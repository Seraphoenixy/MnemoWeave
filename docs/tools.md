# 工具与命令参考

MnemoWeave 向模型与用户提供两类交互入口：

1. **模型工具（`mnemo_*`）**：DSH 通过插件宿主注册 13 个具名记忆工具与 1 个内部子 Agent 回执工具（`mnemo_subagent_result`）；Codex 通过 `dist/mnemo-weave-mcp.js`（stdio MCP）接入 13 个同名工具及只读工作准则工具 `mnemo_working_rules`，共 14 个工具。两端名称与必填参数保持一致；MCP 直接调用 Source Route/Action，不具备 DSH 的 Agent 回合、子 Agent 委派与 profile 配置，执行路径和输出结构按 MCP 入口单独说明。
2. **对话命令（`/mnemon`）**：仅 DSH 会话支持，提供确定性读取与显式写入入口。

## 具名工具总览

| 工具名称 | 所属来源 | 类型 | DSH | MCP | DSH 执行路径 |
|---|---|---|---|---|---|
| `mnemo_working_rules` | `runtime` | 只读 | 否（系统提示注入） | 是 | MCP 本地直读 `working-rules` |
| `mnemo_runtime_memory` | `runtime` | 写入 | 是 | 是 | 确定性控制；`add` 溢出时触发容量维护 |
| `mnemo_document_search` | `documents` | 只读 | 是 | 是 | Documents 控制层（每回合限 1 次） |
| `mnemo_document_manage` | `documents` | 写入 | 是 | 是 | 创建/更新先做容量预检并按需归档；`archive` 由 Host 本地归档 |
| `mnemo_memory_bodies` | `memory-spaces` | 只读（检查） | 是 | 是 | 读取固定 Source 目录与能力摘要 |
| `mnemo_status` | `memory-spaces` | 只读（检查） | 是 | 是 | 读取 Provider 健康摘要与 `idleReviewAccess` |
| `mnemo_recall` | `memory-spaces` | 只读 | 是 | 是 | 经协调器检索固定激活空间（每回合限 2 次） |
| `mnemo_related` | `memory-spaces` | 只读 | 是 | 是 | 经协调器遍历图关联（每回合限 1 次） |
| `mnemo_remember` | `memory-spaces` | 写入 | 是 | 是 | Root Agent 派发 `spawn` 写入子 Agent；子 Agent 直连 Source |
| `mnemo_link` | `memory-spaces` | 写入 | 是 | 是 | Root Agent 派发 `spawn` 写入子 Agent；子 Agent 直连 Source |
| `mnemo_forget` | `memory-spaces` | 写入 | 是 | 是 | 仅显式操作或 Root Agent 可用；自主蒸馏子 Agent 不可用 |
| `mnemo_memory_body_create` | `memory-spaces` | 写入 | 是 | 是 | Root Agent 派发 `spawn` 写入子 Agent；子 Agent 直连 Source |
| `mnemo_memory_body_update` | `memory-spaces` | 写入 | 是 | 是 | Root Agent 派发 `spawn` 写入子 Agent；子 Agent 直连 Source |
| `mnemo_memory_body_merge` | `memory-spaces` | 写入 | 是 | 是 | Root Agent 派发 `spawn` 写入子 Agent；子 Agent 直连 Source |
| `mnemo_subagent_result` | 内部协调 | 回执 | 仅子 Agent | 否 | 校验可撤销 `requestId` 与操作 schema 后交回宿主 |

MCP 的 13 个工具直接调用 Source Route/Action，没有 Root Agent 与子 Agent 的区分：写入返回 Source 回执（含 `memoryReceipt`），不返回 DSH Root 的委派摘要；也没有 DSH 回合预算、`idleReviewAccess`、profile 权限门禁和子 Agent 归档限制。MCP 的读预算按进程段计算，详见各工具说明。

## DSH 注册与权限边界

### 工具族生命周期

DSH 中具名工具按已提交全局注册记录的 `manifest.typeId` 动态挂载与卸载：

