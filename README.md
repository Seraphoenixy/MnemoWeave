# MnemoWeave

MnemoWeave 是独立的 AI Agent 记忆编排系统。正式记忆正文、原生实体关系与检索由 Mnemon 提供；MnemoWeave 负责候选审核、可靠写入、逻辑版本与冲突治理、多 Host 接入，以及 Bridge 本地副本与同步。

TypeScript Workspace Monorepo，模块化单体，原生部署。HTTP 承载 Application Core，默认 stdio MCP 代理到唯一 Server：提交候选 → 规则与语义审核 → 异常人工处理 → Transactional Outbox → 官方 Mnemon 0.2.13 CLI → 内容核对与正式回执。候选、审核与写入进度可跨进程重启恢复。

当前进度（2026-11-09）：

- 运行时记忆主链路已补齐：持久化 Pinned、会话工作上下文、任务投影、主动记录指引、事件提炼候选与审核边界。
- 正式写入、Revision/冲突、授权 Recall、按范围同步和共享多 Host Bridge 有程序化验证；未把接口存在或测试数量当成 Host 行为验收。
- 当前 Host 目标为 DSH、ChatGPT 桌面、ZCode。ZCode 与 ChatGPT 本地钩子进程端到端可运行；真实桌面会话、DSH SDK 接入尚未验收，首版未完成。Codex CLI 仅保留历史代码。
- 详细结果、已知限制和后续工作见 `docs/implementation/current-handoff.md`，运行时设计见 `docs/implementation/runtime-memory.md`。

文档入口：

- 实现规格与交接：`docs/implementation/README.md`，当前状态见 `docs/implementation/current-handoff.md`。
- 架构基线：`docs/architecture/overview.md`；ADR：`docs/adr/README.md`。
- Provider 核查：`docs/research/mnemon-capability-matrix.md`；参考项目评估：`docs/research/dsh-mnemon-architecture-analysis.md`。

## 本机运行

前提：Node.js 24、pnpm 11.18.0、Mnemon 0.2.13。本机已验证的二进制位于 `work/tools/mnemon/mnemon.exe`，下载来源和 SHA256 见能力矩阵。`work` 是忽略目录，不随 Git 提交；换机需要重新从官方 release 获取并校验。

在 PowerShell 中：

```powershell
Set-Location D:\projects\MnemoWeave
pnpm.cmd install --frozen-lockfile
pnpm.cmd typecheck
pnpm.cmd build
pnpm.cmd test
pnpm.cmd test:e2e

$env:MNEMON_BINARY='D:\projects\MnemoWeave\work\tools\mnemon\mnemon.exe'
$env:MNEMON_DATA_DIR='D:\projects\MnemoWeave\work\dev-memory'
$env:MNEMON_STORE='development'
$env:MNEMOWEAVE_STATE_DIR='D:\projects\MnemoWeave\work\dev-state'
$env:MNEMOWEAVE_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:MNEMOWEAVE_OPERATOR_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
node apps/server/src/main.ts
```

默认仅监听 `127.0.0.1:4317`，所有 HTTP 请求要求 `Authorization: Bearer <MNEMOWEAVE_TOKEN>`。

- `GET /health/live`、`GET /health/ready`、`GET /v1/storage`、`GET /openapi.json`
- `POST /v1/recall`、`POST /v1/view`、`POST /v1/remember`
- `GET /v1/candidates/{id}`、`GET /v1/memories/{memoryId}?revisionId=`、`GET /v1/conflicts/{caseId}`
- operator：`POST /v1/review`、`POST /v1/retry`、`POST /v1/conflicts/resolve`、`POST /v1/versions/cancel`
- 同步：`GET /v1/sync/{changes,snapshot,verify,watermark,grant}`、`POST /v1/sync/{grant,revoke,intents}`；Host 身份由配对授权确定，不接受请求体自报。

未配置候选存储时 `POST /v1/remember` 返回 409 `REVIEW_REQUIRED`。`/openapi.json` 与实际路由逐条对应，包含冲突读取、冲突裁定、版本取消与同步端点。

