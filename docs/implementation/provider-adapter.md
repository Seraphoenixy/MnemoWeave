# Provider Adapter

状态：Mnemon CLI Adapter 为已实现事实；能力判定以 `../research/mnemon-capability-matrix.md` 的源码证据为准，运行验收只承诺 Mnemon 0.2.13（提交 `0025a66351263abec3b67ef5b4a6932adb80e5dd`）。

## 1. 端口

Application 定义、Adapter 实现：

| Port | 方法 | 用途 |
|---|---|---|
| `MemoryProvider` | `health`、`recall`、可选 `readMemory` | 读取、健康、按 ID 取正文 |
| `WriteProvider` | `inspectExact`、`verifyContent`、`persistReviewed`、`recall`、`health` | 写入、去重查找、写后核对 |
| `VersionProvider` | 以上 + `readMemory`、`linkSupersedes` | 版本基线与原生 Supersedes 投影 |

Provider 不得自行寻找模型、不得读取内部数据库、不得在失败时降级为其它后端。

## 2. 进程调用规则

- 二进制必须是绝对路径；`execFile`、`shell:false`、`windowsHide:true`。
- 单次超时 15 秒；stdout 上限 2 MiB；超时错误映射 `PROVIDER_TIMEOUT`，其它非零退出映射 `PROVIDER_UNAVAILABLE`。
- 每个子进程注入 `MNEMON_MAX_INSIGHTS=0`，关闭其自动容量清理。
- 参数数组形式：`--data-dir <abs> --store <safe>`；store 名只允许 `[a-zA-Z0-9_-]+`。
- 每次调用先执行 `--version`，必须精确等于 `mnemon version 0.2.13`，否则 `UNSUPPORTED_VERSION`。
- 同一 Adapter 实例上的调用串行排队；跨进程并发不由本层保证。
- stderr 不进入响应、不记录正文或路径。

## 3. 命令与 JSON 契约

| 操作 | 命令 | 期望 JSON |
|---|---|---|
| 健康 | `status` | `{ total_insights: number }` |
| 检索 | `recall --limit <n> -- <query>` | `{ results: [{ id, content, score, superseded? }] }` |
| 有界精确查找 | `recall --basic --limit 200 -- <content>` | `[{ id, content }]` 或 `null` |
| 读取 | `show -- <id>` | `{ id, content }` |
| 写入 | `remember --source mnemoweave:<writeKey> -- <content>` | `{ id, action:'added' }` 或 `{ id, action:'skipped', replaced_id }` |
| 原生关系 | `link <src> <tgt> --type supersedes --meta <json>` | `{ status:'linked', source_id, target_id, edge_type:'supersedes', metadata }` |

结构不符一律 `PROVIDER_PROTOCOL`；不得猜测兼容形态。

## 4. 去重与物理 ID

- `action=skipped` 表示已存在完全重复内容，正式记忆 ID 为 `replaced_id`；`id` 是本次尝试 ID，不得当作正式 ID。
- 缺少 `replaced_id` 的 skipped 响应视为协议错误。
- `replaced_id` 只能用于定位已有记忆；不能当作本次写入成功的回执。
- 一个物理 ID 可被多个逻辑记忆引用，见 `domain-and-data-ownership.md` 第 5 节。

## 5. 精确核对

`inspectExact`：

- 只使用官方 `recall --basic`，上限 200 行，随后按内容严格相等过滤。
- 上游使用 SQL LIKE，`%`/`_` 具有通配语义；因此结果必须再过滤，不能直接信任。
- 返回 `{ matches, complete }`；达到 200 行即 `complete=false`。
- `complete=false` 不能推断“不存在”，不能据此授权重发写入。

`verifyContent`：按 ID 执行 `show`，要求返回 ID 与全文完全一致；这是写入成功的核对条件。

## 6. 写入键与幂等

- 稳定写入键：`candidate:<candidate UUID>`，随 Task 持久化。
- 传给 Mnemon 的形式：`--source mnemoweave:candidate:<UUID>`。
- 该标记用于对账与来源识别，不是 Provider 原生 exactly-once 承诺；不能据此声称跨进程全局唯一。
- 重复 Remember 的去重由 Provider 决定；MnemoWeave 只按 `action` 与 `replaced_id` 解释结果。

## 7. Supersedes 投影

- 方向：`link NEW OLD`，`NEW` 为替代者。
- 回执必须逐字段核对 `source_id`、`target_id`、`edge_type`、`metadata`；不一致视为协议错误。
- 相同源/目标/类型的重复 link 是逻辑 upsert，不新增边；创建时间可能变化，因此业务生效时间以计划为准。
- `related --edge supersedes` 会遍历两端邻接，不能证明方向；不得作为方向性读取接口。
- 未发现官方 unlink；失败补偿只能前向恢复或人工处理。
- 投影前置条件不满足（目标物理 ID 被多个逻辑记忆引用、源 ID 已被其它 Revision 占用、其它 staged 操作用到同一物理 ID）→ `REVIEW_REQUIRED`，不得静默降级为 semantic。

## 8. 能力边界

只声明并使用以下能力：`health`、`recall`、`remember`，以及适配器内部的 `show`、`inspectExact`、`verifyContent`、`linkSupersedes`。

不提供、也不假设：

- 通用内容更新、版本历史、当前指针、变更流、删除传播。
- 原生 MCP Server 或通用远端 HTTP 写接口。
- 正式 FTS/向量检索保证（Embedding 为可选上游能力，本轮未验收质量）。
- 多进程并发安全保证；同一活跃库不得随意 `immutable --readonly`。

## 9. 版本固定与升级

- 当前只接受 0.2.13；其它版本明确拒绝，不静默放宽。
- 升级流程（Proposed，需用户确认后执行）：更新二进制 → 校验 SHA256 → 重跑 Contract 与真实 E2E → 更新 `../research/mnemon-capability-matrix.md` 证据 → 更新版本常量与能力声明 → 记录决策。
- 升级前必须确认：`remember` 去重语义、`recall` 输出结构、`link` 回执字段、`status` 字段、自动清理开关是否仍存在。
- 不得用 README 功能描述替代源码核查。

## 10. 已知限制

- 每次调用都先跑一次 `--version`，开销固定；批量读取时需评估。
- 串行队列使单实例吞吐受限；未来 Bridge 或多进程场景必须单独验证并发。
- `inspectExact` 的 200 行上限是硬边界；大批量写入场景需要更可靠的定位方式（上游未提供）。
- 原始 `recall` 默认可能更新访问计数与操作日志，不是纯读。
