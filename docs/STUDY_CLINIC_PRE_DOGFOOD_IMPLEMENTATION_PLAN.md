# Hy3 Study Clinic — Approved Pre-Dogfood Implementation Plan

Date: 2026-08-09

## 0. Authority

This document is the authoritative construction plan for the next implementation round.

Source documents:
- `docs/STUDY_CLINIC_FABLE_SYNTHESIS.md`
- `docs/STUDY_CLINIC_FABLE_BLIND_AUDIT.md`
- `docs/STUDY_CLINIC_V2_AUDIT.md`

Implementation precedence:
1. Repository-local instructions (`AGENTS.md`, `CLAUDE.md`, etc.)
2. THIS document
3. Fable synthesis
4. Blind/Codex audits as rationale

Do not overwrite the audit reports. Do not create a parallel “V2” product.

Approved construction order:
**Phase 0 → Phase 1 → Phase 2 → Phase 4 → STOP → human dogfood**

The numeric slot **Phase 3 remains reserved for the deeper adaptive-learning layer** that may or may not be implemented after dogfood.

Core principle:
> The source defines the course; the model teaches the course.

Course-specific truth, definitions, notation, scope, rubrics and assessment evidence remain source-grounded. AI may provide bounded teaching explanations around source-confirmed concepts, but AI teaching must be clearly labeled and must never silently become grading truth.

---

# 1. Human-review amendments that override the synthesis

## A. Preserve phase numbering

Do not rename evaluation to Phase 3.

- Phase 0: reliability / activity executability / state safety
- Phase 1: course understanding / extraction / mapping / progression
- Phase 2: teaching enrichment
- Phase 3: RESERVED and DEFERRED adaptive-learning layer
- Phase 4: evaluation / regression / documentation / dogfood preparation

## B. Remediation uses targeted bounded retry, NOT contract relaxation

Do not weaken the existing requirement that each remediation target should receive the required grounded question pair.

Instead:
1. keep already-valid questions;
2. identify the exact missing/invalid required type;
3. retry only missing pieces;
4. use a strict small retry bound;
5. rerun grounding/business validation;
6. never weaken quote/evidence requirements;
7. if still incomplete, fail honestly with structured details.

Increase success through repair, not by lowering the learning contract.

## C. Idempotency must be race-safe below the route layer

A route-level “already graded → 409” preflight is useful but cannot be the only guard.

Guarantee that the same logical submission can apply learner-state side effects at most once even under concurrent requests/retries.

Use the most natural current-schema solution:
- DB uniqueness,
- transaction-local recheck,
- insert-once semantics,
- or equivalent repository/unit-of-work protection.

Friendly route checks may remain, but the final invariant must survive races.

## D. Section extraction must handle weak/missing headings

Use `headingPath` when it is useful.

If headings are absent, degenerate, or too coarse, create deterministic synthetic sections / bounded block windows based on SourceBlocks and character/context budgets.

Requirements:
- deterministic for unchanged source content;
- bounded;
- no embeddings/vector DB;
- preserve SourceBlock provenance;
- must not fall back to the old whole-document one-shot bottleneck.

## E. Do not force 3–8 concepts per section

Section-level extraction uses a size/information-aware budget.

A small section may legitimately produce 0–2 concepts.

Do not create near-duplicate concepts merely to satisfy a minimum.

The document-level `~40` cap is a tunable safety ceiling, not a target or KPI.

## F. Coverage UI must be honest about what it measures

First-round metrics are structural mapping / evidence anchoring, not proof of semantic course coverage.

Prefer user-facing wording such as:
- 资料映射情况
- 已提取 / 未提取小节
- 已映射概念数
- 引用锚点覆盖
- 需要继续提取

Do not show a vanity “课程覆盖率 83%” number without narrowly defining it.

Semantic recall belongs in eval using hand-authored must-find concept labels.

## G. Teaching provenance wording

Do not label ordinary AI teaching as simply “AI 补充，超出资料范围”.

Preferred semantics:
- **课程资料 / 本地已验证**
- **AI 辅助讲解（非资料原文）**

