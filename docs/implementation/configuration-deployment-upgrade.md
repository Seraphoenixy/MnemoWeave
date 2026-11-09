# 配置、部署与升级

状态：本地开发部署已可运行；Linux systemd 单元与磁盘地板 guard 已交付（WP8）；Bridge 进程与 HTTP 传输已交付（WP6/WP7），Windows 用户会话后台化与 Linux Bridge 单元未交付。ADR-026 的迁移与恢复原则已在此落成可执行步骤。

## 1. 运行前提

- Node.js 24（`>=24 <25`），pnpm 11.18.0。
- Mnemon 0.2.13 官方 Windows/Linux 二进制；本机已验证路径 `work/tools/mnemon/mnemon.exe`（不随 Git 提交）。
- 专用 Mnemon 数据目录与 Store；不得指向用户默认记忆目录。
- 本机无需 Docker、无需 Go 工具链。

## 2. 环境变量

| 变量 | 必需 | 默认 | 校验 | 用途 |
|---|---|---|---|---|
| `MNEMON_BINARY` | 是 | — | 绝对路径 | 官方 CLI |
| `MNEMON_DATA_DIR` | 是 | — | 绝对路径 | Provider 数据目录 |
| `MNEMON_STORE` | 是 | — | `[a-zA-Z0-9_-]+` | 专用 Store |
| `MNEMOWEAVE_PORT` | 否 | 4317 | 0–65535 | HTTP 端口 |
| `MNEMOWEAVE_STATE_DIR` | 否 | — | 绝对路径 | 治理库目录；缺省则禁用候选 |
| `MNEMOWEAVE_WORKER` | 否 | `on` | on/off | 关闭后只暂存候选，不审核不写入 |
| `MNEMOWEAVE_MODEL_URL` | 否 | — | HTTPS 或 loopback HTTP | 审核模型端点 |
| `MNEMOWEAVE_MODEL` | 否 | — | 非空 | 模型名 |
| `MNEMOWEAVE_MODEL_KEY` | 否 | — | 非空 | 主模型凭据 |
| `MNEMOWEAVE_BACKUP_MODEL_URL` / `MNEMOWEAVE_BACKUP_MODEL` / `MNEMOWEAVE_BACKUP_MODEL_KEY` | 否 | — | 同主路由校验 | 备用模型路由（仅 temporary/unavailable/timeout 时最多 1 次） |
| `MNEMOWEAVE_MIN_FREE_BYTES` | 否 | — | 非负整数 | Worker 磁盘地板：低于该剩余空间停止领取新任务（每次状态切换告警一次），恢复后自动继续；statfs 失败时不阻塞 |
| `MNEMOWEAVE_QUOTA_SOFT_BYTES` | 否 | 10 GiB | 非负整数 | 软配额：告警并触发清理，允许继续写入 |
| `MNEMOWEAVE_QUOTA_HARD_BYTES` | 否 | 20 GiB | 非负整数且大于软配额 | 硬配额：拒绝新候选增长（`QUOTA_EXCEEDED`） |
| `MNEMOWEAVE_TOKEN` | 是 | — | ≥24 字符 | HTTP 普通令牌 |
| `MNEMOWEAVE_OPERATOR_TOKEN` | 否 | — | ≥24 且不同于普通令牌 | 人工例外入口 |

`MNEMOWEAVE_MODEL_URL` 与 `MNEMOWEAVE_MODEL` 必须同时提供；备用路由同理。只配一个即启动失败。

模型用量（MODEL-06）写入 `<STATE_DIR>/model-usage.jsonl`（追加、不轮转）；未配置状态目录时输出 stderr `model_usage` 行。

## 3. 开发运行

```powershell
Set-Location D:\projects\MnemoWeave
pnpm.cmd install --frozen-lockfile
pnpm.cmd typecheck
pnpm.cmd build
pnpm.cmd test
pnpm.cmd test:e2e

$env:MNEMON_BINARY='D:\projects\MnemoWeave\work\tools\mnemon\mnemon.exe'
$env:MNEMON_DATA_DIR='D:\projects\MnemoWeave\work\dev-memory'
$env:MNEMON_STORE='development'
$env:MNEMOWEAVE_STATE_DIR='D:\projects\MnemoWeave\work\dev-state'
$env:MNEMOWEAVE_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:MNEMOWEAVE_OPERATOR_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
node apps/server/src/main.ts
```

MCP：`node apps/server/src/mcp-main.ts`，stdio，日志只写 stderr。构建产物可用 `node dist/apps/server/src/main.js`；尚未打包为独立发布物。

Bridge 进程（WP7 接线）：`node dist/apps/bridge/src/main.js`，环境变量 `MNEMOWEAVE_SERVER`（Server HTTP 地址）、`MNEMOWEAVE_TOKEN`（服务令牌）、`MNEMOWEAVE_BRIDGE_DIR`（绝对路径，副本/队列/快照暂存）、`MNEMOWEAVE_BRIDGE_HOST_ID`、可选 `MNEMOWEAVE_SYNC_INTERVAL_MS`（默认 30,000，SYNC-04）与 `MNEMOWEAVE_MIN_FREE_BYTES`。配对流程：操作员经 `POST /v1/sync/grant` 签发 → Bridge 下一次循环自动取回（AUTH-04）。本机冒烟已验证：进程启动 → HTTP 配对 → 初始快照同步 → 副本落地。本地注入端点默认监听 `127.0.0.1:4318`（`MNEMOWEAVE_BRIDGE_PORT`），令牌为 `MNEMOWEAVE_BRIDGE_TOKEN`（缺省沿用 `MNEMOWEAVE_TOKEN`，至少 24 字符）；Host 钩子设置 `MNEMOWEAVE_BRIDGE_URL` 与同一令牌后连接 Bridge，未设置时回退服务端 `/v1/view`。`POST /v1/inject` 由 Bridge 按会话持有注入控制器；View 优先用本地副本组装，副本不可用或未配对时回退服务端装配。

