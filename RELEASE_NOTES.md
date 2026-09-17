# MoonanBot v0.0.1-rc.3

This release candidate keeps the RC.2 backend and WebUI and narrows the OneBot handshake to match real implementations.

RC.3 fixes a connection-blocking incompatibility: the adapter required the `X-Client-Role` header to be lowercase, so implementations that send the conventional capitalized role values (`Universal`, `Event`, `Api`) — SnowLuma among them — were closed immediately with code `4400` and never reached the runtime. The header is now trimmed and compared case-insensitively, unknown values are still rejected with `4400`, and the default stays `universal` when the header is absent. Credential handling, the one-`self_id` rule (`4409`), roster sync, and outbound text sending are unchanged.

The handshake is now covered by adapter unit tests and a real WebSocket round trip against `/onebot/v11/ws`. Operators upgrading from RC.2 keep their database, WebUI password, character, and provider configuration; reinstalling preserves `/var/lib/moonanbot` and writes a pre-upgrade backup of the SQLite database.

The release still supports one character, one operator, one OneBot account, and text sending. Incoming media is represented only as text placeholders.

---

这是 MoonanBot v0.0.1 的第三个候选版本，后端与 WebUI 与 RC.2 保持一致，只修正 OneBot 握手以对齐真实实现。

RC.3 修复了一个会直接阻断连接的不兼容问题：适配器要求 `X-Client-Role` 必须是小写，因此发送约定大写角色值（`Universal`、`Event`、`Api`）的实现——包括 SnowLuma——会在握手阶段被 `4400` 立即关闭，永远进不到运行时。现在该请求头会先去除空白再做大小写不敏感比较，未知取值仍以 `4400` 拒绝，缺省值仍为 `universal`。凭据校验、单 `self_id` 规则（`4409`）、名单同步与文本发送均未变动。

该握手现在同时有适配器单测和针对 `/onebot/v11/ws` 的真实 WebSocket 往返测试覆盖。从 RC.2 升级会保留数据库、WebUI 密码、角色与模型配置；重装不会删除 `/var/lib/moonanbot`，并会在升级前生成 SQLite 备份。

本版本仍只支持单角色、单操作者、单 OneBot 账号和纯文本发送，媒体仅转为文字占位。
