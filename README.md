# MnemoWeave

MnemoWeave（包名 `dsh-mnemo-weave`）为本机及多设备环境提供可组合记忆系统，支持三类宿主与一个独立同步服务：

- **Codex / Antigravity**：通过 stdio MCP 入口 `dist/mnemo-weave-mcp.js` 访问共享工作准则、工作区档案与记忆空间；仓库内另提供 [Antigravity 插件包](integrations/antigravity/plugin.json) 与安装脚本 `pnpm antigravity:install`。
- **DeepSeek Harness（DSH）**：通过插件 `dsh-mnemo-weave`（最低支持 `0.2.2-rc.1`）提供系统提示注入、记忆工具、后台整理、工作台 WebUI 与技能管理。
- **HTTP 同步服务**：通过 `dist/mnemo-weave-sync-server.js` 提供基于 SRP-6a（PAKE）与 SQLite 的增量快照和活动记录同步。

项目基于 `dsh-mnemon` 0.5.46，随个人使用需求迭代。上游更新按功能价值、数据兼容性与宿主影响评估后选取。[dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)

## 组成模块

| 模块 | 标识 / 入口 | 职责 |
|---|---|---|
| 核心与宿主 | `dsh-mnemo-weave`、`./core`、`./contracts`、`./extension-sdk` | View 编译、运行代与租约管理、DSH 生命周期与 RPC |
| 运行时记忆 Source | `dsh-mnemo-weave/source-runtime` | 共享工作准则、`runtime/memories.json`、分支筛选与容量控制 |
| 工作区档案 Source | `dsh-mnemo-weave/source-documents` | 托管 Markdown 档案、`documents/index.json`、全文搜索与冷归档 |
| 记忆空间 Source | `dsh-mnemo-weave/source-memory-spaces` | 记忆空间目录、召回质量策略、图谱与 Provider 托管 |
| 技能管理 Source | `dsh-mnemo-weave/source-skills` | DSH `SKILL.md` 版本、进化账本、评测用例与市场来源 |
| 主动记录增强 | `dsh-mnemo-weave/strategy-auto-capture` | 向分层策略的 `capture` 槽提供对话内记录指引（默认停用） |
| 原生记忆 Provider | `dsh-mnemo-weave/provider/mnemon-native` | 封装本地 `mnemon` CLI 与 `mnemon.db` |
| stdio MCP 服务 | `dist/mnemo-weave-mcp.js` | 向 Codex 与 Antigravity 暴露 `mnemo_working_rules` 与 13 个记忆工具 |
| Antigravity 插件 | `integrations/antigravity/` | 打包 MCP 配置、常驻规则 `AGENTS.md` 与 `mnemo-weave` 技能 |
| HTTP 同步服务 | `dist/mnemo-weave-sync-server.js` | 独立 Node.js 服务，管理 SRP-6a 认证、变更游标与内容寻址文件块 |

## 构建与验证

构建需要 Node.js 24.9 或更高版本及 pnpm（`package.json` 声明 `engines.node >= 20`，仓库开发与同步服务运行以 Node.js 24.9+ 为准）。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm -r build
```

执行完整验证链（文档链接、类型检查、单元测试、可复现构建、Headless DSH 启停、同步集成与包结构检查）：

```powershell
pnpm verify
```

## 文档

- [安装与使用](docs/usage.md) — Codex、Antigravity 与 DSH 的接入配置、CLI 参数、环境变量、本地热重载与故障排查。
- [工具与命令参考](docs/tools.md) — 14 个 `mnemo_*` 模型工具、内部回执工具 `mnemo_subagent_result` 与 `/mnemon` 命令的参数、权限与返回值。
- [架构与契约](docs/architecture.md) — 可组合视图记忆架构、组件边界、存储模型与安全边界。
- [生命周期与核心流程](docs/workflows.md) — 每轮上下文与 Wake、召回预算信封、容量压缩与归档、空闲审查流程。
- [DSH 工作台](docs/workbench.md) — 工作台页面、对话交互控件、记忆组合与设置位置。
- [DSH 配置参考](docs/configuration.md) — `cordis.patch.yml` 配置项、默认值、范围、模型路由、存储范围与技能设置。
- [DSH 接口与 RPC](docs/interfaces.md) — UI 入口、Profile 能力面、工作区路由与 RPC 通道。
- [DSH 运维与 Provider](docs/operations.md) — 健康检查、ZIP 备份导入导出、云端 WebUI、故障排查与 Mnemon Native Provider。
- [服务器同步与部署](docs/sync.md) — Linux 同步服务部署、SRP-6a 认证、HTTP 端点、增量文件块同步与合并规则。
- [技能管理](docs/skills.md) — 技能标签页、自进化工作流、可选自动采纳、评测与市场来源。
- [记忆活动记录与同步](docs/memory-activity.md) — 结构化读写与子 Agent 活动的采集边界、本地存储与同步机制。
- [扩展设计与依赖契约](docs/extensions.md) — Source、Strategy、Provider 与 Client 扩展 SDK 及独立仓库测试夹具。
- [开发与验证](docs/development.md) — 目录归属、验证脚本、Headless/Web 隔离测试方法。

源代码按 [MIT 许可证](LICENSE) 提供。第三方组件声明见 [第三方声明](THIRD_PARTY_NOTICES.md)。
