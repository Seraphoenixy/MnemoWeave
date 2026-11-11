# MnemoWeave

MnemoWeave 是独立的 AI Agent 记忆编排系统。正式记忆正文、原生实体关系与检索由 Mnemon 提供；MnemoWeave 负责候选审核、可靠写入、逻辑版本与冲突治理、多 Host 接入。

架构是**三台开发机各一个本机 Server + 本机 Mnemon，另有一台远端同步 Server**：每台机器上的宿主插件内含共享客户端库（`packages/client`），直接用服务令牌访问本机 Server，并用 `x-mnemoweave-host` 头标识自己；共享写入由远端确认版本，注入与召回走本机。没有本地 Bridge 或代理进程，同步凭据只在本机 Server 环境里。协议见 [docs/sync.md](docs/sync.md)；同步已接通（契约、远端存储与 HTTP 服务、本机账本与应用流水线、准则/档案/编辑的远端确认），未配置 `MNEMOWEAVE_SYNC_*` 时退化为纯本机直连。

TypeScript Workspace Monorepo，模块化单体，原生部署（不使用 Docker）。HTTP 承载 Application Core，stdio MCP 也代理到同一 Server：提交候选 → 规则与语义审核 → 异常人工处理 → Transactional Outbox → 官方 Mnemon 0.2.13 CLI → 内容核对与正式回执。候选、审核与写入进度可跨进程重启恢复。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 系统组成、包边界、数据所有权、部署、安全、已固定的设计决策 |
| [docs/implementation.md](docs/implementation.md) | HTTP/MCP/Provider 契约、治理库 schema v14、状态机、配置项 |
| [docs/sync.md](docs/sync.md) | 三机同步：条目模型、版本与变更规则、端点、故障恢复（已实现；未完成项见 `docs/status.md`） |
| [docs/dsh-ui.md](docs/dsh-ui.md) | DSH 记忆界面（可查看与编辑） |
| [docs/host-acceptance.md](docs/host-acceptance.md) | ZCode / ChatGPT / DSH 接入与验收 |
| [docs/status.md](docs/status.md) | 最近一次验证结果、未验收项、未决事项、下一步 |

## 本机运行

前提：Node.js 24、pnpm 11.18.0、Mnemon 0.2.13。`MNEMON_BINARY` 可省略：默认先找 `work/tools/mnemon/mnemon.exe`，再找 npm 全局包内的 `mnemon.exe`，最后才用 PATH 上的 `mnemon`；Windows 上 PATH 里的 `mnemon` 是 `.cmd` 包装，`execFile` 无法直接启动，因此 E2E 优先使用原生可执行文件。`work/` 为忽略目录，不随 Git 提交。

```powershell
Set-Location D:/project/MnemoWeave
pnpm.cmd install --frozen-lockfile   # 依赖装在项目内 work/pnpm-store（见根 .npmrc）
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc
node --test tests/unit/*.test.ts tests/contract/*.test.ts
node --test --test-concurrency=1 tests/e2e/*.test.ts   # 需要可用的 Mnemon CLI；必须串行

$env:MNEMON_DATA_DIR='D:/project/MnemoWeave/work/dev-memory'
$env:MNEMON_STORE='development'
$env:MNEMOWEAVE_STATE_DIR='D:/project/MnemoWeave/work/dev-state'
$env:MNEMOWEAVE_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:MNEMOWEAVE_OPERATOR_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
node apps/server/src/main.ts
```

默认仅监听 `127.0.0.1:4317`，除 `/health/live` 外所有 HTTP 请求要求 `Authorization: Bearer <MNEMOWEAVE_TOKEN>`。

- 读：`POST /v1/recall`、`POST /v1/view`、`GET /v1/memories`、`GET /v1/memories/{memoryId}`、`GET /v1/candidates/{id}`、`GET /v1/conflicts/{caseId}`、`GET /v1/storage`、`GET /v1/reviews/due`、`GET /openapi.json`
- 宿主：`POST /v1/inject`、`POST /v1/events`、`POST /v1/session/close`、`POST /v1/runtime/context`
- 写：`POST /v1/remember`（只提交候选）、`PATCH /v1/memories/{memoryId}`（用户直接编辑，追加 Revision）
- operator：`POST /v1/review`、`/v1/retry`、`/v1/conflicts/resolve`、`/v1/versions/cancel`、`/v1/reviews/complete`、`/v1/runtime/pins`、`/v1/runtime/projects`

