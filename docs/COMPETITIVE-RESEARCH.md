# Noah 竞品研究与差距清单

查阅日期：2026-10-02（Asia/Shanghai）  
研究目的：为 Noah 的产品完善 Spec 提供逐项依据，并区分现在可以实施的工作与需要真实 harness 验证的工作。  
范围：AionUi、hcom、Agent Relay、MCP Agent Mail、AgentLink、ensemble、Superset、Conductor。

## 1. 结论与证据边界

Noah 已有独立 macOS 应用、真实 Grok / pi 受管会话互通、持久消息、幂等发送、暂停与不确定投递恢复、讨论标题搜索、Markdown 导出、草稿恢复和基础安装发现。当前最大的差距是：**尚未让新用户可靠地把正在工作的原会话带入讨论，也尚未把全文共享讨论、多个会话实例和可解释的运行状态连成完整流程。**

因此下一步首先是完成通信产品的核心使用路径，再提高日常使用和发行质量。单纯增加支持的 harness 名称、模型数量或视觉装饰，无法解决这些差距。

不能把八个项目统一称为“成熟产品”：

| 类型 | 项目 | 本次可依据的事实 | 不能据此推断的事实 |
| --- | --- | --- | --- |
| 有桌面分发和完整工作流文档的产品 | AionUi、Superset、Conductor | 官方提供应用入口，涵盖创建、使用、查看结果等流程 | 没有实测它们在用户电脑上的稳定性、性能、无障碍质量或所有 adapter 的兼容性 |
| 有专门接口和运维文档的工具 / 基础设施 | hcom、Agent Relay、MCP Agent Mail | 官方公开通信、会话、状态或诊断机制 | 功能列举不等于端到端交付保证；文档中的支持范围仍需逐 harness 验证 |
| 明确标为实验性的项目 | AgentLink、ensemble | AgentLink 标记 experimental v0.5；ensemble 标记 experimental developer tool | 不能因为概念高度相似，就把其可靠性和发布质量当作成熟基准 |

研究使用官方仓库与官方文档；没有安装这些产品、运行它们的测试或登录其服务。表中的竞品能力是“官方公开说明”，不是本地实测结果。Noah 的差距来自本轮实施前的仓库代码与需求文档；并行实施可能随后改变代码，完成状态应由实现记录和测试结果更新，不能把本文的基线描述当成持续实时状态。

## 2. 逐一对比与可学习的机制

### 2.1 AionUi：从发现到团队工作的完整入口

