# 契约目录

状态：本目录描述 MnemoWeave 自有契约。HTTP/MCP 字段以 `packages/core/contracts/src/index.ts` 的 Zod Schema 为准；字段级重复只用于阅读，出现分歧以 Schema 与测试为准并应立即修正文档。

## 1. 通用规则

- 所有输入使用 `.strict()`：未知字段拒绝，返回 `INVALID_INPUT`。
- 契约版本：当前 `0.1.0`，未实现版本协商；Provider 版本单独固定为 `0.2.13`。
- 请求体上限 256,000 字节；非 `application/json` 请求拒绝。
- 带 `Origin` 头的请求一律拒绝；当前只服务本机非浏览器客户端。
- 响应 JSON 不回传 stderr、路径、凭据或原始记忆内容（读取接口按 Schema 返回正文）。
- 日志只写 stderr；stdout 保留给 MCP。

## 2. 错误模型

| 错误码 | 语义 | HTTP 状态 |
|---|---|---|
| `INVALID_INPUT` | Schema 校验失败、额外观测字段、非法参数 | 400 |
| `UNAUTHORIZED` | 令牌缺失/不匹配、Origin 头、operator 路由使用普通令牌 | 401 |
| `NOT_FOUND` | 候选、记忆、Revision、冲突案件不存在 | 404 |
| `REVIEW_REQUIRED` | 未配置候选存储、需要审核、能力不足 | 409 |
| `IDEMPOTENCY_CONFLICT` | 同幂等键不同输入 | 409 |
| `INVALID_STATE` | 当前状态不允许该操作、CAS 或占用冲突、fencing 失败 | 409 |
| `VIEW_BUDGET_EXCEEDED` | 关键 Pinned 超出注入预算，拒绝交付残缺 View | 409 |
| `QUOTA_EXCEEDED` | 治理库达到硬配额，拒绝新候选增长 | 409 |
| `PROVIDER_UNAVAILABLE` | 进程启动失败、CLI 非零退出 | 503 |
| `PROVIDER_TIMEOUT` | 子进程超时 | 503 |
| `PROVIDER_PROTOCOL` | JSON 结构不符、内容查找歧义 | 503 |
| `PROVIDER_INTEGRITY` | ID 或内容哈希与记录不符 | 503 |
| `UNSUPPORTED_VERSION` | CLI 版本不是 0.2.13 | 503 |
| `INTERNAL` | 未分类异常 | 503 |

未知错误一律映射为 `INTERNAL`，不返回异常消息。MCP 失败以 `isError: true` 返回同样的 `{code}` JSON。

## 3. HTTP 接口

鉴权：`Authorization: Bearer <MNEMOWEAVE_TOKEN>`；operator 路由必须使用独立的 `MNEMOWEAVE_OPERATOR_TOKEN`，两个令牌不得相同，长度至少 24。

| 方法 | 路径 | 请求 | 成功响应 | 说明 |
|---|---|---|---|---|
| GET | `/health/live` | — | `{live:true}` | 进程存活 |
| GET | `/health/ready` | — | ProviderHealth | 依赖就绪；失败返回错误 |
| GET | `/openapi.json` | — | OpenAPI 3.1 文档 | 与实际路由逐条对应，见 `tests/contract/openapi.test.ts` |
| GET | `/v1/storage` | — | StorageStatus | 容量状态（ok/soft/hard）与用量 |
| GET | `/v1/reviews/due` | — | ReviewDueOutput | operator；到期复核队列 |
| POST | `/v1/reviews/complete` | ReviewCompleteInput | ReviewDueItem | operator；记录复核并从当时重排 |
| GET | `/v1/candidates/{candidateId}` | UUID 路径 | Candidate | 生命周期、审核、写入任务、回执 |
| GET | `/v1/memories/{memoryId}` | 可选 `?revisionId=` | PublishedMemoryOutput | 从 Provider 读取并校验哈希 |
| GET | `/v1/conflicts/{caseId}` | UUID 路径 | ConflictDescriptor | 案件、双方证据引用、裁定记录 |
| POST | `/v1/recall` | RecallInput | RecallOutput | 默认有效集合过滤 |
| POST | `/v1/view` | ViewRequest + `x-mnemoweave-host` | View | 配对 Host；交付不可变 View，检查授权/撤销/预算 |
| POST | `/v1/remember` | RememberInput | 202 Candidate | 只创建候选，不写正式记忆 |
| POST | `/v1/review` | HumanReviewInput | Candidate | operator；approve/reject/amend |
| POST | `/v1/retry` | RetryInput | 202 Candidate | operator；仅 failed 候选 |
| POST | `/v1/conflicts/resolve` | ConflictResolutionInput | Candidate | operator；五种裁定 |
| POST | `/v1/versions/cancel` | RetryInput 形状 | Candidate | operator；取消未发布版本操作 |

