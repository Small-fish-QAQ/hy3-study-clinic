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

`apps/server/src/grounding/verify.ts` is the trust boundary between model-proposed evidence and stored evidence. Most providers supply `(blockId, quote)`; Curriculum instead supplies only a server-offered evidence identity. The identity binds an exact MaterialRevision, SourceBlock, span, and excerpt. Local code resolves the quote and owns all location data.

1. Trim leading/trailing quote whitespace. This is the only textual normalization; there is no fuzzy matching.
2. Search the claimed block with exact string matching and compute UTF-16 offsets locally.
3. If the quote occurs more than once in that block, anchor the first occurrence and retain `occurrenceCount` so ambiguity remains visible.
4. If it is absent from the claimed block, re-anchor only when exactly one other eligible block contains exactly one occurrence; mark `reanchored: true`.
5. Reject zero, repeated cross-block, or otherwise ambiguous matches.

The server never trusts provider-supplied offsets, page numbers, or line numbers and never invents a quotation.

Curriculum first builds a complete deterministic catalog and Course Source Map from the frozen execution-source manifest. Each local binding hashes workspace, revision, block, span, and exact excerpt. The map validates the current logical Materials, active revisions, exact SourceBlock order and fingerprints, parser heading paths, derived budgeting sections, current Concept associations, and valid predecessor intersection. A second deterministic selection stage limits only what the provider sees: accepted-predecessor references (up to six per unit), Concept and authority groundings, one-block neighbors, per-unit and Contract lexical matches, section-balanced candidates, and evenly sampled fallback widening. The production `derived_section_reserve_v1` policy reserves one candidate opportunity per derived budgeting section and deterministically redistributes unused capacity through the unchanged ranked order followed by exact Course source order. If the block ceiling is saturated, it replaces only unprotected candidates so baseline predecessor references, Concept groundings, and priority groundings are retained. The provider budget remains 160 blocks, 240 offers, two offers per block, and 320 characters per excerpt. The reserve offer prefix is additionally bounded by the exact UTF-8 size of the baseline internal-offer JSON array, at complete-object boundaries. Provider-facing keys (`E1`, `E2`, ...) are operation-local; the mapping retains the full binding ID and authority metadata outside the prompt. Materialization rejects unknown, foreign, stale, or span-mismatched IDs and then runs the ordinary exact grounding check. Map metadata, lexical rank, locality, and quotas narrow navigation context only; they never prove truth or semantic entailment. Persisted Curriculum provenance remains the revision-bound SourceBlock reference, and provider paraphrases are never promoted to source truth.

Exact quotation validation proves that text exists at the recorded source position. It does **not** independently establish the complete semantic truth or entailment of a concept, relation, explanation, hypothesis, or plan reason. The UI therefore distinguishes model proposals from locally verified source location.

### Curriculum quality and retrieval evaluation boundary

`apps/server/src/eval/curriculumQuality.ts` is reusable offline evaluation infrastructure, not a route, provider workflow, persistence service, or acceptance gate. It parses one Course-scoped Learning Contract, Curriculum, exact execution-source corpus, current Concept/canonical binding authority, and optional per-LearningUnit execution capability/frontier eligibility, then rejects foreign workspace data, a different Contract revision, an incomplete or stale manifest, duplicate identities, stale SourceBlock fingerprints, invalid grounded Concepts, and SourceBlocks, Concepts, canonical Concepts, or references owned by another Course or MaterialRevision. Its schema-versioned output is a quality profile rather than a weighted total:

- deterministic identity/structure metrics cover source, material and section mapping; hierarchy depth and module balance; LearningUnit/objective/binding distributions; prerequisite references, cycles, ordering, density and isolation; valid, invalid, and duplicate declared synthesis references; evidence diversity; and explicitly supplied execution capability/frontier eligibility;
- lexical learner-goal coverage and near-duplicate objective similarity are explicit heuristics; and
- prerequisite meaningfulness, objective correctness/depth, synthesis usefulness, and human preference are named as model-judged or human dimensions, but are not calculated by the deterministic evaluator.

`selectCurriculumEvidenceOffersWithTrace` runs either the frozen `b3_baseline_v1` control or the `derived_section_reserve_v1` production policy while recording the complete corpus/catalog/candidate/offer counts, material/section diversity, configured limits, policy reason, priority-ordering effects, and attempted/selected/first-contributor/budget-rejected counts for each selection signal. Serialization telemetry is the exact UTF-8 byte length of the ranked internal `CurriculumEvidenceOffer` JSON array; `ceil(bytes / 4)` is stored only as an estimate and is never presented as provider-reported token usage. This is an internal selection diagnostic, not the smaller provider-facing evidence DTO or complete prompt size; `measureCurriculumRequest` remains the exact provider-request sizing boundary. `evaluateCurriculumEvidenceRecallAtBudgets` compares caller-supplied required SourceBlock IDs with ranked offer prefixes at a block budget, exact internal-offer byte budget, and estimated-token budget. The output-only selector preserves exact binding materialization and priority offer ordering. Switching the named production constant back to the baseline needs no migration and does not invalidate historical Curricula or evidence.

These measurements locate where source identities were retained or lost. They do not show that Hy3 used an offered block well, that the resulting Curriculum teaches a learner goal adequately, or that an exact quotation completely entails a pedagogical claim. Private human-labelled comparisons can supply exact required SourceBlock IDs to the recall helper, but those labels and historical artifacts do not belong in the public repository.

`apps/server/src/services/courseSourceMap.ts` builds a schema-validated, deterministic organization view over one exact current execution-source manifest. Material and active-revision order comes from the manifest; SourceBlock ownership, order, parser identity, and revision fingerprints must match exactly. Parser heading paths become provenance-labelled navigation nodes, while the existing `computeSections()` output is retained separately as deterministic budgeting boundaries. Current Concept associations and the intersection of the selected same-Course predecessor with the current corpus are signals. Stale predecessor references remain historical data but cannot introduce stale evidence into the map because only exact current block/revision fingerprints contribute. The builder rejects foreign Course data, inactive or mismatched revisions, incomplete corpora, duplicate identities, and reordered blocks. `buildCurriculumExecutionContext` now retains the exact active-revision facts needed to construct this projection once in the real Curriculum operation, before provider-visible selection. It is pure and migration-free: the fingerprint identifies the projection, but the projection does not replace SourceBlocks or establish truth.

`apps/server/src/eval/curriculumRetrievalBenchmark.ts` is an offline comparison harness. It validates a Course Source Map, immutable catalog membership, baseline candidates/offers, all seven named production rankings, required exact block IDs, diagnostic groups, and fixed block/global-offer/per-block-offer/UTF-8-byte budgets before evaluating anything. It produces independent profiles for the caller-supplied baseline, whole-offer serialized-byte truncation, source-order section reserve/cap with deterministic unused-capacity redistribution, normalized weighted RRF, and bounded hierarchy packaging. RRF ties resolve by Course source order and then block ID, and each score retains its named rank contribution. Hierarchy packaging groups unchanged child offers under derived-section metadata only when a configured child threshold is met; it neither invents parent text nor changes evidence identities, and all metadata is charged to the same byte budget.

Each profile reports exact-ID recall at candidate, offered, block, and byte boundaries; counts; material and derived-section balance; named-signal attribution; baseline overlap; diagnostic-group retention; exact serialized bytes; and an explicitly labelled `ceil(bytes / 4)` token estimate. It emits no aggregate score and has no route, provider, persistence, acceptance, or Course Preparation authority. Its one-block uncapped reserve implementation is shared with production; caps, RRF, byte-profile comparison, and hierarchy packaging remain offline evaluation paths. The source map intentionally omits block text, so the harness verifies catalog identity, ownership, span length, heading path, and page metadata but leaves exact quote-to-source validation with the existing catalog builder and materializer. Private historical labels remain outside the repository; the committed representative multi-Material fixture uses only synthetic identities and explicit test labels. Rank scores and quota decisions remain navigation-only.

### Formal assessment evidence backbone

The additive formal-assessment aggregate is persisted by migration 28. An `AssessmentDefinition` is the logical identity; each accepted `AssessmentVersion` is immutable and contains target-bound items, exact source-revision bindings, rubric authority, and a local `FORMAL_ELIGIBLE` or `PRACTICE_ONLY` reason. `AssessmentAttempt` stores one durable execution and its submitted responses. `GradeRecord` is append-only and identifies the grader/rubric version; regrading supersedes a record without rewriting it. Evidence is derived only by the local gate from a submitted attempt, current grade, immutable formal item, authoritative non-derived source and rubric bindings, and the approved short-answer policy. `AssessmentEvidenceRecord` and `AssessmentProgressionReconciliation` are separate durable records. Migration 30 adds immutable launch context and retry identity to that reconciliation boundary: supported Evidence is translated into one local grading projection and passed to the existing `formalProgression` service, which retains the versioned completion policy, route projection, duplicate fencing, and historical-current semantics. A failed projection leaves Grade and Evidence durable and retryable; it never invokes a provider. Existing Tutor, lesson, and legacy quiz paths remain non-formal unless they enter this explicit contract.

### Diagnostic Repair orchestration

Migration 29 adds `repair_episodes`, immutable `repair_packets`, non-credit `repair_practice_events`, and append-only `repair_status_events`. An episode is idempotently keyed by the exact current triggering GradeRecord and retains the failed attempt, immutable AssessmentVersion/item, target LearningUnit, affected criteria, bounded diagnostic category, learner-safe gap summary, verification link, and resolution Evidence link. The diagnosis is a pedagogical interpretation of one response, not Formal Evidence, Course Truth, a learner trait, or a mastery mutation.

The local service derives Repair eligibility from persisted score and criterion judgments. A full semantic pass never creates Repair merely for a surface typo. When the grading contract supplies a bounded diagnosis, local code validates its criterion IDs and uses `UNCERTAIN` for high uncertainty; otherwise it conservatively distinguishes incomplete coverage from no demonstrated coverage. The fixed minimum-intervention mapping chooses a notice, targeted prompt, contrast, scaffold, prerequisite review, concise reteach/retrieval prompt, or clarification. Hy3 may supply only the explanation, practice prompt, hints, and controlled intervention mode; local code supplies all IDs, source context, generation identity, status, and persistence. Phase 7B1 enables this operation only through the deterministic Fake provider; real-provider Repair evaluation remains separately gated.

The Repair state machine is `OPEN -> ACTIVE -> AWAITING_VERIFICATION -> RESOLVED`, with learner-governed `DEFERRED` and `CANCELLED` branches. Practice events have no Evidence or progression authority. A distinct accepted AssessmentVersion with an eligible item for the same target must supply a fresh attempt; only a supported AssessmentEvidenceRecord from that linked attempt resolves the episode. Three failed verification cycles cause deterministic deferral for deeper support instead of unbounded provider recursion. Repair resolution closes only the specific gap and is not global Mastery. The existing assessment reconciliation remains a separate idempotent record boundary; no Repair method calls legacy direct mastery mutation.

Source blocks are wrapped with fresh request-specific delimiters and explicitly labelled untrusted data. Student answers are fenced for grading in the same way. This reduces injection risk but is not presented as a proof of prompt-injection immunity.

### Production Course Map and bounded Curriculum materialization

The default policy identity is `legacy_direct_v1`, the established direct-Curriculum workflow. Unless a caller explicitly selects a policy, an outline with at least 80 items deterministically selects `course_map_materialization_v1`. That hierarchy-first path places `apps/server/src/services/courseMap.ts` and `apps/server/src/services/curriculumMaterialization.ts` between the deterministic Course Source Map and the existing Curriculum materializer. The Course Map and its source allocation are operation-local planning state: neither is persisted, learner-visible, accepted as Course Truth, Evidence, Mastery, or learner state. The only proposed or accepted course-structure artifact remains the existing Curriculum, so switching the internal policy requires no migration and does not reinterpret historical Curricula.

The local source-allocation builder validates one exact current Course Source Map and evidence catalog, preserves Material boundaries, and partitions every derived section and SourceBlock exactly once into at most 120 contiguous planning regions. Provider visibility is smaller: region summaries, compact `R*` refs, region-adjacent `R*:A*` Concept/canonical options, and at most 160 exact excerpts with a two-per-region ceiling. Raw source-allocation, Concept, canonical, and evidence identities stay in the local adapter. Allocation proves visibility and planning coverage only; exact SourceBlocks remain the authoritative evidence leaves.

Hy3 or Fake first proposes concise modules, ordered instructional regions, approximate scope, selections from adjacent anchor options, pedagogical prerequisite edges, and synthesis boundaries. Exactly one offered `R*` ref identifies each output region, and array position carries semantic order. The provider does not generate keys, numeric indexes, fingerprints, counts, or authority IDs. Local code resolves the refs to exact current authority, derives proposal keys, indexes, fingerprints, and operation-local IDs, then validates module/region limits, complete one-time allocation, anchor ownership, prerequisite self/duplicate/degree/edge/order rules, complete DAG acyclicity, and synthesis identities/boundaries. There is intentionally no universal quality score and no locally invented semantic prerequisite edge.

After a valid Course Map, deterministic stable-order planning tries one detail batch and then a module-preserving split, with `MAX_DETAIL_BATCHES=2`. Each batch is limited to 50 regions, 120 evidence offers, 120000 exact request bytes, and a 62000-byte output estimate; the estimate is a conservative planning heuristic, not a theoretical model-output guarantee. A plan requiring a third batch or containing a region that cannot fit alone fails closed. The planner verifies exact region order and rejects overlap or omission rather than dropping work.

Each detail response must represent every offered region exactly once in order and may select only the region-owned evidence, current Concepts, and canonical Concepts supplied in that batch. Local code rejects foreign evidence, missing source allocations, stale fingerprints, and unknown anchors, then deterministically assembles one chapter per Course Map module and one section/LearningUnit per region into the existing `CurriculumProposalPayload`. Course Map prerequisite and synthesis relationships are mapped locally, and the assembled Curriculum passes the unchanged evidence materializer, structural validation, and StudyPlan preflight before a single persistence transaction. Any failure writes neither a Course Map nor partial Curriculum and leaves the accepted predecessor unchanged.

