# 宿主验收

验收使用隔离状态目录、专用 Mnemon Store 和可识别的测试项目。启动方法见 [根目录 README](../README.md)。各宿主配置同一台本机 Server、同一测试项目和不同 Host ID。使用服务令牌连接；管理凭据留在管理端。记录宿主版本、测试场景、实际结果和脱敏证据。

## 宿主接入

| 宿主 | 代码与运行方式 | 实机验收 |
|---|---|---|
| DSH | `plugins/dsh-mnemo-weave`。导入插件，在真实会话检查提示注入、工具与界面 | 基本浏览、编辑和注入记录已有桌面证据。完整界面及任务 Agent 待验收。独立的 `packages/adapters/dsh` 当前仅提供能力状态记录 |
| ChatGPT 桌面 | `packages/adapters/chatgpt` 与本地插件。使用 local-only command hooks，注入通过 `hookSpecificOutput.additionalContext` | 检查真实会话、工具结果变体、`SessionEnd` |
| ZCode | `packages/adapters/zcode`。启用 hooks，验证 `additionalContext`、MCP 和 `Stop` 的最终答复映射 | 检查真实会话。宿主缺少独立会话结束事件，`Stop` 只表示一轮结束 |

配置生成与取证入口位于 `tests/support/`。ZCode 使用 `zcode-acceptance-setup.ts` 和 `zcode-acceptance-collect.ts`；ChatGPT 使用 `chatgpt-acceptance-setup.ts`。DSH 插件导入与连接见 [DSH 界面](dsh-ui.md)。

ZCode 工作区的配置和采证命令在构建后运行：

```powershell
node dist/tests/support/zcode-acceptance-setup.js <workspace> http://127.0.0.1:4317 <service-token> zcode-host
node dist/tests/support/zcode-acceptance-collect.js <state-dir> zcode-host
```

先生成配置，再运行真实会话，最后采证。ChatGPT 使用配置生成器输出的本地工件，在目标宿主中安装并审查。测试项目通过 operator 登记，宿主使用一致的 `MNEMOWEAVE_PROJECT_ID`。

## 共同判据

- 已运行的 Server 可复用。冷启动或并发启动只有一个 Server。令牌错配保留现有进程。
- 在同一测试项目的三个真实会话中检查全局与项目准则均完整送达，切换项目后范围正确。记录注入往返与截止行为。
- 请求超时或 Server 不可达时，宿主回合继续执行；支持注入诊断的界面应可解释缺失结果。
- 模型提交记忆后得到候选回执。检查模型工具无法直接发布。
- 记录事件来源与会话绑定。遇到宿主事件缺失或工具结果格式不明确，按实际表现登记。

## DSH 页面

| 页面 | 核对项 |
|---|---|
| 概览 | 显示连接、范围与最近注入，数据和实际会话一致 |
| 运行时记忆 | 新增、修改和启停，校验预算与版本冲突提示 |
| 项目档案 | 搜索、打开详情、写入和版本冲突 |
| 正式记忆 | 概览图谱、检索、内容及实体视图；新增、编辑、撤回、历史、并发冲突及草稿保护 |
| 技能 | 顶部导航独立打开；在真实会话运行复盘、起草、自动和手动回测、取消及失败恢复 |
| 设置 | 保存与测试连接、唤醒、计划任务注册、同步状态和手动刷新 |

程序化证据包括 `tests/e2e/dsh-host-half.test.ts`、`tests/e2e/page-endpoint-smoke.test.ts`、`tests/contract/dsh-tools.test.ts` 和技能契约测试。真实桌面与部署缺口见 [当前状态](status.md)。
