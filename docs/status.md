# 当前状态

最后更新：2026-11-10。本文件的测试数字只来自当日实际执行。

## 1. 本轮验证结果

环境：Windows 10.0.19045 x64、Node.js 24.22.1、pnpm 11.18.0、TypeScript 7.0.2。

| 检查 | 实际命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | 通过（退出码 0） |
| 构建 | `node node_modules/typescript/bin/tsc` | 通过（退出码 0，产物在 `dist/`） |
| Unit + Contract | `node --test tests/unit/*.test.ts tests/contract/*.test.ts` | 231 项全部通过（231 pass / 0 fail），含同步规则 14、远端存储 11、远端 HTTP 8、客户端 6、本机账本 5、协调器 9、应用流水线 9、记忆存储 6、同步服务 7、Provider 8、View 14、渲染顺序 5、DSH 注入渲染 3、DSH 页签端点 4、规则与档案 5、本地写入 5、项目头 4 |
| 客户端类型 | `node node_modules/typescript/bin/tsc -p plugins/dsh-mnemo-weave/tsconfig.client.json` | 通过（退出码 0） |
| DSH 插件构建 | `node plugins/dsh-mnemo-weave/build.mjs`、`build-client.mjs` | 通过：`lib/ui/index.js`（esbuild 自包含）、`lib/client.js`（41 KiB） |
| E2E | `node --test tests/e2e/*.test.ts` | 24 项全部通过（24 pass / 0 fail，约 78 秒），含同步链路 3 项、编辑链路 1 项、两台机器双向 1 项、三台机器收敛 1 项、断网排队与恢复 2 项、快照重建 2 项、插件 Host 半 1 项；二进制由 `tests/e2e/mnemon-binary.ts` 解析 |
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

## 2. 已实现能力

- 三机拓扑（已实现）：宿主插件通过 `packages/client` 直连本机 Server；本机 Server 按 `MNEMOWEAVE_SYNC_*` 与远端同步 Server 交换变更，写入由远端确认版本，注入与召回走本机；无本地代理进程，同步不经过宿主。单机不配置 `MNEMOWEAVE_SYNC_*` 时退化为纯本机模式。
- 候选提交（HTTP/MCP 同契约）、规则 + 模型语义审核、人工例外处理、Outbox 与可靠写入、Provider 内容核对与回执追溯；进程中断后可对账恢复。
- Revision 不可变、CAS 更新、业务占用、前向恢复；冲突案件与裁定；版本操作取消；到期复核。
- 授权范围内召回与 View 组装，注入预算 4096 token、2 秒截止、迟到结果不覆盖已结束回合。
- 运行时记忆：持久化 Pinned、项目登记、会话工作上下文与任务投影、事件提炼候选与审核边界。
- 记忆列表、详情与**用户直接编辑**（追加 Revision、supersedes 旧记忆、记录为 operator 审核决定）。
- 治理库 schema v12（每步迁移先 `VACUUM INTO` 快照）：v11 新增同步与三类记忆八表并删除 v8 遗留的 `sync_log` / `sync_grants` / `sync_license_state`；v12 新增 `entry_versions` 记录已确认版本并从 `formal_map` 回填。
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
- 记忆页顶栏五页签（2026-11-10）：概览 / 运行时记忆 / 项目档案 / 正式记忆 / 同步（顺序照抄 dsh-mnemon 的页面 order：runtime 100 → documents 200 → memory 300），默认展示全部项目。授权相应调整：`GET /v1/rules`、`GET /v1/archives`（可省略 `projectId`，即全部项目）、`GET /v1/sync/status`、`POST /v1/sync/refresh` 对带 Host 头的宿主开放；准则与档案的写入仍只接受 operator 令牌。联调环境实测：宿主令牌取到 1 条准则、空档案列表、两个同步范围（`global`、`project:alpha`），手动同步返回 `pulled 0 / applied 0`。
- **同步其余部分尚未实现**：三宿主（DSH、ChatGPT 桌面、ZCode）在同一项目上的注入结果与延迟尚未实机验证。

## 3. 未验收

- 三个目标 Host 的真实桌面会话：ZCode（含无 `session.ended` 的结构性缺口）与 ChatGPT 桌面仍待执行；DSH 的界面与提示注入已在 2026-11-10 通过真实会话验证，文本级效果仍待用户观察确认。
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
| 实体关系扩展、高级多路召回、第三方组件生命周期 | 未实现 | 不得由当前内置 Source 接线推断为已完成 |

## 5. 下一步

1. 在三个宿主上核对同一项目的注入结果与耗时：DSH、ChatGPT 桌面、ZCode。
2. 完成 ZCode 与 ChatGPT 桌面真实会话验收并采集脱敏证据（`host-acceptance.md`）。
3. 取得可核验的 DSH SDK/运行时后实现 `packages/adapters/dsh`；在此之前保持阻塞，不虚构 SDK 或私有 RPC。
4. 在真实 DSH 桌面确认记忆界面的浏览与编辑，并检查编辑后 Revision 链与 supersedes 边。
5. 真实用户数据迁移、Linux systemd 实机运维、TLS 与生产身份体系。
8. 真实数据迁移前先复制到 `work/` 演练，禁止直接升级用户默认记忆目录。
