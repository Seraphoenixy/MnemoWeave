# Host 接入

状态：2026-11-09 按用户 AGENTS.md 校正。当前目标为 DSH、ChatGPT 桌面、ZCode；Codex CLI 已移出目标与验收，历史适配器和记录不删除、不计作完成依据。

## 当前事实

| Host | 当前可运行代码与证据 | 未完成 |
|---|---|---|
| ZCode | normalizeHookEvent、hook-main 实进程、Server/MCP/共享 Bridge 注入；SessionStart/UserPromptSubmit/工具失败接线；Stop 触发候选提炼但不是会话结束 | 真实桌面会话行为验收；原生 session.ended 入口仍缺失 |
| DSH | 已安装桌面的历史探测与参考项目实际源码，adapter 当前仅阻塞说明 | 可用的已安装 SDK/运行时核查、MnemoWeave 实际适配器及真实会话 |
| ChatGPT 桌面 | 官方 Hooks/MCP 核查；chatgpt adapter 事件归一、配置生成与 hook 子进程已实现 | 本地模式桌面真实会话、实际工具结果变体；云编排不能沿用本地 command hooks |

`tests/e2e/runtime-memory.test.ts` 运行真实 Mnemon、Server、ZCode hook 子进程、MCP 代理及双 Host 共享 Bridge，验证新会话常驻记忆、“继续”任务投影、断网本地读取和跨 Host 隔离。它不声称已在 ZCode 桌面、DSH 或 ChatGPT 桌面的真实会话执行。

## 运行时契约

- 会话开始加载持久化 Global/Project/Host/Session Pinned，任务工作片段参与 Dynamic Projection；两者同受 Grants、发布状态与总预算限制。
- 支持的入口携带 sessionId、稳定原生 eventId/turnId（Host 提供时）和显式登记的 projectId。没有原生事件身份时生成本地调用身份，不宣称能证明跨进程重试是同一事件。
- ZCode 用户消息先进入有界 runtime 素材，再装配 View。助手最终回复可以触发用户素材提炼，助手文本不自动变为用户事实。
- 工具失败触发刷新；显式 Recall/预算/许可变化也由共享注入入口提供。Host 没有预算或原生事件接口时保留能力缺口，不伪造回调。
- 前台授权、召回和装配共享两秒截止；generation 防止旧回合覆盖新回合；会话结束使旧控制器与迟到结果失效。
- 默认 MCP 是到 Server 的代理，不在每个 Host 中另起 Provider/Worker。所有模型提炼输出仍经 Candidate 审核。
- Bridge 可在一个用户进程内服务多个 Host profile，各自的凭据、许可、缓存、离线队列和会话控制器隔离；详见 runtime-memory.md。

## 完成门槛

每个目标 Host 都需证明：新会话自动注入、真实用户/助手/工具事件、上下文更新、候选来源与回执、撤权/离线、退出/崩溃语义。MCP 手工调用、钩子子进程或参考插件能运行，都不能替代目标 Host 的真实会话验收。当前首版仍未完成。

历史官方链接与负载证据保留在 host-integration-evidence.md 和 host-acceptance/ 下；有关 Codex 的材料仅供历史追溯。没有核验的 SDK 或私有 RPC 不当作稳定公开接口。

ChatGPT 接入补充（2026-11-09）：实际查阅 [官方 Hooks](https://learn.chatgpt.com/docs/hooks) 和 [MCP](https://learn.chatgpt.com/docs/extend/mcp) 后实现 packages/adapters/chatgpt；只面向文档允许的本地模式，未知工具输出不猜成功。配置生成工具为 tests/support/chatgpt-acceptance-setup.ts，仅生成项目 work/ 工件，不改用户配置。DSH 启动脚本指向的已安装 CLI 文件本轮重查仍不存在，因此不能凭参考插件虚构可运行 SDK 适配。
