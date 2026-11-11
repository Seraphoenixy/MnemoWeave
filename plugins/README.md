# 宿主插件

在仓库根目录构建：

```powershell
node node_modules/typescript/bin/tsc
node scripts/build-plugins.mjs
```

构建在 `dist/plugins/` 生成插件目录、压缩包和本地 marketplace。先按 [本机服务说明](../README.md) 启动 Server，再配置宿主服务令牌与独立 Host ID。

| 宿主 | 安装方式 |
|---|---|
| DSH | 导入 `dist/plugins/dsh-mnemo-weave`。见 [DSH 插件](dsh-mnemo-weave/README.md) |
| ChatGPT 桌面 | 使用仓库的 `.agents/plugins/marketplace.json` 或生成的本地插件目录 |
| ZCode | 添加 `dist/plugins/marketplace.json` 或安装生成的本地插件目录。见 [ZCode 插件](zcode-mnemo-weave/README.md) |

运行边界和真实会话检查见 [宿主验收](../docs/host-acceptance.md)。
