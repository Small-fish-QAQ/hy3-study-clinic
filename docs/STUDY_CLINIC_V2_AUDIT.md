# Hy3 Study Clinic 深度产品与架构审计报告

## 执行结论

Hy3 Study Clinic 不是一个需要推倒重来的 Demo。它已经具备相当扎实的“可靠 AI 应用骨架”：

- source block 与精确引文；
- runtime schema validation；
- 本地 ID、证据、图结构、评分和状态转换校验；
- fake / Hy3 provider 同契约；
- 图谱版本与失败保旧；
- objective-local + semantic-rubric grading；
- mistake、mastery、misconception、review 分离；
- completed attempt 历史快照；
- 前端 cancellation / stale-response 防护；
- 大量确定性离线测试。

但产品核心目前仍然更接近：

> 文档 → 3–8 个扁平概念 → 关系图 → 计划文案 → 测验 → 错题/掌握度

而不是：

> 课程知识地图 → 教学增强 → 诊断 → 策略选择 → 教学活动 → 学习证据 → 再规划

因此最终判断是：

1. 已确认一个会中断 Tutor 推荐活动的 P0 契约错误。
2. “学习内容薄”不是简单调大 concept 数量即可解决，而是抽取管线、知识模型和 grounding policy 共同造成的结构性问题。
3. 当前“测评—错题—掌握度—复习”闭环是真实的；“诊断—教学—活动—结果—再规划”仍是半闭环。
4. 值得进行结构性升级，但必须沿现有可靠骨架渐进演进，不应重写。

### 审计基线

本轮全程只读，没有修改代码、配置、Prompt、Schema、测试或文档，没有创建 commit。

实际运行结果：

- `npm.cmd test`：59 个测试文件、771 项测试全部通过；
- `npm.cmd run build`：通过；
- `npm.cmd run lint`：ESLint 与 Prettier 检查通过；
- `npm.cmd run demo:offline`：完整离线学习闭环通过；
- `npm.cmd run eval:fake`：31/31 项结构与安全检查通过。

Git tracked worktree 保持不变；现有未跟踪 `.claude/` 在审计前已存在，未触碰。需要强调的是，现有 fake eval 明确偏向结构、grounding 和状态不变量，而不是教学质量证明，[eval/README.md](/C:/Users/smallfish/open-source/hy3-study-clinic/eval/README.md:94)。

---

# A. Current Architecture

## A1. 当前真实架构

```text
React UI
├─ 单资料流程
│  └─ 导入 → 概念分析 → Quiz → 结果/错题/掌握度/历史
└─ Workspace 图谱流程
   └─ 文档 → 对齐 → 图谱 → Overlay/Queue
                    → Plan / Tutor → Assessment

              REST JSON / Tutor NDJSON
                         ↓
Fastify Routes
                         ↓
Application Services
├─ ingestion / analysis / graph / alignment
├─ quizzes / assessment / grading / remediation
├─ planner / tutor / queue
└─ mistakes / mastery / misconception / review
                         ↓
Domain validators + Zod schemas
             ↙                           ↘
SQLite repositories              LlmProvider
                              ├─ FakeProvider
                              └─ Hy3Provider
                                  ↓
                           structured JSON
                                  ↓
                    parse → Zod → local validation
                                  ↓
                           accepted persistence
```

### 模块结构

| 层 | 主要实现 | 实际职责 |
|---|---|---|
| 前端应用 | [App.tsx](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/App.tsx:26) | 保存当前 material、concept、quiz、assessment、result 等顶层状态；切换资料、图谱、练习、错题、掌握度、历史等视图 |
| 图谱工作区 | [GraphWorkspaceView.tsx](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/GraphWorkspaceView.tsx:172) | 加载 workspace、graph、overlay、alignment、misconception、review、queue；承载 Plan、Tutor 和 activity launch |
| Tutor UI | [TutorPanel.tsx](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/components/TutorPanel.tsx:90) | 展示工具调用时间线、最终 plan 和“开始推荐活动”；没有学生自由追问或实际教学内容 |
| API | [app.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/app.ts:80)、[study.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/routes/study.ts:1) | Fastify REST；Tutor 使用 NDJSON 流 |
| Service/domain | [services/index.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/index.ts:1) | 核心业务编排；route handler 基本没有承载主要领域规则 |
| AI provider | [provider.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/provider.ts:1)、[hy3Provider.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/hy3Provider.ts:192) | 统一 fake/Hy3 契约；JSON 提取、Zod 验证、一次有界 repair |
| Prompt | [prompts.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/prompts.ts:1) | concept、quiz、grading、remediation、graph、plan、alignment、assessment、Tutor Prompt 集中定义 |
| 持久化 | [migrate.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/db/migrate.ts:21)、[repositories](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/repositories/index.ts:1) | SQLite、11 个 migration、WAL、FK、显式 repository |
| 可靠性 | [verify.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/grounding/verify.ts:35)、[validate.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/graph/validate.ts:15) | 引文定位、已知 ID、关系枚举、去重、环、证据和预算校验 |

## A2. 主用户路径

### 单资料路径

```text
.md/.txt/.pdf/.docx
→ 解析与 segment
→ Material + SourceBlock
→ concept extraction
→ Quiz
→ submit
→ objective local grading / Hy3 semantic rubric coverage
→ local score
→ Mistake + Mastery + Review
→ Results / History
```

支持格式和解析器在 [documents.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/ingestion/documents.ts:13) 中明确定义：

- Markdown / TXT；
- PDF：unpdf/PDF.js + layout reconstruction，保留页码范围；
- DOCX：Mammoth，保留 heading；
- 当前没有 OCR 管线。

限制为单文件 10 MiB、标准化文本 100,000 字符、每份材料最多 2,000 个 block，见 [workspace.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/workspace.ts:7)、[ingest.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/ingestion/ingest.ts:3)、[segment.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/ingestion/segment.ts:19)。

### Workspace 自适应路径

```text
Workspace + 多文档
→ 各文档 concept extraction
→ canonical alignment
→ graph proposal / activation
→ mastery/mistake/misconception/review overlay
→ DailyQueue / Plan / Tutor
→ AssessmentMode
→ workspace Quiz + QuestionBlueprint
→ grading
→ learner state update
```

两条前端路径仍有明显分离：App 顶层的 Mistakes/Mastery 等主要是当前 material 作用域，而 GraphWorkspaceView 处理 workspace assessment。这可能造成用户刚完成 workspace 测评，却看到另一个 material 的学习状态。

## A3. AI 调用链

