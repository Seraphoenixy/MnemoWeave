# 当前工程交接

状态：2026-11-09 运行时记忆与授权/同步修复后的实际快照。旧版“核心已完成、仅剩 Host 验收”的表述已撤回；功能、程序化链路和真实 Host 行为分别记录。

## 本轮实现

- 持久化 Global/Project/Host/Session Pinned 引用；新会话没有 query 也能交付常驻正式记忆。
- 有界会话工作上下文、任务续接与 Dynamic Projection；“继续”沿用先前任务；工作材料明确标注未验证。
- 工作模型主动记录 guidance；助手最终回复/结束事件触发对用户素材的辅助提炼。capture Task、Run、Receipt 独立持久化，Gateway 声明能力，输出只成为候选，原始用户证据受保护；无模型、撤权、非法引用与 opt-out 不发布。
- SourceRegistry / Strategy Plan / Capability 验证 / 只读 Pipeline 已接入运行时交付；未复刻 DSH 插件系统，未承诺第三方插件热更新或全部高级策略。
- 项目身份来自明确登记；当前/历史读取、Pinned、模型重排及同步均应用 Grant，旧无 projectId 的数据只对 `*` Grant 可见。
- Server master 与 Host 凭据分离；逐 Host 派生 credential，换 header 不可借用别人的身份。普通读取在交付前复验；全局撤权按 generation，重新签发后可恢复。
- MCP 默认代理唯一 Server，不在每个 Host 创建 Provider/Worker；standalone 只作显式隔离验收且关闭 Worker。
- 共享 Bridge 单进程支持多 Host profile，各自隔离许可/目录/缓存/队列/会话；Server 关闭后仍可用有效许可及缓存完成投影，事件持久排队。
- 注入截止涵盖授权；超时不重复召回；旧回合/关闭会话不能再绑定迟到结果；Pinned 改动按当前请求处理；View 递归冻结，来源/版本/上下文封装纳入预算。
- 快照目录与单调 Cursor 同事务捕获；日志清空仍保留高水位；按 Grant 过滤快照、增量和摘要。小漂移按快照高水位定向修复，超过 5% 重建；正文哈希与 pending 参加核对；重叠同步/排空合并，切换中断可恢复 previous 副本。
- schema v10 增加项目、pin、临时工作素材和提炼账本；每次从 v9 迁移前备份。仅在 work/ 隔离目录演练，未升级用户真实状态目录。
- DSH 只读界面：Bridge 增加独立 token 的 `/v1/ui/*`（状态/记忆/详情/历史版本/意图，按 Grant 过滤，支持作用域与项目收窄），并扩展现有 `plugins/dsh-mnemo-weave` 包（`dsh-mnemo-weave/ui` 条目 + `lib/client.js` 侧边栏记忆页 + Host RPC）。token 只留在 Host 进程；另加开发用热重载（监视 `lib/` → 宿主 `pluginManager.setBundleEnabled`，参考 dsh-plugin-harbor）。真实 DSH 桌面点击验收仍未完成，见 [dsh-ui.md](dsh-ui.md)。2026-11-09 已把该插件装入 `profiles/desktop`；首次启动因客户端未声明 `locale` 注入失败（web boot: 1 entry did not activate），修复后宿主条目 `active`，侧边栏入口与页面仍待用户确认；Bridge UI token 未设置，页面数据通道尚未可用。

细节、路径和实际接口见 [runtime-memory.md](runtime-memory.md)。ADR-001–026 未改动；同步扩展仍是可演进实现，不冻结 Q3/Q4 Schema。

## 验证结果

环境：Node.js 24.22.1、pnpm 11.18.0、Mnemon 0.2.13、TypeScript 7.0.2。

