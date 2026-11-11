# 实现规格

本文件描述**代码中实际存在**的契约与机制。未标注的条目都能在源码中找到落点。

## 1. 契约来源与错误码

- 唯一契约来源是 zod schema：同一份 schema 派生 TypeScript 类型、MCP `inputSchema` 与 HTTP `/openapi.json`。
- 所有请求 schema 均为 `.strict()`，多余字段直接拒绝。
- 错误码（`packages/core/contracts/src/index.ts`）：`INVALID_INPUT`、`UNAUTHORIZED`、`PROVIDER_UNAVAILABLE`、`PROVIDER_PROTOCOL`、`PROVIDER_INTEGRITY`、`PROVIDER_TIMEOUT`、`UNSUPPORTED_VERSION`、`REVIEW_REQUIRED`、`NOT_FOUND`、`IDEMPOTENCY_CONFLICT`、`INVALID_STATE`、`VIEW_BUDGET_EXCEEDED`、`QUOTA_EXCEEDED`、`INTERNAL`。
- 对外只返回错误码，不返回 stderr、路径、原始记忆或凭据。
- 同步错误码（已注册于 `ErrorCode`）：远端侧 `VERSION_CONFLICT`、`CHANGE_ID_REUSED`、`CHANGE_ID_EXPIRED`、`SNAPSHOT_REQUIRED`、`DEVICE_REVOKED`、`SCOPE_FORBIDDEN`、`SYNC_UNAVAILABLE`；本机侧 `SYNC_QUEUED`、`SYNC_OUTCOME_UNKNOWN`、`RULE_BUDGET_EXCEEDED`、`NEEDS_REVIEW`。语义见 `sync.md` 第 6 节。

## 2. HTTP 端点

鉴权是单一服务令牌（`Bearer`）；宿主用 `x-mnemoweave-host` 自报身份。带 `operator` 的端点（`/v1/review`、`/v1/retry`、`/v1/conflicts/resolve`、`/v1/versions/cancel`、`/v1/reviews/complete`、`/v1/runtime/*`、准则与档案写入）只接受 `MNEMOWEAVE_OPERATOR_TOKEN`。**编辑与撤回不在此列**：它们是记忆写入，只要求服务令牌 + Host 头。

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

### 5.1 进程启动成本与缓存（2026-11-11）

页面变慢的根因不是数据量，而是 CLI 进程启动次数。实测（本机，25 行真实记忆）：

| 场景 | 优化前 | 优化后 |
|---|---|---|
| `/health/ready` | 171 ms | 1–3 ms（缓存命中） |
| 页面启动（probe + ready + list） | 249 ms | 4 ms |
| 列表 25 行正文（冷） | 2219 ms | 1256 ms |
| 列表 25 行正文（热） | 2219 ms | 0 ms |

**2026-11-11 复测（200 条真实记忆，每路径取 3 次中位数）**：

| 场景 | 中位数 | 三次采样 |
|---|---|---|
| 列表首页 25 行 | **44 ms** | 36 / 44 / 1234 |
| 列表下一页 25 行 | **41 ms** | 34 / 41 / 1202 |
| 实体索引（`limit=1`，不读正文） | **30 ms** | 29 / 30 / 35 |
| 按重要度排序 25 行 | **34 ms** | 33 / 34 / 708 |
| 按实体筛选 | **35 ms** | 30 / 35 / 675 |
| 详情 | **1 ms** | 1 / 1 / 2 |
| 探索 20 条 | **137 ms** | 137 / 137 / 141 |

读法很重要：三次采样里的那个 ~1.2 s 是**首次读取该批正文**（未进 `bodyCache`），其余两次是缓存命中。也就是说稳态翻页约 40 ms，只有第一次看到某页时按 ~48 ms/条 的进程成本付费；`BODY_CACHE_LIMIT = 500` 意味着库内 ≤500 条时整库正文读一次就够。