| 操作 | 输入 | Hy3/Fake 输出 | 本地约束及持久化 |
|---|---|---|---|
| Concept extraction | 当前文档全部 blocks | `ConceptProposal[]` | Zod、已知 block、精确 quote；合法项保存 |
| Quiz generation | concept + source blocks + difficulty/types | questions + rubric + grounding | concept/type/quote/rubric 验证；无合法题则失败 |
| Semantic grading | 用户答案 + rubric points | 每个 rubric point 的 covered 判定和简短反馈 | 分数由本地重新计算；模型不决定最终状态 |
| Graph | 已有 concepts + source blocks | typed edge proposals | 已知 ID、枚举、去重、cycle、evidence；验证通过后激活新版本 |
| Alignment | 多文档 concepts | possible equivalents | exact normalization 可自动接受；语义 proposal 需要显式处理 |
| Plan | graph + mastery + mistakes + review/misconception | plan/steps/strategy/evidence | concept、中心性、证据校验；失败保留旧计划 |
| Tutor | graph/state + lexical retrieval tools | remediation plan + `{mode, conceptIds}` | 校验 plan/evidence/concept ID，但未校验 activity 当前是否可执行 |
| Assessment | activity mode + target concepts + source evidence | blueprints/questions | mode-specific evidence 和 rubric 校验，持久化 workspace quiz |

Concept extraction 的真实入口是 [AnalysisService.analyze](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/analysis.ts:18)。它不是逐 chunk 或逐 section 调用，而是一次把整份材料 blocks 传给 provider。

除 Tutor 外，多数生成路径没有真正的 retrieval/context packer；通常直接拼接目标材料的全部相关 block。Tutor 才使用 lexical retrieval，[lexical.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/retrieval/lexical.ts:1)，并受 6 turns、12 tool calls、最多 3 个 target、每次 8 个 block 等预算约束，[tutor.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/tutor.ts:33)。

## A4. Prompt、parser 与 fallback

真实 Hy3 调用采用 OpenAI-compatible `/chat/completions`，低温度、timeout 和 AbortSignal；响应按 fenced JSON、whole JSON、balanced JSON 提取，再经 Zod 验证。JSON/schema 失败允许一次携带验证错误的 bounded repair，[hy3Provider.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/hy3Provider.ts:192)、[json.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/json.ts:1)。

重要边界：

- 没有 real → fake 静默 fallback；
- grounding 或业务后置条件失败不会自动改用 fake；
- JSON/Zod repair 不等于 grounding repair；
- 新图、新 plan 失败时不会覆盖旧有效版本；
- 已存在 concepts 时 `analyze` 直接返回，不会自动增量补充；
- fake provider 保持相同输出契约且离线确定性。

当前配置只有 `LLM_PROVIDER=fake|hy3`、endpoint、key、model、timeout 等，[config.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/config.ts:10)。没有 Strict Source / Enhanced Tutor feature flag；六个 `AssessmentMode` 是活动类型，不是 grounding policy，[blueprint.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/blueprint.ts:23)。

## A5. 核心实体与持久化

```text
Workspace
├─ Material
│  ├─ SourceBlock
│  ├─ Concept
│  ├─ document Quiz / Question
│  ├─ Mistake
│  └─ MasteryState
├─ CanonicalConcept ← CanonicalMember → Concept
├─ GraphVersion → GraphEdge → GraphEdgeEvidence
├─ RemediationPlan
├─ workspace Quiz → QuestionBlueprint
├─ Submission → GradingResult
├─ MisconceptionRecord
├─ ReviewItem → immutable ReviewEvent
└─ TutorRun → TutorEvent
```

SQLite 启用 WAL 与 foreign key，[database.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/db/database.ts:11)。11 个 migration 覆盖了材料、workspace、图谱、对齐、assessment、misconception、review、Tutor、页范围和历史快照。

当前没有以下一等实体：

- document revision；
- course/knowledge map version；
- coverage unit；
- teaching artifact；
- learning activity lifecycle；
- diagnosis snapshot；
- activity → plan/Tutor/queue → outcome lineage；
- append-only mastery evidence event。

## A6. Grounding 与 provenance

现有 grounding 做得很扎实：

- SourceBlock 保存确定性 offset、heading、页码；
- model 引用必须带现有 block ID 和 quote；
- `verifyGrounding` 验证 quote 精确存在，允许唯一、保守的 re-anchor；
- 歧义或不存在时拒绝；
- graph edge、plan target、assessment blueprint 都保留 evidence；
- completed attempt 保存快照，因此原材料被删除后历史仍可审计。

但代码也正确承认：

> 精确引文只能证明文本存在于该位置，不能证明整条语义关系被完整蕴含。

这一边界在 [graph/validate.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/graph/validate.ts:35) 中已明确。

问题不在 grounding 太可靠，而在目前几乎所有内容合同都只有一种 provenance：“必须能被原文直接支撑”。[wrapSource.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/grounding/wrapSource.ts:32) 明确要求“仅依据这些数据”，quiz、graph、assessment Prompt 也有类似约束。系统没有 `ai_teaching` 这类合法内容来源，因此可靠性逐渐演化成了 source-only。

## A7. 学习状态如何流转

提交后：

1. 选择题本地判分；
2. 文本题由 Hy3 判断 required/optional rubric point coverage；
3. 本地根据覆盖结果计算分数；
4. `<0.6` 创建 open mistake；
5. remediation/adaptive 正确题可按 `sourceMistakeIds` 精确关闭旧错题；
6. 同一 concept 本次题目分数先取平均，再更新 EMA mastery；
7. misconception check 走本地状态机；
8. adaptive 错题可让模型提出 tentative misconception；
9. 本地更新 ReviewItem 并追加 ReviewEvent；
10. state changes 存入 GradingResult 快照。

主要实现位于 [grading.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/grading.ts:148)、[misconceptions.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/misconceptions.ts:92)、[review.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/review.ts:37)。

这是一个真实闭环。模型不能直接：

- 修改 mastery；
- 关闭 mistake；
- confirm/resolve misconception；
- 调整 review；
- 删除学习历史。

### 已形成闭环

- answer → grading → mistake/mastery/review；
- remediation → 精确解决 source mistake；
- proposed misconception → check → confirmed/rejected/resolved；
- due review → review assessment；
- graph prerequisite → weak prerequisite queue；
- graph/state 确实被 Planner 和 Tutor 读取。

### 表面存在但未形成完整闭环

