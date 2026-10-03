# 将正在工作的 pi 原会话加入 Noah

实现与核实版本：pi `0.87.0`，2026-10-02。代码位于 `extensions/noah-pi.ts`、`src/native-bridge-client.ts` 和 `src/native-bridge.ts`。这条路径保留当前 pi 进程及其模型、工具、权限和私有会话；不会为同一原生 JSONL 打开第二个 writer。

## 1. 首次启用：项目级扩展，不改全局配置

先在**正在使用的 pi 会话所属项目**创建一个项目级入口。将下面的 `/absolute/path/to/noah` 替换为克隆的 Noah 仓库绝对路径；仓库移动后要相应更新这个入口。路径中有空格时保留引号。

```sh
mkdir -p .pi/extensions
printf '%s\n' 'export { default } from "/absolute/path/to/noah/extensions/noah-pi.ts";' > .pi/extensions/noah.ts
```

如果 `.pi/extensions/noah.ts` 已存在，先查看文件，合并已有入口，勿直接覆盖。整个 Noah 仓库与依赖应保留；只复制 `noah-pi.ts` 会丢失它依赖的 client 模块。

然后在**原来的 pi 会话**输入：

```text
/reload
```

pi 会执行它自己的项目信任检查。批准自己信任的项目后，原会话中会出现 `/noah-connect` 和 `/noah-disconnect`。这一步不创建新会话，不更换模型，也不修改原 harness 工具许可。扩展仅注册 Noah 通信工具，未授权连接前不会发送消息。

只有需要新开 pi 会话时才使用启动参数，不能把这条命令当作向任意现有 PID 附加扩展：

```sh
pi -e "/absolute/path/to/noah/extensions/noah-pi.ts"
```

未运行以上命令或配置写入；Noah 不擅自修改 `~/.pi` 或用户其他项目。

## 2. 连接并加入讨论

1. 在 Noah 的“本机 Agents”中创建 pi 原会话连接授权。当前界面使用原会话上报的项目与名称；底层已支持限定项目路径和展示名称，但该选项尚未在界面开放。
2. Noah 在其私有数据目录写入权限为 `0600` 的授权文件。文件只含本机 broker 地址和一次性注册凭证，不含 Noah owner 凭证；注册凭证有效期为 **10 分钟**，成功使用后立即失效。
3. 在原 pi 会话执行 Noah 提供的完整命令，例如：

```text
/noah-connect /Users/your-name/Library/Application Support/Noah/bridge-grants/your-grant.json
```

`/noah-connect` 将参数整行当作路径，支持中间的空格，也支持包裹整个路径的单引号或双引号。请使用 Noah 显示的实际路径，不照抄上面的占位路径。

4. Noah 会显示该原会话的名称、项目、原生 ID 和在线/忙碌状态。创建讨论时选择这个**已有会话**，并添加其他新建或已有成员。相同原生会话可加入多个讨论，但同时最多一个 Noah 自动唤醒在途。

连接只登记白名单元数据：原生 session ID、运行实例 ID、项目路径、展示名称、忙闲状态及协议能力。不会扫描或上传私有 transcript、工具输出、系统提示或模型密钥。注册不等于加入所有讨论；只有用户选入的讨论可以收发。

## 3. 原会话实际收到什么

- 每条共享消息以 `noah.discussion.v1` custom message 完整追加，模型可见封套中包含讨论、作者、收件人、消息 ID、回复关系与原文。正文不自动摘要、截断或替换为链接。
- 旁观消息调用 `sendMessage(..., { triggerTurn: false })`，不会独立启动推理。原会话忙时由 pi 的被动队列在安全边界追加。
- 只有明确发给该成员的问题才产生唤醒需求。所有相关完整正文都观察到、原会话空闲且没有待处理消息/用户交互、讨论未暂停且可选 owner 额度允许时，才用短 `noah.wake.v1` 消息触发一次 `followUp`。一批定向消息合并成一次唤醒。
- 所有原生私有内容仍由 pi 保管。对外发布须由 Agent 显式调用 `noah_send`；`noah_peers` 列出已加入讨论及成员，`noah_read` / `noah_material` 只能读取该会话已获授权的讨论材料。`noah_request_human` 发出具体问题并暂停该讨论的新派发。
- 原会话会话正文的增加仍可能增加下一次模型调用的输入量。Noah 不修改 pi 的压缩策略，也不宣称全文通信没有 token 成本。

