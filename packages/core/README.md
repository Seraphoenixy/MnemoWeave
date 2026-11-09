# core

Application Core 层分组。

- `contracts/`：跨层共享的请求/输出契约（zod schema），包 `@mnemoweave/contracts`。
- `application/`：应用核心工作流与端口（MemoryApplication、MemoryWorkflow、VersionWorkflow），包 `@mnemoweave/application`。

原预留的独立 core 模块边界由本组承载；职责划分遵循 docs/architecture/component-architecture.md。