Explain in UI help text:
> AI teaching may use the model’s existing knowledge to explain a concept confirmed by the course material. It is not treated as uploaded source text or grading evidence.

Actual beyond-course extension, if ever allowed, is a separate concern and should not be conflated with normal AI teaching.

---

# 2. Cross-cutting invariants

1. Extend the existing product; do not build a duplicate concept/graph/tutor/state architecture.
2. Model proposes semantic content; deterministic code owns persistent state and safety.
3. Anything surfaced as startable must be executable when created and revalidated at launch.
4. Grounding remains fail-closed.
5. Generation failure never destroys valid prior content/state.
6. Existing concept IDs remain stable during additive deepening.
7. AI teaching never becomes grading/rubric/mastery authority implicitly.
8. Every generated field needs a real consumer.
9. Expensive generation is bounded and cancellable where practical.
10. FakeProvider and Hy3Provider maintain domain-contract parity.
11. Existing user data and completed history remain valid.
12. Do NOT implement full adaptive Phase 3 in this round.

---

# 3. Phase 0 — Activity executability and state safety

## Goal

Fix the real launch failures and state-integrity problems before expanding learning content.

## Activity capability / launch contract

Introduce a server-side shared resolver, likely near `apps/server/src/services/activityLaunch.ts`, consistent with repository conventions.

It must determine current executability for:

### `cross_document`
Require genuine multi-document capability for the target:
- enough applicable documents;
- accepted alignment/sibling/evidence capability where required;
- realistic ability to construct verified evidence from multiple documents.

Two files existing is not enough.

### `review`
Bind to concrete eligible review targets.

Fix the queue mismatch:
- queue items advertised as reviewable later today must actually launch under the same named-target semantics;
- generic unnamed review may keep stricter due-now semantics.

### `misconception_check`
Bind to a current actionable misconception identity.
Delete the frontend stale-cache bridge as a business-rule mechanism.

### `prerequisite_repair`
Require real current prerequisite target/gap under existing graph semantics.

### Fallback
Use the smallest existing safe deterministic fallback chain, e.g.
`concept_practice(valid selected concept)` → `diagnostic`.

Do not invent a large activity taxonomy.

## Validate twice

### Tutor finalize
- compute currently launchable modes;
- expose only those modes to the model where practical;
- validate model intent locally;
- downgrade invalid recommendations deterministically;
- persist an auditable `activity_adjusted` event with original mode + reason.

Invariant:
> every newly completed Tutor run has an activity launchable at completion time.

### Actual launch
Prefer a server-owned route semantically equivalent to:
`POST /api/workspaces/:id/tutor/runs/:runId/activity`

At click time:
- reload persisted activity;
- reload current state;
- re-resolve capability;
- construct the mode-specific launch server-side;
- launch or visibly adjust.

Legacy runs remain history; launch-time validation protects them.

## Queue

Every returned queue item must resolve to a valid launch payload.

Add a regression sweep:
> every queue item returned from a supported state can be launched immediately.

Fix the deterministic `due_review` mismatch.

## Tutor grounding repair

Real data showed Tutor plan evidence fragility.

Add one small bounded grounding-specific repair round:
- report rejected target/evidence details to provider;
- retry;
- rerun full local validation;
- fail closed afterward.

## Remediation

Apply Amendment B:
targeted bounded repair for missing required question pieces; preserve valid pieces; no validation weakening.

## Stale assessments

Before grading:
- ensure referenced concepts/source dependencies still exist;
- stale pending assessments reject/invalidate;
- completed history remains;
- zero learner-state mutation on stale rejection;
- zero valid assessed concepts can never report normal success.

## Atomic grading + race-safe idempotency

Flow:
1. all provider/network grading and misconception proposal work first;
2. then one DB transaction/unit-of-work for submission, grading result, mistake/mastery/misconception/review/state-change writes;
3. no model calls inside the DB transaction.

Apply Amendment C for duplicate/concurrent submissions.

## Frontend stale-plan race

Fix the confirmed late-response race when selected concept changes, using the current cancellation/epoch style.

## Required Phase 0 regression coverage

