# 同步协议

每台开发机的本机 Server 使用逐设备令牌连接远端同步 Server。宿主在本机完成注入和召回，已应用的本机副本在远端断开时仍可读取。

## 数据与范围

共享条目有稳定 `entryId`、`kind`、`scope`、`version`、`content`、`payload` 和 `withdrawnAt`。

| 类型 | 元数据 |
|---|---|
| `runtime` | 准则启用状态与适用范围 |
| `archive` | 标题、来源、验证状态、证据、标签 |
| `formal` | 分类、重要度、标签、实体、关系 |

范围为 `global` 或 `project:<projectId>`，全局准则使用 `global`。项目档案使用项目范围。授权、日志、序号、游标、快照和清理均按范围处理。项目快照的 `nextSince` 只更新该项目游标。

`content` 使用 `{format,data,contentHash,byteLength}`，支持协议格式 `plain` 和 `enc-v1`。远端的校验和快照处理依赖载荷哈希与长度。允许远端读取正文与否仍待决策。密文封装只覆盖正文，标题、证据、实体和关系等字段依然可见。

## 提交与版本

变更包含 `changeId`、`baseVersion`、`operation` 和全量目标条目。创建以 0 为基准，远端分配版本 1；更新或撤回须基于已确认版本。远端在事务中检查设备权限、幂等键、基准版本及范围，写入当前态、Revision、范围日志和回执。同一范围序号单调递增，条目版本独立递增。

正式记忆编辑和撤回按读取到的 `entryVersion` 提交。准则、档案表单也带读取时的版本。过期基准返回 `VERSION_CONFLICT`。正式记忆编辑、撤回和项目档案写入经远端确认后进入本机应用。准则通过 Outbox 提交，远端确认、排队或结果未知时可更新本机工作副本。注入读取本机启用的准则。

| 状态 | 含义与处理 |
|---|---|
| `SYNC_QUEUED` | 变更待推送，后续同步继续处理 |
| `SYNC_OUTCOME_UNKNOWN` | 提交可能已到达远端，或本机尚未确认应用；按 `changeId` 查询回执并核对本机账本 |
| `VERSION_CONFLICT` | 读取最新版本，对照草稿后重新提交 |
| `needs_review` | 数据、Provider 或回执核对失败，保留现场并由人工处理 |

## 拉取、应用与快照

本机先解析未知结果并推送 Outbox，再按可读范围增量拉取、写入 Inbox、依序应用。只对连续已应用记录推进游标。出现缺口、清理地板或落后过久时，按范围取得快照。快照由单一一致切点生成，包含准则和档案的当前态，以及正式记忆所需历史修订、关系、当前版本和撤回状态。全部应用完成后才推进该范围游标。

正式记忆按修订顺序在本机调用 `remember --no-diff`，以 `mnemoweave:<changeId>:<version>` 定位已写入的正文，核对内容、关系后更新 `formal_map` 和目录。每台机器的 Mnemon ID 独立。写入响应丢失时先定位并核对；无法确定结果时保留待处理记录。撤回移出当前召回，保留历史。

## 远端 HTTP

所有端点要求有效设备令牌。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v1/sync/changes` | 提交变更 |
| GET | `/v1/sync/changes?scope=&since=&limit=` | 增量拉取，页大小最多 500 |
| GET | `/v1/sync/receipts/{changeId}` | 查询幂等回执 |
| GET | `/v1/sync/entries/{entryId}` | 查询完整条目及修订 |
| GET | `/v1/sync/snapshot?scope=` | 读取范围快照 |
| GET | `/v1/sync/scopes` | 读取设备授权范围 |
| GET | `/v1/sync/health` | 探活与协议版本 |

本机按调用身份决定动作权限，远端按设备决定范围读写。远端保存设备令牌哈希并支持单设备撤销。设备管理使用 `apps/sync-server/src/enroll.ts` 命令入口，部署单元为 `apps/sync-server/deploy/mnemoweave-sync.service`。

在远端设置 `MNEMOWEAVE_SYNC_STATE_DIR` 后，从构建目录运行设备管理命令。新令牌只在签发时输出。

```text
node dist/apps/sync-server/src/enroll.js enroll dev-a global:rw project:alpha:rw
node dist/apps/sync-server/src/enroll.js revoke dev-a
```

## 配置与保留

本机 `MNEMOWEAVE_SYNC_URL`、`MNEMOWEAVE_SYNC_DEVICE_ID`、`MNEMOWEAVE_SYNC_TOKEN` 必须一并提供。三者均未配置时运行本机模式，部分配置拒绝启动。地址使用 HTTPS 或 loopback。轮询间隔 `MNEMOWEAVE_SYNC_INTERVAL_MS` 默认 300000 ms，0 停止周期调度；`MNEMOWEAVE_SYNC_TIMEOUT_MS` 默认 10000 ms。

远端使用 `MNEMOWEAVE_SYNC_HOST`、`MNEMOWEAVE_SYNC_PORT`、`MNEMOWEAVE_SYNC_STATE_DIR`。远端库 schema v2。默认每范围保留 90 天或 50000 条日志，回执独立保留 365 天，分别由 `MNEMOWEAVE_SYNC_RETENTION_DAYS`、`MNEMOWEAVE_SYNC_MAX_CHANGES` 和 `MNEMOWEAVE_SYNC_RECEIPT_DAYS` 配置。清理只移除日志前缀，过期回执返回 `CHANGE_ID_EXPIRED`，本机转人工处理。
