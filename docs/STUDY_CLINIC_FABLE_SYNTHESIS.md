# Hy3 Study Clinic — Final Synthesis (Fable × Codex)

Date: 2026-08-09. Inputs: frozen [Fable blind audit](STUDY_CLINIC_FABLE_BLIND_AUDIT.md) and the Codex audit ([STUDY_CLINIC_V2_AUDIT.md](STUDY_CLINIC_V2_AUDIT.md)), both produced independently against `main` @ `a6e3a4d`. Every disagreement below was resolved by re-reading the actual code or the user's real database (read-only), not by author preference. This round changed no product code; baseline re-verified at 771/771 tests, 31/31 eval:fake.

---

# 1. Executive Decision

Both independent audits converged on the same diagnosis from different directions, which raises confidence to near-certainty:

1. **The P0 is a cross-layer contract error, not a bug in any single function.** A schema-legal `AssessmentMode` was treated as an executable activity. The user's own database contains the failure (a completed real-Hy3 Tutor run recommending `cross_document` in a single-document workspace, never launched); both audits reproduced it deterministically.
2. **"Thin learning content" is structural**: a 3–8-concept one-shot extraction ceiling, a flat single-evidence concept model, a provenance regime that quietly turned *source-grounded* into *source-only*, and activities that are always quizzes. Raising the concept count alone would fix nothing.
3. **The deterministic skeleton is excellent and must be preserved** — grounding, grading, state machines, versioned graph, snapshots, cancellation, provider parity, tests.

**Decision:** execute a four-phase pre-dogfood upgrade — (0) activity executability + state safety, (1) sectioned extraction + coverage + progression, (2) per-concept teaching enrichment with segment-level provenance, (3) evaluation/evidence — following the *shape* of Fable's minimal-additive design while adopting Codex's server-side launch construction, segment provenance, progression fixes, and state-safety batch. Codex's full knowledge-map engine (versioned typed node model, CoverageUnit inventory, DocumentRevision reconciliation, policy engine, activity lineage) is explicitly deferred until dogfood evidence justifies it.

# 2. What Fable Independently Found

(Full detail in the frozen blind audit.) Reproduced three launch failures end-to-end: Tutor `cross_document` → 422 in a 1-doc workspace; **daily-queue `due_review` tier that is deterministically unlaunchable** (queue advertises due-later-today with 「可提前完成复习」, launch requires due-now); raw `misconception_check` activity unlaunchable because `TutorActivitySchema` cannot carry `misconceptionId` (web bridges it from a stale client cache). Found the real completed `cross_document` tutor run in the user's DB. Quantified thinness on real data (17-page/16,352-char/277-block PDF → 8 concepts, avg 85-char summaries; ~97% of blocks evidence-orphaned). Root-caused thinness to five multiplicative caps (prompt budget, permanent freeze in `analysis.ts:31`, flat representation, nothing-downstream-exceeds-inputs, grounding-forbids-teaching). Designed: activity launchability contract with deterministic downgrade + `activity_adjusted` event; sectioned additive extraction over existing `headingPath`; derived (no-table) coverage; single new table `concept_lessons` with two provenance classes; concrete file-level change map, FakeProvider parity, eval extensions.

# 3. What Codex Found

Same P0 mechanism, same reproduction conditions, same real-DB evidence (plus the detail that concept groundings span only 6 of 17 pages). Same four thinness ceilings (recall / representation / provenance / activity). Beyond Fable, Codex found: **stale pending workspace assessments survive document deletion and grade dishonestly** (missing concepts silently skipped; can report 「全部达标」 with zero assessed concepts); **grading side effects are not one transaction and not idempotent** (provider call mid-write-sequence); **no coverage-aware progression** (queue has no unassessed tier; diagnostic fixed to first 6 canonical groups); **plan stale race** in `selectNode`; graph budget inconsistency (schema max 60 vs service max 120; min-1-edge vs 宁缺毋滥); brand string 「Hy3 智学诊所」; `smoke-adaptive` comment/path mismatch; real-Tutor plan-evidence fragility. Proposed a full target architecture: Course Map Engine with versioned typed `KnowledgeNode`/`KnowledgeRelation`, independent `CoverageUnit` inventory, `TeachingArtifact` with segment-level provenance, operation-level `GroundingPolicy`, `DocumentRevision`, DiagnosisSnapshot + PedagogicalPolicy + `ActivityLaunchSpec` + `LearningActivity` lineage, in five phases.

# 4. Agreement Between Both Audits

