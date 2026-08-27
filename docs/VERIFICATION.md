# Verification and Reviewer Evidence

This document is the reproducibility companion to the [Hy3 Study Clinic README](../README.md).
It keeps current commands, evidence boundaries, and the competition requirements visible without
turning historical implementation logs into current claims.

## Standard verification

Use Node.js 20.9 or newer from the repository root:

```bash
npm ci
npm run build
npm run lint
npm test
npm run eval:fake
npx prettier --check .
git diff --check
```

The root commands run the existing workspaces:

- `npm run build` builds shared and server TypeScript and the web TypeScript/Vite bundle.
- `npm run lint` runs ESLint and the repository Prettier check.
- `npm test` builds shared code and runs every shared, server, and web Vitest suite.
- `npm run eval:fake` runs the real server in process with in-memory SQLite and the deterministic Fake provider.
- `npx prettier --check .` is the direct formatting gate; `git diff --check` catches whitespace errors.

Migration, repository, route, integration, and frontend coverage is included in the workspace test
suites; there is no second hidden verification command. Tests, CI, and Fake evaluation never call
the real Hy3 API. The optional external connection test and `npm run eval:hy3` require explicit
credentials and are never run implicitly.

## Current-state verification

Run the commands above against the checked-out revision. Do not copy historical test totals or
latency figures into a current claim.

`eval:fake` covers provenance retention; alignment validation and graph preservation;
cross-document assessment scope; Tutor iteration budgets and zero-state-on-failure; misconception
transitions; fixed-clock Review scheduling and its separation from mastery; retrieval bounds and
workspace isolation; prompt-injection fencing; mastery bounds and foreign-key integrity; activity
launchability; duplicate/stale grading safety; section-aware course-understanding fixtures;
lesson provenance; and the lesson-aware Tutor policy profile.

The focused suites below are useful when reviewing one boundary:

```bash
npm run test -w @hy3-clinic/shared -- src/domain/objectiveAuthoritySemanticSupport.test.ts src/domain/courseMap.test.ts src/domain/providerConfig.test.ts
npm run test -w @hy3-clinic/server -- src/services/curriculum.test.ts src/services/coursePreparation.test.ts src/services/teachingBriefPreparation.test.ts
npm run test -w @hy3-clinic/server -- src/services/formalProgression.test.ts src/services/visualPreparation.test.ts src/services/agentProviderRuntime.test.ts
npm run test -w @hy3-clinic/server -- src/routes/workspaces.test.ts src/routes/flows.test.ts src/app.test.ts
npm run test -w @hy3-clinic/web -- src/views/AgentCourseWorkspace.live01.test.tsx src/views/AgentCourseViews.test.tsx
npm run test -w @hy3-clinic/web -- src/views/KnowledgeMapView.test.tsx src/views/StudySessionView.test.tsx
```

These suites cover the current Course-centred route: immutable MaterialRevision provenance,
source/claim authority, learner-confirmed Contract, Curriculum and StudyPlan proposals, atomic
route activation, flexible SessionAgenda, durable StudySession pause/resume/stop and detours,
Teaching Brief provenance, non-credit Lesson/Practice/Tutor work, Formal Evidence and progression,
mistakes and Repair, FSRS Review state, semantic-support validation and recovery, cancellation,
idempotency, stale responses, and Course/document switching safety.

## End-to-end smoke workflows

The in-process smoke is self-contained:

```bash
npm run build
npm run demo:offline
```

For the HTTP smoke, start an isolated Fake server in one terminal:

```bash
AUTOMATION_EXPECT_PROVIDER=fake PROVIDER_CONFIG_PATH=./data/smoke-provider-config.json LLM_PROVIDER=fake VISUAL_PROVIDER=disabled npm run dev:server
```

Then, from another terminal:

```bash
npm run demo:http
npm run demo:graph
npm run demo:adaptive
```

The graph and adaptive scripts accept their documented `verify` arguments after a restart.
These scripts are observational smoke checks; invariant claims belong to Vitest and `eval:fake`.
The server-side provider-isolation tests prove that a Fake expectation and an enabled external
visual transport cannot coexist in guarded automation.

## Document and migration checks

