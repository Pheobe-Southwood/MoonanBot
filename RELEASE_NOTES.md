# MoonanBot v0.0.1-rc.1

This first release candidate delivers the complete v0.0.1 backend and a user-testable WebUI. It starts paused and binds to `127.0.0.1:21314` by default. Configure a character, provider/model pair for both agents, and OneBot before starting it.

The release supports one character, one operator, one OneBot account, and text sending. Incoming media is represented only as text placeholders. Provider credentials are plaintext inside the protected SQLite database; full backups must be treated as secrets.

The automated backend suite and live DeepSeek report are included in the repository. Browser acceptance remains the purpose of this RC; report visual or workflow issues before the final `v0.0.1` release.

---

这是 MoonanBot v0.0.1 的第一个候选版本，包含完整初版后端和可供亲测的 WebUI。默认保持暂停，只监听 `127.0.0.1:21314`。请先完成角色、两个 Agent 的模型以及 OneBot 配置，再启动 Bot。

初版支持单角色、单操作者、单 OneBot 账号和纯文本发送；媒体仅转为文字占位。提供商凭据以明文保存在受权限保护的 SQLite 中，完整备份必须按密钥保管。

仓库包含自动化后端测试与 DeepSeek 实测报告。本 RC 的下一步是 WebUI 人工验收；正式 `v0.0.1` 会在反馈修正并确认后发布。
