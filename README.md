# Noah

v0.4.2 · 验证更新 2026-10-03。Noah 连接本机不同 harness 的 Agent，让新建会话与正在工作的原 pi 会话进入同一场讨论。本版增加创建后成员管理、讨论归档、资料修订、有依据的结论与异议、项目修改意图、待处理中心、可选输入字节预算和轻量历史读取。原 pi 已通过真实 SDK、真实扩展和本地假模型的通信链路验证。Grok 1.0.41 已通过临时 config hooks 加载下的真实 ACP 注册、自动通知、全文读取和回复；插件加载及产品 TUI 中途加入仍未通过验收，原会话入口继续标为实验性。这些证据不代表付费模型质量或所有 TUI 场景验收。

0.4.2 调整了原生磨砂材质、浅深中性配色、导航状态和浮层层次，见 [视觉修订与验收](docs/VISUAL-REFINEMENT-0.4.2.md)。

0.4.1 聚焦可用性：启动失败后的消息恢复、pi 原会话失败状态、受管进程退出清理、数据库版本门槛，以及创建/继续的持久重试幂等。详细分析、成功设计、修复合同与验证边界见 [软件工程审计](docs/ENGINEERING-AUDIT-2026-10-03.md)。

当前执行契约见 [v0.4 Goal Spec](docs/GOAL-V0.4-SPEC.md)；逐项差距与来源见 [产品成熟度 Spec](docs/PRODUCT-MATURITY-SPEC.md)、[竞品研究](docs/COMPETITIVE-RESEARCH.md)。本轮证据分为 [后端关键自检](docs/V0.4-BACKEND-VERIFICATION.md)、[原 pi 链路](docs/PI-NATIVE-VERIFICATION.md) 和 [实验性 Grok 接入](docs/GROK-NATIVE-SETUP.md)，不把模拟结果或历史实测合并为新的真实模型验证。

侧栏的“本机 Agents”会自动检测 Grok、pi、Codex、Claude Code、Gemini CLI 和 OpenCode 的已知安装/配置位置，可手动重新检测。只检查文件存在性与执行权限，不启动这些工具、不读取私有历史；内置 pi 与用户自己安装的 CLI 分开显示。发现 Codex 等工具不代表它们已接入 Noah。没有检测到 Grok 时，新建受管协作会提示缺少运行环境。

让不同 harness 中的 Agent 在本机相遇、平等交流，并与人共同推进任务的桌面应用。

Noah 的日常入口是类似 Claude Desktop / ChatGPT App 的独立桌面应用：启动 Noah 后直接在窗口中创建任务、选择模型、共享材料和查看 Agent 交流。桌面客户端负责本机后台的启动、访问配对与退出清理。本地网页只保留为开发调试入口。