- 存在至少一个 `runtime` Source 时注册 `mnemo_runtime_memory`（1 个）。
- 存在至少一个 `documents` Source 时注册 `mnemo_document_search`、`mnemo_document_manage`（2 个）。
- 存在至少一个 `memory-spaces` Source 时注册 `mnemo_memory_bodies`、`mnemo_status`、`mnemo_recall`、`mnemo_related`、`mnemo_remember`、`mnemo_link`、`mnemo_forget`、`mnemo_memory_body_create`、`mnemo_memory_body_update`、`mnemo_memory_body_merge`（10 个）。
- `mnemo_subagent_result` 独立注册，不随 Source 开关移除。

首次经 Loader 启动时，工具族在 `Loader.await()` 就绪后按注册顺序发布；后续重新启用组件只追加恢复的工具族。工具注册存在不代表当前回合 View 允许调用：实际调用时宿主仍会校验当前回合的 View 绑定、Source 参与模式与工作区排除状态。

### 权限与只读限制（DSH）

- **`writeEnabled: false`**：全部写入工具在宿主边界拒绝（`dsh-mnemo-weave is configured read-only`）。
- **Source 参与模式（`automatic` vs `manual`）**：模型工具使用 `automatic` trigger。某层设为 `manual` 时保留 Web/RPC 人工管理，模型工具调用该层时被拒绝。
- **工作区排除（`excludedWorkspaces`）**：当前会话或父会话位于排除列表中时，所有记忆工具拒绝执行。
- **自主写入子 Agent 白名单**：会话空闲审查与后台写入子 Agent 的工具白名单排除 `mnemo_forget`，空闲审查的档案写入仅允许 `create` 与 `update`（禁止 `archive`）。
- **版本前缀兼容**：工具统一使用 `mnemo_` 前缀；历史会话记录中的 `mnemon_` 前缀、已移除的 `mnemo_document_create`、`mnemo_view_route` 与 `mnemo_view_action` 在活动读取时仍按兼容映射识别。

### 权限与只读限制（MCP）

MCP 入口只读取 `--data-dir`、`--workspace`、`--storage-scope`、`--storage-dir` 及其环境变量，不读取 DSH profile 的 `writeEnabled`、`memoryTopology` 或 `excludedWorkspaces`。它以默认配置运行：写入开启、参与模式为 `automatic`、排除列表为空。MCP 当前没有等价的产品级只读开关；需要只读接入时，应在 MCP 进程外控制存储目录权限，或使用单独的只读数据副本。

MCP 的模型写入同样要求目标记忆空间已激活。`mnemo_memory_body_create` 创建的新空间默认未激活，需要用户明确要求后调用 `mnemo_memory_body_update` 设置 `active: true`；`mnemo_remember` 会拒绝未激活目标，不再隐式激活它。

---

## 工作准则工具

### `mnemo_working_rules`（仅 MCP）

读取共享工作准则（`working-rules/runtime/memories.json` 中 `target === "memory"` 的条目）。只返回当前工作区 Git 分支可见的条目；工作区不是 Git 工作树、HEAD 分离或分支探测失败时返回全部条目。配置同步服务时，读取前先尝试同步工作准则范围。不接受输入参数。

返回值（JSON 文本）：

- `entries`：条目数组，每项含 `content`、`importance`（`critical` / `normal` / `low`）、可选 `pinned: true`。不重复返回 Markdown 投影；需要排序后的文本时由调用方按 `pinned` 优先自行拼接。
- `sync`：仅在已配置同步服务且本次同步失败时返回 `{ synchronized: false, message }`。

### `mnemo_runtime_memory`

维护共享工作准则。不接受 `target` 参数（传入会报错），所有操作均作用于 `memory` 目标。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `'add' \| 'replace' \| 'remove'` | 是 | 操作类型 |
| `content` | `string` | `add` / `replace` 必填 | 条目正文，UTF-8 字节长度上限 `8192`（8 KiB） |
| `old_text` | `string` | `replace` / `remove` 必填 | 待匹配条目的完整正文或唯一子串；完整正文精确匹配优先于子串匹配；零命中或命中多条时拒绝 |
| `importance` | `'critical' \| 'normal' \| 'low'` | 否 | 重要性等级；`add` 默认 `normal`；`replace` 省略时保留原值，显式指定较低值时控制层保留原有较高重要度 |

