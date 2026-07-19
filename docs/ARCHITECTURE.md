# 架构与设计说明 / Architecture & Design Notes

本文档补充 [README](../README.md) 中的架构概览,面向想深入理解或扩展本项目的开发者。

## 1. 请求生命周期(以出题为例)

```
POST /api/quizzes { materialId, config }
  │
  ├─ Zod 校验请求体(QuizConfigSchema)——失败 → 400 VALIDATION_ERROR
  │
  ├─ QuizService.generate
  │    ├─ 取材料与源块;若无概念则先 AnalysisService.analyze
  │    ├─ provider.generateQuiz(wrapSourceBlocks(blocks) 包裹的不可信数据)
  │    │    └─ (Hy3) fetch → 超时/取消 → 安全 JSON 提取 → Zod 校验 → 一次有界修复
  │    ├─ assembleQuestions:逐题 verifyGrounding —— 找不到引文的题目被丢弃
  │    │    └─ 全部被丢弃 → 422 GROUNDING_FAILED
  │    └─ 组装 Quiz(服务器计算偏移量、分配 points)并持久化
  │
  └─ toPublicQuiz —— 剥离 correctOptionIds / expectedAnswer / rubric
       → 201 { quiz }
```

关键点:**模型输出在落库前必须同时通过 Zod Schema 与引文验证两道关卡**;客户端在提交判分前拿不到答案与评分要点,判分后返回完整题目用于结果讲解。

## 2. 引文验证:信任边界

`grounding/verify.ts` 是模型输出与持久化数据之间的信任边界。模型只提供 `(blockId, quote)`:

1. 去除引文首尾空白(唯一的规范化,不做模糊匹配);
2. 在指定源块内用精确字符串搜索定位,**服务器自行计算 UTF-16 偏移量**;
3. 重复处理:
   - 块内重复 → 锚定第一处,记录 `occurrenceCount`(歧义保持可见);
   - 指定块内找不到、但在**恰好一个**其他块中**恰好出现一次** → 安全重锚(`reanchored: true`);
   - 其他情况(跨多块、候选块内重复、完全找不到)→ 拒绝(fail closed)。

绝不采信模型给出的偏移量、页码、行号,也绝不编造引用。

## 3. Provider 抽象

`LlmProvider` 是窄接口(6 个方法:概念分析、出题、简答判分、康复出题、图谱关系提议、康复计划提议),两个实现:

- **FakeProvider** — 纯函数式、确定性、离线。所有引文逐字复制自真实源块,因此必然通过引文验证。选项乱序用内容哈希做种子(可复现)。可选模拟延迟以便观察加载/取消状态。
- **Hy3Provider** — OpenAI 兼容 `chat/completions` 适配器。端点/模型/密钥全部来自服务器环境变量。

有界修复(`Hy3Provider.complete`):初次请求 → 若 JSON 提取或 Zod 校验失败,携带具体错误发起**一次**修复请求 → 仍失败则抛 `PROVIDER_INVALID_OUTPUT`。测试断言此路径恰好触发 2 次网络调用,杜绝无界重试。

## 4. 判分与掌握度

- **客观题**(`grading/score.ts`):单选=键相等;多选=精确集合匹配(不给部分分,便于向学习者解释)。完全确定性。
- **简答题**(`services/grading.ts`):空答直接 0 分(不调用模型);否则走 `provider.gradeShortAnswer`,输出映射为得分/置信度/命中要点。`gradedBy` 标注来源,低置信度置 `needsReview`。
- **总分**:确定性求和 + 归一化(`computeTotals`)。
- **掌握度**(`shared/mastery.ts`):指数移动平均 `m' = clamp01(m + 0.3 × (score − m))`,初始 0.5。数据库层再加 `CHECK (mastery BETWEEN 0 AND 1)` 双保险。

## 5. 康复闭环

`services/remediation.ts` 的目标选择完全确定性:

1. 只选择当前仍有未解决错题的概念,按未解决错题数降序、概念 ID 打破平局;
2. 每轮最多选择 3 个概念;没有未解决错题时直接拒绝生成;
3. 每个概念必须恰好保留 1 道单选题和 1 道简答题,因此每轮共 2–6 题。

生成的每道康复题通过 `sourceMistakeIds` 链接到它所复测的错题。判分时(`grading.ts` 的 `persistOutcomes`),若某道康复题答对,则**精确解决**其 `sourceMistakeIds` 指向的错题——形成"错 → 练 → 解决"的闭环。

## 6. 取消传播

`util/requestSignal.ts` 监听**响应流**的 `close`(而非请求流——请求流在 body 解析后立即关闭,会误取消每个带 body 的请求)。当客户端在响应写完前断开时,`AbortSignal` 触发,贯通到 Provider 的 `fetch`,取消在途模型调用。`routes/realSocket.test.ts` 用真实 socket 回归此问题(`fastify.inject` 无法复现)。

## 7. 数据库

`better-sqlite3`(N-API,Windows/Linux 预编译二进制,覆盖 Node 20/24)。迁移带版本号且可重复执行(`migrate.test.ts` 验证重复运行是幂等的)。仓储层在写入与读回时都做 Zod 校验,确保库中数据始终符合域模型。

