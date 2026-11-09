# 文档细化决策登记

状态更新规则：Pending 是待确认，Accepted 必须有用户明确选择。推荐不等于已接受；不得把历史编号未展开的方案重新命名成其他选择。

## 已确认的基础

- 项目名 MnemoWeave，根目录 D:\projects\MnemoWeave。
- TypeScript strict、Workspace Monorepo、模块化单体、原生部署，不以 Docker 为前提。
- Mnemon 官方接口优先；通过真实 CLI 核查行为，不以 Go 测试作为项目验收前提。
- ADR-001–026 的交接选择保留；ADR-015 已补齐自动审核和历史保留的具体规则。
- Q2 方案 A 已接受：Mnemon 正式各版本全文权威；MnemoWeave 管版本映射、哈希、当前指针及治理账本；读取异常不以候选正文兜底。
- 当前工作改为选项式确认、文档补全及实现交接，不继续扩写业务代码。

## 首批已确认

| 编号 | 问题 | 状态 | 推荐 |
|---|---|---|---|
| DOC-01 | 文档交付覆盖全项目首版，还是先限定一个实施阶段 | Accepted | 用户选择覆盖全项目首版：Server、Bridge、本地副本、同步、DSH/Codex/ZCode；后续扩展单列 |
| DOC-02 | ADR-016/017/018 等只有方案编号的历史细节如何补齐 | Accepted | 用户选择由助手提供细化选项、逐批确认；作为新的补充决策，不冒充历史原文 |

确认来源：2026-11-08 用户对首批选项的明确答复。沿用上述选择，不重复征求。

## 第二批：模型职责、路由和失败处理（新材料已补齐基线）

用户随后提供完整 P0–R20 决策统一整理版，已归档于 ../sources/p0-r20-user-summary-2026-11-08.md。此前尚未作答的概括性选项被该材料取代，不视为用户选了某个预设答案，也不再重复询问已有原则。

| 编号 | 待确定事项 | 状态 |
|---|---|---|
| MODEL-01 | 工作模型优先，后台模型按需补充；工作模型主导知识沉淀，后台仅辅助 | Baseline confirmed |
| MODEL-02 | Task-oriented Gateway；按任务、能力、显式配置及可用性统一路由 | Baseline confirmed；路由表和预算待细化 |
| MODEL-03 | 统一区分临时错误、不可用、超时、参数/权限、能力不足；按任务重试/切换/延迟/人工 | Baseline confirmed；顺序、次数和时限待细化 |

不变约束：MnemoWeave 自己发起的模型调用统一经过 Gateway；组件权限必须声明；Provider 不自行调用模型；置信度不等于技术验证；缺失或不确定的审核不能默认通过。

ADR-018 也已明确：持久化队列、Server 进程内 Worker、显式状态与检查点、暂停/取消/恢复及人工介入。原始 A/B/C 菜单无需伪造或作为实施前提；具体调度与参数仍可通过补充决策细化。

## 第三批：本地副本与离线边界

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| SYNC-01 | 本地副本的历史正文范围 | Accepted：同步当前及历史全文，限授权允许的范围；不包含全部会话原文 |
| SYNC-02 | 离线持久化队列的意图范围 | Accepted：候选、事件、版本和关系变更意图均可排队；Server 重验后再处理 |
| AUTH-01 | 离线读取许可默认有效时长 | Accepted：1 小时，由 Server 配置；收到撤权立即停止，到期未续期也停止 |

本批不重开 Local-first、SQLite Replica、持久化队列、快照+增量+校验等既定选择；只确认尚未确定的覆盖范围与时限。全部离线写意图仍需联网后由 Server 重验授权、基线和审核，不能本地晋升正式记忆。

确认来源：2026-11-08 用户对第三批三组选项均明确选择推荐方案。AUTH-01 是读取许可时长，不是同步间隔或身份凭据有效期。

