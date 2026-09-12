# OneBot v11 setup

MoonanBot exposes one reverse WebSocket endpoint on the WebUI listener:

```text
ws://127.0.0.1:21314/onebot/v11/ws
```

Configure NapCat or another OneBot v11 implementation as the connecting client. Required connection metadata:

- `X-Self-ID`: the bot account ID.
- `X-Client-Role`: `event`, `api`, or `universal` (defaults to `universal`). Separate event and API sockets may coexist for the same account.
- `Authorization`: `Bearer <token>` or `Token <token>`, using the token shown under Connections.

Only one `self_id` is accepted. A different second account is closed with code `4409` and recorded as an operational problem.

Private and group allowlists are independent. An empty list means allow all. All messages from allowed groups are stored, even when they do not notify the character. Incoming text, mentions, and replies are normalized. Images, audio, video, files, and unsupported segments become text placeholders; no media is downloaded. MoonanBot sends text segments only.

The adapter matches API responses by `echo`, enforces a configurable timeout, clears pending requests on disconnect, caches friend/group rosters, and records every observed group member as a possible relationship contact. Message IDs are deduplicated locally.
