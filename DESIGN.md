---
name: "Noah desktop"
description: "平等 Agent 的桌面讨论空间"
colors:
  canvas: "#fbfbfc"
  surface: "#ffffff"
  sidebar: "#f1f2f4"
  panel: "#f1f2f5"
  hover: "#e9ebef"
  selected: "#dfe9fb"
  ink: "#25262b"
  secondary: "#5a5e68"
  muted: "#676c77"
  line: "#25262b10"
  control-line: "#25262b24"
  accent: "#2864d7"
  accent-soft: "#eaf0fd"
  navigation-surface: "#ffffff85"
  warning-bg: "#faf5eb"
  warning-ink: "#7b5d2c"
  danger: "#b13643"
  danger-bg: "#fbeef0"
  action: "#2864d7"
  on-action: "#ffffff"
  success: "#32744f"
  dark-canvas: "#202124"
  dark-surface: "#2b2d32"
  dark-sidebar: "#202124"
  dark-panel: "#303238"
  dark-hover: "#3a3d45"
  dark-selected: "#344967"
  dark-ink: "#f3f4f6"
  dark-secondary: "#c1c4cc"
  dark-muted: "#a5aab5"
  dark-line: "#ffffff12"
  dark-control-line: "#ffffff26"
  dark-accent: "#91baff"
  dark-accent-soft: "#2c3b54"
  dark-navigation-surface: "#ffffff0f"
  dark-warning-bg: "#353027"
  dark-warning-ink: "#e4c594"
  dark-danger: "#f5a4ae"
  dark-danger-bg: "#412c32"
  dark-action: "#85b4ff"
  dark-on-action: "#142b4e"
  dark-success: "#87cda5"
