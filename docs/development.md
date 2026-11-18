# 开发与验证

项目按个人使用需求迭代。上游更新作为参考，按实际价值、数据兼容性和宿主影响决定是否吸收。源码基线、上游版本和许可证见 [README](../README.md)。

## 开发基线

开发依赖锁定 DSH `0.2.2-rc.1`，CI 也测试 RC2。源码构建使用 Node.js `>=24.9.0` 和 pnpm。DSH 本地安装、热重载和客户端验收见 [安装与使用](usage.md)。

## 验证命令

| 命令 | 用途 |
|---|---|
| `pnpm typecheck` | 检查根包和仓库内 TypeScript 引用 |
| `pnpm build` | 构建根包。构建全部组件再运行 `pnpm -r build` |
| `pnpm test` | 运行 `tests/unit`：单模块行为的用例，不起服务或宿主 |
| `pnpm test:integration` | 运行 `tests/integration`：真实同步服务、Host 与 Pack 的组合用例 |
| `pnpm verify:docs` | 校验本地 Markdown 链接及锚点 |
| `pnpm verify:build` | 校验根包构建可复现 |
| `pnpm verify:headless` | 使用隔离 DSH profile 检查插件启停和工具 |
| `pnpm verify:sync` | 构建后验证独立同步服务、PAKE 握手和 MCP 跨进程同步 |
| `pnpm verify:package` | 检查打包文件清单、公开入口可导入性与 `publint` / `attw` 类型声明 |
| `pnpm verify:windows-pnpm` | Windows 专用：验证桌面 PATH 之外的 pnpm 全局 shim 发现 |
| `pnpm verify` | 依次运行文档、类型、单元测试、构建、Headless、同步和打包验证 |

测试与仓库自身的校验闸门都放在 `tests/`：`unit/` 放单模块用例，`integration/` 放组合用例，`checks/` 放需要包管理器、已构建产物或已安装 DSH 的闸门，`support/` 放共用夹具。`scripts/` 只保留产出构建产物的工具。用例使用 Node 内置的 `node:test`，通过 `--experimental-transform-types` 直接引用 `src/` 下的 TypeScript 模块，不额外安装测试框架。详见 [tests/README.md](../tests/README.md)（英文）。

每个用例自行收尾：在 `finally` 中停止它启动的服务并删除临时目录，因此一个失败的用例不会给下一个留下监听端口或子进程。

## 扩展开发

Source、Strategy 和 Client 扩展使用 `dsh-mnemo-weave/contracts`、`dsh-mnemo-weave/extension-sdk` 和 `dsh-mnemo-weave/client` 公开入口。Provider 通过记忆空间 Source 的 `provider-sdk` 注册。组件配置和公开接口见 [组件目录](../src/components/)。

