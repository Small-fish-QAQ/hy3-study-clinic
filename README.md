# Hy3 智学诊所 · Hy3 Study Clinic

[![CI](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml/badge.svg)](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

> **证据可溯源**的出题、判分与错题康复练习 Web 应用。由 Hy3 提供大模型能力,并内置**离线确定性 Fake Provider**——无需联网、无需 API Key,即可完整体验两条学习闭环。
>
> An **evidence-grounded** quiz / grading / mistake-remediation web app powered by Hy3, with a built-in **offline deterministic fake provider** — both end-to-end study flows run without network access or an API key.

---

## 目录 / Navigation

- [两条核心闭环 / Two core flows](#两条核心闭环--two-core-flows)
- [快速开始(离线 Fake 模式) / Quick start (offline fake mode)](#快速开始离线-fake-模式--quick-start-offline-fake-mode)
- [可复现演示脚本 / Reproducible demo scripts](#可复现演示脚本--reproducible-demo-scripts)
- [架构 / Architecture](#架构--architecture)
- [Hy3 到底负责什么 / What exactly Hy3 does](#hy3-到底负责什么--what-exactly-hy3-does)
- [确定性 vs 模型判断边界 / Deterministic vs model boundary](#确定性-vs-模型判断边界--deterministic-vs-model-boundary)
- [真实 Hy3 配置 / Real Hy3 configuration](#真实-hy3-配置--real-hy3-configuration)
- [安全与隐私 / Security & privacy](#安全与隐私--security--privacy)
- [证据矩阵 / Evidence matrix](#证据矩阵--evidence-matrix)
- [限制与非目标 / Limitations & non-goals](#限制与非目标--limitations--non-goals)
- [CodeBuddy 协作记录 / CodeBuddy participation](#codebuddy-协作记录--codebuddy-participation)
- [参与贡献 / Contributing](#参与贡献--contributing)

---

## 两条核心闭环 / Two core flows

**Flow A(学习准备):**
源材料导入 → 确定性切分为源块 → 概念分析(逐条引文校验)→ 证据可溯源出题 → 交互答题

**Flow B(诊断与康复):**
提交作答 → 判分(客观题确定性判分,简答题按评分要点由模型评分)→ 错题本 → 针对真实薄弱概念生成康复练习 → 确定性掌握度更新 → 答对的康复题**精确解决**其来源错题

核心设计原则:**模型只提出主张,服务器负责验证。** 模型引用原文时只能给出 `(blockId, 逐字引文)`;服务器用精确字符串匹配在原文中定位引文并**自行计算偏移量**,找不到就拒绝——绝不采信模型给出的页码、行号或偏移量,也绝不编造引用。

## 快速开始(离线 Fake 模式) / Quick start (offline fake mode)

要求:Node.js ≥ 20(开发环境验证于 Node 24 / Windows 11,CI 覆盖 Ubuntu + Windows、Node 20 + 24)。**无需 Docker,无需 API Key。**

```bash
npm ci            # 安装依赖(含 better-sqlite3 预编译二进制)
npm run build     # 构建 shared → server → web
npm test          # 158 个测试全部离线运行
npm run dev       # 同时启动后端(8787)与前端(5173)
```

打开 <http://localhost:5173>:

1. **① 导入资料** — 点「载入示例资料」(内置自创中文课程《认知科学入门:记忆与学习》),或粘贴/上传你自己的 `.md` / `.txt`;
2. 点「导入并切分」查看源块预览,再点「分析核心概念」;
3. **② 出题作答** — 选择难度与题型,生成测验,作答时可展开每题的「查看原文依据」;
4. **③ 判分结果** — 查看总分、逐题判定、判分方式标签(确定性/模型)、评分要点命中情况;
5. **④ 错题本 / ⑤ 掌握度** — 生成康复练习,答对后错题自动解决、掌握度上升。

默认即离线模式(`LLM_PROVIDER=fake`):所有"模型"输出都由确定性 Fake Provider 从**你的真实资料**中生成,同样经过服务器端引文校验,全程可复现。

## 可复现演示脚本 / Reproducible demo scripts

两个脚本分别覆盖两种运行方式,输出均为确定性的:

```bash
# 演示 1:进程内离线全流程(无端口、无网络;需先 npm run build)
npm run demo:offline

# 演示 2:通过真实 HTTP 驱动两条闭环(需先在另一个终端 npm run dev:server)
npm run demo:http
```

`demo:offline` 会打印两条闭环的完整过程:导入 → 6 个概念(逐条 ✓ 引文校验)→ 6 题测验(确认客户端载荷不泄露答案)→ 全错提交 → 6 条错题 → 康复练习 → 错题 6 → 0 → 掌握度变化。

## 架构 / Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  apps/web  (React + Vite, 中文优先)                                 │
│  导入/出题/判分/错题本/掌握度 视图 · SourceEvidencePanel 引文高亮      │
│  ── 不持有任何凭证;仅经 /api 代理访问后端 ──                          │
└───────────────▲────────────────────────────────────────────────────┘
                │ JSON(结构化错误 { error: { code, message } })
┌───────────────┴────────────────────────────────────────────────────┐
│  apps/server  (Fastify)                                             │
│  ┌──────────┐ ┌──────────────┐ ┌──────────────────────────────┐     │
│  │ ingestion │ │ grounding    │ │ services                     │     │
│  │ 校验/切分  │ │ 引文验证/包装 │ │ analysis/quiz/grading/       │     │
│  │ 限长/防注入│ │ 偏移量计算    │ │ remediation/mastery          │     │
│  └──────────┘ └──────────────┘ └──────────────┬───────────────┘     │
│  ┌───────────────────────────┐  ┌─────────────▼───────────────┐     │
│  │ SQLite (better-sqlite3)   │  │ LlmProvider 窄接口           │     │
│  │ materials/blocks/concepts │  │ ┌─────────┐  ┌────────────┐ │     │
│  │ quizzes/submissions/      │  │ │ Fake    │  │ Hy3        │ │     │
│  │ mistakes/mastery          │  │ │ 确定性离线│  │ OpenAI 兼容 │ │     │
│  └───────────────────────────┘  │ └─────────┘  └────────────┘ │     │
│                                 └─────────────────────────────┘     │
│  凭证只存在于服务器环境变量;日志脱敏;模型输出全部过 Zod + 引文校验      │
└─────────────────────────────────────────────────────────────────────┘
         packages/shared — Zod 域模型 / Provider 载荷 / 掌握度公式
```

monorepo 布局(npm workspaces):

| 路径 | 职责 |
| --- | --- |
| `packages/shared` | Zod 域模型(Material/SourceBlock/Quiz/Question/Grounding/Submission/GradingResult/MistakeRecord/MasteryState/ApiError)、Provider 载荷 Schema、确定性掌握度公式、自创示例课程 |
| `apps/server` | Fastify 路由与服务、SQLite 迁移与仓储、确定性切分与引文验证、Provider 层(Fake/Hy3)、判分与康复逻辑 |
| `apps/web` | React 交互界面(导入/出题/判分/错题本/掌握度)、证据面板、取消与错误状态 |

## Hy3 到底负责什么 / What exactly Hy3 does

Hy3(或离线 Fake Provider)只承担 **4 个受约束的判断型任务**,每个任务的输出都必须通过 Zod Schema 校验 + 服务器端引文验证才会被采用:

1. **概念分析** `analyzeConcepts` — 从源块中提炼概念(名称/摘要/重要度)并给出 `(blockId, 逐字引文)`;
2. **出题** `generateQuiz` — 按难度/题型配置生成题目,每题必须引用原文;
3. **简答题评分** `gradeShortAnswer` — 按评分要点判断覆盖情况,输出分数、置信度与中文评语;
4. **康复出题** `generateRemediation` — 针对真实薄弱概念(来自错题记录与低掌握度)换角度出巩固题。

结构化输出失败时**最多一次**有界修复:初次请求 → 携带 Zod 校验错误的修复请求 → 仍失败则返回结构化错误 `PROVIDER_INVALID_OUTPUT`(绝无无界重试循环)。

## 确定性 vs 模型判断边界 / Deterministic vs model boundary

| 环节 | 确定性(代码) | 模型判断(Hy3 / Fake) |
| --- | --- | --- |
| 源材料校验、限长、二进制拒绝 | ✅ `ingestion/ingest.ts` | — |
| 切分与源块偏移量 | ✅ `ingestion/segment.ts` | — |
| 概念/题目的**内容** | — | ✅ 提出主张 |
| 引文定位与偏移量计算 | ✅ `grounding/verify.ts`(找不到即拒绝) | ❌ 永不采信 |
| 单选/多选判分 | ✅ 精确集合匹配,无部分给分 | — |
| 简答题评分 | 空答直接 0 分 | ✅ 按评分要点 + 置信度(`gradedBy: "model"`) |
| 总分汇总 | ✅ `grading/score.ts` | — |
| 错题记录(得分 < 0.6) | ✅ | — |
| 康复练习的**目标选择** | ✅ 按未解决错题数 + 低掌握度排序 | — |
| 康复题内容 | — | ✅ |
| 错题解决规则 | ✅ 答对康复题 → 精确解决其 `sourceMistakeIds` | — |
| 掌握度更新 | ✅ `m' = clamp01(m + 0.3 × (score − m))`,初始 0.5 | — |

每条判分记录都带 `gradedBy: "deterministic" | "model"`,模型评分同时暴露 `confidence`,低于 0.6 标记 `needsReview: true`(界面显示"建议人工复核")。

## 真实 Hy3 配置 / Real Hy3 configuration

服务端通过环境变量切换 Provider(前端零改动、零感知):

```bash
cp .env.example .env      # 然后编辑 .env(该文件已被 .gitignore 忽略)
```

```ini
LLM_PROVIDER=hy3
HY3_BASE_URL=   # 你的 OpenAI 兼容端点,例如 https://your-hy3-endpoint.example.com/v1
HY3_API_KEY=    # 只存在于服务器进程;绝不进入前端/日志/错误信息
HY3_MODEL=      # 模型名
HY3_TIMEOUT_MS=30000
```

适配器特性:请求级超时 + 客户端断开取消(AbortSignal 贯通)、安全 JSON 提取、Zod 校验、一次有界修复、结构化错误(`PROVIDER_ERROR` / `PROVIDER_TIMEOUT` / `PROVIDER_INVALID_OUTPUT` / `REQUEST_CANCELLED`)。代码不硬编码任何商业端点。

> 说明:本仓库的自动化验证全部在 fake 模式完成;真实 Hy3 端到端联调尚待有效凭证后进行(见[证据矩阵](#证据矩阵--evidence-matrix))。

## 安全与隐私 / Security & privacy

- **凭证隔离**:API Key 只出现在服务器环境变量与 `Authorization` 头;`/api/config` 只暴露 Provider 名称;日志对 `authorization`/`cookie` 等头部脱敏;错误信息不含密钥、端点、栈或原始响应体。测试断言密钥不会泄漏进错误信息。
- **源材料按不可信输入处理**:大小上限 10 万字、扩展名白名单(`.md`/`.txt`)、NUL/控制字符密度检测拒绝二进制;发给模型时以每次随机的围栏包裹并声明"数据非指令"(prompt-injection 缓解);学生简答同样按不可信文本包裹。
- **前端不渲染 HTML**:源块、引文、题目一律按纯文本渲染(React 转义),测试验证 `<img onerror>` 注入只会显示为文字。
- **引文防伪**:模型引文必须能在原文中逐字找到;块内重复引文锚定第一处并记录出现次数;跨块歧义直接拒绝;绝不生成页码/行号/偏移量类的虚构引用。
- **本地数据**:所有学习数据存于本机 SQLite(`data/`,已被 .gitignore 忽略);仓库不含任何 `.env` 或数据库文件。

## 证据矩阵 / Evidence matrix

| 主张 | 实现 | 自动化验证 | 状态 |
| --- | --- | --- | --- |
| 离线可完整运行两条闭环 | `llm/fakeProvider.ts` | `routes/flows.test.ts`(12 例)、`scripts/demo-offline.mjs` | ✅ 已验证 |
| 切分满足切片不变量 `content.slice(start,end)===block.content` | `ingestion/segment.ts` | `ingestion.test.ts`(含中文/星形字符/整篇示例) | ✅ 已验证 |
| 引文验证:找不到即拒绝、重复安全解析、偏移量服务器计算 | `grounding/verify.ts` | `verify.test.ts`(9 例) | ✅ 已验证 |
| 模型输出全部 Zod 校验 + 一次有界修复后失败 | `llm/hy3Provider.ts` | `hy3Provider.test.ts`(断言恰好 2 次调用) | ✅ 已验证(mock 传输) |
| 超时/取消/HTTP 错误 → 结构化错误 | `llm/hy3Provider.ts`、`util/requestSignal.ts` | `hy3Provider.test.ts`、`realSocket.test.ts`、web 取消测试 | ✅ 已验证 |
| 客观题确定性判分、总分确定性汇总 | `grading/score.ts` | `score.test.ts` | ✅ 已验证 |
| 简答题评分暴露 rubric 命中、置信度、needsReview | `services/grading.ts` | `flows.test.ts`、`App.test.tsx` | ✅ 已验证 |
| 出题载荷不泄露答案/评分要点 | `services/quizzes.ts#toPublicQuiz` | `flows.test.ts`、demo 脚本 | ✅ 已验证 |
| 错题持久化、康复练习源自真实薄弱概念、答对精确解决错题 | `services/remediation.ts` | `flows.test.ts` | ✅ 已验证 |
| 掌握度确定性公式且始终在 [0,1] | `shared/mastery.ts` + SQL CHECK | `mastery.test.ts`、`migrate.test.ts` | ✅ 已验证 |
| 密钥不泄漏(日志/错误/前端) | `config.ts`、`app.ts`、`llm/errors.ts` | `hy3Provider.test.ts`、`app.test.ts` | ✅ 已验证 |
| CI 跨平台复现(Ubuntu/Windows × Node 20/24) | `.github/workflows/ci.yml` | 推送后由 GitHub Actions 执行 | ⏳ 待推送后生效 |
| 真实 Hy3 端点端到端联调 | `llm/hy3Provider.ts` | — | ⏳ 待真实凭证 |
| 界面截图 / 演示 GIF | — | — | ⏳ 待录制(不预先伪造) |

## 限制与非目标 / Limitations & non-goals

**当前限制:**

- 仅支持文本类资料(纯文本 / Markdown 的 ATX 标题结构);Setext 标题(下划线式)不参与分节;
- 简答题评分是模型判断,即使有评分要点与置信度,也可能出错——界面如实标注"模型评分"并对低置信度建议人工复核;
- Fake Provider 的题目是模板化的(用于验证管线与离线演示),题目质量不代表真实 Hy3 效果;
- 单用户、单机、本地数据,无并发控制。

**明确的非目标(刻意不做):**PDF/OCR、用户账号体系、云同步、向量数据库、多租户、本地模型部署、任何训练/微调。

## CodeBuddy 协作记录 / CodeBuddy participation

> **状态:待完成(诚实占位,不虚构记录)。**
>
> 本仓库目前**未使用** CodeBuddy / WorkBuddy。计划中的一次独立 CodeBuddy 任务(对 `apps/web/src/components/SourceEvidencePanel.tsx` 的评审或增强)将在后续单独完成,届时在此处附上真实的任务链接与产出记录。当前的 SourceEvidencePanel 为基线实现,不声称任何 CodeBuddy 参与。

## 参与贡献 / Contributing

```bash
npm ci             # 安装
npm run dev        # 本地开发(server 8787 + web 5173)
npm run lint       # ESLint + Prettier 检查(提交前请先 npm run format)
npm test           # 全部测试(离线)
npm run build      # 全量构建(含类型检查)
```

- 提交信息使用约定式前缀(`feat:` / `fix:` / `docs:` / `chore:`);
- 新功能请附带测试;涉及模型输出的功能必须经过 Schema 校验与(如适用)引文验证;
- 切勿提交 `.env`、数据库文件或任何真实凭证。

## 许可证 / License

[Apache-2.0](./LICENSE)(SPDX: `Apache-2.0`)。示例课程文档《认知科学入门:记忆与学习》为本仓库原创内容,随仓库一同以 Apache-2.0 发布。
