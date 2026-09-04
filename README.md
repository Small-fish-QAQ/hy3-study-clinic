# Hy3 Study Clinic

[![CI](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml/badge.svg)](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**A Course-centred, source-grounded, evidence-gated, learner-governed learning-execution Agent built on Hy3.**

You give it your own course material, choose one global learning depth, and optionally
name topics that deserve extra attention. Hy3 builds the Course Skeleton, teaches the
lessons, writes the practice, grades your answers, diagnoses what went wrong, and
proposes the repair. Deterministic local code decides what any of that is allowed to
change about your learning record - and can always show you which piece of your own
material a claim came from.

> **个人 / 活动作品声明**
>
> 本项目是个人为「腾讯犀牛鸟开源人才培养计划 · 混元大语言模型项目」实战任务开发的
> **个人活动作品**，**不代表腾讯或 Hy3 官方发布**，与腾讯官方产品无关。
>
> This is a personal project created for a Tencent Rhino-Bird open-source activity.
> It is **not** an official Tencent or Hy3 release.

---

## 项目简介（中文）

**Hy3 Study Clinic** 是一个基于 Hy3 构建的**学习执行 Agent**。它面向的不是「再多一个能
答题的聊天机器人」，而是一段**可持续数天到数周、可复核、可追溯**的真实学习过程。

学习者提供自己的课程资料（PDF / DOCX / PPTX / Markdown / HTML / 网页快照 / 源码），选择
四档全局学习深度，并可选填写特别想深入的主题。资料定义课程学什么，全局深度定义整门课程的
教学基线，可选重点决定在哪些资料内主题上投入额外教学资源。Hy3 据此提出课程骨架；学习者可
重命名、在先修约束内调整顺序、修正重点标记，然后只接受一次。系统再派生版本化学习计划
（StudyPlan），逐单元完成讲解、练习、正式测评、诊断与补救，并把「掌握」这件事绑定在
**通过判据门控的正式证据**上，而不是绑定在一次对话或一次做对的题上。

单元讲解在内部仍保留细粒度段落与各自来源，但学习界面会把相邻内容组合成连续讲解；理解检查是
主要停顿点。合适的推演案例会由教师先示范一个有意义的步骤，再让学习者判断下一步；系统按具体
选择给出反馈，答错时最多展开一个小提示和一个仍需作答的脚手架问题，然后继续案例，并用条件变化
后的第二次判断逐步减少支持。全部互动材料在 Lesson 准备时一次生成，点击后的执行与断点恢复由本地
代码确定性完成，不会逐次调用 Hy3，也不产生正式证据或掌握度。当前学习界面与生成契约固定为
`zh-CN` 简体中文，技术英文名词可按语境保留。非正式 Practice 只呈现题目、作答控件与学习者反馈，
不展示供应商、规划器或评估器的内部理由。

其中，**Hy3 承担全部需要语义理解与生成的开放式工作**：概念抽取、课程结构提案、讲解生成、
练习命题、简答语义评分、证据关系判断、错误诊断与补救提案。而**确定性本地代码保留全部权威**：
逐字引用校验、ID 与版本校验、证据覆盖与绑定判定、评分算术、正式证据、进度推进、掌握状态与
复习调度。

这类输出**不存在唯一标准答案** - 同一份资料可以有多种合理的课程切分、多种正确的讲法、多份
可辩护的评分理由。因此本项目在应用之外，另外设计一套面向 Hy3 教育行为的
**开放式质量评估体系**，并将在终稿前完成评估器实现与有效性实验。

- 竞赛方案（完整设计与评估协议）：**[docs/PROJECT_PROPOSAL.md](docs/PROJECT_PROPOSAL.md)**
- 评估方法说明：**[docs/EVALUATION.md](docs/EVALUATION.md)**

---

## Why this problem is hard

A general chat model is already good at explaining one concept on demand. Sustained
study is a different job, and it fails in specific ways:

- **Route drift.** The longer the conversation, the further it drifts from the original
  goal, scope, and pace.
- **Material fact vs. model extension.** A model can helpfully add general knowledge -
  and then present it as though your handout said it.
- **Evidence mis-binding.** A conclusion can be correct while the citation attached to
  it points at the wrong passage.
- **False mastery.** You do well on the familiar phrasing, then fail the same idea in a
  new representation or two weeks later.
- **Unauditable state.** A transcript cannot answer "why does this system believe I have
  learned this, and from which verified evidence?"

Study Clinic is built around the last question. Every consequential belief it holds
about your learning is supposed to be traceable to something you can inspect.

## What Hy3 does, and what it is never allowed to do

Hy3 performs the open-ended semantic work - the parts with no unique correct answer:

| Hy3 proposes | Concretely |
| --- | --- |
| Course structuring | concept extraction; depth- and optional-focus-aware Course Map, LearningUnit and objective proposals; derived StudyPlan and replan proposals |
| Teaching | Teaching-Brief lesson slots; practice items (a separate call, made only after the lesson passes its gates); Tutor moves from a controlled vocabulary |
| Judgement | short-answer semantic grading and rubric-point coverage; blind source-dependency attestation; candidate-evidence relation classification; bounded compositional support groups |
| Diagnosis | misconception hypotheses; targeted Repair proposals; adversarial mastery-challenge candidates |

Deterministic local code owns everything consequential:

| Local code owns | Concretely |
| --- | --- |
| Provenance | exact quotations, offsets, page/section/slide/DOM locations, immutable material revisions |
| Structure | IDs, relation vocabulary, cycles, schema validation, version lineage, fingerprints |
| Evidence | coverage, binding match, mis-binding detection, contradiction, and the final authority verdict |
| Progression | objective answer keys, score arithmetic, criterion-gated Formal Evidence, progression reconciliation |
| Learner state | mastery, mistake lifecycle, FSRS review scheduling, all persistence and permissions |

**Two boundaries worth stating plainly, because they are the point of the design:**

1. **Hy3 never issues the verdict.** For evidence support, Hy3 classifies candidate
   relations and proposes minimal support groups. Local code computes coverage, binding
   match, mis-binding, contradiction, and the pass/fail decision - and **re-derives and
   compares that verdict at every later boundary**, so a model-supplied verdict could not
   survive acceptance even if one were injected.
2. **Hy3 cannot see which evidence is currently bound.** Provider input is byte-identical
   across differing private bindings (proven by regression tests). The model therefore
   cannot rationalise a selection it cannot observe - which is what makes "the conclusion
   is right but bound to the wrong passage" a detectable condition rather than a
   self-confirming one.

## The loop in 30 seconds

```text
materials + global depth + optional focus
                       |
          immutable revisions + exact source blocks
                       |
          proposed Course Skeleton       (Hy3 proposes; local gates validate)
                       |
          learner review and acceptance  (rename / safe reorder / focus toggle, once)
                       |
          derived StudyPlan + Agenda     (validated locally; no second normal-path decision)
                       |
               SessionAgenda            (what to do now)
                       |
        Lesson  ->  Practice  ->  Tutor (teaching; non-credit)
                       |
              Formal Assessment         (the only path to credit)
                       |
        criterion-gated Formal Evidence -> progression reconciliation
                       |
            mastery  /  Repair  /  Review scheduling
```

Everything above the Formal Assessment line is teaching and carries **no credit**:
conversation, informal checks, and "I get it" do not move your record. Everything below
it is deterministic, versioned, and auditable.

## Trust principles

- **Source-grounded, not source-limited.** Your material decides what the course is
  about and which specific facts belong to it. Hy3 may add general explanation, examples
  and analogies - but anything asserted as *your material says so* must resolve to an
  exact verified span.
- **Objectives constrain; the pedagogical arc teaches.** Objectives remain mandatory,
  but Hy3 is asked to organize the whole Lesson around a concrete anchor, a usable mental
  model, genuine worked reasoning, causal explanation, boundaries, misconceptions,
  transfer and a forward bridge—not to recite an objective-by-objective outline. The
  internal Teaching Skeleton still owns obligations, identities and budgets.
- **Worked examples can become worked interactions.** For a suitable planned worked process,
  Hy3 prepares one intermediate learner decision, choice-specific misconception feedback,
  one bounded hint/scaffold level, a debrief, and a changed-condition transfer. Local code
  withholds the continuation until the relevant response, persists each phase for resume,
  and never calls the provider on a normal learner click.
- **Exact quotation proves location, not entailment.** Verifying that a quote occurs at a
  claimed offset is not a proof of complete semantic entailment. The codebase, the UI and
  these docs all keep that distinction.
- **Conversation is not evidence.** Lessons, worked interactions, hints, scaffolds, practice,
  Tutor turns and informal checks
  are explicitly non-credit.
- **A grade is not mastery, and scheduling is not mastery.** Mastery follows
  criterion-gated Formal Evidence plus reconciliation; FSRS review state is tracked
  separately and never presented as mastery.
- **The Knowledge Map is a projection, not the product.** It explains and navigates the
  Course authority chain; it does not own progress.
- **Accepted versions are immutable.** Corrections happen by proposing a learner-accepted
  successor, never by editing history.
- **Teaching focus is not evidence authority.** A focused Unit receives an instructional
  investment signal only; it cannot override global depth, prove source entailment, grant
  Formal credit, or change mastery.
- **Failed generation never overwrites valid data.** Schema, source, authority and route
  violations fail closed.
- **Lesson preparation recovers by failure class.** Local code first applies only
  schema-proven representation defaults, then permits one bounded targeted repair. A
  truncated response is discarded and regenerated from the same immutable slot inventory;
  an alias-only failure can rewrite only the affected learner-text leaves. Source refs,
  slot identities, accepted Lesson checkpoints, Formal authority and learner state stay
  locally controlled.

## Implementation status

Implemented and covered by the automated suite: multi-format ingestion with
revision-owned provenance; concepts and the validated concept graph; the simplified
Materials + Global Depth + Optional Focus creation flow; one explicit, versioned Course
Skeleton review with bounded rename/safe-reorder/focus edits; derived StudyPlan and
SessionAgenda with atomic accepted-route activation; historical Contract/Curriculum/Plan
compatibility;
durable StudySessions with pause/resume/stop and learner-controlled detours; Teaching
Briefs whose teacher-led pedagogical arc and per-segment provenance separate verified
course excerpts from labelled Hy3 teaching; failure-classified, bounded Lesson/Practice
preparation recovery with accepted-Lesson preservation; gated practice generation; a lesson-aware
Tutor over a controlled move vocabulary; Formal Assessment with criterion-gated Evidence
and progression reconciliation; mistakes, misconceptions and targeted Repair; FSRS-6 review scheduling;
the blind candidate-relation / support-group semantic verifier with locally derived
verdicts and deterministic mis-binding repair; and a developer-only adversarial
mastery-challenge workflow.

Not claimed: proof of learning-outcome improvement, OCR, calibrated cognitive
diagnosis, or semantic entailment as a formal guarantee. See
[docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Competition evaluation framework

Because the scenario has **no unique standard answer**, "did it pass the tests" cannot
measure quality. This repository therefore carries a second deliverable: an evaluation
framework for Hy3's educational behaviour, plus planned experiments testing whether that
framework is itself reliable.

Two layers are kept strictly separate:

- **Layer A - runtime safeguards (implemented).** What the product refuses to do:
  schema validation, exact-quote provenance, blind support-group verification, criterion
  gating, version and stale fencing, budgets. This is *state safety*, not teaching
  quality.
- **Layer B - StudyEval (planned evaluator).** A planned offline harness that will score
  **frozen real Hy3 outputs** across seven dimensions with written level anchors: source
  fidelity; evidence-binding correctness; objective and scope fidelity; pedagogical
  soundness and clarity; assessment defensibility; diagnostic specificity and repair
  usefulness; and false-mastery resistance.

The design deliberately reuses the product's own authority pattern: the semantic judge
emits **atomic structured observations, never a score**, and local rules derive the
level. Two of the seven dimensions use no model at all. Two baseline scorers
(length-only and deterministic-only) will be reported alongside, so "the semantic layer
adds signal beyond verbosity" is tested rather than asserted.

Validity will be reported separately from product performance: discrimination (do good /
medium / bad outputs rank correctly), consistency (agreement with human labels, and
stability across repeated runs), and adversarial robustness (can padding, jargon
stacking, fabricated citations, or familiar phrasing buy a high score).

**Runtime model.** StudyEval will separate deterministic work from model work. Corpus
validation, the deterministic dimensions, aggregation from frozen semantic observations,
and the baseline scorers will run **offline with no credentials**. Semantic judging will
use an **explicitly credentialed Hy3 path**; its observations will be frozen into the
corpus, after which every later aggregation and repeat will be offline and reproducible.

Method: **[docs/EVALUATION.md](docs/EVALUATION.md)** · Design and rationale:
**[docs/PROJECT_PROPOSAL.md](docs/PROJECT_PROPOSAL.md)**

> **Status at this commit.** `docs/EVALUATION.md` publishes the full method
> specification - dimensions, level anchors, scorers, sample design and validation
> protocols. The **executable harness, the case corpus, and the result tables are not
> yet built**; they are scheduled for publication before final submission. Nothing in
> this repository currently reports a StudyEval result, and no such result is claimed
> here.

## Quick start

### Requirements

- Node.js 20.9 or newer (`.nvmrc` selects the current Node 20 release; CI also verifies
  Node 24)
- npm
- **No API key and no network access are required.** The application defaults to a
  deterministic offline fake provider.

### Run it

```bash
npm ci
npm run build
npm run dev          # API + web dev servers
```

Open the web app, create a Course, add material under `课程资料`, choose the global depth,
optionally name a material topic to emphasize, review the proposed Course Skeleton once,
and follow the Course Home next action. Use a disposable Course workspace or a backed-up database when
intentionally testing interruption and restart behavior.

### Provider modes

| Mode | How | What it does |
| --- | --- | --- |
| **Fake** (default) | nothing to configure | Deterministic offline provider. Full workflows, no network, no credentials, no cost. This is the normal development and test runtime, not a degraded state. |
| **Hy3** | copy `.env.example` to `.env`, set `LLM_PROVIDER=hy3` plus `HY3_BASE_URL`, `HY3_API_KEY`, `HY3_MODEL` | Real Hy3 over an OpenAI-compatible endpoint. Configure your own endpoint and credentials. |

Real Hy3 outputs are model-generated and may vary between runs; deterministic local
validation and authority boundaries remain unchanged.

Credentials are read from environment variables or a git-ignored local config file. **No
key is ever committed** - `.env` and `**/provider-config.json` are git-ignored, and the
evidence publisher fails closed if a credential, token, or local path would be written to
a tracked file.

**Model-capability paths.** For the competition configuration, the only enabled
model-capability path is **Hy3**. The repository also retains an experimental optional
visual-description adapter; it is **disabled by default**, is forced disabled in the
competition configuration and in all evaluation runs, produces advisory-only output that
can never enter Formal Evidence, grading, mastery or any authority, and is **not part of
the submitted model-call chain**. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
its boundary.

### Main commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build shared code and run the API and web dev servers |
| `npm run build` | Type-check and build every workspace |
| `npm run lint` | ESLint plus the Prettier check |
| `npm test` | Build shared code and run all workspace tests |
| `npm run demo:offline` | Exercise the core flows in process with the fake provider |
| `npm run demo:http` | Exercise the same flows over HTTP against a running server |
| `npm run demo:graph` | Exercise document -> graph -> overlay -> plan -> remediation |
| `npm run demo:adaptive` | Exercise alignment -> assessment -> Tutor -> learner state -> daily queue |
| `npm run eval:fake` | Deterministic offline structural evaluation (no network) |
| `npm run eval:hy3` | Optional real-provider evaluation; explicit credentials mandatory |
| `npm run eval:evidence` | Publish sanitized evidence from a successful real-provider report |

Of the commands above, only `eval:hy3` contacts a real model. Tests and CI never call it.
The future StudyEval commands specified in [docs/EVALUATION.md](docs/EVALUATION.md) are
not implemented and are therefore not listed here.

## Verification

```bash
npm run build && npm run lint && npm test && npm run eval:fake
```

`eval:fake` starts the real server in process against in-memory SQLite and asserts
provenance retention, canonical alignment, blueprint scope isolation, Tutor budgets,
misconception transitions, review scheduling, retrieval bounds, prompt-injection
defences, state invariants, activity executability, grading state safety, course
understanding against hand-authored labels, and lesson provenance.

Full command matrix and evidence rules: **[docs/VERIFICATION.md](docs/VERIFICATION.md)**.

A sanitized real-provider record is at
[docs/evidence/hy3-online-verification.md](docs/evidence/hy3-online-verification.md) -
it names the exact evaluated commit, model, endpoint hostname and aggregate metrics, and
states what it does and does not prove. **That record is historical:** it was generated
from an earlier commit and predates the current Curriculum, Lesson and semantic-support
layers, so it does not exercise them. It will be regenerated at a current commit before
final submission.

## Honest limitations

- Exact-quote verification establishes **location**, not complete semantic entailment.
- The objective-support evaluator is model-assisted and can be wrong; structured
  observations, frozen authority, local construct rules and downstream revalidation make
  it **auditable and fail-closed**, not a formal proof.
- Mastery and review scheduling are transparent local heuristics, **not** calibrated
  cognitive diagnoses. Misconceptions stay hypotheses until graded evidence moves them.
- Lessons may teach beyond your uploaded text; those segments are explicitly labelled as
  AI teaching, are never grading evidence, and their factual quality depends on the
  configured model.
- PDF import needs an embedded text layer - there is no OCR. Complex multi-column
  layouts, rotated text and figure text are not reconstructed.
- The fake evaluation validates structure and safety boundaries, **not** teaching
  quality. Real-provider samples are small and model-dependent - indicative, not a
  benchmark.
- No learning-outcome study has been conducted. This project does not claim measured
  educational effectiveness.

Full register, including observed Hy3 failure modes:
**[docs/LIMITATIONS.md](docs/LIMITATIONS.md)**

## Documentation

| Document | Responsibility |
| --- | --- |
| [docs/PROJECT_PROPOSAL.md](docs/PROJECT_PROPOSAL.md) | Competition proposal: scenario, Hy3's role, evaluation design and plan (Chinese) |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Evaluation method specification: dimensions, level anchors, scorers, sample design, validation protocols. Harness and results are planned, not yet published |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Current architecture, trust boundaries, provider contracts, data model |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | How to reproduce every result claimed here |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Capability boundaries and known failure modes |
| [docs/evidence/](docs/evidence/) | Sanitized real-provider records (currently one historical record) |
| [docs/HISTORY.md](docs/HISTORY.md) | Project history. Historical context only - not current product truth |
| [eval/README.md](eval/README.md) | Evaluation harnesses and their labels, scope and limits |

## License

[Apache-2.0](LICENSE). The built-in Chinese sample course and the evaluation fixtures are
original repository content released under the same license.
