# DSH 记忆界面

DSH 的记忆页面实现在既有插件包 `plugins/dsh-mnemo-weave/` 内，是独立 Cordis 条目 `dsh-mnemo-weave/ui`；同包的 `mnemo-weave` 条目仍是提示期注入骨架（未接入 SDK）。

状态：程序化层面已验证，插件已装入 desktop profile；**真实桌面点击与编辑已于 2026-11-10 完成**，证据见第 7 节。

## 1. 边界

- 页面用**九个页签**展示三类记忆（运行时记忆、项目档案、正式记忆）以及概览、实体、探索、图谱、本机↔远端同步状态与设置，默认展示全部项目。正式记忆可**直接新增**（POST /v1/memories，表单里可选知识类型、分类、重要度、标签、实体与范围）与**直接编辑**：走 `PATCH /v1/memories/{id}`，追加不可变 Revision、supersedes 旧记忆、移动当前指针，并把这次改动记录为 `local-user` 的审核决定。准则与档案只读，写入需 operator 凭据。
- 正式记忆页提供范围筛选（全部项目/全局/具体项目）、分类筛选、实体筛选、排序（最新/最早/重要度优先）、关键词搜索与逐步加载（默认每批 25 条，可在设置中修改）；换排序会重新开始扫描——旧游标绑定原排序，服务端会拒绝而不是跳页；项目选项来自 Server 返回的完整 `projects` 索引，分类选项来自 `categories` 索引（含计数，且不随当前筛选收缩），不因未出现在首批结果而不可选。切换筛选或搜索会废弃旧请求。卡片直接显示当前修订的分类、标签与实体；没有记录分类的卡片不显示分类，而不是标成「一般」。
- 关联可先**内联预览**目标正文（含其状态），确认后再跳转；预览按目标缓存，读取失败就地显示原因。
- 新增「图谱」页签：把目录关系画成图。布局是**确定性同心环**（手写 SVG，不引入图形库）：以连接最多的节点为圆心、按跳数分环、环内按 memoryId 排序。每次渲染完全一致——同一张图不会看起来「自己在动」，布局也因此可以被单测固定。节点大小随重要度；没有关系的节点用虚线描边、单独成环；取代关系用高亮线。点击节点直接打开该记忆。
- 详情提供**关联网络**：按需加载目录关系图，从当前记忆广度优先走 2 跳，每条邻居标注关系类型、方向与跳数；同一记忆只报最短跳数的那一次，避免暗示两条关系。图节点被截断时明确提示只显示了一部分。切换记忆会清空已加载的邻域，不会把上一个记忆的网络显示在新记忆旁边。
- 详情独立记录 `currentRevisionId` 与 `selectedRevisionId`：点选历史版本只读该版正文，可随时返回当前版，并可将历史版与当前版并排比较（窄屏上下排列、各自滚动）。历史版本只读，编辑入口只在当前版出现。
- 新增「实体」页签：按记忆当前修订记录的实体浏览，实体名可再筛选，条目带计数；选中一个实体会应用到正式记忆列表（只保留一个结果视图，避免两处列表互相漂移）。实体索引由 Server 从整个作用域计算，因此用一行的列表请求即可取回，不额外读正文。DSH 与 dsh 合并为一条并保留首次出现的拼写，与列表的实体筛选规则一致。
- 新增「探索」页签：按语义相似度搜索本机 Provider。它和正式记忆列表是两种检索——列表是稳定扫描 + 正文匹配，探索是 Provider 排序；结果只包含本机已登记、可打开的记忆，未登记的 Provider 命中只显示条数。命中可直接打开到正式记忆页的详情。页面提供**相似度门槛**（默认 0.5）：Provider 对无关查询也会给非零分，没有门槛时排序列表会被当成答案；结果为空时提示可以调低门槛。「显示更多」用更大的 limit 重新查询（探索没有游标，偏移分页会重复或丢行），已到单次上限 50 条时改为提示缩小查询。
- 详情展示 Server 已返回的完整数据：修订链（父修订、内容哈希、生效时间；父修订缺失会标出而不是略过）、分类（知识类型或分类/重要度）、标签与实体、关系（方向、`Supersedes`/`RelatedTo`、原因、证据、是否已写入 Provider）、以及未解决的冲突与已有裁定。此前这些字段被解析层丢弃，页面看起来完整但只显示了一半数据。分类按修订记录：查看历史版时显示的是那一版的分类，缺失就留空，不推测。
- 撤回是编辑的对应操作，入口在当前版正文旁：必须填写原因，确认后记忆退出召回与注入，历史版本仍可查看与比较，且不能再被二次撤回。
- 关联来自详情接口已有的关系，目标不可读时明确提示，不显示空面板。
- 窄屏一次只显示一个面板；两个面板都保持挂载，返回列表时筛选、选中条目与滚动位置都保留。
- 打开编辑器时保存详情返回的 `entryVersion`，随表单原样提交。页面不得在保存时改用本机最新版本：后台同步可能已经推进版本，改了基准就会静默覆盖另一台机器的修改。重新读取详情本身也不改变提交基准。
- 编辑表单除正文与原因外，还可设置分类、重要度与标签；未改动的字段显示为「保持不变」，提交时整项省略，因此新修订继承原值而不是被清空。标签留空即清空。后台刷新详情不会移动基准；收到 `VERSION_CONFLICT` 后再次点击保存仍按旧基准提交并再次被拒，直到用户显式点「改用最新版本作为基准」。没有这条约束，一次冲突后连点两次就能把旧草稿写到新版本上，绕过合并确认。显示 UTF-8 字节计数，空白、超过 8000 字节或正文无变化（相对打开时的原文）时禁止保存。关闭详情、切换条目、切换版本或离开页签前，若存在未提交草稿会先询问「继续编辑 / 丢弃草稿」。
- 保存成功后用返回的 `revisionId` 读取新正文并定位该版本，验收要求一次保存只追加一条 Revision 且父节点为编辑前的当前版。冲突时保留草稿与原文，另取最新正文供对照。<br>同步状态分三种提示且都**暂停重复提交**（按钮变为「等待结果，暂不可重复提交」）：`SYNC_QUEUED`（已排队）、`SYNC_OUTCOME_UNKNOWN`（结果待确认）、`NEEDS_REVIEW`（远端已确认、本机待应用）。
- **编辑与撤回不需要第二把凭据。** 这是个人项目：服务令牌与 operator 令牌由同一个人持有，多一道校验无法区分「用户点击」与「宿主代码」。两类写操作只要求服务令牌 + `x-mnemoweave-host`，Host 头缺失则拒绝；写入仍记录为 `local-user` 审核决定，审计里能证明的是发起请求的宿主。Host 半不读取 `MNEMOWEAVE_OPERATOR_TOKEN`，设置页也不再显示「操作员令牌」一项。原先的一次性确认码更早已移除，因为申请方与使用方是同一个，不构成证明。
- 页面不做召回决策、不改授权、不提交候选。候选审核仍只走 `POST /v1/review`（operator）。
- 数据只来自本机 Server；浏览器不持有令牌，也不能直连 Server（带 `Origin` 即被拒）。

