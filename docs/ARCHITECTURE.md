# Architecture and Design Notes

This document expands the [Hy3 Study Clinic README](../README.md) for maintainers who need to understand or extend the system. It describes the shipped product, not a proposed rewrite.

## 1. System boundaries

```text
React/Vite client
      | JSON APIs and NDJSON Tutor events
      v
Fastify server
      |-- request and domain validation (Zod)
      |-- ingestion, grounding, grading, graph, and learning services
      |-- repositories and numbered SQLite migrations
      `-- LlmProvider
             |-- FakeProvider (offline development/tests)
             `-- Hy3Provider (OpenAI-compatible chat/completions)

packages/shared
      `-- runtime schemas, domain contracts, payload types, mastery utilities
```

There are three ownership rules:

1. Hy3 may propose semantic data, but it cannot accept its own output or mutate persistent learner state.
2. Local services validate schemas, IDs, evidence, scopes, budgets, and state transitions before repositories write anything.
3. Routes and React components coordinate transport and presentation; domain rules live in services, validators, repositories, and shared pure functions.

The browser never receives server-only answers/rubrics before grading and never calls Hy3 directly.

## 2. Request lifecycle

A standard quiz request illustrates the model boundary:

```text
POST /api/quizzes { materialId, config }
  |
  |-- validate request with QuizConfigSchema
  |     `-- invalid -> 400 VALIDATION_ERROR
  |
  |-- QuizService.generate
  |     |-- load the material and source blocks
  |     |-- analyze concepts first when none exist
  |     |-- provider.generateQuiz(wrapSourceBlocks(blocks), ...)
  |     |     `-- Hy3: fetch -> timeout/cancellation -> JSON extraction
  |     |               -> Zod validation -> at most one schema-repair request
  |     |-- assembleQuestions -> verifyGrounding for every candidate
  |     |     `-- no surviving question -> 422 GROUNDING_FAILED
  |     `-- compute offsets/points locally and persist transactionally
  |
  `-- toPublicQuiz removes answers and rubrics -> 201 { quiz }
```

Provider output must pass both runtime schema validation and downstream domain/grounding validation. A successful schema is necessary, not sufficient.

The same layering is used for graph generation, alignment, assessment blueprints, misconception hypotheses, remediation planning, and Tutor steps.

## 3. Exact-quote grounding

`apps/server/src/grounding/verify.ts` is the trust boundary between model-proposed evidence and stored evidence. A provider supplies only `(blockId, quote)`; local code owns location data.

1. Trim leading/trailing quote whitespace. This is the only textual normalization; there is no fuzzy matching.
2. Search the claimed block with exact string matching and compute UTF-16 offsets locally.
3. If the quote occurs more than once in that block, anchor the first occurrence and retain `occurrenceCount` so ambiguity remains visible.
4. If it is absent from the claimed block, re-anchor only when exactly one other eligible block contains exactly one occurrence; mark `reanchored: true`.
5. Reject zero, repeated cross-block, or otherwise ambiguous matches.

The server never trusts provider-supplied offsets, page numbers, or line numbers and never invents a quotation.

Exact quotation validation proves that text exists at the recorded source position. It does **not** independently establish the complete semantic truth or entailment of a concept, relation, explanation, hypothesis, or plan reason. The UI therefore distinguishes model proposals from locally verified source location.

Source blocks are wrapped with fresh request-specific delimiters and explicitly labelled untrusted data. Student answers are fenced for grading in the same way. This reduces injection risk but is not presented as a proof of prompt-injection immunity.

## 4. Provider contract

`LlmProvider` is a narrow interface with eleven methods shared by `FakeProvider` and `Hy3Provider`:

1. `analyzeConcepts`;
2. `generateQuiz`;
3. `gradeShortAnswer`;
4. `generateRemediation`;
5. `proposeGraphEdges`;
6. `proposeRemediationPlan`;
7. `proposeConceptAlignment`;
8. `proposeAssessment`;
9. `proposeMisconception`;
10. `proposeTutorStep`; and
11. `generateConceptLesson`.

Every method receives an optional `AbortSignal` and returns a Zod-validated payload. Implementations expose normalized `ProviderError` failures rather than raw transport errors.

### FakeProvider

The fake provider is offline and deterministic for identical inputs. It copies evidence verbatim from supplied blocks and uses content-hash seeds where ordering is required. A configurable delay supports loading/cancellation tests.

The complete workflow can be repeated offline, but this does not promise byte-identical output between runs. Workflows create new IDs and state, which can alter later inputs, selected weak concepts, and generated ordering. The guarantee is deterministic provider behavior for identical input plus deterministic local scoring and transition rules.

### Hy3Provider

The real adapter calls an OpenAI-compatible `chat/completions` endpoint. Base URL, model, key, and timeout come only from server environment configuration.

`Hy3Provider.complete` performs one initial request. If JSON extraction or Zod validation fails, it may make exactly one structured repair request containing the validation error. A second failure becomes `PROVIDER_INVALID_OUTPUT`. Transport errors, cancellation, timeout, and later evidence/domain rejection do not enter that repair loop.

Credentials remain server-side, authorization headers are redacted, and no configured endpoint/model/key is supplied by the repository.

### Browser Settings boundary