同步传输（`/v1/sync/*`）是 Bridge 专用通道：GET 与 `intents` 使用服务令牌，且 `x-mnemoweave-host` 必须对应已配对授权；`POST /v1/sync/grant`、`POST /v1/sync/revoke` 只接受 operator 令牌。Host 身份取自通道头，不接受请求体自报。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/sync/changes?since=<seq>` | 有序增量窗口（≤200 条或 8 MiB）；返回 `changes`、`windowOldestSeq`、`latestSeq`；revision 正文按哈希核对，失败标 `contentPending` |
| GET | `/v1/sync/snapshot` | 返回 SQLite 快照字节，响应头 `x-sync-latest-seq`；清单存于文件内 `snapshot_meta` |
| GET | `/v1/sync/verify` | 按 memory 的分区摘要（memoryId、currentRevisionId、contentHashes） |
| GET | `/v1/sync/watermark` | `{watermark, revoked}`；撤权水位线与 Host 撤销状态 |
| GET | `/v1/sync/grant` | 当前配对授权；不存在返回 404 |
| POST | `/v1/sync/grant` | operator 签发 `{hostId, projects, globalIncluded, ttlMs?}`（AUTH-04） |
| POST | `/v1/sync/revoke` | operator 撤销 `{hostId, global?}`（AUTH-02） |
| POST | `/v1/sync/intents` | Host 提交 `{intentId, kind, payload, baselineRef?}`；返回 `accepted` 或 `isolated` |

Bridge 只读 UI 通道（本机、独立令牌 `MNEMOWEAVE_BRIDGE_UI_TOKEN`，≥24 字符且不得与 `MNEMOWEAVE_TOKEN` 相同；默认端口 4319，必须与注入端口不同）。只接受 GET；任何带 `Origin` 的请求返回 401，浏览器页面必须经 DSH 插件 Host 半访问；未设置 UI 令牌时该端口不监听。每条记录仍按 Host grant 过滤，未配对/撤权/过期/越权以显式状态与原因返回，不用空列表掩盖。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/ui/status` | 配对、grant（范围/到期/代次/撤权）、replica（游标/数据时间/条数/待补正文/是否过期）、意图计数 |
| GET | `/v1/ui/memories?query=&limit=&scope=&projectId=` | 当前版本列表；`query` 复用本地检索排序，`limit` 1–200，`scope`/`projectId` 只在已授权集合内收窄 |
| GET | `/v1/ui/memories/{memoryId}` | 单条正文（≤40,000 字符）、版本历史、关联 |
| GET | `/v1/ui/memories/{memoryId}/revisions/{revisionId}` | 指定历史版本正文（哈希校验后返回；缺失/未同步给显式原因） |
| GET | `/v1/ui/intents` | 最近 50 条离线意图（不含完整 payload） |

`/v1/remember` 在未配置 `MNEMOWEAVE_STATE_DIR` 时返回 409 `REVIEW_REQUIRED`；`/v1/recall` 与健康检查始终可用（只要 Provider 可用）。

## 4. 核心 Schema

### RecallInput / RecallOutput

| 字段 | 约束 |
|---|---|
| `query` | 非空，≤2000 字符，去首尾空白 |
| `limit` | 1–100，默认 10 |
| `memories[]` | `id`、`content`、可选 `score`、可选 `superseded` |
| `complete` | 可选；仅在启用发布目录过滤时出现：Provider 结果已穷尽（未因扩展窗口上限截断）为 true。默认 Recall 先过滤后分页：扩展窗口页宽 100、上限 1,000，直至填满请求 limit 或结果穷尽 |