## 2. 数据链路

```
DSH 浏览器页面
  └─ dsh-mnemo-weave/client   （注册 main 面板 + sidebar.panellist 入口）
        └─ connection.rpc.call('/dsh-mnemo-weave', 'status'|'config'|'memories'|'memory'|'edit'|'injection'|'rules'|'archives'|'sync'|'syncRefresh'|'settings'|'saveInterface'|'saveConnection'|'saveInjection'|'saveAutoStart'|'testConnection'|'testWake')
              └─ dsh-mnemo-weave/ui（Node，持有服务令牌）
                    ├─ SettingsService → src/shared/host-config.js（与注入钩子共用的唯一配置读取）
                    └─ MemoryClient → http://127.0.0.1:4317（Bearer + x-mnemoweave-host）
```

页面与提示注入**共用一份 Host 配置**：`plugins/dsh-mnemo-weave/src/shared/host-config.js` 是唯一读取处，Host 半由 esbuild 内联，注入钩子 `lib/index.js` 直接 import 构建时复制到 `lib/host-config.js` 的同一文件。非敏感值按「页面偏好 → DSH 配置 → 环境变量 → 默认值」解析，并在设置页标注来源；令牌只从 DSH 配置或环境变量读取，永不写入偏好文件、也永不回传浏览器。

RPC 通道名必须是 `/dsh-mnemo-weave`：DSH 校验 `/^\/[A-Za-z0-9._~-]+$/` 且禁止 `/api`。Host 半以 `inject: ['connection','webServer']` 注册，并用 `ctx.extend({ webServer })` 把服务变成注册上下文的自有属性。

RPC 失败返回错误结果（`{ ok:false, error }`），不伪装成空数据。

