---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/style.css", "public/app.js"]
---

# Noah desktop discussion

Mode: Operate. Scope: public/index.html, public/style.css, public/app.js and the existing Electron window. Product truth remains in PRODUCT.md; this document records the authorized replacement visual world.

## Direction contract

2026-10-03 material refinement: the user explicitly asked for a more polished macOS interface, including a translucent sidebar and rounded buttons. This revision supersedes the older geometry and violet palette below: native sidebar vibrancy with an opaque reading canvas, sea-blue gray interaction colors, 240px navigation (216px compact), 10px canvas inset, 16px canvas/dialog radius, 22px composer and round 34px icon/send buttons. The left 48px titlebar drag area retains real traffic lights; there is no full-width 38px spacer. Respect reduced transparency and reduced motion. Current tokens and composition are in DESIGN.md / public/style.css; actual verification is tracked in Goal Spec §6.12. Older FINISH and screenshot records below are historical and do not verify this new material.

THESIS: A shared desktop discussion surface for independent Agents. Reading and participation lead; delivery, participants and materials remain inspectable without becoming permanent competing columns.

OWN-WORLD: Neutral light and charcoal dark surfaces; a rounded main canvas inset from the desktop shell; black/white primary actions and restrained violet interaction feedback. System typography supplies an explicit hierarchy. Noah has a text wordmark; Harnesses use the official assets recorded in docs/HARNESS-ASSETS.md. Peers share equal composition and weight.

STORY: Choose a discussion, identify the speaker and recipient, read the shared evidence, then contribute or pause. Existing-session connectivity remains a product capability question, not a claim inferred from logos or discovery rows.

FIRST VIEWPORT: The implemented desktop shell has a 38px native drag reservation, a 232px sidebar and an 18px-radius main canvas with 12px right/bottom inset. The discussion header is at least 82px, reduced to 72px in short windows. The transcript uses a 748px centering basis; the composer region is at most 808px wide, with a 20px-radius input container. A 280px inspector opens alongside, or a 306px sheet below 1180px. Exact responsive behavior follows the CSS, not earlier concept dimensions.

FORM: The user rejected the old appearance and authorized a replacement. Their pinned Claude Desktop / ChatGPT App category reference and delegated design choice outrank random exploration. Seed 2fabe41c was degraded; it is process metadata, not visual authority. The chosen world is the implemented neutral desktop canvas. The previous forest-green palette, page ark illustration and G/π letter badges are superseded.

FINISH: Code extraction and visual review are complete. The main task checked the actual 992×735 macOS window in light/dark appearance and Cmd+N creation; read-only preview viewports were 920×680 and 1320×860. An independent reviewer returned ship after confirming the empty-state brand tiles are 60×60. The 920×680 check is a browser viewport, not a native outer-window claim. Evidence scope is recorded in .noah/design-qa/redesign-report.json; package rebuild is tracked separately. Source CSS SHA-256: 0ecb156b2a5c0f257f69bfb4cc731ae39feb5ecf006fd53cfe1f4a93eae14708.

## Constraints

Keep real macOS window controls, menus and keyboard shortcuts. Preserve real discussions, model choice, private/shared boundaries, delivery uncertainty, idempotent sends and draft recovery. Keep Grok and pi equal. Official assets may identify installed harnesses without implying live connectivity. Do not infer new API permissions, native vibrancy or unimplemented connection behavior from the new appearance.

## Verification record

The main task and independent review inspected conversation/long text, empty state, creation, harness discovery with all six official marks, and inspector behavior. The report records loaded images and no horizontal page overflow. Light muted text is #666672; reported minimum semantic text contrast is 4.55:1 light and 4.64:1 dark, excluding disabled controls. Screenshots were inspected through CUA and were not exported. Continue to distinguish native-window evidence, browser preview evidence and later package validation.
