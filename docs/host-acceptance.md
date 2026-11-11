# Host 接入与验收

目标 Host 为 **DSH、ChatGPT 桌面、ZCode**。三个插件都通过 `packages/client` 直连**本机** Server，统一用服务令牌和 `x-mnemoweave-host` 头；没有 Bridge、没有配对。本机 Server 持有已同步副本，远端同步凭据不进入任何宿主环境（见 `sync.md`）。

验收判据：任一必需 Host 的真实会话未完成，首版不得标记完成。程序化契约测试与钩子子进程冒烟不能替代真实桌面会话。

## 1. 现状总览

| Host | 适配器代码 | 真实会话验收 | 阻塞 |
|---|---|---|---|
| ZCode Desktop | `packages/adapters/zcode`（钩子归一、注入、配置生成） | 未执行 | 无专用 `session.ended` 事件（结构性登记）；真实会话待用户运行 |
| ChatGPT 桌面 | `packages/adapters/chatgpt`（local-only command hooks、配置生成） | 未执行 | 仅支持文档允许的本地模式；桌面真实会话与工具输出变体未验证 |
| DSH | 界面与注入都在插件 `plugins/dsh-mnemo-weave` 内（`mnemo-weave` 注入条目、`mnemo-weave-ui` 界面条目）；`packages/adapters/dsh` 仅保留 `DSH_HOST_FACTS`（`status: 'blocked'`），不影响插件运行 | 界面：2026-11-10 真实点击与编辑通过；注入：2026-11-10 新会话在 Server 端留下注入记录（准则 1 条） | 提示文本级效果仍需用户在新会话里观察；`packages/adapters/dsh` 作为独立适配器仍无实现 |

共同前提：本机有可用的 MnemoWeave Server 与 Mnemon 0.2.13；令牌不写入插件，钩子从环境变量读取 `MNEMOWEAVE_TOKEN`。

## 2. 通用准备

```powershell
Set-Location D:/project/MnemoWeave
node node_modules/typescript/bin/tsc   # 构建 dist/
```

启动 Server（隔离目录、专用 Store，不接触用户默认记忆目录）：

```powershell
$env:MNEMOWEAVE_SERVER='http://127.0.0.1:4317'
$env:MNEMOWEAVE_HOST_ID='zcode-host'
$env:MNEMON_DATA_DIR='D:/project/MnemoWeave/work/host-memory'
$env:MNEMON_STORE='hostcheck'
$env:MNEMOWEAVE_STATE_DIR='D:/project/MnemoWeave/work/host-state'
$env:MNEMOWEAVE_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:MNEMOWEAVE_OPERATOR_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
node dist/apps/server/src/main.js
```

`MNEMON_BINARY` 可省略（默认用 PATH 上的 `mnemon`）；如需指定路径再设置。宿主用同一个 `MNEMOWEAVE_TOKEN` 直连，不需要签发凭据；编辑与撤回也不需要 operator 令牌（个人项目），`MNEMOWEAVE_OPERATOR_TOKEN` 只在调用管理端点时使用，不进入宿主环境。

项目 ID 需显式登记（`POST /v1/runtime/projects`，operator），或直接不传 `projectId`（此时会话上下文不绑定项目）。

## 3. ZCode

已核验（本机 3.17.2.9661，Windows 10.0.19045）：

| 能力 | 状态 |
|---|---|
| 钩子事件 | SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop（需 `hooks.enabled: true`） |
| 自动注入 | `additionalContext` 写入会话上下文 |
| MCP 工具 | `mcp.servers` 用户级与工作区级，会话启动自动连接 |
| 助手最终答复 | Stop 钩子 stdin 携带 `last_assistant_message`，映射为 `message.assistant.final` |

验收步骤：

```powershell
# ① 安装钩子与 MCP 配置到将运行真实会话的工作区
node dist/tests/support/zcode-acceptance-setup.js <工作区目录> http://127.0.0.1:4317 <MNEMOWEAVE_TOKEN> zcode-host

# ② 为桌面会话准备环境（钩子子进程继承用户环境）
[Environment]::SetEnvironmentVariable('MNEMOWEAVE_SERVER','http://127.0.0.1:4317','User')
[Environment]::SetEnvironmentVariable('MNEMOWEAVE_TOKEN','<TOKEN>','User')
[Environment]::SetEnvironmentVariable('MNEMOWEAVE_HOST_ID','zcode-host','User')

# ③ 启动真实 ZCode 会话，执行带工具调用的任务后结束

# ④ 采集脱敏证据
node dist/tests/support/zcode-acceptance-collect.js <MNEMOWEAVE_STATE_DIR 绝对路径> zcode-host
```

