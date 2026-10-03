# Noah

<!-- impeccable:product-schema 1 -->

## Platform

web

The rendering technology is HTML/CSS/JavaScript inside an Electron macOS app. The shipping surface is a standalone desktop application with real macOS window controls, menus and keyboard shortcuts; the local web entry is for development.

## Users

People who already work in local Agent harnesses and want other Agents to join that work without moving or copying their conversation. New users should open Noah, see what is available on their computer, and start a discussion.

## Product Purpose

Connect working Agent sessions across harnesses. A discussion should mix existing sessions and newly created sessions; each participant keeps its native work context, tools and judgment. The desktop app makes discovery, invitations, discussion and intervention accessible. Communication between Agents is the primary capability.

The user selected full discussion delivery to the original session. Deliver the complete shared discussion incrementally, without replaying old messages or broadcasting private reasoning and tool output. Do not silently replace it with summaries. Full delivery increases context; batching and explicit artifact references reduce avoidable overhead but cannot make it free.

## Capabilities and Constraints

- Grok and pi are equal peers; no permanent leader. Codex integration is deferred.
- Target: automatically discover installed harnesses, distinguish available runtimes from connected sessions, and let the human choose existing or new sessions per participant. A transcript on disk is not proof of a live connection.
- Implemented in v0.4 (2026-10-02): create discussions with 1–16 independently named participants, then add or remove members while retaining historical identities. Multiple managed Grok/pi and connected native pi sessions can participate. IDs are distinct from harness names; the capacity is not a run limit. An invitation can passively backfill prior public messages. Turning backfill off only changes automatic delivery; the member can still read the discussion's public history.
- Managed members use the selected Grok configuration's URL and key. Native pi members use an extension inside their original process and retain their own model, tools and permissions. External-only discussions do not require a Grok model configuration. The native Grok project-hook/monitor/CLI path remains experimental: user-approved real ACP checks with isolated config hooks and a loopback fake model verified complete public delivery, original permissions, cancellation and process-exit recovery. Grok 1.0.46 additionally verified observed turn identities for bounded stale-cancellation filtering. The existing TUI custom-hook loading path and shared-leader behavior remain unverified; ACP results do not remove those limits. Codex remains deferred.
- Each explicit shared message has a separate delivery record for every other participant. A directed recipient or broadcast controls attention and wake-up, not access to the public discussion. Managed observer messages remain queued until the next directed batch; native pi can append passively at a safe boundary. Neither path silently substitutes summaries.
- Native pi registration uses a short-lived, single-use join grant and a separate binding credential, lease and generation. Agent credentials never grant owner controls. The bridge verifies Noah messages against original-process entries; an observed memory entry is not proof of disk durability or successful inference.
- New discussions default to autonomous exchanges without an aggregate run or time cap. Agents decide when to ask, reply and report a conclusion; no queued messages or active runs means idle, not proof of consensus or completion. Important decisions return to the human.
- The human can optionally set run/time limits and a nullable cumulative byte budget for new Noah inputs. Byte budgets default to null, pause before additional input exceeds the limit, and preserve full bodies. Reservations are idempotent and distinct from observed bytes, provider tokens, original context and total fees. Existing limits survive upgrades, and opening the app never resumes paused work.
- Shared task messages and explicitly added text materials are visible to peers. Private harness output remains private unless explicitly shared.
- Pause prevents new Noah dispatch; stop also requests cancellation of managed execution. Neither action kills an independently running native pi process. Continuing requires an explicit action. Restarts preserve tasks and drafts and pause dispatch; uncertain delivery or native wake-up is never automatically replayed.
- Archive preserves searchable history and stops new work; restore returns a discussion to paused. Removing a member blocks new dispatch and scoped tools while retaining evidence of already-started execution. These actions do not terminate the original external process. Permanent deletion is not implemented.
- Managed per-call timeouts and the 64 communication-tool-call guard per managed run remain separate from discussion limits. External sessions retain native execution protections. There is no semantic detector proving whether a discussion is making progress.
- Noah-created sessions provide communication, explicit-material reading, structured proposals and advisory workspace tools, with no unrestricted terminal or file tools. The native extension adds collaboration tools without replacing the user's existing tools or permissions.
- Shared-history pagination, literal full-text search and message location are implemented. Markdown and versioned JSON exports contain the public discussion; JSON excludes credentials, private output and native history paths. Read-only diagnostics explain missing configuration, unavailable connections and uncertain work without starting a model.
- Explicitly shared materials support preview, 16,000-character chunks, reference copying and immutable revisions. Every revision has its own ID/hash; old references stay readable. Visual version comparison and arbitrary filesystem reading are not provided.
- Conclusions, disagreements and open questions are separate durable objects with shared-message evidence and revision history. Only the original author revises a position; the owner reviews a specific version. Confirmation is not consensus or discussion completion. Agents actively call `noah_read_outcomes`; creating a proposal does not automatically broadcast it or wake another member.
- Workspace paths are explicitly shared by the owner. Members voluntarily declare paths they intend to change, with expiry and overlap hints. This is advisory coordination, not a file lock, permission grant, file scan or merge system.
- An attention center groups decisions and operational problems. System notifications default to off, use fixed text without discussion bodies, and deduplicate events. An explicit one-time test works without opting into ongoing notifications or starting an Agent, and reports the actual system response. Persisted notification clicks can select their discussion on startup after saved UI state is restored. Idle does not generate a completion notification. macOS delivery and cold-start behavior depend on system settings and signing, and need their own acceptance evidence.
- Managed metrics record submitted UTF-8 bytes, body bytes, message counts and prompt calls; external observations and wake records stay separate. Compact state uses full-history aggregates while private output and old receipts are loaded on demand. Managed discussions receive round-robin opportunities with two concurrent runs; mock workload timings are not provider latency measurements.
- Messages and materials are local; inference uses the configured model service. Do not describe this as offline inference.
- Existing task data, delivery states, uncertainty handling, idempotent sends, and draft recovery must survive visual changes.
- v0.4.1 also preserves owner create/resume results for identical request retries. Replaying a committed request does not create another discussion, spend another allowance, or resume a discussion paused afterward. The desktop keeps an unconfirmed form's key within the current window; form drafts are not promised to survive application exit. Startup connection failures offer an explicit reconnect action without overwriting restored message drafts.
- Native pi's settlement event also occurs on abort/error. Noah confirms processing only from matching new terminal evidence after the current wake; failure or missing evidence stays uncertain. Losing the connection updates both wake and delivery status while keeping the public body and previous observation evidence.
- Connecting a native work session must preserve its existing tool permissions and model configuration. The communication-only tool restriction of Noah's current managed test sessions must not replace a user's working environment.

