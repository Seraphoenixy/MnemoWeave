# 服务器同步与部署

MnemoWeave 提供独立 HTTP 同步服务（`dist/mnemo-weave-sync-server.js`），基于 SRP-6a（PAKE）双向认证与 SQLite 变更日志，支持在多台主机之间同步共享工作准则、全局/自定义数据目录、工作区记忆与记忆活动记录。

<a id="ops-服务器同步"></a>

## Linux 同步服务部署

### 获取构建产物

- **GitHub Actions**：手动运行 **Build Linux Sync Server** 工作流，或推送 `v*` 标签，可生成 `MnemoWeave-linux-server`（`tar.gz`），内含 Linux x86_64 Node.js 24、同步服务产物、启动脚本（`start.sh`）与 systemd 单元（`mnemoweave-sync.service`）。运行环境需 glibc `>= 2.28`。
- **本地构建**：运行 `pnpm build` 后，可将 `dist/mnemo-weave-sync-server.js` 单独复制到服务器并重命名为 `.mjs` 后缀（打包产物已内联运行依赖 `@swan-io/srp`、`jsbn`、`zod`），使用 Node.js 24 运行。

### 初始化认证与启动（systemd）

以下命令在部署目录可访问的 Bash 环境中执行（systemd 单元默认使用 `/usr/bin/node` 与 systemd `>= 247`；使用发行归档时，将以下 Node 命令替换为 `/opt/mnemoweave/start.sh --init-auth` 并安装 `/opt/mnemoweave/mnemoweave-sync.service`）：

```bash
sudo install -d -m 0755 /opt/mnemoweave
sudo install -m 0644 dist/mnemo-weave-sync-server.js /opt/mnemoweave/mnemo-weave-sync-server.mjs
sudo install -d -m 0700 /etc/mnemoweave-sync
sudo -v
read -rs -p 'Sync password: ' sync_password
printf '\n'
printf '%s' "$sync_password" | sudo env MNEMOWEAVE_SYNC_AUTH_FILE=/etc/mnemoweave-sync/auth.json \
  /usr/bin/node /opt/mnemoweave/mnemo-weave-sync-server.mjs --init-auth
unset sync_password
sudo install -m 0644 deploy/linux/mnemoweave-sync.service /etc/systemd/system/mnemoweave-sync.service
sudo systemctl daemon-reload
sudo systemctl enable --now mnemoweave-sync
curl -f http://127.0.0.1:4319/health
```

