# Changelog

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