typography:
  display: {"fontFamily":"-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", sans-serif","fontSize":"28px","fontWeight":600,"lineHeight":1.4,"letterSpacing":"-0.8px"}
  headline: {"fontFamily":"-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", sans-serif","fontSize":"21px","fontWeight":600,"lineHeight":1.4,"letterSpacing":"-0.4px"}
  title: {"fontFamily":"-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", sans-serif","fontSize":"17px","fontWeight":600,"lineHeight":1.4,"letterSpacing":"-0.3px"}
  body: {"fontFamily":"-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", sans-serif","fontSize":"15px","fontWeight":400,"lineHeight":1.8}
  human-body: {"fontFamily":"-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", sans-serif","fontSize":"14px","fontWeight":400,"lineHeight":1.8}
  interface: {"fontFamily":"-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", sans-serif","fontSize":"13px","fontWeight":400}
  button: {"fontFamily":"-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", sans-serif","fontSize":"12px","fontWeight":500}
  caption: {"fontFamily":"-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", sans-serif","fontSize":"11px","fontWeight":400}
  code: {"fontFamily":"\"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace","fontSize":"12px","fontWeight":400,"lineHeight":1.7}
rounded:
  code: "4px"
  recipient: "6px"
  control: "11px"
  navigation: "12px"
  dialog: "16px"
  canvas: "#fbfbfc"
  composer: "22px"
  circular: "50%"
  human-message: "18px 18px 6px 18px"
spacing:
  related: "8px"
  row: "12px"
  group: "16px"
  section: "20px"
  actions: "24px"
  dialog: "28px"
components:
  button-primary: {"backgroundColor":"{colors.action}","textColor":"{colors.on-action}","typography":"{typography.button}","rounded":"{rounded.control}","padding":"7px 13px"}
  button-secondary: {"backgroundColor":"{colors.surface}","textColor":"{colors.ink}","typography":"{typography.button}","rounded":"{rounded.control}","padding":"7px 13px"}
  button-icon: {"backgroundColor":"transparent","textColor":"{colors.secondary}","rounded":"{rounded.circular}","padding":"7px","width":"34px"}
  input-field: {"backgroundColor":"{colors.canvas}","textColor":"{colors.ink}","typography":"{typography.interface}","rounded":"{rounded.control}","padding":"10px 12px"}
  task-selected: {"backgroundColor":"{colors.navigation-surface}","textColor":"{colors.ink}","rounded":"{rounded.navigation}","padding":"11px 12px"}
  composer: {"backgroundColor":"{colors.surface}","textColor":"{colors.ink}","rounded":"{rounded.composer}"}
  recipient-label: {"backgroundColor":"{colors.panel}","textColor":"{colors.secondary}","typography":"{typography.caption}","rounded":"{rounded.recipient}","padding":"2px 7px"}
  human-message: {"backgroundColor":"{colors.panel}","textColor":"{colors.ink}","typography":"{typography.human-body}","rounded":"{rounded.human-message}","padding":"14px 19px 12px"}
  send-button: {"backgroundColor":"{colors.action}","textColor":"{colors.on-action}","rounded":"{rounded.circular}","padding":"7px","width":"34px","height":"34px"}
---

# Design System: Noah desktop

## Overview

**Creative North Star: "共享讨论桌面"**

半透明的系统侧栏环绕一块安静的实色讨论画布；浅色为瓷白与中性灰，深色为石墨与分层灰。帆船蓝集中强调操作、焦点和选择，玻璃表面、圆润控件与留白承担层次。Noah 保留用户选定的彩色双帆与浪线 Logo；参与者使用随应用分发的官方品牌素材。

这是 Electron 承载的 macOS 桌面界面，沿用真实窗口控制、系统字体和本机快捷键。Grok 与 pi 使用同等的消息结构与工具入口；界面描述已实现的能力，产品事实继续以 PRODUCT.md 为准。

本规范初版提取于 2026-09-26，2026-10-03 按用户“透明边栏、圆角按钮、更耐看”的要求更新。旧截图和 sidecar 预览属于此前实色界面，不能证明本轮材质效果；v0.4.1 记录保留在 [Goal Spec §6.12](docs/GOAL-V0.4-SPEC.md#612-macos-材质与阅读层次)；本轮新材质、配色及验收见 [v0.4.2 视觉修订](docs/VISUAL-REFINEMENT-0.4.2.md)。参考来源见 [设计参考](docs/DESIGN-REFERENCES.md)，素材来源见 [Harness 官方图标](docs/HARNESS-ASSETS.md)。

**Key Characteristics:**

- 系统毛玻璃导航与实色阅读面；蓝色用于操作、焦点、投递过程和拖入反馈。
- 圆角主画布容纳开放对话，导航与可关闭的详情留在画布之外。
- 官方 Harness 图标与相邻文字共同辨认身份，不用自绘字母徽记代替品牌。
- 正文、身份、状态与操作各有稳定层级，保留浅深外观和键盘反馈。

## Colors

### Primary

主要创建与发送操作使用 action / on-action，在浅深主题中分别形成蓝底白字与浅蓝底深字。accent 用于焦点、输入光标、排队/运行状态与拖入反馈；悬停使用 accent-hover / on-accent。success、warning 与 danger 只表示真实状态。

### Neutral

canvas 为讨论画布，sidebar 为窗口底色和导航，surface 为输入及弹窗，panel 为消息和轻量分组。ink、secondary、muted 区分正文、次级信息与辅助信息；line 与 control-line 区分区域和输入边界。dark- 前缀对应同名深色 token，独立调整而非反相滤镜。

frontmatter 记录主要颜色。原生 under-window material 叠加 16% 浅色 / 24% 深色中性底色；逻辑属性仍叫 sidebar。导航的 hover、selected、new action 使用独立表面，选中状态不再与悬停相同。旧 sidecar 的八阶色带和几何值未随本轮重生成，仅作历史预览，不覆盖当前 CSS。

**The Quiet Chrome Rule.** 导航与控件通过中性色阶分层，品牌与强调色不铺满工作背景。

## Typography

界面和正文使用系统字体栈，中文回退 PingFang SC。正文使用 15px / 1.8 的阅读节奏；层级由尺寸、字重、位置和颜色共同建立。Noah 文字标识使用 22px / 600，与对话标题保持适当距离。

| 角色 | 用途 |
| --- | --- |
| display | 空状态主标题 |
| headline | 对话框标题 |
| title | 当前讨论标题；窄桌面窗口降为 16px |
| body | Agent 正文与 Markdown 段落 |
| human-body | 人类消息正文 |
| interface / button | 导航、输入与操作文字；任务标题另用 13px / 500 |
| caption | 时间、投递、模型与协作模式等辅助信息；当前仍有 11px 标签 |
| code | 多行代码；行内代码为正文的 0.88em |

Agent 名称使用 14px / 600。标题保留一行省略，正文可换行；长代码与表格局部滚动。阅读列按像素宽度约束，不宣称已经实现固定字符数行宽。

**The Readable Roles Rule.** 系统字体服务界面与对话，等宽字体只服务代码；辅助文字保持真实层级，不冒充标题。

## Layout

默认左侧导航宽 240px，右侧详情宽 280px；达到 1500px 时分别为 256px 和 290px。1179px 及以下导航为 216px，详情改为宽 306px 的可关闭侧面 sheet。主画布与窗口顶、右、底边保留 10px 外距；轻微阴影划分工作面。

桌面不再为整个窗口额外预留一条实色顶部横条。左上 48px 是原生红绿灯与拖动区域，导航内容从 56px 起排；讨论头部也可拖动，按钮始终 no-drag。头部最小高 76px，短窗口收至 68px。Electron 最小尺寸保持 920×680；680px 以下布局仅服务开发网页。

对话列的居中宽度基准为 760px，左右至少 32px 内距；每条 Agent 消息由 34px 品牌容器、13px 间隔和正文组成，消息间距 32px。编辑区外框最大宽 816px、左右内距 28px，锚定在画布底部。人类消息向内收 70px，以浅表面和不对称圆角区别于 Agent 正文。窄窗口继续收紧外围尺寸，不让整个窗口滚动。

## Elevation & Depth

macOS 使用 Electron 的 under-window vibrancy 呈现真实窗后材质；窗口维持 followWindow，保留原生边框，不额外设置 transparent:true。透明页面底色让侧栏与宽窗详情露出系统材质，主画布始终实色。v0.4.1 的 sidebar 也已使用 behind-window 混合；本轮调整的是材质与遮盖强度。原生材质随 Noah 浅/深/系统外观同步，减少透明度开启时恢复实色；开发网页及其他平台使用实色底。弹窗、窄窗详情和 toast 使用 28px blur / 125% saturation 的局部磨砂浮层，CSS 不支持或系统减少透明度时退回实色；遮罩仅压暗背景。阴影同步为中性灰，浮层顶缘用轻高光定义。具体值以 CSS tokens 为准。

**The One Conversation Surface Rule.** 主画布是完整的讨论容器，Agent 正文保持开放排版，不为每条消息再套同级卡片。

状态颜色与边框默认过渡 150ms，弹窗入场为 180ms 的轻微位移与透明度变化；reduced motion 关闭过渡、动画和滚动动效。

## Shapes

正文保持开放；主画布、编辑框、弹窗各有独立的圆角层级。主要圆角值由 frontmatter 的 rounded 定义，人类消息保留实际不对称四角值。轻量收件标签与行内代码更紧凑；普通窗口圆角由系统负责，不再用网页绘制第二套窗口控制。

官方品牌容器根据用途调整：消息 34px、讨论头部 31px 圆形、空状态 60px、检测与创建面板 38px。图标用 contain 保留原图比例，素材本身的颜色和图案不被重新着色；OpenCode 选择官方明暗文件，pi 通过素材自身的 color-scheme 适配。Codex 的固定深色容器服务其白色官方标志。素材存在不代表相应工作会话桥接已实现。

## Components

### Noah 标识

侧栏以 36 × 36 px 透明彩色帆船与 22px / 600 的 Noah 文字并列，间距 10px。原图来自用户确认的 #069 舒展帆船配色版，保持船形、颜色及浪线。Dock、关于窗口与启动页使用浅色圆角底版本；详细来源和生成流程见 [品牌素材](docs/BRAND-ASSETS.md)。

### Buttons and fields

普通操作最小高 34px、圆角 11px；标题栏紧凑按钮为胶囊，图标与发送按钮为 34px 圆形点击区。主要操作使用 action，空白草稿时发送显示中性禁用状态。主要文本按钮没有固定宽度；创建对话框按钮另有 72px 最小宽度。

普通弹窗圆角 16px、宽度上限 430px，Harness 检测弹窗上限 584px。创建讨论采用独立滚动内容和固定底部操作栏，紧凑窗口始终能看到取消和创建。弹窗输入最小高 41px，正文编辑框实际最小高 62px、最大高 180px。焦点显示 2px accent 轮廓或编辑框边色；滚动条、选择区、光标也使用主题颜色。

### Navigation and discussion

讨论项保留名称、实际状态和模型信息两行，最小高 60px；选中使用浅蓝半透明底色、顶缘高光和加重标题；悬停仅使用更轻的中性透明层。搜索、创建和待处理入口在导航上部，本机 Agents 与连接/外观在底部。不能制造日期分组或虚构活动来填充侧栏。

Agent 正文采用相同的品牌、姓名、收件标签、时间及操作结构；成功状态保持简短，错误与结果待核对仍可见。Markdown、引用、代码和表格使用各自局部样式，不执行消息里的 HTML。

### Composer, inspector and dialogs

编辑框将明确收件人、草稿、资料入口和发送动作收在同一容器，协作模式单独位于下方；只有启用可选限制时才展示已用与上限次数。创建对话默认自主讨论，次数与时长在「协作设置」中按需启用，未启用时隐藏并禁用数值输入。Enter 换行，Cmd/Ctrl+Enter 发送；回复、IME、拖入资料和草稿恢复延续既有交互。

详情默认关闭，在宽窗口中并列，在较窄桌面窗口中浮出。创建对话框清楚标为新的 Grok/pi 会话；检测列表区分 CLI、配置、内置运行时与未发现。路径与私有输出按需展开，不因视觉重做扩大共享范围。

## Do's and Don'ts

### Do:

- **Do** 从当前 CSS 提取并同步人工规范和机器预览，区分实现值与尚待验收的效果。
- **Do** 保留真实 macOS 窗口控制、拖动区域、快捷键、焦点和 reduced motion 行为。
- **Do** 让 Grok 与 pi 保持相同视觉权重；品牌素材保持比例，并沿用官方明暗版本。
- **Do** 保留真实收件对象、时间、错误与投递状态；视觉变化不改写产品能力。

### Don't:

- **Don't** 恢复旧森林绿背景、旧方舟图案或 G/π 字母头像；Noah 使用用户批准的彩色双帆 Logo，详见 docs/BRAND-ASSETS.md。
- **Don't** 将官方 Harness 图标解读为该工具已经连接、已支持协作或为 Noah 背书。
- **Don't** 将主画布描述为原生 vibrancy，也不要绘制假的窗口红绿灯。
- **Don't** 在没有实际截图证据时宣称布局、对比度或发布包已通过视觉验收。
