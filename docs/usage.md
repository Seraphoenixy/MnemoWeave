# 安装与使用

先按 [README](../README.md#构建) 安装依赖和构建。

## Codex 与 ZCode

两个客户端各自启动本机 stdio MCP，与 DSH 共享一份本机工作准则。三个宿主使用同一个 `MNEMON_DATA_DIR` 时，准则保存在该目录的 `working-rules/runtime/`。未设置时使用 `~/.mnemon/working-rules/runtime/`。

`--data-dir` 可选。升级时保留旧配置里的绝对路径，MCP 会从该路径的 `runtime/memories.json` 迁入旧条目。新安装只需传入脚本路径。

### Codex

在 Codex 用户配置或受信任的项目配置 `.codex/config.toml` 中添加以下配置，然后重新加载客户端。[Codex MCP 文档](https://developers.openai.com/codex/mcp)

```toml
[mcp_servers.mnemo_weave]
command = "node"
args = ["D:/projects/MnemoWeave/dist/mnemo-weave-mcp.js"]
```

### ZCode

在「设置 → MCP 服务器 → 新建 MCP 服务器」选择工作区作用域，服务名称填 `mnemo_weave`，启动方式选 stdio，命令填 `node`，添加下面的脚本参数。[ZCode MCP 文档](https://zcode.z.ai/cn/docs/mcp-services)

```text
D:/projects/MnemoWeave/dist/mnemo-weave-mcp.js
```

### 验收

在 Codex 调用 `append_workspace_memory` 保存一条工作准则，再在 ZCode 调用 `read_workspace_memory` 读取，并在 DSH 的「工作准则」页查看同一条记录。

## DeepSeek Harness

最低支持 DSH `0.2.2-rc.1`。插件名为 `dsh-mnemo-weave`。DSH 宿主路线包含运行时记忆、工作区档案、记忆空间和技能管理。

升级时先退出同一存储上的旧版宿主进程。DSH 初始化工作区时合并该工作区和旧全局目录中的用户画像及工作记忆，保留旧文件供回查。同一个旧存储只导入一次。要迁入以前使用过的其他工作区，请用新版打开相应工作区，或把该工作区的旧存储根传给 MCP 的 `--data-dir`。

使用 `link:` 把 DSH 开发 profile 中的 `dsh-mnemo-weave` bundle 指向本仓库，并在支持 HMR 的 profile 中启用它。已有上游插件的开发环境可使用独立 profile，避免两套 bundle 使用相同条目 ID。首次切换到包含热重载逻辑的构建时，启动或重启一次 DSH。

从仓库根目录执行以下命令。将 `web` 替换为实际使用的 profile。桌面插件界面中的本地安装路径填写仓库根目录 `D:\projects\MnemoWeave`。

```powershell
pnpm build
pnpm -r build
dsh plugin --profile web add "link:$($PWD.Path)"
```

内置 Source、Strategy 和 Provider 使用 `dsh-mnemo-weave-` 包名前缀，由根 bundle 装配。此前若在 profile 中手工链接过旧包名，升级后可移除这些旧的本地链接。已有的条目 ID 和记忆存储目录继续使用。

此后修改根插件源码，再在仓库根目录运行 `pnpm build`。完整构建成功后，运行中的插件会请求 DSH 重新加载 bundle，结果会写入宿主日志。WebUI 资源更新后可刷新页面。宿主报告需要重启时，重启 DSH 即可加载本次构建。

设置环境变量 `DSH_MNEMO_WEAVE_HOT_RELOAD=0` 后启动 DSH，可关闭本地构建监听。

### 配置与日常操作

- 插件配置保存在 DSH profile 的 `cordis.patch.yml`，核心条目 ID 为 `mnemon`。在插件页启停整套 bundle，在记忆系统的状态页确认各组件的运行状态。
- 工作台可从侧栏打开，也可在「界面 → 记忆系统入口」选择会话标签页。已有记忆的实际存储范围以界面当前选择为准，切换范围时先确认目标目录。
- 运行时记忆保存近期工作上下文，工作区档案保存可追溯的长文，记忆空间通过 Provider 保存和检索长期知识。技能管理通过 DSH 的技能工具参与会话。
- 变更宿主、插件或存储范围前，可从记忆系统导出备份。服务器同步需显式配置服务地址及凭据，恢复前先核对存储范围与目标。
- DSH 桌面窗口使用宿主声明的本地传输。其他设备经 API Gateway 访问时，管理写入由 `remoteAccess` 控制。

已在 DSH RC1 Headless 验证插件启停和代表性记忆工具注册。桌面热重载和 WebUI 改动以实机验收为准。

<a id="host-dsh-运行环境"></a>

## DSH 运行环境


MnemoWeave 的 DSH 插件从 **DSH 0.2.2-rc.1** 起支持。开发依赖锁定在该版本，CI 也验证 0.2.2-rc.1 和 0.2.2-rc.2。开发构建和本地链接见 [DSH 本地插件热重载](#deepseek-harness)。

<a id="host-配置与维护"></a>

### 配置与维护

插件从 DSH profile 的 `cordis.patch.yml` 读取配置。安装和启停以 `dsh-mnemo-weave` bundle 为单位，组件的运行状态可在记忆系统的状态页查看。`mnemon` 条目仍是核心配置和停用目标。

变更插件或宿主前，可通过[备份与恢复](dsh-operations.md)保存当前记忆数据。安装新的宿主后先确认插件已启用，再核对配置和存储位置。

<a id="host-桌面版窗口"></a>

### 桌面版窗口

DSH 桌面窗口使用宿主提供的本地传输。其他设备通过 API Gateway 访问时，管理写入由 `remoteAccess` 配置控制，详见[远程访问](dsh-configuration.md)。

<a id="host-记忆任务"></a>

### 记忆任务

记忆子任务通过 DSH 的托管 activation 运行。MnemoWeave 在子 Agent 发布时注册该任务的工具限制与指令。任务结束后释放运行实例，已保存的会话仍可读取。0.2.2-rc.2 的客户端可能会在历史列表显示带 `Mnemon · …` 标题的任务记录。

<a id="host-安装后直接启用-starter"></a>

### 安装后直接启用 Starter

启用 bundle 时，Loader 加载其 Source、Strategy 与 Provider 依赖。插件启用与重启后的状态一致性由隔离的 Headless 和 bundle 激活测试验证。

<a id="install-mnemon-cli-和云端访问"></a>

## Mnemon CLI 和云端访问

<a id="install-云端访问"></a>

### 云端访问

如果需要通过云端域名访问 Web profile，不要直接发布 3080 端口。DSH 通过 Host 启动时输出的一次性 URL 建立浏览器会话，并用它认证全部 Mnemon RPC 与 stream。请按[云端 WebUI](dsh-operations.md#ops-cloud-hosted-webui)同时配置 HTTPS 反向代理或访问网关与可信 authority，再打开该启动 URL。

<a id="install-mnemon-cli-的其他安装方式"></a>

### Mnemon CLI 的其他安装方式

只有 Mnemon Native 使用 Mnemon CLI。请在运行 DSH 的那台机器上安装。推荐使用第 1 步的 npm 命令（Node.js 22+，macOS、Linux 与 Windows 通用），之后用 `mnemon update` 更新；状态页识别到所属 npm 安装时，也可以用“检查版本”中的更新操作。从 Homebrew、Go 或下载的二进制迁移到 npm 时，让 npm 全局命令目录在 PATH 中优先于旧命令，并同步调整 `MNEMON_CLI_PATH` / `mnemon.cliPath`。改变宿主环境后重启 DSH，再在状态页核对可执行文件路径。

macOS 也可以使用 Homebrew Cask：

```sh
brew install --cask mnemon-dev/tap/mnemon
```

macOS 和 Linux 可以通过 Go 安装：

```sh
go install github.com/mnemon-dev/mnemon@latest
```

Windows 手工安装时，官方发行包同时提供 AMD64 与 ARM64 ZIP。下面的 PowerShell 会把 v0.2.9 安装到可自动发现的用户 Programs 目录，并用官方 checksum 校验下载内容：

```powershell
$version = '0.2.9'
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$archiveName = "mnemon_${version}_windows_${arch}.zip"
$releaseBase = "https://github.com/mnemon-dev/mnemon/releases/download/v${version}"
$archive = Join-Path $env:TEMP $archiveName
$checksumFile = Join-Path $env:TEMP "mnemon_${version}_checksums.txt"
Invoke-WebRequest "${releaseBase}/${archiveName}" -OutFile $archive
Invoke-WebRequest "${releaseBase}/checksums.txt" -OutFile $checksumFile
$line = Get-Content $checksumFile | Where-Object { $_.EndsWith("  $archiveName") } | Select-Object -First 1
if (-not $line) { throw "Checksum entry not found for $archiveName" }
$expected = (($line -split '\s+')[0]).ToLowerInvariant()
$actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Checksum mismatch for $archiveName" }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\mnemon'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Expand-Archive -Path $archive -DestinationPath $installDir -Force
$mnemon = Join-Path $installDir 'mnemon.exe'
& $mnemon --version
```

已经装好 Go 工具链时，Windows 上也可以继续使用 Go：

```powershell
go install github.com/mnemon-dev/mnemon@latest
$mnemonBin = go env GOBIN
if (-not $mnemonBin) {
  $mnemonBin = Join-Path (((go env GOPATH) -split ';')[0]) 'bin'
}
$mnemon = Join-Path $mnemonBin 'mnemon.exe'
& $mnemon --version
```

Windows 上，dsh-mnemo-weave 会从 `PATH`、导出的 `GOBIN` 或 `GOPATH`、默认 `%USERPROFILE%\go\bin`、`%LOCALAPPDATA%\Programs\mnemon` 和 Program Files 中发现原生 `mnemon.exe`，随后检查 `PNPM_HOME` 及其 `bin` 子目录、`NVM_SYMLINK`、`%LOCALAPPDATA%\pnpm` 及其 `bin` 子目录、`%APPDATA%\npm`。查找这些全局 bin 目录时，缺少 AppData 环境变量会使用用户目录下的标准 `AppData\Local` / `AppData\Roaming` 路径。Windows 环境变量名称不区分大小写，PATH 目录可以带引号。既有 PATH 命中和显式 `mnemon.cliPath` / `MNEMON_CLI_PATH` 选择仍优先。

也可以用 `pnpm add -g @mnemon-dev/mnemon@latest` 安装。npm 与 pnpm 的 `mnemon.cmd` 启动器均受支持，包括带版本的全局目录和包链接：验证包身份与静态 JavaScript 目标后，普通命令优先直接调用匹配的原生二进制，继续隐藏 Windows 控制台；缺少匹配二进制时通过 Node 调用已验证的入口，不通过 shell 执行 batch 内容。pnpm 安装请用 `pnpm add -g @mnemon-dev/mnemon@latest` 更新；包不属于 npm 已验证的全局目录时，状态页不会提供 npm 更新操作。

若自定义 `global-bin-dir` 既不在 DSH 的 PATH 中，也没有通过 `PNPM_HOME` 暴露，则无法自动推断。改变环境后重启 DSH，或将 `cliPath` 明确指向生成的启动器或原生可执行文件。`pnpm bin -g` 和 PowerShell 的 `Get-Command mnemon` 可以核对终端选中的目录与命令；桌面进程继承的环境可能不同。任意其他 `.cmd` / `.bat` wrapper 仍不受支持。

DSH 内嵌在 Electron 桌面主进程时，经过验证的 npm 启动器会在子进程中以 `ELECTRON_RUN_AS_NODE=1` 运行，覆盖记忆命令、版本检查和 npm 更新，并保留已保存的 embedding 设置。桌面应用自身的环境变量不变。如果桌面壳关闭了 Electron 的 `runAsNode` fuse，请将 `mnemon.cliPath` 指向当前平台的 Mnemon 原生二进制，详见[故障排查](dsh-operations.md#ops-故障排查)。

如果 DSH 仍然找不到二进制，请设置 `MNEMON_CLI_PATH`，或把 `mnemon.cliPath` 写入用户设置；不要为此整体替换插件的 profile patch（参见[配置参考](dsh-configuration.md)）：

```yaml
mnemon:
  cliPath: 'C:\Users\alice\AppData\Local\Programs\mnemon\mnemon.exe'
```

`mnemon status` 会打开有效 Store，可能初始化数据或执行上游迁移，不要把它当作完全无副作用的安装探测。

<a id="install-常见问题"></a>

### 常见问题

<a id="install-插件页提示没有找到-pnpm无法安装"></a>

#### 插件页提示“没有找到 pnpm，无法安装”

运行 `npm install --global pnpm`，然后在新的终端中重新启动 DSH，让 DSH 能在 PATH 中找到 pnpm。命令行对应的提示是 `pnpm was not found; install pnpm and make it available on PATH.`

<a id="install-无法连接安装源"></a>

#### 无法连接安装源

点击对话框右侧的**安装源**，在中国大陆镜像源与 npm 官方源之间切换后重试；公司内网可以填写自定义地址。

<a id="install-状态页显示未找到-mnemon-cli"></a>

#### 状态页显示“未找到 Mnemon CLI”

安装 Mnemon CLI 后重启 DSH。DSH 会在 PATH 和常见安装目录中查找 `mnemon`；仍然找不到时，按[Mnemon CLI 的其他安装方式](usage.md#install-mnemon-cli-的其他安装方式)设置 `mnemon.cliPath`。

<a id="install-在另一台设备上打开时记忆系统是只读的"></a>

#### 在另一台设备上打开时，记忆系统是只读的

从另一台设备访问 DSH 时（例如通过 `--trusted-host` 配置的地址），记忆系统默认只读，页面会写明原因。确实需要远程管理时，按[运维指南](dsh-operations.md#ops-remote-management)设置 `remoteAccess: trusted-host` 并重启 DSH。桌面版窗口和本机浏览器都不属于远程页面。
