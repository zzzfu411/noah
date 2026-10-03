# Noah 的项目设计 skills

两项 skill 安装在本仓库的 `.agents/skills/`，没有安装到全局 skill 目录。以下来源固定到本次使用的 commit；机器可读记录在 [.agents/skills/sources.json](../.agents/skills/sources.json)。

| Skill | 来源与版本 | 项目位置 | 许可依据 |
| --- | --- | --- | --- |
| macos-design | [ceorkm/macos-design-skill](https://github.com/ceorkm/macos-design-skill/tree/8f528a2364f996cd42f02a10b1b27198a74ca2a3)，未声明独立版本号 | [.agents/skills/macos-design/SKILL.md](../.agents/skills/macos-design/SKILL.md) | 固定版本的 README 声明 MIT；安装的上游目录没有独立 LICENSE 文件 |
| impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable/tree/83c2c735777c68e30ea536ab9cc97f7843456945)，skill 4.3.1，engine 0.1.5 | [.agents/skills/impeccable/SKILL.md](../.agents/skills/impeccable/SKILL.md) | Apache-2.0；已将同一 commit 的上游 [LICENSE](../.agents/skills/impeccable/LICENSE) 原样复制到 skill 目录 |

安装日期：2026-09-23。Impeccable 的运行缓存位于 `.impeccable/runtime/`，已被 `.gitignore` 忽略。两个 skill 的版本目录可以随项目保存，运行缓存和运行结果不承担设计规范的角色。

## 后续调用

从 Noah 根目录启动 Agent，可以直接要求：

> 使用本仓库的 macos-design 和 impeccable skills，先读取 PRODUCT.md、DESIGN.md 与 public/index.html 的 surface brief，再优化指定界面；保留现有通信、权限与状态恢复行为。

支持 skill 命令的 Agent 中，可使用 `$impeccable critique public/index.html`、`$impeccable polish public/index.html` 或 `$impeccable document`。这些是交给 Agent 的 skill 指令，不应当作已存在的 npm 脚本。若 harness 没有自动发现项目 skill，直接指定上述 `SKILL.md` 路径即可。

每个新会话按 Impeccable 指令加载一次上下文。本机缓存已建立时，可明确指定项目内 engine，避免选择其他位置的可执行文件：

```sh
IMPECCABLE_HOME="$PWD/.impeccable/runtime" \
IMPECCABLE_BIN="$PWD/.impeccable/runtime/bin/0.1.5/impeccable" \
.agents/skills/impeccable/scripts/impeccable context --target public/index.html
```

切换机器时，上述二进制路径可能尚不存在；其 launcher 支持在 `IMPECCABLE_HOME` 指定的位置下载对应平台的版本并核对校验和。不要为了使用项目 skill 改为全局安装。上下文加载失败时，按 skill 的 fallback 直接读取项目文件继续可完成的工作。

## 此次实际采用的准则

- **macOS 布局与操作**：真实 Electron 窗口控制和拖动区、任务侧栏、清晰键盘提示、搜索、按需详情和文本资料拖入。
- **阅读优先**：共享对话成为主区域；运行细节与私有输出进入详情。Grok 和 pi 使用同级消息结构，独立状态据实展示。
- **视觉系统**：系统字体、纸白与石色表面、森林绿强调色、一致 SVG 操作图标；浅深色分别设计，外观选择进入桌面 UI 状态保存。
- **内容排版**：Markdown 以安全 DOM 呈现段落、代码、引用、列表和表格；不会执行消息 HTML、加载消息图片或新增外链导航权限。
- **可维护性**：[DESIGN.md](../DESIGN.md) 的 token 来自实际 CSS；[design.json](../.impeccable/design.json) 记录阴影、动效、断点和可独立预览的组件。sidecar 的合成色阶用于设计面板展示，不是应用新增的颜色规范。

Noah 仍是 Electron macOS 应用，没有迁移到 SwiftUI。macOS 系统字体是明确的操作界面选择；侧栏当前采用实色层次，没有把 skill 示例中的 vibrancy 当作已经实现的能力。这里记录来源、调用方式与已实现设计，不替代实际桌面运行和人工视觉验证报告。