行为说明：

- DSH 中调用前要求当前回合已固定 View（`composableTurn`）；`add` 或增大正文的 `replace` 超过共享容量上限（默认 `14336` 字节，即 14 KiB）时，由宿主执行容量维护与归档。
- MCP 中直接通过本机控制器执行，使用 `preserveImportance: true`；容量超限时按本地策略把未保留的条目移入本地归档，不运行 DSH 的跨 Provider 容量维护。返回值为本机控制器结果，不含 `memoryReceipt`。配置同步服务时在操作前后同步工作准则范围。

---

## 工作区档案工具

### `mnemo_document_search`

在当前 View 固定的工作区档案范围内执行一次确定性关键词或自然语言检索。DSH 中每个执行中的 Agent 回合仅允许 1 次查询，同回合内的并发或重复调用共享结果；后续不同查询返回 `notRun: true`、`budgetExhausted: true` 与空 `results`。MCP 没有 DSH 的回合边界，查询配额按 MCP 进程段计算，直到一次会重建 View 的写入（文档创建/更新/归档或记忆空间管理）结束该段。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | `string` | 是 | 检索词；传空字符串时列出最近档案 |
| `workspaceId` | `string` | 否 | 仅 DSH：已登记的 DSH 工作区 ID；仅在明确指定查询其他工作区时传入。MCP 不接受此参数 |
| `includeArchived` | `boolean` | 否 | 是否包含冷归档原文；仅在已知归档引用并需要全文检查时设为 `true` |
| `limit` | `number`（整数 `>= 1`） | 否 | 请求返回条数；两端模型输出上限均为 4 条、单条最多 2600 字符、总正文最多 6000 字符 |

说明：检索命中的档案会更新索引中的 `lastAccessedAt` 字段，用于容量淘汰排序。

### `mnemo_document_manage`

创建、更新或归档受管工作区档案。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `'create' \| 'update' \| 'archive'` | 是 | 操作类型 |
| `id` | `string` | `update` / `archive` 必填 | 档案 ID |
| `title` | `string` | `create` 必填 | 档案标题 |
| `description` | `string` | 否 | 用于检索匹配的路由摘要 |
| `content` | `string` | 否 | Markdown 正文（单份上限 2 MiB）；纯引用档案可省略正文并提供 `sourcePaths` |
| `sourcePaths` | `string[]` | 否 | 相对当前会话工作区的只读引用路径；不得逃逸工作区或指向受管 `documents/` 目录 |

返回值（两端都经 `documentReceipt` 裁剪）：

- `document`：仅包含元数据字段（`id`、`title`、`description`、`status`、`revision`、`contentHash`、`sizeBytes`、`sourcePaths`、`memoryBodyIds`、`archivedAt`、`archiveSummary`），不回传刚写入的 `content` 正文、内部存储路径或完整 `snapshot`。
- `documents`：当前层的统计摘要 `{ active, archived, activeBytes, limitBytes }`（活跃上限 10 MiB）。
- `memoryReceipt`：MCP 与 DSH 子 Agent 的 `create` / `update` 返回；DSH Root 的 `create` / `update` 返回协调结果，不含 `memoryReceipt`；两端 `archive` 都不返回。
- `maintenance`：容量预检归档过候选档案时返回，包含 `runId`、`provider`、`summary`、`memoryBodyIds` 与 `archivedDocumentIds`。

容量行为：写入前读取 `capacity-plan`，不足时按候选顺序归档现有档案再重试，归档摘要为 `Archived workspace material.`；没有候选时拒绝并报告投影大小与上限。两端都在 Host/MCP 进程内归档，不启动归档子 Agent。

权限约束：DSH 中非用户续写触发的空闲工作区子 Agent 调用 `action: "archive"` 时会被拒绝。MCP 没有子 Agent，不适用该限制。

---

## 记忆空间只读与检查工具

### `mnemo_memory_bodies`

读取当前 View 固定的记忆空间目录，无输入参数。返回各空间的 `memoryBodyId`、名称、路由说明、`active` 状态、Provider 能力标志（`capabilities`）、健康状态与可用统计（模型侧目录最多返回 16 项），以及 `persistenceStrategy` 配置。

