# 测试与验收矩阵

状态：2026-11-09 修复后的最终命令与计数见 current-handoff.md。历史通过记录不替代当前 Host 行为验收。

## 1. 测试层次

| 层 | 命令 | 范围 |
|---|---|---|
| Unit | `pnpm.cmd test`（含 contract） | 契约校验、应用端口、纯逻辑 |
| Contract | 同上 | 治理库事务、Outbox、租约、Provider 参数、版本工作流 |
| E2E | `pnpm.cmd test:e2e` | 真实官方 Mnemon 二进制、真实 HTTP Server、独立 MCP 子进程、进程重启与崩溃 |
| 直接执行 | `node --test tests/unit/*.test.ts tests/contract/*.test.ts` | pnpm 包装器不返回退出码时使用 |

测试使用 `work/e2e/*` 随机隔离目录与专用 store；不接触用户默认 Mnemon 目录。真实二进制路径由环境提供，测试自行校验版本。

## 2. 覆盖清单

| 文件 | 覆盖 |
|---|---|
| `tests/unit/application.test.ts` | 严格输入、默认值、业务 Remember 不能绕过审核、默认 Recall 先过滤后分页与 complete 语义 |
| `tests/contract/governance.test.ts` | 候选与回执原子性、幂等、回执失败回滚、拒绝未知既有库 |
| `tests/contract/workflow.test.ts` | 自动审核入队原子性、模型缺失/异常转人工、重复与低复用拒绝、审核/Outbox 事务回滚、中断检查点、未知结果不重发、租约 fencing、amend、Provider 绑定、预写故障重试、退避封顶与 24 小时告警、v1 升级与备份 |
| `tests/contract/provider.test.ts` | 参数边界、未知版本、畸形 JSON、超时与输出溢出、串行队列恢复、skipped/replaced_id、截断查询不作缺失证明 |
| `tests/contract/catalog.test.ts` | 初始发布原子性、Revision 不可变与指针重开、哈希校验拒绝候选兜底、v2 回执回填 v3（含 v6 链路） |
| `tests/contract/openapi.test.ts` | OpenAPI 与实际路由逐条对应、错误码状态映射、逐路由真实请求 |
| `tests/contract/host-adapters.test.ts` | ZCode 钩子事件归一（五类可覆盖事件）、additionalContext 注入 HOST-06 截止、工作区 hooks/mcp 配置生成与合并、Codex config.toml 生成与注册状态探测、HOST-01 记录保持缺口可见（unverified 不得过 HOST-02 门） |
| `tests/contract/sync-http.test.ts` | HTTP 同步端点：操作员签发/撤销授权（普通令牌 401）、未配对/缺 host 头 401、changes/snapshot/verify/watermark/grant/intents 契约、HTTP 通道双 Bridge 快照+增量+本地召回、意图接收建候选不直写、撤销后意图隔离不提交、快照字节清单校验 |
| `tests/contract/injection.test.ts` | 会话开始全量注入与普通轮次沿用、增量触发与代际更新、2 秒截止显式不可用、迟到结果仅作新 View 交付、截止期间撤权拒绝、召回不可用不阻断普通任务、关键 Pinned 超限映射 budget_exceeded、适配器声明未核验项不通过 HOST-02 门槛 |
| `tests/contract/sync.test.ts` | 快照往返与清单校验（篡改拒绝）、双 Bridge 增量与重放跳过、离线意图重验为候选不直写、撤权立即生效且副本保留意图隔离、过期许可停止读取仍可排队、Cursor 落后压缩窗口触发重建、损坏副本不可读并重建、旧副本带数据时间可读、72 小时全量校验修复漂移、删除标记 90 天清理、sync_log 与发布同事务回滚 |
| `tests/contract/hardening.test.ts` | 并发提交完整性、租约 fencing 时钟漂移（伪造过期戳不能提交/续期）、300 候选规模保留清扫与重开、双真实进程共享治理库无损坏 |
| `tests/contract/retention.test.ts` | 事件归一与 (hostId,eventId) 去重冲突、默认选择规则、7+90 天按计划时点推进与迟到偏斜报告、重要/引用保护、候选正文 30 天清理与幂等回放、清理后 Revision 读取不变、活跃/冲突/证据候选豁免 |
| `tests/contract/view.test.ts` | Grant 有效/撤销/项目作用域拦截、View 深冻结与代际、关键 Pinned 超限异常、预算排除与 complete 标记、显式/歧义重排与失败保留确定性顺序、迟到重排不得回写、Token 保守估算、被替代/未知 Pinned 排除 |
| `tests/contract/model-gateway.test.ts` | 能力声明与路由拒绝、临时错误主 3 备 1 重试、参数/权限/能力/协议错误立即停止、步骤预算封顶重试、用量 unknown 语义与凭据不出记录、并发 2 信号量、文件用量账本 |
| `tests/contract/version-workflow.test.ts` | 占用阻止并发批准、发布回执失败回滚、关系重放不重发内容、内容结果未知先对账、基线变化停写、取消与不可逆 link 的边界、无审核记录时的冲突案件拦截 |
| `tests/e2e/native.test.ts` | 真实 Remember、去重、HTTP 与 stdio MCP Recall |
| `tests/e2e/cli-behavior.test.ts` | 特殊文本、Link、Forget、Store 隔离、进程持久化、响应丢失对账 |
| `tests/e2e/candidate-lifecycle.test.ts` | HTTP/MCP 跨进程幂等提交、真实重启恢复、未经审核不进入正式记忆 |
| `tests/e2e/reliable-memory.test.ts` | 自动与人工审核、正式写入、operator 权限、真实崩溃恢复、人工重试 |
| `tests/e2e/supersedes-behavior.test.ts` | 原生 supersedes 重放、related 非方向性、Recall 标记保留 |
| `tests/e2e/version-publication.test.ts` | 逻辑 Revision、旧基线拒绝、独立 Supersedes、同内容不同范围并存 |
| `tests/e2e/version-recovery.test.ts` | 版本操作中断后的恢复路径 |
| `tests/e2e/conflict-resolution.test.ts` | keep/uncertain/revise/supersede/coexist 五种裁定与历史保留 |
| `tests/support/server.ts`、`crash-worker.ts`、`crash-version-worker.ts` | 真实子进程启动与故障注入，仅测试使用 |

