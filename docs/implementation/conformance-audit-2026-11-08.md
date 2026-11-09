# 实现与文档一致性检查（2026-11-08）

状态：只读检查。未修改代码、未修改规格正文；本文件只记录事实与偏差。结论按 `README.md` 的权威顺序判定：ADR/用户决策 > 十五份规格 > 政策基线 > 代码与测试。本文件记录修正前状态；P0/P1 修正结果见第 10 节。

## 1. 检查范围与方法

| 类别 | 内容 |
|---|---|
| 规格文档 | `docs/implementation/` 十五份文档 + 九份基线 + `host-acceptance/` |
| 架构与决策 | `docs/architecture/`、`docs/adr/`、根 `README.md` |
| 代码 | `packages/`、`apps/`、`tests/` 全部 TypeScript 源（62 个文件，6,699 行） |
| 方法 | 抽取文档中可证伪的断言（状态、计数、Schema、能力边界），对照源码与测试；不逐字段重抄 Zod 定义 |

本轮实测：

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 构建 | `node node_modules/typescript/bin/tsc` | 通过（输出 `dist/`，工作区保持干净） |
| Unit + Contract | `node --test tests/unit/*.test.ts tests/contract/*.test.ts` | 97 项，97 通过 |
| E2E（真实 Mnemon 0.2.13） | `node --test tests/e2e/*.test.ts` | 12 项，12 通过 |

## 2. 总体结论

实现进度已领先于多数文档的状态描述。代码层面未发现被文档明确禁止的做法（未读 Mnemon 内部库、未绕过候选审核、未让 Provider 自寻模型），主要问题是文档状态行与“未实现”清单大量停留在 WP5 之前。

| 类别 | 数量 | 含义 |
|---|---|---|
| A 事实过期 | 16 | 文档陈述的版本、计数、缺陷或完成状态与当前代码不符 |
| B 文档互相矛盾 | 5 | 同一事实在不同文档或同一文档前后表述冲突 |
| C 能力接线不一致 | 4 | 组件已实现并有测试，但未接入实际交付路径，文档表述介于“已实现”与“未接线”之间 |
| D 文档缺失已实现契约 | 4 | 代码已交付的 HTTP/MCP/Schema 能力未写入规格 |
| E 真实实现缺口 | 7 | 文档正确记录、代码确实未完成 |

## 3. A 类：事实过期

