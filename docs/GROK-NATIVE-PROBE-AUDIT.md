# Grok 原生 probe：静态诊断与真实验证

更新：2026-10-03。当前结论：**隔离 config hooks 入口已经通过真实 Grok ACP 长正文、原客户端审批、受控取消及进程退出后的同 ID 恢复；产品 TUI 加载仍待验收，N15 尚未完成。** 退出时孤儿 monitor 续租缺陷已修复并复测，边界和失败过程均保留如下；旧 plugin probe 的注册失败不构成另一条产品路线，旧执行审批拒绝不再是当前条件。

## 最新补充：迟到取消与真实回合身份

当前桥接新增 UserPromptSubmit 观察。CLI 在本机散列 opaque promptId，只向 broker 提交 `promptIdHash`。当前凭据代际内按首次观察顺序编号，重复旧身份不改变顺序；每个通知批次冻结创建时的最大观察序号。取消身份已知且严格小于该冻结边界才忽略，相同、较新、未知或缺失仍待核对。新授权清空本代观察，旧数据边界默认 0。这个规则排除部分确定过期的报告，不证明批次实际属于哪个原生回合。

3 项关键检查通过：旧取消不误停新批；后续新回合不掩盖对旧批的取消；未知/缺失身份及旧 PreCompact 空请求保持保守行为。凭据更新和旧身份重复观察也在这些场景内核对。最终 `npm run typecheck` 退出 0。

真实验证命令仍为 `node scripts/check-grok-native.ts --hook-source=config --recovery=cancel`，使用已授权的临时 HOME/项目、回环假模型和假 key。

- 首次运行退出 1，6 次本地假模型、0 paid。Grok 报告版本 **1.0.46**；UserPromptSubmit 带身份，但首次事件在显式注册前，PreToolUse 则没有 promptId。probe 错误要求加入和 monitor 两轮都已登记，实际只有后者，因此在真正发出取消前停止。这是验证前置假设错误，不是取消规则失败，也不能把文档中的通用字段当作所有真实事件必有字段。
- 保留运行时的未知身份/default 0 行为，不建立未授权会话缓存。仅在 recovery probe 中加入成功后先完成一个真实原工作回合，再入队讨论；新增检查确认该独立回合的原工具 marker。公开讨论入队后仍不靠追加 prompt 唤醒。
- 修正后真实退出 **0**，**21 次本地假模型、0 paid**，清理完成才输出成功。中断前观察到 **2 个不同原生回合**，批次冻结边界为 **1**；所有 `/turn` 请求只含身份哈希，取消带有已经观察过的身份。
- 正文已返回后执行原 ACP 取消，旧批转 uncertain，原进程仍在；owner 核对并解除后，旧进程退出才用官方 session/load 恢复同 native ID、同 binding，并以新凭据废止旧凭据。旧批不自动重放，新正文完整进入原模型请求，公开回复、真实 turn_completed、独立原工作新 marker 和原配置不变均通过。恢复讨论期间新增 prompt=0、cancel=0。

本次没有重跑 exit、extended、busy 或全部 UI/后端检查。旧 1.0.41 结果仍是以下各自运行的历史证据；不能将所有结果拼成 1.0.46 完整兼容矩阵。没有操作 Ghostty、真实 TUI 或用户已有会话。临时目录已清理，本文保留工具结果摘要，不声称保存全部原始 payload。

## 2026-10-03：加载入口对照与真实 ACP 结果

用户已对说明过的隔离验证回复“继续”，随后真实运行获得工具审批。验证使用临时项目、隔离 `HOME` / `GROK_HOME`、本地脚本模型和假密钥；不是读取或改写用户日常 Grok 配置后运行。当前没有等待该次验证批准的事项。

### 加载入口与 manifest 更正

| 尝试 | 实测结果 | 可以得出的判断 |
| --- | --- | --- |
| 原 session plugin 路径：进程 `--plugin-dir` 与 session `_meta.pluginDirs` | 仍缺少同一 native session 的注册 binding | 不能把“加载参数存在”当作 hooks 生效 |
| 在隔离配置中加入 `plugins.enabled` | 仍未完成注册 | 该改动没有解决本次注册失败 |
| 将 plugin manifest 改为 plugin 根目录的 `plugin.json` | 仍未完成注册 | 原 manifest 路径解释有误，但修正路径并未解决实际失败 |
| 使用 `--hook-source=config`，将同一 hooks 对象写入临时 `GROK_HOME/config.toml` | 注册、原生 monitor 唤醒和公开收发链路成功 | 同一 hook 定义及 Noah 后续链路至少能在该隔离配置入口工作；plugin 路径的失败根因仍未确定 |

