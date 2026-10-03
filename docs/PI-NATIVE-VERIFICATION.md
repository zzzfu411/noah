# pi 原会话通信链路验证

验证日期：2026-10-02。实测成功时间：11:11 UTC（北京时间 19:11）。

## 证据层级

本轮使用项目锁定的真实 pi SDK、真实 `extensions/noah-pi.ts` 扩展、真实 Noah HTTP 服务及本地 OpenAI-compatible SSE 假模型，跑通了原会话加入、全文接收、原有工具执行、显式发布到 owner 的完整链路。

**这不是 pi TUI 交互验收，也不是实际付费模型的协作质量评估。** 对侧消息由受限 bridge API fixture 发送；本轮没有启动第二个真实 harness。假模型按预设返回工具调用，用于验证 SDK 的真实请求、工具执行和回报通路，不用于证明模型能自主作出正确判断。

脚本：[scripts/verify-pi-native.ts](../scripts/verify-pi-native.ts)。只增加两个关键场景，不扩展为大量边界测试。

## 隔离方式

- 在系统临时目录创建独立项目、pi agent 目录、原生 JSONL 会话、Noah 数据库及授权文件，结束后删除。
- 接入前先创建一个带私有历史的真实 `SessionManager`，并确认历史已经落盘。接入前后使用同一个 `AgentSession` 和 `SessionManager`。
- 所有凭据都是测试值，pi 凭据使用 `InMemoryCredentialStore`。模型目录与资源目录均显式指向临时项目，禁用全局扩展、skills、主题、提示模板及上下文文件发现。
- 模型只指向 `127.0.0.1` 上的假模型服务，关闭模型目录网络刷新、重试和自动压缩；没有真实付费模型请求。
- Noah 的 harness 发现使用空 fixture，创建的讨论只包含 external 成员；如果意外创建受管 harness，脚本立即报错。
- 使用本机 HTTP 代理在内存中检查 bridge 请求体，验证私有历史与真实 `read` 工具输出没有跨过 Noah 的共享边界。不输出原始请求、凭据或私有正文。

## 场景一：原会话接入与完整旁观正文

执行真实扩展命令 `/noah-connect <临时授权文件>`，并通过 Noah owner API 查到与原 native session ID 相符的连接。创建讨论后，对侧 fixture 通过受限 `noah_send` API 发出一条给 owner 的公开消息；原会话作为旁观成员接收。

正文包含中文、换行、代码和较长英文段落。脚本检查原生 custom message 的正文完整匹配，并确认原 `SessionManager` 对象和 native session ID 保持不变。

| 关键结果 | 实测 |
| --- | --- |
| 完整公开正文进入原会话 | 1 条，完整匹配 |
| 原生 Agent 启动次数 | 0 |
| 模型 HTTP 请求数 | 0 |
| 私有历史进入 bridge 请求体 | 否 |

## 场景二：一次原生处理返回 owner

owner 暂停讨论，连续提交两条定向消息后明确继续，使合批验证不依赖轮询时序。原扩展先接收完整正文，再启动一次原生处理。

本地假模型在第一次请求中要求执行原本允许的 `read` 工具，以及 `noah_send`。pi SDK 实际读取临时私有文件，并将显式公开结果提交给 owner；随后第二次模型请求收到工具结果并结束本轮。两次模型请求属于同一次原生唤醒，不能把它们混称为一次 API 调用。

| 关键结果 | 实测 |
| --- | --- |
| 两条定向正文完整进入原会话 | 各 1 次，无重复 |
| 原生 Agent 启动次数 | 1 |
| 模型 HTTP 请求数 | 2，均为本机假模型 |
| 原有 `read` 工具 | 实际成功执行 |
| `noah_send` | 实际成功执行 |
| owner 收到显式结果 | 是 |
| 额外受管 harness 启动 | 0 |
| 原 native ID、会话文件、模型配置、工具白名单 | 均保持 |
| 私有历史、read 输出进入 bridge 请求或 owner state | 均未出现 |

验证还等待了一次额外的实际 bridge 轮询，确认没有再次启动模型。原生 JSONL 文件的 header ID 仍与接入前一致；`read` 保持允许，`bash`、`write` 仍不在原工具白名单中。

## 如何复验

```sh
node scripts/verify-pi-native.ts
```

运行需要允许监听本机随机端口。输出一份 JSON 结果并清理临时目录，不读取或改写用户真实的 pi 会话、Grok 配置或 Noah 数据。初次在受限沙箱内遇到本机监听 `EPERM`，在获得对应执行许可后成功完成。

## 仍需区分的边界

- 真实 TUI 的扩展加载、终端交互、权限提示和长任务中途接入，仍需要单独的实际操作验收；SDK 成功不能替代这些结论。
- 假模型证明执行链路和调用次数，不证明实际模型的讨论质量、保密判断或任务完成度。
- 原生正文的内存观察、模型请求确实包含正文、JSONL 文件保存是不同证据。本轮分别检查了对应状态；不得把一般的 observed 回执改称持久化或模型理解保证。
- 完整公开正文会进入原模型上下文，同时原模型仍能使用它自己的私有工作历史。Noah 没有把私有历史同步给其他成员，也没有把全文压缩为摘要。
- 本脚本未验证 Grok 原进程接入、Codex 或其他 harness，也未改变它们当前的支持状态。

## 2026-10-03：可用性审计发现的完成状态缺陷与修复

审计实际发现两处状态错误，先用定向测试复现失败，再修改实现：

- pi SDK 的 `agent_settled` 在 abort / provider error 后同样发出；原客户端无条件将其当作完成，导致失败回合被标为 `completed`。现在只在当前 native wake 的匹配记录之后，观察到新的 assistant `stop` / `length` 终态，才报告回合结束；error、abort、没有新终态都变为待核对，不自动重放。判断只在原进程内读取终态元信息，不向 broker 发送私有消息内容，完成也不代表共识或任务成功。
- 原 pi 的租约过期、撤销、重连、服务重启 / 退出或上下文暂停，原来可能只有 wake 进入 `uncertain`，其 delivery 仍显示 `transcript_observed`。现在在同一事务中同步在途投递状态，保留正文和原生观察记录；owner 核对仍使用已有取消旧唤醒的操作，不重发旧消息。

[本轮关键检查](../tests/pi-native-outcomes.test.ts) 使用真实 pi SDK 与内存脚本 provider，覆盖 error、abort、正常 stop；每例 1 次本地 provider 调用，无 HTTP、无付费模型。另覆盖连接丢失和旧成功消息不能证明新 wake 完成。5 项定向检查（上述 3 项，加成功合批、丢 ACK 不重复）通过。类型检查因测试导入了 SDK 的 type-only 导出首次失败，改用公开 stream factory 后通过，受影响的 3 项重新通过。未重跑此前的实际 TUI 或原生 HTTP probe，现有 TUI 证据边界保持。
