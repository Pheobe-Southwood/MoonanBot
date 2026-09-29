# MoonanBot v0.0.1-rc.7

This release candidate gives the character sight: inbound QQ images are downloaded the moment they are observed, understood through a dual path keyed by each model's real capability, and described once for models that cannot see.

Images used to become a `[图片：file]` placeholder and nothing else. Now every consumer resolves its Image Input Capability at render time — from the pi-ai catalog's `model.input`, or from the new per-slot `forceImageInput` override when a catalog under-declares. Image-capable consumers receive the real image content inline, newest-first, capped by `media.maxInjectedImages` (default 10); overflow degrades to description text with a note. Image-blind consumers receive `[图片：description]` text produced by the new Vision Agent, generated lazily on first need and cached permanently on the media row, so one image is described at most once no matter how many blind consumers or restarts follow (ADR-0008).

The Vision Agent is the third mind beside Simulation and Synthesis: its own provider, model, thinking level, and an editable, versioned system prompt with no required placeholders. Its calls appear in the Activity page as `vision` runs with traces, and the prompt travels in character export/import — bundles without it stay importable.

Because QQ image URLs expire quickly, bytes are downloaded at observation time: segment URL first, the OneBot `get_image` API as fallback, with the format decided by magic bytes (jpeg/png/gif/webp/bmp), two concurrent downloads, and failures degrading to placeholders instead of breaking renders. Bytes live in the SQLite `message_media` table under a TTL (`media.byteTtlDays`, default 7) and are purged daily while descriptions survive; pending downloads re-enqueue after a restart. Bytes are part of full database backups — size them accordingly.

Persisted agent state never carries base64: image blocks are replaced with `[图片]` markers when a run ends, and the archive threshold estimates a flat 1500 tokens per image block. The new validated settings group `media` (`enabled`, `downloadTimeoutMs`, `byteTtlDays`, `maxInjectedImages`) has its own WebUI card. Readiness gained non-blocking warnings — a blind model with no usable Vision Agent surfaces on the Overview page but never prevents start.

In the WebUI, the Agents page becomes three tabs; model dropdowns mark image-capable models with 🖼, a capability pill states whether the selected model sees images natively or by force, and the force toggle appears exactly when the catalog says text-only. Activity labels `vision` runs, and providers now expose each model's input modalities through the API.

Upgrading from RC.6 keeps the database, WebUI password, character, providers, and account configuration; the installer writes a pre-upgrade backup of the SQLite database. The schema change is additive (`message_media`), settings normalize without migration, and the vision slot starts unconfigured — until it is configured (or a blind slot is forced), blind consumers keep seeing the old placeholders.

The release still supports one character, one operator, and one OneBot account, and still sends text only. Audio, video, files, and unsupported segments remain textual placeholders and are not downloaded.

---

这是 MoonanBot v0.0.1 的第七个候选版本，让角色拥有了视觉：入站 QQ 图片在观测瞬间即被下载，按每个模型的真实能力走双通道理解，且对看不见图的模型只描述一次、永久缓存。

图片过去只会变成 `[图片：file]` 占位符。现在每个消费者在渲染时解析自己的图片输入能力——以 pi-ai 目录的 `model.input` 为准，目录漏报时可以用新的按槽位 `forceImageInput` 强制覆盖。支持图片输入的消费者直接收到原图内容，按时间倒序、受 `media.maxInjectedImages`（默认 10）限制；超出上限的图片降级为文字描述并附注说明。不支持图片的消费者收到 `[图片：描述]` 文本，由新的图片识别 Agent 在首次需要时惰性生成，并永久缓存在媒体行上——无论多少盲模型消费者、无论重启多少次，一张图最多描述一次（ADR-0008）。

图片识别 Agent 是与推演、归纳并列的第三个心智：独立的提供商、模型、思考等级，以及可编辑、带版本的系统提示词（无必需占位符）。它的调用以 `vision` 运行出现在活动页并带完整轨迹；提示词随角色包导出/导入，不含它的旧角色包仍可导入。

QQ 图片 URL 过期很快，因此字节在观测时立即下载：优先分段 URL，失败回退 OneBot `get_image` API，格式由 magic bytes 判定（jpeg/png/gif/webp/bmp），并发上限 2，任何失败都降级为占位符而不影响渲染。字节存于 SQLite 新表 `message_media`，按 TTL（`media.byteTtlDays`，默认 7 天）每日清理，描述永久保留；重启后未完成的下载自动续传。字节会计入完整数据库备份的体积，请据此规划。

持久化的 Agent 状态永不携带 base64：运行结束时图片块被替换为 `[图片]` 标记，归档阈值按每张图固定 1500 token 估算。新增经过校验的 `media` 设置组（`enabled`、`downloadTimeoutMs`、`byteTtlDays`、`maxInjectedImages`），WebUI 有独立卡片。就绪检查新增非阻塞警告——盲模型没有可用的图片识别 Agent 时会在总览页提示，但绝不阻止启动。

WebUI 的 Agents 页变为三个标签；模型下拉为支持图片的模型加 🖼 标记，能力 Pill 说明当前模型是原生支持还是被强制启用，强制开关只在目录声明纯文本时出现。活动页标注 `vision` 运行，提供商 API 暴露每个模型的输入模态。

从 RC.6 升级保留数据库、WebUI 密码、角色、模型配置与账号配置；安装器会在升级前生成 SQLite 备份。表结构变更为纯新增（`message_media`），设置无需迁移即可归一化；图片识别槽位初始未配置——在配置它（或强制某个盲槽位）之前，盲模型消费者仍看到旧占位符。

本版本仍只支持单角色、单操作者、单 OneBot 账号，发送仍为纯文本；音频、视频、文件与不支持的分段仍只转为文字占位，不下载。