| 编号 | 位置 | 文档说法 | 实际 |
|---|---|---|---|
| A1 | `README.md:106` | 治理库 schema v5，启动按 v1→v5 迁移 | v1–v8；`packages/infrastructure/governance/src/index.ts:146-160` 新增 v8 `sync_log`、`sync_grants`、`sync_license_state` |
| A2 | `README.md:110` | v2→v3 回填访问未创建的 `catalog_relations`，修复前禁止升级 | 已修复：`packages/infrastructure/governance/src/catalog.ts:186-189` 在表不存在时跳过歧义检查；对应 contract 用例通过 |
| A3 | `README.md:114` | 31 项测试中 1 项失败 | 97/97 通过（unit + contract），E2E 12/12 通过 |
| A4 | `README.md:49` | `/openapi.json` 未包含冲突读取、冲突裁定、版本取消三条路径 | OpenAPI 覆盖 17 条路径、18 个操作；`tests/contract/openapi.test.ts:11-17` 断言与 `httpRoutes` 完全一致 |
| A5 | `README.md:11` | M3 Bridge、M4 Host 接入、M5 运维加固尚未开始 | M3 已实现（库层 + HTTP 传输 + Bridge 进程）；M4 ZCode/Codex 适配器与钩子入口已实现并经 HOST-01 核验（Codex 注入经用户侧钩子处理器，真实会话验收通过）；M5 部分交付（systemd 单元、磁盘地板、保留清扫逻辑） |
| A6 | `README.md:102` | 写入前故障最多三次，退避 2 秒 × 尝试次数 | `packages/infrastructure/governance/src/index.ts:336` 为指数退避，封顶 900,000 ms（15 分钟） |
| A7 | `docs/implementation/README.md:59` | M2 覆盖不足；M3/M4/M5 未开始 | 同 A5；M2 并发、多进程、时钟漂移已有 hardening 用例 |
| A8 | `docs/implementation/README.md:61` | HOST-05、2 秒上限、4,096 Token、保留期、模型预算、Rerank 均未实现 | 全部有实现与契约测试；仅容量配额未接受默认值 |
| A9 | `docs/implementation/README.md:62` | 仓库当前没有任何提交 | `main` 有连续提交，最新 `85342cc` |
| A10 | `docs/implementation/bridge-and-sync.md:3` | 实现未开始 | WP6 库层、`apps/bridge` 进程、HTTP 同步端点、双 Bridge 快照/增量测试均已交付 |
| A11 | `docs/implementation/host-integration.md:3` | 实现未开始 | `packages/adapters/shared-sdk`、`zcode`、`codex` 已实现并有 contract 覆盖 |
| A12 | `docs/implementation/requirements-and-scope.md:55-57,73-75` | M3 进程入口“随 WP7”、M5 未开始；HOST-05/2 秒/预算/保留/用量/重排“尚无执行代码” | 均已有代码；M5 另有 systemd、磁盘地板与保留逻辑 |
| A13 | `docs/implementation/contract-catalog.md:137` | 自有 Host 事件契约尚未实现 | `HostEvent` Schema、`session_events` 表、去重与保留均已实现；ZCode/Codex 适配器已产生事件 |
| A14 | `docs/architecture/data-ownership.md:15`、`open-questions.md:6`、`revision-conflict-proposal.md:95` | schema v5；“v2→v3 缺陷需先修复” | schema v8；缺陷已修复 |
| A15 | `test-and-acceptance-matrix.md:73`、`host-integration.md:30` | ZCode 缺助手最终答复事件，作为首版阻塞理由 | 第十九批已勘误：上游 Stop 携带 `last_assistant_message`，映射已实现；剩余缺口为 `session.ended` 与真实会话运行 |
| A16 | `test-and-acceptance-matrix.md:89,92` | HOST-01 真实宿主核验缺位；Bridge 进程、HTTP 传输与适配器证据缺位 | HOST-01 已核验 ZCode 3.17.2.9661 与 Codex 0.148.0；`sync-http`、`injection`、`host-adapters` contract 已存在 |

补充：`docs/implementation/decision-register.md` 末尾“保留的工程审查事项”仍写“当前未提交实现仅作为待审快照”，与现有提交历史不符；`docs/implementation/lifecycle-and-retention.md:5` 写 schema v7，实际为 v8。

## 4. B 类：文档互相矛盾

| 编号 | 冲突点 | 说明 |
|---|---|---|
| B1 | `docs/implementation/README.md:59-62` 与 `current-handoff.md:3,28,59-71` | 入口文档称“无提交、M3–M5 未开始、多项未实现”；交接文档称“WP0–WP9 可交付能力完成、97 项通过” |
| B2 | `current-handoff.md:38,46,48,70` | 同一文档内路由数与迁移版本不一致：OpenAPI “12 条路由”、HTTP “19 条”、正文“12 条路由”；实际 20 条路由、18 个 OpenAPI 操作、schema v8 |
| B3 | `current-handoff.md:51` | `packages/protocols/http/src/index.ts` 出现两次，行数分别标 ~170 与 ~75 |
| B4 | `current-handoff.md:57` | “预留目录（仅 README）”列出 `packages/bridge`、`packages/adapters/*`，与同一文档第 40-43 行“已实现”矛盾；实际 `packages/domain`、`packages/shared` 才是仅 README |
| B5 | `host-integration.md:3` 与同文档 `:20`、`:30`；`test-and-acceptance-matrix.md:73` 与 `:92` | 状态行称“实现未开始”，正文称注入控制器与适配器已实现；矩阵一处称“Bridge/Host 传递接线未实现”，另一处称适配器与注入已有 contract 证据 |

