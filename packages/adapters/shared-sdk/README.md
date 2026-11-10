# adapters/shared-sdk

Host 适配器共用件：`InjectionController`（注入截止与预算，默认 2 秒）、`InjectionRecallSource`、`InjectionTrigger`（7 种触发）、`AdapterDescriptor` 与 `validateDescriptor`/`unverifiedDescriptor`（能力声明校验）。

各 Host 适配器基于本模块实现事件映射与注入，见 `docs/host-acceptance.md`。
