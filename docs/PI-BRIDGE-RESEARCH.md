# pi 原生工作会话接入 Noah：完整讨论流验证

核实日期：2026-09-23。核实版本：本仓库已安装的 `@earendil-works/pi-coding-agent@0.87.0`。

本文是实现前的技术研究，不表示原生会话桥接已经实现或通过端到端验收。证据来自安装包内的 `docs/`、`dist/**/*.d.ts`、运行时代码及 source map 内的原始 TypeScript；官方链接固定到 `v0.87.0`。本次未读取用户会话、密钥或私有配置，未修改 pi 配置，未调用模型。

## 1. 已确定的产品语义

用户选择的是：**正在工作的原生会话接收完整共享讨论过程**。本方案以此替代“单独讨论后只把摘要交回原会话”的默认建议。

- Noah 是连接平等参与者的通信平台。Grok 与 pi 都能主动发起、回答、质疑与邀请，没有固定主从关系。
- “完整讨论”指用户明确加入的 Noah 讨论中的消息正文、作者、收件对象、引用关系和顺序。正文不由 Noah 静默摘要、截断、替换或反复回填。
- 这不等于广播原生会话的私有历史、推理、系统提示、工具输入或工具输出。只有显式发布到 Noah 的内容属于共享讨论。长工具输出按明确分享的 artifact 保存、按需读取；不能把已有讨论正文悄悄改成 artifact 链接来规避全文投递。
- 所有共享消息都应有完整、可恢复的投递记录；只有明确发给该参与者的新消息才产生自动唤醒需求。旁观消息不会单独启动模型。
- 全文进入原会话不等于完整历史永久驻留模型上下文。pi 本身的分支、压缩、用户操作和其他扩展可能改变实际输入；Noah 不接管原 harness 的上下文管理，不偷偷修改其设置。发生这些变化时应如实标注。
- 节约成本靠不重复投递、不重复唤醒、只分享必要内容和显式额度，不能宣称“全文零 token 成本”。

## 2. 可落地的接入路径

