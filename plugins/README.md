# 宿主插件

三个可导入的插件目录与压缩包在 `dist/plugins/` 下（构建后生成）：

| 目录 | 宿主 | 形态 | 状态 |
|---|---|---|---|
| `zcode-mnemo-weave/` | ZCode | `.zcode-plugin/plugin.json` + `hooks/hooks.json` + `.mcp.json` | 可安装 |
| `chatgpt-mnemo-weave/` | ChatGPT 桌面 | `.codex-plugin/plugin.json`（OpenAI 插件清单目录）+ `hooks/hooks.json` + `.mcp.json` | 可安装；钩子输出 `hookSpecificOutput` |
| `dsh-mnemo-weave/` | DSH | Cordis 包：`lib/index.js` 注入骨架 + `lib/ui`、`lib/client.js` 记忆界面（可查看与编辑） | 可导入；界面已程序化验证，真实桌面加载未验收 |

## 构建

```powershell
Set-Location D:/project/MnemoWeave
node node_modules/typescript/bin/tsc
node scripts/build-plugins.mjs
```

输出：

```
dist/plugins/
├── zcode-mnemo-weave/          # 直接选择该文件夹导入
├── chatgpt-mnemo-weave/        # 直接选择该文件夹导入
├── dsh-mnemo-weave/            # DSH 插件包
├── marketplace.json            # ZCode 本地 marketplace
└── README.md
```

## 导入方式

- ZCode：Settings → Plugins → Create → Add marketplace → 选择 `dist/plugins/marketplace.json`，或直接选 `dist/plugins/zcode-mnemo-weave`。
- ChatGPT 桌面：仓库级 marketplace 在 `.agents/plugins/marketplace.json`；也可把 `dist/plugins/chatgpt-mnemo-weave` 作为本地插件目录加入。
- DSH：把 `dist/plugins/dsh-mnemo-weave` 作为插件包导入；记忆界面见 `docs/dsh-ui.md`，提示期注入骨架在 SDK 核验完成前只加载空注入。

## 运行前提

- 三个插件都假定本机有可用的 MnemoWeave Server（HTTP 4317）与 Mnemon 0.2.13。
- 令牌不写入插件：ZCode/ChatGPT 钩子在启动宿主前从环境变量读取 `MNEMOWEAVE_TOKEN`；MCP 子进程从插件配置/环境读取 Mnemon 路径。
- ZCode/ChatGPT 的自动注入仍是钩子子进程；DSH 才是进程内注入，需等待 Harness CLI 初始化并核验 SDK。
