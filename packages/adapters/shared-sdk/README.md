# 宿主适配共用 SDK

提供适配器能力描述与校验（`descriptor.ts`）：每项能力都带状态、证据与核验时间，声明 `supported` 必须给出核验日期，`gatesMet` 只在四项首版门槛能力全部 `supported` 时成立。准则注入的渲染与截止由 `packages/client` 提供，见 [实现与契约](../../../docs/implementation.md#宿主准则注入)。架构与包边界见 [架构](../../../docs/architecture.md)。
