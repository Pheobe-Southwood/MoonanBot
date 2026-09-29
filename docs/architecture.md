# Architecture

MoonanBot is a modular TypeScript ESM application with one process and one authoritative SQLite database.

```text
WebUI ── REST/SSE ── Fastify API ─┬─ RuntimeOrchestrator ─┬─ SimulationAgent
                                  │                       └─ SynthesisAgent
                                  ├─ ProviderRegistry ──── pi-ai providers
                                  ├─ ChatPlatformAdapter ─ OneBot v11 WS (reverse + outbound)
                                  └─ MoonanDatabase ────── SQLite/WAL
```

The simulation loop receives world events, renders current character context into the system prompt, and exposes a single public tool: `perform_action`. Every world-event user message and every action result (errors included) ends with the currently available actions, rendered from the same phone-state machine that validates execution, so no discovery tool is needed. The phone moves through Closed → Home → Contact List → Chat; `open_chat` is only reachable from the Contact List and validates that the target is a known contact or group; entering a chat marks it fully read and keeps a persisted Reading Cursor for paging upward with `load_history`. `wait_messages` is the third Terminating Action beside `idle` and `sleep`: it keeps mode `waiting` and the chat open until the watched conversation delivers enough messages, the time limit runs out, or any notification interrupts (the wake merges the notification with the watched conversation's new messages). Group messages that @ the Character — `@all` included — notify with the sender's Message Importance using the private-message signal mapping, and platform echoes of the Character's own messages are dropped before storage. Director notes and provider reasoning are stored as traces and never sent to OneBot; only `send_messages` can produce outbound chat.

The synthesis loop runs on every sleep and at `min(272k, 80% of model context)` by default. Its tools modify an in-memory staging view. `finish_synthesis` validates memory limits and commits memories, relationships, groups, and a possible soft-limit change in one SQLite transaction. Raw events and document revisions remain available after active-memory forgetting.

Platform concerns are isolated behind `ChatPlatformAdapter`. OneBot v11 is the only v0.0.1 implementation. A Platform Connection is either a reverse socket dialed by the implementation or an Outbound Client dialed by MoonanBot; both feed one connection set, so authentication, the one-`self_id` rule, event handling, and API dispatch do not branch on direction. `fetchHistory` is an optional future capability; current history reads only locally observed messages.

See [CONTEXT.md](../CONTEXT.md) for canonical terms and [ADR-0001](adr/0001-sqlite-source-of-truth.md), [ADR-0002](adr/0002-platform-adapter-and-onebot-reverse-websocket.md), [ADR-0003](adr/0003-plaintext-provider-credentials.md), [ADR-0004](adr/0004-outbound-onebot-clients.md), [ADR-0005](adr/0005-platform-roster-authority.md), [ADR-0006](adr/0006-terminating-action-invariant.md), and [ADR-0007](adr/0007-action-menu-appendix.md) for tradeoffs.