## 第四批：变更来源、同步频率与重建期间服务

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| SYNC-03 | 正式变更入口 | Accepted：专用 Store，正式变更统一经 MnemoWeave；其它 Host 经 Bridge/MCP，外部数据经导入与审核 |
| SYNC-04 | 同步与全量校验默认频率 | Accepted：增量每 30 秒；全量校验每 3 天（72 小时），采用用户自定义值 |
| SYNC-05 | 重建期间服务 | Accepted：暂存区重建后一次切换；结构完整且许可有效的旧副本可带数据时间和过期标记读取，联网可远端补充 |

确认来源：2026-11-08 用户第四批答复。SYNC-04 不是推荐组合中的 24 小时或低负载组合中的 7 天；必须准确采用 3 天。重连及关键业务事件仍额外触发同步，损坏/许可过期的副本不可读取，离线队列保留。

## 第五批：本地安全与身份接入（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| AUTH-02 | 明确撤权后的本地副本 | Accepted：立即禁止访问，保留本地副本；不自动清理正文/索引以便重授权后恢复 |
| AUTH-03 | 读取许可到期后的新意图 | Accepted：Host 本地身份有效且未明确撤权时，继续仅接收待提交意图；不读取过期副本，重连由 Server 重验 |
| AUTH-04 | Host 注册 | Accepted：首次配对由用户确认并分配权限，签发每 Host 独立凭据；后续会话自动连接 |

确认来源：2026-11-08 用户第五批答复。AUTH-02 明确选择保留副本，不采用此前推荐的自动清理。明确撤权与单纯许可过期必须分开；未上传意图在撤权后隔离保留，不自动提交。

## 第六批：项目身份、默认授权和本地存储（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| PROJECT-01 | 项目身份 | Accepted：显式稳定项目 ID，目录和 Git 地址作别名；新克隆经确认关联后共享项目记忆 |
| AUTH-05 | Host 项目范围 | Accepted：配对时明确授予当前及未来全部项目；Global 权限另外选择 |
| STORAGE-01 | Bridge 本地存储保护 | Accepted：SQLite 不额外加密；使用用户级文件权限，磁盘加密由用户自行配置 |

确认来源：2026-11-08 用户第六批答复。AUTH-05 不采用推荐的逐项目默认拒绝，STORAGE-01 不采用额外应用层加密；实现不得替用户改回推荐值。全部项目授权不等于全部操作、全部其它 Host/Session 或 Global 权限。

## 第七批：Recall 与上下文选择（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| RECALL-01 | 默认检索范围 | Accepted：全部已授权项目 + 已授权 Global；保留原项目、版本及适用条件，不自动晋升 Global |
| VIEW-01 | Pinned 与预算竞争 | Accepted：关键约束完整保留，普通 Pinned 可用可追溯摘要，余量供动态内容；关键内容仍超限时明确提示 |
| VIEW-02 | 未知上下文预算的兜底上限 | Accepted：总注入 4,096 Token，含 Pinned、动态内容及投影元数据；Host 更小预算优先 |

确认来源：2026-11-08 用户第七批答复。RECALL-01 不采用推荐的“当前项目 + Global”，不得在实现时暗中缩小。全部项目权限不隐含 Global 许可，跨项目 Recall 也不等于知识 Global 晋升。

## 第八批：数据生命周期与重新验证（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| RETENTION-01 | 普通选存 Session 事件 | Accepted：热存 7 天，此后归档保留 90 天；重要或被引用的证据受保护 |
| RETENTION-02 | 已进入可清理状态的非必要候选正文 | Accepted：保留 30 天；保留审核记录/元数据/受保护证据，不按该周期清理待审和失败待处理候选 |
| KNOWLEDGE-01 | 时间型复核 | Accepted：版本/平台敏感 30 天、常规实践 90 天、长期原理 180 天；相关事件立即触发。到期仅 ReviewDue，不自动失效或删除（已实现 2026-11-09：知识类型映射见 `catalog.ts`，`/v1/reviews/due` 与 `/v1/reviews/complete`） |

