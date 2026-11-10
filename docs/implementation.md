# 实现规格

本文件描述**代码中实际存在**的契约与机制。未标注的条目都能在源码中找到落点。

## 1. 契约来源与错误码

- 唯一契约来源是 zod schema：同一份 schema 派生 TypeScript 类型、MCP `inputSchema` 与 HTTP `/openapi.json`。
- 所有请求 schema 均为 `.strict()`，多余字段直接拒绝。
- 错误码（`packages/core/contracts/src/index.ts`）：`INVALID_INPUT`、`UNAUTHORIZED`、`PROVIDER_UNAVAILABLE`、`PROVIDER_PROTOCOL`、`PROVIDER_INTEGRITY`、`PROVIDER_TIMEOUT`、`UNSUPPORTED_VERSION`、`REVIEW_REQUIRED`、`NOT_FOUND`、`IDEMPOTENCY_CONFLICT`、`INVALID_STATE`、`VIEW_BUDGET_EXCEEDED`、`QUOTA_EXCEEDED`、`INTERNAL`。
- 对外只返回错误码，不返回 stderr、路径、原始记忆或凭据。
- 同步错误码（已注册于 `ErrorCode`）：远端侧 `VERSION_CONFLICT`、`CHANGE_ID_REUSED`、`CHANGE_ID_EXPIRED`、`SNAPSHOT_REQUIRED`、`DEVICE_REVOKED`、`SCOPE_FORBIDDEN`、`SYNC_UNAVAILABLE`；本机侧 `SYNC_QUEUED`、`SYNC_OUTCOME_UNKNOWN`、`RULE_BUDGET_EXCEEDED`、`NEEDS_REVIEW`。语义见 `sync.md` 第 6 节。

## 2. HTTP 端点