先前静态审计将 `.grok-plugin/plugin.json` 认作单个 plugin 的 manifest，这一判断错误。本机 plugin 文档第 185 行（`~/.grok/docs/user-guide/09-plugins.md`，第 185 行） 描述的是 **marketplace index 的兼容路径**；单个 plugin 的可选 manifest 位于 plugin 根目录的 `plugin.json`，同一段布局中也有示例。此次修正仅纠正了路径与文档解释；它本身没有使 plugin probe 注册成功。

成功命令为 `node scripts/check-grok-native.ts --hook-source=config`。这一开关是隔离诊断入口，**不是产品中已验证的 TUI 热加载方案**；它不能证明任意已有 Grok 会话可以即时接入，也不能据此修改用户日常配置。

### 首次短正文成功的证据范围

| 项目 | 2026-10-03 结果 | 边界 |
| --- | --- | --- |
| Runtime | 本机 Grok `1.0.41`，真实 ACP 进程、原生 hooks、`monitor` 与 Noah CLI | 模型响应来自本地脚本，不是付费模型质量验收 |
| 身份 | hook 注册的 native ID 与本次 `session/new` 返回的 ID 一致；公开消息之后仍有同 ID 的 session 更新 | 证明本次新建隔离 ACP 会话的身份保持，不等于已有 TUI、原 PID 或所有恢复窗口验收 |
| 自动接收 | join 后的原生 monitor 在公开消息入队后触发后续处理 | 仅覆盖本次空闲 ACP 路径；心跳或 monitor 启动本身不等于模型已读 |
| 全文 | 一条含中文、emoji 与换行的完整短正文进入模型请求的工具结果 | 尚未覆盖长正文分页、忙时多条保序及重复读取 |
| 回复与回执 | 显式 `noah_send` 公开回复存在，随后得到 `agent_reported` | 这是 Agent 上报处理，不是 pi 式内存观察、共识或任务完成保证 |
| 私有边界 | 预置的私有 marker 未出现在 Noah snapshot 中 | 是本次选定 marker 的检查，不代表对任意私有历史作全面泄漏证明 |
| 请求数 | 8 次本地脚本模型请求，0 次付费模型调用 | 不外推为真实供应商耗时、token 或费用 |
| 清理 | 子进程、服务器、数据库和临时目录清理完成后才输出成功 | 不等于已验证“退出 Noah 后已有 TUI 原工作继续”；测试最后主动关闭隔离进程 |

本节依据 10-03 本任务真实工具输出记录。临时 probe 目录已由脚本清理，本文件保留结果摘要，不声称仓库另存了该次全部原始 hook payload 或进程日志。

这次短正文运行当时尚未核验原审批客户端实际允许/拒绝、忙时或审批等待时投递、退出/恢复/取消及唯一 writer 的全部边界；不能把安装审批 handler 当作这些行为已经发生。后续扩展结果单独记录如下，不以短正文成功覆盖。

### 同日扩展验证：首次长分页失败

在已验证的隔离 config 入口继续长正文分页、原审批允许/拒绝及原工作继续的关键验证。首次扩展运行暴露了真实终端边界：**Grok terminal 给长 JSON 行插入换行，导致分页结果解析失败。** 该次失败没有被计作通过；后续输出修复及最终真实复核结果分别记录如下。

这个失败发生在原生终端输出到模型工具结果的链路。broker 的分页、顺序与幂等检查不能替代该边界；短正文成功也不能保证长 JSON 可解析。修复保留全文，没有通过删减正文、替换成摘要或忽略中间分页规避失败。

### 输出修复与定向检查

已增加 [src/grok-native-output.ts](../src/grok-native-output.ts) 共用 formatter。CLI 的 `noah_read` 将 `message.content` 编码为 `message.contentEncoding: "concat"` 和 `message.contentChunks`；`noah_material` 在顶层采用相同字段。每段原始 UTF-16 长度与 JSON 转义后正文长度均不超过 512，不拆 emoji，按顺序无分隔拼接可恢复原字符串。CLI 使用缩进 JSON，HTTP body、12,000 分页及 next 游标保持原合同。