确认来源：2026-11-08 用户第八批三项均选择推荐方案。归档 90 天从进入归档阶段计，不将 7+90 偷换成自事件发生起总共 90 天。复核周期与正文清理周期不得混用。

## 第九批：模型与后台任务默认预算（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| MODEL-04 | 模型时间上限 | Accepted：单次 60 秒，整个模型处理步骤最多 5 分钟；总计含退避、重试及备用调用 |
| MODEL-05 | 模型暂时性错误重试 | Accepted：主模型最多 3 次（含首次），事先配置的备用模型最多 1 次；服从总时限 |
| TASK-01 | 后台模型任务并发 | Accepted：最多 2 个；不限制无模型本地 Recall，同一逻辑记忆写入另行串行保护 |

确认来源：2026-11-08 用户第九批均选择推荐方案。语义不确定不能靠反复调用争取通过；权限/参数/能力错误不作为普通临时错误重试。上述模型调用上限不授权盲目重复 Provider 写入。

## 第十批：任务调度与恢复（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| TASK-02 | 调度 | Accepted：交互优先并防后台饿死；撤权等即时控制不受普通队列延迟，业务依赖和串行保护仍有效 |
| TASK-03 | 执行租约 | Accepted：90 秒，每 30 秒续期；不等于模型步骤预算或离线读取许可 |
| TASK-04 | 非模型可恢复故障 | Accepted：持久化退避重试，间隔封顶 15 分钟；持续超过 24 小时告警，不自动放弃 |

确认来源：2026-11-08 用户第十批均选择推荐方案。网络恢复可重新调度，但不能借此绕过授权/业务基线；外部写入结果未知仍先核对，不能按网络重试规则盲目重放。

## 第十一批：日志与容量（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| SYNC-06 | 增量及标记保留窗口 | Accepted：增量 30 天，删除/移除标记 90 天；过期 Cursor 重建快照，不因此删除正式历史 |
| STORAGE-02 | 容量预算 | Accepted（2026-11-09 确认默认值）：Server 软 10 GiB / 硬 20 GiB，Bridge 不设配额；按治理库与 WAL 计量，软配额告警与清理、硬配额拒绝新候选增长 |
| OPS-01 | 诊断日志 | Accepted：默认 30 天，不记录正文/完整提示词/密钥；审核、正式 Receipt 和必要证据不按此期限清理 |

确认来源：2026-11-08 用户第十一批均选择推荐方案。未接受固定 Server 20 GiB/Bridge 10 GiB 默认配额，不得把这些候选值写成最终配置。

## 第十二批：接入目标与模型调用策略（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| HOST-01 | ZCode 的具体产品/主要入口 | Accepted：智谱/Z.ai ZCode 桌面版，主要使用内置 ZCode Agent；已安装版本尚未核验 |
| MODEL-06 | 项目级模型用量硬预算 | Accepted：只记录用量，不额外设置项目每日/任务 Token 硬配额；保留超时、重试及并发限制 |
| RECALL-02 | 可选模型重排 | Accepted：用户明确请求或确定性规则判定候选歧义较大时启用；普通查询确定性排序，未配置/失败明确标为未重排 |

确认来源：2026-11-08 用户第十二批回答。用量缺失不能记为零，模型上下文上限及供应商限流仍须遵守，但不能擅自引入项目级硬配额。

## 第十三批：三个 Host 的首版验收（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| HOST-02 | 缺少自动接入能力时，MCP 手动入口能否替代首版验收 | Accepted：不能替代；DSH、Codex、ZCode 三者均须实现自动注入和选定事件采集，接口不足时对应 Host 阻塞首版验收 |

确认来源：2026-11-08 用户选择“自动接入为必交付”。支持 MCP、提供 Skill 或文档宣称支持 Hook 均不能单独证明满足自动接入要求。可以分别开发和验收已就绪的组件，但任一目标 Host 不满足必需能力时，不得宣布全项目首版验收完成。

选定事件及运行时故障行为已由第十四批补齐；交付验收与单次运行故障仍须分别判断。

