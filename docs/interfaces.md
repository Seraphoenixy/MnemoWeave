# DSH 界面、路由与 RPC 接口

<a id="interfaces-webheadless工具命令与-rpc"></a>

## Web、Headless、工具、命令与 RPC


本页是集成参考。日常使用请先看 [Sidebar 与对话交互指南](workbench.md)。

<a id="interfaces-记忆空间命名与兼容性"></a>

### 记忆空间命名与兼容性

产品统一使用**记忆空间（memory space）**。Source 导出 `MemorySpace`、`MemorySpaceView`、`MemorySpaceCatalog` 及对应的请求和元数据类型；已发布的 `MemoryBody*` 类型作为弃用别名保留，数据形状不变。

既有 v0.5.x 标识，如 `mnemo_memory_bodies`、`mnemo_memory_body_create`、`body-directory` 和 `memoryBodyId` / `memoryBodyIds`，仍表示记忆空间。为兼容已安装的工具、Source 页面、Provider 适配器和持久化的 Document/Pack 来源信息，这些标识保持稳定；`.dsh-memory-bodies.json` 文件名与其中的 `bodies` 字段也继续保留。术语调整不会重命名用户创建的空间、修改 ID、移动数据库或改变访问授权。

<a id="interfaces-用户界面入口"></a>

### 用户界面入口

| 入口 | 默认 | 说明 |
|---|---:|---|
| Sidebar | 是 | 左侧栏的“记忆系统”工作台：状态、设置、运行时、档案、记忆空间 |
| 会话标签页 | 否 | 在会话内打开同一工作台，自动跟随所属会话的范围 |
| 本回合记忆 | 是 | 已完成回合下方的记忆工具摘要；展开后可跳到对应页面 |
| 存入记忆 | 是 | 已定稿助手回复旁的操作；确认后调用监督写入 |
| 插件页中的 dsh-mnemo-weave 页面 | 是 | 界面设置 |
| 记忆系统中的**设置**页 | 是 | 记忆组合、组件设置、存储与备份 |
| `/mnemon` | — | 对话命令入口 |
| 模型工具 | — | Root Agent 的结构化读写入口 |

`displayMode` 选择 `sidebar`（默认）或 `builtin`（会话标签页）；`tabEnabled` 控制所选入口是否显示。会话标签页不展示 Sidebar 的范围控件。对话内两个快捷入口在**界面**中分别开关，通过 `mnemon-ui` 设置范围保存。

<a id="interfaces-profile-能力面"></a>

### Profile 能力面

| 能力 | Web | Headless |
|---|---:|---:|
| 运行时上下文与生命周期提示 | 是 | 是 |
| 模型工具与独立任务 Agent | 是 | 是 |
| `workspace` 范围按 Agent cwd 路由 | 是 | 是 |
| Sidebar / 对话操作 | 是 | 否 |
| Host 到客户端 RPC | 是 | 否 |
| Agent idle 后的延迟评分审查 | Host 持续运行时执行 | 一次性进程退出时取消 |

Headless 会获得完整模型工具面。它把命令行任务作为普通用户消息提交，不提供交互式斜杠命令分发；Agent 进入 idle 前已经完成的显式和模型引导写入会持久化。

模型工具、生命周期 hook 与系统调度都使用 `automatic` trigger；Web/RPC 中由用户直接发起的数据面操作使用 `manual` trigger。因此把某层设为 `manual` 会保留人工管理能力，同时拒绝模型工具和自动投影。`memory-system` 与 `status` 属于控制面观察，即使某层关闭也仍可读取。

<a id="interfaces-模型工具"></a>

### 模型工具

DSH 工具统一使用 `mnemo_` 前缀。升级后，自定义提示词、Code Mode 脚本和工具白名单中的旧 `mnemon_` 工具名需同步更新。既有会话中的历史调用仍可查看。已移除 `mnemo_view_route` 和 `mnemo_view_action`，对话使用对应的具名工具。原 `mnemo_document_create` 调用请改用 `mnemo_document_manage` 并传入 `action=create`。

各工具的完整参数 Schema、类型、取值范围、返回值与权限守卫见[工具与命令参考](tools.md)。

<a id="interfaces-只读工具"></a>

#### 只读工具