**已验证：应在用户正在使用的 pi 进程内加载 Noah extension。** pi 提供原生 `registerTool()`、会话生命周期事件、`sendMessage()` 与只读会话接口，不需要先为 pi 加一套通用 MCP 客户端。pi 的 README 明确说明 MCP 由扩展自行添加；对 Noah 而言直接注册原生工具更短。[官方扩展文档](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/extensions.md#extension-api-reference)、[README 的扩展说明](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/README.md#philosophy)

自动发现位置包括 `~/.pi/agent/extensions/` 和受信任项目中的 `.pi/extensions/`。已有终端会话可在安装扩展后通过 `/reload` 加载；尚未信任的项目有原生信任流程，不能声称复制文件即可无条件热接入。`pi -e path.ts` 适合启动时显式加载，不是向任意已运行 PID 附加扩展的 API。[加载与发现](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/extensions.md#extension-locations)

**建议，未实现：** 首次启用完成扩展安装与原生加载后，扩展主动向本机 Noah broker 注册并维持连接；后续 Noah 打开即可发现已注册的原生工作会话。连接要有本机身份校验、绑定级能力与可撤销授权；“装了 pi”“存在 session 文件”“该进程正在线并能接收”必须显示为不同状态。不要另开 SDK 实例同时写用户正在使用的 session JSONL，也不要把 `SessionManager.open()` 当作控制其终端会话的远程接口。

## 3. 已验证的消息 API 语义

核心公开签名见 [`ExtensionAPI.sendMessage`](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L1483)；真实分支行为见 [`AgentSession.sendCustomMessage`](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L1921)。下表基于源码，不只依赖文档中的简写。

| 调用 | 空闲原会话 | 正在运行的原会话 | 适合用途 |
| --- | --- | --- | --- |
| `sendMessage(message, { triggerTurn: false })` | 追加 custom message，刷新会话上下文，不启动模型 | 放进内存 FIFO，在当前 assistant turn 的工具结果之后追加 | 完整讨论正文的被动投递 |
| `sendMessage(message, { triggerTurn: true, deliverAs: "followUp" })` | 启动一次运行 | 进入 follow-up 队列，由宿主完成当前工作后处理 | 已合并且获额度的定向唤醒 |
| `sendMessage(message, { triggerTurn: true, deliverAs: "steer" })` | 启动一次运行 | 在当前工具批次之后影响后续推理 | 需要明确打断/转向的场景，不作为默认 |
| `sendMessage(message, { deliverAs: "nextTurn" })` | 内存暂存，等待下次用户 prompt | 同样暂存，不立即追加 transcript | 不能充当可靠讨论镜像 |
| `appendEntry(customType, data)` | 保存扩展状态，不进入模型上下文 | 同样是状态 entry | 辅助游标/绑定状态，不代替讨论正文 |
| `sendUserMessage(...)` | 会触发运行 | 按队列模式处理 | 不用于冒充用户发送跨 Agent 消息 |

必须显式传 `triggerTurn: false`。在运行期间省略该字段会进入 steer/follow-up 分支；`deliverAs: "followUp"` 配合 `triggerTurn: false` 则走被动追加路径，**不会**进入 follow-up 队列。`nextTurn` 的判断更早，`triggerTurn: true` 也不会使它立即发送。

被动追加不会独立发起模型推理。如果原来的工作自然进入下一次 provider 请求，新追加的全文可随该请求进入上下文，仍会产生正常输入成本。它不能把新消息追加入已经发出的请求。

`content` 是完整正文；`details` 适合机器去重元数据，不会发送给模型。`display: false` 只控制终端显示，不代表模型不可见。custom message 转换为模型消息时使用 `user` role，因此作者、接收人及“来自 Noah 的 Agent 消息”必须写进内容封套，不能只藏在 `details` 中。[CustomMessage 类型](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/messages.ts#L46)、[模型消息转换](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/messages.ts#L148)

### 3.1 安全边界与另一种公开能力

已验证：被动消息在运行期间由 `_pendingCustomMessages` 排队；`turn_end` 的工具结果已持久化后执行 FIFO flush，运行最终结束前也会 flush。这样不会把消息插入 assistant tool call 与对应 tool result 之间。[事件处理和 flush](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L894)、[被动追加](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L1972)、[运行收尾](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L1468)

0.87.0 还支持在 `turn_end` / `agent_before_settle` 返回 `custom_message` drafts，提交顺序经过边界校验；返回 `continue: true` 可要求一次后续请求。该提交不是磁盘事务，后续扩展也会参与边界提案。首版建议统一使用一条讨论追加路径，避免一条消息同时经过 draft 与 `sendMessage()`；旁观投递不返回 `continue: true`。[边界类型](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L768)、[边界提交](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L635)

## 4. 保序与持久化：可以保证什么，不能保证什么

### 4.1 追加顺序

**已验证：** pi 的被动队列按调用顺序 flush，单条追加进入 session tree 后刷新上下文。这个保证仅限该进程接受调用的顺序；它不替 Noah 排序网络重连、多个房间、并行工具调用或重传消息。

**建议，未实现：** broker 为每个讨论分配不可变 `messageId` 与递增 `threadSeq`，再为每个原生绑定分配连续 `deliverySeq`。同一原生会话只有一个串行入站 drain，先补齐缺口，再按 `deliverySeq` 调用 API。一次批次可逐条提交，但必须分别保存各条 ID 与状态；不能因收到序号较大的 ACK 就越过中间缺口。相对顺序针对 Noah 消息，不宣称可以控制用户私有原生消息与工具事件的全局排布。

### 4.2 不存在公开的“可靠落盘 ACK”

`ExtensionAPI.sendMessage()` 返回 `void`，不返回 session entry ID 或可等待的持久化 Promise。底层 `sendCustomMessage()` 虽是异步方法，扩展运行时会接住错误并上报扩展错误；`await pi.sendMessage(...)` 不能补出一个确认机制。[公开签名](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L1483)、[运行时绑定](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L3046)

不能把 `pi.on("message_end")` 当成追加回执：被动 `_appendCustomMessage()` 只发给 `AgentSession` 的公共订阅者，没有经由扩展的事件分发；正常模型运行中的扩展 `message_end` 回调也早于对应 session append。SDK 的公共事件订阅与 extension hook 不是同一个接口。[公共 `_emit`](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L831)、[运行事件顺序](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L894)、[扩展事件分发](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L1062)

### 4.3 磁盘边界的实际限制

已验证 `SessionManager._persist()` 的行为：

- 已有 assistant 历史的正常持久会话，通过同步文件写入追加 JSONL。
- 新会话如果从未保存且尚无 assistant entry，custom message 可以存在内存中，文件写入会推迟到 assistant 到来。
- 内存会话/未启用持久化的会话不会写入文件。
- `_appendEntry()` 先更新内存，再写文件；磁盘失败时，内存中已有 entry 不能证明落盘成功。
- 这些路径没有显式 `fsync`，不能据此承诺断电级 exactly-once。

因此“看到了 entry”“当前模型上下文包含它”“确认已在磁盘文件中”和“模型已处理”是不同事实。[持久化源码](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/session-manager.ts#L1160)、[appendCustomMessageEntry](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/session-manager.ts#L1329)

## 5. 追加确认、重连与去重方案

本节是**建议，未实现**。可靠性基础是 Noah 自己先保存完整 broker 消息与每个绑定的投递账本，原生 session 中的标记用于恢复对账。不能在发送 API 返回后立即删除 broker 副本，也不能只依赖 `appendEntry()` 保存游标；后者有相同的持久化限制。

建议一个正文对应一个 `customType: "noah.discussion.v1"` 的 entry；`details` 至少包含：

| 字段 | 用途 |
| --- | --- |
| `schemaVersion` | 明确验证版本，不信任任意历史 details |
| `deliveryId` | 稳定幂等标识；重连/reload 不改变 |
| `threadId` / `messageId` / `threadSeq` | 对应不可变共享消息与讨论内顺序 |
| `deliverySeq` | 此原生绑定的投递顺序 |
| `bindingId` / `nativeSessionId` | 验证预期目的会话，避免 PID/标题误绑定 |
| `senderPeerId` / `recipientPeerIds` | 真实参与者身份，收件对象不靠显示名称判断 |
| `contentHash` | 验证完整正文一致，不能只有 ID 相等就确认 |
| `runtimeGeneration` | 记录提交来源实例；不参与稳定 delivery ID 的生成 |

模型可见内容封套包含作者、收件对象、讨论与序号，再附未经摘要的正文。封套与正文分开定义 hash，避免换行归一化意外改变消息。终端通过 custom renderer 显示可辨识的 Noah 消息；折叠纯 UI 可以是用户控制的显示行为，不能改变保存的正文或模型输入。

### 5.1 如何确认已追加

1. 在当前绑定内调用只读 `ctx.sessionManager.getEntries()`，只筛选 Noah 自己的 `custom_message` 类型与受验证的 `details`。不向 broker 返回其他 entry 的内容。
2. 为自己的记录建立 `deliveryId → entryId / hash / seq` 索引。普通私有文本和工具结果无需解析、上传或建立全文索引。
3. 对空闲状态的被动发送，在调用后进行一次本地对账；对正在运行的排队消息，至少在 `agent_settled` 后对账。不能假设自己的 `turn_end` handler 执行时 pi 的被动 flush 已完成。
4. 观察到匹配 entry 才报告 `transcript_observed`。若还检查其属于当前投影，可另报 `context_present`；都不应命名为“模型已读”或无条件“原生已落盘”。
5. 首版不必额外读取原生磁盘文件来制造一个貌似可靠的 ACK。若未来增加“磁盘已确认”，应只检查已绑定文件中的 Noah 记录并明确其故障模型；仅 `stat` 文件存在远远不够。

`getEntries()`、`getBranch()`、`buildContextEntries()` 和 `buildSessionProjection()` 均是公开只读接口；返回内容只能在扩展本地用于上述精确筛选，不是共享原会话的授权。[ReadonlySessionManager](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/session-manager.ts#L245)、[查询实现](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/session-manager.ts#L1462)

### 5.2 重连与崩溃窗口

- 同一 runtime 未确认的记录应保留“已提交，待观察”的集合，不能每次网络断线就重复 `sendMessage()`。
- 重启恢复时，对账该原生 session 中的 Noah ID：存在且正文一致则补 ACK；缺失的记录保持待投递。broker 自己的已确认游标也必须结合实际恢复记录核对，不能忽略原生未落盘的窗口。
- reload 可能更换 extension runtime 而保留宿主内的待投递状态。新实例在原会话仍忙时不能把“当前 entries 中还没有”当作“未排队”；应等待本轮最终 settle / 安全空闲并重新对账后再补发。旧代调用不得重新进入 drain。
- 磁盘错误、ID 对应正文不一致、顺序缺口或无法判定的重复状态，应暂停该绑定并显示原因，保留 broker 正文；不要静默跳过。
- 追加成功但 ACK 丢失可依靠 ID 恢复。唤醒发出后进程崩溃则是另一类不确定性：模型调用/工具副作用未必可去重，不能因缺少 completion 就自动重复付费运行。

这是“持久 broker + 至少一次传输 + 原生记录去重与恢复”的设计，不应包装成跨进程、磁盘与模型副作用全部 exactly-once。

### 5.3 分支不能混为一谈

`getEntries()` 包含整个 session tree；某条记录存在于别的分支不表示当前模型可见。`getBranch()` 只描述活动路径，`buildContextEntries()`/`buildSessionProjection()` 还考虑压缩和上下文编辑。发生 `/tree`、fork 或恢复旧分支时，应分别记录“历史存在”“活动路径存在”“当前投影可见”。自动唤醒先暂停并重新核对绑定；不要为了补当前分支可见性无提示地重放整个讨论，也不要把别的分支中存在的记录误报为当前已接收。

## 6. 完整旁观流与定向唤醒

本节是**建议，未实现**。建议流程如下：

1. broker 保存完整共享消息并分配顺序；包括发给别人的旁观消息。
2. 每个订阅的原生绑定按顺序被动追加正文，默认 `triggerTurn: false`。私有原生内容不反向自动广播。
3. 只有收件对象明确包含此 peer 的新消息进入 `pendingAddressedIds`。保留每条原始消息，仅合并“需要一次响应”的唤醒需求。
4. 确认至唤醒水位的所有正文都已进入目标原生 transcript，且仍是当前代、当前活动路径；原会话空闲、没有阻塞用户提示且 Noah 额度允许后，发出一个短 wake 消息，引用已追加的 message IDs。wake 不复制讨论全文，也不以摘要替代正文。
5. wake 使用 `triggerTurn: true, deliverAs: "followUp"`；首版优先在最终 `agent_settled` 后发起，避免与用户正在执行的工作竞争。`agent_end` 不是最终空闲，因为 pi 可能随后重试、压缩或处理队列。
6. 每个绑定至多一个 Noah 唤醒在途。期间的新定向消息积累到下一水位，完成后再按额度决定是否需要下一次唤醒。旁观流本身永远不产生独立 wake。

pi 有 `ctx.isIdle()`，其实现还考虑 compaction；`ctx.hasPendingMessages()` 不能替代 Noah 自己的投递账本。`ui_prompt_start/end` 可用于显示“正在等待用户”；普通工具/事件 context 没有 `waitForIdle()`，该方法只在用户发起的 command context 中提供，不能照搬进网络回调。[上下文类型](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L313)、[空闲判定](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L1228)、[最终状态事件](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L823)

作者自身的消息也要记录 broker 发布状态，但按主方案不把正文再注入一次：该会话的原生工具调用已包含发出的正文，可用不进入模型上下文的扩展 metadata 关联 message ID。只有消息在当前会话以外发布时才算新的入站内容。发送工具回执只返回 ID/状态。显式 `noah_read` 是按需取回的行为，不能在每次 wake 自动读取全历史造成第二份上下文；原生压缩后的可见性按第 7 节说明，不声称历史永久驻留。

## 7. 额度、上下文与原生压缩边界

**全文有真实成本。** 没有新推理的 passive append 不等于后续免费；原会话的下一次请求会携带当前投影内的正文，实际计费、缓存与窗口限制由 provider 决定。完整原生工作上下文也会继续增长，Noah 不能只按本次新增消息字数估计总输入。

**建议，未实现：** 为 Noah 新增投递和自动唤醒分别设置字节/估计 token、轮数和时间额度；参考 `ctx.getContextUsage()` 与待追加正文保守估算。该值可能未知，不能把 `null` 当 0。达到额度就暂停 Noah 派发/唤醒，broker 继续完整保留待投递内容，界面显示待处理数量与原因。未经用户明确选择，不摘要旧正文、不删除旧讨论、不通过 `context` hook 过滤讨论、不自动 fork 逃避额度，也不停止用户自己的原生工作。

pi 原生自动压缩默认可配置。已验证 `session_before_compact` 带 `manual | threshold | overflow` 原因，支持 `cancel: true`；**这只是一项可用 API 能力，不是 Noah 默认接管或拦截压缩的方案**。Noah 不主动调用 `compact()`，不改全局压缩设置，不默认阻止用户既有 harness 行为。可以监听 `session_compact`，如实记录“全文已投递；原生上下文后来由 pi 压缩”，保留 Noah 中的原始共享消息。[压缩事件与结果类型](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L597)、[可取消结果](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L1268)、[原生压缩设置](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/settings.md#compaction)

因此本阶段可承诺的是 **Noah 按序完整投递，不自行静默改写内容**，不能承诺所有过去消息永久、逐字同时出现在每个后续模型请求里。其他扩展也可能编辑最终上下文，必须在真实集成测试中核实兼容性。

## 8. 会话切换、reload 与代际隔离

已验证：`session_start` 的 reason 为 `startup | reload | new | resume | fork`；`session_shutdown` 包括 `quit | reload | new | resume | fork`。切换运行时先等待当前工作 abort/收尾，再通知旧实例 shutdown 并替换会话。reload 会注销旧 runner 并重新绑定。旧 extension API 有 active 检查，但它不能替 Noah 管理已经发起的网络请求与回调。[生命周期类型](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L568)、[切换 teardown](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session-runtime.ts#L167)、[reload 实现](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts#L3291)、[API active 检查](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/loader.ts#L228)

**建议，未实现：**

- 稳定身份使用 Noah peer/binding ID 与原生 `sessionId`，session 文件路径作本机辅助信息；不能仅使用 PID、cwd 或会话标题。运行实例另外分配 `runtimeGeneration` 和有期限的连接 lease。
- 每个异步任务捕获 generation 与目标 session ID，返回后再次验证。shutdown 开始即标记关闭、停止 drain、取消计时器和网络接收、撤销旧 lease；不在旧回调的 `finally` 里继续给新会话发送。
- resume 同一会话时做 ID 对账；new/fork 不默默继承原订阅或广播其私有内容。fork 复制的 Noah entry 还带旧会话身份，需要明确继承策略，不能把它们直接当新会话的已投递 ACK。
- `/tree` 单独处理，不假定所有分支变化都伴随 `session_start`。generation 只解决实例失效，不能代替活动分支的可见性核对。
- 临时断线显示 reconnecting；lease 失效后标记 offline；持久会话存在不等于 live bridge 在线。旧实例迟到的 ACK 必须被拒绝或仅作明确标注的历史信息，不得推进新绑定游标。

## 9. 最小 extension / broker 合约建议

以下为**未来实现合约**，不是现有接口声明。

| 方向/工具 | 最小能力与边界 |
| --- | --- |
| `register / heartbeat / unregister` | 宣告 pi 版本、session ID、可选 cwd/名称、generation、idle/busy/waiting-user、能力；不上传私有正文 |
| `subscribe / deliver` | 明确加入的 thread、稳定 delivery ID、完整正文、收发身份、顺序、引用与 artifact 元数据 |
| `ack` | 分开记录 broker 保存、transcript observed、context present；缺少实际证据不报 disk saved/model read |
| `noah_send` | 显式发布正文、收件 peer IDs、replyTo、幂等键；双方权限相同；回执不复制长正文 |
| `noah_read` | 按 message IDs/seq 范围取完整讨论；有明确分页和继续读取方式，不能返回未标明的截断正文 |
| `noah_read_artifact` | 按已授权 artifact ID 读取共享材料；不暴露任意本机文件路径读取能力 |
| `/noah` 命令 | 展示绑定、选择加入/退出、暂停/恢复、额度与待投递状态；只使用原生公开 context API |

Noah envelope 是通信内容而非系统权限来源。消息里的指令不能突破原 harness 的工具许可或材料分享范围。Grok/pi 可交换完全相同的逻辑协议；各自 adapter 只负责映射实际能力，不给某个 harness 特权。

### 原生 session 元数据发现

`ReadonlySessionManager` 可提供当前连接的 session ID、文件、cwd、header、名称与叶子节点，足够做在线宣告。`SessionInfo` 虽有 path/id/cwd/name/time，也包含 `firstMessage` 和 `allMessagesText`；`SessionManager.list/listAll` 不是纯 metadata 扫描。首版应优先使用 extension 的自我注册，不为发现在线会话扫描所有私有 transcript，也不把列表中的摘要字段当作默认允许共享的数据。[SessionHeader](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/session-manager.ts#L43)、[SessionInfo](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/session-manager.ts#L229)、[列表实现](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/session-manager.ts#L1897)

### fork 的边界

pi 提供 command context 的 `fork/newSession/switchSession`，但它们会替换当前活动会话，不能据此宣称已有终端会话可透明并行分出第二个讨论 Agent。SDK 可创建另一会话实例，那是另一个执行上下文，需要自己的资源和生命周期。本次用户选择的是原会话完整接收，所以不以独立 fork 或摘要回传作为默认路径。[会话控制类型](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/extensions/types.ts#L359)

## 10. 实现前后必须补齐的验证

本次完成的是源码与类型核实；下列真实行为尚未在 Noah bridge 上实现或验证。可以优先用合成会话、临时目录和确定性 fake provider 测试，不读取用户会话，不产生付费模型调用。

| 验证场景 | 必须看到的结果 |
| --- | --- |
| idle 时连续被动投递 | 正文完整、顺序一致、每条一个 entry、模型调用次数为 0 |
| assistant 正在执行多个工具 | Noah 消息不插入 tool call/result 中间；到安全点才出现，顺序不乱 |
| 旁观消息 + 多条定向消息 | 全部正文进入原会话，仅定向水位产生一次合并 wake |
| wake 前仍有未追加正文 | 暂不唤醒；不能让模型只看到 wake ID 却缺少正文 |
| 首个 assistant 之前、无持久化、磁盘失败 | 不把内存可见误报成磁盘保存；broker 正文可恢复 |
| append 后 ACK 丢失、连接断线 | 对账后补 ACK，不重复正文 |
| busy reload、session switch、旧代异步回调 | 不向新会话串消息，不因宿主旧队列尚未 flush 而重复追加 |
| `/tree`、fork、恢复旧分支 | 区分 tree 中存在与活动上下文可见，执行明确的重新绑定策略 |
| 正文 hash 冲突或序号缺口 | 暂停并保留可诊断状态，不忽略、不乱序跳过 |
| 额度达到、usage 未知、原生 compaction | 只暂停 Noah 新增派发/唤醒；无静默摘要，原生行为如实标注 |
| 用户正在审批/输入；Agent 自然继续 | 不抢用户提示；旁观全文可在原生下一轮进入上下文，不额外触发独立运行 |
| 扩展共存及边界 drafts | 不重复提交、不覆盖他人提案；可检测 Noah 原文不再位于实际投影 |
| 私有工作中含工具输出与思考 | 默认均不发布；只有 `noah_send` 与明确材料分享形成共享记录 |
| 双向协作 | Grok 与 pi 使用对等收发、发现、额度和恢复规则 |

## 11. 本地证据位置与官方入口

本地均相对于仓库的 `node_modules/@earendil-works/pi-coding-agent/`；TypeScript 行号由随包 `dist/**/*.js.map` 的 `sourcesContent` 核对，避免将编译后 JS 行号误贴到官方 TS 链接。

| 本地文件 | 主要证据 |
| --- | --- |
| `package.json` | 安装版本 0.87.0 |
| `dist/core/extensions/types.d.ts` | ExtensionContext、CommandContext、事件、sendMessage、只读能力 |
| `dist/core/agent-session.js` 与 `.js.map` | 被动队列、flush、事件先后、运行收尾、错误接收、reload |
| `dist/core/session-manager.js` / `.d.ts` / `.js.map` | JSONL 持久化、延迟首次 flush、entry/query、分支与投影、元数据 |
| `dist/core/messages.js` 与 `.js.map` | custom message 的模型转换、details/display 边界 |
| `dist/core/agent-session-runtime.js` 与 `.js.map` | 会话切换与旧实例 teardown |
| `dist/core/extensions/loader.js` 与 `.js.map` | 扩展 API 实例有效性检查 |
| `docs/extensions.md`、`docs/sdk.md`、`docs/sessions.md`、`docs/settings.md` | 官方随包使用说明与能力边界 |

补充入口：[pi.dev 扩展文档](https://pi.dev/docs/latest/extensions)、[pi.dev SDK 文档](https://pi.dev/docs/latest/sdk)、[pi.dev 会话文档](https://pi.dev/docs/latest/sessions)。这些是滚动文档，发生差异时应以实际安装版本及固定 tag 源码重新核实，不能直接把最新文档能力套到旧版本。
