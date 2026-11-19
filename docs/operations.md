# DSH 运维与 Provider

<a id="ops-运维安全与故障排查"></a>

## 运维、安全与故障排查


<a id="ops-健康检查"></a>

### 健康检查

打开记忆系统的“状态”页。使用 Mnemon Native 时再检查它的二进制，其他 Provider 不需要：

```sh
command -v mnemon
mnemon --version
```

Windows PowerShell：

```powershell
Get-Command mnemon -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"
```

```text
/mnemon status
```

![状态页：每个记忆组件、Provider 与存储区域](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/main/docs/assets/webui-v0.5.32/zh-CN/memory-status.jpg)

状态页显示 dsh-mnemo-weave 与 Mnemon 的版本、每个记忆组件一张卡片，以及当前实际目录。`mnemon status` 会打开有效 Store，上游 CLI 可能初始化数据或执行迁移，因此不是完全无副作用的只读探测。

<a id="ops-版本检查与更新"></a>

### 版本检查与更新

状态页的“检查版本”打开“检查与更新版本”面板：

- **MnemoWeave 主插件**：状态页显示正在运行的构建。当前项目从源码构建并按 [DSH 安装与热重载](usage.md#deepseek-harness)更新。
- **Mnemon CLI**：本地版本来自 `mnemon --version`，最新版本来自官方 `@mnemon-dev/mnemon` npm 包。只有 Mnemon Native 需要它，未安装时显示为可选并给出安装命令。

Mnemon CLI 支持官方 npm 启动器、Homebrew Cask / Formula 与 `go install`。版本面板按实际安装来源给出可用操作。

npm 更新要求当前启动器属于现有 npm 所报告的全局安装目录；不同 Node/npm 环境或启动器故障会显示修复指引。首次安装或迁移使用 `npm install --global @mnemon-dev/mnemon@latest`，后续使用 `mnemon update`。命令在 DSH 宿主运行，需要 Node.js 22+。修改 PATH 或 CLI 配置后，重新检查并核对面板中的可执行文件路径。

在 Windows 桌面宿主中，记忆操作和版本检查会直接调用已识别的官方 Mnemon npm 安装所锁定的原生程序，避免 npm 启动器额外弹出控制台窗口，并保留隐藏子进程、超时、取消和已保存的嵌入设置。界面显示的安装路径和 npm 更新归属仍指向原启动器。对于未知包布局或缺失的原生依赖，继续使用启动器回退路径及其修复诊断。

展开 dsh-mnemo-weave 子包列表，可按 Source、Strategy、Provider 查看版本。主包固定的依赖随主包更新，仅当前所属 Profile 中独立安装的包支持单独更新；源码链接保持原维护方式。包更新串行执行，重新检查或重开面板仍保留待重启提示。只读连接可检查版本与复制命令；页面更新需要管理权限且开启 `writeEnabled`。

Go 更新还要求当前执行文件确实位于本机 Go 的安装输出位置（`GOBIN`，或 `GOPATH` 第一项的 `bin` 目录），且未配置交叉编译目标。不能仅因下载的二进制包含 Go 构建信息就认定它由 Go 管理。CLI 更新后还会核验当前执行文件已达到所检查的版本，才报告成功。

更新命令由 Host 固定选择：浏览器不能传入命令或参数，执行禁用 shell，并限制时间与输出。插件更新在所属 profile 中安装已检查的精确版本，确认实际安装版本后才报告成功，避免固定 beta 版本未变却提示已更新。更新完成后界面自动重新检查两个组件并刷新状态。Mnemon CLI 从下一次调用起生效。主插件的本地构建按 [热重载流程](usage.md#deepseek-harness)生效，宿主报告需要重启时再完全退出并重新打开 DSH。

<a id="ops-备份与恢复"></a>

### 备份与恢复

<a id="ops-推荐设置页-zip"></a>

<a id="ops-推荐插件页-zip"></a>

#### 设置页 ZIP

记忆系统**设置**页“存储”一节中的“备份与迁移”针对**当前有效根**工作：

- **导出 ZIP**：包含 Runtime、Documents 和全部 Mnemon Native Memory Spaces；三方连接、本地外部 Store 与远程数据不进入包；
- 包中只有 dsh-mnemo-weave 随附的记忆来源：运行时记忆、工作区档案与记忆空间。从其他插件包安装的记忆来源既不会导出也不会导入，它的数据由它自己保存；
- **导入 ZIP**：先预检，再合并到当前有效根；
- 包内包含 `manifest.json`、SHA-256 清单和三类数据摘要；
- 导出与导入持有组件锁，Memory Space 仍有未 checkpoint 的 WAL 时会拒绝；
- 导入检查路径、数量、压缩 / 展开大小、JSON schema、Document 哈希、registry 与 SQLite 头；
- 合并先写 staging，再替换目标组件；提交失败会恢复导入前目录。

当前 UI 只提供安全合并，不做“覆盖一切”：

- Runtime 按目标与内容去重；
- 相同 Document ID + 相同内容跳过，ID 冲突且内容不同则生成新 ID；
- 记忆空间按其中的记忆与关联比较，召回时改写的计数和之后补齐的向量不参与比较。一条关联由它连接的两条记忆及其类型确定：合并空间或重新关联会改写它的权重、备注和时间，值不同的同一条关联仍是同一条关联，保留本机的值。因此在一台设备上改过的权重或备注只留在那台设备上。记忆的更新时间也不参与比较：嵌入服务恢复响应后用嵌入设置里的**补齐**或 `mnemon embed` 补齐向量，或用 `mnemon gc --keep` 让记忆免于清理，都会改写这个时间，记忆本身并没有变。相同 ID 的空间会并入只有传入版本才有的记忆，因此两台设备都新增了记忆时，结果仍是一个同时包含两边记忆的空间；本机已有的行、召回计数、读取日志和表结构保持不变。同一条记忆在两边不同（一边编辑或遗忘了它）时，传入版本以新 ID 保留在本机版本旁边，只保留一份，它之后的版本会更新这份副本，而不是再添加一份。新 ID 的空间：本机已有同名空间包含其全部记忆时跳过。比较时用 `node:sqlite` 读取数据库（Node 22.13、23.4 及以上）；更早的 Node、无法读取的数据库、含虚拟表的数据库或超过 50 万行的数据库比较字节。

两份各自有效的 MEMORY 文件合并后超过工作记忆上限时，Mnemon 优先保留重要度较高、更新时间较新的条目，同分同时间按文本稳定排序选择。未保留的条目连同时间、分支范围和来源信息，以完整 JSON 记录保存在 `<dataDir>/runtime/archived/import-overflow/`。归档与热记忆一起提交；归档写入失败时保持原数据。重复合并复用已有归档。

安全导入会分别报告本机归档条数与进入热记忆的远端条数。可检查 JSON 文件，在释放空间或提高容量后，通过运行时记忆页面恢复需要的条目。与已有 Runtime 归档一致，该目录只保存在本机，**不包含在 ZIP 中**，完整离线备份应包含它。USER 容量校验、格式错误及单份输入已经超限时的拒绝行为保持不变。


导入受 `writeEnabled` 控制，只读部署会拒绝。ZIP 包含私有记忆，应加密、限制访问并验证恢复。Provider 凭据保存在 `state/memory-providers.json`（`0600`），不会进入 ZIP。已保存的凭据值也不会经管理通道返回；若要备份连接，需要按[文件系统级快照](operations.md#ops-文件系统级快照)保护整个 `state/`。

![安全导入前经过校验的备份预览](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/main/docs/assets/webui-v0.5.32/zh-CN/plugin-backup-preview.jpg)

<a id="ops-记忆整理"></a>

#### 记忆整理

整理复用既有的审查账本，入口位于**存储**中**记忆整理**这一行的三个独立触发按钮：**工作准则整理**（生成工作准则的增删改提案）、**工作区档案整理**（生成活跃档案的归档提案）与**记忆空间整理**（生成记忆条目的修订、软删除与建立关联提案）。

- **整理要求**说明这次整理要达成什么，例如“保留短句风格，合并同义条目”。三个整理按钮共用这一输入，它只描述目标，不会放宽权限：一条操作能包含什么仍由 Host 按所属范围决定。整理完成后页面会说明是否参考了你的要求，以及参考了远端多少条本机没有的记忆。
- 方案以待审查建议的形式出现，不会自动写入。它列出每条操作与理由，可以**接受**后**执行**，也可以拒绝，或先留下意见。
- 已拒绝的方案要先**重新打开**才能再整理：账本里已决定的建议由其决定回答，只有重新打开后，你的意见才会进入下一次 run 读到的证据，所以顺序是「写下意见 → 重新打开 → 再整理」。
- 接受后的方案可以只执行一部分：每条操作前有复选框，只列出还没执行过的位置，**全选**/**全不选**切换整组，按钮会显示本次执行几条；一条都没选时直接提示，而不是什么也不做。账本逐条记录执行过的位置（`appliedOperations`），并显示为「已执行 {count}/{total} 条」，因此只执行了一部分的方案仍留在列表里，直到它的每条操作都执行过为止。
- 全部执行完的方案离开列表，收进**已执行的历史方案**弹窗，只供回看；重新打开它不会撤销已经写入的改动，而是把整份方案恢复成待审查、可以重新决定。
- 只读 Host 依然可以读取和批注账本；需要可写部署的是“执行”。

<a id="ops-恢复演练"></a>

#### 恢复演练

1. 在“存储”中将“数据目录”设为“自定义”，填写一个隔离目录并应用。
2. 确认状态页显示的当前实际读写根正是该目录。
3. 在“备份与迁移”中选择备份，阅读预检摘要后执行导入。
4. 在状态页检查 Runtime、Documents、Memory Spaces 与目录。
5. 用一个聚焦查询验证直接检索，再阅读一份档案。
6. 验证无误后再决定是否切换正式范围。

不要在没有备份时把恢复直接指向唯一生产根。

<a id="ops-文件系统级快照"></a>

#### 文件系统级快照

需要保留预留 `state` 或做离线完整快照时，可以停止所有使用该根的 DSH / Mnemon 进程后复制：

```text
<storageRoot>/runtime
<storageRoot>/documents
<storageRoot>/data
<storageRoot>/state    # 若存在；不在内置 ZIP 的四类数据组件中
```

复制完成后生成文件清单或校验和，并在隔离路径演练恢复。不要在多个进程仍写入时把普通目录复制当作一致快照。

<a id="ops-切换存储范围"></a>

### 切换存储范围

宿主支持时，可用**选择目录**打开 DSH 原生选择器。选择只填入自定义路径草稿；**应用**沿用手动输入的保存路径，**放弃修改**恢复草稿。选择器报错后仍可手动输入。

保存 `global` / `workspace` / `custom` / `workspaces` 后，Host 先初始化新运行图，再原子切换；页面自动重新读取，但**不会迁移数据**：

```text
旧范围 -- 保存设置 --> 新的空目录或既有目录

不自动复制
不自动合并
不自动删除
```

迁移流程：在旧范围导出 ZIP → 切换到新范围并确认显示目录 → 导入 ZIP → 验证。工作区模式下先确认查看工作区与会话执行工作区是否是预期目标。

使用 `workspaces` 时，备份整个集中目录可覆盖所有工作区，导出 Pack 则只覆盖所选工作区。移动或重命名工作区会产生新路径哈希；恢复旧数据需要操作者显式执行。

现有回合和已委托的子 Agent activation 可能仍使用旧运行图。迁移或停用其数据前，应等待它们结束或取消这些任务。父回合结束本身不会释放异步子任务的委托；新创建或冷恢复的 activation 会捕获自己获准使用的 generation。

<a id="ops-停用完整-starter"></a>

### 停用完整 Starter

既有的 `mnemon` Entry 继续作为整个 Starter 的生命周期总开关。需要停用 Mnemon 时，在 profile patch 中加入以下配置并重启 DSH；不需要逐项停用 Source 或 Strategy：

```yaml
- id: mnemon
  disabled: true
```

该开关会同时停用 Core/Host、三个随附 Source 与随附的 Strategy 增强，不会卸载包或删除记忆数据。删除该覆盖项，或把它改为 `false`，再重启 DSH，即可重新启用完整 Starter。

<a id="ops-cloud-hosted-webui"></a>

<a id="ops-云端-webui"></a>

### 云端 WebUI

[DSH 运行环境](usage.md#host-dsh-运行环境)列出的 DSH 版本是支持的 registry 安装目标。页面、每个 RPC 与每条 stream 都通过 Host 输出的启动 token URL 建立同一份、与 authority 绑定的浏览器会话。`--trusted-host` 仍只是 Host/Origin 防线，不能替代 HTTPS 或部署层访问控制。

1. 在反向代理或访问网关终止 HTTPS，并只向预期用户开放公网入口。把同源的 `/` 与 `/api` 流量（包括 stream）代理到 `http://127.0.0.1:3080`，同时保留外部 `Host` authority。
2. 使用外部 authority 启动回环服务。参数应为裸 `host[:port]`，不是 URL：

   ```sh
   dsh web --trusted-host memory.example.com --no-open
   ```

   公网入口使用非默认端口时，应传入准确 authority，例如 `memory.example.com:8443`。DSH 会刻意拒绝 `--host 0.0.0.0`；请让服务保持在回环地址，只由代理或 SSH tunnel 访问。
3. 如果浏览器还没有该公网 authority 的有效 Cookie，请使用终端里以 `dsh web: ...` 输出的启动 token URL。经过反向代理时，只把其中的回环 origin 替换成公网 HTTPS origin，保留 `/` 路径与 `?token=...` query。例如把 `http://127.0.0.1:3080/?token=...` 转为 `https://memory.example.com/?token=...`。该 URL 等同凭据，不要放入日志、Issue 或聊天。DSH 会把它交换为 HttpOnly、SameSite Cookie，再重定向到干净的 `/`；尚未过期且 authority 相同的 Cookie 可以跨 Host 重启继续使用。
4. 打开干净的公网 URL，确认“状态”和**设置**页都能加载，并且整页刷新后仍保持认证。远程设置默认只读；需要管理时，先应用[显式远程管理授权](operations.md#ops-remote-management)、重启 DSH，再验证一次有意的小范围保存。

HTTP 403 可能来自 Host/Origin 不匹配，或旧远程 Client 仍调用独立通道。请检查 `--trusted-host`、公网 authority 与代理路由，再升级 dsh-mnemo-weave、重启 DSH 并刷新浏览器；远程 Mnemon 调用使用已认证 API Gateway。HTTP 401 需要恢复 Host 浏览器认证或配对。若返回远程管理需要 `remoteAccess: trusted-host`，则是另一个 Mnemon 授权检查；浏览器认证成功本身不授予管理权限。

<a id="ops-remote-management"></a>

<a id="ops-远程管理"></a>

#### 远程管理

对于已认证的远程客户端，`remoteAccess: trusted-host` 授予管理操作；远程读取与小范围激活不需要该授权。没有该授权时，远程页面的记忆系统与插件设置会写明只读的原因。本机浏览器与 DSH 桌面版窗口不是远程客户端，不需要该授权。仅为预期的已认证用户配置远程管理权限。

1. 打开 `~/.dsh/profiles/web/cordis.patch.yml`；如果设置了 `DSH_HOME`，则路径为 `$DSH_HOME/profiles/web/cordis.patch.yml`。如果已经有顶层 `- id: mnemon`，请直接修改该项，不要添加重复项。如果初始化文件仍以 `[]` 结尾，请用下面的完整配置行替换它；否则把该行追加到现有顶层 YAML 列表：

   ```yaml
   - id: mnemon
     config:
       routingGuidance: true
       lifecycleEnabled: true
       recallMode: guided
       writebackMode: guided
       idleReviewMs: 30000
       tabEnabled: true
       writeEnabled: true
       remoteAccess: trusted-host
       timeoutMs: 10000
       defaultRecallLimit: 10
       embedding:
         enabled: false
         endpoint: http://localhost:11434
         model: nomic-embed-text
       recallQuality:
         policy: strict-v1
         lowScoreThreshold: 0.25
         highScoreThreshold: 0.6
         candidateMultiplier: 3
         maxMediumResults: 4
         maxRankedResults: 4
         maxUnknownResults: 2
   ```

   Profile patch 会替换目标行的完整 `config`，不会只深度合并一个字段。请保留已有自定义项；插件升级后用 `dsh web --dump-default-config` 对照它，避免遮蔽新增的包内默认值。
2. 运行 `dsh web --dump-config` 检查最终配置树。确认最后的 `mnemon` 行包含 `remoteAccess: trusted-host`，并且 stderr 没有报告无法匹配 `mnemon` 目标。
3. 使用同一条 `--trusted-host` 命令启动 DSH。每次修改 `remoteAccess` 后都要重启，因为 Mnemon 只在启动时捕获该策略。最后通过已认证远程连接验证“状态”、设置加载和一次有意的小范围保存。

<a id="ops-embedding-credentials"></a>

<a id="ops-向量嵌入凭据"></a>

### 向量嵌入凭据

在**设置 → 记忆空间 → Mnemon Native**中，新 API Key 保存为 DSH 凭据库中与 Endpoint 绑定的记录，Profile 仅保留不透明的 `embedding.apiKeyRef`。这个页面不会收到已保存的密钥。凭据库及其磁盘保护由 DSH 负责；这里承诺的是与主设置文件分离，不表示额外加密或使用系统钥匙串。

升级后，已有的明文 `embedding.apiKey` 配置继续可用。点击**将已有明文密钥迁入 DSH 凭据库**，或保存嵌入连接，即可迁移。Host 先写入并读回校验新记录，再替换 Profile 中的值；保存失败保留原连接。密钥输入留空会保留当前密钥。修改 Endpoint 时，需要新密钥、明确配置环境变量，或移除旧引用。**移除本连接的密钥和环境变量引用**是显式操作，可通过恢复配置撤销；它不会删除凭据库记录，因此其他引用和回滚配置仍可使用这些记录。

也可配置 `embedding.apiKeyEnv: MY_EMBEDDING_API_KEY`，并给 DSH 进程提供该环境变量。每次调用 CLI 时读取它，优先于凭据引用和旧明文密钥。变量缺失、为空或凭据不可读时，会明确报错，不发出空密钥请求，也不改用其他凭据。`embedding.enabled: false` 时，仍原样继承 Mnemon CLI 的环境变量。没有凭据服务的 Host 可使用环境变量方案。

请一起升级 Starter 与 Memory Spaces Source。新 Source UI 搭配旧 Starter 时，现有连接仍可用，但页面不接受新的密钥。旧版插件不能解析 `apiKeyRef`；回滚前请准备已有的 CLI 环境变量方案（`embedding.enabled: false`，设置 `MNEMON_EMBED_ENDPOINT`、`MNEMON_EMBED_MODEL`、`MNEMON_EMBED_API_KEY`，按需设置 `MNEMON_EMBED_PROTOCOL`），或恢复适用的升级前配置。迁移可写 Profile 覆盖值不能删除继承/只读基础文件及历史备份里的旧密钥；确认迁移后连接正常，再自行清除这些原始副本。不要分享凭据文件或带密钥的备份。

<a id="ops-安全边界"></a>

### 安全边界

<a id="ops-进程"></a>
<a id="ops-文件"></a>
<a id="ops-web-与模型"></a>

Host 调用 Mnemon CLI 时不经过 shell，限制每次调用的时间与输出，并通过锁与修订让写入串行。浏览器既拿不到凭据，也不能启动进程；每个任务 Agent 只拿到其任务需要的记忆工具。各项边界的细节见[架构设计](architecture.md#design-安全边界)。

这些边界不是秘密扫描器。当前没有确定性的凭据检测；不要提交密钥、token、私钥和原始敏感日志。

从技能管理市场安装的技能是 Agent 会照着执行的指令，也可能带有脚本。dsh-mnemo-weave 自身从不运行技能里的脚本：每次安装前都可预览，网站发布的压缩包必须与其公布的摘要一致，压缩包不得包含链接或技能文件夹之外的路径，大小与文件数也有上限。安装前请先审阅技能，见[技能管理数据与信任](skills.md#skills-数据与信任)。

<a id="ops-安全问题报告"></a>

#### 安全问题报告

按 [SECURITY.md](../SECURITY.md) 私下报告漏洞，不要创建公开 issue。数据丢失、路径穿越、锁 / revision 绕过、子 Agent 隔离破坏和 WebUI 记忆内容注入都在范围内。

<a id="ops-故障排查"></a>

### 故障排查

`mnemon.cliPath` 接受显式路径，也接受按 Host 的 PATH 查找的命令名。DSH 运行时，若二进制安装或恢复到既有搜索目录，点击记忆系统顶栏的**刷新**即可更新可用状态，无需重启；Host 进程环境变量的变化仍需重启。状态与版本检查解析同一个配置命令。

| 现象 | 检查与处理 |
|---|---|
| Windows 切换会话时终端窗口闪现 | 更新 Starter，或独立安装的 Runtime Source，然后重启 DSH Host。Runtime 的 Git 分支检测会隐藏控制台窗口；Git 失败、超时或 HEAD 分离时仍回退到不按分支筛选的 Runtime 视图。 |
| 写入含补充 Unicode 字符的长 Runtime 记忆后，同一会话每次请求都返回 HTTP 400 | 检查历史 `tool/result.data.meta.item.title` 或 `excerpt` 中是否有不成对的代理字符（[#548](https://github.com/omdsh-dev/dsh-mnemon/issues/548)）。修复会在原有活动摘要长度限制内保留完整码点，存储的记忆正文不变。更新到包含修复的构建并重启 DSH。已有会话记录不会被改写：可在新会话中继续使用同一份记忆，并保留受影响的会话供单独恢复。仅凭通用 400 错误不能确认此原因。 |
| Mnemon 不可用 | macOS/Linux 运行 `command -v mnemon`、`mnemon --version`；Windows PowerShell 运行 `Get-Command mnemon`、`Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"`。设置 `MNEMON_CLI_PATH` 或 `mnemon.cliPath` 后重启 |
| Electron 桌面 Host 无法运行 npm CLI 脚本 | 经过验证的 npm 启动器仅在子进程中设置 `ELECTRON_RUN_AS_NODE=1`。如果桌面壳关闭了 [Electron `runAsNode` fuse](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode)，该变量会被忽略；请将 `mnemon.cliPath` 指向官方原生二进制（Windows 为 `mnemon.exe`）。npm 自动更新仍需要 Host 能够运行 JavaScript 启动器 |
| Headless Agent 没有 Mnemon 工具 | 插件按 profile 独立安装；按[本地链接步骤](usage.md#deepseek-harness)安装，使用 `headless` profile，Web profile 的安装不会自动带入 |
| 会话中的记忆标签底部被输入框遮挡 | 记忆标签默认收起输入框，点击**展开输入框** / **收起输入框**可保存当前浏览器偏好；草稿与附件保留在 DSH 编辑器中。切回对话恢复输入框，待处理交互优先显示，技能的**使用**会展开输入框。多个会话分栏或 Host 不提供输入框插槽时保留正常输入框，记忆页面按实际高度留出滚动空间。 |
| 找不到“记忆系统”入口 | 检查 `tabEnabled=true`；`displayMode=sidebar` 使用侧边栏，`displayMode=builtin` 使用已打开会话的标签页。本地 link 先 `pnpm run build` 再重启 profile |
| 旧的 `buildin` 偏好打开了会话标签页 | 它会保存为 `builtin`；如需独立入口，请在**界面**中选择**侧边栏**。记忆范围与已存数据不变 |
| 状态正常但召回为空 | 检查 active 记忆空间、存储范围、查看目录、会话实际目录和查询是否足够聚焦 |
| 顶部提示目录未对齐 | 工作台正在查看另一个工作区；确认是否为预期范围。工作台任务在查看工作区执行，对话工具仍使用所属会话范围 |
| 设置看起来没有变化 | 开关与选择器立即生效，需要输入的值要点击**应用**；写入失败时控件旁会显示原因并恢复为已保存的值 |
| 自定义目录被拒绝 | 使用绝对路径、`~` 或 `~/...` |
| `memoryBodyId is required...` | active 数量不是恰好 1；显式选择目标 |
| `memory space is not active for reading` | 在概览激活目标；写入 inactive 可以，读取不行 |
| Provider 错误 | 审查需要受 guard 保护的本地子 Agent；默认有界 `spawn`，可选择 `fork`。安装了 Team 工具时如需继续审查，可选择 `idleReview.agentTeams: scoped`，默认仍为 `pause`；重试前核对部分写入回执 |
| 本地模型（例如 Ollama 上的 Qwen3.x）下空闲审查报 `no user query found in messages` | 工具结果填满模型的上下文窗口后，Ollama 截断时丢掉了子代理的任务提示。0.5.22 起，Mnemon 会给被拒的子代理步骤追加一条用户消息并重试（[#327](https://github.com/omdsh-dev/dsh-mnemon/issues/327)），请更新 dsh-mnemo-weave。调大 Ollama 的上下文长度（`OLLAMA_CONTEXT_LENGTH` 或模型的 `num_ctx`）也能避免截断。审查可能在失败前已创建工作区档案，请核对部分写入回执 |
| 侧栏“未分组”下出现空的“未命名”会话，每运行一次记忆任务就多一些 | 上游 0.5.32 及更早版本没有给记忆任务（存入记忆、Agent 查询、档案归档、运行时记忆容量维护、记忆整理等）的任务 Agent 加上子代理来源标记，DSH 只要没有该会话的投影缓存记录，就把它当作对话列出（[#435](https://github.com/omdsh-dev/dsh-mnemon/issues/435)）。当前版本的任务记录显示方式取决于 DSH 客户端。已有的这些行会保留：dsh-mnemo-weave 不会删除它们，记忆数据不受影响。想隐藏某一行，在该行上使用“归档会话”；DSH 会把它保留在已归档筛选中，“取消归档”即可恢复 |
| Runtime replace 超容量 | 缩短 replacement 或先显式整理；自动维护只处理 add 溢出 |
| Document source path 被拒绝 | 路径必须在会话工作区内，且不能引用受管 Documents 目录 |
| CLI timeout | 增大 `timeoutMs`；大 Store 的状态与图谱可能超过 10 秒 |
| lock timeout | 检查其他写进程，不要删除仍属于活跃进程的 lock |
| ZIP 导出提示 WAL busy | 等待 Memory Space 写入完成并重试；不要绕过未 checkpoint WAL 检查 |
| ZIP 导入 checksum / schema 失败 | 备份损坏或格式不兼容；保留当前根，不要手工解压覆盖 |
| 更新按钮不出现 | 当前已是最新、远程检查失败，或安装来源是 link / 手工模式；按面板提示沿原方式更新 |
| 已认证远程页面能读取或激活记忆空间，但不能保存设置或执行其他写入 | 默认管理限制；确需远程管理时，保留当前配置、在本地设置 `remoteAccess: trusted-host` 并重启 DSH |
| DSH 桌面版记忆页面只读 | 核对当前窗口是否连接本机宿主，以及插件的 `writeEnabled` 设置。远程窗口还需满足对应的写入授权。 |
| Profile 中装有 dshmarket，DSH 启动时提示 `mkt-client-dsh-mnemo-weave-source-memory-spaces` 未能激活（`Memory Spaces requires at least one explicit Provider child`），状态页的运行时记忆或工作区档案出现两次，或每轮对话都因 `found ambiguous working-context Sources` 失败 | Profile 中另外单独安装了某个 Source 包，dshmarket 1.66 又把它作为仅客户端挂载加载了一次（[#359](https://github.com/omdsh-dev/dsh-mnemon/issues/359)）。核对 profile 是否同时加载了重复来源，调整后重启 DSH。把单独安装的 Source 从 Profile 中移除也能消除这些问题，例如 `dsh plugin --profile web remove dsh-mnemo-weave-source-memory-spaces`，因为 Starter 自带这些组件。记忆数据不受影响 |
| 技能管理的**进化**一直是空的、回合下显示**复盘失败**，或市场提示 GitHub 拒绝列出仓库 | 自进化默认关闭；一次复盘需要几轮实际工作和一次停顿。GitHub 对未认证请求每小时限 60 次：在 DSH 的运行环境中设置 `GITHUB_TOKEN` 或 `GH_TOKEN` 后重启。见[技能管理常见问题](skills.md#skills-常见问题) |
| DSH 重启或 authority 改变后 Mnemon RPC 返回 401 | 打开 `dsh web` 输出的启动 URL，让一次性 token 建立新的、与 authority 绑定的浏览器 Cookie |

<a id="ops-dsh-015-兼容与旧会话恢复"></a>

<a id="ops-已知限制"></a>

### 已知限制

<a id="ops-功能只读不等于磁盘只读"></a>

#### 功能只读不等于磁盘只读

`writeEnabled=false` 禁用语义 mutation 与 Pack 导入，但启动可能初始化 / 修复 Runtime 投影，Document 搜索更新 `lastAccessedAt`，Mnemon 读命令也可能迁移数据库。

<a id="ops-documents-的共享范围"></a>

#### Documents 的共享范围

`global` 与 `custom` 可能让多个工作区共享同一 Document index；记录没有独立 workspace ownership 字段。`sourcePaths` 只在写入时相对发起会话 cwd 校验。

<a id="ops-跨系统事务"></a>

#### 跨系统事务

“先冷索引、后移动”保护 active 原文，但不是跨 Mnemon SQLite 与文件系统的可回滚分布式事务。索引后发生 revision 冲突时可能保留重复引用；系统选择保留数据。

<a id="ops-后台审查配额"></a>

#### 后台审查配额

活动评分、最近 checkpoint 与重试状态未持久化；Host 重启会清空未处理活动。失败退避、熔断和人工重试入口尚未实现。

<a id="ops-版本与国际化"></a>

#### 版本与国际化

支持的 DSH 版本见[DSH 运行环境](usage.md#host-dsh-运行环境)。Web 界面为中英文双语，但命令、工具卡、兼容元数据和部分错误仍未完全国际化。

<a id="ops-文档归档恢复"></a>
<a id="ops-运行时归档恢复"></a>

<a id="ops-归档失败时"></a>

### 归档失败时

归档失败或中断后会保留什么、重试前应检查什么，与各自的流程写在一起：见[工作区档案归档恢复](workflows.md#workflows-工作区档案归档恢复)与[运行时归档恢复](workflows.md#workflows-运行时归档恢复)。

<a id="providers-长期记忆-provider"></a>

## 长期记忆 Provider

记忆空间保存 dsh-mnemo-weave 的长期记忆。本项目只支持一种 Provider：**Mnemon Native**，即官方 CLI 操作本地 `mnemon.db`。它是唯一的长期记忆后端，没有第三方适配器，也不内置外部后端服务。

Mnemon Native 需要 Mnemon CLI。缺少 CLI 时记忆空间没有可用的 Provider，创建空间会失败并提示先安装 CLI。

![插件中的记忆空间页面](https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/main/docs/assets/webui-v0.5.32/zh-CN/plugin-spaces.jpg)

<a id="providers-provider-能力矩阵"></a>

### Provider 能力矩阵

| Provider | 数据面 | 召回 / 浏览 | 图谱 / 关联 | 写入 | 遗忘 |
|---|---|---|---|---|---|
| **Mnemon Native** | 官方 CLI 操作本地 `mnemon.db` | 支持 / 支持 | 完整类型图谱 / 支持 | 精确写入 | 软删除 |

Host 只暴露适配器能够兑现的能力；UI 与 Agent 工具不会伪造缺失的图谱、关联、链接、浏览或删除语义。

<a id="providers-windows-cli-安装"></a>

### Windows CLI 安装

Mnemon 可以通过 npm 或 pnpm 全局安装（`pnpm add -g @mnemon-dev/mnemon@latest`）。自定义全局目录未暴露给 DSH 时，请在 Provider 的 `cliPath` 中填写可执行文件的绝对路径，显式路径仍优先。环境检查及 pnpm 更新方式见 [CLI 安装与发现](usage.md#install-mnemon-cli-的其他安装方式)。

<a id="providers-服务与记忆空间字段"></a>

### 服务与记忆空间字段

| Provider | 工作区行为 | 记忆空间页面中的服务配置 | 记忆空间中的实例配置 |
|---|---|---|---|
| Mnemon Native | 自动随工作区切换 | 无，由 CLI 配置管理 | Store 身份、嵌入设置 |

“记忆空间”页面（**设置 → 记忆空间**）保存 Mnemon Native 的服务配置与嵌入设置。“**记忆空间 → 概览**”负责创建、编辑、启停与删除记忆空间。Host 在调用适配器前合并两层配置。

启动时会在每个 Host 进程中对每个数据目录发现一次本机已有的 Mnemon Store，把它们同步进记忆空间目录；只读部署或记忆空间层关闭时不运行。

<a id="providers-召回评分语义"></a>

### 召回评分语义

Mnemon Native 的 `smart` 召回请求详细信号，先将 Source 的候选请求扩大为 `min(50, max(20, requested * 4))`，再应用返回数量限制。有正向向量相似度时，将相似度限制在 0–1、优先排序，并用于召回质量阈值。没有相似度的结果保持无分数，但已被替代的事实保留 CLI 的降权，且不会高于其原有分数。全部相似度缺失或非正时，保留 CLI 原有顺序和分数。`keyword` 与 `basic` 保留原有命令和分数。旧 CLI 拒绝 `--verbose` 时只去掉该参数重试一次，因为这些版本的默认响应已包含信号。这是在 CLI 候选内做有界重排，不是全库向量搜索，也不代表校准概率。普通召回会记录较大候选池的访问；检查仍使用 `--readonly`。

参见[召回质量策略](configuration.md#召回质量策略)。

<a id="providers-运维边界"></a>

### 运维边界

- WebUI 不直接调用本地 CLI；Provider I/O 都留在 Host，统一具备取消、超时、进程输出上限和 shell-disabled 参数执行。
- “断开”记忆空间只删除本地目录登记，不删除底层数据。单条记忆的“遗忘”是另一项按能力开放的操作。
- Mnemon Native 会记录使用。Agent、`/mnemon recall` 或 **Agent 查询**发起的召回，会把查询写入存储的操作日志（`mnemon log`，保留最近 5,000 条操作），并把返回的记忆计为已访问；Mnemon 的保留策略会参考访问次数（`mnemon gc` 不会建议清理访问过三次的记忆）。记忆系统自身的检索（记忆空间页上的**直接检索**和实体页上的**查找相关记忆**）改为用 `mnemon --readonly` 读取快照，与它的列表和图谱一样，不做任何改动。Host 归档时核验自身写入的检查读取实时存储，因为其他进程写入期间，快照不一定与存储一致。
- Mnemon Pack 包含 Mnemon Native 记忆空间、运行时与档案。
