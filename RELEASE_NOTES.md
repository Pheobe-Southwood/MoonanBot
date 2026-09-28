# MoonanBot v0.0.1-rc.5

This release candidate fixes three defects found in daily use: bodyless WebUI requests, simulation runs that stall awake, and a group list that drifts away from QQ.

The WebUI attached `Content-Type: application/json` to every request, including the ones without a body. Fastify 5 rejects an empty body carrying that header, so Start, Pause, Wake, model refresh, prompt restore, logout, and every delete button failed with `400 FST_ERR_CTP_EMPTY_JSON_BODY` while saves — which do carry a body — kept working. The header is now sent only when a body exists, which repairs all of those controls at once.

The Simulation Agent is designed to end every run with a Terminating Action: `idle` or `sleep`, the two actions that schedule the character's next wake. The old guard only noticed runs that performed no action at all, so a run that sent messages and then simply stopped left the character `awake` with no timer — silently stalled until somebody wrote to it. The guard now checks the ending state instead of the call count: a character still awake after the loop receives a continuation correction (worded for "no action at all" versus "acted but scheduled nothing"), up to the configured retries, before the existing forced thirty-minute idle fallback engages.

Roster Sync used to only add friends and groups when a Platform Connection opened, never removing anything, so groups the character had left stayed in the social world and the WebUI group list drifted from QQ. The platform roster is now authoritative for membership: a successful sync with a non-empty group list deletes local groups the platform no longer reports (each deletion is recorded as a `roster_sync` event), an empty platform list skips pruning to protect against a misbehaving implementation, and contacts missing from the friend list keep their record but lose `isFriend`. Sync also runs every six hours while connected and on demand through `POST /api/v1/platform/sync`, surfaced as a "Sync roster / 同步名单" button on the Groups tab.

Upgrading from RC.4 keeps the database, WebUI password, character, providers, and account configuration; the installer writes a pre-upgrade backup of the SQLite database.

The release still supports one character, one operator, one OneBot account, and text sending. Incoming media is represented only as text placeholders.

---

这是 MoonanBot v0.0.1 的第五个候选版本，修复了日常使用中发现的三个缺陷：WebUI 无 body 请求、推演运行醒着停滞、群列表与 QQ 漂移。

WebUI 过去给所有请求都带上 `Content-Type: application/json`，包括没有 body 的请求。Fastify 5 会拒绝「声明 JSON 却空 body」的请求，于是启动、暂停、唤醒、刷新模型、恢复提示词、退出登录以及所有删除按钮一律 `400 FST_ERR_CTP_EMPTY_JSON_BODY`，而带 body 的保存按钮却一切正常。现在仅当请求确实带 body 时才附加该头，上述控件一次全部修复。

推演 Agent 的设计要求每轮运行以 Terminating Action 收尾：即 `idle` 或 `sleep` 这两个会调度下次唤醒的动作。旧守卫只统计「是否调用过动作」，因此「发了消息然后直接结束」的运行会让角色停在 `awake` 且没有定时器——除非有人发消息，否则永久静默。现在守卫检查结束状态而非调用次数：循环结束后仍醒着的角色会收到继续纠正提示（区分「完全没动作」与「动作了但没安排下一步」两种文案），超过重试次数后仍由原有的强制待机 30 分钟兜底。

Roster Sync 过去只在连接建立时新增好友与群、从不清理，角色退掉的群会永远留在社交世界里，WebUI 群列表与 QQ 越漂越远。现在平台名单是成员资格的权威：成功且非空的 `get_group_list` 会删除本地多出的群（每次删除记录一条 `roster_sync` 事件）；平台返回空名单时跳过清理以防实现抽风误删；不在好友名单里的联系人保留记录但取消 `isFriend`。同步还在连接期间每六小时自动执行一次，并可通过 `POST /api/v1/platform/sync` 手动触发——群聊页新增「同步名单 / Sync roster」按钮。

从 RC.4 升级会保留数据库、WebUI 密码、角色、模型配置与账号配置；安装器会在升级前生成 SQLite 备份。

本版本仍只支持单角色、单操作者、单 OneBot 账号和纯文本发送，媒体仅转为文字占位。