At minimum:
- one-document Tutor cannot expose invalid cross-document activity;
- multi-doc without real capability cannot cross-document;
- valid cross-doc case succeeds;
- due review / no due review;
- queue due-later-today review launches;
- misconception identity and stale-state revalidation;
- prerequisite eligibility;
- finalize-valid then launch-stale adjustment;
- every queue item launch sweep;
- stale pending quiz no state mutation;
- zero targets cannot succeed;
- concurrent/retried duplicate applies state once;
- fault-injected persistence is atomic;
- remediation targeted repair;
- Tutor grounding repair;
- legacy-run compatibility;
- stale frontend plan response.

### Hard gate

Do not enter Phase 1 until targeted tests + full relevant regression + build + lint + offline demos/evals pass and the diff has been inspected for architecture duplication or weakened grounding.

Checkpoint commit if repository rules allow.

---

# 4. Phase 1 — Section-aware additive extraction, mapping visibility and progression

## Goal

Remove the structural whole-document → 3–8-concepts bottleneck while keeping the existing Concept/Graph model.

## Deterministic sections

Create/extend a deterministic section utility, likely under `ingestion/`.

Use headings when meaningful.

Apply Amendment D for missing/weak heading structure using stable synthetic bounded windows.

No new section table unless current code proves persistence is required.

## Section extraction

Evolve existing AnalysisService, do not create a second concept registry.

For each bounded section:
- run concept extraction;
- verify grounding as today;
- append accepted concepts;
- deduplicate with existing normalized-key semantics.

Apply Amendment E:
- size-aware budget;
- no mandatory minimum;
- 0–2 concepts can be valid;
- ~40/document only a soft ceiling.

Existing documents keep their current concepts until explicitly deepened.
New documents use section-aware extraction by default.

## Additive deepen

Support section-targeted analyze/deepen:
- append only;
- preserve existing IDs/content;
- dedup;
- retry failed sections independently;
- cancellable.

No destructive replacement during ordinary deepening.

## Structural mapping

Derive section mapping / evidence anchoring from SourceBlocks, concepts, graph evidence and later lesson anchors.

Expose an endpoint/UI, but apply Amendment F.

Do not claim deterministic anchor metrics equal semantic course coverage.

## Progression

Add an `unassessed_next` queue tier after remedial/review priorities.

Prefer:
- unassessed;
- important;
- prerequisite-ready when graph evidence exists;
- deterministic stable ordering.

Diagnostic selection should prefer meaningful unassessed candidates rather than always the first six canonical groups.

## Graph context bounding

As concept count rises, do not blindly concatenate all blocks.

For large workspaces use bounded:
- concept summaries;
- evidence-bearing blocks;
- section digests/context.

Keep graph validators/versioning unchanged.

## UX

Show extraction progress for multi-call analysis, including auto-analysis paths.

Show:
- mapped/unmapped sections;
- concept counts;
- structural anchor information;
- retry/deepen actions.

No misleading single coverage percentage.

## Phase 1 tests/eval

Include:
- real-heading sections;
- synthetic-section fallback;
- deterministic identity;
- merge/split boundaries;
- size-aware concept budgets;
- zero/few-concept sections;
- additive non-destruction;
- dedup;
- partial failure/retry;
- structural mapping reconciliation;
- unassessed progression;
- diagnostic selection;
- graph input bounding;
- long-document fixture;
- hand-authored semantic recall labels.

### Hard gate

Do not enter Phase 2 until all Phase 1 + existing graph/alignment/assessment regressions pass, old data compatibility is verified, no parallel KnowledgeNode registry exists, and build/lint/evals pass.

Checkpoint commit if allowed.

---

# 5. Phase 2 — Teaching enrichment with segment-level provenance

## Goal

Make Study Clinic genuinely teach, not merely summarize and route into quizzes.

## Persistence

Add one additive `concept_lessons` table (expected migration 12).

One current persisted lesson per concept is enough for this round.
No lesson-history/version subsystem yet.

## Lesson content

Use a bounded useful set such as:
- explanation
- intuition
- worked_example
- misconception_warning
- contrast
- application

Do not require every type for every concept.

Represent content at segment granularity:
`{ text, anchor? }`

`anchor` is optional VerifiedGrounding.

