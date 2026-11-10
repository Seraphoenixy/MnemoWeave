# dsh-mnemo-weave（DSH 插件包）

一个可供 DSH 导入的 Cordis 包，包含两个独立条目：

| 条目 | 入口 | 内容 | 状态 |
|---|---|---|---|
| `dsh-mnemo-weave` | `lib/index.js` | 提示期 View 注入（`system-prompt/assemble`，准则 → 工作上下文 → 正式记忆） | 已可运行：真实会话已在 Server 端留下注入记录 |
| `dsh-mnemo-weave/ui` | `lib/ui/index.js` + `lib/client.js` | 可编辑记忆界面：侧边栏入口、连接状态、搜索、详情、编辑 | 已程序化验证，并在 2026-11-10 完成真实点击与编辑验收 |

界面规格与验收细节见仓库 `docs/dsh-ui.md`。

## 记忆界面

数据流：浏览器页面 → Host RPC（`/dsh-mnemo-weave` 通道）→ 共享 `packages/client` → `http://127.0.0.1:4317`（MnemoWeave Server）。Host 用服务令牌认证，并通过 `x-mnemoweave-host` 自报身份；令牌只留在 Host 进程里，页面既拿不到令牌，也不直连 Server。没有本地代理进程、副本或离线队列。

Host 半（`src/ui/`）：

- `index.ts`：Cordis 插件；`inject: ['connection','webServer']`，注册 `connection.rpc.handle('/dsh-mnemo-weave', …)`。DSH 只接受 `/` 开头且匹配 `/^\/[A-Za-z0-9._~-]+$/` 的通道名；注册时的上下文还必须带 `webServer`（`connection.rpc` 以读取该服务的上下文为 owner，路由挂在该 owner 的 web server 上），否则条目分别以 `invalid or reserved RPC channel` 与 `cannot get property "webServer" without inject` 失败。配置非法或缺 token 时只写 stderr 诊断，不中断 DSH。
- `memory-source.ts`：`MemoryClient` 的薄封装；逐字段校验 Server 应答（`MemoryList`、`PublishedMemoryOutput`、`MemoryEditOutput`、`/health/ready`），不匹配时报 `PROVIDER_PROTOCOL`，不把畸形数据当内容显示。
- `rpc.ts`：`status`/`memories`/`memory`/`edit`/`config` 五个端点；请求先校验，再调用 Server，Server 的错误码原样回传。
- `hot-reload.ts`：开发期产物监视，与网络配置无关。

客户端半（`src/client/`）：

- `index.tsx`：`inject: ['slots','connection','layout','locale']`；注册 `main` 面板与 `sidebar.panellist` 入口，失败时回滚已注册项。侧栏中文标签 `LABEL_ZH` 与页面标题 `page.title` 统一为四个字「记忆中枢」，英文侧为 `MnemoWeave Memory`。侧边栏在注册与每次语言变更时都会调用 `label`，因此读取 locale 走带回退的读取函数：读取抛错或服务缺失时回退为英文标签，不让异常逃逸。
- `page.tsx`：连接状态、搜索（防抖 + 取消在途请求）、列表/详情、详情内编辑（textarea + 保存 + 取消），保存成功后刷新该条详情与列表，失败显示错误横幅并可重试。
- `api.ts`、`view-model.ts`、`i18n.ts`：RPC 调用、可无 DOM 测试的纯函数与 zh/en 文案。
- `styles.ts`：一次性注入的样式表，颜色优先使用 DSH 主题变量。

共享契约：`src/shared/contract.ts`，自包含，只保留与 Server 契约一致的最小类型。

## RPC 端点

| 端点 | 请求 | 应答 |
|---|---|---|
| `status` | `{}` | 可用性、服务地址、Host 标识、检查时间、Server 版本 |
| `memories` | `{ query?, limit? }`，`limit` 1–200，默认 50 | `{ query, limit, returned, items }` |
| `memory` | `{ memoryId }`（UUID） | 选中版本的正文、元数据与版本列表 |
| `edit` | `{ memoryId, content, reason? }` | 新 `revisionId`、`providerMemoryId`、`contentHash` |
| `config` | `{}` | `{ serverUrl, hostId, hasToken }`，不含 token |