- Plan 的 `strategy`、`steps`、`weaknessHypothesis` 主要用于展示；launch 实际只根据是否有 open mistakes 决定 remediation 或普通 quiz，[planner.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/planner.ts:185)。
- Tutor 最终只输出 plan 和 assessment mode；没有解释、worked example 或对话式教学。
- Tutor 推荐的 assessment 没有 `tutorRunId`、`planId`、strategy、diagnosis lineage。
- Tutor plan 的 difficulty/questionTypes 不控制推荐 assessment；workspace assessment 最终固定 `medium`，[assessment.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/assessment.ts:438)。
- `expectedReasoningSteps`、`learningObjective` 等 blueprint 字段大量生成并保存，但很少参与后续诊断或策略。
- Grading 的“继续学习下一个概念”只是文字，不存在确定性的 next-concept selector。
- 所有当前活动最终仍然归结为 Quiz/Assessment；没有真正的 explanation、worked example、guided practice 等教学活动。

---

# B. Confirmed Problems

## P0

| 问题 | 用户影响 | 根因 | 修复层级 |
|---|---|---|---|
| Tutor 推荐了当前状态下不可执行的 activity | 用户完成 Tutor 规划，看到“开始推荐活动”，点击后 422，完整学习流程中断 | `AssessmentMode` 的合法枚举值被误当成当前 workspace 中可执行的活动；Tutor 不验证 mode-specific prerequisite | 后端 domain/service：Activity capability + policy + discriminated launch spec；详见 C |

## P1

| 问题 | 用户影响 | 根因与证据 | 修复层级 |
|---|---|---|---|
| Concept recall 和教学内容上限过低 | 真实课程被压缩为少数大概念，解释薄、关联稀疏 | 全文一次抽取；Prompt 要求 3–8 个；Concept 只有单 evidence，见 [prompts.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/prompts.ts:69)、[material.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/material.ts:156) | Course Map Engine，而非只调大数量 |
| Plan/Tutor/Activity 没有执行与结果因果链 | 系统不能判断哪个策略执行过、是否有效、是否需要换策略 | Quiz/Submission 不保存 plan、Tutor、queue、diagnosis、strategy origin | 新增 LearningActivity + outcome lineage |
| 缺少 coverage-aware 课程推进 | 首轮测过一部分概念后，其余未评估内容可能永远不进入队列 | diagnostic 固定取 canonical groups 前 6 个；queue 没有 `unassessed_next`，[assessment.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/assessment.ts:154)、[queue.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/queue.ts:47) | Progression policy，结合 map coverage 和 learner goal |
| 文档删除/重解析后 pending assessment 仍可提交 | 用户可提交已经引用不存在概念的旧测验，并得到“全部达标” | workspace quiz 只 FK workspace；concept/doc 引用嵌在 JSON；删除时未 invalidated；grading 对 missing concept `continue`，[workspaces.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/repositories/workspaces.ts:145)、[grading.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/grading.ts:155) | Activity lifecycle + source revision dependencies |
| Grading side effects 非完整单事务且缺乏幂等 | 中途 DB 故障可能留下 submission/result/state 部分写入；重复提交可重复改变 mastery/review | Provider 调用虽全部在写入前完成，但随后多次 repository write 没有一个外层事务，[grading.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/grading.ts:328) | Unit of Work + idempotency key |
| 长文档上下文构造不可扩展 | latency、context overflow、边缘内容召回下降 | analysis/graph/quiz 等直接拼大量 blocks；单文档可达 100k 字符，workspace 无严格文档数上限 | section batching + context budget + synthesis |
| Remediation all-or-nothing | 少一种题型或一题 grounding 被拒即整轮失败 | 每个 target 必须同时有 single-choice 和 short-answer；没有针对 missing pair 的局部补生，[remediation.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/remediation.ts:95) | bounded targeted retry，保留 fail-closed grounding |
| 真实 Tutor plan 容易因 evidence 验证失败 | 规划阶段直接失败，需要整轮重试 | Tutor 最终计划每个 target 都需有效引文，但 schema repair 后没有 grounding-specific repair | 工具上下文改善 + 针对无效 target/evidence 的 bounded repair |

## P2

| 问题 | 影响 | 证据/建议 |
|---|---|---|
| Mastery 只有单 scalar EMA | 无法区分会识别、会解释、会应用、会迁移；unknown 被隐含成 0.5 | 初值 0.5、alpha 0.3，[mastery.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/mastery.ts:19)。先增加 evidence dimensions，不急于上复杂 BKT/IRT |
| `attempts` 实际按题数而非独立学习事件 | 三道同次测验可被视为“三次 activity” | 需要区分 question evidence、attempt、session |
| Graph 数量合同不一致 | provider 最大 60、service 接受 120；schema 至少一条边与 Prompt“无证据可为空”存在张力 | 统一预算与空图语义，不必更换 graph 技术 |
| 前端存在局部 stale plan 竞态 | 快速切换概念时，A 的 plan 响应可能绑定到 B | [GraphWorkspaceView.tsx](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/GraphWorkspaceView.tsx:272) 只检查 workspace epoch，没有检查当前 selected concept |
| Tutor 历史和 blueprint 丰富字段生成后很少消费 | 增加 AI/存储成本但不提升下一步学习决策 | 用于后续 diagnosis/lineage，或停止生成无消费者字段 |
| 产品名未完全统一 | UI 顶部仍使用“Hy3 智学诊所” | [App.tsx](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/App.tsx:474)；后续应统一为 Hy3 Study Clinic |

---

# C. Activity Generation Failure

## C1. 已复现的现象

我能够稳定复现一个与用户描述阶段高度一致的失败：

条件：

1. workspace 只有一份文档；
2. 已完成分析和图谱；
3. 没有 open mistake；
4. 没有 confirmed misconception；
5. 启动 Tutor 并让其完成 plan；
6. Tutor 推荐 `cross_document`；
7. 点击“开始推荐活动”。

结果：

```json
{
  "tutorStatus": "completed",
  "activity": {
    "mode": "cross_document",
    "conceptIds": ["con_..."]
  },
  "launch": {
    "status": 422,
    "code": "GROUNDING_FAILED",
    "message": "跨文档评估未能生成任何真正使用多文档证据的题目,请重试。",
    "details": {
      "rejected": []
    }
  }
}
```

这不是随机 LLM 文案，而是后端固定 guard。

## C2. 完整调用链

1. Fake Tutor 在没有 mistake/misconception 时默认选择 `cross_document`，[FakeProvider.proposeTutorStep](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/fakeProvider.ts:743)。

2. 真实 Hy3 Prompt 也允许在六种 activity mode 中自由选择，但没有告诉模型当前哪些 mode 可执行，也没有提供 document count、due review、alignment/evidence capability matrix，[prompts.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/prompts.ts:535)。

3. `TutorActivity` 只有：

```ts
{
  mode,
  conceptIds
}
```

没有 `misconceptionId`、review item、source revision、aligned document capability 等依赖，[tutor.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/tutor.ts:102)、[payloads.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/provider/payloads.ts:391)。