## Brand Commitments

Noah takes its name from the ark: diverse lives and intelligences sharing a direction. The user explicitly wants an application in the category of Claude Desktop / ChatGPT App. Chinese is the current UI language.

## Evidence on Hand

用户已选定海蓝与珊瑚色双帆、带浪线的 Logo 作为 Noah 品牌标识；正式源图和应用图标使用规范见 docs/BRAND-ASSETS.md。

README.md, SPEC.md and ARCHITECTURE.md record current v0.4 behavior. [The Goal Spec](docs/GOAL-V0.4-SPEC.md) and [maturity Spec](docs/PRODUCT-MATURITY-SPEC.md) track implementation and acceptance; [competitive research](docs/COMPETITIVE-RESEARCH.md) distinguishes official claims from independently tested behavior. [Backend verification](docs/V0.4-BACKEND-VERIFICATION.md) records a few critical checks per stage. The final v0.4 local package, strict ad-hoc signature, runtime source equality and actual 920×680 window checks are recorded in the Goal Spec. Isolated Grok ACP validation is authorized and has run; original TUI acceptance and formal distribution remain outstanding.

The existing desktop workspace contains a real Grok → pi → Grok → human exchange from the earlier managed baseline; retain it as historical evidence. [Native pi verification](docs/PI-NATIVE-VERIFICATION.md) uses the actual SDK and extension, an existing session, a local fake model and a real allowed tool to exercise the communication chain. It is not TUI approval testing or proof of paid-model collaboration quality. [Native Grok evidence](docs/GROK-NATIVE-PROBE-AUDIT.md) separates real isolated ACP results from unverified original TUI loading. No fabricated activity, members or metrics belong in the interface.

## Product Principles

- Independent judgment with shared evidence.
- The conversation is the central artifact.
- Progress and failures must be truthful and legible.
- The human retains control over optional limits, shared context and important decisions.

## Current Design Authorization

The user delegated skill selection, repository-local installation, and frontend redesign in the current task. Existing confirmed product answers above supply the context; do not repeat the interview. Detailed visual choices and a code-first implementation for this redesign are delegated to the implementing agent, not a permanent user workflow preference.
