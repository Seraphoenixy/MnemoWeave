# DSH 插件

将构建后的 `dist/plugins/dsh-mnemo-weave` 导入 DSH profile。包内 Cordis 配置加载两个条目：

| 条目 | 入口 | 职责 |
|---|---|---|
| `mnemo-weave` | `lib/index.js` | 会话注入与模型工具 |
| `mnemo-weave-ui` | `lib/ui/index.js`、`lib/client.js` | 记忆中枢的六个页签与设置分组 |

配置 `MNEMOWEAVE_TOKEN`，需要时设置 `MNEMOWEAVE_SERVER`、`MNEMOWEAVE_HOST_ID` 和 `MNEMOWEAVE_PROJECT_ID`。默认连接 `http://127.0.0.1:4317`。环境变量修改后重新启动 DSH。

见 [构建与安装](../README.md)、[界面使用](../../docs/ui.md) 和 [宿主验收](../../docs/host-acceptance.md)。