| 工具 | 用途 | Root Agent 路径 |
|---|---|---|
| `mnemo_status` | CLI、配置、存储与目录聚合状态 | 直接服务 |
| `mnemo_memory_bodies` | 读取记忆空间目录、Provider 能力、健康与可用统计 | 直接服务 |
| `mnemo_recall` | 从一个或多个 active Provider 召回；异构结果排名融合 | 受 pinned Source 权限约束的 Host 直接服务 |
| `mnemo_related` | 在 `capabilities.related=true` 的记忆空间中遍历关系 | 受 pinned Source 权限约束的 Host 直接服务；Root 默认两跳 |
| `mnemo_document_search` | 确定性搜索受管档案 | Documents 控制层 |

“只读”表示不修改受管正文或长期语义内容。`mnemo_document_search` 命中后仍会更新 `lastAccessedAt`，用于 LRU 排序，因此功能只读不等于磁盘只读。

`mnemo_recall` 搜索记忆空间中的记忆，`mnemo_document_search` 搜索工作区档案；各自的工具说明写明了这一点，也写明对于冷归档的档案，召回只能找到归档时留在空间里的索引记忆。在 Mnemon Native 空间中，`mnemo_related` 标明每个关联记忆经由哪种边得到（`edgeType`）；时间边和实体边由系统自动添加，数量远多于其他边，所以可以传入 `edge` 只沿一种边查找。其他 Provider 不标明边的类型，也不按 `edge` 筛选。`mnemo_status` 的 `aggregate` 只合计已激活、正常且 Provider 提供统计数据的空间，在 `aggregate.spaces` 中给出空间数，并在 `aggregate.scope` 中说明；`totalInsights` 统计未遗忘的记忆，`deletedInsights` 统计 Provider 保留下来的已遗忘记忆（Mnemon Native 会保留）。

<a id="interfaces-writeenabledtrue-时的工具"></a>

#### `writeEnabled=true` 时的工具

| 工具 | 用途 | Root Agent 路径 |
|---|---|---|
| `mnemo_runtime_memory` | `add` / `replace` / `remove` 运行时记忆 | 确定性控制；add 溢出时可能启动 worker |
| `mnemo_document_manage` | 创建、更新或归档档案 | 创建/更新确定性；归档使用 worker，没有记忆空间能接收索引时不经 worker 直接归档到本地 |
| `mnemo_remember` | 按 Provider 语义沉淀洞察，回执区分已接受与持久提交 | `spawn` write worker |
| `mnemo_link` | 在支持能力的 Provider 中建立 typed relationship | `spawn` write worker |
| `mnemo_forget` | 在支持能力的 Provider 中按精确 ID 删除 | 仅限显式操作的 `spawn` write worker；自主蒸馏不含此工具 |
| `mnemo_memory_body_create` | 由 Agent 创建独立 Mnemon Native 记忆空间；第三方连接只由用户在 WebUI 管理 | `spawn` write worker |
| `mnemo_memory_body_update` | 更新名称、说明或 active | `spawn` write worker |
| `mnemo_memory_body_merge` | 非破坏性合并 Mnemon Native 记忆空间 | `spawn` write worker |

worker 内或 MCP 中调用同名工具时直接进入服务层，不再递归委派。

默认三层策略在当前视图提供 `remember` 时，会提示模型在结束回合前判断是否形成了经过验证、能改变未来做法的新经验。每条可以独立复用的经验可分别通过 `mnemo_remember` 保存。同一结论的根因、修复和适用条件应放在一起。两条经验均已持久化、ID 已核实、位于同一记忆空间，且明确的关系有助于未来召回时，可在视图和 Provider 支持的情况下调用 `mnemo_link`。模型应尊重用户不记录的要求，跳过重复、临时内容及仅从记忆检索出的事实。

写入工作区档案后，返回给模型的是它写入的那份档案（带 `contentHash`，不含刚发送的正文，也不含路径）以及 `documents` 中该层的合计：未归档与已归档的数量、未归档的字节数和上限。包含摘录和路径的全部档案目录留在 WebUI 读取的控制面。`mnemo_forget` 因本回合的 View 不读取某个空间而被拒绝时，会说出是哪个空间以及原因：空间未激活（是否激活由用户决定，激活后从下一回合起才能遗忘）；它的 Provider 已关闭或未安装；或者它是在本回合开始之后才激活的。

自主 write worker（蒸馏与 supervised writeback 运行）自行决定写入内容，因此宿主在其硬性工具白名单中排除了 `mnemo_forget`：遇到重复或冲突时只能跳过或写入修正后的条目，不能删除已有记忆。请求目标由用户或用户侧流程显式给出的操作（`/mnemon forget`、`mnemo_link` 与记忆空间管理）保留完整 write 工具面。

