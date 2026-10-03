# Noah 桌面交付记录

验证日期：2026-09-23，macOS Apple Silicon。版本：0.2.0。

## 应用产物

- `release/mac-arm64/Noah.app`：可直接打开的独立桌面应用，已实际启动。
- Electron 44.4.3，内置 Node 24.21.0；后台、pi worker、MCP 桥均使用应用随附运行时，无需系统 Node。
- macOS 后台采用独立 bundle ID 的 Noah Helper（`LSUIElement=true`），应用主进程负责其启动与关闭。
- 应用使用本机 ad-hoc 签名，`codesign --verify --deep --strict` 通过。尚无 Developer ID 发行签名、Apple 公证或自动更新。
- 用户的 Grok CLI 与 `~/.grok/config.toml` 是现有依赖；pi 官方 SDK 随应用提供。没有复制全局模型 key 到应用包。

源码启动：`npm start`。重新打包：`npm run package:mac`。网页开发入口：`npm run dev:web`、`npm run open:web`。

## 已验证行为

| 项目 | 证据 |
| --- | --- |
| 独立窗口 | 实际打开 Noah.app，具有 macOS 三色窗口按钮、Noah / 文件 / 编辑 / 显示 / 窗口 / 帮助菜单；用户无需启动浏览器或配对 token |
| 自动连接 | 应用启动随机回环端口后台，直接显示“已连接”及 Grok 配置中的模型 |
| 创建任务 | 在桌面 UI 中创建“方舟上的第一次对话”，显式选择 `deepseek-v4-flash` |
| 状态持久化 | 原生菜单退出后重开，任务、选中项与完整中文草稿恢复；旧任务保持暂停，等待显式继续 |
| 真实 harness 通信 | 打包应用托管的 Grok → pi → Grok → 人，3 个运行全部 completed，共 5 条共享消息；UI 显示真实消息和各自原生会话 ID |
| 完整退出 | 实际通过菜单退出后，主进程、后台、Grok、MCP 桥和 pi 五个已记录进程均结束；server.lock 与 connection.json 移除，SQLite 和 UI 状态保留 |
| 基础检查 | `npm test` 23/23；`npm run typecheck`；`npm run check:ui` 13 项模拟；Electron 内置 Node 下 Pi worker 恢复及后台测试 8/8 |

真实通信使用用户授权的临时 DeepSeek 配置。默认模型仍来自 Grok 配置（本机为 `grok-4.7`），没有失败后自动切换供应商或修改全局配置。

本机运行证据（含会话内容，未打入应用包）：

- `.noah/desktop-report.json`：任务 `cdb973f2-832e-4ac0-bc6b-5f3ff6049c89` 的共享消息、原生会话与投递结果。
- `.noah/desktop-exit-report.json`：退出后的文件与进程检查。
- `.noah/desktop-build.log`：打包日志。

其中真实协作消息通过桌面后台 API 发起，随后在原生窗口核对展示；不会把这项证据算作 Cmd+Enter 键盘验收。

## 验证边界

原生自动化遇到焦点、输入及无障碍状态同步不稳定。实际窗口启动、菜单、新建任务、中文草稿恢复和消息显示已有证据；Cmd+N / Cmd+L / Cmd+Enter 已实现并在 UI 模拟中覆盖，但原生键盘组合、拖拽、最小窗口、重复打开已有实例尚未逐项完成人工验收。不能将模拟结果等同于这些原生操作全部通过。单后台目录互斥与服务生命周期已有真实进程测试。

当前采用明文目录分发（`asar: false`），让真实 harness 子进程能够直接读取 TypeScript、MCP 和 SDK 资源；这不包含运行数据。它是本机开发版本，完整产品 SPEC 中的其他功能和跨平台发行仍按独立里程碑推进。

## 数据位置

桌面默认保存在 `~/Library/Application Support/Noah/`：

- `workspace/`：SQLite、共享资料与两种 harness 的独立原生会话。
- `ui-state.json`：选中任务、消息草稿和发送重试标识。
- `window-state.json`：窗口尺寸。

关闭窗口后，正在进行的协作继续，遵守用户已启用的可选限制；“退出 Noah”会停止后台。新讨论默认自主协作，旧任务保留原限制和暂停状态，可在下次明确继续时取消限制。再次启动应用不会自动重放中断的任务。旧网页版本的项目 `.noah/` 保留，不自动迁移，避免原生会话路径失配。
