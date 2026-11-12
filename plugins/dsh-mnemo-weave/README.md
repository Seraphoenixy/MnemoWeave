# DSH 插件

将构建后的 `dist/plugins/dsh-mnemo-weave` 导入 DSH profile。包内 Cordis 配置加载两个条目：

| 条目 | 入口 | 职责 |
|---|---|---|
| `mnemo-weave` | `lib/index.js` | 会话注入与模型工具 |
| `mnemo-weave-ui` | `lib/ui/index.js`、`lib/client.js` | 记忆中枢的六个页签与设置分组 |

配置 `MNEMOWEAVE_TOKEN`，需要时设置 `MNEMOWEAVE_SERVER`、`MNEMOWEAVE_HOST_ID` 和 `MNEMOWEAVE_WORKSPACE_ID`。默认连接 `http://127.0.0.1:4317`。环境变量修改后重新启动 DSH。

## 构建产物边界

`lib/index.js` 与 `lib/index.d.ts` 是手写源码（会话注入与模型工具那一半），直接入库。其余由 `build.mjs` 和 `build-client.mjs` 生成并被 `.gitignore` 忽略：`lib/ui/index.js`（Host 半，内联 `packages/client`）、`lib/client.js`（浏览器包）、`lib/host-config.js`（`src/shared/host-config.js` 的副本，让手写的 `lib/index.js` 与 Host 半加载同一份配置）。因此导入插件前必须先构建。

## 开发回路

`node plugins/dsh-mnemo-weave/dev.mjs` 监视 `src/` 并重建两半，`--once` 只构建一次。检出安装下 Host 半还会监视 `lib/` 并通过 `pluginManager` 重新编排本 bundle；打包副本没有 `src/` 与 `build.mjs`，该分支不生效。`DSH_MNEMO_WEAVE_HOT_RELOAD=0` 关闭监视。首次启用仍需重启一次 DSH，因为监视器位于已加载的 Host 半。

见 [构建与安装](../README.md)、[界面使用](../../docs/ui.md) 和 [宿主验收](../../docs/host-acceptance.md)。
