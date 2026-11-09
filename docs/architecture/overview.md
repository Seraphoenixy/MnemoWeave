# MnemoWeave 架构基线

基线日期：2026-11-08。权威输入：本目录 handoff-2026-11-08.md（用户交接说明）；ADR 索引见 ../adr/README.md。

MnemoWeave 是独立的 AI Agent 记忆编排系统。正式记忆存储、原生实体关系及检索由 Mnemon 提供；MnemoWeave 负责候选审核、编排、治理、多 Host 接入和副本同步。主语言 TypeScript，Workspace Monorepo，模块化单体，原生部署，不使用 Docker。当前目标 Host 为 DSH、ChatGPT 桌面、ZCode；Codex CLI 仅保留历史代码和证据。

## 术语

| 名称 | 含义 |
|---|---|
| Source | 以标准 Capability 暴露数据和操作的组件 |
| Provider Adapter | 对真实后端接口的适配，不能承载任意业务或自行调用模型 |
| Strategy | 声明 Composition Plan，不执行底层操作 |
| Core | 验证 Plan、协调执行和授权 |
| Pipeline | 可复用任务执行机制 |
| Enhancement | 通过标准插槽扩展；模型权限必须 declared |
| View | 不可变执行上下文，严格 Grants；能力声明不等于授权 |
| Candidate | 待审核内容，不能直接作为正式记忆 |
| Task / Run / Receipt | 独立身份，关联而不混为同一记录 |
| Replica | 远端权威记忆的本地逻辑副本，不要求物理 Schema 相同 |

规则优先规划；仅规则不足时调用 LLM Planner。模型调用统一经过 Gateway 与 Routing。LLM 置信度和审核不等于技术验证。

## 决策一致性检查

- ADR-020 不提供通用文件同步/云备份，与 ADR-022/023/026 的专用记忆同步、迁移前备份兼容，适用范围不同。
- 本地优先 Recall 与远端正式记忆权威兼容；Bridge 不成为独立写入权威。
- 不可变 View 与 Dynamic Projection 兼容：更新生成新 View，不修改正在执行的 View。
- 主动 Remember、后台整理均需经过候选审核；当前已打通新记忆审核与 Outbox 写入，模型没有绕过审核的正式写入工具。
- Worker 留在 Server 进程中；任务仍需持久化状态机，进程边界不等于领域边界。
- Outbox / Receipt 处理跨 Provider 写入，不假定共享事务；Provider 超时后不可盲目重试。
- Revision 当前指针与发布事务已实现主路径（CAS、业务占用、前向恢复），详见 `../implementation/state-machines-and-transactions.md`；离线撤销与同步已实现（WP6），上游自动清理仍是缺口，见 open-questions.md。

此检查确认已给定选择之间未发现直接矛盾，不代表所有方案的历史细节已经补齐。ADR-015 已由用户补充完整规则；ADR-016/017/018 的历史细节仍待核验。ADR-021 使用交接说明补齐并标明来源。实现规格入口见 `../implementation/README.md`，当前可运行范围与缺口见 `../implementation/current-handoff.md`。

2026-11-09 运行时修复：Pinned、会话任务上下文和事件提炼主链路已实现，详见 ../implementation/runtime-memory.md；真实目标 Host 验收仍未完成。
