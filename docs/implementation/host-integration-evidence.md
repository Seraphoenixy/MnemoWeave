# Host 接入证据与验收边界

核查日期：2026-11-08。HOST-01 已接受：ZCode 指智谱/Z.ai 桌面版内置 ZCode Agent。本文的官方文档证据不代表本机兼容性已经通过；本次未修改任何 Host 配置或安装插件。

## 能力矩阵

| Host | 已取得的证据 | 可据此设计的入口 | 尚不能承诺的能力 |
|---|---|---|---|
| DSH | 已固定 dsh-mnemon 源码提交 ee080a7371759928c97c581621713819f31507d4；package.json 0.5.42；src/host/lifecycle.ts 注册 session/event、system-prompt/assemble、agent/pre-step 等事件 | 依据实际 SDK 编写 DSH 适配器，将事件及 View 对接 Bridge | 不能把插件私有 SDK 当成所有 DSH 版本的稳定公共 API；目标 DSH 版本及实际加载待验收 |
| Codex | 官方 MCP 文档列出本地 STDIO、Streamable HTTP 以及 config.toml 配置 | MCP 工具入口；具体安装界面和配置需按本机版本确认 | 尚未核验本机 Hook 事件、输出上下文和全部消息采集；不能假定 MCP 等于完整会话订阅 |
| ZCode Agent | 官方文档明确支持 STDIO/HTTP/SSE MCP、会话/工具 Hook，以及 SKILL.md 技能 | MCP 工具；按官方子进程契约设计 Hook；Skill 提供调用指导 | 已安装版本、Hook 实际负载与身份绑定、Windows 路径及退出码行为待实测 |

DSH 证据是集成插件源码，不是 Mnemon 官方能力。其 package.json 声明的 DSH 范围为 `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`，不能从该范围推断其它版本可用。Provider 能力另见 `../research/mnemon-capability-matrix.md`。

## 官方来源

- [ZCode MCP](https://zcode.z.ai/cn/docs/mcp-services)：设置页区分用户/工作区作用域，并支持本地命令及远端连接；不同 Host 必须使用各自身份，不能因可导入配置而复制共享凭据。
- [ZCode Hooks](https://zcode.z.ai/cn/docs/hooks)：本地进程通过标准输入/输出 JSON 及退出码交互；提供 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、Stop 等事件。Hook 不提供内部模型调用对象。
- [ZCode Skill](https://zcode.z.ai/cn/docs/skill)：技能以 SKILL.md 定义，用户级目录为 `~/.zcode/skills`；技能是指导文档，不能作为强制授权控制。
- [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)：列出 STDIO、Streamable HTTP、Bearer/OAuth 及 config.toml 选项。文档页面产品命名和本机界面可能存在变化，实施前记录实际客户端版本。
- [OpenAI Hooks 文档](https://learn.chatgpt.com/docs/hooks)：作为后续适配核查入口；当前未逐项核验本机事件和上下文返回契约，不据此标记全量 Hook 支持。
- [DSH 集成源码](https://github.com/omdsh-dev/dsh-mnemon/tree/ee080a7371759928c97c581621713819f31507d4)：本地对应 `work/upstream/dsh-mnemon`。

## 自有适配器契约建议（Proposed，非上游 API）

适配器声明 hostProduct、hostVersion、adapterVersion 和逐项 Capability：工具调用、会话开始、消息事件、工具结果、上下文注入、动态增量、预算报告。每项记录 supported/unsupported/unverified 及证据；客户端自报能力不能扩大 Grants。

一次 MCP 会话绑定已配对 Host 凭据；Hook 转交事件时也必须证明同一身份和 Session，不信任正文中的 hostId。STDIO 接入宜由轻量连接端转交共享 Bridge，不能为每个 Host 启动独立正式存储或绕开 Bridge 队列。

MCP 工具结果不是系统提示词注入接口。自动注入只能使用经验证的 Host 入口；无事件能力时不能伪造“已采集”，无注入能力时不能宣称“自动记忆已启用”。Skill 仅说明何时 Recall、提交 Candidate 和报告状态，不授权直接 Remember。

## 每个 Host 的验收记录

必须保存产品版本、平台、配置作用域、能力列表、测试日期及脱敏结果：首次配对、独立身份、Recall、提交候选、状态查询、撤权、Bridge 重启重连。每个 Host 还必须验证自动注入、选定事件采集、事件去重、会话关联和预算限制；未通过的必需项标记为阻塞，不能以未启用视为首版通过。

严禁为了接入读取 Host 私有数据库或无限采集历史会话。HOST-02 已接受：三个 Host 的自动注入和选定事件采集都是首版必交付能力；MCP 手动入口不能替代。接口不足时，对应 Host 阻塞首版验收，保留缺口及证据，不私自改为延期项。

## 首版交付门槛（Accepted：HOST-02）

| 必需项 | 通过依据 | 不足时的处理 |
|---|---|---|
| 自动注入 | 真实 Host 中，无需用户逐轮手动调用 Recall，适配器通过受支持入口自动交付经过授权和预算校验的上下文；记录会话及 View 身份 | 缺少入口、只有静态 Skill 指导或仅展示 MCP 查询结果，均不能宣称通过 |
| 选定事件采集 | 真实 Host 触发会话开始/结束、用户消息、助手最终答复、成功及失败工具结果；Bridge 接收、身份关联、选择性保存和去重有证据 | Hook 名称存在但未验证实际负载和交付，不算通过；禁止采集隐藏推理或逐 Token 输出 |
| 故障和撤权 | 重启恢复、已知撤权及过期读取许可不会导致越权注入；失败状态可见 | 不通过时阻塞对应 Host 验收，不用旧正文绕过权限 |
| 全项目首版 | DSH、Codex、ZCode 均完成上述验收，并满足其余首版要求 | 任一必需 Host 阻塞，则全项目首版不得标记完成 |

这是完成标准，不意味着首版必须一次性提供每个 Host 的所有 Hook。具体受支持入口按已安装版本核查，不强行统一成虚构的通用 Hook API。HOST-03/04 已确认事件集合和故障行为，见 `host-event-and-injection-contract.md`；没有接口时报告能力缺口，不能通过读取私有数据库规避。