本轮据此改了两处：①列表窗口从 `max(limit*4, 32)` 改为**从 `limit` 起步、被查询过滤掉才倍增**——原先一页 25 行固定读 32 条，等于为不显示的行付钱；②`readMany` 默认并发从 2 提到 **4**。并发不是越高越好：实测 16 条正文 concurrency=1 为 1805 ms、4 为 934 ms、8 为 1160 ms、16 为 1504 ms，8 以上因争用反而变慢。

三项改动（前一轮）：

1. **版本检查只做一次。** `checked()` 原先在每条命令前跑 `mnemon --version`，等于每次调用多起一个进程（约 85 ms）。版本对同一二进制不可变，改为缓存 60 秒；失败的检查不缓存，所以二进制被就地替换后一分钟内仍会被发现并拒绝。
2. **只读命令走不可变快照。** `status`、`recall`、`show`、`related` 使用 `--readonly`（CLI 文档：打开不可变数据库快照，拒绝写入、不产生 WAL 文件），比读写打开更安全也更快（约 20%）。**例外**：全新 store 无法以只读打开（CLI 报 `database not found`），所以本进程第一次调用走普通打开并由它建库；此后所有读都走快照。这里刻意不做「失败后重试」——那会把真实的 Provider 故障吞掉，`tests/contract/provider-cache.test.ts` 固定了「失败不重试」。
3. **正文缓存与批量读。** 正文对同一 memory id 不可变（编辑生成新 id 并 supersede 旧记忆），因此 `readMemory` 缓存正文，`forget` 删除时同步清除该 id。列表改为 `readMany` 批量读，整批仍与写操作串行，批内少量并发。

并发窗口经实测取 **2**：25 行下每行一个进程 2219 ms、窗口 2 为 1256 ms、窗口 3 为 1290 ms、窗口 4 为 1336 ms、窗口 8 为 1490 ms、窗口 16 为 1852 ms。进程启动是 CPU 密集的，且每次读都要开一个快照，加大窗口只增加竞争。

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

## 6. 治理库与迁移（schema v14）

默认路径 `<MNEMOWEAVE_STATE_DIR>/governance.db`；`node:sqlite` `DatabaseSync`，`timeout: 5000`，`WAL` + `synchronous=FULL` + `foreign_keys=ON`。版本上限守卫：`user_version > 14` 拒绝启动。

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
| v13 | `share_outbox`（待共享的已发布记忆）。审核发布与它的入队写在同一事务，进程在通知前崩溃也能在下次启动补偿 |
| v14 | `catalog_revisions` 增加 `knowledge_type`、`category`、`importance`、`tags_json`、`entities_json`。本地 Remember 记录知识类型与标签，同步条目记录分类、重要度、标签与实体；两类维度并存，互不推导 |

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

## 8. 浏览、用户直接编辑与撤回

### 8.1 列表与分页

`GET /v1/memories?query=&limit=&scope=&projectId=&cursor=`：`scope` 取 `all`（默认）/`global`/`project`，`scope=project` 必须带 `projectId`，否则 `INVALID_INPUT`。

顺序固定为「先按范围选候选 → 稳定排序 → 再按正文匹配」：候选按 `publishedAt` 降序、`memoryId` 升序排列。

游标是**键集位置**，不是数组下标（`v2:<publishedAt>:<memoryId>`，base64url）：下一页从上一页最后一条返回记录之后继续。用下标时，两次加载之间只要有发布、撤回或同步应用，就会重复或漏掉记忆——`tests/contract/memory-browse.test.ts` 用「页面之间撤回一条」固定了这个性质。非法游标返回 `INVALID_INPUT`，不会静默回到第一页。

正文读取失败**不等于「没有这条记忆」**：扫描在该条停下，游标留在它之前，重试会重新读它而不是跳过；若整页一条都没取到又确实发生了读失败，返回 `PROVIDER_UNAVAILABLE`，让页面给出重试而不是显示为空。