### `mnemo_status`

检查记忆空间与 Provider 的健康摘要，无输入参数。返回已激活且正常空间的数量、聚合统计（`aggregate`）及诊断摘要；DSH 中额外附带当前 Agent 的 `idleReviewAccess` 状态（`state`: `unchecked` / `available` / `unavailable`、`checkedAt` 及枚举 `reason`）。MCP 没有 DSH Agent，不返回 `idleReviewAccess`。

### `mnemo_recall`

从当前 View 固定的已激活记忆空间召回持久记忆。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | `string` | 是 | 聚焦的自然语言检索词 |
| `mode` | `'smart' \| 'keyword' \| 'basic'` | 否 | 检索模式：`smart` 为图谱增强默认模式，`keyword` 为词元排序，`basic` 为 SQL LIKE 回退 |
| `limit` | `number`（整数 `>= 1`） | 否 | 请求最大结果数；受本次查询信封上限约束 |
| `entities` | `string[]`（最多 50 项） | 否 | 可选实体名称列表，用于锚定并优先召回关联记忆；实体是检索键，应传短规范名，不要传从句、整句或本机路径 |
| `memoryBodyIds` | `string[]` | 否 | 限定检索的已激活记忆空间 ID 列表；省略时检索全部已固定激活空间；传入未固定 ID 会被宿主拒绝 |

预算信封：

- 首次查询最多准入 `4` 条、总正文 `3600` 字符。
- 仅在首次查询后允许提交 1 个实质不同的精炼查询；两次查询共享最多 `6` 条、单条 `1200` 字符、总正文 `4800` 字符。
- 相同查询或并发重复调用会复用已有结果；第 3 个不同查询返回 `notRun: true`、`budgetExhausted: true`；结果被裁剪时标记 `truncated: true`。

DSH 按 Agent 回合计算上述信封。MCP 没有 Agent 回合边界，按 MCP 进程段计算：文档创建/更新/归档、记忆空间创建/更新/合并会重建 View 并结束当前段；`remember`、`link`、`forget` 不重建 View，不重置预算，也不清除已准入的 Recall 证据。

### `mnemo_related`

从本回合 `mnemo_recall` 已准入的某条记忆出发遍历图关联。每个执行中的 Agent 回合最多执行 1 次不同遍历（重复同一查询会重放结果）。MCP 中“本回合”指当前进程段；会重建 View 的写入会结束该段，之前准入的 ID 不再可用于 related，需要重新 Recall。`remember`、`link`、`forget` 不结束该段。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 本回合 `mnemo_recall` 返回的记忆条目 ID；未准入的 ID 返回 `notRun: true` |
| `depth` | `number`（整数 `1..5`） | 否 | 遍历深度，默认 `2` |
| `edge` | `'temporal' \| 'semantic' \| 'causal' \| 'entity'` | 否 | 仅沿指定边类型遍历（适用于支持按边过滤的 Provider，如 Mnemon Native） |
| `memoryBodyId` | `string` | 否 | 拥有该记忆条目的已激活记忆空间 ID |

---

## 记忆空间写入与管理工具

Root Agent 在 DSH 中调用以下 6 个工具时，宿主启动独立的 `spawn` 写入子 Agent，返回 `DelegatedWriteResult`（`delegated`、`runId`、`provider`、`summary`、`action`、`memoryBodyIds`，可能含 `activatedMemoryBodyIds`、`unembedded`、`hint`），不返回 `memoryReceipt`。子 Agent 内部与 MCP 直接经 Source Action 执行，返回 Source 结果与 `memoryReceipt: { status, completion, committedAt? }`。MCP 没有 Root/子 Agent 区分，写入始终走直连路径。

### `mnemo_remember`