## 3. 使用的 Server 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health/ready` | 页面状态栏的可用性 |
| GET | `/v1/memories?query=&limit=&scope=&projectId=&cursor=` | 列表。`scope` 为 `all`/`global`/`project`，先按范围选候选、再按正文匹配；`cursor` 记录扫描位置，响应带 `nextCursor` 与全部项目的 `projects` 索引 |
| GET | `/v1/memories/{memoryId}` 或 `/v1/memories/{memoryId}?revisionId=` | 详情：正文、Revision 历史、关联、`currentRevisionId`/`selectedRevisionId` 与 `entryVersion`；带 `revisionId` 即读历史版本 |
| POST | `/v1/memories` | 新增：{content, knowledgeType, category?, importance?, tags?, entities?, scope?, projectId?, reason?}，正文 1–8000 字节；直接发布为正式记忆，不经过候选审核 |
| PATCH | `/v1/memories/{memoryId}` | 编辑：`{content, entryVersion, reason?, category?, knowledgeType?, importance?, tags?}`，正文 1–8000 UTF-8 字节；`entryVersion` 取自打开编辑器时的详情；省略的分类字段继承上一版 |
| POST | `/v1/memories/{memoryId}/withdraw` | 撤回：新增撤回版本，历史仍可读；服务令牌 + Host 头即可 |
| GET | `/v1/memories/graph?scope=&projectId=&limit=` | 图谱：节点是作用域内的 `active` 记忆、边是两端都在节点集里的目录关系；**不含正文**、不含悬空边 |
| POST | `/v1/memories/explore` | 探索：`{query, limit≤50, minScore}`，按 Provider 相似度排序并映射回本机目录 |
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
| 客户端契约 | `node --test tests/contract/dsh-ui-client.test.ts` | 通过：注册与回滚、标签回退、九页签外壳、端点调用与错误码透传、Host 侧校验先于远端调用、注入报告、准则/档案/同步端点、编辑分类校验、图谱请求边界 |
| 页签端点解析 | `node --test tests/contract/dsh-ui-endpoints.test.ts` | 4/4 通过：准则/档案/同步状态/同步趟次逐字段校验，非法枚举与非整数计数报 `PROVIDER_PROTOCOL` |
| 视图模型 | `node --test tests/unit/dsh-ui-view-model.test.ts` | 7/7 通过：状态标签、秒级相对时间、到秒的绝对时间、可用性原因与错误码文案 |
| Host 半打包 | `node plugins/dsh-mnemo-weave/build.mjs` | 通过：`packages/client` 被内联进 `lib/ui/index.js`，打包副本不依赖检出目录 |
| 客户端打包 | `node plugins/dsh-mnemo-weave/build-client.mjs` | 通过：`lib/client.js` 约 176 KiB，含九个页签与面板（含手写 SVG 图谱） |
| 真实桌面点击（2026-11-10） | 在运行中的 DSH 桌面打开「记忆中枢」，列出 2 条记忆、打开项目记忆、修改正文并保存 | 通过。服务端核对：列表正文与页面一致、`entryVersion` 1 → 2、`formal_map` 新增 v2、发布目录第 3 个 Revision、Mnemon `show` 返回新正文、`related --edge supersedes` 指向前一版 |
| 提示注入送达（2026-11-10） | 新建会话发一句话，检查 Server 的注入记录 | 通过：新增 `hostId dsh`、新会话 id 的记录，`rulesInjected 1`；渲染顺序由 `tests/contract/dsh-host-inject.test.ts` 约束 |
| 连接配置 | desktop profile 的 `mnemo-weave-ui.config` | 修正：原 `bridgeUrl` 不是插件读取的键（被忽略、回落到 4317 默认值），已改为 `serverUrl: http://127.0.0.1:4317`，令牌不变；`mnemo-weave` 条目补上 `serverUrl` / `projectId` / `token` |
| 设置页真机验收（2026-11-11） | `work/desktop-acceptance/settings-acceptance.mjs` 加载**已部署**的 `dist` 产物，读真实 profile patch、真实用户级令牌、真实偏好文件、真实 Server | 14/14 通过：配置解析、令牌来源为环境变量且不出现在页面可读数据中、页面与注入钩子解析一致、偏好写入 `%USERPROFILE%\.dsh\profiles\desktop\mnemo-weave.settings.json` 且无凭据、改写后解析立即变化、非 loopback 被拒、真实 `/health/live` 与 `/health/ready` 正常 |
| 唤醒真机验收（2026-11-11） | `work/desktop-acceptance/wake-acceptance.mjs`：先 `schtasks /end` 停掉 Server，再走 `testWake` | 6/6 通过：运行中报 `already_running`；停止后连接测试报 `connection_refused`；唤醒后报 `woken` 且服务身份正确；任务缺失报 `task_missing`；只启动不就绪报 `timeout` |
| 页面刷新与点击 | 触达方式 | **未执行**：DSH 的 RPC 需网页令牌，外部无法代点；需在桌面点击确认 |