空闲审查从已完成会话提炼有长期价值的项目知识或用户明确陈述的常设规则。候选已记录、证据不足或没有持久变化时返回跳过。它可以搜索档案，并通过 `mnemo_document_manage` 新建档案（`action=create`）或更新当前 View 可见的档案（`action=update`）。已有档案覆盖候选时跳过；新增知识适合补入现有档案时，按精确 ID 更新并保留已有依据和细节。Host 拒绝归档及其他操作，并以已提交的工具回执核实变更和档案 ID。容量不足时拒绝新建或更新，已有档案不会为这次写入腾出空间。

`mnemo_runtime_memory` 对共享工作准则执行 `add`、`replace` 或 `remove`，调用请省略原 `target`。可选 `branches` 数组限定 DSH 会话适用的 Git 分支。替换时提供 `branches` 修改范围，传空数组清除范围，省略则保留范围。

具名工具的参数名是 `old_text`，内部 Runtime `mutate` Action 使用 `oldText`。两个入口都以条目正文匹配。记忆空间的 `memoryBodyId` 是空间 ID，`mnemo_memory_body_update` 修改的是空间配置。当前 Provider 契约没有按 ID 原地修改洞察的操作，`mnemo_remember` 可能按 Provider 语义去重或合并，无法保证修订指定 ID。

<a id="interfaces-工具准入建议"></a>

### 工具准入建议

用户只说“记住这件事”时，按以后如何使用来选写入层。用户明确指定了存放位置时，按指定位置处理。

- **运行时**使用 `mnemo_runtime_memory`，保存未来回合应默认应用的长期偏好、常设约定和简明环境事实。例如“以后提交前都运行类型检查”。
- **档案**使用 `mnemo_document_manage`，保存需要一起保留背景、依据和步骤的工作区记录。例如一份包含时间线、证据与修复过程的故障复盘。
- **记忆空间**使用 `mnemo_remember`，保存将来遇到相关问题时才需召回、能够独立复用的已验证经验。例如一个经验证的故障原因和修复方法，连同适用条件。
- **跳过**问题、猜测、临时进度、完成日志、原始输出、秘密和可轻易从仓库重新发现的普通事实。

同一条知识只选一层。一次故障可以留下完整复盘，也可以提炼一条复盘之外有独立用途的经验。先检查目标层是否已有对应记录，有则补充或跳过。未来用途确实影响选层且无法从上下文判断时，先确认用户想怎么用。目标层不可用或拒绝写入时，说明情况并让该条内容保持未保存。

遇到有辨识度的报错、失败症状或疑似复发的问题，在决定第一项诊断检查前，用组件名、错误特征和已知触发条件做一次聚焦召回。命中后先核对适用条件，再做能区分原因的最小验证；没有可用命中时继续排查。沉淀排障经验时保留可识别的症状、适用条件、已验证的原因（若已知）和最短的已验证检查或修复步骤。完整调查过程保存在工作区档案。

`mnemo_forget` 是破坏性语义操作；只有用户明确要求，或内容已确认错误 / 过时时才应执行。宿主通过把该工具排除出自主 worker 的白名单来强制这一点；用户明确要求时主代理仍可调用。

<a id="interfaces-模型工具与-mnemon-cli"></a>

### 模型工具与 Mnemon CLI

模型工具和 Mnemon CLI 通过不同的路径访问同一份 Mnemon Native 记忆。工具作用于当前 View 固定的空间，使用 dsh-mnemo-weave 的存储根目录，以及 DSH 管理嵌入时的地址、模型和密钥。CLI 每次只作用于一个 Store：`--store <id>`，否则是 `MNEMON_STORE`，再否则是它的 active 文件；所在的数据目录由 `--data-dir` 决定，否则是 `MNEMON_DATA_DIR`，再否则是 `~/.mnemon`。dsh-mnemo-weave 的全局范围使用同一个目录，所以只要两边看到的 `MNEMON_DATA_DIR` 相同，在终端运行的命令就能访问它的记忆；工作区范围或自定义数据目录需要把该目录作为 `--data-dir` 传入。只有带上对应的 `--store`，才能找到另一个 Store 里的记忆。

