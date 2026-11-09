# 数据所有权

| 数据 | 权威 / 职责 |
|---|---|
| 正式记忆内容与原生实体关系 | Mnemon；只用已核实官方接口 |
| Candidate、审核、Provenance 扩展 | MnemoWeave |
| Task、Pipeline Run、Receipt、Outbox、同步状态 | MnemoWeave |
| Revision 正式全文 | 用户已确认：仅 Mnemon 权威保存各版本全文 |
| Revision 映射、哈希、当前指针 | MnemoWeave 治理账本；候选只作审核素材，读取不回退到候选原文 |
| Bridge Replica | 远端授权范围内的逻辑副本，可重建 |
| 大内容 | 数据库元数据 + 本地内容寻址文件 |

SQLite 优先、单库内模块独立建表。MnemoWeave/Bridge 各自版本化迁移、升级前备份与恢复；Provider 自行管理内部迁移。禁止读取或修改 Mnemon 内部表作为产品接口。

版本目录按已接受方案分阶段迁移，当前治理库为 schema v9：包含逻辑记忆、不可变 Revision、版本操作计划、业务占用、冲突案件、Session 事件、同步授权/变更流与复核计划；发布、Supersedes 投影、冲突裁定、同步与时间型复核已有主路径实现。完整同步 Schema 已按第十八批确认落地（`sync_log`、`sync_grants`、`sync_license_state`），副本协议由 `packages/bridge` 实现。会话只选择性保存，热数据/限期归档/重要事件长期保留；候选内容按状态清理并保留审核记录。细化见 `../implementation/domain-and-data-ownership.md` 与 `../implementation/state-machines-and-transactions.md`。