## 第十四批：事件闭环与注入故障（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| HOST-03 | 三个 Host 的必需采集入口 | Accepted：会话开始/结束、用户消息、助手最终答复、工具完成结果（含成功与失败）；不采集隐藏推理及逐 Token 输出 |
| HOST-04 | Bridge 不可用且没有合法可读副本时，普通任务如何继续 | Accepted：明确显示记忆不可用后允许普通任务继续；不得假称已加载，恢复后重试，不使用越权、过期或损坏内容 |

确认来源：2026-11-08 用户第十四批均选择推荐方案。事件入口覆盖不等于所有事件正文永久保存，更不等于自动批准正式记忆。关键 Pinned 超出预算仍明确报错，HOST-04 不授权静默丢弃关键约束。

## 第十五批：自动注入时机与等待（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| HOST-05 | 默认自动注入刷新时机 | Accepted：会话开始时注入完整 View；用户消息、工具失败或重要工具结果、显式 Recall、上下文接近预算、撤权或许可变化触发增量。默认不每轮重新注入 |
| HOST-06 | 普通自动注入前台等待上限 | Accepted：默认 2 秒，优先本地检索；Host 自身限制更短时服从更短值，较慢结果留待后续受支持入口交付 |

确认来源：2026-11-08 用户对第十五批的回答（HOST-06 已确认；HOST-05 于本轮文档重写前补充确认）。该上限不替代主动 Recall 和后台模型任务预算；超时后明确提示并允许普通任务继续，不假称注入成功。

## 第十六批：文档基线与历史（已确认）

| 编号 | 具体未决问题 | 状态 |
|---|---|---|
| DOC-03 | dsh-mnemon 在文档中的定位 | Accepted：证据与形态来源；自有契约独立定义，不依赖 DSH 运行时，不照搬客户端与插件结构 |
| DOC-04 | 仓库历史与执行记录 | Accepted：不恢复 docs/execution 历史；清理索引中不存在的路径；文档不再引用不可核验的提交号 |
| DOC-05 | 本轮文档交付 | Accepted：全量重写 docs/implementation 十五类文档，并校正根 README、架构状态陈述与参考项目评估 |

确认来源：2026-11-08 用户对文档重写选项的答复。DOC-04 不表示放弃历史可追溯性；后续在存在真实提交后，由 current-handoff 记录可核验基线。

## 第十七批：WP2 执行中的实现层决定（依据 implementation-work-packages WP2 输出要求）

| 编号 | 问题 | 状态 |
|---|---|---|
| OUTBOX-01 | Outbox 独立派发还是随 Task 推进 | 已决定：随 Task 推进。Outbox 是 approve/retry 事务内的入队账本（Task 一对一），无独立状态；镜像状态（pending/dispatching/failed/delivered/cancelled）暗示不存在的独立派发器，已在 schema v6 删除。旧库迁移到 v6 时一并去除该列 |
| RETRY-01 | 非模型可恢复故障的重试退避 | 已按 TASK-04 实现：指数退避 2s×2^(attempts−1)，单次间隔封顶 15 分钟，无次数上限（不自动放弃）；first_failed_at 持久化，持续失败超 24 小时输出一次 task_retry_alert，人工 retry 重置观测 |
| MODEL-USE-01 | 模型用量记录的存储位置 | 已决定：配置状态目录时写 `<STATE_DIR>/model-usage.jsonl`（追加、不轮转、不混入 30 天诊断日志）；无状态目录时输出 stderr `model_usage` 行。保留期与归档策略留待运维批次确认 |
| EVT-SEL-01 | Session 事件选择性保存的默认规则 | 已决定（实现层默认，可配置）：会话边界只存元数据（不存正文）；工具失败与推断中断存正文；携带候选来源引用的消息存正文；其余事件跳过不保存。重要标记与证据引用受保护，不按普通期限清理 |
| RET-CLEAR-01 | 候选正文清理后的幂等语义 | 已决定：正文清理只删 `governance_candidate_bodies` 行并保留元数据与全量请求哈希；同键同输入（哈希命中）仍返回既有候选，同键不同输入返回 IDEMPOTENCY_CONFLICT，不静默接受无法核验的重放 |