| 任务 | 模型工具 | Mnemon CLI |
|---|---|---|
| 召回记忆 | `mnemo_recall`：View 中每个已激活的空间 | `mnemon recall` 或 `search`：一个 Store |
| 搜索工作区档案 | `mnemo_document_search` | 无：工作区档案是 dsh-mnemo-weave 自己的层 |
| 沿图谱查看关联记忆 | `mnemo_related`：在 Mnemon Native 空间中每条结果标明 `edgeType`，`edge` 只沿一种边 | `mnemon related <id>` |
| 保存记忆 | `mnemo_remember`，经由写入任务 Agent | `mnemon remember` |
| 关联两条记忆 | `mnemo_link` | `mnemon link` |
| 遗忘记忆 | `mnemo_forget`：View 读取的空间；未激活的空间要等用户激活后的下一回合 | 在指定的 Store 中 `mnemon forget <id>` |
| 新建空间 | `mnemo_memory_body_create`：一个 Store 及其 dsh-mnemo-weave 登记 | `mnemon store create`：只有 Store；它位于 dsh-mnemo-weave 的数据目录中时，dsh-mnemo-weave 会把它列为未激活的空间 |
| 重命名、修改说明、激活或取消激活 | `mnemo_memory_body_update` | 无：这些属于 dsh-mnemo-weave |
| 合并空间 | `mnemo_memory_body_merge` | 导入草稿的 `mnemon import` |
| 删除空间 | 无：在 WebUI 的记忆空间页面删除 | `mnemon store remove`，dsh-mnemo-weave 的登记仍会留下，它下一次检查状态时会在原处创建一个空的 Store |
| 查看健康状况与数量 | `mnemo_status`：已激活、正常且 Provider 提供统计数据的空间的合计 | `mnemon status`：一个 Store |
| 向量覆盖率 | 无：Mnemon Native 嵌入设置中的「测试状态」 | `mnemon embed --status` 与 `--all`：一个 Store |
| 选择 active Store | 无：View 每个回合固定空间 | `mnemon store set`：只影响 CLI 自己的默认值 |

模型从不删除空间，也不切换 Mnemon 的 active Store；这些由用户决定。

<a id="interfaces-mnemon-命令"></a>

### `/mnemon` 命令

```text
/mnemon
/mnemon status
/mnemon recall <查询>
/mnemon related <完整记忆 ID>
/mnemon remember <内容>
/mnemon forget <精确 ID>
```

- 空 `/mnemon` 等价于 `status`。
- `status` 是确定性读取，不启动模型。
- `recall`、`related` 通过命令所在 live Agent 的限定 Source 路由直接读取，不启动 worker；`remember`、`forget` 使用该 Agent 作为写入 worker 的 parent。
- 命令 recall 最多返回 10 条。
- `forget` 必须接收一个不含空格的精确 ID。
- `forget` 仅在收到 `forgotten` 回执时报告删除成功；跳过、失败或未确认的结果返回错误并附 worker 摘要。

<a id="interfaces-界面注册"></a>

### 界面注册

Mnemon 在 DSH 中展示的一切都注册到 DSH 自己的界面区域。对话内的注册都是增量的，不替换 DSH 官方渲染。

| DSH 区域 | 注册 | 行为 |
|---|---|---|
| `conversation.chat.turnTail` | list，`id=dsh-mnemo-weave/turn-tail` | 通过 `turn-activity` 汇总完成回合中的 `mnemo_*` 调用，以及工具活动元数据中每次调用读到或写入的内容；无活动或未完成回合不渲染 |
| `conversation.chat.turnTail` | list，`id=dsh-mnemo-weave/skill-tail` | `skills.hints` 开启时：通过 `skill-activity` 列出每个完成回合用到的技能，以及随后复盘的状态和仍在等待的建议；没有内容的回合不渲染 |
| `conversation.chat.assistant-actions` | list，`id=mnemon-save` | 通过 `assistant-message` 读取已定稿文本；只在用户确认后调用 `supervise` |
| `conversation.session.header.lineage` | DSH 官方条目的低优先级副本 | 任务 Agent 会话页眉只统计该 Agent 自己的 token，不含其 fork 来源的日志 |
| `plugins.bundle.config` | keyed，`dsh-mnemo-weave` | 插件页中 dsh-mnemo-weave 页面上的界面设置 |
| `plugins.row.config` | keyed，`dsh-mnemo-weave#<row>` | 每个随包组件的行打开的页面，含该组件注册的设置 |
| `plugins.detail.actions` | list，`id=dsh-mnemo-weave/open-workspace` | 从插件详情页打开记忆系统 |
| `sidebar.panellist` 与 `main` | `id=mnemon-skills` | `skills.sidebar` 开启时：技能管理在记忆系统之后的独立侧边栏入口与页面，此时记忆系统不再显示技能管理页 |

Mnemon 自己声明两个 keyed 区域，都以组件包名为键：`mnemon.component.settings` 渲染在该组件的页面上，`mnemon.component.status` 是它在状态页上的卡片。官方组件与第三方组件都通过这两个区域注册，见[插件开发](extensions.md)。