## 3. 需求到证据

| 需求 | 证据 | 状态 |
|---|---|---|
| 严格契约、未知字段拒绝 | unit + contract | 已验证 |
| 候选与提交回执原子 | governance contract | 已验证 |
| 同键相同输入幂等、不同输入冲突 | governance + e2e candidate-lifecycle | 已验证 |
| 审核不可绕过、approved 不能由输入伪造 | unit + workflow contract | 已验证 |
| 模型缺失/异常不默认通过 | workflow contract | 已验证 |
| 审核与 Task/Outbox 同事务 | workflow contract | 已验证 |
| 写入前检查点与未知结果只对账 | workflow + version-workflow contract；reliable-memory e2e | 已验证 |
| 租约 fencing、过期 Worker 不能提交 | workflow contract | 已验证 |
| Provider 版本固定与错误映射 | provider contract；native e2e | 已验证 |
| 精确核对、截断不作缺失证明 | provider contract | 已验证 |
| skipped 使用 replaced_id | provider contract；cli e2e | 已验证 |
| 读取哈希校验、不回退候选正文 | catalog contract | 已验证 |
| v1→v3 迁移、快照、回填 | workflow contract；catalog contract | 已验证（夹具数据） |
| 版本 CAS、占用、前向恢复 | version-workflow contract；version-publication e2e | 已验证（单机顺序场景） |
| Supersedes 方向与重放 | supersedes e2e；version-workflow contract | 已验证 |
| 冲突五种裁定 | conflict-resolution e2e | 已验证（顺序场景） |
| 版本取消边界 | version-workflow contract | 已验证 |
| 人工 operator 令牌隔离 | reliable-memory e2e | 已验证 |
| OpenAPI 与实际路由逐条对应、错误码状态映射 | openapi contract | 已验证 |
| 非模型可恢复故障退避封顶 15 分钟、不自动放弃、24 小时告警 | workflow contract | 已验证 |
| 真实崩溃后不重复写入 | reliable-memory e2e | 已验证 |
| 默认 Recall 按发布目录过滤、先过滤后分页 | unit application.test（稀疏可见集合扩展窗口） | 已验证 |
| 并发多候选提交、多进程共享治理库、同逻辑记忆版本竞争 | hardening contract（50 并发提交 + 双进程各 40 候选 + 双进程版本竞争恰一占用） | 已验证 |
| Bridge、同步、离线许可 | sync contract（协议语义，双 Bridge）+ sync-http contract（HTTP 传输端点与通道） | 已验证（库层 + HTTP 传输）；Bridge 进程冒烟通过（启动→配对→快照同步）；Host 适配器已实现（WP7），验收状态见下一行 |
| Host 自动注入与事件采集 | runtime-memory E2E + injection/host-adapters contract | ZCode hook 实进程链路已验证；DSH、ChatGPT 桌面和 ZCode 完整真实会话仍未验收 |
| 模型预算、路由、用量 | model-gateway contract（60 秒/5 分钟/3+1、并发 2、用量记录、失败分类） | 已验证（网关层）；交互优先调度未实现 |
| View/ReadGrant/预算/Rerank（VIEW-01/02、RECALL-02） | view contract（权限/版本/预算交付前检查、4096 兜底、Pinned 超限异常、重排验证）+ HTTP `/v1/view` + Bridge `/v1/inject`（bridge-injection contract）+ bridge-offline-view contract；服务端 View 交付默认接线网关重排 | 已验证（应用层、HTTP 交付、Bridge 会话绑定与离线本地组装）；Bridge 本地装配不调用模型 |
| 保留期、清理 | retention contract（事件 7+90 天、候选正文 30 天、受保护证据）+ workflow contract（租约内按间隔调度、失败不阻断 tick） | 逻辑与调度已验证；Blob GC 未实现 |
| 时间型复核（KNOWLEDGE-01） | review-schedule contract（按知识类型 90/180 天排期、到期只排队、完成重排、未知记忆拒绝） | 已验证（治理库层）；到期队列 API 见 `/v1/reviews/due` |
| Blob 存储与回收 | blob-store contract（大正文内容寻址、读回校验、随正文清理删除、未引用对象宽限回收） | 已验证（候选正文）；正式记忆正文仍由 Mnemon 管理 |
| TASK-02 交互优先 | workflow contract（已批准写入在长模型调用完成前排空、审核随后完成、租约内无饿死） | 已验证（单进程租约）；高吞吐写入仍串行 |
| 容量配额（STORAGE-02） | quota contract（硬配额拒绝新候选、软配额放行并报告、软硬顺序校验）+ GET `/v1/storage` | 已验证（治理库与 WAL 计量）；真实规模与清理联动未验证 |

