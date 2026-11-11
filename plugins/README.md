# 宿主插件

三个可导入的插件目录与压缩包在 `dist/plugins/` 下（构建后生成）：

| 目录 | 宿主 | 形态 | 状态 |
|---|---|---|---|
| `zcode-mnemo-weave/` | ZCode | `.zcode-plugin/plugin.json` + `hooks/hooks.json` + `.mcp.json` | 可安装 |
| `chatgpt-mnemo-weave/` | ChatGPT 桌面 | `.codex-plugin/plugin.json`（OpenAI 插件清单目录）+ `hooks/hooks.json` + `.mcp.json` | 可安装；钩子输出 `hookSpecificOutput` |
| `dsh-mnemo-weave/` | DSH | Cordis 包：`lib/index.js` 注入骨架 + `lib/ui`、`lib/client.js` 记忆界面（六个页签，可浏览、编辑与设置） | 可导入；界面已程序化验证，真实桌面加载未验收 |

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
- **令牌只有一个来源**：登录用户的环境变量 `MNEMOWEAVE_TOKEN`（宿主用）与 `MNEMOWEAVE_OPERATOR_TOKEN`（仅人工审核用）。Server、启动包装与三个插件都从这里读，不写进 `.env.local-server`，也不写进 profile patch。首次注册任务时由 `install-local-server-task.ps1` 生成并写入用户环境。
- 进程只在启动时读环境变量：改令牌后，Server 需重跑任务（或重新登录），三个宿主需重启。
- MCP 子进程从环境读取同一批变量；Mnemon 路径由插件配置或环境提供。
- ZCode/ChatGPT 的自动注入仍是钩子子进程；DSH 才是进程内注入，需等待 Harness CLI 初始化并核验 SDK。

## 宿主先于 Server 启动

三个宿主都可以先打开。插件启动时先探测本机 Server：

- 已就绪 → 直接使用；
- 连接被拒绝 → 请求运行 `MnemoWeave Local Server` 计划任务并轮询；
- 已响应但 Mnemon 仍在初始化 → 显示「正在启动」；
- 令牌不匹配 → 显示「服务令牌不匹配」，不动现有 Server；
- 端口被其他程序占用，或连上后无响应 → 显示具体原因并停止本轮尝试。

只有**连接被拒绝**会触发唤醒，因此不会在已被别的程序占用的端口上再起一个 Server。计划任务设为 `IgnoreNew`，三个宿主同时唤醒也只运行一个实例。DSH 在插件加载时后台预热，记忆页显示「正在启动 / 已连接 / 失败原因」；ZCode 与 ChatGPT 在会话启动钩子里预热，按轮执行的钩子仍受 2 秒注入截止约束——Server 来不及就绪就本轮不注入，下一轮再试。

### 注册计划任务（安装步骤）

任务由安装步骤注册，插件只负责探测、唤醒和直连。**注册必须使用管理员权限的 PowerShell 窗口**（写入系统任务计划需要提权；脚本会先自检并给出提示）。

```powershell
# 1. 复制并按需填写非凭据配置（不要把令牌写进去）
Copy-Item scripts/local-server.env.example .env.local-server

# 2. 编译（任务运行的是 dist/apps/server/src/main.js）
node node_modules/typescript/bin/tsc

# 3. 在【管理员】PowerShell 中注册（首次会生成服务/operator 令牌并写入用户环境变量）
.\scripts\install-local-server-task.ps1 register -ServerDir D:\projects\MnemoWeave

# 其他操作（query 不需要提权；remove 需要）
.\scripts\install-local-server-task.ps1 query
.\scripts\install-local-server-task.ps1 run      # 等同于插件发现端口被拒时的唤醒
.\scripts\install-local-server-task.ps1 remove
```

任务在登录时启动，绑定用户会话（注销即停止）。注册结果可用 `query` 核对：`MultipleInstances` 应为 `IgnoreNew`、`Schedule Type` 为 `At logon time`。

令牌写入用户环境变量后，**已在运行的 DSH 读不到新值**（进程启动时才读环境）；需要重启 DSH 一次。插件本身不需要在配置里写 token。

### 真机验证结果（2026-11-10）

| 场景 | 结果 |
|---|---|
| 已有 Server | 插件直接复用，不触发任务 |
| 无 Server | 唤醒任务后 **763 ms** 转为就绪（生产代码路径，未打桩） |
| 三个插件并发冷启动 | 三次并发 `schtasks /run` 均提示「正在运行」，最终仅 1 个实例、PID 未变 |
| 令牌不匹配 | 报 `unauthorized`、`taskRun:false`，Server 进程 PID 前后一致 |