`assistant-message` 读取的候选可编辑，长回复会按界面上限截取；确认后会启动独立任务 Agent，写入结果以它的落定回执为准。

<a id="interfaces-工作区路由"></a>

### 工作区路由

Web 工作台请求携带 `sessionId` 和可选 `workspaceId`。Host 只接受 `workspaceRegistry` 已登记的 ID：

- 确定性读取与人工维护可以路由到 `workspaceId` 选择的查看根；
- Agent、工具、命令和生命周期仍按 `sessionId` 对应 Agent cwd 路由；
- `status.workspaceContext` 返回 selected / effective roots 与 `aligned`；
- 工作台发起的独立任务 Agent 使用查看工作区，不要求当前主会话与其对齐；对话工具仍使用所属会话的 cwd 和本轮 View，不借用工作台的查看范围。

Headless 等没有 Web 工作区目录的 profile 不提供任意查看目标；Agent 执行仍直接根据 session cwd 路由 `workspace` 范围。

<a id="interfaces-rpc-通道"></a>

### RPC 通道

RPC 是 DSH Host 与插件客户端之间的内部桥，不是稳定外部 HTTP API。页面与组件插件应使用 `dsh-mnemo-weave/client` 提供的限定范围客户端，见[插件开发](extensions.md)。

| 通道 | 承载 | 远程页面 |
|---|---|---|
| `/dsh-mnemo-weave-read` | 状态、目录、检索与对话读取 | 允许 |
| `/dsh-mnemo-weave-activation` | 开关单个记忆空间 | 允许 |
| `/dsh-mnemo-weave-write` | 其余所有 mutation | 需要 `remoteAccess: trusted-host` |
| `/dsh-mnemo-weave-pack` | 备份导出与导入 | 需要 `remoteAccess: trusted-host` |
| `/dsh-mnemo-weave-sync` | 服务器连接设置与全局增量同步 | 需要 `remoteAccess: trusted-host` |
| `/dsh-mnemo-weave-review` | 合并记忆的整理建议、审查意见，以及执行已接受的方案 | 需要 `remoteAccess: trusted-host` |
| `/dsh-mnemo-weave-settings` | Host 与界面设置 | `get` 允许；`mutate` 需要 `remoteAccess: trusted-host` |
| `/dsh-mnemo-weave-view` | 记忆组合读取 | 允许 |
| `/dsh-mnemo-weave-view-settings` | 保存记忆组合、安装组件 | 需要 `remoteAccess: trusted-host` |

