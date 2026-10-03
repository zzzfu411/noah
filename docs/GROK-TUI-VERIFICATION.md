# Grok 原 TUI 中途加入：隔离验收

状态：隔离脚本已准备，语法、定向类型检查及仅准备/清理检查通过，尚未实测 TUI。已有 ACP 成功证据见 [原生验证记录](GROK-NATIVE-PROBE-AUDIT.md)，不能替代本页的 TUI 加载与人工审批。

## 当前操作限制

2026-10-03，电脑控制工具对 `cua.getApp('Ghostty')` 返回：`Computer Use is not allowed to use the app 'com.mitchellh.ghostty' for safety reasons.` 因此本次不能自动操作 Ghostty。没有改用其他终端自动化、PTY 按键或系统事件绕过限制。需要用户手动完成终端步骤，或该工具的访问限制实际解除后继续。

## 可复核的准备

[隔离 fixture](../scripts/prepare-grok-tui-probe.ts) 只准备本机临时项目、临时 HOME/GROK_HOME、Noah broker、本地假模型和启动脚本，不自行启动 Grok。启动脚本只连接本地模型，凭据是假值；不会加载真实用户会话或修改日常配置。结束时清理临时资源。未启动前不能宣称已经观察到原 TUI 的行为。

以已安装 Grok 1.0.41 的实际 `--help` 为准：顶层 TUI 支持 `--cwd`、`--model`、`--permission-mode default`、`--agent`，没有显示 ACP 的 `--agent-profile` / `--no-leader`，也没有显示 `--no-auto-update`。临时配置设置 `cli.use_leader=false`、`cli.auto_update=false`。最小 profile 不能视作原生工具白名单已收窄的保证。

2026-10-03 追加一次仅准备/清理自检：真实启动本地 fixture，观察到 prepared、零模型请求、未加入且 binding=null；确认 hook 文件和 launch.sh 已生成，然后通过控制文件发送 finish。脚本报告 cleanupCompleted=true，临时目录已删除。fixture 自身按未完成 TUI 验收退出 1（预期结果），外层自检退出 0。没有启动 Grok、没有操作终端 UI、没有付费调用；这仅证明准备及清理可用，不是 TUI 接入通过。正式人工验收时需重新生成本轮路径与授权。

## 用户协助的最小流程

1. 助手运行 fixture，给出本次 `launchCommand`、`hookPath` 与状态文件路径。用户在 Ghostty 执行这个生成的启动命令。
2. 在原 Grok TUI 输入本次输出的完整 `originalPrompt`（以 `NOAH_TUI_ORIGINAL` 开头），完成一次无害的原工作；有审批时仅允许本次指定命令。fixture 记录原会话身份和独立结果标记。
3. 在同一个 TUI 输入 `/hooks`，按 `a`，填入本次 `hookPath`。路径是生成的 **hooks.json 文件**，不是 plugin 目录或 grant.json。按实际 UI 确认 Custom hook 来源与启用状态，再按 `r` 重载。不得切换会话、重新启动或打开同一历史的第二个 writer。
4. 输入本次输出的完整 `joinPrompt`（以 `NOAH_TUI_JOIN` 开头），按原审批方式允许精确的加入命令及 monitor。模型响应由本地 fixture 固定生成；不要选择永久允许或更换权限模式。注册 binding 和 `Monitor started` 还不是验收成功。
5. 连接就绪后，助手通过本次 fixture 的控制文件发送一条公开消息。此后用户不再给 Grok 追加 prompt；等待原 monitor 自动触发全文读取、公开回复和完成上报。审批仍由原 TUI 处理。
6. `collaborationPassed=true` 后，助手核验同 native ID、完整正文进入原模型请求、公开回复存在、无私有 marker 共享，并通过 `revokeCommand` 断开该测试连接。再在原 TUI 输入完整 `originalAfterPrompt`（以 `NOAH_TUI_ORIGINAL_AFTER` 开头），完成一次带有新结果标记的独立原工作；`originalAfterSameID=true` 才确认同一原会话继续。
7. 用户退出本次临时 Grok；助手结束 fixture，清理其临时目录和服务。无真实模型费用；不根据 fixture 单方面的成功标签代替上述证据。

授权文件有十分钟有效期。若等待期间过期，应重新准备该隔离 fixture 并使用新路径，不能放宽授权有效期或复用已消耗的 join grant。

准备命令为 `node scripts/prepare-grok-tui-probe.ts`，在仓库根目录执行。脚本打印本轮路径、三个 prompt 和 `queueCommand` / `revokeCommand` / `finishCommand`；不自行启动或操作 Grok。控制文件动作是带唯一 `id` 的 `{ "id": "queue", "action": "queue" }`（另有 `revoke`、`finish`），过早操作被拒后须用新 id 重试。用户退出临时 TUI 后才执行 `finishCommand`，避免删除仍在使用的临时工作目录。脚本最终输出结果并清理临时目录和本地服务。

## 判定

通过至少需要同一 TUI 的“原工作 → 中途加载 hook → 原审批加入 → monitor 自动收发 → 断开后原工作继续”证据。只有日志里的注册、人工发送第二条 prompt 后收到回复、或者使用启动时 config hooks，均不足以完成本项。TUI 中的项目信任提示以实际显示为准，不能从文档猜测并自动授予整个目录额外权限。

测试完成后将实际结果补记到本页；目前保留为待验收。
