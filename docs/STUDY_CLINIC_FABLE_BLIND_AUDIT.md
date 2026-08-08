# Hy3 Study Clinic — Fable Independent Blind Audit

Date: 2026-08-09.
Scope: full-repository product and architecture review at `main` @ `a6e3a4d`, performed WITHOUT reading `docs/STUDY_CLINIC_V2_AUDIT.md`.
Baseline verified during this audit: `npm run build` clean; 771/771 tests (75 shared / 422 server / 274 web); `eval:fake` 31/31. No product code was modified.

---

# 1. Executive Conclusion

Hy3 Study Clinic is a well-engineered **assessment-and-bookkeeping machine wrapped around an extremely thin course model**. Its deterministic spine — ingestion with exact provenance, quote verification, local grading arithmetic, mistake/mastery/misconception/review state machines, bounded Tutor — is genuinely solid and should not be rebuilt. But three product-level facts dominate the dogfood experience:

1. **The product never teaches.** There is no lesson content anywhere in the data model, API, or UI. The only explanatory text a learner ever sees per concept is one model summary capped at ~200 chars by the prompt (`apps/server/src/llm/prompts.ts:87`), plus ≤500-char edge explanations and question explanations. Every "learning activity" is a quiz. The Tutor produces a *plan about studying*, not *teaching*; its steps literally tell the learner to go re-read the source.
2. **The course model is starved at the root.** Concept extraction is a single one-shot prompt over the whole document asking for "3–8 最重要的概念" (`prompts.ts:82`), schema-capped at 12 (`packages/shared/src/provider/payloads.ts:29`), and permanently frozen after the first run (`apps/server/src/services/analysis.ts:31` returns existing concepts forever). Measured on the user's real dogfood data: a 17-page, 16,352-char, 277-block PDF (「Weknora学习」) became **8 concepts averaging 85-char summaries**; ~97% of source blocks are not anchored by any concept evidence. Everything downstream (graph, quizzes, assessments, mistakes, mastery, review, Tutor) can only operate on those 8 nodes.
3. **The Tutor→activity handoff is broken by design, and I reproduced the user's real failure.** The Tutor validates its final *plan* rigorously but persists its recommended *activity* mode without any launchability check (`apps/server/src/services/tutor.ts:289-295`). The user's real database contains a completed real-Hy3 Tutor run whose persisted activity is `{"mode":"cross_document", ...}` in a **single-document workspace** — structurally impossible to launch (422 `跨文档评估未能生成任何真正使用多文档证据的题目`). A second, fully deterministic launch failure exists in the daily queue (`due_review` tier). Both were reproduced end-to-end in this audit.

My independent recommendation: before the next human dogfood, ship four bounded work packages — (A) an **activity-executability contract** fixing all launch failures; (B) **sectioned, additive concept extraction with a deterministic coverage model**; (C) **per-concept teaching enrichment ("lesson cards") with a two-class provenance model** (`本地已验证原文` vs `AI 补充讲解`); (D) **evaluation infrastructure** for launchability, coverage, and enrichment honesty. Explicitly defer conversational tutoring, curriculum sequencing, and any mastery/scheduler redesign. No clean-slate rewrite is justified by the code.

---

# 2. Current Architecture

Monorepo: `packages/shared` (Zod contracts + pure utilities), `apps/server` (Fastify + better-sqlite3), `apps/web` (React 18 + Vite + @xyflow/react). All learner state lives in SQLite; the browser holds only selection/layout preferences.

**Data flow.** Document upload → `ingestion/` (`documents.ts` shared by material library and workspace endpoint; `pdfLayout.ts` deterministic PDF reconstruction; `segment.ts` paragraph segmentation, ≤2000 blocks, offset invariant `content.slice(start,end)===block.content`) → `analysis.ts` one-shot concept extraction (provider) with `grounding/verify.ts` exact-quote verification → `graph.ts` whole-workspace edge proposal (provider) validated by `graph/validate.ts` (IDs, 6-relation enum, evidence, cycles, 120-edge budget, versioned activation) → learner activities (quizzes/assessments/remediation) → `grading.ts` (objective deterministic; short-answer rubric via provider, score recomputed locally from required coverage) → `persistOutcomes` (mistakes, mastery EMA `m' = m + 0.3(s−m)`) → `misconceptions.ts` (proposed→confirmed→resolved state machine, model proposes only) → `review.ts` + `review/scheduler.ts` (FSRS-lite) → `queue.ts` (5-tier deterministic daily queue) → `tutor.ts` (bounded tool loop → plan via shared `planValidation.ts` + recommended activity).

**Provider boundary.** `llm/provider.ts` defines 10 methods; `FakeProvider` (deterministic, offline) and `Hy3Provider` (OpenAI-compatible chat/completions, one bounded schema-repair attempt, 30s default timeout) share the same Zod-validated payload contracts (`packages/shared/src/provider/payloads.ts`). All prompts are in `llm/prompts.ts` with fenced untrusted-data wrapping (`grounding/wrapSource.ts`).

**Persistence.** 11 numbered migrations in `db/migrate.ts`; repositories in `repositories/*` validate domain objects both directions; multi-row writes are transactional; failed generation never overwrites valid data (graph versions, plans).

