# Grok 原生会话桥接能力核验

> 2026-10-02 增补：本机现为 Grok 1.0.41。Noah 已提供实验性的原会话主动加入代码与 [接入指南](GROK-NATIVE-SETUP.md)，HTTP/CLI 通信回路已验证；真实 Grok hooks → monitor → 模型往返仍未验收。下文保留 2026-09-23 的历史核验，不代表当前版本的所有接口都已验证。

核验日期：2026-09-23。目标是让已经在 Grok 中开展工作的原会话加入 Noah，接收完整、保序的共享讨论增量；原生私有历史继续由 Grok 管理。

## 结论

Grok 有恢复会话、MCP、原生 monitor，以及在同一 leader 内共享会话的机制。它们的边界不同：安装了 Grok、发现历史会话、恢复历史副本、订阅正在运行的会话、向其送入模型可见消息，必须分别报告能力状态。

当前本机没有可发现的运行中 leader。此次没有接入任何用户真实会话，不能报告“原生会话已接通”。现有 Noah adapter 使用隔离的 `GROK_HOME` 和 `--no-leader`，只证明 Noah 管理的会话可工作，不能据此宣称任意终端 Grok 会话均可被无侵入接管。

## 实测范围与版本证据

- 可执行文件：`~/.grok/bin/grok`，解析到 `~/.grok/downloads/grok-1.0.40-macos-aarch64`。
- `grok --version`：`grok 1.0.40 (eb1a2256660d)`。
- `grok leader list --json`：`[]`；默认 `~/.grok/leader.sock` 不存在。只确认 `~/.grok/sessions` 目录存在，没有枚举或读取用户会话正文。
- 只读 CLI 帮助确认 `--resume`、`--continue`、`--fork-session`、`agent --leader/--no-leader`、`--leader-socket`、`leader list/info --json`。
- 协议探针在临时空 `GROK_HOME` 中运行 `grok agent --no-leader stdio`，未传入模型密钥，未调用 `authenticate` 或 `session/prompt`，未创建有效 session。探针只初始化、查询空列表，或对缺失参数/不存在的假 ID 发请求。自己的进程已结束，临时目录已删除。
- 未读取 `~/.grok/config.toml`、凭据文件或真实会话记录；未更改用户配置或全局 skill。

