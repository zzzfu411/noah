# Harness 官方图标来源

这些文件用于在 Noah 中识别对应的 Harness。全部复制自品牌官方网站、官方仓库或官方发布页面使用的现成素材；未描摹、生成、重着色或把文字缩写包装成图标。PNG 保留原始格式，没有伪装为 SVG。获取日期：2026-09-26。

品牌名称、标志及商标仍归各自权利人所有。记录官方来源不代表 Noah 获得品牌背书，也不把某个软件仓库的开源许可证自动解释为商标使用授权。

## 素材与使用方式

所有路径相对于 `public/assets/harnesses/`。

| Harness | 文件 | 原始尺寸 | 官方来源与素材身份 | 明暗主题使用 |
| --- | --- | --- | --- | --- |
| Grok | `grok.svg` | 512 × 512 | [Grok 官方网站](https://grok.com/)引用的[官方 favicon SVG](https://grok.com/images/favicon.svg)，xAI / Grok 品牌 | 原样显示；素材自带深色圆角底板。 |
| Pi coding agent | `pi.svg` | 560 × 560 | [Pi 官方 Press Kit](https://pi.dev/press-kit)中 Square badge 的[下载文件](https://pi.dev/favicon.svg)，Earendil 的 Pi，**不是 Inflection Pi** | SVG 自带 `prefers-color-scheme`：浅色为 `#111111`，深色为 `#f6f6f6`；让外层 `color-scheme` 与 Noah 的显式主题保持一致。 |
| Codex | `codex.png` | 385 × 385 | [OpenAI 官方 Codex IDE 文档](https://developers.openai.com/codex/ide/)链接的[官方扩展发布页](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt)所使用的[原始产品图标](https://openai.gallerycdn.vsassets.io/extensions/openai/chatgpt/26.5917.62051/1790149959307/Microsoft.VisualStudio.Services.Icons.Default)；发布版本 `26.5917.62051` | 白色结形图标，使用固定深色底板以保持可见。它是官方 Codex IDE 扩展图标；不宣称是蓝色 macOS 桌面图标。 |
| Claude Code | `claude.png` | 192 × 192 | [Claude Code 官方文档](https://code.claude.com/docs/en/overview)引用的[官方 favicon PNG](https://code.claude.com/docs/_mintlify/favicons/claude-code/pLsy-mRpNksna2sx/_generated/favicon/android-chrome-192x192.png)，Anthropic / Claude 品牌 | 原样显示，素材含暗色圆形底板与橙色 Claude 标志。官方深色 favicon 与此文件字节相同，无须切换。 |
| Gemini CLI | `gemini.png` | 1645 × 1645 | [Gemini CLI 官方网站](https://geminicli.com/)明确标注为 Gemini CLI Icon 的[原始 PNG](https://geminicli.com/icon.png)，Google 品牌 | 原样显示；素材自带暗色底板和彩色边框。它是 CLI 的终端图标，不是通用 Gemini 星形标志。 |
| OpenCode | `opencode.svg`、`opencode-dark.svg` | 300 × 300 | [OpenCode 官方品牌页](https://opencode.ai/brand)对应的官方仓库[浅色方形标志](https://github.com/anomalyco/opencode/blob/696f41bc8e7586657375d53390925fc54c25d34c/packages/console/app/src/asset/brand/opencode-logo-light-square.svg)与[深色方形标志](https://github.com/anomalyco/opencode/blob/696f41bc8e7586657375d53390925fc54c25d34c/packages/console/app/src/asset/brand/opencode-logo-dark-square.svg)，Anomaly / OpenCode 品牌 | 浅色主题选 `opencode.svg`，深色主题选 `opencode-dark.svg`；不需要 CSS 反色。 |

使用 `<img>` 加 `object-fit: contain` 保留比例及完整形状，不裁切、不加品牌色滤镜。图标旁保留 Harness 名称；相邻文字已清楚命名时，图标可用空 `alt` 避免重复朗读。上述主题建议只改变容器或选择已有官方版本，不修改素材。

## 许可证与品牌归属

- **Grok / xAI**：素材由 Grok 官网直接提供；没有随该图标发现独立的开源许可声明。不能把可下载等同于获得任意再授权。
- **Pi / Earendil**：Press Kit 明确提供品牌素材下载；Pi 项目使用 [MIT License](https://github.com/earendil-works/pi/blob/main/LICENSE)，版权声明为 `Copyright (c) 2025 Mario Zechner`。项目许可证原文保存在 `LICENSE-pi.txt`。该记录不额外推断商标授权范围。
- **Codex / OpenAI**：来源是 OpenAI 官方发布的扩展图标。未发现该图标独立的开源许可；不套用 Codex CLI 源码许可证，也不据此宣称 OpenAI 认可 Noah。
- **Claude Code / Anthropic**：来源是 Claude Code 官方文档的品牌 favicon。未发现素材独立的开源许可声明。
- **Gemini CLI / Google**：来源是 Gemini CLI 官网的产品图标。未发现该下载响应附带独立的素材许可声明。
- **OpenCode / Anomaly**：素材来自官方仓库的品牌目录，固定提交为 `696f41bc8e7586657375d53390925fc54c25d34c`。该仓库根目录 [MIT License](https://github.com/anomalyco/opencode/blob/696f41bc8e7586657375d53390925fc54c25d34c/LICENSE) 的版权声明为 `Copyright (c) 2025 opencode`，原文保存在 `LICENSE-opencode.txt`；商标归属仍然独立。

## 原始文件校验

下载后验证了 PNG 签名与尺寸、SVG 的 XML 结构。所有 SVG 均没有脚本或外部资源引用。Grok 官网原始 SVG 含一个用于背景模糊的 `foreignObject`；保留官方文件字节，不以内联 HTML 注入。

| 文件 | SHA-256 |
| --- | --- |
| `grok.svg` | `c3db0dfaf760b702b8490c6cbefe07fd8bfe00db43cae6a0acccf768f44d6179` |
| `pi.svg` | `d266b2c1d2c7bf169ca30d438963b176fba16fea6263b9ac30c8302f34ad7ce7` |
| `codex.png` | `2ce1c57dd3b312417106a487815ab1235bddce17e1fa9b32a2f048bd71ee25d3` |
| `claude.png` | `d4e5e8e9990ac52f147a74ae80b9e69cdc612264b84a76cdb5c43b53b73a1707` |
| `gemini.png` | `351e9f5b1bf863d738cd7be4ed040a625a1419450ae7fc490143e4042b7c2438` |
| `opencode.svg` | `b1c48d82ebd304eab820658387642bcf4c9b8350d6860894d0fe21ddca25ef3f` |
| `opencode-dark.svg` | `d6a0e3b8a295f413543f41cb73957e670351b5cb088c8d9dbd186b9e9d633cca` |

为确定 Claude Code 的主题行为，同时保留了官方深色地址下载的 `claude-dark.png`；其 SHA-256 与 `claude.png` 相同。UI 只需要引用 `claude.png`。
