# alfred-ghostty

[English](README.md) | [简体中文](README.zh-CN.md)

> Alfred workflow：在 Alfred 中检索并跳转 [Ghostty](https://ghostty.org) 的全部 Tab 与分屏（splits），支持别名、打开目录、复制路径。

灵感来自 [alfred-browser-tabs](https://github.com/epilande/alfred-browser-tabs)（检索浏览器 Tab），基于 **Ghostty 1.4+ 原生 AppleScript 字典**——无需辅助功能权限、无需额外依赖。

## 功能

### `gt` — 检索并跳转

```
gt <关键词>
```

列出 Ghostty 当前**所有窗口 × Tab × 分屏**（一个分屏一项，普通 Tab 自然对应单项）。

匹配维度（拼接为单一 match 串，Alfred 模糊匹配，空格分隔多关键词取交集）：

| 维度 | 来源 |
|---|---|
| 别名 | 通过改名模式设置（见下） |
| 终端标题 | Ghostty 当前 title（含 shell 集成标题） |
| Tab 标题 | 所在 Tab 的标题 |
| 工作目录 | 完整 cwd（终端里 `cd` 后实时更新） |
| 正在运行的进程 | 前台进程 PID 反查（如 `vim`、`htop`；空闲时为 `zsh`） |
| tty | 如 `ttys001` |

| 按键 | 行为 |
|---|---|
| `↩` 回车 | 跳转：窗口置前 → 选中 Tab → 聚焦该分屏 |
| `⌃` + 回车 | 复制该分屏的完整工作目录 |
| 选中项按 `⌘C` | Alfred 原生复制路径 |
| `Tab` | 进入改名模式（见下） |

列表项格式：`W1 · T1 · 窗格2 · ~/path/to/cwd · zsh · ttys001`，各 Tab 当前聚焦的分屏带"当前所在"标记。

### 改名（在 `gt` 内完成）

在 `gt` 列表选中某个分屏按 **Tab**，输入框变为 `改名 ttysNNN `，继续输入别名后回车：

- 别名**立即参与检索**；对聚焦分屏设置别名会同步显示在 Ghostty 的 Tab 栏
- 清空别名回车 = 清除别名、恢复原标题
- 别名写入 Ghostty 的 `name override`，为**会话级**：Ghostty 退出或分屏关闭后失效

### `go` — 打开目录

```
go            ← 无参数
go ~/Workspaces/foo
```

| 输入 | 行为 |
|---|---|
| 无参数 | 默认打开 **Finder 当前目录**（无 Finder 窗口时为个人目录） |
| 输入路径 | 目录补全：`~` 自动展开、无斜杠时相对个人目录；**Tab 逐级下钻**，回车打开 |
| `↩` 回车 | 在新 Tab 打开 |
| `⌘` + 回车 | 在新窗口打开 |

Ghostty 未运行时，`go` 会直接以新窗口拉起 Ghostty 并打开目标目录。

## 安装

1. 要求：macOS、[Alfred 5](https://www.alfredapp.com) + Powerpack、**Ghostty ≥ 1.4**
2. 双击 `dist/alfred-ghostty.alfredworkflow` 导入（或 `make build` 自行打包）
3. 首次授权（各弹一次）：
   - "Alfred 想要控制 **Ghostty**"（gt / go 都需要）
   - "Alfred 想要控制 **Finder**"（只用 go 的 Finder 回退时）

> 不需要辅助功能（Accessibility）权限——走的是 Ghostty 原生脚本字典，不是 GUI 事件模拟。

界面文案跟随系统首选语言自动显示中文或英文。

## 开发

```
make build    # 打包 dist/alfred-ghostty.alfredworkflow
make test     # 三层测试：plist 契约 / Script Filter JSON 契约 / Ghostty 动作集成
make clean
```

脚本本体可直接脱离 Alfred 调试：

```
osascript -l JavaScript src/list-surfaces.js                        # 枚举
osascript -l JavaScript src/go.js "~/Work"                          # 目录补全
action=focus window_id=... tab_id=... terminal_id=... \
  osascript -l JavaScript src/action.js                             # 跳转
```

```
info.plist            # Alfred 对象图：gt(SF) → action.js ← go(SF)，共 3 个对象
src/list-surfaces.js  # 枚举 windows→tabs→terminals + 批量 ps 反查进程名 + 改名模式
src/go.js             # go 补全：Finder 回退、~ 展开、逐级下钻
src/action.js         # 动作分发：focus / copy / rename / open / open_window
```

### 测试说明（`test/run-tests.sh`）

Alfred 没有官方测试机制，本套件按 Alfred 的真实调用契约模拟（cwd = workflow 目录、item 变量 = 环境变量、query = argv），分三层：

1. **info.plist 契约**——连线引用的对象存在、脚本文件存在、无幻影变量、关键词不重复
2. **Script Filter 输出契约**——gt/go 输出的 JSON 符合 Alfred 规范（items 结构、icon 文件存在、变量全为字符串）、go 的目录兜底、改名模式 item
3. **动作集成**——真连 Ghostty：open 开 Tab/窗口（断言 cwd）、split 后 focus 往返、剪贴板往返、rename override 生效与恢复

集成测试在**临时目录的自建 Tab** 里做，不碰你正在用的分屏；退出时按目录反查 shell 进程（`lsof +D`）并 SIGKILL 清理（交互式 zsh 忽略 SIGTERM，且脚本字典的 close 对某些窗口类型会静默失效）。Ghostty 未运行时第 3 层自动跳过。

## 已知限制

- `gt` 结果在单次会话内不自动刷新，重新唤起即刷新
- 别名为会话级，Ghostty 退出后失效
- Alfred 过滤按自身相关度排序，"当前所在"项不保证置顶
- 分屏的几何位置（左/右/上/下）不在 Ghostty 字典中，以"窗格 N"（创建顺序）标注

## 发布

版本由 git tag 驱动：改好 `info.plist` 里的 `version` 并提交后，推送 tag 即可——CI（`.github/workflows/release.yml`）会校验 tag 与 plist 版本一致、跑测试套件、打包并发布带 `.alfredworkflow` 附件的 GitHub Release：

```
git tag v1.0.0 && git push origin v1.3.0
```

## License

MIT。`icon.png` 取自 Ghostty 应用图标，版权归 Ghostty 项目所有。
