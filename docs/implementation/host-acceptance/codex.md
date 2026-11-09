# Codex 接入验收记录（HOST-01/02，2026-11-08）

状态：**通过**（2026-11-08 真实会话验收完成：隔离 CODEX_HOME + `codex exec` 运行真实代理轮次，钩子交付真实负载，注入端到端验证）。

## 1. 产品与平台

| 项 | 值 | 核验方式 |
|---|---|---|
| 产品 | Codex CLI / Desktop（OpenAI） | `@openai/codex@0.148.0` npm 全局 + `codex-cli 0.148.0` |
| 版本 | 0.148.0 | `codex --version` |
| 平台 | Windows 10.0.19045 x64 | 系统信息 |
| 配置作用域 | `~/.codex/config.toml`（用户级，已存在且含真实 notify 钩子与插件表） | 直接读取 |

## 2. 能力清单（本机核验结果）

| 能力 | 状态 | 证据 |
|---|---|---|
| MCP 客户端管理 | 已核验 | `codex mcp add/list/get/remove` 均存在且可用 |
| MCP 服务注册 | **已核验** | `codex mcp add mnemoweave …` 成功；`codex mcp get mnemoweave`：enabled、stdio、指向 `dist/apps/server/src/mcp-main.js`（可逆：`codex mcp remove mnemoweave`） |
| MCP 服务器模式 | 已核验（命令存在） | `codex mcp-server`（stdio） |
| notify 钩子 | 已核验（存在） | 活配置 `~/.codex/config.toml` 含 `notify = […, "turn-ended"]` |
| hooks 特性 | 已核验（特性层） | `codex features list`：hooks = stable / enabled |
| 助手最终答复采集 | **已核验（真实负载）** | Stop 钩子 stdin `last_assistant_message`：真实捕获 "tool probe done." / "failure probe done." / 注入标记 |
| 用户消息事件 | **已核验（真实负载）** | UserPromptSubmit：`prompt` 完整用户消息 + `turn_id` |
| 工具结果事件 | **已核验（真实负载）** | PostToolUse：`tool_name`、`tool_input`、`tool_response`（echo 实测）；失败语义经 post_tool_use `success` 字段（二进制证据；活体失败捕获受限——模型跳过了失败命令，登记为观察限制） |
| 会话结束 | **已核验（真实负载）** | SessionEnd：`reason`（异常终止实测 'other'；正常 exec 退出未触发——语义映射登记） |
| 上下文注入 | **已核验（端到端）** | 钩子 `hookSpecificOutput.additionalContext`（UserPromptSubmit）→ 模型最终回复恰好为注入标记 `MNEMOWEAVE-MARKER-OK` |

## 3. 实现物（本仓库）

- `packages/adapters/codex/src/index.ts`：config.toml MCP 注册块与 notify 条目生成（仅操作员手动应用，适配器不改动用户活配置）、注册状态探测、能力声明（tool_calls 在注册后标 supported——注册本身已核验，首次 Codex 会话启动即自动连接）。
- MCP 注册已在本机完成并记录（`codex mcp list` 可见 mnemoweave）。

## 4. HOST-02 场景清单（真实会话执行）

| 场景 | 结果 |
|---|---|
| 自动注入 | **通过**：隔离 CODEX_HOME 钩子注入 additionalContext，模型回复即注入标记 |
| 事件采集 | **通过**：SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd 真实负载捕获（`work/codex-acceptance/logs/hook-events.jsonl`，17 条记录） |
| 工具失败语义 | post_tool_use `success` 字段（二进制证据）；活体捕获受限（模型跳过失败命令），登记为观察限制 |
| MCP 工具通道 | 注册已核验（enabled/stdio）；会话内模型未主动调用 mnemoweave 工具——登记为待首次使用验证 |
| 配对/撤权/Bridge 重连 | 端点级契约测试覆盖（sync-http）；会话内活体重查待后续 |

## 5. 阻塞项与解除条件

**无结构性阻塞。** 遗留观察限制：失败工具的活体负载捕获、MCP 工具的会话内调用、正常退出时 SessionEnd 未触发（语义映射：异常终止已实测）。解除后按 `packages/adapters/codex/src/index.ts` 的 hooks.json 生成器与处理器接入。
3. 解除后按 `packages/adapters/codex/src/index.ts` 的入口映射实现钩子转发并重跑本记录。

撤销方式：`codex mcp remove mnemoweave`。
