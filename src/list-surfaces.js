// alfred-ghostty · gt
// 枚举 Ghostty 全部窗口/Tab/分屏，输出 Alfred Script Filter JSON。
// 过滤交给 Alfred 完成（match 字段 = 标题 + tab标题 + cwd + 进程名 + tty）。
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
    return Application("Ghostty").running();
  } catch (e) {
    return false;
  }
}

function collectSurfaces(g) {
  const out = [];
  const wins = g.windows();
  const winCount = wins.length;
  wins.forEach(function (w, wi) {
    const windowId = String(w.id());
    const tabs = w.tabs();
    const tabCount = tabs.length;
    tabs.forEach(function (t, ti) {
      const tabId = String(t.id());
      let tabTitle = "", tabTitleOverride = "";
      try { tabTitle = String(t.name() || ""); } catch (e) {}
      try { tabTitleOverride = String(t.nameOverride() || ""); } catch (e) {}
      let focusId = null;
      try { focusId = String(t.focusedTerminal().id()); } catch (e) {}
      const terms = t.terminals();
      const paneCount = terms.length;
      terms.forEach(function (s, si) {
        let title = "", titleOverride = "", cwd = "", tty = "", pid = 0;
        try { title = String(s.name() || ""); } catch (e) {}
        try { titleOverride = String(s.nameOverride() || ""); } catch (e) {}
        try { cwd = String(s.workingDirectory() || ""); } catch (e) {}
        try { tty = String(s.tty() || ""); } catch (e) {}
        try { pid = Number(s.pid() || 0); } catch (e) {}
        out.push({
          winIdx: wi + 1, winCount: winCount,
          tabIdx: ti + 1, tabCount: tabCount,
          paneIdx: si + 1, paneCount: paneCount,
          windowId: windowId, tabId: tabId, terminalId: String(s.id()),
          tabTitle: tabTitle, tabTitleOverride: tabTitleOverride,
          title: title, titleOverride: titleOverride,
          cwd: cwd, tty: tty, pid: pid,
          isFocused: focusId !== null && focusId === String(s.id())
        });
      });
    });
  });
  return out;
}

const SHELL_PROCS = { zsh: 1, bash: 1, fish: 1, sh: 1, dash: 1, ksh: 1, tcsh: 1, csh: 1, nu: 1, login: 1 };
const AGENT_PROCS = {
  omp: "omp",
  opencode: "opencode",
  pi: "pi",
  claude: "claude",
  codex: "codex",
  aider: "aider",
  goose: "goose",
  amp: "amp",
  kimi: "kimi",
  qwen: "qwen",
  cursor: "cursor",
  "cursor-agent": "cursor-agent"
};
const WRAPPER_PROCS = { node: 1, bun: 1, python: 1, python3: 1, deno: 1, npx: 1, pnpm: 1, yarn: 1, env: 1 };

function baseName(p) {
  if (!p) return "";
  return String(p).replace(/\/+$/, "").split("/").pop().replace(/^-/, "");
}

function resolveCmdName(comm, args) {
  let c = baseName(comm);
  if (WRAPPER_PROCS[c] && args) {
    const tokens = String(args).trim().split(/\s+/);
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok || tok.charAt(0) === "-") continue;
      const b = baseName(tok).replace(/\.(?:c?js|mjs|ts|py)$/i, "");
      if (b && !WRAPPER_PROCS[b]) {
        if (b === "cli" || b === "index" || b === "main" || b === "bundle") {
          const m = tok.match(/(?:@[\w-]+\/)?(pi-coding-agent|claude-code|codex|opencode|omp|aider|amp|goose|qwen|kimi)\b/i);
          if (m) {
            const k = m[1].toLowerCase();
            if (k === "pi-coding-agent") return "pi";
            if (k === "claude-code") return "claude";
            return k;
          }
        }
        return b;
      }
    }
  }
  return c;
}

function isBgHelperProc(name, args) {
  const s = (name + " " + args).toLowerCase();
  return s.indexOf("mcp") >= 0 || s.indexOf("lsp") >= 0 || s.indexOf("language-server") >= 0 || s.indexOf("esbuild") >= 0;
}