`initialize` 的实际能力包含：

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "sessionCapabilities": { "list": {}, "resume": {}, "close": {} }
  }
}
```

| 能力 | 实测或一手证据 | 可报告的状态 |
| --- | --- | --- |
| `session/list` | 对空隔离目录实际返回 `sessions: []` | 已验证接口可用；没有验证真实历史枚举 |
| `session/new` / `session/load` | 缺少必要字段时返回 `-32602`；`loadSession: true`；当前 Noah 已使用这些入口管理自己的 session | 支持创建/加载；外部原会话接入另行验证 |
| `session/resume` | 初始化广告支持；缺少 `sessionId` 时返回 `-32602` | 接口可用；此次未恢复用户 session |
| 标准 `session/fork` | 仅缺字段时先触发反序列化错误；补齐 `sessionId`、`cwd` 后返回 `-32601 Method not found` | **本机版本不支持标准 fork**，不能把缺字段错误误判为已实现 |
| `_x.ai/session/fork` | 缺字段时要求 `sourceSessionId`；完整假来源参数返回文件不存在 | Grok 扩展路由存在；真实 fork 未执行 |
| `_x.ai/interject` | 假 ID 返回明确的 `session not found` | 扩展路由存在；真实投递、消费回执未验证 |
| leader live attach | 官方源码具有多客户端订阅/driver 路由；本机 leader 清单为空 | 条件性能力，未连接、未端到端验证 |
| 不唤醒模型的 passive append | 本次未找到公开、稳定的通用追加接口 | 不承诺支持；不能编辑历史文件伪造它 |

## 官方源码与版本边界

此次检查的官方仓库固定为 [xai-org/grok-build @ 4247f661689354b831191f11eeeac8424993fe3d](https://github.com/xai-org/grok-build/tree/4247f661689354b831191f11eeeac8424993fe3d)。该树的 [SOURCE_REV](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/SOURCE_REV) 是 `9bb727ccdff0a793ee73bcde4e2e09cbef6b5387`，与本机二进制报告的 `eb1a2256660d` 不同。下面关于运行细节的结论是该源码的静态证据，不是本机版本已经通过真实会话测试的保证；正式 adapter 必须版本门控并做独立测试。

### 发现与连接

1. 安装发现优先解析用户显式路径、`PATH` 和默认管理目录，再用 `--version` 核验。不要把模型配置文件的存在当成 harness 已安装。
2. `grok leader list --json`、`grok leader info --pid <pid> --json` 是现成的进程发现入口。指定自定义 socket 的实例需要显式路径；CLI 只自动发现约定命名的 `~/.grok/leader*.sock`。
3. **不要为自动扫描直接运行 `grok agent --leader stdio`。** 它走 `connect_or_spawn`，连接失败时可能启动、回收或重建 leader；这不是纯枚举操作。`agent stdio` 是否使用 leader 取决于配置，不能假设默认一定复用。
4. 官方 Rust `LeaderClient::connect` 可以只连接现有 socket。其 IPC 使用四字节大端长度加 JSON，并要求注册后等待 ready；没有在本机帮助中发现“不自启 leader、仅接入”的等价 CLI 开关。直接实现此 IPC 意味着维护 Grok 私有协议、版本协商、断线和兼容性测试。
5. ACP `session/list` 可返回 `sessionId`、`cwd`、`title`、`updatedAt` 与分页。扩展 `_x.ai/sessions/list` 在所查源码中提供运行态 roster，并配合 `_x.ai/sessions/changed` 更新；不能将磁盘 mtime 当成会话仍在运行。
6. 没有运行通道时，磁盘仅作为历史发现降级：文档规定 `sessions/<encoded-cwd>/<id>/summary.json`，超长 cwd 分组另有 `.cwd` 文件。提取 ID、目录、标题、模型、时间等白名单字段；不读取 `updates.jsonl`、`chat_history.jsonl`、系统提示或工具结果。

一手代码：[leader 发现与 connect_or_spawn](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/leader/mod.rs#L269)、[IPC framing 与注册](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/leader/protocol.rs#L425)、[列表和 roster](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/agent/handlers/session.rs#L42)。

### load/resume 不是只读订阅

同一 leader 中，`session/load` / `session/resume` 可以附着已有 resident session。可是源码显示，重连仍会更新 `initial_client_mcp_servers` 并发送 `UpdateMcpServers`，还可能重设系统提示覆盖、client hooks、code navigation 和权限模式；加载也会准备认证、恢复模型及处理持久状态。`resume` 只明确跳过历史 replay、禁止恢复代码，并不消除其他重连副作用。

因此不能把现有 Noah adapter 的 `mcpServers: [noah]`、profile、模型和权限配置原样用于用户原会话。尤其不能以空 `mcpServers` 冒充“不修改”：它是重连配置输入，而非一个只读选项。

一手代码：[attach 入口](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L922)、[已有会话的 MCP/hook/提示更新](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1280)、[权限刷新](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1589)、[resume 策略](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L140)。

### driver、审批与并发

leader 给已有 session 增加订阅者时使用 `or_insert` 保留原 driver，附着本身不等于夺取终端执行权。普通反向工具请求只交给 driver；权限、用户提问、计划批准等交互请求却会广播给所有订阅者，首个回答生效。原 TUI 断开后，driver 还可能转交给另一位订阅者。

旁观 adapter 必须与当前 Noah 托管 adapter 分离：不能对不认识的权限请求自动 reject，也不能自动 approve。必须保留原 harness 的审批界面，定义原 driver 消失后的停用行为。Noah 离开协作只应注销自己的成员关系/连接，不应调用 `session/cancel`、`session/close` 或杀掉共享 leader。

普通 `session/prompt` 默认 `_meta.sendNow = false`，所查源码把它送入同一 session 的队列；它不是另一个独立并行模型轮次。不同客户端同时发起请求仍会竞争队列顺序。Noah 应自己按共享事件序号合批、持久化投递记录，而不是为每条讨论独立发起 prompt；未经明确操作不使用 send-now 或 cancel。

一手代码：[订阅保留 driver](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/leader/server.rs#L1825)、[共享交互请求](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/leader/server.rs#L507)、[断开后 driver 迁移](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/leader/server.rs#L1642)、[prompt 队列](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1358)。

### 注入、MCP 和 monitor

`_x.ai/interject` 会把消息送入原会话的 interjection buffer，在安全点消费，不取消当前 turn。但 idle 状态或错过最后消费点时，源码会把消息转换为后续 prompt。因此它不是不调用模型的纯追加接口，返回 `queued` 也不是模型已经消费的回执。

MCP 工具允许原 Agent 显式注册、发送讨论、读取未读增量。HTTP/SSE 是 MCP 传输能力，不能解释为“任意 MCP 通知自动唤醒 Grok 并追加对话”。只接通 MCP 而没有轮询、工具边界、monitor 或其他原生唤醒机制，应显示为“主动读取”，不能显示“实时接通”。

官方 `monitor` 工具是更适合原生会话主动加入的候选：由该会话启动一个读取 Noah 事件流的命令，每行输出进入其通知通道，`persistent: true` 可保持到会话结束。它需要已有 Grok 会话具备并允许 monitor/命令执行，必须由该会话建立。通知过量时 Grok 会自动停止 monitor，所以 Noah 应合并唤醒，而不是逐 token 输出。

Grok hooks 可以用会话 ID、cwd、生命周期事件做注册和状态回报；`PostToolUse.additionalContext` 可在工具边界送入上下文。`SessionStart` / `Notification` 的 stdout 是被忽略的，允许通过的 `UserPromptSubmit.additionalContext` 也不注入；不能把这些 hooks 当通用 idle 推送通道。hooks 可在原 TUI 重新加载，但不能假设未安装的桥接器会自动出现在所有已经运行的会话中。

一手代码：[interject 请求](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/extensions/interject.rs#L14)、[idle fallback](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-shell/src/session/acp_session_impl/interjection.rs#L26)。本机官方指南位于 `~/.grok/docs/user-guide/`；对应的固定源码链接：[monitor](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-pager/docs/user-guide/20-background-tasks.md)、[hooks](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md)。在线一手文档：[MCP](https://docs.x.ai/build/features/mcp-servers)。

## 最小协议示意（未对真实会话执行）

对已经通过版本核验的现有 leader，私有 IPC 注册帧的 JSON 内容如下；外层仍需长度 framing，等待 `registered` / `leader_ready` 后才能发送 ACP。

```json
{"type":"register","client_type":"noah-observer","mode":"stdio","capabilities":{}}
```

ACP 请求放在 `{"type":"acp","payload":"<JSON-RPC string>"}` 内。先初始化、枚举；不为了发现调用 load/resume，也不认证、覆盖模型或权限：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"noah","version":"0.2"},"clientCapabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"session/list","params":{"cwd":"/absolute/project"}}
{"jsonrpc":"2.0","id":3,"method":"_x.ai/sessions/list","params":{}}
```