broker 的 `noah_read` 字节预留也调用同一个 formatter，按最终 CLI 文本的 UTF-8 字节计量，包括缩进和结尾换行；重试 charge key 不变。该变更不将预算改成 token，也不把手动材料读取纳入原本不包含它的预算范围。

[2 项定向检查](../tests/grok-native-output.test.ts) 已通过，覆盖无损长正文/emoji/换行和预算精确值/重试幂等；类型检查通过，没有重新运行全套。这些是 formatter 与 broker 的检查，后续真实长回路另行复核，结果见下节。

### 最终 extended：真实 ACP 复核通过

命令：`node scripts/check-grok-native.ts --hook-source=config --extended`。实际退出码为 0，成功报告在清理完成之后输出。

| 检查 | 2026-10-03 最终真实结果 | 证据边界 |
| --- | --- | --- |
| 运行与身份 | Grok `1.0.41`、`hookSource: isolated-config`；native ID 与 PID 保持不变，隔离配置文件内容完全不变 | 使用新建隔离 ACP 会话；不是已有 TUI 热加载或任意 PID 热附加 |
| 原生链路 | 真实 hook 注册、native monitor 自动唤醒、完整共享正文进入模型请求、显式公开回复均通过 | 使用真实 Grok 原生工具，本地脚本模型决定响应；不是付费模型协作质量比较 |
| 长正文与顺序 | 24,034 个 UTF-16 code units 的正文分 3 页，第二条消息 1 页，共 4 个唯一页；完整拼接匹配，重复 `clientKey` 不新增消息 | 不推定任意长度、任意忙碌状态或所有终端版本均已覆盖 |
| 审批等待 | 原 ACP 客户端持有审批期间 `read_chars=0`，待其处理后才继续 | 覆盖本次真实审批等待边界；不等于所有忙时注入模式验收 |
| 允许与拒绝 | 原客户端实际允许 2 次、拒绝 1 次；拒绝动作的目标文件不存在；hook 中观察到的权限模式为 `default` | ACP 原客户端是测试客户端，不是手动 TUI 审批体验 |
| 撤销后继续工作 | 撤销 Noah 连接后，原 Grok 继续独立原工作，以新 marker 验证；同 PID/ID 保持 | 不依靠旧历史 marker 通过；不是进程退出、崩溃恢复或全部取消场景验收 |
| 私有边界与回执 | 私有 marker 未进入 Noah snapshot；显式回复及 `agent_reported` 保留 | `agent_reported` 是自报处理，不是共识或独立的模型理解保证 |
| 请求与清理 | 19 次本地假模型请求、0 次付费调用；子进程、服务器、数据库及临时目录清理完成 | 请求数不用于估算真实供应商性能；清理不代替产品退出恢复验收 |

为保证证据对应真实阶段，probe 将协作处理与撤销后的原工作检查隔离，并等待实际 `turn_completed`；monitor 的自动轮次尚未结束时不会额外提交 `session/prompt`。只有协作结束后，才进入独立原工作的拒绝/允许步骤。这是验证脚本的证据收集修正，不应另写成产品缺陷或由测试主动 prompt 唤醒 monitor 的成功案例。

短正文 8 次请求和最终 extended 19 次请求是两次独立运行，均使用显式 `--hook-source=config`。不带该开关仍走默认 plugin 路径，该路径未注册成功，不能把无参数 probe 写成通过。完整 N15 仍需已有 TUI 加载、其他忙时情形与进程退出/恢复/取消等对应证据；本次通过只支持上表列出的隔离 ACP 能力。

### 同日忙时到达补充验证

`node scripts/check-grok-native.ts --hook-source=config --busy` 实际运行一次，退出 0，清理完成。暂挂第 3 个已经到达本地 provider 的原模型请求，在原 `session/prompt` 尚未返回时发送 Noah 消息。批次进入 `monitor_notified` 且 `read_chars=0`；暂挂期间还观察到含 Noah 通知的 `session/update:tool_call_update`。释放模型响应后，同 native ID/PID 完成全文、显式回复、`agent_reported` 和真实 `turn_completed`，期间没有新增 `session/prompt` 或 `session/cancel`。9 次本地假模型请求、0 paid。

这项明确覆盖原模型响应等待时消息到达。它不代表任意长工具执行、TUI 中途加载、进程退出重连或取消后的恢复已经通过。与前述 19-call extended 是两次独立运行，不混合统计。

### 同日取消与恢复验证

