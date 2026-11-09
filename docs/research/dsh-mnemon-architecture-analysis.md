# DSH 集成层评估（dsh-mnemon 0.5.42）

核查日期：2026-11-08。方式：静态阅读源码，不运行插件、不安装 DSH、不执行其测试。

- 固定提交：`ee080a7371759928c97c581621713819f31507d4`（`v0.5.42`，仓库 `https://github.com/omdsh-dev/dsh-mnemon`）。
- 本地副本：`work/upstream/dsh-mnemon`（含 `.git`）与 `D:\projects\dsh-mnemon-main`（无 `.git`，内容一致）。
- 目标 Host：DSH `0.2.2-rc.1`、Node ≥24.9；Mnemon CLI 0.2.9（Embedding 检查需 0.2.13+）。
- 定位：DSH 侧的编排与集成实现，不是 Mnemon 官方引擎，也不是 MnemoWeave 的运行时依赖。

## 1. 参考项目的结构

- Core + SDK：标准能力注册、契约校验、不可变 View、预算、generation 与 lease。
- Source：拥有数据与操作（runtime、documents、memory-spaces、skills）。
- Strategy：纯确定性组合（`request + facts + 贡献 → ViewSpec`），默认 Layered，另有 General 与三个 Enhancement 插槽。
- Provider：9 个独立插件包，运行在 Memory Spaces 内部，作为存储/检索驱动，不是 Core 贡献。
- Host：DSH 生命周期、工具/RPC 适配、鉴权、设置与受监管任务。
- Starter：包集合与默认配置，不引入第二套加载器。

## 2. 证据