function lookupProcs(surfaces) {
  const byPid = {};
  const byTty = {};
  const ttys = [];
  const pids = [];
  surfaces.forEach(function (s) {
    if (s.pid > 0 && pids.indexOf(s.pid) < 0) pids.push(s.pid);
    const shortTty = (s.tty || "").replace("/dev/", "");
    if (shortTty && ttys.indexOf(shortTty) < 0) ttys.push(shortTty);
  });
  if (!pids.length && !ttys.length) return { byPid: byPid, byTty: byTty };
  const selector = ttys.length ? ("-t " + ttys.join(",")) : ("-p " + pids.join(","));
  // ps 对含死 pid/tty 的列表会非零退出，2>/dev/null || true 保住 stdout。
  // stat 含 Z = 僵尸进程（shell 已死、Ghostty 尚未回收）→ 视为死亡。
  const out = shellOut("ps -o pid=,ppid=,pgid=,tpgid=,tty=,stat=,%cpu=,comm=,args= " + selector + " 2>/dev/null || true");
  out.split("\n").forEach(function (line) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) return;
    const commTok = m[8];
    const rest = m[9] || "";
    // macOS ps 的 comm 可能含空格（如某些 Helper），但终端 CLI 均无空格
    const args = rest || commTok;
    const cmdName = resolveCmdName(commTok, args);
    const rec = {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      tpgid: Number(m[4]),
      tty: m[5],
      stat: m[6],
      dead: m[6].indexOf("Z") >= 0,
      fg: m[6].indexOf("+") >= 0 || Number(m[3]) === Number(m[4]),
      cpu: parseFloat(m[7]) || 0,
      comm: commTok,
      args: args,
      name: cmdName
    };
    byPid[String(rec.pid)] = rec;
    if (!byTty[rec.tty]) byTty[rec.tty] = [];
    byTty[rec.tty].push(rec);
  });
  return { byPid: byPid, byTty: byTty };
}

// 解析终端标题中的 Coding Agent 状态与会话摘要
// - omp: "π > proj" (idle), "π ⠋ proj" / "π : proj" (working), "π ! proj" (attention)
// - pi: "π - proj"
// - opencode: "OpenCode" | "OC | session title"
// - claude: "✳ session title" | "⠋ session title"
const SPINNER_RE = /[\u2800-\u28FF\u25CB\u25D4\u25D1\u25D5\u25CF\u2733\u273B\u273D]/;

