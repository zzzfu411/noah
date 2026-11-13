# Noah

面向 macOS 的本机多 Agent 协作桌面工作区：让新建的受管会话与正在工作的原生 CLI 会话（`pi`、`Grok`）进入同一场讨论，在不迁移上下文、不替换原有工具与权限的前提下与人协同推进任务。

[English](README.md) · 简体中文

## 核心能力

- **跨 Harness 对等讨论** — 单场讨论支持 1–16 位独立命名的参与者，可混合受管 `Grok` / `pi` 新会话与已连接的原生 `pi` 会话，无固定领导者。
- **接入正在工作的原会话** — 通过 `extensions/noah-pi.ts`（`/noah-connect`）与一次性短期令牌接入运行中的 `pi` 会话，保留原会话的模型、编码工具与权限（另附实验性 `Grok` 原生接入链路）。
- **增量全文投递** — 显式共享的讨论消息按增量完整投递，不静默替换为摘要；各 Agent 的私有推理与工具输出默认隔离。
- **版本化资料与结论沉淀** — 支持带不可变修订历史的文本资料共享、基于消息证据的结论/异议/未决问题记录，以及提示性的工作区修改路径声明。
- **可控的人机边界** — 支持随时暂停新派发、设置新增输入字节预算、归档与全文检索历史讨论，并可导出为 Markdown 或脱敏 JSON。

## 快速开始

环境要求：**macOS（Apple Silicon）**、**Node.js 24+**。

```sh
git clone https://github.com/zzzfu411/noah.git
cd noah
npm ci
npm start
```

构建独立 macOS 应用（输出至 `release/mac-arm64/Noah.app`）：

```sh
npm run package:mac
```

运行只读环境与连接诊断（不触发模型请求）：

```sh
npm run doctor
```

## 配置说明

应用内置官方 `pi` SDK（`0.87.0`），无需全局安装 `pi` CLI。新建受管成员从 `~/.grok/config.toml` 读取模型地址与密钥引用，并在隔离目录中运行，不修改全局配置；外部原生 `pi` 会话直接沿用自身模型。讨论与资料默认保存在本机 `~/Library/Application Support/Noah/workspace`（本地存储不代表离线推理，模型请求仍发往你配置的服务端）。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NOAH_GROK_CONFIG` | `~/.grok/config.toml` | 受管成员读取的模型配置文件路径 |
| `NOAH_MODEL` | `[models].default` | 新建讨论的默认模型别名 |
| `NOAH_GROK_BIN` | `~/.grok/bin/grok` | 选择 Grok 成员时使用的可执行文件路径 |
| `NOAH_DATA_DIR` | `~/Library/Application Support/Noah/workspace` | 讨论消息、资料与本地状态目录 |
| `NOAH_RUN_TIMEOUT_MS` | `180000` | 单次受管 Harness 调用超时（毫秒） |

## 开发与文档

```sh
npm test          # 单元与集成测试
npm run typecheck # TypeScript 类型检查
npm run check:ui  # 桌面端界面检查
```

- [PRODUCT.md](PRODUCT.md) 与 [SPEC.md](SPEC.md) — 产品定位、设计约束与核心契约
- [ARCHITECTURE.md](ARCHITECTURE.md) — 调度引擎、SQLite 存储与消息投递机制
- [docs/PI-BRIDGE-SETUP.md](docs/PI-BRIDGE-SETUP.md) — 接入正在运行的原生 `pi` 会话指南
- [docs/GROK-NATIVE-SETUP.md](docs/GROK-NATIVE-SETUP.md) — 实验性 `Grok` 原会话 hook / CLI 接入说明
- [docs/DESKTOP.md](docs/DESKTOP.md) — 桌面打包、进程生命周期与网页调试入口（`npm run dev:web`）

---

名字取自方舟：容纳多样的生命与智能，一起走向更好的未来（创意来源：[《大宝可梦时代》](https://www.yeuxark.com/notes/%E5%A4%A7%E5%AE%9D%E5%8F%AF%E6%A2%A6%E6%97%B6%E4%BB%A3k.html)）。
