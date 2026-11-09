# 运行时记忆与本轮修复

状态：2026-11-09 实现细化。依据 ADR-008、013、014、016、024；未改变 ADR，也未冻结尚待评审的跨设备同步 Schema。

## 数据与流程

- 正式全文仍由 Mnemon 0.2.13 保存。Runtime Pinned 只保存正式逻辑记忆引用、critical/normal 和 Global/Project/Host/Session 选择条件，不保存第二份正式全文。
- 操作员明确登记 projectId；操作员签发具体项目 Grant 也完成登记。项目身份不由目录名推断。候选、Revision 派生元数据、View 与副本携带 projectId；旧记录缺少项目身份时，只有显式 `*` Grant 可读，不做猜测回填。
- Runtime 由 SourceRegistry → Strategy 声明 Plan → Core 校验 Capability → 只读 Pipeline → ViewAssembler 执行。当前内置工作上下文与正式记忆 Source；这不是参考项目 Cordis/Fiber 或其插件生态的复刻。
- 新会话按已保存的 Pinned 引用加载常驻内容；没有 query 也会交付。任务和有界工作材料独立于长期 Recall，用户输入“继续”不会清空先前任务。
- 同一 session 的项目身份不允许静默切换；新项目使用新 session。Global/Host/Session pin 不构成读取授权；critical 优先于同一记忆的 normal 标记，不引入作用域之间的隐含覆盖排序。
- 当前工作模型通过实际提供的 MCP remember 提交候选；运行时 guidance 明确主动记录、查重、敏感内容排除和候选回执语义。

## 有界会话材料与提炼

- 实现默认：最近 12 条用户工作片段，每条至多 2,000 UTF-8 字节，片段 JSON 合计至多 8,000 字节，7 天后清理。它们是未验证的工作上下文，不是正式知识。
- 原始用户事件只在有限待提炼材料中暂存；旧片段且不再被任务使用时移除，最多保留 7 天。成功候选引用的原始用户证据进入 session_events/session_event_refs 的保护流程。
- 助手最终回复/会话结束可以触发提炼任务，但助手正文不是可自动沉淀的用户事实来源。工具失败只提供运行时诊断上下文。
- 工作事件 → 持久化 capture Task → 独立 Run → declared `memory-capture` Gateway → 最多一个带用户事件引用的候选 → 既有审核工作流。没有正式写入捷径。
- 无模型显示 awaiting_model。非法引用/无项目归属/撤权转需要介入的状态；可恢复模型失败按退避重试，过期租约或不同 owner 不得提交。候选及 capture Receipt 同事务。
- “不要记住”取消尚未完成的当前会话提炼并清空临时工作材料，不追溯删除已审核的正式知识。
- 模型输出保持 unverified，既有规则要求人工确认；不能将模型提炼或审核置信度当成技术验证。

## 预算与交付

- 默认总预算 4,096 Token，可由请求 budgetTokens 缩小；固定记忆、动态记忆、来源/版本标记、guidance、任务和工作片段共用预算。
- 采用 UTF-8 保守估算，普通片段按 UTF-8 字节截取；critical 完整呈现，超限明确拒绝。
- View 递归冻结。交付前重验许可、发布指针和 runtime revision；同步变化产生新 View。
- 注入截止包含授权检查。超时复用原读取，禁止额外重复召回；旧回合不能覆盖新回合，关闭会话使待完成和迟到结果失效。
- 本地 View 标注 local_replica、数据时间和 stale。Bridge 按 Grant 缓存 runtime 元数据；离线有有效缓存时仍可装配，新会话若缺少可证明可用的缓存则明确不可用。

## HTTP / MCP

- POST /v1/runtime/projects：operator，`{projectId}`。
- POST /v1/runtime/pins：operator，`{memoryId,tier,scope,projectId?,hostId?,sessionId?,remove?}`。
- POST /v1/runtime/context：Host，`{sessionId,projectId?,task?,close?}`；返回有界上下文、固定引用和 capture 状态。
- POST /v1/view：增加 sessionId、task、budgetTokens；不接受调用方扩大授权。
- MCP 默认只是 HTTP 代理，增加 runtime_context、memory_view，并提供主动记忆指引。正式部署只启动唯一 Server Worker；`MNEMOWEAVE_MCP_MODE=standalone` 仅为显式隔离验收兼容路径，强制关闭 Worker。
- Bridge 增加 POST /v1/events（持久排队）和 /v1/session/close。ZCode 使用真实进程入口；已接入工具失败刷新，会话结束仍不能伪造 ZCode 原生事件。