**Frontend.** Five modules in `App.tsx`: 资料库 (`ImportView`), 学习图谱 (`GraphWorkspaceView` — graph canvas, document panel, inspector `DetailPanels.tsx`, `TutorPanel`, `DailyQueue`, `AlignmentPanel`), 练习 (`QuizView`/`ResultsView`/`QuizHistoryView`), 错题 (`MistakesView`), 学习进展 (`MasteryView`). Async work uses abort controllers + epoch/take-latest staleness guards throughout.

---

# 3. Real User Flows

1. **Import**: paste/MD/TXT/PDF/DOCX → auto workspace (`material_import` origin) or explicit workspace document. Provenance: blocks with headingPath + PDF page ranges.
2. **Extract**: per-document button 提取概念 (`GraphWorkspaceView.tsx:831`, `ImportView.tsx:192`) → 3–8 concepts, once, forever.
3. **Graph**: generate → validated typed edges over those concepts; network/dependency/weak-path views; concept inspector shows summary (模型提出), learner state, relations, verified quote, plan tab.
4. **Alignment** (multi-doc): local candidate pairs (≤30) → provider proposals → exact-alias auto-accept; semantic merges wait for review.
5. **Assess**: 今日学习 empty state offers diagnostic; queue items launch mode-mapped assessments; concept plan tab generates/launches remediation plans; TutorPanel streams a session then offers 开始推荐活动.
6. **Answer/grade**: quiz UI → submission → deterministic + rubric grading → stateChanges summary (mistakes/mastery/misconceptions/review) → history snapshots (read-only replay).
7. **Remediate**: open mistakes → remediation quiz (exactly 1 single_choice + 1 short_answer per concept, ≤3 concepts); correct answers resolve exactly the linked mistakes.

Flow-level observation: after the first diagnostic, the product's only "next things to do" are more quizzes (queue/plan/tutor all terminate in quiz launches). There is no reading/teaching step anywhere in the loop.

---

# 4. AI / Deterministic Responsibility Boundary

What the model decides (proposals only, all schema-validated, all quote-verified where evidence exists): concept names/summaries/importance/one quote each; question content + rubric drafts; rubric-point coverage judgments; graph edges + explanations + evidence; alignment relations; assessment blueprint+question pairs; misconception hypotheses (may decline); plan content; tutor tool choice and finalize payload (plan + activity mode/conceptIds).

What deterministic code decides: everything persistent. Segmentation/offsets/page provenance; quote verification (`verify.ts` — trim-only normalization, first-occurrence anchoring, single-block reanchor); option/answer arithmetic (`grading/score.ts`); required-coverage score; rubric-contract enforcement (`grading/rubricAlignment.ts`); mistake lifecycle; mastery EMA; misconception transitions (`MISCONCEPTION_TRANSITIONS`); review scheduling; queue composition; graph validation/versioning/pruning; plan validation (`planValidation.ts`); tutor budgets/tool execution/timeline composition; assessment target selection per mode + blueprint scope from **verified** evidence; workspace/document lifecycle.

Two asymmetries stand out:

- **The activity mode is the single model-chosen value that crosses into "will later be executed" territory without deterministic validation.** Plans get `validatePlanProposal`; the activity `mode` gets nothing (`tutor.ts:294`).
- **Generated-but-barely-consumed fields**: blueprint `expectedReasoningSteps` (validated, hidden, then only stored); plan `strategy`/`steps`/`weaknessHypothesis` (displayed but drive nothing — `planner.launch` uses only `difficulty`, `questionTypes`, `targets`); `importance` on concepts (display only). The system generates planning metadata it never acts on.

---

# 5. Confirmed Problems

## P0

- **P0-1: Tutor-recommended activities can be unlaunchable; reproduced and present in real user data.** See §6. Variants: `cross_document` in a 1-doc workspace (GROUNDING_FAILED, guaranteed); `review` with nothing due now (VALIDATION_ERROR `当前没有到期的复习概念`); `misconception_check` whose required `misconceptionId` cannot exist in `TutorActivitySchema` (`packages/shared/src/domain/tutor.ts:104-108`) — server-side 400 guaranteed; the web client papers over it from a **stale client cache** (`GraphWorkspaceView.tsx:594-617`).
- **P0-2: Daily-queue `due_review` tier is deterministically unlaunchable.** `queue.ts:137-152` pushes items due **later today** (`due > now && due <= endOfDay`) with reason 「今天晚些时候到期,可提前完成复习。」; clicking launches `{mode:'review'}` (`GraphWorkspaceView.tsx:568-577`), but `assessment.ts:144-149` accepts only `dueAt <= now` and throws. Reproduced: queue shows the item, launch returns 400. No model involved; pure frontend/backend contract mismatch.

## P1

- **P1-1: Concept budget + one-shot extraction starves the whole product** (§7). 3–8 concepts per document regardless of size; frozen forever after first run; destructive reprocess is the only refresh.
- **P1-2: No teaching content exists as a product concept.** No entity, no API route, no UI surface delivers explanations beyond the ≤200-char summary. The strategy enum (`worked_example`, `contrast`…) names teaching actions the product cannot perform; plan steps are prose instructions pointing back at the source text.
- **P1-3: No coverage model.** The system cannot say what part of a document it captured or missed; unanchored sections are invisible. Users cannot recover missed concepts except by full destructive reprocessing.
- **P1-4: Whole-document single-request pipeline limits scale and depth.** `analyzeConcepts` and `proposeGraphEdges` send ALL workspace blocks in one prompt (`services/graph.ts:86-94`, `services/analysis.ts:33-38`); 2000-block documents would produce giant prompts, 30s timeouts, and shallow output.
- **P1-5: Remediation generation is all-or-nothing.** `remediation.ts:98-116` requires exactly 1 grounded single_choice + 1 grounded short_answer per target; one dropped question fails the whole round (`康复练习未能为每个未解决概念生成完整的…`). Fragile against real providers.