确认来源：`implementation-work-packages.md` WP2 输出条目明确要求"明确记录……的最终决定"与"重试退避与已确认政策对齐"。此批是实现层决定，不改变 ADR-018/025/026。

## 第十八批：Bridge 同步协议设计选项（Accepted，2026-11-08 用户确认推荐方案）

依据 `bridge-and-sync.md` 第 4 节与第 7 节门槛。2026-11-08 用户审阅后确认以下推荐方案（各编号采纳「推荐」列），WP6 据此解除阻塞；副本 Schema 已冻结为 Accepted。

| 编号 | 问题 | 推荐 | 备选 |
|---|---|---|---|
| SYNC-P1 | 快照格式 | 单文件 SQLite 导出（`VACUUM INTO` 语义）+ 逐表 SHA-256 清单 + 分片 64 MiB；快照带 Server 单调 generation | 分表 JSONL 流；在线分片拉取 |
| SYNC-P2 | 增量流 | Server 维护 `sync_log(monotonic seq, op, payload_hash, op_at)`：op ∈ upsert_memory/upsert_revision/pointer/tombstone；Bridge 按 seq 幂等应用，应用与 Cursor 更新同事务 | 按时间戳拉取（无法保证全序，不推荐） |
| SYNC-P3 | Cursor | Bridge 保存已应用 seq；Server 只保留 30 天增量日志，Cursor 落后于窗口最旧 seq 即失效并触发快照重建；重复投递幂等跳过 | 游标带签名续期 |
| SYNC-P4 | Tombstone | remove_tombstone（正式记忆被治理移除）、revoke_tombstone（授权撤回）分离；保留 90 天；旧副本收到 seq ≤ 已应用 seq 的复活数据直接丢弃 | 单一删除标记 |
| SYNC-P5 | 批与背压 | 单批 ≤200 条或 ≤8 MiB；超时 30 秒；指数退避同 TASK-04（封顶 15 分钟）；本地剩余磁盘低于阈值暂停接收并告警，不丢弃队列 | 固定批大小 |
| SYNC-P6 | 全量校验 | 每 72 小时按 memory 分区请求 Server 摘要（memoryId + 当前 revision + 内容哈希列表），差异生成增量请求；差异超过阈值（如 5%）转快照重建 | 全量拉回比对 |
| SYNC-P7 | 暂存切换 | 重建写入 `<state>/replica.staging.db`，校验通过（快照清单哈希全对 + 抽样正文核对）后原子 rename 切换；旧副本保留为 `replica.previous.db` 并带数据时间与过期标记，许可有效时可读 | 就地重建（不可回退，不推荐） |
| SYNC-P8 | 离线队列 | 意图 = Bridge 本地表 `intent_queue(intent_id, host_id, kind, payload, baseline_ref, created_at, state)`；重连后由 Server 重新验证授权/基线/审核；撤权后意图隔离保留不自动提交；投递确认（Receipt 引用）前不删除 | 意图直接进候选提交接口（丢失重验时机） |

配套门槛确认：副本 Schema 已随本批确认在 `bridge-and-sync.md` 冻结为 Accepted，按此建表实现；WP6 完成条件保持第 8 节验收。传输层：Server↔Bridge 协议已以库接口实现并通过第 8 节验收，HTTP 传输端点与 Bridge 进程入口已交付（WP7）。

## 第十九批：三 Host 首版验收缺口登记（Accepted，2026-11-08 用户决策）

HOST-01 本机核验完成后，三个 Host 的 HOST-02 验收存在无法在会话内解除的缺口。用户续作指令明确选择将结构性缺口登记为永久阻塞项（另一路径——安装 DeepSeek Harness Desktop——超出会话自主能力，且需真实 GUI 安装与用户凭据）。

