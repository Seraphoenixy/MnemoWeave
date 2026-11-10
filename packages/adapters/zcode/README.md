# adapters/zcode

ZCode 适配：`zcodeWorkspaceHooks`/`installWorkspaceHooks`/`installWorkspaceMcp` 生成工作区配置（`hooks.enabled: true`、process 类型钩子、2.5 秒钩子超时），`normalizeHookEvent` 归一化七个钩子事件（SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop），`injectContext` 走 `additionalContext`。`src/hook-main.ts` 是钩子子进程入口。

能力声明保持 `unverified`，真实桌面会话验收未完成，见 `docs/host-acceptance.md`。
