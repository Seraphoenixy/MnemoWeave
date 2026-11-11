# 实现与契约

`packages/core/contracts` 定义严格的 Zod 输入、输出和错误码。本机 `GET /openapi.json` 提供接口描述，MCP 复用 Application Core。本文规定目标契约。交付状态见 [当前状态](status.md)。术语见 [架构](architecture.md#统一术语)。

## HTTP 与 MCP

| 用途 | HTTP 入口 |
|---|---|
| 探活与就绪 | `GET /health/live`、`GET /health/ready` |
| 注入与会话 | `POST /v1/inject`、`/v1/events`、`/v1/session/close` |
| 授权任务写入 | `POST /v1/memory-write-tasks/{taskId}/actions/{index}`、`GET /v1/memory-write-tasks/{taskId}/actions/{index}` |
| 档案提炼草稿 | `POST /v1/archive-distillations`、`GET /v1/archive-distillations/{draftId}` |
| 候选 | `POST /v1/remember`、`GET /v1/candidates/{candidateId}` |
| 正式记忆 | `GET/POST /v1/memories`、`GET/PATCH /v1/memories/{memoryId}`、`POST /v1/memories/{memoryId}/withdraw` |
| 图谱与检索 | `GET /v1/memories/graph`、`POST /v1/memories/explore`、`POST /v1/recall`、`POST /v1/memories/related` |
| 工作区 | `GET /v1/workspaces`、`POST /v1/workspaces`、`PUT /v1/workspaces/{workspaceId}/binding`、`PUT /v1/sessions/{sessionId}/workspace` |
| 准则、档案 | `GET/POST /v1/rules`、`PATCH /v1/rules/{ruleId}`、`GET/POST /v1/archives`、`PATCH /v1/archives/{entryId}`、`POST /v1/archives/{entryId}/state`、`GET /v1/archives/{entryId}/history`、`GET /v1/archives/{entryId}/content`、`GET /v1/archives/search` |
| 本机诊断 | `GET /v1/storage`、`/v1/injections/latest`、`/v1/sync/status`、`GET /v1/diagnostics/embeddings`、`POST /v1/diagnostics/embeddings/backfill`；`POST /v1/sync/refresh` |
| 空闲复盘 | `POST/GET /v1/idle-review/runs`、`POST /v1/idle-review/runs/{runId}/items`、`POST /v1/idle-review/runs/{runId}/finish` |
| 人工治理 | `/v1/review`、`/v1/retry`、`/v1/conflicts/resolve`、`/v1/versions/cancel`、`/v1/reviews/due`、`/v1/reviews/complete` |

本机 HTTP 端点统一校验 Bearer 令牌，包括存活探针和 OpenAPI。宿主操作携带 `x-mnemoweave-host`，管理入口使用 operator 令牌。注入报告对宿主按 Host 隔离，可进一步限定会话。无同步配置时，同步诊断返回明确的未启用结果。

## 宿主工具注册

同一个本机 Server 处理工具调用与注入。工具注册和准则注入是两个入口。MCP 握手中的服务说明是固定工具用法，准则由本机注入入口提供。

| 宿主 | 注册入口 | 传输 |
|---|---|---|
| DSH | Cordis 加载 `dsh-mnemo-weave` 会话插件，`apply(ctx, config)` 通过 `ctx.tools.register` 注册下表工具，卸载时调用每个注册返回的释放函数 | 宿主工具调用本机 HTTP。DSH 界面插件使用独立 RPC，不重复注册模型工具 |
| ZCode | 安装插件由 `.mcp.json` 声明 `mnemoweave`。工作区验收安装器也可在 `.zcode/config.json` 的 `mcp.servers.mnemoweave` 注册同一服务 | 宿主启动 Node 运行构建后的 `dist/apps/server/src/mcp-main.js`，通过 stdio 发现并调用 MCP 工具 |
| ChatGPT 桌面 | 本地插件由 `.mcp.json` 声明 `mnemoweave`。验收生成器也可生成 `mcp.toml` 的 `[mcp_servers.mnemoweave]` 项，供宿主按本地配置安装 | 与 ZCode 使用同一 stdio 入口。命令 Hook 采用 `local-only` 模式 |

DSH 使用宿主原生工具注册；ChatGPT 桌面和 ZCode 使用各自插件配置中的 MCP 工具注册。Hook 负责事件和准则注入。工具注册与 Hook 可以分别验收。每个宿主选择插件声明或手工注册中的一种方式，避免重复注册同名服务。MCP 子进程需要 `MNEMOWEAVE_SERVER`、`MNEMOWEAVE_TOKEN` 和 `MNEMOWEAVE_HOST_ID`。本机 HTTP 请求带 Bearer 令牌与 Host 头。宿主配置须将这三项传给 MCP 子进程。默认 MCP 模式代理已运行的本机 Server，不在子进程启动 Worker 或访问另一份记忆库。`standalone` 仅用于隔离验收，在子进程内运行 Core 并关闭 Worker。

### DSH 原生工具

| 目标注册名 | 输入与动作 |
|---|---|
| `mnemoweave_recall` | 接收查询及结果上限，经 `POST /v1/recall` 查询共享正式记忆 |
| `mnemoweave_read_memory` | 接收逻辑 ID 与可选修订 ID，经 `GET /v1/memories/{memoryId}` 读取并校验正文 |
| `mnemoweave_read_rules` | 经 `GET /v1/rules` 只读查看准则正文、启用状态及版本。调用不改变本轮已注入的准则 |
| `mnemoweave_change_rule` | 请求新增、替换或移除一条通用准则。宿主核对用户明确表达的长期意图与目标版本后提交 |
| `mnemoweave_write_workspace_archive` | 显式创建或更新当前绑定工作区的档案。更新必须携带读取时的 `baseVersion`。自动复盘只获得创建权 |
| `mnemoweave_related` | 请求扩展本轮直接召回已返回的正式记忆关系，受本轮关系预算约束 |
| `mnemoweave_workspace_archives` | 使用宿主已绑定的会话。传查询时经 `GET /v1/archives/search` 返回有界摘要；传条目 ID 和可选游标时经 `GET /v1/archives/{entryId}/content` 分段读取当前正文。查询和分段读取互斥。宿主从当前工具执行上下文取得会话 ID 并转发。Server 从 Host 与会话 ID 取得工作区，校验档案归属。模型无会话或工作区参数 |
| `mnemoweave_remember` | 主动记录有证据的通用工程知识或用户提供的长期事实。将正文、证据和分类建议交由宿主委派写入任务 Agent，返回实际任务回执。宿主缺少委派能力时经 `POST /v1/remember` 提交候选并返回候选回执 |

每项工具只注册一次。宿主按写入任务回执报告 `mnemoweave_remember` 的实际结果。主会话模型的注册清单限于上表。用户直接编辑或撤回、授权任务写入、人工审批和冲突裁决走各自的宿主或管理入口。

### 通用 stdio MCP 工具

| 注册名 | 动作 |
|---|---|
| `recall` | 正式记忆召回 |
| `provider_health` | Provider 就绪检查 |
| `read_memory` | 读取当前或历史修订 |
| `read_conflict` | 只读查看冲突证据和裁决历史 |
| `remember` | 提交候选，返回候选回执 |
| `candidate_status` | 查询候选状态 |
| `related` | 扩展本轮直接召回已返回的正式记忆关系 |

先以 DSH 原生工具完成会话与轮次契约。表中的轮次相关 MCP 工具（包括会话模型调用 `remember`）须在 ChatGPT 桌面与 ZCode 分别验证可信绑定后才启用。MCP 启动时提供的 `MNEMOWEAVE_SESSION_ID` 不能单独证明当前轮次。尚未完成适配时，仅验收独立准则注入和无需轮次的工具能力。隔离 `standalone` 按实际可用的应用服务注册可选工具。通用 MCP 不提供准则和档案修改、正式记忆直接发布或人工审批。

## 宿主准则注入

1. 宿主用 Host 和会话身份调用本机 `POST /v1/inject`。该入口只返回当前可见、启用的准则，按创建时间和条目 ID 排序。宿主将准则全文渲染为常驻区块。
2. 交付时检查宿主输出限制。完整准则装不下、请求失败或超时时，记录注入失败，宿主继续原回合。禁止截断、挑选部分条目或使用旧轮内容补齐。
3. 工作区档案与正式记忆通过工具按需读取。该入口不组装三类记忆的聚合 View。

| 宿主 | 触发与注入位置 |
|---|---|
| DSH | `agent/created` 后订阅该 Agent 的 `system-prompt/assemble`。等待原组装完成后追加 `mnemo-weave:rules` section。通过持久化 `turn/start`、`turn/end` 识别轮次，同轮复用第一次成功读取的准则。轮次不可识别时按次请求。写入任务 Agent 不订阅该注入入口 |
| ZCode | 进程 Hook 从 stdin 读事件。`SessionStart`、`UserPromptSubmit` 及已识别的 `PostToolUseFailure` 请求准则，成功时 stdout 输出 `{additionalContext}`。其余事件只作归一与上报，`Stop` 表示轮次结束 |
| ChatGPT 桌面 | 本地 command Hook 从 stdin 读事件。`SessionStart`、`UserPromptSubmit` 及 `PostToolUse` 中能确定的失败请求准则，成功时 stdout 输出 `{hookSpecificOutput:{hookEventName,additionalContext}}`。`Stop` 和 `SessionEnd` 分别上报轮次与会话结束 |

DSH 插件的实际入口是 `plugins/dsh-mnemo-weave/lib/index.js`。ZCode、ChatGPT 桌面的事件入口分别是 `packages/adapters/zcode/src/hook-main.ts` 和 `packages/adapters/chatgpt/src/hook-main.ts`。两个桌面宿主的 Hook 每次触发独立运行。默认注入截止为 2 秒，探活、事件上报、准则请求和渲染共用这一预算。ChatGPT 桌面 Hook 的前台截止为 1,900 ms，给外层 2 秒 Hook 留出退出时间。

## 工作区与会话绑定

- 工作区登记记录含稳定的 `workspaceId`（UUID）和显示名称 `name`（去除首尾空白后 1–200 字符）。首台设备生成 ID，其他设备使用同一个 ID 登记。不同工作区可同名。本机根目录仅保存在本机；名称、绝对路径、仓库 URL、分支和会话 ID 都不用于派生工作区 ID。
- `POST /v1/workspaces` 由 operator 提交 `{workspaceId,name}`。同 ID 同名称幂等成功，同 ID 不同名称返回 `INVALID_STATE`。`PUT /v1/workspaces/{workspaceId}/binding` 由 operator 提交 `{rootPath}`，以本机解析出的真实目录保存绑定。不存在或无法解析的目录返回 `INVALID_INPUT`。同一规范化根目录已绑定另一个工作区时返回 `INVALID_STATE`。同一工作区可绑定多个本地根目录。绑定接口幂等添加，不自动转移根目录。工作区列表只返回发起者获授权的 ID 和名称，Host 响应不包含本地路径。
- 会话开始时，可信宿主通过 `PUT /v1/sessions/{sessionId}/workspace` 提交 `{rootPath?,workspaceId?}`。有根目录时必须发送宿主实际打开的工作区根目录，Server 按真实目录精确匹配本机绑定；未匹配时会话无绑定。宿主无法提供根目录时，可发送配置 `MNEMOWEAVE_WORKSPACE_ID` 中已登记的 ID。若两字段同时存在，根目录必须解析到该 ID，否则返回 `INVALID_INPUT`。空载荷明确记录无绑定。相同绑定重放成功，变更已有绑定返回 `INVALID_STATE`。工作区切换从下一会话生效。未知工作区返回 `INVALID_INPUT`，无权访问返回 `SCOPE_FORBIDDEN`。
- 会话档案工具只使用本机已保存的会话绑定，模型输入不得携带工作区 ID。无绑定时返回 `WORKSPACE_REQUIRED`。无绑定的会话仍可使用准则和正式记忆。管理界面列表、搜索或新建工作区档案时必须显式提交 `workspaceId`。缺少该字段时返回 `WORKSPACE_REQUIRED`，不执行跨工作区查询。详情、历史、编辑、归档和恢复由条目 ID 查出工作区，并在实际读写前检查工作区权限。会话工具拿到其他工作区的条目 ID 时返回 `NOT_FOUND`。目标工作区不可通过编辑变更。工作区绑定不能授予访问权限。
- 工作区绑定用于授权访问档案。档案可引用来源会话，来源会话结束不会删除档案。

## 正式记忆召回

- 本机按正式记忆读取权限检查召回、列表、图谱、详情和历史。启用同步时，设备还需具备 `formal-memories` 读权限才能同步该集合。准则和工作区档案各自校验权限。正式记忆召回排除撤回、非当前修订及未登记的 Provider 记录。
- `POST /v1/recall`和 `POST /v1/memories/explore`使用一个 `query` 字段。宿主使用当前工作区的显示名称，去除首尾空白，将非空名称作为单独一行附在原查询后。工作区未提供名称时原样查询。用户也可在检索框直接输入工作区名称。Source 使用收到的查询执行既有检索和结果限制。
- 正式记忆请求与响应均无条目级工作区字段和同步流字段。召回、管理列表和图谱均不接收工作区过滤字段。出现已移除字段时返回 `INVALID_INPUT`。工作区档案按工作区授权处理。

### 会话工具预算

内容长度按 JavaScript UTF-16 代码单元计，裁剪不得切开代理对。以下限制按 Host、会话、Agent 和轮次独立核算，在 Source 调用前验证。管理检索的 Recall 接口默认 10 条、最多 50 条，模型调用必须执行以下更小额度。DSH 从当前工具执行上下文取得真实 Host、会话、Agent 和轮次，Server 与已登记绑定核对。模型参数不提供这些标识。轮次或会话无法核对时返回 `UNAUTHORIZED`，不能退到管理预算。ChatGPT 桌面和 ZCode 的可信绑定另行设计。

| 操作 | 每轮上限 |
|---|---|
| 直接召回 | 两个不同查询合计 6 条、正文 4,800 字符，单条 1,200 字符。首次最多 4 条、3,600 字符，第二次用剩余额度。相同查询重放已返回结果，无新 Provider 查询。排除低相关，每次中等相关和未知相关各最多 1 条。读取 Mnemon 0.2.13 默认 Recall JSON 的 `confidence`，`high`、`medium`、`low` 直接映射。缺失或未知值才视为未知 |
| 关系扩展 | 一次。起点必须是本轮直接召回已返回的条目。最多 4 条、正文 4,000 字符，单条 1,200 字符，排除本轮已返回的重复内容 |
| 完整正文 | 模型最多读取 1 条本轮已返回的正式记忆正文，正文存储上限 8,000 UTF-8 字节。用户在管理界面读详情不占模型预算 |

### 工作区档案工具预算

模型搜索与按 ID 分段读取合计每 Host、会话及轮次最多四次。搜索默认五条，正文摘要合计最多 6,000 个 UTF-16 代码单元，单条使用剩余额度。分段读取每次最多 6,000 个 UTF-16 代码单元，响应返回正文、档案版本及下一段游标。游标绑定 Host、会话、档案 ID 和档案版本；从头读取时不传游标。档案更新使旧游标失效并返回 `VERSION_CONFLICT`。裁剪保持完整 Unicode 字符。管理界面读取全文和历史使用管理入口，模型工具没有该能力。

## 写入任务 Agent 与发布

### 入口和权限

| 发起方式 | 允许的动作 | 执行边界 |
|---|---|---|
| 用户在记忆界面直接操作 | 三类记忆按各自界面操作写入 | 本机 Server 校验授权和条目版本。正式记忆记录 `local-user` |
| 主会话请求 `remember` | 正式记忆 `create`、`skip`。当前轮用户明确纠正时可提出 `edit` | 宿主先检查「本轮不留存」，允许时由 DSH 委派写入任务 Agent，校验结果后提交 |
| 用户触发「整理记忆」 | 正式记忆 `create`、`edit`、`withdraw`、`skip` | 先展示计划，用户勾选并确认后逐项执行。撤回还须在原始指令中明确指定条目 |
| 用户确认回复旁保存 | 正式记忆 `create`、`skip` | 宿主委派写入任务 Agent 提炼用户确认的回复，并保存来源证据 |
| 用户确认「提炼为正式记忆」 | 正式记忆 `create` | 单篇档案生成一条草稿，用户确认具体正文与共享范围后提交 |
| 空闲复盘 | 一项准则变更及一篇工作区档案新增 | 分别核对用户明确长期意图及工作区成果，见 [空闲复盘](#空闲复盘) |
| 有可信会话和轮次绑定、但无委派能力的宿主或通用 MCP | 提交候选、查询候选状态 | Worker 按确定性规则检查。已有候选保持原审核流程 |

「整理后保存」允许写入用户在表单中选择的记忆类型。准则和正式记忆分别校验对应的本机写入权限，工作区档案要求用户选择工作区并校验工作区权限。任务 Agent 可建议分类，宿主只能执行用户确认的目标类型。

### 主动记录通用工程经验

DSH 原生 `mnemoweave_remember` 和 stdio MCP `remember` 的工具说明引用同一份工程经验指引，由共享工具契约维护。各适配器补充自己的执行回执：有委派能力的宿主描述写入任务回执，通用 MCP 描述候选回执。该指引属于工具说明，不写入用户准则，也不启动后台总结。

> 当本轮验证了一个非显然、能减少未来排查或返工、且可在其他工作区复用的工程结论时，主动考虑记录。先在剩余召回额度内核对是否已有同等结论，再选本轮最有价值的一条，写清适用条件、观察结果和可复用做法，并给出证据引用。本轮不留存时跳过。

- 适合记录的是有可核对依据的诊断方法、工具版本差异、可复现的故障条件和验证过的解决办法。仓库特有路径、部署地址和项目交接信息应留在工作区档案；用户明确要求以后遵守的通用规则走准则入口。
- 除用户明确提供或确认的事实，工程经验可以引用宿主可回查的**本轮证据**：测试或对照实验的结果、带文件及版本定位的源码读取结果。单凭执行过一条命令、一次原因不明的成功、模型猜测、已召回的旧记忆或原始日志堆积，不能作为新经验发布。未说明适用版本时不得扩大结论范围。
- 模型只提出正文、分类和证据引用。宿主从可信工具执行记录核对引用、结果及来源归属，并给写入任务 Agent 提供受预算限制的证据摘录。Server 校验证据记录绑定同一 Host、会话及轮次。写入任务 Agent 判断证据是否支持结论；仅在语义依据足够且通过现有写入检查时发布。依据不完整或与已有记忆矛盾时，跳过或进入候选审核。工程证据不能单独授权编辑已有条目，纠正仍需遵守原编辑规则。
- 主会话每轮最多受理一条模型自行提出的正式记忆写入请求。受理后查询原回执；超时或重复调用不创建第二个任务。没有可信轮次绑定或该轮标记「本轮不留存」时，在委派或提交候选前拒绝。空闲复盘不写正式记忆。

### 授权任务接口

路径中的 `taskId` 是宿主持久化的 UUID，`index` 是从 0 开始的整数。POST 载荷按 `kind` 区分记忆类型并拒绝未知字段。下表适用于 `kind=formal-memory`，准则与档案见 [准则与档案的授权写入](#准则与档案的授权写入)。

| 字段 | 规则 |
|---|---|
| `trigger` | `conversation`、`organize`、`reply-save` 或 `archive-distill` |
| `sessionId`、`turnId` | 会话写入和回复旁保存必须提供。界面整理可没有会话，两字段同时省略。档案提炼省略两字段 |
| `action` | `create`、`edit`、`withdraw` 或 `skip`，按发起方式校验白名单 |
| `reason` | 去除首尾空白后 1–500 字符 |
| `evidenceRefs` | 1–12 个去重的来源 ID。会话写入引用同一 Host、会话及轮次的已持久化用户事件或宿主核验的工程证据记录，回复旁保存引用同一会话内用户确认的回复和确认事件。界面整理引用宿主持久化的用户原始指令及对具体动作的确认记录，两者均绑定 Host 与任务 ID。档案提炼只引用一条草稿的用户确认记录 |
| `memoryId`、`entryVersion` | 编辑和撤回必填，其余动作禁止携带。逻辑 ID 使用 UUID，版本使用当前读取接口返回的整数 |
| `content` 和分类 | 新增及编辑使用现有正式记忆正文和分类约束。编辑时省略分类则继承。档案提炼从已确认草稿取得正文和分类，提交时禁止携带这两个字段。其余动作禁止携带 |
| `draftId` | 仅档案提炼必填，取已确认草稿的 UUID |
| `assessment` | 新增及编辑必填，档案提炼从草稿取得。枚举为 `supported`、`uncertain`、`conflict`。后两者进入人工审核 |

该入口仅供受信任宿主代码调用，禁止注册为模型工具。Server 从认证上下文取得 Host ID，按 Host、会话及触发原因校验证据和动作。界面撤回目标必须在用户原始指令中包含完整正式记忆逻辑 ID，且该 ID 必须等于请求目标。任务 Agent 不得创建证据记录。GET 只向发起 Host 返回回执，未知回执和其他 Host 的回执都返回 `NOT_FOUND`。

回执含 `taskId`、`index`、`action`、`status`、`memoryId`、`entryVersion`、`candidateId`、`errorCode`。无对应值的字段为 `null`。状态固定为 `published`、`duplicate`、`skipped`、`needs_review`、`queued`、`unknown` 或 `failed`。其中 `published`、`duplicate` 必须带逻辑 ID 和版本，`needs_review` 必须带候选 ID，`queued`、`unknown`、`failed` 必须带错误码。POST 重放返回该动作的最新已知回执。

### 计划验证和回执

1. 宿主绑定发起 Host、会话、轮次和触发原因。会话写入与回复旁保存向任务提供相关用户原文、可核验的工程证据或用户确认的回复及其来源事件、至多 5 条相关正式记忆的当前正文摘要、逻辑 ID 和条目版本。整理任务另可提供当前会话工作区的档案摘要。Agent 无通用写入工具、服务令牌或同步凭据。模型调用经过宿主 Gateway/Routing。
2. 主会话每轮最多受理一项模型自行发起的写入请求，回复旁保存最多一项，整理任务最多八项。每项必须有动作和原因。新增必须给出非空正文和符合触发方式的证据引用。编辑必须给出实际提供过的目标 ID、条目版本、正文及用户指令或明确纠正的证据。撤回必须同时满足用户明确指定、目标在任务读取结果内、条目版本匹配。禁止由 Agent 提升权限或指定同步流。
3. 宿主先校验动作、证据引用、目标和版本，再提交。无效计划返回 `INVALID_INPUT`，超出动作权限返回 `UNAUTHORIZED`，版本已变返回 `VERSION_CONFLICT`。任务 Agent 声明 `uncertain` 或 `conflict` 时，保存候选并返回 `needs_review`。缺失或无权使用的证据视为无效请求。Server 不进行语义推理。跳过动作必须记录原因。
4. 本机 Server 为授权任务记录发起 Host、任务 ID、动作序号和证据，使用 `(Host ID, 任务 ID, 动作序号)` 生成稳定幂等键。相同键与相同载荷返回原回执，同键不同载荷返回 `IDEMPOTENCY_CONFLICT`。模型输出不能自行选择用户身份，任务写入记为 `task-agent`，由 Host 归因。
5. 正式记忆查重使用整个共享集合。以契约规范化后正文的 UTF-8 字节比较当前有效记录。多个旧条目匹配时按逻辑 ID 字典序选择第一条。启用同步时的跨设备并发查重见 [同步协议](sync.md#提交与版本)。创建与已有正文相同则返回 `duplicate`、已有逻辑 ID 和条目版本。编辑正文与目标相同且分类也未变化则返回 `duplicate`，不追加修订。编辑拟写正文与另一条有效记忆相同则进入人工审核。发现 Provider 返回 `skipped` 时必须以 `replaced_id` 定位并读取核对。正文不同的原生重复结果不得以成功回执更新目录。自动写入无法核对时进入 `needs_review`，保留原条目。
6. Server 校验权限和版本，执行确定性检查，通过 Worker、Outbox 和回执完成写入。结果未知时先对账。启用同步时只有远端确认且本机已应用才返回发布成功。暂未提交和结果未知分别返回 `SYNC_QUEUED` 与 `SYNC_OUTCOME_UNKNOWN`。无同步时，以 Provider 正文、关系回读校验通过且目录事务提交作为成功条件。逐项记录动作、状态、目标 ID、条目版本及错误码。
7. 授权写入与普通候选提交走不同权限检查。通用 MCP 和旧候选端点没有授权任务写入能力。升级不自动审批或发布遗留候选。

### 整理预览与逐项确认

整理任务先生成只读计划，最多八项。每项显示动作、原因及证据；编辑和撤回还显示目标逻辑 ID、读取时的条目版本和原正文，新增或编辑显示拟写正文。界面初始不选中任何变更。用户勾选后一次确认，宿主持久化确认的动作序号、目标、版本及拟写正文哈希，只有被确认的动作才进入授权写入。修改计划内容后须重新预览并确认。关闭预览无写入。

按原序号逐项执行，幂等键保持原任务 ID 与动作序号。单项版本冲突返回 `VERSION_CONFLICT`，其他独立项继续。相同目标出现多个写动作时，计划无效，须重新生成。任一项回执为排队或结果未知时，查询同一动作回执。已成功的动作不重放。任务计划与逐项回执留在本机，可在界面查看。

### 任务 Agent 预算

限制用于空闲复盘、正式记忆写入及整理、档案提炼和技能总结的每次模型任务。技能配对回测的基线侧和草案侧各自执行相同限制。

| 项目 | 默认上限与行为 |
|---|---|
| 证据输入 | 每次任务合计 24,000 个 UTF-16 代码单元，包含送入模型的会话、档案、召回正文及其来源标记 |
| 单个档案 | 档案作为证据最多使用 12,000 个 UTF-16 代码单元，全文可在管理界面查阅 |
| 模型输出与截止 | 最多 4,096 输出 token。一次模型任务自开始起最多 60 秒，超时取消并保留可重试状态 |
| 并发 | 同一 Host 与会话只运行一个空闲复盘；同一任务的重复请求复用原运行。技能写入同一技能时串行 |

会话证据按最近已完成轮次取用，档案证据优先取用户选定段落，其次按原文顺序。按总预算裁剪，保留来源标记、段落范围与是否截取；保留完整 Unicode 字符。没有足够证据时任务返回跳过，不能从缺失片段推断。档案提炼预览及技能总结结果显示实际使用的段落范围。模型任务的超时不改变已受理写入的回执；已提交写入按原幂等键对账。

### 准则与档案的授权写入

用户直接写入使用相应资源路由。准则移除使用 `PATCH /v1/rules/{ruleId}`，提交 `{baseVersion,remove:true}`；移除与正文编辑、启停互斥。移除追加版本，退出容量计算及常驻集合。

主会话工具和空闲复盘经同一个授权任务接口提交。请求按 `kind` 区分 `formal-memory`、`rule` 和 `workspace-archive`。上节正式记忆字段只用于 `formal-memory`；其余类型使用以下动作与字段。新增的正文及元数据沿用资源创建契约，编辑沿用资源编辑契约。

| 触发入口 | 允许的动作 | 授权与目标 |
|---|---|---|
| 主会话 `conversation` | 准则 `create`、`edit`、`remove`；档案 `create`、`edit` | 准则校验用户明确表达的长期意图，移除需明确废止。档案目标由真实会话绑定取得，模型不得指定工作区 |
| 空闲复盘 `idle-review` | 一项准则 `create`、`edit` 或 `remove`；一项档案 `create` | 携带 `runId`。Server 校验运行属于发起 Host 和会话、尚可提交、与所用证据相符，并拒绝超出动作额度的请求 |

两种触发均携带可信会话、轮次和来源引用。准则或档案的编辑、移除必须带目标 `entryId` 与读取时的 `baseVersion`。会话档案请求不接收 `workspaceId`。回执用 `entryId` 和 `version` 表达已应用条目版本，成功状态为 `applied`；排队、未知和失败沿用授权任务回执及幂等规则。同步开启时，远端确认并本机应用后才返回成功。工具与复盘不得借此归档或恢复档案。

### 从档案提炼正式记忆

#### 入口与草稿

用户从工作区档案详情点「提炼为正式记忆」。每次只读一篇档案的当前版本，活跃及已归档档案均可提炼。宿主先校验档案读权限及正式记忆写入权限，再读取档案正文。源版本固定为 `{workspaceId,entryId,entryVersion,contentHash}`，由宿主从读取结果取得。界面可以在没有会话时发起。模型工具、归档、恢复、容量维护和空闲复盘都不触发提炼。

宿主通过 Gateway/Routing 委派只读任务 Agent。输入为选定档案正文中符合任务预算的证据片段及本次用户指令。档案内容作为数据，里面的指令不具有执行权限。Agent 输出 `skip` 加原因，或一条可脱离该工作区使用的知识草稿，包含正文、分类、理由及 `assessment`。正文沿用正式记忆的 8,000 UTF-8 字节上限。提炼保留适用条件、限制和证据含义，去除仅对该工作区有意义的路径、地址、账号、项目专名和凭据。只有工作区专属事实或缺少可核实依据时返回 `skip` 或标记 `uncertain`。Agent 不调用发布工具。

宿主收到草稿后向 `POST /v1/archive-distillations` 提交固定来源、草稿正文、分类、理由及 `assessment`。Server 再校验 Host 权限及档案当前版本和正文哈希，写入不可变草稿，返回 `draftId`。草稿归发起 Host，GET 仅在同一 Host 且仍有来源读取权限时返回。访问其他 Host 的草稿返回 `NOT_FOUND`。草稿可留在本机供继续确认。丢弃或关闭界面不会产生正式写入。用户修改正文或分类时，从同一来源创建新草稿，重新展示完整待共享内容并确认。

#### 确认与发布

1. 界面并排显示来源档案版本、待发布正文及分类，并提示确认后会进入共享正式记忆集合，获该集合读权限的设备都可以读取。用户点击「确认共享并发布」才产生授权。宿主持久化确认事件，绑定 Host、`draftId` 和草稿内容哈希。
2. 宿主用草稿 ID 作为授权写入接口的 `taskId`，固定 `index=0`，提交 `trigger=archive-distill`、`kind=formal-memory`、`action=create`、`draftId`、确认记录引用及固定理由「用户确认从档案提炼」。Server 校验确认记录及草稿身份，再检查源读取与正式记忆写入权限、当前源版本和哈希。来源已更新或状态变化导致版本变化时返回 `VERSION_CONFLICT`，要求读取新版本后重新提炼。校验通过后，固化来源与待发布内容并在同一事务登记正式写入任务。
3. 写入沿用全库查重、Provider 回读及同步确认。同文返回已有正式记忆 ID 和条目版本，保留本次来源回执。模型标记 `uncertain` 或 `conflict` 时转人工审核，确认共享本身不跳过审核。每个草稿最多一次创建动作。重放同一已受理请求查询原任务进度，不因来源后续变化再次写入；回执为排队或结果未知时查同一任务，禁止新建任务盲重试。
4. 来源记录存于本机治理库，包含来源档案 ID、工作区 ID、版本、正文哈希和确认事件，关联本次写入回执。正式记忆同步只发送已确认的正文和正式记忆分类，省略档案标题、原文、路径、来源 ID 和工作区 ID 等来源元数据。仅在本机且调用者仍有来源档案读取权限时显示「查看来源」。提炼本身不修改原档案。用户可在容量维护流程另行确认归档。后续档案变更不自动改写正式记忆。

### 编辑和撤回

正式记忆按逻辑 ID 串行。编辑与撤回必须提交读取时的 `entryVersion`。编辑追加不可变修订，对旧修订投影 `supersedes`。省略的分类字段从当前修订继承，发布与同步携带完整分类。撤回退出当前召回，保留可读历史。正文读取通过 Provider 并核对哈希。

准则编辑和启停、工作区档案编辑和归档或恢复都必须提交读取时的 `baseVersion`。缺失返回 `INVALID_INPUT`，过期返回 `VERSION_CONFLICT`。

## 空闲复盘

DSH 在轮次结束后启动空闲计时。连续空闲 30 秒且累计活动达到 5 分才启动任务。同一会话两次尝试至少间隔 5 分钟，最多 20 次。用户文本每 50 个 UTF-16 代码单元计 1 分、最多 3 分；每个完成轮次计 1 分；每 5 次工具调用计 1 分、最多 2 分；使用 3 类工具计 1 分、4 类及以上计 2 分。活动分只用于启动。新一轮开始时取消尚未提交的动作。

用户可通过宿主的「本轮不留存」入口标记本轮，也可在本轮明确要求不留存，由宿主记录该意图。被标记轮次不进入自动复盘的评分和证据。主会话模型在该轮自行发起任何记忆写入时（包括 `remember`、准则变更和档案创建或更新），宿主返回 `UNAUTHORIZED`，原因显示「本轮不留存」。检查先于 Agent 委派、候选提交和资源写入；本机 Server 在受理带有该轮绑定的写入时再次检查。已运行且依赖该轮证据的任务取消尚未提交的动作，已提交的动作按原回执核对。标记只适用于本轮。用户主动点击「保存回复」或从界面发起的保存与总结分别确认，按独立授权处理。

宿主无法提供可用模型路由或完整的必要会话片段时跳过并报告原因。DSH 检测到 Agent Teams 时默认暂停复盘。以上情况在启动前发生时不占尝试次数；模型任务实际启动才占一次。一次完成后，以该次已处理的轮次为水位，下次评分只累计后续轮次；有失败动作时可按原回执重试。

复盘默认允许变更准则。每次至多新增、替换或移除一条准则，仅依据用户明确表达的通用长期信息。替换或移除必须定位目标并携带读取时的版本，移除还需用户明确废止该准则。每次至多新建一篇工作区档案，先搜索当前工作区已有档案；已有覆盖、无绑定、容量不足时跳过。档案证据来自有复用价值的设计、调查、操作流程或交接记录。复盘没有更新或归档旧档案的权限，也不写入正式记忆。

每个动作分别保存回执。已提交动作先对账；已成功、确认为重复或主动跳过的动作不重放。失败动作保留结果，后续满足门槛时仅重试尚未完成的动作。

## 备份与恢复演练

备份由用户发起。每次生成一份清单，记录生成时间、各组件的版本、备份文件哈希和是否纳入。

| 组件 | 备份范围 |
|---|---|
| 本机治理库 | 准则、工作区档案及其版本，正式记忆目录、Provider 映射、候选、草稿、任务与回执。使用 `VACUUM INTO` |
| Mnemon Store | 同一停写点的专用 Store，包含正式记忆正文与关系 |
| 已选择的技能 | 由宿主导出所选技能文件、历史、草稿、用例和回测记录；在清单记录工作区 ID、技能相对位置与哈希。未选择技能时注明未纳入 |

治理库和 Provider Store 一起停写、备份和恢复，不能混用不同备份批次。技能组件也在该次备份中冻结写入并成套导出。备份排除令牌、密钥、宿主会话全文和本机绝对路径绑定。治理库导出前清除副本中的本机路径绑定。恢复后由操作者在目标设备重新绑定目录并配置凭据。备份属于本机恢复资料，远端同步库须独立备份。

在隔离目录校验清单、哈希和版本，验证准则、档案正文与历史、正式记忆正文和关系、任务回执及已选技能的历史、草稿与回测都可读。技能恢复若目标已存在，保留现有文件并列出冲突，由用户选定新位置或另行确认替换。确认恢复结果后才切换运行目录。恢复失败保留现用数据。

## 工作上下文

工作上下文由宿主管理。发起写入、空闲复盘或技能总结时，MnemoWeave 通过宿主读取本次任务所需且获授权的会话片段。宿主无法提供时，依赖该片段的动作跳过并记录原因。本机治理库只记录操作所需的会话绑定、事件标识和证据，不维护可更新的任务状态或会话副本。工作上下文不经本机准则入口注入，也不参与同步。

## Mnemon
`MNEMON_BINARY` 默认 `mnemon`，启动由 `execFile` 执行。Windows 应指定原生 `.exe`。固定接受 `mnemon version 0.2.13`，版本检查有短期缓存，子进程设置 `MNEMON_MAX_INSIGHTS=0`，使用专用 `--data-dir` 与 `--store`。只读命令在 Store 初始化后使用只读快照；不可变正文可按 Provider ID 缓存。

| 命令 | 用途 |
|---|---|
| `status`、`recall`、`show` | 健康、召回、读取正文；`recall --basic` 用于精确核对 |
| `remember --source mnemoweave:candidate:<uuid>` | 写入审核通过的正文；`skipped` 使用 `replaced_id` 定位 |
| `remember --no-diff --source mnemoweave:<changeId>:<version>` | 跨机重建，建立本地 Provider ID 映射 |
| `link`、`related --edge supersedes` | 投影及核对取代关系 |
| `forget` | Provider 适配器操作；正式记忆撤回使用目录和同步版本语义 |
| `embed --status` | 官方嵌入覆盖报告：服务可达、模型可用、已嵌入条数与总数 |

命令超时、版本不兼容、输出格式错误和正文核对失败分别作为独立错误返回。

嵌入诊断只转述 Provider 的官方报告，不额外探测服务：`GET /v1/diagnostics/embeddings` 返回协议、模型、服务与模型可用性、已嵌入/总数、覆盖率、推导出的召回模式（`semantic`/`keyword`/`unknown`）、是否降级、最近错误与检查时间。Provider 没有该接口或报告失败时返回 `unknown`，不猜测。`POST /v1/diagnostics/embeddings/backfill` 以 Host 身份启动一次 `embed --all`，同一类任务同时只允许一个；任务行持久化在治理库，重启时遗留的 running 标记为 interrupted。命令输出不是稳定契约，任务是否成功以退出状态和随后重新读取的覆盖率为准，结果记录在任务详情的 `embeddedBefore`/`embeddedAfter`/`error`。

## 治理库与配置

目标本机治理库使用 schema v22。每步升级前使用 `VACUUM INTO` 生成一致快照。恢复时停止相关进程，保留原库，把选定快照作为新状态目录的 `governance.db`。Provider Store 分开备份。升级差异和切换步骤见 [当前状态](status.md#旧版同步切换)。

## 容量与维护

准则使用一个共享集合，默认总容量 **10,000 UTF-8 字节**。按所有未移除准则的正文及条目间的 `\n§\n` 分隔符计量，包括停用条目。超限时返回 `RULE_CAPACITY_EXCEEDED` 和容量信息，保留原集合，界面提示删减。可继续提交使集合变小的替换和移除。容量维护不自动裁剪、压缩、归档或转写到其他记忆。

工作区档案正文按 UTF-8 字节计，单篇 2 MiB，每个工作区活跃正文默认 10 MiB。归档不占活跃容量，保留原文及完整历史。同步开启时由远端在确认创建、编辑或恢复前按工作区计算容量，超限返回 `ARCHIVE_CAPACITY_EXCEEDED`，保留原状态。纯本机模式执行同一检查。本机及同步 HTTP 的单次 JSON 请求上限为 16 MiB。搜索和分段读取的字符数上限见 [工作区档案工具预算](#工作区档案工具预算)。

### 工作区档案容量维护

容量不足时保留待提交草稿，并列出活跃档案与可释放的正文容量，按远端确认的更新时间从旧到新排列，同时间按 ID 排列。用户选中档案后可发起评估：有可跨工作区复用的知识时生成 [正式记忆草稿](#从档案提炼正式记忆)，用户确认共享；仅具工作区价值时可选择直接归档。评估和草稿生成均不改变档案状态。

选择「提炼后归档」时，宿主保存用户对共享草稿与来源归档的两项确认，分别关联正式记忆任务 ID 与归档变更 ID。正式记忆已发布或已核对为重复后，才提交归档动作。重开界面或重试沿用原标识及回执。待审、排队、结果未知或失败时不推进归档；查询原回执。归档仍提交来源的 `baseVersion`。若来源已更新，保留已发布记忆和最新档案，显示归档冲突。归档确认并应用后才释放活跃容量，原草稿由用户重试。空闲复盘遇到容量不足只记录跳过，不发起该维护流程。


管理列表按 `limit`/`cursor` 翻页，正文预算不计标题、ID 和版本等元数据。

| 变量 | 用途 |
|---|---|
| `MNEMON_BINARY`、`MNEMON_DATA_DIR`、`MNEMON_STORE` | 官方 CLI、独立数据目录与 Store 名 |
| `MNEMOWEAVE_STATE_DIR`、`MNEMOWEAVE_PORT` | 本机状态目录与端口，默认 4317 |
| `MNEMOWEAVE_TOKEN`、`MNEMOWEAVE_OPERATOR_TOKEN` | 本机服务与管理凭据，使用不同值 |
| `MNEMOWEAVE_SERVER`、`MNEMOWEAVE_HOST_ID`、`MNEMOWEAVE_WORKSPACE_ID` | 宿主连接、身份与无工作区根目录时的显式绑定 |
| `MNEMOWEAVE_INJECT_DEADLINE_MS`、`MNEMOWEAVE_MCP_MODE` | 宿主注入截止与 MCP 运行模式 |
| `MNEMOWEAVE_WORKER` | 默认启用，`off` 停止后台候选处理 |
| `MNEMOWEAVE_RULE_CAPACITY_BYTES` | 准则总容量，默认 10,000 UTF-8 字节 |
| `MNEMOWEAVE_ARCHIVE_ACTIVE_CAPACITY_BYTES` | 每个工作区作用域的活跃档案容量，默认 10 MiB |
| `MNEMOWEAVE_MIN_FREE_BYTES`、`MNEMOWEAVE_QUOTA_SOFT_BYTES`、`MNEMOWEAVE_QUOTA_HARD_BYTES` | 容量地板与软硬配额 |
| `MNEMOWEAVE_SYNC_*` | 同步配置，见 [同步协议](sync.md) |

整理后保存和技能任务的界面行为见 [记忆界面设计](ui.md)。
