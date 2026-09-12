# MoonanBot

[English](README.md)

MoonanBot 是一个可对接多平台的 AI 聊天 Bot，致力于研究“真人感”，赋予你的虚拟角色生命。

> **v0.0.1 当前为候选版本。** 后端已经自动化测试，WebUI 等待用户亲测验收。完成角色、提供商和出站消息配置前，请保持 Bot 暂停。

## 主要能力

- `SimulationAgent` 根据人设、记忆、关系和外界事件推演单个角色的行为。
- `SynthesisAgent` 使用暂存、统一校验和事务提交，把经历归纳为有边界的长期记忆和关系资料。
- 初版通过平台适配层对接 OneBot v11 反向 WebSocket，后续可扩展其他平台。
- 中英双语、macOS 桌面风格 WebUI，以渐进式披露组织角色、Agents、连接、活动和设置。
- SQLite 是唯一权威数据源；启用 WAL、外键、持久化计时器、Prompt 版本与完整原始历史。

项目基于 [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) 和 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi)，均固定为 `0.85.1`。

## Ubuntu 26.04 x86_64 一键安装

以 root 运行：

```bash
curl -fsSL https://raw.githubusercontent.com/Pheobe-Southwood/MoonanBot/v0.0.1-rc.1/scripts/install.sh | bash
```

安装器会创建低权限 `moonanbot` 用户，将程序放在 `/opt/moonanbot`，数据放在 `/var/lib/moonanbot`，默认仅监听 `127.0.0.1:21314`，并只显示一次随机密码。服务启动后角色仍保持暂停。

远程访问建议使用 SSH 隧道：

```bash
ssh -L 21314:127.0.0.1:21314 你的服务器
```

随后打开 <http://127.0.0.1:21314>。

## 本地开发

需要 Node.js `>=22.19.0` 与 pnpm `11.7.0`：

```bash
pnpm install
pnpm check
pnpm dev
```

首次启动会输出随机 WebUI 密码。默认数据目录为 `~/.moonanbot`，可以用 `MOONANBOT_DATA_DIR` 修改。

```bash
moonanbot reset-password
moonanbot backup /安全路径/moonanbot.sqlite
moonanbot status
```

完整 SQLite 备份包含明文提供商凭据；WebUI 角色包不会包含密钥、消息或运行历史。

## OneBot

让 OneBot 实现反向连接：

```text
ws://127.0.0.1:21314/onebot/v11/ws
```

连接需提供 `X-Self-ID`、`X-Client-Role: event|api|universal`，以及配置的 `Bearer` 或 `Token`。v0.0.1 只接受一个 OneBot 账号。详见 [OneBot 配置](docs/onebot.md)。

## 文档

- [架构](docs/architecture.md)
- [OneBot v11 配置](docs/onebot.md)
- [提供商与 OAuth](docs/providers.md)
- [运维、备份和 SSH 访问](docs/operations.md)
- [安全模型与限制](docs/security.md)
- [工程初评协议](docs/evaluation.md)
- [领域语言](CONTEXT.md)与[架构决策](docs/adr)

## 初版边界

初版仅支持单角色、单本地用户、单 OneBot 账号和纯文本发送。收到的媒体只转为文字占位，不下载、不理解。本项目不宣称科学验证、真人复现能力或适合无人值守公网部署。

## 许可证

MoonanBot 使用 [GNU Affero General Public License v3.0 or later](LICENSE)。
