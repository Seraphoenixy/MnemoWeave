# 候选提交：里程碑前半段

历史阶段记录：用户随后已补充 ADR-015，审核与可靠写入已继续实现。当前状态见 reliable-write-milestone.md，以下“等待补充/未完成”不代表最新实现。

范围依据：用户要求完成“通过 HTTP/MCP 提交候选记忆，审核后可靠写入 Mnemon，重启后仍可查询并追溯”的最近里程碑。

用户选择补充原审核方案，未选择独立人工审核令牌方案。因此本阶段只实施不依赖审核策略的提交与取证；正式审核、批准权限和写入调度保持关闭，不能把 pending_review 提交回执解释为写入成功。

## 应用与数据边界

RememberInput 包含幂等键、内容、知识类型、标签和结构化 Provenance。HTTP/MCP 使用同一 Zod 契约和 MemoryApplication。额外 approved 等字段被 strict 校验拒绝。

CandidateRepository 为 Application Port，SqliteCandidates 为实现。治理库使用 node:sqlite DatabaseSync，WAL、synchronous FULL、显式事务和 busy timeout。参考 [Node 官方 v24.x API 源文档](https://github.com/nodejs/node/blob/v24.x/doc/api/sqlite.md)，并在本机 Node 24.22.1 实际运行验证。

初始版本 v1 只包含 governance_candidates 和 governance_submission_receipts，不包含正式记忆内容表、Revision 指针、同步 Schema 或 Provider 内部表。候选 request_json 是不可变审核素材，不是第二份正式内容权威。将来扩展需版本化迁移、升级前一致备份及恢复；当前仅初始化空库，拒绝未知既有数据库和更新版本。

稳定幂等键唯一索引与 payload SHA256 由同一 BEGIN IMMEDIATE 事务验证。候选和提交回执同事务创建；故障注入证明回执失败会回滚候选。HTTP/MCP 两个独立进程并发提交同键输入返回同一候选，实际 Server 进程终止并重启后仍保持相同身份。

## 写入核对基础

inspectExact 只调用官方 recall --basic，使用完整内容和最多 200 行的有界查询，随后精确比较。由于 LIKE 的 %/_ 行为与输出上限，结果标明 complete；达到上限不能推断不存在。verifyContent 通过官方 show 按 ID 再核对完整内容。

真实故障测试在 Mnemon 已提交后丢弃 CLI 响应并抛出超时，随后通过官方读取找回记忆，验证写入次数仍为 1。这只是对账机制证据，不是完整可靠写入状态机。未找到内容、读取失败、截断或模糊结果都不能自动授权重试。

## 未完成的里程碑要求

- 原审核方案及冲突处理细节，尤其谁能批准、语义审核、哪些情况需要人工确认。
- 审核记录、Outbox、Task/Run/Receipt 事务关联和持久化状态机。
- 写入成功但治理事务未提交时的自动恢复与人工介入入口。
- 审核后双协议正式写入、重启后正式回执追溯的完整 E2E。

Q2/Q4/Q5/Q6 仍保留；本阶段不替用户决定正式 Revision、同步和离线授权方案。目标仍为完整里程碑，当前未完成。
