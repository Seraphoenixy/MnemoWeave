# DSH 记忆界面

DSH 的记忆页面实现在既有插件包 `plugins/dsh-mnemo-weave/` 内，是独立 Cordis 条目 `dsh-mnemo-weave/ui`；同包的 `mnemo-weave` 条目仍是提示期注入骨架（未接入 SDK）。

状态：程序化层面已验证，插件已装入 desktop profile；**真实桌面点击与编辑已于 2026-11-10 完成**，证据见第 7 节。

## 1. 边界

- 页面用顶栏页签展示三类记忆（运行时记忆、项目档案、正式记忆）以及概览与本机↔远端同步状态，默认展示全部项目。正式记忆可**直接编辑**：走 `PATCH /v1/memories/{id}`，追加不可变 Revision、supersedes 旧记忆、移动当前指针，并把这次改动记录为 `local-user` 的审核决定。准则与档案只读，写入需 operator 凭据。
- 打开编辑器时保存详情返回的 `entryVersion`，随表单原样提交。页面不得在保存时改用本机最新版本：后台同步可能已经推进版本，改了基准就会静默覆盖另一台机器的修改。
- 页面不做召回决策、不改授权、不提交候选。候选审核仍只走 `POST /v1/review`（operator）。
- 数据只来自本机 Server；浏览器不持有令牌，也不能直连 Server（带 `Origin` 即被拒）。

## 2. 数据链路

```
DSH 浏览器页面
  └─ dsh-mnemo-weave/client   （注册 main 面板 + sidebar.panellist 入口）
        └─ connection.rpc.call('/dsh-mnemo-weave', 'status'|'config'|'memories'|'memory'|'edit'|'injection'|'rules'|'archives'|'sync'|'syncRefresh')
              └─ dsh-mnemo-weave/ui（Node，持有服务令牌）
                    └─ MemoryClient → http://127.0.0.1:4317（Bearer + x-mnemoweave-host）
```

RPC 通道名必须是 `/dsh-mnemo-weave`：DSH 校验 `/^\/[A-Za-z0-9._~-]+$/` 且禁止 `/api`。Host 半以 `inject: ['connection','webServer']` 注册，并用 `ctx.extend({ webServer })` 把服务变成注册上下文的自有属性。

RPC 失败返回错误结果（`{ ok:false, error }`），不伪装成空数据。

## 3. 使用的 Server 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health/ready` | 页面状态栏的可用性 |
| GET | `/v1/memories?query=&limit=` | 列表；`limit` 1–200，`query` 空格分词过滤 |
| GET | `/v1/memories/{memoryId}` | 详情：正文、Revision 历史、关联、`entryId` 与 `entryVersion`；正文经哈希校验 |
| PATCH | `/v1/memories/{memoryId}` | 编辑：`{content, entryVersion, reason?}`，正文 1–8000 UTF-8 字节；`entryVersion` 取自打开编辑器时的详情 |
| GET | `/v1/sync/status` | 本机 Server 与远端同步 Server 的状态，按范围给出游标、待推送、待确认、待应用与最近错误 |
| POST | `/v1/sync/refresh` | 「同步」页签的手动触发，返回本次趟次的拉取与应用计数 |
| GET | `/v1/rules` | 「运行时记忆」页签，宿主得到全部项目的条目 |
| GET | `/v1/archives` | 「项目档案」页签，省略 `projectId` 即全部项目 |
| GET | `/v1/injections/latest` | 顶部注入摘要与本宿主最近一次注入 |

准则与档案只读；写入端点（`POST/PATCH /v1/rules`、`POST /v1/archives`）仍只接受 operator 令牌，页面不提供写入口。同步未配置时 `sync/status` 返回 409，页面显示「本机未配置远端同步」而不是空白。

### 3.1 顶栏页签

| 页签 | 内容 |
|---|---|
| 概览 | 三类计数、涉及项目与范围数、最近一次注入（准则/记忆/token/会话/时间）、本机↔远端同步汇总、服务信息 |
| 运行时记忆 | 全文、适用范围、启用状态、版本；页脚注明修改需 operator |
| 项目档案 | 标题、正文、来源、验证状态、证据、版本 |
| 正式记忆 | 搜索、列表（全部项目，行内标注项目与范围）、详情、Revision 历史、编辑 |
| 同步 | 每个范围一行：游标、待推送、待确认、待应用、最近拉取、最近错误；顶部「立即同步」 |

页签顺序照抄 dsh-mnemon 的页面 `order`：runtime 100 → documents 200 → memory-spaces 300；本页把档案对应 documents、正式记忆对应 memory-spaces，跨类的概览作为落地页放在最前，同步与设置类页面一样放在末尾。

