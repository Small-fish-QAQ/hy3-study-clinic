# Hy3 Study Clinic

[![CI](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml/badge.svg)](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Hy3 Study Clinic turns a learner's course documents into a **verifiable personal learning graph** and closes the loop from **diagnostic weakness to grounded remediation and persistent learning progress**. It supports pasted text, Markdown, TXT, PDF, and DOCX inside multi-document course workspaces.

Hy3 performs the semantic work: concept extraction, grounded question generation, semantic rubric grading, relationship and alignment proposals, misconception hypotheses, and bounded tutoring decisions. Deterministic local code validates citations and IDs, computes scores, controls every learning-state transition, and persists the accepted result in SQLite. The model never directly changes mastery, closes mistakes, accepts alignments, sets review dates, or deletes history.

## Product status

### Implemented current product

Hy3 Study Clinic now supports both the original graph-led learning workflows and an evidence-gated course-execution loop. Implemented behavior includes document workspaces, immutable material revisions, SourceBlocks, concepts, graph exploration, grounded lessons and assessments, mistakes, mastery, misconceptions, review scheduling, learner-confirmed Contracts, Curricula, accepted StudyPlans, SessionAgendas, StudySessions, formal progression, and bounded replanning. The graph remains useful supporting infrastructure; Course Home, Study Session, Curriculum, Progress, and Explore are the learner-facing course workflow.

### Agent architecture implementation status

Phases 1-4 of the Learning Execution Agent are implemented. Phase 1 provides material-revision lineage, independent source/premise authority, idempotent fenced operations, and durable model-call telemetry. Phase 2 adds learner-confirmed Contracts, validated Curriculum and StudyPlan proposals, atomic accepted-route activation, and SessionAgenda composition. Phase 3 adds durable StudySessions, bounded Tutor context, transcript events, pause/resume/stop, and learner-controlled detours. Phase 4 adds formal-evidence reconciliation, progression state, deterministic replan triggers, successor-plan proposals, and goal outcomes. The authoritative [Learning Execution Agent Product Design](docs/STUDY_CLINIC_AGENT_PRODUCT_DESIGN.md) remains the source for future scope: its Phase 5 work is conditional on the required product/dogfood gate and separate authorization.

## Reviewer quick links

- **[Watch the final demo](docs/assets/hy3-study-clinic-demo.mp4)**: 1:53, silent H.264 MP4, 1920x1200.
- **[Review the real Hy3 online-verification record](docs/evidence/hy3-online-verification.md)**: sanitized, commit-pinned aggregates from the complete six-operation `eval:hy3` suite.
- **[Read the architecture and trust boundaries](docs/ARCHITECTURE.md)**.
- **[Reproduce the verification results](docs/VERIFICATION.md)**.
- **[Review the authoritative next-product design](docs/STUDY_CLINIC_AGENT_PRODUCT_DESIGN.md)** and **[project evolution](docs/PROJECT_EVOLUTION.md)**; both clearly distinguish design from implemented behavior.
- **[Inspect the final tagged release](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/issue-4-final)** and **[upstream submission PR #77](https://github.com/Tencent-Hunyuan/Hy3/pull/77)**.

The immutable `issue-4-final` tag points to `c67ac6d`. The real-provider evaluation ran from its direct parent, clean commit `46d34f2`; the tagged child publishes only the sanitized record, its regression guard, and documentation. Later main commits contain the separately identified post-award improvements and next-product design; they do not move or reinterpret that historical checkpoint.

## Demo

[![Personal learning graph with locally verified source evidence](docs/assets/02-learning-graph-evidence.png)](docs/assets/hy3-study-clinic-demo.mp4)

**[Watch the full demo video (1:53, silent MP4)](docs/assets/hy3-study-clinic-demo.mp4)**

The video follows one continuous learning journey:

course material -> document import with provenance -> Hy3 concept extraction -> locally validated personal learning graph -> evidence inspection -> diagnostic assessment -> deterministic objective grading plus Hy3 semantic grading -> mistake notebook -> targeted remediation -> score improvement from 81 to 100 -> mistake resolution -> persistent mastery update -> graph-grounded Hy3 tutoring.

The same workflows run offline with the fake provider through `npm run demo:graph` and `npm run demo:adaptive`.

## Product workflow

### Course materials to a verifiable learning graph

1. Create a course workspace and add one or more documents. PDF/DOCX parsing preserves stable source blocks, character offsets, heading paths, and PDF page ranges.
2. Hy3 extracts concepts section by section along a deterministic document outline (with a synthetic-window fallback for weak headings), under size-aware budgets — a thin section may honestly yield nothing, and long documents are no longer compressed into one 3-8-concept pass. Every concept carries `(blockId, exact quote)` evidence, and 资料映射 shows which sections are mapped, with per-section additive deepening that never regenerates existing concept ids.
3. Deterministic candidate generation and bounded Hy3 proposals align equivalent concepts across documents. Only exact normalized aliases are auto-accepted; semantic merges require learner review.
4. Hy3 proposes typed graph relations from a controlled vocabulary: `prerequisite`, `part_of`, `contrasts_with`, `causes`, `applies_to`, and `example_of`.
5. Local validation rejects unknown concepts, cross-workspace references, invalid relations, fabricated evidence, duplicates, and prerequisite/part-of cycles before a versioned graph is persisted.
6. The learner explores network, dependency, and weak-path views, with mastery, mistakes, and review state overlaid on canonical concepts. Every accepted concept and edge remains traceable to source evidence.
7. Each concept can open a 讲解 lesson card: typed teaching sections (explanation, intuition, worked example, misconception warnings, contrasts, applications) whose provenance is decided per segment by the server — verified course quotes are labeled 课程资料/本地已验证, everything else is honestly labeled AI 辅助讲解(非资料原文) and never becomes grading evidence. Where the course text differs from the common presentation, the conflict is shown with a verified quote and the source wins.

Failed graph, plan, or lesson generation never overwrites the last valid version.

### Diagnostic weakness to verified remediation

1. A workspace diagnostic assessment uses validated question blueprints. A question marked cross-document must have verified evidence from at least two documents.
2. Objective answers are graded locally. Hy3 classifies short-answer rubric coverage, while local code recomputes the awarded score from required-point coverage.
3. Low scores create open mistakes. A substantive wrong answer may create a tentative misconception hypothesis, but only later discriminating answers can confirm, reject, or resolve it.
4. Remediation re-tests at most three concepts with open mistakes. A correct remediation answer resolves exactly the linked source mistakes. A round missing a required grounded question piece gets ONE targeted regeneration of only the missing pieces before failing honestly.
5. Local rules update historical mastery and a separate FSRS-style review schedule. Grading applies its complete learner-state write set in one transaction; duplicate or concurrent submissions of the same quiz apply state at most once (409), and a stale pending quiz whose required concepts are no longer available is rejected with zero state change.
6. A bounded Tutor session can inspect only whitelisted, read-only workspace state. The Tutor is offered only activity modes that are executable in the current state; its recommendation is validated at completion (deterministically downgraded with a visible timeline note when preconditions fail) and launched server-side with launch-time revalidation — every 开始 button the product shows corresponds to an activity that actually starts. The daily queue works the same way, and after remediation it advances into unassessed concepts so newly extracted content is reachable.

Completed quizzes are retained as immutable, read-only history. Opening a historical result never regenerates, regrades, or reapplies learning-state changes.

Removing a material from the active course normally retires its stable logical identity rather than deleting its revisions, source provenance, assessments, or longitudinal learner history. Retired material is hidden from active material lists and can force route revalidation. Explicit workspace deletion is the separate destructive operation and may cascade the workspace's course data.

### Accepted course execution

1. The learner confirms a versioned Learning Contract over stable logical materials and role assignments. Material revisions and source blocks are execution identities, not Contract scope.
2. Hy3 may propose a Curriculum and StudyPlan, but local code validates known IDs, source evidence, manifest freshness, route coverage, feasibility, authority eligibility, and launchability. The learner accepts or rejects consequential candidates.
3. Acceptance atomically installs one compatible Contract, Curriculum, StudyPlan, and SessionAgenda route. A failed or rejected successor leaves the prior accepted route intact.
4. A StudySession persists Tutor turns, exchanges, summaries, route-stack frames, and agenda edits. Pause, resume, and stop change execution state without rewriting the accepted StudyPlan snapshot or pointer.
5. Conversation is not formal evidence. Formal assessments and deterministic reconciliation alone can advance objective and unit progression; replan candidates remain proposals until learner acceptance.

## Evidence

The seven screenshots use the Chinese-language interface shown in the final demo. Their captions state only what is visible and what the local validation pipeline establishes.

### Materials and provenance

![PDF concept evidence with page-level provenance](docs/assets/01-pdf-page-evidence.png)

_A PDF imported through the material library. The expanded source-evidence panel identifies the document, section, and page and displays the exact verified quotation._

![Personal learning graph with a selected concept, typed relationships, and locally verified source evidence](docs/assets/02-learning-graph-evidence.png)

_The personal learning graph with a selected concept, typed relationships, and a source quotation marked locally verified. The active graph contains only proposals that passed local ID, relation, evidence, deduplication, and cycle checks._

### Graph-grounded tutoring

![Bounded Hy3 Tutor session inspecting learning state, graph context, and a prerequisite path](docs/assets/03-hy3-graph-tutoring.png)

_A completed bounded Tutor session. Its safe timeline shows read-only inspection of learning state, concept context, graph neighborhood, and prerequisite path before a `prerequisite_repair` plan is accepted and made launchable._

### Assessment and Hy3 grading

![Diagnostic assessment result showing an 81-point score and deterministic learner-state changes](docs/assets/04-assessment-result-overview.png)

_An 81-point diagnostic result with the locally composed learning-state-change summary: mistake creation, mastery movement, and review scheduling._

![Hy3 short-answer grading with per-rubric-point coverage, confidence, feedback, and evidence](docs/assets/05-hy3-rubric-grading.png)

_Hy3 semantic grading reports per-rubric-point coverage, confidence, and feedback. The displayed 1.5/2 award is computed locally from validated rubric coverage, and the supporting source quotations remain visible._

### Remediation and persistent learner state

![Mistake notebook showing a previously open RAG mistake marked resolved after remediation](docs/assets/06-remediation-resolved.png)

_The previously open RAG mistake is marked resolved after a linked remediation answer is graded correct. The model cannot close mistakes._

![Learning-progress view separating the recent score from historical weighted mastery](docs/assets/07-learning-progress.png)

_The learning-progress view keeps the latest score separate from historical weighted mastery and displays the transparent local update formula._

### Real Hy3 online verification

The repository also publishes [human-readable](docs/evidence/hy3-online-verification.md) and [machine-readable sanitized aggregates](docs/evidence/hy3-online-verification.json) generated from a gitignored real-provider report. The record binds the run to clean commit `46d34f2` and records:

- provider `hy3`, configured model, endpoint hostname, runtime, and timestamps;
- 6/6 successful evaluation operations across nine requests, including one bounded schema-repair request;
- 4/4 and 3/3 proposed concepts passed exact-quote grounding across two fixture documents;
- alignment and grading agreement against small hand-authored labels;
- 2/2 assessment items with verified evidence spanning multiple documents; and
- a Tutor first step inside the controlled action vocabulary.

This is integration evidence, not a benchmark. Exact quotation validation proves the cited text exists at the claimed source position; it does not independently prove complete semantic entailment.

## Responsibility boundary

| Hy3 proposes | Deterministic local code owns |
| --- | --- |
| Grounded concepts | Ingestion, source blocks, offsets, page/section provenance |
| Standard and remediation questions | Request/domain schemas and answer stripping |
| Short-answer rubric coverage and feedback | Objective answers, required-point score arithmetic, totals |
| Typed graph relations | Known IDs, relation vocabulary, evidence, cycles, version acceptance |
| Cross-document alignments | Candidate bounds, exact-alias rule, review decisions, canonical persistence |
| Assessment blueprints and misconception hypotheses | Evidence-derived scope, lifecycle transitions, persistence |
| Lesson-card teaching content and conflict claims | Segment-level provenance (verified anchors vs labeled AI teaching), conflict-quote verification, assessment isolation |
| Remediation and Tutor plans | Tool execution, budgets, plan validation, activity launchability + launch |
| Semantic rationales | Mistakes, mastery, review scheduling, permissions, all final mutations |
| Curriculum and StudyPlan proposals | Contract scope, source-manifest freshness, hierarchy, coverage, feasibility, launchability, route activation |
| Tutor turns and StudySession summaries | Persistent transcript/event lifecycle, route version checks, pause/resume/stop, formal-evidence separation |
| Replan suggestions | Trigger qualification, successor lineage, learner decision, atomic route replacement |

All important real-provider output uses runtime-validated structured contracts. Important output is never extracted with ad hoc regular expressions. A schema/JSON failure receives at most one bounded repair request; grounding failures remain failures.

## Getting started

### Requirements

- Node.js 20 or newer (`.nvmrc` selects 20; CI also verifies Node 24).
- npm.
- No Docker, network connection, or API key for the default fake-provider mode.

Windows PowerShell:

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Unix-like shells:

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to Fastify at `http://127.0.0.1:8787`.

### Provider modes

`LLM_PROVIDER=fake` is the default. It is offline and shares the real provider's validated contracts. The complete workflow can be repeated offline, but regenerated IDs and state mean generated content and order may vary between runs; byte-identical output is not promised.

For the real API, set the server-side variables in `.env`:

```dotenv
LLM_PROVIDER=hy3
HY3_BASE_URL=https://your-hy3-endpoint.example.com/v1
HY3_API_KEY=your-own-key
HY3_MODEL=your-model-name
```

`HY3_BASE_URL`, `HY3_API_KEY`, and `HY3_MODEL` are required in `hy3` mode. The repository provides no default endpoint, model, or credential. `HY3_TIMEOUT_MS` defaults to 30000 ms. See [`.env.example`](.env.example) for the complete contract, including server and database settings.

### Main commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build shared code and run the API and web development servers. |
| `npm run build` | Type-check and build every workspace. |
| `npm run lint` | Run ESLint and the Prettier check. |
| `npm test` | Build shared code and run all workspace tests. |
| `npm run demo:offline` | Run the original flows in process with the fake provider. |
| `npm run demo:http` | Exercise the original HTTP flows against a running server. |
| `npm run demo:graph` | Exercise the document -> graph -> overlay -> plan -> remediation workflow. |
| `npm run demo:adaptive` | Exercise alignment -> assessment -> Tutor -> learner-state -> daily-queue workflow. |
| `npm run eval:fake` | Run the deterministic offline structural evaluation and write ignored reports. |
| `npm run eval:hy3` | Run the optional real-provider evaluation; explicit credentials are mandatory. |
| `npm run eval:evidence` | Publish sanitized evidence from a successful real-provider report. |

The full command matrix, restart checks, evidence-publication rules, and test inventory are in [Verification](docs/VERIFICATION.md). Real-provider evaluation details are in [eval/README.md](eval/README.md).

## Architecture

```text
apps/web (React + Vite)
        | /api JSON and NDJSON Tutor events
        v
apps/server (Fastify)
        |-- ingestion, grounding, deterministic domain services
        |-- SQLite repositories and numbered migrations
        `-- provider boundary --> Hy3-compatible API or Fake Provider

packages/shared -- Zod schemas, domain types, payloads, and deterministic utilities
```

The browser never calls Hy3 directly. SQLite holds course workspaces, logical materials and immutable revisions, source blocks, source authority, Contracts, Curricula, StudyPlans, SessionAgendas, StudySessions, formal progression records, graph versions, assessments, completed attempts, mistakes, mastery, misconception hypotheses, review events, operations, and model-call telemetry. The browser retains only lightweight selection and graph-position preferences.

See [Architecture & Design Notes](docs/ARCHITECTURE.md) for request lifecycles, grounding rules, all 17 migrations, document deletion/reprocessing behavior, accepted-route lifecycle, formal progression, graph routing, provider contracts, learner-state machines, cancellation, and dependency rationale. It documents implemented current behavior; the authoritative design separately identifies the gated Phase 5 work that remains future scope.

## Verification summary

The immutable `issue-4-final` tag has a historical verification record. Current test files and test totals are intentionally not duplicated here because they change as the implementation evolves. Run the commands in [Verification](docs/VERIFICATION.md) against the checked-out revision for current results.

CI runs build, lint, and tests on Ubuntu Node 20, Ubuntu Node 24, and Windows Node 24. `eval:fake` exercises deterministic structural boundaries, including activity executability, grading state safety, semantic-recall fixtures, and lesson provenance. See [Verification](docs/VERIFICATION.md) for exact commands, migration/integration coverage, the evidence-to-requirement matrix, and the limits of each smoke script. The human product/dogfood protocol is maintained separately in [docs/DOGFOOD.md](docs/DOGFOOD.md).

Tests never call the real Hy3 API.

## CodeBuddy collaboration

CodeBuddy Code, connected to Hy3 through Tencent Cloud TokenHub, performed a focused accessibility and regression review of the source-evidence disclosure. Its accepted contribution was limited to [`SourceEvidencePanel.test.tsx`](apps/web/src/components/SourceEvidencePanel.test.tsx):

- correcting a test that retained a detached DOM reference after conditional rendering;
- adding Enter and Space keyboard-interaction coverage; and
- covering the fallback for unavailable cited source blocks.

CodeBuddy confirmed, but did not author, the component's existing native button semantics, `aria-expanded`, `aria-controls`, and stable panel ID. It did not stage, commit, or push files.

## Limitations

- PDF import requires an embedded text layer; there is no OCR. Complex multi-column layouts, rotated text, diagrams, and image text are not reconstructed. DOCX provenance has section headings but no page numbers.
- Exact-quote verification establishes location, not semantic entailment. Strict grounding may reject otherwise schema-valid output.
- 资料映射 reports structural mapping and anchor coverage, never semantic course coverage: a mapped section may still contain uncaptured ideas. Section budgets and the 40-concepts-per-document ceiling bound extraction depth.
- Lesson cards may teach beyond the uploaded text; such segments are explicitly labeled AI 辅助讲解(非资料原文), are never grading evidence, and their factual quality depends on the configured model.
- Mastery and review scheduling are transparent local heuristics, not calibrated cognitive diagnoses. Misconception records remain hypotheses until graded evidence changes their state.
- Semantic alignment can be wrong and has no unmerge operation; source concepts and history remain intact underneath.
- Tutor context, graph generation, assessments, remediation, history, and retrieval are deliberately bounded. Dense graph layouts can retain crossings, and lexical retrieval can miss synonyms.
- Material/document retirement is non-destructive to immutable revisions, source provenance, assessments, and longitudinal learning history, but there is no automatic unretire operation. Reprocessing stages and activates an immutable extraction revision while retaining earlier source artifacts and history; failed parsing leaves the prior active revision unchanged. Explicit workspace deletion is irreversible and has no recycle bin.
- The fake evaluation checks structure and safety boundaries, not teaching quality. The real evaluation uses small fixtures and depends on the configured model/API.

Detailed format, graph, history, scheduling, and parser limitations are documented beside their implementation in [Architecture & Design Notes](docs/ARCHITECTURE.md).

## License

[Apache-2.0](LICENSE). The built-in Chinese sample course and evaluation fixtures are original repository content released under the same license.
