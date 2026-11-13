# 同步协议

本文定义同步协议 2，远端同步库使用 schema v4。交付状态见 [当前状态](status.md)，术语见 [架构](architecture.md#统一术语)。

每台开发机的本机 Server 使用逐设备令牌连接远端同步 Server。宿主在本机完成注入和召回，已应用的本机副本在远端断开时仍可读取。

## 同步流与条目

同步流是日志、序号、游标、快照和清理的单位。协议 2 使用 `stream` 作为同步流的字段名。

| 条目类型 `kind` | 同步流 `stream` | 条目元数据 |
|---|---|---|
| `rule` | `rules` | 准则启用状态 |
| `formal-memory` | `formal-memories` | 分类、重要度、标签、实体、关系 |
| `workspace-archive` | `workspace-archives:<workspaceId>` | 工作区 ID、标题、来源、验证状态、证据、标签、归档状态与时间 |

条目信封包含 `entryId`、`kind`、`content`、`payload`、`withdrawnAt`。远端响应再包含 `version`。仅工作区档案的 `payload` 必须含 `workspaceId`。写入端和远端按表从 `kind` 和工作区档案的 `payload.workspaceId` 派生同步流。POST 写入条目不接收 `scope`、`stream` 或客户端指定的 `version`。准则和正式记忆载荷不接收 `workspaceId`。未知字段、类型和同步流 ID 返回 `INVALID_INPUT`。

增量拉取和快照显式指定同步流。增量响应与快照在外层返回 `stream`，条目不重复返回。应用前校验每条记录派生的同步流等于外层 `stream`。快照的 `nextSince` 只更新该同步流的游标。已认证设备可读写整个同步库。

准则新增和编辑在远端确认版本前，以事务内的最新集合和正文 UTF-8 字节长度检查容量。超过上限返回 `RULE_CAPACITY_EXCEEDED`，不生成版本或同步日志。本机应用入站记录时复核容量，不自动归档或压缩准则。设备使用一致的准则容量配置。JSON 请求上限见 [容量与维护](implementation.md#容量与维护)。远端在同一提交事务内按工作区校验活跃档案正文容量，超限返回 `ARCHIVE_CAPACITY_EXCEEDED`，不生成版本。归档和恢复由远端确认条目版本及状态，归档时间取远端确认时间。设备应用已确认的状态，不因本机容量或接收顺序独立归档。参见 [容量维护](implementation.md#工作区档案容量维护)。

`content` 使用 `{format,data,contentHash,byteLength}`，支持协议格式 `plain` 和 `enc-v1`。远端的校验和快照处理依赖载荷哈希与长度。允许远端读取正文与否仍待决策。密文封装只覆盖正文，标题、证据、实体和关系等字段依然可见。

档案提炼生成的正式记忆按普通正式记忆同步，来源档案元数据和用户确认事件只保留在发起端治理库。归档档案不生成正式记忆索引。

## 提交与版本

变更包含 `changeId`、`baseVersion`、`operation` 和全量目标条目。创建以 0 为基准，远端分配版本 1；更新或撤回须基于已确认版本。远端在事务中检查设备权限、幂等键、基准版本及派生同步流，写入当前态、修订、同步流日志和回执。同一同步流的序号单调递增，条目版本独立递增。

启用同步时，正式记忆新增在远端事务内按当前有效条目的 `contentHash` 和 `byteLength` 做并发查重。匹配时按逻辑 ID 字典序选择第一条，在原 `changeId` 下保存重复回执，返回该条目的 ID 和版本。回执的 `seq=0` 表示没有产生新日志序号。普通提交的回执包含 `confirmedAt`，用于本机应用远端确认时间。发起端在本机应用或取得该条目并核对正文后才返回 `duplicate`。本机模式在单一发布临界区内完成同样的比较与提交。此规则用于当前 `plain` 封装。启用密文前须确定能保留查重语义的协议，客户端收到 `enc-v1` 转 `needs_review`。

正式记忆编辑和撤回按读取到的 `entryVersion` 提交。准则、档案表单也带读取时的版本。过期基准返回 `VERSION_CONFLICT`。正式记忆新增、编辑、撤回和工作区档案写入经远端确认后进入本机应用。正式记忆只有远端确认且本机应用完成才返回发布成功。准则通过 Outbox 提交。排队或结果未知时保留原本机有效集合，确认并应用后再更新常驻内容。

| 状态 | 含义与处理 |
|---|---|
| `SYNC_QUEUED` | 变更待推送，后续同步继续处理 |
| `SYNC_OUTCOME_UNKNOWN` | 提交可能已到达远端，或本机尚未确认应用；按 `changeId` 查询回执并核对本机账本 |
| `VERSION_CONFLICT` | 读取最新版本，对照草稿后重新提交 |
| `needs_review` | 数据、Provider 或回执核对失败，保留现场并由人工处理 |

## 拉取、应用与快照

本机先解析未知结果并推送 Outbox，再按可读同步流增量拉取、写入 Inbox、依序应用。只对连续已应用记录推进游标。出现缺口、清理地板或落后过久时，按同步流取得快照。快照以单一一致切点生成，只包含请求流的条目。正式记忆快照还包含其历史修订、关系和撤回状态。本机先把快照投影写入暂存状态，此时客户端继续读取上一份已应用状态。校验整个快照、正文、关系和映射后，在一次本机事务内切换该流的可见目录或工作副本，并推进游标。新写入 Provider 的记录在切换前不得通过逻辑 ID 或召回暴露。失败时保留旧状态和游标，重试复用已核对的 Provider 写入。首次安装无旧状态时报告该流尚未就绪。

正式记忆按修订顺序在本机调用 `remember --no-diff`，以 `mnemoweave:<changeId>:<version>` 定位已写入的正文，核对内容、关系后更新 `formal_map` 和目录。每台机器的 Mnemon ID 独立。写入响应丢失时先定位并核对；无法确定结果时保留待处理记录。撤回移出当前召回，保留历史。

## 远端 HTTP

同步数据端点要求有效设备令牌。除探活外，同步数据请求须携带 `x-mnemoweave-sync-protocol: 2`。协议缺失或不匹配时返回 HTTP 409 和 `SYNC_PROTOCOL_MISMATCH`。本机发现远端协议版本不匹配时停用同步并报告该错误。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v1/sync/changes` | 提交变更 |
| GET | `/v1/sync/changes?stream=&since=&limit=` | 增量拉取，页大小最多 500 |
| GET | `/v1/sync/receipts/{changeId}` | 查询幂等回执 |
| GET | `/v1/sync/entries/{entryId}` | 查询完整条目及修订 |
| GET | `/v1/sync/snapshot?stream=` | 读取同步流快照 |
| GET | `/v1/sync/streams` | 发现当前同步流 |
| GET | `/v1/sync/health` | 探活与协议版本 |

本机按调用身份决定动作权限。远端通过设备 Bearer 令牌认证，已登记且未撤销的设备可读写整个同步库。同步流各自维护序号、游标和快照。设备令牌哈希持久化，支持单设备撤销。远端 schema v3→v4 保留设备和撤销状态，移除旧同步流授权表。旧令牌升级后可访问整个同步库，升级前应清点现有设备并撤销不再信任的设备。

首次初始化、SRP-6a 登录及一次性配对使用以下端点。路径均以 `/v1/sync` 为前缀。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/auth/config` | 读取初始化状态、SRP 与 KDF 参数 |
| POST | `/devices/initialize` | 用部署时的引导令牌初始化 SRP 验证器并签发首个设备令牌 |
| POST | `/auth/login/challenge` | 获取五分钟有效的一次性 SRP 挑战 |
| POST | `/auth/login/verify` | 验证客户端证明，返回服务端证明和设备令牌 |
| POST | `/devices/pairing-token` | 已认证设备签发五分钟有效的配对令牌 |
| POST | `/devices/pair` | 消耗一次性配对令牌，签发设备令牌 |

在远端服务环境中设置随机的 `MNEMOWEAVE_SYNC_BOOTSTRAP_TOKEN`（至少 32 字符）以启用首次初始化。成功后可以从服务环境删除该引导令牌。SRP 验证器保存在远端，主密码由本机使用。Windows 本机以计划任务运行用户执行下列命令，并设置 `MNEMOWEAVE_STATE_DIR` 为计划任务使用的状态目录。密码和配对令牌由命令交互读取。命令在验证 `/streams` 后使用 Windows DPAPI 保存设备凭据，重启本机 Server 后生效。

```powershell
node dist/apps/server/src/sync-enroll.js initialize https://sync.example.com dev-a
node dist/apps/server/src/sync-enroll.js login https://sync.example.com dev-b
node dist/apps/server/src/sync-enroll.js pairing-token
node dist/apps/server/src/sync-enroll.js pair https://sync.example.com dev-c
```

登记成功后 Windows 命令显示设备 ID。远端管理命令使用 `MNEMOWEAVE_SYNC_STATE_DIR`，设备清单显示 ID、标签、登记时间与撤销时间。

```bash
node dist/apps/sync-server/src/enroll.js enroll dev-a
node dist/apps/sync-server/src/enroll.js list
node dist/apps/sync-server/src/enroll.js revoke dev-a
```

本机与远端需成套更新，以识别带 `confirmedAt` 的回执和 `seq=0` 的同文回执。迁移过的流在游标 0 的拉取响应中返回 `snapshotAtStart`。本机首次读取该流时先应用快照，以取得旧日志清除前已经存在的条目。

## 配置与保留

本机 `MNEMOWEAVE_SYNC_URL`、`MNEMOWEAVE_SYNC_DEVICE_ID`、`MNEMOWEAVE_SYNC_TOKEN` 必须一并提供。三者均未配置时读取本机 DPAPI 凭据，凭据缺失时运行本机模式。部分环境配置拒绝启动。跨机地址必须使用 HTTPS；HTTP 仅允许回环 IP 地址。同步客户端拒绝重定向。轮询间隔 `MNEMOWEAVE_SYNC_INTERVAL_MS` 默认 300000 ms，0 停止周期调度；`MNEMOWEAVE_SYNC_TIMEOUT_MS` 默认 10000 ms。

本机和远端使用相同的 `MNEMOWEAVE_RULE_CAPACITY_BYTES` 与 `MNEMOWEAVE_ARCHIVE_ACTIVE_CAPACITY_BYTES`。旧项目切换时两端均使用 `MNEMOWEAVE_LEGACY_WORKSPACE_MAP` 指向对照表文件。

远端使用 `MNEMOWEAVE_SYNC_HOST`、`MNEMOWEAVE_SYNC_PORT`、`MNEMOWEAVE_SYNC_STATE_DIR`。默认每个同步流保留 90 天或 50000 条日志，回执独立保留 365 天，分别由 `MNEMOWEAVE_SYNC_RETENTION_DAYS`、`MNEMOWEAVE_SYNC_MAX_CHANGES` 和 `MNEMOWEAVE_SYNC_RECEIPT_DAYS` 配置。清理只移除日志前缀，过期回执返回 `CHANGE_ID_EXPIRED`，本机转人工处理。

主密码登记按来源 IP 限制 SRP 挑战签发，每 30 秒最多 10 次，同时最多保留 10 个未消费挑战。经 TLS 反向代理部署时，将 `MNEMOWEAVE_SYNC_ENROLLMENT_PROXY_IP` 设为代理连接 Server 时使用的源 IP，并让代理用实际客户端 IP 覆盖 `X-Real-IP`。Server 只从该代理地址读取此请求头，其他连接使用 TCP 对端地址。
