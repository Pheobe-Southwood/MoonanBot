# MoonanBot v0.0.1-rc.4

This release candidate adds an outbound OneBot mode so MoonanBot can dial the QQ implementation itself, which is what containerised SnowLuma deployments need.

Until now the only way to attach an account was a reverse WebSocket: SnowLuma connected to `ws://127.0.0.1:21314/onebot/v11/ws`, and MoonanBot bound that port on the host loopback address only. An account running inside a Docker container cannot reach the host loopback, so the container had to be bridged with an extra TCP relay. RC.4 removes that requirement. `onebot.outbound` holds a list of clients — name, WebSocket URL, access token, optional `self_id`, role, reconnect interval, and an `enabled` flag — and MoonanBot dials each enabled entry with the usual OneBot headers (`X-Client-Role`, optional `X-Self-ID`, `Authorization: Bearer …`). Events and API replies arrive over that same socket, and `self_id` is learned from the first event when the field is left empty. Dropped sockets retry with exponential backoff capped at 30 seconds, and saving the settings reconnects only the entries that actually changed.

Reverse connections are now toggled by `onebot.acceptReverse`, which defaults to `true`, so the existing SnowLuma account keeps working exactly as before. Operators who only need the outbound path can turn it off. The settings row is normalised on read, so databases written by RC.3 gain the new fields without a migration, and `outbound: []` reproduces the previous behaviour. The Connections page gained an outbound section with per-client status (`已连接` / `重连中` / `已停用`) and the last error, and `GET /api/v1/runtime` reports the same list.

Upgrading from RC.3 keeps the database, WebUI password, character, providers, and the old account's configuration; reinstalling preserves `/var/lib/moonanbot` and writes a pre-upgrade backup of the SQLite database.

The release still supports one character, one operator, one OneBot account, and text sending. Incoming media is represented only as text placeholders.

---

这是 MoonanBot v0.0.1 的第四个候选版本，新增 OneBot「出站连接」模式：由 MoonanBot 主动拨号连接 QQ 实现，这正是容器化 SnowLuma 部署所需要的。

在此之前只有反向 WebSocket 一条路：SnowLuma 主动连接 `ws://127.0.0.1:21314/onebot/v11/ws`，而 MoonanBot 只监听宿主机回环地址。运行在 Docker 容器里的账号无法访问宿主机回环，只能额外加一层 TCP 中继。RC.4 取消了这一要求：`onebot.outbound` 是一个客户端列表——名称、WebSocket 地址、接入 Token、可选 `self_id`、角色、重连间隔与启用开关——MoonanBot 会按 OneBot 约定的请求头（`X-Client-Role`、可选 `X-Self-ID`、`Authorization: Bearer …`）逐条拨出。事件与 API 回包走同一条连接；`self_id` 留空时会从第一条事件中自动学习。连接断开后按指数退避重试、上限 30 秒；保存设置时只重连真正发生变化的条目。

反向连接现在由 `onebot.acceptReverse` 控制，默认 `true`，因此原有 SnowLuma 账号的行为完全不变；只需要出站路径的操作者可以将其关闭。设置行在读取时会做归一化，RC.3 写入的数据库无需迁移即可获得新字段，`outbound: []` 等价于旧行为。连接页面新增出站区块，逐个显示状态（`已连接` / `重连中` / `已停用`）与最近一次错误，`GET /api/v1/runtime` 也会返回同一份列表。

从 RC.3 升级会保留数据库、WebUI 密码、角色、模型配置与旧账号配置；重装不会删除 `/var/lib/moonanbot`，并会在升级前生成 SQLite 备份。

本版本仍只支持单角色、单操作者、单 OneBot 账号和纯文本发送，媒体仅转为文字占位。
