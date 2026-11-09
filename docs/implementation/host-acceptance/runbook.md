# 宿主验收操作手册（用户执行）

状态：2026-11-08。会话内可完成的实现与自动化验收（Codex 全部、ZCode 端到端冒烟）已完成；剩余两项为用户操作。本手册把它们压缩为逐条命令，完成后按各记录的场景清单回填脱敏结果。

## 前置（一次性）

```powershell
Set-Location D:\projects\MnemoWeave
node node_modules/typescript/bin/tsc   # 构建 dist/
```

## 1. ZCode 真实会话验收

```powershell
# ① 启动 Server（隔离目录，专用 Store）
$env:MNEMON_BINARY='D:\projects\MnemoWeave\work\tools\mnemon\mnemon.exe'
$env:MNEMON_DATA_DIR='D:\projects\MnemoWeave\work\zcode-memory'
$env:MNEMON_STORE='zcode'
$env:MNEMOWEAVE_STATE_DIR='D:\projects\MnemoWeave\work\zcode-state'
$env:MNEMOWEAVE_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:MNEMOWEAVE_OPERATOR_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:MNEMOWEAVE_PORT='4317'
node dist/apps/server/src/main.js          # 窗口 1

# ② 操作员签发 Host 授权（新窗口，替换 <OPERATOR_TOKEN> 与 <TOKEN> 为 ① 输出的值）
curl -s -X POST http://127.0.0.1:4317/v1/sync/grant `
  -H "Authorization: Bearer <OPERATOR_TOKEN>" -H "content-type: application/json" `
  -d '{"hostId":"zcode-host","projects":["proj"],"globalIncluded":true}'

# ③ 安装钩子/MCP 配置到工作区（选择将运行真实会话的工作区目录）
node dist/tests/support/zcode-acceptance-setup.js <工作区目录> http://127.0.0.1:4317 <TOKEN> zcode-host

# ④ 为 ZCode 桌面会话准备处理器的环境变量（会话内钩子进程继承用户环境）
[Environment]::SetEnvironmentVariable('MNEMOWEAVE_SERVER','http://127.0.0.1:4317','User')
[Environment]::SetEnvironmentVariable('MNEMOWEAVE_TOKEN','<TOKEN>','User')
[Environment]::SetEnvironmentVariable('MNEMOWEAVE_BRIDGE_HOST_ID','zcode-host','User')

# ⑤ 启动真实 ZCode 桌面会话（工作区目录），执行任意带工具调用的任务后结束
```

验收采集点：

- 会话结束后运行证据收集器（自动生成脱敏结果与 HOST-03 覆盖率）：
  `node dist/tests/support/zcode-acceptance-collect.js <MNEMOWEAVE_STATE_DIR 绝对路径> zcode-host`
  把输出的 JSON 整体贴回 `host-acceptance/zcode.md` 场景清单。
- 注入：会话开始/用户消息时若 Recall 命中，回复上下文包含 MnemoWeave 注入块；未命中时钩子静默（HOST-04 不阻断）。
- 能力声明升级：`packages/adapters/zcode/src/index.ts` 的 `zcodeDescriptor`（unverified → supported，附会话日期）。

已知登记缺口：session.ended 无专用事件（保持登记，不假充）。

## 2. DSH（先安装，后核验）

1. 启动已安装的 DeepSeek Harness Desktop，完成 CLI/运行时初始化（官方渠道安装）。
2. 核验：`node dist/tests/support/dsh-verify.js` —— 自动探测版本是否落入 dsh-mnemon peer 范围并输出证据块。
3. 把证据块填入 `host-acceptance/dsh.md`，然后按其第 5 节指引以真实 SDK 实现 `packages/adapters/dsh` 并运行 HOST-02 场景清单。

## 3. Codex（已完成，留档）

真实会话验收已于 2026-11-08 完成（隔离 CODEX_HOME + `codex exec`，六类事件负载捕获 + additionalContext 注入端到端标记验证）。原始负载：`work/codex-acceptance/logs/hook-events.jsonl`；注册：`codex mcp get mnemoweave`（撤销：`codex mcp remove mnemoweave`）。
