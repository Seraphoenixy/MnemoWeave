# DSH 界面：MnemoWeave 客户端插件（补充规格）

状态：2026-11-09 实现并验证到程序化层面；真实 DSH 会话中的加载与点击尚未验收（见第 8 节）。

本文是 `README.md` 所列十五份规格之外的补充文档，跟随 `runtime-memory.md` 的追加方式；不改变 ADR-001–026，也不把 DSH 客户端层变成 MnemoWeave 的运行时依赖。

## 1. 目标与边界

- 在 DSH 里提供一个**只读**记忆界面：连接与授权状态、记忆搜索与列表、单条记忆详情（正文/版本/关联）、离线意图队列。
- 数据只来自本机 Bridge 的 replica；页面不做召回决策、不写记忆、不改授权、不提交 intent。
- 与 ADR-022 一致：DSH 是 Host 接入目标。界面是 Bridge 读能力的呈现层，不复制 Mnemon 插件运行时、Cordis Fiber 或私有 RPC。
- 参考 `D:\projects\dsh-mnemon-main` 的**插件形态**（`dsh.client` 清单、`window.__ModuleLoader__` 客户端包、Cordis host/client 两半、Slot 注册、Host RPC 通道）；未复制其代码、Slot 名称、RPC 端点或数据契约。

## 2. 结构

实现位于既有 DSH 插件包 `plugins/dsh-mnemo-weave/`，与提示期 View 注入骨架共用同一个可导入包；UI 是独立 Cordis 条目 `dsh-mnemo-weave/ui`。

```
DSH 浏览器页面
  └─ dsh-mnemo-weave/client   （Cordis 客户端插件：注册 main 面板 + sidebar.panellist 入口）
        └─ connection.rpc.call('mnemoweave', 'status' | 'memories' | 'memory' | 'intents')
              └─ dsh-mnemo-weave/ui（Cordis Host 条目，Node，持有 UI token）
                    └─ GET http://127.0.0.1:4319/v1/ui/*   （Bearer + 拒绝 Origin）
                          └─ Bridge.uiStatus / uiMemories / uiMemory / uiIntents
                                └─ replica.db（只读 SQL）+ grant 过滤
```

- UI token 只存在 Bridge 与 Host 进程；浏览器永远拿不到，也不能跨域直连 Bridge（`Origin` 存在即 401）。
- Host RPC 的失败是错误结果（`{ ok:false, error }`），不是空数据。

## 3. Bridge 只读 UI API

代码：`packages/bridge/src/ui-read.ts`（读取与授权过滤）、`apps/bridge/src/ui-server.ts`（HTTP）、`apps/bridge/src/main.ts`（进程接线）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health/live` | 存活探测（仍需 token） |
| GET | `/v1/ui/status` | 配对、grant（范围/到期/代次/撤权）、replica（游标/数据时间/条数/待补正文/是否过期）、意图计数 |
| GET | `/v1/ui/memories?query=&limit=&scope=&projectId=` | 当前版本列表；无 `query` 按发布时间倒序，有 `query` 复用本地检索排序；`scope`/`projectId` 只在已授权集合内收窄；上限 200 |
| GET | `/v1/ui/memories/{memoryId}` | 单条正文（上限 40,000 字符）、版本历史、关联 |
| GET | `/v1/ui/memories/{memoryId}/revisions/{revisionId}` | 指定历史版本的正文（哈希校验后返回）；不存在或未同步返回显式原因 |
| GET | `/v1/ui/intents` | 最近 50 条离线意图（kind/状态/时间/会话），不含完整 payload |

约束：

- 独立 token `MNEMOWEAVE_BRIDGE_UI_TOKEN`（≥24 字符，必须不同于 `MNEMOWEAVE_TOKEN`），端口 `MNEMOWEAVE_BRIDGE_UI_PORT`（默认 4319，必须不同于注入端口）。未设置 token 时不监听。
- 仅 GET；带 `Origin` 一律 401；未知路径 404；非法 `limit`/`memoryId` 400。
- 可用性用显式状态表达，与 `Bridge.recall` 一致：`ok` / `unauthorized` / `unavailable` / `corrupted` 加原因（`unpaired`、`revoked`、`license_expired`、`no_replica`、`out_of_grant`、`not_found`、完整性失败）。未配对或撤权不会伪装成“没有记忆”。
- 每条记录都经 `mayRead(grant, descriptor)`；`status` 在未配对时仍可读，用于解释原因。
- 只读：API 不写 replica、不扩展 grant、不清理意图。

## 4. 插件两半

代码：`plugins/dsh-mnemo-weave/src/`。

| 文件 | 职责 |
|---|---|
| `src/ui/index.ts` | Cordis Host 条目：校验配置（loopback URL、token、超时），注册 `connection.rpc.handle('mnemoweave', …)`，随 Fiber 释放；无 token 时保持惰性并写 stderr 诊断 |
| `src/ui/bridge-client.ts` | Bridge UI 客户端：3 秒超时、响应大小上限、逐字段校验、API 版本检查 |
| `src/ui/rpc.ts` | 端点 `status`/`config`/`memories`/`memory`/`revision`/`intents`；请求校验先于任何读取；错误码透传；`config` 只回地址、Host 与是否有 token，绝不回 token |
| `src/client/index.tsx` | 客户端插件：`inject: ['slots','connection','layout']`；先声明 `main` 面板，再注册 `sidebar.panellist` 入口；任一失败都释放已注册项 |
| `src/client/page.tsx` | 页面：状态标签、搜索（280ms 防抖并取消在途请求）、作用域过滤、列表/详情/历史版本正文、意图队列、错误横幅与重试 |
| `src/client/view-model.ts` | 纯函数：授权/副本标签、相对时间、范围文本、可用性原因；可无 DOM 测试 |
| `src/shared/contract.ts` | 两端共享契约（UI API v1）；自包含，不依赖 MnemoWeave 工作区 |

原有 `lib/index.js`（提示期注入骨架）保持不动，仍由条目 `mnemo-weave` 加载；本 UI 由 `mnemo-weave-ui` 条目加载。

### 热重载（开发用）

参考 `D:\projects\dsh-plugin-harbor` 的做法，不自己清模块缓存，而是让宿主按磁盘上的新代码重新组合：

- `src/ui/hot-reload.ts` 在 **检出形态**（存在 `src/ui/index.ts` 与 `build.mjs`）下监视 `lib/`；产物变化去抖 700ms，调用宿主 `pluginManager.setBundleEnabled('dsh-mnemo-weave', true)` 触发重新组合。`lib/client.js` 不算宿主产物（改它只需刷新页面）。
- 前置条件：profile 的依赖必须 `link:` 到**检出目录**（不是 `dist/` 的拷贝），且宿主提供 `hmr` 服务；缺任一条件时只写一行 stderr 诊断，不假装重载成功。
- `DSH_MNEMO_WEAVE_HOT_RELOAD=0` 关闭监视；打包副本里没有 `src/` 与 `build.mjs`，这段逻辑完全惰性。
- 循环：`node plugins/dsh-mnemo-weave/dev.mjs` 监视 `src/` 并自动重建两半 → 宿主侧自动重新组合 → 浏览器刷新页面拿到新的 `client.js`。
- 首次启用监视器需要重启一次 DSH（监视器代码在已加载的 Host 半里）。

配置（`cordis.patch.yml` 或环境变量）：

```yaml
- insert:
    - id: mnemo-weave-ui
      name: dsh-mnemo-weave/ui
      config:
        bridgeUrl: http://127.0.0.1:4319
        # token 建议留给 MNEMOWEAVE_BRIDGE_UI_TOKEN