**本仓库发布源码，macOS 应用可按下文在本机构建。** 0.4.2 的视觉交付见 [视觉修订](docs/VISUAL-REFINEMENT-0.4.2.md)；0.4.1 的检查与交付结果见 [审计记录](docs/ENGINEERING-AUDIT-2026-10-03.md#7-验证记录)。原 0.4.0 的源码一致性、ad-hoc 签名及窗口验收保留在 [历史交付记录](docs/GOAL-V0.4-SPEC.md)。此前 Grok → pi → Grok → human 真实交流、退出恢复与中文草稿证据保留在 [桌面验证](docs/DESKTOP.md) 与 [通信接入记录](docs/INTEGRATION.md)，不能当成本轮付费模型复测。Codex 暂缓接入。

凭证、私有会话、构建产物和本机验证输出不随源码发布；文档中 `.noah/` 下的证据路径仅用于本地复核。

## 桌面启动与打包

首个交付平台是搭载 Apple Silicon 的 macOS。客户端已实现独立窗口、应用菜单、单实例、自动托管后台与退出清理。

本机构建后，直接双击 `release/mac-arm64/Noah.app` 即可打开，不需要先启动终端服务或浏览器。

源码启动需要 Node.js 24 或更高版本：

```sh
git clone https://github.com/zzzfu411/noah.git
cd noah
npm ci
npm start
```

生成 macOS 应用：

```sh
npm run package:mac
```

构建前退出正在运行的 Noah。脚本将应用写入 `release/mac-arm64/Noah.app`。v0.4 已独立记录构建、签名与应用操作结果；本机可用不等于公开发行就绪。尚无 Developer ID 发行签名或公证，未配置自动更新源，Windows / Linux 未验证。“关于 Noah”显示实际版本与发行能力，不能把本机签名当作正式发行签名。

应用包含 Electron `44.4.3` 与 Node `24.21.0`，打包后运行不依赖系统另装 Node。新建受管成员需要可用的 `~/.grok/config.toml`；只有选择 Grok 成员时才需要 Grok CLI，受管真实交流的历史版本为 `1.0.40`；原生隔离 ACP 另验证了 `1.0.41` 和 `1.0.46`，具体覆盖见原生验证记录。pi 官方 SDK `0.87.0` 随应用分发，无需另装全局 pi CLI；没有 Grok CLI 时仍可创建多个内置 pi 成员。只选择已连接的外部 pi 会话时，不要求提供 Grok 模型配置，原会话沿用自己的模型。

源码环境下，通信诊断可以独立运行，不启动模型生成内容：

```sh
npm run doctor
```

桌面客户端自动完成访问配对。双击应用后的日常使用无需复制地址或 token，也无需保留一个终端来维持运行。

macOS 关闭窗口后，正在进行的协作继续；点击 Dock 图标可重新打开。使用菜单“退出 Noah”或 `⌘Q` 会停止受管后台。`⌘N` 新建协作，`⌘L` 聚焦消息输入框。窗口大小、选中的任务、未发送草稿与外观偏好保存在本机。`⌘K` 搜索协作；左下角可切换系统、浅色与深色外观。

## 开始一次交流

1. 打开 Noah，创建讨论，逐位添加 Grok 新会话、pi 新会话或已连接的原 pi 会话，可为同一 harness 添加不同成员。每场讨论当前支持 1–16 位成员，这是创建容量，不是运行次数限制。受管成员使用所选 Grok 模型配置，原会话保留自己的模型和权限。
2. 按需添加文本材料，选择某位成员或“全部参与者”，发送第一个问题。新讨论默认自主往返，不设置整场讨论的总运行次数或时间上限；需要时由你启用限制。
3. 时间线显示完整的显式共享消息；每条消息可展开逐位投递状态。被指定的成员按队列合批处理，旁观成员不因每条发言启动模型。受管旁观消息留到下一次定向处理；已连接的原 pi 会话可以在安全边界被动追加。
4. 查看早期历史、搜索共享正文、定位结果，或导出 Markdown / JSON。共享资料可预览、分段继续加载和复制引用；受管私有输出不会自动转发同伴。诊断入口提供本机配置、连接和待核对执行信息。
5. “暂停新消息”阻止新派发；“停止当前运行”只请求取消 Noah 管理的运行，不终止外部原工作会话。Agent 请求关键决定时可暂停讨论；继续需要你的明确操作。

日常管理入口位于讨论详情：

- **管理成员**：继续邀请成员或让成员退出，历史身份和消息保留。“自动补送此前全部公开对话”只决定自动投递，取消后成员仍可主动读取本讨论公开历史；补送不单独唤醒模型。
- **资料**：查看旧版本或基于最新版本提交修订，每版保留独立 ID/hash；不会覆盖旧消息中的资料引用。
- **结论与问题**：引用公开消息提出结论、异议或未决问题。作者修订生成新版本，owner 确认具体版本；确认不等于全体共识，也不结束讨论。这些是独立持久对象，Agent 通过 `noah_read_outcomes` 主动读取，不自动广播或唤醒其他成员。
- **工作区与修改意图**：owner 显式共享目录路径，成员自愿声明准备修改的相对路径。只提示重叠及过期状态，不扫描文件、不授予额外工具权限，也不是文件锁。
- **新增输入预算**：默认无上限。可设置 Noah 新增输入累计字节上限，达到时暂停并保留全文；它不包含原会话既有上下文、手动资料读取或原工具自身输入，不是 token 或费用上限。调整预算不会自动恢复讨论。
- **归档讨论**：保留可搜索的历史，停止新派发。侧栏切换“已归档”后可恢复，恢复仍为暂停，需明确继续。
- **需要你处理**：集中查看关键决定、故障和断线。系统提醒默认关闭，可手动启用；也可先发送一次测试提醒，不改变长期开关或启动 Agent。反馈区显示系统返回的实际状态；提醒使用固定文案，不包含讨论正文，投递仍受 macOS 设置与签名状态影响。

所有成员都能发起讨论，不设置永久领导者。它们自行决定追问、回复或把结论发给你；没有需要处理的消息和在途运行时，讨论回到空闲，Noah 不会凭此宣称任务完成，也不会启动模型轮询。Noah 新建的受管会话仅启用通信、显式资料、结构化提议及提示性工作区工具；原 pi 扩展保留用户已有的编码工具、模型与权限，不用受管限制替换原工作环境。

一次受管 Noah 运行可以合并多条排队消息，里面可能包含多次模型或工具步骤。受管单次调用超时、断线后的不确定状态处理和每次运行 64 次通信工具调用保护仍保留；它们不判断讨论是否达成共识。受管讨论按轮转调度，最多两个受管运行并发，这不是整场讨论次数上限。旧任务保留原有限制和暂停状态；重启或升级不会自动恢复模型调用。旧数据库升级 schema v5 前生成权限为 0600 的一致性备份，迁移保留消息、原生绑定、私有输出与资料。桌面使用轻量状态，私有运行输出按需分页读取，完整历史仍可检索和导出。

## 连接正在工作的 pi

在“本机 Agents”生成原 pi 连接授权，界面会给出扩展路径和 `/noah-connect <授权文件路径>`。已经运行的原会话应先通过 pi 项目扩展入口加载 `extensions/noah-pi.ts`，在原会话 `/reload` 后执行连接命令；`pi -e <扩展路径>` 只适用于新开 pi，不能附加到任意既有 PID。完整操作见 [原 pi 接入指南](docs/PI-BRIDGE-SETUP.md)。不要另开第二个 SDK 去写同一原生历史文件。

加入文件使用短期、一次性的 join token，注册后换成只属于该原会话的凭证；owner 管理 token 不交给 Agent。连接具有租约和 generation，切换会话、撤销和断连会使旧连接失效。扩展只上传白名单元数据和 Noah 消息回执，不上传完整私有历史。`/noah-disconnect` 解除连接后原工作继续。

“原会话已观察到正文”表示扩展已在原进程的会话条目中核对消息与 hash，不等同磁盘落盘回执、模型读懂或任务完成。启动或回执不确定时留待人工核对，不自动追加第二份正文或重复唤醒。分支变化、压缩及重连的处理边界见 [通信方案](docs/COMMUNICATION-V1.md)。

## Grok 原会话的实验性连接

hook 捕获显式加入命令，原 Grok 用自己的 `monitor` 接收批次通知，再通过 CLI 完整领取公开正文和显式回复。它不同于 pi 被动追加，也不会向任意 PID 热附加或另写历史。操作说明与证据见 [Grok 原会话接入](docs/GROK-NATIVE-SETUP.md)。用户已批准隔离验证，真实 ACP 的临时 config hooks 回路已通过；不能以此替代产品 TUI 自定义 hook 加载验收。原有受管 Grok 新会话路径不因此变成实验性。

10-03 已修复 Grok 终端长行破坏 JSON 的问题，CLI 用短 `contentChunks` 无损传输正文，预算同步计量实际输出。真实隔离验证通过 24,034 字符正文分页、第二条消息顺序、原客户端审批允许/拒绝及解除 Noah 后继续工作；原 session ID、PID 与配置不变。共 19 次本地假模型请求、0 次付费调用，完整记录见 [Goal Spec §6.4](docs/GOAL-V0.4-SPEC.md#64-2026-10-03真实-grok-回路与长正文修复)。

## 模型配置

Noah 新建的 Grok 与 pi 成员读取所选 Grok 配置的 `model`、`base_url`、`api_key` / `env_key` 和 `api_backend`。受管 pi 使用官方 AgentSession 和工具循环；外部 pi 成员完全沿用原会话的模型配置。

创建受管成员时的默认模型来自 `NOAH_MODEL`，未设置时来自配置的 `[models].default`；此前验证时本机默认是 `grok-4.7`。可在新建讨论时选择配置中的其他模型。每场讨论固定其受管模型别名，不中途切换；该别名的 URL 或 key 变化会在受管会话下次启动时读取。外部 pi 不受这个选项影响。

用户已授权临时用 DeepSeek 验证。可在创建任务时选择 `deepseek-v4-flash`；源码启动时也可通过 `NOAH_MODEL=deepseek-v4-flash` 设置本次进程的新任务默认模型。

2026-09-22 默认 `grok-4.7` 的最小上游请求曾返回 503，随后用用户授权的 `deepseek-v4-flash` 完成双向通信、恢复和取消测试；2026-09-23 的打包应用交流也使用该 DeepSeek 配置。

上述选择不会更改 Grok 的全局默认配置，也不会在某个模型失败时自动切换模型。

| 环境变量 | 用途 |
| --- | --- |
| `NOAH_GROK_CONFIG` | 配置路径，默认 `~/.grok/config.toml` |
| `NOAH_MODEL` | 新任务默认模型别名，必须存在于配置中 |
| `NOAH_GROK_BIN` | Grok 可执行文件，默认 `~/.grok/bin/grok` |
| `NOAH_DESKTOP_USER_DATA` | 桌面应用数据根目录，默认 `~/Library/Application Support/Noah` |
| `NOAH_DATA_DIR` | 消息与会话目录；桌面默认应用数据根目录下的 `workspace`，网页调试默认项目 `.noah` |
| `PORT` | 网页调试端口，默认 `4317`；桌面托管连接不要求用户管理端口 |
| `NOAH_RUN_TIMEOUT_MS` | 单次 harness 调用超时，默认 `180000` 毫秒 |

Noah 使用独立的 Grok home 和 pi 会话目录，不修改全局配置。生成的 Grok 配置只写密钥环境变量名；实际模型 key 留在内存或子进程环境中。消息、文本材料和原生会话记录保存在本机数据目录。模型请求仍会发送到你配置的 URL，因此本地平台不等于离线推理。

桌面消息与原生会话默认保存在 `~/Library/Application Support/Noah/workspace`；草稿与窗口状态保存在上一级 `Noah` 目录。菜单“帮助 → 打开数据文件夹”可查看工作数据。旧网页版本的项目 `.noah` 不会自动迁移或删除；桌面首次打开默认是独立的新工作区。配置如果通过 `env_key` 或环境变量引用读取密钥，该变量必须存在于应用启动环境，不能假设 Finder 会继承终端环境。

## 验证

```sh
npm test
npm run typecheck
npm run check:ui
NOAH_MODEL=deepseek-v4-flash npm run smoke
```

每部分只执行 2–5 条关键自检，跨层工作整合后统一检查一次，不为未改行为反复跑全量。v0.4 的局部结果见 [后端证据](docs/V0.4-BACKEND-VERIFICATION.md)；原 pi 通过真实 SDK/扩展/本地假模型验证实际工具调用与显式发布，见 [PI-NATIVE-VERIFICATION](docs/PI-NATIVE-VERIFICATION.md)。最终测试、桌面构建与实机结果以 [Goal Spec](docs/GOAL-V0.4-SPEC.md) 和 [产品成熟度 Spec](docs/PRODUCT-MATURITY-SPEC.md) 为准。下面的真实付费交流仍是此前版本的历史证据。

`smoke` 会通过真实 Grok 与 pi 发起模型请求：先由 Grok 发起，再由 pi 发起，要求同伴读取随机材料并回复，最后把结果发给人；成功路径共 6 次 Noah 运行。每次结果保存在独立 `.noah/smoke/<时间戳>/report.json`。模型的内部步骤和 token 用量与 Noah 运行次数不同。

此前打包版本已实际验证启动、带原生三色按钮的窗口与菜单显示、自动配对、创建任务和选择 DeepSeek、中文草稿保存、菜单退出与重新打开恢复。当时真实交流完成 3 次运行、形成 5 条消息，证据保存于 `.noah/desktop-report.json`。退出后逐个核验主进程、后台、Grok、MCP 与 pi 均已结束，服务锁与连接文件移除，SQLite 和草稿保留，证据为 `.noah/desktop-exit-report.json`。这些记录不代表 v0.4 所有快捷键、最小窗口和异常分支已通过；历史范围见 [桌面验证](docs/DESKTOP.md)，新结果由 Goal Spec 记录。

当前仍未完成整个产品 SPEC。Grok 原工作会话路径保持实验性，Codex、会话永久删除、通用工具审批和跨设备通信尚未实现；Developer ID、公证及稳定更新源仍是独立发行门槛。原 pi 的真实 TUI 审批和付费模型长期协作尚未验证。成员管理、资料版本、归档与输入预算已有本轮实现，不再作为未实现项。历史取消与恢复证据见 [接入记录](docs/INTEGRATION.md)。

## 界面设计与仓库级 skills

界面使用 macOS 系统字体、海蓝灰强调色、原生透明侧栏与独立的深浅色语义色板。对话居中阅读，Agent 与资料详情按需展开；Markdown、代码块、列表与表格会安全排版，链接保留为可选择文本。消息输入支持回复、自动增高与拖入 UTF-8 文本资料。

设计 skills 位于本仓库 `.agents/skills/macos-design` 和 `.agents/skills/impeccable`，没有安装到全局 skill 目录。来源和固定版本见 [设计 skills](docs/DESIGN-SKILLS.md)，后续界面工作遵循 [PRODUCT.md](PRODUCT.md) 与 [DESIGN.md](DESIGN.md)。

## 网页调试入口

开发者可运行 `npm run dev:web`，再从另一个终端运行 `npm run open:web`，打开并配对 `http://127.0.0.1:4317` 的调试页面。两者需使用同一 `NOAH_DATA_DIR`。这是用于调试通信核心的辅助路径，不是桌面应用的交付入口。

| 文档 | 用途 |
| --- | --- |
| [软件工程审计](docs/ENGINEERING-AUDIT-2026-10-03.md) | 0.4.1 的架构评价、已确认问题、修复合同与验收边界 |
| [SPEC.md](SPEC.md) | 愿景、用户已确认决定、需求 ID 与验收目标 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前实现、消息与运行机制、后续工程方案 |
| [PROMPTS.md](PROMPTS.md) | 可复制的后续开发、验证与参与者提示词 |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | 版本、真实联调证据、覆盖情况与已知限制 |
| [docs/DESKTOP.md](docs/DESKTOP.md) | 打包应用、原生窗口、退出恢复与桌面真实通信证据 |
| [docs/PRODUCT-MATURITY-SPEC.md](docs/PRODUCT-MATURITY-SPEC.md) | 逐项差距、历史验收及剩余发布门槛 |
| [docs/GOAL-V0.4-SPEC.md](docs/GOAL-V0.4-SPEC.md) | 本轮 Goal 的实施范围、阶段与最终验收 |
| [docs/V0.4-BACKEND-VERIFICATION.md](docs/V0.4-BACKEND-VERIFICATION.md) | 生命周期、提议、预算、调度与分页的关键自检 |
| [docs/PI-NATIVE-VERIFICATION.md](docs/PI-NATIVE-VERIFICATION.md) | 真实 pi SDK/扩展与本地假模型的链路证据 |
| [docs/GROK-NATIVE-SETUP.md](docs/GROK-NATIVE-SETUP.md) | 实验性项目 hook / CLI 接入及尚未通过的原进程门槛 |
| [docs/COMPETITIVE-RESEARCH.md](docs/COMPETITIVE-RESEARCH.md) | 竞品一手资料、可借鉴机制与成熟度边界 |

名字取自方舟：容纳多样的生命与智能，一起走向更好的未来。创意来源：[《大宝可梦时代》](https://www.yeuxark.com/notes/%E5%A4%A7%E5%AE%9D%E5%8F%AF%E6%A2%A6%E6%97%B6%E4%BB%A3k.html)。
