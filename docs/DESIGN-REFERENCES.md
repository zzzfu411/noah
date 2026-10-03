# Noah 桌面视觉参考

研究与代码提取日期：2026-09-26。以下资料用于理解高质量桌面产品的层级、布局和系统边界；尺寸、颜色及组件最终以本次实际 public/style.css 和 DESIGN.md 为准。本文不表示照搬某个产品，也不把研究阶段建议误记为已经实现。

## Linear：让导航退后，让工作内容居前

[《A calmer interface for a product in motion》](https://linear.app/now/behind-the-latest-design-refresh)，2026-03-12。官方文章提供侧栏、标签栏和边框的前后对比，说明导航降权、减少图标装饰与统一头部操作的位置。[同日发布说明](https://linear.app/changelog/2026-03-12-ui-refresh)可交叉核对。

Noah 的实际应用：侧栏与主画布使用中性色阶；页面不再重复方舟图案和口号；同类操作、投递状态和资料入口使用稳定位置。主画布的圆角、边框和具体间距是 Noah 的实现选择，并不宣称逐像素复刻 Linear。

## Raycast：桌面窗口和操作行为优先

[《A Technical Deep Dive Into the New Raycast》](https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast)，2026-05-14。文章讨论使用 Web UI 时如何保留原生窗口、键盘、浮层与即时反馈；[官方桌面界面图](https://www.raycast.com/uploads/blog-technical-deep-dive-new-raycast/raycast-2-overview.png)可直接复核。

Noah 的实际应用：保留 Electron 的真实窗口按钮、拖动区域与菜单；创建、搜索、编辑和发送保留快捷键与焦点反馈。当前仍使用 DOM 弹窗、CSS hover 和 pointer 光标，没有实现 Raycast 的独立原生 popover 或窗口架构，不把这些参考能力写成现有事实。

## Things：系统层级与柔和内容表面

[《Things for OS 26》](https://culturedcode.com/things/blog/2025/09/things-for-os-26/)，2025-09-15。官方解释对间距、控件曲率与侧栏材质的调整；[官方 macOS 截图](https://culturedcode.com/frozen/2025/09/things-os26-screenshot-macos-io75.jpg)提供可复核的原生界面参照。

Noah 的实际应用：主画布、编辑框、品牌容器和弹窗有分明的曲率层级，文字使用系统字体，主区域保持稳定阅读底色。当前侧栏是实色，没有原生 Liquid Glass 或 vibrancy，不用 CSS 模糊冒充已完成的系统材质集成。

## 品牌素材与选择依据

用户明确指定 Claude Desktop / ChatGPT App 这一桌面产品范式，并把细节选择委托给实现者；本次已实现方向以这一约束和实际代码为准。探索 seed 2fabe41c 处于 degraded 状态，不能覆盖用户选择。

Harness 使用官网、官方仓库和发布页中的现成品牌素材。完整文件、官方链接、明暗策略及校验值统一维护在 [HARNESS-ASSETS.md](HARNESS-ASSETS.md)，不另建一份可能漂移的清单。Noah 页面文字标识与外部 Harness 品牌图标分工明确；图标存在不意味着已接入对应会话。

## 验收状态

本次规范按最终源码提取，主任务及独立审查已完成界面检查。实际 macOS 窗口为 992×735，检查浅深主题、真实窗口控制与 Cmd+N 创建弹窗；只读预览为 920×680 和 1320×860，覆盖会话、长文本、空状态、创建、详情与六家官方图标。920×680 不代表已检查同尺寸的原生外窗。独立审查确认空状态品牌容器已修为 60×60 后给出 ship。详细范围、对比度和限制见 [.noah/design-qa/redesign-report.json](../.noah/design-qa/redesign-report.json)；发布包重建不包含在本条视觉结论内。
