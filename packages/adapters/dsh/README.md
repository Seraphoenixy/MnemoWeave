# adapters/dsh

**阻塞**。本模块只有 `DSH_HOST_FACTS` 常量（`status: 'blocked'`，附阻塞原因与证据文本），没有可运行的事件适配或 hook 入口。

解除条件：取得可核验的已安装 SDK/运行时，再按 `HostEvent` 映射与 shared-sdk 的 `InjectionController` 实现。DSH 的只读记忆界面是另一件事，实现在 `plugins/dsh-mnemo-weave`，见 `docs/dsh-ui.md`。