4. TutorService 只删除未知 concept ID，并在空列表时补当前 concept；不验证 mode 前置条件，然后把 run 标为 completed，[tutor.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/tutor.ts:289)。

5. 前端把 `cross_document + conceptIds` 原样发给 assessment，[GraphWorkspaceView.tsx](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/GraphWorkspaceView.tsx:585)。

6. AssessmentService 只装载目标 concept 和已接受 canonical sibling 所在的文档证据，[assessment.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/assessment.ts:199)。

7. Cross-document 模式最终要求至少一个 blueprint 的已验证 evidence 来自两份文档；否则返回固定 422，[assessment.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/assessment.ts:427)。

因此即使 workspace 有两份文档，只要目标 concept 没有合法、已接受的跨文档 alignment，也仍不可执行。

## C3. 根因

根因不是“缺少一个前端字段”，而是跨层契约错误：

> Schema 只证明 activity 是一个合法枚举值，没有证明它在当前 learner state、workspace state 和 evidence capability 下可以执行。

Activity eligibility 被错误地交给了模型自由选择，而 model output 又被误认为已完成本地验证。

## C4. 本地真实数据佐证

对当前录制环境 SQLite 做了只读聚合检查：

- workspace 中只有 1 份 PDF；
- 17 页、16,352 字符、277 个 SourceBlock；
- 仅 8 个 concepts；
- 8 个 concept grounding 分布于 6 页；
- 存在一个真实 Hy3 completed Tutor run，其 activity 正是 `cross_document`，目标 concepts 全部来自同一份 PDF；
- 该 run 后没有创建新的 quiz；
- 另外两个真实 Tutor runs 因“目标概念或原文依据不合法”在 plan validation 阶段失败。

数据库本身不能证明用户当时确实点击了按钮，但它与确定性复现的前置状态完全一致，因此这是最强候选。

## C5. 已排除的原因

对本次复现可以排除：

- 前端漏传 `conceptIds`：实际传递正确；
- Tutor JSON 解析失败：run 已 completed，activity schema 合法；
- 未知 concept：Tutor 本地过滤后 concept 存在；
- retrieval context 为空：assessment 已有目标 concept/source blocks；
- 题目被 grounding validator 全量拒绝：`rejected` 是空数组；
- LLM 自己编造“缺失”错误：文案来自 backend 固定 postcondition；
- 单纯 evidence 规则过严：对名为 `cross_document` 的活动，要求真正跨文档是正确的；错误在于不该推荐该 mode。

## C6. 其他可能与用户记忆文案对应的路径

由于没有保留当时视频日志，不能 100% 断言用户记忆的原句就是 cross-document 文案。还发现三个相关路径：

1. Remediation 缑少题型：

   > 康复练习未能为每个未解决概念生成完整的单选题和简答题，请重试。

   任一 target 缺 `single_choice` 或 `short_answer`，包括 grounding rejection 后缺项，都会整轮失败，[remediation.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/remediation.ts:16)。

2. Review 无到期项：

   > 当前没有到期的复习概念。

   Tutor 可推荐 `review`，但 TutorService 不验证 `reviewDue`，[assessment.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/assessment.ts:144)。

3. Misconception contract 不完整：

   `misconception_check` 后端要求具体 `misconceptionId`，但 TutorActivity 无此字段。主前端会自行寻找最早的一条 actionable misconception；找不到则静默降级为 `concept_practice`，[GraphWorkspaceView.tsx](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/GraphWorkspaceView.tsx:594)。

这些不是三个独立偶发 Bug，而是同一个抽象问题的不同表现：activity intent 没有 mode-specific、可执行的领域合同。

## C7. 为什么测试没有发现

- Tutor service 测试只断言 `activity !== null`，没有启动它，[tutor.test.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/tutor.test.ts:79)。
- 前端 AdaptivePanels 测试只验证 callback/loading。
- Assessment 的跨文档成功测试预先建立了合法 alignment。
- `smoke-adaptive` 在 Tutor 前先制造了错误状态，Fake Tutor 通常转向 `concept_practice`；脚本中的“Cross-document activity”注释与实际路径不一致，[smoke-adaptive.mjs](/C:/Users/smallfish/open-source/hy3-study-clinic/scripts/smoke-adaptive.mjs:256)。
- 真实 Hy3 eval 只验证 Tutor first step，没有验证 finalize → launch。
- 所有现有测试仍然通过，因此这是测试覆盖空洞，而不是测试已经能捕获的回归。

## C8. 正确修复层级

不应只在前端遇错后把 mode 改成 `concept_practice`。

建议后端增加：

```text
ActivityCapabilityResolver
+ PedagogicalPolicy
→ discriminated ActivityLaunchSpec
```

最低规则：

- `cross_document`：必须存在至少两份可用文档，并有目标 concept 的合法 canonical alignment/evidence capability；
- `review`：必须绑定具体 due ReviewItem；
- `misconception_check`：必须绑定具体 actionable `misconceptionId`；
- `prerequisite_repair`：必须存在合法 prerequisite；
- 其他情况确定性 fallback 到 diagnostic、source review 或 concept practice。

Model 可以提出教学意图，但：

1. 提供给模型的 allowed modes 应先由本地 capability resolver 缩减；
2. Tutor persist completed 前再次验证；
3. launch 时读取最新状态再次验证；
4. 最好由 `POST /tutor/runs/:runId/activity` 在服务端构造 launch request，前端不再拼接 mode-specific 参数。

完成标准应是：

> 每个被标记为“可开始”的 Tutor activity 都能立即启动；状态变化后则返回明确 `invalidated` 和安全的新建议，而不是生成阶段的 422。

---

# D. Concept / Knowledge Coverage Audit

## D1. 当前 concept extraction 的真实工作方式

当前不是逐 chunk/section 抽取，而是：

```text
material 全部 SourceBlock
→ 一次 provider.extractConcepts
→ 验证每个 proposal 的单个 grounding
→ 保存 Concept[]
```

关键限制：

- Prompt 要求“提炼最重要的 3–8 个概念”；
- provider schema 允许 1–12 个，但 Prompt 的 3–8 是实际主要约束；
- name 较短，summary 也很短；
- 每个 Concept 只有一个 grounding；
- 已有 concepts 时直接返回，不做增量补充；
- 没有 section inventory、candidate merge report、coverage pass 或遗漏检查。

FakeProvider 也硬性最多 8 个，并对 heading 相同的候选做压缩，[fakeProvider.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/fakeProvider.ts:117)。

## D2. Merge/dedup 是否误删了大量概念

真实 provider extraction 路径没有一个复杂的 semantic merge 在大规模删除 concepts：

