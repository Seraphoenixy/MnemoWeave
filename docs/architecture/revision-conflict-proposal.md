# 版本更新与冲突处理：待审阅实施方案

状态：Accepted（2026-11-08 用户确认“采用推荐方案，继续实施”）。采用方案 A；随后按本文分阶段实施，不代表完整里程碑已完成。

依据：ADR-015、R17-4、R19-6/7/8、R20-3；Q2 方案 A 已接受（Provider 保存各版本全文，MnemoWeave 保存映射、哈希与当前指针）。上一阶段建议先审阅数据所有权与事务方案，再实现表和流程，本方案落实这一前置步骤。

## 1. 需要确定的数据所有权

推荐方案 A：**Mnemon 保存每个版本的正式全文；MnemoWeave 保存逻辑身份、不可变版本映射、内容哈希、当前指针、审核和发布账本。**

- Logical Memory ID 由 MnemoWeave 分配，表示一个明确适用范围内的逻辑知识，不从文本相似度自动推断身份。
- Revision ID 在审核通过后的操作计划中预分配；Provider Memory ID 由 Mnemon 返回。不同 Revision 对应不同物理 Insight，但仍属于同一个 Logical Memory，不误算为不同业务记忆。
- 当前版本指针由 MnemoWeave 的发布事务管理，只有核对完成的版本可被引用。Mnemon 不提供这一业务指针接口。
- 候选原文和 Provenance 保持不可变审核素材，不能成为另一份可编辑的正式内容权威。正式读取始终用官方 show，校验已发布哈希。
- Provider 缺失/被旁路修改时返回完整性异常并要求核对；不能偷偷用候选文本代替 Provider 结果，或自动重建“正式事实”。

优点：不增加第二个正式内容权威；充分复用 Mnemon；职责清晰。代价：历史全文的可用性依赖 Mnemon 旧记录和服务器备份，丢失时明确报错。

备选方案 B：在 A 之外另存每个正式版本的不可变审计快照，用于核对和经授权恢复，正式读取仍以 Mnemon 为准。优点是审计全文和恢复材料更完整；代价是增加持久化内容副本与生命周期管理，必须严格限制其用途，避免变成第二个读写权威。

两者都不允许“Mnemon 与 MnemoWeave 分别修改正式文本”。用户确认后再确定字段与迁移，不以本文冻结 Schema。

## 2. 两层身份与适用范围

| 类型 | 语义 |
|---|---|
| Logical Memory | 同一事实/工程知识的稳定身份，绑定明确适用范围 |
| Revision | 同一逻辑身份下的不可变版本；包含前版本、依据、时间、Provider 引用、哈希和发布记录 |
| Supersedes | 两个不同 Logical Memory 之间的替代；冻结源/目标版本，记录原因、证据和适用时间 |
| Coexists | 双方成立但适用项目/版本/环境不同；均保留，不改变另一方的当前指针 |
| Conflict Case | 同适用条件下真实矛盾；双方证据与候选保留，未经裁定不发布新结论 |

适用范围需显式描述项目、技术栈/版本、环境和前置条件；不能只凭自由文本相似度合并逻辑身份。现有 provenance.applicability 原样保留，旧数据不自动解析成虚构的结构化事实。跨范围统一和 Global 晋升继续人工审核。

自然演变用 revise 操作引用原 Logical Memory 和 expectedCurrentRevision；方案替代用 supersede 操作明确两个逻辑身份，不能把所有新 Revision 都变成独立业务记忆或 Supersedes。

## 3. 写入与发布事务

推荐采用持久化操作计划 + 前向恢复，不假定跨 Provider 事务：

1. HTTP/MCP 提交候选和明确的操作类型，附目标、预期基线、适用时间及依据。模型没有直接修改指针的权限。
2. 规则/模型检查；版本演变、替代及冲突解决由人工确认。记录最终操作意图，不能让模型置信度代替裁定。
3. 在同一治理事务中保存审批、预分配的身份、不可变计划、Task 与 Outbox，并为涉及的逻辑记忆登记持久化操作占用。Worker 租约可过期，但业务占用不能因租约过期就被另一个更新覆盖。
4. 检查 expectedCurrentRevision（CAS）与基线内容哈希；冲突则回到需要重新审核，不自动以“最新提交”覆盖。
5. 通过现有可靠写入机制写新内容，核对官方 show，保存 Provider ID/哈希。中断时按检查点对账，不盲目新增。
6. 需要原生 Supersedes 时，先持久化固定的源/目标 ID、operationId、原因与 effectiveAt，再调用官方 link。保存方向正确的结构化回执；恢复可重放同一固定 upsert 意图，不能根据邻接遍历推断方向。
7. 所有必需步骤确认后，用一个 SQLite 发布事务登记 Revision、更新指针/逻辑状态、发布关系、关闭冲突任务、提交最终 Receipt 并释放业务占用。CAS 再校验；合法写入者都必须遵守占用，因此不能在不可逆外部操作之后任意换基线。

在 Provider 已成功、治理发布尚未完成的窗口中，新物理记录是 staged，不是当前版本。治理 API 的默认有效 Recall 需要按已发布目录过滤并补充检索，排除未发布、被替代和旧 Revision；显式历史查询可读取旧版本。原生 Recall 的 superseded 只作 Provider 信号，不能替代逻辑指针或作用域判断。

