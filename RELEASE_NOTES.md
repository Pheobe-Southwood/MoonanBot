# MoonanBot v0.0.1-rc.9

This release candidate fixes custom-provider model list zeroing and stalling, stops stale action menus from inflating the simulation context, anchors message waits to the unread watermark so model latency cannot drop messages, and standardizes wake messages to character profile names.

**Custom-provider model lists are now persisted and resilient (#7, ADR-0010).** Custom-provider models previously existed only in process memory: restarts, editing any provider, or upstream glitches returning empty lists reset selectable models to zero, stalling the character with consumed timers. Models are now persisted in SQLite as a durable Known Model List. `ProviderRegistry` fetches remote models directly (with or without an API key, so keyless local endpoints like LM Studio or vLLM work seamlessly), writes back successful non-empty lists, triggers a background re-sync at boot, and preserves stored models on empty or failed responses while recording the failure. The WebUI also adds an in-place editor for custom endpoints with sync timestamps and error indicators.

**Superseded action menus are pruned from simulation context (#6, ADR-0009).** The "接下来可用的动作" action menu attached to world events and action results previously accumulated in the transcript until synthesis compaction, costing 150–250 tokens per action. The Simulation Agent now strips superseded menus before every LLM call and prunes them from the persisted state at run end, ensuring only the newest action menu reaches the model.

**Message waiting anchors to the unread watermark (#5).** `wait_messages` previously anchored its time window to `Date.now()` at tool execution, missing replies that arrived during model generation latency. The wait window now anchors to the oldest unread incoming message, count-mode waits already satisfied wake immediately, and delivered wait summaries mark rendered messages as read.

**Wake messages address the character by profile name (#8).** Start and wake events now use `${name}醒来了` and `${name}被唤醒了` instead of "你", matching system prompts and the Simulation Agent's director persona.

**Upgrade notes.** Upgrading from RC.8 preserves the database, WebUI password, character, providers, and account configuration. The installer automatically creates a pre-upgrade backup of the SQLite database. The schema update is non-destructive (two nullable columns `last_refresh_at` and `last_refresh_error` added to `custom_providers` via lightweight migration).

---

这是 MoonanBot v0.0.1 的第九个候选版本，修复了自定义提供商模型列表归零停滞问题，移除了推演上下文中堆积的过期动作菜单以降低 Token 消耗，“等待消息”锚定未读水位以防止模型延迟期间漏消息，并将唤醒消息统一为角色名称。

**持久化自定义提供商模型列表，修复归零停滞（#7，ADR-0010）。** 此前自定义端点的模型列表仅保存在内存中：进程重启、编辑提供商或上游偶发返回空列表都会导致可选模型归零，使角色陷入激活失败和定时器耗尽的死锁。现在模型列表作为“已知模型列表”（Known Model List）持久化存储在 SQLite 中。注册表自行拉取 `/models`（无论有无 API Key 均可刷新，无缝支持 LM Studio、vLLM 等本地无 Key 端点），成功获取非空列表时写回数据库，并在服务启动时后台异步重新拉取；空响应或请求失败绝不清空已存模型，同时将错误原因与同步时间记录在卡片上。Web 端新增了自定义端点就地编辑入口。

**上下文中仅保留最新一份动作菜单（#6，ADR-0009）。** 世界事件与动作结果末尾附带的“接下来可用的动作”菜单此前会持续累积在推演上下文中直至归纳压缩，每步消耗约 150–250 Token。现在每次调用 LLM 前均会自动剔除历史消息中的过期菜单，并在运行结束落库时同步裁剪，确保发给模型和估算归档阈值的上下文中仅有一份最新菜单。

**“等待消息”锚定未读水位（#5）。** 此前 `wait_messages` 的等待窗口始于工具执行时的 `Date.now()`，容易漏掉上一步与模型思考延迟期间到达的消息。现在等待窗口锚定到角色未读的最早消息时间戳，已满足数量的等待会立刻唤醒，投递的等待摘要也会准确将对应消息标记为已读。

**唤醒消息改用角色名称（#8）。** 启动与唤醒消息从“你醒来了”/“你被唤醒了”改为 `${name}醒来了` 与 `${name}被唤醒了`，与系统提示词和推演 Agent 的导演角色定位保持一致。

**升级须知。** 从 RC.8 升级会完整保留数据库、WebUI 密码、角色设定、模型及账号配置；安装脚本会在升级前自动执行 SQLite 备份。表结构更新为无损增量（通过轻量迁移向 `custom_providers` 表添加可空的 `last_refresh_at` 与 `last_refresh_error` 列）。