采集点：会话开始/用户消息时若召回命中，回复上下文含注入块；未命中时钩子静默，不阻断（HOST-04）。能力声明 `zcodeDescriptor` 在真实会话验证前保持 `unverified`。

已知缺口：ZCode 没有专用会话结束事件（Stop 按轮触发），登记为结构性缺口，不得用 Stop 冒充。

## 4. ChatGPT 桌面

- 只面向官方文档允许的**本地模式**：`SessionStart`、`UserPromptSubmit`、`PostToolUse`、`Stop`、`SessionEnd` 五个 command hooks；注入走 `hookSpecificOutput.additionalContext`。
- 插件清单是 `.codex-plugin/plugin.json`（OpenAI 插件格式规定的清单目录），钩子命令与 MCP 路径用插件运行时提供的 `${PLUGIN_ROOT}` 解析。
- `PostToolUse` 缺少 `isError`/`exit_code` 结构时抛 `REVIEW_REQUIRED`，不对未知工具输出猜成功。
- 配置生成器 `tests/support/chatgpt-acceptance-setup.ts` 只生成项目 `work/` 下的产物，不修改用户配置。

未验收：桌面真实会话、工具输出变体、`SessionEnd` 语义。

## 5. DSH

- 桌面应用已安装（0.2.2-rc.1），CLI 位于 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。
- **记忆界面**已作为插件装入 desktop profile：条目 `mnemo-weave-ui` 直连 Server（`serverUrl` + `token` + `hostId`），可列出、查看并**直接编辑**正式记忆；状态行显示本宿主最近一次注入（准则/记忆条数与 token，预算省略时标注）。两条目当前均为 `active`。
- **真实点击验收已于 2026-11-10 完成**：在运行中的桌面打开记忆页、列出 2 条记忆、编辑项目记忆并保存；服务端核对到正文一致、`entryVersion` 1 → 2、新增 v2 映射与第 3 个 Revision、Mnemon 正文逐字一致、supersedes 指向前一版。证据记在 `dsh-ui.md` 第 7 节。
- **注入条目**（`dsh-mnemo-weave`）在真实会话中已运行：2026-11-10 新建会话后，Server 记录到一条 `hostId dsh`、会话 id 为新会话的注入记录（`rulesInjected 1`）。注入内容按 `Runtime rules → Working context → Formal memories` 渲染，准则因预算省略时写明原因；文本级效果（模型是否按准则行动）仍由用户在新会话中观察后记录。
- **独立注入适配器**（`packages/adapters/dsh`）仍是阻塞记录：只有 `DSH_HOST_FACTS` 常量。它是面向 DSH SDK 的独立实现，与插件内的注入条目不是同一件事。
- 参考材料只能来自官方接口或已安装产物；不得用第三方插件的私有 RPC 虚构 SDK。

## 6. 准则注入验收（目标态）

方案要求宿主在模型行动前拿到当前项目适用的准则。`View` 的准则段与注入报告已经实现，验收在三个宿主上按同一张表执行，逐项记录，不合并结论。

先在本机 Server 上准备：登记项目 `alpha`，创建一条全局准则与一条项目准则，然后用任一宿主令牌请求 `POST /v1/view`（带 `x-mnemoweave-project: alpha`）确认返回 `rules` 两条、`rulesBudget` 未超限——这是宿主应看到的同一份数据。

| 检查 | 方法 | 判据 |
|---|---|---|
| 送达 | 三个 Host 各发起一轮带工具调用的任务，检查注入块是否含当前项目准则 | 准则出现在模型可见的同一轮上下文里 |
| 耗时 | 记录 `/v1/inject` 往返与本机组装耗时（远端不参与注入） | 不超过 2 秒截止；超时按现有规则静默不阻断 |
| 范围匹配 | 同时登记全局准则与项目准则，在另一项目会话中检查 | 两者分别匹配，跨项目不泄漏 |
| 完整性 | 登记一条接近预算上限的准则后再新增一条，检查是拒绝启用还是截断 | 超预算拒绝启用，已有准则正文保持完整 |
| 可见性 | 打开 DSH 记忆页，读状态行的「最近注入」格 | 条数与 token 与 `/v1/injections/latest`（宿主令牌 + Host 头）一致；预算省略时该格转为警示并标注 |

记录格式：每个 Host 一段，写明日期、Host 版本、执行人、每项的实际观察与结论（通过 / 未通过 / 未执行）。未执行的项不得写成通过。
| 可见状态 | 断开 Server 或让注入超过 2 秒，检查界面是否显示「本轮未注入」 | 未注入有可见提示，不静默 |
| 执行控制 | 观察宿主是否拦截违规操作 | 单独记录为未实现，不因注入送达而改判 |

准则送达不等于宿主能拦截违规操作，这两项分别验收。