```

| 键 | 默认 | 说明 |
|---|---|---|
| `bridgeUrl` | `http://127.0.0.1:4319` | 只接受 loopback HTTP(S)，否则不注册并写诊断 |
| `token` | `MNEMOWEAVE_BRIDGE_UI_TOKEN` | <24 字符时插件保持惰性，不抛出、不中断 DSH 启动 |
| `hostId` | `MNEMOWEAVE_BRIDGE_HOST_ID` | 多 Host 时作为 `x-mnemoweave-host` |
| `timeoutMs` | 3000 | 250–30000 |

## 5. 构建

```bash
node plugins/dsh-mnemo-weave/dev.mjs            # 开发：监视 src/，自动重建两半（宿主侧自动重载）
node plugins/dsh-mnemo-weave/build.mjs          # Host: lib/ui/*、lib/shared/*
node plugins/dsh-mnemo-weave/build-client.mjs   # Client: lib/client.js（__ModuleLoader__ 包装）
node node_modules/typescript/bin/tsc -p plugins/dsh-mnemo-weave/tsconfig.client.json  # 客户端类型检查
node scripts/build-plugins.mjs                  # 打包到 dist/plugins/（会自动先跑上面两个构建）
```

- 客户端用 esbuild 打成单个 CJS 包，`react`、`react-dom`、`react/jsx-runtime`、`@deepseek-ai/*` 保持外部依赖（由 DSH 的模块加载器提供），与参考插件的产物形态一致。
- 构建与契约测试用根 `devDependencies` 的 `esbuild`、`react`、`react-dom`、`@types/react*`；该插件包不在 pnpm workspace 内，因此构建需从仓库根执行，`pnpm-workspace.yaml` 的 `allowBuilds.esbuild` 允许其安装脚本。
- 生成物 `lib/client.js`、`lib/ui/`、`lib/shared/` 已加入 `.gitignore`；手写的注入骨架 `lib/index.js` 仍受版本控制。
- 根 `tsconfig.json` 排除 `plugins/dsh-mnemo-weave/src/client/**`（该目录由专用 `tsconfig.client.json` 以 JSX/DOM 设置检查），Host 与共享契约随根类型检查。

## 6. 安装到 DSH profile

1. 启动 Bridge 并带上 UI token（见第 3 节）。
2. 先运行操作探针，确认 Bridge 侧数据与授权符合预期（它走同一客户端与解析器）：
   `MNEMOWEAVE_BRIDGE_UI_TOKEN=<token> node tests/support/dsh-ui-verify.ts http://127.0.0.1:4319`
