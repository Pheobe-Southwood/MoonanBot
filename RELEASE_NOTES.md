# MoonanBot v0.0.1-rc.8

This release candidate fixes two silent capability bugs that made custom-provider models — the ones behind a self-hosted OpenAI-compatible proxy — unable to use the very features the operator turned on: forced image input never reached the wire, and a selected thinking level was dropped before it could be sent. It also adds the `max` reasoning level.

**Forced image input now actually sends images.** In RC.7 the per-slot `forceImageInput` toggle only relaxed MoonanBot's own capability gate; the pi-ai serialization layer still checked the model record's `input` modalities and, finding no `"image"`, replaced every image with the literal text `(image omitted: model does not support images)`. Custom-provider models are always fabricated as `input:["text"]`, so a forced slot's character was told, in plain text, that the image had been omitted — exactly the "白蒙蒙的雾" symptom. Slot selection now patches the pi-ai Model record before serialization, so a forced slot sends real `image_url` data URIs.

**Custom-provider thinking levels now reach the provider.** Remote-fetched custom models are fabricated with `reasoning:false`, which made pi-ai clamp any selected level down to `off` and send no `reasoning_effort` at all. Even with reasoning enabled, `xhigh` and `max` were downgraded to `high` unless the model carried an explicit `thinkingLevelMap`. For custom providers, a non-`off` slot level now forces `reasoning:true` and maps `xhigh`/`max` to their verbatim wire values, so the level you pick is the level sent.

**New `max` thinking level.** pi-ai and pi-agent-core already model a `max` level above `xhigh`; MoonanBot now exposes it in the domain type, settings validation, and the WebUI thinking-level selector for every slot.

Catalog (built-in) models are untouched: pi-ai's authoritative metadata still governs them, reasoning is never force-enabled on a catalog model (which would 400 on providers that genuinely lack it), and `forceImageInput` remains the only image override. The WebUI now shows a hint on custom endpoints that the selected thinking level is sent verbatim as `reasoning_effort` — choose `off` to send nothing.

**Behaviour change to note.** Because the default slot thinking level is `medium`, custom-provider slots that previously sent no `reasoning_effort` (it was silently dropped) will now send `reasoning_effort:"medium"` after this upgrade. If your proxy rejects that parameter, set the slot's thinking level to `off`. Likewise, whether a proxy forwards `image_url` data URIs and `reasoning_effort` to the upstream model is a server-side concern: after this fix MoonanBot sends them correctly, and a proxy that refuses will now surface a visible error instead of a silent omission.

Upgrading from RC.7 keeps the database, WebUI password, character, providers, and account configuration; the installer writes a pre-upgrade backup of the SQLite database. There is no schema change and no settings migration — `max` simply becomes an accepted level.

---

这是 MoonanBot v0.0.1 的第八个候选版本，修复了两个让自定义供应商模型（自建 OpenAI 兼容代理后面的模型）无法使用运营者已开启功能的静默能力 Bug：强制图片输入从未真正发出，选定的思考等级在发送前就被丢弃；同时新增了 `max` 推理等级。

**强制图片输入现在真的会发送图片。** 在 RC.7 中，按槽位的 `forceImageInput` 开关只放开了 MoonanBot 自己的能力门；pi-ai 序列化层仍会检查模型记录的 `input` 模态，发现没有 `"image"` 后，把每张图片替换成字面文本 `(image omitted: model does not support images)`。自定义供应商模型总是被构造为 `input:["text"]`，所以被强制的槽位里，角色会用纯文本被告知"图片已被省略"——正是那层"白蒙蒙的雾"。现在槽位选择会在序列化前修补 pi-ai 的 Model 记录，被强制的槽位会发送真正的 `image_url` data URI。

**自定义供应商的思考等级现在能送达供应商。** 远程拉取的自定义模型被构造为 `reasoning:false`，这让 pi-ai 把任何选定等级钳到 `off`，完全不发送 `reasoning_effort`。即使启用了推理，`xhigh` 和 `max` 在缺少显式 `thinkingLevelMap` 时也会被降到 `high`。对于自定义供应商，非 `off` 的槽位等级现在会强制 `reasoning:true`，并把 `xhigh`/`max` 映射为其原样的 wire 值，于是你选的等级就是发出的等级。

**新增 `max` 思考等级。** pi-ai 与 pi-agent-core 本就在 `xhigh` 之上建模了 `max` 等级；MoonanBot 现在在每个槽位的域类型、设置校验与 WebUI 思考等级选择器中暴露它。

目录（内置）模型不受影响：仍以 pi-ai 的权威元数据为准，绝不在目录模型上强制启用推理（那会让真正不支持的供应商返回 400），`forceImageInput` 仍是唯一的图片覆盖手段。WebUI 现在会在自定义端点上提示：所选思考等级会原样以 `reasoning_effort` 发送——选 `off` 则不发送。

**需注意的行为变化。** 由于槽位默认思考等级是 `medium`，此前不发送 `reasoning_effort`（被静默丢弃）的自定义供应商槽位，升级后会开始发送 `reasoning_effort:"medium"`。如果你的代理拒绝该参数，请把该槽位的思考等级设为 `off`。同样，代理是否会把 `image_url` data URI 与 `reasoning_effort` 转发给上游模型属于服务器侧行为：修复后 MoonanBot 会正确发送它们，拒绝的代理现在会显式报错，而不再静默省略。

从 RC.7 升级会保留数据库、WebUI 密码、角色、模型配置与账号配置；安装器会在升级前生成 SQLite 备份。没有表结构变更，也无需迁移设置——`max` 只是成为一个被接受的等级。
