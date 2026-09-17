# Operations

## Service layout

- Application: `/opt/moonanbot/releases/<version>`
- Active symlink: `/opt/moonanbot/current`
- Runtime: `/opt/moonanbot/runtime`
- Data: `/var/lib/moonanbot/moonanbot.sqlite`
- Configuration: `/etc/moonanbot/moonanbot.env`
- Service: `moonanbot.service`

The installer is idempotent. Before an upgrade it stops the service and creates a timestamped full database backup under `/var/lib/moonanbot/backups`. Version directories make application rollback possible, but database downgrade is not promised.

## Commands

```bash
systemctl status moonanbot
journalctl -u moonanbot -f
/opt/moonanbot/runtime/bin/node /opt/moonanbot/current/dist/cli.js status
/opt/moonanbot/runtime/bin/node /opt/moonanbot/current/dist/cli.js reset-password
/opt/moonanbot/runtime/bin/node /opt/moonanbot/current/dist/cli.js backup /safe/path/backup.sqlite
```

A full backup contains plaintext credentials. Store it like a secret. The WebUI character package is suitable for moving identity and long-term state without credentials or chat history.

## Remote access

Keep the default `127.0.0.1` bind address and tunnel it:

```bash
ssh -N -L 21314:127.0.0.1:21314 server
```

## Uninstall

`install.sh --uninstall` removes the service and application but preserves `/var/lib/moonanbot` and `/etc/moonanbot`. Add `--purge` only when you deliberately want those retained files deleted.

## Troubleshooting

- Login lost: reset the password with the root CLI; all Web sessions are revoked.
- OneBot offline: verify the reverse-WS URL, token, `X-Self-ID`, role, and localhost/network namespace. For outbound clients, check the URL/token under Connections and the reported last error, and confirm the implementation's WebSocket server is enabled.
- Provider unavailable: refresh models, inspect OAuth progress, and confirm the selected model still exists.
- Agent degraded: inspect Activity. Failed synthesis batches remain pending and retry on the next eligible run.
- Port conflict: edit the Web settings or `/etc/moonanbot/moonanbot.env`, then restart the service.