| 编号 | 问题 | 状态 |
|---|---|---|
| HOST-02-ZC | ZCode 无助手最终答复采集入口 | Accepted（永久阻塞项，**已被第十九批勘误**）：ZCode Desktop 3.17.2.9661 的七个钩子事件均不携带助手最终答复正文的判断有误；上游文档确认 Stop 携带 `last_assistant_message`，已映射为 message.assistant.final。实际剩余缺口为专用 `session.ended` 与真实会话运行，ZCode 首版验收保持阻塞 |
| HOST-02-CX | Codex 无消息级事件与注入入口 | Accepted（永久阻塞项，**已被第十九批解除**）：Codex 0.148.0 的 hooks 框架实际交付所需负载（SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd），并通过 additionalContext 端到端注入验收。Codex 首版验收通过 |
| HOST-02-DSH | DeepSeek Harness Desktop 未安装 | Accepted（永久阻塞项，环境）：本机仅存 shim；适配器实现的前置条件（真实 SDK）不满足。DSH 首版验收保持阻塞。解除条件：用户安装 Harness Desktop 后按 `packages/adapters/dsh` 指引实现并验收 |

按 HOST-02 规则（任一必需 Host 阻塞则全项目首版不得标记完成）：**首版三 Host 验收门槛在本批登记后保持"未达成（永久阻塞）"状态**，这是用户知情的范围决策，不是实现缺口。除三 Host 真实会话验收、View 与注入控制器的适配器接线、保留清扫调度外，其余可交付能力均已实现并验证（见 current-handoff §3/§5）。

## 第十九批勘误与解除（2026-11-08，上游确认 + 真实会话验收）

第十九批登记后，按续作指令向上游官方文档确认并在真实宿主会话中执行验收，结果如下：

| 编号 | 勘误/解除 | 证据 |
|---|---|---|
| HOST-02-CX | **解除——Codex 验收通过**。原"无消息级事件/注入入口"判断有误：hooks 框架（hooks.json，Claude-Code 风格事件名）真实存在并交付全部所需负载 | 隔离 CODEX_HOME + `codex exec` 真实会话：SessionStart/UserPromptSubmit(prompt+turn_id)/PostToolUse(tool_name/input/response)/Stop(last_assistant_message)/SessionEnd(reason) 全部捕获；additionalContext 注入端到端验证（模型回复恰为注入标记）。记录：`host-acceptance/codex.md`；原始负载：`work/codex-acceptance/logs/hook-events.jsonl` |
| HOST-02-ZC | **勘误**——原"assistant.final 缺口"判断有误：上游文档（zcode.z.ai/cn/docs/hooks）确认 Stop 钩子 stdin 携带 `last_assistant_message`，已映射为 message.assistant.final。**剩余阻塞（范围缩小）**：ZCode 无专用 session.ended 事件 + 真实会话运行待用户启动（桌面会话无法在本会话内驱动） | 上游文档核对；适配器映射已更新并有测试 |
| HOST-02-DSH | 不变（Harness Desktop 未安装，等待用户安装） | — |

首版门槛状态更新：Codex **通过**；ZCode **阻塞范围缩小**（session.ended + 真实会话运行）；DSH **阻塞**（等待安装）。按 HOST-02 规则全项目首版仍不标记完成——剩余为 ZCode session.ended 上游入口、DSH 安装、以及 ZCode 与 DSH 的真实会话运行。

## 第二十批：DSH 桌面安装后的复核（2026-11-09）

2026-11-09 复核发现 DeepSeek Harness Desktop 已安装于 `%LOCALAPPDATA%\Programs\DeepSeek Harness`（Electron 应用，`resources/runtime/versions.json` 记录 node 24.21.0、pnpm 11.28.5），但 `dsh.cmd --version` 仍输出 "Harness CLI not found"，首次运行尚未初始化 CLI/运行时。

| 编号 | 结论 | 证据 |
|---|---|---|
| HOST-02-DSH | 阻塞不变（原因细化：CLI/运行时未就绪，而非桌面未安装） | 目录与 `versions.json` 核验；`dsh.cmd --version` 输出；记录见 `host-acceptance/dsh.md` |

