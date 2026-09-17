# MoonanBot

[简体中文](README.zh-CN.md)

MoonanBot is a multi-platform AI chat bot dedicated to exploring lifelike presence and bringing virtual characters to life.

> **v0.0.1 is a release candidate.** The backend is tested; the WebUI is awaiting hands-on acceptance. Keep the bot paused until you have reviewed the character, provider, and outbound-message settings.

## What it does

- Runs a `SimulationAgent` that directs one character's actions from personality, memory, relationships, and current events.
- Runs a transactional `SynthesisAgent` that consolidates events into bounded long-term memory and social records.
- Connects to OneBot v11 over a reverse WebSocket or as an outbound client that dials the implementation, behind a platform-neutral adapter for future integrations.
- Provides a bilingual macOS-inspired WebUI with progressive disclosure for configuration, traces, prompts, providers, and data maintenance.
- Stores all authoritative state in SQLite with WAL, foreign keys, durable timers, versioned prompts, and immutable raw history.

MoonanBot is built on [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) and [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi), both pinned to `0.85.1`.

## Install on Ubuntu 26.04 x86_64

Run as root:

```bash
curl -fsSL https://raw.githubusercontent.com/Pheobe-Southwood/MoonanBot/v0.0.1-rc.4/scripts/install.sh | bash
```

The installer creates a locked-down `moonanbot` service user, installs under `/opt/moonanbot`, stores data under `/var/lib/moonanbot`, binds the WebUI to `127.0.0.1:21314`, and prints the generated password once. The service starts with the character paused.

For remote access, keep the default loopback binding and use an SSH tunnel:

```bash
ssh -L 21314:127.0.0.1:21314 your-server
```

Then open <http://127.0.0.1:21314>.

## Development

Requirements: Node.js `>=22.19.0` and pnpm `11.7.0`.

```bash
pnpm install
pnpm check
pnpm dev
```

The first local start prints a generated WebUI password. Data defaults to `~/.moonanbot`; override it with `MOONANBOT_DATA_DIR`.

Useful commands:

```bash
moonanbot reset-password
moonanbot backup /safe/path/moonanbot.sqlite
moonanbot status
```

The full SQLite backup contains plaintext provider credentials. A WebUI character export intentionally excludes credentials, messages, and run history.

## OneBot

Either configure your OneBot implementation to connect to:

```text
ws://127.0.0.1:21314/onebot/v11/ws
```

and send `X-Self-ID`, `X-Client-Role: event|api|universal`, and the configured `Bearer` or `Token` credential, or add an outbound client under Connections so MoonanBot dials the implementation instead — useful when the implementation runs in a container that cannot reach the host loopback. Only one OneBot account is accepted in v0.0.1. See [OneBot setup](docs/onebot.md).

## Documentation

- [Architecture](docs/architecture.md)
- [OneBot v11 setup](docs/onebot.md)
- [Providers and OAuth](docs/providers.md)
- [Operations, backups, and SSH access](docs/operations.md)
- [Security model and limitations](docs/security.md)
- [Engineering evaluation protocol](docs/evaluation.md)
- [Domain language](CONTEXT.md) and [architecture decisions](docs/adr)

## Scope and limitations

This release supports one character, one local operator, one OneBot account, and text output only. Incoming media becomes a textual placeholder and is not downloaded or understood. It does not claim scientific validation, human reproduction, or safe unattended public deployment.

## License

MoonanBot is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
