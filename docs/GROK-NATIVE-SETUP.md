# Grok 原工作会话加入 Noah（实验性）

2026-10-03。接口依据为本机 Grok hooks 与 monitor 文档，真实 ACP 结果覆盖 1.0.41 和本次 1.0.46。**隔离 config hooks 下已通过长正文收发、原客户端审批、受控取消及进程退出后的同 ID 恢复；产品 TUI 加入与完整 N15 尚未验收。** 本次新增已知旧回合取消过滤；1.0.46 的取消恢复使用 21 次本地假模型请求、0 paid。长 JSON 输出、孤儿 monitor 续租的历史修复与各次独立结果见[诊断与证据](GROK-NATIVE-PROBE-AUDIT.md)，不把 ACP 结果外推至 TUI/leader。

这不是任意运行中 PID 的热附加器，也不会加载或改写 Grok 的历史文件。隔离 config 只是已验证的诊断入口，不代表可以修改用户日常配置来代替下述 TUI 流程。

## TUI 加入流程（待实机验收）

1. 在 Noah 的“本机 Agents”中生成 Grok 加入授权。授权十分钟有效、只使用一次。Noah 将 `grant.json`、`hooks.json` 写入本机私有目录，权限为 0600；界面只展示路径和指令。
2. 在**正在工作的那个 Grok TUI** 中输入 `/hooks`，按 `a` 添加生成的 `hooks.json` 路径，按 `r` 重载。按 Grok 原有方式确认这个本机 hook；Noah 不修改全局配置、不替换既有 hooks。
3. 将 Noah 给出的加入提示词提交给原 Agent。Agent 用现有 `run_terminal_command` **原样**执行 `joinCommand`。只有这个特定命令才允许 PreToolUse hook 消耗授权，并从真实 hook 输入中获取 session ID 和 cwd。普通工具调用、其他会话的 hook 事件不会自动加入。
4. Agent 用它自己的 `monitor` 工具启动返回的 `monitor.command`，设置 `persistent: true`。首次 monitor 握手后，Noah 才把该会话列为可选成员；仅生成授权或 hook 注册不算已在线。
5. 在 Noah 创建讨论或添加成员时，选中这个 Grok 原工作会话。模型、原工具、审批、当前工作和历史继续由原 Grok 进程管理。

本机官方指南确认 `/hooks` 中 `a` 添加自定义路径、`r` 重载，但本轮尚未实测这套 TUI 加载流程。是否受到组织策略、项目信任或版本影响，应以原 Grok 显示为准。若加入命令报告没有连接，先核对 hook 是否已加载和授权是否过期；不要另启一个 writer 去修改原生 session 文件。已准备不读真实会话、只连接本地假模型的[人工隔离验收流程](GROK-TUI-VERIFICATION.md)；当前电脑控制工具拒绝访问 Ghostty，需要人工操作该步骤。

## 通信机制及回执

| 阶段 | 实际动作 | 能确认什么 |
| --- | --- | --- |
| 注册 | 原会话 hook 发送 session ID、cwd 和一次性授权 | 收到了持有授权的 hook 注册；不读取原生私有正文 |
| 在线 | 原会话启动的 monitor 子命令定期与本机 broker 握手 | 此连接的 monitor 仍在运行；不是模型空闲状态证明 |
| 通知 | broker 将待处理的同一讨论合为一批，monitor 输出一行短通知 | 通知响应已发出；**不证明 Grok 已入上下文或模型已阅读** |
| 全文领取 | 原 Agent 用 CLI 调用 `noah_read`，按编码恢复本页，再沿 `next` 读取后续正文 | 全部分页成功领取才算完整；真实 extended 的 4 个唯一页已无损取回，不等于原生内存观察 |
| 回复 | 原 Agent 显式调用 `noah_send` | 公开消息已经进入 Noah；未发送的工作仍留在原会话 |
| 完成本批 | 原 Agent 在取完所有正文后调用 `noah_complete` | **Agent 自报**本批处理结束；不是独立审计的模型阅读、共识或整个任务完成 |

Grok 当前路径不提供 pi 的 passive append。发给其他成员的旁观消息保留在 Noah 的完整 journal；下次此 Grok 被定向通知时，会和新消息一起完整领取。旁观消息不会单独启动一次模型。`noah_read` 每段至多 12,000 个 UTF-16 code units，并避免拆开 emoji 的 surrogate pair；它给出下一段 cursor，不能跳过未领取正文直接完成。

### CLI 正文编码

Grok 终端可能给长输出行插入换行。为保留正文，`callCommand` 的 stdout 使用缩进 JSON；[共享 formatter](../src/grok-native-output.ts) 将长正文按如下契约输出：