## 4. 目录与数据

| 路径 | 内容 |
|---|---|
| `<STATE_DIR>/governance.db` | 治理库（候选、审核、Task/Outbox/Receipt、版本目录、冲突、Session 事件、候选正文账本、复核计划） |
| `<STATE_DIR>/blobs` | 候选正文内容寻址文件（>4,096 字节）；随正文清理删除，未引用对象宽限回收 |
| `<STATE_DIR>/governance.db.pre-vN.<uuid>.db` | 迁移前一致快照 |
| `<MNEMON_DATA_DIR>` | Provider 自有存储；本系统不读取内部表 |
| `work/` | 本机工具、上游源码、测试隔离目录；被 `.gitignore` 排除 |

治理库绑定 Provider 数据目录与 Store；启动时身份不一致直接拒绝，防止把 Outbox 发到另一个后端。目录权限依赖操作系统用户级控制，数据库不额外加密。

## 5. 迁移

- 当前支持 schema v1–v9，启动时按顺序迁移；更高版本拒绝。
- v9 新增 `catalog_review_state`/`catalog_review_history`（KNOWLEDGE-01 复核计划、到期队列与完成记录）；按知识类型默认 30/90/180 天，到期只排队复核，不失效或隐藏。
- v8 新增 `sync_log`（有序变更流，与业务写入同事务追加）、`sync_grants`/`sync_license_state`（每 Host 配对凭据与撤权水位）——WP6 同步协议（第十八批已确认）。
- v7 把候选正文拆分到 `governance_candidate_bodies`（30 天清理只删正文行），新增 `session_events`/`session_event_refs`（HOST-03 事件归一、去重、保留周期）与 Revision 级 provenance 列。
- v1→v2 前用 `VACUUM INTO` 生成一致快照（含已提交 WAL）；其余版本迁移前同样快照。
- 迁移在事务内完成；失败回滚并保留快照。
- v3 迁移会把已有 `persisted` 回执回填为初始逻辑记忆与 Revision；身份或范围不明确的不猜测，交由人工登记。
- v6 把 Outbox 重建为无状态的入队账本（随 Task 推进，见 `state-machines-and-transactions.md`），并为 Task 增加重试观测列（`first_failed_at`、`alerted_at`）。
- 拒绝初始化无法识别内容的非空数据库。

## 6. 恢复与回退

1. 停止全部 Server、MCP 与 Worker 进程。
2. 保留当前 `governance.db`，不覆盖。
3. 选定快照，复制到**新的**状态目录并命名为 `governance.db`。
4. 将 `MNEMOWEAVE_STATE_DIR` 指向新目录后启动。
5. 用官方 `show` 与内容哈希核对正式记忆；快照只恢复治理数据，不回滚 Provider。

禁止：原地覆盖用户现有库、把快照当 Provider 回滚、在写入进行中恢复、用 `git` 或文件同步工具替代状态目录管理。

## 7. 诊断

- `GET /health/live`：进程存活。
- `GET /health/ready`：Provider 版本、状态与能力；失败返回错误码。
- stderr 结构化事件：`listening`、`configuration_invalid`、`listen_failed`、`mcp_start_failed`、`workflow_tick_failed`、HTTP 请求 `{traceId, operation, code}`。
- 响应头 `x-trace-id` 与错误体 `traceId` 可用于对应日志。
- 不记录正文、完整提示词、凭据或原始工具输出。

## 8. 部署形态

- Linux Server：单元文件 `apps/server/deploy/mnemoweave.service`（user unit）：`ExecStart=/usr/bin/node %h/mnemoweave/dist/apps/server/src/main.js`、`EnvironmentFile=%h/mnemoweave/apps/server/deploy/mnemoweave.env`、`Restart=on-failure`、`NoNewPrivileges`。诊断日志经 journald 按系统配置轮转（OPS-01 的 30 天由 journald 承担，应用只写 stderr）。
- 迁移演练：升级/回退按第 5、6 节在隔离状态目录演练；contract 迁移链测试覆盖 v1→v9 与 v2 回填。
- Linux Bridge：`systemd --user` 单元未交付；Windows Bridge：进程已实现，用户会话后台化未交付，需处理注销、锁屏与重启。
- Server 与 Mnemon 同机，经 CLI 调用；不暴露 Mnemon 私有 Web API。
- Worker 留在 Server 进程内，不单独部署。
- 保留清扫：Worker 在租约内按小时执行一次（无独立进程或 cron）。
- 容量：Server 默认软 10 GiB / 硬 20 GiB（`MNEMOWEAVE_QUOTA_SOFT_BYTES` / `MNEMOWEAVE_QUOTA_HARD_BYTES`），按治理库与 WAL 计量；Bridge 不设配额。`MNEMOWEAVE_MIN_FREE_BYTES` 仍是文件系统耗尽前的停止条件，二者分别检测。

## 9. 未决事项

- 生产 TLS、反向代理与远端访问模型。
- Linux Bridge 的 systemd 单元与 Windows 用户会话后台化；同步协议与进程已交付。
- 发布与版本号策略（当前全部包 `0.1.0`，无独立发布）。

## 2026-11-09 修复补充

本轮实际运行时、projectId 授权、逐 Host 凭据、capture 状态机、v10 迁移和同步一致性以 [runtime-memory.md](runtime-memory.md) 的实现细化及 [current-handoff.md](current-handoff.md) 的实测状态为准。旧章节的“已实现”不表示真实 Host 验收已完成；未决同步 Schema 和身份体系细节不因原型代码而冻结。
