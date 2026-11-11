# MnemoWeave 开发约定

## 项目与基线

- 项目名：MnemoWeave；根目录：`D:\project\MnemoWeave`。
- 文档只有六份：`docs/architecture.md`（结构与已固定的设计决策）、`docs/implementation.md`（契约与机制）、`docs/sync.md`（三机同步协议与版本模型）、`docs/dsh-ui.md`（DSH 记忆界面，可查看与编辑）、`docs/host-acceptance.md`（Host 验收）、`docs/status.md`（当前状态与未决事项）；开工前先读 `docs/status.md` 与 `docs/implementation.md`。
- 改动 `docs/architecture.md` 决策表中等价于改变架构选择；不要为了配合某次实现而改写决策，应先在对话中确认。
- 项目文件、上游源码、临时文件、工具下载和缓存均放在本项目下；中间文件使用 `work/`，不得提交个人记忆、数据库、凭据或 API Key。

## 技术与模块边界

- TypeScript strict；Workspace Monorepo；模块化单体；原生部署，不使用 Docker。
- HTTP/MCP 协议层共享 Application Core；领域不得依赖协议、数据库或进程实现。保持包依赖声明与实际依赖一致。
- Source 声明标准 Capability；Strategy 声明 Plan，Core 验证协调，Pipeline 执行；View 不可变，读取范围在实际操作边界强制执行。
- 拓扑为三台开发机各一个本机 Server + 本机 Mnemon，另有一台远端同步 Server：共享写入由远端确认版本，注入与召回走本机。三个宿主插件（DSH、ChatGPT 桌面、ZCode）各自内嵌 `packages/client` 直连**本机** Server，统一使用服务令牌与 `x-mnemoweave-host` 头；不引入本地代理进程。本机 Server 到远端使用逐设备令牌（`MNEMOWEAVE_SYNC_*`），宿主不持有同步凭据。
- 正文封装为 `{format, data, contentHash, byteLength}`：远端是否可读正文**待确认**；`enc-v1` 只封装正文，标题、证据、实体与关系仍是明文。远端校验与快照只依赖哈希与长度，不得解析正文语义。
- 同步以「范围」为单位：`global` 或 `project:<projectId>`。序号、游标、快照、设备授权都按范围，禁止用全局游标跨项目推进，也禁止用按项目快照的 `nextSince` 推进全局游标。
- 编辑请求必须携带读取接口返回的 `entryVersion` 作为基准，服务端不得补全为本机最新版本；否则会静默覆盖他机修改。
- 准则按完整条目注入，超出预算拒绝启用，**不得按正文截断**准则。
- 授权分层：本机决定「发起者能否做这个动作」，远端只决定「设备能否读写这个范围」。**三类记忆均可由用户在记忆界面直接新增与编辑**，写入按宿主归因，界面编辑携带读取时的版本。用户可显式发起任务 Agent 整理后新增；普通模型工具只提交候选。
- 远端同步 Server 部署目标为 Linux systemd；本机 Server 在 Windows 开发机由登录时启动的计划任务托管，不做 Windows 服务包装；Worker 暂留本机 Server 进程内。
- `packages/domain`、`packages/shared` 尚未实现。

## Provider 与数据约束

- Mnemon 是后端名称，不随项目改名。`MNEMON_*` 为其配置，禁止误改为 MnemoWeave。
- 官方接口优先；核查实际源码、commit、参数和输出，不凭 README 臆造 API，不把 DSH 集成能力归给官方引擎。
- 禁止直接读写 Mnemon 内部数据库作为产品接口。能力缺失或版本不兼容必须明确拒绝，不得静默降级。
- 当前仅验收 Mnemon 0.2.13；升级需更新能力证据和契约测试。重复 Remember 的 `skipped` 结果必须用 `replaced_id` 定位已有记忆。
- 正式记忆正文与原生关系由 Mnemon 权威保存；MnemoWeave 只保存映射、哈希、当前指针与审核素材。宿主与 Server 之间只有一种身份：服务令牌 + Host 头，不做逐 Host 凭据签发；逐设备令牌只用于本机 Server 到远端同步 Server。
- `remember` 没有指定 ID 的参数，跨机重建必须建立逐机映射并用 `--no-diff`，否则会被去重返回 `skipped`。撤回用 `forget`，关系用 `related --edge`。
- 用户可在界面直接新增与编辑正式记忆（新增直接发布；编辑追加 Revision、supersedes 旧记忆；两者都记录为 `local-user` 审核决定）；模型没有这个入口，模型输出仍只能成为候选。
- Remember 与后台整理必须遵守候选审核边界；不得将模型输出直接写入正式记忆。`acceptanceRemember` 仅用于隔离验收。
- 跨 Provider 操作不假定共同事务；使用 Outbox、稳定幂等键、Receipt 与结果核对。超时写入不得盲目重试。
- 模型调用统一经过 Gateway/Routing；仅 declared 组件可调用模型，Provider 不得自行寻找模型。

## 验证与交付

- 运行环境和命令见 README。当前 Node.js 24、pnpm 11.18.0；不要擅自覆盖系统工具链。
- 相关改动完成后运行 `pnpm.cmd typecheck`、`pnpm.cmd build`、`pnpm.cmd test`；涉及真实 Provider 或协议链路时运行 `pnpm.cmd test:e2e`。
- 本机 `pnpm.cmd` 包装器会先尝试重装依赖，无交互终端时报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`；此时直接执行 `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/typescript/bin/tsc` 和 `node --test tests/unit/*.test.ts tests/contract/*.test.ts`，不能把包装器退出码 0 当成通过。
- E2E 需要可运行的 Mnemon 0.2.13。Windows 上 PATH 里的 `mnemon` 是 npm 的 `.cmd` 包装，`execFile` 不带 shell 无法启动（报 `spawn mnemon ENOENT`，再被 Provider 报成 `PROVIDER_UNAVAILABLE`）；`tests/e2e/mnemon-binary.ts` 依次尝试 `MNEMON_BINARY`、`work/tools/mnemon/mnemon.exe` 与 npm 全局包内的 `mnemon.exe`，每个候选都用 `--version` 探测。仍不可用时必须如实记录为环境缺失，不得写成通过。
- 测试使用项目 `work/` 下隔离目录和专用 store，禁止使用用户默认记忆目录。
- Provider 主要通过真实 CLI 进程验证输入、JSON 输出和副作用；上游 Go 测试不是本项目验收前提。只有修改或排查 Mnemon 内部源码时再考虑。
- 按改动范围验证，不为简单可逆变更添加镜像实现的测试。不能把未执行或失败的检查写成通过。
- 治理库当前 schema v14；迁移每步先 `VACUUM INTO` 快照；升级仍需先在隔离状态目录演练，不直接对真实库升级。Host 真实会话验收（ZCode、ChatGPT 桌面、DSH）仍属未完成项，见 `docs/host-acceptance.md` 与 `docs/status.md`。
- 向用户说明实际改动路径、执行命令、测试结果、未决事项和下一步；区分已实现、预留和待验证能力。
