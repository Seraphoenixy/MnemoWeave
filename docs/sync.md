# 同步规格

本文描述三机共享记忆的协议、版本模型与故障恢复。状态标记沿用 `README.md`。**同步已按本文件实现**：契约、纯规则、远端权威库与远端同步服务、本机接入（账本、应用流水线、本地写入）、三类记忆与编辑的远端确认均已落地；除标注「已实现」的条目外，其余仍为**规格**。

## 1. 拓扑与职责

| 组件 | 部署 | 职责 | 不做什么 |
|---|---|---|---|
| 本机 Server A/B/C | 各开发机，`127.0.0.1:4317` | 宿主接入、注入与召回、治理库、向远端提交与拉取、把变更应用到本机 Mnemon | 不做跨机仲裁，不与其他本机 Server 直连 |
| 本机 Mnemon A/B/C | 与所属 Server 同机 | 正式正文、原生关系、检索 | 不保存版本顺序，不被跨机直接访问 |
| 远端同步 Server | 一台常驻主机，TLS | 设备授权、变更去重、版本登记、按范围分发、生成快照 | 不运行 Mnemon，不进入宿主每轮调用链，不做注入与召回 |

宿主到本机 Server 仍是 loopback + 服务令牌 + `x-mnemoweave-host`，这条边界不因同步而改变。新增的只有本机 Server 与远端之间这一段。

九个宿主实例（三机 × 三宿主）只使用本机接口。同步凭据只存在于三台本机 Server 的环境里。

**授权分层（本文件反复依赖这条）**：本机 Server 决定「这个发起者能不能做这个动作」，远端只决定「这台设备能不能读或写这个范围」。远端设备令牌证明的只是机器身份，不证明动作已被用户确认。

## 2. 三类记忆与统一条目

| 类型 | 保存什么 | 怎样进入模型上下文 | 跨机同步什么 |
|---|---|---|---|
| 运行时记忆 | 用户确认的行为准则、常驻偏好、协作约定 | 从本机读取，在支持的宿主调用点优先提供适用准则，按全局或项目范围匹配 | 正文、适用范围、启用状态、版本、撤回记录；用于注入的文本由本机生成 |
| 项目档案 | 项目经验、调查结果、设计过程、证据、待验证结论 | 识别当前项目后按需检索，待验证结论保留其状态 | 正文、项目归属、来源、验证状态、版本 |
| Mnemon 正式记忆 | 已发布的长期事实、决策、经验与原生关系 | 从本机 Mnemon 按需召回，由本机 Server 按项目范围与生效版本筛选 | 每个 Revision 的正文与关系、当前指针、撤回记录；各机维护自己的 Mnemon ID 映射 |

三类共用一条条目骨架，差异放进 `payload`：

| 字段 | 说明 |
|---|---|
| `entryId` | UUID，创建端生成，永不变，跨机唯一 |
| `kind` | `runtime` / `archive` / `formal` |
| `scope` | `global` 或 `project:<projectId>`；见第 3 节 |
| `content` | 当前版本正文封装，见第 5 节 |
| `payload` | 按 `kind` 的元数据，见下表 |
| `version` | 整数，从 1 起，由远端分配 |
| `withdrawnAt` | 用户可见的撤回时间；非空即不再参与注入与召回，历史仍可读 |
| `purgedAt` | 本机物理清理时间，只在各机本地有意义，不参与同步 |

| kind | `payload` 字段 |
|---|---|
| `runtime` | `enabled`、`scope` |
| `archive` | `title`、`source`（会话 / 工具 / 人工）、`verification`（`verified` / `open` / `refuted`）、`evidence`（≤2000 UTF-8 字节摘要）、`tags` |
| `formal` | `category`、`importance`、`tags`、`entities`、`relations`；`providerId` 是各机自己的，不参与同步 |

### 2.1 正式记忆的 Revision 与关系