One `course_map_materialization_v1` operation therefore has at most three logical provider calls: one Course Map plus at most two detail batches. Each logical call permits independently bounded schema and candidate-semantic repair budgets. A third physical attempt occurs only when the failure kind changes; an equivalent repeated schema or candidate failure still exhausts after attempt two. The staged ceiling is therefore nine physical requests, and the direct path ceiling is three. Timeout, transport failure, cancellation, or an authoritative snapshot/fencing change does not trigger a blind repair or retry. Both policies retain the same local validation and persistence authority boundaries.

### Curriculum completeness and pedagogical acceptance (Phase 12B7B)

The Course Map is also the source-accountability boundary. Every source region receives exactly one bounded disposition: `represented_directly`, `represented_by_parent_or_synthesis`, `duplicate/redundant`, `boilerplate/navigation/non-learning-content`, `explicitly_out_of_scope`, or `unresolved_candidate_gap`. The row retains exact MaterialRevision, SourceBlock, section, and source-map identities plus a bounded rationale and affected Curriculum/objective IDs. Structural unmapped counts remain diagnostic; for `systematic_mastery`, an unresolved meaningful region is an acceptance error rather than silently disappearing content. Intentional scope may retain an explicit out-of-scope disposition.

The staged path is spine-first. A validated skeleton establishes modules, source-region membership, module rationale, expected major outcomes, sequence rationale, prerequisite relations, and synthesis boundaries before any LearningUnit detail request. Detail batches can fill only those accepted regions and anchors; they cannot add modules, reorder the spine, or invent authority. The existing direct provider policy still uses its established contract, but its materialized result enters the same completeness and semantic gates.

The locally owned source allocation, not provider-selected evidence alone, supplies complete final membership. Each accepted Course Map region maps to exact current SourceBlocks and normalized structural units in its final LearningUnit. `represented_directly` is valid only when that real membership plus an objective or teaching role exists; a disposition-only recovery cannot close coverage. The explicit 10,000-reference schema ceiling admits a large exact region such as the observed 295-block source while remaining bounded.

After deterministic materialization and structural validation, `curriculumSemanticEvaluator.ts` performs an independent bounded semantic pass. Its structured findings cover coverage/accountability, hierarchy and sequence, conceptual cohesion/topic scattering, granularity/over-compression, objective alignment, and required-objective Formal Assessment compatibility. It uses bounded semantic features only as a challenge signal; it does not turn lexical overlap, unit count, or verbosity into a quality score. Single Han characters, joiner bigrams, decimal subsection ordinals, generic course vocabulary and a broad domain label such as `RAG` cannot alone prove focused topic scattering. Narrow aliases cover only documented equivalences for document chunking, grounded-answer quality and retrieval; focused repeated anchors still require grouping or synthesis. One optional critique/repair callback may run, followed by a fresh independent evaluation. Exhaustion rejects the proposal and preserves the accepted predecessor. Required objectives are marked Formal-ready only when local exact, current, independently authorized source premises support the claimed competence; the exact selected evidence envelope is decisive, and authority cannot leak from a stronger sibling offer in the same region. An apply-target Course may reserve at most eight exact paired procedure blocks inside the unchanged provider-evidence ceilings. Every required objective must retain a semantic anchor in its own learner-visible LearningUnit title; bounded repair may rename or regroup only inside the offered Course Map region. Teaching explanations may be broader, but they cannot become Formal authority.

Accepted Curriculum payloads retain immutable `coverageAccountability` and `qualityEvaluation` metadata. Migration 35 adds append-only `curriculum_quality_evaluations` records keyed to the immutable Curriculum/version and source-map fingerprint; repository writes occur in the same acceptance boundary and never mutate learner state. The hierarchy API exposes bounded status, finding summaries, and disposition counts. `CurriculumView` shows only a concise repair/quality status and inspectable coverage detail, with no visual redesign and no new authority path.

## 4. Provider contract

`LlmProvider` is a bounded interface shared by `FakeProvider` and `Hy3Provider`. It includes one deliberate `testConnection` probe and runtime-validated operations for concept/visual analysis, question generation and grading, remediation/Repair, graph and alignment proposals, assessment and mastery challenges, misconception proposals, Concept lessons, Teaching Briefs, Tutor turns, Course Map/Curriculum materialization, and StudyPlan proposals. The current Teaching Brief route uses two additional composition-specific methods: `generateLessonSlotContent` fills only an immutable local Lesson skeleton, and `generatePracticeContent` fills only the local Practice plan after Lesson acceptance. The older whole-Brief method remains a compatibility contract; it does not own the current StudySession preparation path.

Every method receives optional provider-call options containing an `AbortSignal` and, when its owning operation needs one, a bounded timeout override. Every method returns a Zod-validated payload. Implementations expose normalized `ProviderError` failures rather than raw transport errors.

Production composition decorates the complete runtime provider interface once. Every method call must supply metadata-only telemetry context before inference; missing context fails closed. The decorator is the single writer for logical calls, sent physical attempts, repairs/retries, provider/model/runtime generation, duration, normalized outcome, and provider-reported usage. Hy3 token fields are stored only when reported; a timeout without a usage-bearing response has an attempt row but no fabricated usage row. Monetary cost remains unknown when the provider does not report or the product cannot derive it, while Fake usage is truthfully known zero. Cost policy evaluation occurs before send; the staged Curriculum coordinator reevaluates it before each logical Course Map/detail stage. Thus a configured refuse policy fails closed after an unknown-cost real attempt, while a confirmation policy must be confirmed for the operation up front. The context and schema contain no prompt, response body, header, or credential field, and unknown errors are stored only as a normalized failure. Idempotent decoration lets nested services reuse the boundary without double counting.

### FakeProvider

The fake provider is offline and deterministic for identical inputs. For Course Map detail batches it returns exactly one LearningUnit proposal per offered region and selects one region-owned evidence offer for each represented source allocation. For the legacy direct Curriculum policy it selects only supplied evidence identities; the exact excerpt is resolved locally. It uses content-hash seeds where ordering is required. For anonymous legacy Curriculum outline rows it groups only a consecutive run with the same material revision, kind, parent, normalized title, and complete nonempty parser heading path. Identical headings under different chapter paths do not merge, and headingless rows remain independent structural regions. A configurable delay supports loading/cancellation tests.

The complete workflow can be repeated offline, but this does not promise byte-identical output between runs. Workflows create new IDs and state, which can alter later inputs, selected weak concepts, and generated ordering. The guarantee is deterministic provider behavior for identical input plus deterministic local scoring and transition rules.

### Hy3Provider

The real adapter calls an OpenAI-compatible `chat/completions` endpoint. Base URL, model, key, and timeout are server-owned; Settings may save a validated local override in a versioned ignored JSON file outside Course SQLite. A usable saved configuration takes precedence over startup environment values; malformed or incomplete saved data falls back to a valid environment configuration or Fake mode.

Automated/offline processes can declare `AUTOMATION_EXPECT_PROVIDER=fake`.
`ProviderRuntime` evaluates that guard only after saved/environment precedence
has produced the final runtime configuration, but before constructing a provider
or accepting any operation. A saved Hy3 override, a later Hy3 activation, or an
external TokenHub visual mode therefore fails closed before the first provider
request. The guard is opt-in and does not alter normal Settings precedence.

`Hy3Provider.complete` performs one initial request. It accepts only a complete JSON value or exactly one whole-response JSON markdown fence; prose plus an embedded fragment, wrong wrappers, null normalization, and invented fields are not compatibility paths. JSON parsing is followed by the existing Zod schema and the explicitly supplied input-aware candidate validator. Most important structured output has two independent repair budgets: at most one schema repair and at most one candidate-semantic repair. A third physical attempt is possible only when the second attempt crosses failure kind, such as schema-invalid to schema-valid but candidate-invalid. Repeated equivalent schema or candidate failures still exhaust after attempt two. Compositional Lesson and Practice deliberately use a stricter limit: each logical call has one original plus at most one targeted repair, even if the failure kind changes. Their input-aware validator names the invalid stable `L*` or `PR*` identities, local merge logic restores every frozen valid peer, and a second failure exhausts that phase. Technical attempt codes preserve `EMPTY_RESPONSE`, `JSON_PARSE_FAILURE`, `SCHEMA_VALIDATION_FAILURE`, `SEMANTIC_VALIDATION_FAILURE`, `TRUNCATED_OUTPUT`, `PROVIDER_FORMAT_INCOMPATIBILITY`, and `REPAIR_EXHAUSTED` distinctions without changing the generic learner-facing provider error. The optional evaluation/debug diagnostic envelope retains only operation/schema identity, attempt kind, transport/envelope shape, UTF-8 byte counts, bounded finish reason, redacted structure, schema paths/codes, semantic codes, and repair outcome. Raw prompts, source/learner text, provider bodies, scalar output, headers, and credentials never enter it or ordinary telemetry. Candidate validators return only model-correctable reasons and stable diagnostic codes plus bounded sanitized facts. They throw authoritative Contract, manifest, predecessor, active-pointer, lease, or fencing conflicts, which fail locally without repair. Transport errors, cancellation, and timeout also do not enter the repair loop. The adapter does not universally send `response_format`: Hy3 Study Clinic accepts configurable OpenAI-compatible endpoints whose native constrained-output capabilities differ. A future verified endpoint capability would still precede, not replace, JSON parsing, Zod, and local semantic validation. The per-request abort timer covers `fetch`, headers, and response-body parsing, so a sent timeout is one failed physical attempt and is not automatically retried. Ordinary calls use the configured `HY3_TIMEOUT_MS` (30000 ms by default), the minimal connection probe is capped at 15000 ms, and Curriculum and StudyPlan generation default to 240000 ms. Curriculum requests additionally set a 16000-token output ceiling, based on observed usage with bounded headroom. Direct Curriculum ownership uses `3 * provider timeout + 120000ms` (840000 ms, or 14 minutes, at the default). A maximum `course_map_materialization_v1` operation uses `9 * provider timeout + 120000ms` (2280000 ms, or 38 minutes) around its three logical calls. These are bounded operation policies, not a global timeout increase; caller cancellation remains authoritative.

Credentials remain server-side, authorization headers are redacted, and no configured endpoint/model/key is supplied by the repository. The explicit connection probe sends one `OK` chat request with `temperature=0` and `max_tokens=1`; providers that do not honor `max_tokens` may still charge their minimum request usage. Passing this probe establishes reachability, credential/model acceptance, and a minimal compatible response at that time. It does not establish future large-request latency or availability.

### Browser Settings boundary

The system Settings surface edits provider configuration through validated `GET/PATCH /api/config` and user-triggered `POST /api/config/test`. The safe response includes mode, non-secret URL/model, completeness, source, generation, a boolean secret-configured flag, and the status/generation/timestamp of the last connection test. The secret is never returned. Runtime updates construct, persist, and activate atomically; in-flight requests retain their provider snapshot. A configuration generation change invalidates the prior test result. Local service health, saved configuration, last connection test, and individual provider-operation failures remain separate states; a failed generation does not invalidate saved credentials.

The browser never stores provider secrets in local or session storage. The API-key field is password-type and is cleared after save/reset or explicit cancellation of credential editing. Reset discards unsaved provider and credential edits; confirmed removal persists an explicit credential removal while switching to Fake because Hy3 cannot be active without a key. Switching Fake/Hy3 otherwise does not delete credentials or mutate learning state. Diagnostic/about information remains progressively disclosed.

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

### Coverage/Risk current projection

Coverage/Risk entries are append-only audit records. Deterministic seeding may
record one observation per unmapped SourceBlock and one readiness observation per
unverified Curriculum objective; those rows preserve exact revision and source
provenance but are not independent learner blockers. Course Home computes a
current projection fenced to the active Contract and source manifest, groups
rows by stable material/Curriculum/objective identity, and keeps supporting raw
record ids inspectable. Structural source observations, meaningful Curriculum
gaps, planning warnings, recommendations, intentional deferrals, execution
blockers, readiness gaps, and historical observations remain distinct.

Phase 12B3 soft feasibility deficits produce advisory planning warnings. A
provider-generated recommendation is persisted as a pending planning record;
only a learner-accepted consequential route decision becomes an intentional
deferral. Rejected recommendations remain immutable history and do not inflate
the current Course summary. Mapping arithmetic never proves semantic
completeness or entailment.

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
- `.md`, `.txt`, `.html`, `.htm`, `.pdf`, `.pptx`, `.docx`, `.png`, `.jpg`, `.jpeg`, and `.webp` file uploads use base64 JSON and are limited to 10 MB after decoding. Common standalone source-code extensions use the same bounded text path. Public Web Snapshots use `POST /api/materials/web-snapshot` and the same HTML parser after a captured response.
- Every file is checked against its extension and optional declared MIME type. PDF requires a `%PDF-` header; PPTX and DOCX require ZIP/OOXML signatures and their expected package parts. Standalone images require matching PNG, JPEG, or WebP bytes and bounded sharp validation. Markdown/TXT/source-code bytes pass a binary-content check instead.
- Invalid, oversized, or malformed inputs fail before the first database write. Text-oriented inputs must retain extractable text unless a supported original asset makes the rich document valid; a standalone Image Material and an asset-only PPTX/DOCX revision may legitimately have no textual SourceBlocks.

Binary sniffing applies only to raw text-like bytes. Parsed PDF/PPTX/DOCX text is sanitized instead, preventing valid documents with extractor artifacts from being misclassified as binary.

### PDF layout reconstruction

`pdfLayout.ts` uses positioned PDF.js text items from `unpdf` rather than flattening pages immediately. The deterministic stages are:

1. cluster baselines into stable visual lines;
2. derive body font size, line spacing, and right-margin statistics;
3. remove repeated page-margin headers/footers and bare page-number lines, while preserving heading-sized text;
4. infer heading tiers from font-size differences and emit Markdown headings;
5. repair evidence-supported visual wraps for CJK and Latin text, including hyphenation and line-fit constraints;
6. recover line-leading list bullets that some ToUnicode maps expose as U+0000;
7. insert `|` separators only for conservatively detected aligned table rows; and
8. return normalized text plus exact per-page character spans.

Paragraphs can cross a repaired page boundary, so normalized units and SourceBlocks store `pageNumber` through nullable `pageEnd`. Image-only pages produce warnings; a document with no extractable text returns `PARSE_FAILED`. The adapter does not enumerate PDF figures. There is no OCR or visual interpretation.

### Bounded OOXML package reader