概览是默认页签，页面加载时并行拉取四类数据；单类失败只影响对应页签，不遮蔽其余内容。

编辑失败按错误码显示：`INVALID_INPUT`（内容长度/JSON）、`NOT_FOUND`、`INVALID_STATE`（记忆已 superseded 或 unverified）、`PROVIDER_UNAVAILABLE` / `PROVIDER_INTEGRITY`；启用同步后另有 `VERSION_CONFLICT`（保留草稿并展示差异，基于新版本重提）、`SYNC_QUEUED`（未到达远端，已排队，可继续编辑）与 `SYNC_OUTCOME_UNKNOWN`（已发出但结果未知，显示「确认中」，不要重复提交）。

## 4. 插件两半

| 文件 | 职责 |
|---|---|
| `src/ui/index.ts` | Host 条目：校验配置（loopback URL、token、hostId），注册 RPC，随 Fiber 释放；无 token 时保持惰性并写 stderr 诊断 |
| `src/ui/rpc.ts` | 五个端点；请求校验先于任何远端调用；错误码透传；`config` 只回地址、Host 与是否有 token |
| `src/client/index.tsx` | 客户端插件：`inject: ['slots','connection','layout','locale']`；先声明 `main` 面板，再注册 `sidebar.panellist`，失败时回滚 |
| `src/client/i18n.ts` | zh/en 文案；中文侧栏标签与页面标题统一为「记忆中枢」，英文为 `MnemoWeave Memory` |
| `src/client/page.tsx` | 状态栏、搜索（280 ms 防抖并取消在途请求）、列表/详情、编辑表单（保存/取消）、错误横幅与重试 |
| `src/client/view-model.ts` | 纯函数：状态标签、相对时间（秒级）、绝对时间（到秒）、范围文本、可用性原因 |
| `src/shared/contract.ts` | 两端共享的最小类型（RPC 通道与请求/响应形状），自包含，不依赖工作区 |

侧边栏在注册和每次语言变更时都会调用 `label`。真实客户端树对未注入服务的读取直接抛错，异常会中止侧边栏条目并让 web boot 失败，因此 `label` 与面板注入都经带 try/catch 的读取函数取 locale，读取失败回退英文标签。这条约束有专门的契约用例。

## 5. 配置与构建

```yaml
- insert:
    - id: mnemo-weave-ui
      name: dsh-mnemo-weave/ui
      config:
        serverUrl: http://127.0.0.1:4317
        # token 来自 MNEMOWEAVE_TOKEN
        # hostId 来自 MNEMOWEAVE_HOST_ID
```