- **Revision**：正式记忆的一次正文版本，不可变。一个 `entryId` 可以有多个 Revision，`version` 与 Revision 一一对应。
- **关系**：指向具体 Revision，形式为 `{type, from: {entryId, version}, to: {entryId, version}, metadata}`，不指向「逻辑条目」。`supersedes` 表示 `to` 取代 `from`。
- **撤回**（用户可见）：新增一个版本并置 `withdrawnAt`。历史 Revision 仍可读，仍可 `show`，只是不参与注入与召回。
- **物理清理**（`purge`）：本机运维动作，调用 `forget` 让正文不再可查。它是本机行为，不同步，也不代表其他机器同样清理。清理后本机不再保证历史可读，界面必须标注。

### 2.2 变更携带全量目标态

变更携带条目的目标全量状态，不携带增量补丁。正文上限 8000 UTF-8 字节，重复传输可忽略；换来的是应用幂等、乱序也收敛、快照就是条目当前态。补丁式协议需要字段级合并规则，在三台机器、低频同步的场景里不划算。正式记忆的 Revision 链在这一条之上单独表达：一次 `update` 提交的是「新增哪个版本」，历史版本不重传。

## 3. 同步范围、序号与游标

**同步范围（scope）是游标与快照的单位**，不是项目。项目授权与全局准则不能共用一条序号：如果序号全局递增，而设备只被授权部分项目，授权外项目的变更会在序号上留下空洞，按「连续才推进」的规则会永久卡住；快照若按项目返回，用它的 `nextSince` 推进全局游标又会跳过其他项目尚未应用的变更。

| 范围 | 内容 |
|---|---|
| `global` | 跨项目生效的全局准则 |
| `project:<projectId>` | 该项目下的项目准则、项目档案、正式记忆 |

规则：

1. 每个 `scope` 有自己独立的 `seq`，从 1 连续递增，**该范围内不存在设备看不见的空洞**——设备只能读某个 scope 时，它读到的该 scope 序号必然连续。序号的当前值记在 `sync_scope_heads`，不随变更日志清理回退：清空某范围的日志后继续从下一个序号发放，否则设备会因序号从头开始而永久停在缺口上。
2. 条目创建时必须确定并保持 `scope` 不变；跨项目移动等于删除 + 新建。
3. 每个 `scope` 一个独立游标：`sync_state(scope_id, cursor, last_pull_at, last_error)`。
4. 设备按范围授权：`device_scopes(device_id, scope_id, can_read, can_write)`。三台机器都需要 `global` 的读写；项目范围按项目授予。
5. 新项目出现时，本机先申请该 `scope` 的授权；未授权期间该项目不同步，本地仍可正常使用，界面显示「未同步范围」。
6. 拉取、应用、快照、游标推进全部以 `scope` 为单位，互不影响。

## 4. 版本与变更

变更操作只有三种：

| op | 语义 | 例子 |
|---|---|---|
| `create` | 新条目，`baseVersion = 0` | 新建准则、发布正式记忆 |
| `update` | 提交新的目标状态（含新增 Revision） | 改正文、`enabled: false`、改验证状态 |
| `delete` | 置 `withdrawnAt` | 撤回正式记忆、删除档案 |

远端规则：

1. `version` 由远端在事务内按 `当前版本 + 1` 分配，客户端提交的版本字段一律忽略。
2. `baseVersion` 必须等于该条目当前版本，否则返回 `VERSION_CONFLICT`，并附 `currentVersion` 与 `currentEntry`。新建时 `baseVersion = 0`；条目已存在则返回 `VERSION_CONFLICT`。
3. **`baseVersion` 只能来自读取接口返回的条目版本，不得由服务端用「本机最新版本」补全**（见 7.1）。
4. `changeId` 全局唯一。重放同一 `changeId` 返回首次结果并标 `duplicate: true`；同一 `changeId` 配不同内容返回 `CHANGE_ID_REUSED`；去重凭证已被清理时返回 `CHANGE_ID_EXPIRED`（见第 15 节）。
5. 每次登记在所属 `scope` 内分配下一个 `seq`，它是该范围的拉取游标。
6. 所有写入在单个事务内完成，天然串行。

## 5. 正文封装与可见性

正文不写成裸字符串字段：

```
content: { format: 'plain' | 'enc-v1', data: string, contentHash: string, byteLength: number }
```

`format: 'plain'` 时 `data` 是 UTF-8 文本；`format: 'enc-v1'` 时是本机加密后的密文（base64）。`contentHash` 与 `byteLength` 始终对 `data` 计算，远端只需要这两个值。