官方说明包括自动发现 CLI、多会话并行，以及 Team 模式的 MCP 服务、异步邮箱、任务板、成员增减和各成员权限提示。Team 模式由 Leader 拆分和汇总任务，不能据此说它已经验证了 Noah 想要的默认平等讨论。[官方仓库](https://github.com/iOfficeAI/AionUi#multi-agent-mode--already-have-cli-agents-bring-them-in)

| 可学机制 | Noah 的对应差距 | 采用方式 |
| --- | --- | --- |
| 检测、选择、启动构成连续流程 | `src/discovery.ts` 检查文件存在，结果尚未变为逐项可操作的首次连接流程 | 每个 harness 显示来源、可新建条件、下一步动作和失败后的修复入口 |
| 每个成员有自己的权限状态 | 固定 Grok / pi 受管会话，尚无外部原会话权限状态 | 保留原 harness 权限，显示谁正在等用户决定；不把它统一改成自动批准 |
| 团队成员可动态调整 | `Store.create()` 固定插入两名成员 | 先独立成员身份与加入 / 离开语义，再提供 UI 操作 |

不照搬：内置办公 Agent、远程聊天渠道、Leader 默认制度。它们会扩大 Noah 当前范围，也不直接提高原会话互通的质量。

### 2.2 hcom：在原生终端工作流中通信

hcom 的公开机制是 hooks → 本地 SQLite → hooks；官方支持表包含 Pi 和 Grok Build。自动集成以 `hcom pi` / `hcom grok` 等包装启动为入口；另有恢复外部历史会话的命令。它证明“保留 harness、增加通信”的路径具有实际工程参考，不能证明任意未装桥接器的运行中会话可以热接入。[官方仓库与支持表](https://github.com/aannoo/hcom#supported-tools)

| 可学机制 | Noah 的对应差距 | 采用方式 |
| --- | --- | --- |
| 通信工具与原生工作共存 | 当前 managed adapter 使用 Noah 自己的环境和受限通信工具 | 原生 bridge 独立于 managed adapter，不接管原工作权限 |
| 状态和事件触发通信 | 当前仅有受管运行状态，没有外部会话生命信号 | session 注册、心跳、过期离线、忙闲边界；不用定期调用模型检查邮箱 |
| 明确支持表与接入入口 | 发现了安装文件仍不足以说明接通 | 将 installed、resumable、join-required、connected-pull、connected-live 分开 |

不照搬：默认观察完整私有 transcript、广泛文件活动共享、跨设备执行。Noah 的共享边界仍是用户选择的公开讨论与资料。

### 2.3 Agent Relay：通信层与运行层分离

官方文档把消息、投递、action 和 event 作为核心，把创建、attach、release、日志与 readiness 放进可选 harness driver。能力记录属于具体 session，同一 harness 的两个会话可因权限和连接状态具有不同能力。[架构入口](https://agentrelay.com/docs/introduction)、[driver 边界](https://agentrelay.com/docs/harness-driver)、[session 能力](https://agentrelay.com/docs/session-capabilities)

| 可学机制 | Noah 的对应差距 | 采用方式 |
| --- | --- | --- |
| 持久消息与实时事件分工 | 已有 SQLite 与 SSE，但 `deliveries`、`runs` 仍紧耦合 | broker 先存消息，通知只加速发现；重连依据账本补齐 |
| per-session 能力协商 | `AgentId` 同时充当 harness 与会话身份 | session 记录接收、被动追加、唤醒、取消、恢复等已验证能力 |
| 生命周期驱动可替换 | `LocalAdapter` 同时处理进程和通信 | managed、native extension、pull bridge 使用不同生命周期契约 |
| 明确投递回执 | 已有基础状态，但一条消息只能有一个 delivery | 一条共享消息对应多个接收者记录，运行状态与投递状态分开 |

不照搬：为了获得本地通信而增加强制云账户、跨团队基础设施或一套通用工作流引擎。可以学习边界与契约，无需整体替换 Noah 的轻量本地服务。

### 2.4 MCP Agent Mail：外部邮箱、检索和可恢复运维

官方提供身份、inbox、讨论串、FTS5 搜索，以及彼此独立的 read / acknowledge 操作；另有 doctor、备份恢复与导出工具。文件预约是 advisory lease，不能当作隔离或硬锁。[官方工具与运维说明](https://github.com/Dicklesworthstone/mcp_agent_mail)

| 可学机制 | Noah 的对应差距 | 采用方式 |
| --- | --- | --- |
| 消息保存在外部并可检索 | 目前只搜索讨论标题；界面 snapshot 是全局最近 1000 条消息 | 提供正文检索、讨论内分页、结果定位和稳定引用 |
| 已读和确认分别记录 | 接受、运行完成与模型真正处理容易被用户混淆 | 文案只表达能证明的状态，不把“接口接受”写成“对方已读” |
| diagnose → backup → repair | 已有 CLI doctor，但桌面内缺少同等可理解入口 | 桌面展示无密钥的检查结果；恢复前给出具体影响和可撤销路径 |
| 内容导出可追溯 | 当前 Markdown 导出有正文与 ID，缺少结构化成员 / 投递元数据 | 保留 Markdown，增加带版本、时间和引用关系的结构化导出 |

不照搬：默认摘要压缩讨论。用户已经选择完整共享讨论进入原会话，搜索和 artifact 读取不能暗中替代正文投递。

### 2.5 AgentLink：把通信状态做成用户看得懂的产品

AgentLink 的桌面说明采用 messenger 视图，展示参与者、连接、请求和投递状态。其文档同时明确：普通 MCP 不能向未准备监听的闲置 GUI 会话注入新一轮；没有原生唤醒机制时，应入箱并通知用户。该项目当前明确标为实验性。[官方说明](https://github.com/Oryntai/AgentLink#client-behavior)

| 可学机制 | Noah 的对应差距 | 采用方式 |
| --- | --- | --- |
| 连接状态和处理状态可读 | 用户需从错误、运行日志推断接入状态 | 参与者卡显示当前连接、排队、处理或等待用户及对应动作 |
| 无监听者时诚实降级 | 外部 bridge 尚未实现，不能预填在线状态 | 无 live 能力时明示“等待原会话读取”，保留可靠 inbox |
| 区分通知与需要回答的请求 | 每个定向普通消息都会形成新的运行任务 | 消息记录是否需要响应，旁观正文同步与响应唤醒分离 |

不照搬：跨用户配对和加密 relay。本轮仍是单台机器上的通信，不能以建立远程系统为完成本地需求的前置条件。

### 2.6 ensemble：显式完成信号与启动前检查

ensemble 公开了结构化消息总线、团队 TUI 和 steer 入口；全员显式 done 后结束团队。默认是 lead / worker，Grok 作为额外成员有文档；仓库整体仍标记实验性。[官方仓库](https://github.com/michelhelsdingen/ensemble)

| 可学机制 | Noah 的对应差距 | 采用方式 |
| --- | --- | --- |
| 启动前检查有具体失败原因 | 检测到文件后仍可能到首轮才发现运行问题 | 显示缺运行时、缺配置、协议不支持、模型服务异常等独立原因 |
| Agent 显式报告完成 | Noah 正确地把无队列视为空闲，但缺少结构化结论 | 引入可修订的结论 / 待决定事项，最终结束由人决定 |
| 观察界面独立于执行 | 当前已有基础查看能力 | 保持 UI 断开不会使消息消失，重连可恢复状态 |

不照搬：默认主从、自动更换用户指定模型 / Agent、默认跳过原生权限，以及把“没有新消息”当作共识。Noah 不需要为自主讨论重新加入默认次数上限。

### 2.7 Superset：可日常使用的桌面工作台

Superset 官方工作流覆盖选择 Agent、运行、查看 patch、测试与预览；提供持久终端、会话恢复 / fork、状态与通知、命令入口。Git worktree 用于分开工作文件，并不等于进程沙箱。[官方仓库](https://github.com/superset-sh/superset)、[Agent 会话与配置](https://docs.superset.sh/agent-integration)、[终端持久化](https://docs.superset.sh/terminal-integration)

| 可学机制 | Noah 的对应差距 | 采用方式 |
| --- | --- | --- |
| 状态提醒能跨窗口被注意到 | Noah 有界面状态，但没有成型的待处理中心与通知策略 | 只提醒待人决定、断线或错误等可行动变化，点击直达对应讨论 |
| 内容与结果可就地检查 | 材料目前主要是名称和 hash；正文阅读偏工具侧 | 增加共享文本预览、复制引用、来源和版本信息 |
| 大量会话仍可查找和恢复 | 全局 snapshot、固定成员 UI 不利于规模增长 | 分页、搜索、置顶 / 归档和正确的恢复语义逐步补齐 |

不照搬：把 Noah 变成完整 IDE。Diff viewer 和 worktree 管理只有在真实协作任务反复需要时再进入范围。

### 2.8 Conductor：结果导向的工作流与发行完整度

Conductor 当前官网强调云工作区、隔离 microVM、多人协作、桌面 / 移动端和 API，并保留 first-party harness。它是完整产品流程的对标，不能视为本地原会话互通已经被验证的替代品。[官方产品页](https://www.conductor.build/)、[官方文档](https://www.conductor.build/docs)

| 可学机制 | Noah 的对应差距 | 采用方式 |
| --- | --- | --- |
| 工作入口、运行、审阅结果连续 | Noah 能讨论，但缺少清晰结论与下一步整理 | 用户能从讨论定位结论、依据、未决问题和所需动作 |
| 明确版本和可安装入口 | 目前 Apple Silicon 开发产物，正式发行闭环未验收 | 分阶段补版本说明、可下载构建、签名 / 公证和更新策略 |
| 后台工作生命周期清楚 | Noah 已有关闭窗口 / 退出区分，但帮助文案仍需与自主模式一致 | 明示关闭窗口继续后台、退出停止受管服务；重启不自动恢复派发 |

不照搬：云环境、付费基础设施和多人账号。它们不是 Noah 本地通信闭环成立的必要条件。

## 3. Noah 代码对应差距：逐项实施输入

下表记录本轮实施前基线。`P0` 指阻塞核心承诺，`P1` 指日常可靠使用，`P2` 指公开发行或扩展场景。优先级表示依赖顺序，不构成所有项目可以在同一轮完成的保证。

| ID | 差距与当前依据 | 对用户的影响 | 优先级 | 完成所需证据 |
| --- | --- | --- | --- | --- |
| CR-01 | `src/store.ts` 的 `AgentId` / `AGENTS`、`sessions` 主键及 `src/server.ts` recipient 枚举写死 Grok / pi | 不能同 harness 加两位成员，不能自由选择人数 | P0 | 两个 pi 加一个 Grok 的创建、路由、隔离、恢复测试；原双成员数据库可迁移 |
| CR-02 | `src/discovery.ts` 明确仅文件存在检测，`sessionsInspected: false` | 检测到安装仍无法选择真正在线的原会话 | P0 | 安装清单与已注册会话清单分开；离线和过期 session 不显示在线 |
| CR-03 | `LocalAdapter` 创建 Noah 的独立会话；原生 pi / Grok bridge 仍是研究文档 | 用户进行到一半的工作仍不能直接邀请其他成员 | P0 | 实际原会话加入、保留工具权限和模型、双向消息、退出讨论后原工作继续 |
| CR-04 | `Engine.run()` 只投递当前定向消息；公开其他消息靠 `noah_read_messages` 按需读取 | 尚未兑现 D16 的完整公开讨论自动增量进入原会话 | P0 | 多成员收到全部共享正文，旁观消息不单独启动推理，断线补齐不重复 |
| CR-05 | `deliveries.message_id` 唯一，且 `runs.id` 直接关联 delivery | 无法表达同一公开消息对多成员的接收状态及合批唤醒 | P0 | 逐成员账本、连续游标、独立 wake 记录；ACK 缺口不被跳过 |
| CR-06 | 缺少原生 binding 的代次、所有者与 session 切换契约 | reload、fork、换会话可能导致重复或串会话 | P0 | 旧代回调拒绝；单写入所有者；busy reload、branch、switch 隔离测试 |
| CR-07 | session 的 `capabilities` 已存 JSON，但缺少贯穿发现、注册、UI 和调度的能力契约 | 用户无法判断支持的是 pull、live 还是只有 resume | P0 | 未实现能力拒绝执行并解释；能力降级时停止依赖该能力的派发 |
| CR-08 | `public/app.js` 只按讨论标题检索；`Store.snapshot()` 全局最近 1000 条消息 | 较早消息仍在数据库，却可能在界面无从找到 | P1 | 中文 / 英文正文查找、按讨论过滤、分页、跳转原消息；大量历史无静默消失 |
| CR-09 | 已有 Markdown 全量导出，但缺少完整成员、时间与投递元数据的结构化格式 | 调试或迁移时难以追溯一次通信 | P1 | 带 schemaVersion 的 JSON 导出；Markdown 可读且不遗漏正文；不导出凭证与私有输出 |
| CR-10 | 当前调用前封套重复 `systemPrompt`，无显式通信开销账本 | 不易解释上下文增加和重复唤醒的原因 | P1 | 记录独立通信字节数、批次数、唤醒原因；token 未提供时显示未知，不估成精确费用 |
| CR-11 | `scripts/doctor.ts` 已能握手 / 创建隔离会话，但缺少桌面诊断面板 | 新用户需要终端才能理解失败阶段 | P1 | 先只读本地检查，主动连接检查明确；结果脱敏、有修复提示，默认不请求模型 |
| CR-12 | UI 可看运行状态，缺少统一待决定 / 故障入口和系统提醒 | 后台协作停住后用户可能不知道原因 | P1 | 事件去重、非重复弹窗、点击定位、尊重系统通知权限；空闲不误报完成 |
| CR-13 | 材料是文本快照与 hash，界面无完整阅读流程 | 用户难以确认实际共享的内容 | P1 | 预览正文、大小、hash、来源说明和复制引用；超限有明确提示，不自动上传目录 |
| CR-14 | 无结构化结论对象；队列空只表示 idle | 用户难以区分暂时停顿、已提出结论和等待决策 | P1 | Agent 可提交结论 / 异议 / 待决定；人可继续讨论或明确结束；无伪共识 |
| CR-15 | `desktop/main.cjs` 和 `electron-builder.yml` 以本机开发分发为基线 | 新机器安装、更新和回滚没有完整验收 | P2 | 干净账号启动、发行包完整性、升级保留数据库 / 草稿 / 暂停状态；签名公证需要真实发行身份 |
| CR-16 | `Engine.pump()` 全局并发数固定为 2，snapshot 返回所有 runs / deliveries | 讨论增加后公平性、延迟和界面负载缺乏度量 | P2 | 有界分页与事件增量；多个讨论公平推进；模型并发策略独立于可选整场讨论限制 |
| CR-17 | 当前 managed sessions 只提供通信和资料工具；未来原会话可能共享目录 | 多个 Agent 操作同一文件时冲突需可见 | P2 | 首先显示成员工作目录与显式写入所有权；真实需求出现后再选 advisory lease 或 worktree，不宣称软租约能隔离 |

相关代码：[Store](../src/store.ts)、[Engine](../src/engine.ts)、[发现](../src/discovery.ts)、[adapter](../src/adapters.ts)、[HTTP API](../src/server.ts)、[前端](../public/app.js)、[desktop](../desktop/main.cjs)、[doctor](../scripts/doctor.ts)。

## 4. 建议的实施顺序与验收门槛

### 阶段 A：先让新用户知道哪些能力真的可用

- 完成 CR-02 / CR-07 的能力展示和下一步动作。没有桥接能力的项目仍可显示“已发现”，但不能提供会失败的“直接加入”按钮。
- 完成 CR-08 / CR-09 / CR-11 / CR-13 中不依赖原生接入的日用闭环：消息查找、完整导出、可理解诊断、共享内容可见。
- 验收使用空数据目录、已有暂停讨论、缺运行时、缺配置四类场景；不能因打开检查页面启动模型或恢复讨论。

### 阶段 B：成员实例与共享讨论账本

- 完成 CR-01 / CR-04 / CR-05 / CR-06 的底层契约：`harnessId`、`sessionId`、`memberId` 分开；公开正文与定向唤醒分开；发送幂等与多接收者投递分开。
- 先用 deterministic adapter 证明多实例、排序、去重、合批、取消和恢复，再接真实 harness。用假 adapter 验证协议不等于原生接入通过。
- 旧讨论迁移保持消息 ID、sender 归属、原模型、已启用限制和暂停状态。不能迁移后自动唤醒。

### 阶段 C：一条原生会话真实加入的闭环

- 优先以已研究的 pi extension 在原进程内注册 / 收取 / 发送。它的被动追加和可观察 entry 能力比“任意外部 GUI 热注入”更明确。
- Grok 采用独立验证路径。当前研究中的 monitor、hook、leader attach 能力和副作用不能混用；不修改原 MCP / 权限设置来制造接通效果。
- 验收原工作仍可继续、公开正文完整、私有历史不上传、旁观不额外启动推理、忙碌时安全排队、断线恢复不重复、离开 Noah 不终止用户原会话。
- 对无法证明的能力明示降级为主动读取或暂不可加入，不通过编辑原生历史文件和模拟键盘伪造接通。

### 阶段 D：把协作变成可持续使用的应用

- 完成 CR-10 / CR-12 / CR-14：开销可解释、待办可行动、结论可定位。没有自动次数上限仍需保留暂停、停止和异常保护。
- 再完成 CR-15 / CR-16：真实新机器发行与升级测试、较大历史和多讨论负载测试。需要外部签名身份的部分单列，不能用 ad-hoc 签名冒充正式公证。

## 5. 保留的产品判断

1. **平等不等于没有协议。** 不设置永久 Leader，同时仍需明确消息作者、收件人、顺序、请求和回执。
2. **自主不等于无边界。** 默认不限制整场讨论的运行次数和时长；保留用户暂停、独立单次超时、不确定副作用保护以及重要决定交给人。
3. **完整共享不等于全部私有上下文。** 只同步公开讨论与明确添加的资料；原会话内部推理和工具输出不会自动广播。
4. **减少重复不等于没有上下文成本。** 正文增量、合批和资料引用减少无效消耗，但完整正文进入模型仍占上下文。
5. **可恢复不等于在线接入。** 文件存在、会话历史、运行进程、已注册 bridge、已确认上下文，是五种不同证据。
6. **日常可靠性比功能数量更值得先学。** 搜索、错误恢复、可理解状态和升级数据保留，会直接影响用户是否继续使用；办公套件、云团队、远程市场暂不增加。

产品基线：[SPEC.md](../SPEC.md)、[PRODUCT.md](../PRODUCT.md)、[通信协议方案](COMMUNICATION-V1.md)、[pi 原生接入研究](PI-BRIDGE-RESEARCH.md)、[Grok 原生接入研究](GROK-BRIDGE-RESEARCH.md)。后两份研究记录了已核实版本与实际测试边界，本次未重新验证安装在用户电脑上的 harness 版本。

## 6. 来源索引

下列来源均于 2026-10-02 查阅。官方链接指向可变文档，因此后续实现前应再次核对相关 adapter 与协议的当前版本；本文没有以 star 数或营销人数判断成熟度。

| 来源 | 用于支持的判断 |
| --- | --- |
| [AionUi GitHub](https://github.com/iOfficeAI/AionUi) | 自动发现、多会话、Team MCP / 异步邮箱、成员权限 |
| [hcom GitHub](https://github.com/aannoo/hcom) | hooks / SQLite、本地通信、包装启动、Pi / Grok 支持、resume 边界 |
| [Agent Relay GitHub](https://github.com/AgentWorkforce/relay) | 产品范围、云与自托管定位 |
| [Relay introduction](https://agentrelay.com/docs/introduction) | 持久消息、实时事件、投递与 session 的分工 |
| [Relay harness driver](https://agentrelay.com/docs/harness-driver) | 可选生命周期管理、条件 attach、driver 边界 |
| [Relay session capabilities](https://agentrelay.com/docs/session-capabilities) | 每个 session 的能力协商与明确失败 |
| [MCP Agent Mail GitHub](https://github.com/Dicklesworthstone/mcp_agent_mail) | inbox / thread / FTS5、read / ACK、诊断恢复和 advisory lease |
| [AgentLink GitHub](https://github.com/Oryntai/AgentLink) | 实验性状态、messenger UI、未监听 GUI 的 MCP 唤醒边界 |
| [ensemble GitHub](https://github.com/michelhelsdingen/ensemble) | 实验性状态、团队总线、显式 done、Grok 成员与 lead / worker |
| [Superset GitHub](https://github.com/superset-sh/superset) | 桌面入口、审阅流程、worktree、状态与命令入口 |
| [Superset Agent integration](https://docs.superset.sh/agent-integration) | Agent 配置、恢复 / fork 入口 |
| [Superset terminal integration](https://docs.superset.sh/terminal-integration) | 终端持久化及恢复说明 |
| [Conductor 官网](https://www.conductor.build/) / [文档](https://www.conductor.build/docs) | 云工作区、多人协作、桌面 / 移动端和 first-party harness 定位 |

本次 Agent Relay 独立 delivery 文档两次抓取超时；本文关于其回执与顺序的描述只使用成功读取的 introduction / session capabilities，不把未读到的内部算法当事实。