- AnalysisService 会逐个接受通过 grounding 的 proposal；
- canonical alignment 不删除原 source concept；
- exact normalization/semantic alignment 主要影响展示身份；
- graph generation 只能连接已有 concepts，不能补建缺失概念。

因此“内容少”的首要原因不是 merge 误删，而是 candidates 一开始就被 Prompt 和模型合同限制得很少。

FakeProvider 的 heading 去重会让同一标题下后续段落更容易消失，但它主要影响离线 demo，不是实际 Hy3 低 recall 的唯一原因。

## D3. 当前知识表示是什么

准确分类是：

> per-document flat concept list  
> + optional canonical equivalence layer  
> + post-hoc typed relation graph  
> + learner-state overlay

它不是课程知识地图。

当前 Concept 只有：

- `name`
- `summary`
- `importance`
- 一个 `grounding`

见 [material.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/material.ts:156)。

Graph 只有六类关系：

- prerequisite；
- part_of；
- contrasts_with；
- causes；
- applies_to；
- example_of。

Graph Prompt 禁止创造新概念且强调“宁缺毋滥”，[prompts.ts](/C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/prompts.ts:234)。因此 extraction 漏掉的公式、方法、子概念、限定条件、反例，图谱阶段永远无法恢复。

## D4. 信息量在哪里被压缩

| 阶段 | 当前限制 | 产品后果 |
|---|---|---|
| Ingestion | 10 MiB、100k chars、2000 blocks；无 OCR | 图片型讲义无法进入；长材料只能整体受限 |
| Concept extraction | 全文一次调用，Prompt 3–8 | 最强的 recall ceiling |
| Concept schema | 单层、单 grounding、短 summary | 无法表示章节、子概念、多证据、公式或方法 |
| Graph | 只能连接已有 concepts | 无法补回遗漏内容 |
| Graph policy | 每条关系必须逐字 evidence | 合理但会压制隐含 prerequisite/教学联系 |
| Tutor retrieval | 每次最多 8 blocks、短 excerpt、有限工具预算 | 对局部 Tutor 尚可，但无法替代课程级 map 建设 |
| Plan | 目标概念和证据较少 | 计划只能围绕已有少数节点 |
| Activity | 最终仍是 Quiz | 不能承载深入解释、推导或 worked example |

真实录制数据库中：

- 277 个 block；
- 8 个 concepts；
- concepts 只锚定 8 个 block、6 页。

“8 个引文只覆盖 8 个 block”不能直接等于“语义覆盖率只有 2.9%”，因为一个 concept 可概括多个段落；但它清楚表明系统没有任何机制证明剩余教学内容已被映射，更没有能力显示哪些重要内容遗漏了。

## D5. Source-grounded 是否已变成 source-only

答案是：对当前核心生成能力，基本是。

系统目前混淆了两个不同命题：

1. 课程事实、考试范围、评分依据必须来自资料；
2. 教学解释、类比、前置知识、例子也必须能逐字回到资料。

第一个是应该保留的可靠性原则；第二个造成了教学内容薄。

当前没有一个合法 schema 可以表达：

> 这是 AI 为帮助理解而提供的解释，它没有声称是老师原文，但它被限制在已确认的课程概念范围内。

因此模型只能：

- 重述原文；
- 用有限的 source summary 生成题；
- 不敢展开资料中一句带过但教学上重要的内容。

## D6. 为什么真实体验会“内容很薄”

不是单一原因，而是四个瓶颈相乘：

1. Recall ceiling：全文只取 3–8 个概念。
2. Representation ceiling：Concept 既承担课程结构又承担学习目标，粒度无法分层。
3. Provenance ceiling：所有内容只能是 course-source，没有 AI teaching 的合法位置。
4. Activity ceiling：计划最终落成题目，而不是实际教学。

所以只把 `8 concepts` 改成 `30 concepts` 会产生更多扁平标签和更拥挤的图，而不会自动产生课程知识地图。

## D7. Document Coverage 应如何定义

建议先构造独立于已生成 concepts 的 `CoverageUnit` 分母：

- definition；
- formula/theorem；
- method/procedure；
- condition/boundary；
- worked-example teaching point；
- misconception warning；
- chapter learning objective；
- important comparison/application。

每个 unit 必须锚定 SourceBlock，并有：

- section；
- importance；
- parser/extraction confidence；
- mapped node IDs；
- `covered | partial | uncovered | uncertain`。

覆盖率由本地计算，例如：

```text
Σ(unit weight × mapping credit)
──────────────────────────────
Σ(eligible unit weight)
```

同时必须展示：

- critical uncovered units；
- section-level coverage；
- evidence coverage；
- parser warnings；
- uncertain/partial 数量。

不能只展示一个漂亮百分比，更不能把 concept count 当 coverage。

---

# E. Evaluation of the Proposed Upgrade

为遵守产品身份，建议不要把这次升级对外称为“V2”或新产品，而是继续叫 Hy3 Study Clinic。

| 提议 | 结论 | 评价 |
|---|---|---|
| source-grounded ≠ source-only | 保留 | 是解决内容薄的最高收益原则；课程事实与评分 strict，教学解释允许受范围约束的 AI enrichment |
| 三层知识模型 | 修改后保留 | 现在实施 Course Ground Truth + AI Teaching Enrichment；External Enrichment 延后。不要建设三套平行知识库 |
| knowledge map | 保留 | 应是“课程结构树 + 知识关系图 + teaching artifacts + learner overlay”，不是所有东西都塞入同质 graph node |
| Document Coverage | 保留 | 分母必须来自独立的 teaching-unit inventory，报告 critical gaps 和不确定性 |
| Enhanced Tutor 默认 | 保留 | 默认用于解释、例子、推导、误区和前置补课；每段明确 provenance |
| Strict Source Mode | 修改 | 不建议 workspace 全局双模式；改为 operation-level grounding policy |
| policy-driven activity | 强烈保留 | 本地选择 strategy 和合法 activity；Hy3 生成具体教学内容 |
| adaptive learning loop | 保留 | 当前已有可信状态基础；需补 activity lineage、diagnosis 和再规划 |

## 双模式的最终建议

Provenance 不能完全替代 policy：只在生成后标一个“AI”标签，无法在生成前阻止模型越界。

但全局 mode switch 也不理想，它会：

- 分裂缓存和 plan；
- 让同一 workspace 产生两套难以解释的状态；
- 增加用户每次操作前的选择负担；
- 容易演化成两套 provider/service/schema。

建议两层控制：

### 生成前：operation-level policy

```ts
GroundingPolicy =
  | 'source_only'
  | 'source_bounded_enrichment'
```

默认矩阵：

- 考试范围、原文问答、课程定义、required rubric、source-only quiz：`source_only`
- 解释、前置知识、类比、推导、worked example、误区对照：`source_bounded_enrichment`