The system Settings surface does not introduce a second provider-configuration authority. `SettingsView` receives the current `fake | hy3` mode from the existing sanitized config response. Its **Test Connection** action concurrently requests `GET /api/health` and `GET /api/config` through one `AbortSignal`; cancellation and stale-result handling use the existing `useAsyncAction` contract. Success means only that the local Fastify server responded and disclosed its configured mode. It does not call `LlmProvider`, send an external request, validate credentials, or establish that the configured model is available.

There are deliberately no browser fields for base URL, model, API key, or token, and no secret or provider configuration is written to local storage. Changing `LLM_PROVIDER` or any `HY3_*` value requires changing the server environment and restarting the server. The only editable Settings value is the Course-sidebar default, which is frontend-owned presentation state; diagnostic/about information is read-only and progressively disclosed.

## 5. Grading and mastery

### Objective grading

`grading/score.ts` is deterministic:

- single choice requires exact option-ID equality;
- multiple choice requires exact set equality and gives no partial credit; and
- a blank short answer receives zero without a provider call.

Total awarded and possible points are calculated locally.

### Rubric contract

Each short-answer rubric point is classified as `required` or optional enrichment. Only information explicitly requested by the question, or necessary to answer it, can reduce the score.

The provider proposes classifications, but `grading/rubricAlignment.ts` validates them locally:

- unrequested evaluative aspects such as advantages, drawbacks, or comparisons are demoted to optional;
- an aspect explicitly requested by the stem is promoted to required;
- required points need source-evidence support;
- normalized duplicates are removed;
- an all-optional rubric is repaired to preserve legacy required semantics; and
- a rubric with no groundable required point is rejected.

Historical string-only rubric rows load as required points without a migration.

### Short-answer score

Hy3 reports full/partial/missing coverage, confidence, and feedback per rubric point. Local code computes the award from required points only:

```text
score = (full required + 0.5 * partial required) / required count
```

Optional enrichment has zero score-reducing weight. Provider confidence may set a review flag but never sets points. The shared status classifier uses the same required coverage: all required -> correct; at least 0.6 -> basically correct; greater than zero -> partially correct; zero -> needs reinforcement.

### Historical mastery

Mastery is a separate deterministic exponential moving average:

```text
m' = clamp01(m + 0.3 * (score - m))
```

Each concept starts at `0.5`. A service averages that concept's question scores once per submission before applying one update. SQLite also constrains stored mastery to `[0, 1]`. This is a product heuristic, not a cognitive diagnosis.

### Grading state safety

Grading is atomic and idempotent below the route layer:

1. every provider call — question grading and the bounded misconception proposals — completes FIRST and writes nothing;
2. one database transaction then applies the complete learner-state write set (submission, grading result, mistakes, mastery, misconception transitions and proposals, review scheduling, and the state-change snapshot);
3. inside that transaction the service re-checks two invariants: the quiz has no grading result yet (a duplicate or concurrent submission gets `409 DUPLICATE_SUBMISSION`; learner state is applied at most once), and every question's concept still exists (a stale pending quiz whose required concepts are no longer available is rejected with zero state mutation instead of dishonestly reporting success).

A mid-write failure rolls the whole set back; the quiz remains submittable after the fault clears.

### Concept extraction (section-aware, additive)

`ingestion/sections.ts` derives a deterministic section outline from the persisted blocks (no section table): consecutive blocks group at the first heading level that actually varies (`# 标题` + `## 小节` documents group at H2), undersized groups merge forward, oversized groups split at block boundaries, and documents without usable headings fall back to deterministic synthetic character windows — never a whole-document one-shot for long inputs.

`AnalysisService` extracts per section, sequentially and cancellably, with a size-aware UPPER bound per call (a thin section may legitimately produce zero concepts; nothing is padded to a minimum). Verified concepts are APPENDED per section, so a mid-run provider failure keeps every already-accepted section; failed sections are reported and retryable. A document small enough to be a single section keeps the legacy whole-document behavior. `MAX_CONCEPTS_PER_DOCUMENT` (40) is a visible safety ceiling — skipped sections are reported, never silently dropped. Section-targeted deepening (`POST /api/materials/:id/analyze` with `{section}`) appends deduplicated (normalized-key) concepts and NEVER modifies existing concept rows, so every id that quizzes, mistakes, mastery, graph edges, and alignment reference stays stable.

`GET /api/materials/:id/mapping` reports structural mapping only: per-section block/char counts, grounded-concept counts, and which blocks are cited by at least one verified anchor (concept groundings, active-graph edge evidence, lesson anchors). Mapping means "this section has at least one grounded concept" — it is NOT a claim of semantic course coverage, and the UI says so. Semantic recall is measured separately in the evaluation suite against hand-authored must-find labels.

## 6. Completed-attempt snapshots

A successful submission is an immutable snapshot across `quizzes/questions`, `submissions`, and `grading_results`: revealed questions/rubrics, learner answers, per-question grades, totals, provider, and deterministic `stateChanges`.

Migration 10 added nullable `provider` and `state_changes` fields to preserve response-only data for new attempts. `recordStateChanges` is write-once and does not overwrite a snapshot.

- `GET /api/workspaces/:id/attempts` returns the latest 50 attempts using deterministic `created_at DESC, id DESC` ordering.
- `GET /api/workspaces/:id/attempts/:attemptId` returns one workspace-scoped snapshot.
- Reads call no provider and update no mastery, mistakes, misconceptions, or review state.
- The React history view reuses `ResultsView` in read-only mode.

