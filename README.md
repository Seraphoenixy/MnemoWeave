# MnemoWeave

MnemoWeave 为 DSH、ChatGPT 桌面和 ZCode 提供本机记忆服务。Mnemon 保存和检索正式记忆正文，MnemoWeave 管理候选、发布、版本和同步。启用远端同步后，共享变更由远端确认，宿主继续在本机注入和召回。正式记忆共享和写入任务 Agent 的目标契约见 [架构](docs/architecture.md)，实现进度见 [当前状态](docs/status.md)。

## 开发与验证

需要 Node.js 24、pnpm 11.18.0 和 Mnemon 0.2.13。测试使用 `work/` 下的隔离数据目录与专用 Store。

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd typecheck
pnpm.cmd build
pnpm.cmd test
pnpm.cmd test:e2e
```

若 Windows 包装器在非交互终端因 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中断，使用已安装的依赖直接执行：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc
node --test tests/unit/*.test.ts tests/contract/*.test.ts
node --test --test-concurrency=1 tests/e2e/*.test.ts
```

E2E 需要真实 Mnemon 可执行文件。Windows 可通过 `MNEMON_BINARY` 指定 `.exe`，测试也会探测项目工具目录和 npm 全局包。生产运行时未设置此变量则使用 PATH 上的 `mnemon`。

## 启动本机服务

在仓库根目录运行以下命令。Windows 上将 `MNEMON_BINARY` 设为原生程序路径。

```powershell
$env:MNEMON_DATA_DIR = Join-Path $PWD 'work/dev-memory'
$env:MNEMON_STORE = 'development'
$env:MNEMOWEAVE_STATE_DIR = Join-Path $PWD 'work/dev-state'
$env:MNEMOWEAVE_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:MNEMOWEAVE_OPERATOR_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
node dist/apps/server/src/main.js
```

默认地址为 `http://127.0.0.1:4317`。将服务令牌配置给宿主，operator 令牌仅供管理端。stdio MCP 入口为 `dist/apps/server/src/mcp-main.js`。治理库当前 schema v23，迁移和恢复见 [实现文档](docs/implementation.md)。

浏览记忆界面需要真实数据时，`node scripts/seed-demo.mjs` 在 `work/demo-store/` 创建隔离演示库并打印指向它的环境变量；`--print` 只打印变量。

## 发布与安装

Windows 构建后执行 `node scripts/publish-server.mjs`。要注册登录计划任务，执行 `node scripts/publish-server.mjs --register` 并批准安装阶段的 UAC。已注册任务由登录会话托管。DSH 设置页也提供注册与唤醒入口。

宿主插件构建和导入见 [插件说明](plugins/README.md)。远端部署和配置见 [同步协议](docs/sync.md)。

## 文档

见 [文档导航](docs/README.md) 和 [当前状态](docs/status.md)。