仅在参与者已经明确加入、属于同一可控运行通道且完成隔离验证后，才考虑投递完整增量批次：

```json
{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"<joined-native-session-id>","prompt":[{"type":"text","text":"Noah 共享讨论，seq 41–45：<按原顺序保留所有共享消息>"}],"_meta":{"promptId":"noah:<thread>:41-45:<delivery-id>","sendNow":false}}}
```

`promptId` 是可用的追踪入口，不能仅凭它宣称所有版本和崩溃路径都 exactly-once。`_x.ai/interject` 的参数为 `sessionId`、`text`、可选 `interjectionId`；它会改变当前/后续模型输入，不属于发现阶段。

## Noah 的建议实现边界（待实现）

- 将状态拆成 `installed`、`history-discovered`、`join-required`、`connected-pull`、`connected-live`、`disconnected`；仅在实际握手后显示已接通。本机当前 Grok 可以报告已安装，不能预填 connected-live。
- 原会话主动注册是第一条可交付路径：工具/命令完成加入，MCP 提供双向消息，monitor 或经验证的 native 通道提供唤醒。leader attach 作为独立、版本门控的增强路径，不先声称可以无侵入连接所有 TUI。
- Noah 保存完整共享事件 journal：`threadId`、全局递增 `seq`、`messageId`、发送者、正文、artifact 引用；每位参与者保存已入队与已消费 cursor。断线只补未确认增量，区分接收、排队和消费。
- 合并短时唤醒，但保留全部共享消息及顺序；不要以摘要替换用户选择的讨论过程。长代码/日志作为完整 artifact 存储并按引用读取，界面说明原文的存放位置，不静默截断。
- 完整讨论进入原生会话后仍会占用上下文并可能触发模型运行；增量投递、合批和 artifact 只能减少重复与无效唤醒，不能承诺零 token 成本。
- 只共享 Noah 明确发送的讨论与资料。自动发现无需导入原生私有聊天；不要通过重写 `updates.jsonl` 或模拟键盘输入来冒充 API 接通。

项目依据：[当前 adapter](../src/adapters.ts#L43) 使用独立 stdio 进程、隔离 home 和 Noah 专用 MCP 权限处理，外部会话桥接必须采用不同的生命周期与权限契约。