正式发布后的历史查询返回 Logical Memory、Revision 链、各自适用范围/时间、审核依据、Provider 内容核对结果和 Receipt。查询历史不能反向更新当前指针。

## 4. Mnemon 的真实关系能力与限制

固定版本：v0.2.13 / 0025a66351263abec3b67ef5b4a6932adb80e5dd。依据 cmd/memory/link.go、related.go、internal/memory/graph/bfs.go、internal/memory/model/edge.go 和实际 CLI 测试。

- `link NEW OLD --type supersedes --meta JSON` 支持方向性 Supersedes；JSON 回执带 source_id、target_id、edge_type、metadata。
- 相同源/目标/类型重复 link 是逻辑 upsert，实际重复提交后边数不增加；原全文不变。原生创建时间可能变化，因此业务原始生效时间与操作身份必须由不可变计划/metadata 保留，不能把重放时间当原审批时间。
- `related --edge supersedes --depth 1` 会遍历两端邻接，**不能证明替代方向**。源码 BFS 在 source/target 两端寻找邻居，输出也没有原始 source/target。
- 原生 `recall` 返回 superseded 标记；适配器原先丢弃该字段，现已保留，避免将旧记忆呈现成无状态普通结果。
- link 回执里的 created_by 在上游被固定写为 claude；不能用它当作 MnemoWeave 审核人或真实操作者身份。操作者以本系统可信审核记录为准。
- 未发现正式方向性关系读取 JSON 端点；viz 是 DOT/HTML 展示导出，不能据此臆造图 JSON API。本阶段不依赖私有 Web 或内部表。
- 未发现官方 unlink CLI。不能用“写反向边/删除旧内容”当作失败补偿；Supersedes 之后优先前向恢复，需人工处理的状态必须保留。

原生关系没有业务级适用范围和 Revision 身份。仅在替代覆盖整个已确认范围、物理记录不被其他有效范围共享时投影原生 Supersedes；条件不同或 Provider 去重导致多个范围共享物理 ID 时，不能无条件投影成全局替代。需要的能力不满足时明确停写/转人工，而非静默降级成 semantic。

## 5. 故障窗口与处理

| 窗口 | 恢复规则 |
|---|---|
| 审核后、Provider 调用前 | 恢复原 Task/操作身份；重新校验基线，不重新生成不同计划 |
| 新内容调用结果未知 | 官方内容查找 + show 核对；唯一明确结果才继续，否则保持待处理 |
| 内容已写、关系未写 | 保持 staged 和旧指针，按固定计划继续关系步骤 |
| link 已成功、回执丢失 | 只能重放同一方向/同一 metadata 的 upsert 并校验回执；related 邻接不作为方向证明 |
| link 已成功、尚未发布 | 保留业务占用并前向恢复发布；不自动 unlink、forget 或指向无关版本 |
| 发布事务失败/进程终止 | SQLite 事务回滚或完整提交；重启核对 operation/Receipt，已发布不重复推进 |
| 并发改同一逻辑知识 | expectedCurrentRevision + 持久化业务占用；旧基线请求显式冲突，不自动重基线 |
| Provider 被外部改写/删除 | 标记完整性异常，停止自动推进；保留双方证据，人工决定 |

取消只在尚未执行不可逆关系投影前安全受理；已写入但未发布的内容作为审计关联保留，不自动物理删除。后续修正应新建经审核操作，而非覆盖历史。

## 6. 冲突裁定的四种结果

- 原有结论正确：拒绝新候选，旧指针保持，保存裁定依据。
- 新结论替代旧结论：明确选择 revise 或 supersede，按完整操作计划发布，不自动按时间/置信度选择。
- 双方均成立：补齐各自范围，保留双方；必要的更正仍为新 Revision，不改历史正文。
- 双方证据不足：保留待验证案件和材料，不发布新的确定性结论，不物理删除旧记录。

## 7. 从当前 v2 的迁移与验收计划

用户确认方案后，先定义统一契约，再设计版本化 Migration 与一致快照。现有 Persisted 候选根据成功 Receipt/Provider ID 建立初始逻辑映射，核对内容哈希；身份或范围不明确时不猜测，标为待人工登记。原 Candidate/Review/Task/Receipt ID 保持不变。

正式验收必须覆盖：HTTP/MCP 更新同一逻辑身份、旧版本可查、当前指针 CAS、方案替代和完整依据、不同范围并存、真实矛盾裁定、旧基线并发失败、每个外部步骤中断恢复、关系回执丢失重放、阶段数据默认不可见、Provider 完整性异常、迁移备份/重启。使用真实 Mnemon 和隔离目录，通过 CLI 验证副作用。

当前状态（2026-11-08）：版本操作入口已开放，经人工确认的 `change` 意图进入版本工作流；`keep_existing`/`unverified`/`revise`/`supersede`/`coexist` 五种冲突裁定与未发布版本取消已有实现。证据为 `tests/e2e/version-publication.test.ts`、`tests/e2e/conflict-resolution.test.ts`、`tests/e2e/supersedes-behavior.test.ts`、`tests/e2e/version-recovery.test.ts` 与 `tests/contract/version-workflow.test.ts`。该里程碑仍未完成：外部改写、模型/Provider 长时间异常与真实数据迁移尚未验收；v2→v3 迁移回填缺陷已修复并有 contract 用例。