function inspectSurfaceActivity(s, procInfo) {
  const shortTty = (s.tty || "").replace("/dev/", "");
  const ttyList = (procInfo.byTty && procInfo.byTty[shortTty]) || [];
  const rootProc = procInfo.byPid && procInfo.byPid[String(s.pid)];

  // 1. 优先在当前 tty 的前台进程组中找 Coding Agent 或非 Shell 前台进程
  let agentRec = null;
  let fgCmdRec = null;
  let activeToolRec = null;

  ttyList.forEach(function (p) {
    if (p.dead || SHELL_PROCS[p.name]) return;
    const key = p.name.toLowerCase();
    if (AGENT_PROCS[key]) {
      if (!agentRec || p.fg) agentRec = p;
    } else if (p.fg && !isBgHelperProc(p.name, p.args)) {
      fgCmdRec = p;
    }
  });

  // 如果存在 Coding Agent，检查它下面是否有正在执行的非 MCP 工具子进程（如 bash, git, rg, python 等）
  if (agentRec) {
    ttyList.forEach(function (p) {
      if (p.dead || p.pid === agentRec.pid) return;
      if (p.ppid === agentRec.pid || p.pgid === agentRec.pgid) {
        if (!isBgHelperProc(p.name, p.args) && !AGENT_PROCS[p.name.toLowerCase()]) {
          activeToolRec = p;
        }
      }
    });
  }

  const rawTitle = (s.title || "").trim();
  let agentName = agentRec ? AGENT_PROCS[agentRec.name.toLowerCase()] : "";
  let agentState = ""; // "working" | "attention" | "idle" | ""
  let sessionTopic = "";

  // 从终端标题进一步识别 Agent 状态与会话标题
  const ompMatch = rawTitle.match(/^\u03C0\s+([^\s]+)(?:\s+(.*))?$/);
  if (ompMatch && (!agentName || agentName === "omp" || agentName === "pi")) {
    const indicator = ompMatch[1];
    sessionTopic = (ompMatch[2] || "").trim();
    if (indicator === "-") {
      if (!agentName) agentName = "pi";
    } else {
      if (!agentName) agentName = "omp";
      if (indicator === "!") agentState = "attention";
      else if (indicator === ">") agentState = "idle";
      else agentState = "working";
    }
  } else if (/^OC\s*\|\s*(.+)$/.test(rawTitle)) {
    if (!agentName) agentName = "opencode";
    sessionTopic = rawTitle.replace(/^OC\s*\|\s*/, "").trim();
  } else if (rawTitle === "OpenCode") {
    if (!agentName) agentName = "opencode";
  }

  if (agentName) {
    if (!agentState) {
      if (activeToolRec || SPINNER_RE.test(rawTitle) || (agentRec && agentRec.cpu >= 1.5)) {
        agentState = "working";
      } else {
        agentState = "idle";
      }
    }
    let stateLabel = "";
    if (agentState === "attention") {
      stateLabel = T("🔴 需确认", "🔴 needs input");
    } else if (agentState === "working") {
      const toolSuffix = activeToolRec && !SHELL_PROCS[activeToolRec.name] ? (" " + activeToolRec.name) : "";
      stateLabel = T("⚡ 工作中", "⚡ working") + toolSuffix;
    } else {
      stateLabel = T("💬 等待输入", "💬 idle");
    }
    return {
      isAgent: true,
      proc: agentName,
      state: agentState,
      stateLabel: stateLabel,
      topic: sessionTopic,
      activeTool: activeToolRec ? activeToolRec.name : ""
    };
  }

  // 非 Agent：看是否有普通前台命令（如 vim, ssh, top, npm 等）
  if (fgCmdRec) {
    return {
      isAgent: false,
      proc: fgCmdRec.name,
      state: "running",
      stateLabel: fgCmdRec.name,
      topic: "",
      activeTool: ""
    };
  }

  const fallbackProc = (rootProc && rootProc.name) || "zsh";
  return {
    isAgent: false,
    proc: fallbackProc,
    state: SHELL_PROCS[fallbackProc] ? "shell" : "running",
    stateLabel: SHELL_PROCS[fallbackProc] ? "" : fallbackProc,
    topic: "",
    activeTool: ""
  };
}

function homePath() {
  try { return ObjC.unwrap($.NSHomeDirectory()) || ""; } catch (e) { return ""; }
}

// ---- 进程图标：icons/<进程名>.png 存在即用，否则回退应用图标 ----
// Alfred 以 workflow 目录为工作目录，放一张 node.png 即可让 node 进程用上。

const iconCache = {};
const fileMgr = $.NSFileManager.defaultManager;

