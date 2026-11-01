// alfred-ghostty · 动作分发
// 环境变量（由 Alfred 从上游 item 变量注入）：
//   action=focus|copy|rename|open|open_window
//   window_id tab_id terminal_id cwd open_path rename_alias
// focus       : 窗口置前 -> 选中 Tab -> 聚焦分屏（id 失效时逐级回退）
// copy        : cwd 写入剪贴板并弹系统通知
// rename      : 给 terminal 写 name override（rename_alias，空串即清除）
// open        : path 在新 Tab 打开（Ghostty 未运行则新窗口）
// open_window : path 在新窗口打开
// 说明：Ghostty 的 surface configuration record 只认原始四字符代码键
// （«class GScD» = initial working directory），所以 open 走 AppleScript。

ObjC.import('Foundation');
ObjC.import('stdlib');

const LANG_ZH = (function () {
  try {
    const langs = ObjC.deepUnwrap($.NSLocale.preferredLanguages) || [];
    const first = String(langs[0] || "").toLowerCase();
    return first.indexOf("zh") === 0;
  } catch (e) {
    return false;
  }
})();

function T(zh, en) {
  return LANG_ZH ? zh : en;
}

const alfred = Application.currentApplication();
alfred.includeStandardAdditions = true;

function env(k) {
  try {
    const v = $.getenv(k);
    if (v === undefined || v === null) return "";
    const s = ObjC.unwrap(v);
    return s === null || s === undefined ? "" : s + "";
  } catch (e) {
    return "";
  }
}

function shq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

function findById(list, id) {
  for (let i = 0; i < list.length; i++) {
    let xid = "";
    try { xid = String(list[i].id()); } catch (e) {}
    if (xid === id) return list[i];
  }
  return null;
}

function doCopy(cwd) {
  alfred.doShellScript("printf %s " + shq(cwd) + " | pbcopy");
  try {
    alfred.doShellScript(
      "osascript -e 'display notification " + shq(cwd) +
      " with title \"alfred-ghostty\" subtitle \"" + T("已复制路径", "Path copied") + "\"'"
    );
  } catch (e) {}
}

function notify(msg) {
  try {
    alfred.doShellScript(
      "osascript -e 'display notification " + shq(msg) + " with title \"alfred-ghostty\"'"
    );
  } catch (e) {}
}

function doRename(alias) {
  const g = Application("Ghostty");
  const w = findById(g.windows(), env("window_id"));
  if (!w) return notify(T("未找到目标窗口（可能已关闭）", "Target window not found (it may have closed)"));
  const t = findById(w.tabs(), env("tab_id"));
  if (!t) return notify(T("未找到目标 Tab（可能已关闭）", "Target tab not found (it may have closed)"));
  const s = findById(t.terminals(), env("terminal_id"));
  if (!s) return notify(T("未找到目标分屏（可能已关闭）", "Target surface not found (it may have closed)"));
  s.nameOverride = alias;
  notify(alias ? T("别名已设置：", "Alias set: ") + alias : T("别名已清除", "Alias cleared"));
}

function doFocus() {
  const g = Application("Ghostty");
  const w = findById(g.windows(), env("window_id"));
  if (!w) return;
  g.activateWindow(w);
  const t = findById(w.tabs(), env("tab_id"));
  if (!t) return;
  g.selectTab(t);
  const s = findById(t.terminals(), env("terminal_id")) || t.terminals()[0];
  if (s) g.focus(s);
}

function ghosttyRunning() {
  try {
    alfred.doShellScript("pgrep -xi ghostty >/dev/null");
    return true;
  } catch (e) {
    return false;
  }
}

function openTarget(path, wantWindow) {
  const esc = String(path).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const cfg = 'configuration {«class GScD»:"' + esc + '"}';
  const forms = [];
  if (ghosttyRunning() && !wantWindow) {
    forms.push('new tab in front window with ' + cfg);
  }
  forms.push('new window with ' + cfg);

  let lastErr = null;
  for (let i = 0; i < forms.length; i++) {
    try {
      alfred.doShellScript("osascript -e " + shq('tell application "Ghostty" to ' + forms[i]));
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  try {
    alfred.doShellScript(
      "osascript -e 'display notification " + shq(String((lastErr && lastErr.message) || lastErr)) +
      " with title \"alfred-ghostty\" subtitle \"" + T("打开目录失败", "Failed to open folder") + "\"'"
    );
  } catch (e) {}
}

const action = env("action") || "focus";
if (action === "copy") {
  const cwd = env("cwd");
  if (cwd) doCopy(cwd);
} else if (action === "focus") {
  doFocus();
} else if (action === "rename") {
  doRename(env("rename_alias"));
} else if (action === "open" || action === "open_window") {
  const openPath = env("open_path") || env("cwd");
  if (openPath) openTarget(openPath, action === "open_window");
}
