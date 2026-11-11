# 当前状态

最后更新：2026-11-10。本文件的测试数字只来自当日实际执行。

## 1. 本轮验证结果

环境：Windows 10.0.19045 x64、Node.js 24.22.1、pnpm 11.18.0、TypeScript 7.0.2。

| 检查 | 实际命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | 通过（退出码 0） |
| 构建 | `node node_modules/typescript/bin/tsc` | 通过（退出码 0，产物在 `dist/`） |
| Unit + Contract | `node --test tests/unit/*.test.ts tests/contract/*.test.ts` | 261 项全部通过（261 pass / 0 fail）。数量较上一轮减少是因为移除了模型网关及其 6 项测试、并合并了若干「模型自动审核」用例；含同步规则 14、远端存储 11、远端 HTTP 8、客户端 6、本机账本 5、协调器 11、应用流水线 11、记忆存储 6、同步服务 7、Provider 8、View 13、渲染顺序 5、DSH 注入渲染 3、DSH 页签端点 4、DSH 服务阶段 7、规则与档案 5、本地写入 7、项目头 4、编辑鉴权 3、连接探测 8、宿主轮次预算 4、实例保护 8 |
| 客户端类型 | `node node_modules/typescript/bin/tsc -p plugins/dsh-mnemo-weave/tsconfig.client.json` | 通过（退出码 0） |
| DSH 插件构建 | `node plugins/dsh-mnemo-weave/build.mjs`、`build-client.mjs` | 通过：`lib/ui/index.js`（esbuild 自包含）、`lib/client.js`（41 KiB） |
| 计划任务注册（真机，2026-11-10） | 提权后 `.\scripts\install-local-server-task.ps1 register -ServerDir D:\projects\MnemoWeave` | 通过：任务 `MnemoWeave Local Server` 注册成功，计划类型「登陆时」，`MultipleInstances=0`（IgnoreNew）、无执行时限、3 次重启、`RunLevel` 最小权限 |
| 任务冷启动（真机） | 停止任务后用 `ensureServer` 走生产路径（`tests/support/ensure-server-live.ts`） | 通过：连接被拒 → 唤醒任务 → **763 ms** 转为 `ready`，未注入 transport 或 task runner |
| 并发只起一个（真机） | 三次并发 `schtasks /run` | 通过：三次均提示「正在运行」，最终监听 1 个、PID 未变（20780），无重复实例 |
| 令牌错配（真机） | 用错误令牌调 `ensureServer` | 通过：`{state:'failed', reason:'unauthorized', taskRun:false}`，Server PID 前后一致（23980），原进程保留 |
| 实例保护（真机） | 端口已有本服务时启动第二个 `main.js` | 通过：`{"event":"already_running"}` 退出 0；`remove` 非提权时正确报 `Access is denied` 并退出 1 |
| 健康端点标识（真机） | `GET /health/live`（带/不带令牌）、`/health/ready` | 通过：存活返回 `{live,service:'mnemoweave',protocol:1}`；无令牌 401；**401 响应体同样带 `service` 与 `protocol`**；ready 返回 `0.2.13` |
| E2E | `node --test tests/e2e/*.test.ts` | 25 项全部通过（25 pass / 0 fail），含同步链路 3 项、编辑链路 1 项、审核发布入同步 1 项、两台机器双向 1 项、三台机器收敛 1 项、断网排队与恢复 2 项、快照重建 2 项、插件 Host 半 1 项；二进制由 `tests/e2e/mnemon-binary.ts` 解析。本轮连接改动只影响 `/health/live` 响应体与插件探测，按最小范围复跑了 `native.test.ts` 与 `dsh-host-half.test.ts`（各约 2 秒，均通过），未整套重跑 |
| 同步实施前置门 | `mnemon --data-dir work/verify/mn-b --store recon` 上的 remember / show / log / recall / link / related / forget | 通过，结论见 1.1 |
| 远端同步 Server 冒烟 | 构建后 `node dist/apps/sync-server/src/main.js`（端口 4399，隔离状态目录） | 通过：带令牌 `/v1/sync/health` 返回 `{ready,protocol:1}`，`/v1/sync/scopes` 回显授权，无令牌返回 401，进程正常监听与退出 |

### 1.1 同步实施前置门结果（2026-11-10）

隔离 store：`work/verify/mn-a`、`work/verify/mn-b`（不接触用户默认记忆目录）。

| 项目 | 实际结果 |
|---|---|
| 写入定位 | `recall --basic --limit 200 -- <正文>` 返回完整记录，含 `id` 与 `source`；用 `--source mnemoweave:<changeId>:<version>` 可唯一确定本次写入。`log` 只显示 8 位 ID 前缀与正文，不足以定位；`receipt` 对标识符做哈希，无法定位 |
| `--no-diff` 的语义 | 相同正文、近似正文（差一个字）各写一次，得到 3 个不同 `id`。`--no-diff` 不提供幂等，重建只能靠 `source` 定位 |
| 关系写入与读回 | `link <新> <旧> --type supersedes --meta <json>` 返回 `status: linked` 与 ack；`related <新> --edge supersedes --depth 1` 读回对端与 `via_edge_type`。ack 的 metadata 附带 `created_by: "claude"`，是 Provider 侧固定值，不由调用方控制 |
| `forget` 的实际表现 | `show` 返回 `sql: no rows in result set`，`recall` 不再返回该条；**指向它的 supersedes 边同时从 `related` 消失**（`edge_count` 6 → 2）。因此撤回不得调用 `forget`，物理清理会切断历史关系 |
| 删除与不存在的区分 | 两者在 `show` 上返回同一条错误，无法区分。恢复流程不能靠错误文本判断，只能靠 `source` 定位与 `status` 汇总 |
| 未覆盖 | 8000 字节上限正文下 `recall --basic` 的匹配行为未验证 |

上表 E2E 一行此前长期记为「未执行」，原因是 Windows 上 PATH 里的 `mnemon` 是 npm 的 `.cmd` 包装，`execFile` 不带 shell 无法启动它（`spawn mnemon ENOENT`），Provider 会把它报成 `PROVIDER_UNAVAILABLE`。真实可执行文件是 npm 包内的 `@mnemon-dev/mnemon-win32-x64/bin/mnemon.exe`；本轮新增 `tests/e2e/mnemon-binary.ts` 统一解析（依次尝试 `MNEMON_BINARY`、`work/tools/mnemon/mnemon.exe`、npm 全局包路径），每个候选都用 `--version` 探测，全部不可用时报「环境缺失」而不是静默通过。E2E 套件因此首次完整通过。

