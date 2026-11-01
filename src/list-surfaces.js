// alfred-ghostty · gt
// 枚举 Ghostty 全部窗口/Tab/分屏，输出 Alfred Script Filter JSON。
// 过滤交给 Alfred 完成（match 字段 = 标题 + tab标题 + cwd + 进程名 + tty）。
// 改名模式：普通 item 的 autocomplete 把输入变成 "改名 ttysNNN "，继续输入别名
// 回车 -> action.js(action=rename)。用 autocomplete 而非链式 Script Filter，
// 是因为 Alfred 动作时会触发全部出线，链式会让跳转/改名互相误触。
// 需要 Ghostty >= 1.4（AppleScript 字典）。

ObjC.import('Foundation');

const alfred = Application.currentApplication();
alfred.includeStandardAdditions = true;

// 运行时文案按系统首选语言切换（zh -> 中文，否则英文）。
// info.plist 里的静态说明无法动态切换，已是英文。
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

function shq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

function shellOut(cmd) {
  // JXA doShellScript 会把输出里的 LF 转成 CR，统一归一回 LF
  try {
    return String(alfred.doShellScript(cmd)).replace(/\r/g, "\n");
  } catch (e) {
    return "";
  }
}

function ghosttyRunning() {
  try {
    alfred.doShellScript("pgrep -xi ghostty >/dev/null");
    return true;
  } catch (e) {
    return false;
  }
}

function collectSurfaces(g) {
  const out = [];
  g.windows().forEach(function (w, wi) {
    const windowId = String(w.id());
    w.tabs().forEach(function (t, ti) {
      const tabId = String(t.id());
      let tabTitle = "";
      try { tabTitle = String(t.name()); } catch (e) {}
      let focusId = null;
      try { focusId = String(t.focusedTerminal().id()); } catch (e) {}
      t.terminals().forEach(function (s, si) {
        let title = "", cwd = "", tty = "", pid = 0;
        try { title = String(s.name()); } catch (e) {}
        try { cwd = String(s.workingDirectory()); } catch (e) {}
        try { tty = String(s.tty()); } catch (e) {}
        try { pid = Number(s.pid()); } catch (e) {}
        out.push({
          winIdx: wi + 1, tabIdx: ti + 1, paneIdx: si + 1,
          windowId: windowId, tabId: tabId, terminalId: String(s.id()),
          tabTitle: tabTitle, title: title, cwd: cwd, tty: tty, pid: pid,
          isFocused: focusId !== null && focusId === String(s.id())
        });
      });
    });
  });
  return out;
}

function lookupProcs(surfaces) {
  const map = {};
  const pids = [];
  surfaces.forEach(function (s) {
    if (s.pid > 0 && pids.indexOf(s.pid) < 0) pids.push(s.pid);
  });
  if (!pids.length) return map;
  // ps 对含死 pid 的列表会非零退出，2>/dev/null || true 保住 stdout。
  // stat 含 Z = 僵尸进程（shell 已死、Ghostty 尚未回收）→ 视为死亡。
  const out = shellOut("ps -o pid=,stat=,comm= -p " + pids.join(",") + " 2>/dev/null || true");
  out.split("\n").forEach(function (line) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (m) map[m[1]] = { dead: m[2].indexOf("Z") >= 0, comm: m[3].trim() };
  });
  return map;
}

function homePath() {
  try { return alfred.doShellScript('printf %s "$HOME"'); } catch (e) { return ""; }
}

// ---- 进程图标：icons/<进程名>.png 存在即用，否则回退应用图标 ----
// Alfred 以 workflow 目录为工作目录，放一张 node.png 即可让 node 进程用上。

const iconCache = {};

function iconForProc(proc) {
  if (proc && proc !== "zsh") {
    const p = "icons/" + proc + ".png";
    if (!(p in iconCache)) {
      try {
        alfred.doShellScript("test -f " + shq(p));
        iconCache[p] = true;
      } catch (e) {
        iconCache[p] = false;
      }
    }
    if (iconCache[p]) return { path: p };
  }
  return { path: "icon.png" };
}

let QUERY = "";

function run(argv) {
  QUERY = ((argv && argv[0]) || "").replace(/^\s+|\s+$/g, "");
  return runMain();
}