`edit` 对应 Server 的 `PATCH /v1/memories/{id}`：追加不可变 Revision、取代旧 Provider 记忆并移动当前指针，不经过候选审核；模型没有这个入口。

## 配置

`cordis.patch.yml` 已插入两个条目。UI 条目的可调项：

| 键 | 默认 | 说明 |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:4317` | 只接受 loopback HTTP(S)；两个条目都读这个键 |
| `token` | `MNEMOWEAVE_TOKEN` | ≥24 字符；放在 Cordis 条目配置或环境变量；缺失或过短时对应条目保持惰性 |
| `hostId` | `MNEMOWEAVE_HOST_ID`，缺省 `dsh` | 作为 `x-mnemoweave-host` 自报身份 |
| `projectId` | `MNEMOWEAVE_PROJECT_ID` | 仅注入条目使用；作为 `x-mnemoweave-project` 头 |

Server 侧需要设置同一个 `MNEMOWEAVE_TOKEN`；宿主只需能访问该 loopback 地址。

## 构建

```bash
node plugins/dsh-mnemo-weave/dev.mjs            # 开发：监视 src/，自动重建两半
node plugins/dsh-mnemo-weave/build.mjs          # lib/ui/index.js（esbuild 打包 Host 半）
node plugins/dsh-mnemo-weave/build-client.mjs   # lib/client.js
node scripts/build-plugins.mjs                  # 两半一起打包进 dist/plugins/dsh-mnemo-weave
```

Host 半从仓库 `packages/client` 以相对路径 import，因此 `build.mjs` 用 esbuild 把它内联进 `lib/ui/index.js`：打包副本不依赖检出目录。`lib/index.js` 是手写的注入骨架，构建不会覆盖它。

## 热重载（开发）

参考 dsh-plugin-harbor 的做法，插件自己不清模块缓存：

1. profile 里本包必须是 `link:` 指向**检出目录**（不是 `dist/` 拷贝）。
2. Host 半在检出形态下监视 `lib/`，产物变化去抖 700ms 后调用
   `pluginManager.setBundleEnabled('dsh-mnemo-weave', true)`，由宿主按磁盘上的新代码重新组合。
3. `DSH_MNEMO_WEAVE_HOT_RELOAD=0` 关闭；打包副本里没有 `src/`/`build.mjs`，这段逻辑完全惰性。
4. 客户端 `lib/client.js` 不算宿主产物：改完刷新页面即可，不触发重新组合。
5. 监视器首次生效需要重启一次 DSH；之后 `node plugins/dsh-mnemo-weave/dev.mjs` 即可边改边生效。

## 安装前自检

```bash
MNEMOWEAVE_TOKEN=<token> node tests/support/dsh-ui-verify.ts http://127.0.0.1:4317
```

它会按插件相同的方式读取健康状态、少量记忆与一条详情并打印结果；不写入任何记忆。

## 提示期注入

- 导出：`name`、`inject`、`apply(ctx, config)`；事件入口 `agent/created` → `system-prompt/assemble`、`agent/turn-stopping`。
- 每个会话首次组装提示词时请求 `POST /v1/inject`（1.9 秒超时），把 View 渲染成固定顺序的一段：`Runtime rules` → `Working context` → `Formal memories`；准则因预算整块省略时渲染一行说明。
- 成功送达后才记该会话已注入；Server 不可达时下一轮重试，不阻塞对话。
- 渲染函数 `render` 从 `lib/index.js` 导出并有契约测试（`tests/contract/dsh-host-inject.test.ts`），与共享 `packages/client/src/render.ts` 的顺序与文案保持一致。
- 2026-11-10 在真实桌面会话中观察到 Server 端新增注入记录（`hostId dsh`、新会话 id、`rulesInjected 1`）。