解除条件：启动桌面应用完成初始化，使 `dsh.cmd --version` 可用；随后取得真实 DSH 版本与 SDK，按 `packages/adapters/dsh` 指引实现并重跑 HOST-02 场景。首版门槛状态不变。

## 第二十一批：目标 Host 与插件形态（2026-11-09 用户确认）

| 项 | 决定 | 依据 |
|---|---|---|
| Codex CLI | 从项目目标与验收中移除，并卸载本机 `@openai/codex` 与 `~/.codex` 配置 | 用户明确指令；实际使用 ChatGPT 桌面客户端 |
| 目标 Host | DSH、ChatGPT 桌面（Codex in ChatGPT desktop）、ZCode | 与用户实际使用面一致 |
| 交付形态 | 宿主原生插件：ZCode `.zcode-plugin/plugin.json`、ChatGPT `.codex-plugin/plugin.json`、DSH Cordis 插件 | 官方插件文档：ZCode Plugin、Codex Plugins |
| 注入边界 | ZCode/ChatGPT 插件仍通过 hooks 子进程；DSH 为进程内事件 | ZCode Hooks、Codex 插件 hooks 文档 |
| Bridge | 保持常驻有状态核心（会话 View、注入控制器、副本、离线队列） | 现架构不变 |

## 后续确认批次

以下为问题目录，不是已定案方案；具体选项要结合依赖和上游证据形成。

1. 需求边界与完成标准：首版用户流程、端到端交付范围、延期项。
2. 领域与版本：逻辑身份、作用域、历史读、默认有效 Recall、并发、跨作用域物理内容别名与暂存隔离。
3. 审核与可靠任务：质量门槛、人工权限、重试分级、超时、租约、暂停/取消、幂等和 Receipt。
4. Model Gateway/Routing：工作模型与后台模型、声明权限、显式路由、失败与降级、模型凭据。
5. Bridge 与同步：完整副本数据范围、快照一致性、Cursor、顺序、Tombstone、重建和离线模式。
6. 认证与授权：Host/Bridge 注册、作用域、离线 Lease、撤销时间、密钥和存储保护。
7. Recall/View/Projection：作用域匹配、检索阶段、预算、Pinned、不可变 View、动态增量及行为反馈。
8. 知识生命周期：Session 保留、候选清理、复核触发、容量与 Blob 清理。
9. Host 与协议：三个 Host 的能力证据、HTTP/MCP 契约、Hook/Skill、组件版本协商。
10. 运维与交接：配置默认值、原生部署、迁移恢复、诊断、安全日志、测试矩阵和实施工作包。

## 保留的工程审查事项

实现已进入提交历史，细节仍不自动视为设计决定。尤其需要核验暂存版本、Provider 去重产生的物理 ID 别名、原生 Supersedes 投影及新发布之间的交叉占用规则；单路径测试不能替代并发不变量的证明。

## 2026-11-09 评审修复的实现细化

依据：用户要求修复全部评审问题；沿用 ADR-008/013/014/016/024，不标记为新的 ADR 选择。

- Runtime 使用正式记忆引用作为 Pinned；临时工作素材有界且不成为正式全文权威。
- projectId 显式登记，旧数据 fail-closed；同步传输扩展仍为可演进的实现方言，不冻结 Q3/Q4 Schema。
- 默认 MCP 改成连接唯一 Server；standalone 仅显式隔离验收且不运行 Worker。
- 本地开发身份增加逐 Host 派生凭据；单 Host 凭据轮换、配对 UX、防改时钟仍未宣称完成。
- 工程默认的上下文容量、提炼批量与截断参数见 runtime-memory.md；不冒称用户已单独确认这些数值。
- 当前 Host 目标以用户 AGENTS.md 为准：DSH、ChatGPT 桌面、ZCode。历史 Codex CLI 材料不恢复为验收要求。
