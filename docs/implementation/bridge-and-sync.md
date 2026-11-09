# Bridge 与同步

状态：政策 Accepted（SYNC-01 至 SYNC-06、AUTH-01 至 AUTH-05、STORAGE-01）；库层、HTTP 传输与 Bridge 进程已实现（WP6/WP7），真实 Host 与生产部署未完成。本文固定 Bridge 的职责、数据范围与协议字段，详细政策见 `bridge-sync-baseline.md`、`identity-and-offline-access.md`、`storage-and-operations.md`。

## 1. 角色与进程形态

- 常驻 Shared Bridge，多 Host 共用；Windows 为用户级后台进程，Linux 为 `systemd --user`。
- Bridge 持有本地 SQLite 副本、离线队列与有限运行缓存；不成为正式写入权威。
- Host 通过适配器连接 Bridge；Bridge 通过 Server 同步与提交意图。
- Server 保持正式权威；Bridge 不得自行批准候选、晋升 Global 或修改当前指针。

## 2. 已确认范围

| 编号 | 决定 |
|---|---|
| SYNC-01 | 同步授权范围内当前与历史版本全文；不含全部 Session 原文；历史 Recall 可离线 |
| SYNC-02 | 候选、事件、版本与关系变更意图均可离线持久化排队 |
| SYNC-03 | 专用 Mnemon Store，正式变更统一经 MnemoWeave；外部数据经导入与审核 |
| SYNC-04 | 增量 30 秒；全量校验 3 天（72 小时）；重连与关键事件额外触发 |
| SYNC-05 | 暂存区重建后一次切换；结构完整且许可有效的旧副本带数据时间与过期标记可读 |
| SYNC-06 | 增量日志保留 30 天；删除/移除标记 90 天；过期 Cursor 触发快照重建 |
| AUTH-01 | 离线读取许可默认 1 小时，由 Server 配置；不能由 Bridge 自行续期 |
| AUTH-02 | 撤权后立即禁止访问但保留副本；不自动清理正文与索引 |
| AUTH-03 | 仅读取许可过期时，身份有效且未撤权的 Host 仍可提交待处理意图 |
| AUTH-04 | 首次配对由用户确认并签发每 Host 独立凭据 |
| AUTH-05 | 配对时授予当前及未来全部项目；Global 另行授权 |

## 3. 副本数据范围

副本包含：

- 授权范围内已发布 Revision 的 Provider 正文、逻辑记忆与 Revision 元数据、当前指针、状态（active/superseded/unverified）、适用范围。
- 检索所需的本地索引与关系投影。
- 版本与关系变更意图的待提交记录（独立于正式副本）。

副本不包含：未授权历史、全部 Session 原文、服务端模型凭据、其它 Host 的私有上下文、被拒绝或未发布的候选正文（除本地意图本身）。

## 4. 同步协议（Accepted，2026-11-08 第十八批确认）

以下字段与流程已由用户确认（详见 `decision-register.md` 第十八批），副本 Schema 据此冻结：

| 项 | 决定 |
|---|---|
| 快照格式 | 独立快照 SQLite 文件（仅副本范围表，不含候选/审核材料）+ 逐表 SHA-256 清单 + Server 单调 generation；分片 64 MiB |
| 增量流 | Server 治理库 `sync_log(seq, op, entity_id, payload_json, payload_hash, op_at)`，op ∈ memory/revision/relation/remove_tombstone/revoke_tombstone；变更与业务写入同事务追加；Bridge 按 seq 幂等应用 |
| Cursor | Bridge 保存已应用 seq；增量窗口 30 天（SYNC-06），Cursor 落后于窗口最旧 seq 即失效并触发快照重建；重复投递按 seq 幂等跳过 |
| Tombstone | remove（正式记忆被治理移除）与 revoke（授权撤回）分离；保留 90 天；seq ≤ 已应用 seq 的复活数据直接丢弃 |
| 批与背压 | 单批 ≤200 条或 ≤8 MiB；超时 30 秒；重试退避同 TASK-04（指数、封顶 15 分钟）；本地剩余磁盘低于阈值暂停接收并告警，不丢弃队列 |
| 全量校验 | 每 72 小时按 memory 分区摘要核对（memoryId + 当前 revision + 内容哈希）；差异生成增量请求；差异超过 5% 转快照重建 |
| 切换 | 重建写入 `replica.staging.db`，清单哈希全对后原子 rename 切换；旧副本保留为 `replica.previous.db` 带数据时间与过期标记，许可有效时可读 |
| 离线队列 | Bridge `intent_queue(intent_id, host_id, kind, payload, baseline_ref, created_at, state)`；重连后 Server 重验授权/基线/审核；撤权后意图隔离保留不自动提交；投递回执确认前不删除 |