运行时补上 `StopCancelled`：hook 抵达时若存在 `notified` 批次，将连接暂停、批次和投递转为 `uncertain`，不重发；没有在途批次则保持连接。已有空 `pause` 请求继续表示 PreCompact，私有取消细节不进入 broker。两项定向检查及类型检查通过。

`node scripts/check-grok-native.ts --hook-source=config --recovery=cancel` 第二次真实运行退出 0：

- 原批次已通知且 `noah_read` 正文已返回，下一次本地模型响应被暂挂；通过标准 ACP `session/cancel` 中断，真实 StopCancelled 触发，旧批成为待核对，旧凭据请求返回 401。
- owner 核对旧批并解除连接；旧 Grok 进程实际退出后，才启动新进程，用官方 `session/load` 恢复相同 native ID，再使用新授权加入。沿用同 binding 身份，旧凭据仍无效，没有第二个并行 writer。
- 新消息的完整正文、公开回复及原生 `turn_completed` 通过，恢复后讨论处理期间没有额外 prompt 或 cancel；原工作的新独立 marker 执行，隔离模型配置保持。
- 18 次本地假模型请求，0 次付费调用；子进程、本地服务、数据库和临时目录清理完成后报告通过。

首次同模式运行退出 1（13 次本地假模型、0 paid）：取消转待核对、退出、同 ID load 和新授权注册已发生，但恢复后的正文未完成。定位为 **probe 错把历史通知用于新批次**，随后只修改脚本，要求消息已入队且通知包含当前 broker 的 `notified` batch。该次失败不计作恢复通过，也未修改正文断言或在恢复讨论中追加 prompt。

只读自检发现并保留的时序限制：本机 hooks 文档（`~/.grok/docs/user-guide/10-hooks.md`，第 383 行） 允许取消报告晚于下一回合，`timestamp` 是派发时间。当前没有可靠 `promptId`→批次映射，因此迟到的旧原工作取消可能保守暂停下一批，仍须人工核对；原进程不被关闭、旧批不自动重发。上述通过覆盖本次受控取消窗口，不是所有取消顺序的精准归属证明。

产品 TUI 中途加载及手动审批仍未验收。[人工隔离步骤](GROK-TUI-VERIFICATION.md) 和准备脚本已完成；电脑控制工具明确拒绝访问 Ghostty，本轮没有绕过它。真实 ACP 的批准保持有效，该 UI 限制是另一项条件。

### 退出模式暴露的真实存活判断缺陷

随后 `--hook-source=config --recovery=exit` 退出 1（6 次本地假模型、0 paid）：原 Grok ACP 进程已退出，未观察到 SessionEnd hook；35 秒后批次仍为 notified、binding 仍为 busy，租期持续延长，因此脚本没有进入恢复阶段。进一步只检查本次唯一临时目录对应的进程，确认 bash 的 PPID 已成为 1，而它的 Noah monitor 子进程仍在 poll。验证 Agent 重新校验本次临时路径后精确终止这两个测试进程，随后按两个 PID 查询均为空，清理已完成；未操作其他会话。

这是真实运行时缺陷：monitor 心跳不足以证明其原 harness 仍存活。取消模式通过不能覆盖此退出情形。随后按以下最小修复独立复核。

### 父链退出检查与 exit 复测通过

CLI 在 monitor 启动时仅沿已知 PPID 捕获祖先的 PID、PPID、启动时间和状态；每次续租前只复查这组 PID。祖先消失、重挂、身份变化、僵尸或读取失败时退出自身 monitor，并在 finally 尝试断开。启动时直接被系统收养或仅剩单层孤儿 shell 不续租。没有扫描其他进程、读取参数/会话、杀原 harness 或放宽权限。

一项本机真实 helper→shell→monitor 检查通过：helper 退出后，仍存活的 shell/monitor 没有再发送 poll，monitor 主动断开，随后二者自行退出。类型检查通过。独立 Agent 只读检查未发现新的直接缺陷；没有重跑完整测试集。

修复后仅重跑失败模式：`node scripts/check-grok-native.ts --hook-source=config --recovery=exit`，真实 Grok 1.0.41，退出 0，18 次本地假模型、0 paid，cleanupCompleted=true。

- 已读未完成批次在原进程退出后转为 uncertain，没有自动重发；owner 核对/解除旧连接之后才继续。
- 明确旧进程退出后用官方 session/load 恢复同 native ID，以新授权复用原 binding；旧 credential 返回 401。
- 新正文完整进入恢复后的原模型请求，公开 reply 和原生 turn_completed 通过；讨论处理阶段新增 prompt=0、cancel=0。
- 原工作的新 marker 执行，隔离配置与 default 权限保持。原 Grok 会话没有第二个并行 writer。