`pnpm.cmd` 包装器在本机会先尝试重装依赖，无交互终端时报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`；因此上表统一用直接 Node 命令，包装器退出码不能当作检查通过。

原始日志：`work/client-migration-tests.log`（忽略目录，不提交）。

### 1.2 本轮修复（8 项 P1）

每项都先复现、再修、再用测试锁住；真实 Provider 行为用 Mnemon 0.2.13 CLI 实测。

| 发现 | 根因 | 修复落点 | 锁住它的检查 |
|---|---|---|---|
| 服务令牌可直接编辑正式记忆 | `PATCH /v1/memories/{id}` 通过通用鉴权后直接进入编辑，不要求 `x-mnemoweave-host` | `packages/protocols/http/src/index.ts` | `tests/contract/edit-authorization.test.ts`（无 Host 401 且不进应用层、带 Host 通过、operator 不需 Host、空 Host 无效） |
| 快照失败留下已前移的游标 | `captureSnapshot` 先 `resetScope` + `setCursor`，再逐条 apply | `packages/core/application/src/sync.ts`：先全部 apply；有失败则保留原游标并返回它；全部成功后才 `resetScope` / `setCursor` | `tests/unit/sync-coordinator.test.ts`（游标不动、inbox 行保留、重试成功后才提交切点） |
| 同步编辑一次追加两条本机 Revision | apply 流水线已写一条 Revision，`editMemory` 又调 `publishDirectEdit` 追加第二条；同时周期性刷新与显式 `applyScope` 会并发应用同一 inbox 行 | `apps/server/src/config.ts`（同步路径复用 apply 已产生的 Revision，只补记 `local-user` 审核决定）、`catalog.ts`（`currentRevisionFor` / `recordEditDecision`）、`sync.ts`（按 scope/seq 的 `claimRow`） | `tests/e2e/edit-through-sync.test.ts` 断言共 3 个 Revision 且父子链正确；`tests/unit/sync-coordinator.test.ts` 并发用例 |
| 第 101 条 outbox 起写入误报 | `submitLocalChange` 用默认分页 `outbox()` 查找，SQLite 只返回最早 100 条且含已确认记录 | `sync.ts` 端口新增 `outboxForEntry` / `outboxChange` / `inboxEntry` / `inboxChange`；`sync-ledger.ts` 按 entry / changeId 直接查询 | `tests/unit/local-write.test.ts`（150 条历史后仍能确认；列表之外的未确认项仍阻塞）；已验证旧实现报 `INTERNAL` |
| 审核发布未接入共享同步 | `catalog.setSyncHook` 全仓无调用方，Worker 发布只写本机发布目录 | `governance/src/index.ts` 新增 `setPublishListener`，`finish()` 提交事务后通知；`apps/server/src/config.ts` 收到后经 outbox 入队并推送一次 | `tests/e2e/publish-through-sync.test.ts`（真实 Worker + 真实远端）；已验证移除监听器后该用例失败 |
| 准则与档案入队前即本机可见 | 先 `upsertRule` / `upsertArchive`，再提交远端 | `config.ts`：`submitLocal` 改为接受 `applyLocal` 回调，只在确认/排队/结果未知后落本机；冲突或 `SYNC_QUEUED` 时不写 | 顺序由 `submitLocal` 单一入口保证，既有准则与档案用例覆盖 |
| 同步中断后重复写 Mnemon | apply 只查本机 `formal_map`，而 `remember --no-diff` 不提供幂等 | `sync-apply.ts` 先按 `mnemoweave:<changeId>:<version>` 定位已写入记录；`providers/mnemon` 新增 `findBySource`（`recall --basic --source`，实测返回并精确过滤 `source`）；正文不一致转 `needs_review` | `tests/unit/sync-apply.test.ts`（重放复用已有记录、正文不符转复核） |
| 干净检出无法安装依赖 | 锁文件含已删除的 `apps/bridge` / `packages/bridge`；ChatGPT 与 ZCode 声明不存在的 `@mnemoweave/bridge`；`apps/server` 漏声明 `@mnemoweave/sync-client`；`apps/sync-server` 与 `protocols/http` 有未使用依赖 | 六个 `package.json` 改正后重算 `pnpm-lock.yaml` | `pnpm install --frozen-lockfile --ignore-scripts` 从零安装通过 |

另修正两处与本轮改动直接相关的时序问题：`SyncService.stop()` 现在等待在途趟次结束再关闭治理库（否则最后一次 apply 报 `database is not open`）；`syncRefresh()` 与启动趟次重叠时按既有语义返回 `skipped`，E2E 改为重试到真正完成一趟，而不是把 `skipped` 当成完成。

## 2. 已实现能力

- 三机拓扑（已实现）：宿主插件通过 `packages/client` 直连本机 Server；本机 Server 按 `MNEMOWEAVE_SYNC_*` 与远端同步 Server 交换变更，写入由远端确认版本，注入与召回走本机；无本地代理进程，同步不经过宿主。单机不配置 `MNEMOWEAVE_SYNC_*` 时退化为纯本机模式。
- 候选提交（HTTP/MCP 同契约）、规则 + 模型语义审核、人工例外处理、Outbox 与可靠写入、Provider 内容核对与回执追溯；进程中断后可对账恢复。
- Revision 不可变、CAS 更新、业务占用、前向恢复；冲突案件与裁定；版本操作取消；到期复核。
- 授权范围内召回与 View 组装，注入预算 4096 token、2 秒截止、迟到结果不覆盖已结束回合。
- 运行时记忆：持久化 Pinned、项目登记、会话工作上下文与任务投影、事件提炼候选与审核边界。
- 记忆列表、详情与**用户直接编辑**（追加 Revision、supersedes 旧记忆、记录为 operator 审核决定）。
- 治理库 schema **v14**（每步迁移先 `VACUUM INTO` 快照）：v11 新增同步与三类记忆八表并删除 v8 遗留的 `sync_log` / `sync_grants` / `sync_license_state`；v12 新增 `entry_versions` 记录已确认版本并从 `formal_map` 回填；v13 新增 `share_outbox`；v14 给 `catalog_revisions` 增加知识类型/分类/重要度/标签/实体五列。
- 本机同步账本：`SqliteSyncLedger`——按范围游标只前进不回退、outbox 状态机、inbox 幂等接收与按序应用、`progress()` 供游标计算，4 项契约用例覆盖。
- DSH 记忆界面插件：直连 Server，可查看与编辑；状态行显示本宿主最近一次注入（准则/记忆条数与 token，预算省略时标注）。
- 同步契约与纯规则（P0）：`packages/core/contracts/src/sync.ts`（信息模型、拉取页、快照、范围授权、同步错误码）与 `packages/core/application/src/sync.ts`（按范围游标、缺口即停、保留地板触发快照、编辑基准不补全、失败分类），13 项单元用例覆盖。
- 远端权威库（P1 首项）：`packages/infrastructure/sync-store`——设备鉴权（令牌哈希、撤销）、按范围授权、变更登记（版本 + 范围序号 + 幂等凭证）、增量拉取、单事务快照、Revision 链，8 项契约用例覆盖。
- 远端同步服务（P1 完成）：`packages/protocols/sync-http` 提供七个端点（含变更结果查询）与统一的错误映射（冲突 409、越权范围 403、设备撤销 401、拒绝 `Origin`，health 也要求有效设备令牌），`apps/sync-server` 提供组合根、`enroll` / `revoke` 设备签发 CLI 与 systemd 单元；8 项契约用例覆盖，构建产物冒烟通过（health 200 / scopes 回显 / 无令牌 401）。
- 本机同步客户端：`packages/infrastructure/sync-client`——超时、错误码映射、`VERSION_CONFLICT` 直接携带远端当前条目、连接被拒与已发出超时的区分（`SyncTransportError.reachedRemote`）、结果查询，6 项契约用例覆盖。
- 本机同步协调器：`SyncCoordinator`——outbox 刷写（确认后回灌 inbox）、`SYNC_OUTCOME_UNKNOWN` 按 receipt 收敛、拉取入 inbox、按序应用并在 `needs_review` 处阻塞游标；远端新增 `GET /v1/sync/receipts/{changeId}`，存储 / HTTP / 客户端三处打通，6 项单元用例覆盖。
- 同步应用流水线：`applyInboxEntry` 先校验正文哈希与长度，再按种类落库；正式记忆按 `remember → link supersedes → show 核对 → formal_map` 顺序执行，读回不一致即 `needs_review` 且不移动映射；9 项单元用例覆盖。
- 本机记忆存储：`SqliteMemoryStore`（`runtime_rules`、`project_archives`、`formal_map`），准则按范围过滤且停用/撤回不可见，档案保留验证状态，3 项契约用例覆盖。
- 同步服务：`SyncService` 一趟内 resolve → flush → 每个可读范围 pull + apply，失败按范围隔离并写入 `last_error`，重叠趟次直接跳过；5 项单元用例覆盖。
- 本机 Server 接线：`configure()` 按 `MNEMOWEAVE_SYNC_URL` / `_DEVICE_ID` / `_TOKEN`（三者必须同时给出，否则启动即拒绝）装配客户端、协调器与服务，`GET /v1/sync/status` 与 `POST /v1/sync/refresh` 只接受 operator 令牌；关闭时先停定时器。构建产物冒烟通过：远端 enroll 后本机读到 `project:alpha`、`refresh` 返回 `pulled 0 applied 0`、服务令牌请求 `401`。
- Provider 跨机接口：`syncRemember`（`--no-diff`，源为 `mnemoweave:<changeId>:<version>`）、`forget`、`related`，2 项契约用例覆盖参数构造与输入校验。
- 准则注入：`ViewAssembler` 从本机读取全局与当前项目准则，作为独立 `rules` 块返回；准则按完整条目交付，单独超过 1024 token 时整块不注入并置 `rulesBudget.exceeded`，不截断任何一条；3 项契约用例覆盖。
- 注入可见性：每轮写入 `runtime_injections`；`GET /v1/injections/latest` 对 operator 返回全局最近一条，对带 Host 头的宿主令牌只返回该宿主自己的记录（可再用 `sessionId` 限定），没有记录时 404，宿主令牌缺 Host 头返回 401。DSH 页面在状态行显示「最近注入：准则 N 条 · 记忆 M 条 · 约 T token」，预算省略时标注并转为警示色。
- 准则与档案写入：`POST /v1/rules`、`PATCH /v1/rules/{ruleId}`、`GET /v1/rules`、`POST /v1/archives` 只接受 operator 令牌；保存时按「全局 + 该项目」计算适用准则，超出 1024 token 返回 409 `RULE_BUDGET_EXCEEDED` 且不落截断版本，编辑追加版本；5 项单元用例覆盖规划逻辑。
- 构建产物冒烟（`work/smoke-rules.sh`）：新建全局与项目准则、超预算被拒（409）、停用后版本递增、带 `projectId` 的 `/v1/view` 注入 2 条准则、停用全局后注入 1 条、`/v1/injections/latest` 同步反映 `rulesInjected`、服务令牌访问准则端点 401、缺 `projectId` 的项目准则 400。冒烟过程修复了一处真实缺陷：`MemoryRuntime.view` 未把 `projectId` 传给装配器，导致项目准则从未被注入。
- 编辑基准版本：`GET /v1/memories` 与 `GET /v1/memories/{id}` 返回 `entryVersion`（`formal_map` 中该条目的最高版本，未同步过为 0）；`PATCH` 必填该值，不一致返回 409 `VERSION_CONFLICT` 且不写 Provider；成功后新版本为当前 + 1 并写入 `formal_map`。DSH 插件的编辑表单改为携带详情里的 `entryVersion`，Host RPC 也做同名校验。
- 同步链路 E2E（`tests/e2e/sync-roundtrip.test.ts`，真实 Mnemon CLI）：远端登记 → 本机 `pullScope` 只入 inbox 不动游标 → `applyScope` 写 Provider 并记 `formal_map` → 游标推进；第二版写入后用 `related --edge supersedes` 读回指向第一版；撤回后 `show` 失败、`formal_map` 留下墓碑。3 项用例覆盖。
- 本地写入接入 outbox：schema v12 新增 `entry_versions`（已确认版本，并从 `formal_map` 回填），准则与档案写入「先落本机 → 按已确认版本入队 → 推送一次」，远端确认后由同一应用流水线写入确认版本；同一 entry 存在未确认变更时再次写入返回 409 `SYNC_QUEUED`，不会重复入队。4 项单元用例覆盖。
- 准则同步冒烟（`work/smoke-rule-sync.sh`，构建产物 + 两进程）：本机 `POST /v1/rules` 返回 201 后，远端 `GET /v1/sync/changes` 已有该条目 `version 1`；`PATCH` 后远端出现 `version 2`；两次 `POST /v1/sync/refresh` 应用后本机游标 2、待推送 0、待应用 0。
- 编辑接入远端确认：启用同步时 `PATCH /v1/memories/{id}` 先按 `entryVersion` 提交远端（`planEditChange` 生成 `create`/`update` 与 supersedes 关系），确认后经应用流水线写本机 Mnemon，再用远端分配的版本号更新发布目录与 `entry_versions`；未确认不写 Provider。未到达远端返回 409 `SYNC_QUEUED`，结果未知返回 409 `SYNC_OUTCOME_UNKNOWN`，基准过期仍是 `VERSION_CONFLICT`。
- 编辑链路 E2E（`tests/e2e/edit-through-sync.test.ts`，真实配置与真实 CLI）：用候选路径发布一条正式记忆 → `PATCH /v1/memories/{id}` 以 `entryVersion 0` 编辑，远端收到 `create` v1、本机 Provider 写入、发布目录更新为 v1 → 过期基准 `entryVersion 0` 返回 `VERSION_CONFLICT` 且远端无新变更 → 以 v1 再编辑，远端出现 `update` v2、列表正文与版本同步。用例同时暴露并修复了一处真实缺陷：编辑请求的 `provenance.limitations` 传空串，违反 `min(1)`，此前每次 `PATCH` 都会返回 `INVALID_INPUT`。
- 项目档案检索：`GET /v1/archives?projectId=`（operator）按项目返回档案，默认过滤已撤回条目、`includeWithdrawn=true` 时一并返回；缺 `projectId` 返回 400，服务令牌返回 401。构建产物冒烟验证了创建、读取、`includeWithdrawn`、其他项目为空与两类拒绝。
- 两台机器双向（`tests/e2e/two-machine-sync.test.ts`）：两个独立的 `configure()` 实例各自持有状态目录与 Mnemon，共用同一远端范围。A 编辑 → 远端 `create` v1；B 刷新后把该记忆镜像进本机 Provider 与发布目录，可列出（`entryVersion 1`）并以 1 为基准编辑 → 远端 `update` v2；A 再刷新后读到 v2 正文与版本。两侧 `sync/status` 均为待推送 0。
- 快照重建：拉取发现游标低于保留地板时改取快照（`captureSnapshot`），把 `asOfSeq` 设为新游标、删除被覆盖的 inbox 行，并按 Revision 从旧到新重放，supersedes 边由前一版本的本地映射补齐；任一条失败记为 `SNAPSHOT_APPLY_INCOMPLETE`。`tests/e2e/snapshot-rebuild.test.ts` 用真实 CLI 验证：删除远端首条变更制造地板后，本机重建出两版记忆与 supersedes 边，游标为 2。
- 变更日志清理（`SyncStore.prune`）：按范围删除前缀（时间过期序号与 `head - 50000` 取较大者），不会在序号中留下空洞；去重凭证按 365 天单独清理。远端同步 Server 启动时清理一次，此后按 `MNEMOWEAVE_SYNC_PRUNE_INTERVAL_MS`（默认 6 小时，0 关闭周期）执行，日志行 `{"event":"prune",...}`。构建产物冒烟确认启动即清理并随后开始监听。
- 项目声明头（`x-mnemoweave-project`）：请求体省略 `projectId` 时由该头补齐，相同值放行，冲突返回 400 `INVALID_INPUT`，超过 200 字符拒绝；作用于 `/v1/view`、`/v1/inject`、`/v1/runtime/context`、`/v1/events`。`packages/client` 新增 `projectId` 选项并从 `MNEMOWEAVE_PROJECT_ID` 读取，随每个请求发送。4 项契约用例覆盖。
- 三台机器收敛（`tests/e2e/three-machine-sync.test.ts`）：A 写入 v1，B 与 C 刷新后都看到 v1；B、C 同时以 v1 为基准写入，B 得 v2、C 收到 `VERSION_CONFLICT`；C 重新拉取后以 v2 写入 v3；A、B 再刷新后三台都读到 v3 与同一 `memoryId`。远端只有 `create v1 → update v2 → update v3`，每台机器为三个版本各保留一个不同的 Provider 映射，`entryVersion` 均为 3。
- 断网行为（`tests/e2e/offline-recovery.test.ts`，2 项）：远端从未可达时编辑返回 409 `SYNC_QUEUED`，发布目录保持原版本，待推送计数为 1；远端恢复后一次刷新即推送并应用。已有连接后远端消失时返回 `SYNC_QUEUED` 或 `SYNC_OUTCOME_UNKNOWN`（取决于连接是否已建立），该变更在 ledger 里保留为待确认，恢复后由 `changeId` 回执判定「未到达」并重新排队，最终收敛到 v2。
- 同步状态字段：`/v1/sync/status` 增加 `unknown`（待确认条数），`pending` 与 `unknown` 现在按范围过滤；范围列表合并已见授权与 outbox 中出现的范围，因此远端不可达时待推送项仍可见。
- 插件 Host 半（`tests/e2e/dsh-host-half.test.ts`）：用真实 `MemoryClient`、真实 `MemorySource`、真实 RPC 处理器与真实 Server 走一遍列表 → 详情 → 编辑 → 过期基准 `VERSION_CONFLICT` → 首次注入无记录 → 一次 View 后读到注入报告。桌面上的插件条目 `mnemo-weave` 与 `mnemo-weave-ui` 均为 `active`，重建后的 `lib/` 已由 HMR 载入。
- 序号与清理独立（远端库 v2）：`sync_scope_heads` 保存每个范围的序号高水位，`nextSeq` 从它递增而不是从「现存最大 seq」推断。此前清空某范围的日志后序号会从 1 重新发放，游标停在旧值的设备将永久卡在缺口；现在继续从下一个序号发放，保留地板按 `head + 1` 返回，落后设备判定为需要快照。契约测试覆盖：清空后新变更 `seq 4`、游标 3 的设备正常续拉、游标 0 的设备走快照、快照 `asOfSeq` 为 4。
- 整范围清理后的恢复（`tests/e2e/snapshot-rebuild.test.ts` 第 2 项）：普通 `prune` 删除全部变更行后，游标 0 的设备 `pullScope` 判定需要快照，`captureSnapshot` 以高水位 2 为切点重放两版记忆并记 `formal_map`；随后新变更取得 `seq 3`，增量拉取与应用继续推进到游标 3。
- 保留参数可配置：远端 `MNEMOWEAVE_SYNC_RETENTION_DAYS` / `_MAX_CHANGES` / `_RECEIPT_DAYS`（默认 90 / 50000 / 365），小于 1 时启动报 `CONFIG_INVALID`；构建产物冒烟验证了合法值启动与 `RETENTION_DAYS=0` 被拒。
- 未登记记忆的可见性：Mnemon 中存在、但本机从未发布的 insight 以前会被静默丢弃；现在 `MemoryApplication.recallDetailed` 收集这类 Provider id，View 把它们记为 `excluded: [{reason: 'unregistered'}]`，`/v1/recall` 的返回结构保持不变。契约用例覆盖「陌生 Provider id 被排除、已登记记忆正常交付」。
- DSH 界面真实点击（2026-11-10）：本机 Server 按插件配置启动在 `127.0.0.1:4317`（令牌与 desktop profile 一致，预置 2 条记忆与 1 条全局准则），在 DSH 记忆页打开列表、打开项目记忆并编辑保存。服务端核对结果：列表正文变为页面写入的文字、`entryVersion` 由 1 升到 2、`formal_map` 新增 v2 映射、发布目录产生第 3 个 Revision、Mnemon 中该版本正文与页面内容逐字一致、`related --edge supersedes` 指向前一版。
- DSH 提示注入（2026-11-10）：新建会话后 Server 记录到 `hostId dsh`、会话 id 为新会话的注入记录，`rulesInjected 1`；注入条目按 `Runtime rules → Working context → Formal memories` 渲染，预算省略时写明原因，渲染函数有 3 项契约用例。`packages/adapters/dsh` 仍是独立的阻塞记录，与插件内注入条目无关。
- 本机联调环境（`work/dsh-live/`，不在版本库内）：Server 监听 `127.0.0.1:4317`，令牌与 desktop profile 一致，状态库与 Mnemon 目录都在该目录下；`server.pid` 记录进程号。启动时用 `Start-Process node -ArgumentList 'dist/apps/server/src/main.js' -WindowStyle Hidden`（不加 `-WindowStyle Hidden` 会弹出控制台窗口）；停止用 `Stop-Process -Id (Get-Content work/dsh-live/server.pid)`。
- 记忆页顶栏五页签（2026-11-10，**当时**；后续增至九个，见文末）：概览 / 运行时记忆 / 项目档案 / 正式记忆 / 同步（顺序照抄 dsh-mnemon 的页面 order：runtime 100 → documents 200 → memory 300），默认展示全部项目。授权相应调整：`GET /v1/rules`、`GET /v1/archives`（可省略 `projectId`，即全部项目）、`GET /v1/sync/status`、`POST /v1/sync/refresh` 对带 Host 头的宿主开放；准则与档案的写入仍只接受 operator 令牌。联调环境实测：宿主令牌取到 1 条准则、空档案列表、两个同步范围（`global`、`project:alpha`），手动同步返回 `pulled 0 / applied 0`。
- 宿主连接与唤醒（2026-11-10）：`packages/client` 的 `ensureServer` / `probeServer` 统一三个宿主的连接顺序——探测 `/health/live` 确认是本服务，再用 `/health/ready` 判断可用。只有 `ECONNREFUSED` 才请求运行 `MnemoWeave Local Server` 计划任务；超时、401、响应不匹配均不触发启动。`/health/live` 增加 `service`/`protocol` 标识，`401` 错误体同样带标识，因此「令牌不匹配」与「别的程序返回 401」可区分。DSH 在插件加载时后台预热并在状态里给出 `connected`/`starting`/`failed` 与具体原因；ZCode 与 ChatGPT 钩子在会话启动时预热，按轮执行时受 2 秒注入截止约束，来不及就本轮不注入。`apps/server/src/main.ts` 增加实例保护：端口已有本服务则安静退出（0），被其他程序占用则报 `port_not_ours`（1）。注册/查询/运行/注销任务见 `scripts/install-local-server-task.ps1`，启动包装为 `scripts/run-local-server.ps1`，配置样例 `scripts/local-server.env.example`。
- 本轮连接相关的验证全部为进程内契约测试（26 项：连接探测 8、宿主轮次预算 4、实例保护 7、DSH 服务阶段 7），不启动子进程、不监听端口；E2E 只按最小范围复跑 `native.test.ts` 与 `dsh-host-half.test.ts`。
- **模型归属改为「Server 不调用外部模型」（2026-11-10，经用户确认）**：删除 `packages/infrastructure/model-gateway` 与 `MNEMOWEAVE_MODEL_*` 配置（配置它们会启动失败并说明原因）。候选审核与提炼的语义判断交给宿主会话内的模型，做法与 DSH 生态的 `dsh-mnemon` 一致——它不启动后台 Agent，只通过注入指令引导当前 LLM。`CAPTURE_GUIDANCE` 因此承载了完整的判断标准（值不值得记、先 recall 查重、矛盾要说明、每轮至多一条、尊重不记请求）。`MemoryWorkflow.review` 只保留确定性规则：显式变更意图转人工、全等重复自动拒绝、查询截断转人工、其余转人工；`ViewAssembler` 不再重排（`rerank` 恒为 `not_requested`）；运行时提炼不再在 Server 执行，排队的 capture 任务标记 `awaiting_model`。相关测试按新语义重写：`workflow.test.ts` 断言「无任何自动批准」，`view.test.ts` 断言「永不重排」，`reliable-memory.test.ts` 改为人工批准后仍覆盖真实写入、重启与崩溃恢复。
- 本轮顺带修复的缺陷：实例保护把 `MNEMOWEAVE_PORT=0`（由系统分配端口）当作可疑占用，导致所有用随机端口的启动被判为 `port_not_ours`；`main.ts` 把启动失败一律吞成 `configuration_invalid`，现附带 200 字符内的错误摘要。
- **记忆全生命周期处置（2026-11-10）**：修复 9 项 P1。①审核发布后回拉不再重复生成 Revision——发布时把本机已有的 Provider 映射写入 `formal_map`，回灌时按内容哈希找到同一写入而不是再写一次；②同一基准的两次并发编辑只有一个成功，编辑路径按 memoryId 串行化；③撤回改为「新增撤回版本、保留可读历史」，不再调用 `forget`（它会擦除正文并丢掉指向它的边），并补齐 `POST /v1/memories/{id}/withdraw` 端点；④后续裁定可完整传播——发布回调按版本发 `create`/`update` 并携带 supersedes 关系，不再恒发 `create`；⑤发布与共享入队之间不再有丢失窗口——v13 新增 `share_outbox`，与发布同事务写入，启动时补偿；⑥同步编辑只承认本次变更真正写入后的结果，以「该条目是否新增映射」判定，不再把旧版本当成功；⑦用户动作边界加一次性确认（`POST /v1/memories/{id}/confirm`，绑定 memoryId 与动作、60 秒过期、用后即焚），Host 头之外再要求 UI 流程凭证；⑧端口探测前移到 `configure()` 之前，第二个进程不再先打开治理库并启动 Worker；⑨OpenAPI、迁移与相关测试同步更新（schema v13）。
- **第 ⑦ 项的边界必须说清**：确认令牌证明「UI 流程跑过」，不能证明「用户点了」。持有服务令牌的任何代码同样能申请并使用它，因此它不是防伪。该机制已于后续轮次整体移除（2026-11-11），连同编辑所需的 operator 令牌一起——见下条第 ⑤ 项。<br>~~真正的用户边界仍是 operator 令牌~~：这条结论在 2026-11-11 被用户否决（个人项目，不需要第二把凭据）。
- **DSH 记忆中枢补齐（2026-11-11）**：四批交付均已完成程序化验收。①浏览契约：列表新增 `scope`/`projectId`/`cursor`，响应带 `nextCursor` 与全量 `projects` 索引；先按范围选候选、稳定排序后再做正文匹配，游标记录扫描位置；详情支持 `?revisionId=` 读历史版，并拆分 `currentRevisionId`/`selectedRevisionId`。②正式记忆页：卡片列表、范围筛选、搜索、逐步加载（默认 25 条）、历史点选、并排比较、关联跳转、宽窄屏布局（窄屏单面板切换且保留筛选/选中/滚动）。③安全编辑：先以真实验收三条约束（同基准并发只有一个成功、成功返回本次 Revision 与确认版本、排队/待确认状态不被当成成功），再补编辑表单、UTF-8 字节计数、冲突对照与草稿离开守卫。④设置页：新增第六页签，统一 Host 配置到 `src/shared/host-config.js`，页面与注入钩子共读同一份，四组保存语义落地。
- **本批新增测试**：`tests/contract/memory-browse.test.ts`（4，翻页无重复无漏页、项目可达、跳过整页仍推进、非法游标拒绝）、`tests/contract/edit-gates.test.ts`（3，真实 Mnemon）、`tests/contract/host-config.test.ts`（8，解析顺序、loopback、令牌不外泄、偏好校验、失败保留旧连接、两半一致、重启保留、损坏回落）；`tests/unit/dsh-ui-view-model.test.ts` 增至 9 项。<br>当前：unit+contract **279 通过 / 0 失败**，e2e **25 通过 / 0 失败**，根类型检查与构建、DSH 客户端类型检查与两半打包全部退出 0。
- **设置页与唤醒的真机验收（2026-11-11）**：用**已部署**的 `dist` 产物在本机跑通 20 项检查。①`work/desktop-acceptance/settings-acceptance.mjs` 14/14：真实 profile patch 解析、令牌来自用户环境变量且不出现在页面可读数据中、页面与注入钩子解析一致、偏好写入 profile 目录且文件内无凭据、改写后解析立即变化、非 loopback 被拒、真实 `/health/live` 与 `/health/ready` 正常。②`work/desktop-acceptance/wake-acceptance.mjs` 6/6：先 `schtasks /end` 真停 Server，再验证运行中报 `already_running`、停止后 `connection_refused`、唤醒后 `woken`、任务缺失 `task_missing`、只启动不就绪 `timeout`。
- **仍未完成的一项**：设置页的界面点击未执行。DSH 的 RPC 通道经网页令牌鉴权，外部无法代点；Host 半的通道确认已注册（`/dsh-mnemo-weave` 与 `/api` 同为 401，未知路径为 405），产物为新代码。需在桌面刷新后人工点击确认六个页签与分组保存。
- **界面加载性能（2026-11-11）**：测得瓶颈不是数据量而是 CLI 进程启动次数。`/health/ready` 每次起两个进程（`--version` + `status`）耗时 171 ms，占满页面启动；列表每行正文各起一个进程。三项修复：版本检查缓存 60 秒（失败不缓存）、只读命令走 `--readonly` 不可变快照（本进程首次调用普通打开以建库，之后固定快照，且失败不重试）、正文按 id 缓存且 `forget` 清除 + 列表批量读（窗口 2，实测最优）。结果：`/health/ready` 171 ms → **1–3 ms**；页面启动路径（probe + ready + list）稳定态 **2–8 ms**（原 249 ms），重启后首次调用仍有 237 ms 的进程预热成本；25 行列表冷 2219 ms → **1256 ms**、热 **0 ms**。修复过程中发现并修正批量读的游标 off-by-one（每页丢一行，由 `tests/contract/memory-browse.test.ts` 捕获）。
- **处置复评 6 项（2026-11-11）**：①**编辑基准**：草稿在打开时固定 `entryVersion` 与原文，冲突后重新读取详情只更新对照内容、不移动基准；连点保存仍按旧基准被拒，只有显式「改用最新版本作为基准」才切换。排队/待确认三态下按钮变为「等待结果，暂不可重复提交」。②**用户写操作**：编辑与撤回改为要求 operator 令牌，服务令牌 + 自报 Host 头一律 `UNAUTHORIZED`；移除无证明力的 `/confirm`（申请方与使用方相同）。线上实测：服务令牌编辑 401、operator 令牌通过鉴权、`/confirm` 不再返回 200。③**Provider 回退**：该项在上一轮已改为「本进程首次普通打开、之后固定只读快照，失败不重试」，本轮复核确认并保留「失败不重试」测试。④**连接持久化**：`saveConnection` 在测试通过后写入同一份偏好文件，页面与注入钩子共读；保存其他分组不再还原地址。⑤**游标**：改为键集（`publishedAt`+`memoryId`），补齐「页面之间撤回一条仍不重复不遗漏」测试；正文读取失败不再被越过，整页无结果时报 `PROVIDER_UNAVAILABLE`。⑥**注入唤醒**：提示钩子接入共享 `ensureReachable`，仅 `ECONNREFUSED` 且 autoStart 打开时唤醒，唤醒预算计入两秒总截止。
- **记忆视图与编辑补全（2026-11-11，第 1 轮）**：①解析层不再丢弃 Server 已返回的字段：修订增加父修订、内容哈希、候选 ID；关系增加方向、`Supersedes`/`RelatedTo`、证据、是否已写入 Provider；补齐此前完全未解析的**冲突与裁定**。②详情视图相应展示修订链（父修订缺失会标出）、关系证据与投影状态、未解决冲突及其裁定记录。③**新增撤回入口**：当前版正文旁、必填原因、确认后退出召回与注入、历史仍可读、不可二次撤回；RPC 增加 `withdraw` 端点并在 Host 侧校验。④编辑冲突时给出「打开时的版本 / 最新生效版本 / 我的草稿」三方对照。⑤修复真实缺陷：**撤回在无同步时不推进 `entryVersion`**，导致后续编辑使用记忆已不再持有的基准、且调用方被告知撤回未生效。真机 e2e 验证：撤回返回新版本、`state` 变 `superseded`、两条修订仍在、正文仍可读、二次撤回被拒。
- **分类落到目录表（2026-11-11，第 2 轮）**：同步载荷里的 `category`/`importance`/`tags`/`entities` 以及本地 Remember 的 `knowledgeType` 此前只在传输中出现、从不落库，详情因此无从展示。①schema **v14** 给 `catalog_revisions` 增加五列，所有发布路径（初始发布、审核修订、直接编辑、同步应用）改走同一个 `insertRevision`；直接编辑继承上一版分类（改的是正文不是分类）；同步应用写入载荷分类且不冒充本地知识类型。②契约里这些字段可选：缺失表示「当时没记录」，与「记录为空」可区分。③详情页按修订展示分类、标签与实体，查看历史版时显示那一版的值。④迁移先在真实库副本上演练（v13→v14、五列齐全、`integrity_check` ok、生成 pre-v14 快照、行数不变），随后才升级真实库；升级后真实库为 v14。
- **列表分类与关系预览（2026-11-11，第 3 轮）**：①`MemoryListItem` 携带当前修订的 `knowledgeType`/`category`/`importance`/`tags`，卡片直接显示分类与标签；未记录分类的卡片留空，不标成「一般」。②列表新增 `category`/`knowledgeType` 筛选，在**读正文之前**作用于候选集；响应新增 `categories`/`knowledgeTypes` 索引（按范围筛选后计数），选中一个分类不会让其他分类从选择器消失。③非法分类值在 HTTP 与 Host 两侧都返回 `INVALID_INPUT`，不会静默变成空列表。④关联新增**内联预览**：不离开当前记忆即可读目标正文与状态，按目标缓存，失败就地显示原因。真实 Server 实测：`?category=decision` 正常返回并带索引，`?category=nonsense` 返回 400。
- **语义探索与召回授权（2026-11-11，第 4 轮）**：①新增 `POST /v1/memories/explore`：按 Provider 相似度排序，把命中的 `providerMemoryId` 映射回本机目录，只返回 `active`、可打开的记忆；Provider 里存在但本机从未发布的命中只计数（`unregistered`）。②新增「探索」页签：独立查询与结果，命中可直接打开到正式记忆详情。③**修复真实授权缺口**：`/v1/recall` 此前直接调用 `app.recall(input)`，既不需要 Host 头也不带 grant——服务令牌足以读取整个 Provider，绕过 View 的可见性规则；现在要求宿主身份，有目录时经 `client.recall(hostId, …)` 用同一 grant 过滤。真实 Server 实测：无 Host 的 recall → 401，带 Host → 200；explore 正常返回。④新增 `tests/contract/recall-authorization.test.ts`（3 项）固定该边界。
- **编辑分类与测试稳定性（2026-11-11，第 5 轮）**：①编辑不再只改正文：`category`/`knowledgeType`/`importance`/`tags` 可随 Revision 更新。**省略字段表示继承上一版**（只改正文不会清空分类），显式空数组才是清空标签；由 `classificationOf` 只保留调用方真正设置过的字段实现。②编辑表单增加分类/重要度/标签控件，未改动显示「保持不变」，提交时整项省略。③RPC 与 HTTP 两侧都校验分类取值，非法值 `INVALID_INPUT`；真实 Server 实测：合法载荷 → 404（鉴权通过、记忆不存在），`importance: 9` → 400。④**修掉长期偶发的测试失败**：TAP 复跑抓到 `project-header`（3 项）与 `recall-authorization`（1 项）的间歇失败，根因是测试用 `fetch` 的 keep-alive 连接可能在该临时端口的 server 关闭后仍被复用，`server.close()` 也会被这些连接挂住。给相关测试加上 `connection: close` 与 `closeAllConnections()` 后，连跑 **8 次全量 309/309 通过**。
- **编辑与撤回不再要求 operator 令牌（2026-11-11，用户指示：个人项目）**：①`PATCH /v1/memories/{id}` 与 `POST /v1/memories/{id}/withdraw` 改为只要求服务令牌 + `x-mnemoweave-host`（缺失 Host 仍 `UNAUTHORIZED`），写入继续记录 `local-user` 审核决定。②Host 半**不再读取** `MNEMOWEAVE_OPERATOR_TOKEN`，设置页移除「操作员令牌」一项，`packages/client` 删除 `operatorToken` 选项。③operator 令牌**继续**约束管理类端点（review/retry/conflicts/versions/runtime/rules/archives/sync），这些不属记忆写入。④取舍已写入架构决策表：审计能证明「哪个宿主发了请求」，不能证明「人在场」；这是单用户机器上明确接受的选择，不是被忽略的漏洞。
- **排序、实体筛选与实体索引（2026-11-11，第 6 轮）**：对照参考项目 `memory-spaces` 的 `entities-page`/`list-page` 补齐浏览侧。①新增 `sort=newest|oldest|importance`：三种顺序都以 `publishedAt` + `memoryId` 收尾构成全序，未记录重要度排最后而不是当作 0；游标升级为 `v3` 并**绑定签发时的排序**，换排序后用旧游标返回 `INVALID_INPUT`，旧 `v2` 游标仍解析为 `newest`。②新增 `entity` 筛选（大小写不敏感）与 `entities` 索引：同一实体的不同拼写合并为一条、保留首次出现的写法并计数。③卡片显示实体；列表新增排序与实体下拉。④真实 Server 实测：`sort=importance`、`sort=oldest`、`entity=DSH` 均 200，`sort=nonsense` 400。⑤新增 2 条契约测试（三种顺序各自翻完全部行且不重复、游标不可跨排序；实体大小写合并与索引不随筛选收缩）。
- **探索的相似度门槛与「显示更多」（2026-11-11，第 7 轮）**：①用 `mnemon recall` 实测分数：强相关 `1`、部分相关 `0.6`、**完全无关仍有 `0.3`/`0`**——所以门槛不是装饰，没有它排序列表会被误读成答案。②`ExploreInput` 增加 `minScore∈[0,1]`（默认 0），`ExploreOutput` 增加 `truncated`（本次填满 `limit`，可能还有更多）。③探索**不设游标**：Provider 每次重新排序，偏移分页会重复或丢行；「显示更多」= 用更大的 `limit` 再问一次，上限 50，到顶后提示缩小查询。④页面默认门槛 0.5，可切换 0/0.3/0.5/0.8；门槛变化清空旧结果，避免看到与当前门槛不符的列表。⑤新增 `tests/contract/explore-ranking.test.ts`（2 项，真实 Provider）：**大答案必须是小答案的前缀**（否则「显示更多」会打乱用户刚读的顺序）、门槛确实逐条生效且空结果不报 `truncated`。⑥真实 Server 实测：`minScore=0.5` → 200、`minScore=1.5` → 400。
- **实体页、性能复测与探索排序修复（2026-11-11，第 8 轮）**：①新增「实体」页签（对照参考项目的 `entities-page`）：实体索引可再筛选、带计数，选中即应用到正式记忆列表；索引由 Server 对整个作用域计算，用一行请求取回，不额外读正文。筛选规则抽成 `filterEntities` 纯函数并单测（大小写不敏感、空查询不收缩、非 ASCII 生效）。②**图标定为第 8 个页签**，`TAB_ORDER` 与计数占位同步。③性能复测（200 条真实记忆、每路径 3 次中位数）：列表首页 44 ms、下一页 41 ms、实体索引 30 ms、详情 1 ms、探索 137 ms；三次采样中的 ~1.2 s 是**首次读该批正文**，其余为 `bodyCache` 命中。据此改了两处：列表窗口**从 `limit` 起步、被过滤才倍增**（原先固定读 32 条，为不显示的行付钱）；`readMany` 并发 2 → **4**（实测 1/4/8/16 分别为 1805/934/1160/1504 ms，8 以上因争用变慢）。④**修掉一个真实缺陷**：Provider 的等分项排序不稳定——同一查询、同一 limit 连跑 5 次出现 3 种顺序，用户重跑同一搜索会看到列表自己洗牌；服务端改为施加自己的全序（分数降序 → 发布时间降序 → memoryId 升序），并新增测试固定「同一查询两次顺序一致」。此前 `explore-ranking` 在并行负载下 2/3 失败，正是这条不稳定性暴露出来的。
- **关系图端点与关联网络（2026-11-11，第 9 轮）**：①新增 `GET /v1/memories/graph`（`scope`/`projectId`/`limit≤500`）：节点是作用域内 `active` 记忆，边是两端都在节点集中的目录关系；**不带正文**（每个节点读正文就是一次 CLI 进程），**不带悬空边与自环**。②`truncated` 表示节点达上限；节点按发布时间降序 + memoryId 升序截断，保留最近部分。③过滤规则抽成 `drawableEdges` 纯函数并单测（悬空边、自环、未知关系类型归为 `RelatedTo` 而非 `Supersedes`——后者是更强的断言）。④详情新增**关联网络**：按需加载、从当前记忆广度优先走 2 跳、标注关系/方向/跳数，同一记忆只报最短跳数，切换记忆即清空。⑤真实 Server 实测：`?` 与 `?scope=global` → 200；`?scope=project`（缺 projectId）与 `?limit=501` → 400。
- **图谱画布（2026-11-11，第 10 轮）**：新增「图谱」页签，把目录关系画成图（对照参考项目的 `memory-graph`）。①布局是**确定性同心环**（`client/graph-layout.ts`，手写 SVG、不引入图形库）：以连接最多的节点为圆心、按跳数分环、环内按 memoryId 排序。刻意不用力导向——它每次渲染落点不同，同一张图会显得自己在动，也没有任何东西可被断言。②节点大小随重要度、无重要度用默认尺寸而不是最小；无关系节点虚线描边并单独成环；取代关系高亮；点击节点直接打开该记忆。③打开页签时按需加载一次，之后由「重新加载」按钮控制，不在每次切页签时重拉。④新增 `tests/unit/graph-layout.test.ts`（6 项）：同一输入两次布局完全一致、按跳数分环、坐标有限且落在边界内、孤立节点不冒充中心、自环与悬空边不绘制、空图仍给出可用画布。
- **失败重试修复与面板渲染测试（2026-11-11，第 11 轮）**：①**修掉上一轮自己引入的缺陷**：图谱自动加载的条件是 `graph === null`，而加载失败时 graph 仍然为 null，effect 会在每次渲染后重新触发——服务端已知会失败的请求被无限重发。改为独立的 `graphAttempted` 标志（尝试过 ≠ 成功过），失败后停止自动重试，只能由「重新加载」按钮显式重试。②新增 `tests/unit/dsh-panels-render.test.ts`（6 项）：Node 无法直接导入 `.tsx`，改用项目已有的 esbuild 把面板打成 ESM 再交给 `react-dom/server` 渲染，因此**不需要浏览器、不新增依赖**。覆盖：探索页渲染命中/分数/未登记计数/显示更多、空结果在有门槛与无门槛下文案不同、图谱页每个节点一个 `<g>`、每条关系一条 `<line>`、取代关系可区分、焦点标记、坐标不出现 `NaN`（`NaN` 会让画布静默空白而不是报错）、实体页高亮当前应用的实体且可筛选、无匹配有解释。
- **整页首帧渲染与图谱请求校验（2026-11-11，第 12 轮）**：①新增 `tests/unit/dsh-page-render.test.ts`（3 项）：用 esbuild 打包 `page.tsx` 后用 `react-dom/server` 渲染**整个页面**，连接桩必须在"服务端没起"与"桥接同步抛错"两种情况下都能画出首帧，且 9 个页签齐全、界面里不出现 `undefined` 与 `NaN`。SSR 不执行 effect，所以这是**首帧**检查——首帧崩溃会整页空白，这是面板级测试覆盖不到的。②语言断言按显式传入的 locale 写，不依赖环境默认值（第一版就是因为假设默认中文而失败）。③`tests/contract/dsh-ui-client.test.ts` 增加图谱请求校验（12 项）：`scope=project` 缺 `projectId`、空白 projectId、`limit` 为 0/501/小数、未知 scope 一律 `INVALID_INPUT`，且**被拒的请求不会到达 Server**；projectId 会去除首尾空白。④`tests/e2e/dsh-host-half.test.ts` 增加图谱断言：通过真实 Server 与真实 `MemorySource` 解析器验证节点可打开且**不夹带正文**。
- **并发写入与重启一致性（2026-11-11，第 13 轮）**：①新增 `tests/e2e/concurrent-writes.test.ts`（3 项）：同一记忆上并发发起「编辑与撤回」「两次撤回」「两次编辑」，断言**恰好一个成功**。这一条不是防重复提交，而是防状态被写坏——撤回后再让编辑成功，会留下一条已撤回忆记忆带着更新的正文；编辑后再按旧基准撤回，会覆盖用户没看过的版本。三个用例均通过，说明按 memoryId 串行化 + 锁内校验基准是有效的。②新增 `tests/e2e/restart-consistency.test.ts`（2 项）：写入跨进程重启后仍成立——编辑后重启，`entryVersion` 停在 1、Provider 提供的是新正文、再编辑能从 1 继续到 2；撤回后重启，状态仍是 `superseded`、历史可读、且不再出现在列表里。这两条覆盖的是「版本计数与目录指针都在治理库里、Provider 正文在另一个库」这个三处写入的一致性。③真实 Server 冒烟：`health/live`、`health/ready`、`memories`、`graph`、`explore` 全部 200。
- **文档漂移审计与契约测试（2026-11-11，第 14 轮）**：审计后发现文档与实现已经分叉，逐条修正并加测试防止再犯。①**`docs/dsh-ui.md` 记录了一条已被删除的 `POST /v1/memories/{id}/confirm` 路由**，还写着 PATCH 接受 `confirmation` 字段——读文档的人会以为这条路由存在。②`dsh-ui.md` 说「六个页签」，实际是九个（缺实体/探索/图谱）；`status.md` 与 `sync.md` 说 schema v12、`README.md` 说 v10，代码早已到 v14。③新增 `tests/contract/docs-consistency.test.ts`（3 项）：**新建一个真实治理库读出实际 `user_version`**，再要求文档里「当前 schema vN」与 README 首行的版本与它一致（历史性表述如「v12 新增 `entry_versions`」允许保留旧版本号，因此只校验带「当前/目前/现在」线索的句子）；`dsh-ui.md` 里提到的每个 `/v1/...` 路径必须在 OpenAPI 路由表里存在；文档声明的页签数量必须等于 `TAB_ORDER` 的长度。④测试自己也修了一处：正则原先不允许 Markdown 的 `**` 强调，导致「当前 schema **v14**」匹配不到而误报。
- **同步可见性边界修正（2026-11-11，第 15 轮）**：①发现 `dsh-ui.md` 自相矛盾——既列出「同步」页签，又写「`/v1/sync/status` 与 `/v1/sync/refresh` 只接受 operator 令牌，不提供给宿主」，而实现是 `if (!isOperator) requireHost()`，宿主半也确实在调用它。②核对响应形状后确认**文档过严**：`SyncStatusOutput` 只含「已确认游标、待推送/待确认/待应用计数、最近拉取时间与错误」，**没有设备令牌、远端地址或任何凭据**，所以给宿主看同步视图不等于把设备凭据边界并入宿主。③文档按实现修正，并写清真正的边界是**必须自报身份**：没有 Host 头一律 401。④新增测试固定这一条：匿名调用 `sync/status` 与 `sync/refresh` 返回 401 且**不会触达同步状态**，带 Host 头返回 200，且响应体内不得出现 `token`/`deviceId`/`url`/`secret`；另在主机半端到端断言「未配置远端时同步页签得到明确的 disabled 或显式拒绝，而不是空白的成功」。
- **演示库与首次真实数据验证（2026-11-11，第 16 轮）**：此前所有界面验证都受限于「真实库是空的」，功能只在夹具上跑过。新增 `scripts/seed-demo.mjs`：在 `work/demo-store/` 生成**完全隔离**的演示数据（9 条记忆，覆盖决策/洞见/约束/事实/偏好/上下文六种分类、2–5 的重要度、中英文标签与实体、全局与项目两种范围），可随时整体删除，绝不触碰真实部署。脚本走的是 Server 同一条发布路径，不是特例。
  用它在 4319 端口起了一个独立 Server 后，**首次用真实数据逐项验证**：列表分页与分类/实体索引正确（`decision=5/context=1/fact=1/insight=1/preference=1`、`MnemoWeave=8/DSH=2`）；详情返回修订链与哈希；按重要度排序得到 `5,5,5,4,4,4,3,3,3`；实体筛选大小写不敏感命中 2 条；探索返回真实相似度 `0.486 / 0.3` 且门槛生效；编辑后 `entryVersion 0→1`、两条修订；撤回后 `state=superseded`、`entryVersion=2`、历史仍可读、列表从 9 条降到 8 条。全程 HTTP 200。
- **验证中发现的一个真实缺口**：`catalog_relations` 恒为 0，因此图谱只有节点没有连线。原因是目录关系**只由候选审核发布路径产生**——用户编辑与跨机同步都只在 Provider 侧建立 supersedes 链接，不写目录关系。这不是图谱的 bug（同一条记忆的版本链已在详情「修订历史」里），但会让图谱长期没有边。已在图谱页补一句说明（有节点无连线时告知原因，而不是让人以为画布坏了），并新增渲染测试固定它。是否要**把冲突（`catalog_conflicts`）也画成边**、以及是否让编辑写入目录关系，属于设计取舍，留给下一轮判断。
- **图谱边的真 bug 与修复（2026-11-11，第 17 轮）**：上一轮真实数据验证留下一个问题——图谱恒零边。本轮查清并修好，是**产品缺陷不是数据问题**：图谱只把 `active` 记忆当节点，而 `Supersedes` 边的目标恰恰是已被替代、状态为 `superseded` 的记忆，于是**这类边结构上永远画不出来**。①服务端改为先按 `active` 选起点，再把「一端已在图中的关系」的另一端补进来，节点新增 `state` 字段。②页面把已退休节点画成虚线，避免与当前记忆混淆。③新增端到端测试 `tests/e2e/review-publish-graph.test.ts`：走**真实完整链路**——`/v1/remember` 提交带 `change.kind='supersede'` 的候选 → 等它进入 `needs_review` → `/v1/review` 批准 → 后台 worker 发布 → 断言图谱出现一条 `Supersedes` 边、两端是不同记忆、被替代的那条状态为 `superseded`。这条测试还固定了「关系只能由审核发布产生」这一事实。
- **写这条测试时被系统纠正两次**：①`effectiveAt` 写成未来时刻被目录拒绝（`catalog.ts` 不允许未来生效——守卫是对的，夹具错了）；②`/v1/remember` 的响应是完整 Candidate，评审句柄是 `id` 而不是 `candidateId`。
- **冲突接入图谱（2026-11-11，第 18 轮）**：证书里只有「候选 ↔ 目标记忆」的冲突，只有在候选**发布之后**才成为两条记忆之间的关系——`coexist` 裁定正是这种情况：原候选被拒、限定范围的替代记忆被发布，两条记忆同时 active。①`catalog.allConflictEdges` 取这种已配对的冲突；**连接必须用 `COALESCE(follow_up_candidate_id, candidate_id)`**，否则 coexist 流程下原始候选永远没有修订，一条边也查不到（第一版就是这么错的，端到端测试把它抓了出来）。②图谱新增 `Conflicts` 边类型，页面用琥珀色虚线区分于取代关系；详情邻域同样显示。③新增 `tests/e2e/conflict-graph.test.ts`：走完整链路（提交冲突候选 → 等 `needs_review` → 断言直接批准会被 409 拒绝 → `coexist` 裁定 → 批准后续候选 → 图谱出现 `Conflicts` 边且两端都是 active）。④单元测试补 `Conflicts` 不能折叠成 `RelatedTo` 或 `Supersedes`。
- **e2e 改为串行执行（2026-11-11，第 18 轮）**：多轮全量运行里**不同**的 e2e 用例会偶发失败（重启一致性、审核发布图谱、同步发布各失败过一次），共同点是并行负载下真实 Provider 调用变慢或进程争用。这些测试每个都要起 Server 与多个 Mnemon 进程，12 个文件并行本就超出本机的合理争用水平。处理：`package.json` 的 `test:e2e` 与 README 改为 `--test-concurrency=1`，并给使用 `MemoryClient` 的测试显式 30 秒超时（它们不是在测延迟）。串行后 **3 次全量 32/32 通过**，耗时约 94 秒——可靠性换来的这点时间值得。
- **页面端点冒烟测试抓到的死控件（2026-11-11，第 19 轮）**：新增 `tests/e2e/page-endpoint-smoke.test.ts`，用**页面真正使用的那条 RPC 通道**（`MemorySource` + `createRpcHandler`）对真实数据把每个端点跑一遍。第一次运行就抓到严重 bug：**`memories` 的 RPC 处理器只转发了 `query`/`limit`/`scope`/`projectId`/`cursor`，把 `category`、`knowledgeType`、`entity`、`sort` 全部丢掉**——也就是说分类筛选、实体筛选、排序这三个控件**从上线起就没有生效过**：请求成功、返回未过滤数据，看起来像「筛选匹配了一切」。校验层是对的（有单测），坏在转发。①修复后三个控件才真正工作。②新增回归守卫（`tests/contract/dsh-ui-client.test.ts`）：断言每个被校验的字段都到达 source，且不传时不凭空补字段。③测试本身把设置页写入路径排除在外（探针/唤醒需要真实调度器与桥接，由 `host-config.test.ts` 覆盖），并显式把偏好目录指向临时目录，不写真实 profile。
- **把「校验了却没转发」变成一类可测的错（2026-11-11，第 20 轮）**：上一轮的死控件属于**一类**问题，不止一处可能犯。本轮在两层各加一张转发矩阵：①`tests/contract/dsh-rpc-forwarding.test.ts`（4 项）：用 Proxy 造出「任何被调用的方法都记录参数」的桩，因此**新端点自动纳入覆盖**；逐端点断言每个被校验的字段都到达 source／settings，且被拒绝的请求**一个字节都不转发**。②`tests/contract/http-query-forwarding.test.ts`（5 项）：同一类错在 HTTP 路由层也测——`/v1/memories` 的九个查询参数、`/graph` 的 scope/project/limit、`/explore` 的 query/limit/minScore 都必须送达处理层；未传的参数保持缺失，只补文档写明的默认值（`limit=50`、`scope=all`）；非法值一律 400 而不是被忽略。③两张矩阵跑完后**没有发现新的转发缺陷**——说明当前 20 个端点在这条轴上是对的，本轮价值是把这个错误类别变成必然被抓住，而不是继续靠肉眼检查。
- **逐页签验收矩阵（2026-11-11，第 21 轮）**：`docs/host-acceptance.md` 里 2026-11-10 的点击验收**只覆盖「列出 + 编辑」两条路径**，此后页面增至九个页签，实体/探索/图谱/撤回/筛选/排序都是新增能力，从未被点过。新增 §5.1 矩阵，逐个页签写明：哪些有可复跑的程序化断言（列到具体测试文件）、哪些只能人工确认。**明确标出两类不宣称通过的事项**：①连接相关的三个动作（保存连接、测试连接、唤醒）必须对着真实 Server 与真实计划任务执行；②视觉与手感（窄屏布局、滚动加载、画布缩放、焦点与文案）。同时把「验收清单必须覆盖每个页签」变成断言：`docs-consistency` 从 `TAB_ORDER` 取页签、从 i18n 取中文标签，要求每个标签都出现在 `host-acceptance.md` 里——当初实体/探索/图谱正是「存在但没人约定怎么验」才一路没被点过。
- **再次确认「新增记忆」确实受阻**（不是我没做）：读了 `MemoryWorkflow.review`，除「完全重复」会被自动拒绝外，**所有候选都转人工**（`'No automatic semantic review… A person must approve or reject this candidate.'`），没有自动发布路径。因此界面提交候选后就无人能批准——`/v1/review` 是 operator 端点，而 Host 半按决策不持有 operator 令牌。要落地必须先改 `AGENTS.md` 的两条边界，与之前判断一致。
- **界面新增记忆（2026-11-11，第 22 轮，按用户的 B 方案）**：用户确认「界面新增直接发布为正式记忆」，此前 16 轮未决的阻塞解除。①`AGENTS.md` 与 `docs/architecture.md` 决策表同步改写：宿主没有写准则、写档案的入口，但**正式记忆的新增与编辑由记忆界面直接发布**；模型仍无发布入口，模型输出仍只能成为候选。顺带把 `AGENTS.md` 里过时的 schema v12 改为 v14。②新增 `POST /v1/memories`：提交候选 → 立即以 `local-user` 批准 → 走**既有发布流水线**（不另写一条发布路径，避免重复检测与共享入队分叉）。③`RememberInput` 增加可选的 `category`/`importance`/`entities`，发布时统一经 `revisionMetaOf` 写入修订分类，候选与同步两条路径因此都能带上分类。④页面在正式记忆页加了「新增记忆」表单（正文、知识类型、分类、重要度、标签、实体、范围、备注、字节计数），发布成功后刷新列表并打开新记忆。⑤失败方式明确：worker 未运行时**立即** `INVALID_STATE`（不让人等 15 秒）、发布失败 `PROVIDER_UNAVAILABLE`、等待超时 `SYNC_OUTCOME_UNKNOWN`。
- **本轮测试抓到的两个真实问题**：①`packages/client` 自己声明了一份 `MemoryListItem`，**漏了 `entryVersion`/`category`/`knowledgeType`/`importance`/`tags`/`entities` 六个字段**——宿主用这份类型时看不到分类信息，是真实的类型漂移；已补齐。②我一开始断言「新记忆 `entryVersion` 是 1」，实际是 **0**（计数器记录已确认的编辑，不是发布次数）；契约注释与测试都已改正。
- **仍待补全**：编辑不涉及项目归属与关系修改（各有独立治理语义）。
- **同步其余部分尚未实现**：三宿主（DSH、ChatGPT 桌面、ZCode）在同一项目上的注入结果与延迟尚未实机验证。

## 3. 未验收

- 三个目标 Host 的真实桌面会话：ZCode（含无 `session.ended` 的结构性缺口）与 ChatGPT 桌面仍待执行；DSH 的界面与提示注入已在 2026-11-10 通过真实会话验证，文本级效果仍待用户观察确认。
- 宿主先启动的四个验收场景（已有 Server 复用、无 Server 自动启动、三插件并发冷启动只出现一个 Server、令牌错配保留原进程）已在 2026-11-10 通过真实计划任务验证（见第 1 节）；**仍未验证**的是三个宿主应用实际启动时的表现，以及锁屏/休眠恢复后的行为。
- 跨机数据流：两机、三机、断网恢复与快照重建均有 E2E 覆盖；尚未覆盖长时间断网下的多次并发写入、清理与拉取同时发生的时序、真实网络故障（丢包、半开连接）。
- 真实用户数据迁移、外部 Provider 改写、高并发负载、Linux systemd 实机运维、TLS 与生产身份体系。
- 全量套件此前出现过偶发失败，已定位并修正：`tests/contract/model-gateway.test.ts` 的「步骤预算限制重试」用例把「第二次尝试必然发生」写死，负载高时预算在第二次尝试前已耗尽，导致 `1 !== 2`。现改为断言契约本身——尝试次数不超过 2、每次实际尝试都记为超时、最终以 `timeout` 或 `budget_exhausted` 结束；该文件连续 12 次、全量套件连续 3 次均通过。

## 4. 未决事项

| 事项 | 现状 | 约束 |
|---|---|---|
| 离线与断网 | 当前实现直连，断网不可用；目标态是读取已同步副本、共享编辑排队 | 副本能力随同步一起落地，落地前不得声称可用 |
| 逐 Host 凭据与撤权 | 宿主仍共用服务令牌；同步侧改为逐设备令牌、可单独撤销 | 两条边界不同，设备令牌不得下发给宿主 |
| 编辑免审核的边界 | 用户编辑直接写正式记忆并记录为 operator 决定 | 只对本地可信用户开放；对外暴露前必须重新评审 |
| 容量配额 | 软 10 GiB / 硬 20 GiB 为默认值 | 未经用户确认的业务默认值 |
| 上游自动清理 | 本项目写入固定 `MNEMON_MAX_INSIGHTS=0` 关闭 | 其他原生客户端仍可能改动同一 Store |
| 正文可见性 | **待确认**：已确认的只有「三类记忆都要跨机同步」 | 确认前不得按明文写死；`enc-v1` 只封装正文，标题、证据、实体、关系仍是明文 |
| 变更日志保留 | 90 天 / 50000 条为提议值 | 决定离线机器还能否增量恢复 |
| 去重凭证保留期 | 365 天为提议值 | 过期后只能 `needs_review` 人工处理，不自动重试 |
| 准则预算 | 1024 token 为提议值 | 超出拒绝启用，永不按正文截断 |
| 正式记忆历史快照 | 体积未评估 | 历史全量进快照可能过大，需评估冷存或分批 |
| 本机 Server 常驻 | Windows 登录时计划任务 | 注销即停止，需要开机自启时再评估 |
| 计划任务注册脚本 | `scripts/install-local-server-task.ps1` 已在真机注册并验证注册/查询/运行/注销 | **需管理员权限**：`schtasks /create` 与注册任务均要求提权窗口，脚本会先自检并给出明确提示。真机注册过程中修正了三个缺陷：原生命令 stderr 被 `2>&1` 转成终止性错误、`/tr` 多层引号导致含空格路径解析失败（改用 Task Scheduler COM API）、`$action` 与 `-Action` 参数名冲突 |
| 实体关系扩展、高级多路召回、第三方组件生命周期 | 未实现 | 不得由当前内置 Source 接线推断为已完成 |

## 5. 下一步

1. 在三个宿主上核对同一项目的注入结果与耗时：DSH、ChatGPT 桌面、ZCode。
2. 完成 ZCode 与 ChatGPT 桌面真实会话验收并采集脱敏证据（`host-acceptance.md`）。
3. 取得可核验的 DSH SDK/运行时后实现 `packages/adapters/dsh`；在此之前保持阻塞，不虚构 SDK 或私有 RPC。
4. 在真实 DSH 桌面确认记忆界面的浏览与编辑，并检查编辑后 Revision 链与 supersedes 边。
5. 真实用户数据迁移、Linux systemd 实机运维、TLS 与生产身份体系。
8. 真实数据迁移前先复制到 `work/` 演练，禁止直接升级用户默认记忆目录。
