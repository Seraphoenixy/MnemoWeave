# 生命周期与核心流程

<a id="workflows-生命周期与核心流程"></a>

本文档描述 Core 内置的**分层策略**及 DSH 宿主的运行时执行流程。分层策略每个角色只组合一个 Source，挂载第二个同角色 Source 会在回合开始时因 `found ambiguous … Sources` 失败。除各路由自身上限外，分层策略应用每回合召回准入信封，并承担 Runtime 容量维护、归档与空闲审查。

<a id="workflows-每轮上下文"></a>

## 每轮上下文

模型每轮获得三层记忆：当前回合固定的工作准则、按需检索的工作区档案，以及按需召回的记忆空间。

- `mnemon:strategy`：说明工作准则层用途，条目在系统提示中直接生效、不另行检索；说明投影预算与分支筛选可能导致条目未出现，以及替换条目时的匹配规则。
- `mnemon:working-rules`：紧跟在 `mnemon:strategy` 之后，注入当前 View 筛选后的工作准则条目正文。当前用户指令优先，条目作为引用数据。
- `mnemon:routing`：在 `routingGuidance=true` 时注入工作区档案与记忆空间的读写边界说明，并随当前视图能力裁剪。
- **Wake**：以 `dsh-mnemo-weave` 自有 `user` 角色插件消息追加本轮动态上下文（可用工具、档案与记忆空间的有界封面），不重复注入工作准则。Host 仅在 Wake 内容变化时追加新的快照消息。

```text
turn/start
  -> 进入 system-prompt/assemble hook
  -> beginTurn（根回合 + 操作范围）
  -> Source 能力事实 -> Strategy 提案 ViewSpec -> 校验 -> Source 投影
  -> 固定 Source 修订/摘要与仅留在 Host 的权限
  -> 生成有界 Wake
  -> 继续 Host 提示词组装
  -> 将静态协议 section 与已固定的 Runtime Source 对齐
  -> 将变化后的 Wake 作为本插件的完整快照消息追加

agent/pre-step(step=1)
  -> 为新回合取消待执行/执行中的空闲审查
  -> 仅标记一次 Prime
  -> 按需追加只含动态上下文的 Wake 快照
  -> 主 Agent 根据上下文决定是否调用记忆工具
```

Source snapshot 不执行语义召回。Prime 只初始化路由状态，不执行异步 CLI 状态查询。

子 Agent 在 `agent/created`、driver 启动前捕获并保留存活父 Agent 的固定 View 与运行图。子 Agent 的各回合固定该保留 View，不随父回合结束或热更新 generation 变化而改变；activation 销毁时释放委托，冷恢复重新获取委托；Host 显式创建且无父模型回合的后台子任务生成新的 scoped View。子 Agent 拥有独立回合权限，不安装 root 专属的空闲审查。

<a id="workflows-委派的子会话"></a>

### 委派的子会话

`dsh-mnemo-weave` 委派给子 Agent 的每个任务以单独一行开头：`[dsh-mnemo-weave:delegated <operation>]`，任务正文从下一行开始。已知 `<operation>` 包括 `review`、`write`、`skill`、`answer`、`placement`、`migration`、`compaction`、`document-archive`、`metadata-maintenance` 与 `reconcile`。

- DSH 将任务记录为子会话的 `user` 消息（`source.kind: "user"`），子会话头部带有 `origin: "subagent"` 与 `parentSession`。
- `fork` 出的子 Agent 以父 Agent 回合副本开头（头部 `isSeeded: true`，止于 `session/end-seed`），任务跟在后面。
- 对话之外发起的后台任务（如记忆系统页发起的**存入记忆**、**Agent 查询**、**整理名称与说明**、**档案归档**、**容量维护**与**记忆整理**）运行在独立任务 Agent 会话中，头部带有 `origin: "subagent"`，不含 `parentSession` 与 `delegationDepth`。
- DSH 让子 Agent 沿用父 Agent 的工作目录，用于重启恢复后在 `workspace` / `workspaces` 模式下定位所属工作区存储。

<a id="workflows-agent-召回"></a>

## Agent 召回

```text
根 Agent 或子 Agent 调用 mnemo_recall（query，可选 memoryBodyIds）
          |
          v
解析当前执行 Agent 自己固定的回合与保留的运行时
          |
          v
读取 Host 上已固定的记忆空间 Source 状态
          |
          v
校验请求 ID 是已固定集合的子集；未指定时使用全部已固定的激活 ID
          |
          v
记忆空间 Source 并发检索已授权的 Provider 命名空间
          |
          v
质量归一化 + 倒数排名融合
          |
          v
丢弃低相关项；首次最多准入 4 条 / 3,600 字符
          |
          v
LLM 判断 evidence 是否足够
          | 足够                        | 不足
          v                             v
直接回答，不再 Recall             显式提交一个不同查询
                                        |
                                        v
                              再检索一次、去重并关闭 Recall
          |
          v
两次在当前执行 Agent 回合共享至多 6 条、每条 1,200 字符、
总正文 4,800 字符的总预算
```