测试证明的是程序化行为与打包产物结构；真实点击一项记录的是 2026-11-10 在本机 desktop profile 上的实际观察。

## 6.1 设置页（2026-11-11）

设置页签，沿用参考项目的两种保存方式：**低风险偏好即时保存，连接与注入设置按组应用**。

| 分组 | 设置项 | 保存与生效 |
|---|---|---|
| 界面 | 默认页签、正式记忆默认范围、每批条数 | 写入偏好文件并立即生效，只影响页面浏览 |
| 本机连接 | loopback 地址、Host 标识 | 先校验再「测试连接」，通过后才切换连接客户端；失败保留旧连接 |
| 令牌 | 状态与来源 | 只显示是否已配置与鉴权结果，不读取、不回传 |
| 自动启动 | 是否在连接被拒绝时唤醒本机 Server、测试唤醒 | 即时保存；计划任务名只读；测试结果区分「已在运行 / 已唤醒 / 任务缺失 / 启动超时 / 失败」 |
| 提示注入 | 注入项目、注入等待上限 | 按组应用；项目与列表默认筛选独立；上限限制在 250–1900 毫秒，计入两秒总截止 |
| 同步与诊断 | 偏好文件路径 | 只读摘要，计数与刷新在「同步」页 |

每项都标注来源（页面偏好 / DSH 配置 / 环境变量 / 默认值），避免「保存成功但运行仍读另一处值」。

偏好文件默认 `%USERPROFILE%\.dsh\mnemo-weave.settings.json`，可用 `MNEMOWEAVE_DSH_SETTINGS` 或 `DSH_PROFILE_DIR` 覆盖；写入采用临时文件 + rename，损坏文件回落到默认值而不是让页面失效。

## 8. 未完成

1. 真实桌面会话中侧边栏入口、列表与编辑的点击验收已于 2026-11-10 完成（第 7 节）；注入适配器（提示级注入）仍未实现。
2. 客户端 `lib/client.js` 改动仍需刷新页面，没有页面级 HMR。
3. 只读以外的能力做到编辑正文与撤回：候选审核、冲突裁定、项目归属与关联修改仍不在页面内。
4. 设置页的**界面点击未执行**：已用已部署产物在真机跑通配置解析、偏好读写、连接测试与唤醒测试（第 7 节，14/14 与 6/6），但页面刷新后在桌面上点击仍待人工确认。DSH 的 RPC 通道经网页令牌鉴权，外部无法代点。
5. 原生插件设置入口未接线：需先确认当前 DSH 版本是否支持该入口，再复用同一表单；工作区设置页已交付。
6. 偏好文件位于 profile 目录（`DSH_PROFILE_DIR` 存在时），而非 `~/.dsh` 根目录；两者都受支持，文档与本机实际位置以 profile 为准。
5. 准则注入状态已实现：状态行显示本宿主最近一次注入的准则条数、记忆条数与估算 token，准则因预算未注入时标注并转为警示色；数据来自 `GET /v1/injections/latest`，由 Server 按 Host 头限定到本宿主。
6. 同步状态栏与手动刷新对**带 Host 头的宿主**开放，原因写在代码里：`GET /v1/sync/status` 与 `POST /v1/sync/refresh` 的响应只含「已确认游标、待推送/待确认/待应用计数、最近一次拉取时间与错误」，**不含设备令牌、远端地址或任何凭据**，所以给宿主看同步视图不等于把设备凭据边界并入宿主——凭据始终只在 Server 的环境变量里。此前文档写「只接受 operator 令牌」，与实现不符（实现是 `if (!isOperator) requireHost()`），已按实现修正；边界在于**必须自报身份**，没有 Host 头一律 401。
5. 无远程访问路径，`serverUrl` 强制 loopback；无多 Host 切换 UI。
6. 视觉只对齐到 DSH 主题 CSS 变量与回退值，未做截图级验收。