**「远端可以读取正文」目前是待确认项，不是已决定的决策。** 已确认的只有「三类记忆都要跨机同步」。若最终允许远端读取明文，服务端可以直接做一致性校验与生成快照；若不允许，则要引入设备密钥、快照本地生成与元数据封装。在确认之前，协议按下面约束实现，避免把明文写死：

- 远端的校验、去重比对与快照生成**只依赖 `contentHash` 与 `byteLength`**，不得解析正文语义。这样同一套服务在正文加密后仍可工作，不需要改表结构。
- `content.format` 是显式字段，加密只改这个字段与快照生成位置，不改版本规则与端点。
- **`enc-v1` 只封装正文**。下列字段在当前协议里仍是明文，界面上要如实说明，不能宣称「加密后远端什么都看不到」：

| 远端可见（即使正文加密） | 说明 |
|---|---|
| `kind`、`scope`、`version`、`seq`、时间戳 | 分发必需 |
| `entryId`、`changeId`、设备 ID | 去重与审计必需 |
| 档案 `title`、`evidence`、`tags` | 元数据，随 payload 明文传输 |
| 正式记忆 `category`、`importance`、`entities`、`relations` | 同上 |

因此「切换加密不改协议」只在正文层面成立；密钥管理、元数据封装与恢复契约确定前，不能把它当作零成本切换。

## 6. 同步协议端点