PPTX and revision-aware production DOCX ingestion share a purpose-built bounded package reader over `yauzl@3.4.0`. It keeps members in bounded memory and never extracts an uploaded package to the filesystem. The hard limits are 1,000 members, 20 MiB per expanded member, 100 MiB total expanded bytes, and a 1,000:1 maximum declared compression ratio; streamed byte counts are checked again rather than trusting the central directory.

The reader rejects absolute/traversing or duplicate normalized paths, encrypted members, unsupported compression methods, impossible sizes, malformed central directories, and declared/actual size disagreement. Relationship resolution cannot escape the package. External URI, fragment, and query targets resolve to no local member and are never fetched. XML parsing rejects `DOCTYPE`/entity declarations and bounds each parse to 40 MiB of XML, 200,000 element nodes in aggregate, and depth 100. Learner-visible warnings do not expose internal OOXML relationship IDs.

### PPTX extraction

`pptx-ooxml-rich-v1` follows the relationship order declared by `ppt/presentation.xml`; it does not infer order from slide filenames. Each accepted SourceBlock carries its 1-based `slideNumber`. Inside a slide, grouped shapes are traversed in stable OOXML drawing-layer order. This policy is deterministic and auditable, but every PPTX receives an explicit warning that drawing-layer order may not equal spatial or semantic reading order.

The adapter preserves visible shape paragraphs, contiguous list items, reversibly escaped TSV tables with row/column/cell-paragraph order, speaker notes as separate `speaker_notes` units owned by their slide, and supported embedded media relationships. Notes are source content from the package and are never silently merged into visible slide text. Missing or malformed relationships, unsupported object kinds, and text-free slides produce partial-extraction warnings. A presentation with neither extractable text nor a supported original asset fails; an asset-only presentation remains valid original source material but produces no textual SourceBlocks.

Charts and SmartArt are recorded only as unsupported/partial warnings; their labels are not flattened into fabricated semantic claims. Equations, unknown shapes, and unsupported embedded objects are likewise not interpreted. No external relationship is fetched.

### DOCX conversion

Revision-aware production ingestion uses `docx-ooxml-rich-v1` over the bounded OOXML reader. It walks body children in package order and preserves Heading 1-6 hierarchy, paragraphs, contiguous lists/list items, reversibly escaped TSV tables, embedded media relationships, and headers/footers as structurally distinct source units. It never executes macros or document code and never fetches an external relationship. An asset-only DOCX remains valid original source material but produces no textual SourceBlocks.

`mammoth` remains as the compatibility conversion path for callers without revision identity and for historical behavior tests; accepted revision-aware production imports and reprocessing use the direct OOXML path so structural and embedded-asset provenance share one parser boundary. DOCX has heading/document-structure provenance but no reliable page numbers, so none are invented. Footnotes/endnotes, equations, drawings, and other unsupported objects are not claimed as complete.

### HTML files and public Web Snapshots

HTML uses `html-readability-jsdom-v1`: Mozilla Readability is the primary bounded main-content extraction strategy and jsdom parses static DOM with `runScripts: outside-only`; scripts, styles, frames, embeds, and templates are removed. If Readability returns no meaningful article, the parser uses a structured body fallback and persists a warning. Headings, paragraphs, lists, blockquotes, `pre/code`, tables, captions, safe absolute links, and image alt/reference markers are projected into the existing normalized units and `structure-aware-v1` chunks. Remote images are never fetched; only a safe reference and alt text can remain. DOM paths are honest structural locations, not pixel or raw-byte offsets.

Web Snapshots accept one explicit public HTTP(S) URL. DNS results are checked for loopback, localhost, private, link-local, multicast, documentation, carrier-grade, and reserved addresses before every request and redirect. Fetches send only an HTML `Accept` header, never learner cookies or authorization, follow at most four validated redirects, enforce a 15-second timeout and 10 MiB decompressed response ceiling, and require both an HTML MIME type and plausible HTML bytes. The captured bytes and SHA-256 are immutable revision data, alongside requested/normalized/final URL, fetch timestamp, policy version, and extraction strategy. Refreshing a URL creates a new revision; URL equality never implies byte equality. No JavaScript, browser automation, authentication, crawling, or linked-page scope expansion is performed.

Dynamic SPA shells may produce partial extraction or a fail-closed empty-source error. Exact evidence offsets refer to normalized extracted content; HTML parser output does not claim browser-rendered coordinates or raw HTML byte spans.

### Embedded ORIGINAL assets

Supported PPTX/DOCX media relationships produce immutable revision-local asset records. Each record binds the logical Material, exact MaterialRevision, stable revision-local index/ID, parent structural unit when known, package source path, signature-validated media type, SHA-256 byte hash, byte length, deterministic dimensions when available, slide/document location, relationship kind, and parser version. PNG, JPEG, GIF, BMP, TIFF, WMF, EMF, WAV, MP3, and MP4 signatures are recognized locally; PNG, JPEG, and GIF dimensions are retained when their headers are valid. Unknown or conflicting types receive warnings and unknown dimensions remain `null`.

The exact uploaded member bytes are `extracted_original` source material. `source_asset_blobs` stores them once by hash, while `material_revision_assets` preserves immutable revision ownership and provenance. Repository writes validate owner IDs, parent unit IDs, byte length, and hash collisions transactionally. These child assets are not independent logical Materials, and activating a later revision does not rewrite older asset records.

Local OCR remains intentionally absent. Phase 6B2A can prepare a generated visual description for an eligible original image occurrence, but that description is DERIVED advisory content and never replaces or becomes identical to the ORIGINAL asset.

### Parsed-text sanitation

Sanitation runs before offsets/page spans are finalized. It removes NUL and unsafe control artifacts, soft hyphens, noncharacters, stray BOMs, and unpaired surrogates; separator-like controls become newlines. Unambiguous Kangxi-radical variants are normalized back to unified ideographs so search and exact evidence validation use the same code points. CJK, emoji (including ZWJ sequences), ordinary punctuation, tabs, and newlines are preserved.

Every stored source block maintains:

```text
document.content.slice(block.startOffset, block.endOffset) === block.content
```

Blocks also carry stable content-derived IDs, heading paths, optional PDF page ranges or PPTX slide numbers, normalized structural-unit identity, `structure-aware-v1` chunker identity, and `extracted_original` content origin. Small tables and other ordinary structural units remain intact; oversized units split deterministically at bounded line/hard boundaries without generic overlap becoming independent evidence. Parser warnings/version, media type, filename, and page count are stored on the document. PDF/PPTX/DOCX documents retain their original upload bytes; text documents retain normalized content instead.

## 9. Workspace and document lifecycle

A workspace groups documents, source concepts, canonical concepts, graph versions, and accepted plans. Attempts, mistakes, and mastery remain keyed to their actual documents/concepts; workspace views aggregate them.

`workspaces.origin` is immutable creation provenance; it does not make ordinary document removal destructive:

- `manual`: explicitly created in the learning-graph UI. Retiring its final document preserves the empty workspace and its workspace-level history.
- `material_import`: auto-created for a material-library import. Retiring its final document also preserves the workspace and its history; the material is simply no longer active.
- `unknown`: pre-migration rows whose creation path cannot be reconstructed. They are conservatively preserved like manual workspaces.

Both document-removal endpoints retire the stable Material, preserve its revisions and longitudinal history, and return `{ workspaceId, workspaceDeleted: false }`, allowing the frontend to clear stale selections only after the server commits.

Explicit workspace deletion is available for every origin. The canonical Settings surface requires an exact-name typed confirmation and discloses that materials, the accepted route, Evidence, Repair, Review, mastery, and history are permanently removed. Before calling `DELETE /api/workspaces/:id`, the Course coordinator cancels its active preparation, generation, remediation, and lifecycle actions; it invalidates pending loads and clears Course state only after server-confirmed success. The server cascades documents, blocks, concepts, graph data, quizzes/history, mistakes, mastery, alignments, misconceptions, review data, Tutor data, and blueprints in one transaction. A missing workspace is treated as already deleted by the UI. No archive state, archive-aware repository query, or restore contract exists, so permanent deletion is the explicit Course-retirement policy rather than an invented reversible lifecycle.

Reprocessing reruns the current parser from stored original bytes for PDF/PPTX/DOCX, or reruns text ingestion and segmentation from stored normalized content for pasted text, Markdown, and TXT. `materials.id` remains the stable logical identity. The service stages a new immutable `MaterialRevision`, revision-owned structural units, SourceBlocks, and embedded assets, then activates it transactionally only after parsing and structural validation succeed. Earlier revisions, assets, concepts, quizzes, attempts, mistakes, mastery, and other longitudinal history remain stored; ordinary current-state reads select artifacts owned by the active revision. Exact truth-authority records tied to the replaced revision become stale rather than being rewritten, and an accepted route is marked `revalidation_required` before another Tutor turn or action may launch. The stable Learning Contract is not versioned merely because extraction changed. A parser failure is recorded and leaves the prior active revision and route unchanged. Legacy binary documents imported before original-byte storage cannot be reprocessed and must be re-imported.

Retiring one document clears the active graph pointer, marks dependent source-authority records stale, and requires accepted-route revalidation. Immutable revisions, concepts, graph history, assessments, and learner state remain inspectable; current active-material reads exclude the retired source. Canonical groups remain backed by their surviving source concepts where available.

## 10. Database and migrations

`better-sqlite3` runs with foreign keys enabled. Repositories validate domain objects on writes and reads. Multi-row operations use explicit transactions, and migrations are recorded in `schema_migrations`.

The 36 shipped migrations are:

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
18. `complete_provider_inference_telemetry` - permits workspace-less connection-probe calls and non-agent attempts, adds nullable provider generation, and preserves populated v17 telemetry without fabricating historical generation.
19. `canonicalize_provider_generation_nullability` - repairs migration-18 schema drift by rebuilding the attempt/usage foreign-key chain with nullable, no-default provider generation while preserving every telemetry value. An interim migration-18 build backfilled existing rows with `1`; because those rows have no provenance marker and application timestamps may use an injected clock, migration 19 cannot reliably distinguish that backfill from a genuinely observed generation 1 and does not guess by rewriting either value.
20. `immutable_learning_unit_teaching_briefs` - append-only, route- and source-pinned Teaching Brief artifacts.
21. `session_owned_lesson_execution` - weak StudySession-owned lesson presentation state and append-only presentation events.
22. `tutor_pedagogy_turn_metadata` - nullable audit metadata for the selected pedagogical move and offered source references on conversational StudySession turns.
23. `structure_aware_material_derivation_metadata` - parser/chunker/source fingerprints, revision-owned normalized structural kinds and locations, SourceBlock structural-unit ownership, `structure-aware-v1` identity, and honest nullable legacy metadata.
24. `rich_document_assets_and_slide_provenance` - PPTX slide locations on normalized units and SourceBlocks plus hash-addressed original asset blobs and immutable MaterialRevision-owned asset provenance.
25. `immutable_visual_derivations` - advisory, occurrence-bound visual descriptions over original image assets.
26. `visual_provider_runtime_identity` - provider endpoint/runtime identity for immutable visual derivations.
27. `html_web_snapshot_metadata` - immutable requested/final URL, response hash, fetch policy and extraction strategy metadata for HTML Web Snapshots.
28. `formal_assessment_evidence_backbone` - immutable formal assessment versions, attempts, grades, criterion-gated evidence, and the separate assessment reconciliation record.
29. `diagnostic_repair_orchestration` - immutable Repair packets, non-credit practice events, and append-only Repair status history.
30. `formal_assessment_progression_bridge` - immutable assessment launch context plus retryable linkage to the existing deterministic progression reconciliation.
31. `objective_review_scheduler_successor` - objective-bound successor Review targets, executions, immutable events, and locally fenced scheduler state.
32. `review_cutover_backfill_support` - explicit null-memory Review state, deterministic event sequence numbers, and audited one-time eligibility decisions for supported historical Evidence.
33. `mastery_red_team_shadow` - immutable shadow snapshots, candidates, evaluations, and explicit no-mutation audit fields.
34. `adaptive_pace_observations` - append-only active-time observations and versioned pace projections without making pace a mastery authority.
35. `curriculum_quality_evaluations` - immutable independent Curriculum quality evaluations and bounded repair audit metadata.
36. `informal_lesson_practice_execution` - session-owned non-credit Practice state and events, including bounded retries, without any Formal Evidence, mastery, mistake, Review, Agenda, or Plan authority.
37. `immutable_accepted_lesson_checkpoints` - route/source/skeleton-pinned accepted Lesson predecessors that survive a Practice failure without becoming learner-state authority.
38. `accepted_lesson_logical_call_provenance` - nullable historical backfill plus required completed Lesson logical-call provenance for new checkpoints.
39. `allow_accepted_lesson_workspace_cascade` - preserves direct checkpoint immutability while allowing authorized whole-workspace deletion to cascade through the session-owned artifact.

Table-rebuild migrations disable foreign keys only around the controlled rebuild, run `foreign_key_check` before commit, and restore enforcement even after failure. Tests cover idempotence, populated v1 and v3 upgrades, all-or-nothing rollback, and data preservation.

### Implemented Learning Execution Agent: Phases 1-5A

The current implementation closes one bounded course-execution loop. Phase 5A adds only the lesson-aware conversational Tutor policy described above; it does not treat the design document as a claim that later Tutor UX, Assessment/Repair, FSRS, multimodal, or other Phase 5 capabilities exist.

