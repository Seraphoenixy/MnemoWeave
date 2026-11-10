# core

Application Core 层分组。

- `contracts/`：跨层共享的请求/输出契约（zod schema），包 `@mnemoweave/contracts`。
- `application/`：应用核心工作流与端口（MemoryApplication、MemoryWorkflow、VersionWorkflow），包 `@mnemoweave/application`。

本组承载 Application Core 的边界；包依赖方向与职责见 `docs/architecture.md`。
