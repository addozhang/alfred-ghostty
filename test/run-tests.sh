#!/bin/bash
# alfred-ghostty 测试套件
# 模拟 Alfred 的调用契约：cwd = workflow 目录、item 变量 = 环境变量、query = argv[1]。
# 三层：
#   1. info.plist 契约（连线、脚本文件存在、相对路径）—— 无需 Ghostty
#   2. Script Filter JSON 输出契约（Alfred JSON 规范、icon 存在、变量类型）
#   3. 动作集成（focus/copy/open/open_window，真连 Ghostty）—— 会短暂创建
#      分屏/Tab/窗口并在退出时自动清理（含失败清理）
# 用法：make test  或  test/run-tests.sh

set -u
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; SKIP=0
CLEAN_ORIGINAL_CLIP=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; [ $# -gt 1 ] && sed 's/^/     /' <<<"$2"; }
skip() { SKIP=$((SKIP+1)); echo "  ⏭️  $1"; }
section() { echo; echo "── $1 ─────────────────────────────"; }

# 按 Alfred 的方式调用 JXA 脚本（bash -c 模拟 argv 传递）
jxa() { # jxa <file> [arg]
  /bin/bash -c 'osascript -l JavaScript "$1" "${2:-}"' jxa "$1" "${2:-}"
}

# 校验 Script Filter JSON：items 存在、title 非空、icon 文件存在、variables 全为字符串
validate_items() { # stdin: json
  python3 -c '
import json, sys, os
d = json.load(sys.stdin)
items = d.get("items")
assert isinstance(items, list) and items, "items 缺失或为空"
for it in items:
    assert isinstance(it.get("title"), str) and it["title"], "title 缺失: %r" % it
    ic = it.get("icon", {}).get("path", "icon.png")
    assert os.path.exists(ic), "icon 文件不存在: %s" % ic
    for k, v in (it.get("variables") or {}).items():
        assert isinstance(v, str), "variables[%s] 不是字符串: %r" % (k, v)
print("%d items OK" % len(items))
'
}

cleanup() {
  [ -n "$CLEAN_ORIGINAL_CLIP" ] && printf '%s' "$CLEAN_ORIGINAL_CLIP" | pbcopy
  # 地面真值清理：按目录反查占用它的 shell，SIGKILL（zsh 忽略 SIGTERM）。
  # 不用脚本字典的 close：进程退出后字典可能返回僵尸/串线条目，close 会静默失败。
  local pids pid
  pids=$(lsof -Fp +D /tmp/alfred-ghostty-test.* 2>/dev/null | grep '^p' | cut -c2- | sort -u)
  for pid in $pids; do kill -9 "$pid" 2>/dev/null; done
  rm -rf /tmp/alfred-ghostty-test.* 2>/dev/null
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────

section "1. info.plist 契约"

plutil -lint info.plist >/dev/null 2>&1 \
  && pass "plutil -lint" \
  || fail "plutil -lint" "$(plutil -lint info.plist)"

python3 - <<'PY' && pass "对象/连线/脚本文件契约" || fail "对象/连线/脚本文件契约"
import plistlib, re, os
d = plistlib.load(open("info.plist", "rb"))
objects = {o["uid"]: o for o in d["objects"]}
for src, conns in d["connections"].items():
    assert src in objects, "connection 来源不存在: %s" % src
    for c in conns:
        assert c["destinationuid"] in objects, "connection 目标不存在: %s -> %s" % (src, c["destinationuid"])
sf_keywords = []
for o in d["objects"]:
    if "scriptfilter" in o["type"]:
        sf_keywords.append(o["config"]["keyword"])
    script = o.get("config", {}).get("script", "")
    assert "alfred_workflow_dir" not in script, "引用了不存在的 $alfred_workflow_dir: %s" % script
    for f in re.findall(r'src/[\w.-]+\.js', script):
        assert os.path.exists(f), "脚本文件不存在: %s" % f
assert len(sf_keywords) == len(set(sf_keywords)), "关键词重复: %r" % sf_keywords
PY

section "2. Script Filter 输出契约"

out=$(jxa src/list-surfaces.js 2>&1)
if printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  msg=$(printf '%s' "$out" | validate_items 2>&1)
  pass "gt 枚举 JSON 契约（${msg}）"
else
  fail "gt 枚举 JSON 契约" "$out"
fi

for q in "Work" "~/Workspaces/github_w/alf" "/Users/addo"; do
  out=$(jxa src/go.js "$q" 2>&1)
  if msg=$(printf '%s' "$out" | validate_items 2>&1); then
    pass "go [$q]（${msg}）"
  else
    fail "go [$q]" "$msg | $out"
  fi
done

out=$(jxa src/go.js "" 2>&1)
if printf '%s' "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
titles = [i["title"] for i in d["items"]]
ok = any(("个人目录" in t) or ("home folder" in t.lower()) for t in titles)
assert ok, "缺 home 兜底项: %r" % titles
'; then
  pass "go 空查询有 home 兜底（中/英）"
else
  fail "go 空查询有个人目录兜底" "$out"
fi

section "3. Ghostty 动作集成"

if ! pgrep -xi ghostty >/dev/null 2>&1; then
  skip "Ghostty 未运行，集成测试全部跳过"
else
  # 全部断言都在自建的临时 Tab 里做，和用户正在用的窗口/分屏完全隔离
  TESTDIR=$(mktemp -d /tmp/alfred-ghostty-test.XXXXXX)

  action=open open_path="$TESTDIR" jxa src/action.js
  sleep 1.2
  STATE=$(TESTDIR="$TESTDIR" osascript -l JavaScript -e '
ObjC.import("stdlib");
const g = Application("Ghostty");
const dir = ObjC.unwrap($.getenv("TESTDIR"));
let hit = null;
g.windows().forEach(w => w.tabs().forEach(t => {
  try {
    const s = t.terminals()[0];
    if (String(s.workingDirectory()) === dir)
      hit = {win: String(w.id()), tab: String(t.id()), term: String(s.id()), count: w.terminals ? 0 : 0};
  } catch (e) {}
}));
JSON.stringify(hit || {win: "", tab: "", term: ""})')
  TABWIN=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["win"])' "$STATE")
  TABID=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["tab"])' "$STATE")
  TERMID=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["term"])' "$STATE")

  if [ -z "$TABID" ]; then
    fail "准备工作：open 创建测试 Tab"
  else
    pass "open 新 Tab 打开指定目录"

    # 3.1 聚焦切换：在测试 Tab 里建分屏 → focus 过去 → 切回（不关分屏，退出时随 Tab 一起清理）
    osascript -e "tell application \"Ghostty\"" \
      -e "set theTab to missing value" \
      -e "repeat with w in windows" \
      -e "repeat with t in tabs of w" \
      -e "if ((id of t) as text) is \"$TABID\" then set theTab to t" \
      -e "end repeat" \
      -e "end repeat" \
      -e "if theTab is not missing value then split (terminal 1 of theTab) direction right" \
      -e "end tell" >/dev/null 2>&1
    sleep 1.2
    SPLIT_ID=$(TABID="$TABID" TERMID="$TERMID" osascript -l JavaScript -e '
ObjC.import("stdlib");
const g = Application("Ghostty");
const tab = ObjC.unwrap($.getenv("TABID"));
const orig = ObjC.unwrap($.getenv("TERMID"));
let out = "";
g.windows().forEach(w => w.tabs().forEach(t => {
  if (String(t.id()) !== tab) return;
  t.terminals().forEach(s => { if (String(s.id()) !== orig) out = String(s.id()); });
}));
out')
    if [ -n "$SPLIT_ID" ]; then
      action=focus window_id="$TABWIN" tab_id="$TABID" terminal_id="$SPLIT_ID" jxa src/action.js
      sleep 0.6
      NOW=$(TABID="$TABID" osascript -l JavaScript -e '
ObjC.import("stdlib");
const g = Application("Ghostty");
const tab = ObjC.unwrap($.getenv("TABID"));
let out = "";
g.windows().forEach(w => w.tabs().forEach(t => {
  if (String(t.id()) === tab) out = String(t.focusedTerminal().id());
}));
out')
      [ "$NOW" = "$SPLIT_ID" ] && pass "focus 聚焦到新分屏" || fail "focus 聚焦到新分屏" "期望 ${SPLIT_ID}，实际 ${NOW}"
      action=focus window_id="$TABWIN" tab_id="$TABID" terminal_id="$TERMID" jxa src/action.js
      sleep 0.6
      NOW=$(TABID="$TABID" osascript -l JavaScript -e '
ObjC.import("stdlib");
const g = Application("Ghostty");
const tab = ObjC.unwrap($.getenv("TABID"));
let out = "";
g.windows().forEach(w => w.tabs().forEach(t => {
  if (String(t.id()) === tab) out = String(t.focusedTerminal().id());
}));
out')
      [ "$NOW" = "$TERMID" ] && pass "focus 切回原分屏" || fail "focus 切回原分屏" "期望 ${TERMID}，实际 ${NOW}"
    else
      skip "focus 切换（分屏创建失败）"
    fi

    # 3.2 复制路径（保存并恢复剪贴板）
    if [ -z "$CLEAN_ORIGINAL_CLIP" ]; then
      CLEAN_ORIGINAL_CLIP=$(pbpaste 2>/dev/null | head -c 100000)
      action=copy cwd="$TESTDIR" jxa src/action.js
      sleep 0.4
      GOT=$(pbpaste 2>/dev/null)
      [ "$GOT" = "$TESTDIR" ] && pass "copy 复制 cwd 到剪贴板" || fail "copy 复制 cwd 到剪贴板" "期望 ${TESTDIR}，实际 ${GOT}"
    else
      skip "copy（剪贴板已被占用，跳过）"
    fi

    # 3.4 open_window 新窗口打开目录
    W0=$(osascript -l JavaScript -e 'Application("Ghostty").windows().length')
    action=open_window open_path="$TESTDIR" jxa src/action.js
    sleep 1.5
    NEWWIN=$(TESTDIR="$TESTDIR" TABWIN="$TABWIN" osascript -l JavaScript -e '
ObjC.import("stdlib");
const g = Application("Ghostty");
const dir = ObjC.unwrap($.getenv("TESTDIR"));
const knownWin = ObjC.unwrap($.getenv("TABWIN"));
let hit = null;
g.windows().forEach(w => {
  try {
    if (String(w.id()) === knownWin) return;
    if (String(w.tabs()[0].terminals()[0].workingDirectory()) === dir) hit = String(w.id());
  } catch (e) {}
});
JSON.stringify({count: g.windows().length, id: hit})')
    W1=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["count"])' "$NEWWIN")
    NEWWIN_ID=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$NEWWIN")
    [ "$W1" -eq $((W0 + 1)) ] && [ -n "$NEWWIN_ID" ] && pass "open_window 新窗口打开指定目录" || fail "open_window 新窗口打开指定目录" "窗口数 $W0 -> $W1, id=$NEWWIN_ID"
  fi
fi

# ─────────────────────────────────────────────────────────────

echo
echo "══════════════════════════════════════"
echo "通过 $PASS · 失败 $FAIL · 跳过 $SKIP"
[ "$FAIL" -eq 0 ]