### RememberInput

| 字段 | 约束 |
|---|---|
| `idempotencyKey` | `[A-Za-z0-9_-]{8,128}`，全局唯一 |
| `content` | 非空白，≤8000 UTF-8 字节 |
| `knowledgeType` | Concept / Practice / Architecture / Troubleshooting / Constraint / Procedure / Reference |
| `tags` | ≤20 个，每个 ≤100 字符 |
| `scope` | `project`（默认）或 `global` |
| `change` | 可选 ChangeIntent |
| `provenance` | 见下 |

Provenance：`source`、`sourceReference`、`evidence`（1–20 条）、`verificationStatus`（unverified/verified/disputed）、`confidence`（0–1）、`applicability`、`limitations`、`lastVerified`（ISO 时间或 null）。

ChangeIntent：`kind`（revise/supersede/coexist/conflict）、`targetMemoryId`、`expectedRevisionId`、`effectiveAt`、`reason`（≤4000）、`evidence`（1–20 条）。

### 审核与裁定

| Schema | 关键字段 |
|---|---|
| HumanReviewInput | `candidateId`、`decision`（approve/reject/amend）；仅 amend 需要完整 `replacement` |
| RetryInput | `candidateId`、`reason`、`confirmNoActiveWrite: true` |
| ConflictResolutionInput | `caseId`、`decision`（keep_existing/revise/supersede/coexist/unverified）、`reason`、`evidence`、可选 `replacement`；coexist 必须带 replacement |
| SemanticAssessment | 六项检查 source/accuracy/reuse/scope/duplication/consistency，每项 pass/fail/uncertain；`requiresHuman`、`conflict`、`summary` |

### View / ReadGrant / Rerank（WP4）

- `ReadGrant`：grantId、hostId、projects、globalIncluded、issuedAt、expiresAt、generation。撤权用 generation 水位线：低于水位线的授权不可用（AUTH-01 默认 1 小时）。
- `ViewRequest`：`query?`、`projectId?`、`pinned?`（`memoryId`、`tier=critical|normal`）、`rerank?`；严格校验；Host 身份取自 `x-mnemoweave-host`，不接受请求体自报。
- `View`：viewId、generation、createdAt、grantId、query、scopeNote、budget（limitTokens/usedTokens/estimator=utf8-bytes-3/estimated=true/envelopeReserveTokens）、memories[]（memoryId、revisionId、providerMemoryId、tier=pinned-critical/pinned-normal/dynamic、scope、applicability、content、excerpt、score?、sourceReference）、excluded[]（memoryId、reason=not_visible/superseded/budget/grant_scope）、complete、rerank（status=not_requested/applied/unavailable/failed、reason、route?）。交付后深度冻结；变更生成新 generation。
- Token 预算：默认 4,096（可配置），封装元数据预留 96；估算按 UTF-8 字节/3 保守估计并标记 estimated，不冒称精确 Token。关键 Pinned 超限抛 `VIEW_BUDGET_EXCEEDED`；普通 Pinned 转可追溯摘要；动态内容按剩余预算填入并标记 complete=false。
- Rerank（RECALL-02）：显式请求或分数差 <0.05 的歧义规则触发（规则版本 score-gap-0.05-v1）；输出只能是输入集合的排列，未知/重复/遗漏即 failed 并保留确定性顺序；未配置为 unavailable。RerankOutput.generation 绑定请求代际，迟到结果不得回写旧 View。

### 同步传输 Schema（WP6）

- `SyncChange`：`seq`、`op`（memory/revision/relation/remove_tombstone/revoke_tombstone）、`entityId`、`payload`、`payloadHash`、`opAt`；revision 可带 `content` 或 `contentPending`。
- `SnapshotManifest`：`generation`（等于 latest seq）、`dataTime`、`latestSeq`、`tables{rows, sha256}`；清单写入快照文件 `snapshot_meta`。
- `PartitionSummary`：`memoryId`、`currentRevisionId`、`contentHashes[]`。
- `SyncIntent`：`intentId`、`kind`（remember/event/version_intent/relation_intent）、`payload`、可选 `baselineRef`；`event` 落 `session_events`，其余转候选，不直接发布。
- 配对凭据即 `ReadGrant`；`ttlMs` 默认 1 小时；撤权按 Host 或全局水位线生效。

