# 首个切片与工程设计范围

此文记录最初的只读切片。后续已完成的新记忆审核/可靠写入范围见 reliable-write-milestone.md；下文的“未实现”描述仅对应初始阶段。

证据门槛：官方 v0.2.13 CLI 帮助与源代码明确支持 status、recall、remember JSON。选择原生 CLI Adapter，不使用私有 Web、未知 MCP 或内部数据库。当前不冻结 SQL Schema。

工作流：HTTP Recall / stdio MCP Recall → 同一 MemoryApplication → MemoryProvider Port → Mnemon CLI → Schema 校验 → 统一响应。启动时显式配置绝对路径、隔离数据目录、store、Bearer Token。诊断区分 live 与 ready。仅允许验收过的 0.2.13，拒绝未知版本而非猜测兼容。

Remember 的真实 Provider 写入在测试专用 store 验收；业务入口明确返回 REVIEW_REQUIRED。下一切片必须先解决候选审核持久化及 Outbox/Receipt，才能开放正式 Remember；不能用临时 approved 布尔字段冒充审核授权。

进程执行使用 shell:false、超时、输出上限和串行化；超时写入视为结果未知，不自动重试。错误响应不返回 stderr、路径、原始记忆或凭据。日志只记录 traceId、操作、结果。

契约使用 Zod Schema 作为 TypeScript 类型、MCP inputSchema 与 HTTP OpenAPI 文档的来源。共享统一错误码；边界拒绝额外字段。

测试：Unit 验证拒绝未知能力/业务写入；Contract 验证进程参数、JSON 和错误；E2E 使用校验过的真实二进制，贯穿写入→两个协议 Recall、鉴权、非法输入、重复写入。Reliability 首轮覆盖输出/超时错误；系统级断电、并发和恢复尚未实施。

WP3 仅完成本切片详细设计。Revision/Sync/Auth 完整设计仍待 open-questions.md 所列决策，不能声称 WP3 全部完成。Bridge 和三个 Host Adapter 当前仅建立边界说明，不虚报实现。
