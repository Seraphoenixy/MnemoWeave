# MnemoWeave

MnemoWeave 提供本机记忆。Codex、ZCode 和 DeepSeek Harness 共享一份本机工作准则。Codex 和 ZCode 通过 stdio MCP 访问。DeepSeek Harness 通过 `dsh-mnemo-weave` 插件使用分层记忆与工作台，最低支持 DSH `0.2.2-rc.1`。

项目基于 dsh-mnemon 0.5.46，随个人使用需求迭代。上游更新按实际价值和兼容性评估后选取。 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)

## 构建

需要 Node.js 24.9 或更高版本及 pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm build
```

## 文档

- [安装与使用](docs/usage.md) — Codex、ZCode 和 DSH 的接入、验收与热重载。
- [DSH 工作台](docs/dsh-workbench.md) · [运维、Provider 与技能](docs/dsh-operations.md) — 用法、备份、同步与故障排查。
- [架构与契约](docs/architecture.md) — 记忆系统设计、存储模型和 MCP 工具。
- [记忆活动记录与同步](docs/memory-activity.md) — 写入、召回与子 Agent 的活动证据。
- [DSH 配置](docs/dsh-configuration.md) · [接口与工作流](docs/dsh-interfaces.md) — 配置项、工具、RPC 和执行流程。
- [开发与验证](docs/development.md) · [扩展设计](docs/extensions.md) — 验证夹具、扩展 SDK 和兼容边界。

源代码按 [MIT 许可证](LICENSE) 提供。第三方组件见 [第三方声明](THIRD_PARTY_NOTICES.md)。