Identical on: executive verdict (evolve, don't rewrite); P0 root cause, call chain, real-DB evidence, and repair layer (deterministic capability check at recommendation time, prompt restriction, launch-time revalidation); the same three sibling failure paths (review-not-due, misconception-id gap + client bridge, remediation all-or-nothing); test-gap analysis (tutor tests assert `activity !== null` but never launch it; assessment tests pre-build alignment; no queue-item launch test); thinness as multiplicative ceilings with the same numbers; "source-grounded became source-only" as the deep teaching blocker; two-provenance-class solution with source-wins conflict rules and AI content excluded from grading; keep grounding/grading/state machines/history/cancellation untouched; defer vector DBs, chat platforms, agent frameworks, BKT/IRT, global strict/enhanced mode switches; write-only generated fields (blueprint reasoning steps, plan strategy) as waste; preserve product identity (no "V2" branding).

# 5. Important Disagreements

1. **Knowledge-model size**: Codex proposes a parallel versioned typed node model with projections back to existing APIs; Fable keeps `concepts` as the only node registry with derived sections and one new table.
2. **Coverage denominator**: Codex wants an independent model-extracted `CoverageUnit` inventory (semantic units, weighted); Fable computes deterministic per-section cited-character coverage with no model in the metric.
3. **Lesson granularity**: Codex marks provenance per content *segment*; Fable's blind design labeled whole fields with an anchor list.
4. **Launch mechanics**: Codex adds a server-side `POST …/tutor/runs/:runId/activity` so the frontend stops assembling mode-specific parameters; Fable kept the existing client-assembled launch with a validated payload.
5. **Pre-dogfood adaptive machinery**: Codex's Phase 3 (goals, evidence events, diagnosis snapshots, policy engine, activity lineage) sits inside its roadmap before rollout; Fable defers all of it past dogfood.
6. **Queue fix**: only Fable found the deterministic `due_review` mismatch; Codex's plan doesn't address it.
7. **Tutor evidence fragility**: only Codex elevated it to P1; Fable had it as generic P2.

# 6. What Codex Got Better

- **Stale pending assessments + dishonest empty grading** — verified: `deleteDocumentTx` (`repositories/workspaces.ts:151-155`) removes material-scoped rows only; workspace quizzes (`material_id NULL`) survive un-invalidated; `grading.persistOutcomes` skips vanished concepts (`grading.ts:186-187`) and `nextStepText` then reports 「全部作答达标」 even for a zero-score stale submission. Real P1, missed by Fable.
- **Grading atomicity/idempotency** — verified: no outer transaction; `proposeFromWrongAnswers` (a provider call) executes *between* repository writes; duplicate submission re-applies mastery/review. ARCHITECTURE.md §17's "transactions protect grading side effects" is inaccurate at flow level and must be corrected.
- **Coverage-aware progression** — verified: queue tiers 1–5 are all remedial/review; diagnostic targets = first 6 canonical groups (`assessment.ts:169-180`). Crucial interaction Fable missed: raising extraction to ~40 concepts *without* a progression tier would orphan most new concepts.
- **Plan stale race** — verified at `GraphWorkspaceView.tsx:287-293`: `setPlan((current) => current ?? result.plan)` lets concept A's late response occupy concept B's panel.
- **Tutor plan-evidence fragility elevated by real data** — verified in the user's DB: 2 of 4 real-Hy3 tutor runs failed with 「康复计划未通过本地校验(目标概念或原文依据不合法)」. A 50% observed failure rate deserves pre-dogfood treatment.
- Server-side activity construction; segment-level provenance; graph budget inconsistency (schema 60 vs `MAX_GRAPH_EDGES` 120, min-1 edge tension); brand string `App.tsx:474`; smoke comment mismatch (`smoke-adaptive.mjs:256`); the honest observation that 8 anchored blocks ≠ 2.9% semantic coverage (a concept can summarize many blocks) — Fable's phrasing overstated that number's meaning.

# 7. What Fable Got Better

- **The queue `due_review` P0-2** — deterministic, provider-independent, reproduced (`queue.ts:137-152` vs `assessment.ts:144-149`). Codex missed it entirely; any "recommendation executability 100%" goal fails without it.
- **Deterministic end-to-end reproductions** (three scripts, exact HTTP codes/messages) rather than condition analysis alone — these become regression tests almost verbatim.
- **Concrete, file-level change map with FakeProvider parity and offline-demo preservation** — Codex's plan is entity-level and never states how fake/offline determinism or the 771 passing tests survive its projections.
- **Right-sizing against repo constraints** — CLAUDE.md explicitly forbids duplicating concept models and parallel systems; Fable's design extends `concepts` additively where Codex's `KnowledgeNode` would create a second concept model with an indefinite projection bridge (which CLAUDE.md's migration rules discourage without a defined removal criterion).
- **Tutor review recommendation losing conceptIds at launch** (P2-1), **misconceptions only proposed for adaptive quizzes** (P2-2), FakeProvider round-robin distortion, stale-cache detail of the misconception bridge.
- Coverage metric that cannot lie: deterministic and cheap, with clearly stated limits — versus a model-extracted denominator whose own recall is unaudited (who audits the auditor?).

# 8. What Both Missed

(Found while cross-verifying.) 1) The interaction between the misconception bridge and `assessment.selectTargets`'s terminal-status rejection can *also* be triggered by the daily queue when a confirmed misconception is resolved between queue fetch and click — the queue item carries `misconceptionId` but no freshness guarantee; the Phase-0 launch-spec revalidation covers it. 2) Neither audit noted that `analysis.analyze` inside `quizzes.generate` (auto-analyze on first quiz) will inherit sectioned extraction latency — first-quiz UX needs a progress affordance. 3) Neither quantified prompt-size limits for `proposeGraphEdges` against a 40-concept, 277-block workspace (both flagged it qualitatively; Phase 1 bounds the input). 4) Neither proposed persisting the *reason* a tutor activity was downgraded for later evaluation — added to the `activity_adjusted` event detail.

# 9. Disagreements Resolved Against Actual Code

| # | Disagreement | Resolution (code-based) |
| --- | --- | --- |
| 1 | Parallel typed node model vs extend `concepts` | **Fable's shape wins for this round.** CLAUDE.md: "Do not duplicate concept models"; "Prefer extending existing schemas"; parallel model + projection has no removal criterion and risks the 771-test surface. Codex's own text concedes the migration bridge burden. Typed hierarchy revisits after dogfood *as columns/relations on `concepts`*, not a new table. |
| 2 | CoverageUnit inventory vs deterministic section coverage | **Deterministic metric is the official one now** (auditable, zero model error). The unit inventory is deferred; if dogfood shows section-granularity too coarse, add it as *advisory* output of the same sectioned extraction call. |
| 3 | Segment vs field provenance in lessons | **Codex wins.** Segment-level `{text, anchor?}` is what makes the honesty labels real in the UI; cost is one nesting level in the schema. Adopted into Fable's single-table design. |
| 4 | Client-assembled vs server-constructed launch | **Codex wins.** `POST /api/workspaces/:id/tutor/runs/:runId/activity` re-reads the persisted activity + current state server-side; the misconception client bridge is deleted rather than patched. Queue items get server-provided launch payloads for the same reason. |
| 5 | Adaptive machinery before dogfood | **Fable wins.** The existing diagnostic→mistake→remediation→review loop is genuine (both audits agree); dogfood should measure teaching + coverage + reliability before policy engines exist. Codex's own final recommendation sequences policy last. |
| 6 | Queue due_review | **Fable's finding stands** (reproduced); fixed via launch specs + review-mode named-concept due-within-today semantics. |
| 7 | Tutor evidence fragility priority | **Codex wins** (2/4 real runs failed). Add one bounded grounding-repair round at tutor finalize, mirroring the existing schema-repair philosophy (`hy3Provider.complete`), fail-closed after it. |
| 8 | "8 blocks anchored" interpretation | **Codex's caveat adopted**: report block-anchor counts as *anchor sparsity*, never as semantic coverage percentage. |

# 10. Final Product Principles

1. The source defines the course (scope, definitions, notation, grading); the model teaches the course — beyond-source teaching is legal only when labeled.
2. Two provenance classes, machine-enforced, segment-granular: `本地已验证原文` (exact-quote verified) vs `AI 补充讲解` (beyond-source). Conflicts must quote the source and the source wins for all assessment/grading purposes; AI enrichment never enters rubrics, mastery, or any learner-state mutation.
3. Anything the system recommends, the system can execute — enforced when the recommendation is *created*, revalidated when launched, with deterministic downgrade instead of user-facing 422s.
4. Coverage is deterministic, visible, and honest about being structural (section/anchor coverage, not semantic entailment).
5. Learner data is append-only/additive across upgrades; extraction deepening never regenerates existing concept IDs; failed generation never overwrites valid data (existing rule, extended to lessons).
6. Every generated field has a consumer or is cut.
7. Bounded generation everywhere: section-scoped prompts, explicit budgets, one bounded repair (schema — and now grounding for tutor plans).
8. Product identity stays "Hy3 Study Clinic" everywhere (fix 智学诊所).

# 11. Final Target Architecture

```text
Ingestion (unchanged) → SourceBlocks
  ├─ ingestion/sections.ts (derived outline; no table)
  ├─ AnalysisService v2: section-chunked extraction → additive concepts (cap 40/doc)
  ├─ CoverageService (pure fn): per-section concept/anchor stats → GET coverage
  ├─ GraphService (input-bounded for large workspaces; validator unchanged)
  ├─ LessonsService (NEW): per-concept lesson, segments with optional verified anchors,
  │    verified conflicts, fail-closed regeneration, single-turn directives
  ├─ ActivityLaunch (NEW pure module): per-mode capability check + deterministic fallback
  │    ├─ consumed at tutor finalize (downgrade + activity_adjusted event)
  │    ├─ consumed by queue composition (items carry launch specs)
  │    ├─ consumed by POST /tutor/runs/:runId/activity (server-constructed launch)
  │    └─ consumed at assessment launch (existing selectTargets stays as final gate)
  ├─ GradingService: all provider calls first → ONE transaction for all writes;
  │    duplicate-submission guard; stale-quiz guard; honest empty-outcome wording
  └─ Queue: tiers 1–5 (launchable by construction) + tier 6 unassessed_next
Providers: 11 methods (+generateConceptLesson); tutor prompt lists only launchable modes;
FakeProvider parity for everything (offline demos/evals stay deterministic)
```

Unchanged: grounding verify, rubric alignment, score arithmetic, mistake/mastery/misconception/review machinery, alignment, graph validation/versioning, attempts history, cancellation/stale-response layers, all existing routes (extended, not replaced).

# 12. Final Data Model

- **Migration 12 `concept_lessons`**: `id PK, workspace_id FK→workspaces ON DELETE CASCADE, concept_id UNIQUE FK→concepts ON DELETE CASCADE, content TEXT (JSON: sections[{kind, segments[{text, anchor?}]}]), conflicts TEXT (JSON: [{claim, sourceQuote(VerifiedGrounding)}]), provider, provider_model, prompt_version, created_at, updated_at`. Lessons die with their concept (document delete/reprocess cascades — correct semantics).
- **No other tables.** Sections/coverage derived from `headingPath`; tutor activity JSON gains optional `misconceptionId` (schema-only; old rows parse); review request gains optional `conceptIds` (request schema only).
- **Shared schema changes**: `ConceptLessonSchema` + payload (`domain/lesson.ts`, `provider/payloads.ts`); `TutorActivitySchema`/`TutorFinalizeStepSchema` `misconceptionId?`; `TutorEventKindSchema` + `activity_adjusted`; `CreateAssessmentRequestSchema` review `conceptIds?`; `DailyQueueItemSchema` + `launch` payload field; extraction constants (`MAX_CONCEPTS_PER_DOCUMENT = 40`, per-call 3–8 unchanged); graph budget unification (`GraphProposalPayloadSchema` max — align to one number with `MAX_GRAPH_EDGES`, and allow `edges: []` so 宁缺毋滥 is schema-legal; service treats empty as failed-no-overwrite as today).

# 13. Final Responsibility Boundaries

- **Model**: proposes concepts per section; lesson sections/segments/conflict candidates; questions/rubrics/coverage judgments; edges/alignments/plans; tutor tool choices and finalize payloads; may *choose among* launchable activity modes only.
- **Deterministic domain code**: everything persistent plus (new) launchability resolution and fallback, provenance classification of every lesson segment (anchored-verified vs AI), coverage numbers, downgrade events, submission guards, transaction boundaries.
- **Persistence**: additive migration 12 only; all multi-write flows transactional (grading joins graph/deletion/reprocess in this discipline).
- **Frontend**: presentation + the existing cancellation/epoch discipline; stops assembling mode-specific launch parameters (server constructs launches); renders provenance labels it receives, never invents them.

# 14. Activity Failure Final Resolution

1. `services/activityLaunch.ts`: `resolveActivityLaunch(repos, clock, workspaceId, activity) → {launchable: true, spec} | {launchable: false, reason, fallback}`; rules: `cross_document` ⇒ ≥2 documents AND target concepts have cross-document evidence capability (aligned siblings or multi-doc anchors); `review` ⇒ named concepts due within today, or (unnamed) anything due now; `misconception_check` ⇒ actionable (`proposed|confirmed`) misconception id, resolved server-side when absent; `prerequisite_repair` ⇒ concepts exist (graph prerequisites optional, as today); `concept_practice`/`diagnostic` ⇒ concepts exist. Fallback chain: `concept_practice(selected)` → `diagnostic`.
2. Tutor finalize validates; on failure persists the fallback and emits `activity_adjusted` with `{originalMode, reason}` in detail. **Invariant: every `completed` run's persisted activity is launchable at completion time.**
3. Tutor prompt offers only currently-launchable modes (computed in `buildStepInput`), with one-line preconditions; includes actionable misconception ids. FakeProvider selects from that list (its `cross_document` default disappears in 1-doc workspaces).
4. New route `POST /api/workspaces/:id/tutor/runs/:runId/activity`: server re-resolves against *current* state and creates the assessment (or returns the downgrade applied, honestly). `TutorPanel` calls it; the client misconception bridge is deleted.
5. Queue items carry server-computed launch payloads; tier 5 becomes launchable by construction (named-concept review honors due-within-today, matching its own advertisement); tutor `review` activities keep their conceptIds.
6. `assessment.selectTargets` remains the final gate (protects legacy rows and races); its error payload gains the resolver's fallback suggestion so the UI can offer one-click recovery.
7. Tutor plan grounding-repair: when `validatePlanProposal` rejects a finalize for evidence reasons, one bounded re-prompt listing the rejected targets/quotes; then fail as today (addresses the observed 2/4 real failure rate).

# 15. Course Knowledge / Coverage Final Design

Sectioned additive extraction (Fable mechanics, Codex intent): derived outline from `headingPath` (merge <800 chars, split >4000); per-section calls to the *existing* `analyzeConcepts` contract (3–8 per call); normalized-key dedup; global cap 40/document; `addConcepts` appends — `replaceConcepts` is no longer reachable from extraction (only reprocess uses it); per-section deepen endpoint; existing documents keep their concepts until the user deepens. Deterministic coverage: per-section `{charCount, blockCount, conceptCount, anchoredCharRatio}` (anchors = concept groundings + edge evidence + lesson anchors) via `GET /api/materials/:id/coverage`; UI shows per-section rows with 「未提取」+ deepen buttons; the metric is documented as structural coverage, not semantic entailment. Progression: queue tier 6 `unassessed_next` (importance-ranked, prerequisite-ready first when a graph exists); diagnostic target selection prefers unassessed + high-importance canonical groups instead of the first six. Graph proposal input bounded to concepts + evidence-bearing blocks (+ section digests) above a size threshold.

# 16. Teaching Enrichment / Provenance Final Design

One lesson per concept (`concept_lessons`), generated on demand, structured as ≤6 typed sections (`explanation | intuition | worked_example | misconception_warning | contrast | application`), each ≤10 segments `{text ≤600, anchor?}`. Every anchor and every conflict quote passes `verifyGrounding` against the workspace's real blocks; failed anchors are dropped (segment survives, labeled AI); conflicts without verifiable quotes are dropped entirely. UI (讲解 tab): anchored segments show 「本地已验证」 with `SourceEvidencePanel`; unanchored segments render in the AI style with an explicit 「AI 补充,超出资料范围」 disclosure; conflicts render as 「资料与常见表述不同」 quoting the source; a fixed disclaimer mirrors the existing entailment caveat. Regeneration: full-card, plus single-turn directives (`more_intuitive | more_examples | deeper`) through the same validation; failure preserves the previous card. Lessons never touch learner state and never feed rubrics. Input context: concept + its quote + same-section blocks + bounded lexical retrieval + graph-neighbor names/relations. FakeProvider produces a deterministic lesson (sentence-derived, one verified anchor, no conflicts) so demos/tests stay offline-deterministic.

# 17. Reliability / State Safety Final Design

- **Grading**: reorder to *all provider calls first* (question grades, then misconception proposals computed pre-write), then ONE `db.transaction` covering submission, grading result, mistakes/mastery, misconception transitions + inserts, review updates, state-changes snapshot. Route-level duplicate-submission guard (409 for a quiz that already has a grading result; verify no existing test re-submits — if any does, the guard moves behind an explicit flag). Stale-quiz guard: reject submission when any question's concept no longer exists (「该测验引用的内容已被删除或重解析,请重新生成练习」); `nextStepText` honesty fix for empty outcomes.
- **Documents**: delete/reprocess leaves *submitted* history intact (unchanged); *pending* workspace quizzes become unsubmittable via the guard (no migration needed).
- **Frontend**: fix `selectNode` plan race (track requested conceptId, compare on resolve); everything else keeps the existing epoch/abort discipline.
- **Budget/consistency cleanups**: graph payload/service budget unified; empty edge list schema-legal.
- Existing fallback rules unchanged and extended to lessons/extraction: partial section failure marks that section 未提取 and retryable; never blocks others.

# 18. Scope To Implement Before Dogfood

Phases 0–3 below, in order, each a coherent local commit: executability + state safety; course-map depth + coverage + progression; lesson cards; evaluation/documentation. This is jointly the smallest coherent upgrade that changes the dogfood verdict: reliability failures the user already hit on camera; the 8-concepts-for-17-pages ceiling; the absence of any teaching surface; and the evidence that all of it works. **Deeper adaptive machinery is not required for meaningful dogfood** — both audits agree the assess→mistake→remediate→review loop is real; the missing ingredients are teaching content, coverage, and recommendation reliability. The only "small adaptive piece" needed earlier is inside Phase 0 by definition: recommendations must reflect current state.

# 19. Scope Explicitly Deferred

Codex's map engine (versioned `KnowledgeMapVersion`/typed `KnowledgeNode`/`KnowledgeRelation`, `CoverageUnit` inventory, `DocumentRevision` + reconciliation); `LearningActivity` lineage, `LearnerEvidenceEvent`, `DiagnosisSnapshot`, `PedagogicalPolicy` engine, `LearningGoal`, mastery dimensions (recognition/explanation/application/transfer), non-quiz activities as first-class records; free-form bounded 追问 beyond the three fixed directives; multi-document lesson synthesis; operation-level `GroundingPolicy` enum (per-surface policy is hardcoded this round); external enrichment (web); unmerge; OCR; assessment-size preferences; FakeProvider round-robin fix; misconception proposals for non-adaptive quizzes. Each has a defined trigger in the dogfood protocol (§25).

# 20. Detailed Implementation Phases

## Phase 0 — Activity executability + state safety

### Goal
Every recommendation the product surfaces is launchable; grading is atomic, idempotent, and honest about stale state.
### User-visible benefit
「开始推荐活动」 always works (or visibly, sensibly adjusts); no more dead queue items; no dishonest 「全部达标」.
### Existing components to reuse
`assessment.selectTargets` rules (source of truth for preconditions), `planValidation.ts`, tutor loop/budgets/timeline, queue tiers, `useAsyncAction`/PendingLaunch frontend discipline, `buildTestApp`.
### Data/schema changes
Shared only: `TutorActivitySchema.misconceptionId?`; finalize payload same; `activity_adjusted` event kind; `CreateAssessmentRequestSchema.conceptIds?` for review; `DailyQueueItem.launch` payload.
### Migration changes
None.
### Repository changes
None (tutor activity is JSON; submissions gain a `getByQuiz` lookup if not present).
### Service/domain changes
New `services/activityLaunch.ts`; `tutor.ts` finalize validation/downgrade + grounding-repair round + launchable-modes in `buildStepInput`; `queue.ts` launch payloads + due-today semantics; `assessment.ts` review-named-concepts rule + fallback-suggestion in error details; `grading.ts` reorder + transaction + guards + honest wording; `remediation.ts` partial tolerance (≥1 grounded question per target; missing types reported as warnings — documented behavior change).
### Provider/LLM changes
`TutorStepInput` + `launchableModes`/`actionableMisconceptions`; FakeProvider tutor policy selects from launchable modes.
### Prompt changes
`tutorStepMessages`: only launchable modes with one-line preconditions; grounding-repair re-prompt template.
### API changes
`POST /api/workspaces/:id/tutor/runs/:runId/activity`; queue response carries launch payloads; assessment 422/400 payloads carry `fallback`.
### Frontend changes
`TutorPanel` uses the run-activity route; `GraphWorkspaceView` deletes the misconception bridge, uses queue launch payloads, passes review conceptIds, renders `activity_adjusted`; fix `selectNode` plan race.
### Validation / invariants
Completed tutor run ⇒ activity launchable at completion; queue item ⇒ launchable at composition; graded submission ⇒ all-or-nothing persistence; duplicate submission ⇒ 409; stale quiz ⇒ structured rejection.
### Fallback behavior
Downgrade chain `concept_practice(selected)` → `diagnostic`; launch-time drift returns the downgrade applied (honest note), not an error, via the run-activity route.
### Tests
Unit: resolver per mode × state matrix. Service: tutor downgrade/adjusted-event/grounding-repair; grading transaction (fault injection), duplicate, stale-quiz, empty-outcome wording; remediation partial. Route: queue sweep — every listed item launches 201; run-activity route including drift. Web: TutorPanel/queue/race tests. The three Stage-A repro scenarios become regression tests.
### Evaluation
eval:fake: full-session-then-launch invariant; queue sweep. `smoke-adaptive.mjs`: launch the recommended activity and assert 201; add a no-mistake tutor scenario; fix the stale comment.
### Risks
Behavior changes (remediation tolerance, duplicate guard) must be documented and test-audited; FakeProvider demo output shifts (memory note updated).
### Backward compatibility
Legacy completed runs with unlaunchable activities: run-activity route downgrades them honestly. Old clients: existing `POST /assessments` unchanged.
### Definition of done
All new invariants tested; 771 existing tests green (with documented, justified updates only); repro scripts return 201.
### Dependencies
None.
### Explicitly deferred work
Pending-quiz UI invalidation surface (guard is server-side only); idempotency keys beyond the 409 guard.

## Phase 1 — Course-map depth, coverage, progression

### Goal
Long documents extract proportionally to their size, additively, with visible honest coverage and a path for every concept to get assessed.
### User-visible benefit
A 17-page PDF yields a real map (up to 40 concepts) instead of 8; 「未提取」 sections are visible and fixable in place; 今日学习 advances into unassessed material.
### Existing components to reuse
`analyzeConcepts` provider contract unchanged; `normalizeConceptKey`; `verifyGrounding`; queue/diagnostic infrastructure; `headingPath` data.
### Data/schema changes
Shared constants (`MAX_CONCEPTS_PER_DOCUMENT`); coverage response schema; graph budget unification + empty-edges legality.
### Migration changes
None.
### Repository changes
`materials.addConcepts` (append, ID-stable).
### Service/domain changes
`ingestion/sections.ts` outline util; `analysis.ts` chunked initial + per-section additive extraction + dedup + cap; `CoverageService` pure function + route; `queue.ts` tier 6 `unassessed_next`; `assessment.ts` diagnostic selection prefers unassessed/high-importance; `graph.ts` bounded proposal input above a size threshold.
### Provider/LLM changes
None (same method, chunked calls). FakeProvider unchanged (already per-blocks deterministic).
### Prompt changes
None per call; optional section title line in the extraction prompt.
### API changes
`POST /api/materials/:id/analyze` accepts `{section?}`; `GET /api/materials/:id/coverage`.
### Frontend changes
Coverage rows + deepen buttons in `GraphWorkspaceView` document panel; `ImportView` coverage summary; progress affordance for multi-call initial extraction (auto-analyze path included).
### Validation / invariants
Existing concept rows never mutated by extraction (snapshot test); dedup by normalized key; caps enforced; coverage sums reconcile to document totals.
### Fallback behavior
Per-section provider failure ⇒ section marked 未提取, retryable, others unaffected; initial run sequential + cancellable.
### Tests
Outline determinism (merge/split boundaries); additive non-destruction; dedup; cap; coverage math; tier-6 ordering; diagnostic selection; graph input bounding.
### Evaluation
eval:fake additivity + coverage checks; new fixture `eval/fixtures/long-sectioned-zh.md` + hand-authored `eval/labels/coverage-concepts.json` for recall measurement (fake structural, hy3 real).
### Risks
Node clutter in the graph UI at 40 concepts (mitigated: existing layout budgets; dogfood judges the cap); longer first-extraction latency (progress UI).
### Backward compatibility
Existing documents untouched until deepened; all current API responses superset-compatible.
### Definition of done
277-block real-shape document extracts across all sections within caps; coverage visible; every concept reachable through queue tier 6.
### Dependencies
Phase 0 (queue launch payloads).
### Explicitly deferred work
Hierarchy columns; unit inventory; map versioning.

## Phase 2 — Lesson cards (teaching enrichment)

### Goal
Every concept can teach: structured, regenerable lesson content with segment-level provenance and verified conflicts.
### User-visible benefit
讲解 tab turns the clinic into a tutor: explanations, intuition, worked examples, misconception warnings, contrasts, applications — clearly labeled 原文 vs AI 补充.
### Existing components to reuse
`verifyGrounding`, `retrieval/lexical.ts`, `SourceEvidencePanel`, `useAsyncAction`, provider repair loop, fail-closed persistence pattern.
### Data/schema changes
`domain/lesson.ts` (`ConceptLessonSchema`, content/section/segment/conflict schemas, directive enum); `provider/payloads.ts` lesson payload.
### Migration changes
Migration 12 `concept_lessons` (+ idempotence/compat tests).
### Repository changes
New `repositories/lessons.ts` (get by concept, transactional upsert, cascade-tested).
### Service/domain changes
New `services/lessons.ts` (context assembly, validation, anchor/conflict verification, preserve-on-failure, directives).
### Provider/LLM changes
Method 11 `generateConceptLesson` on `LlmProvider`, `FakeProvider` (deterministic), `Hy3Provider`.
### Prompt changes
`conceptLessonMessages`: course-scope binding, mandatory labeling rules (anchors verbatim-only; beyond-source segments unanchored), conflict rule (must quote source), 中文, JSON contract, directive variants.
### API changes
`GET/POST /api/workspaces/:id/concepts/:conceptId/lesson` (POST body `{directive?}`), cancellable.
### Frontend changes
讲解 tab (in `DetailPanels.tsx`, extracted to `LessonCard.tsx` if large): segment rendering with provenance chips, conflicts, generate/regenerate + three directive buttons, loading/cancel/stale/switching handling; `api.ts` additions.
### Validation / invariants
Anchors/conflict quotes verified or dropped; caps enforced; lessons write no learner state (row-count invariant test); failed regeneration preserves previous card; provenance labels derive solely from server-verified anchors.
### Fallback behavior
No lesson yet + generation failure ⇒ clear error + retry; lexical retrieval empty ⇒ proceed with section blocks only.
### Tests
Service validation matrix; cascade on concept/document deletion; migration tests; provider parity; web rendering/labels/directives/cancel; injection-resistance reuse (lesson prompt wraps untrusted blocks with existing fencing).
### Evaluation
eval:fake lesson checks (schema, anchors, no-state-writes, provenance separation); eval:hy3 op 7: first-pass schema rate, anchor verification rate, conflict honesty on `forces-conflict.md`.
### Risks
Hallucinated teaching presented confidently — mitigated by labels, conflicts, dogfood spot-checks; verbosity — mitigated by caps.
### Backward compatibility
Purely additive; absent lesson = current behavior.
### Definition of done
Offline demo displays a labeled lesson for every concept; all invariants tested; real-provider op 7 passes on fixtures.
### Dependencies
Phase 1 (section context improves lesson input; not a hard dependency).
### Explicitly deferred work
Free-form follow-ups; per-field regeneration; lesson history; canonical-group merged lessons.

## Phase 3 — Evaluation, documentation, identity

### Goal
Prove the upgrade holds; make every claim in the docs true.
### User-visible benefit
Trustworthy docs; consistent product name; reviewers can re-verify everything offline.
### Existing components to reuse
`eval/run-fake.mjs` harness, `run-hy3.mjs` + fail-closed evidence pipeline, VERIFICATION structure.
### Data/schema/migration/repository changes
None.
### Service/provider/prompt/API changes
None (evaluation only).
### Frontend changes
`App.tsx:474` 「Hy3 智学诊所」→「Hy3 Study Clinic」(+ test snapshot updates).
### Validation / invariants
eval:fake grows to ≥38 checks covering §14–§17 invariants.
### Fallback behavior
n/a.
### Tests
Updated totals recorded in VERIFICATION.
### Evaluation
Coverage-recall labels; lesson-quality op; launchability sweeps; regression: all pre-existing checks unchanged.
### Risks
Doc drift — mitigated by writing docs from the tested invariants.
### Backward compatibility
n/a.
### Definition of done
README/ARCHITECTURE/VERIFICATION document provenance classes, coverage semantics, launchability contract, corrected grading-transaction claim, new limitations; eval suites green; worktree clean.
### Dependencies
Phases 0–2.
### Explicitly deferred work
Human-study claims (none are made without running the dogfood).

# 21. Concrete Code Change Map

**Server modify:** `services/tutor.ts`, `services/queue.ts`, `services/assessment.ts`, `services/grading.ts`, `services/remediation.ts`, `services/analysis.ts`, `services/graph.ts`, `services/index.ts`, `llm/provider.ts`, `llm/prompts.ts`, `llm/fakeProvider.ts`, `llm/hy3Provider.ts`, `repositories/materials.ts`, `repositories/index.ts`, `routes/workspaces.ts`, `routes/study.ts`, `db/migrate.ts` (migration 12).
**Server create:** `services/activityLaunch.ts` (+`.test.ts`), `services/lessons.ts` (+`.test.ts`), `repositories/lessons.ts`, `ingestion/sections.ts` (+`.test.ts`), coverage util (inside `services/materials.ts` or a small `services/coverage.ts` — placement at implementation time).
**Server tests modify:** `services/tutor.test.ts`, `services/assessment.test.ts`, `services/quizzes.test.ts` (grading flows live in `routes/flows.test.ts` + service tests), `routes/workspaces.test.ts`, `routes/flows.test.ts`, `repositories/repos.test.ts`, `db/migrate.test.ts`, `db/migrateCompat.test.ts`, `llm/fakeProvider.test.ts`, `llm/providerGraph.test.ts`.
**Shared modify:** `domain/tutor.ts`, `domain/blueprint.ts`, `domain/graph.ts` (budget note), `provider/payloads.ts`, `index.ts`; **create** `domain/lesson.ts`; tests: `domain/adaptiveSchemas.test.ts`, `domain/schemas.test.ts`.
**Web modify:** `views/GraphWorkspaceView.tsx` (+test), `components/DetailPanels.tsx` (+ via `AdaptivePanels.test.tsx`), `components/TutorPanel.tsx`, `views/ImportView.tsx`, `App.tsx` (brand), `api.ts`; **create** `components/LessonCard.tsx` (+test) if extracted.
**Eval/demo:** modify `eval/run-fake.mjs`, `eval/run-hy3.mjs`, `eval/README.md`, `scripts/smoke-adaptive.mjs`; create `eval/labels/coverage-concepts.json`, `eval/fixtures/long-sectioned-zh.md`.
**Docs:** `README.md`, `docs/ARCHITECTURE.md` (incl. correcting the grading-transaction sentence in §17), `docs/VERIFICATION.md`.
Unverified-placement caveats are marked inline above; no other paths are invented.

# 22. Migration / Compatibility Strategy

Single additive migration (12); every schema change optional-field; existing rows re-validate unchanged. User data fully preserved: materials/blocks/concepts (extraction only appends), attempts/history (untouched; stale-pending protection is submission-time), graph versions/alignment (validator unchanged; budget unification only widens legality of empty proposals), grading/mistakes/mastery/misconception/review (logic unchanged except atomicity + honesty wording), tutor history (legacy unlaunchable activities downgraded honestly at the new launch route). Provider parity maintained method-for-method; offline demos and eval:fake remain deterministic. Deliberate behavior changes — remediation partial tolerance, duplicate-submission 409, stale-quiz rejection, queue review semantics, FakeProvider tutor mode selection — are each documented with updated tests and reasons (per the never-weaken-tests rule). No coexistence/adapter period is needed because no model is replaced; if post-dogfood work introduces typed hierarchy, it lands as nullable columns on `concepts` with a defined backfill, not a parallel table.

# 23. Testing Strategy

Pyramid per phase (see §20): pure-unit (resolver, sections, coverage, lesson validation) → service (downgrade, transactions with fault injection, additive extraction, preserve-on-failure) → route (launch sweeps, run-activity drift, guards) → web (race fix, lesson UI, adjusted events) → migration (12: apply, idempotence, cascade, rollback) → the three Stage-A repro scenarios as permanent regressions. Tests never call the real API; the duplicate-submission guard is introduced only after auditing existing suites for double-submits. Target: existing 771 green (minus documented deliberate changes), plus ~60–80 new tests.

# 24. Evaluation Strategy

**A. Deterministic:** launchability invariants (tutor + queue sweeps), grading atomicity/idempotency, extraction additivity/ID stability, coverage reconciliation, lesson anchor verification + zero learner-state writes, provenance-class separation. In eval:fake + Vitest.
**B. Source-consistency/provenance:** anchor verification rates; conflict-quote verification; UI label derivation tests; anchor-sparsity reporting (never claimed as semantic coverage).
**C. Model-based (real provider, out of CI):** eval:hy3 op 7 lesson quality (schema first-pass, anchor verify rate, conflict honesty on `forces-conflict.md`); extraction recall vs hand-authored `coverage-concepts.json` (recall of must-find concepts per fixture section); existing 6 ops unchanged; aggregates only, same fail-closed evidence pipeline.
**D. Human (dogfood, §25):** course-understanding judgment (map vs the learner's own pre-listed key concepts), teaching quality vs a general-purpose assistant, activity reliability count, honesty spot-checks. No fabricated gold labels; the human authors expectations before extraction.
**Regression:** all existing checks; snapshot history replay; injection fixtures extended to lesson prompts.

# 25. Human Dogfood Protocol (30–45 min, after implementation)

**Material:** one real course PDF, 10–25 pages, with headings and at least one formula/procedure section (e.g. an actual lecture handout); optionally a second short overlapping document for alignment/cross-document checks.
**Before starting:** write down (outside the app) the 10–15 concepts you believe the document must contain.
**Flow:** import → watch extraction progress → review coverage panel (compare against your list; deepen 1–2 sections; note anything still missing) → open 4–5 lesson cards including one formula-heavy concept (read explanation/example; check labels; try one directive regenerate) → ask the same concept questions to a strong general assistant and compare usefulness, correctness, course-specificity → run diagnostic → answer honestly (some wrong) → follow the queue for 3–4 items including a review and a misconception check → run the Tutor on a weak concept → launch its recommended activity → complete remediation until a mistake resolves → reopen history.
**Record:** every recommendation that failed to launch (severity: critical); every lesson statement that is wrong or mislabeled (critical if labeled 原文, major if AI-labeled); coverage misses from your pre-list (major); latency pain points; whether lesson + source beats the general assistant for *this course's* framing (the core product question); whether you ever wanted to *ask* something the card couldn't answer (evidence for the deferred 追问 feature).
**Decision gates:** adaptive-phase justified if (a) activities were reliable AND (b) lessons were useful but you repeatedly wanted sequencing/follow-ups the static loop couldn't give. Adaptive-phase unnecessary/redesign if lessons + queue already sustain a full session, or if teaching quality (not orchestration) remains the binding constraint. Coverage-unit inventory justified only if section-level coverage repeatedly mislabeled thin sections as covered.

# 26. Risks / Overengineering Check

Top risks: mislabeled AI teaching (mitigated: segment labels, verified conflicts, dogfood spot-checks, op 7); graph clutter at 40 concepts (existing budgets + cap tunable); multi-call extraction latency (progress UI, sequential cancellable); behavior-change fallout (documented tests); scope creep toward Codex's full engine (this document's deferrals are explicit, each with a dogfood trigger). Overengineering rejected in this round: parallel typed node model, CoverageUnit inventory, DocumentRevision reconciliation, policy engine + lineage entities, GroundingPolicy enum, lesson versioning, embeddings, follow-up chat. Under-engineering guarded against: the queue/diagnostic progression fix ships *with* the extraction raise (Codex's coupling insight), and state-safety lands in Phase 0 rather than "later".

# 27. Final Definition of Done

1. Build/lint/tests/eval:fake green; new totals recorded; no existing test weakened without documented deliberate change.
2. Invariants proven by test + eval: every surfaced recommendation launches (tutor sweep, queue sweep, repro scripts 201); grading atomic + idempotent + honest on stale/empty; extraction additive with stable IDs; coverage reconciles; lesson anchors verified; zero learner-state writes from lessons; provenance labels server-derived.
3. Real-shape document (~277 blocks) extracts across sections within caps with visible coverage and deepen; every concept queue-reachable.
4. Every concept can show a labeled lesson card offline (FakeProvider) and pass op 7 on the real provider fixtures.
5. Docs truthful (provenance classes, coverage semantics, launchability, corrected transaction claim, brand string fixed); worktree clean; focused per-phase commits.

# 28. Implementation Readiness

**If this synthesis is approved unchanged, can Fable start implementation directly from this report next session without repeating the architecture investigation? — Yes**, via §20–§21: every phase names its files, schemas, routes, invariants, tests, and fallbacks against verified current code. Three small items are intentionally left as implementation-time decisions and do not block starting: (a) coverage util placement (`services/materials.ts` vs a tiny `services/coverage.ts`); (b) whether the 讲解 tab lives inline in `DetailPanels.tsx` or extracts to `LessonCard.tsx`; (c) the duplicate-submission guard's final form pending an audit of existing tests for double-submission. One numeric decision (concept cap 40, section chunk ~800/4000 chars, segment caps) is a tunable default, not a design blocker.
