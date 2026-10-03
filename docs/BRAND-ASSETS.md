# Noah 品牌素材

用户于 2026-09-26 选定彩色「舒展帆船」作为 Noah 正式 Logo：海蓝大帆、珊瑚色小帆、深蓝船身和浅蓝浪线。

## 唯一源图

- 正式源文件：`public/assets/noah/logo.png`，1254 × 1254 PNG，保留透明背景。
- 与确认稿 `output/imagegen/noah-logo-handdraw-v5/noah-logo-069-color-waves.png` 字节一致。
- SHA-256：`f0e094d59cd03e7cbb8db5923d59c378d42d72b45b2f128e9daba5ab21bc67bc`。
- 由内置 imagegen 使用 #069 编号画风参考生成；提示词记录位于 `output/imagegen/noah-logo-handdraw-v5/PROMPTS.md`。
- 不重新绘制、追踪或自动改色这份原图。修改造型与配色需要新的设计决定。

## 使用位置

- 侧栏：透明源图与 Noah 文字并列，桌面图像框 40 × 40 px；保持原始比例和颜色，浅深主题使用同一文件。
- Dock、Finder、关于窗口及启动页：以源图生成浅色圆角底的 macOS 图标，避免深色轮廓融入背景。
- 浏览器开发入口：使用同一应用图标生成的 PNG favicon。
- Grok、pi 等 Harness 继续使用各自官方素材，来源见 HARNESS-ASSETS.md。

## 可重复生成

运行 `npm run icons:mac`，脚本 `scripts/make-icon.swift` 读取唯一源图，仅作适配尺寸、居中与格式转换，生成：

- `desktop/assets/icon.png`：1024 px 应用图标。
- `desktop/assets/icon.iconset/`：16–1024 px 的 1× / 2× 图标。
- `desktop/assets/icon.icns`：macOS 应用图标。
- `public/assets/noah/favicon.png`：256 px favicon。

`npm run package:mac` 会先自动生成图标，再打包。旧蓝底白色几何帆船 SVG 已移除，避免再被用作源文件。


`output/imagegen/` 是未随源码发布的本地设计历史；公开仓库中用于构建的最终 Logo 为 `public/assets/noah/logo.png`。