| 键 | 默认 | 说明 |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:4317` | 只接受 loopback HTTP(S)，否则不注册并写诊断 |
| `token` | `MNEMOWEAVE_TOKEN` | 少于 24 字符时插件保持惰性，不抛出、不中断 DSH 启动 |
| `hostId` | `MNEMOWEAVE_HOST_ID` | 作为 `x-mnemoweave-host` 发送 |

```bash
node plugins/dsh-mnemo-weave/dev.mjs            # 开发：监视 src/，自动重建两半
node plugins/dsh-mnemo-weave/build.mjs          # Host: lib/ui/*、lib/shared/*
node plugins/dsh-mnemo-weave/build-client.mjs   # Client: lib/client.js（__ModuleLoader__ 包装）
node node_modules/typescript/bin/tsc -p plugins/dsh-mnemo-weave/tsconfig.client.json
node scripts/build-plugins.mjs                  # 打包到 dist/plugins/
```

- 客户端用 esbuild 打成单个 CJS 包，`react`、`react-dom`、`react/jsx-runtime`、`@deepseek-ai/*` 保持外部依赖。
- 插件包不在 pnpm workspace 内，构建需从仓库根执行；Host 半直接以相对路径 import `packages/client`。
- 生成物 `lib/client.js`、`lib/ui/`、`lib/shared/` 已忽略；手写的 `lib/index.js` 仍受版本控制。
- 根 `tsconfig.json` 排除 `plugins/dsh-mnemo-weave/src/client/**`，该目录由 `tsconfig.client.json` 单独检查。

热重载（开发用）：检出形态下 `src/ui/hot-reload.ts` 监视 `lib/`，产物变化去抖 700 ms 后调用宿主 `pluginManager.setBundleEnabled('dsh-mnemo-weave', true)` 触发重新组合。前提是 profile 依赖 `link:` 到**检出目录**且宿主提供 `hmr` 服务；缺任一条件只写 stderr 诊断。`lib/client.js` 不算宿主产物，改完刷新页面即可。首次启用监视器需要重启一次 DSH。

## 6. 安装与验收

```powershell
dsh plugin --profile desktop add 'link:D:/project/MnemoWeave/plugins/dsh-mnemo-weave'
```

该命令一次写入 dependencies、`dsh.profile.bundles` 与 lockfile。`link:` 路径以本机检出的 `plugins/dsh-mnemo-weave` 为准；`dist/plugins/...` 是打包拷贝，改了不会自动重载。

页面数据需要三项同时成立：Server 已启动、`MNEMOWEAVE_TOKEN` 已设置、profile 的 UI 条目读到同一 token 与 `MNEMOWEAVE_HOST_ID`。缺 token 时宿主条目仍在、页面仍能打开，但只显示不可用原因。

安装前可用操作探针核对 Server 侧数据：

```bash
MNEMOWEAVE_TOKEN=<token> MNEMOWEAVE_HOST_ID=dsh-host node tests/support/dsh-ui-verify.ts http://127.0.0.1:4317
```

编辑验收时确认：保存后详情正文更新、`GET /v1/memories/{id}` 的 Revision 历史出现新版本且父指针指向旧版本、Mnemon `show` 返回的是新正文。

## 7. 验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 客户端类型 | `tsc -p plugins/dsh-mnemo-weave/tsconfig.client.json` | 通过 |
| 客户端打包 | `node plugins/dsh-mnemo-weave/build-client.mjs` | 通过 |
| 客户端契约 | `node --test tests/contract/dsh-ui-client.test.ts` | 8/8 通过：注册与回滚、标签回退、五页签外壳、端点调用与错误码透传、Host 侧校验先于远端调用、注入报告、准则/档案/同步端点 |
| 页签端点解析 | `node --test tests/contract/dsh-ui-endpoints.test.ts` | 4/4 通过：准则/档案/同步状态/同步趟次逐字段校验，非法枚举与非整数计数报 `PROVIDER_PROTOCOL` |
| 视图模型 | `node --test tests/unit/dsh-ui-view-model.test.ts` | 7/7 通过：状态标签、秒级相对时间、到秒的绝对时间、可用性原因与错误码文案 |
| Host 半打包 | `node plugins/dsh-mnemo-weave/build.mjs` | 通过：`packages/client` 被内联进 `lib/ui/index.js`，打包副本不依赖检出目录 |
| 客户端打包 | `node plugins/dsh-mnemo-weave/build-client.mjs` | 通过：`lib/client.js` 75 KiB，含五页签与面板 |
| 真实桌面点击（2026-11-10） | 在运行中的 DSH 桌面打开「记忆中枢」，列出 2 条记忆、打开项目记忆、修改正文并保存 | 通过。服务端核对：列表正文与页面一致、`entryVersion` 1 → 2、`formal_map` 新增 v2、发布目录第 3 个 Revision、Mnemon `show` 返回新正文、`related --edge supersedes` 指向前一版 |
| 提示注入送达（2026-11-10） | 新建会话发一句话，检查 Server 的注入记录 | 通过：新增 `hostId dsh`、新会话 id 的记录，`rulesInjected 1`；渲染顺序由 `tests/contract/dsh-host-inject.test.ts` 约束 |
| 连接配置 | desktop profile 的 `mnemo-weave-ui.config` | 修正：原 `bridgeUrl` 不是插件读取的键（被忽略、回落到 4317 默认值），已改为 `serverUrl: http://127.0.0.1:4317`，令牌不变；`mnemo-weave` 条目补上 `serverUrl` / `projectId` / `token` |

测试证明的是程序化行为与打包产物结构；真实点击一项记录的是 2026-11-10 在本机 desktop profile 上的实际观察。

## 8. 未完成

1. 真实桌面会话中侧边栏入口、列表与编辑的点击验收已于 2026-11-10 完成（第 7 节）；注入适配器（提示级注入）仍未实现。
2. 客户端 `lib/client.js` 改动仍需刷新页面，没有页面级 HMR。
3. 只读以外的能力只做到编辑正文：候选审核、冲突处理、删除、设置页未接线。
5. 准则注入状态已实现：状态行显示本宿主最近一次注入的准则条数、记忆条数与估算 token，准则因预算未注入时标注并转为警示色；数据来自 `GET /v1/injections/latest`，由 Server 按 Host 头限定到本宿主。
6. 同步状态栏与手动刷新不提供给宿主：`/v1/sync/status` 与 `/v1/sync/refresh` 只接受 operator 令牌，宿主只持有服务令牌，给它同步视图等于把设备凭据边界并入宿主。同步状态因此只在 Server 侧（operator 端点）可读。
5. 无远程访问路径，`serverUrl` 强制 loopback；无多 Host 切换 UI。
6. 视觉只对齐到 DSH 主题 CSS 变量与回退值，未做截图级验收。