Historical attempts with null provider/state-change columns are labelled "not recorded" rather than reconstructed. When a cited source is retired or is no longer the active revision after reprocessing, replay retains the persisted quotation and labels the live source unavailable or stale.

Normal material/document retirement preserves document-scoped quiz history, grading, learner state, immutable revisions, and persisted quotations; current-source reads may label the source unavailable or stale. Explicit workspace deletion is the separate destructive path and cascades workspace-scoped history.

## 7. Mistake remediation

`services/remediation.ts` selects targets locally:

1. only concepts with currently open mistakes;
2. descending open-mistake count, with concept ID as a stable tie-breaker;
3. no more than three concepts per round; and
4. exactly one single-choice and one short-answer question per target, yielding 2-6 questions.

No open mistakes means generation is rejected and the UI action is disabled. When a round is missing a required grounded question piece, the service performs ONE bounded targeted retry — re-requesting only the incomplete targets and filling only the missing (concept, type) slots under the identical grounding validation — and fails honestly with structured details if pieces are still missing. The learning contract (one grounded single-choice plus one grounded short answer per target) is never weakened.

Each remediation question stores `sourceMistakeIds`. On grading, a correct answer resolves exactly those linked mistakes. An incorrect remediation answer can create a new open mistake. Resolved concepts do not re-enter remediation merely because historical mastery remains low.

Plan-launched remediation uses the same engine and rules, filtered to the accepted plan targets. There is no parallel grading or mistake lifecycle.

## 8. Document ingestion and provenance

The material library and workspace document endpoint share `createFromUpload`, so they use the same parser, limits, provenance, and errors.

### Inputs and limits

- Pasted text uses the text ingestion path.
- `.md`, `.txt`, `.pdf`, and `.docx` file uploads use base64 JSON and are limited to 10 MB after decoding.
- Every file is checked against its extension. PDF and DOCX also require matching magic bytes (`%PDF-` or ZIP `PK`); Markdown/TXT bytes pass a binary-content check instead.
- Invalid, oversized, malformed, and text-free inputs fail before the first database write.

Binary sniffing applies only to raw text-like bytes. Parsed PDF/DOCX text is sanitized instead, preventing valid documents with extractor artifacts from being misclassified as binary.

### PDF layout reconstruction

`pdfLayout.ts` uses positioned PDF.js text items from `unpdf` rather than flattening pages immediately. The deterministic stages are:

1. cluster baselines into stable visual lines;
2. derive body font size, line spacing, and right-margin statistics;
3. remove repeated page-margin headers/footers and bare page-number lines, while preserving heading-sized text;
4. infer heading tiers from font-size differences and emit Markdown headings;
5. repair evidence-supported visual wraps for CJK and Latin text, including hyphenation and line-fit constraints;
6. recover line-leading list bullets that some ToUnicode maps expose as U+0000;
7. insert ` | ` separators only for conservatively detected aligned table rows; and
8. return normalized text plus exact per-page character spans.

Paragraphs can cross a repaired page boundary, so blocks store `pageNumber` through nullable `pageEnd`. Image-only pages produce warnings; a document with no extractable text returns `PARSE_FAILED`. There is no OCR.

### DOCX conversion

`mammoth` converts DOCX XML into constrained HTML, and the local `docxHtmlToText` converter preserves heading/list/table text as Markdown-style input for the existing segmenter. Macros and scripts are not executed. Mammoth's default image conversion can read and encode embedded image data, but the local converter discards the resulting `<img>` output.

DOCX has heading-path provenance but no reliable page numbers.

### Parsed-text sanitation

Sanitation runs before offsets/page spans are finalized. It removes NUL and unsafe control artifacts, soft hyphens, noncharacters, stray BOMs, and unpaired surrogates; separator-like controls become newlines. Unambiguous Kangxi-radical variants are normalized back to unified ideographs so search and exact evidence validation use the same code points. CJK, emoji (including ZWJ sequences), ordinary punctuation, tabs, and newlines are preserved.

Every stored source block maintains:

```text
document.content.slice(block.startOffset, block.endOffset) === block.content
```

Blocks also carry stable content-derived IDs, heading paths, and optional PDF page ranges. Parser warnings/version, media type, filename, and page count are stored on the document. PDF/DOCX documents also retain their original upload bytes; text documents retain normalized content instead.

## 9. Workspace and document lifecycle

A workspace groups documents, source concepts, canonical concepts, graph versions, and accepted plans. Attempts, mistakes, and mastery remain keyed to their actual documents/concepts; workspace views aggregate them.

`workspaces.origin` is immutable creation provenance; it does not make ordinary document removal destructive:

- `manual`: explicitly created in the learning-graph UI. Retiring its final document preserves the empty workspace and its workspace-level history.
- `material_import`: auto-created for a material-library import. Retiring its final document also preserves the workspace and its history; the material is simply no longer active.
- `unknown`: pre-migration rows whose creation path cannot be reconstructed. They are conservatively preserved like manual workspaces.

Both document-removal endpoints retire the stable Material, preserve its revisions and longitudinal history, and return `{ workspaceId, workspaceDeleted: false }`, allowing the frontend to clear stale selections only after the server commits.