`requirements-and-scope.md:63` 与 `decision-register.md` 第十九批一致（Codex 通过、ZCode 阻塞缩小、DSH 阻塞），这一组是目前最准确的门槛描述。

## 5. C 类：组件已实现但未接入交付路径

| 编号 | 能力 | 代码事实 | 文档表述风险 |
|---|---|---|---|
| C1 | 不可变 View / ReadGrant / 预算 / Rerank | `ViewAssembler` 仅被 `tests/contract/view.test.ts` 与 `injection.test.ts` 实例化；`packages/protocols/http`、`apps/server`、`apps/bridge` 未引用 | `contract-catalog.md:91-96` 以“交付契约”口吻描述 View；`current-handoff.md:69` 列为已实现能力；矩阵 `:75` 已注明“Bridge/Host 传递接线未实现”，但其余文档未统一 |
| C2 | 注入控制器（HOST-04/05/06） | `InjectionController` 仅被测试引用；ZCode 适配器另有一条 `injectContext` 实现，按 2 秒截止拼接 Recall 文本，`viewId` 为 `recall-trace-<traceId>` | `host-integration.md:20` 称控制器已实现；实际运行路径未使用它，HOST-05“会话开始全量 + 关键事件增量”尚未成为活路径行为 |
| C3 | 保留清扫（RETENTION-01） | `SqliteCandidates.sweepRetention` 与 `SessionEventStore.sweepEvents` 已实现并有 retention contract；`grep` 显示 `sweepRetention` 无调用方，工作循环未调度 | `current-handoff.md:68`、矩阵 `:76` 称“已实现”；`configuration-deployment-upgrade.md:111` 又称“保留期与清理执行入口”未决。二者需统一为“逻辑已实现，调度入口未接” |
| C4 | 后台并发 2 | `workflow.ts:18` 的 `reviewConcurrency=2` 与网关信号量已实现并有测试 | `state-machines-and-transactions.md:164` 称“未实现后台并发 2”，与代码和矩阵 `:74` 冲突 |

`state-machines-and-transactions.md:163` 称退避为 `2 秒 × attempts`，与代码（指数、封顶 15 分钟）不符，属同一文档的过期偏差。

## 6. D 类：代码已交付、文档未收录

| 编号 | 缺失内容 | 代码/测试证据 |
|---|---|---|
| D1 | 8 条同步路由未写入 `contract-catalog.md` 的 HTTP 表（现仅 12 行） | `packages/protocols/http/src/index.ts:23-30`：`/v1/sync/{changes,snapshot,verify,watermark,grant,revoke,intents}` |
| D2 | 同步协议实体（`sync_log`、`sync_grants`、`sync_license_state`、分区摘要、意图受理）未进入 `contract-catalog.md` 与状态机文档 | `sync-source.ts`、`packages/bridge/src/*`、`tests/contract/sync-http.test.ts` |
| D3 | Bridge 进程入口与配对流程未进入 `module-and-dependency.md` 包表（仅在正文提及） | `apps/bridge/src/{main,http-channel}.ts`、`configuration-deployment-upgrade.md:55` |
| D4 | 适配器包与 `host-acceptance/` 未出现在包布局表；模型网关“单一路由”表述过期（已支持主/备路由） | `module-and-dependency.md:12,18`；`apps/server/src/config.ts:47-50` |

## 7. E 类：文档正确、代码确未完成

以下与 `current-handoff.md:73-78` 一致，属于实现缺口而非文档错误：

