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

`LlmProvider` 是窄接口(4 个方法),两个实现:

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
