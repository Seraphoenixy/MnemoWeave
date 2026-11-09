# 实现交接文档入口

状态：2026-11-08 按用户确认（DOC-05）全量重写。本目录的十五份规格文档是后续开发的入口；九份政策基线文档用于追溯已确认依据，不单独定义字段与流程。

## 1. 权威顺序

1. 用户明确确认的 ADR 与决策：`../adr/README.md`、`decision-register.md`。
2. 本目录十五份规格文档：字段、状态机、工作包与验收以它们为准。
3. 政策基线文档：解释“为什么”，与规格冲突时以规格为准并报告冲突。
4. 代码与测试：实现证据，不得反推为设计决策。

未标注 Accepted 的内容都是 Proposed 或 Open，不能当作已定案要求。

## 2. 状态标记

| 标记 | 含义 |
|---|---|
| Accepted | 用户明确选择，或由已确认 ADR 直接推出 |
| Proposed | 有明确建议与理由，等待确认；实现不得当成定案 |
| Open | 尚未选择，禁止自行填默认值 |
| 已实现 / 部分实现 / 未开始 | 代码事实，不等于验收通过 |

## 3. 十五份规格文档

| 文档 | 回答的问题 |
|---|---|
| `requirements-and-scope.md` | 首版交付什么、非目标、里程碑、完成门槛 |
| `decision-register.md` | 逐批确认结果、待选择项、默认值依据 |
| `domain-and-data-ownership.md` | 身份、Revision、关系、冲突、Provenance、唯一权威 |
| `module-and-dependency.md` | 每个模块的责任、允许与禁止依赖 |
| `contract-catalog.md` | HTTP/MCP/事件/错误/幂等/版本协商的实际契约 |
| `state-machines-and-transactions.md` | 候选、Task、Run、Receipt、Outbox、版本操作、冲突的事务边界 |
| `provider-adapter.md` | 固定版本、真实能力、核对、去重、缺口 |
| `model-gateway-and-routing.md` | 模型权限、路由、预算、失败与降级 |
| `bridge-and-sync.md` | 副本范围、快照、Cursor、排序、删除、校验、重建、离线 |
| `security-and-authorization.md` | 身份、作用域、撤权、Lease、密钥、审计 |
| `host-integration.md` | DSH/ChatGPT 桌面/ZCode 的实际入口、事件、注入与验收 |
| `configuration-deployment-upgrade.md` | 配置、运行、部署、迁移、恢复与诊断 |
| `test-and-acceptance-matrix.md` | 每项需求的证据、状态与缺口 |
| `implementation-work-packages.md` | 依赖顺序、输入输出、完成条件、禁止事项 |
| `current-handoff.md` | 当前仓库状态、已实现能力、已知缺陷、续作步骤 |

## 4. 政策基线（依据，不是实现规格）

- `bridge-sync-baseline.md`：Bridge 与同步政策原文。
- `identity-and-offline-access.md`：身份、撤权与离线状态。
- `recall-and-view.md`：Recall 范围、Pinned、预算与 View 政策。
- `model-and-task-baseline.md`：模型与任务政策。
- `task-scheduling-and-recovery.md`：调度、租约、重试与恢复政策。
- `lifecycle-and-retention.md`：保留、证据与复核政策。
- `storage-and-operations.md`：容量、日志与增量标记政策。
- `host-integration-evidence.md`：Host 官方证据与链接。
- `host-event-and-injection-contract.md`：事件信封与注入故障行为。

这些文档保留原编号与原文；若与规格文档不一致，先修正规格或登记冲突，不静默改写政策。

## 5. 当前结论（2026-11-09 修复后）

- 新增运行时规格 `runtime-memory.md`：持久化 Pinned、会话任务投影、事件提炼候选、Source/Strategy/Pipeline 接线、共享 Bridge 与授权读取。
- 新增 DSH 界面补充规格 `dsh-ui.md`：Bridge 只读 UI API、DSH 客户端插件 host/client 两半、安装与程序化验证；真实桌面加载未验收。
- 当前目标 Host 为 DSH、ChatGPT 桌面、ZCode；Codex CLI 代码及验收仅作历史证据，不计首版门槛。
- 功能代码、进程链路和真实 Host 会话验收分别报告；首版未完成，具体结果与外部阻塞见 current-handoff.md。
- 原十五份规格之外新增运行时补充规格，不改变 ADR-001–026，也不冻结未决同步 Schema。

## 6. 维护规则

- 修改契约、状态机或工作包时，同一提交内更新对应文档与验收矩阵。
- 新增未决项写入 `decision-register.md` 的“后续确认批次”，不在正文里悄悄定默认值。
- 文档中的“已实现”必须能指向代码路径或测试；不能指向计划。
- 每轮交接更新 `current-handoff.md` 的实际状态与未完成项。