MCP 使用同样的 `MNEMON_BINARY` / `MNEMON_DATA_DIR` / `MNEMON_STORE` 环境变量，启动 `node apps/server/src/mcp-main.ts`；工具为 `recall`、`provider_health`，启用候选后另有 `read_memory`、`remember`、`candidate_status`、`read_conflict`。stdio 继承启动者权限，不作为远端服务。日志仅 stderr；stdout 留给 MCP。

## 候选记忆提交

`MNEMOWEAVE_STATE_DIR` 保存 MnemoWeave 自有治理数据，与 Mnemon 存储分离；HTTP 与 MCP 使用同一目录即可共享候选。

- HTTP：`POST /v1/remember` 返回 202 和 `pending_review` 候选、提交回执；`GET /v1/candidates/{candidateId}` 查询。
- MCP：`remember` 只提交候选，正式写入由审核后的后台流程执行。
- 重复 `idempotencyKey` 且相同输入返回原候选/回执；同键不同输入返回 `IDEMPOTENCY_CONFLICT`。
- 候选内容不可变；改动内容需另建候选。
- 按 ADR-015 自动审核为主、异常转人工；没有配置模型或模型失败也转人工，不默认通过。不能用 `approved` 字段绕过。

请求示例（完整 Schema 见 `/openapi.json`）：

```json
{
  "idempotencyKey": "project-fact-0001",
  "content": "示例候选知识，需要审核后才能进入正式记忆。",
  "knowledgeType": "Practice",
  "scope": "project",
  "projectId": "registered-project-id",
  "tags": ["example"],
  "provenance": {
    "source": "working-model",
    "sourceReference": "session:example",
    "evidence": ["待审核的来源说明"],
    "verificationStatus": "unverified",
    "confidence": 0.5,
    "applicability": "示例项目",
    "limitations": "尚未验证，不应作为正式结论",
    "lastVerified": null
  }
}
```

## 审核、版本与冲突

后台 Worker 默认随 Server/MCP 进程启动；多个进程共享同一治理库时，通过 SQLite 租约串行调度。`MNEMOWEAVE_WORKER=off` 只用于诊断/候选暂存。

自动审核的模型由 Model Gateway 显式配置，不从 Provider 或其他客户端寻找模型。设置完整 Chat Completions URL（例如本地兼容服务的 `http://127.0.0.1:端口/v1/chat/completions`）、`MNEMOWEAVE_MODEL`，以及需要时的 `MNEMOWEAVE_MODEL_KEY`。非本地端点要求 HTTPS；不配置则所有非明显重复候选进入人工审核。可另配 `MNEMOWEAVE_BACKUP_MODEL_*` 作为备用路由，仅在 temporary/unavailable/timeout 时最多切换一次。

六项语义检查必须明确完成；低复用价值可拒绝。未验证证据、任何不确定性、重要架构知识、Global 晋升或冲突均转人工。内容相同但来源/适用范围不同或未知时保留候选并转人工。

人工例外处理只通过 HTTP，使用独立 `MNEMOWEAVE_OPERATOR_TOKEN`，不得放进模型 Host/MCP 环境，也不得与普通令牌相同。两个令牌仅保护本地开发接口，不能替代最终 Bridge/Host 身份体系。

- `POST /v1/review`：`{"candidateId":"…","decision":"approve","reason":"…"}`。decision 可为 approve/reject/amend；amend 需提供完整 replacement（新的 Remember 请求及幂等键）。
- `POST /v1/retry`：仅处理 `failed` 候选，保留稳定 writeKey；执行前再次对账 Provider。
- 带 `change` 意图的候选（revise/supersede/coexist/conflict）不进入自动批准，必须人工确认。
- `POST /v1/conflicts/resolve`：keep_existing / revise / supersede / coexist / unverified；coexist 必须提供适用范围不同的 replacement。
- `POST /v1/versions/cancel`：取消未发布版本操作；仅在不可逆关系投影前受理。取消回执标记 `uncertain=true`，不表示 Provider 回滚。

