# Changelog

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