Classification is deterministic:
- verified anchor → course-source-backed;
- no verified anchor → AI teaching.

The model cannot self-certify provenance.

## Provenance UI

Apply Amendment G:
- `课程资料 / 本地已验证`
- `AI 辅助讲解（非资料原文）`

Reuse SourceEvidencePanel for source-backed segments.

## Conflict handling

If AI/common presentation conflicts with course material:
- conflict must include a verified source quote;
- invalid conflict quotes are dropped;
- source wins for course assessment;
- AI conflict text never affects required rubrics/mastery;
- bounded regeneration may be attempted;
- unresolved unsafe content is suppressed or clearly surfaced.

If two course sources conflict, do not silently choose one.

## Context

Bound lesson generation to:
- concept;
- its verified evidence;
- same-section blocks;
- bounded lexical retrieval;
- relevant graph-neighbor names/relations.

No web search.
No vector DB.

## Generation/fallback

Generate on demand and persist/cache.

Allow a few fixed directives such as:
- more intuitive;
- more examples;
- deeper.

Do not add free-form Tutor chat yet.

Failed regeneration preserves the previous valid lesson.

Invalid source attribution is never displayed as verified source.

## Assessment isolation

Viewing/generating lessons:
- does not change mastery;
- does not close mistakes;
- does not change review/misconception state;
- does not become required rubric evidence;
- does not redefine course truth.

## Provider parity

Add the new lesson-generation contract to FakeProvider and Hy3Provider together.

## Phase 2 tests/eval

Include:
- schema validation;
- anchor verification;
- conflict verification;
- server-derived provenance labels;
- AI segment never mislabeled as source;
- no learner-state writes;
- failed regeneration preserves old lesson;
- deletion cascade;
- injection resistance;
- cancellation/stale switching;
- Fake/Hy3 parity;
- real-provider lesson fixture/eval where credentials exist.

### Hard gate

Do not enter Phase 4 until lesson/provenance/conflict tests, existing grading/state regressions, build, UI and offline evals are green and sample fixture lessons have been inspected for usefulness rather than mere length.

Checkpoint commit if allowed.

---

# 6. Phase 4 — Evaluation, regression, docs and dogfood preparation

## Deterministic evaluation

Extend fake/offline evaluation for:
- Tutor launchability;
- queue launch sweep;
- stale recommendation revalidation;
- grading atomicity/idempotency;
- stale quiz rejection;
- targeted remediation repair;
- section partial failure;
- additive extraction stability;
- structural mapping reconciliation;
- lesson anchor/provenance checks;
- zero learner-state writes from teaching;
- context/retry bounds.

## Course-understanding evaluation

Separate:

**Structural mapping**
- processed/unprocessed sections;
- anchor distribution;
- concept distribution;
- reconciliation with source blocks/chars.

**Semantic recall**
- hand-authored must-find concept labels on selected fixtures.

Never use raw concept count as the success metric.

## Teaching evaluation

Separate:
- deterministic schema/provenance checks;
- source consistency/conflict checks;
- real-provider heuristic metrics;
- human usefulness judgment.

Do not claim a model judge proves teaching quality.

## Documentation

Update README / ARCHITECTURE / VERIFICATION only to describe implemented/tested behavior.

Document:
- launchability contract;
- structural mapping semantics;
- source-vs-AI provenance;
- assessment isolation;
- corrected grading transaction behavior;
- limitations;
- consistent `Hy3 Study Clinic` branding.

No “V2” branding.

## Human dogfood

Prepare, but do not fabricate, a 30–45 minute study protocol:

1. use a real 10–25 page course document;
2. before import, write 10–15 must-find concepts;
3. import and watch extraction;
4. inspect mapping and deepen weak sections;
5. inspect 4–5 lesson cards including a formula/procedure-heavy topic;
6. verify source/AI labels;
7. compare equivalent explanations with a strong general-purpose AI assistant;
8. run diagnostic, answer some questions incorrectly;
9. follow several queue items;
10. run Tutor on a weak concept and launch its activity;
11. finish remediation and inspect history.