协议必须满足：本地应用与 Cursor 更新同一事务；快照不一致时停止读取而不是返回空结果；任何“已同步”状态必须有可核对的证据。

传输层：HTTP 端点与 Bridge 进程入口已交付；第 8 节验收由 `sync` 与 `sync-http` contract 覆盖。

## 5. 与参考项目的区别

dsh-mnemon 的 Git 同步是“可读文件备份 + 人工合并”：把整包 payload 推到 Git 分支，pull 时经 pack 导入，冲突以人工 review 处理。它证明“可读、可核对、凭据不落盘”的工程做法可用，但不提供：

- 授权范围内的历史正文副本与离线许可。
- 有序 Cursor、删除标记保留期与旧副本复活防护。
- 暂存重建与一次切换。
- 多 Host 共用同一 Bridge 的作用域判定。

因此 Bridge 同步不能照搬 Git 分支模型；可借鉴的是 payload 校验和、镜像与工作区分离、凭据按操作解析、push 显式确认。

## 6. 读取与故障行为

- 本地优先检索；本地缺失或截断时标明数据时间与完备性，联网可向 Server 补充。
- 许可过期、撤权、副本损坏或重建未完成时禁止读取，不得以空结果冒充“无记忆”。
- Bridge 不可用且无合法副本时，Host 明确提示记忆不可用，普通任务可继续（HOST-04），不得显示“已加载”。
- 恢复后生成新 View 并经受支持入口交付；不向已结束的回调补写。

## 7. 实现顺序与门槛

1. 完成 `contract-catalog.md` 的事件与意图契约、`state-machines-and-transactions.md` 的意图状态机。
2. 定义副本 Schema 与快照/增量/Tombstone 协议，评审通过后再建表。
3. 实现 Bridge 进程、配对、许可、离线队列与本地检索。
4. 实现同步、校验与重建，覆盖断网、撤权、Cursor 失效、磁盘不足。
5. 接入 Host 适配器，验证自动注入与事件采集（与 Host 里程碑联动）。

未满足第 1、2 步前不得写 Bridge 持久化实现，避免再出现“Schema 先行、协议后补”。

## 8. 验收要求

- 两个 Bridge 与 Server 的三个方向：提交、增量、全量校验、重建。
- 撤权立即生效、许可到期停止读取、离线意图不丢失且不自动提交。
- 收到旧 Cursor、重复变更、乱序变更、删除标记过期时的明确行为。
- 重建期间旧副本带标记可读，损坏副本不可读，队列隔离。
- 不使用用户默认 Mnemon 目录，不读取 Host 私有数据库。

## 2026-11-09 修复补充

本轮实际运行时、projectId 授权、逐 Host 凭据、capture 状态机、v10 迁移和同步一致性以 [runtime-memory.md](runtime-memory.md) 的实现细化及 [current-handoff.md](current-handoff.md) 的实测状态为准。旧章节的“已实现”不表示真实 Host 验收已完成；未决同步 Schema 和身份体系细节不因原型代码而冻结。