### 环境变量与口令管理

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MNEMOWEAVE_SYNC_PORT` | `4319` | 服务监听端口（固定绑定 `127.0.0.1`） |
| `MNEMOWEAVE_SYNC_DATA_DIR` | `./mnemo-sync-data`（systemd 为 `/var/lib/mnemoweave-sync`） | SQLite 数据库（`sync.sqlite`）存储目录 |
| `MNEMOWEAVE_SYNC_AUTH_FILE` | `<dataDir>/auth.json` | SRP-6a 验证记录路径（systemd 通过 `LoadCredential=` 注入） |

- `--init-auth` 从标准输入读取 8–1024 个 UTF-8 字节的单行同步口令，生成权限 `0600` 的验证记录；目标文件已存在时拒绝覆盖。轮换口令时需生成到新路径，替换验证记录后重启服务。
- 服务仅监听 `127.0.0.1`。跨机器访问需配置 HTTPS 反向代理转发认证与同步路径，并允许至少 8 MiB 请求体；客户端仅对本机回环地址允许明文 HTTP。
- 备份数据库时使用 SQLite 在线备份，或停止服务后复制数据目录。

---

## 同步协议与 HTTP 接口

### SRP-6a（PAKE）认证

1. 客户端向 `POST /v1/auth/login/challenge` 发送 SRP-6a 临时公钥，取得 `challengeId`、`salt` 与 `serverPublic`。
2. 客户端向 `POST /v1/auth/login/verify` 提交 `challengeId` 与 `clientProof`，验证服务端返回的 `serverProof`，并获得 Bearer 会话令牌。
3. 服务端持久化的 `auth.json` 仅包含版本、盐与验证值；运行中的会话令牌以 SHA-256 摘要保存在内存中。

### HTTP 端点契约

| 方法与路径 | 认证 | 限额与行为 |
|---|---|---|
| `GET /health` | 无 | 返回 `{"status":"ok"}` |
| `POST /v1/auth/login/challenge` | 无 | 请求体上限 2048 字节；每分钟最多 60 次挑战，超限返回 HTTP 429 与 `Retry-After: 60`；挑战一次有效，60 秒过期 |
| `POST /v1/auth/login/verify` | 无 | 请求体上限 2048 字节；令牌有效期 30 分钟，最多保留 256 个活跃会话，服务重启后失效 |
| `GET /v1/sync/<scope>/changes?cursor=N` | Bearer | 分页读取变更日志，单页最多 128 个批次；客户端处理完一页后更新游标 |
| `POST /v1/sync/<scope>/changes` | Bearer | 请求体上限 8 MiB；单批最多 1024 条变更，单批内每个 `key` 唯一；以 `requestId` 与 `baseCursor` 事务提交，重复 `requestId` 返回原游标，基准过期返回 HTTP 409 与当前游标 |
| `HEAD /v1/sync/<scope>/blobs/<digest>` | Bearer | 检查 SHA-256 数据块是否存在；活动范围（`activity-*`）返回 HTTP 404 |
| `GET /v1/sync/<scope>/blobs/<digest>` | Bearer | 读取数据块原始内容（`application/octet-stream`） |
| `PUT /v1/sync/<scope>/blobs/<digest>` | Bearer | 单文件上限 128 MiB；写入前校验字节流 SHA-256 与路径摘要一致 |

---

## 增量文件块与清单同步

- **清单发布**：每个记忆范围的内容按文件同步。客户端上传变化文件的数据块后，提交包含文件列表（路径与 SHA-256）及确定性归档总摘要的清单批次。
- **增量拉取**：接收方比对本地文件与远端清单，仅下载内容不同的文件，在本地按固定顺序与时间戳重新组装归档并校验总摘要，随后在 Source 写锁内确认本地内容未发生并发变更后再替换。
- **单范围上限**：最多 `4096` 个文件、归档压缩上限 `48 MiB`、单文件上限 `128 MiB`。
- **数据块回收**：服务端仅保留最新清单引用的文件，被替换的文件在宽限期后清理。

---

## 同步范围与合并规则

| 范围类型 | 合并方式 | 冲突处理 |
|---|---|---|
| **独立工作区（`workspace` / `workspaces`）** | 按 DSH 登记工作区名称匹配，执行同名等价并集合并 | 工作准则按目标与正文合并；档案按内容合并；记忆空间按条目合并；结果规范化后字节一致 |
| **共享数据目录（`global` / `custom`）与全局工作准则** | 整份快照替换 | 两边同时改动时暂停同步并标记 `conflictTarget`，需在设置页或 `sync-all` 传入 `resolve: "server" \| "local"`、`conflictToken` 与 `confirmed: true` |
| **记忆活动流（工作区与工作准则）** | 按不可变事件 ID 追加并集 | 仅允许“清空事件”在同一事务内缩短服务端活动流（见[记忆活动记录与同步](memory-activity.md)） |

- 档案记录中的本机工作区路径不进入快照，拉取后按本机工作区路径重新标注。
- 未包含在同步范围内的本地状态：技能管理目录（`skills/`）、审查账本（`state/review-ledger.json`）、机器标识（`state/machine.json`）、空闲审查配额（`state/idle-review/`）与本地溢出归档（`runtime/archived/`）。

---

## 客户端接入与运行行为

### DSH 客户端

- **连接配置**：在 **记忆系统 → 设置 → 存储 → 服务器同步** 填写地址与口令并点击 **验证并保存**（口令存入 DSH 凭据库），或设置宿主环境变量 `MNEMOWEAVE_SYNC_URL` 与 `MNEMOWEAVE_SYNC_PASSWORD`（已保存的连接优先）。
- **手动与自动同步**：点击 **同步全部** 或工作台顶栏同步状态指示触发同步。`autoSync.enabled` 默认开启，按 `autoSync.intervalMs`（可选 5 / 15 / 30 / 60 分钟）在一次运行结束后计时。手动与自动同步共用同一把进程锁，冲突暂停时定时器暂停，其余失败按间隔重试。
- **超时与重试**：单次同步拥有独立 `600` 秒宿主预算，不因页面关闭或刷新中止。单个请求遇到连接超时、连接拒绝、中断或 DNS 解析失败时最多重试 3 次（间隔 400 毫秒、1.2 秒）；冲突、认证失败、摘要不匹配与分页不连续不重试。
- **运行日志**：每次同步在运行日志中记录开始、结束与实际变化范围；无变化范围按记忆范围与活动记录分别汇总为单行。

### MCP 客户端（Codex）

- MCP 进程读取环境变量 `MNEMOWEAVE_SYNC_URL` 与 `MNEMOWEAVE_SYNC_PASSWORD`（兼容 `MNEMOWEAVE_SYNC_TOKEN`），在每次调用 `mnemo_working_rules` 与 `mnemo_runtime_memory` 时同步共享工作准则及工作准则活动流。
- 同步服务不可达时，本地读写正常提交，工具返回体附带 `sync: { synchronized: false, message }` 说明原因，连接恢复后下一次读写自动同步。