向指定或适用的记忆空间写入一条独立持久经验。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `content` | `string` | 是 | 精炼、自包含的持久经验正文 |
| `replacesId` | `string` | 否 | 同空间内被新证据推翻的旧记忆 ID；传入时要求同时具备 `forget` 权限，不支持修订的 Provider 会跳过旧条目退役 |
| `category` | `'preference' \| 'decision' \| 'fact' \| 'insight' \| 'context' \| 'general'` | 否 | 记忆分类（缺省为 `'general'`）：`preference`（用户习惯/偏好）、`decision`（架构选型/权衡/流程规范）、`fact`（客观平台行为/API 语义/契约约束）、`insight`（排障因果/根因经验/设计模式）、`context`（项目/环境背景）、`general`（无更窄分类时的通用持久记忆） |
| `importance` | `number`（整数 `1..5`） | 否 | 持久价值评分 |
| `entities` | `string[]`（最多 50 项） | 否 | 命名实体列表，每项一个短规范名（产品、库、组件、服务、API/工具、符号、标准、人名、组织、项目名或既有专业术语），保持记忆正文原本语言（中文术语保留中文，英文/代码标识保留原文，不跨语种翻译），2–48 字符（纯中文 2–16 字符），不带首尾引号或标点。不得传入从句、整句、引文、状态/动作短语（如 `需确认`、`已修改`）、双语括注（如 `系统提示词 (system prompt)`、`Foo (Bar)`）、斜杠并列写法、本机路径或工作目录、单字符（如 `如`）、纯数字、规则/条目编号或范围（如 `G1`–`G9`、`G1-G9`、`R1`）、泛化词（如 `code`、`file`、`project`、`issue`、`data`、`系统`、`数据`、`规则`、`问题`）；没有合格名称时传 `[]`。写入、`reconcile` 修订与界面 AI 生成实体共用该规则，写入路径按 `canonicalEntityName` 过滤被拒绝的值 |
| `source` | `'user' \| 'agent' \| 'external'` | 否 | 来源标识，模型调用默认为 `'agent'` |
| `memoryBodyId` | `string` | 否 | 目标记忆空间 ID；激活空间数量不是 1 时必须显式指定，且必须为当前已激活空间。MCP 与 DSH 模型工具都会拒绝未激活目标，不会隐式激活；新空间需先调用 `mnemo_memory_body_update` 设置 `active: true` |

嵌入未生成时，Mnemon Native 仍保存记忆并返回 `embedded: false`（DSH Root 的委派回执在 `unembedded` 字段列出对应条目及 `hint`；MCP 直接返回 Source 结果中的 `embedded` 与候选字段）。

### `mnemo_link`