分类筛选（`category`、`knowledgeType`）与实体筛选（`entity`，大小写不敏感）在**读正文之前**作用于候选集，只花一次目录查询。没记录分类的记忆**不等于** `general`：它对分类筛选不命中，也不会被标成 `general`。响应里的 `categories`/`knowledgeTypes`/`entities` 是「按范围筛选后、按其他筛选前」的计数，所以选中一个分类不会让其他分类从选择器里消失；实体索引保留**首次出现的记录拼写**（`DSH` 与 `dsh` 合并成一条），计数覆盖两种写法的记忆。

排序（`sort`）有 `newest`（默认）、`oldest`、`importance` 三种。三种都接 `publishedAt` 再按 `memoryId` 收尾，因此顺序是全序，任意两条不会相等——这是游标不重复不跳过的前提。未记录重要度按「最后」排，而不是当作 0，返回时该字段仍然缺失。游标为 `v3|<sort>|<publishedAt>|<importance>|<memoryId>`：**游标绑定它被签发时的排序**，换排序后再用旧游标返回 `INVALID_INPUT`，而不是静默跳过一页。旧版 `v2:` 游标仍可解析为 `newest`。

### 8.1.2 关系图

`GET /v1/memories/graph?scope=&projectId=&limit=` 返回**结构，不含正文**：节点是作用域内的 `active` 记忆，边是 `catalog_relations` 里两端都在节点集中的关系。

两点是刻意的：

- **不带正文。** 正文是 Provider 读取，一个几百节点的图会变成几百次 CLI 进程；要画标签的地方应由渲染层按需解析它真正显示的节点。
- **不带悬空边。** 节点上限（`limit≤500`）截断后，端点被丢掉的关系一并丢弃——否则每个客户端都要自己重写这个过滤，而画一条指向不存在节点的线本身就是错的。自环同样被丢弃：记忆不能取代自己。

**节点不限于 `active`。** 一开始只把 `active` 记忆当节点，结果是 supersede 边永远画不出来——这类边的目标恰恰是已退休的记忆。现在先按 `active` 选起点，再把「一端已在图中的关系」的另一端补进来，并在节点上带 `state`，让页面把已退休的节点画成虚线。真机验证抓到的就是这个：库里明明有 `Supersedes` 关系，接口却返回零条边。

`truncated` 表示节点达到上限，此时答案是整个目录的子集而不是全部。节点先按发布时间降序、再按 memoryId 升序排序后截断，所以上限保留的是最近的那部分，不是任意切片。

过滤规则抽成 `drawableEdges`（`apps/server/src/config.ts` 导出）单独测试：关系行只由候选发布路径产生，端到端夹具为了造一条边要跑完整条审核流水线，不如直接测这个纯函数。

页面侧的布局在 `plugins/dsh-mnemo-weave/src/client/graph-layout.ts`：**确定性同心环**，不使用力导向。力导向看起来更"活"，但每次渲染的落点不同，同一张图会显得自己在动，而且没有任何东西可以被断言。同心环以连接最多的节点（同度数时按 memoryId）为圆心、按跳数分环、环内按 memoryId 排序，坐标因此是输入的纯函数；无关系的节点被放在最外环并单独报告，与"中心节点"在视觉上区分开。

### 8.1.3 语义探索

`POST /v1/memories/explore`（`{query, limit≤50, minScore∈[0,1]}`，宿主身份必需）与列表是两种检索：列表在稳定扫描上按正文匹配，探索按 Provider 自身的相似度排序。结果被映射回本机目录：每条命中的 `providerMemoryId` 找到对应的逻辑记忆，只保留 `active` 的，因此返回的每一项都能打开。Provider 里存在但本机从未发布的命中**只计数**（`unregistered`），不伪装成可打开的记忆。

