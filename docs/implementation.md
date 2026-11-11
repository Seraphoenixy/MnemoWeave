# 实现与契约

`packages/core/contracts` 定义严格的 Zod 输入、输出和错误码。HTTP 端点及请求体以本机 `GET /openapi.json` 为准，MCP 复用 Application Core。

## HTTP 与 MCP

| 用途 | HTTP 入口 |
|---|---|
| 探活与就绪 | `GET /health/live`、`GET /health/ready` |
| 注入与会话 | `POST /v1/inject`、`/v1/view`、`/v1/events`、`/v1/session/close`、`/v1/runtime/context` |
| 候选 | `POST /v1/remember`、`GET /v1/candidates/{candidateId}` |
| 正式记忆 | `GET/POST /v1/memories`、`GET/PATCH /v1/memories/{memoryId}`、`POST /v1/memories/{memoryId}/withdraw` |
| 图谱与检索 | `GET /v1/memories/graph`、`POST /v1/memories/explore`、`POST /v1/recall` |
| 准则、档案 | `GET/POST /v1/rules`、`PATCH /v1/rules/{ruleId}`、`GET/POST /v1/archives`、`PATCH /v1/archives/{entryId}` |
| 本机诊断 | `GET /v1/storage`、`/v1/injections/latest`、`/v1/sync/status`；`POST /v1/sync/refresh` |
| 人工治理 | `/v1/review`、`/v1/retry`、`/v1/conflicts/resolve`、`/v1/versions/cancel`、`/v1/reviews/due`、`/v1/reviews/complete`、`/v1/runtime/pins`、`/v1/runtime/projects` |

本机 HTTP 端点统一校验 Bearer 令牌，包括存活探针和 OpenAPI。宿主操作携带 `x-mnemoweave-host`，管理入口使用 operator 令牌。注入报告对宿主按 Host 隔离，可进一步限定会话。无同步配置时，同步诊断返回明确的未启用结果。

stdio MCP 默认代理本机 Server，`standalone` 模式在进程内运行并关闭 Worker。工具包括 `recall`、`provider_health`；启用对应服务时还提供 `remember`、`candidate_status`、`read_memory`、`read_conflict`、`runtime_context`、`memory_view`。会话绑定来自宿主配置。MCP 写入面限于候选和有界会话上下文。

## 候选与发布

1. `remember` 按 `idempotencyKey` 提交不可变候选。同键同输入返回原结果，同键不同输入返回 `IDEMPOTENCY_CONFLICT`。
2. 规则可确定的完全重复由 Server 处理，其余进入人工审核。涉及修订、取代、共存或冲突的变更按版本工作流裁定。
3. 批准生成任务和 Outbox。Worker 领取租约、调用 Provider，按稳定写入键核对正文、关系和回执。
4. 正式发布更新目录指针；共享入队与发布记录一起提交，重启可补偿。结果未知时查询已有结果，避免重复写入。

正式记忆的用户直接新增复用发布流水线，以 `local-user` 批准。编辑和撤回按条目串行，必须携带读取时的 `entryVersion`。编辑追加不可变 Revision，正文更新投影 `supersedes`；省略的分类字段继承原值。撤回保留历史正文并退出当前召回。目录只对当前有效、映射已应用的记忆开放召回。列表游标绑定排序，支持范围、分类、知识类型和实体筛选。正文读取经 Provider 并核对哈希。

准则界面编辑提交读取时的 `baseVersion`。当前 HTTP 契约仍接受省略该字段；界面总是发送基准。档案编辑必须发送 `baseVersion`。过期基准返回 `VERSION_CONFLICT`。

## 运行时与 View

View 组装按宿主、会话和项目授权限制读取。宿主可传 `x-mnemoweave-project`，客户端可配置 `MNEMOWEAVE_PROJECT_ID`；头与显式项目冲突时拒绝请求。工作上下文为本机会话投影，事件按 ID 去重。准则注入合并全局与当前项目，默认预算 1024 token。启用或修改会使适用准则超预算时拒绝写入，注入时也保持条目完整。每次注入记录条数、估算 token 和预算省略状态。

## Mnemon

`MNEMON_BINARY` 默认 `mnemon`，启动由 `execFile` 执行。Windows 应指定原生 `.exe`。固定接受 `mnemon version 0.2.13`，版本检查有短期缓存，子进程设置 `MNEMON_MAX_INSIGHTS=0`，使用专用 `--data-dir` 与 `--store`。只读命令在 Store 初始化后使用只读快照；不可变正文可按 Provider ID 缓存。

| 命令 | 用途 |
|---|---|
| `status`、`recall`、`show` | 健康、召回、读取正文；`recall --basic` 用于精确核对 |
| `remember --source mnemoweave:candidate:<uuid>` | 写入审核通过的正文；`skipped` 使用 `replaced_id` 定位 |
| `remember --no-diff --source mnemoweave:<changeId>:<version>` | 跨机重建，建立本地 Provider ID 映射 |
| `link`、`related --edge supersedes` | 投影及核对取代关系 |
| `forget` | Provider 适配器操作；正式记忆撤回使用目录和同步版本语义 |

命令超时、版本不兼容、输出格式错误和正文核对失败分别作为独立错误返回。

## 治理库与配置

当前治理库 schema v14。启动按顺序执行迁移，每步使用 `VACUUM INTO` 生成一致快照后再提交迁移。升级先在隔离状态目录演练。恢复时停止相关进程，保留原库，把选定快照作为新状态目录的 `governance.db`。Provider Store 与治理库分别保留，治理库快照只覆盖治理数据。

| 变量 | 用途 |
|---|---|
| `MNEMON_BINARY`、`MNEMON_DATA_DIR`、`MNEMON_STORE` | 官方 CLI、独立数据目录与 Store 名 |
| `MNEMOWEAVE_STATE_DIR`、`MNEMOWEAVE_PORT` | 本机状态目录与端口，默认 4317 |
| `MNEMOWEAVE_TOKEN`、`MNEMOWEAVE_OPERATOR_TOKEN` | 本机服务与管理凭据，使用不同值 |
| `MNEMOWEAVE_SERVER`、`MNEMOWEAVE_HOST_ID`、`MNEMOWEAVE_PROJECT_ID` | 宿主连接、身份与项目 |
| `MNEMOWEAVE_INJECT_DEADLINE_MS`、`MNEMOWEAVE_MCP_MODE` | 宿主注入截止与 MCP 运行模式 |
| `MNEMOWEAVE_WORKER` | 默认启用，`off` 停止后台候选处理 |
| `MNEMOWEAVE_MIN_FREE_BYTES`、`MNEMOWEAVE_QUOTA_SOFT_BYTES`、`MNEMOWEAVE_QUOTA_HARD_BYTES` | 容量地板与软硬配额 |
| `MNEMOWEAVE_SYNC_*` | 同步配置，见 [同步协议](sync.md) |

DSH 整理后保存和技能任务的行为见 [DSH 界面](dsh-ui.md)。