## P2

- **P2-1: Tutor `review` recommendation loses its concept focus at launch** — frontend sends `{mode:'review'}` without conceptIds (`GraphWorkspaceView.tsx:619-625`); server then targets up to 4 arbitrary due concepts, not the tutor's chosen ones.
- **P2-2: Misconception proposals only happen for adaptive quizzes** (`misconceptions.ts:143`); wrong answers in standard/remediation quizzes never generate hypotheses — inconsistent with the mental model that mistakes drive diagnosis.
- **P2-3: `alignRubricToQuestion` + strict quote verification can reject otherwise-good provider output**, surfacing as generic retry errors; no partial-accept path for quizzes below the minimum.
- **P2-4: FakeProvider question round-robin** (`fakeProvider.ts:179`) concentrates questions on concept 0 for 2-concept materials (already noted in project memory) — distorts offline demos.
- **P2-5: Assessment questionCount is derived, not learner-controllable** (`assessment.ts:241-244`); diagnostic size = #targets clamped [3,8] — no way to ask for a longer/shorter session.

## Non-problems (verified healthy)

Grounding verification; grading arithmetic; state machines (misconception/review); transactional graph versioning; snapshot history; cancellation/stale-response discipline; workspace lifecycle (per revised origin semantics); migration hygiene. All confirmed by reading + passing suites.

---

# 6. Activity Failure Investigation

**Symptom (user report):** Tutor planning completed; recommending/starting a learning activity later reported missing content/state and could not generate or execute.