- **Phase 1: durable foundations.** A logical Material owns immutable revisions and revision-owned SourceBlocks. Learner material-role assignments are separate from parsing. Material-role proposal and confirmation routes validate workspace, Material, and assignment identity before invoking mutating services, so a URL/body mismatch is side-effect free. Source authority is distinct from learner scope; accepted model output is runtime-validated; consequential commands are durable, idempotent, leased, and fenced; model logical calls, physical attempts, cache identity, and optional cost policies are persisted.
- **Phase 2: accepted route.** A learner-confirmed Learning Contract contains stable logical Material/role scope, never a MaterialRevision. Curriculum manifests bind exact active revisions and blocks. The production default uses the direct `legacy_direct_v1` provider contract. The internal/testable `course_map_materialization_v1` policy first creates an operation-local Course Map, then deterministically partitions every region across no more than two LearningUnit-detail batches and assembles their validated output into the existing Curriculum contract. Under either policy, provider output is materialized and validated against the same resolved manifest, blocks, scoped Concepts, graph relations, canonical memberships, and source authority, then authority is rechecked inside one persistence transaction. No partial stage is persisted. Parser outlines currently expose no honest normalized structural-unit IDs, so no such ID is offered and provider arrays must remain empty; future non-null offered IDs derive their revision owners from that same outline. Canonical IDs are offered only when a current canonical has a scoped source-Concept member in the exact manifest, and repository persistence independently rechecks that membership. A proposed StudyPlan is locally checked for hierarchy, objective coverage/deferral, feasibility, authority, and launchability. Its deterministic preflight is built from the same provider input and launch profiles as generation, reports executable/non-executable counts, kind distribution, planning-entry count, and prompt-size estimates, and blocks a provider call when the accepted scope cannot be accounted for. It is readiness evidence, not permission to bypass per-item launch validation. Input-relative IDs, ordering, depth, per-unit capability, coverage, and deferral rules remain local deterministic gates. `due_review` capability uses only Concepts mapped to that LearningUnit. Accepting a route rechecks that the Plan is bound to the latest accepted Curriculum and the current exact material manifest. Version lineage may pass through retained stale/rejected proposals, but must descend from the active Curriculum and accepted Plan; this preserves audit history without allowing a stale route to reactivate. Agenda launch rechecks route pointers, Agenda version, queued/active state, Plan/item kind and unit identity, current capability, and targeted-repair preconditions. A successor failure or rejection preserves the active route. Successful successor activation also abandons predecessor StudySessions, cancels their unfinished turns and logical calls, and terminally fences their operations in the same transaction.
- **Phase 3: conversational execution.** A StudySession is a durable conversation and route container, separate from the accepted Plan. It records turns, exchanges, summaries, events, current Agenda item, and nested detour frames. Tutor context is bounded to the accepted source manifest. Pause, resume, and stop are versioned execution transitions; stale routes are rejected rather than silently resumed. The frontend selects an open session only when all four accepted-route IDs match and reloads that selection when the route execution version changes. After a definitive provider failure has already advanced the durable Session version, the owning Study surface reloads authoritative detail before enabling the next distinct send; interrupted retries retain their original frozen command identity. Tutor events may be delivered as persisted NDJSON as well as retrieved from session detail.
- **Phase 4: evidence-gated progression and replanning.** Formal assessment contracts bind a quiz to the accepted route. Local reconciliation records objective evidence, unit progression, next actions, and deterministic reason codes. Conversation does not create formal completion. Pace/risk qualification may create a bounded successor-plan proposal; it cannot replace the accepted route without the learner's decision. Goal outcomes preserve the evidence and gap snapshot that led to closure or abandonment.
- **Phase 4B1: Teaching Brief lesson execution.** Explicit preparation binds an immutable Brief to the current `teach_unit` Agenda item. A weak session child persists bounded segment position, revisits, informal responses, and presentation completion with command/version fencing. Tutor receives only a current Brief slice; informal checks carry no credit, and no presentation action changes Plan progress, Agenda completion, Evidence, Mistakes, or Mastery.
- **Phase 5A: lesson-aware Tutor pedagogy.** The existing `respondToTutorTurn` operation remains the single Tutor-turn provider call (plus the shared one-repair structured-output allowance). Its bounded input includes route state, current lesson segment, nearby segments, compact source offers, recent moves, and whether the existing formal checkpoint is launchable. The provider returns one validated pedagogical move, learner-facing text, selected offered source references, and an advisory route signal. Local policy owns the move vocabulary, direct-intent constraints, confusion handling, repetition guard, source identity, context budgets, and formal/non-credit authority. A completed StudySession turn stores `tutorMetadata` under migration 22 for audit/resume; this metadata has no path to Evidence, Mastery, Mistakes, Reviews, Agenda completion, or Plan progress. Detours are signals only and return-to-route remains explicit. The offline `lesson-aware-tutor-v1` profile checks 23 deterministic scenarios; it does not claim educational effectiveness or real-Hy3 quality.

### Curriculum-to-StudyPlan execution contract

Curriculum provider output may select source evidence, offered Concept IDs, offered canonical IDs, graph relations, prerequisites, and objectives. It does not grant identity or progression authority. Materialization first resolves every operation-local evidence ID through the frozen evidence catalog and verifies the exact active MaterialRevision, SourceBlock, quote, and offsets. A LearningUnit receives a source Concept binding only from an offered current Concept selected by ID, an authoritative source member of a selected offered canonical Concept, or an exact match between selected evidence and that current Concept's already-verified grounding. Accepted canonical memberships of those materialized source Concepts deterministically supply the canonical bindings. Unknown Concepts, canonical groups without a materialized authoritative member, invalid grounding, and membership changes fail closed. Titles and approximate citation similarity never create Concepts or canonical membership.

The service identifies an execution-remediation successor when the nearest accepted Curriculum in its predecessor lineage cannot pass the unchanged deterministic StudyPlan preflight; rejected or stale intermediate versions do not erase this obligation. The candidate must establish the frontier permitted by the current Contract: at least one launchable LearningUnit when explicit deferral is allowed, or launchability for every required unit when it is forbidden. The candidate validator participates in the provider's existing shared original-plus-one-repair allowance. Final materialization repeats the gate before persistence. Acceptance reconstructs the current manifest and reruns both predecessor classification and candidate preflight, so a disappeared Concept or other launch-state change leaves the candidate proposed and the predecessor accepted. Course overview derives `canAcceptCurriculum` from the same current-state check.

This rule applies identically to Fake and Hy3 providers. Fake output may leave Concept arrays empty like real output; only the shared local materializer can derive bindings. The server does not repair a source-only Curriculum by inventing a Concept from a title or quoted passage. Concept extraction must first persist a current revision-grounded Concept, after which one learner-authorized successor can derive and validate the binding.

Curriculum recovery is a read-only deterministic projection over the selected Contract, active MaterialRevisions, exact current Concept groundings, accepted canonical memberships, accepted Curriculum, and StudyPlan preflight. It never calls a provider or creates authority. The projection exposes the earliest next action through these states:

- `not_required`: the accepted planning Curriculum does not require execution repair;
- `concept_grounding_missing`: no included Material has a usable current Concept, so the learner must explicitly build Concept grounding;
- `concept_grounding_stale`: only superseded-revision or invalid current groundings exist, so the learner must explicitly rebuild them;
- `curriculum_remediation_ready`: at least one exact current grounding exists and the accepted Curriculum still lacks a launchable frontier, so a successor may be proposed; and
- `curriculum_candidate_ready`: a proposed successor passes the unchanged current StudyPlan preflight and is ready for learner review.

The Course capability and the Curriculum proposal service both consume this projection. Missing/stale states suppress the successor capability, and a direct execution-repair command fails durably before provider attempt creation with the Concept recovery action. The existing Explore surface performs only GET requests when opened; an explicit Concept extraction completion triggers a workspace-fenced Course reload. A failed or non-launchable successor never changes the accepted predecessor, and it cannot become acceptable until the same preflight succeeds against current authority.

Learning Contract scope readiness is a separate deterministic projection. A Contract's stored Material ID and role-assignment ID/version remain immutable acceptance provenance. Current scope validity compares each stable logical Material with its Course membership/availability and latest learner-confirmed semantic role. A pending role proposal does not invalidate the accepted scope, and a confirmed successor with the same semantic role remains current. A retired, missing, or moved logical Material, missing confirmation provenance, or a confirmed different role yields structured `reconfirmation_required` issues. MaterialRevision IDs, parser/content fingerprints, SourceBlocks, Concepts, canonical memberships, graph versions, Curricula, and StudyPlans never participate in this projection.

Course overview reports that scope readiness and suppresses downstream Curriculum/StudyPlan capabilities when reconfirmation is genuinely required. Direct Curriculum and StudyPlan proposal services enforce the identical rule before provider work. When scope remains current, Curriculum recovery keeps ownership of revision-bound staleness and routes missing or stale grounding to Concept extraction. Neither evaluation mutates the accepted Contract or calls a provider. This prevents a downstream rebuild from becoming learner-intent churn without making real logical scope changes permissive.

Persisted Curriculum validation warnings remain immutable audit data. The read model projects bounded diagnostics into structured coverage warning codes/counts. `CurriculumView` renders learner-safe copy from that structure and keeps the original technical string inside a closed disclosure, including for historical accepted Curricula; unknown warning shapes receive generic safe copy rather than being rendered directly.

The route API is split by responsibility: `agentCourse.ts` owns Contract, Course Preparation, Curriculum, StudyPlan, accepted-route, coverage-risk, and Agenda-action endpoints; `studySessions.ts` owns StudySession lifecycle and Tutor-turn endpoints; `formalProgression.ts` owns progression, replan, and goal-outcome endpoints. Route handlers parse requests and delegate to services; repositories preserve the durable invariants.

### Course Preparation coordinator

`coursePreparation.ts` projects one strict learner-safe preparation state from the current Contract scope, active MaterialRevisions and SourceBlocks, exactly grounded Concepts, Curriculum lineage, StudyPlan preflight, accepted route, and durable operation rows. The projection returns one optional machine action, one learner action, four checkpoints, a Course revision fingerprint, and bounded blocker/failure metadata. `GET /api/workspaces/:id/preparation` is read-only: navigation neither creates an operation nor calls a provider.

`POST /api/workspaces/:id/preparation/run` accepts only a learner command bound to the projected revision and stable operation key. One claimed `course_preparation` operation loops for at most 200 durable transitions, renewing its 30-minute lease between steps and propagating the request `AbortSignal`. It calls the existing section-aware Concept analysis, Curriculum proposal/remediation, Curriculum acceptance, StudyPlan preflight, and StudyPlan proposal services instead of duplicating their domain logic. Concept persistence rechecks both the parent lease/fence and active MaterialRevision immediately before each additive write. An expired preparation lease is projected as retryable; the command path interrupts only expired preparation operations for that Course before claiming a fenced retry. Exact running invocations observe the active operation, and exact completed invocations replay the stored result without another provider call.

The coordinator may accept a Curriculum only when the proposal event was created by the local coordinator with `course_preparation_v1` and the current deterministic StudyPlan preflight passes. The public Curriculum route accepts only `learner_review`; learner-created proposals therefore remain explicit governance stops. StudyPlan acceptance remains learner-only and is presented as the final course-plan decision. A provider failure, cancellation, stale Contract/Material, failed preflight, or lost lease cannot replace an accepted predecessor. No migration or production dependency is required because the coordinator reuses migrations 14-15 operations/events and accepted-route storage.

### Frontend product shell

The frontend projects those domain boundaries into one selected-Course journey rather than exposing each subsystem as a top-level application:

```text
Course selection
└── current Course
    ├── 主页
    ├── 学习
    ├── 课程结构
    ├── 知识地图
    ├── 进展
    └── 课程资料
system zone
    ├── runtime mode
    └── 设置
```

`App` owns selected-Course continuity, provider bootstrap fencing, canonical hash parsing, legacy alias normalization, and browser history. `AgentCourseWorkspace` projects each controlled destination through the single Course navigation model and reports only learner-initiated destination changes. Applying a back/forward intent is suppressed from the outbound route effect until the requested state is active, so an old Progress subsection cannot overwrite the browser destination. Switching Course cancels owned operations and always opens the new Course Home. `AgentCourseShell` owns layout state only: an original vector product mark and wordmark, a 220 px expanded/60 px collapsed desktop sidebar, a below-768 px modal drawer with focus containment and Escape restoration, Course navigation, and the separate system zone. Settings receives its own layout mode. The brand asset is also used by the browser favicon. None of these surfaces owns Course domain state.

Course Home composes the bounded overview into one next action, a short Agenda, learner-actionable exceptions, and secondary disclosures. Confirming the Contract starts one cancellable preparation request. Home shows four compact learner-safe checkpoints, recoverable retry copy, and exactly one course-plan acceptance control; internal Concept/graph/operation identifiers remain absent. The preparation action owns its loading, error, cancellation, and Course identity. Switching Courses aborts it and ignores late results, while same-Course cancellation refreshes authority only after the request unwinds. Each learner-triggered asynchronous command is owned by its initiating surface: Contract confirmation and Curriculum proposal failures stay beside their Home actions, Plan accept/reject stays in its decision surface, Continue/start stays beside the next action, Progress commands stay in Progress, and Tutor failures stay in Study. A failed Curriculum proposal says that the new structure did not pass source-consistency checks, the prior version remains unchanged, and whether one repair was attempted; bounded deterministic reasons are available under an optional technical disclosure. The API client runtime-validates this known detail shape. Durable command failures store bounded known AppError/provider code, message, and sanitized details, while unexpected failures store only a generic message and never raw error text. Retry/replacement or success clears the corresponding local failure. Learning-route generation retains its longer-lived Home-owned recovery state. None of these errors is inserted into unrelated Study, Curriculum, Progress, Knowledge Map, Materials, or Settings layout containers, and the removed global action banner is not recreated. Transient shell notices render in a shell-owned notification region outside route-specific grids. Course Materials is a dedicated destination over the existing document APIs. `学习` renders the durable StudySession while retaining formal/informal evidence boundaries. `CourseProgressView` consolidates formal progression/Evidence, assessment history, mistakes/Repair, concept mastery/Review, and bounded Contract/Curriculum/StudyPlan history. The optional manual-assessment surface reuses the existing quiz generation, grading, result, and history contracts inside the Course shell.

The learner-facing `KnowledgeMapView` is the only ordinary graph destination. `GraphWorkspaceView` remains Course-locked behind `课程结构 > 课程概念依据` for concept extraction/deepening, graph generation, alignment review, graph version activation/history, and provenance audit. In that mode it does not list/switch/delete workspaces or add/delete Materials, and it does not request learner overlay, misconceptions, Review, daily queue, or remediation plans. Tutor, quiz launch, learner-state badges, weak/Review counts, remediation, and learner onboarding stages are absent. Concept and edge details use read-only grounding projections. A failed preparation action retains the previous valid graph/version.