### 状态枚举

- `StorageStatus`：`usedBytes`、`state`（ok/soft/hard）、可选 `softBytes`/`hardBytes`；按治理库与 WAL 计量，不含 Provider 存储。
- `ReviewDueItem`/`ReviewDueOutput`：`memoryId`、`knowledgeType`、`intervalDays`、`dueAt`、`lastReviewedAt`；`ReviewCompleteInput`：`memoryId`、`reason`。到期仅排队复核，不改变记忆状态。

- Candidate：`pending_review`、`needs_review`、`approved`、`rejected`、`persisting`、`persisted`、`failed`。
- WriteTask：`queued`、`running`、`succeeded`、`failed`、`cancelled`；checkpoint `ready`、`writing`、`retry`。
- ExecutionReceipt：`persisted`（providerMemoryId、providerAction、reconciled、contentHash）或 `failed`（code、uncertain）。
- 冲突案件：`open`、`resolving`、`resolved`、`unverified`。

## 5. 幂等与重试语义

- 同一 `idempotencyKey` 且规范化输入相同：返回既有候选与回执。
- 同一键、输入不同：`IDEMPOTENCY_CONFLICT`，不覆盖。
- 稳定写入键固定为 `candidate:<candidate UUID>`，写入 `--source mnemoweave:<writeKey>`；它是来源标记，不是 Provider 原生的 exactly-once。
- 人工 retry 只接受 `failed` 候选，保留原 Task 与写入键，改写 `checkpoint=retry` 后重新入队；执行前必须先对账 Provider。
- 网络超时、响应丢失、进程中断都不构成重发理由；只允许对账。

## 6. MCP 工具

stdio 传输，继承启动者权限。未配置候选存储时只注册前两个工具。

| 工具 | 输入 | 输出 | 是否 operator |
|---|---|---|---|
| `recall` | RecallInput | RecallOutput | 否 |
| `provider_health` | — | ProviderHealth | 否 |
| `read_memory` | memoryId + 可选 revisionId | PublishedMemoryOutput | 否 |
| `remember` | RememberInput | Candidate | 否 |
| `candidate_status` | candidateId | Candidate | 否 |
| `read_conflict` | caseId | ConflictDescriptor | 否 |

MCP 不提供 approve/reject/amend/retry/conflict-resolve/version-cancel；人工权限只在 HTTP operator 边界。

## 7. 自有事件契约

Host 事件信封与注入结果字段见 `host-event-and-injection-contract.md`。要点：

- 事件类型：session.started / session.ended / message.user / message.assistant.final / tool.completed。
- 信封字段：protocolVersion、adapterVersion、eventId、sessionId、turnId、projectId、kind、occurredAt、receivedAt、sourceRef、payload。
- 身份由配对凭据与通道认证确定，不信任 payload 中的 hostId。
- 注入结果：`injected` / `unavailable` / `denied` / `budget_exceeded`，附 reason、viewId（仅真实交付时）、数据时间与是否使用本地副本。

事件信封、去重与选择性保存已实现（`HostEvent`、`SessionEventStore`、`session_events`）；字段名仍属自有契约，不冒充上游 API。

## 8. 已知缺口

- 没有请求 ID、分页、速率限制与内容协商。
- 没有自有契约版本协商；破坏性字段变更只能整体升级并记录迁移。
- MCP 工具结果没有结构化 `structuredContent`，依赖 JSON 文本。
- 同步端点没有独立的速率限制、凭据轮换与请求级审计；Host 身份只有配对授权一种。

## 2026-11-09 修复补充

本轮实际运行时、projectId 授权、逐 Host 凭据、capture 状态机、v10 迁移和同步一致性以 [runtime-memory.md](runtime-memory.md) 的实现细化及 [current-handoff.md](current-handoff.md) 的实测状态为准。旧章节的“已实现”不表示真实 Host 验收已完成；未决同步 Schema 和身份体系细节不因原型代码而冻结。
