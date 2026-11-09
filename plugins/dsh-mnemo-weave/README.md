# dsh-mnemo-weave（DSH 插件包）

一个可供 DSH 导入的 Cordis 包，包含两个独立条目：

| 条目 | 入口 | 内容 | 状态 |
|---|---|---|---|
| `dsh-mnemo-weave` | `lib/index.js` | 提示期 View 注入骨架（`system-prompt/assemble`） | 阻塞：Harness CLI 未初始化，SDK 类型未核验 |
| `dsh-mnemo-weave/ui` | `lib/ui/index.js` + `lib/client.js` | 只读记忆界面：侧边栏入口、状态、搜索、详情、离线意图队列 | 已程序化验证；真实桌面加载未验收 |

界面规格与验收细节见仓库 `docs/implementation/dsh-ui.md`。

## 只读界面

数据流：浏览器页面 → Host RPC（`mnemoweave` 通道）→ `http://127.0.0.1:4319/v1/ui/*`（Bridge，独立 token）→ 本地 replica。Bridge 拒绝带 `Origin` 的请求，页面不能绕过 Host 直连。

Host 半（`src/ui/`）：

- `index.ts`：Cordis 插件；`inject: ['connection','webServer']`，注册 `connection.rpc.handle('/dsh-mnemo-weave', …)`。DSH 只接受 `/` 开头且匹配 `/^\/[A-Za-z0-9._~-]+$/` 的通道名；注册时的上下文还必须带 `webServer`（`connection.rpc` 以读取该服务的上下文为 owner，路由挂在该 owner 的 web server 上），否则条目分别以 `invalid or reserved RPC channel` 与 `cannot get property "webServer" without inject` 失败。配置非法或缺 token 时只写 stderr 诊断，不中断 DSH。
- `bridge-client.ts`：Bridge UI 客户端；3 秒超时、响应上限、逐字段校验、API 版本检查。
- `rpc.ts`：`status`/`memories`/`memory`/`intents` 四个端点；请求先校验，再读取。

客户端半（`src/client/`）：

- `index.tsx`：`inject: ['slots','connection','layout','locale']`；注册 `main` 面板与 `sidebar.panellist` 入口，失败时回滚已注册项。侧边栏在注册与每次语言变更时都会调用 `label`，因此读取 locale 走带回退的读取函数：读取抛错或服务缺失时回退为英文标签，不让异常逃逸。
- `page.tsx`：状态标签、搜索（防抖 + 取消在途请求）、列表/详情、意图队列、错误横幅与重试。
- `view-model.ts`、`i18n.ts`：可无 DOM 测试的纯函数与 zh/en 文案。
- `styles.ts`：一次性注入的样式表，颜色优先使用 DSH 主题变量。

共享契约：`src/shared/contract.ts`（UI API v1），自包含。

## 配置

`cordis.patch.yml` 已插入两个条目。UI 条目的可调项：

| 键 | 默认 | 说明 |
|---|---|---|
| `bridgeUrl` | `http://127.0.0.1:4319` | 只接受 loopback HTTP(S) |
| `token` | `MNEMOWEAVE_BRIDGE_UI_TOKEN` | ≥24 字符；建议只放环境变量 |
| `hostId` | `MNEMOWEAVE_BRIDGE_HOST_ID` | 多 Host 时作为 `x-mnemoweave-host` |
| `timeoutMs` | 3000 | 250–30000 |

Bridge 侧需要同时设置 `MNEMOWEAVE_BRIDGE_UI_TOKEN`（与 `MNEMOWEAVE_TOKEN` 不同）和可选的 `MNEMOWEAVE_BRIDGE_UI_PORT`（默认 4319）。

## 构建

```bash
node plugins/dsh-mnemo-weave/dev.mjs            # 开发：监视 src/，自动重建两半
node plugins/dsh-mnemo-weave/build.mjs          # lib/ui/*、lib/shared/*
node plugins/dsh-mnemo-weave/build-client.mjs   # lib/client.js
node scripts/build-plugins.mjs                  # 两半一起打包进 dist/plugins/dsh-mnemo-weave
```

`lib/index.js` 是手写的注入骨架，构建不会覆盖它。

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
MNEMOWEAVE_BRIDGE_UI_TOKEN=<token> node tests/support/dsh-ui-verify.ts http://127.0.0.1:4319
```

它会按插件相同的方式读取状态、少量记忆、一条详情与意图队列并打印结果。

## 注入骨架（仍阻塞）

- 导出：`name`、`inject`、`apply(ctx, config)`；事件入口 `agent/created` → `system-prompt/assemble`、`agent/turn-stopping`。
- 当前 `dsh.cmd` 报 CLI not found，无法核验 SDK 类型；在真实会话验收前不宣称已接入。
- 后续按 `docs/implementation/host-integration.md` 与 `docs/implementation/host-acceptance/dsh.md` 补齐。