Record:
- any launch failure;
- any provenance mislabel;
- materially wrong AI teaching;
- must-find concepts still missing;
- latency/graph clutter;
- where Study Clinic beats/loses to general chat;
- moments where free-form follow-up was desired;
- moments where automatic sequencing was desired.

## Post-dogfood Phase 3 decision

Only then decide whether to build:
- LearningGoal;
- multidimensional evidence/mastery;
- DiagnosisSnapshot;
- deterministic pedagogical policy;
- LearningActivity lineage;
- activity → outcome → replan;
- bounded conversational follow-up.

None are authorized now.

---

# 7. Expected code-change map

Verify actual placement before editing.

Likely server modifications:
- `services/tutor.ts`
- `services/queue.ts`
- `services/assessment.ts`
- `services/grading.ts`
- `services/remediation.ts`
- `services/analysis.ts`
- `services/graph.ts`
- `services/index.ts`
- `llm/provider.ts`
- `llm/prompts.ts`
- `llm/fakeProvider.ts`
- `llm/hy3Provider.ts`
- `repositories/materials.ts`
- `repositories/index.ts`
- `routes/workspaces.ts`
- `routes/study.ts`
- `db/migrate.ts`

Likely server additions:
- `services/activityLaunch.ts`
- `services/lessons.ts`
- `repositories/lessons.ts`
- `ingestion/sections.ts`
- corresponding tests
- a small mapping/coverage utility if cleaner than extending an existing service

Shared:
- evolve Tutor/activity/request/provider schemas
- create `domain/lesson.ts`

Web:
- `GraphWorkspaceView.tsx`
- `DetailPanels.tsx`
- `TutorPanel.tsx`
- `ImportView.tsx`
- `App.tsx`
- `api.ts`
- optionally `LessonCard.tsx` if extraction improves maintainability

Eval/docs:
- `eval/run-fake.mjs`
- `eval/run-hy3.mjs`
- `eval/README.md`
- `scripts/smoke-adaptive.mjs`
- semantic-recall labels / long-document fixture
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/VERIFICATION.md`

Do not invent paths that do not exist.

---

# 8. Execution protocol

Execute exactly:

Phase 0
→ targeted tests
→ full relevant regression
→ inspect diff
→ checkpoint

Phase 1
→ targeted tests
→ compatibility regression
→ inspect diff
→ checkpoint

Phase 2
→ targeted tests
→ provenance/UI regression
→ inspect diff
→ checkpoint

Phase 4
→ eval/docs
→ complete project validation
→ final implementation report
→ STOP

Do not pass a failing gate by:
- deleting/skipping tests;
- weakening grounding;
- adding fake-only shortcuts;
- hiding failures in UI;
- silently redesigning the approved architecture.

If implementation reveals a design conflict that invalidates this plan, stop and report it rather than launching an unapproved rewrite.

---

# 9. Definition of done before dogfood

The round is complete only if:

1. surfaced Tutor/queue activities are executable and launch-time revalidated;
2. predictable capability failures no longer appear as late generation errors;
3. stale assessments cannot mutate learner state;
4. zero-valid-target grading cannot succeed normally;
5. duplicate/concurrent submissions cannot apply state twice;
6. grading persistence is atomic across the learner-state write set;
7. remediation uses bounded targeted repair without weaker grounding;
8. long documents no longer depend on one whole-document 3–8 concept extraction;
9. weak headings use deterministic synthetic sections;
10. per-section extraction does not force a minimum concept count;
11. additive deepening preserves existing concept IDs;
12. structural mapping/unmapped sections are visible and honestly labeled;
13. new concepts are reachable by progression;
14. concepts can display useful persisted teaching content;
15. provenance is segment-level and server-verified;
16. course-source vs AI teaching is clearly distinguished;
17. AI teaching cannot become grading truth implicitly;
18. FakeProvider/Hy3Provider parity remains;
19. existing reliability/history behavior remains;
20. existing + new tests/build/lint/demos/evals pass;
21. real-provider checks run when credentials permit or are reported honestly unavailable;
22. docs claim only tested behavior;
23. human dogfood protocol exists but no human result is fabricated;
24. full adaptive-learning Phase 3 is NOT implemented.

After that: STOP and hand the product to the human user for real dogfood.
