# ChatGPT desktop adapter

实现依据（2026-11-09）：[官方 Hooks](https://learn.chatgpt.com/docs/hooks) 与 [官方 MCP](https://learn.chatgpt.com/docs/extend/mcp)。当前仅接入 local-only Work 的 command hooks；云编排不沿用这条本地链路。

`src/index.ts` 生成 hooks.json / MCP TOML 工件并归一生命周期；`src/hook-main.ts` 是真实可运行入口，通过 `packages/client` 直连同一个 Server，处理会话开始、用户消息、已知结构的工具结果、助手最终回复和会话结束。未知工具结果明确不可判定，不猜测成功，也不读取 transcript。

`node dist/tests/support/chatgpt-acceptance-setup.js` 只在项目 `work/chatgpt-acceptance/` 生成工件；不会改用户配置或跳过 Host 的原生信任审查。运行前提供 Server URL、服务令牌、Host ID，按需提供已登记 projectId。然后在目标桌面环境中人工安装、审查并运行真实会话，记录版本和脱敏负载。

程序化证据：chatgpt-adapter contract 与 runtime-memory E2E 中的钩子子进程。桌面真实会话、实际工具输出变体与能力预算仍未验收，descriptor.gatesMet 保持 false。