## 7. 事件与注入约束（对所有 Host）

- 事件信封统一为 `HostEvent`，`eventId` 去重、`sessionId` 关联；会话结束不得伪造。
- 注入必须单调 2 秒截止：超时静默不阻断宿主回合，且不重复召回。
- 迟到结果只能作为后续 View，不得覆盖已结束回合。
- 注入预算 4096 token；View 递归冻结，来源/版本/上下文封装纳入预算。
- 断网时宿主仍可使用本机已同步的副本；共享编辑离线只能排队，不能确认（`sync.md` 第 7 节）。该能力随同步落地，当前实现仍是直连。

## 8. 验收记录要求

每条记录需包含：产品与版本、平台、配置作用域、能力清单（状态 + 证据）、场景清单结果、阻塞项与解除条件。未验证的能力标 `unverified`，不得因"代码已实现"改标 `supported`。

## 5.1 记忆页逐页签验收矩阵（2026-11-11）

2026-11-10 的点击验收只覆盖了「列出 + 编辑」两条路径；此后页面增至九个页签，实体、探索、图谱、撤回、筛选、排序全部是新增能力，**尚未经过真实点击**。下表说明每一项当前的证据级别：`自动` 表示有可复跑的程序化断言，`人工` 表示只能由人在真实桌面确认。

| 页签 / 能力 | 自动证据 | 仍需人工 |
|---|---|---|
| 概览（状态行、注入报告） | `tests/e2e/page-endpoint-smoke.test.ts`（`status`/`config`/`injection` 全通） | 状态行在窄屏下的换行 |
| 运行时记忆（准则） | 同上（`rules` 读取） | — |
| 项目档案 | 同上（`archives` 读取） | — |
| 正式记忆：列表 / 搜索 / 分页 | `tests/contract/memory-browse.test.ts`、`tests/e2e/page-endpoint-smoke.test.ts` | 滚动到底自动加载的手感 |
| 正式记忆：范围 / 分类 / 实体筛选 / 排序 | `memory-browse`（三种顺序翻完全部行、游标不可跨排序）、`http-query-forwarding`（九个参数全部送达）、`dsh-rpc-forwarding`（Host 不丢字段） | 下拉在窄屏下的可用性 |
| 正式记忆：详情 / 修订链 / 历史版 | `page-endpoint-smoke`（含按 `revisionId` 读历史）、`tests/unit/dsh-memory-detail.test.ts` | 并排比较的排版 |
| 新增（直接发布） | `tests/e2e/create-memory.test.ts`（分类与标签落库、可立即编辑、项目范围不外溢、非法输入不发布）、`page-endpoint-smoke`（经页面通道新建） | 表单在窄屏下的排版 |
| 编辑（正文 + 分类 + 标签） | `tests/e2e/dsh-host-half.test.ts`、`edit-gates`、`concurrent-writes`、`restart-consistency` | 草稿离开时的确认弹窗 |
| 撤回 | `dsh-host-half`、`restart-consistency`、`concurrent-writes` | 撤回确认区的文案与焦点 |
| 关联网络（2 跳） | `tests/unit/dsh-ui-view-model.test.ts`（广度优先、最短跳、入边方向） | — |
| 实体页 | `memory-browse`（索引与合并拼写）、`dsh-ui-view-model`（筛选规则）、`dsh-panels-render`（渲染与高亮） | 选中实体后跳到列表的过渡 |
| 探索页 | `explore-ranking`（同一查询顺序稳定、大答案是小答案前缀）、`page-endpoint-smoke`（门槛生效）、`dsh-panels-render` | 门槛下拉的默认值是否符合直觉 |
| 图谱页 | `memory-graph`、`review-publish-graph`（真实审核发布产生取代边）、`conflict-graph`（coexist 产生冲突边）、`graph-layout`（布局确定性）、`dsh-panels-render` | 画布滚动与缩放手感 |
| 同步页 | `recall-authorization`（无 Host 头 401、载荷不含凭据）、`page-endpoint-smoke`（未配置时得到明确结果） | **配置真实远端后**的状态与手动刷新 |
| 设置页 | `tests/contract/host-config.test.ts`（解析顺序、循环回环、令牌不外泄、偏好校验）、`page-endpoint-smoke`（读取 + 本地保存） | **保存连接、连接测试、唤醒测试**（需要真实第二台 Server 与计划任务） |

**仍然只能人工的两类**：①连接相关的三个动作（保存连接、测试连接、唤醒）必须对着真实 Server 与真实计划任务执行，自动测试只能证明"解析与校验正确"；②视觉与手感（窄屏布局、滚动加载、画布缩放、焦点与文案）。这两类不做「已通过」的宣称。
