# Changelog

## Unreleased

- Fixed `wait_messages` missing messages that arrive during model-provider latency (#5): the wait window anchored to `Date.now()` at tool execution, so incoming messages between the last chat read/send and the wait action were excluded from `messageCount`, absent from the wait summary, and could even produce a "phone vibrated … no new messages" wake. The window now anchors to the Character's last up-to-date view of the watched chat — the oldest unread incoming message, else now — and a count-mode wait whose target is already satisfied expires immediately instead of idling until the timeout.
- Delivered wait summaries now mark exactly the messages they rendered as read, so consecutive waits never re-count or re-show them and the contact list no longer reports a chat the Character just read through a wait summary as unread. A wait timer that expires while paused still leaves its messages unread, so they resurface after the operator resumes.
- Fixed stale action menus accumulating in the simulation context (#6): world-event messages and `perform_action` results still append the current “接下来可用的动作” menu (ADR-0007), but superseded menus are now stripped before every LLM call and from the transcript persisted at run end, so only the newest copy is ever sent to the model or counted toward the archive threshold (ADR-0009).

## 0.0.1-rc.8 — 2026-09-29

- Fixed `forceImageInput` never reaching the provider wire: the flag only relaxed MoonanBot's own capability gate, while pi-ai's message transform still replaced images with `(image omitted: model does not support images)` whenever the model record's `input` lacked `"image"` — which is always the case for custom-provider models (hardcoded `input:["text"]`). Slot selection now patches the pi-ai Model record before serialization, so forced slots send real `image_url` data URIs.
- Fixed custom-provider thinking levels being silently dropped: remote-fetched custom models are fabricated with `reasoning:false`, so pi-ai's `clampThinkingLevel` collapsed any selected level to `off` and sent no `reasoning_effort`; even with reasoning enabled, `xhigh`/`max` were downgraded to `high` without an explicit `thinkingLevelMap`. For custom providers, a non-`off` slot level now forces `reasoning:true` and maps `xhigh`/`max` to their verbatim wire values.
- Added the `max` thinking level (already supported by pi-ai/pi-agent-core) to the domain type, settings validation, and the WebUI thinking-level selector.
- Catalog models keep pi-ai's authoritative capability metadata: reasoning is never force-enabled on them (which would 400 on providers that genuinely lack it), and `forceImageInput` remains the only image override.
- WebUI: custom endpoints show a hint that the selected thinking level is sent verbatim as `reasoning_effort` (choose `off` to send nothing).

## 0.0.1-rc.7 — 2026-09-29

- Added image understanding with a dual path (ADR-0008): image-capable consumers receive real `ImageContent` inline (newest-first, capped by the new `media.maxInjectedImages`, default 10); image-blind consumers receive `[图片：description]` text from a Vision Agent, generated lazily on first need and cached permanently.
- Added the Vision Agent as a third model slot beside Simulation and Synthesis: its own provider/model/thinking level, an editable and versioned system prompt (no required placeholders), activity traces as `vision` runs, and inclusion in character export/import (bundles without it stay importable).
- Image capability resolves from the pi-ai catalog (`model.input`, now exposed by `GET /api/v1/providers`) or the new per-slot `forceImageInput` override for mis-catalogued models; the WebUI marks image-capable models with 🖼, shows a capability pill, and offers the force toggle.
- Inbound image segments are downloaded at observation time into a new `message_media` table (segment URL first, OneBot `get_image` fallback, magic-byte format sniffing, 2-way concurrency); bytes are purged after `media.byteTtlDays` (default 7) while descriptions survive, and pending downloads re-enqueue after a restart.
- Persisted simulation state never carries base64: image blocks become `[图片]` markers when a run ends, and the archive threshold estimates a flat 1500 tokens per image block.
- New validated settings group `media` (`enabled`, `downloadTimeoutMs`, `byteTtlDays`, `maxInjectedImages`) with a WebUI card; readiness gained non-blocking warnings when blind models have no usable Vision Agent, surfaced on the Overview page.
- Added ADR-0008 plus the CONTEXT.md terms Vision Agent, Media Cache, Image Description, and Image Input Capability; updated the architecture, security, and OneBot docs for the media pipeline.

## 0.0.1-rc.6 — 2026-09-29

- Refactored the simulation action surface: removed `list_available_actions`; every world-event user message and every `perform_action` result (errors included) now ends with the currently available actions.
- Reworked the phone state machine to Closed / Home / Contact List / Chat with new actions `view_contacts` and `wait_messages`; `open_chat` is only reachable from the Contact List and validates that the target is known; entering a chat marks it fully read and keeps a persisted Reading Cursor for `load_history` paging.
- Added `wait_messages` as a third terminating action (new `waiting` runtime mode and `wait` timer kind): watch the open chat for 1–5 new messages (with a timeout, default 180 s) or for 5–60 seconds; any notification-level message from any conversation ends the wait early and merges the notification with the watched conversation's new messages; operator wake cancels the wait too.
- `idle` and `sleep` now close the phone; `set_contact_importance` is restricted to the Contact List (any friend) or the private chat of that friend.
- Group messages that @ the Character (`@all` included) now notify with the sender's Message Importance using the private-message signal mapping.
- Dropped platform echoes of the Character's own messages: they are no longer re-stored as incoming, never trigger notifications, and never count toward waits.
- New validated simulation settings: `waitMinSeconds`/`waitMaxSeconds`/`waitMinMessages`/`waitMaxMessages`/`waitMessageTimeoutSeconds`/`contactListMaxEntries`; `chatPreviewMessages` default 20→10 and `historyMaxMessages` default 200→50 (existing databases keep their stored values).
- Simulation system prompt v0.0.2 with exact-match migration: untouched 0.0.1 default templates are replaced on upgrade, customised templates are preserved.
- Fixed duplicated user-message entries in agent traces: world-event messages, continuation corrections, and synthesis inputs were recorded manually and again through the agent's `message_end` event.
- WebUI: localised runtime mode and phone state (including `waiting` and Contact List) and exposed the new wait and contact-list settings.
- Revised ADR-0006 (wait is a terminating action) and added ADR-0007 (action-menu appendix replaces the discovery tool).

## 0.0.1-rc.5 — 2026-09-28

- Fixed the WebUI sending `Content-Type: application/json` on bodyless requests, which made Fastify reject Start/Pause/Wake, model refresh, prompt restore, logout, and every delete button with `400 FST_ERR_CTP_EMPTY_JSON_BODY`.
- Enforced the terminating-action invariant: a simulation run that ends while the character is still awake (no idle/sleep scheduled) now receives a continuation correction — worded differently for "no action at all" and "acted but scheduled nothing" — before the forced thirty-minute idle fallback.
- Made the platform roster authoritative: Roster Sync now deletes local groups absent from a successful non-empty `get_group_list` (each removal recorded as a `roster_sync` event), skips pruning on an empty platform list, and clears `isFriend` on contacts missing from `get_friend_list`.
- Added `POST /api/v1/platform/sync`, a "Sync roster" button on the Groups tab, and a six-hour periodic Roster Sync while connected.
- Added ADR-0005 (platform roster authority) and ADR-0006 (terminating-action invariant) plus the matching CONTEXT.md terms.

## 0.0.1-rc.4 — 2026-09-17

- Added outbound OneBot clients (`onebot.outbound`) so MoonanBot dials the QQ implementation instead of requiring an inbound reverse WebSocket; each entry carries a name, URL, access token, optional `self_id`, role, reconnect interval, and an enabled flag.
- Added automatic reconnection with exponential backoff (capped at 30 s), `self_id` learning from the first event, and reconciliation on save that only reconnects entries whose configuration changed.
- Added `onebot.acceptReverse` (default `true`) to keep reverse WebSockets working, plus settings normalisation so existing databases gain the new fields without a migration.
- Exposed outbound status in `GET /api/v1/runtime` and added an outbound section with per-client status to the Connections page.

## 0.0.1-rc.3 — 2026-09-17

- Accept `X-Client-Role` case-insensitively so OneBot implementations that send `Universal`, `Event`, or `Api` (for example SnowLuma) can attach instead of being closed with `4400`.
- Covered the handshake with adapter unit tests and a real WebSocket round-trip test through `/onebot/v11/ws`.

## 0.0.1-rc.2 — 2026-09-12

- Fixed the Ubuntu release-version variable collision in the root installer.
- Added synthesis retry/context-compaction coverage and refreshed release metadata.

## 0.0.1-rc.1 — 2026-09-12

- Initial modular TypeScript/ESM implementation built on pi-ai and pi-agent-core 0.85.1.
- Simulation and transactional synthesis agents with durable SQLite state.
- OneBot v11 reverse WebSocket adapter.
- Password-protected bilingual macOS-style WebUI.
- Built-in and custom provider management, OAuth flows, traces, exports, backups, tests, and Ubuntu installer.