function runMain() {
  const items = [];
  const icon = { path: "icon.png" };

  if (!ghosttyRunning()) {
    items.push({
      title: T("Ghostty 未在运行", "Ghostty is not running"),
      subtitle: T("启动 Ghostty 后重新唤起 gt", "Launch Ghostty, then invoke gt again"),
      valid: false,
      icon: icon
    });
    return JSON.stringify({ items: items });
  }

  const g = Application("Ghostty");
  let surfaces = [];
  try {
    surfaces = collectSurfaces(g);
  } catch (e) {
    items.push({
      title: T("无法读取 Ghostty 分屏", "Cannot read Ghostty surfaces"),
      subtitle: T("需要 Ghostty >= 1.4；", "Requires Ghostty >= 1.4; ") + String((e && e.message) || e),
      valid: false,
      icon: icon
    });
    return JSON.stringify({ items: items });
  }

  const procs = lookupProcs(surfaces);
  const home = homePath();
  const tilde = function (p) {
    return p && home && p.indexOf(home) === 0 ? "~" + p.slice(home.length) : p;
  };
  const procName = function (pid) {
    const p = procs[String(pid)];
    return ((p && p.comm) || "").replace(/^-/, "").split("/").pop();
  };
  // ps 反查同时充当存活检查：Ghostty 的脚本字典偶尔会返回已死亡的分屏
  // （进程退了枚举里还在），ps 里查不到 pid 的直接跳过
  const havePs = Object.keys(procs).length > 0;

  // ---- 改名模式：query = "改名 [ttysNNN] [别名]" ----
  const mode = QUERY.match(/^(?:改名|rename)\s*([\s\S]*)$/);
  if (mode) {
    const rest = mode[1].trim();
    const m = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const handle = m ? m[1] : "";
    const alias = m && m[2] !== undefined ? m[2].trim() : "";
    let hit = null;
    if (handle) {
      const live = surfaces.filter(function (s) {
        if (havePs) {
          if (s.pid <= 0) return false;
          const p = procs[String(s.pid)];
          if (!p || p.dead) return false;
        }
        return true;
      });
      for (let i = 0; i < live.length; i++) {
        const tty = live[i].tty || "";
        if (tty === handle || (tty.length && tty.indexOf(handle, tty.length - handle.length) >= 0)) {
          hit = live[i];
          break;
        }
      }
    }
    if (!hit) {
      items.push({
        title: handle
          ? T("找不到 tty 为 " + handle + " 的分屏（可能已关闭）", "No surface with tty " + handle + " (it may have closed)")
          : T("Tab 选择要改名的分屏", "Press Tab on a surface in gt to rename it"),
        subtitle: T("在 gt 列表对某个分屏按 Tab 进入改名", "Autocomplete fills this input from a gt result"),
        valid: false,
        // match 取原样 query，保证 Alfred 过滤时该 item 永远存活
        match: QUERY,
        icon: icon
      });
    } else {
      items.push({
        title: alias ? T("设置别名为「" + alias + "」", "Set alias to '" + alias + "'")
                     : T("清除别名（恢复原标题）", "Clear alias (restore original title)"),
        subtitle: T("目标：", "Target: ") + (hit.title || hit.cwd) + T(" · 回车确认", " · press ↩ to confirm"),
        arg: alias,
        match: QUERY,
        icon: icon,
        variables: {
          action: "rename",
          window_id: hit.windowId,
          tab_id: hit.tabId,
          terminal_id: hit.terminalId,
          rename_alias: alias
        }
      });
    }
    return JSON.stringify({ items: items });
  }

  surfaces.forEach(function (s) {
    // ps 成功输出的前提下判活：pid<=0（字典对已死表面返回 0）、
    // pid 查不到（已被回收）、stat 含 Z（僵尸）都视为死亡，直接跳过
    if (havePs) {
      if (s.pid <= 0) return;
      const p = procs[String(s.pid)];
      if (!p || p.dead) return;
    }
    const proc = procName(s.pid);
    const itemIcon = iconForProc(proc);
    const title = s.title || tilde(s.cwd) || s.tty || T("终端", "terminal");
    const parts = ["W" + s.winIdx, "T" + s.tabIdx, T("窗格", "pane") + s.paneIdx];
    if (s.cwd) parts.push(tilde(s.cwd));
    parts.push(proc || "zsh");
    if (s.tty) parts.push(s.tty.replace("/dev/", ""));
    let sub = parts.join(" · ");
    if (s.isFocused) sub += T(" · 当前所在", " · current");

    items.push({
      title: title,
      subtitle: sub,
      match: [s.title, s.tabTitle, s.cwd, proc, s.tty].filter(Boolean).join(" "),
      arg: title,
      icon: itemIcon,
      text: { copy: s.cwd, largetype: title },
      variables: {
        window_id: s.windowId,
        tab_id: s.tabId,
        terminal_id: s.terminalId,
        kind: "terminal",
        action: "focus",
        cwd: s.cwd,
        current_title: title
      },
      mods: {
        ctrl: {
          variables: { action: "copy" },
          subtitle: T("⌃回车 复制完整路径：", "⌃↩ copy full path: ") + (tilde(s.cwd) || s.cwd)
        }
      },
      autocomplete: s.tty ? (LANG_ZH ? "改名 " : "rename ") + s.tty.replace("/dev/", "") + " " : ""
    });
  });

  if (!items.length) {
    items.push({
      title: T("未发现任何分屏", "No surfaces found"),
      subtitle: T("Ghostty 正在运行，但没有可枚举的终端", "Ghostty is running, but no terminals were found"),
      valid: false,
      icon: icon
    });
  }

  return JSON.stringify({ items: items });
}

