# OneBot v11 setup

MoonanBot talks OneBot v11 in both directions. Pick whichever direction fits the deployment; both share the same token, allowlists, and one-`self_id` rule.

## Reverse WebSocket (the implementation dials in)

MoonanBot exposes one reverse WebSocket endpoint on the WebUI listener:

```text
ws://127.0.0.1:21314/onebot/v11/ws
```

Configure NapCat or another OneBot v11 implementation as the connecting client. Required connection metadata:

- `X-Self-ID`: the bot account ID.
- `X-Client-Role`: `event`, `api`, or `universal`, compared case-insensitively (defaults to `universal`). Separate event and API sockets may coexist for the same account.
- `Authorization`: `Bearer <token>` or `Token <token>`, using the token shown under Connections.

Set `onebot.acceptReverse` to `false` to reject inbound sockets with code `4403` and use the outbound mode only.

## Outbound WebSocket (MoonanBot dials out)

Each `onebot.outbound` entry makes MoonanBot the client:

| Field | Meaning |
| --- | --- |
| `name` | Unique label, also used to match live status in the WebUI. |
| `url` | `ws://` or `wss://` endpoint of the implementation's WebSocket server. |
| `accessToken` | Sent as `Authorization: Bearer <token>`; must match the token configured on the implementation's side. |
| `selfId` | Optional. Sent as `X-Self-ID` when set, otherwise learned from the first event. |
| `role` | `event`, `api`, or `universal`; use `universal` unless you deliberately split sockets. |
| `reconnectIntervalMs` | First retry delay (1000–600000); retries back off exponentially, capped at 30 s. |
| `enabled` | `false` keeps the entry configured but disconnected. |

This mode exists for implementers that run in a container, where their `127.0.0.1` is not the host loopback and therefore cannot reach MoonanBot's reverse endpoint without an extra relay. Point the URL at a host address the container can route to, for example `ws://172.18.0.1:3001/` for a SnowLuma container using its own WebSocket server, or `ws://<host>:3001/` across a LAN.

The implementation must have a WebSocket **server** enabled with a token; MoonanBot then acts as both the event receiver and the API caller on that socket. Multiple entries are allowed, for example one per account or per SnowLuma module instance. Saving the settings reconnects only the entries that changed, and `GET /api/v1/runtime` reports each entry as `connected`, `reconnecting`, or `disabled` with its last error.

## Shared behaviour

Only one `self_id` is accepted, no matter which direction the socket used. A different second account is closed with code `4409` and recorded as an operational problem.

Private and group allowlists are independent. An empty list means allow all. All messages from allowed groups are stored, even when they do not notify the character. Incoming text, mentions, and replies are normalized. Images, audio, video, files, and unsupported segments become text placeholders; no media is downloaded. MoonanBot sends text segments only.

The adapter matches API responses by `echo`, enforces a configurable timeout, clears pending requests when the last API-capable socket disconnects, caches friend/group rosters, and records every observed group member as a possible relationship contact. Message IDs are deduplicated locally.