基线的详细配置、历史验证及扩展设计可追溯至上游。 [上游中文文档](https://github.com/omdsh-dev/dsh-mnemon/tree/main/docs/zh-CN)

<a id="verification-宿主与制品验证细节"></a>

## 宿主与制品验证细节

<a id="verification-仓库归属"></a>

### 仓库归属

```text
src/
  index.ts, bundle.ts, mcp.ts, sync-server.ts   顶层装配入口
  starter-resolution.ts, message-source.ts     发行装配与消息来源
  core/          contracts, View compilation, generations, turn leases
  sdk/           installMemory, validation, test fixtures
  host/          DSH 宿主：按职责分包
    contracts/      浏览器可用的 channel、RPC 端点、配置 schema 与共享类型
    configuration/  配置解析、设置服务、显示方式与嵌入凭据
    boot/           插件注册、生命周期、命令、引导与续写回合
    engine/         运行时图、Pack、审核台账、存储根与容量工作流
    session/        Session 事件、快照与 Agent 兼容
    delegation/     记忆子 Agent 的启动、提示、回执与用量
    skills/         技能进化、审核与轨迹
    review/         审核准入、检查点、工具与活动投影
    surface/        RPC 注册、工具登记、插件与版本管理
    support/        宿主接口声明与无状态工具函数
  client/        DSH WebUI：样式表留在本层根目录
    i18n/           文案表
    kit/            页面套件、控件、图标、锚点与选择器
    connection/     RPC 客户端、View store 与 Source 契约
    workspace/      工作台、侧边栏、编辑器与导航
    pages/          状态页、Source 管理页与版本对话框
    panels/         设置卡片、组合面板与各 Source 设置
    hosting/        组件宿主、区域目录与 Source 页面
    turn/           会话内的回合尾部、保存动作与用量
  components/    各 Source / Strategy / Provider 的独立模块：
                 source-runtime, source-documents, source-memory-spaces,
                 source-skills, strategy-auto-capture, provider-mnemon-native
  memory/        MCP 与 DSH 共用的本机目录、工作准则和同步配置
  sync/
    protocol.ts  服务端与客户端共用的同步协议
    server/      HTTP 请求处理、存储接口、SQLite 实现
    client/      快照协调、远端接口、HTTP 客户端、本地状态文件
scripts/         build-time tooling: bundle declarations, component assets, Antigravity installer
tests/           unit, integration and check cases (see tests/README.md)
cordis.patch.yml   default Starter composition
```

根包拥有 Core/SDK、DSH Host 和默认 Starter，不拥有 Source 存储实现：Host 复制或统计 Source 的文件时，从该 Source 的 `./contracts` 读取其文件名、锁文件与解析器（见[内置存储范围](architecture.md#design-内置存储范围)）。每个组件都是 `src/components/<id>` 下的独立模块，经 `dsh-mnemo-weave/<id>` 子路径发布为独立 Entry：对外只有一个包，内部仍按组件开发。默认发行包含全部官方组件。Starter 安装策略增强，其 Entry 默认停用；主策略由 Core 内置，各组件开关由 DSH 插件管理器记录。Source/Strategy 通过 peer 使用 Core SDK，策略贡献使用其完整 Strategy 的公开 SDK，Provider 使用 Memory Spaces SDK。

不再保留私有工作区包、控制器转发文件、业务 binding 或 compatibility 目录。兼容指用户配置、数据与使用流程，不是延续历史内部符号。[兼容登记表](extensions.md)列出为此保留的代码、保留原因，以及每一项可以移除的条件。

历史背景见 [上游设计记录](https://github.com/omdsh-dev/dsh-mnemon/tree/main/docs/plans)。[tests/README.md](../tests/README.md)（英文）列出每个用例、闸门与夹具，以及它们的输入和环境变量。

插件 Client 测试需要根包的公开浏览器制品时，先构建根包：

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm --filter dsh-mnemo-weave-source-runtime verify
```

声明的 peer 版本可用后，任意插件可复制到新仓库，运行自己的 `pnpm install && pnpm verify`。未发布开发使用打包制品及本地 registry 验收，不以仓库源码路径代替公开依赖。

<a id="verification-验证方式"></a>

### 验证方式

仓库以单模块用例、可复现构建、独立制品和真实宿主的集成检查为主。

| 检查 | 覆盖 |
|---|---|
| `pnpm test` | 单模块用例：失败原因链、可重试的失败、运行记录、设置白名单、清单边界与活动读取 |
| `pnpm test:integration` | 组合用例：独立同步服务、活动流、Host 同步与同名工作区合并、逐文件传输、Pack 合并收敛、子任务活动与 blob 收集 |
| `pnpm verify:docs` | 本地 Markdown 链接、锚点，以及公开插件目录与实际入口一致 |
| `pnpm typecheck` | 根包与仓库内全部 TypeScript 引用 |
| `pnpm verify:build` | 确定性构建：比较两次构建的全部生成文件 hash |
| `pnpm verify:headless` | 用隔离 DSH profile 安装打包产物，检查插件启停与工具注册 |
| `pnpm verify:sync` | 在临时目录启动独立同步制品，验证双向证明、重放拒绝、跨进程同步和服务重启 |
| `pnpm verify:package` | 打包文件清单、公开入口可导入性和类型声明链接 |

`pnpm verify` 串联以上检查。`prepublishOnly` 也运行同一条链。Windows 的 Node 24 任务只运行 `pnpm verify:windows-pnpm`，它检查桌面 PATH 之外的 pnpm 全局 shim。

验证不读写运行者的真实记忆数据。`pnpm verify:headless` 创建临时 profile，把 `DSH_HOME`、`MNEMON_DATA_DIR`、工作区与模型端点都指向夹具内部。

已安装 Mnemon Native CLI 时，可以用隔离 Web profile 验证会话沉淀。夹具使用脚本化模型和临时记忆空间，检查前台零记忆写入、后台正式记忆回执、新会话召回，以及常规校验跳过审查。

```powershell
pnpm build
$env:MNEMO_VERIFY_DISTILLATION = '1'
node tests/checks/verify-web-profile.mjs node_modules/@deepseek-ai/dsh "$env:TEMP/mnemo-distillation-web.json"
```

确定性构建比较两次构建的全部生成文件 hash，两者不一致即失败。它不承诺生产网络延迟或模型质量。

[2026-09-01 策略贡献验证](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/pr-assets/strategy-extensions-20260901/README.md)
记录了共存、独立制品、真实 Headless 激活结果及其边界。

<a id="verification-较早的记录"></a>

#### 较早的记录

[2026-09-04 main rebase 验证记录](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/pr-assets/main-rebase-20260904/README.md)列明精确的 v0.4.7/DSH rc.1 revision、registry 与源码覆盖完整测试、独立制品、插件组合重启持久化和真实双入口验证及其限制。

[2026-08-30 npm 回归记录](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/pr-assets/npm-sidebar-cli/README.md#简体中文)保留了旧 Taskboard/SSH 与 CLI 调查。已移除的历史夹具不是当前 checkout 的命令。

<a id="verification-文档存储与历史证据"></a>

### 文档、存储与历史证据

保持中英文页面一致、公开示例可执行。Mermaid 表达归属和流程；真实截图位于 `docs/assets`。不保留空目录占位或历史转发文件。

没有明确迁移方案与测试前，保留持久格式及配置键。存储改动须验证锁、原子 rename、修订、损坏输入和复制数据根上的升级/回退。

v0.3 benchmark 是冻结的历史结果，不是本架构的性能证明。失效的可执行评估框架已移出工作树；[发布记录](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/releases/v0.3.0.md) 链接到固定版本历史源码。当前验收入口为上述脚本。