回环页面直接调用这些通道，由 DSH 浏览器会话认证。远程页面经 DSH API Gateway 到达同一组处理器：通道 `/api`，endpoint 为 `dshMnemon/read`、`dshMnemon/activation`、`dshMnemon/write`、`dshMnemon/pack`、`dshMnemon/settings`、`dshMnemon/view`、`dshMnemon/viewWrite`、`dshMnemon/sync` 与 `dshMnemon/review`。Gateway 负责 Host/Origin 校验、浏览器配对与响应封装；Mnemon 只额外施加上表中的 `remoteAccess` 授权，并在启动时确定。见[远程管理](operations.md#ops-远程管理)。

Gateway 通过 Mnemon 在 `dshMnemon` 命名空间下的 `mnemonRemote` Typert 服务到达这些处理器，其命名远程方法为 `read`、`activation`、`write`、`pack`、`settings`、`view`、`viewWrite`、`sync` 与 `review`。缺少该授权时，`write`、`pack`、`sync`、`review`、`viewWrite` 与 `settings` 的 `mutate` 会返回 `remote Mnemon management requires remoteAccess: trusted-host`；`read`、`activation`、`view` 与 `settings` 的 `get` 不需要。

<a id="interfaces-读通道"></a>

#### 读通道

| Endpoint | 行为 |
|---|---|
| `status` / `status-summary` | 服务、版本、生命周期、档案、存储与工作区上下文及当前 Memory System 描述符；`status-summary` 不等待任何 Provider I/O |
| `memory-system` | Serving/候选评估、脱敏 Source 实例描述符与当前参与配置 |
| `versions` | Mnemon CLI 与 dsh-mnemo-weave 的当前 / 最新版本和安装来源 |
| `task-agent-models` | 独立任务 Agent 可用的模型 |
| `runtime-memory` | 运行时快照 |
| `documents` / `document` / `document-search` | 档案目录、正文与确定性搜索 |
| `diagnostics` | 宿主最近的操作记录，最新的在前；可选 `limit` 限制条数（最多 200）。不要求记忆能力，因为它描述当前进程而不是记忆内容 |
| `memory-activity` | 最近记录的记忆活动事件，最新的在前，合并所选工作区与全局工作准则两个活动流；可选 `limit`（最多 100，默认 50）。返回结构化字段（活动流、类型、来源、操作、结果、跳过原因、条数、耗时、已提交写入数），不含正文、查询词、路径或错误原文。清空事件只标出流的起点，不作为一行返回。它读取与同步相同的事件文件，因此这些记录跨机器一致 |
| `graph` / `bodies` / `body-directory` | active 多空间图谱投影、含 Provider 能力的记忆空间目录与快速目录投影 |
| `body-reconnect` | 清除短期健康状态并刷新单个记忆空间，不修改持久数据 |
| `provider-services` | 脱敏的 Provider 服务目录；可包含已配置的凭据字段名，绝不包含凭据值 |
| `provider-service-check` | 在不修改已保存配置的前提下检查单个 Provider 的连通性（原生检查 CLI，第三方通过 `discover` 探测并返回可见记忆空间数或错误原因） |
| `embedding-status` | Mnemon 嵌入模型与可用性，以及每个 Mnemon Native 空间的向量覆盖率和合计 |
| `local-embedding-status` | 本地 `llama.cpp` 嵌入运行时（`llama-server`）、所选 GGUF 模型预设与本地端口健康状态 |
| `list` / `entities` | 内容列表与实体聚合 |
| `search` / `agent-search` / `related` | 直接检索、证据回答与关系遍历 |
| `turn-activities` / `turn-activity` | 会话或单回合的记忆工具活动 |
| `skill-activity` | 一段对话按回合列出的技能使用，以及随后每次复盘的状态（scheduled、reviewing、suggested、nothing、error）和仍在等待的建议；有在线 Agent 时由它回答，从历史记录重新打开的对话则读取已存储的会话 |
| `assistant-message` | 按 messageId 读取已定稿助手文本 |
| `source-management-catalog` / `source-management-read` / `source-assistance` | 通用 Source 管理：实例目录、声明的读取操作与只读辅助检索 |

<a id="interfaces-激活通道"></a>

#### 激活通道

`/dsh-mnemo-weave-activation` 的请求 schema 比写通道更窄。`body` endpoint 只接受 `memoryBodyId`、布尔值 `active` 和常规 session / workspace 路由字段；`source-assistance` 以经确认的 `activation` 操作接受同样两个字段，仅作用于 Memory Spaces 实例。两者只控制记忆空间是否参与 DSH 读取与路由，不接受元信息、Provider 连接、凭据、删除或持久记忆 mutation。只读模式会在 Host 边界拒绝。

<a id="interfaces-写通道"></a>

#### 写通道

| Endpoint | 行为 |
|---|---|
| `runtime-memory` | 运行时记忆修改 |
| `document` | create / update / archive |
| `supervise` | 用独立任务 Agent 处理候选并返回落定回执 |
| `remember` / `link` / `forget` | 长期语义写入、关系与软删除 |
| `body-create` / `body-update` / `body-delete` / `body-merge` | 创建或连接、编辑、确认后的 Native 删除或远程断开，以及合并记忆空间 |
| `body-metadata-maintain` | 由任务 Agent 刷新 1 到 20 个 active 记忆空间的名称与说明 |
| `provider-service-update` | 更新单个 Provider 服务；凭据仅在 Host 保存，响应脱敏 |
| `embedding-fill` | 为一个 Mnemon Native 空间补齐缺少的向量，使用 Host 的存储根目录与嵌入设置；最多运行一分钟，每步最多十秒，返回补齐与仍缺少的数量 |
| `local-embedding-deploy` | 一键下载并部署本地 `llama-server` 与所选 GGUF 嵌入模型（`qwen3-embedding:0.6b` 或 `qwen3-embedding:4b`），支持断点续传 |
| `local-embedding-control` | 手动启动（`start`）或停止（`stop`）本地 `llama-server` 嵌入进程 |
| `memory-activity-clear` | 删除记忆活动：删除所选工作区活动流与全局工作准则活动流当前已有的全部事件，各留一条清空事件，返回两者被删除的事件数。清空事件随活动同步传输，服务端据此丢弃被取代的批次；只读模式拒绝 |
| `source-management-mutate` / `source-assistance` | 通用 Source 管理 mutation，以及按 Source 当前修订确认的 Host 辅助操作；技能管理的辅助操作是 `skill-draft`、`skill-backtest`、`skill-derive-cases` 与 `skill-review-now`，均由任务 Agent 执行 |
| `version-update` | 安装或更新明确组件（含 `mnemon` CLI 未安装时通过 `npm` 全局一键安装）；Host 固定命令与参数 |

`provider-services` 通过读通道返回脱敏目录。设置编辑器只知道哪些凭据字段已经配置；保存新的值或显式清除字段，不回读已保存的凭据值。

`writeEnabled=false` 时激活通道与写通道仍保持注册，但所有 mutation 都在 Host 边界拒绝。浏览器也会根据 Host settings snapshot 在传输前禁用 mutation 控件。

<a id="interfaces-备份通道"></a>

#### 备份通道

| Endpoint | 行为 |
|---|---|
| `target` | 当前有效根、范围，以及“默认位置”对应的默认根 |
| `export` | 导出完整、带 manifest 与 SHA-256 校验的 ZIP |
| `inspect` | 解析并校验待导入 ZIP，返回组件与占用预览 |
| `import` | 把 ZIP 安全合并到当前有效根；只读模式拒绝。结果里的 `runtime` 回报合并新增了几条、又有几条因为本机记录过删除而留在原处，可选 `revive: true` 表示这次导入推翻这些删除 |

备份包含私有记忆；调用方必须把已认证 DSH 浏览器会话视为完整 Host 权限，并单独保护导出的归档。

<a id="interfaces-同步通道"></a>

#### 同步通道

- `connection` 返回服务器地址、是否已配置和凭据库是否可写。
- `save-connection` 接收 `url` 和 `password`，验证服务器后写入凭据库。响应使用与 `connection` 相同的字段。
- `progress` 返回宿主进程当前的服务器同步：进行中时给出阶段（`prepare`、`snapshot`、`activity`）、正在同步的范围、本次步数与当前步序号，以及当前步已传输的文件数；结束后 `running` 为 `false`，`last` 保留最近一次结果，含 `state`、结束时间、耗时、拉取与推送数量，失败时带 `error`，快照冲突时带 `conflictTarget`。该状态只保存在宿主进程内，重启后清空。
- `sync-all` 按游标同步工作准则、各存储根及活动。同步要求宿主可写。解决冲突时传入 `resolve: "server"` 或 `resolve: "local"`、本次冲突的 `conflictToken` 和 `confirmed: true`。同一宿主进程同时只运行一次同步，进行中再次调用会被拒绝。宿主自身在 `autoSync.enabled` 开启时按 `autoSync.intervalMs` 调用同一条路径，因此定时运行与页面点击共用同一把锁与同一份进度记录；因冲突停止时定时器暂停，其它失败按间隔重试。一次同步使用自己的时间预算（600 秒），不随发起它的 HTTP 请求结束而中止：页面跳转或连接重建只结束那次调用，同步继续在宿主中完成，结果从 `progress` 读取。
- `server-sync-rules`、`server-sync` 和 `server-sync-activity` 继续服务旧客户端。

接入说明见[服务器同步与部署](sync.md#ops-服务器同步)。

<a id="interfaces-审查通道"></a>

#### 审查通道

| Endpoint | 行为 |
|---|---|
| `view` | 审查账本：文件路径、全部建议与待审查数量；只读 |
| `opinion` | 为某条建议追加一条意见；除非调用方指定 `agent`，作者记为 `user` |
| `decide` | 接受或拒绝一条待审查建议 |
| `reopen` | 把已决定的建议退回 `pending`，并清掉已执行位置的记录，让整份方案重新成为一次待审查的决定 |
| `reconcile` | 对本机记忆执行一次整理，把计划暂存为新的待审查条目。可选 `guidance` 字符串说明计划要达成什么，证据中会带上待审查建议已记录的意见；需要 `writeEnabled` |
| `apply` | 执行已接受建议的操作，遇到第一个失败即停止。可选 `operations` 数组给出计划中的位置，只执行这些操作，因此审查者可以只采纳计划的一部分。已经执行过的位置会被跳过，没有剩余可执行操作的建议会被拒绝而不是重放；需要 `writeEnabled` |

整理本身从不写记忆：模型返回计划，计划被记录为一条建议，只有对已接受的建议执行 `apply` 才会触碰 Source。每条建议用 `appliedOperations` 记录已经执行过的位置，因此只执行一部分可以重复进行，剩下的位置也正是调用方还能看到的部分。`view`、`opinion`、`decide` 与 `reopen` 在只读 Host 上同样可用，因为它们只编辑 `state/` 下的账本。账本不是 Pack 组件，因此任何建议都不会同步到其他机器。

<a id="interfaces-设置通道"></a>

#### 设置通道

`/dsh-mnemo-weave-settings` 为三个命名空间提供 `get` 与 `mutate`：`mnemon` 管理 Host 与存储设置，`mnemon-ui` 管理 `turnBar` 与 `saveAction`，保存为 `conversationInteraction`，`mnemon-skills` 管理技能管理的设置，保存为 `skills`（见[技能管理设置](configuration.md#技能管理设置)）；`mnemon-skills` 的修改无需重建记忆运行图即可生效。mutation 携带 settings revision，防止覆盖并发编辑。插件页中的 dsh-mnemo-weave 页面（`plugins.bundle.config`）与记忆系统的**设置**页在回环页面和远程页面上都通过该通道读写。回环页面还会跟随 DSH `ctx.configForms` 中 `mnemon` 条目的 revision，在其他页面或 profile 重新加载改动它时重新读取该通道。

<a id="interfaces-记忆组合通道"></a>

#### 记忆组合通道

| 通道 | Endpoint | 行为 |
|---|---|---|
| `/dsh-mnemo-weave-view` | `dashboard` | 已安装组件、当前主策略、当前会话的 View 与回合活动，以及此处能否安装组件 |
| `/dsh-mnemo-weave-view` | `preview` | 按当前修订校验拟保存的组合，不写入 |
| `/dsh-mnemo-weave-view` | `inspect-plugin` | 读取组件包的 registry manifest：版本、`dsh-mnemo-weave` peer 范围，以及当前 Profile 是否已安装 |
| `/dsh-mnemo-weave-view-settings` | `apply` | 保存经确认的组合：主策略、组件开关与选项 |
| `/dsh-mnemo-weave-view-settings` | `install-plugin` | 用 DSH CLI 把经确认的包版本安装到当前 Profile |

`apply` 把主策略与各组件选项保存在 `mnemon-view` 设置范围（保存为 `memoryView`）；组件开关由 DSH 插件管理器写入 profile patch。见[配置参考](configuration.md)。

<a id="interfaces-npm-导出与扩展服务"></a>

### npm 导出与扩展服务

Core 发布 `ctx.mnemonMemory: MnemonMemoryService`，实际服务只提供 `installContributions`。Source/Strategy 作者通过 `inject = ['mnemonMemory']` 与 `installMemory` 注册，不获得引擎、控制器或注册表。各包的公开子入口以其 `package.json#exports` 为准；Source 可提供自己的 `./contracts` 和可选 `./client`。

| 入口 | 职责 |
|---|---|
| `dsh-mnemo-weave` | DSH Host 与默认 Starter |
| `dsh-mnemo-weave/core` | 不带 Host/UI 的、Source 无关的 `ctx.mnemonMemory` 服务 |
| `dsh-mnemo-weave/contracts` | JSON 安全的 manifest、facts、ViewSpec、View、Evidence、Receipt |
| `dsh-mnemo-weave/extension-sdk` | Source/Strategy 定义、生命周期注册与校验 |
| `dsh-mnemo-weave/testing` | 真实 Cordis 组合测试夹具与已构建 Client 制品加载器 |
| `dsh-mnemo-weave/client` | DSH 工作台与 Source 页面 SDK |
| `dsh-mnemo-weave-source-memory-spaces/provider-sdk` | Memory Spaces 自己的 Provider 子模块协议 |
| `dsh-mnemo-weave-source-memory-spaces/testing` | Provider 驱动测试夹具 |

模型通过当前回合允许的具名工具操作记忆。具名工具作用于其 Source 类型的 Starter 实例（Entry `mnemon-source-<type>`，嵌套在 include 下时也是），或该类型唯一的 Source。多个运行时 Source 都提供 `mutate` 时，`mnemo_runtime_memory` 写入 Starter 的运行时 Source；否则写入 View 唯一允许它写的那个。未绑定到具名工具的实例可通过工作台管理。浏览器管理使用 `source-management-catalog`、`source-management-read`、`source-management-mutate` 与可选 `source-assistance`，Host/Source 检查实例、确认、修订与当前权限。内部 RPC 名称不是插件 SDK，页面应使用限定实例的管理客户端。见[插件开发](extensions.md)。

<a id="interfaces-国际化范围"></a>

### 国际化范围

主要 Sidebar 工作台（含**设置**页）、插件页中的界面设置与对话内入口支持中文和英文，并跟随 DSH locale 实时切换。品牌名、工具名和配置键不翻译。`/mnemon` 命令、模型工具卡、部分 Host 错误与兼容元数据尚未完全国际化。