只有 `status=persisted` 且存在正式成功回执才表示已核对 Provider 写入；`approved` 仅表示排队。内部状态 `pending_review` 对应 ADR 的 Pending；`needs_review` 表示等待人工。

写入前可确定的故障最多尝试三次，退避按指数增长并封顶 15 分钟；已发起写入后结果未知时只对账，不盲目重发。没有明确结果时保留 `failed` 供人工处理；同一任务持续失败 24 小时后告警一次，不自动放弃。写入进程设置 `MNEMON_MAX_INSIGHTS=0`，关闭其自动容量清理；外部原生客户端仍可能更改同一 Store，因此请使用本项目专用 Store。

## 治理库升级与恢复

治理库当前 schema v8，启动时按顺序迁移（v1→v8）；每个版本迁移前用 `VACUUM INTO` 产生 `<governance.db>.pre-vN.<uuid>.db` 一致快照，包含 WAL 中已提交数据。迁移是 SQLite 事务，失败可重试；未识别的既有库拒绝初始化。

需要回退时：停止全部 Server/MCP/Worker，保留原库，将选定快照复制到**新的状态目录**并命名为 `governance.db`，再把 `MNEMOWEAVE_STATE_DIR` 指向新目录。快照只恢复治理数据，不能当作 Provider 回滚或通用备份。

v2→v3 回填缺陷已修复（迁移在 `catalog_relations` 尚未创建时不执行歧义检查），并有 contract 用例覆盖；升级仍应先在隔离状态目录演练。详见 `docs/implementation/current-handoff.md`。

## 测试与边界

- Unit / Contract：输入、候选审核边界、参数隔离、固定版本、错误 JSON、输出上限、超时、失败后队列恢复、重复 ID 映射、迁移与备份、租约 fencing、版本与冲突不变量、同步、保留清扫调度、View 交付、Bridge 会话注入与离线组装、容量配额、时间型复核、Blob 存储与回收、交互优先调度。当前 119 项全部通过。
- E2E：真实官方二进制，专用 `work/e2e` 随机目录与 acceptance store；不接触个人 Mnemon 默认目录。包含 Provider 写入、HTTP 与独立 MCP 子进程、重启与崩溃恢复。
- 不自动安装系统 Go、不修改系统 PATH，不需要 Docker；上游 Go 测试不作为验收前提。
- 新增能力先补契约与失败场景，再补成功路径；不能把未执行或失败的检查写成通过。
- Provider 版本未知时明确拒绝；升级先核查并重跑验收，不静默放宽版本。

当前包内 imports 使用显式源码路径；各包声明依赖以记录边界，独立发布和包 exports 在后续构建设计中完善，不宣称已完成独立发布。

## 运行时记忆配对

Server 的 `MNEMOWEAVE_TOKEN` 为 master，只留在 Server。使用独立 operator token 调用 `POST /v1/sync/grant`，显式指定 `hostId`、`projects`（可用 `*` 表示全部项目）和 `globalIncluded`；响应中的 `credential` 作为该 Host 的 `MNEMOWEAVE_TOKEN`，请求携带 `x-mnemoweave-host`。普通 Host 不能使用 master 读取记忆，也不能通过修改 Host header 借用另一身份。

项目 ID 必须显式登记（`POST /v1/runtime/projects`，或操作员签发具体项目 Grant）。用 `POST /v1/runtime/pins` 配置常驻正式记忆引用，再启动 Bridge/ZCode hook；详见 `docs/implementation/runtime-memory.md`。MCP 只需 Server URL、Host ID、Host credential，不需要 Mnemon 或治理库路径。不要将 operator token 传入 Host。

旧运行示例中的 `$env:MNEMOWEAVE_TOKEN` 是 Server 启动值；在启动 Host/MCP/Bridge 的进程环境里替换为其 credential。旧数据未记录 projectId 的，只允许明确获准全部项目的调用者读取。