在支持 `capabilities.link` 的同一记忆空间内为两条已核实记忆建立有向/双向关联。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sourceId` | `string` | 是 | 第一条记忆的精确 ID |
| `targetId` | `string` | 是 | 同空间内第二条记忆的精确 ID |
| `type` | `'temporal' \| 'semantic' \| 'causal' \| 'entity'` | 否 | 关联类型，默认 `'semantic'` |
| `weight` | `number`（`0..1`） | 否 | 关联置信度权重，默认 `0.5` |
| `reason` | `string`（最长 1000 字符） | 否 | 基于证据的关系说明 |
| `memoryBodyId` | `string` | 否 | 包含两条记忆的记忆空间 ID；ID 可能歧义时传入 |

### `mnemo_forget`

按精确 ID 删除（Mnemon Native 为软删除）记忆空间中的条目。自主蒸馏与空闲审查子 Agent 的工具白名单不包含此工具。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 当前可读 View 已准入或可读取空间内的精确记忆 ID |
| `memoryBodyId` | `string` | 否 | 记忆空间 ID；多个可读空间存在相同 ID 时必填 |

### `mnemo_memory_body_create`

仅在用户明确要求创建新记忆空间时调用。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | 是 | 主题明确的记忆空间名称 |
| `description` | `string` | 是 | 路由边界说明（应保存什么、何时召回） |
| `providerId` | `string` | 否 | 仅 `persistenceStrategy.mode === 'automatic'` 时使用：从合格候选中选择的 Provider ID |
| `reason` | `string` | 否 | 仅自动模式使用：选择该 Provider 的理由 |
| `confidence` | `'high' \| 'medium' \| 'low'` | 否 | 仅自动模式使用：Provider 选择的置信度 |

说明：在空存储根首次创建 Mnemon Native 空间时，Store ID 固定为 `default`；后续创建的原生空间使用宿主生成的 UUID。新空间默认未激活；模型工具（DSH Root 与 MCP）不会在 `mnemo_remember` 时隐式激活它。用户明确要求后，用 `mnemo_memory_body_update` 设置 `active: true`，下一回合起参与召回与默认写入。

### `mnemo_memory_body_update`

更新记忆空间的名称、路由说明或激活状态。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `memoryBodyId` | `string` | 是 | 目标记忆空间 ID |
| `name` | `string` | 否 | 新名称 |
| `description` | `string` | 否 | 新路由说明 |
| `active` | `boolean` | 否 | 是否激活（影响下一回合起的读取资格与模型默认写入目标）；只有用户明确要求时才可设置 `true` |

### `mnemo_memory_body_merge`

非破坏性地将多个完整的 Mnemon Native 源记忆空间合并到目标 Mnemon Native 空间（不支持外部 Provider）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `targetMemoryBodyId` | `string` | 是 | 目标 Mnemon Native 记忆空间 ID |
| `sourceMemoryBodyIds` | `string[]`（`1..20` 项） | 是 | 源 Mnemon Native 记忆空间 ID 列表 |
| `deactivateSources` | `boolean` | 否 | 合并后是否停用源空间，默认 `true`；不删除源数据库文件 |

---

## MCP 入口的行为边界

MCP 没有 DSH 的 Agent 生命周期与 profile 配置面，以下差异属于入口限制：

- 工作准则通过 `mnemo_working_rules` 读取，不注入系统提示。
- 没有 Agent 回合边界；Recall、Related 与 Document 检索的预算按 MCP 进程段计算，会重建 View 的写入结束该段。
- 不读取 DSH profile 的 `writeEnabled`、`memoryTopology`、`excludedWorkspaces`；以默认配置运行。
- 没有 Root 与子 Agent 的委派区分；写入返回 Source 回执（含 `memoryReceipt`），不返回 `DelegatedWriteResult`。
- `mnemo_status` 不返回 `idleReviewAccess`；`mnemo_document_search` 不接受 `workspaceId`。
- `mnemo_document_manage` 的容量预检在本进程内直接归档候选，不启动归档子 Agent；该工具与 `mnemo_memory_body_*` 会重建 View。

---

## 内部子 Agent 回执工具：`mnemo_subagent_result`

MnemoWeave 委派的所有后台子 Agent（写入、空闲审查、档案归档、Agent 查询、容量维护、整理方案、技能进化）均通过 `mnemo_subagent_result` 向宿主提交结构化结果：

- 参数为 `{ requestId, result }`。
- 宿主校验 `requestId` 归属当前未结束的委派任务（过期、已撤销或其他任务的 `requestId` 会被拒绝），并按该任务的 JSON Schema 校验 `result`。
- 若模型适配器在执行前因 `MALFORMED_RESPONSE` 拒绝不完整 JSON 实参，同一子 Agent 会收到 1 次纠正请求重交结果，不重复已完成的写入。

---

## DSH 对话命令（`/mnemon`）

```text
/mnemon
/mnemon status
/mnemon recall <查询>
/mnemon related <完整记忆 ID>
/mnemon remember <内容>
/mnemon forget <精确 ID>
```

| 命令 | 执行方式 | 说明 |
|---|---|---|
| `/mnemon` / `/mnemon status` | 确定性读取 | 不启动模型；返回当前配置、CLI 可用性与记忆空间统计摘要 |
| `/mnemon recall <查询>` | 确定性读取 | 通过命令所在 live Agent 的固定 Source 路由读取，不启动 worker，最多返回 10 条 |
| `/mnemon related <完整记忆 ID>` | 确定性读取 | 通过命令所在 live Agent 的固定 Source 路由遍历关联，不启动 worker |
| `/mnemon remember <内容>` | 写入 worker | 以当前会话 Agent 为 parent 启动写入子 Agent，返回结构化写入回执；`writeEnabled: false` 时拒绝 |
| `/mnemon forget <精确 ID>` | 写入 worker | 接收不含空格的精确 ID；仅当回执为 `forgotten` 时报告成功，否则返回错误与 worker 摘要；`writeEnabled: false` 时拒绝 |