Rich-document tests cover text-layer PDF, DOCX, PPTX, standalone PNG/JPEG/WebP assets, static HTML
snapshots, parser signatures, exact page/slide/heading provenance, immutable source revisions,
OOXML/XML safety, bounded input, and malformed/unsupported files. OCR, browser-perfect archiving,
semantic chart/equation interpretation, and spreadsheet support remain outside the current product.

Migration tests apply the numbered migrations from scratch, re-run them idempotently, upgrade
populated legacy databases conservatively, preserve source and learning history, re-enable foreign
keys, and verify all-or-nothing rollback. They also cover telemetry ownership, Review cutover,
visual derivation identity, formal progression, repair episodes, and StudySession recovery.

## Published online evidence

[docs/evidence/hy3-online-verification.md](evidence/hy3-online-verification.md) is a sanitized
real-provider record. **It is historical:** it was generated from an earlier commit, predates the
current Curriculum, Lesson, and semantic-support layers, and therefore does not exercise those
layers. It will be regenerated at a current commit before final submission. The paired JSON remains
byte-unchanged in this cleanup. The record’s generated metrics and “what this does not prove”
section are not hand-edited.

`eval:evidence` is a publication command for a deliberate credentialed run; it is not part of
ordinary offline verification. The exporter fails closed on dirty provenance, missing/unknown
operations, credential or local-path leakage, invalid schema, or non-Hy3 reports.

## Competition evaluation

The open-ended StudyEval harness, frozen corpus, and result tables are planned and not yet
implemented. The method specification, written level anchors, sample design, anti-circularity
controls, validity protocols, and runtime model are in [docs/EVALUATION.md](EVALUATION.md).
When implemented, its semantic-judging path will require explicit Hy3 credentials, while the
offline aggregation path will require none. Every such run sets `VISUAL_PROVIDER=disabled`.

The existing `npm run eval:hy3` command is a separate adapter evaluation, not a product-level
browser or human acceptance gate. It must be invoked explicitly with credentials and never runs
in tests or CI.

## Evidence-to-requirement matrix

The matrix is keyed to the official Task 1 requirements. Cells marked PLANNED are deliberately
not current claims.

| Requirement | Current implementation / source | Reviewer evidence | Status |
| --- | --- | --- | --- |
| S1–S5 scenario, user value, personal/activity-work framing | README, Course routes, workspace/material services | README, `docs/ARCHITECTURE.md`, `routes/workspaces.ts`, `routes/agentCourse.ts` | Implemented |
| A1–A3 substantive Hy3 semantic role | Hy3 provider contracts and Curriculum/Lesson/Assessment services | `apps/server/src/llm/hy3Provider.ts`, provider tests, historical online record (qualified above) | Implemented; current real-run refresh planned |
| E1–E5 open-ended evaluation method | StudyEval specification | [docs/EVALUATION.md](EVALUATION.md) | Method published; executable harness/corpus/results PLANNED before final submission |
| V1–V3 provenance, deterministic authority, and state auditability | Grounding, semantic-support, grading, progression, migrations | `apps/server/src/grounding`, `apps/server/src/services`, Vitest suites, `eval:fake` | Implemented |
| X1 limitations and failure analysis | Capability-boundary register and observed Hy3 patterns | [docs/LIMITATIONS.md](LIMITATIONS.md), private observations summarized there without frequencies | Implemented as limitation register |
| D1 competition model path | Hy3 is the only enabled model-capability path; visual adapter excluded | README provider boundary, ARCHITECTURE visual-provider paragraph, all evaluation runs require disabled visual provider | Implemented boundary |
| D2 evaluation method specification | Layer A/Layer B separation, seven dimensions, anchors, scorer protocols | [docs/EVALUATION.md](EVALUATION.md) | Published; harness PLANNED |
| D3 corpus and executable evaluator | Frozen cases, corpus hash, offline aggregation, credentialed semantic observation collection | No public corpus or result artifact yet | PLANNED for 8/31–9/5 |
| D4 proposal and analysis report | Scenario, architecture, method, limitations, schedule | [docs/PROJECT_PROPOSAL.md](PROJECT_PROPOSAL.md) | Published |
| D5 demonstration media | Current workflow demonstration | Obsolete media deleted; replacement recording is scheduled before final submission | PLANNED |

## Historical phase verification

Earlier implementation phases and their individual checks remain reproducible from Git history.
This current document intentionally keeps only the commands and boundaries needed to reproduce the
checked-out product; historical design and chronology are in [docs/HISTORY.md](HISTORY.md).