| 接口 | CLI 输出 | 恢复方式 |
| --- | --- | --- |
| `noah_read` | `message.content` 改为 `message.contentEncoding: "concat"` 与 `message.contentChunks` 字符串数组 | 按数组顺序以空分隔符拼接，即 `message.contentChunks.join('')` |
| `noah_material` | 顶层 `content` 改为顶层 `contentEncoding: "concat"` 与 `contentChunks` | 同样按顺序无分隔拼接 |
| broker HTTP 返回 | 仍使用原来的 `content` 字符串 | HTTP body 不采用 CLI 分片编码 |

每个 chunk 的原始 UTF-16 长度和 JSON 转义后的正文长度都不超过 512，按 Unicode code point 切分，不拆开 emoji 的 surrogate pair。512 不含 JSON 引号、缩进等结构字符。原有换行保留在 chunk 字符串里，**不要在 chunk 之间另加换行或空格**。先恢复本页正文，再按 `next` 顺序读取后续页；12,000 的分页边界、原文 offset、totalLength 和 next 游标不因输出编码改变。这里是无损表示，不是摘要、裁剪或新的页大小。

`idle` 表示 Noah 没有一批尚未确认的通知，**不表示原 Grok 的其他工作已经空闲**。Grok 自己安排 monitor 通知进入当前或后续 turn；Noah 不取消正在进行的工作，不抢审批，也不自动开启或放宽工具权限。

## 可用命令

加入结果给出 `callCommand`。Agent 使用原有命令工具将一个 JSON 对象送入其 stdin；凭据从私有授权目录读取，不能放进命令行或讨论正文。

```json
{"name":"noah_peers","args":{}}
{"name":"noah_read","args":{"batchId":"<通知里的批次 ID>"}}
{"name":"noah_send","args":{"conversationId":"<讨论 ID>","recipient":"<成员 ID、all 或 human>","content":"显式公开的工作","clientKey":"<每条消息唯一>"}}
{"name":"noah_complete","args":{"batchId":"<批次 ID>"}}
```

同时提供 `noah_request_human`、`noah_material`、`noah_propose_outcome`、`noah_revise_outcome`、`noah_read_outcomes`、`noah_list_workspaces`、`noah_declare_work`、`noah_release_work`。除读取批次的工具外，均通过 `conversationId` 选择已加入的讨论；结构化结果与工作区字段沿用 [工具定义](../src/tool-definitions.ts)。工作区接口只展示 owner 明确共享的路径和自愿声明，不替 Agent 读取文件、不授予文件权限，也不是文件锁。

## 退出与恢复

- 在 Noah 解除连接，或原 Grok 会话结束，连接失效。Noah 不关闭原会话、不终止共享 leader。monitor 本身也可通过 Grok 原有停止任务操作结束。
- monitor 失联或 Noah 重启时，已发出但未报告完成的一批变为“待核对”。Noah 不自动重复发送旧通知；用户核对后才可解除阻塞。
- monitor 启动时仅逐层读取自身祖先 PID 的 PID、PPID、启动时间和状态，保存父进程链；每次续租前按这些已知 PID 检查。祖先消失、身份或父关系变化、成为僵尸、或无法读取时，monitor 停止并尝试断开连接；启动时仅剩孤儿 shell/系统父链则不续租。它不读取进程参数或聊天内容，不扫描其他进程、不终止原 Grok。
- 父链检查是保守的退出检测，不能证明原会话仍活着：共享 leader 存活而某会话已结束、以及启动前已经脱离原 harness 的其他宿主形态仍须独立验证。合法 wrapper 退出也可能让 Noah 提前断开。实际退出复核结果见[记录](GROK-NATIVE-PROBE-AUDIT.md)，不能用一个 ACP 进程的结果替代全部 TUI/leader 行为。
- 原上下文压缩时，PreCompact hook 暂停连接；StopCancelled 抵达时，没有在途批次则保持连接。有已通知但未完成的批次时，先检查回合身份；只有能确认是早于该批冻结边界的旧回合才忽略，其他情况暂停并转为“待核对”。
- 暂停后先核对旧批次，再解除旧连接，生成新授权并在原会话重新加入。仅点击“已核对”不会恢复凭据，也不自动重发旧消息。压缩后的未知上下文不会被视为仍保有全部旧正文。Noah 不发送 cancel 来抢占原会话；StopCancelled 只响应原 harness 已发生的事件。
- 回合观察来自 UserPromptSubmit 及提供身份时的 PreToolUse；CLI 仅发送 promptId 的 SHA-256，不发送私有 prompt 或工具输入。批次创建时冻结当时观察序号，新回合不会覆盖旧批边界。取消身份未知、缺失或不能证明早于该边界时仍需核对。1.0.46 实测 PreToolUse 没有 ID，首次 submit 又在注册前，因此首轮保持未知；不会为补齐身份扫描原历史或提前记录未加入会话。这是有限的过期报告过滤，不是精确的批次回合归属。
- 移出成员或归档讨论后，此原会话失去该讨论的后续读取与发送权限；历史成员和消息仍保留。
- 默认没有总运行上限。若 owner 设定通知次数或新增输入字节预算，则在下一次通知/正文领取前检查。通知按其文本及结尾换行的 UTF-8 字节预留；`noah_read` 由 broker 和 CLI 共用 formatter，按最终 CLI 输出的 UTF-8 字节预留，包含分片字段、JSON 缩进和结尾换行。读取重试沿用原 charge key，不重复预留。它不计 Grok 额外输出包裹、原工作上下文或 provider token；手动 `noah_material` 沿用既有预算范围，不因为采用相同编码而新增预算预留。