3. 让 profile 依赖指向**检出目录**，热重载才能生效：
   `"dsh-mnemo-weave": "link:D:/projects/MnemoWeave/plugins/dsh-mnemo-weave"`（`dist/plugins/...` 是打包拷贝，改了不会自动重载）。
4. 确认 `dsh.bundle.patch` 插入的 `mnemo-weave`、`mnemo-weave-ui` 条目已启用；未生效时按第 4 节 YAML 手工插入 profile 的 `cordis.patch.yml`。
5. 重启一次 DSH（首次加载热重载监视器）；之后 `node plugins/dsh-mnemo-weave/dev.mjs` 即可边改边生效，浏览器刷新页面拿到新的客户端包。
6. 打开侧边栏的“MnemoWeave 记忆”，确认状态标签与授权一致。

本机限制：`%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd` 仍返回 “Harness CLI not found”，因此不能用 `dsh plugin add` 自动安装。2026-11-09 按用户要求把 `profiles/desktop` 的依赖从 `link:...dist/plugins/...` 改到 `link:D:/projects/MnemoWeave/plugins/dsh-mnemo-weave`（并同步 lockfile 的两行 specifier、把 `node_modules` 链接重指到检出目录），备份留在同目录的 `package.json.bak-hotreload`、`pnpm-lock.yaml.bak-hotreload`。

## 7. 验证结果（2026-11-09，本轮）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 构建 | `node node_modules/typescript/bin/tsc` | 通过 |
| 客户端类型 | `node node_modules/typescript/bin/tsc -p plugins/dsh-mnemo-weave/tsconfig.client.json` | 通过 |
| 客户端打包 | `node plugins/dsh-mnemo-weave/build-client.mjs` | 通过（约 38 KiB） |
| Host 构建 | `node plugins/dsh-mnemo-weave/build.mjs` | 通过（`lib/ui/index.js` 等） |
| Unit + Contract | `node --test tests/unit/*.test.ts tests/contract/*.test.ts` | 155/155 通过 |
| 真实 Provider/协议链路 | `node --test tests/e2e/*.test.ts` | 13/13 通过（本日重跑） |
| 热重载判定/去抖/结果 | `tests/unit/dsh-ui-hot-reload.test.ts`（桩宿主 + 真实 fs.watch） | 4/4 通过 |
| 开发循环（监视 `src/` 自动重建） | `node plugins/dsh-mnemo-weave/dev.mjs` + 改动源文件 | 通过（创建/删除源文件各触发一次两半重建） |

新增用例：

- `tests/contract/bridge-ui.test.ts`：状态/列表/检索/详情/版本正文、作用域与项目过滤、grant 越权与未配对、token 与 Origin 拒绝、GET-only、非法参数。
- `tests/contract/dsh-ui-host.test.ts`：真实 UI HTTP 服务上的五个 RPC 端点、请求校验、错误码、API 版本、配置解析、停机 Bridge。
- `tests/contract/dsh-ui-client.test.ts`：用 esbuild 现场打包，在 `vm` 中模拟 `__ModuleLoader__` 执行客户端包，断言 `apply`/`inject`/`name`、`main` + `sidebar.panellist` 注册、样式注入、侧栏注册失败时的回滚；并用 `react-dom/server` 渲染页面外壳，确认中文状态文案存在且没有 `undefined`。
- `tests/unit/dsh-ui-view-model.test.ts`：授权/副本标签、可用性原因、相对时间、列表与详情摘要。
- `tests/unit/dsh-ui-hot-reload.test.ts`：检出判定、宿主产物过滤、宿主结果解析与失败上报、去抖与忽略 `client.js`。
- `tests/support/dsh-ui-verify.ts`：真实 Host 安装前的操作探针。

测试证明的是程序化行为与打包产物结构；没有证明真实 DSH 桌面加载了本插件或用户按预期使用。

## 8. 未完成与限制

1. 未在真实 DSH 桌面会话中点击验收；CLI 仍不可用，插件的加载/热重载只做了程序化验证。
2. 热重载：宿主侧改动自动生效（需 profile 指向检出目录且有 `hmr` 服务，首次需重启一次）；客户端 `client.js` 改动仍需刷新页面，没有做页面级 HMR。
3. 只读：候选审核、写入、冲突处理、设置页尚未接线；这些需要 Bridge 的写/审核通道先有稳定接口。
4. 页面不含会话上下文（不显示“当前会话可见的 View”）；注入仍由 `lib/index.js` 骨架与后续 Host 适配器负责。
5. 未做远程访问（API Gateway）路径；`bridgeUrl` 强制 loopback。
6. 未补充多 Host 切换 UI；`hostId` 目前固定来自配置。
7. 视觉与 DSH 主题只对齐到 CSS 变量与回退值，未做截图级验收。

## 9. 下一步

1. 在真实 DSH 会话完成安装与点击验收，记录版本、profile 路径、截图与日志。
2. 与 `packages/adapters/dsh` 的 Host 适配器共享配置解析，避免两处 token 语义漂移。
3. 待 Bridge 审核通道稳定后，追加候选审核页；写入仍须走 Grants 与 Outbox，不在客户端直接调用。