**Strongest real instance found (user's own database, read-only inspection of `apps/server/data/clinic.sqlite`):** workspace 「Weknora学习」 has exactly ONE document; `tutor_runs` contains a completed real-Hy3 run with persisted `activity = {"mode":"cross_document","conceptIds":[3 ids]}`, and `quizzes` contains **no** `cross_document` assessment — i.e. the recommendation was never successfully launched. A second completed run recommended `prerequisite_repair` (launchable).

**Deterministic reproduction (this audit, in-memory app + FakeProvider, script preserved outside the repo):**

1. Create workspace → add ONE markdown document (4 sections) → analyze (4 concepts).
2. `POST /api/workspaces/:id/tutor` → session completes: timeline ends `plan_accepted → session_completed` ("可以开始推荐的学习活动"); persisted activity = `{"mode":"cross_document","conceptIds":[…]}` (FakeProvider recommends `cross_document` whenever there are no open mistakes and no confirmed misconceptions — `fakeProvider.ts:744-749` — i.e. the most common fresh-workspace state).
3. `POST /api/workspaces/:id/assessments {mode, conceptIds}` (exactly what `handleStartTutorActivity` sends) → **HTTP 422 `GROUNDING_FAILED` 「跨文档评估未能生成任何真正使用多文档证据的题目,请重试。」**
4. Queue variant: seed a review item due +6h → `GET /queue` shows `due_review`/「可提前完成复习」 → `POST /assessments {mode:'review'}` → **HTTP 400 「当前没有到期的复习概念。」**
5. Raw `misconception_check` activity (no bridge) → **HTTP 400 「误区判别评估必须指定 misconceptionId。」**

**Exact call chain (cross_document case):**
`TutorPanel.onStartActivity` → `GraphWorkspaceView.handleStartTutorActivity` (`:585`) → `launchAssessment` (`:536`) → `api.createAssessment` → `POST /api/workspaces/:id/assessments` (`routes/workspaces.ts:182`) → `assessment.create` → `selectTargets` passes (conceptIds exist) → provider proposes items → per-item validation computes `scope` from **verified evidence documents** (`assessment.ts:323-330`) → single document ⇒ every blueprint `single_document` ⇒ mode-level check (`assessment.ts:427-436`) throws.

**Root cause (layered):**
1. *Contract gap:* `TutorFinalizeStepSchema.activity` (`payloads.ts:391-400`) admits all six `AssessmentMode` values but carries no `misconceptionId`, and nothing constrains mode by workspace state.
2. *Missing validation layer:* tutor finalize (`tutor.ts:289-295`) filters conceptIds against existing concepts but persists `step.activity.mode` verbatim — the ONLY model output in the system that later drives execution without deterministic validation.
3. *Prompt gap:* `tutorStepMessages` (`prompts.ts:537`) lists all six modes with zero preconditions; the model cannot know `review` requires due-now items, `cross_document` requires ≥2 documents with verified multi-doc evidence, or `misconception_check` requires an id it cannot even express.
4. *Launch-time-only enforcement:* `assessment.selectTargets` + the cross-document postcondition are correct guards, but they run only when the learner clicks, seconds-to-days after the recommendation — with no downgrade path, just an error banner.
5. *Client-side patching in the wrong layer:* the misconception bridge reads a possibly-stale client cache; terminal-status hypotheses yield 「该误区假设已处于终态…」.

**Classification:** domain-contract failure (primary) + prompt underspecification + frontend/backend contract mismatch (queue case). NOT a model failure: the model was given no way to be correct. NOT a schema failure: outputs were schema-valid — schema validity ≠ operational validity.

**Why current tests missed it:** `tutor.test.ts` asserts `run.activity` is persisted and bounded (`:90`, `:364-368`) but never feeds it to `assessment.create`; `assessment.test.ts` never tests `review`-with-nothing-due, workspace-level cross_document failure, or missing misconceptionId; no test exercises queue-item → launch. The two halves are individually tested and jointly broken.

**Correct repair layer:** deterministic server code at *recommendation creation time* (tutor finalize + queue composition), with a shared launchability predicate reused at launch time — plus schema extension (misconceptionId) and prompt precondition surfacing. Not a prompt-only fix; not a frontend fix.

---

# 7. Why Learning Content Feels Thin

Traced through the actual pipeline, thinness is overdetermined — five independent caps multiply:

1. **Extraction budget.** Prompt: 「提炼 3-8 个最重要的概念」, name ≤40 chars, summary ≤200 chars, ONE quote (`prompts.ts:82-88`). Schema hard cap 12 (`payloads.ts:29`). Measured result on real data: 17-page PDF → 8 concepts, avg summary 85 chars. The fake provider mirrors the same cap (`MAX_CONCEPTS = 8`, stride-sampling sections, `fakeProvider.ts:136`).
2. **Permanent freeze.** `analysis.analyze` returns existing concepts unconditionally (`analysis.ts:30-31`). No additive path exists. The only refresh — document reprocess — deliberately destroys extraction-derived learning data.
3. **Flat, single-grain representation.** A `Concept` is {name, summary, importance, one verified quote}. No hierarchy (part_of edges exist but are model-optional and sparse — 2 of 15 in the real graph), no first-class formulas/methods/procedures/examples/conditions, no per-section topics. `concept_comparison` is the only composite cognition the system can express.
4. **Nothing downstream can exceed its inputs.** Graph edges connect the same 8 nodes (real graph: 15 edges, 8 applies_to). Quizzes/blueprints/plans/tutor context all key off `concepts` + their blocks. Compression at the root propagates everywhere.
5. **Grounding philosophy forbids teaching beyond the text.** Every learner-visible claim must carry an exact in-source quote. Prerequisite background, intuition, derivations, worked examples, misconception explanations, and cross-domain connections **do not exist verbatim in the source**, so the current validators would reject them by construction. The system is not "bad at" enrichment — it is architecturally forbidden from storing it. This is the deep reason it loses to a general-purpose assistant as a tutor.

Also verified: the system doesn't know what it missed (no coverage measure — 269 of 277 real blocks are evidence-orphans); plan `strategy` influences nothing downstream; blueprint reasoning steps are write-only; Tutor "teaching" output is a ≤600-char summary + ≤6 one-line steps.

What thinness is NOT: it is not caused by the evidence verifier (which is fine for source-derived claims), not by SQLite, not by the graph UI, and not primarily by token cost.

---

# 8. Independent Product Principles

1. **The source defines the course; the model teaches the course.** Scope, definitions, notation, and assessment grounding stay source-anchored. Teaching (explanation, intuition, examples, misconceptions, connections) may exceed the source when explicitly labeled.
2. **Two provenance classes, never blurred:** `本地已验证原文` (exact-quote verified — existing machinery) and `AI 补充讲解(超出资料)` (model knowledge anchored to a concept, honestly labeled, never quote-faked). A third derived state — 与资料不一致 (conflict) — must always favor the source for assessment purposes.
3. **Anything the system recommends, the system can execute.** Recommendations (tutor activities, queue items) are validated for launchability when created, and degrade deterministically instead of erroring at click time.
4. **Coverage is a first-class, deterministic, visible metric.** The product must know and show which sections it has mapped, and offer additive deepening — never destructive re-extraction.
5. **Additive evolution of learner data.** Existing concept IDs, mistakes, mastery, history stay stable; extraction/enrichment only append or replace their own layer.
6. **The model proposes content; deterministic code owns state, labels, and executability.** Unchanged from today, extended to the new layers.
7. **Every generated field must have a consumer** — or be removed. No more write-only planning metadata.
8. **Bounded generation, bounded context, incremental calls.** Section-scoped prompts instead of whole-document prompts; explicit budgets everywhere, as today.

---

# 9. Independent Proposed Architecture

Four packages, all evolutionary:

**A. Activity-executability contract (reliability).**
New pure module `apps/server/src/services/activityLaunch.ts`:
`assessActivityLaunchable(repos, clock, workspaceId, activity: {mode, conceptIds, misconceptionId?}) → { ok: true } | { ok: false, reason: string, fallback: TutorActivity }`.
Deterministic rules mirroring `assessment.selectTargets` + the cross-document postcondition precondition (≥2 documents in workspace), review due-now check, misconception actionability check; fallback is always `concept_practice` on the first existing concept (launchable whenever concepts exist). Consumers:
- `tutor.ts` finalize: validate the model's activity; on failure persist the fallback and emit a new timeline event kind `activity_adjusted` (「推荐活动不满足当前条件(原因),已调整为…」). A completed Tutor run's activity becomes launchable **by invariant**.
- `tutorStepMessages`: compute the currently-launchable mode list + one-line preconditions per mode and offer ONLY those (plus actionable misconception ids when relevant).
- `TutorActivitySchema` + `TutorFinalizeStepSchema.activity`: add optional `misconceptionId`.
- Queue `due_review` fix: extend `CreateAssessmentRequest` review mode with optional `conceptIds`; when the caller names concepts, accept items due within today (`dueAt <= endOfDay`) — matching what the queue advertises; parameterless review keeps strict due-now. Frontend passes `conceptIds:[item.conceptId]` for queue review items and tutor review activities (also fixing P2-1).

**B. Sectioned, additive extraction + coverage (course model).**
- Deterministic section outline derived from existing `headingPath` data (no new table): top-level heading groups with char spans; small sections merged to ~≥800 chars; oversized split at ~4000 chars.
- `analysis.analyze` v2: chunk blocks by section; call the existing `provider.analyzeConcepts` per chunk (unchanged provider contract) with the same 3–8-per-call budget; merge with `normalizeConceptKey` dedup; global per-document cap ~40. Initial run covers all sections sequentially (cancellable, progress events optional).
- Additive deepening: `POST /api/materials/:id/analyze?section=…` (or body param) extracts ONLY that section and **appends** new concepts (new repo method `addConcepts` — never `replaceConcepts`); duplicates dropped by normalized key. Existing concept IDs never change.
- Coverage: pure function `computeCoverage(blocks, concepts, edges, lessons) → per-section {chars, blockCount, conceptCount, citedCharRatio}` exposed as `GET /api/materials/:id/coverage`; UI badge per document + per-section 「未提取」 rows with a deepen button. No persistence needed (derivable, cheap).

**C. Concept lesson cards (teaching enrichment + provenance).**
- New entity `concept_lessons` (migration 12): one row per concept — `{id, conceptId FK, workspaceId, content: ConceptLessonContent JSON, sourceAnchors: VerifiedGrounding[] JSON, conflicts: {claim, sourceQuote: VerifiedGrounding}[] JSON, provider, providerModel, promptVersion, createdAt, updatedAt}`.
- `ConceptLessonContentSchema` (shared): `{ explanation (≤2500), intuition? (≤1200), workedExample? (≤2500), commonMisconceptions? (≤1500), connections? (≤1200), prerequisitesExplained? (≤1500) }` — controlled fields, no open-ended chat.
- New provider method 11: `generateConceptLesson(input, opts)`; input = concept + its verified quote + same-section blocks + lexical-retrieval blocks (existing `retrieval/lexical.ts`, bounded ≤8) + graph neighbors (names+relations only). Prompt rules: teach the concept as this course defines it; if outside knowledge is used, it must be marked; wherever the source directly supports a sentence, cite `{blockId, quote}` in `sourceAnchors`; when the course text contradicts common presentation, emit a `conflicts` entry citing the source; source wins for answering course questions.
- Deterministic validation in new `services/lessons.ts`: schema → verify every `sourceAnchor` and every conflict quote with the existing `verifyGrounding` (invalid anchors dropped; a conflict without a verifiable quote is dropped); length/field caps; concept/workspace membership; transactional upsert; failed generation preserves the previous lesson (existing principle).
- API: `GET/POST /api/workspaces/:id/concepts/:conceptId/lesson` (POST generates/regenerates, cancellable). Lessons change no learner state; grading/mistakes/mastery remain source-grounded only.
- UI: new inspector tab 讲解 in `DetailPanels.tsx` — provenance pills per field (`AI 补充` default; anchored sentences listed under 原文依据 with the existing `SourceEvidencePanel`; conflicts rendered as 「资料与常见表述不一致」 rows quoting the source). FakeProvider implements it deterministically from block sentences (offline demos/tests intact).
- Tutor/plan integration (cheap, high-value): plan steps and queue reasons may reference lesson sections (「先读『工作记忆』的讲解卡,再完成练习」) — a step type stays plain text; no new machinery.

**D. Evaluation infrastructure** — §14.

Explicitly NOT proposed now: conversational tutor, teach→check micro-loops, curriculum sequencing, mastery/scheduler changes, vector retrieval, new node types in the graph (formulas/methods become lesson content, not graph entities — revisit after dogfood), unmerge, multi-document lesson synthesis.

**Answers to the 17 design questions (§3D of the task):** (1) course truth = source blocks + concepts + coverage outline; (2) richer structure via section-scoped extraction over existing headingPath, not a new ontology; (3) long materials via bounded sequential section calls; (4) coverage = deterministic cited-char/section metric; (5–7) AI teaching lives in `concept_lessons` with two provenance classes and verified-quote conflicts, source always wins for grading; (8) launchability contract at recommendation time; (9) model decides content of concepts/lessons/questions/plans + tool choices; (10) deterministic code decides state, validation, labels, launchability, coverage; (11) unchanged: ingestion, grounding, grading, mistakes, mastery, review, alignment, graph validation, history, cancellation; (12) evolved: analysis (sectioned), tutor finalize (validation), queue (launchable tiers), prompts; (13) new data: `concept_lessons` only; (14) overengineering = new graph node types, lesson versioning history, embeddings, agentized tutor; (15–16) see §15/§16; (17) no further adaptive machinery is needed before dogfood — the existing diagnostic→mistake→remediation→review loop is enough to evaluate once activities are reliable and teaching exists.

---

# 10. Proposed Data Model Changes

1. **Migration 12 `concept_lessons`** (only new table):
   `concept_lessons(id TEXT PK, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, concept_id TEXT NOT NULL UNIQUE REFERENCES concepts(id) ON DELETE CASCADE, content TEXT NOT NULL, source_anchors TEXT NOT NULL DEFAULT '[]', conflicts TEXT NOT NULL DEFAULT '[]', provider TEXT NOT NULL, provider_model TEXT, prompt_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`.
   Cascade follows concept deletion (document delete/reprocess already cascades concepts — lessons die with them, correct semantics).
2. **No schema change** for: coverage (derived), sections (derived from `headingPath`), tutor activity misconceptionId (activity is a JSON column in `tutor_runs`; shared-schema change only, old rows parse fine because the field is optional), review-mode conceptIds (request schema only).
3. **Shared schema changes**: `TutorActivitySchema` + finalize payload `activity` + `CreateAssessmentRequestSchema` (+`conceptIds` for review), new `ConceptLessonContentSchema`/`ConceptLessonSchema`, new tutor event kind `activity_adjusted` in `TutorEventKindSchema`, extraction constants (per-call 3–8 kept; new `MAX_CONCEPTS_PER_DOCUMENT = 40`).
4. **Backward compatibility**: all changes additive; existing rows valid unchanged; old tutor runs with now-invalid activities remain as history (launch guard still protects them at click time).

---

# 11. Proposed Service / Provider Changes

| Area | Change |
| --- | --- |
| `services/activityLaunch.ts` (new) | Launchability predicate + deterministic fallback; unit-tested against every mode. |
| `services/tutor.ts` | Finalize: validate/downgrade activity; emit `activity_adjusted`; include launchable-mode list + actionable misconception ids in `buildStepInput`. |
| `services/queue.ts` | Tier 5 items launch with conceptIds; (optionally) annotate items with the launch payload so the client stops re-deriving modes. |
| `services/assessment.ts` | `review` mode: optional conceptIds → due-within-today filter for named concepts; unchanged otherwise. |
| `services/analysis.ts` | Sectioned initial extraction; additive per-section extraction; dedup by `normalizeConceptKey`; global cap; `addConcepts` repo support. |
| `services/lessons.ts` (new) | Generate/validate/persist lesson cards; anchor + conflict verification via `verifyGrounding`; fail-closed preserve-previous. |
| `services/graph.ts` | Input reduction for large workspaces: concepts + evidence-bearing blocks (+ section digests) instead of ALL blocks; behavior unchanged for small docs. |
| `llm/provider.ts` | Add `generateConceptLesson`; extend `TutorStepInput` with `launchableModes` + `actionableMisconceptions`. |
| `llm/prompts.ts` | New `conceptLessonMessages`; tutor prompt lists only launchable modes with preconditions; extraction prompt unchanged per call (chunking happens in the service). |
| `llm/fakeProvider.ts` | Deterministic lesson generation (sentence-derived, with one anchored quote and no fabricated conflicts); tutor policy picks from `launchableModes`. |
| `repositories/` | `materials.addConcepts`; new `lessons` repository; tutor repo unchanged (JSON column). |
| `routes/` | `GET/POST …/concepts/:conceptId/lesson`; `GET /api/materials/:id/coverage`; `analyze` accepts optional section. |

---

# 12. Proposed Frontend Changes

- `DetailPanels.tsx`: 讲解 tab (lesson card) — generate/regenerate with loading/cancel/stale handling (`useAsyncAction` pattern), provenance pills (`AI 补充` / `本地已验证`), conflicts section, anchored quotes via `SourceEvidencePanel`.
- `GraphWorkspaceView.tsx`: document panel per-doc coverage badge + per-section deepen action; pass conceptIds on queue/tutor review launches; render `activity_adjusted` timeline events (icon + wording already patterned in `TutorPanel`).
- `TutorPanel.tsx`: show adjusted-activity note when present; launch button now always corresponds to a launchable activity.
- `ImportView.tsx`: surface coverage after extraction (「已覆盖 6/9 小节」) with link into the workspace view.
- `api.ts`: new endpoints; types from shared.
- No changes to graph geometry/layout/alignment components.

---

# 13. Reliability / Fallback Strategy

- **Recommendation-time validation + deterministic downgrade** (never error at click for tutor-produced activities). Launch-time guards stay as the second line (protect stale/legacy recommendations; state may still drift between finalize and click — the downgrade rule applies at launch too when the frontend receives a structured `fallback` in the error payload; minimal version: keep click-time error but make it rare and self-explaining).
- **Lessons**: generation failure → keep previous lesson, structured error, retry affordance; anchors that fail verification are dropped silently into the unanchored class (never block the lesson); conflicts without verifiable quotes are dropped (never show unverifiable "the source says" claims).
- **Sectioned extraction**: per-section provider failure → that section reported as 未提取 and retryable; never blocks other sections; initial run is sequential and cancellable; partial results persist additively (IDs stable).
- **Remediation strictness (P1-5)**: relax to "at least one grounded question per target, warn on missing type" behind the same validation reporting — small change in `remediation.ts` selection loop; keep the 2-per-target ideal in the prompt.
- Existing fallback rules unchanged: one bounded schema repair; grounding failures are failures; failed generation never overwrites; no learner-state writes from any new path.

---

# 14. Evaluation Strategy

**A. Deterministic automated (tests + eval:fake extensions).** New invariants: every completed tutor run's persisted activity passes `assessActivityLaunchable` (checked in eval:fake by running a full session then launching it); every queue item launches (iterate queue, POST each, expect 201); lesson anchors always verify; lesson writes touch no learner-state tables (diff row counts); coverage sums equal document char counts; additive extraction never mutates existing concept rows (ID/content snapshot compare).

**B. Source-consistency / provenance.** Lesson conflict entries must carry verified quotes (structural check, both providers); UI provenance labels derive only from server-side classes (component tests); real-provider eval: % of lesson sentences with anchors that verify, % of concepts whose anchor block lies in the concept's own section.

**C. Model-based heuristic (real provider only, out of CI).** Extend `eval/run-hy3.mjs` with op 7 "lesson generation" on the existing fixtures (`cognitive-load-zh.md`, `memory-practice-en.md`): schema-first-pass rate, anchor verification rate, conflict honesty on `forces-conflict.md` (fixture already contains contradicting sources — the lesson for its concept should surface a conflict); extraction coverage recall against a NEW hand-authored label file (`eval/labels/coverage-concepts.json`: per-fixture list of must-find concept keys; measure recall with sectioned extraction). Report aggregates only, same sanitized-evidence pipeline.

**D. Human evaluation** = the dogfood protocol: coverage judgment (did it map my document?), teaching usefulness vs a general assistant, activity reliability (zero dead recommendations), honesty spot-checks (labels, conflicts). No fabricated gold labels; the human writes down expected concepts BEFORE extraction and compares.

**Regression:** the entire existing 771-test suite + 31 eval checks must stay green; snapshot-history, grading, and state-machine behavior byte-compatible.

---

# 15. Proposed Implementation Scope Before Dogfood

Ship all four packages, in order: **A (executability) → B (sectioned extraction + coverage) → C (lesson cards) → D (evaluation)**. Rationale: A is a P0 bug family the user already hit on camera; B+C are the substance of the "thin" complaint — dogfooding again without them would re-measure the known verdict; D is how we know A–C hold. Deeper adaptive machinery is NOT required for meaningful dogfood: the existing diagnostic→mistake→remediation→review loop is sufficient adaptivity to evaluate, once its recommendations are reliable and there is actual teaching content to study from. No small adaptive piece is needed earlier, with one exception already inside A: recommendations must reflect current state (that IS the adaptive contract).

Smallest coherent upgrade if time-boxed hard: A + C (reliability + teaching), with B's coverage display reduced to a per-document "sections without concepts" list; but B's additive extraction is what makes C matter for long documents, so I recommend keeping all four.

---

# 16. Work Explicitly Deferred Until After Dogfood

- Conversational/dialogic tutoring (free-form chat with the tutor) and teach→check micro-loops inside a session.
- Curriculum sequencing / auto-generated study paths beyond the existing plan+queue.
- First-class formula/method/example graph node types (lesson fields cover the need for now; promote only if dogfood shows navigation demand).
- Multi-document lesson synthesis (per-concept lessons use one concept's context; canonical-group merged lessons later).
- Mastery model or review-scheduler changes; misconception taxonomy changes.
- Per-field lesson regeneration, lesson history/versioning, lesson export.
- Alignment unmerge; OCR; vector retrieval; assessment-size preferences (P2-5); FakeProvider round-robin fix (P2-4, cosmetic); misconception proposals for non-adaptive quizzes (P2-2 — revisit with dogfood data).

---

# 17. Implementation Phases

**Phase 0 — Executability (package A).** `activityLaunch.ts` + tutor finalize validation/downgrade + `activity_adjusted` event + schema misconceptionId + tutor prompt launchable-modes + review conceptIds semantics + queue/frontend launch payloads. Tests: unit (predicate per mode ×state), service (tutor downgrade paths), route (queue item → launch 201 for every tier), regression. Exit: eval:fake gains "recommendation executability" checks; the §6 repro scripts pass with 201s.

**Phase 1 — Course model (package B).** Section outline util + sectioned initial extraction + additive per-section endpoint + `addConcepts` + coverage endpoint + coverage UI. Tests: chunk determinism, dedup, cap, additive non-destruction, coverage math, UI. Exit: a 277-block document extracts across all sections (cap-bounded) and shows per-section coverage.

**Phase 2 — Teaching (package C).** Shared lesson schemas + migration 12 + lessons repo/service/routes + provider method (fake+hy3+prompt) + 讲解 tab. Tests: validation, anchor/conflict verification, fail-closed preserve, no-learner-state-writes, UI provenance labels, cancellation/stale. Exit: offline demo shows a lesson card with labeled provenance for every concept.

**Phase 3 — Evidence (package D).** eval:fake new checks; `run-hy3.mjs` op 7 + coverage labels; README/ARCHITECTURE/VERIFICATION updates (document the provenance classes and the entailment caveat for lessons explicitly). Exit: eval:fake ≥35 checks green; docs claim nothing unimplemented.

Each phase is a coherent local commit; worktree clean after each.

---

# 18. Concrete Code Change Map

**Modify (server):** `services/tutor.ts`, `services/queue.ts`, `services/assessment.ts`, `services/analysis.ts`, `services/graph.ts` (input bounding), `services/remediation.ts` (P1-5 relaxation), `services/index.ts`, `llm/provider.ts`, `llm/prompts.ts`, `llm/fakeProvider.ts`, `llm/hy3Provider.ts`, `repositories/materials.ts` (addConcepts), `repositories/index.ts`, `routes/workspaces.ts`, `routes/study.ts` (analyze section param, coverage), `db/migrate.ts` (migration 12).
**Create (server):** `services/activityLaunch.ts`, `services/lessons.ts`, `repositories/lessons.ts`, `ingestion/sections.ts` (outline util), tests: `services/activityLaunch.test.ts`, `services/lessons.test.ts`, `services/analysis.test.ts` (extend/new), route tests inside `routes/workspaces.test.ts`, `repos.test.ts` additions, `db/migrateCompat.test.ts` additions.
**Modify (shared):** `domain/tutor.ts` (activity misconceptionId, event kind), `domain/blueprint.ts` (review request conceptIds), `provider/payloads.ts` (finalize activity, lesson payload), `index.ts`; **create** `domain/lesson.ts` + schema tests in `domain/adaptiveSchemas.test.ts`.
**Modify (web):** `views/GraphWorkspaceView.tsx`, `components/DetailPanels.tsx`, `components/TutorPanel.tsx`, `views/ImportView.tsx`, `api.ts`, plus their test files; **create** `components/LessonCard.tsx` (+test) if the tab outgrows DetailPanels.
**Modify (eval/demo):** `eval/run-fake.mjs`, `eval/run-hy3.mjs`, `eval/README.md`; **create** `eval/labels/coverage-concepts.json`, possibly `eval/fixtures/long-sectioned-zh.md`; extend `scripts/smoke-adaptive.mjs` (launch the tutor's recommended activity and assert 201 — this exact assertion would have caught P0-1).
**Docs:** `README.md`, `docs/ARCHITECTURE.md`, `docs/VERIFICATION.md`.
Placement caveat: exact splitting of `LessonCard` vs `DetailPanels`, and whether coverage lives in `routes/study.ts` vs `routes/materials.ts`, are implementation-time decisions.

---

# 19. Migration / Backward Compatibility Plan

- Migration 12 is purely additive (one table, FK cascades). Rollback = drop table; tested in `migrateCompat.test.ts` alongside idempotence.
- Existing concepts/quizzes/mistakes/mastery/misconceptions/review/tutor history untouched; old tutor runs whose activity would fail the new predicate remain stored as-is (history is honest) and are guarded at click time.
- `TutorActivitySchema.misconceptionId` optional → old JSON parses.
- Extraction: existing documents keep their concepts; sectioned extraction only ADDS on demand (per-section deepen); nothing regenerates automatically — no surprise data changes on upgrade. The whole-doc initial path for NEW documents uses sectioned mode from day one.
- Provider contract: new method + extended TutorStepInput — both providers updated in the same commit (parity tests enforce).
- Offline demos/evals remain deterministic (FakeProvider implements everything new deterministically).
- No coexistence/adapter period is required because no model is being replaced; if lesson cards later grow per-field versioning, `concept_lessons` rows migrate forward additively.

---

# 20. Risks and Overengineering Check

| Risk | Mitigation |
| --- | --- |
| Lesson content hallucination presented as course truth | Two-class provenance labels; conflicts must quote the source; assessments remain source-grounded only; dogfood explicitly spot-checks honesty. |
| Sectioned extraction inflates concept count → cluttered graph | Global cap 40; importance ranking; graph/alignment budgets already bound edges; dogfood judges the right ceiling. |
| More provider calls per document (N sections) | Sequential + cancellable; per-call budget unchanged; cost accepted per task statement (quality > token cost); latency bounded by section count cap (~10 calls initial). |
| Review-early semantics change confuses the scheduler | Only explicit-conceptIds launches accept due-today; rating math unchanged; documented. |
| Downgrade hides model quality issues | `activity_adjusted` event makes every substitution visible and auditable. |
| Scope creep toward a tutor-chat rewrite | Explicitly deferred; lesson fields are a closed enum; no free-form dialogue. |
| Over-engineering check | Rejected during this design: new graph node ontology, lesson version history, embeddings/vector store, per-section extraction state table (derived instead), workspace-level syllabus generation, preflight-API for button disabling. Each fails the "does dogfood need it?" test. |

Honest uncertainty: whether 40 concepts is the right cap, whether lesson fields are the right decomposition, and whether coverage-by-cited-chars matches perceived coverage — all three are cheap to adjust and are exactly what dogfood should measure.

# 21. Definition of Done

1. `npm run build`, `npm run lint`, `npm test` green; existing 771 tests unmodified-and-green (except deliberate, documented behavior changes with updated tests); eval:fake extended and green.
2. Deterministic proof, in tests and eval, that: every completed Tutor run's activity launches (or was downgraded with a visible event); every daily-queue item launches; the §6 repro scenarios return 201.
3. A 17-page-class PDF extracts across all sections with visible per-section coverage and an additive deepen path; existing documents unaffected until the user deepens them.
4. Every concept can display a lesson card with correct provenance labels; anchors verified; conflicts quoted; failed regeneration preserves the previous card; no learner-state writes.
5. FakeProvider parity for all new provider surface; offline demos (`demo:graph`, `demo:adaptive`) extended to launch a recommended activity successfully.
6. README/ARCHITECTURE/VERIFICATION document the provenance classes, coverage semantics, launchability contract, and their limitations truthfully.
7. Worktree clean; focused commits per phase; no Git history rewrites.

---
*Frozen upon completion of Stage A. Not edited after reading the Codex audit.*