这项负向条件修复了本次实际孤儿续租，但不构成原 session 正向活性保证：shared leader 进程仍在而某会话已结束，或初始化前已脱离原 harness 却保留多层宿主链，仍可能无法识别；正常 wrapper 退出则可能保守断开。TUI、leader 及所有取消顺序没有被本次 ACP 结果覆盖，实验标识保持。

## 2026-10-02：静态诊断历史

当时范围：本机官方文档、Noah probe 和 bridge 代码。该次静态检查没有启动任何 Grok 进程，没有读取用户配置、密钥或会话正文，没有更改 `src/` 或打包产物。

**当时结论：尚不能证明修正 `description` 之后的 hook 注册失败根因。** 修正了 probe 的诊断问题，以提高后续验证的辨别能力；这些静态修正不等于 Grok 接入已经修复或验证通过。下表保留当时证据，plugin manifest 解释已依照 10-03 核对更正。

### 当时已有实测与静态检查

| 证据 | 能得出的结论 | 不能据此得出的结论 |
| --- | --- | --- |
| 先前第一次 probe 的 tool result 明确指出 `run_terminal_command` 缺少 `description` | 当次终端调用未成功执行；脚本确实有参数错误，之后已补字段 | 不能解释补字段后仍未注册的问题 |
| 补字段后的已运行 probe 中，终端结果为 `exit: 1` 和 Noah CLI 的统一错误，broker `bindings: []` | 加入没有完成；没有成功保存 broker binding | 不知道 hook 未触发、hook 无操作返回、子进程启动失败还是 HTTP 注册失败 |
| 同次 probe 返回 `Monitor started` | Grok 接受了启动 monitor 的工具调用 | monitor 启动不证明 join 成功，也不证明进程存活、通知消费或模型阅读 |
| 增加观察器和 `_meta.pluginDirs` 后的真实启动被自动审批拒绝 | 修改后的诊断版尚未运行 | 不能把“没有观察器日志”写成 hook 未触发的实测事实 |
| Noah-only HTTP/CLI 检查已通过，hook 输入模拟 | Noah 代码能处理符合预期的 hook 输入，后续自身传输链路可工作 | 不证明真实 Grok 发送了这个输入、加载了 plugin 或消费了 monitor |

上述真实运行结果来自当前任务此前的工具输出；当时的临时 probe 目录在退出时已清理，不能声称现在保有其原生 hook payload 或进程日志。

### 逐项对照

| 检查点 | 文档与代码 | 判断 |
| --- | --- | --- |
| Hook 输入字段 | 本机 hooks 文档（`~/.grok/docs/user-guide/10-hooks.md`，第 267 行） 使用 `hookEventName`、`sessionId`、`cwd`、`toolName` 和 `toolInput.command`；`runGrokHook` 读取同名字段 | 静态一致。没有证据支持“应该改成 snake_case” |
| Event 名称 | 文档示例是 `pre_tool_use`，另有 `hook_event_name: PreToolUse`；实现移除 `_` 并转小写，得到 `pretooluse` | 静态一致 |
| Matcher | 文档说工具事件 matcher 匹配真实工具名；probe 调用 `run_terminal_command`，生成 matcher 为 `^run_terminal_command$` | 静态一致。不能仅因没有注册就断言 regex 错误 |
| 加入命令 | fake provider 与授权文件使用同一个 `joinCommand` 字符串；实现要求 `toolInput.command.trim()` 与它完全一致 | 正常 payload 应匹配；缺少真实 payload，尚不能排除截断、原生转写或其他 guard 提前返回 |
| 子 Agent 排除 | 实现遇到 `subagentType` 提前返回；本机文档（`~/.grok/docs/user-guide/10-hooks.md`，第 411 行） 说明主会话没有该字段 | 没有证据表明当前主会话误带该字段；不能猜成根因 |
| Plugin 结构 | 原检查将 `.grok-plugin/plugin.json` 当作 plugin manifest；本机文档（`~/.grok/docs/user-guide/09-plugins.md`，第 167 行） 实际区分 marketplace index 与 plugin 根目录 `plugin.json` | 10-03 更正：原解释错误；改为根目录 manifest 后注册仍未成功，不能将它写成已解决的根因 |
| Plugin 加载/信任 | 本机文档（`~/.grok/docs/user-guide/09-plugins.md`，第 421 行） 明确 `_meta.pluginDirs` 与 `--plugin-dir` 自动受信任；probe 使用 `--no-leader` | 不能推断缺少 `--trust`、全局安装或项目配置是根因，也不应因此修改用户环境 |
| 两个加载入口 | 当时脚本同时使用 process `--plugin-dir` 和 session `_meta.pluginDirs`；后者在当时最后一次获准运行后添加 | 当时尚未证明组合生效；10-03 该 plugin 路径仍未注册，成功证据来自隔离 config hooks，不能写“加字段已修复” |
| Session 元信息 | session ID 来自 `session/new`，hook 应携带同一个 ID；Noah 注册只接收该 ID、cwd、标签和 scoped 授权 | 原先没有保留可关联的真实 hook 字段；现在增加同 ID / 同 cwd 的诊断布尔值 |
| Tool profile | ACP 文档（`~/.grok/docs/user-guide/15-agent-mode.md`，第 69 行） 仅说明加载 profile；此前实际模型请求仍广告广泛工具 | 不能把 profile 文件中的两个工具视作已生效的能力隔离。10-02 当时自动审批未解除；10-03 已有明确用户授权与工具批准，仍不构成 profile 隔离保证 |