1. 保留清扫没有调度入口（C3 的后半部分），策略要求的 7+90 天与候选 30 天目前只能靠测试直接调用。
2. 交互优先/后台防饿死调度（TASK-02）未实现；写入仍全局串行，审核可并发 2。
3. Blob 垃圾回收、KNOWLEDGE-01 时间型复核执行入口未实现。
4. ZCode 缺专用 `session.ended` 事件，且两个宿主的真实桌面会话运行待执行。
5. DSH 缺 DeepSeek Harness Desktop 运行时，适配器无实现代码。
6. Codex 仍有三项观察：失败工具活体负载、MCP 工具会话内调用、正常退出 `SessionEnd` 语义。
7. 容量软/硬配额、TLS/远端访问、独立发布与版本策略未定。

另有一处文档未写、但实现中可观察到的边界：

- 默认 Recall 的扩展窗口上限为 1,000 条（`packages/core/application/src/index.ts:42`）；`contract-catalog.md:64` 已写“上限 1,000”，但未说明超过上限时的 `complete=false` 行为边界；`domain-and-data-ownership.md:51` 仍写“先取 100 条再过滤”的旧限制。

## 8. 未覆盖与不能确认

- 未重跑真实 Codex/ZCode 桌面会话；`work/codex-acceptance/` 的原始负载未在本轮重新核对。
- 未逐字段比对 15 份文档的全部 Schema 描述与 Zod 定义，只核对了错误码、路由、状态枚举、预算常量与迁移版本。
- 未验证生产部署（无 Linux 主机、无 TLS 终结）。
- 未运行 `pnpm.cmd` 包装器，统一用 `node` 直接执行，避免包装器退出码问题。

## 9. 建议修正顺序

1. P0（入口文档，一次性小提交）：`README.md`、`docs/implementation/README.md`、`current-handoff.md` 的版本、计数、测试结论与提交状态。
2. P1（规格状态行）：`bridge-and-sync.md`、`host-integration.md`、`requirements-and-scope.md`、`state-machines-and-transactions.md`、`contract-catalog.md`、`configuration-deployment-upgrade.md`、`test-and-acceptance-matrix.md`、`module-and-dependency.md`；同步移除 `docs/architecture` 中的 v5 与已修缺陷表述。
3. P2（契约补全）：把同步路由与同步实体的协议写入 `contract-catalog.md` 与状态机文档，避免路由计数再靠硬编码。
4. P3（接线决策，需单独确认）：View 与注入控制器接入适配器路径；保留清扫调度；随后在 `current-handoff.md` 记录新基线。

路由、迁移与测试数量建议不再在正文写死，改为引用 `httpRoutes`、迁移函数与测试输出，减少再次过期。

## 10. P0/P1 修正记录（2026-11-08）

按用户选择完成 P0/P1 文档事实修正，未改代码。已处理：

- 入口与交接：`README.md`、`docs/implementation/README.md`、`current-handoff.md`、`AGENTS.md`——schema v8、97/97 与 12/12、已修迁移缺陷、M3/M4/M5 状态、路由数（20 条 / OpenAPI 18 个操作）、删除重复行与错误的预留目录、View/注入/保留清扫的接线边界。
- 规格状态：`bridge-and-sync.md`、`host-integration.md`、`requirements-and-scope.md`、`state-machines-and-transactions.md`、`contract-catalog.md`、`configuration-deployment-upgrade.md`、`test-and-acceptance-matrix.md`、`module-and-dependency.md`。
- 架构与决策：`data-ownership.md`、`open-questions.md`、`revision-conflict-proposal.md`、`overview.md`、`decision-register.md`（第十九批勘误标记、传输层交付）、`lifecycle-and-retention.md`、`host-acceptance/zcode.md`。

仍未处理：Host 真实会话验收（ZCode `session.ended`、真实桌面会话，DSH 安装）。Rerank 已在服务端 View 交付默认接线（2026-11-09，歧义触发；Bridge 本地装配不调用模型）；TASK-02 交互优先、Blob 存储与回收、KNOWLEDGE-01 复核、C1/C2 View 交付与离线组装、STORAGE-02 配额、C3/E1 保留清扫调度与 P2 同步契约均已完成。第 3–7 节保留修正前证据，供追溯。