Explicit workspace deletion is available for every origin. After confirmation, `DELETE /api/workspaces/:id` cascades documents, blocks, concepts, graph data, quizzes/history, mistakes, mastery, alignments, misconceptions, review data, Tutor data, and blueprints in one transaction. A missing workspace is treated as already deleted by the UI.

Reprocessing reruns the current parser from stored original bytes for PDF/DOCX, or reruns text ingestion and segmentation from stored normalized content for pasted text, Markdown, and TXT. `materials.id` remains the stable logical identity. The service stages a new immutable `MaterialRevision` and revision-owned SourceBlocks, then activates it transactionally only after parsing and structural validation succeed. Earlier revisions, concepts, quizzes, attempts, mistakes, mastery, and other longitudinal history remain stored; ordinary current-state reads select artifacts owned by the active revision. Exact truth-authority records tied to the replaced revision become stale rather than being rewritten, and an accepted route is marked `revalidation_required` before another Tutor turn or action may launch. The stable Learning Contract is not versioned merely because extraction changed. A parser failure is recorded and leaves the prior active revision and route unchanged. Legacy binary documents imported before original-byte storage cannot be reprocessed and must be re-imported.

Retiring one document clears the active graph pointer, marks dependent source-authority records stale, and requires accepted-route revalidation. Immutable revisions, concepts, graph history, assessments, and learner state remain inspectable; current active-material reads exclude the retired source. Canonical groups remain backed by their surviving source concepts where available.

## 10. Database and migrations

`better-sqlite3` runs with foreign keys enabled. Repositories validate domain objects on writes and reads. Multi-row operations use explicit transactions, and migrations are recorded in `schema_migrations`.

The 17 shipped migrations are:

1. `initial_schema` - original materials, blocks, concepts, quizzes, grading, mistakes, and mastery.
2. `course_workspaces_and_documents` - workspaces, document metadata/original bytes, and source-block page numbers; every legacy material receives a compatibility workspace without learning-data deletion.
3. `concept_graph_and_remediation_plans` - graph versions/edges/evidence and accepted plans.
4. `canonical_concept_alignment` - canonical concepts, one membership per source concept, and auditable proposals.
5. `workspace_assessments_and_blueprints` - nullable material/workspace assessments and question blueprints; rebuilds the quiz table using the documented SQLite foreign-key procedure.
6. `misconception_hypotheses` - misconception records and audit payloads.
7. `review_scheduling` - current review items and immutable review events.
8. `tutor_runs_and_events` - bounded Tutor run state and safe timeline events.
9. `source_block_page_ranges` - nullable page-end values for cross-page PDF paragraphs.
10. `completed_attempt_snapshots` - provider and deterministic state-change snapshots on grading results.
11. `workspace_origin` - immutable `manual | material_import | unknown` origin used by deletion policy; existing rows remain honestly `unknown`.
12. `concept_lessons` - one current teaching lesson card per concept (verified segment anchors and conflicts inside validated JSON); purely additive, cascades with its concept.
13. `material_revision_lineage_and_source_authority` - immutable material revisions, revision-owned source artifacts, material roles, lineage, parser attempts, and independently admitted truth/premise authority. Historical rows become revision 1 without fabricated parser or content fingerprints.
14. `durable_agent_operations_and_cost_telemetry` - local idempotent operations, leases and fencing, ordered events, unique terminal results, logical model calls, physical attempts, usage/cost records, validated cache entries, and optional cost policies. No policy row means no monetary cap.
15. `accepted_course_execution_route` - Learning Contract, Curriculum, StudyPlan, SessionAgenda, coverage-risk, and atomic accepted-route persistence.
16. `durable_study_sessions` - StudySessions, turns, exchanges, summaries, events, and route-stack persistence.
17. `formal_evidence_progression_and_replans` - formal evidence links, objective/unit progression, replan triggers, and goal outcomes.

Table-rebuild migrations disable foreign keys only around the controlled rebuild, run `foreign_key_check` before commit, and restore enforcement even after failure. Tests cover idempotence, populated v1 and v3 upgrades, all-or-nothing rollback, and data preservation.

### Implemented Learning Execution Agent: Phases 1-4

The current implementation closes one bounded course-execution loop. It does not treat the design document as a claim that later Phase 5 capabilities exist.

- **Phase 1: durable foundations.** A logical Material owns immutable revisions and revision-owned SourceBlocks. Learner material-role assignments are separate from parsing. Material-role proposal and confirmation routes validate workspace, Material, and assignment identity before invoking mutating services, so a URL/body mismatch is side-effect free. Source authority is distinct from learner scope; accepted model output is runtime-validated; consequential commands are durable, idempotent, leased, and fenced; model logical calls, physical attempts, cache identity, and optional cost policies are persisted.
- **Phase 2: accepted route.** A learner-confirmed Learning Contract contains stable logical Material/role scope, never a MaterialRevision. Curriculum manifests bind exact active revisions and blocks. A proposed StudyPlan is locally checked for hierarchy, objective coverage/deferral, feasibility, authority, and launchability. Accepting a compatible route atomically activates the Contract, Curriculum, Plan, and a composed Agenda; a successor failure or rejection preserves the active route. Successful successor activation also abandons predecessor StudySessions, cancels their unfinished turns and logical calls, and terminally fences their operations in the same transaction.
- **Phase 3: conversational execution.** A StudySession is a durable conversation and route container, separate from the accepted Plan. It records turns, exchanges, summaries, events, current Agenda item, and nested detour frames. Tutor context is bounded to the accepted source manifest. Pause, resume, and stop are versioned execution transitions; stale routes are rejected rather than silently resumed. The frontend selects an open session only when all four accepted-route IDs match and reloads that selection when the route execution version changes. Tutor events may be delivered as persisted NDJSON as well as retrieved from session detail.
- **Phase 4: evidence-gated progression and replanning.** Formal assessment contracts bind a quiz to the accepted route. Local reconciliation records objective evidence, unit progression, next actions, and deterministic reason codes. Conversation does not create formal completion. Pace/risk qualification may create a bounded successor-plan proposal; it cannot replace the accepted route without the learner's decision. Goal outcomes preserve the evidence and gap snapshot that led to closure or abandonment.