用户可以在当前教学会话中选择“只看课程资料”，但不需要整个 workspace 永久切模式。

### 生成后：segment-level provenance

```ts
origin =
  | 'course_source'
  | 'ai_teaching'
  // future: external_source
```

冲突规则：

1. 老师/课程特定的定义、符号、范围和方法以 Course Ground Truth 为准；
2. AI enrichment 与其冲突时标记 `conflicted`，禁止进入 required rubric 或 mastery evidence；
3. 尝试局部再生成；
4. 仍失败则只展示课程原文/summary；
5. 多份课程资料互相冲突时不能静默选一份，应显示 source-source conflict。

这能保留“可靠 AI 应用”的特色，同时真正允许模型教学。

---

# F. Missing Product Requirements

除了用户已经提出的方向，还缺少以下真正影响长期使用的要求。

## 1. 轻量 Learning Goal

“下一步学什么”取决于用户目的：

- 准备考试；
- 学完某章节；
- 补一个薄弱主题；
- 快速复习；
- 深入理解。

只需保存目标章节、目标类型、可选截止时间和 source policy，不需要复杂日历/dashboard。

## 2. Unknown 与 Low Mastery 必须分开

未测过不能等同于 mastery 0.5。需要明确：

- `unassessed`
- `insufficient_evidence`
- `weak`
- `developing`
- `stable`

并保存 evidence count/confidence。

## 3. 掌握度需要最小维度

不必马上引入复杂 psychometric 模型，但至少区分：

- recognition/recall；
- explanation；
- application；
- transfer。

否则“会背定义但不会做题”和“完全陌生”会进入同一策略。

## 4. Coverage-aware progression

当前 queue 主要做补救与复习，缺少“课程剩余内容推进”。

需要确定性 progression：

```text
goal scope
+ map coverage
+ prerequisite readiness
+ learner evidence
→ next unassessed/ready knowledge node
```

## 5. 教学活动和掌握更新分离

- 阅读解释、点击完成：只能记录 engagement/progress；
- quick check/practice：提供 learner evidence；
- 只有有效 graded evidence 才能更新 mastery。

否则系统会把“看过”误当成“会了”。

## 6. 有边界的追问

真正的 Tutor 至少需要：

- 换一种解释；
- 给一个例子；
- 为什么；
- 这一步怎么来的；
- 检查我的理解。

追问应绑定 workspace、map version、node 和当前 activity，不应变成 generic document chat。

## 7. Document revision 与状态迁移

重解析、小幅文档更新、OCR 改进不应自动销毁长期学习状态。

需要：

- revision snapshot；
- old → new node reconciliation；
- 明确 unchanged/equivalent/ambiguous/removed；
- 只有稳定映射才继承 mastery；
- 歧义项等待确认；
- completed history 永久保留；
- pending activity 自动 invalidated。

## 8. 失败恢复与部分成功

- section extraction 可以部分成功并显示 uncovered；
- enrichment 失败时保留旧 artifact；
- 单个 teaching artifact 失败不应重跑整个 Tutor；
- activity generation 失败不能改变 learner state；
- grounding 不应放松，但可以针对缺失项 bounded retry。

## 9. 可解释的下一步

不要只显示模型自由 rationale，应显示本地 reason code，例如：

> 最近两次应用题低分；前置概念 X 尚未评估；因此先做 guided example。

这既提高信任，也便于评测策略是否正确。

---

# G. Recommended Target Architecture

## G1. 目标结构

```text
Source & Revision Layer
  ↓
Course Map Engine
  ├─ structure inventory
  ├─ section extraction
  ├─ cross-section synthesis/dedup
  ├─ relation proposal
  └─ coverage audit
  ↓
Versioned Course Knowledge Map
  ├─ course claims/evidence
  ├─ hierarchy/relations
  ├─ teaching artifacts
  └─ learner overlay
  ↓
Diagnosis Snapshot
  ↓
Deterministic Pedagogical Policy
  ↓
Executable ActivityLaunchSpec
  ↓
Hy3 Activity Content Generation
  ↓
Local schema/provenance/conflict validation
  ↓
LearningActivity
  ↓
graded evidence / engagement
  ↓
Mistake + Mastery + Misconception + Review projection
  ↓
Re-diagnosis and Re-planning
```

## G2. 推荐模块

### 1. Source & Revision Layer

复用现有：

- ingestion；
- SourceBlock；
- PDF page span；
- parser warnings；
- exact grounding。

增加：

- `DocumentRevision`；
- content/parser fingerprint；
- map source snapshot；
- pending activity dependency。

### 2. Course Map Engine

演进现有 AnalysisService，而不是复制一套 concept service：

```text
heading/section inventory
→ section-batched extraction
→ locally grounded candidates
→ cross-section semantic synthesis
→ typed hierarchy/relations
→ coverage audit
→ atomic activation
```

每个 section 可以独立失败和重试；新 map 完整校验后才激活，复用现有 GraphVersion “失败保旧”模式。

### 3. Knowledge Map Repository/Validator

建议的结构：

```ts
KnowledgeMapVersion {
  workspaceId
  sourceSnapshot
  extractionPolicyVersion
  providerModel
  coverageSummary
  status
}

KnowledgeNode {
  type:
    | 'chapter'
    | 'section'
    | 'concept'
    | 'subconcept'
    | 'formula'
    | 'theorem'
    | 'method'
    | 'principle'
  title
  courseSummary
  importance
  parentId
  assessable
  sourceEvidence[]
  stableKey
}

KnowledgeRelation {
  type:
    | 'contains'
    | 'prerequisite'
    | 'part_of'
    | 'contrasts_with'
    | 'causes'
    | 'applies_to'
    | 'derives_from'
  sourceEvidence[]
  validationState
}
```

不要把所有内容都变成同质节点：

- chapter/section 是结构；
- concept/subconcept/formula/method 是可掌握知识；
- explanation、worked example、common misconception 更适合作为 teaching artifact；
- 当前 `MisconceptionRecord` 是某位学习者的假设状态，不能与“课程常见误区”混成同一实体。

现有 CanonicalConcept/member 可作为跨文档 stable identity 的迁移桥，不应删除。

### 4. Teaching Enrichment Service

```ts
TeachingArtifact {
  nodeId
  mapVersionId
  kind:
    | 'detailed_explanation'
    | 'intuition'
    | 'derivation'
    | 'worked_example'
    | 'common_misconception'
    | 'contrast'
    | 'guided_practice'
    | 'transfer_example'
  policy
  segments[]
  basedOnNodeIds[]
  providerModel
  promptVersion
  conflictState
}

ContentSegment {
  text
  origin: 'course_source' | 'ai_teaching'
  sourceEvidence?
}
```

