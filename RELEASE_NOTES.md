# MoonanBot v0.0.1-rc.6

This release candidate reworks the Simulation Agent's action surface: the phone becomes an explicit four-state machine, every message carries a current action menu, and the character learns to wait for replies.

The agent used to expose two tools: `list_available_actions` to discover what the phone state permits, and `perform_action` to act. Discovery cost a full model round trip, its answer could be stale by the next call, and a rejected action told the model what failed but not what it could do instead. The discovery tool is gone: every world-event message and every action result — errors included — now ends with the currently available actions, rendered from the same state machine that validates execution (ADR-0007). The menu can never be stale or skipped, and narration and validation cannot drift apart.

The phone now moves through Closed → Home → Contact List → Chat. `view_contacts` opens the contact list with unread counts and folds long lists (entries with unread messages are always shown); `open_chat` is only reachable from the contact list and only for known contacts or groups; entering a chat marks it fully read and stores a Reading Cursor so `load_history` can page further upward without losing its place. `idle` and `sleep` close the phone, and `set_contact_importance` is restricted to the contact list or that friend's own private chat.

`wait_messages` is the third Terminating Action (ADR-0006 revised). In an open chat the character can watch the conversation for 1–5 new messages (bounded by a timeout, 180 s by default) or simply wait for 5–60 seconds; the run ends in the new `waiting` mode with the chat kept open. Any notification-level message from any conversation ends the wait early, and the wake text merges the notification with whatever accumulated in the watched chat; elapsed time or a reached count wakes the character with a summary of what arrived. An operator wake cancels the wait and merges the new messages the same way.

Group messages that @ the character — `@all` included — now notify by the sender's Message Importance using the private-message signal mapping, so an @ from a Priority friend rings instead of being silenced by the group rule. Platform echoes of the character's own messages are dropped before storage: they are never re-observed as incoming, never notify, and never count toward waits.

The simulation system prompt moves to 0.0.2 with an exact-match migration: an untouched 0.0.1 default template is replaced on upgrade, a customised template is preserved as-is. New settings bound waits and the contact list (`waitMinSeconds`, `waitMaxSeconds`, `waitMinMessages`, `waitMaxMessages`, `waitMessageTimeoutSeconds`, `contactListMaxEntries`); `chatPreviewMessages` (10) and `historyMaxMessages` (50) defaults shrink, while existing databases keep their stored values. The WebUI localises the new `waiting` mode and Contact List state and exposes the new bounds. Agent traces no longer record every user message twice.

Upgrading from RC.5 keeps the database, WebUI password, character, providers, and account configuration; the installer writes a pre-upgrade backup of the SQLite database. Pending idle/alarm timers survive the upgrade; `wait` timers appear only once the character uses `wait_messages`.

The release still supports one character, one operator, one OneBot account, and text sending. Incoming media is represented only as text placeholders.

---

这是 MoonanBot v0.0.1 的第六个候选版本，重做了推演 Agent 的动作面：手机成为显式的四态状态机，每条消息都附带当前可用的动作清单，角色学会了等待回复。

Agent 过去暴露两个工具：`list_available_actions` 查询手机状态允许哪些动作，`perform_action` 执行。查询要花掉一次完整的模型往返，答案在下次调用前就可能过期，动作被拒绝时模型只知道失败原因、不知道还能做什么。现在查询工具已删除：每条世界事件消息和每次动作结果（包括错误）都以「接下来可用的动作」清单收尾，清单由验证执行的同一个状态机渲染（ADR-0007）。菜单不会过期、不会被跳过查询，叙述与校验永不脱节。

手机现在按 关闭 → 主页 → 好友和群聊列表 → 聊天窗口 四态流转。`view_contacts` 打开联系人列表，显示未读数并折叠长列表（有未读消息的条目始终显示）；`open_chat` 只能在联系人列表中执行，且目标必须是已知联系人或群聊；进入聊天窗口会将其全部标记为已读，并保存阅读游标，`load_history` 借此继续向上翻页而不丢失位置。`idle` 与 `sleep` 会关闭手机；`set_contact_importance` 仅限在联系人列表或该好友自己的私聊窗口中执行。

`wait_messages` 是第三个终止动作（ADR-0006 已相应修订）。在打开的聊天窗口中，角色可以等待该会话出现 1–5 条新消息（受超时限制，默认 180 秒），或单纯等待 5–60 秒；本轮以新的 `waiting` 模式结束，聊天窗口保持打开。任何会话中达到通知级别的消息都会提前结束等待，唤醒文案会把通知与被盯会话累积的新消息合并呈现；到时或计数达成同样唤醒，并附上到达内容的概要。操作员唤醒会取消等待，并以同样方式合并新消息。

@ 角色（含 `@all`）的群聊消息现在按发送者的 Message Importance 走私聊信号映射来通知：Priority 好友的 @ 会响铃，而不是被群聊规则静默。角色自己消息的平台回显在入库前被丢弃：不再被二次观测为来信、不触发通知、也不计入等待。

推演系统提示词升级到 0.0.2，并带精确匹配迁移：升级时未改动过的 0.0.1 默认模板会被替换，自定义过的模板原样保留。新增设置约束等待与联系人列表（`waitMinSeconds`、`waitMaxSeconds`、`waitMinMessages`、`waitMaxMessages`、`waitMessageTimeoutSeconds`、`contactListMaxEntries`）；`chatPreviewMessages`（10）与 `historyMaxMessages`（50）默认值调小，已有数据库保留其存储值。WebUI 本地化了新的 `waiting` 模式与联系人列表状态，并暴露新的边界设置。Agent 轨迹不再把每条用户消息重复记录两次。

从 RC.5 升级会保留数据库、WebUI 密码、角色、模型配置与账号配置；安装器会在升级前生成 SQLite 备份。待触发的 idle/alarm 定时器不受影响；`wait` 定时器只会在角色使用 `wait_messages` 后出现。

本版本仍只支持单角色、单操作者、单 OneBot 账号和纯文本发送，媒体仅转为文字占位。