The route API is split by responsibility: `agentCourse.ts` owns Contract, Curriculum, StudyPlan, accepted-route, coverage-risk, and Agenda-action endpoints; `studySessions.ts` owns StudySession lifecycle and Tutor-turn endpoints; `formalProgression.ts` owns progression, replan, and goal-outcome endpoints. Route handlers parse requests and delegate to services; repositories preserve the durable invariants.

### Frontend product shell

The frontend projects those domain boundaries into one selected-Course journey rather than exposing each subsystem as a top-level application:

```text
Course selection
└── current Course
    ├── 主页
    ├── 学习
    ├── 课程结构
    ├── 进展
    └── 探索
system zone
    ├── runtime mode
    ├── 设置
    └── advanced compatibility access
```

`AgentCourseWorkspace` owns the Course selection and the single Course navigation model. `AgentCourseShell` owns layout state only: an original vector product mark and wordmark, a 220 px expanded/60 px collapsed desktop sidebar, a below-768 px modal drawer with focus containment and Escape restoration, Course navigation, and the separate system zone. The brand asset is also used by the compatibility header and browser favicon. None of these surfaces owns Course domain state.

Course Home composes the bounded overview into one next action, a short Agenda, learner-actionable exceptions, and secondary disclosures. Course Materials is a Home subview over the existing document APIs. `学习` renders the durable StudySession as a transcript-first interaction while retaining formal/informal evidence boundaries. `CourseProgressView` consolidates formal progression, assessment history, mistakes and remediation, mastery/reviews, and bounded Contract/Curriculum/StudyPlan history. Embedded `GraphWorkspaceView` keeps the selected Course fixed, collapses its management panel by default, and remains the advanced `探索` workspace.

`CurriculumView` is a read-only projection over the accepted or selected Curriculum version. It first shows the actual version/status, the latest accepted version available in history, major/chapter/section/unit/objective counts, and only server-persisted `started` units as the current location. Major branches derive summaries from their real descendant objectives, prerequisites, source references, and route links. Non-leaf content mounts only after an `aria-expanded`/`aria-controls` disclosure is opened. When a section directly contains more than 12 learning units, the first 12 mount after expansion and a second accessible disclosure controls the remainder (covered with a 277-unit fixture). Expansion state resets when Curriculum identity/version changes and is never persisted as domain state.

Learning objectives preserve their independently verified versus in-scope/unverified truth-authority labels. Unit source anchors, the exact execution-source manifest, and Curriculum history are subordinate disclosures. Their copy preserves the distinction between exact quotation/location and complete semantic entailment. Presentation recovery handles duplicate IDs, missing parents/children, repeated links, and cycles deterministically with visible notices; it neither loops indefinitely nor repairs the stored hierarchy. There is no invented Curriculum search/filter or inferred progress state.

The Learning Contract editor treats Material-role confirmation as its existing separate authoritative command boundary, not as a client-only field change or an implicit side effect of Contract persistence. Before saving scope it refetches the current role assignment, confirms an already matching proposal (or proposes and confirms the reviewed choice), refetches the resulting history, and only then sends the exact confirmed assignment ID/version in Contract scope. A concurrent version conflict refreshes the visible role state and asks the learner to review again; it never bypasses the server freshness check. Reload follows the same history endpoint, so freshness is durable rather than component-local.

The prior Library, Practice, Mistakes, progress, and graph views are reused rather than cloned. Compatibility access remains secondary in `App`; the selected Course is the primary product context. This shell is presentation-only: it does not infer completion from prose, change source authority, rewrite Plan/Agenda ownership, or modify persistence and provider contracts.

## 11. Concept graph and plans

### Graph validation/versioning

`graph/validate.ts` evaluates candidate edges independently:

- endpoints must be existing concepts in the workspace;
- self-links and cross-workspace references are rejected;
- relation must be in the controlled six-value enum;
- each evidence quote passes `verifyGrounding`;
- normalized `(source, target, relation)` duplicates are removed;
- `prerequisite` and `part_of` candidates are checked for cycles; and
- the global accepted-edge budget is 120.

Each generation starts as a persisted `generating` version. Provider failure or zero surviving edges marks it `failed` and leaves the active graph untouched. Success writes edges/evidence, marks `ready`, switches the active pointer, and enforces the ten-version retention window in one transaction. A historical ready version can be reactivated transactionally.