Layer 2 可以有 supporting course anchors，但不能把 anchor 伪装为“整段 AI 解释在课程原文中得到完整蕴含”。

### 5. Diagnosis Service

聚合现有 mastery、mistake、misconception、review，不建立重复状态：

```ts
LearnerEvidenceEvent {
  nodeId
  activityId
  dimension
  score
  confidence
  sourceAttemptId
  gradingMethod
}

LearnerDiagnosisSnapshot {
  dimensionStates
  evidenceCount
  confidence
  openMistakeIds
  misconceptionIds
  dueReview
  prerequisiteGaps
}
```

模型可以提出语义层面的 misconception hypothesis；确认、解决和 mastery mutation 继续由本地状态机负责。

### 6. Pedagogical Policy Engine

输入：

- LearningGoal；
- diagnosis；
- prerequisite map；
- due review；
- map coverage/progression；
- activity history；
- content capabilities。

输出：

```ts
TeachingStrategyDecision {
  strategy
  reasonCode
  targetNodeIds
  successCriteria
  policyVersion
  inputSnapshot
}

ActivityLaunchSpec {
  kind
  targetNodeIds
  misconceptionId?
  reviewItemIds?
  alignedDocumentIds?
  sourcePolicy
  eligibility
  fallbackSpec
}
```

首版策略不宜复杂：

| 学习状态 | 本地策略 |
|---|---|
| unknown / evidence insufficient | diagnostic probe，或 explanation → worked example → simple check |
| prerequisite gap | prerequisite explanation → worked example → guided check |
| 会识别、应用弱 | guided example → scaffolded practice |
| proposed misconception | discriminating check |
| confirmed misconception | contrast/counterexample → discriminating check |
| developing | independent exercise / variation |
| stable but due | retrieval practice |
| stable and not due | synthesis / transfer 或推进下一节点 |

Hy3 不得自行更换 strategy，只负责具体内容生成。

### 7. Activity Content Engine

现有 AssessmentService、Quiz、QuestionBlueprint 应继续作为：

- diagnostic；
- check；
- independent practice；
- retrieval review；

的生成器。

新增非 Quiz 活动：

- detailed explanation；
- worked example；
- guided practice；
- misconception contrast；
- counterexample；
- synthesis/transfer。

### 8. Guided Tutor Session

复用当前 Tutor 的：

- read-only tools；
- lexical retrieval；
- budgets；
- NDJSON timeline；
- persistence；
- cancellation。

但职责调整为：

> 在本地 policy 确定的教学目标和策略下编排内容，并处理绑定当前节点的有限追问。

不是通用聊天，也不允许 Tutor 直接改 learner state。

### 9. Learning Activity 与事件层

```ts
LearningActivity {
  launchSpec
  originPlanId?
  originTutorRunId?
  originQueueItem?
  diagnosisSnapshotId
  mapVersionId
  sourceRevisionIds[]
  status:
    | 'draft'
    | 'ready'
    | 'in_progress'
    | 'completed'
    | 'invalidated'
  outcomeEventIds[]
}
```

这会补上当前最关键的因果链：

```text
为什么推荐
→ 推荐了什么
→ 用户是否执行
→ 产生了什么证据
→ 状态为何改变
→ 下一策略为什么变化
```

## G3. AI 与本地职责

| Hy3 | 本地 deterministic code |
|---|---|
| section-level concept/unit proposal | source revision、scope、IDs、limits |
| semantic merge/relation proposal | grounding、known IDs、dedup、cycle |
| explanation、intuition、derivation、example | provenance 标记和 conflict gate |
| rubric coverage | objective answer 与最终 score |
| tentative misconception proposal | misconception lifecycle |
| policy 已选后生成具体教学内容 | strategy eligibility 和选择 |
| 简洁教学 rationale | mastery、mistake、review mutation |
| 受限追问回答 | activity lifecycle、permissions、budgets |

## G4. Fallback

- Map：section 局部失败标 `partial/uncertain`；旧 active map 继续使用。
- Enrichment：失败保留旧 artifact；无旧版本则退化为 course summary。
- Policy：必须始终能给出合法本地 fallback。
- Activity：单步骤重试，不重跑整个 Tutor。
- Grading：provider 全部完成后才进入一个 DB transaction；支持幂等。
- Source change：pending invalidated，completed history 保留。
- Conflict：AI 内容 quarantine，不参与评分；course source 继续可用。
- Context：section-bounded、显式字符/token budget、有限并发、可取消。

## G5. Evaluation

保留现有 771 项测试和 fake structural eval，新增五类质量评测：

1. Course map：

   - critical-unit recall；
   - weighted coverage；
   - hierarchy/edge precision；
   - duplicate/false-merge rate；
   - uncovered honesty。

2. Enrichment：

   - factual correctness；
   - source-conflict rate；
   - provenance attribution precision；
   - teaching helpfulness；
   - 对“一句带过的重要点”是否能合理展开。

3. Activity policy：

   - learner-state fixtures → expected strategy；
   - recommendation executability 必须 100%；
   - mode-specific eligibility property tests。

4. Closed loop：

   - diagnostic → teaching → check → grade → next policy；
   - 错误原因变化时策略必须变化；
   - 非 graded activity 不得改变 mastery。

5. Reliability：

   - source revision invalidation；
   - repeated submission idempotency；
   - section partial failure；
   - context budget；
   - repair/fallback reachability；
   - 旧有效 map/artifact 保留。

最终还应以少量真实课程讲义做 30–45 分钟 dogfood study，而不是只统计生成了多少节点或题目。

---

# H. Migration Plan

## Phase 0 — 修复 Activity P0 与状态安全

### 修改

- 增加 `ActivityCapabilityResolver`；
- 引入 mode-specific `ActivityLaunchSpec`；
- Tutor persist 前验证 activity；
- Tutor activity 改由服务端 launch；
- cross-document、review、misconception、prerequisite 前置条件本地校验；
- remediation missing pair bounded retry；
- pending workspace assessment 增加 invalidation；
- grading 禁止 `assessedConceptIds=[]` 时返回“全部达标”；
- 增加 submission idempotency 和单事务 persistence。

### 复用

TutorService、AssessmentService、现有六种 mode、grounding validator、现有前端 activity 按钮。

### 风险

会改变 FakeProvider demo 默认行为；需要保留旧 request 的兼容映射。

### 测试

- 单文档、无错题 Tutor → launch；
- 多文档但无 alignment；
- 无 due review；
- 无 misconception；
- source 删除/重解析后提交；
- 重复提交；
- DB 后半段失败；
- switch workspace/cancel/stale response。

### 完成标准