function iconForProc(proc) {
  if (proc && proc !== "zsh") {
    const p = "icons/" + proc + ".png";
    if (!(p in iconCache)) {
      try {
        iconCache[p] = Boolean(fileMgr.fileExistsAtPath(p));
      } catch (e) {
        iconCache[p] = false;
      }
    }
    if (iconCache[p]) return { path: p };
  }
  return { path: "icon.png" };
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

  const procInfo = lookupProcs(surfaces);
  const home = homePath();
  const tilde = function (p) {
    return p && home && p.indexOf(home) === 0 ? "~" + p.slice(home.length) : p;
  };
  // ps 反查同时充当存活检查：Ghostty 的脚本字典偶尔会返回已死亡的分屏
  // （进程退了枚举里还在），ps 里查不到 pid/tty 的直接跳过
  const havePs = Object.keys(procInfo.byPid).length > 0 || Object.keys(procInfo.byTty).length > 0;

  surfaces.forEach(function (s) {
    const shortTty = (s.tty || "").replace("/dev/", "");
    if (havePs) {
      if (s.pid <= 0 && !shortTty) return;
      const p = procInfo.byPid[String(s.pid)];
      const ttyProcs = procInfo.byTty[shortTty] || [];
      const aliveOnTty = ttyProcs.some(function (tp) { return !tp.dead; });
      if ((p && p.dead) || (!p && !aliveOnTty)) return;
    }

    const act = inspectSurfaceActivity(s, procInfo);
    const proc = act.proc;
    const itemIcon = iconForProc(proc);
    const shortCwd = tilde(s.cwd);
    const dirName = baseName(s.cwd) || shortCwd || T("终端", "terminal");

    // 识别用户自定义的 Tab 名：优先取 tab.nameOverride，其次当 tabTitle 与终端 title 不同且不是默认路径时采用
    const customTabName = (s.tabTitleOverride || "").trim() ||
      (s.tabTitle && s.tabTitle !== s.title && s.tabTitle !== shortCwd && s.tabTitle !== s.cwd ? s.tabTitle.trim() : "");
    const customTermName = (s.titleOverride || "").trim();

    // 构造对用户友好的主标题：
    // 1. Coding Agent：显示「目录名 — agent (会话主题) [状态]」
    // 2. 普通前台进程：显示「目录名 — 进程名」（若终端标题有额外语义则保留）
    // 3. 空闲 Shell：显示「目录名」（或用户自定义标题）
    // 若用户手动给 Tab 起了名字，作为前缀「[Tab名] 」展示
    let mainTitle = "";
    if (act.isAgent) {
      let detail = act.proc;
      if (act.topic && act.topic.toLowerCase() !== dirName.toLowerCase() && act.topic.toLowerCase() !== act.proc.toLowerCase()) {
        detail += ": " + act.topic;
      }
      mainTitle = dirName + " — " + detail + "  " + act.stateLabel;
    } else if (act.state === "running" && act.proc) {
      mainTitle = dirName + " — " + act.proc;
    } else {
      const rawT = customTermName || (s.title || "").trim();
      if (rawT && rawT !== shortCwd && rawT !== s.cwd && rawT.indexOf(dirName) < 0) {
        mainTitle = dirName + " · " + rawT;
      } else {
        mainTitle = customTermName || dirName || rawT || T("终端", "terminal");
      }
    }

    if (customTabName && mainTitle.indexOf(customTabName) < 0) {
      mainTitle = "[" + customTabName + "] " + mainTitle;
    }

    // 构造清爽的副标题：
    // - 隐藏 ttys00x 与空闲 zsh
    // - 单窗口时不显示 W1；无分屏时不显示 窗格1
    const subParts = [];
    if (shortCwd) subParts.push(shortCwd);
    const locParts = [];
    if (s.winCount > 1) locParts.push(T("窗口 ", "Win ") + s.winIdx);
    locParts.push("Tab " + s.tabIdx);
    if (s.paneCount > 1) locParts.push(T("分屏 ", "Pane ") + s.paneIdx + "/" + s.paneCount);
    subParts.push(locParts.join(" · "));
    if (s.isFocused) subParts.push(T("当前", "current"));
    const sub = subParts.join("  ·  ");

    // match 保留完整的可搜索维度（含 Tab 名字、目录、进程名、状态词、Tab序号）
    const stateKeywords = act.isAgent
      ? (act.state === "working" ? "working 工作中 运行中" : act.state === "attention" ? "attention confirm 需确认" : "idle waiting 等待输入 空闲")
      : "";
    const matchTokens = [
      mainTitle,
      customTabName,
      s.tabTitle,
      s.title,
      dirName,
      s.cwd,
      proc,
      act.topic,
      stateKeywords,
      "t" + s.tabIdx,
      "tab" + s.tabIdx,
      s.winCount > 1 ? ("w" + s.winIdx) : ""
    ].filter(Boolean).join(" ");

    items.push({
      title: mainTitle,
      subtitle: sub,
      match: matchTokens,
      arg: mainTitle,
      icon: itemIcon,
      text: { copy: s.cwd, largetype: mainTitle + "\n" + (shortCwd || "") },
      variables: {
        window_id: s.windowId,
        tab_id: s.tabId,
        terminal_id: s.terminalId,
        action: "focus",
        cwd: s.cwd
      },
      mods: {
        ctrl: {
          variables: { action: "copy" },
          subtitle: T("⌃回车 复制完整路径：", "⌃↩ copy full path: ") + (shortCwd || s.cwd)
        }
      }
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

runMain();