## 凭据与共享 Bridge

- Server 的 MNEMOWEAVE_TOKEN 是 master，不交给 Host。operator 签发 Grant 时响应包含该 Host 的 credential；Host、MCP、Bridge 使用它作为 Bearer token，携带 x-mnemoweave-host。
- 当前实现以 master HMAC-SHA256 派生 Host 凭据；修改 Host header 不能借用另一身份。全局 master 轮换使派生凭据失效；更完整的单 Host 凭据轮换仍属身份体系后续评审，不宣称生产身份系统完成。
- 续期只取回 Server 已签发的新 Grant，不在 Bridge 自行延长时限。全局撤权按 generation 比较，新签发许可可恢复。
- 单 Host 环境变量保持兼容；共享进程可用 MNEMOWEAVE_BRIDGE_HOSTS JSON 数组配置 `{hostId,token,bridgeToken?}`，统一目录 MNEMOWEAVE_BRIDGE_DIR 下按身份散列隔离副本/队列，统一端口按 x-mnemoweave-host 路由，分别校验本地凭据。

## 同步一致性

- 目录三张表与 sync_log 单调高水位在同一事务内捕获，再在事务外获取 Provider 正文。快照的 Cursor 不越过尚未包含的并发发布。
- 压缩日志后高水位由 sqlite_sequence 保留；空日志也能检测过期 Cursor。部分授权快照/增量/摘要按项目过滤；被排除的序号以 scope_skip 推进，不包含外部实体和正文。该线协议仍是本地实现方言，不是已冻结同步 Schema。
- 同步端点在读取前和交付前检查实时许可；普通 Recall、历史读取、Pinned、模型重排同样应用 Grants。
- 小于等于 5% 的分区差异在快照高水位核对后定向修复；超过 5% 或服务端为空且本地有残留时重建。小修复当前仍下载校验快照，尚未优化为定向网络传输。
- 副本摘要核对实际正文哈希和 pending 状态；未完成正文不能标记一致。副本切换期间若进程中断，启动时可恢复保留的 previous 副本。

## 验收与限制

行为证据：tests/contract/runtime.test.ts、sync.test.ts、injection.test.ts，以及 tests/e2e/runtime-memory.test.ts。后者运行真实 Mnemon、Server、ZCode hook 子进程、MCP 代理和双 Host 共享 Bridge，并验证断网后的本地装配；它不等于 ZCode 桌面真实会话。

未完成的外部验收：ZCode 桌面会话与 session.ended 上游缺口；DSH 已安装运行时/SDK 的活体验证与适配；ChatGPT 本地模式桌面真实会话与工具结果变体核验。Codex CLI 仅保留历史代码，不作为目标或完成证据。任何目标 Host 缺少必需入口时，首版仍未完成。

MCP 的会话私有工具仅在可信启动环境显式设置 MNEMOWEAVE_SESSION_ID 时提供，并拒绝模型输入另一 sessionId。无法绑定真实 session 的 Host 仅提供正式记忆工具，自动运行时注入仍由原生 hook 处理；不通过模型填写 sessionId 来授予私有读取权限。

ChatGPT 接入补充（2026-11-09）：实际查阅 [官方 Hooks](https://learn.chatgpt.com/docs/hooks) 和 [MCP](https://learn.chatgpt.com/docs/extend/mcp) 后实现 packages/adapters/chatgpt；只面向文档允许的本地模式，未知工具输出不猜成功。配置生成工具为 tests/support/chatgpt-acceptance-setup.ts，仅生成项目 work/ 工件，不改用户配置。DSH 启动脚本指向的已安装 CLI 文件本轮重查仍不存在，因此不能凭参考插件虚构可运行 SDK 适配。