## 4. 验收规则

- 按改动范围选择验证：普通改动跑相关测试与 typecheck/build；跨模块或状态机改动跑对应 contract 与 e2e；架构级改动才做全量回归。
- 不得把 mock 成功当作跨系统可靠性证据；Provider 行为必须用真实二进制验证。
- 不得把未执行、失败或被跳过的检查写成通过。
- E2E 必须使用隔离目录与专用 Store；发现触碰默认目录立即停止。
- 故障注入只允许存在于 `tests/support/`，不进入生产代码。
- 新能力先补契约与失败场景，再补成功路径；只有成功路径的测试不能支撑验收。

## 5. 当前证据缺口

- Cursor 失效有 sync contract 证据；当前三个目标 Host 的真实会话门槛尚未全部满足。
- 没有从真实用户规模数据执行的迁移演练。
- 没有模型质量评估，只有协议与分流验证。
- Bridge 库层、共享多 Host 进程与 HTTP/MCP/hook 链路有自动化证据；历史 Codex 会话不计当前目标 Host 验收。
- 没有长期运行下的租约、心跳与时钟漂移测试；保留清扫的调度已由 workflow contract 覆盖，但长期间隔偏差与真实数据规模未验证。

## 运行时补齐的行为门槛（2026-11-09）

| 行为 | 证据 | 范围 |
|---|---|---|
| 新会话不带 query 也加载持久 Pinned | runtime contract + runtime-memory E2E | 已程序化验证 |
| “继续”沿用先前任务 | 同上，真实 hook 子进程和 MCP proxy | 已程序化验证 |
| 用户素材 → Gateway → 带证据候选，未审核不正式写入 | runtime contract | 已验证候选边界与保护引用 |
| 无模型/不记忆请求/撤权/非法引用不发布 | runtime contract | 已验证 |
| 权限先于重排与正式读取，按范围快照/增量 | runtime contract | 已验证 |
| 共享 Bridge 双 Host 同 sessionId 隔离、断网本地投影 | runtime-memory E2E | 已验证进程链路 |
| 快照并发高水位、小漂移定向修复、全局撤权后新授权 | sync contract | 已验证 |
| 桌面模型实际遵循注入和主动记录 | ZCode/DSH/ChatGPT 桌面真实会话 | 尚未验收 |

当前目标 Host 的状态以 host-integration.md 为准；上文历史 Codex CLI 记录不属于当前验收门槛。

ChatGPT 本地协议补充：tests/contract/chatgpt-adapter.test.ts 验证云模式拒绝、事件结构及未知工具输出不推定成功；runtime-memory E2E 增加 ChatGPT hook 子进程注入与 SessionEnd 关闭验证。两者均不等于真实桌面会话。

## DSH 界面（2026-11-09）

| 行为 | 证据 | 范围 |
|---|---|---|
| Bridge UI API 只读、独立令牌、拒绝 Origin、GET-only、非法参数 400 | bridge-ui contract（真实 HTTP） | 已验证 |
| UI 读取按 grant 过滤；作用域/项目只能收窄；未配对/撤权/过期/越权显式返回原因 | bridge-ui contract | 已验证 |
| 历史版本正文读取（哈希校验、缺失给原因） | bridge-ui + dsh-ui-host contract | 已验证 |
| Host RPC 五端点、请求校验先于读取、版本与响应校验、错误码透传 | dsh-ui-host contract（真实 UI HTTP 服务） | 已验证 |
| 客户端包结构、Slot 注册、失败回滚、SSR 外壳渲染 | dsh-ui-client contract（vm 中执行 esbuild 产物） | 已验证 |
| 开发热重载：检出判定、产物过滤、去抖、宿主结果如实上报 | dsh-ui-hot-reload unit | 已验证（桩宿主） |
| 真实 DSH 桌面加载插件、侧栏点击与热重载生效 | 需已安装 CLI / profile 变更与重启 | 未验收 |

