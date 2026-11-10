# MnemoWeave ZCode 插件

状态：本地开发插件。安装后随插件启用 hooks 与 MCP；实际注入依赖 MnemoWeave Server（直连，无本地代理进程）。

## 组成

- `hooks/hooks.json`：SessionStart、UserPromptSubmit、PostToolUse、PostToolUseFailure、Stop 调用 `dist/packages/adapters/zcode/src/hook-main.js`。
- `.mcp.json`：注册 stdio MCP（`recall`、`provider_health`、`remember`、`candidate_status`、`read_memory`、`read_conflict`）。
- `dist/`：构建产物，由 `node scripts/build-plugins.mjs` 生成（不提交）。

## 安装前

1. 构建：`node node_modules/typescript/bin/tsc && node scripts/build-plugins.mjs`
2. 启动 Server，并准备至少 24 字符的 `MNEMOWEAVE_TOKEN` 与独立的 `MNEMOWEAVE_OPERATOR_TOKEN`。
3. 在 ZCode 中通过本地 marketplace 安装：Settings → Plugins → Create → Add marketplace → 选择 `plugins/marketplace.json`。

## 配置

插件详情页的 Configuration 填写 Mnemon 数据目录、Store 与状态目录；这些值用于 MCP 子进程。`MNEMON_BINARY` 可省略，默认使用 PATH 上的 `mnemon`。

hooks 子进程读取宿主继承的环境变量：

| 变量 | 用途 |
|---|---|
| `MNEMOWEAVE_SERVER` | Server 地址，默认 `http://127.0.0.1:4317` |
| `MNEMOWEAVE_TOKEN` | 服务令牌（必需，与 Server 相同） |
| `MNEMOWEAVE_HOST_ID` | 宿主标识，作为 `x-mnemoweave-host` 发送，默认 `zcode-host` |
| `MNEMOWEAVE_PROJECT_ID` | 可选；会话绑定的已登记项目 |
| `MNEMOWEAVE_INJECT_DEADLINE_MS` | 可选；注入截止，默认 2000 |

插件不保存令牌；未设置令牌时钩子静默跳过，不阻塞会话。断网时同样静默——没有本地副本可回退。