### 10-02 仅修正 probe 的诊断错误

修改文件：[scripts/check-grok-native.ts](../scripts/check-grok-native.ts)。运行源码与发布应用未改动。

1. **不再将 hook 函数返回等同注册成功。** 原观察器无条件写 `joined: true`，但 `runGrokHook` 有多个合法的提前返回。现在先记录 `entered`，返回后实际检查 binding 文件是否存在以及原会话 ID 是否匹配，再给出 `registered`。
2. **只记录定位所需元信息。** 观察器记录事件名、工具名、session ID、cwd 是否存在、是否与 `GROK_SESSION_ID` 相符、是否出现 `subagentType`、是否截断以及命令是否完全匹配；不记录正文、完整 tool input 或凭据。
3. **分辨 hook 侧与 broker 侧。** 增加注册请求的 HTTP 状态、session ID 是否匹配以及 cwd 是否匹配。没有日志时仅报告“没有观察器输出”，不把它直接解释成 plugin 未加载。
4. **加入失败后不再启动 monitor。** 第一次 join 工具返回后，必须在 broker 找到本原生 session 的 binding；否则立即给出 `join_registration_missing` 并停止本轮探针，而不是等待后续 monitor 超时掩盖首个故障。
5. **不再用弱条件冒充结果。** 全文检查递归处理解析后的工具文本、文本数组及 CLI 内嵌 JSON 的转义换行，要求包含完整中文、emoji 和第二行，而非仅出现 marker；同 session 更新必须发生在公开消息入队之后。无目标工具的辅助模型请求不再推进测试阶段。
6. **清理完成后才输出成功。** 成功结果先保存在内存中，关闭子进程、关闭服务器和数据库并删除临时目录后才输出；清理抛错不会留下成功宣称。

### 当时列出的后续最小问题

先验证一次 join，读取观察器和 broker 的关联诊断：

- 无 `entered`：仍需区分 plugin 未加载、matcher 未触发、观察器未成功启动；**不能直接选择其中一种**。
- 有 `entered`，却没有注册 HTTP 请求：用事件字段、命令匹配、子 Agent 标识和错误类型定位本地 guard 或执行错误。
- 收到注册请求但非 201：再检查 broker 校验与授权状态；不根据 CLI 统一错误猜测原因。
- 返回 201 但没有同 ID 的 binding 文件：定位本地文件写入环节。
- broker binding 与本地文件均匹配：才继续确认 monitor 握手与原生通知消费。

当时计划命令为 `node scripts/check-grok-native.ts`，该次静态检查没有执行真实 probe，也没有绕过此前的自动审批拒绝。随后用户明确授权并获得工具批准，10-03 的真实结果已记录在本文前半部分；本段不表示当前仍等待批准。

10-02 静态诊断执行过 `node --check scripts/check-grok-native.ts` 与 `node scripts/check-grok-native.ts --check-text-matcher`。前者语法检查通过；后者仅运行全文匹配纯函数检查，覆盖文本块、跨块文本、转义 JSON、只有前缀及缺失 emoji 的情况，然后在创建临时目录、发现 harness、启动服务器或 Grok **之前退出**。这些历史结果没有执行真实 probe、模型或全套测试；10-03 实测是单独的证据。