`CurriculumView` is a read-only projection over the accepted or selected Curriculum version. It first shows the actual version/status, the latest accepted version available in history, major/chapter/section/topic/objective counts, and only server-persisted `started` units as the current location. A presentation topic may combine consecutive source-fragment siblings only when they share parent, normalized title, objective content/authority, concept/canonical/prerequisite/graph/risk mappings, plan mappings, progress state, and source material/revision. This is not title deduplication: different pedagogical or state fields preserve separate rows, and every LearningUnit, objective, and exact source reference remains in technical detail. Major branches derive summaries from their real descendant objectives, prerequisites, source references, and route links. Non-leaf content mounts only after an `aria-expanded`/`aria-controls` disclosure is opened. When a section directly contains more than 12 presentation topics, the first 12 mount after expansion and a second accessible disclosure controls the remainder (covered with a 277-unit fixture). Expansion state resets when Curriculum identity/version changes and is never persisted as domain state.

Learning objectives preserve their independently verified versus in-scope/unverified truth-authority labels. Grounding resolves existing DocumentSummary and SourceBlock data into real material/file names, source types, pages or headings, bounded excerpts, and an owning-Material navigation action. Exact Material/Revision/SourceBlock and unit/objective IDs remain under nested technical disclosure. A source-only unit with no Concept or graph-edge mapping is described naturally there instead of repeating `0 / 0`; no relationship is fabricated. The copy preserves the distinction between exact quotation/location and complete semantic entailment. Presentation recovery handles duplicate IDs, missing parents/children, repeated links, and cycles deterministically with visible notices; it neither loops indefinitely nor repairs the stored hierarchy. There is no invented Curriculum search/filter or inferred progress state.