### Learner overlay

The overlay derives one state from existing mastery/mistake rows:

- `unassessed`: no graded attempts;
- `weak`: an open mistake or mastery below 0.7;
- `stable`: no open mistake, mastery at least 0.85, and at least three attempts;
- `developing`: everything else.

It also returns mastery, counts, latest activity, and direct prerequisites. It stores no probabilistic confidence and does not duplicate review-scheduler state.

### Remediation-plan validation

Planner input is bounded to the selected concept, at most five direct prerequisites, at most eight other neighbors, involved source blocks, relevant mastery, at most ten open-mistake stems, and previously used question types.

A proposal contains a summary, tentative weakness hypothesis, controlled strategy/difficulty, supported question types, 1-6 steps, and 1-4 evidence-cited targets. Local validation requires workspace concepts, centrality around the selected concept/direct prerequisite, supported types, and exact source evidence. A failed proposal preserves the previous accepted plan. Accepting a plan changes no learner state.

## 12. Graph frontend and geometry

The full-height learning workspace has a collapsible document panel, React Flow graph canvas, and collapsible evidence/plan inspector. It offers deterministic network, dependency, and weak-path layouts.

Graph state is layered deliberately:

```text
semantic graph -> visibility -> deterministic layout -> saved positions
               -> active drag positions -> edge geometry -> hover -> selection -> viewport
```

Hover/selection change style only and cannot rerun layout, routing, or fit-to-view.

### Layout and persistence

- Network positions use bounded synchronous `d3-force` ticks seeded from concept-ID hashes; no simulation runs in the background.
- Dependency layout uses longest-path layers plus four bounded barycenter sweeps, accepting only strict crossing improvement.
- Weak-path view keeps every weak node, bounded shortest prerequisite repair paths, direct `part_of` context, and a small number of prerequisite dependents. It excludes contrast/example/application/causal edges and reports when the minimal view covers the whole graph.
- Controlled drag state updates connected edges per frame. One bounded global route cleanup runs on release, and positions persist once per gesture in `localStorage` by graph version.
- If a dragged canonical node disappears through alignment or explicit workspace deletion, the gesture ends without persisting a stale ID.
- `AutoFit` runs once per meaningful graph-state key after nodes are measured. Stale animation-frame callbacks are discarded by epoch.

### Edge routing

`edgeGeometry.ts`, `edgeRouting.ts`, `routePlan.ts`, and `FloatingLearningEdge.tsx` implement deterministic floating edges:

- endpoints intersect measured card boundaries and move during drag;
- high-degree attachment slots are ordered by opposite-endpoint geometry with stable ID/relation tie-breakers;
- parallel and reciprocal relations use separate lanes;
- route candidates include straight, quadratic, and dependency-view cubic paths;
- scoring prioritizes avoiding non-endpoint cards, then crossings, congestion, label/card overlap, bends, and length;
- a bounded improvement pass revisits crossing pairs only when the global metric strictly improves;
- network layout receives a bounded crossing-aware local refinement before first fit; and
- canvas-colored casing strokes keep unavoidable crossings legible.

`graphClarity.ts` is a pure test/development metric, not a user-facing quality claim. Routing is bounded, not an exhaustive global solver; dense or pathological arrangements can retain crossings.

## 13. Canonical cross-document alignment

Alignment is an overlay, never a rewrite of source concepts. `canonical_concepts` and `canonical_members` form a many-to-one mapping with exactly one membership per source concept. A merge is a transactional union of two groups, so cycles are impossible by construction. Accepted, rejected, and kept-separate decisions remain auditable.

Candidates are generated locally and capped at 30 pairs. Signals include normalized-key equality, malformed concatenation containment, shared blocks/headings, Latin token overlap, bilingual summary bigrams, and accepted alias knowledge. Hy3 never receives an unbounded all-pairs set.

Only exact normalized-key equality is auto-accepted as an alias under a tested local rule. Display-name selection is deterministic. All semantic merges wait for review, and provider proposals must reference an offered pair, existing concepts, and verified evidence.

The frontend projects canonical groups into one displayed node, reanchors/deduplicates edges, and aggregates the existing learner overlay. Original concepts, citations, and history remain the underlying source of truth. There is currently no unmerge operation.

## 14. Workspace assessment blueprints

Each adaptive assessment question has a server-side blueprint: target canonical/source concepts, document, type, difficulty, objective, evidence-mapped reasoning steps, scope, and grading method.

- Cross-document scope is computed from documents represented by **verified** evidence, never trusted from a provider flag.
- `concept_comparison` requires evidence from at least two documents and uses the semantic short-answer path.
- Expected answers, rubrics, and reasoning steps are removed from client payloads.
- Mistakes, mastery, misconceptions, and review items are attributed to each question's own source concept/document rather than an arbitrary quiz-level document.
- Practice-oriented questions link open `sourceMistakeIds`, so a correct answer uses the same exact-resolution rule as remediation.
- Every graded submission returns a locally computed `stateChanges` summary after persistence.

## 15. Bounded Hy3 Tutor

One Tutor iteration permits exactly one of two provider decisions: request one whitelisted read-only tool with strict arguments, or finalize a plan and recommended activity.