升级迁移:v2 增加课程空间(workspaces)与文档元数据列,并为每条旧资料创建同名兼容空间(不删除、不改写任何学习数据;`migrateCompat.test.ts` 用带数据的 v1 库验证);v3 增加图谱版本/边/依据与康复计划表。级联链路是有意设计:概念删除 → 关联边级联删除;源块删除 → 边依据级联删除;空间删除 → 全部级联。

## 8. 课程空间与多文档解析

一个课程空间(workspace)聚合多份文档、概念、版本化图谱与已接受的康复计划;学习状态(作答/错题/掌握度)仍以文档与概念为准,空间只做聚合视图。

文档解析管线(`ingestion/documents.ts`):

1. 上传统一走 base64 JSON(≤10MB 解码后),先校验扩展名,再校验魔数(`%PDF-` / ZIP `PK`),不匹配即 422;
2. PDF 用 `unpdf`(PDF.js serverless 构建)逐页抽取文本,拼接后记录每页在归一化全文中的偏移区间,分段后的块按区间赋 `pageNumber`;无文本页产生可见警告,整份无文本 → `PARSE_FAILED`(绝不落成"空文档");
3. DOCX 用 `mammoth` 只读 `word/document.xml`(忽略宏/脚本/媒体),产出的受限 HTML 由本地确定性转换器变为 Markdown 风格文本 —— 标题变成 `#` 行,交给既有分段器后自然获得 headingPath 溯源;
4. 所有块保持不变量 `content.slice(startOffset, endOffset) === block.content`。

破坏性操作是显式且事务化的:删除文档依赖已验证的 FK 级联,并在同一事务里清理"失去全部依据的边"、给受影响的图谱版本写入可见的 `pruned` 标记、作废整个空间的康复计划;重新解析(reprocess)从存储的原始字节重跑当前解析器,并在同一事务里重置该文档的提取衍生数据(块/概念/测验/错题/掌握度)。UI 在执行前弹出明确的确认文案。

## 9. 概念图谱:生成、校验与版本化

`graph/validate.ts` 是模型输出与持久化图谱之间的信任边界,逐条独立判定候选边(一条无效不牵连其余):

- 两端概念必须存在且属于本空间(跨空间引用单独标注拒因);
- 禁止自环;关系必须取自受控枚举(prerequisite / part_of / contrasts_with / causes / applies_to / example_of);
- 每条依据引文走既有 `verifyGrounding` 精确校验,失败的依据被丢弃,全部失败则拒绝该边;
- 归一化去重 (source, target, relation);`prerequisite` 与 `part_of` 分别做环检测(按候选顺序,闭环边被拒);
- 全局边数预算(120)。

生成生命周期(`services/graph.ts`):每次生成先落一行 `generating` 版本;provider 失败或全部候选被拒 → 版本标记 `failed`(记录校验摘要),**当前激活图谱不受影响**;有边通过 → 在**一个事务**里写边+依据、置 `ready`、切换空间的激活指针、按保留窗口(10)清理旧版本。历史 `ready` 版本可再次激活(同样事务化)。

学习状态叠加(`learnerOverlay`)只读既有 mastery/mistake 行,派生确定性状态:无作答 → `unassessed`;有未解决错题或掌握度 < 0.7 → `weak`;无未解决错题且掌握度 ≥ 0.85 且作答 ≥ 3 次 → `stable`;其余 → `developing`。不引入第二个真相源,不虚构置信度,不做 FSRS。

## 10. 受约束的康复计划

规划输入在本地裁剪:选中概念 + 直接前置(≤5)+ 直接邻居(≤8)+ 相关文档源块 + 相关概念的掌握度行 + 未解决错题(≤10,仅题干)+ 已见题型。模型返回结构化计划(概述 / 薄弱假设 / 受控策略与难度 / 引擎支持的题型 / 1–6 步骤 / 1–4 个带逐字依据的目标)。

本地验收(`services/planner.ts`):目标必须是本空间概念;选中概念或其直接前置必须仍是计划中心;目标依据逐条重新走引文校验;验收失败抛结构化错误且**保留原有已接受计划**;每个 (空间, 概念) 只保留一份已接受计划。接受计划不写任何学习状态 —— 模型不能改掌握度、不能解决错题、不能预写历史。

启动计划:若目标概念仍有未解决错题,按"未解决目标错题最多的文档"(id 平局)复用既有康复引擎,并把目标过滤传入(题目仍与其复测的错题精确关联);否则用计划的难度/题型预配置一次聚焦练习(复用既有出题引擎的 targetConceptIds 通道)。判分、错题解决、掌握度更新全部走原确定性管线。

## 11. 前端:学习图谱工作台

三个协同区域:左侧课程空间与文档(类型/解析状态/页数/警告/概念与图谱操作),中间交互式图谱(`@xyflow/react` 渲染 + 本地确定性最长路径分层布局;节点着色=学习状态,徽标=未解决错题数;图例、空/加载/失败/部分成功状态;节点与边都可选中,并附键盘可达的关系列表),右侧证据与辅导详情(选中概念的原文依据(文档/页码/标题路径)、学习状态、出入关系、计划面板;选中边的关系/解释/依据)。UI 用「模型提出」与「本地已验证」标签区分内容来源,并始终提示:引文校验只证明"出现在原文该处",不等于语义蕴含。

失效响应防护沿用请求纪元(epoch)模式:切换/删除空间、改变选中节点或边、重启规划、离开视图都会推进纪元或取消在途请求,迟到的响应绝不覆盖较新的空间、文档列表、图谱版本、选中项、计划或康复配置。