`minScore` 是必要的，不是可选项：实测 Provider 对**完全不相关**的查询也会返回 0.3/0 这样的分数，没有门槛时「排序列表」会被误读成「答案」。分数范围 `[0,1]`，由 `mnemon recall` 实测确认（`1` 强相关、`0.6` 部分相关、`0` 无关）。

探索**没有游标**：Provider 每次调用重新排序，偏移量分页会重复或丢行。`truncated` 表示本次结果填满了 `limit`，可能还有更多；「显示更多」= 用更大的 `limit` 再问一次。这条约定要求**大答案是小答案的前缀**。

但 Provider 做不到这点：实测同一查询、同一 `limit` 连跑 5 次出现 **3 种不同顺序**（等分项的顺序不稳定），所以服务端对结果施加自己的全序——**分数降序 → 发布时间降序 → memoryId 升序**。这样排序是命中集合的确定函数，重复搜索不会让列表看起来自己洗牌，`truncated` + 更大 `limit` 才是真正的「同一顺序往下看」。`tests/contract/explore-ranking.test.ts` 用真实 Provider 固定了三点：同一查询两次结果顺序一致、分数单调不增、大答案是小答案的前缀。

`/v1/recall` 同样要求宿主身份，并在有目录时走 `client.recall(hostId, …)`，用与 View 相同的 grant 过滤可见集合。此前它直接调用 `app.recall(input)`，既不需要 Host 也不带 grant——服务令牌足以读取整个 Provider，绕过 View 的可见性规则。

### 8.2 详情与历史

`GET /v1/memories/{memoryId}`（或 `?revisionId=`）同时返回 `currentRevisionId` 与 `selectedRevisionId`：前者是召回与注入实际使用的版本，后者是本次响应携带的版本。带 `revisionId` 时读该历史版本，正文仍经哈希校验。页面必须用 `currentRevisionId` 判断「当前生效」，不能用所选版本推断——否则读历史时会把历史版误标为当前版。

每个 Revision 还带分类（v14）：`knowledgeType` 来自本地 Remember，`category`/`importance`/`tags`/`entities` 来自同步载荷。两类是不同维度，**不互相推导**：缺少某个字段表示「当时没有记录」，与「记录为空」在契约上可区分（字段可选 vs 空数组）。用户编辑正文时继承上一版的分类，因为改的是正文而不是分类。

### 8.2.1 新增

`POST /v1/memories`（`{content, knowledgeType, category?, importance?, tags?, entities?, scope?, projectId?, reason?}`，正文 1–8000 UTF-8 字节）：**界面新增直接发布为正式记忆，不经过候选审核**（2026-11-11 经用户确认，个人项目）。用户自己写下的内容被视为已确认的知识；模型输出仍然只能成为候选，两者入口不同。

实现上没有另写一条发布路径，而是：提交候选 → 立即以 `local-user` 批准 → 由**既有发布流水线**写 Provider、建档、入共享队列。理由是那条流水线包含重复检测、写结果对账与 `share_outbox` 入队，重写一遍只会引入分歧。代价是发布在后台 worker 里完成，所以端点会等待发布结果（通常 1 秒内，上限 15 秒）。

三种失败都是明确的：worker 未运行时**立即**返回 `INVALID_STATE`（不让人等 15 秒才知道没发布）；发布失败返回 `PROVIDER_UNAVAILABLE`；等待超时返回 `SYNC_OUTCOME_UNKNOWN`（候选已受理但结果未知，刷新即可看到）。

新记忆的 `entryVersion` 是 **0**：这个计数器记录的是已确认的**编辑**，不是发布次数。第一次编辑以 0 为基准，成功后变 1。

### 8.3 编辑

`PATCH /v1/memories/{memoryId}`（`{content, entryVersion, reason?, category?, knowledgeType?, importance?, tags?}`，正文 1–8000 UTF-8 字节；`entryVersion` 必填，取自打开编辑器时 `GET /v1/memories` 或 `GET /v1/memories/{id}` 返回的 `entryVersion`）：

