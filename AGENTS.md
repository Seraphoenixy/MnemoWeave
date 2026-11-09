# MnemoWeave 开发约定

## 项目与基线

- 项目名：MnemoWeave；根目录：`D:\projects\MnemoWeave`。
- 用户确认的架构选择见 `docs/adr/README.md`、`docs/architecture/overview.md`。不得擅自改变 ADR-001–026。
- 实现规格、状态机、验收矩阵与当前工程状态见 `docs/implementation/README.md` 与 `docs/implementation/current-handoff.md`；开工前先读这两份。
- `docs/architecture/handoff-2026-11-08.md` 保留历史项目名 Mneme，是历史证据；历史执行记录已按 DOC-04 删除，不再引用。当前名称以本文及 README 为准。
- 项目文件、上游源码、临时文件、工具下载和缓存均放在本项目下；中间文件使用 `work/`，不得提交个人记忆、数据库、凭据或 API Key。

## 技术与模块边界

- TypeScript strict；Workspace Monorepo；模块化单体；原生部署，不使用 Docker。
- HTTP/MCP 协议层共享 Application Core；领域不得依赖协议、数据库或进程实现。保持包依赖声明与实际依赖一致。
- Source 声明标准 Capability；Strategy 声明 Plan，Core 验证协调，Pipeline 执行；View 不可变，Grants 在实际操作边界强制执行。
- Server 部署目标为 Linux systemd；Worker 暂留 Server 进程内。Bridge 为共享用户级进程，目标 Host 为 DSH、ChatGPT 桌面与 ZCode；Codex CLI 已从目标与验收移除。

## Provider 与数据约束

- Mnemon 是后端名称，不随项目改名。`MNEMON_*` 为其配置，禁止误改为 MnemoWeave。
- 官方接口优先；核查实际源码、commit、参数和输出，不凭 README 臆造 API，不把 DSH 集成能力归给官方引擎。
- 禁止直接读写 Mnemon 内部数据库作为产品接口。能力缺失或版本不兼容必须明确拒绝，不得静默降级。
- 当前仅验收 Mnemon 0.2.13；升级需更新能力证据和契约测试。重复 Remember 的 skipped 结果必须使用 replaced_id 定位已有记忆。
- 正式记忆由 Mnemon 管理，治理数据由 MnemoWeave 管理。Revision 权威已由 Q2 方案 A 确认（Provider 保存各版本全文，MnemoWeave 保存映射、哈希与当前指针）；同步协议等未决问题见 `docs/architecture/open-questions.md`，未解决前不得冻结同步 Schema 或制造双权威。
- Remember 与后台整理必须遵守候选审核边界；不得将模型输出直接写入正式记忆。acceptanceRemember 仅用于隔离验收。
- 跨 Provider 操作不假定共同事务；后续采用已确认的 Outbox、稳定幂等键、Receipt 与结果核对。超时写入不得盲目重试。
- 模型调用统一经过 Gateway/Routing；仅 declared 组件可调用模型，Provider 不得自行寻找模型。

## 验证与交付

- 运行环境和命令见 README。当前 Node.js 24、pnpm 11.18.0；不要擅自覆盖系统工具链。
- 相关改动完成后运行 `pnpm.cmd typecheck`、`pnpm.cmd build`、`pnpm.cmd test`；涉及真实 Provider 或协议链路时运行 `pnpm.cmd test:e2e`。
- 如现有 pnpm 包装器未可靠返回退出码，可直接执行 `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/typescript/bin/tsc` 和 `node --test tests/unit/*.test.ts tests/contract/*.test.ts tests/e2e/*.test.ts`。
- 测试使用项目 `work/` 下隔离目录和专用 store，禁止使用用户默认记忆目录。
- Provider 主要通过真实 CLI 进程验证输入、JSON 输出和副作用；上游 Go 测试不是本项目验收前提。只有修改或排查 Mnemon 内部源码时再考虑。
- 按改动范围验证，不为简单可逆变更添加镜像实现的测试。不能把未执行或失败的检查写成通过。
- 迁移缺陷已于 2026-11-08 修复（v2→v3 回填在 `catalog_relations` 尚未创建时跳过歧义检查），Contract 119/119 通过；迁移仍需先在隔离状态目录演练，不直接对真实库升级。Host 真实会话验收（ZCode `session.ended`、DSH 安装）仍属未完成项，见 `docs/implementation/current-handoff.md` 第 7 节。
- 向用户说明实际改动路径、执行命令、测试结果、未决事项和下一步；区分已实现、预留和待验证能力。
