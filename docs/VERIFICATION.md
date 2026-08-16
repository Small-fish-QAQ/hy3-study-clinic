# Verification and Reviewer Evidence

This document is the reproducibility and reviewer-evidence companion to the [Hy3 Study Clinic README](../README.md). It separates verification detail from the product overview while keeping every published claim auditable.

## Release lineage

| Purpose | Commit or ref | Meaning |
| --- | --- | --- |
| Real Hy3 evaluation source | `46d34f288d6c619d396ee5f39e12cb33249161da` | The six-operation `eval:hy3` suite ran from this clean worktree. |
| Final submitted release | `c67ac6d5a42295a21197794e5055ef7785df3b0b` | Direct child of the evaluated commit; adds the sanitized evidence, its regression guard, and documentation. |
| Immutable final tag | `issue-4-final` | Annotated tag pointing to `c67ac6d`; it is intentionally not moved by later documentation maintenance. |
| Upstream submission | [Tencent-Hunyuan/Hy3#77](https://github.com/Tencent-Hunyuan/Hy3/pull/77) | Wrapper PR targeting upstream branch `rhinobird2026` and linking the independent repository. |

This post-tag audit improves documentation and reviewer-facing metadata. It does not rewrite the historical evaluation or move the release tag.

## Standard verification

Use Node.js 20 or newer from the repository root:

```bash
npm ci
npm run build
npm run lint
npm test
npm run eval:fake
git diff --check
```

The root commands map to the existing monorepo workspaces:

- `npm run build` runs the shared and server TypeScript builds plus the web TypeScript check and Vite production build.
- `npm run lint` runs ESLint and `prettier --check .`.
- `npm test` first builds the shared package, then runs every workspace Vitest suite.
- Migration and HTTP integration coverage live inside the server Vitest suite; there are no separate commands that must be run to obtain those results.
- `npm run eval:fake` uses the deterministic fake provider and makes no real Hy3 request.
- `git diff --check` checks the final patch for whitespace errors. `npm run lint` already includes the repository-wide `prettier --check .`; run `npx prettier --check README.md docs/ARCHITECTURE.md docs/VERIFICATION.md` for a documentation-only formatting check.

CI executes `npm ci`, build, lint, and tests on:

- Ubuntu with Node.js 20;
- Ubuntu with Node.js 24; and
- Windows with Node.js 24.

The immutable final tag passed all three jobs in [CI run 30604963718](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/runs/30604963718).

## Current-state verification

The immutable final tag's historical results remain recorded in the release lineage above. Do not use those historical file or test totals as a claim about the current implementation. Run the standard commands from this document against the checked-out revision to obtain current results.

`npm run eval:fake` covers provenance, alignment, cross-document blueprint scope, Tutor budgets, misconception transitions, review scheduling, retrieval isolation, prompt-injection defenses, mastery bounds, database foreign-key integrity, activity executability, grading state safety, course-understanding fixtures, and lesson provenance. It is deterministic and writes its reports under ignored `eval/reports/`.

The server and shared suites also cover the implemented Phase 1-4 route: MaterialRevision lineage and source authority; Contract/Curriculum/StudyPlan/Agenda validation and atomic activation; durable StudySession lifecycle, idempotency, transcript recovery, and mixed-initiative controls; and formal-evidence progression, replan candidates, and goal outcomes. Web suites cover the Course selection shell, Course Home primary action, Course Materials, Curriculum, Chinese-named `学习` workspace, consolidated Progress destination, embedded Explore graph, and the focused Settings surface. They also assert legacy-destination consolidation, useful empty states, formal/informal separation, prose-independent completion state, request cancellation, stale responses, and Course/document switching safety.

Focused provider/settings checks can be run without calling a real provider:

```bash
npm run test -w @hy3-clinic/shared -- src/domain/providerConfig.test.ts
npm run test -w @hy3-clinic/server -- src/services/providerRuntime.test.ts src/llm/hy3Provider.test.ts src/app.test.ts src/config.test.ts
npm run test -w @hy3-clinic/web -- src/views/SettingsView.test.tsx src/views/AgentCourseWorkspace.live01.test.tsx
npm run test -w @hy3-clinic/web -- src/views/AgentCourseViews.test.tsx src/App.test.tsx
npm run test -w @hy3-clinic/server -- src/llm/fakeProvider.test.ts src/services/studyPlansAgent.test.ts
npm run test -w @hy3-clinic/server -- src/services/providerTelemetry.test.ts src/routes/flows.test.ts src/services/lessons.test.ts src/services/remediation.test.ts
npm run test -w @hy3-clinic/server -- src/services/curriculum.test.ts src/services/curriculumEvidence.test.ts src/services/studyPlansAgent.test.ts
npm run test -w @hy3-clinic/server -- src/services/learningContractScope.test.ts src/services/learningContracts.test.ts src/services/curriculum.test.ts src/services/studyPlansAgent.test.ts
npm run test -w @hy3-clinic/shared -- src/domain/phase2ApiSchemas.test.ts
npm run test -w @hy3-clinic/web -- src/views/AgentCourseViews.test.tsx src/views/GraphWorkspaceView.test.tsx
```

`providerConfig.test.ts`, `providerRuntime.test.ts`, `hy3Provider.test.ts`, and `app.test.ts` cover strict safe contracts, precedence and persistence, atomic activation/rollback, request snapshots, stale connection tests, loopback mutation guards, Fake no-call behavior, redaction, normalized provider failures, explicit secret actions, and provider switching without learning-state writes. `SettingsView.test.tsx` covers fake/Hy3 editing, safe secret replacement/removal/cancellation, unsaved drafts, save cancellation and stale responses, the deliberately local scope of Check Local Service Status, authoritative refresh, external-test cancellation, configuration authority, current-Course diagnostics, and the sidebar-preference callback. `fakeProvider.test.ts` covers source-complete parser-fragment grouping within the Curriculum contract bounds, while `studyPlansAgent.test.ts` covers exact-input preflight and fail-closed provider suppression for a source-only accepted Curriculum. The remaining suites cover the existing course, curriculum, LIVE-01, and App continuity gates. These are behavioral assertions rather than visual snapshots.

Post-red-team correctness regressions exercise the production boundaries rather than only constructing repository state:

- a real HTTP Tutor request reserves a turn, reaches a sent provider attempt, is recovered after application restart, and completes an identical retry as one logical learner turn with two fenced physical attempts;
- a separate live-process HTTP test advances the clock beyond the operation lease, performs demand-driven recovery on the identical retry, records the old sent attempt as `outcome_unknown`, and proves the late old worker cannot replace the fencing-token-2 result;
- repository tests prove that changed operation identity/fingerprint is rejected before expired-lease recovery, and that successor activation atomically closes predecessor sessions, unfinished turns, logical calls, and operations while preserving rollback behavior;
- the StudySession view selects only active/paused sessions matching the current Contract, Curriculum, StudyPlan, and SessionAgenda IDs, and reloads after route/version changes;
- Material-role route tests send mismatched URL/body and URL/assignment identities, assert unchanged role histories and operation/result tables, then prove the correctly addressed request still succeeds; and
- LIVE-01 regressions exercise the wrapped proposal/confirmation response contract, fail-closed stale scope, confirmation/refetch durability, Contract progression after confirmation, learner-facing concurrent-conflict recovery, and future role-version re-staleness without changing the logical Material identity.

The pre-dogfood closure regressions additionally cover all nine major repair paths: current-Curriculum Plan acceptance across retained historical lineage; duplicate headings under different parser paths and headingless Fake outlines; detailed-path input-aware one-repair behavior; unit-local `due_review`; Agenda state/kind/repair launch gates; Home/Progress-owned failures without route leakage; definitive Tutor failure followed by authoritative Session refresh and a successful distinct command; exactly-once physical inference telemetry across direct, nested, repair, retry, timeout, cancellation, and stale-lease cases; and a time-controlled StudyPlan repair that crosses the former five-minute lease while stale tokens remain fenced. Rendered browser QA is still required for the user-visible error and Tutor-recovery flows; component tests alone are not treated as visual evidence.

Deliberate behavior changes in the upgrade, each with updated tests: duplicate submissions of one quiz now return `409 DUPLICATE_SUBMISSION` (learner state applies at most once; the graph smoke asserts this instead of double-grading); pending quizzes whose required concepts are no longer available are rejected instead of dishonestly succeeding; material/document removal retires the source while preserving revisions and longitudinal history; remediation performs one targeted regeneration of missing required pieces before failing; an empty concept-extraction payload is schema-legal (thin sections may yield nothing); and small fixture documents in several suites grew to realistic section sizes required by size-aware extraction budgets.

Application and integration tests use the fake provider by default. Hy3 provider-contract tests inject a mocked `fetch`; ordinary automated tests and CI never require or contact the real Hy3 API.

The B3 Curriculum latency regression suite also reconstructs provider requests without network access. It asserts deterministic section-size reporting, bounded candidate selection for large documents, predecessor/neighbor retention, lexical fallback widening, compact evidence-key resolution, full local binding preservation, omission of manifest/revision/hash internals from the prompt, the 16000-token output ceiling, one-attempt timeout telemetry with no synthetic usage row, accepted-Curriculum preservation, safe learner copy, cancellation, and the shared original-plus-one-repair ceiling. The affected 277-block Course measured 288059 characters / 345831 UTF-8 bytes and 551 visible offers before compaction, versus 41218 characters / 55681 bytes and 204 offers across 148 blocks afterward. Selection still starts from the complete 551-offer exact local catalog; validation accepts only the compact operation-local IDs actually offered to Hy3 and resolves each through its retained full binding. These are offline request-shape results; exactly one controlled human retry is required to observe real post-fix latency.

The Curriculum execution-contract regressions use real-provider-shaped payloads whose Concept and canonical arrays are empty. They prove exact deterministic Concept/canonical derivation, rejection of unknown provider-selected Concepts, an executable remediation frontier, fail-closed empty-frontier successors, accepted-predecessor preservation across rejected intermediate versions, acceptance-time Concept disappearance, dynamic `canAcceptCurriculum`, and Fake/real semantic parity. The same focused run includes the B2 exact evidence-identity and B3 bounded-context cases plus the unchanged StudyPlan preflight suite. The web run proves learner-safe Chinese coverage warnings and execution-remediation diagnostics without exposing raw `Unmapped source blocks...` or `StudyPlan execution repair...` text. All are offline and must not contact Hy3.

The recovery-orchestration regressions add the missing B5 boundary. They cover zero Concepts, stale-revision Concepts, invalid exact grounding, valid current grounding, canonical membership counts, capability suppression, direct-command failure before provider attempts, accepted-history immutability, transition to successor review only after unchanged StudyPlan preflight, and repeated impossible commands without provider retry. Shared schema tests validate the structured recovery and coverage-warning read models. Web tests prove Home and Curriculum route to the existing Concept flow, opening Explore performs GETs only, readiness refresh occurs only after explicit extraction, workspace identity fences late refreshes, and historical raw English warnings remain hidden from the primary learner UI while available under technical disclosure. These tests use Fake or mocked providers only.

The B6 Contract-scope regressions separate learner intent from revision-bound execution state. They keep the accepted Contract current across same-Material reprocessing, parser/fingerprint changes, Concept/graph/Curriculum changes, pending role proposals, and confirmed same-role successors. They fail closed for logical Material retirement/replacement and a confirmed semantic-role change, expose matching structured overview/API state, suppress both Curriculum and StudyPlan provider calls, and preserve accepted Contract history. Shared tests reject inconsistent readiness state/issue combinations. Web tests route valid-scope B5 recovery to Concept extraction without opening the Contract editor, route genuine role changes to Chinese reconfirmation copy, select the latest confirmed role beneath a pending proposal, replace raw stale-predecessor diagnostics, and retain established operation-owned error behavior. All coverage is in-memory or uses mocked/Fake providers; it makes no real Hy3 request.

## End-to-end smoke workflows

The in-process fake-provider smoke is self-contained:

```bash
npm run build
npm run demo:offline
```

The HTTP scripts require a running fake-provider server in another terminal:

```bash
npm run dev:server
```

Then run:

```bash
npm run demo:http
npm run demo:graph
npm run demo:adaptive
```

The graph and adaptive scripts print IDs that can be checked after a server restart:

```bash
node scripts/smoke-graph.mjs verify <workspaceId> <conceptId>
node scripts/smoke-adaptive.mjs verify <workspaceId> <conceptId> <runId>
```

The restart checks verify persisted documents, active graph data, learner state, accepted plans, canonical alignment, misconception/review state, daily-queue data, and completed Tutor runs. The Phase 3 StudySession endpoints additionally persist detail, events, exchanges, and summaries for reload after an interrupted or detached client. The server integration suite, rather than these observational smoke scripts, proves the reachable reserve -> sent -> restart -> identical-retry sequence and the corresponding logical/physical attempt accounting.

`demo:http` is a lightweight observational smoke script. It fails on HTTP errors, but some displayed booleans and remediation counts are logs rather than strict assertions. Use the Vitest suite, `eval:fake`, and the graph/adaptive workflows for invariant claims; do not treat `ALL FLOWS OK` by itself as proof that every logged semantic condition passed.

## Migration verification

The server suite covers all 19 migrations directly: applying them from scratch and re-running them safely;
- populated v1 -> current migration without deleting source, quiz, grading, mistake, mastery, or history rows;
- honest `unknown` origin for workspaces whose historical creation path cannot be reconstructed;
- populated v3 -> current migration, including the SQLite quiz-table rebuild;
- nullable provider/state-change fields for historical completed attempts, without fabricated backfill;
- foreign-key integrity and re-enablement after table rebuilds;
- all-or-nothing rollback after a forced migration failure; and
- conservative legacy migration behavior plus current material/document retirement and explicit workspace-deletion behavior.

Route and repository tests add transaction, cascade, cross-workspace isolation, legacy request compatibility, and historical-result degradation coverage. Migration 12 (`concept_lessons`) is additive; a direct populated-v11 regression verifies that migration 12 creates the lesson table without changing an existing concept row. Migrations 13-14 verify honest revision-1 adoption without invented fingerprints, preservation of existing learning history, active-revision foreign keys, source-authority separation, operation idempotency/fencing/orphan recovery, and optional cost-policy persistence. Migration 15 verifies the accepted Course route and revalidation after source revision. Migration 16 verifies durable StudySession persistence and Agenda mutation invariants. Migration 17 verifies formal evidence, progression, replan, and goal-outcome persistence. Migration 18 rebuilds the telemetry call/attempt/usage foreign-key chain, permits workspace-less probes and nullable non-agent fencing, preserves populated v17 rows, and backfills historical provider generation as unknown (`NULL`) rather than inventing a value. Migration 19 forward-repairs databases that may already report v18 with either the canonical nullable column or an interim `NOT NULL DEFAULT 1` column. Both paths converge on the nullable, no-default schema without losing calls, attempts, or usage. The interim backfill and a genuine observed generation 1 have no reliable row-level discriminator: telemetry timestamps use an injectable application clock, while migration time uses the wall clock. Compatibility tests therefore prove that v19 preserves ambiguous values instead of guessing, while canonical-v18 `NULL` remains unknown and future unknown values can again be stored as `NULL`. A real pre-upgrade database copy was also migrated v11 -> v12 during upgrade verification with clean foreign keys, intact history, and an honest deterministic adjustment when launching a pre-upgrade Tutor recommendation.

## Real Hy3 evaluation

The optional real-provider suite is intentionally separate from tests and CI:

```bash
npm run build
HY3_BASE_URL=... HY3_API_KEY=... HY3_MODEL=... npm run eval:hy3
```

On PowerShell, set those values in the environment or a local `.env` before running the command. Missing credentials cause a non-zero exit; there is no fake-provider fallback path.

The suite runs the six original operations plus two optional upgrade operations: `semantic_recall` (section-aware extraction of the long fixture against hand-authored must-find labels) and `lesson_generation`. A 2026-08-09 local run of the extended suite completed 8/8 operations without schema/grounding failures: semantic recall was 7/8 (87.5%) with 7/7 extracted concepts grounded, and lesson anchors verified 3/3 on the first pass. These are small-fixture diagnostics, not teaching-quality or human-study claims. The raw report stays gitignored, and the COMMITTED sanitized evidence below remains the six-operation record of the tagged release — it was intentionally not regenerated.

The raw Markdown/JSON reports are written under ignored `eval/reports/`. They include run provenance and per-operation detail and must not be committed. See [eval/README.md](../eval/README.md) for the schema, metrics, and fail-closed publication rules.

## Published online evidence

The repository publishes a sanitized pair derived from a successful raw report:

- [hy3-online-verification.md](evidence/hy3-online-verification.md), for reviewers;
- [hy3-online-verification.json](evidence/hy3-online-verification.json), for machine-readable sanitized aggregates.

The committed record reports 6/6 successful operations, nine requests, one bounded schema-repair request, 43.6 seconds of provider latency, 4/4 and 3/3 proposed concepts passing exact-quote grounding across two fixture documents, agreement on one comparable alignment decision, agreement on three grading samples, 2/2 truly cross-document assessment items, and a valid first Tutor action.

Publication is fail-closed. `npm run eval:evidence` rejects:

- the wrong suite, a non-`hy3` provider, or any fake fallback;
- missing Git provenance or a dirty evaluation worktree;
- failed, skipped, duplicate, missing, or unknown operations;
- no comparable alignment, no truly cross-document item, or an invalid Tutor first step; and
- any derived JSON/Markdown that triggers the credential, URL-credential, token, or local-path scanner.

The exporter keeps only whitelisted aggregate fields. Per-sample details, prompts, raw model output, credentials, endpoint paths/query strings, and local paths never enter the public record. `publishedEvidence.test.ts` verifies that the Markdown is rendered from the same JSON object and that the committed pair remains provenance-complete and secret-free.

Do not rerun `eval:hy3` during ordinary tests or documentation maintenance. Do not rerun `eval:evidence` merely as a read-only check: it is a publication command and intentionally writes tracked artifacts with a new generation timestamp.

## Media verification

The reviewer assets are:

- seven PNG screenshots, each 2560x1600;
- one H.264 MP4, 1920x1200 at 30 fps;
- no audio stream; and
- duration 113.066667 seconds (1:53.07), below the two-minute Issue #4 limit.

The README captions map the screenshots to PDF provenance, graph evidence, bounded tutoring, assessment/state changes, semantic grading, resolved remediation, and persistent learning progress. The video and screenshots are repository files rather than external embeds, so the tagged release retains them.

## Evidence-to-requirement matrix

| Issue #4 claim | Implementation | Reviewer evidence | Automated evidence |
| --- | --- | --- | --- |
| Hy3 powers production semantic workflows | [`hy3Provider.ts`](../apps/server/src/llm/hy3Provider.ts), [`provider.ts`](../apps/server/src/llm/provider.ts) | [Online verification](evidence/hy3-online-verification.md), [demo](assets/hy3-study-clinic-demo.mp4) | [`hy3Provider.test.ts`](../apps/server/src/llm/hy3Provider.test.ts), [`flows.test.ts`](../apps/server/src/routes/flows.test.ts) |
| Interactive web frontend | [`App.tsx`](../apps/web/src/App.tsx), [`views/`](../apps/web/src/views) | Seven screenshots and the final demo | [`App.test.tsx`](../apps/web/src/App.test.tsx) and focused view/component suites |
| Page/section source provenance | [`documents.ts`](../apps/server/src/ingestion/documents.ts), [`verify.ts`](../apps/server/src/grounding/verify.ts) | [Screenshot 01](assets/01-pdf-page-evidence.png) | [`documents.test.ts`](../apps/server/src/ingestion/documents.test.ts), [`verify.test.ts`](../apps/server/src/grounding/verify.test.ts) |
| Locally validated concept graph | [`graph.ts`](../apps/server/src/services/graph.ts), [`validate.ts`](../apps/server/src/graph/validate.ts) | [Screenshot 02](assets/02-learning-graph-evidence.png) | Graph validator, service, route, and frontend graph suites |
| Bounded graph-grounded Tutor | [`tutor.ts`](../apps/server/src/services/tutor.ts), [`tools.ts`](../apps/server/src/tutor/tools.ts) | [Screenshot 03](assets/03-hy3-graph-tutoring.png) | [`tutor.test.ts`](../apps/server/src/services/tutor.test.ts), [`tools.test.ts`](../apps/server/src/tutor/tools.test.ts) |
| Hybrid deterministic/semantic grading | [`grading.ts`](../apps/server/src/services/grading.ts), [`score.ts`](../apps/server/src/grading/score.ts) | [Screenshots 04](assets/04-assessment-result-overview.png) and [05](assets/05-hy3-rubric-grading.png) | Score, rubric-alignment, flow, and results-view suites |
| Mistake-remediation loop | [`remediation.ts`](../apps/server/src/services/remediation.ts), [`grading.ts`](../apps/server/src/services/grading.ts) | [Screenshot 06](assets/06-remediation-resolved.png) | Flow, remediation, service, and repository tests |
| Persistent learner state | [`database.ts`](../apps/server/src/db/database.ts), [`study.ts`](../apps/server/src/routes/study.ts) | [Screenshot 07](assets/07-learning-progress.png) | Repository, migration, flow, history, misconception, and review tests |
| Reproducible open-source delivery | [`package.json`](../package.json), [`.env.example`](../.env.example), [`ci.yml`](../.github/workflows/ci.yml) | Final Release, tag, PR, and this document | Full offline suite and three-platform CI matrix |

## Honest scope

- A successful Settings **Check Local Service Status** proves only that local `/api/health` and `/api/config` responded. The separate external connection action is user-triggered; campaign verification uses Fake mode and never calls the real Hy3 API.
- Curriculum disclosure tests prove bounded initial rendering, accessibility state, and semantic labels. They do not benchmark scan time, teaching quality, or performance for every possible hierarchy shape.
- The small hand-authored labels and fixtures make the online record an integration check, not a quality benchmark.
- Exact quotation validation proves location, not complete semantic entailment.
- `eval:fake` checks deterministic boundaries and state invariants, not the pedagogical quality of generated content.
- Real-provider latency and output depend on the configured endpoint and model.
- The current automated suite is broad but is not a formal proof of security, psychometric validity, or perfect PDF reconstruction.