仅本机 Server 调用，宿主不接触。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/sync/changes` | 提交一条变更，幂等 |
| GET | `/v1/sync/changes?scope=&since=&limit=` | 按该范围 `seq` 增量拉取，`limit` ≤ 500 |
| GET | `/v1/sync/receipts/{changeId}` | 查询某次提交的结果；无记录返回 404，是 `SYNC_OUTCOME_UNKNOWN` 的唯一收敛途径 |
| GET | `/v1/sync/entries/{entryId}` | 取单条完整状态（含全部 Revision 与关系） |
| GET | `/v1/sync/snapshot?scope=` | 该范围的全量快照，含一致切点 |
| GET | `/v1/sync/scopes` | 本设备可读写的范围与当前序号 |
| GET | `/v1/sync/health` | 存活与协议版本；要求有效设备令牌 |

鉴权：`Authorization: Bearer <设备令牌>`，设备身份从令牌解析。生产环境由部署层终止 TLS；拒绝带 `Origin` 的请求。设备被撤销后返回 `DEVICE_REVOKED`；越权访问某范围返回 `SCOPE_FORBIDDEN`。

远端错误码（需在 `packages/core/contracts` 注册）：`VERSION_CONFLICT`、`CHANGE_ID_REUSED`、`CHANGE_ID_EXPIRED`、`SNAPSHOT_REQUIRED`、`DEVICE_REVOKED`、`SCOPE_FORBIDDEN`、`SYNC_UNAVAILABLE`。

本机面向宿主与界面的语义错误码（与远端错误区分开）：`SYNC_QUEUED`、`SYNC_OUTCOME_UNKNOWN`、`RULE_BUDGET_EXCEEDED`、`NEEDS_REVIEW`。前两者的区别见 7.3。

## 7. 本机写入与应用

### 7.1 编辑

1. 读取接口 `GET /v1/memories/{id}` 必须返回 `entryId` 与 `entryVersion`（打开编辑时的目标基准）。
2. 界面在打开编辑器时把 `entryVersion` 随表单保存。
3. `PATCH /v1/memories/{id}` 请求体必须携带该 `entryVersion` 作为 `baseVersion`；缺失即 `INVALID_INPUT`，**不得回退到本机最新版本**。
4. 本机 Server 原样转发，不改写基准。后台拉取可能已经把本机更新到更新的版本，用户草稿仍以打开时的版本提交。
5. 确认 → 记 `version` 与 `seq`，再走与应用相同的路径落到本机 Mnemon。
6. 冲突 → 草稿保留，返回 `VERSION_CONFLICT`，界面展示两版正文差异；用户基于新版本重提（新 `changeId`，`baseVersion` 为新版本）。
7. 提交前连接失败 → `SYNC_QUEUED`；已发出但超时 → `SYNC_OUTCOME_UNKNOWN`（见 7.3）。

### 7.2 拉取

启动拉一次；之后后台定时，默认 300 秒（`MNEMOWEAVE_SYNC_INTERVAL_MS`，0 关闭）；界面提供手动 `POST /v1/sync/refresh`。拉取与应用同一时刻只允许一个循环，互斥执行；每个范围独立推进，一个范围失败不阻塞其他范围。

### 7.3 超时后的用户语义

两种失败对用户的操作含义不同，必须分开：

| 情况 | 错误码 | 含义 | 用户可做什么 |
|---|---|---|---|
| 请求未到达远端（连接失败、DNS 失败、TLS 失败） | `SYNC_QUEUED` | 本机已排队，稍后自动提交，内容尚未进入共享版本 | 可以继续编辑；界面显示「待同步」 |
| 请求已发出但超时、连接中断、进程在响应前退出 | `SYNC_OUTCOME_UNKNOWN` | 远端可能已登记，也可能没有 | 不要重复提交；界面显示「确认中」，本机用原 `changeId` 查询 |

`SYNC_OUTCOME_UNKNOWN` 只能通过 `GET /v1/sync/receipts/{changeId}` 收敛，不能靠超时推断：查到已登记则转为已确认并回灌 inbox；明确无记录则转回排队并重试；去重凭证已过期（`CHANGE_ID_EXPIRED`）则转人工，不自动重试。

### 7.4 中断安全

Mnemon 是外部进程，与本机库没有共同事务。顺序固定为：

```
收到 change → 写 sync_inbox(scope, seq, received) → 逐条应用到 Mnemon → 标 applied
→ cursor = 该 scope 内连续 applied 的最大 seq
```

游标按范围推进，不因单条成功而推进；范围内序号跳号先补齐再应用。启动时扫描 `sync_inbox` 中 `received` / `pending` 与 `formal_map` 中 `pending` / `unknown`，逐条用 `show` 核对。核对不清就停在原游标，界面继续显示上一个已核对版本。

### 7.5 准则的完整性与预算

- 准则**按完整条目注入，永不按正文截断**。截掉适用条件或例外的准则会改变含义，不能作为降级手段。（注入侧已实现）
- 保存或启用时必须检查：全部适用准则的完整条目能否装入准则预算（提议值 1024 token）。装不下则拒绝启用并返回 `RULE_BUDGET_EXCEEDED`，同时给出总量与超限条目，不允许先存后截。（已实现；写入先落本机，再按已确认版本入 outbox 并推送一次）
- 注入时准则以独立 `rules` 块交付，并带 `rulesBudget`（上限、用量、是否超限），不与其他记忆的预算互相挤占；准则单独超过 1024 token 时整块不注入并把 `exceeded` 置真，不截断任何一条。
- 注入结果必须可见：每一轮写入 `runtime_injections`，`GET /v1/injections/latest` 返回最近一条（准则条数、是否因预算省略、记忆条数、估算 token）。宿主侧 2 秒超时、Server 不可达都算未注入，不能静默。

## 8. 正式记忆的应用、定位与核对

### 8.1 顺序

| 步骤 | 动作 |
|---|---|
| 1 | 对目标 Revision 执行 `remember --source mnemoweave:<changeId>:<version> --no-diff` 写入正文 |
| 2 | `link <新ID> <旧ID> --type supersedes --meta <json>`，逐项核对 ack |
| 3 | `show <新ID>` 比对 `contentHash` |
| 4 | 在**同一本地事务**内写 `formal_map`（`applied`）并移动当前指针 |
| 5 | 标 `sync_inbox.applied`，再推进该范围游标 |

`--no-diff` 必须带：其他机器可能已存在相同正文，不带会被去重返回 `skipped`，拿不到新 ID。

### 8.2 写入成功但响应丢失

`remember` 没有指定 ID 的参数，`--no-diff` 也不提供幂等保证。因此「已写入、进程在记录返回 ID 前退出」是必须显式处理的故障，不能靠重试掩盖。

**前置门已通过**（2026-11-10，隔离 store，结论见 `status.md` 1.1）：

| 方式 | 实测结果 | 用途 |
|---|---|---|
| `recall --basic --limit 200 -- <正文>` | 返回完整记录，含 `id` 与 `source` | **主定位方式**：按正文召回后以 `source = mnemoweave:<changeId>:<version>` 唯一确定 |
| `mnemon log` | 只显示 8 位 ID 前缀与正文 | 仅作旁证，不足以定位 |
| `mnemon receipt` | 标识符与细节均哈希 | 不能用于定位 |

`--no-diff` 实测不提供幂等：相同正文与近似正文各写一次会得到不同条目。因此定位不能依赖重试或 Provider 去重，只能依赖 `source`。

`--source` 采用 `mnemoweave:<changeId>:<version>`，让每次写入带可检索的唯一标记；这是本项目的事前标记，不是 Provider 原生幂等。

**恢复算法**（重启后对 `formal_map` 中缺 `providerId` 的 `pending` 行执行一次）：

1. 按 source 查找。
2. 恰好一条且 `show` 的正文哈希匹配 → 采纳，记 `providerId`，按已应用继续。
3. 零条 → 写入未生效，用同一 source 重试一次；若返回 `skipped`，用 `replaced_id` 定位。重试后再查一次，若同一 `source` 对应多条，按第 4 条处理，不得任选其一。
4. 多条命中、或哈希不匹配 → 标 `needs_review`，**不推进游标**，界面列为待人工处理，并给出候选 ID 列表供用户选择或要求重建。
5. 上述只允许一次自动重试；之后不得再自动重试。

若三种定位方式都不可用，正式记忆同步不得上线：降级为「只同步逻辑记录，本机应用一律转人工」，并在 `status.md` 记为阻塞项。

### 8.3 应用窗口与召回可见性

步骤 1–3 之间，新正文与新关系已经在 Mnemon 里可见，而治理库当前指针尚未移动。这段时间内：

- 召回与注入**只使用治理库当前指针指向且 `formal_map.state = 'applied'` 的版本**。Mnemon 中存在但治理库未登记的 insight 不参与注入与召回，在 View 中标记 `excluded: 'unregistered'`。
- 因此应用中断不会让未核对内容进入模型上下文；代价是短时间内新旧两版都不可召回，这是可接受的降级。
- 进程重启时先对账再继续：`show` 确认正文与关系后，要么完成指针移动，要么回退本地状态；不得凭「Mnemon 里看起来有新正文」直接推进。

### 8.4 撤回与清理

- 撤回（`delete`）走正常变更，跨机同步；本机**不调用** `forget`，保证历史仍可读、可导出。
- 物理清理是单独的 operator 动作，调用 `forget` 并记 `purgedAt`；它不跨机同步，其他机器继续保留自己的历史副本。界面必须区分「已撤回」与「本机已清理」。

## 9. 逐机 ID 映射

本机 `formal_map`：

| 列 | 说明 |
|---|---|
| `entry_id` + `version` | 联合主键，历史版本行保留用于溯源、关系定位与撤回 |
| `provider_id` | 本机 Mnemon insight ID |
| `content_hash` | 应用后核对用 |
| `state` | `applied` / `pending` / `unknown` / `needs_review` |

逻辑 ID（`entryId`）跨机一致；原生 ID 各机独立。任何跨机引用只使用 `(entryId, version)`。

## 10. 发起动作的授权

三类记忆都只有一条进入共享集合的路径，且**本机必须校验发起者**。远端不判断动作是否经用户确认，只判断设备能否写该范围；如果本机对宿主请求无条件代签，模型输出就可能变成三台机器都会注入的准则。

| 动作 | 允许的发起者 | 本机端点 | 说明 |
|---|---|---|---|
| 提交候选 | 宿主（服务令牌 + Host 头） | `POST /v1/remember` | 只产生候选，不进共享集合 |
| 事件、注入、会话上下文 | 宿主 | `/v1/events`、`/v1/inject`、`/v1/runtime/context` | 只读或写本机会话状态 |
| 新建 / 编辑 / 启用 / 停用准则 | 用户（operator） | `POST /v1/rules`、`PATCH /v1/rules/{id}` | 宿主只能读（`GET /v1/rules` 返回全部项目） |
| 把候选提升为准则 | 用户（operator）确认 | `POST /v1/rules/promote` | 模型不能自行提升 |
| 写项目档案 | 用户，或已批准候选由 Worker 落库 | `POST /v1/archives` | 模型输出只能先成为候选；宿主可读 `GET /v1/archives`（省略 `projectId` 即全部项目） |
| 查看同步状态 / 触发一次同步 | 用户（operator）或本机宿主 | `GET /v1/sync/status`、`POST /v1/sync/refresh` | 宿主只反映本机 Server 与远端同步 Server 的关系，不涉及宿主自身 |
| 发布正式记忆 | 已批准候选的 Worker | 内部路径 | 发布前必须已有 `persisted` 与回执 |
| 用户编辑正式记忆 | 用户 | `PATCH /v1/memories/{id}` | 追加 Revision，记录为 `local-user` 决定 |
| 撤回 | 用户（operator） | `DELETE /v1/{rules\|archives\|memories}/{id}` | 记录撤回版本，保留历史 |
| 物理清理 | 用户（operator） | `POST /v1/maintenance/purge` | 本机行为，不同步 |

结论：模型与宿主没有任何直接写共享集合的入口；准则只能由用户确认后写入；远端设备令牌只证明「哪台机器提交了什么范围」。

## 11. 凭据与项目绑定

- 远端保存 `devices`（`device_id`、令牌哈希、`revoked_at`）与 `device_scopes`（范围授权，含读写位）。
- 本机 Server 读取 `MNEMOWEAVE_SYNC_URL`、`MNEMOWEAVE_SYNC_DEVICE_ID`、`MNEMOWEAVE_SYNC_TOKEN`。三者缺一即视为未配置同步，本机行为与纯本机模式一致。
- 设备签发首版用命令行走 operator 令牌，不做管理界面；撤销即时生效，只影响该设备。
- 项目绑定：`project_bindings` 记录 `projectId` 与工作区路径。宿主可用 `x-mnemoweave-project` 声明；未声明时用 `MNEMOWEAVE_PROJECT` 兜底；两者都没有则由用户在界面选择，选择结果写回绑定。

## 12. 部署

| 组件 | 平台 | 方式 |
|---|---|---|
| 远端同步 Server | Linux | systemd 单元 `apps/sync-server/deploy/mnemoweave-sync.service` |
| 本机 Server | Windows 开发机 | 登录时启动的计划任务，失败自动重启 |
| 本机 Mnemon | Windows 开发机 | 由本机 Server 按需调用 CLI 进程，无常驻服务 |

本机 Server 首版不做 Windows 服务包装，不引入第三方服务管理器。计划任务绑定用户会话，注销即停止——这是明确取舍，写入部署说明，不写成「开机自启」。

## 13. 配置

| 变量 | 默认 | 用途 |
|---|---|---|
| `MNEMOWEAVE_SYNC_URL` | 空（不启用同步） | 远端地址，必须 HTTPS 或 loopback |
| `MNEMOWEAVE_SYNC_DEVICE_ID` / `MNEMOWEAVE_SYNC_TOKEN` | 空 | 设备凭据 |
| `MNEMOWEAVE_SYNC_INTERVAL_MS` | `300000` | 后台拉取间隔，0 关闭 |
| `MNEMOWEAVE_SYNC_TIMEOUT_MS` | `10000` | 单次远端调用超时 |
| `MNEMOWEAVE_PROJECT` | 空 | 宿主未声明项目时的兜底 |

未配置同步时不得因为缺少同步而拒绝启动，也不得改变注入与召回行为。

## 14. 故障恢复

| 故障 | 处理 |
|---|---|
| 重复提交同一变更 | 远端按 `changeId` 幂等返回首次结果 |
| 写入成功但响应丢失 | 按 `changeId` 查询；查询不可用则见 8.2 |
| Mnemon 写入响应丢失 | 按 8.2 的定位与核对流程处理，必要时人工解卡 |
| 应用中断（本地进程退出） | 重启后从 `sync_inbox` 续应用，游标按范围不动 |
| Mnemon 写入状态不明 | 标 `needs_review`，不推进游标，界面待处理 |
| 两端同时编辑同一条目 | 后提交方得到 `VERSION_CONFLICT`，保留草稿，基于新版本重提 |
| 某范围长期离线 | 从该范围自己的游标续拉；该范围历史已被清理则先取该范围快照 |
| 某范围未授权 | 该项目不同步，其他范围照常，界面显示未同步范围 |
| 设备泄露 | 远端撤销该设备，令牌立即失效，其余两台不受影响 |

## 15. 保留与幂等凭证

- **去重凭证独立于变更日志保留。** `change_receipts(change_id, scope_id, entry_id, version, seq, created_at)` 保留 365 天，体积小，不随日志清理删除。这样「按 `changeId` 返回首次结果」在日志已清理后仍然成立。
- 变更日志保留 90 天或 50000 条（先到为准），按范围统计；清理后更早的游标只能走该范围快照。
- 去重凭证也过期后，同一 `changeId` 再出现返回 `CHANGE_ID_EXPIRED`。本机收到后把该条标 `needs_review`，**不自动重试**——此时无法排除它早已生效。
- `entries` 当前态与 `withdrawnAt` 不随日志清理消失，快照一并携带。

实现（`SyncStore.prune`）：按范围删除**前缀**（`seq <= cut`），`cut` 取「按时间过期的最长序号」与「`head - 50000`」的较大者，因此清理不会在序号中留下空洞；收到低于地板游标的设备按第 16 节走快照。没有可保留的变更时，该范围的保留地板按 `head + 1` 返回，落后于 `head` 的设备因此仍判定为需要快照。去重凭证单独按 365 天清理。远端同步 Server 启动时执行一次，之后每 `MNEMOWEAVE_SYNC_PRUNE_INTERVAL_MS`（默认 6 小时，0 关闭周期）执行；保留天数、每范围条数上限与凭证天数分别由 `MNEMOWEAVE_SYNC_RETENTION_DAYS`、`MNEMOWEAVE_SYNC_MAX_CHANGES`、`MNEMOWEAVE_SYNC_RECEIPT_DAYS` 配置（默认 90 / 50000 / 365），结果以 `{"event":"prune",...}` 写入 stderr。远端库 schema 为 v2（v1 → v2 增加 `sync_scope_heads` 并从现有变更回填）。

这几项数值是待确认的默认值，不是业务结论。

## 16. 快照

快照必须让一台新机器重建到与当前指针一致的状态，因此**不能只有条目当前态**：

| 内容 | 说明 |
|---|---|
| `scope`、`asOfSeq` | 一致性切点 |
| 条目（`runtime` / `archive`） | 当前版本正文与 payload |
| 条目（`formal`） | 全部 Revision 正文、全部关系、`currentVersion`、`withdrawnAt` |
| `nextSince` | 等于 `asOfSeq`，可直接作为该范围游标 |

一致性规则：快照在**单个读事务**内读取，`asOfSeq` 取该事务内该范围的最大 `seq`，只读 `seq ≤ asOfSeq` 的数据；不得先取时间点再分批查询。因为序号按范围连续，用 `asOfSeq` 作为该范围游标不会跳过任何变更，也不影响其他范围。

应用顺序：先按 Revision 从旧到新逐条 `remember`，再逐条 `link`，最后移动指针；应用中断后按 8.2 与 8.3 对账。`purgedAt` 不写入快照。

正式记忆的历史全量会放大快照体积，评估项见第 19 节。

**本机实现（`SyncCoordinator.captureSnapshot`）**：拉取发现游标低于保留地板时，本机取该范围快照，把 `asOfSeq` 作为新游标，删除被覆盖的 inbox 行，并按 Revision 从旧到新逐条应用——版本 N 的 supersedes 边由版本 N-1 的本地映射补齐，因此重建出的链与变更流一致。任一条应用失败时该范围记为 `SNAPSHOT_APPLY_INCOMPLETE`，不静默跳过。

尚未实现的相邻部分：快照应用中断后的对账沿用 8.2/8.3 的逐条重放（每条按 `formal_map` 幂等）。

## 17. 与现有实现的衔接

| 位置 | 动作 | 现状 |
|---|---|---|
| `packages/core/contracts` | 新增 `sync.ts`：变更、拉取页、快照、范围、同步错误码 | 已实现（P0） |
| `packages/core/application` | 同步纯规则（提交构造、按范围游标、缺口与保留地板、失败分类）、`SyncCoordinator`（outbox 刷写、unknown 收敛、拉取入 inbox、按序应用与游标推进）、`applyInboxEntry`（正文校验、三类落库、正式记忆写入顺序）与 `local-write`（本地写入入队、编辑变更构造） | 已实现；两台机器双向由 `tests/e2e/two-machine-sync.test.ts` 覆盖 |
| `packages/infrastructure/sync-store` | 新包：远端权威库（`devices`、`device_scopes`、`changes`、`entries`、`entry_revisions`、`change_receipts`） | 已实现（P1 首项） |
| `packages/infrastructure/sync-client` | 新包：本机到远端的 HTTP 客户端、超时与失败分类（未发出 / 结果未知）、结果查询 | 已实现（P1） |
| `packages/protocols/sync-http` | 新包：远端路由与设备鉴权 | 已实现（P1） |
| `apps/sync-server` | 新应用：远端组合根、设备签发 `enroll` / `revoke` CLI、systemd 单元 | 已实现（P1） |
| `packages/infrastructure/governance` | schema v12：v11 的同步与三类记忆八表，加 `entry_versions`（已确认版本） | 已实现；账本见 `SqliteSyncLedger`，写入应用见 `applyInboxEntry` |
| `packages/providers/mnemon` | 新增 `forget`、`related`、`remember --no-diff`、按 source 定位 | 已实现（`tests/contract/provider.test.ts` 与真实 CLI 的 E2E 覆盖） |
| `packages/client` / `packages/adapters/*` | `View` 增加准则段与降级标记；`x-mnemoweave-project` 头；编辑请求携带 `entryVersion` | 部分实现（准则段、注入报告、项目头与 `entryVersion` 已实现；客户端渲染未实现） |
| `apps/server` | 同步服务（`sync-service.ts`：定时/手动一趟、按范围隔离失败、重叠跳过）与 `/v1/sync/status`、`/v1/sync/refresh`（operator 令牌）；启动时按 `MNEMOWEAVE_SYNC_*` 装配；准则、档案与编辑的写入端点都经 outbox | 已实现 |

## 18. 实施前置门

2026-11-10 已在隔离 store 上跑完，结论见 `status.md` 1.1：

| 检查 | 结果 |
|---|---|
| 写入定位 | 通过：`recall --basic` + `source` 可唯一确定；`log` 与 `receipt` 不可用 |
| 关系读取 | 通过：`link --type supersedes` 有 ack，`related --edge supersedes` 读回对端 |
| 撤回语义 | 通过：`forget` 后 `show` 报无行、`recall` 不再返回，且指向它的 supersedes 边从 `related` 消失 |

剩余未覆盖项：8000 字节上限正文下的 `recall --basic` 匹配行为。实现时首个用例就要补测，若长正文匹配不可靠，定位方式改为「正文分块查询 + `source` 过滤」，并回填 `status.md`。

## 19. 未决

| 事项 | 现状 | 约束 |
|---|---|---|
| 远端是否可读明文 | **待确认**，当前按「不依赖明文」实现 | 确认前不得按明文写死；加密范围与元数据封装见第 5 节 |
| 元数据是否封装 | 未定 | `title`、`evidence`、`entities`、`relations` 目前明文 |
| 变更日志保留值 | 90 天 / 50000 条为提议值 | 决定离线机器还能否增量恢复 |
| 去重凭证保留期 | 365 天为提议值 | 过期后只能 `needs_review` 人工处理 |
| 准则预算 | 1024 token 为提议值 | 超出拒绝启用，不截断 |
| 正式记忆历史快照体积 | 未评估 | 历史全量进快照可能过大，评估是否冷存或分批 |
| 物理清理是否跨机 | 当前不同步 | 其他机器保留自有历史副本 |
| Windows 常驻方式 | 首版用登录时计划任务 | 需要开机自启时再评估服务包装 |
| 项目识别来源优先级 | 头 > 环境变量 > 用户选择 | 三机共用 `projectId`，工作区路径只在本机有意义 |
