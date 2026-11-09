# Provider Capability Matrix

核查日期：2026-11-08。状态表示已读源码证据，不表示所有能力均已运行验证。

固定证据版本：

- 官方 HEAD：`bbc9151234e0c4f563a0d581e4bc2d5a2d4f83ec`，https://github.com/mnemon-dev/mnemon 。
- 实际运行版本 v0.2.13：`0025a66351263abec3b67ef5b4a6932adb80e5dd`。Windows amd64 压缩包 SHA256：`ab36b832a2b5db1b1dd4f479fb8cedd8d1928b34704d6311fa5c9d666235dfa9`，与官方 checksums.txt 一致。
- DSH HEAD：`ee080a7371759928c97c581621713819f31507d4`（`v0.5.42`），https://github.com/omdsh-dev/dsh-mnemon 。集成层评估见 `dsh-mnemon-architecture-analysis.md`。
- 本地源码在 work/upstream/{mnemon,dsh-mnemon}。下表 M 路径相对官方 HEAD，D 路径相对 DSH HEAD；运行测试只承诺 v0.2.13。HEAD 比 release 新，不能把 HEAD 功能当成 release 已提供。

| 能力 | 官方 Mnemon：结论与源码符号 | DSH 集成层 | 证据/验证限制 |
|---|---|---|---|
| Memory CRUD | 部分支持：M cmd/memory/{remember,show,forget}.go 的 rememberCmd/showCmd/forgetCmd；未发现通用内容 update 命令 | D plugins/dsh-mnemon-provider-mnemon-native/src/driver.ts，MnemonNativeProvider 适配 | remember_test.go、readonly_test.go 是上游测试源码，未运行 Go 测试 |
| Remember | 已证实支持：rememberCmd，UUID、JSON、精确重复跳过，差异建议不等于审核 | native driver remember 映射，不增加官方事务保障 | 本项目真实二进制验收覆盖新增/重复/Recall；见 execution 日志 |
| Recall | 已证实支持：recallCmd、compactResponse；默认图增强，--basic 为 SQL LIKE | driver.normalizeInsight 兼容不同输出形态 | 本项目覆盖默认 compact JSON；模型重排未验收 |
| Link | 已证实支持：linkCmd、relatedCmd，创建/更新边与 BFS 查询 | driver.link/related；图导出还解析 viz HTML | link_test.go、related.go；本项目不采用 HTML 作为稳定契约 |
| Entity | 部分支持：model.Insight.Entities、graph.EntityMode，remember --entities/--entity-mode | Source/Provider 展示实体与图 | 不是独立实体 CRUD API |
| Relation | 部分支持：model.EdgeType（temporal/semantic/causal/entity/supersedes）及 IsDirected | Source 的关系模型另有边界 | 不等于 MnemoWeave 的全部 Supports/Contradicts/Refines 等关系；不可强行映射 |
| Store | 已证实支持：storeCmd 子命令 list/create/set/remove；root.resolveStoreName | Memory Spaces 将 body/store 适配 | 首切片显式 --data-dir 和 --store，避免活动 store 污染 |
| Source | 部分支持：Insight.Source 字符串、--source 筛选；HEAD records 是另一子系统 | D src/core/contracts/view.ts MemorySourceDefinition/Manifest；SDK defineMemorySource | 原生 source 字段不等于编排 Source |
| Strategy | HEAD 部分支持：cmd/memory/serve.go openMemoryAgent、internal/memoryagent；release CLI 未提供该入口 | D MemoryStrategyDefinition、composition.ts | 不能把旧结论“仅 DSH 有”推广至新 HEAD，也不能认为等同 MnemoWeave Strategy |
| Enhancement | 正式 Memory CLI 未发现对应标准扩展契约 | D MemoryStrategyExtensionDefinition、sdk/index.ts | MnemoWeave 继承抽象而非复制全部 Host 运行时 |
| View | HEAD 部分支持：memoryagent.Read；不是 release 的通用不可变授权上下文 | D ComposableMemoryView、MemoryReadGrant、definitions.deepFreeze | DSH View 与官方 Memory 数据模型分开 |
| Revision | 正式 Insight 未发现不可变内容历史/当前指针接口；HEAD internal/records 有 revision 固定读取 | D View facts revision/expectedRevision 提供执行一致性 | records/index_test.go 等为源码证据，不能替代正式 Insight Revision |
| Provenance | 部分支持：Insight.Source、tags、时间戳；未见完整 R19 证据结构 | D MemoryPackageProvenance、MemoryEvidence、ViewFragment.provenance | 包来源、执行证据不等于知识 Provenance 的全套语义 |
| Change Feed | 未发现满足 MnemoWeave 同步要求的正式 Insight cursor 变更协议 | DSH 自有同步/导出不等于通用 Provider change feed | cmd/memory/{log,receipt}.go 是操作记录/脱敏收据，不能作为可重放同步流 |
| Snapshot | 部分支持：store.OpenReadOnly 为 immutable 数据库快照读取；Web BeginWebSnapshot 为请求内一致读 | D View exact-snapshot / namespace-pinned-live-read | 不等于含 cursor、授权和完整关系的同步快照导出 |
| Tombstone | 部分支持：Insight.DeletedAt、forget 软删 | Source 自有 archive/forget 语义 | 未发现正式删除传播协议；不能仅凭软删宣称支持 Replica Tombstone |
| Embedding | 已证实源码支持：embed/ollama.go Client、openai_test.go、vector.CosineSimilarity | native Provider 使用 Mnemon 能力 | 可选；本轮不调用外部模型，不宣称语义召回质量已验证 |
| Search | 部分支持：cmd/memory/search.go、recall.go；token scoring、LIKE、向量/图增强 | 多 Provider 自有差异 | 正式 Insight 未据此认定 FTS5；HEAD records 的 lexical/native_bm25 属另一体系 |
| Capability | 官方 CLI 有版本；未发现满足 MnemoWeave 的标准协商端点 | D MEMORY_CAPABILITIES、Provider manifest/apiVersion | DSH 声明不等于官方声明；MnemoWeave 首切片采用固定版本配置档并拒绝未知版本 |
| API | CLI JSON 已证实；HEAD serve.go 为 Unix socket，service.Service.Dispatch 仅 native.show/search/recall；无证据支持原生通用 Memory MCP | D Host RPC/插件 SDK 和 Provider Runner | release --help 无 serve；不能伪造官方 HTTP/MCP |
| HTTP | 部分支持：M internal/memory/web/handler.go NewHandler/ServeHTTP：私有 GET-only、loopback/same-origin | D src/client/remote-rpc.ts 绑定 DSH | Web 私有读 API 不是通用远端写接口；Agency/AML 控制接口另属子系统 |

## Q1 结论

可在 Server 所在机器调用 CLI，使用绝对二进制路径、参数数组、显式 data-dir/store 和 JSON 解码。SQLite WAL 是源码事实，不构成无条件多进程安全保证；本项目先串行化同一 Adapter 实例调用，跨进程并发仍待压力/故障验证。正常 Recall 会更新 access_count/oplog，因此不是纯无副作用读取。不要对活跃数据库随意使用 immutable --readonly。

版本固定只降低兼容风险，不意味着上游已承诺 CLI 永久稳定。升级必须重新执行 Contract/E2E 验收。

## 真实验收发现：重复写入 ID

v0.2.13 与 HEAD 的 cmd/memory/remember.go `diffAction == "skipped"` 分支返回新尝试的 `id`，已有记忆 ID 位于 `replaced_id`。初次 E2E 直接比较 id 失败；Adapter 必须以 action 判别结果，skipped 时取 replaced_id，并拒绝缺失该字段的响应。不要将 attempt id 当成正式 Memory ID 或幂等回执。