## 已做的关键自检与未完成验证

- 当前取消归属的 3 项关键检查及类型检查通过；真实 1.0.46 `--recovery=cancel` 通过两个原生回合身份、冻结边界和哈希限定请求，并再次确认同 ID 恢复、新授权、旧批不重放、新全文回复与原工作继续，21 次本地假模型、0 paid，清理完成。此前的 1.0.41 cancel/exit 各 18-call 及祖先退出检查是历史独立结果；本次未重跑 exit。失败尝试也保留在诊断记录。
- 原模型响应等待中的消息到达：`node scripts/check-grok-native.ts --hook-source=config --busy` 独立实测通过。原 prompt 尚未返回时通知入队，释放后同 session/PID 收到全文并回复；新增 prompt/cancel 均为 0，9 次本地假模型、0 paid，清理完成。该结果不外推到任意工具执行或恢复窗口。
- `node --test tests/grok-native-bridge.test.ts`：3 个核心场景通过，覆盖合批和全文、断线/成员权限、可选字节预算。
- `node scripts/check-grok-bridge-transport.ts`：真实 loopback HTTP 和真实 Node CLI 子进程完成授权、monitor 单行通知、全文领取、公开回复与退出；**hook 输入是模拟的，没有启动 Grok**。
- 类型检查通过。
- 10-02 历史：隔离 ACP probe 曾进入原生 terminal/monitor 工具，但未完成 hook 注册。其后自动审批曾拒绝进一步启动，因为 ACP 仍暴露广泛原生工具，`--agent-profile` 没有把实际广告工具集收窄到 probe 所需的两个；当时没有将失败报告为成功。
- 10-03 用户回复“继续”并获得工具批准后，运行 [真实 Grok probe](../scripts/check-grok-native.ts) 的 `--hook-source=config` 入口，临时 `HOME` / `GROK_HOME`、本地脚本模型和假密钥下完成真实注册、monitor 唤醒、完整短正文进入请求、显式公开回复、`agent_reported` 和清理。8 次本地假模型请求、0 paid；本次私有 marker 未进入 Noah snapshot。这是成功的 ACP 短正文链路证据，不是 TUI、付费模型或所有原生场景验收。
- session plugin、`plugins.enabled` 和 plugin 根目录 manifest 修正均未使该加载路径完成注册。同一 hooks 对象经隔离 config 成功，不能据此断言 plugin 失败根因已解决。
- 长分页扩展首次真实运行失败：Grok terminal 给长 JSON 行插入换行，导致分页结果解析失败。已增加无损 `contentChunks` 与缩进 JSON 输出，HTTP body 和 12,000 分页不变；[2 条针对检查](../tests/grok-native-output.test.ts) 已通过，分别覆盖长正文/emoji/原始换行，以及最终 CLI 字节预算与重试幂等，类型检查通过，未重跑全套。
- 最终真实复核 `node scripts/check-grok-native.ts --hook-source=config --extended` 在清理后报告成功并退出 0：24,034 个 UTF-16 code units 正文 3 页、第二消息 1 页，共 4 个唯一页；重复 `clientKey` 不新增消息，完整正文进入模型请求。原 ACP 客户端审批等待时 `read_chars=0`，随后实际允许 2 次、拒绝 1 次，拒绝文件不存在。撤销后原 Grok 用独立新 marker 继续工作；同 native ID、PID 和隔离配置保持不变，hook 权限模式为 `default`。19 次本地假模型请求、0 paid，私有 marker 未共享。
- probe 等待 monitor 自动轮次的真实 `turn_completed` 后才发起独立原工作检查，没有用追加 prompt 冒充自动唤醒。没有 `--hook-source=config` 时仍走未注册成功的 plugin 默认路径，不能将无参数运行写成已通过。
- [诊断记录](GROK-NATIVE-PROBE-AUDIT.md) 分开保留 10-02 静态检查、10-03 真实短正文成功及长分页失败，不再将此前审批拒绝写成当前阻塞。该脚本不是默认测试流程；仅按实际覆盖场景记验收，不以全部运行都已通过表述。

本次审批与继续工作使用真实 Grok ACP 的测试客户端，不是手动 TUI 体验；受控取消和进程退出恢复的成功不覆盖所有时序及 shared leader。隔离 TUI 的加载 hook → 原 session ID 注册 → 原生 monitor 触发 → 全文进入原请求 → 显式回复仍须独立实测。上述门槛通过前继续显示“实验性”，不把当前未完成项归为等待这次 probe 的用户批准。