- 模型工具不暴露 `category`、`source` 或 `intent` 过滤器（传入默认 Recall 会被拒绝且不消耗查询预算）。
- 同查询与并发重复请求合并或重放；第 3 个不同查询返回 `notRun: true`、`budgetExhausted: true` 与空 `results`。
- `mnemo_related` 每回合至多执行 1 次不同遍历，且只能使用本回合 `mnemo_recall` 已准入的 `memoryBodyId + id`；未准入 ID 返回 `notRun: true`。
- `mnemo_document_search` 每回合至多执行 1 次查询（最多 4 条、单条最多 2,600 字符、总正文最多 6,000 字符）；第 2 次不同查询返回 `notRun: true`、`budgetExhausted: true`。
- 并发失败会归还查询名额；子 Agent 从收到任务到最后一步为一个回合，后续向该子 Agent 追加消息开始新回合。

<a id="workflows-web-检索和-agent-查询"></a>

## Web 检索和 Agent 查询

```text
直接检索
  -> RPC 读取通道
  -> 限定到 Source 的管理检索
  -> 原始证据

Agent 查询
  -> 同一条确定性直接检索路径
  -> 派发不含 Mnemon 工具的任务 Agent
  -> 仅根据已提供的证据回答
  -> Host 将引用限定到实际的 memoryBodyId/id 对
```

**实体**与**内容**页经 Source 管理协议执行确定性读取，不调用模型。

<a id="workflows-显式长期写入"></a>

## 显式长期写入

根 Agent 调用 `mnemo_remember` / `mnemo_link` / `mnemo_forget` / `mnemo_memory_body_*` 或执行 `/mnemon remember` 时：

```text
长期记忆候选
       |
       v
派发写入任务 Agent
       |
       +-- 列出记忆空间
       +-- 指定的空间，或最小的适用已激活范围
       +-- 需要查重或检查冲突时召回
       +-- 仅在用户明确要求时创建或调整空间
       +-- 按请求执行 remember / link / forget / merge
       v
结构化回执
```

- 指定 `memoryBodyId` 时，宿主在启动子 Agent 前校验该空间存在、Provider 可写且处于激活状态；守卫拒绝向其他空间写入或关联。
- 未指定空间时，任务 Agent 在已激活空间中选择（所有空间均停用时，除用户明确新建空间外不写入任何内容）。
- **嵌入未生成提示**：向量生成失败时，Mnemon Native 仍保存记忆并返回 `embedded: false`，任务 Agent 回执在 `unembedded` 字段列出对应条目与 `hint`；`embedding.enabled: false` 时显示中性说明（关键词、关联与时间召回仍可用），`embedding.enabled: true` 时以提醒样式提示嵌入服务未成功生成向量。

<a id="workflows-runtime-add正常路径"></a>

## Runtime add：正常路径

```text
请求
  -> 规范化内容
  -> 获取进程内队列与文件锁
  -> 重新加载 memories.json
  -> 校验唯一匹配 / 重复 / 容量
  -> 写入临时 JSON 与 Markdown 投影
  -> 重命名投影文件
  -> 重命名 memories.json，作为提交标记
  -> 返回紧凑回执
```

`replace` 与 `remove` 优先在请求目标内按 `old_text` 唯一精确匹配完整正文，其次匹配唯一子串；重复完整正文或零命中均拒绝。

<a id="workflows-usermd-容量整理"></a>

## USER.md 容量整理

```text
USER 新增后超过 4 KiB
          |
          v
保存修订与已提交条目的快照
          |
          v
派发无工具权限的本地压缩任务
          |
          v
返回压缩条目 + sourceIndexes
          |
          v
Host 校验：
  - 每个来源索引恰好出现一次
  - 没有重复或越界索引
  - 重要性未降低
  - 候选符合 Host 字节预算
  - 修订仍是当前版本
          |
          +-- 无效/冲突 -> 保留原始数据
          |
          v
按 UTF-8 字节确定性装填
          |
          v
重试待处理的新增操作
```

固定条目（`pinned: true`）原文逐字保留，不送入压缩模型。

<a id="workflows-memorymd-归档与压缩"></a>

## MEMORY.md 归档与压缩

```text
分层策略下，本次 MEMORY 写入将超过配置上限（默认 10 KiB）
          |
          v
snapshot revision + 可归档的已提交 entries
（排除待提交 add、正被 replace/remove 的 entry，以及 pinned 条目）
          |
          v
Host 在本次操作的 Source / 命名空间范围内选择已有、active、可写的 Memory Spaces
          |
          +-- 任何地方都没有（该层关闭或不接受自动写入、没有就绪的 Provider、
          |   没有支持精确写入与安全删除的 active 空间）
          |     -> Runtime Source 在同一把锁内把压缩舍弃的条目追加到 runtime/archived/，
          |        再提交压缩与待提交修改；不调用模型，也不写 Provider
          |
          v
单个目标：Host 直接路由
多个目标：独立无工具 worker 只返回 source-index 路由
  模型执行失败时，Host 在合格目标中确定性兜底
          |
          v
Host 校验精确 source coverage、目标、权限与源修订
          |
          +-- 无效/revision 已变 -> 不写 Provider；保留 Runtime
          |
          v
Host 把每条原始 entry 精确写入规划的已有 Space
  - committed receipt -> 绑定目标 digest
  - skipped -> 必须取得完全一致的 Recall evidence
          |
          v
Host 按重要性与字节预算保留原始运行时记忆条目
          |
          v
CAS compactAndMutate(revision, compaction, original mutation, lineage)
  -> JSON 与两个 Markdown projection 作为一次本地提交落盘
```