The ten tools are `inspect_learning_state`, `inspect_concept`, `inspect_canonical_aliases`, `get_graph_neighborhood`, `get_prerequisite_path`, `search_source_blocks`, `read_source_block`, `inspect_open_mistakes`, `inspect_misconceptions`, and `inspect_review_queue`.

Tools are workspace-scoped repository reads. They cannot execute SQL strings, access the filesystem/network, or modify state. Unknown/out-of-workspace references fail before execution.

Budgets are explicit:

- six planning iterations;
- twelve executed tool calls;
- three final plan targets;
- eight blocks per search;
- twenty retained evidence records; and
- bounded observation payloads.

The server composes every streamed/persisted timeline event. It exposes tool purpose, validation outcome, and evidence counts, not chain-of-thought, raw prompts, or raw model output.

The final plan uses the same validator/store as ordinary remediation planning, with one bounded grounding-specific repair round: when plan evidence fails verification, the rejection details are fed back as an observation and the model may finalize once more before the run fails closed. Completed, cancelled, failed, and interrupted runs remain auditable; a process restart changes stranded `running` rows to `interrupted`. No incomplete run changes learner state.

### Activity executability contract

An `AssessmentMode` being a legal enum value never made it executable; `services/activityLaunch.ts` is the single deterministic authority on launchability, consumed three times:

