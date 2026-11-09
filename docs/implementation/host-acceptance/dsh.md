# DSH 接入验收记录（HOST-01/02，2026-11-08；2026-11-09 复核）

状态：**阻塞**（DeepSeek Harness Desktop 已安装，但 Harness CLI/运行时未由桌面应用初始化，无法核验版本与 SDK 能力）。

## 1. 产品与平台

| 项 | 值 | 核验方式 |
|---|---|---|
| 产品 | DSH（DeepSeek Harness） | — |
| 版本 | 未知；桌面应用已安装（Electron；`resources/runtime/versions.json` 记录 node 24.21.0、pnpm 11.28.5），Harness CLI 未就绪 | `dsh.cmd --version` 仍输出 "Harness CLI not found" |
| 平台 | Windows 10.0.19045 x64 | 系统信息 |
| 安装位置 | `C:\\Users\\Xuan\\AppData\\Local\\Programs\\DeepSeek Harness`（2026-11-09 观测） | 目录核验 |
| 残留物 | `%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd` 存在但输出 "[dsh] Harness CLI not found. Please run DeepSeek Harness Desktop to install it first" | 直接运行 `dsh.cmd --version` 与 `--help`（均报同错误） |

## 2. 已知证据（非本机核验）

- `work/upstream/dsh-mnemon`（提交 ee080a73，package 0.5.42）注册 session/event、user/message、assistant/message、tool/call、tool/result、turn/end、system-prompt/assemble 等事件；其 DSH peer 范围 `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`。
- 该证据是集成插件源码，不是 DSH 公共 API；不得据此实现适配器。

## 3. 实现物

- `packages/adapters/dsh/src/index.ts`：阻塞记录与解除后的实现指引；无可运行适配器代码（依据实际 SDK 编写的前置条件不满足）。

## 4. HOST-02 场景清单

全部未执行——宿主运行时不存在的机器上无法核验任何能力。

## 5. 阻塞项与解除条件

1. **Harness CLI/运行时未就绪**：桌面应用已安装，但首次运行尚未初始化 CLI（`dsh.cmd` 报 CLI not found），因此无法取得 DSH 版本、加载插件或核验 SDK。已由用户决策登记为**永久阻塞项**（`decision-register.md` 第十九批 HOST-02-DSH，2026-11-08）。解除条件：启动 DeepSeek Harness Desktop 完成初始化，使 `dsh.cmd --version` 可用；随后按 `packages/adapters/dsh` 指引实现并重跑验收。
2. 安装后：运行 `node dist/tests/support/dsh-verify.js` 自动核验版本与 peer 范围并输出证据块；以真实 SDK 编写适配器（事件映射 → HostEvent、注入 → shared-sdk InjectionController）、运行 HOST-02 场景清单、补齐脱敏结果并更新本记录。操作手册：`host-acceptance/runbook.md` §2。

解除安装阻塞前，DSH 首版验收保持阻塞；按 HOST-02 规则，任一必需 Host 阻塞则全项目首版不得标记完成。
