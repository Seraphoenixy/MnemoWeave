# 未决事项与决策门槛

| 编号 | 优先级 | 问题 / 当前状态 |
|---|---|---|
| Q1 | P0 | 上游接口：CLI 可验收；Web 是私有 GET-only；HEAD 的 socket 仅本地且与 release 不同。并发安全需压力验证 |
| Q2 | P0 | 内容权威边界已确认方案 A：Mnemon 正式全文，MnemoWeave 映射/哈希/指针/账本。schema v9 的逻辑记忆、Revision、版本操作、冲突裁定、同步与复核计划已有主路径实现；并发与多进程已有 contract 证据，外部改写与真实数据迁移待验收。见 `../implementation/state-machines-and-transactions.md` |
| Q3 | P0 | 已确认授权范围内当前及历史全文副本；候选/事件/版本/关系意图可离线排队。图、Provenance、Pinned/Projection、FTS/向量及具体传输边界继续细化 |
| Q4 | P0 | 已确认专用 Store 统一变更、30 秒增量、3 天全量校验、暂存重建/有效旧副本带标记读取；快照/Cursor/Tombstone 的具体协议仍待细化 |
| Q5 | P0 | 离线读取许可默认 1 小时已确认；收到撤权立即停止。Host 注册、Bridge 认证、许可签发/时钟、凭据轮换及数据库保护继续细化 |
| Q6 | P0 | 已确认不支持正常旁路写入：专用 Store，外部数据经导入审核；非预期外部改变进入完整性异常。子进程关闭自动容量清理；异常核对与处置协议待细化 |
| Q7 | P0 | 用户全量整理版已补齐 ADR-016/017/018 的架构原则；不再要求恢复原始菜单。具体路由预算、重试参数和调度规则通过实现细化决策确定 |

P1：Provider 超时写入对账、Blob GC、Migration 中断恢复、Capability 命名/废弃、Gateway 凭据、僵尸任务回收、E2E 环境、日志脱敏/保留、Replica 损坏恢复。

P2：更多 Provider/Host、完整 OpenTelemetry、Claim 图谱、管理 UI、高级知识推理。

## 需要用户决定的方向（暂不执行）

Q2 的方案 A 已由用户接受，按 revision-conflict-proposal.md 实施；版本更新、CAS/业务占用、Supersedes 投影与发布恢复已有主路径，剩余为并发、外部异常与迁移验收，见 `../implementation/current-handoff.md`。

Q4 推荐所有正式写入经 MnemoWeave，维护应用变更流并定期用官方导出能力核对；优点是可控制 Cursor/Tombstone，代价是必须约束旁路写入和自动清理。替代方案周期全量差分实现简单，但延迟和成本较高，无法直接替代已确认的增量方案。

Q5 离线 Lease 短时限提升撤销及时性但减少离线可用性；长时限相反。推荐待真实离线需求确定后选择时限，当前不填默认业务承诺。