完整端点表见 [docs/implementation.md](docs/implementation.md#2-http-端点)。

## 宿主客户端

三个插件共用 `packages/client`：

```ts
import { MemoryClient, clientFromEnv, renderView } from './packages/client/src/index.ts';

const client = clientFromEnv();                       // MNEMOWEAVE_SERVER / MNEMOWEAVE_TOKEN / MNEMOWEAVE_HOST_ID
const view = await client.inject({ sessionId, query }, 2_000);
const list = await client.listMemories({ limit: 50 });
await client.editMemory(memoryId, { content: '修正后的正文', reason: '用户更正' });
```

客户端强制 loopback URL、令牌至少 24 字符、注入超时默认 2 秒；网络失败返回 `{ ok: false, error }`，不抛异常给宿主回合。

## MCP

`node apps/server/src/mcp-main.ts`，stdio，服务名 `mnemoweave`。默认代理到唯一 Server（`MNEMOWEAVE_SERVER`，默认 `http://127.0.0.1:4317`）；`MNEMOWEAVE_MCP_MODE=standalone` 时进程内直连并关闭 Worker。

工具：`recall`、`provider_health`；启用候选存储后另有 `remember`、`candidate_status`、`read_memory`、`read_conflict`；配置运行时后另有 `runtime_context`、`memory_view`。MCP 不提供审核/重试工具，也不接受模型自报 `sessionId`。日志只写 stderr，stdout 留给 MCP。

## 候选、审核与写入

`MNEMOWEAVE_STATE_DIR` 保存 MnemoWeave 自有治理数据，与 Mnemon 存储分离；HTTP 与 MCP 使用同一目录即可共享候选。

- 重复 `idempotencyKey` 且输入相同返回原候选与回执；同键不同输入返回 `IDEMPOTENCY_CONFLICT`。候选内容不可变，改动需另建候选。
- 自动审核以规则为主、模型为辅；未配置模型、模型失败、证据未验证、重要架构知识、Global 晋升、带变更意图或存在冲突时一律转人工。不能用 `approved` 字段绕过。
- 后台 Worker 默认随 Server 进程启动；多进程共享同一治理库时靠 SQLite 租约串行调度。`MNEMOWEAVE_WORKER=off` 仅用于诊断。
- 模型由 Model Gateway 显式配置（`MNEMOWEAVE_MODEL_URL` / `_MODEL` / `_MODEL_KEY`），非本地端点必须 HTTPS；`MNEMOWEAVE_BACKUP_MODEL_*` 仅在 temporary/unavailable/timeout 时最多切换一次。
- 人工管理入口（审核、准则、档案、同步诊断）只走 HTTP，使用独立 `MNEMOWEAVE_OPERATOR_TOKEN`，不得与普通令牌相同，也不得进入 Host 环境。**记忆的编辑与撤回不在此列**：个人项目，只要求服务令牌 + `x-mnemoweave-host`，并记录为 `local-user` 审核决定（可归因到宿主，不证明人在场）。
- 只有 `persisted` 且有正式成功回执才表示 Provider 写入已核对；`approved` 只表示排队。写入前可确定的故障最多三次退避重试（指数增长，封顶 15 分钟）；已发起写入后结果未知时只对账，不盲目重发。
- 写入进程固定 `MNEMON_MAX_INSIGHTS=0` 关闭 Mnemon 自动容量清理；请使用本项目专用 Store，外部原生客户端仍可能改动同一 Store。

**用户直接编辑**（`PATCH /v1/memories/{memoryId}`）不经过候选审核：它在 Mnemon 写入新生正文、以 supersedes 关联旧记忆、追加一个不可变 Revision 并移动当前指针，同时把这次改动记录为 `local-user` 的审核决定。它与"模型输出只能成为候选"的规则不冲突——模型没有这个入口。

## 治理库升级与恢复

治理库当前 schema **v14**，启动时按顺序迁移（v1→v14）；每步迁移前用 `VACUUM INTO` 生成 `<governance.db>.pre-vN.<uuid>.db` 一致快照（含 WAL 中已提交数据），迁移本身在事务内提交。未识别的既有库拒绝初始化。

回退方式：停止全部 Server/MCP/Worker → 保留原库 → 将选定快照复制到**新的**状态目录并命名 `governance.db` → 把 `MNEMOWEAVE_STATE_DIR` 指向新目录。快照只恢复治理数据，不能当作 Provider 回滚或通用备份。升级前应先在隔离状态目录演练。

## 插件

`plugins/` 下有 ZCode、ChatGPT 桌面与 DSH 三个宿主插件，构建后输出到 `dist/plugins/`，说明见 [plugins/README.md](plugins/README.md)。DSH 界面见 [docs/dsh-ui.md](docs/dsh-ui.md)。

## 边界

- Provider 版本未知时明确拒绝，不静默放宽版本；升级前先核查并重跑验收。
- 不直接读写 Mnemon 内部表；不修改系统 PATH、不安装系统 Go、不依赖 Docker。
- 各包 imports 使用显式源码路径；`package.json` 的依赖声明用于记录边界，尚未完成独立发布与 `exports` 设计。
- 同步与三类记忆（运行时准则、项目档案、正式记忆）已实现并有测试覆盖；未完成事项（三宿主实机注入核对、Host 真实会话验收）以 `docs/status.md` 为准。
- 新增能力先补契约与失败场景，再补成功路径；未执行或失败的检查不得写成通过。
