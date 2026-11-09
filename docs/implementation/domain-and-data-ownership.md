# 领域与数据所有权

状态：Q2 方案 A Accepted（Mnemon 保存正式全文，MnemoWeave 保存逻辑身份、版本映射、哈希、当前指针与治理账本）。本文固定领域身份、所有权和不变量；表结构与事务细节见 `state-machines-and-transactions.md`。

## 1. 权威矩阵

| 数据 | 权威 | 允许的派生/缓存 | 禁止 |
|---|---|---|---|
| 正式记忆正文（每个已发布版本） | Mnemon | MnemoWeave 只保存内容哈希与 Provider 引用 | 用候选正文或本地副本冒充正式正文 |
| 原生关系（temporal/semantic/causal/entity/supersedes） | Mnemon | 逻辑关系记录与投影标记 | 把原生邻接遍历当成方向性事实 |
| 逻辑记忆身份、适用范围、当前指针 | MnemoWeave | Bridge 副本按授权复制 | Provider 侧修改指针或自动重基线 |
| Revision 元数据（编号、父版本、哈希、发布时间） | MnemoWeave | 只读展示与审计导出 | 修改已发布 Revision |
| Candidate、审核记录、Review Task | MnemoWeave | 只读查询与审计 | 让候选文本成为第二正式内容权威 |
| Task、Run、Execution Receipt、Outbox | MnemoWeave | 只读查询 | 用单一成功字段代替三种身份 |
| 冲突案件与裁定依据 | MnemoWeave | 只读查询 | 未裁定即发布新结论 |
| Session 事件与候选素材 | MnemoWeave | 归档、受保护证据 | 无限保存全部会话原文 |
| Bridge 本地副本、离线队列 | 远端权威的派生副本 / 本地待提交意图 | 本地检索、离线读取 | 在本地批准或晋升正式记忆 |
| 大型内容 Blob | MnemoWeave 内容寻址存储 | 引用计数与 GC | 按目录年龄删除 |

Mnemon 内部数据库不是产品接口。能力缺失或版本不兼容必须明确拒绝，不得读取内部表兜底。

## 2. 身份模型

- **Logical Memory**：一个明确适用范围内的稳定业务身份，不从文本相似度自动推断。字段对应 `catalog_memories`：`id`、`current_revision_id`、`state`（active/superseded/unverified）、`scope`（project/global）、`applicability`。
- **Revision**：同一逻辑身份下的不可变版本。由 MnemoWeave 预分配 ID，写入成功后绑定 Provider Memory ID 与内容哈希；同一 `(memory_id, revision_number)` 唯一，更新与删除受触发器拒绝。
- **Supersedes**：两个不同 Logical Memory 之间的方向性替代，替代者指向被替代者。发布后目标记忆标记 `superseded`，替代者保持 `active`；原生投影是尽力而为，不是权威。
- **RelatedTo**：无法构成 Supersedes 但存在明确关联的关系类型。不得用相似度自动生成方向。
- **Coexist**：双方成立但适用范围不同。完整实现要求新候选的 `scope` 或 `applicability` 与目标不同，并保留双方当前指针。
- **Change Intent**：`revise` / `supersede` / `coexist` / `conflict`。带 `change` 的候选不进入自动批准路径。

适用范围由 `provenance.applicability` 自由文本与 `scope` 共同表达。不得把自由文本解析成未经确认的结构化事实；跨范围合并与 Global 晋升继续人工审核。

## 3. 所有权不变量

1. 候选请求不可变：`governance_candidates.request_json` 只追加，不就地修改。修改内容必须新建候选（amend 也生成新候选）。
2. Revision 不可变：`catalog_revisions` 的更新与删除被触发器拒绝；修正必须发布新 Revision。
3. 每个逻辑记忆最多一个当前指针，且指针只能指向已核对并发布的 Revision。
4. 同一逻辑记忆同时最多一个未完成版本操作占用（`catalog_reservations` 主键为 `memory_id`）。
5. 操作计划不可变：`catalog_operations.plan_json` 由触发器拒绝更新；只允许推进 `checkpoint_json` 与 `state`。
6. 未发布内容不可见于默认有效读取：可见集合只包含 `active` 记忆的当前 Revision（`visibleProviderIds`）。
7. Provider 内容必须按哈希核对：读取时 `show` 返回的 ID 与全文哈希必须匹配 Revision 记录。
8. 候选正文不得作为读取失败的回退内容。

## 4. 读取与完整性

- 默认有效读取：先按发布目录过滤 Provider 结果，再做业务排序；未发布 Revision、`superseded` 与 `unverified` 不进入默认结果。
- 显式历史读取：返回逻辑记忆、Revision 链、适用范围、发布时间、审核依据与 Provider 核对结果；不反向修改当前指针。
- 完整性异常（Provider 缺失、内容哈希不符、ID 不符）返回 `PROVIDER_INTEGRITY`，保留双方证据并要求人工处置。
- 原生 `superseded` 标记只是 Provider 信号，不能替代逻辑指针、作用域或冲突状态判断。

当前 Recall 扩展 Provider 检索窗口至 1,000，再按发布目录与 Grant 过滤；被截断时 complete=false。项目 ID 来自显式登记与候选不可变元数据，旧数据不猜测归属。运行时临时工作材料不是正式记忆，见 runtime-memory.md。

## 5. Provider 去重与物理别名

Mnemon `remember` 对完全重复内容返回 `action=skipped`，已有记忆 ID 在 `replaced_id`；适配器据此识别物理 ID。一个物理 Insight 可能被多个 Logical Memory 的不同 Revision 引用（不同适用范围共享同一物理内容），因此：

- 逻辑身份与物理 ID 是一对多关系，不能反推业务身份。
- Supersedes 原生投影要求目标物理 ID 只被一个逻辑记忆引用，且源物理 ID 未被其它 Revision 占用、未被其它未完成操作共享；不满足时停止自动推进并转人工。
- 不能把 `replaced_id` 当作新写入成功的正式回执；必须按 `action` 判别。

## 6. 生命周期归属

- Session 事件、候选正文、诊断日志、增量标记分别有独立保留期，见 `lifecycle-and-retention.md` 与 `storage-and-operations.md`。
- 正式历史不随候选正文清理；候选清理后，Revision、审核记录与回执仍需可追溯。
- 撤权后保留本地副本但停止服务（AUTH-02），不将撤权实现为删除。

## 7. 未决事项

- 上游自动清理与旁路写入造成的完整性异常如何检测与处置（Q6 细化）。
- 逻辑记忆跨项目复用的物理别名何时允许、何时必须拆分为独立物理内容。
- 冲突裁定的四种结果在多个并发案件下的合并规则（当前实现要求目标基线未被占用）。
