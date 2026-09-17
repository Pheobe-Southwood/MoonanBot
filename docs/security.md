# Security model

MoonanBot v0.0.1 is a single-operator local service. It binds to loopback by default, uses password-only login, hashes the password with scrypt, stores only hashed Web session tokens, enforces same-origin checks on unsafe authenticated requests, and rate-limits failed logins in memory.

SQLite files are created with mode `0600`; installation directories are owned by the non-login `moonanbot` service user. API and OAuth secrets are stored in plaintext by explicit product choice. Web responses mask provider secrets and ordinary logs do not include request bodies, but root, the service account, process debuggers, or copied full database backups can read them.

The OneBot token protects the reverse WebSocket, and each outbound client authenticates to the implementation with its own token. Keep both on a trusted host/network. MoonanBot does not provide TLS; use `wss://` for outbound clients, or an SSH tunnel or a carefully configured reverse proxy, when transport leaves a trusted network.

Outbound messages can have real social impact. Review the character and traces, use allowlists, and keep the global outbound switch disabled during evaluation. A message whose connection fails after dispatch is marked `unknown` and is not automatically resent.

Raw messages, events, traces, provider reasoning, tool results, and revisions are retained until an operator deletes data. Incoming media URLs or file identifiers may appear in placeholders, but content is not downloaded. Prompt injection from chat participants remains a model-level risk; action validators and platform allowlists limit effects but do not eliminate it.

The temporary DeepSeek key used by maintainers for release testing is never committed or stored in MoonanBot's database. Any key pasted into a chat or external system should still be revoked by its owner after testing.
