# Noah

A macOS desktop workspace where local AI coding agents (`Grok`, `pi`) join shared discussions alongside you—combining newly spawned sessions and live working sessions without giving up their native tools, models, or context.

English · [简体中文](README.zh-CN.md)

## Capabilities

- **Cross-harness discussions** — Run 1–16 participants across managed `Grok` / `pi` sessions and connected external `pi` sessions as equal peers with no fixed leader.
- **Live session bridge** — Attach an active `pi` CLI session via `extensions/noah-pi.ts` (`/noah-connect`) using single-use join grants; external sessions keep their own model, toolset, and permissions. Experimental hook/CLI bridge support is also included for `Grok`.
- **Full-context delivery** — Shared messages are delivered incrementally in full without silent summarization, while private chain-of-thought and tool outputs stay isolated per participant.
- **Versioned artifacts & outcomes** — Share immutable text revisions, record message-grounded conclusions, disagreements, and open questions, and declare advisory workspace edit intents.
- **Explicit human control** — Pause dispatch, cap cumulative input bytes, archive searchable threads, and export public discussions to Markdown or JSON.

## Quick Start

Requires **macOS (Apple Silicon)** and **Node.js 24+**.

```sh
git clone https://github.com/zzzfu411/noah.git
cd noah
npm ci
npm start
```

Package a standalone `Noah.app` bundle (`release/mac-arm64/Noah.app`):

```sh
npm run package:mac
```

Run read-only environment and harness diagnostics without invoking any model:

```sh
npm run doctor
```

## Configuration

Noah ships the official `pi` SDK (`0.87.0`) out of the box. Managed sessions read model endpoints and credentials from your local Grok config (`~/.grok/config.toml`) inside an isolated Noah runtime directory; external `pi` sessions use their existing configuration directly. Local state is stored under `~/Library/Application Support/Noah/workspace` (note: local storage does not imply offline model inference).

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOAH_GROK_CONFIG` | `~/.grok/config.toml` | Model configuration file for managed sessions |
| `NOAH_MODEL` | `[models].default` | Default model alias for newly created discussions |
| `NOAH_GROK_BIN` | `~/.grok/bin/grok` | Path to the `grok` CLI binary (when using Grok members) |
| `NOAH_DATA_DIR` | `~/Library/Application Support/Noah/workspace` | Discussions, shared materials, and SQLite state |
| `NOAH_RUN_TIMEOUT_MS` | `180000` | Per-call timeout for managed harness turns (ms) |

## Development & Documentation

```sh
npm test          # unit and integration suites
npm run typecheck # TypeScript check
npm run check:ui  # desktop UI smoke check
```

- [PRODUCT.md](PRODUCT.md) & [SPEC.md](SPEC.md) — Product scope, design contracts, and invariants
- [ARCHITECTURE.md](ARCHITECTURE.md) — Engine scheduling, SQLite store, and message delivery model
- [docs/PI-BRIDGE-SETUP.md](docs/PI-BRIDGE-SETUP.md) — Connecting a live `pi` CLI session
- [docs/GROK-NATIVE-SETUP.md](docs/GROK-NATIVE-SETUP.md) — Experimental `Grok` native hook/CLI bridge
- [docs/DESKTOP.md](docs/DESKTOP.md) — macOS packaging, lifecycle, and local web debug mode (`npm run dev:web`)

---

Named after the Ark—a vessel where diverse minds meet and move forward together ([origin note](https://www.yeuxark.com/notes/%E5%A4%A7%E5%AE%9D%E5%8F%AF%E6%A2%A6%E6%97%B6%E4%BB%A3k.html)).