鉴权是单一服务令牌（`Bearer`）；宿主用 `x-mnemoweave-host` 自报身份。带 `operator` 的端点只接受 `MNEMOWEAVE_OPERATOR_TOKEN`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health/live` | 存活探针（除它以外都要鉴权，它本身也要） |
| GET | `/health/ready` | Provider 健康与版本 |
| GET | `/openapi.json` | 由同一契约生成的 OpenAPI 文档 |
| POST | `/v1/recall` | 召回 |
| POST | `/v1/view` | 组装不可变 View（同 `/v1/inject`，保留兼容） |
| POST | `/v1/inject` | 宿主一次调用完成注入：装配会话 View，受 2 秒截止约束 |
| POST | `/v1/events` | 宿主事件入库；同时推进运行时投影 |
| POST | `/v1/session/close` | 关闭会话，迟到结果不再绑定 |
| POST | `/v1/runtime/context` | 有界会话工作上下文与常驻引用 |
| POST | `/v1/runtime/pins`（operator） | 登记常驻记忆引用 |
| POST | `/v1/runtime/projects`（operator） | 显式登记项目 ID |
| POST | `/v1/remember` | 提交候选，返回 202 + 提交回执 |
| GET | `/v1/candidates/{candidateId}` | 候选状态 |
| GET | `/v1/memories` | 已发布记忆列表（`query` 空格分词、`limit` 1–200） |
| GET | `/v1/memories/{memoryId}` | 记忆与指定 Revision（正文来自 Provider 并校验哈希） |
| PATCH | `/v1/memories/{memoryId}` | 用户直接编辑：必须携带 `entryVersion`；追加 Revision、supersedes 旧 Provider 记忆、移动当前指针 |
| GET | `/v1/conflicts/{caseId}` | 冲突案件 |
| POST | `/v1/review`（operator） | 人工裁定 approve / reject / amend |
| POST | `/v1/retry`（operator） | 失败候选重试，保留稳定 writeKey |
| POST | `/v1/conflicts/resolve`（operator） | keep_existing / revise / supersede / coexist / unverified |
| POST | `/v1/versions/cancel`（operator） | 取消未发布版本操作 |
| POST | `/v1/reviews/complete`（operator） | 完成到期复核 |
| GET | `/v1/reviews/due` | 到期复核列表 |
| GET | `/v1/storage` | 容量与用量状态 |
| GET | `/v1/sync/status`（operator 或带 Host 头的宿主） | 按范围的本机同步状态：游标、最近成功拉取时间、最近错误、待推送（`pending`）、待确认（`unknown`）与待应用（`unapplied`）条数；范围来自已见授权与 outbox 中出现的范围，因此远端不可达时待推送项仍然可见；同步未配置时返回 409 `REVIEW_REQUIRED` |
| POST | `/v1/sync/refresh`（operator 或带 Host 头的宿主） | 手动触发一趟：收敛未知结果 → 推送 outbox → 逐范围拉取并应用；重叠趟次返回 `skipped` |
| GET | `/v1/rules?scope=&projectId=`（operator 或带 Host 头的宿主） | operator 可按范围收窄；宿主得到全部项目的准则（停用项也返回，撤回项不返回） |
| POST | `/v1/rules`（operator） | 新建准则；适用准则超出 1024 token 准则预算返回 409 `RULE_BUDGET_EXCEEDED`，不落截断版本 |
| PATCH | `/v1/rules/{ruleId}`（operator） | 编辑正文或启停；追加版本并重新校验预算 |
| POST | `/v1/archives`（operator） | 写项目档案；模型输出只能先成为候选 |
| GET | `/v1/archives?projectId=&includeWithdrawn=`（operator 或带 Host 头的宿主） | 可按项目读档案，省略 `projectId` 即全部项目；默认不含已撤回条目 |
| GET | `/v1/injections/latest`（operator，或带 Host 头的宿主令牌） | 最近一轮注入结果：准则条数与是否因预算省略、记忆条数、估算 token；宿主只看自己的记录，可带 `sessionId` 进一步限定；尚未注入过返回 404 |

本机 Server 与远端之间的端点（`/v1/sync/changes`、`/v1/sync/snapshot` 等）不在这张表里，它们的鉴权与语义不同，见 `sync.md` 第 6 节。

未配置候选存储时 `/v1/remember` 返回 409 `REVIEW_REQUIRED`。

## 3. 宿主客户端（`packages/client`）

三个宿主插件共用同一实现，避免各自维护一份 HTTP/校验逻辑：

| 方法 | 端点 | 说明 |
|---|---|---|
| `inject(input, timeoutMs)` | `POST /v1/inject` | 默认 2 秒截止；超时返回错误结果而不是拖住宿主回合 |
| `context(input)` | `POST /v1/runtime/context` | 会话工作上下文 |
| `event(input)` | `POST /v1/events` | 事件入库 |
| `closeSession(id)` | `POST /v1/session/close` | 关闭会话 |
| `recall(input)` / `remember(input)` | `/v1/recall`、`/v1/remember` | 召回与候选提交 |
| `listMemories({query, limit})` | `GET /v1/memories` | 界面列表 |
| `readMemory(id, revisionId?)` | `GET /v1/memories/{id}` | 详情 |
| `editMemory(id, {content, reason?})` | `PATCH /v1/memories/{id}` | 用户编辑 |
| `health()` | `GET /health/ready` | 可用性 |

约束：`baseUrl` 必须是 loopback；令牌至少 24 字符；所有失败返回 `{ ok: false, error }`，不抛异常。`clientFromEnv()` 读取 `MNEMOWEAVE_SERVER`、`MNEMOWEAVE_TOKEN`、`MNEMOWEAVE_HOST_ID`。

## 4. MCP 工具

stdio 服务名 `mnemoweave`，版本 `0.1.0`。

| 工具 | 条件 | 说明 |
|---|---|---|
| `recall` | 总是 | 召回 |
| `provider_health` | 总是 | Provider 健康与版本 |
| `remember` | 启用候选存储 | 只提交候选，不写正式记忆 |
| `candidate_status` | 启用候选存储 | 候选状态 |
| `read_memory` / `read_conflict` | 启用候选存储 | 读取记忆与冲突 |
| `runtime_context` / `memory_view` | 配置了运行时 | 会话上下文与 View |

MCP 不暴露 approve/review/retry，也不接受模型自报 `sessionId`。`MNEMOWEAVE_MCP_MODE=standalone` 时进程内直连（Worker 关闭），否则通过 `http-memory-client.ts` 代理到唯一 Server。

## 5. Provider CLI 契约（Mnemon 0.2.13）

`packages/providers/mnemon/src/index.ts`：

- 可执行文件来自环境：`MNEMON_BINARY` 可省略，默认 `mnemon`（按 PATH 解析）；也可显式给绝对路径。代码里没有任何相对仓库的路径。
- 执行方式：`execFile(binary, args, { shell:false, windowsHide:true, timeout:15000, maxBuffer:2MiB })`；子进程被杀 → `PROVIDER_TIMEOUT`，其他启动/退出失败 → `PROVIDER_UNAVAILABLE`。
- 每次调用前先执行 `--version`，`stdout.trim()` 必须严格等于 `mnemon version 0.2.13`，否则 `UNSUPPORTED_VERSION`。
- 公共前缀：`--data-dir <绝对路径> --store <[a-zA-Z0-9_-]+>`；所有调用经内部串行队列。
- 子进程环境固定 `MNEMON_MAX_INSIGHTS=0`，关闭其默认自动容量清理。

| 用途 | 命令行 |
|---|---|
| 健康 | `status` → `{total_insights}` |
| 召回 | `recall --limit <n> -- <query>` → `{results:[{id,content,score,superseded?}]}` |
| 精确核对 | `recall --basic --limit 200 -- <content>`，内容全等过滤，`complete = rows < 200` |
| 读取全文 | `show -- <id>` |
| 关系投影 | `link <src> <dst> --type supersedes --meta <json>`，并逐项核对 ack |
| 正式写入 | `remember --source mnemoweave:candidate:<uuid> -- <content>`（writeKey 必须匹配 `^candidate:[a-f0-9-]{36}$`） |
| 隔离验收 | `remember --source external -- <content>` |
| 跨机重建（已实现） | `remember --source mnemoweave:<changeId>:<version> --no-diff -- <content>`；不带 `--no-diff` 会被去重返回 `skipped` |
| 撤回（已实现） | `forget <id>`；软删除，数据保留、查询排除 |
| 关系读取（已实现） | `related <id> --depth <n> --edge supersedes`，用于跨机核对 |

`remember` 没有指定 ID 的参数，因此重建时必须建立逐机映射（`formal_map`），不能复用远端 ID。

`remember` 的响应是判别联合：`added` 或 `skipped{replaced_id}`。重复时以 `replaced_id` 定位既有记忆，不视为新写入。输出一律经 zod 解析，失败即 `PROVIDER_PROTOCOL`。Provider 不做能力探测：`health()` 的 `capabilities` 是固定值。

## 6. 治理库与迁移（schema v12）

默认路径 `<MNEMOWEAVE_STATE_DIR>/governance.db`；`node:sqlite` `DatabaseSync`，`timeout: 5000`，`WAL` + `synchronous=FULL` + `foreign_keys=ON`。版本上限守卫：`user_version > 12` 拒绝启动。

迁移内联在构造函数中按版本号顺序执行，每步先用 `VACUUM INTO <db>.pre-vN.<uuid>.db` 生成一致快照（0→1 除外），迁移在事务内提交。

| 版本 | 内容 |
|---|---|
| v1 | `governance_candidates`、`governance_submission_receipts` |
| v2 | lifecycle、reviews、review_tasks、tasks、outbox、runs、execution_receipts、provider_binding、workflow_lock |
| v3 | `catalog_memories`、`catalog_revisions`（不可变触发器），从历史回执回填初始发布 |
| v4 | `catalog_operations`、`catalog_reservations`、`catalog_relations` |
| v5 | `catalog_conflicts`、`catalog_conflict_decisions` |
| v6 | 重建 outbox（去镜像态）、tasks 增加 `first_failed_at`/`alerted_at` |
| v7 | 候选正文拆表 `governance_candidate_bodies`；`session_events`/`session_event_refs`；revisions 增加 `applicability`/`scope` |
| v8 | `sync_log`、`sync_grants`、`sync_license_state`（**已废弃**：不再有代码写入） |
| v9 | `catalog_review_state`、`catalog_review_history` |
| v10 | runtime 八表：`runtime_user_events`、`runtime_projects`、`runtime_pins`、`runtime_sessions`、`runtime_event_ids`、`runtime_capture_tasks`、`runtime_capture_runs`、`runtime_capture_receipts` |
| v11 | 同步与三类记忆八表：`sync_state`（按范围游标）、`sync_outbox`、`sync_inbox`、`formal_map`、`runtime_rules`、`project_archives`、`project_bindings`、`runtime_injections`；同一步删除 v8 遗留的 `sync_log`、`sync_grants`、`sync_license_state` |
| v12 | `entry_versions`（已确认的条目版本），并从 `formal_map` 回填；本地写入以它作为基准版本，不再从映射推断 |

升级与恢复：停止全部 Server/MCP/Worker → 保留原库 → 把选定快照复制到**新的**状态目录并命名 `governance.db` → 指向新目录。快照只恢复治理数据，不能回滚 Provider。

## 7. 候选审核与可靠写入

流程：`remember` 写候选（不可变，内容存 `governance_candidate_bodies`）→ 确定性规则 + 官方读取去重 → 需要时调用 Model Gateway 做六项语义检查 → 批准结论、正式 Task、Outbox 同事务提交 → 进程内带租约的 Worker 领取 → 持久化 `writing` 检查点后才调用 CLI → `show` 核对 ID 与全文 → 保存成功回执与 `persisted`。

不变量：

- 候选与提交回执同事务；批准结论、Task、Outbox 同事务；Task / Run / Receipt ID 独立关联。
- 稳定写入键为 `candidate:<UUID>`，写入 Task、Receipt 并传给 `--source`。CLI 没有声明支持该幂等协议，因此它是本项目的事前标记，不是 Provider 原生 exactly-once。
- 租约 + owner fencing：心跳延长租约，过期 Worker 不得回写；重启等待旧租约到期。
- 中断或响应丢失只做对账：找到唯一明确结果则补记回执；无明确结果或查询截断则 `failed`，等人工确认后再重试。
- 未发起写入的可确定故障最多三次退避重试（指数增长，封顶 15 分钟）。
- 同一任务持续失败 24 小时告警一次，不自动放弃。
- 只有 `persisted` 且有正式成功回执才表示 Provider 已核对；`approved` 只表示已排队。

## 8. 用户直接编辑

`PATCH /v1/memories/{memoryId}`（`{content, entryVersion, reason?}`，正文 1–8000 UTF-8 字节；`entryVersion` 必填，取自打开编辑器时 `GET /v1/memories` 或 `GET /v1/memories/{id}` 返回的 `entryVersion`）：

1. 读取 `catalog_memories`，只允许 `active`；取当前 Revision 的 Provider 记忆 ID。
2. 用 `persistReviewed(content, 'candidate:<uuid>')` 在 Mnemon 写入新生正文。
3. `linkSupersedes(新ID, 旧ID, {operationId, reason, effectiveAt})` 建立 supersedes 边。
4. `catalog.publishDirectEdit` 在同一事务里插入一条 `pending_review` 占位候选、提交回执、`persisted` 生命周期记录、`local-user` 的 approve 审核记录，追加 Revision（`parentId = 旧 Revision`、`revision_number + 1`），移动当前指针并重排复核时间。
5. 返回 `{memoryId, revisionId, providerMemoryId, contentHash, entryVersion}`；新版本为「当前版本 + 1」，同时写入 `formal_map`（`state = applied`），作为下一次编辑的基准。

`entryVersion` 在写入前与 `formal_map` 中该条目的最高版本比较，不一致返回 409 `VERSION_CONFLICT`，不落 Provider。本机在用户打开编辑器之后被后台同步推进到新版本时，旧基准必须原样提交并被拒绝，由远端拒绝并保留草稿，不能静默以新版本为基准覆盖他机修改。

这条路径不创建 Task、不进 Outbox、不经过审核队列；它是用户本人的更正，不是模型输出。Revision 仍不可变，历史版本可读。

跨机同步：启用同步时，编辑先把变更提交远端确认（`baseVersion` 取自 `entryVersion`，`changeId` 幂等），确认后经同一应用流水线写入本机 Mnemon（`remember --no-diff` + `link supersedes`），再更新发布目录；本机未确认前不写 Provider，避免远端拒绝后留下无引用记忆。未到达远端返回 409 `SYNC_QUEUED`（草稿仍在调用方，可重试）；已发出但结果未知返回 409 `SYNC_OUTCOME_UNKNOWN`，由 `changeId` 查询收敛，不靠超时推断；基准过期返回 `VERSION_CONFLICT`。未启用同步时保持上面的本机直写路径。详见 `sync.md` 第 7.1 节。

## 9. 版本与冲突

- Revision 不可变；更新以 CAS 比较 `expectedRevisionId`，配合业务占用与前向恢复。
- 变更意图 `revise` / `supersede` / `coexist` / `conflict` 一律不进自动批准，必须人工确认。
- 冲突案件由 `catalog_conflicts` 记录，裁定写入 `catalog_conflict_decisions`；`coexist` 必须提供适用范围不同的 replacement。
- 取消版本操作只在不可逆关系投影前受理，回执标记 `uncertain=true`。
- 到期复核由 v9 的 review 表驱动，默认间隔 90 天（`DEFAULT_REVIEW_INTERVAL_DAYS`）。

## 10. 运行时记忆

- 持久化 Pinned（`runtime_pins`）、项目登记（`runtime_projects`）、会话工作上下文（`runtime_sessions`）、事件去重（`runtime_event_ids`）。
- 会话上下文有界；"继续"沿用先前任务；工作材料明确标注未验证。
- 事件先经保留规则写入 `session_events`，再推进运行时投影；投影自己按事件 ID 去重。
- 入选提炼：capture Task / Run / Receipt 独立持久化，输出只成为候选；无模型、非法引用与 opt-out 不发布。
- 注入：`ViewAssembler` 按调用方范围过滤，预算 `DEFAULT_INJECTION_BUDGET_TOKENS = 4096`，客户端截止 2 秒；超时不重复召回，迟到结果只作为后续 View。
- 准则注入：Server 提供 `rules` 读取（全局准则 + 当前项目准则），随 View 以独立 `rules` 块与 `rulesBudget` 返回，准则占用计入 `usedTokens`；每轮注入写入 `runtime_injections`，`GET /v1/injections/latest` 返回最近一条——operator 得到全局最新，宿主凭 Host 头只得到自己的记录。
- 保留期：会话热数据 7 天、归档 90 天、候选正文 30 天、诊断日志 30 天。
- 运行时准则：`runtime_rules` 保存用户确认的准则正文、适用范围（全局/项目）、启用状态与版本；它来自用户确认，不进候选审核队列。写入走 `POST /v1/rules` 与 `PATCH /v1/rules/{ruleId}`，只接受 operator 令牌：先落本机，再按已确认版本入 outbox 并尝试推送一次；远端确认后由同一应用流水线覆盖版本，`SYNC_QUEUED` 表示已排队待推送，`SYNC_OUTCOME_UNKNOWN` 由 `changeId` 查询收敛。
- 项目档案：`project_archives` 保存项目经验正文、来源、验证状态与版本；待验证结论保留 `open` 状态。写入走 `POST /v1/archives`（operator），路径与准则相同；读取走 `GET /v1/archives?projectId=`，只返回该项目的档案，默认过滤已撤回条目，`includeWithdrawn=true` 才一并返回。写入只接受 operator 令牌；读取（含跨项目）对带 Host 头的宿主开放，用于 DSH 记忆页展示。
- 同步来的正式记忆：应用流水线写入本机 Mnemon 并记录映射后，同时把它记入本机发布目录（`publishSynced`），因此它在其他机器上可列出、可编辑。目录里没有对应候选，故用一条合成的候选行承载请求元数据，审核记录 `actor=sync`，来源为 `sync`；同一 `providerMemoryId` 重复应用返回已有修订，不重复建条目。远端撤回时该记忆标记为 `superseded`，修订历史保留。应用前已有映射的变更直接跳过 Provider 写入，避免重试造成重复记忆。
- 注入顺序：`packages/client/src/render.ts` 的 `renderView` 固定为「引导语 → 准则 → 工作上下文 → 正式记忆」，准则逐条成行、不截断；准则因预算整块省略时渲染一行说明，使模型能区分「没有适用准则」与「准则被丢弃」。ZCode 与 ChatGPT 钩子使用该渲染器；DSH 的提示注入适配器仍未实现。
- 准则完整性：启用或保存时校验全部适用准则能否装入 1024 token 准则预算，装不下返回 `RULE_BUDGET_EXCEEDED` 并拒绝写入（全局准则只与全局准则竞争，项目准则与「全局 + 该项目」一起计算）；注入时准则按完整条目交付，**永不按正文截断**，单独超出预算时整块不注入并把 `rulesBudget.exceeded` 置真。
- 注入可见性：最近若干轮注入结果写入 `runtime_injections`，界面可读「本轮已注入 N 条准则」或「本轮未注入」及原因；2 秒超时、Server 不可达都算未注入，不静默。DSH 页面通过宿主令牌读取本宿主自己的记录。
- 召回可见性：召回与注入只使用治理库当前指针指向且 `formal_map.state = 'applied'` 的版本。`MemoryApplication.recallDetailed` 在过滤可见集合的同时收集「Provider 返回但本机从未发布」的 id；`/v1/recall` 仍按原契约返回（不带该列表），View 则把它们记入 `excluded: [{reason: 'unregistered'}]`，不再静默丢弃。

## 11. 模型网关

`ChatModelGateway` 只允许已声明组件（候选审核、提炼）调用显式配置的路由，并发上限 2；非本地端点必须 HTTPS。未配置模型时所有非明显重复候选转人工。备用路由仅在 temporary/unavailable/timeout 时最多切换一次。模型拒绝、截断、无效 JSON、不确定结论一律转人工；模型申报的 `verified` 或 confidence 不单独作为批准依据。用量写入 `model-usage.jsonl` 或 stderr。

## 12. 配置

Server（`apps/server/src/config.ts`，zod 校验，不合法即拒绝启动）：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `MNEMON_BINARY` | 否 | `mnemon` | 按 PATH 解析；也可显式给路径 |
| `MNEMON_DATA_DIR` | 是 | — | 绝对路径 |
| `MNEMON_STORE` | 是 | — | `^[a-zA-Z0-9_-]+$` |
| `MNEMOWEAVE_PORT` | 否 | 4317 | 只监听 127.0.0.1 |
| `MNEMOWEAVE_STATE_DIR` | 否 | — | 绝对路径；治理库、快照、用量文件都在此 |
| `MNEMOWEAVE_WORKER` | 否 | `on` | `off` 仅用于诊断/暂存 |
| `MNEMOWEAVE_MODEL_URL` / `_MODEL` / `_MODEL_KEY` | 否 | — | 审核用模型路由 |
| `MNEMOWEAVE_BACKUP_MODEL_URL` / `_MODEL` / `_MODEL_KEY` | 否 | — | 备用路由 |
| `MNEMOWEAVE_MIN_FREE_BYTES` | 否 | — | 磁盘地板，低于则 Worker 停 |
| `MNEMOWEAVE_QUOTA_SOFT_BYTES` / `_HARD_BYTES` | 否 | 10 GiB / 20 GiB | 软 ≥ 硬则拒绝 |
| `MNEMOWEAVE_SYNC_URL` / `_DEVICE_ID` / `_TOKEN` | 否 | 空 | 三者必须同时给出，缺一在启动时拒绝；全空则不启用同步，本机行为与纯本机模式一致 |
| `MNEMOWEAVE_SYNC_INTERVAL_MS` | 否 | 300000 | 后台拉取间隔，0 关闭定时（启动时仍跑一趟） |
| `MNEMOWEAVE_SYNC_TIMEOUT_MS` | 否 | 10000 | 单次远端调用超时，超时按「已发出、结果未知」处理 |
| `MNEMOWEAVE_SYNC_PORT` / `_HOST` / `_STATE_DIR` | 远端 | 4318 / 127.0.0.1 / — | 远端同步 Server 的监听与状态目录；`_STATE_DIR` 必填 |
| `MNEMOWEAVE_SYNC_PRUNE_INTERVAL_MS` | 远端 | 21600000 | 变更日志清理周期，0 关闭周期（启动时仍清理一次） |
| `MNEMOWEAVE_SYNC_RETENTION_DAYS` / `_MAX_CHANGES` / `_RECEIPT_DAYS` | 远端 | 90 / 50000 / 365 | 变更保留天数与每范围条数上限、去重凭证保留天数；小于 1 时启动报 `CONFIG_INVALID` |
| `MNEMOWEAVE_PROJECT_ID` | 否 | 空 | 宿主声明当前项目；等价于 `x-mnemoweave-project` 头 |

不在 zod schema 内、由入口直接读取：`MNEMOWEAVE_TOKEN`（服务令牌）、`MNEMOWEAVE_OPERATOR_TOKEN`、`MNEMOWEAVE_MCP_MODE`、`MNEMOWEAVE_SERVER`、`MNEMOWEAVE_HOST_ID`、`MNEMOWEAVE_SESSION_ID`。

宿主侧（三个插件一致）：`MNEMOWEAVE_SERVER`、`MNEMOWEAVE_TOKEN`、`MNEMOWEAVE_HOST_ID`；可选的 `MNEMOWEAVE_PROJECT_ID`、`MNEMOWEAVE_INJECT_DEADLINE_MS`（默认 2000）。项目也可用 `x-mnemoweave-project` 头声明：请求体省略 `projectId` 时由该头补齐，请求体与它相同则照常，两者冲突返回 `INVALID_INPUT`，长度上限 200 字符；该头作用于 `/v1/view`、`/v1/inject`、`/v1/runtime/context`、`/v1/events`。`packages/client` 的 `projectId` 选项与 `MNEMOWEAVE_PROJECT_ID` 环境变量会自动把它加到每个请求上。宿主侧不含任何同步凭据。
