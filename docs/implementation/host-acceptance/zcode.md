# ZCode 接入验收记录（HOST-01/02，2026-11-08）

状态：**阻塞（范围缩小）**——上游文档纠正：Stop 钩子 stdin 携带 `last_assistant_message`（助手最终答复入口存在，原缺口判断有误）；剩余缺口仅 session.ended 无专用事件 + 真实会话运行待执行。

## 1. 产品与平台

| 项 | 值 | 核验方式 |
|---|---|---|
| 产品 | ZCode Desktop（智谱/Z.ai） | `%LOCALAPPDATA%\Programs\ZCode\ZCode.exe` 存在 |
| 版本 | 3.17.2.9661 | ZCode.exe VersionInfo.ProductVersion |
| 平台 | Windows 10.0.19045 x64 | 系统信息 |
| 配置作用域 | 用户：`~/.zcode/cli/config.json`；工作区：`<repo>/.zcode/config.json` | 已安装版本的 zcode-configuration-guide（权威本机文档） |

## 2. 能力清单（本机核验结果）

| 能力 | 状态 | 证据 |
|---|---|---|
| Hook 事件入口 | 已核验（契约） | 已安装配置指南：七个事件 SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop；配置文件钩子须 `hooks.enabled: true` |
| 自动注入入口 | 已核验（契约） | Hook stdout `additionalContext` 注入会话（配置指南明示）→ 满足 HOST-05 会话开始 + 用户消息增量的受支持入口 |
| MCP 工具 | 已核验（契约） | `mcp.servers` 用户/工作区双作用域、会话启动自动连接 |
| 助手最终答复采集 | 入口已核验（上游文档） | **勘误（2026-11-08）**：Stop 钩子 stdin 携带 `last_assistant_message`——已映射为 message.assistant.final；原"缺口"判断有误并撤回 |

## 3. 实现物（本仓库）

- `packages/adapters/zcode/src/index.ts`：钩子事件归一（HOST-03 五类可覆盖事件）、`additionalContext` 注入（HOST-06 单调 2 秒截止、超时静默不阻断）、工作区 hooks/mcp 配置生成（`hooks.enabled: true`、process 类型、2.5 秒钩子超时）、能力声明。
- 适配器实现完成；能力声明全部 `unverified`——按验收规则，未在真实会话中验证实际负载与交付前不得标 supported。

## 4. HOST-02 场景清单

| 场景 | 结果 |
|---|---|
| 首次配对 | 未执行（需操作员签发授权 + 真实会话） |
| 独立身份 / Recall / 提交候选 / 状态查询 / 撤权 / Bridge 重启重连 | 未执行（依赖真实会话） |
| 自动注入 | 实现完成（additionalContext 入口），真实交付未验证 |
| 六类事件采集 | 实现 5/6（session.started/message.user/tool.success/**assistant.final**/tool.failure）；剩余缺口：session.ended 无专用事件（Stop 按轮触发） |
| 事件去重 / 会话关联 / 预算限制 | 实现（eventId 去重、session_id 关联、2 秒预算）；未在真实会话验证 |

## 5. 阻塞项与解除条件

1. **session.ended 缺口（结构性，登记）**：ZCode 无专用会话结束事件（Stop 按轮触发）；按 HOST-02 规则登记，不得以 Stop 假充。
2. **真实会话验收**：用户按 `host-acceptance/runbook.md` §1 执行（工作区安装脚本 + 环境变量 + 真实桌面会话）；钩子→意图→session_events 链路已端到端冒烟（SessionStart 与 PostToolUseFailure 均落库）。

勘误说明：第十九批 HOST-02-ZC 中"assistant.final 缺口"判断有误，已由上游文档（zcode.z.ai/cn/docs/hooks）纠正并撤回；ZCode 阻塞范围缩小为 session.ended 缺口 + 真实会话运行。