1. 在同一 memoryId 的串行锁内读取 `catalog_memories`，只允许 `active`；取当前 Revision 的 Provider 记忆 ID。
2. 校验 `entryVersion` 等于本地已确认版本，否则 `VERSION_CONFLICT`。
3. 用 `persistReviewed(content, 'candidate:<uuid>')` 在 Mnemon 写入新生正文。
4. `linkSupersedes(新ID, 旧ID, {operationId, reason, effectiveAt})` 建立 supersedes 边。
5. `catalog.publishDirectEdit` 在同一事务里插入一条 `pending_review` 占位候选、提交回执、`persisted` 生命周期记录、`local-user` 的 approve 审核记录，追加 Revision（`parentId = 旧 Revision`、`revision_number + 1`），移动当前指针并重排复核时间。

启用同步时先由远端确认再写本机 Provider；成功判定以「该条目是否新增了映射」为准（`nextMappedVersion`），因为 inbox 行可能已被快照清理，不能作为凭据。

同一 memoryId 的编辑与撤回经过 `withEditLock` 串行执行：版本校验与写入之间隔着多个 `await`，不加锁时两个携带同一 `entryVersion` 的请求都会通过校验并各自写入，基准版本就失去了保护作用。并发验收见 `tests/contract/edit-gates.test.ts`（同基准两次编辑只有一个成功，失败方不留可见 Revision）。

### 8.4 撤回

`POST /v1/memories/{memoryId}/withdraw`（`{reason, entryVersion}`）：撤回是**新增撤回版本**，不是物理删除。本机 Provider 正文保留，`catalog_memories.state` 置 `superseded`，审核记录写入 `withdraw` 决定；启用同步时以 `delete` 操作提交新版本并置 `withdrawnAt`。收到其他设备的撤回同样只退役映射，不调用 `forget`——`forget` 会使 `show` 失败并丢掉指向该记忆的边，与「历史仍可读」的协议承诺冲突。

撤回与编辑一样**推进 `entryVersion`**：无同步时没有别的东西会推进计数器，若不推进，后续编辑会拿一个记忆已经不再持有的版本作为基准，调用方也会被告知撤回没有生效。撤回后 `state` 变为 `superseded`，再次撤回返回 `INVALID_STATE`。

### 8.4.1 编辑分类

编辑不只改正文：`category`、`knowledgeType`、`importance`、`tags` 都可随 Revision 一起更新。**省略某个字段表示继承上一版**，不是清空——只改正文的编辑不会静默丢掉记忆原来的分类；显式传空数组才是清空标签。这由 `classificationOf` 只保留「调用方真正设置过」的字段实现，目录层再把它们与上一版合并后写入新 Revision。

两者都只要求**服务令牌 + `x-mnemoweave-host`**，并要求 Host 头存在（缺失返回 `UNAUTHORIZED`），使写操作可归因到发起它的宿主。写入仍记录一条 `local-user` 审核决定。

这里刻意**不再要求第二把凭据**（2026-11-11 用户确认：个人项目）。服务令牌与 operator 令牌由同一个人持有、来自同一处环境变量，多一道校验并不能区分「用户点击」与「宿主代码」，只会增加配置负担。代价要说清楚：审计里能证明的是**哪个宿主发了请求**，不是「有人在屏幕前确认过」。这是单用户机器上明确接受的取舍，不是被忽略的漏洞。

此前曾用一次性确认码（`POST /v1/memories/{id}/confirm`）试图区分「用户点击」与「宿主代码」——该机制已移除：确认码由同一个调用方申请、同一个调用方消费，持服务令牌的任何代码都能自行完成两步，只增加形式而没有增加证明力。Host 半**完全不读取 `MNEMOWEAVE_OPERATOR_TOKEN`**，因此该秘密不再分布在三个插件里。

### 8.5 DSH Host 配置

