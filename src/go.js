// alfred-ghostty · go
// 打开目录到 Ghostty 新 Tab（⌘回车 = 新窗口）。
//   无参数：默认打开 Finder 前窗口目录（无 Finder 窗口回退个人目录）
//   有参数：目录补全，Tab 逐级下钻，回车打开
// 打开动作交给 action.js（action=open / open_window）。

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
  } catch (e) { return ""; }
}

function shq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

function tryShell(cmd) {
  try {
    // JXA doShellScript 会把输出里的 LF 转成 CR，统一归一回 LF
    return String(alfred.doShellScript(cmd)).replace(/\r/g, "\n");
  } catch (e) { return ""; }
}

function homeDir() {
  return tryShell('printf %s "$HOME"') || "/";
}

function tilde(p, home) {
  return p && p.indexOf(home) === 0 ? "~" + p.slice(home.length) : p;
}

function finderDir() {
  const out = tryShell(
    'osascript -e \'tell application "Finder" to if (count of Finder windows) > 0 then return POSIX path of (target of front Finder window as alias)\''
  );
  return out.trim();
}

function existsDir(p) {
  try { alfred.doShellScript("test -d " + shq(p)); return true; } catch (e) { return false; }
}

function listDirs(base) {
  const out = tryShell("find " + shq(base) + " -maxdepth 1 -type d");
  if (!out) return [];
  return out.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
}

// 把用户输入解析成 {base, prefix}：~ 展开为 home；无斜杠时相对 home
function splitPath(q) {
  const home = homeDir();
  let full = q.trim();
  if (full === "~") full = home;
  else if (full.indexOf("~/") === 0) full = home + full.slice(1);
  const idx = full.lastIndexOf("/");
  if (idx < 0) return { base: home, prefix: full, full: "" };
  const base = idx === 0 ? "/" : full.slice(0, idx);
  return { base: base, prefix: full.slice(idx + 1), full: full };
}

function run(argv) {
  const q = ((argv && argv[0]) || "").trim();
  const icon = { path: "icon.png" };
  const home = homeDir();
  const items = [];
  const vars = function (p) { return { action: "open", open_path: p }; };
  const mods = {
    cmd: {
      variables: { action: "open_window" },
      subtitle: T("⌘回车 在新窗口打开", "⌘↩ opens in a new window")
    }
  };

  if (!q) {
    const fd = finderDir();
    if (fd) {
      items.push({
        title: T("打开 Finder 当前目录", "Open Finder's current folder"),
        subtitle: tilde(fd, home),
        arg: fd, icon: icon, variables: vars(fd), mods: mods
      });
    }
    items.push({
      title: T("打开个人目录", "Open home folder"),
      subtitle: tilde(home, home),
      arg: home, icon: icon, variables: vars(home), mods: mods
    });
    return JSON.stringify({ items: items });
  }

  const parts = splitPath(q);
  const expanded = parts.prefix
    ? parts.base + (parts.base === "/" ? "" : "/") + parts.prefix
    : parts.base;

  // 输入本身已是目录 → 置顶直开
  if (parts.prefix && existsDir(expanded)) {
    items.push({
      title: T("打开 ", "Open ") + tilde(expanded, home),
      subtitle: T("回车=新 Tab　⌘回车=新窗口", "↩=new tab　⌘↩=new window"),
      arg: expanded, icon: icon, variables: vars(expanded), mods: mods
    });
  }

  const entries = [];
  listDirs(parts.base).forEach(function (p) {
    if (p === parts.base) return;
    const name = parts.base === "/" ? p.slice(1) : p.slice(parts.base.length + 1);
    if (name) entries.push({ name: name, path: p });
  });

  const pre = parts.prefix.toLowerCase();
  let hits = entries.filter(function (e) { return e.name.toLowerCase().indexOf(pre) === 0; });
  if (!hits.length && pre) {
    hits = entries.filter(function (e) { return e.name.toLowerCase().indexOf(pre) >= 0; });
  }
  if (parts.prefix) {
    hits = hits.filter(function (e) { return e.path !== expanded; });
  }
  hits.sort(function (a, b) { return a.name.localeCompare(b.name); });

  hits.slice(0, 30).forEach(function (e) {
    items.push({
      title: e.name + "/",
      subtitle: tilde(e.path, home) + T("　Tab=进入子目录　⌘回车=新窗口", "　Tab=descend　⌘↩=new window"),
      arg: e.path,
      autocomplete: e.path + "/",
      icon: icon, variables: vars(e.path), mods: mods
    });
  });

  if (!items.length) {
    items.push({
      title: T("无匹配目录", "No matching folder"),
      subtitle: parts.base === "/"
        ? T("从 / 开始补全", "Completing from /")
        : T("在 " + tilde(parts.base, home) + " 下未找到", "Nothing under " + tilde(parts.base, home)),
      valid: false, icon: icon
    });
  }

  return JSON.stringify({ items: items });
}