<a id="workflows-运行时归档恢复"></a>

### 运行时归档恢复

- 容量归档仅写入已激活且支持精确写入与安全删除的记忆空间。在 View 固定后新建的空间需下一回合方可使用；若当前 View 写入范围内无可用空间而目录中存在其他符合条件的空间，写入会被拒绝而非回退到本地 `runtime/archived/`。
- 归档回执或本地提交失败时，Host 仅尝试删除回执明确证明由本次操作新建的条目，保留跳过或复用条目。若本地提交时发生修订冲突且无法读取当前修订，则保留已归档条目以防止数据丢失，并在错误中列出剩余空间与条目 ID。

<a id="workflows-documents-创建更新和归档"></a>

## Documents 创建、更新和归档

```text
创建/更新请求
          |
          v
按渲染后的 UTF-8 字节执行 capacityPlan
          |
     +----+----+
     |         |
   未超限     溢出
     |         |
     v         v
   提交    选择最久未访问的活跃档案
               |
               v
          保存档案与修订的快照
               |
               +-- 任何地方都没有能接收索引的记忆空间
               |     -> 不建索引，直接将文件移入归档，不派发任务 Agent
               |
               v
          派发归档任务 Agent
               |
               v
       写入并验证紧凑的 Mnemon 冷引用
       包含标题、摘要、计划路径、SHA-256
               |
          +----+----+
          |         |
         失败     回执有效
          |         |
          v         v
      保持活跃    检查修订
                    |
               +----+----+
               |         |
                冲突     一致
               |         |
               v         v
             保持活跃   将文件移入归档
                             |
                             v
                       重试原始修改
```

<a id="workflows-工作区档案归档恢复"></a>

### 工作区档案归档恢复

人工归档复用同一路径。若冷引用写入成功但后续文件修订冲突，已写入的索引保留（不回滚），活跃原文维持原状。

<a id="workflows-确定性活动评分和空闲审查"></a>

## 确定性活动评分和空闲审查

完成的 turn 累计四种信号：

```text
score =
  min(floor(totalUserCharacters / 50), 3)
  + completedTurnCount
  + min(floor(completedToolResults / 5), 2)
  + toolDiversityScore

toolDiversityScore:
  不同工具数 < 3  -> 0
  不同工具数 = 3  -> 1
  不同工具数 >= 4 -> 2

score >= 5 时达到门槛
```

```text
已完成的回合
      |
      v
score >= 5 ? -- 否 --> 为后续回合保留累计活动
      |
      是
      |
      v
Host 判断是否存在待整理内容
  - 当前轮明确要求不写记忆 -> 停止
  - 持久化意图、累计 >=320 用户字符、
    >=600 助手字符或已完成非 Mnemon 工作 -> 继续
      |
      v
等待 idleReviewMs（默认 30 秒），且距上次尝试
至少 idleReview.minIntervalMs（默认 5 分钟）
      |
      +-- 新回合 --> 取消定时器/任务，保留累计活动
      |
      v
确认 Agent 已空闲、已有 turn/end、该回合由分层策略组合，
且未达到 idleReview.maxPerSession
      |
      v
就已完成的回合启动任务 Agent
  - spawn（默认）：有界检查点，上限 idleReview.maxContextChars
  - fork：继承父 Agent 上下文
      |
      v
保守整理决策，每轮只写一层
  - 先看档案：先检索；项目记录至多新建一份独立档案，
    不更新或归档已有档案
  - 运行时记忆：只收录用户新提出的、明确且持久的陈述；
    MEMORY.md 只收档案未涵盖的简短规则，不收项目记录
    （idleReview.runtimeMemory: false 时关闭）
  - 建了档案就不能再改工作记忆，反之亦然
  - 不提供记忆空间写入工具
      |
      +-- 已完成（含跳过）--> 清空累计活动
      |
      +-- 失败/中止 --------> 保留累计活动
```

安装 Agent Teams 工具时，除非设置 `idleReview.agentTeams: scoped`，否则自动审查暂停。

<a id="workflows-配置开关的关系"></a>

## 配置开关的关系

- `recallMode`：兼容旧配置保留；系统提示中的路由指引由 `routingGuidance` 控制。
- `writebackMode=off`：关闭自动会话沉淀，显式写入仍由 `writeEnabled` 控制。
- `lifecycleEnabled=false`：关闭工作准则正文注入、Wake 更新与自动会话沉淀，显式工具与 Web 入口仍可用。
- `routingGuidance=false`：仅移除 `mnemon:routing`；Runtime Memory 上下文仍注册。
- `writeEnabled=false`：移除语义写工具与写 RPC，拒绝写命令；不构成文件系统只读挂载保证。