所有 completed Tutor activities 要么立即可启动，要么在持久化前确定性降级；不再把可预知的 capability 错误暴露给用户。

## Phase 1 — Concept Engine / Course Knowledge Map

### 修改

- 新增 DocumentRevision、KnowledgeMapVersion、CoverageUnit、KnowledgeNode、KnowledgeRelation；
- section inventory；
- 分 section 抽取；
- 跨 section synthesis/dedup；
- multi-evidence；
- hierarchy；
- weighted coverage report；
- 投影回现有 Concept/Graph API。

### 复用

SourceBlock、PDF page provenance、verifyGrounding、alignment、graph validator、GraphVersion fail-safe。

### 风险

节点爆炸、跨版本 ID 漂移、错误 semantic merge、context/latency 上升。

### 控制

- section/type budgets；
- stableKey 与 lineage；
- merge 必须可审计；
- bounded concurrency；
- map quality gate；
- 未覆盖内容显式展示。

### 测试

- 人工标注课程 fixture；
- critical unit recall；
- section partial failure；
- multi-evidence；
- false merge；
- migration/legacy data compatibility；
- old UI/quiz projection。

### 完成标准

课程重要内容的映射程度可计算，关键遗漏可见；现有 graph、quiz、grading 继续工作。

## Phase 2 — Teaching Enrichment

### 修改

- TeachingArtifact / ContentSegment；
- operation-level GroundingPolicy；
- segment-level provenance；
- conflict validator；
- source + AI teaching 分层 UI；
- 节点绑定追问。

### 复用

LlmProvider、Zod repair、fake/Hy3 contracts、Tutor tools、SourceEvidencePanel。

### 风险

AI 与课程冲突、来源标签误导、内容冗长。

### 测试

- provenance precision；
- conflict suppression；
- AI 内容不得进入 required rubric；
- prompt injection；
- generation failure 保留旧 artifact；
- strict workflow 不受 enrichment 故障影响。

### 完成标准

每个核心节点可获得适用的详细解释、worked example、误区或联系；所有内容片段来源明确。

## Phase 3 — Adaptive Activity

### 修改

- LearningGoal；
- LearnerEvidenceEvent；
- DiagnosisSnapshot；
- PedagogicalPolicy；
- LearningActivity；
- explanation/worked/guided/counterexample/transfer 活动；
- plan/Tutor/queue → activity → outcome lineage；
- coverage-aware progression。

### 复用

Mastery、Mistake、Misconception、Review、DailyQueue、Assessment、QuestionBlueprint、grading。

### 风险

策略过硬、维度证据稀疏、规则互相竞争。

### 控制

首版策略少而显式；保存 policy version/input snapshot；允许用户表达“我完全不会”“换种解释”，但不允许其直接篡改 mastery。

### 测试

至少覆盖：

- 完全陌生；
- 会定义不会应用；
- prerequisite gap；
- proposed/confirmed misconception；
- due stable；
- stable transfer；
- 剩余未评估课程推进；
- teaching-only activity 不改 mastery。

### 完成标准

不同诊断进入不同教学路径，后续真实结果能够改变下一策略。

## Phase 4 — Evaluation / Regression / Rollout

### 修改

- 真实课程 coverage fixtures；
- enrichment 人工标注集；
- policy golden cases；
- closed-loop eval；
- latency/context/repair/fallback 指标；
- source revision/reconciliation regression；
- 小规模真实学习试用。

### 风险

把 concept 数、题数或生成长度误当学习效果。

### 完成标准

- recommendation executability 100%；
- critical coverage 达到预设阈值；
- provenance/conflict 指标达标；
- 完整 adaptive loop 可回放；
- 所有既有测试保持；
- 旧数据、旧 API 和失败保旧能力通过回归。

Rollout 应按 workspace/map capability 渐进启用，不应建立“旧产品/新产品”品牌开关。

---

# I. Final Recommendation

## 当前项目是“小修即可”吗？

不是。

P0 本身可以局部修复，但要让用户上传真实课程资料后愿意持续使用，必须进行一次结构性领域升级。

这次升级不是重写基础设施，而是在现有可靠骨架上补齐四层：

1. 课程知识结构；
2. AI 教学内容；
3. 学习证据与诊断；
4. 确定性教学策略和活动生命周期。

## 必须保留的设计

- Hy3 Study Clinic 产品身份；
- TypeScript / React / Fastify / Zod / SQLite monorepo；
- SourceBlock 和 VerifiedGrounding；
- exact quote 与 semantic entailment 的诚实区分；
- model proposal / local mutation 边界；
- runtime schema + bounded repair；
- fake/Hy3 同契约；
- objective-local + semantic-rubric grading；
- mistake、mastery、misconception、review 分离；
- graph version 和失败保旧；
- completed attempt history；
- cancellation 和 stale-response protection；
- 现有测试与离线 eval。

## 已经限制真实体验的设计

- 全文一次抽取 3–8 个 Concept；
- Concept 单表同时承担课程结构、学习目标和图谱节点；
- 单 grounding、无层级、无 coverage；
- 把 source-grounded 实现成几乎 source-only；
- Tutor 同时决定策略和 activity mode；
- activity 实际等同于 assessment；
- plan steps 没有执行与结果追踪；
- single scalar mastery；
- 没有 source revision、pending activity lifecycle；
- queue 主要补救/复习，缺少课程推进。

## 对用户学习体验提升最大的三个变化

1. 从 3–8 个扁平概念升级为分 section、可版本化、有诚实 coverage 的课程知识地图。
2. 分离 Course Ground Truth 与 AI Teaching Enrichment，提供深入解释、推导、例子、误区和有边界追问。
3. 用本地 diagnosis/policy 选择可执行的教学策略，Hy3 只生成具体内容，并建立 activity → outcome → replan 因果链。

## 现在不应该做的事情

- 外部网页搜索和 Layer 3；
- 向量数据库或 Neo4j；
- LangChain/复杂 agent swarm；
- generic document chat；
- 微服务或新后端语言；
- 社交、排行榜、积分、无关 dashboard；
- 为追求“知识图谱”而无限增加节点；
- 在证据模型尚未建立前直接上复杂 BKT/IRT；
- 只把 concept 数量从 8 改成 30；
- 用一个 workspace 全局 Strict/Enhanced 开关分裂两套产品。

最终建议可以概括为：

> 先修复可执行性 P0；再把课程内容从“少量概念摘要”升级为“可验证覆盖的课程知识地图”；随后加入来源清晰的 AI 教学增强；最后让本地策略真正驱动教学活动和再规划。

这条路线既保留 Hy3 Study Clinic 已获验证的可靠性特色，也能把它从优秀的 source-grounded assessment demo，升级成用户愿意长期使用的真实学习辅导系统。
