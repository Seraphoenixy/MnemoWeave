# ZCode 插件

按 [插件构建说明](../README.md) 生成 `dist/plugins/zcode-mnemo-weave`，通过本地 marketplace 或插件目录安装。插件提供会话 hooks 与 stdio MCP。

钩子继承宿主的 `MNEMOWEAVE_SERVER`、`MNEMOWEAVE_TOKEN`、`MNEMOWEAVE_HOST_ID` 和可选的 `MNEMOWEAVE_PROJECT_ID`。MCP 默认代理本机 Server，插件清单同时定义了可用的 Mnemon 与状态目录配置。

参见 [宿主验收](../../docs/host-acceptance.md)。