The fake provider addresses the parser-granularity root cause for future proposals: consecutive anonymous outline rows group only within the same complete nonempty parser heading path and structural region, with bounded evidence and concept lookup across the grouped blocks. Equal visible headings under different chapters remain separate, and headingless rows never collapse into one document-wide unit. Explicit structural-unit identities are never merged merely because titles match. A regenerated Curriculum uses the existing successor/version workflow and retains exact SourceBlock references (up to the Curriculum contract's per-node bound). Learner-created proposals remain proposed until learner acceptance; a coordinator-created proposal may be locally accepted only through the preparation policy and current preflight described above. Previously accepted Curricula remain immutable and use the conservative presentation adapter above.

StudyPlan does not introduce a `PlanningUnit` or reuse presentation topics. Its authoritative input is the accepted Curriculum's exact LearningUnits. If a historical accepted version promoted parser fragments into source-only LearningUnits, deterministic preflight exposes the missing capabilities and Home returns the learner to Curriculum review. Once a pedagogical successor is accepted, StudyPlan references those exact successor LearningUnit IDs; Plan launch validations retain the accepted source-manifest fingerprint, and Agenda composition revalidates each selected item against current resources.

The Learning Contract editor treats Material-role confirmation as its existing separate authoritative command boundary, not as a client-only field change or an implicit side effect of Contract persistence. It initializes role choices from the latest learner-confirmed history entry even when a newer proposal is pending. Before saving scope it refetches the current role assignment, confirms an already matching proposal (or proposes and confirms the reviewed choice), refetches the resulting history, and only then sends the exact confirmed assignment ID/version in Contract scope. It also refetches Course overview and uses the authoritative latest/active Contract pointers for the create command. A concurrent role or Contract-pointer conflict refreshes visible state and asks the learner to review again in Chinese; it never bypasses the server freshness check or exposes the old raw English diagnostic. Navigating to Concept recovery closes the editor and its operation-owned error without clearing unrelated Home failures. Reload follows the same history and overview endpoints, so freshness is durable rather than component-local.

The prior Library, Practice, Mistakes, mastery, Review, history, provider, and graph capabilities are reused rather than cloned. Their parallel peer shells are retired; canonical Course destinations and deterministic legacy aliases preserve their jobs and bookmarks. This shell is presentation-only: it does not infer completion from prose, change source authority, rewrite Plan/Agenda ownership, or modify persistence and provider contracts.

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

Compositional teaching applies the same rule between its two child phases. Preparation rechecks the exact active Curriculum/Plan/Session/Agenda route and source-context fingerprint before writing the accepted Lesson checkpoint, again before Practice, and again when finalizing the Teaching Brief. Lesson and Practice use distinct logical-call identities and attempt ledgers under the owning operation. Cancellation reaches both provider calls; an expired lease, changed route/source/skeleton, wrong fencing token, or late response cannot persist. Practice failure leaves the immutable accepted Lesson checkpoint intact, while a retry proves that checkpoint still matches the current route before skipping Lesson generation.

Ordinary command leases remain five minutes. StudyPlan proposal uses a ten-minute lease because its bounded provider envelope permits a 240-second first request plus exactly one repair request. Lease checks run before repair, before successful telemetry completion, and again at transactional finalization. This lets a valid bounded repair finish within its intended envelope without allowing a cancelled, stolen, expired, or wrong-token worker to persist.

An interrupted StudySession turn is retryable under its original expected session version only when local code proves ownership of that exact durable logical turn. The immutable command/fingerprint, turn identity and status, single learner exchange, transcript watermark, logical-call and attempt history, operation interruption event, and fencing state must all agree. The retry adds a physical attempt to the existing logical call; changed content/fingerprints and unrelated fresh commands with stale expected versions still conflict.

At process startup, unfinished StudySession turns and running operations are marked interrupted. During a live process, `createOrGet` performs demand-driven expired-lease recovery only after an identical immutable operation identity has matched. Recovery transactionally interrupts linked turns, records sent attempts as `outcome_unknown` and queued attempts as `interrupted`, clears ownership, and records the interruption; the replacement claim increments the fencing token. A late worker holding the older token cannot append an authoritative event or terminal result. There is no background lease sweeper: live recovery occurs when the exact command is retried.

## 18. Production dependencies added for the upgrade

| Dependency                                                             | Scope  | Rationale                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`unpdf`](https://github.com/unjs/unpdf)                               | server | Maintained serverless PDF.js distribution exposing positioned text items needed for deterministic layout reconstruction and page provenance, without native binaries or OCR.                                                                                                                                          |
| [`mammoth`](https://github.com/mwilliamson/mammoth.js)                 | server | Retained compatibility DOCX-to-HTML path for historical/non-revision-aware callers; revision-aware production DOCX ingestion now uses the bounded direct OOXML adapter.                                                                                                                                               |
| [`yauzl@3.4.0`](https://github.com/thejoshwolfe/yauzl)                 | server | Small, maintained lazy-entry ZIP reader used only for bounded PPTX/DOCX package access. It supports central-directory validation and streamed member reads without extracting attacker-controlled paths to disk; local code adds member, byte, compression-ratio, duplicate-path, encryption, and relationship gates. |
| [`@xmldom/xmldom@0.8.13`](https://github.com/xmldom/xmldom)            | server | Maintained namespace-aware XML DOM parser used for the limited OOXML parts needed by PPTX/DOCX structure and relationships. Local code rejects entity/doctype declarations, malformed XML, and oversized/deep trees before consuming nodes.                                                                           |
| [`sharp@0.35.3`](https://github.com/lovell/sharp)                      | server | Maintained Node/libvips image pipeline used for actual-byte PNG/JPEG/WebP inspection, strict bounded decode, EXIF orientation, and deterministic provider transport resizing/transcoding. Exact original bytes remain immutable source authority.                                                                     |
| [`@mozilla/readability@0.6.0`](https://github.com/mozilla/readability) | server | Apache-2.0 mature main-content scoring and boilerplate reduction for static HTML. Adapted locally so accepted output still passes structural-unit, warning, provenance, and chunk limits.                                                                                                                             |
| [`jsdom@26.1.0`](https://github.com/jsdom/jsdom)                       | server | MIT WHATWG DOM/parser used for malformed HTML recovery and deterministic structure projection. Configured without resource loading or page-script execution; browser fidelity is intentionally out of scope.                                                                                                          |
| [`@xyflow/react`](https://github.com/xyflow/xyflow)                    | web    | Maintained React 18 graph renderer with accessible pan/zoom, selection, and controlled dragging.                                                                                                                                                                                                                      |
| [`d3-force`](https://github.com/d3/d3-force)                           | web    | Small standard force-layout library used for bounded, hash-seeded synchronous network layout.                                                                                                                                                                                                                         |

No vector database, graph database, orchestration framework, authentication layer, microservice, or new backend language was introduced.

## 19. Known architectural limits

- Settings can verify local health/config endpoints and, only after an explicit user action, run the minimal external Hy3 connectivity probe. It also edits server-owned provider configuration through validated loopback APIs; campaign verification never calls the real provider.
- Curriculum uses branch expansion and a 12-unit preview for large direct-unit sections, but it has no search/filter. Missing current/progress state remains visibly unavailable, and malformed-tree recovery changes presentation only.
- PDF fidelity depends on the file's text layer. There is no OCR, and rotated/multi-column text, diagrams, PDF figures, complex tables, and text in images are not reconstructed.
- Header/footer removal, visual-wrap repair, heading recognition, and table detection are conservative heuristics and can misclassify pathological documents.
- PPTX drawing-layer order is deterministic but is not guaranteed spatial/semantic reading order. Charts, SmartArt, equations, unknown shapes, and unsupported embedded objects are not semantically interpreted.
- DOCX does not provide stable page provenance. Footnotes/endnotes, equations, drawings, and other unsupported document objects may be absent or produce partial warnings.
- Embedded PPTX/DOCX images retain exact ORIGINAL bytes and provenance. Phase 6B2A can explicitly prepare derived descriptions for retained PNG/JPEG/WebP image occurrences with known dimensions; other retained media remain provenance-only. Derived descriptions and advisory lexical retrieval are not visual source truth. HTML/Web Snapshot ingestion is static, no-JavaScript extraction with exact captured response bytes and URL/hash provenance; remote images remain reference-only.
- Grounding can reject semantically reasonable output when an exact quote is unavailable or ambiguous.
- Structural document mapping reports which sections have grounded concepts and which blocks are cited by verified anchors; it never measures semantic coverage, and a "mapped" section may still contain uncaptured ideas. Semantic recall lives in the evaluation suite against hand-authored labels.
- Lesson cards may contain model teaching that goes beyond the uploaded text; it is labeled AI 辅助讲解(非资料原文) and is never grading evidence, but its factual quality depends on the configured model and should be read critically. Section-aware extraction and lesson quality are bounded by the size-aware budgets and the 40-concepts-per-document ceiling.
- Teaching Skeleton activity ranges are deterministic plausibility bounds, not observed learner time, psychometric calibration, or proof of teaching effectiveness. A provider candidate can be source-faithful yet still fail the local pedagogy evaluator, and FakeProvider conformance never establishes real-provider conformance.
- Alignment review has no unmerge operation, though underlying source concepts/history remain intact.
- Completed history is limited to 50 attempts per workspace and has no edit/export/pagination workflow.
- Lexical retrieval can miss synonyms; the graph/Tutor/assessment/remediation budgets can omit useful context.
- Review scheduling and mastery are transparent heuristics, not psychometrically calibrated models.
- Deterministic bounded graph routing can retain crossings in dense arrangements.
- Material/document retirement is non-destructive to immutable revisions and longitudinal history, although the current API has no automatic unretire operation. Reprocessing retains immutable prior revisions and history, but activating a new revision changes which source artifacts ordinary current-state workflows use. Explicit workspace deletion is irreversible and cascades its course data.
- Course Preparation treats a Material as grounded after at least one exact current-revision Concept survives local validation. Section extraction can retain valid partial progress after another section fails, so this state is operational readiness rather than proof of semantic completeness or entailment.
- The production Course Map remains non-persisted, operation-local planning rather than a second accepted artifact. Its deterministic validation proves structure, identity, evidence ownership, and bounded assembly, not pedagogical superiority or semantic entailment. A map that requires more than two detail batches fails without dropping regions, and sparse regions without an executable current Concept may still fail the unchanged StudyPlan preflight.

## 20. Teaching Brief foundation (Phase 4A)

Teaching Briefs are immutable, route-pinned teaching artifacts for executable LearningUnits. The authority chain is `accepted Curriculum -> accepted StudyPlan -> teach_unit -> source context -> Brief`; the Brief never becomes Course Truth and never writes Evidence, mastery, progression, or durable mistakes. Existing `ConceptLesson` cards remain a separate concept-level artifact.

Local code constructs a deterministic source context from the LearningUnit's mapped exact evidence first, current Concept groundings second, and bounded same-revision neighboring blocks third. The context is capped at 24 blocks/offers and 32,768 serialized offer bytes, with material and section diversity recorded. Providers receive only compact operation-local objective (`O*`), prerequisite (`P*`), source (`S*`), and advisory visual (`V*`) refs plus bounded excerpts and semantic context. Database IDs, offsets, fingerprints, lifecycle state, and learner state remain local. On the current path, local code also chooses the semantic sequence as an immutable Teaching Skeleton; the provider fills only its approved content slots. Local code resolves every exact source identity, validates quotes and refs, assigns stable segment indexes, materializes objective/prerequisite IDs, computes structural quality dimensions, and persists the immutable result.

The artifact distinguishes `source_backed_teaching`, `ai_teaching_synthesis`, and `pedagogical_risk_candidate`. Examples and contrasts may be synthesis, misconceptions are advisory hypotheses, and informal checks are understanding prompts only. Exact occurrence validation proves that a quote exists at its claimed span; it does not prove complete semantic entailment. Reuse requires the accepted Curriculum, accepted StudyPlan, LearningUnit, execution source-manifest fingerprint, and deterministic source-context fingerprint to match. Stale artifacts remain audit history and are never selected as current.

Migration 20 adds the append-only `teaching_briefs` table. Preparation uses the existing operation lease, cancellation, telemetry, and fencing runtime. Fake and Hy3 providers share the same strict contracts; current composition applies an independent original-plus-one-targeted-repair ceiling to each Lesson and Practice logical call.

## 21. Lesson execution (Phase 4B1)

The current StudySession owns a weak child `lesson_execution_states` row keyed by `(StudySession, Agenda item)` and bound to the exact accepted Curriculum, StudyPlan, LearningUnit, source-manifest fingerprint, and immutable Teaching Brief. `lesson_execution_events` is an append-only audit trail for preparation, segment presentation/revisit, informal responses, and presentation completion. Migration 21 adds both tables; deleting a StudySession cascades only this presentation state.

The preparation endpoint is an explicit command, never a read side effect. It reuses a matching Brief or calls the Phase 4A preparation service once under a durable command lease. Duplicate commands observe `preparing` and do not start a second provider call. A successful preparation returns a learner-safe projection with objective, prerequisites, ordered segments, exact source excerpts, provenance labels, advisory misconception text, and informal checks. A route or source change yields a stale conflict; failed provider work leaves a retryable local state and never overwrites a valid Brief.

Presentation commands require expected StudySession, SessionAgenda, Agenda-item, and lesson-state versions. They can start, advance in order, revisit, answer an informal check, or complete the presentation. These commands update only the StudySession-owned lesson child and session version: they do not complete an Agenda item, advance StudyPlan progress, create Formal Evidence, resolve Mistakes, or alter Mastery. Pause/resume continues to fence the same route and refreshes the projection from durable state.

Tutor context is a deterministic bounded slice containing the current segment, at most adjacent previews, up to four source projections, and a short summary. When it is present, the older broad `currentUnit` source context is omitted. The Tutor prompt explicitly has no authority to grade, mutate learner state, or change the route. Exact quotation validation still proves existence at the claimed span, not complete semantic entailment. Phase 4B2 renders this projection in the lesson-first Study surface and keeps Tutor secondary; no browser-side Brief payload or second lesson state machine is introduced.

## 22. Lesson-first Study UX and formal handoff (Phase 4B2)

The Study view reads the existing lesson-execution projection on activation. A `preparation_needed` projection triggers one idempotent prepare command for the current session/Agenda/item version tuple; `preparing` is polled with read-only GETs, while retryable failures retain the last valid presentation and expose one learner-safe retry. Abort controllers and request epochs fence course/session switching and late responses. The UI presents objectives, why-now context, ordered sections, examples, contrasts, advisory misconceptions, compact expandable source references, informal checks labeled `credit: none`, and the summary/next connection without exposing source IDs, offsets, fingerprints, or provider internals.

Start, next, revisit, and complete controls call the existing version-fenced commands. Completion is a presentation milestone only: it never creates Formal Evidence, grades, changes Mastery, closes Mistakes, schedules reviews, advances a Plan, or completes an Agenda item. The UI offers `开始正式检验` only when the existing direct-checkpoint launch path is already available; the callback reuses the current session command, agenda launch, deterministic grading, evidence, and progression services. If no such opportunity exists, the UI states that no direct formal entry is available rather than fabricating one. Assessment/Repair redesign, later Tutor UX, FSRS, multimodal Materials, and real-Hy3 quality evaluation remain outside this phase.

This Phase 4B2 description supersedes the pre-4B2 transcript-first wording in the shell overview above; the transcript remains available, but it is no longer the primary empty Study surface.

## 23. Lesson-aware Tutor learner UX (Phase 5B)

The Study view renders the accepted Phase 5A Tutor metadata without recomputing pedagogy policy in the browser. Quick-help controls submit ordinary learner text through the existing `SubmitTutorTurnRequest`; they do not select or transmit provider move enums. The existing StudySession turn remains the audit source for move, route signal, lesson-segment index, and operation-local source refs. Streaming, stop, exact-request retry, reconciliation, request epochs, and workspace/route switching retain the existing cancellation and stale-response protections.

The lesson remains the primary Study surface and Tutor is a secondary support panel below it. Tutor identifies the current objective and segment purpose, renders prose and bullet responses for scanning, maps a small accepted-move subset to learner language, and shows accepted detour/return signals as conversational route cues. Provider enum names, source keys, database IDs, offsets, fingerprints, and policy versions are not learner-facing.

Source disclosure is deliberately narrower than accepted metadata alone. Operation-local source keys are resolved only when the turn's accepted `lessonSegmentIndex` equals the current lesson projection's segment index; matching learner-safe source projections provide material title, location, and exact excerpt in a native keyboard-accessible disclosure. A response with an empty accepted source-ref list is labeled `Hy3 补充解释`, preserving the distinction between grounded quotations and teaching synthesis. A historical or stale key that cannot be safely resolved is not displayed or rebound to another segment. Exact quotation still establishes occurrence at the claimed location, not complete semantic entailment.

`FORMAL_CHECK_READY` remains advisory metadata. The UI offers `开始正式检验` only when the latest accepted conversational Tutor turn carries that move and the existing current Agenda item is independently launchable with kind `formal_checkpoint`. The action calls the existing version-fenced `direct_checkpoint` command and formal assessment path; Tutor text, quick questions, move labels, and route cues never create Evidence, grade an answer, update Mastery, change Mistakes or Reviews, complete an Agenda item, or advance Plan progress. Phase 5B adds no migration or production dependency and does not include Assessment/Repair redesign, FSRS, multimodal Materials, or real-Hy3 evaluation.

Verification commands, test counts, migration coverage, public evidence, and reviewer mappings are maintained separately in [Verification and Reviewer Evidence](VERIFICATION.md).

## 23b. Course readiness and Formal Assessment handoff (Phase 12B7A)

Course Preparation exposes a deterministic readiness projection over the current Contract, active MaterialRevisions/SourceBlocks, accepted Curriculum, accepted StudyPlan, and current SessionAgenda. A systematic-mastery Course may enter `complete` only when every required objective has independently validated source authority whose claims are tied to the objective's current Curriculum source references, plus an accepted launchable `formal_checkpoint` item for that objective. Optional objectives may remain teaching-only; required unsupported or stale objectives remain unresolved and block readiness with `formal_assessment_readiness_unavailable`.

The readiness check is local and provider-independent. `sourceAuthority` validates exact current claims and eligibility; Curriculum or Teaching Brief prose, Tutor output, and lesson completion cannot authorize a formal premise. The bounded coordinator preserves accepted predecessors and durable intermediate work. One learner start command claims the durable preparation operation, whose server-side transition loop continues ordinary successful checkpoints; the web client observes progress and does not simulate continuation clicks. Cancellation, recoverable failure, stale authority, and learner decisions remain genuine stop points. Curriculum navigation is observation-only while preparation owns the structure stage. Home renders semantic preparation stages and keeps system-owned readiness gaps out of learner-actionable attention items.

Formal entry is a deterministic Lesson next-state: a launchable matching checkpoint is offered; otherwise the learner sees whether formal preparation is pending or the objective is currently unverifiable. Presentation completion records no Evidence, mastery, Review, or progression mutation. Formal Assessment versions still use the existing launch-time schema, provenance, attempt, grading, Evidence, and deterministic progression authorities.

## 23c. Lesson and informal Practice pedagogy closure (Phase 12B7C)

A Teaching Brief candidate must first satisfy the existing runtime schema and authority materialization, then pass independent deterministic lesson and Practice evaluators. Provider code does not own either evaluator. The lesson gate requires purposeful instructional roles, explanation with observable reasoning moves, a complete worked example, learner action, contrast or misconception handling, objective-semantic alignment, bounded redundancy, and locally computed active-time support for the Agenda duration. It deliberately does not use word count as a proxy for teaching quality. A declarative paraphrase, padded repetition, missing reasoning, or implausible duration fails closed.

Each informal Practice item binds one existing objective, one controlled construct, and an authority mode. `exact_source` items must cite only exact source blocks independently authorized for that objective; visual-derived context may be used only as `advisory_visual` and cannot authorize an expected answer. The Practice evaluator rejects source-location trivia, unsupported authority, answer leakage, non-observable constructs, invalid options, duplicate items, and retries that do not meaningfully change the elicitation. An item carries one initial prompt and at most one changed retry. Feedback and a hint are hidden until the learner commits a response.

The compositional path applies one original structured request plus one targeted repair independently to Lesson and Practice. Schema failure and semantic candidate failure are distinguished, and each returned phase is evaluated afresh before it can become an accepted predecessor or final Brief. A route, source, skeleton, or request-ownership change fences the result. Cancellation, a stale response, exhausted repair, or either independent evaluator's rejection preserves any previously valid immutable artifact. Persisted diagnostics retain only bounded categories, issue paths/codes, completion facts, and repair actions; raw provider output, summaries, prompt previews, model fingerprints, and expected answers are excluded.

Migration 36 extends the weak `lesson_execution_states` child and its append-only event trail with Practice position, attempt, learner response, feedback visibility, and completion facts. Service commands remain StudySession, Agenda, route, and row-version fenced. Practice events are permanently marked `credit: none`; the repository and service have no path from these events to Formal Evidence, grading, mastery, mistakes, Review, Agenda completion, or StudyPlan progress. The React surface consumes only the learner-safe projection and preserves abort/stale-response behavior during Course or document switches.

FakeProvider and Hy3 implement the same contract, but deterministic Fake coverage is not evidence that a real provider candidate is pedagogically acceptable. Real candidates are intentionally allowed to fail the independent gates; successful persistence, actual-browser interaction, and human review remain separate release evidence. Exact quotation validation continues to prove source occurrence, not complete semantic entailment or instructional effectiveness.

## 23d. Spine-first compositional Teaching generation (Phase 12B7C2)

The current Teaching Brief path is compositional responsibility separation, not a new product or a collection of per-slot model agents:

```text
accepted Curriculum + accepted StudyPlan + exact SessionAgenda/StudySession item
        + current execution-source manifest and bounded exact source context
        -> local Teaching Skeleton and Practice plan
        -> Lesson logical call (original + at most one targeted repair)
        -> fresh local Lesson validation and independent evaluation
        -> immutable accepted-Lesson checkpoint
        -> Practice logical call (original + at most one targeted repair)
        -> fresh local Practice validation and independent evaluation
        -> local Teaching Brief assembly
        -> non-credit StudySession interaction
```

### Accepted-route and objective authority

Preparation accepts only the exact current route. The Curriculum and StudyPlan must both be accepted and active; the StudySession and SessionAgenda must point to those versions and their current source-manifest fingerprint; their expected versions and current item IDs must match; the Agenda item must be queued/active, launchable `learning_unit_teaching` work with Lesson capability; and its linked Plan item must be the matching `teach_unit` for the same LearningUnit. Current visual-derivation identity is also fenced. Reads may inspect a paused route, but provider preparation requires the active route.

The linked accepted Plan item's ordered `objectiveIds` is the route authority. It must be nonempty, contain no duplicate, and resolve entirely inside the matched LearningUnit. The service derives stable operation-local `O*` aliases from that ordered subset—not from every LearningUnit objective—and uses the same projection for source/visual query terms, provider objective envelopes, the skeleton, Lesson metadata and segments, Practice mapping, quality evaluation, and final Brief objective metadata. Objective membership, priority, construct, and authority never come from Lesson or Practice output. When a selected objective carries a formal construct plus nonempty exact formal-evidence SourceBlock IDs, only matching offered blocks are eligible for that objective. Otherwise exact blocks already mapped to the accepted LearningUnit provide teaching authority. If neither exact path is available, accepted advisory visual material can support only `identify` or `explain`; it cannot authorize `apply`, `design`, or `evaluate`. Unknown, stale, cross-objective, or unoffered `S*`/`V*` aliases fail local validation.

### Deterministic Teaching Skeleton and duration plan

`planTeachingSkeleton` is pure: it has no provider, repository, clock, or learner-state access. From the accepted objectives, exact authority envelopes, and Agenda minutes, it creates a schema-versioned, planner-versioned, content-addressed plan containing:

- the local objective set, priorities, constructs, and allowed aliases;
- stable `L*` Lesson slots with role, purpose, construct, protected/optional status, authority mode, learner-action requirement, controlled relation kinds, and minimum/maximum activity minutes;
- stable `PR*` Practice slots with exact objective/construct ownership, capability to observe, prohibited stronger constructs, retry permission, authority envelope, and activity minutes; and
- target, acceptable, protected, Practice, synthesis, and total planned activity ranges.

Construct policy is qualitative and bounded. `identify` receives meaningful discrimination/action but not an automatic worked procedure. `explain` receives a protected semantic-relation slot plus learner cognition. `apply`, `design`, and `evaluate` require exact source authority; `apply` receives a worked-process slot and an observable decision/action, while advanced constructs are never inferred merely to enrich a Lesson. Required/high objectives receive truthful planned Practice coverage. Optional contrast or deeper explanation is added only after protected work fits.

Duration is therefore decided before prose. The planner accepts an active-time window around the Agenda target, sums fixed qualitative ranges, and rejects an unavailable authority, an over-limit slot set, protected work that cannot fit, a total plan that cannot fit, or a plan that cannot honestly support the accepted duration. Displaying a larger minute count cannot repair an unchanged activity plan, and Hy3 cannot solve a duration conflict by deleting protected learning moves. These ranges are feasibility checks rather than stopwatch predictions.

### Lesson call, evaluation, and accepted checkpoint

The Lesson provider projection contains the skeleton identity/version, objective metadata, target minutes, and approved Lesson slots, plus bounded learning and source context. The Practice plan is omitted. Provider output is content-only: each item names one existing `L*` and may supply explanation, exact refs, typed semantic relations, a structured worked process where required, bounded illustration/contrast/misconception content, and an informal check. Fields that would redefine objective refs, construct, role, duration, protection, or authority are forbidden.

Zod validation is followed by input-aware local authority validation and the Lesson pedagogy evaluator. Candidate diagnostics identify invalid `L*` slots. Hy3 may receive one targeted repair; local merge replaces only those identities and restores every valid first-pass peer, then reruns the complete validator/evaluator. No second repair is available. Practice is never called when Lesson fails.

A passing Lesson is stored in `accepted_lesson_checkpoints` before Practice begins. The checkpoint contains the full immutable skeleton, exact Lesson slot content, passing evaluation, active Session/Agenda/Plan/LearningUnit identities and versions, source/skeleton fingerprints, provider/model and prompt version, owning operation, and completed Lesson logical-call identity. Migration 37 creates the session-owned table and runtime immutability triggers; migration 38 adds nullable compatibility backfill for Lesson logical-call provenance, while every newly created checkpoint requires the exact completed Lesson call. Migration 39 keeps direct deletion forbidden while the owning route/workspace exists but allows the checkpoint to follow an authorized whole-workspace cascade. There is no separate standalone Teaching Skeleton table: a pre-acceptance skeleton is operation-local, while an accepted skeleton is durably embedded in this checkpoint and referenced by the final Brief.

### Separate Practice call, retry, and final assembly

Only after checkpoint acceptance does the Practice provider projection expose the immutable accepted Lesson and local `PR*` plan. Provider output can fill prompt/options, feedback/hint/explanation, refs, and bounded application facts; it cannot change the Lesson, objective, construct, authority, duration, retry permission, credit, or persistent learner state. The input-aware validator and separate Practice evaluator require objective/construct alignment, exact per-slot authority, observable capability, non-leaking options, non-trivia prompts, and a materially changed retry. Apply additionally needs a source-stated starting state/rule, a genuine decision, and an expected action represented by the response surface. One targeted `PR*` repair freezes both the accepted Lesson and valid Practice peers; a second failure closes that logical call.

A Practice failure does not delete or regenerate the checkpoint. Lesson execution exposes the accepted Lesson as a read-only preview with `practice_retry_available`; an explicit preparation retry proves the checkpoint still matches the exact current route, sends the same accepted Lesson bytes to a new Practice call, and makes no second Lesson call. Cost policy is enforced immediately before each phase call: checkpoint reuse skips the Lesson cost check/call, and a Practice refusal leaves the accepted Lesson intact. Final local assembly occurs only after fresh Practice acceptance. The immutable Teaching Brief records the skeleton/checkpoint identity, planner/schema/prompt versions, duration ranges, owning operation, distinct Lesson and Practice logical-call identities, provider/model, source-context and manifest fingerprints, both evaluations, and learner-visible exact provenance.

### Semantic quality, state authority, and observability

Lexical markers are not acceptance authority. `because`, `therefore`, `if`, `因为`, `因此`, or `下一步` may be diagnostic signals, but a typed Lesson relation must contain two distinct propositions/states, a controlled relation, objective relevance, and compatible source refs. Keyword-free valid relations are allowed; marker-stuffed restatements fail. A worked process must expose a starting state, source-stated rule or procedure, transitions with reasons and resulting states, a result, and why it follows. A field label or checklist is insufficient. Practice applies the same rule to claimed application capability; source-location recall remains invalid.

The checkpoint and final Brief are instructional artifacts only. Lesson presentation, informal checks, Practice attempts, feedback, hints, and retries persist with `credit: none`; no repository or service path from them creates Formal Evidence, grades, mastery changes, mistake closure, Review scheduling, Agenda completion, or StudyPlan progression. Learner commitment precedes feedback, and local execution owns attempt number, retry eligibility, selected surface, completion, and all state transitions.

Both phase calls use the canonical `prepare_teaching_brief` operation type, but retain distinct `:lesson` and `:practice` logical-call identities and phase schemas (`lesson-slot-content-proposal-v1` and `practice-content-proposal-v1`). Repositories require that operation type plus the matching schema fingerprint when accepting checkpoint or final-Brief provenance. Each logical call retains its own physical attempts, repair, provider/model/runtime generation, source fingerprint, per-phase cost-policy decision, and sanitized structured-output records. Raw prompts, full provider responses, source corpora, authorization data, credentials, and expected answers are not telemetry. FakeProvider and Hy3 implement the same composition contracts and local gates, but Fake proves only deterministic integration behavior. Real-provider calls remain explicit and independently evaluated; no automated test or `eval:fake` run may contact Hy3, and no real acceptance result is implied by this architecture description.

## 24. Normalized material extraction foundation

The supported learning-material core is pasted text, Markdown, TXT, text-layer PDF, PPTX, rich DOCX, standalone PNG/JPEG/WebP images, static HTML/Web Snapshots, and source-code files. Uploads are resolved through the parser registry using filename, optional declared MIME, and parser-level signature checks. Unknown or mismatched inputs fail closed; bounded input, OOXML archive/XML, unit, image, HTML, and chunk limits prevent a parser from becoming an unbounded resource consumer.

Adapters produce a normalized ordered document structure before chunking. Production units include headings, sections, paragraphs, lists/list items, quotes, fenced code, conservative tables, PDF page locations, PPTX slides/text boxes/speaker notes, DOCX document structure, and source-code constructs. `structure-aware-v1` attaches heading spans and paths to the content they govern, keeps normalized structural units separate for primary provenance, keeps fenced code and small tables intact, and falls back to line or hard-boundary splitting only for oversized units. It does not use generic overlap as independent evidence or merge unrelated slides merely to reach a target size.

Each accepted SourceBlock retains exact offsets into the normalized revision text, heading path, page/slide/document or line location where available, normalized-unit identity, content-origin class, and chunker version. Parser and chunker identities are persisted with the immutable MaterialRevision derivation metadata. Legacy rows remain nullable/unknown and are never relabeled retroactively. `extracted_original` is distinct from derived OCR, visual descriptions, layout labels, or summaries; derived text may aid navigation and teaching but is not automatically Course Truth. Exact quote validation proves occurrence at the recorded span, not complete semantic entailment.

PPTX and richer DOCX structure now retain supported embedded ORIGINAL assets with immutable revision provenance. Standalone-image semantic preparation and visual descriptions plus static HTML/Web Snapshot ingestion are implemented, while OCR, vector image search, browser-perfect web archiving, semantic chart/SmartArt/equation interpretation, repository ingestion, AST/call-graph analysis, and spreadsheet support are not implemented.

The parser and persistence path is identical in Fake and real-Hy3 modes and makes no provider call. `LLM_PROVIDER`, Hy3 endpoint/model/credential configuration, provider budgets, and external connectivity checks are unchanged by rich-document ingestion.

Exact focused and full verification commands are:

```bash
npm run test -w @hy3-clinic/shared -- src/domain/richDocumentSchemas.test.ts
npm run test -w @hy3-clinic/server -- src/ingestion/ooxmlPackage.test.ts src/ingestion/richDocuments.test.ts src/ingestion/pdfLayout.test.ts src/ingestion/normalized.test.ts src/ingestion/documents.test.ts src/ingestion/ingestion.test.ts src/services/materials.test.ts src/routes/materials.test.ts src/db/migrate.test.ts src/db/migrateCompat.test.ts
npm run test -w @hy3-clinic/web -- src/upload.test.ts src/views/GraphWorkspaceView.test.tsx src/App.test.tsx
npm run build
npm run lint
npm test
npm run eval:fake
npx prettier --check README.md docs/ARCHITECTURE.md
git diff --check
```

## 25. Visual source preparation and derived semantics (Phase 6B2A)

Phase 6B2A extends the normalized-material foundation with a bounded visual
path. It reuses Phase 6B1 `material_revision_assets`, `source_asset_blobs`, and
revision-local occurrences; it does not create a second Material or asset
identity model.

### Original visual authority

The accepted source is the exact original image byte sequence. Standalone
`PNG`, `JPEG`, and `WebP` uploads become Image Materials with an image-only
normalized revision and no invented authoritative text. PPTX/DOCX embedded
images remain occurrence-bound original assets; visual preparation enumerates
only retained PNG/JPEG/WebP image occurrences with known dimensions. Other
retained media remain provenance-only. Hash-addressed blobs may be deduplicated,
but occurrence IDs and parent slide/document locations are never collapsed.
The original SHA-256, media type, dimensions, and source location remain local
authority.

### Bounded image preparation

`apps/server/src/ingestion/images.ts` opens the exact `Buffer` with `sharp`
0.35.3 and validates actual format, declared media type, positive dimensions,
channels, 25-million-pixel and 16,384-pixel dimension limits, and single-frame
policy. Animation and multipage inputs fail closed. Metadata checks are
followed by a strict bounded decode with warning failure, pixel/channel limits,
EXIF auto-orientation, and a ten-second libvips timeout. Provider transport is
an immutable-source-preserving derivative capped at 2,048 pixels per dimension
and 4 MiB, with a recorded transformation and preparation/version fingerprint.
The original bytes are never replaced. sharp has no active-work AbortSignal;
request cancellation is checked around the decode and provider boundary, while
the timeout and operation fence contain in-flight work.

### Derivation contract and persistence

`packages/shared/src/domain/visual.ts` defines strict schemas for the semantic
payload, transport metadata, immutable `VisualDerivation`, preparation state,
learner-safe source projection, and bounded advisory teaching context. The
provider sees only one image-only visual unit and local limits. It cannot emit
Material IDs, revision IDs, asset IDs, hashes, authority, Evidence IDs, mastery,
or persistent state. Local code attaches those facts after schema and semantic
validation.

`visual_derivations` is migration 25. Each accepted row binds Material,
MaterialRevision, exact asset occurrence, original byte hash, generator/schema
version, provider/model/configuration identity, context mode, transport
fingerprint, bounded payload, and immutable creation time. Reprocessing creates
another versioned record when the derivation identity changes. Identical bytes
may reuse semantic content, but the new occurrence receives its own derivation
identity and provenance link.

Preparation is explicit and operation-fenced. It does not spend provider calls
on a read. A command is idempotent, duplicate in-flight work is rejected, and
an old revision/asset/hash cannot finalize onto a newer source. Failed or
cancelled preparation leaves the original asset and any prior accepted
derivation intact. FakeProvider is deterministic and offline. Its visual
fixtures exercise photo, diagram, chart, text-heavy, embedded, no-text,
uncertainty, malformed, schema-invalid, semantic-invalid, one-repair,
repair-exhausted, timeout, and cancellation paths.

### Downstream authority boundary

`apps/server/src/retrieval/lexical.ts` projects a visual derivation as a
retrieval unit with explicit `derived_visual_description` origin,
`advisory_nonblocking` authority, derivation identity, original asset
occurrence, and original byte hash. It is searchable for discovery and teaching
context but is not merged into an authoritative SourceBlock. Teaching Brief
and Tutor projections use operation-local `V*` references and retain separate
`original_visual` source facts beside `generated_visual_explanation` advisory
facts. Learner projections omit database IDs, hashes, provider payloads, and
diagnostics. Derived visual text is never admissible as Formal Evidence and
cannot grant mastery, close mistakes, complete an Agenda item, or advance a
Plan.

### Provider and OCR scope

The shared visual-provider contract and FakeProvider include one strict
`describeVisual` operation with the existing whole-response JSON boundary and
at most one bounded repair. `Hy3Provider` remains text-only and never receives
an undocumented image payload; the dedicated `TokenHubVisionProvider` is the
documented Phase 6B2C image path. Local OCR is rejected for this phase after
source-level review
of Tesseract.js, native Tesseract, PaddleOCR, Surya, and OCRmyPDF. The selected
production image dependency is sharp only; no Python runtime, native OCR
binary, model-download manager, GPU runtime, or vector database is added.

HTML/Web Snapshot, full local OCR, OCR confidence projections, vector visual
search, chart/equation entailment, and visual-grounded formal evidence remain
outside this phase.

## 26. Dedicated TokenHub visual provider (Phase 6B2C)

Hy3 remains the text-only language and pedagogy provider. Visual description has
its own startup-only configuration: `disabled`, deterministic `fake`, or the
single documented TokenHub target `hy-vision-2.0-instruct`. The TokenHub adapter
implements only `describeVisual`; it is not a Course, Curriculum, StudyPlan,
assessment, grading, mastery, or evidence provider.

The documented transport is `POST /v1/chat/completions` with one `user` message
whose content array contains one `image_url` Data URL followed by one bounded
text instruction. Local preparation restricts input to one PNG, JPEG, or WebP
image. The adapter does not use a system message, `response_format`, automatic
model routing, multiple images, video, or an OCR cascade. The response must be
one complete JSON value that passes the shared Zod payload and local semantic
validation. Only a schema or semantic failure may trigger one repair; HTTP,
network, envelope, timeout, and cancellation failures are not retried.

Migration 26 rebuilds `visual_derivations` to add immutable, non-secret
`provider_endpoint_identity` and `provider_runtime_identity` fields and permit
the controlled `tokenhub` provider value. Historical rows receive the explicit
`historical:unrecorded` sentinel rather than a fabricated target. New semantic
reuse binds provider, model, hashed normalized endpoint, adapter/transport
generation, prompt generation, generator/schema version, image-preparation
version, context mode, limits, and the prepared transport fingerprint. API keys
and Authorization headers never enter this identity.

Visual preparation derives its ownership lease from the real request envelope:
two possible physical requests plus a 30-second local finalization margin. With
the 120-second default per-request timeout, the lease is 270 seconds. Existing
cancellation, active-revision/asset/hash checks, operation fencing, immutable
accepted-history behavior, provider-attempt telemetry, and failed-generation
preservation remain authoritative.

Regardless of provider, accepted output remains
`derived_visual_description`, `authority: derived`, and
`advisory_nonblocking`. It can support lexical discovery, Teaching Briefs,
Lessons, and Tutor context, but it cannot become a SourceBlock, Formal Evidence,
grading input, mastery update, mistake closure, review decision, Agenda
completion, or Plan progression. Exact quotation validation still proves only
that quoted text occurs at a claimed source position; it does not prove full
semantic entailment.

# Learner Assessment / Repair Execution

The Study route launches accepted formal short-answer versions from the existing SessionAgenda. `AssessmentAttempt` and `GradeRecord` remain immutable/append-only; learner projections hide internal IDs and expose criterion feedback plus honest source locations. Failed or partial formal grades may create one durable `RepairEpisode` and immutable `RepairPacket`. Repair practice is recorded as non-credit events. A fresh successor AssessmentVersion with changed wording is required before supported Evidence can resolve the episode. Tutor and lesson completion cannot grant credit. The Phase 7B2 UI recovers the current attempt and agenda-scoped version after reload; progression reconciliation remains separate from Evidence persistence.

## 27. Production Review scheduler (Phase 8B)

Review scheduling is an objective-level successor domain. `ReviewTarget` identity is bound to the accepted Contract, Curriculum, LearningUnit/objective, and execution source-manifest fingerprint. `MemoryScheduleState` is a rebuildable CAS projection; immutable successor events retain exact pre/post state, policy epoch, source outcome, and ReviewExecution identity. The local adapter owns all `ts-fsrs` types and validates FSRS-6 output before persistence: binary Again/Good, no fuzz, no short-term mode, and a 365-day ceiling.

The authority chain remains Attempt -> Grade -> criterion-gated Evidence -> deterministic formal progression reconciliation -> Review activation/execution. Review cannot grant mastery or bypass Evidence. An active due execution records one Again for retrieval failure; a later supported fresh verification for that same execution records one Good. Event append and schedule-state update are atomic and row-version fenced; duplicate outcomes and launches are idempotent.

Migration 31 preserves legacy `review_items`/`review_events` as audit history and disables their grading writer. Migration 32 makes `pending_initial_review` an explicit null-memory state, adds deterministic per-target event sequence numbers, and records a durable per-Evidence backfill decision. At service startup, the idempotent backfill uses the persisted FSRS-6 policy epoch as its cutover and considers only pre-cutover supported Formal Evidence with an applied Evidence reconciliation, applied formal-progression reconciliation, and an exact locally revalidated Contract/Curriculum/LearningUnit/objective/source binding. Eligible rows become due pending targets without a synthetic event, rating, stability, difficulty, repetitions, or lapses; ambiguous or invalid bindings are audited and skipped.

Current queue, assessment, Tutor, and review API projections resolve successor targets through their exact versioned Curriculum binding and never fall back to legacy scheduling rows. Legacy rows and score buckets are not inputs to successor state. Successor events remain immutable under direct operations while legitimate parent-scope deletion cascades are allowed. FSRS-7, optimization, Hard/Easy automation, broad Review UX, and real-provider scheduling calls remain deferred.

## 28. Due Review execution and learner workflow (Phase 8C)

Due work is composed into the existing accepted Course route as a `due_review` SessionAgenda item. `reviewSuccessor.reconcileDueAgenda()` is deterministic and idempotent: it checks the current accepted Contract, Curriculum, StudyPlan, exact objective binding, source-manifest fingerprint, and agenda version. An active or paused StudySession is never displaced; a queued due item becomes the next meaningful Course action only when the existing continuation rules allow it. The Course overview performs the same reconciliation before projecting Agenda state, so navigation cannot expose a stale due queue.

`courseActionLaunch` is the only learner launch boundary. It rechecks workspace, route, agenda, plan, source-manifest, LearningUnit, objective, and current successor binding fences. A due launch creates or resumes one `ReviewExecution` before any provider request. The execution records the consumed binding and state row version; the accepted Formal AssessmentVersion and Attempt are then bound to that execution. A stale binding, stale agenda, mismatched source, unknown objective, or unlaunched due Evidence fails closed. Replayed launch commands return their durable result and never create another execution.

The formal loop remains the Phase 7 authority chain:

```text
current-source AssessmentVersion
 -> submitted Attempt
 -> semantic Grade
 -> criterion-gated Evidence
 -> deterministic progression reconciliation
 -> locally derived Review event and next schedule
```

For direct supported retrieval, the successor records one `Good`. For a failed retrieval, the successor records one `Again` only after the current Grade/Attempt/Version prove the active due execution failed; the existing targeted Repair service then owns its OPEN/ACTIVE/DEFERRED/AWAITING_VERIFICATION lifecycle. Repair practice is non-credit and cannot create a Review event. A fresh verification must use a changed-context accepted AssessmentVersion and linked Repair episode. Supported fresh Evidence records the one later `Good`; failed verification does not add another `Again` and cannot open nested Repair. Event/state/execution writes are atomic and idempotent, and a scheduler persistence failure is stored on the active execution for retry without deleting valid Formal state or regrading.

The learner projection is intentionally smaller than the audit projection. Progress and Study name the objective, due reason, current phase, formal result, Repair requirement, resolution, and next due time. They do not expose FSRS stability, difficulty, retrievability, policy hashes, private provider output, or internal identifiers. Historical Evidence and Review events remain append-only and visible in audit/history surfaces after current forgetting. Exact quotation validation still establishes source occurrence, not complete semantic entailment.

Hy3 remains responsible for semantic grading, misconception hypotheses, and bounded Repair proposals. Local TypeScript/Fastify/Zod/SQLite code validates structured output, source IDs and quotes, route versions, objective identity, Evidence eligibility, score/state transitions, scheduler outcomes, persistence, budgets, permissions, cancellation, and stale-response fences. FakeProvider supplies deterministic offline fixtures; no new production dependency or competing scheduler was introduced.

## 29. Mastery Red Team shadow architecture (Phase 09A)

Mastery Red Team searches for a locally defensible counterexample to apparent mastery without becoming a second authority. Its entry point is an active objective-level successor `ReviewTarget`, not a legacy mastery score. Eligibility requires an active valid Course route, completed LearningUnit, current supported Formal Evidence with applied reconciliation, a supported latest target attempt, a future non-initial Review state, current original source bindings, and no open mistake, confirmed misconception, active Repair, due Review, or active ReviewExecution already owning the objective gap.

`MasterySnapshot` is an immutable audit fact. It freezes the Course execution version; accepted Contract, Curriculum, StudyPlan, Agenda, and source-manifest identities; Review target/binding/state; LearningUnit/objective/prerequisite/synthesis context; supported Evidence/Grade/Attempt/criterion/reconciliation records; bounded learner-state observations; prior Formal and shadow prompts; active source revision fingerprints and exact excerpts; policy versions; and a content hash. It is never refreshed in place. The service rechecks route version, Review row version/due time, target binding, active material revision, SourceBlock fingerprint, and exact quotation after generation and after grading. A stale operation cannot finalize.

Local policy owns hypothesis and family selection. Observable records yield named hypotheses for transfer, boundary conditions, near-neighbor confusion, hidden-premise changes, counterexamples, error diagnosis, plausible-alternative refutation, cross-LearningUnit synthesis, historical misconceptions, adversarial distractors, representation shift, or one explicit discriminative follow-up. The least-used supported family wins; a stable priority breaks ties. No theta, item-information, posterior-mastery, BKT, or learned selection score exists.

The provider contract exposes only objective/source aliases, the chosen family and basis codes, up to eight exact excerpts, up to eight prior prompts, up to four historical summaries, and fixed length/count limits. Hy3 proposes exactly three structured candidates. Zod validates structure; local semantic policy validates controlled enums, primary-objective scope, source ownership, answer/rubric/premise binding, learner-visible premises, no external knowledge, ambiguity and term declarations, triviality, answer leakage, duplicate candidate keys/text, and normalized word-trigram/character-four-gram overlap. One schema or semantic repair is permitted. Local selection ranks only admissible candidates by bounded coverage, lower prior overlap, and stable candidate key. Lexical novelty is not semantic-equivalence proof, and exact quote validation is not complete semantic entailment.

The selected challenge creates an accepted `AssessmentVersion` with `authorityMode = mastery_red_team_shadow` and no progression context. Internal shadow-only methods may create one Attempt and one GradeRecord by reusing the existing short-answer grader. Ordinary Formal start/grade and learner assessment projection reject shadow versions. `deriveEvidence()` returns no Evidence for the shadow mode, and shadow grading never invokes Formal finalization, progression, Repair, or Review scheduling.

Migration 33 adds the authority mode plus immutable snapshot/candidate and append-only evaluation ledgers. Runs may transition through generating, selected, evaluating, evaluated, or explicit failure states. Start and submission keys provide deterministic replay; a failed provider grade may resume the already submitted Attempt under the same key without duplicate grading. Each evaluation explicitly records `evidenceCreated`, `masteryMutated`, `progressionMutated`, `reviewMutated`, and `repairMutated` as false, plus `robust_signal`, `possible_gap`, or `inconclusive`, bounded advisory confidence/risk, validation limits, and a proposed inspection action.

Only developer/audit routes expose this phase. A `possible_gap` cannot erase lower-level Evidence or open Repair. It may recommend that a later, separately authorized workflow create a fresh current-source ordinary Formal Assessment; only that ordinary Attempt -> Grade -> criterion-gated Evidence -> deterministic reconciliation path may affect authoritative learning state. Human dogfood, live-Hy3 quality claims, calibrated fairness, mastery influence, automatic follow-up, and learner-facing Red Team UI remain outside Phase 09A. No production dependency was added.

## Knowledge Map learner-state projection (Phase 10A)

`apps/server/src/services/knowledgeMap.ts` builds the read-only
`knowledge-map-projection-v1` contract consumed by
`GET /api/workspaces/:workspaceId/knowledge-map`. The contract is a projection
and navigation substrate, not a second mastery/progress authority or a model
truth store. It supplies four modes over one graph: structural knowledge,
learner progress, the accepted route, and defensible weakness signals.

Nodes are heterogeneous: active source concepts retain their canonical/source
metadata, accepted Curriculum LearningUnits carry objective and route context,
and accepted synthesis groups carry only legitimate membership. Structural edges
come from the locally validated concept graph or accepted Curriculum
prerequisite/association/synthesis records. Layout never creates a relation.
Every accepted edge has exact source-block provenance; the projection records
that exact quotation validation does not prove complete semantic entailment.

Learner state is resolved by the fixed precedence policy
`knowledge-map-precedence-v1`: active Repair overrides the primary display
state; current formal failure and progression repair precede supported evidence;
progression completion and supported Formal Evidence yield `evidence_backed`;
lesson presentation yields `taught` or `awaiting_formal_validation`; accepted
Plan membership and active lesson execution yield `planned` and
`currently_learning`; legacy mastery alone may yield `mastered`, `developing`,
or concept `weak`. Review due and retrievability concern are separate signals,
not mastery failure. Mastery Red Team `possible_gap` is advisory only. History
is retained in bounded references and is excluded from current state.

Route projection checks the active Contract, accepted Curriculum and StudyPlan,
Agenda identity, route validation, source-manifest fingerprints, active
MaterialRevision/SourceBlock membership, and current formal bindings. It does
not call `reconcileDueAgenda()` or any provider and performs no writes. A stale
or incomplete route/source binding fails closed with explicit unknown reasons.
The projection is bounded at 2,000 nodes and 4,000 edges and uses fixed-query
repository reads rather than a graph database or whole-corpus provider prompt.

## Learner-facing Knowledge Map and navigation (Phase 10B)

`KnowledgeMapView` is a read-only Course surface over the frozen
`knowledge-map-projection-v1` and `knowledge-map-precedence-v1` contracts. React
maps projection enums to learner wording, icons/badges, shape, border, opacity,
and emphasis; it does not inspect Evidence, Repair, Review, mastery, mistakes,
or Red Team records to reach a new state conclusion. Repair remains the primary
display override, formal failure remains authoritative weakness, Review due is
scheduling, and `possible_gap` remains an advisory that cannot trigger an
action or mutate formal state.

The server owns executable navigation. A LearningUnit receives `study` only
when it is the current Agenda item, its route is current, prerequisites are
unlocked, and its launch status is `launchable`. Current formal records, active
Repair episodes, and current due/concern Review targets project focused
`progress` actions. The client dispatches those validated targets to existing
Study, Progress, Curriculum, and Material surfaces; arbitrary visible nodes do
not receive synthetic actions. The GET path remains provider-free and
mutation-free.

The canvas uses the existing React Flow and d3-force stack. One deterministic
topology layout is independent of learner mode and state, so mode switches keep
selection, node positions, and camera context. Dragged positions and viewport
are optional local presentation preferences keyed by workspace and accepted
Curriculum identity. Small maps retain the existing obstacle-aware edge router;
above 48 edges the view uses straight, low-emphasis edges and visible-element
culling. Search, fit, reset, zoom, and selected one-hop focus provide bounded
navigation without introducing a graph-query language. React Flow selection,
drag, and pan ownership prevents node dragging from becoming canvas panning.

Course-level request ownership uses an AbortController plus a monotonically
increasing request sequence. The projection is cleared on Course identity
change; a late response from a previous Course cannot render into the new one,
and a failed refresh can retain only a valid projection already owned by the
same Course. Unconfigured, partial/unknown, loading, and failed/retry states are
learner-visible. On narrow screens the inspector is a modal bottom sheet with
focus containment, Escape/backdrop close, and focus restoration; desktop uses
an adjacent inspector and medium widths use an overlay drawer.

The legacy `GraphWorkspaceView` is not retired in this phase. It remains behind
the Course preparation bridge for concept extraction, grounding, graph
generation, alignment, and other existing advanced workflows. Phase 10C must
decide those capability destinations and history requirements before removing
any route. The existing concept mastery repository is historical in naming but
still the current authority for concept `mastered`, `developing`, and `weak`;
Phase 10B neither replaces nor reinterprets it.

## Legacy surface retirement and capability consolidation (Phase 10C)

`appRoutes.ts` defines the canonical Course route model. Course paths cover
Home, Study, Curriculum, Knowledge Map, Progress and its Evidence/Repair/
mastery/history subsections, Materials, Settings, advanced grounding, and
advanced manual assessment. `#/courses` is the no-Course state and `#/settings`
keeps Settings available without inventing Course context. Meaningful legacy
hashes and `view`/`tab`/`module` query values normalize with `replaceState`:
Graph/Explore -> Knowledge Map; Quiz/Assessment -> manual assessment;
Results/History -> Progress history; Mistakes/Repair/Remediation -> Progress
Repair; Mastery/Review -> Progress mastery; Import/Materials -> Materials;
Hy3/provider -> Settings; compatibility/advanced -> grounding. Unknown Course
paths fail to its Home. Canonical learner navigation uses `pushState` and never
creates a compatibility-shell history entry or redirect loop.

Retirement is a frontend information-architecture change, not a persistence or
authority migration. No server route, service, repository, database table, or
migration was removed. Formal Assessment still uses immutable versions,
attempts, append-only grades, criterion-gated Evidence, and explicit
progression reconciliation. Durable legacy mistakes and newer Repair episodes
remain inspectable and actionable in Progress. Successor Review targets,
executions, append-only events, and FSRS state remain separate from mastery and
appear through Home, Study, and Progress without default scheduler internals.
Provider configuration and deliberate connectivity diagnostics remain in
Settings; server telemetry and developer/audit APIs remain retained without
becoming ordinary learner navigation.

Concept mastery authority is unchanged. Migration 1's `mastery_states` table
and the existing mistakes/mastery repository remain the store. The deterministic
legacy grading service computes a concept question average and calls the shared
`updateMastery` rule before the repository upsert. `GET /api/materials/:id/mastery`
feeds Progress; the Knowledge Map service reads the same workspace states and is
the only projection source for concept `mastered`, `developing`, or `weak`.
Formal Evidence/progression, Repair, successor Review/FSRS, Tutor, and Mastery
Red Team paths do not write `mastery_states`. Surface consolidation therefore
does not reinterpret objective Evidence or scheduling as concept mastery.