DSH 插件的页面 Host 半与提示注入钩子共用 `plugins/dsh-mnemo-weave/src/shared/host-config.js` 作为唯一配置读取处（Host 半由 esbuild 内联，注入钩子 import 构建时复制到 `lib/host-config.js` 的同一文件）。非敏感值按「页面偏好 → DSH 配置 → 环境变量 → 默认值」解析，并返回 `sources` 标注来源；令牌只从 DSH 配置或环境变量读取。

偏好写入 `%USERPROFILE%\.dsh\mnemo-weave.settings.json`（可用 `MNEMOWEAVE_DSH_SETTINGS` 或 `DSH_PROFILE_DIR` 覆盖），临时文件 + rename 原子替换，损坏文件回落默认值，文件内不含任何凭据。设置页分四种保存语义：界面偏好即时保存；连接设置先校验 loopback 再测试连接，**测试通过后写入同一份偏好文件**（不是只改页面内存），因此页面与注入钩子读到同一个地址，保存其他分组也不会把它还原；自动启动即时保存；注入项目与等待上限作为一组应用（上限限制 250–1900 毫秒，计入两秒总截止）。

提示注入钩子同样接入自动唤醒：请求 `/v1/inject` 前先用共享模块的 `ensureReachable` 探测 `/health/live`，**只有 `ECONNREFUSED` 且 `autoStart` 打开时**才唤醒计划任务；超时、令牌被拒或地址上不是本服务都不会启动进程。唤醒占用一部分预算，剩余时间交给注入请求，整轮不超过两秒。
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

## 11. 模型归属（2026-11-10 变更）

**Server 不调用任何外部模型。** `packages/infrastructure/model-gateway` 已删除，`MNEMOWEAVE_MODEL_*` / `MNEMOWEAVE_BACKUP_MODEL_*` 已移除；配置这些变量会启动失败并说明原因，而不是被静默忽略。

语义判断改由**宿主会话内的模型**完成，这与 DSH 生态中 `dsh-mnemon` 的做法一致（它不启动后台 Agent，只通过注入指令引导当前 LLM）：

| 关注点 | 现在由谁负责 |
|---|---|
| 这条信息值不值得记 | 宿主会话的模型，依据 `CAPTURE_GUIDANCE` 的注入指令自我判断，符合才调用 `remember` |
| 是否与已有记忆重复/矛盾 | 模型先 `recall` 自查；Server 侧只做**确定性**全等去重（`inspectExact`） |
| 候选是否通过 | 确定性规则自动拒绝（已知重复）；其余一律 `needs_review` 等人批准，理由是「Server 不调用模型」 |
| 召回排序 | 不重排，按 Provider 返回顺序交付；`rerank` 恒为 `not_requested` |
| 运行时事件提炼 | 不再在 Server 提取；排队的 capture 任务标记为 `awaiting_model`，指宿主的模型 |

`MemoryWorkflow.review` 只保留机器可证的部分：显式变更意图转人工、全等重复拒绝/转人工、查询截断转人工、其余转人工。模型输出的不可信假设仍然成立——候选依旧只能成为候选，Approval 与写入路径未变。

## 12. 配置

Server（`apps/server/src/config.ts`，zod 校验，不合法即拒绝启动）：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `MNEMON_BINARY` | 否 | `mnemon` | 按 PATH 解析；也可显式给路径 |
| `MNEMON_DATA_DIR` | 是 | — | 绝对路径 |
| `MNEMON_STORE` | 是 | — | `^[a-zA-Z0-9_-]+$` |
| `MNEMOWEAVE_PORT` | 否 | 4317 | 只监听 127.0.0.1；`0` 表示由系统分配端口（实例保护不会探测） |
| `MNEMOWEAVE_STATE_DIR` | 否 | — | 绝对路径；治理库、快照都在此 |
| `MNEMOWEAVE_WORKER` | 否 | `on` | `off` 仅用于诊断/暂存 |
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