1. **Tutor finalize** — the model is offered ONLY currently-launchable modes (with one-line preconditions, plus actionable misconception ids); its chosen activity is validated again locally and, when its preconditions do not hold, deterministically downgraded along `concept_practice(selected)` → `diagnostic` with an auditable `activity_adjusted` timeline event recording the original mode and reason. Every newly completed run's persisted activity is launchable at completion time.
2. **Queue composition** — every daily-queue item carries the server-resolved launch request (`item.launch`); clients send it verbatim and never re-derive modes. Items whose launch cannot be resolved are not listed. The previously dead "due later today" review tier now launches, because review with NAMED concepts accepts anything due by the end of today (matching the queue's own wording), while unnamed review keeps strict due-now semantics.
3. **Launch time** — `POST /api/workspaces/:id/tutor/runs/:runId/activity` reloads the persisted recommendation, re-resolves it against CURRENT state, constructs the mode-specific assessment request server-side, and reports any adjustment honestly (legacy runs persisted before this contract launch through the same route). The assessment service's own per-mode target selection remains the final gate.

Per-mode preconditions: `cross_document` requires an accepted cross-document alignment sibling for a target (two documents merely existing is not capability); `review` requires eligible review items as above; `misconception_check` binds a concrete actionable hypothesis id (resolved server-side; the activity schema carries it); `prerequisite_repair` requires a real prerequisite edge in the active graph; `concept_practice`/`diagnostic` require existing concepts.

## 15b. Concept lesson cards (teaching enrichment)

Lessons make the clinic teach, with provenance the model cannot forge. One current `concept_lessons` row per concept stores up to six typed sections (`explanation`, `intuition`, `worked_example`, `misconception_warning`, `contrast`, `application`) of small segments. Provenance is decided deterministically per segment: a segment whose proposed `(blockId, quote)` anchor passes the SAME `verifyGrounding` used everywhere else renders as 课程资料/本地已验证 with its expandable quote; a segment without a verified anchor renders as AI 辅助讲解(非资料原文) — the model may use its own knowledge to explain a course-confirmed concept, and that is labeled, never hidden. Failed anchors are dropped (the text survives as AI teaching); the model can never self-certify provenance.

Where the course text differs from the common presentation of a concept, a conflict entry pairs the model's claim with a VERIFIED source quote; unverifiable conflicts are dropped whole, and the UI states that course assessment always follows the source. Generation context is bounded (own section blocks, ≤8 lexical-retrieval hits, graph-neighbour names/relations); three fixed regeneration directives (更直观 / 更多例子 / 更深入) rerun the same validated pipeline — there is no free-form chat. Lessons are display-layer teaching material only: generating or reading them writes zero mastery/mistake/misconception/review state, they never feed rubrics, a failed regeneration preserves the previous valid card, and rows cascade away with their concept.

## 16. Misconceptions, review, and retrieval

### Misconception state machine

One wrong answer is not a diagnosis. A provider may propose or decline a bounded tentative hypothesis with controlled category and verified evidence. Local code owns:

```text
proposed --wrong discriminating answer--> confirmed
proposed --correct discriminating answer--> rejected
confirmed --later correct discriminating answer--> resolved
```

`rejected` and `resolved` are terminal. Illegal transitions fail. At most two proposals can be created per submission, and the UI uses explicitly tentative wording until confirmation.

### Review scheduling and daily queue

Review state is separate from mastery. A compact local FSRS-style scheduler stores stability, difficulty, due date, lapse count, versioned current items, and immutable events. Score-to-rating mapping and constants are explicit and fixed-clock tested. Only completed graded events advance it; Tutor reads cannot.

The daily queue prioritizes overdue reviews, confirmed misconception repair, open mistakes, weak prerequisites, then due-today review. A concept appears once, and reasons report facts rather than invented time estimates.

### Bounded lexical retrieval

`retrieval/lexical.ts` tokenizes NFKC-normalized CJK bigrams and lowercase Latin words and scores blocks BM25-style. Graph-neighbor evidence can be appended as an explicit expansion. Query length, result count, excerpt length, and offsets are bounded; callers pass only one workspace's blocks.

There is no vector database. SQLite FTS5 was not used because its default tokenizer does not segment CJK appropriately and current workspaces contain only dozens of blocks. Retrieved instruction-like text remains untrusted data and has no state-changing capability.

## 17. Cancellation, stale responses, and recovery

`requestSignal.ts` watches the response stream `close` event. Watching the request stream would cancel normal body-bearing requests after parsing. The signal reaches provider `fetch` and remains active while the response body is read; real-socket tests cover behavior that `fastify.inject` cannot reproduce.

Frontend asynchronous workflows use abort controllers plus request epochs/take-latest identities. Switching or deleting a workspace/document, changing graph selection, restarting a plan, or leaving a view invalidates older work. Late responses cannot replace newer documents, graph versions, selection, plans, Tutor events, assessments, or history.

Transactions protect material/revision activation, block creation, concept replacement and additive appends, quiz insertion, the complete grading learner-state write set (with in-transaction duplicate and stale-quiz rechecks — see "Grading state safety"), migrations, graph activation, plan storage, lesson upserts, deletion, and reprocessing. Consequential Agent operations additionally persist command identity, expected fingerprints, leases, monotonically increasing fencing tokens, and one terminal result. A failed AI request never overwrites previously valid data.

An interrupted StudySession turn is retryable under its original expected session version only when local code proves ownership of that exact durable logical turn. The immutable command/fingerprint, turn identity and status, single learner exchange, transcript watermark, logical-call and attempt history, operation interruption event, and fencing state must all agree. The retry adds a physical attempt to the existing logical call; changed content/fingerprints and unrelated fresh commands with stale expected versions still conflict.

At process startup, unfinished StudySession turns and running operations are marked interrupted. During a live process, `createOrGet` performs demand-driven expired-lease recovery only after an identical immutable operation identity has matched. Recovery transactionally interrupts linked turns, records sent attempts as `outcome_unknown` and queued attempts as `interrupted`, clears ownership, and records the interruption; the replacement claim increments the fencing token. A late worker holding the older token cannot append an authoritative event or terminal result. There is no background lease sweeper: live recovery occurs when the exact command is retried.

## 18. Production dependencies added for the upgrade

| Dependency | Scope | Rationale |
| --- | --- | --- |
| [`unpdf`](https://github.com/unjs/unpdf) | server | Maintained serverless PDF.js distribution exposing positioned text items needed for deterministic layout reconstruction and page provenance, without native binaries or OCR. |
| [`mammoth`](https://github.com/mwilliamson/mammoth.js) | server | Maintained DOCX-to-HTML converter whose structural output can be reduced locally to text/headings/lists/tables; image output is discarded and no document code is executed. |
| [`@xyflow/react`](https://github.com/xyflow/xyflow) | web | Maintained React 18 graph renderer with accessible pan/zoom, selection, and controlled dragging. |
| [`d3-force`](https://github.com/d3/d3-force) | web | Small standard force-layout library used for bounded, hash-seeded synchronous network layout. |

No vector database, graph database, orchestration framework, authentication layer, microservice, or new backend language was introduced.

## 19. Known architectural limits

- Settings can verify only the local health/config endpoints. It neither tests external Hy3 availability nor edits server-owned provider configuration.
- Curriculum uses branch expansion and a 12-unit preview for large direct-unit sections, but it has no search/filter. Missing current/progress state remains visibly unavailable, and malformed-tree recovery changes presentation only.
- PDF fidelity depends on the file's text layer. There is no OCR, and rotated/multi-column text, diagrams, complex tables, and text in images are not reconstructed.
- Header/footer removal, visual-wrap repair, heading recognition, and table detection are conservative heuristics and can misclassify pathological documents.
- DOCX does not provide stable page provenance; embedded image content is discarded.
- Grounding can reject semantically reasonable output when an exact quote is unavailable or ambiguous.
- Structural document mapping reports which sections have grounded concepts and which blocks are cited by verified anchors; it never measures semantic coverage, and a "mapped" section may still contain uncaptured ideas. Semantic recall lives in the evaluation suite against hand-authored labels.
- Lesson cards may contain model teaching that goes beyond the uploaded text; it is labeled AI 辅助讲解(非资料原文) and is never grading evidence, but its factual quality depends on the configured model and should be read critically. Section-aware extraction and lesson quality are bounded by the size-aware budgets and the 40-concepts-per-document ceiling.
- Alignment review has no unmerge operation, though underlying source concepts/history remain intact.
- Completed history is limited to 50 attempts per workspace and has no edit/export/pagination workflow.
- Lexical retrieval can miss synonyms; the graph/Tutor/assessment/remediation budgets can omit useful context.
- Review scheduling and mastery are transparent heuristics, not psychometrically calibrated models.
- Deterministic bounded graph routing can retain crossings in dense arrangements.
- Material/document retirement is non-destructive to immutable revisions and longitudinal history, although the current API has no automatic unretire operation. Reprocessing retains immutable prior revisions and history, but activating a new revision changes which source artifacts ordinary current-state workflows use. Explicit workspace deletion is irreversible and cascades its course data.

Verification commands, test counts, migration coverage, public evidence, and reviewer mappings are maintained separately in [Verification and Reviewer Evidence](VERIFICATION.md).
