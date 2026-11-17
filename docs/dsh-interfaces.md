# DSH 接口与工作流

<a id="interfaces-webheadless工具命令与-rpc"></a>

## Web、Headless、工具、命令与 RPC


本页是集成参考。日常使用请先看 [Sidebar 与对话交互指南](dsh-workbench.md)。

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
| 记忆系统中的**设置**页 | 是 | 记忆组合、存储、组件页面与备份 |
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

worker 内调用同名工具时直接进入服务层，不再递归委派。

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

回环页面直接调用这些通道，由 DSH 浏览器会话认证。远程页面经 DSH API Gateway 到达同一组处理器：通道 `/api`，endpoint 为 `dshMnemon/read`、`dshMnemon/activation`、`dshMnemon/write`、`dshMnemon/pack`、`dshMnemon/settings`、`dshMnemon/view`、`dshMnemon/viewWrite`、`dshMnemon/sync` 与 `dshMnemon/review`。Gateway 负责 Host/Origin 校验、浏览器配对与响应封装；Mnemon 只额外施加上表中的 `remoteAccess` 授权，并在启动时确定。见[远程管理](dsh-operations.md#ops-远程管理)。

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
| `graph` / `bodies` / `body-directory` | active 多空间图谱投影、含 Provider 能力的记忆空间目录与快速目录投影 |
| `body-reconnect` | 清除短期健康状态并刷新单个记忆空间，不修改持久数据 |
| `provider-services` | 脱敏的 Provider 服务目录；可包含已配置的凭据字段名，绝不包含凭据值 |
| `embedding-status` | Mnemon 嵌入模型与可用性，以及每个 Mnemon Native 空间的向量覆盖率和合计 |
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
| `source-management-mutate` / `source-assistance` | 通用 Source 管理 mutation，以及按 Source 当前修订确认的 Host 辅助操作；技能管理的辅助操作是 `skill-draft`、`skill-backtest`、`skill-derive-cases` 与 `skill-review-now`，均由任务 Agent 执行 |
| `version-update` | 更新明确组件；Host 固定命令与参数 |

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

接入说明见[服务器同步](dsh-operations.md#ops-服务器同步)。

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

`/dsh-mnemo-weave-settings` 为三个命名空间提供 `get` 与 `mutate`：`mnemon` 管理 Host 与存储设置，`mnemon-ui` 管理 `turnBar` 与 `saveAction`，保存为 `conversationInteraction`，`mnemon-skills` 管理技能管理的设置，保存为 `skills`（见[技能管理设置](dsh-configuration.md#技能管理设置)）；`mnemon-skills` 的修改无需重建记忆运行图即可生效。mutation 携带 settings revision，防止覆盖并发编辑。插件页中的 dsh-mnemo-weave 页面（`plugins.bundle.config`）与记忆系统的**设置**页在回环页面和远程页面上都通过该通道读写。回环页面还会跟随 DSH `ctx.configForms` 中 `mnemon` 条目的 revision，在其他页面或 profile 重新加载改动它时重新读取该通道。

<a id="interfaces-记忆组合通道"></a>

#### 记忆组合通道

| 通道 | Endpoint | 行为 |
|---|---|---|
| `/dsh-mnemo-weave-view` | `dashboard` | 已安装组件、当前主策略、当前会话的 View 与回合活动，以及此处能否安装组件 |
| `/dsh-mnemo-weave-view` | `preview` | 按当前修订校验拟保存的组合，不写入 |
| `/dsh-mnemo-weave-view` | `inspect-plugin` | 读取组件包的 registry manifest：版本、`dsh-mnemo-weave` peer 范围，以及当前 Profile 是否已安装 |
| `/dsh-mnemo-weave-view-settings` | `apply` | 保存经确认的组合：主策略、组件开关与选项 |
| `/dsh-mnemo-weave-view-settings` | `install-plugin` | 用 DSH CLI 把经确认的包版本安装到当前 Profile |

`apply` 把主策略与各组件选项保存在 `mnemon-view` 设置范围（保存为 `memoryView`）；组件开关由 DSH 插件管理器写入 profile patch。见[配置参考](dsh-configuration.md)。

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

<a id="workflows-生命周期与核心流程"></a>

## 生命周期与核心流程


本页描述 Core 内置的**分层策略**，它是唯一的策略。每个角色只组合一个 Source，因此挂载第二个同角色的 Source 会在每个回合因 "found ambiguous … Sources" 失败。具名工具服务各自的 Source。除各路由自身的上限外，它还应用每回合的召回准入信封，并承担 Runtime 容量维护、归档与空闲审查。见[策略与增强](dsh-workbench.md#capabilities-策略与增强)。

<a id="workflows-每轮上下文"></a>

### 每轮上下文

分层策略根据当前视图提供路由与工作准则指引，并按需更新 Wake 快照。工具能力变化后，以当前视图为准。

- `mnemon:strategy` 在内置 Runtime Source 参与投影时说明「工作准则」如何约束当前协作，以及何时可以更新准则。
- `mnemon:routing` 在 `routingGuidance=true` 时说明「工作区档案」如何保留工作区决策和来龙去脉，以及「记忆空间」如何按需找回长期知识。工具指引随当前视图能力裁剪。
- Wake 快照由当前 root 回合固定的不可变 View 渲染。内置 Runtime Source 提供受预算限制的工作准则投影。新快照仅取代同一来源实例的旧快照，省略条目可能是筛选或预算所致。Documents 与 Memory Spaces 提供有界封面。

Host 只在 Wake 内容变化时追加新的 user-role 插件消息，不再重新发送其他插件的共享上下文。快照保持完整状态，不构造依赖旧消息的补丁链；静态协议留在 system 前缀，Source 文本按原文传递而不做模板插值。回合、子 Agent 与运行代的所有权见[架构说明](architecture.md#design-生命周期与失败)。

生命周期会在 Host 组装 System Prompt 前固定 View，并让本回合所有模型 step 使用同一个 View：

```text
turn/start
  -> 进入 system-prompt/assemble hook
  -> beginTurn（根回合 + 操作范围）
  -> Source 能力事实 → Strategy 提案 ViewSpec → 校验 → Source 投影
  -> 固定 Source 修订/摘要与仅留在 Host 的权限
  -> 生成有界 Wake
  -> 继续 Host 提示词组装
  -> 让静态协议 section 与已固定的 Runtime Source 对齐
  -> 将变化后的 Wake 作为本插件的完整快照消息追加

agent/pre-step(step=1)
  -> 为新回合取消待执行/执行中的空闲审查
  -> 仅标记一次 Prime
  -> 每个会话至多追加一次简短 recall/writeback cue
  -> 主 Agent 决定是否调用记忆工具
```

Source snapshot 不执行语义召回。Prime 只初始化路由状态，不执行异步 CLI 状态查询。

子 Agent 在 `agent/created`、driver 启动前捕获并保留存活父 Agent 的固定 View 与运行图。自己的各个回合固定这一被保留的 View，即使父回合已结束或已进入更新的 generation。子 Agent activation 销毁时释放委托；冷恢复重新获取委托；Host 显式创建且没有父模型回合的后台子任务生成新的 scoped View。子 Agent 拥有自己的回合权限，但不安装 root 专属的 cue 或空闲审查。详见[权限生命周期](architecture.md#design-生命周期与失败)。

<a id="workflows-委派的子会话"></a>

#### 委派的子会话

dsh-mnemo-weave 委派给子 Agent 的每个任务都以单独的一行开头：`[dsh-mnemo-weave:delegated <operation>]`，任务从下一行开始。空闲审查是 `review`，写入和「存入记忆」是 `write`，技能复盘、草案、回测与评测用例生成是 `skill`，其余为 `answer`、`placement`、`migration`、`compaction`、`document-archive`、`metadata-maintenance` 和 `reconcile`。以后的版本可能增加操作，所以请匹配模式而不是这份清单。DSH 把任务记录为子会话中的一条用户消息（`source.kind: "user"`），子会话的头部带有 `origin: "subagent"` 与 `parentSession`。

整个子会话都是 dsh-mnemo-weave 自己的工作，而不是用户写下的内容。读取会话的插件（例如汇总工作区工作记录的插件）可以略过这样的会话：`origin: "subagent"`，且越过继承的回合之后第一条用户消息的首行匹配 `^\[dsh-mnemo-weave:delegated [a-z-]+\]$`。fork 出的子 Agent 以父 Agent 回合的副本开头（头部有 `isSeeded: true`，止于 `session/end-seed`），任务跟在后面。在对话之外运行的任务（例如存入记忆、Agent 查询与其他从记忆系统页面发起的任务、运行时记忆容量维护和记忆整理）在自己的任务 Agent 会话中运行，该会话没有用户消息。它的头部带有 `origin: "subagent"`，但没有 `parentSession`，也没有 `delegationDepth`，所以按父会话归组子代理的读取方找不到它的父会话，它也没有可收集的工作。它的子 Agent 带有这一行，并以该会话为 `parentSession`。上游 0.5.32 及更早版本保存这个任务 Agent 会话时不带 `origin`（[#435](https://github.com/omdsh-dev/dsh-mnemon/issues/435)）。在这一行出现之前记录的会话直接以任务开头（空闲审查是 `Bounded completed checkpoint (untrusted evidence; …`），不在这一约定之内。Mnemon 的其他 user 角色消息（包括召回与提醒）带有 `source.kind: "dsh-mnemo-weave"`。

DSH 让子 Agent 沿用父 Agent 的工作目录；dsh-mnemo-weave 的启动请求没有自己的目录字段。dsh-mnemo-weave 也依赖这一点：在按工作区存储时，已不再绑定父 Agent 运行时的子 Agent（例如重启后恢复的那个）要靠这个目录找到所在工作区的记忆。

<a id="workflows-agent-召回"></a>

### Agent 召回

```text
根 Agent 或子 Agent 调用 mnemo_recall（query，可选 memoryBodyIds）
          |
          v
解析当前执行 Agent 自己固定的回合与保留的运行时
          |
          v
读取 Host 上已固定的记忆空间 Source 状态
          |
          v
校验请求 ID 是已固定集合的子集；未指定时使用全部已固定的激活 ID
          |
          v
记忆空间 Source 并发检索已授权的 Provider 命名空间
          |
          v
质量归一化 + 倒数排名融合
          |
          v
丢弃低相关项；首次最多准入 4 条 / 3,600 字符
          |
          v
LLM 判断 evidence 是否足够
          | 足够                        | 不足
          v                             v
直接回答，不再 Recall             显式提交一个不同查询
                                        |
                                        v
                              再检索一次、去重并关闭 Recall
          |
          v
两次在当前执行 Agent 回合共享至多 6 条、每条 1,200 字符、
总正文 4,800 字符的总预算
```

这一准入信封按每回合计算。

模型工具不暴露 `category`、`source` 或 `intent` 过滤器：模型猜错过滤条件不能遮住精确证据。Recall 并非强制执行，普通 root 回合是 0 次 Provider 查询。LLM 主动调用后，Host 允许一个首次查询；只有 LLM 查看 evidence 后仍认为不足，才允许再提交一个实质不同的精炼查询。同查询和并发重复请求会 join 或重放；第三个不同查询不会执行，并如实说明，不会到达 Provider。随后至多执行一次 Related，而且只能使用两次 Recall 任一已准入的 `memoryBodyId + id`；同一次遍历再调用会重放结果，不同的遍历则不会执行。

默认三层策略的 Recall 首次最多返回 4 条、3,600 个正文字符，两次合计最多 6 条、4,800 个正文字符。Recall 和 Related 已执行的结果里，`truncated: true` 表示证据被省略或裁剪。`category`、`source`、`intent` 在默认 Recall 中会被拒绝，且不消耗查询预算。需要筛选时请使用查询文本或 `memoryBodyIds`。

Recall、Related 和单次 Documents 搜索槽位按执行中的 Agent 回合计预算。同一回合内并发调用共享状态，兄弟任务、后续回合和冷恢复的 activation 不会共享缓存 evidence 或占用彼此的预算。子 Agent 从收到任务到最后一步算作一个回合、共用一份预算；之后继续这个子 Agent 的消息会开始另一个回合，预算重新计算。重复回合内已运行过的 Recall 或 Related 读取会重放它自己的 evidence，并限于本次请求的 Memory Space 子集。超出预算的另一次读取（包括第二次 Documents 搜索）不会执行查询，而是以它自己的查询返回 `notRun: true`、`budgetExhausted: true` 和空的 `results`，绝不返回另一次读取的 evidence；并发调用会先等正在进行的读取结束，因为失败的读取会把名额还回来。从本回合召回未准入的条目出发的 Related 遍历同样返回 `notRun: true`。Document search 另有独立边界：最多 4 条记录、每条最多 2,600 个查询附近字符、总正文最多 6,000 字符。模型侧 Memory Space 目录最多 16 项，`mnemo_status` 只返回紧凑健康汇总。完整记录、Provider 设置、路径和逐 Space 统计仍由 Web/RPC 控制面读取，不进入对话历史。

如果用户已经提供当前事实，或仓库可以直接回答，Agent 不应为了“展示记忆”而召回。

<a id="workflows-web-检索和-agent-查询"></a>

### Web 检索和 Agent 查询

Web “检索”页与模型工具路径不同：

```text
直接检索
  -> RPC 读取通道
  -> 限定到 Source 的管理检索
  -> 原始证据

Agent 查询
  -> 同一条确定性直接检索路径
  -> 派发不含 Mnemon 工具的任务 Agent
  -> 仅根据已提供的证据回答
  -> Host 将引用限定到实际的 memoryBodyId/id 对
```

“实体”和“内容”页也经 Source 管理协议执行确定性读取，不需要第二个模型。“内容”使用 Provider 的只读 browse 契约，不冒充语义 Recall。

<a id="workflows-显式长期写入"></a>

### 显式长期写入

根 Agent 或 `/mnemon remember` 的长期写入流程：

```text
长期记忆候选
       |
       v
派发写入任务 Agent
       |
       +-- 列出记忆空间
       +-- 指定的空间，或最小的适用已激活范围
       +-- 需要查重或检查冲突时召回
       +-- 只有反复出现的独立领域才创建新范围
       +-- 按请求执行 remember / link / forget / merge
       v
结构化回执
```

空存储根首次创建 Memory Space 时使用 Mnemon 原生 `default` ID，后续 ID 由 Host 生成。向 inactive 目标写入成功后会激活它。这里的激活只影响 DSH 路由；来源数据库的合并是非破坏性的。

`mnemo_remember` 指定了记忆空间时，写入任务 Agent 只写到那里，否则不写。Host 在任务 Agent 启动前检查指定的空间：不存在的空间、Provider 已关闭或不接受写入的空间，以及已停用的空间，都会立即失败并说明原因。只有用户明确要求时，模型才使用空间管理工具。用户也可以在工作台启用空间；用户在记忆空间页上选中的停用空间会随写入重新打开。自动经验写入的任务 Agent 不提供空间管理工具。指定目标时，宿主的守卫也会拒绝写入其他空间的 `mnemo_remember` 或 `mnemo_link`。

没有指定空间时，任务 Agent 在已激活的空间和它自己新建的空间中选择；守卫会拒绝写入或关联运行开始时就处于停用状态的空间，也拒绝把它打开。存入记忆从不合并空间。「存入记忆」遵循同样的规则，所以所有空间都停用时，除非任务 Agent 新建一个空间，否则不会保存任何内容。结果中的 `memoryBodyIds` 取自 Source 回执实际写入的空间，包括 Code Mode 程序中写入成功、之后程序才失败的那次写入；任务 Agent 报告了写入、却没有任何回执能证明时，结果为 `unknown`。写入打开了停用的空间时，`activatedMemoryBodyIds` 会列出它。来自不在本地运行子 Agent 的 provider 的任务 Agent，像以前一样不受守卫地运行；DSH 在守卫看不到的地方发布本地任务 Agent 时，写入会失败。运行结束后，委派的任务 Agent 不能再使用记忆工具：在 DSH 0.2.1 上，其他 Agent 给已结束的任务 Agent 发消息会让它从保存的状态恢复运行，这时它也无法再写入。

嵌入没有成功时（服务不可用或缺少模型），Mnemon Native 会在没有向量的情况下保存记忆，并在回执中说明（`embedded: false`）。经由任务 Agent 的写入会在 `unembedded` 中列出这些记忆，并附上 `hint`：补齐向量之前，它们不参与语义匹配，关键词、关联与时间召回仍能找到它们；嵌入服务可用后，可在 Mnemon Native 嵌入设置的 **测试状态** 中补齐。补齐使用 DSH 的存储根目录和嵌入设置，在终端运行的 `mnemon` 命令未必一致。`/mnemon remember` 会加一行说明；对话中和记忆空间页上的 **存入记忆** 回执也一样，无论记忆由任务 Agent 写入，还是直接写入某个空间；只有写入确实存入了记忆时才显示这一行。这一行的措辞只取决于 `embedding` 设置。DSH 不管理嵌入配置时（`enabled: false`，默认值），DSH 不设置任何嵌入服务，这一行是中性的说明，并指出关键词检索不受影响；不由 DSH 管理的服务没有生成向量时也是如此，例如只在 Mnemon CLI 继承的环境中配置的服务，或 Mnemon 默认地址上没有运行或缺少模型的 Ollama。DSH 管理嵌入配置时，这一行说明嵌入没有成功，回执中以提醒的颜色显示。模型读到的 `hint` 在两种情况下相同。

运行时 `add` / `replace` / `remove` 和 Document `create` / `update` 不需要模型做存储 I/O；它们通过 coordinator 进入确定性控制层。容量维护和归档才启动专用 worker。

<a id="workflows-runtime-add正常路径"></a>

### Runtime add：正常路径

```text
请求
  -> 规范化内容
  -> 获取进程内队列与文件锁
  -> 重新加载 memories.json
  -> 校验唯一匹配 / 重复 / 容量
  -> 写入临时 JSON 与 Markdown 投影
  -> 重命名投影文件
  -> 重命名 memories.json，作为提交标记
  -> 返回紧凑回执
```

`replace` 和 `remove` 在请求的目标内，优先用 `old_text` 唯一匹配完整正文；没有精确匹配时才使用唯一子串。重复的完整正文仍视为有歧义。只有请求中的 add 或增大正文的 replace 会超过目标上限时，才触发容量维护。

<a id="workflows-usermd-容量整理"></a>

### USER.md 容量整理

容量整理与下文的 MEMORY.md 归档都由 Host 执行。

```text
USER 新增后超过 4 KiB
          |
          v
保存修订与已提交条目的快照
          |
          v
派发无工具权限的本地压缩任务
          |
          v
返回压缩条目 + sourceIndexes
          |
          v
Host 校验：
  - 每个来源索引恰好出现一次
  - 没有重复或越界索引
  - 重要性未降低
  - 候选符合 Host 字节预算
  - 修订仍是当前版本
          |
          +-- 无效/冲突 -> 保留原始数据
          |
          v
按 UTF-8 字节确定性装填
          |
          v
重试待处理的新增操作
```

用户画像不会被发送到 Memory Spaces。worker 没有任何工具权限。

<a id="workflows-memorymd-归档与压缩"></a>

### MEMORY.md 归档与压缩

```text
分层策略下，本次 MEMORY 写入将超过配置上限（默认 10 KiB）
          |
          v
snapshot revision + 可归档的已提交 entries
（排除待提交 add，以及正被 replace/remove 的 entry）
          |
          v
Host 在本次操作的 Source / 命名空间范围内选择已有、active、可写的 Memory Spaces
          |
          +-- 任何地方都没有（该层关闭或不接受自动写入、没有就绪的 Provider、
          |   没有支持精确写入与安全删除的 active 空间）
          |     -> Runtime Source 在同一把锁内把压缩舍弃的条目追加到 runtime/archived/，
          |        再提交压缩与待提交修改；不调用模型，也不写 Provider
          |
          v
单个目标：Host 直接路由
多个目标：独立无工具 worker 只返回 source-index 路由
  模型执行失败时，Host 在合格目标中确定性兜底
          |
          v
Host 校验精确 source coverage、目标、权限与源修订
          |
          +-- 无效/revision 已变 -> 不写 Provider；保留 Runtime
          |
          v
Host 把每条原始 entry 精确写入规划的已有 Space
  - committed receipt -> 绑定目标 digest
  - skipped -> 必须取得完全一致的 Recall evidence
          |
          v
Host 按重要性与字节预算保留原始运行时记忆条目
          |
          v
CAS compactAndMutate(revision, compaction, original mutation, lineage)
  -> JSON 与两个 Markdown projection 作为一次本地提交落盘
```

planner 没有数据面工具，不能创建 Memory Space。每次写入都由 Host 发起；只有每条已提交来源都有可验证的 durable destination 后，Runtime 才会变化。若远端写入后发生很晚的跨进程 revision 冲突，原有的运行时记忆条目仍会保留；远端 Provider 无法共享本地文件锁，因此已提交的 durable copy 会作为安全重复保留，而不会被破坏性回滚。

<a id="workflows-运行时归档恢复"></a>

#### 运行时归档恢复

容量归档写入已激活的记忆空间，其 Provider 必须支持精确写入和安全删除；不支持的目标会在任何归档写入前被排除。完全没有能接收归档的记忆空间时（该层已关闭或不接受自动写入、没有就绪的 Provider、没有激活的空间，或只剩不支持的 Provider），Runtime Source 会在同一把锁内、紧接着提交压缩与待写入内容之前，把压缩舍弃的条目追加到本地归档 `runtime/archived/`：`MEMORY.md` 供阅读，`memories.jsonl` 保存每个条目及其元数据。另一个记忆空间 Source 中有能接收归档的空间，或 Runtime Source 版本过旧、无法保留压缩舍弃的条目时，仍会拒绝。Mnemon Pack 不包含本地归档，导入 Pack 时会保留它。直接向 Provider 写入仍保持原有的异步行为。

对话归档使用所选 Source 的写入范围：回合中激活的已知空间，以及当前 View 创建的空间，都可作为归档目标。在 View 固定之后由其他操作创建的空间，需要新回合才能使用；所以当合适的空间都在 View 写入范围之外，或当前 View 不提供对它们的写入时，写入会被拒绝，而不是归档到本地。空范围始终不授权任何空间。目标错误会区分目录为空、View 范围为空或排除了当前空间、Provider 能力不支持，并报告目录、授权和可写数量。失败时待新增内容尚未保存；修正所报告的原因后，请在新回合重试同一份工具输入。已有的运行时记忆条目会保留。

归档回执或本地提交失败时，Host 仅尝试删除回执能证明由本次操作新建的条目，保留跳过或复用的既有条目。本地提交报错后，如果 Runtime 修订已变更或无法读取，则提交结果不确定：保留归档条目，避免丢失已提交的记忆。清理失败会标出剩余目标空间和条目 id。Provider 请求失败且没有返回回执时，远端结果可能不确定，因此这不是分布式事务；重试前应检查对应 Provider。

<a id="workflows-documents-创建更新和归档"></a>

### Documents 创建、更新和归档

```text
创建/更新请求
          |
          v
按渲染后的 UTF-8 字节执行 capacityPlan
          |
     +----+----+
     |         |
   未超限     溢出
     |         |
     v         v
   提交    选择最久未访问的活跃档案
               |
               v
          保存档案与修订的快照
               |
               +-- 任何地方都没有能接收索引的记忆空间
               |     -> 不建索引，直接将文件移入归档，不派发任务 Agent
               |
               v
          派发归档任务 Agent
               |
               v
       写入并验证紧凑的 Mnemon 冷引用
       包含标题、摘要、计划路径、SHA-256
               |
          +----+----+
          |         |
         失败     回执有效
          |         |
          v         v
      保持活跃    检查修订
                    |
               +----+----+
               |         |
                冲突     一致
               |         |
               v         v
             保持活跃   将文件移入归档
                             |
                             v
                       重试原始修改
```

人工归档使用同一条“先索引、后迁移”路径；没有记忆空间能接收索引时，同样归档到本地。Mnemon 索引已经成功但 revision 冲突时不会回滚索引，因此可能出现安全的重复引用，而不会丢失 active 原文。

<a id="workflows-工作区档案归档恢复"></a>

#### 工作区档案归档恢复

工作区档案归档不再要求子代理为 remember/recall 回执编号。旧版本失败后若留下冷索引而档案仍为 active，重试可复用精确路径与当前内容哈希一致的索引；档案更新后需要匹配新修订的索引。异步提取或不支持安全删除的 Provider 会在写入前被拒绝。完全没有能接收索引的记忆空间时，档案会在不建索引的情况下归档到本地：原文移入归档目录，仍可在工作区档案页面阅读。清理失败会报告目标空间和本次新建的 id；确认结果前应保留已有数据。

<a id="workflows-确定性活动评分和空闲审查"></a>

### 确定性活动评分和空闲审查

完成的 turn 累计四种信号：

```text
score =
  min(floor(totalUserCharacters / 50), 3)
  + completedTurnCount
  + min(floor(completedToolResults / 5), 2)
  + toolDiversityScore

toolDiversityScore:
  不同工具数 < 3  -> 0
  不同工具数 = 3  -> 1
  不同工具数 >= 4 -> 2

score >= 5 时达到门槛
```

达到门槛并不代表一定写入：

```text
已完成的回合
      |
      v
score >= 5 ? -- 否 --> 为后续回合保留累计活动
      |
      是
      |
      v
Host 判断是否存在待整理内容
  - 当前轮明确要求不写记忆 -> 停止
  - 持久化意图、累计 >=320 用户字符、
    >=600 助手字符或已完成非 Mnemon 工作 -> 继续
      |
      v
等待 idleReviewMs（默认 30 秒），且距上次尝试
至少 idleReview.minIntervalMs（默认 5 分钟）
      |
      +-- 新回合 --> 取消定时器/任务，保留累计活动
      |
      v
确认 Agent 已空闲、已有 turn/end、该回合由分层策略组合，
且未达到 idleReview.maxPerSession
      |
      v
就已完成的回合启动任务 Agent
  - spawn（默认）：有界检查点，上限 idleReview.maxContextChars
  - fork：继承父 Agent 上下文
      |
      v
保守的整理决策，每轮只写一层
  - 先看档案：先检索；项目记录至多新建一份独立档案，
    不更新或归档已有档案
  - 运行时记忆：只收录用户新提出的、明确且持久的陈述；
    MEMORY.md 只收档案未涵盖的简短规则，不收项目记录
    （idleReview.runtimeMemory: false 时关闭）
  - 建了档案就不能再改工作记忆，反之亦然
  - 不提供记忆空间写入工具
      |
      +-- 已完成（含跳过）--> 清空累计活动
      |
      +-- 失败/中止 --------> 保留累计活动
```

admission 有意只使用结构信号，不调用 LLM 分类；因此达到 activity 门槛但没有 dirty candidate 的普通 checkpoint 不会启动后台模型。审查 Agent 的工具恰好是 `mnemo_document_search`、`mnemo_runtime_memory` 与 `mnemo_document_manage`；`idleReview.runtimeMemory` 为 `false` 时不提供运行时记忆工具。审查 guard 让每轮只写一层：它放行的第一次新建或更新档案、或修改工作记忆决定本轮所写的层，另一层随后被拒绝，即使第一次调用失败也是如此；USER.md 的修改不受影响。“至多一份”档案或一次运行时记忆修改仍由 persona 约束，不是 Host mutation counter。审查的产出之后才进入记忆空间：工作记忆在容量整理时归档，工作区档案在冷归档时建立索引。安装了 Agent Teams 工具时，除非设置 `idleReview.agentTeams: scoped`，审查会暂停；暂停期间状态页会给出提示。后台审查配额尚未持久化，Host 重启会丢失未处理的累计信号。

<a id="workflows-配置开关的关系"></a>

### 配置开关的关系

- `recallMode=off`：不再注入 recall cue，显式 `mnemo_recall` 仍可用。
- `writebackMode=off`：关闭写回 cue 和评分空闲审查，显式写入仍由 `writeEnabled` 决定。
- `lifecycleEnabled=false`：关闭生命周期提醒和审查，不移除显式工具或 Web 入口。
- `routingGuidance=false`：只移除额外路由 section；Runtime Memory context 仍注册。
- `writeEnabled=false`：移除语义写工具和写 RPC，拒绝写命令；它不是文件系统只读挂载保证。