| 关注点 | 证据 |
|---|---|
| 不可变 View 与授权 | `src/core/contracts/view.ts`：`MemoryReadGrant { id, sourceInstanceKey, schema, value, revision, consistency }`、`MemoryViewFragment`、`MemoryViewRoute`、`MemoryViewAction`；`consistency` 为 `exact-snapshot` 或 `namespace-pinned-live-read` |
| generation 与 lease | `src/core/generation.ts`：`GenerationRecord { generation, leases, state: 'serving' \| 'draining' }`；`MemoryGenerationLease.release()`；无可用 generation 时抛 `MemoryCompositionUnavailableError` |
| 组合校验 | `src/core/composition.ts`、`definitions.ts`：实例身份、能力、预算与贡献校验；拒绝的候选不替换 Serving generation |
| Provider 边界 | `plugins/dsh-mnemon-source-memory-spaces/src/provider-sdk.ts`：Source 自有子 Fiber 与 Provider 协议；Provider 只拿到绑定的 `host.install` 能力 |
| Host 事件 | `src/host/lifecycle.ts`：`session/event`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`、`system-prompt/assemble`、`agent/pre-step`、`agent/turn-stopping`、`step/start`、`agent/created` |
| 工具面 | `src/host/tools.ts` 与 `docs/en/reference/interfaces.md`：读工具 `mnemon_status`、`mnemon_memory_bodies`、`mnemon_recall`、`mnemon_related`、`mnemon_document_search`；写工具在 `writeEnabled` 下启用，写工作通过子 Agent 执行 |
| 审核与合并 | `docs/plans/memory-review-flow.md`：模型出计划、用户 `guidance`、按 operation 子集执行并记账；应用不改变未选操作 |
| 同步 | `docs/plans/git-sync.md`：整包 payload 推到 Git 分支、镜像与工作区分离、凭据按操作解析、push 显式确认、pull 校验后导入 |
| 进程与输出边界 | `docs/en/development/architecture.md`：`spawn(shell:false)`、stdout/stderr 每次 2 MiB 上限、超时与 AbortSignal、SIGTERM 后 1.5 秒 SIGKILL、单 Runner 串行 |
| 文件边界 | 锁等待 5 秒、陈旧阈值 30 秒、临时文件 + rename、`sourcePaths` 不得逃出工作区 |

## 3. 可借鉴

| 参考做法 | MnemoWeave 对应 | 借鉴程度 |
|---|---|---|
| View 只把有界模型视图送入 Wake，授权载荷不进模型上下文 | ADR-013 的不可变 View 与 Grants | 采纳形态，字段自有 |
| 每 turn 固定一个 View，写入返回 receipt，后续 turn 才见新版本 | ADR-013/019 | 采纳 |
| generation 保留/排空，拒绝的候选不替换 Serving | Revision 发布事务 | 采纳思路；当前用 CAS + 占用实现 |
| Provider 位于 Source 内部，能力/健康随 Source 上报 | ADR-010 | 采纳边界，不复制 Fiber |
| 审核是计划 + 用户意见，可部分执行并记账 | ADR-015、冲突裁定 | 采纳“可审阅计划”，不采纳“未经审阅的整批合并” |
| 读/写/RPC 通道分离，写通道要求显式授权 | ADR-021、operator 边界 | 采纳分离原则 |
| 输出上限、超时、串行 Runner、临时文件 + rename | ADR-026 | 直接采用工程参数 |
| 不可信数据边界、删除工具不交给自主 Worker | ADR-025 | 采纳 |

## 4. 不可借鉴

- Cordis Fiber、Starter 安装、插件包发布、DSH 客户端页面与 RPC：属于 DSH 生态，ADR-022 选择独立运行时。
- `src/client/*` 与 `mnemon.*` Slot：不是外部 Host 契约，不能作为 MnemoWeave SDK 的形态依据。
- Git 同步：是备份与人工合并，不是授权副本、Cursor、Tombstone 或离线许可协议。
- DSH 的 `MemoryReadGrant` 具体字段：可作为形态参考，不能直接复制成 MnemoWeave 公共契约。
- 其兼容性承诺（DSH 版本区间、Node 版本）不能转写为 MnemoWeave 的部署要求。

## 5. 与 MnemoWeave ADR 的对应

| ADR | 参考项目对应 | 结论 |
|---|---|---|
| ADR-008 核心组件 | Core/Source/Strategy/Host/Starter | 概念一致，MnemoWeave 不需要 Starter 与客户端层 |
| ADR-009 Strategy/Core 边界 | ViewSpec 只作提案，Core 校验 | 与“Strategy 声明 Plan、Core 协调”一致 |
| ADR-010 Source/Provider | Provider 在 Source 内部 | 一致；Mnemon Adapter 属 Provider 层 |
| ADR-013 View | ReadGrant + 不可变 View | 形态可借鉴，需自有字段 |
| ADR-019 Task/Run/Receipt | 写入 worker + receipt | 一致；参考项目没有 MnemoWeave 的 Outbox 账本 |
| ADR-021 HTTP/MCP/Bridge | 读/写/同步/审核分通道 | 分离原则一致，通道实现不复制 |
| ADR-024 Recall | 多 Provider 召回融合 + related 边类型 | 可借鉴“检索结果带来源/一致性” |
| ADR-025 质量与审核 | 自主 Worker 限制、受监管写入 | 一致 |
| ADR-026 可靠性 | 输出上限、超时、串行、原子写 | 直接采用 |

## 6. 对 MnemoWeave 的影响

1. View 契约需要“不可变 + 授权载荷隔离 + 一致性模式 + generation/lease”四项，而不只是字段集合；WP4 的设计以此为输入。
2. Provider 能力应随适配器上报并带证据状态，而不是在核心代码里按 Provider 分支。
3. 审核应表达为可审阅计划与部分执行，而不是“接受/拒绝”单点；冲突裁定沿用该形态更自然。
4. 工程边界参数（输出上限、超时、串行、原子写）可直接采用，但不得声称参考项目的行为等于 Mnemon 官方行为。
5. Git 同步只能作为 Bridge 设计的反例，不能作为协议草案。

## 7. 本次核查的限制

- 未运行 DSH 或插件，事件名与行为来自源码与文档，未经本机验证。
- 未核对参考项目对 Mnemon 版本的实际调用细节；能力结论仍以 `mnemon-capability-matrix.md` 为准。
- 参考项目仍有未合并的 issue 与版本差异，不能把某一提交的行为当成长期契约。