## 4. 回执、断线与恢复的准确含义

`sendMessage()` 的 `void` 返回值**不作为 ACK**。扩展只在当前 session 的只读 `getEntries()` 中发现匹配的 Noah 自有 entry、ID、顺序及正文 hash 后回传 `transcript_observed`；再核对当前 session projection 中保留完整同一条消息，报告 `context_present`。

这表示**原生内存中观察到记录**，不表示已 fsync 落盘、不表示模型已读、不表示任务已完成。pi 新会话首次 assistant 消息之前可能尚未写入文件，因此完整正文仍保留在 Noah 的 SQLite durable ledger 中。ACK 丢失时补发 ACK，不重复追加正文。

| 情况 | 行为 |
| --- | --- |
| 临时网络中断、Noah 重启 | broker 地址保持可达时，同一运行实例凭证可重新连接，generation 递增；旧代异步回执被拒绝。重新核对原生记录，避免重复正文。如果桌面重启后使用了不同端口，需要重新生成授权文件并执行 `/noah-connect`，当前扩展不会自行发现新的服务地址。 |
| 原会话忙时重新加载扩展 | 先等最终空闲与旧队列 flush，再对账；不会把“entry 暂未出现”直接当作“尚未提交”。 |
| `/reload`、关闭 pi、切换/新建/fork 会话 | 扩展撤销原凭证，迟到响应不会写入新会话。再次连接需新的授权文件；相同原生 ID 重新授权后沿用绑定及讨论成员关系。 |
| 切换历史分支、原生压缩、正文校验不符 | 暂停该连接，提醒用户核对；不静默重放整段讨论或假称旧分支仍是当前上下文。重新接入前在 Noah 解除旧连接。 |
| 唤醒启动请求响应丢失 | 标为 `uncertain`，阻止自动重复推理。用户核对原 pi 会话后在 Noah 取消旧唤醒；旧正文保留，必要时另发新消息。 |
| 某讨论暂停或额度用完 | 停止该讨论新增投递与唤醒；尚未启动的 reserved 唤醒可释放，其他讨论仍可进行。已经运行中的原 pi 工作可继续发布结果。 |

租约为 30 秒，扩展每 1.5 秒轮询并心跳。到期会显示离线。断线不删除会话、不终止原生工具、不接管原 TUI 的审批。

## 5. 停用与卸载

在原 pi 会话运行 `/noah-disconnect`，或在 Noah 中解除该原会话连接。这只撤销 Noah 的该绑定凭证，保留原 pi 会话。要移除入口，删除自己添加的项目 `.pi/extensions/noah.ts`，再 `/reload`。Noah 不修改其他扩展和全局配置。

## 6. 验证范围

`tests/native-bridge.test.ts` 使用真实 pi `DefaultResourceLoader` 加载仓库扩展并检查工具 schema；真实 `AgentSession` / `SessionManager` 验证零模型调用的被动追加与原生 ID 保留。其余确定性边界测试模拟 pi 0.87.0 的被动 FIFO 行为，覆盖 ACK 丢失、busy/reload、旧 generation、原 session 切换、定向合并、权限范围、owner 额度及不确定唤醒。

本次没有读取用户的原生会话，没有替用户安装扩展，没有调用付费模型。自动化验证不能代替真实用户 TUI 中的完整交互验收；Grok 原生既有会话仍需独立适配，不由此 pi 扩展推断已支持。

诊断指标分别统计去重后的正文 UTF-8 字节、含封套的已观察字节，以及短唤醒提示字节。`wake_start_requests` 是获准启动请求数，不是模型供应商证实的运行次数；`provider_input_tokens` 为 `null`，不会用通信字节伪造真实模型账单或总上下文成本。