| 检查 | 实际命令 | 结果 |
|---|---|---|
| 类型检查 | node node_modules/typescript/bin/tsc --noEmit | 通过 |
| 构建 | node node_modules/typescript/bin/tsc | 通过 |
| Unit + Contract | node --test tests/unit/*.test.ts tests/contract/*.test.ts | 155/155 通过（含 Bridge UI、DSH 插件与热重载用例） |
| 真实 Provider/协议链路 | node --test tests/e2e/*.test.ts | 13/13 通过 |
| 最新 MCP 输出校验复核 | node --test tests/e2e/runtime-memory.test.ts | 1/1 通过；该用例已包含于上面的 13 项 |
| 锁文件 | pnpm.cmd install --lockfile-only --ignore-scripts --cache-dir work/pnpm-cache --store-dir work/pnpm-store | 联网核验后通过，未新增第三方依赖 |

`pnpm.cmd typecheck/build/test/test:e2e` 均已尝试，但当前包装器先尝试重装依赖，因无交互终端报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY，未实际执行检查。依 AGENTS.md 改用上表直接 Node 命令；不能把包装器的退出码 0 当成通过。

原始日志仅在忽略的 work/final-runtime-contract.log、work/final-runtime-e2e.log 和 work/runtime-hook-e2e.log，不提交临时状态、模型密钥、凭据或个人数据。

## 关键行为证据

- tests/contract/runtime.test.ts：新会话常驻记忆、任务续接、持久化 pin、跨 Host/Session 隔离、权限先于重排、候选边界、证据保护、缺模型/拒记/撤权/非法引用、关闭会话、Capability 校验、按项目同步。
- tests/contract/sync.test.ts：旧有恢复场景 + 快照并发发布不漏事件、全局撤权后新许可恢复、小范围正文损坏定向修复。
- tests/contract/injection.test.ts：授权耗时纳入截止，组装后撤权拒绝；迟到只作后续 View，不覆盖已结束回合。
- tests/e2e/runtime-memory.test.ts：真实 Mnemon + Server + ZCode / ChatGPT 本地 hook 子进程 + MCP proxy + 双 Host 共享 Bridge；固定记忆、“继续”、跨 Host 身份隔离和断网读取/排队。

测试只证明对应程序场景，没有把钩子进程或 MCP 调用当成真实桌面模型已经使用/遵循记忆。

## 尚未完成与限制

1. 当前目标 Host：DSH、ChatGPT 桌面、ZCode。ZCode 桌面真实会话仍未验收，原生 session.ended 缺口仍在；DSH adapter 仍需可核验的已安装 SDK/运行时；DSH 只读界面插件的真实桌面加载同样未验收；ChatGPT 本地模式钩子与配置生成已有实现和子进程验证，桌面真实会话与工具输出变体未验收。Codex CLI 仅历史资料，不计完成门槛。因此首版仍未完成。
2. 首次配对 UX、单 Host 凭据独立轮换、防改时钟与生产身份体系仍需专项评审。本次实现是受保护的本机开发边界，不承诺生产远程部署。
3. 小漂移只定向修改本地分区，但当前传输仍下载完整校验快照；大规模/远程传输优化尚未验收。高级多路召回、实体关系扩展和第三方组件生命周期不能由当前内置 Source 接线推断为完成。
4. Runtime 临时上下文不保存全部历史会话；离线新会话缺少有效 runtime 缓存时明确不可用。旧项目未归属数据不自动映射；如需迁移归属，应提供经确认的登记资料。
5. 外部 Provider 改写、用户真实数据迁移、更高并发负载、Linux systemd 实机运维仍未验证。

## 下一步

先补齐并运行三个当前目标 Host 的真实会话场景；缺少官方或已安装接口时保持阻塞，不能造 SDK、私有 RPC 或假会话结束事件。真实数据迁移前先复制到项目 work/ 演练，禁止直接升级默认记忆目录。工程提交只在本地，不自动推送。

MCP 的会话私有工具仅在可信启动环境显式设置 MNEMOWEAVE_SESSION_ID 时提供，并拒绝模型输入另一 sessionId。无法绑定真实 session 的 Host 仅提供正式记忆工具，自动运行时注入仍由原生 hook 处理；不通过模型填写 sessionId 来授予私有读取权限。

ChatGPT 接入补充（2026-11-09）：实际查阅 [官方 Hooks](https://learn.chatgpt.com/docs/hooks) 和 [MCP](https://learn.chatgpt.com/docs/extend/mcp) 后实现 packages/adapters/chatgpt；只面向文档允许的本地模式，未知工具输出不猜成功。配置生成工具为 tests/support/chatgpt-acceptance-setup.ts，仅生成项目 work/ 工件，不改用户配置。DSH 启动脚本指向的已安装 CLI 文件本轮重查仍不存在，因此不能凭参考插件虚构可运行 SDK 适配。

本地修复阶段提交：3852d2a（运行时记忆/授权/同步）。后续 ChatGPT 本地适配作为独立阶段提交；均不自动推送。
