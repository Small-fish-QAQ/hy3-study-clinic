# Hy3 Study Clinic — Learning Execution Agent Product Design

Status:
AUTHORITATIVE PRODUCT DESIGN FOR NEXT IMPLEMENTATION

Authority order:

1. repository-local AGENTS.md / CLAUDE.md
2. STUDY_CLINIC_AGENT_PRODUCT_DESIGN.md
3. current implemented code/tests for current-state facts

Superseded historical product-design documents are context only and MUST NOT override this design.

Research and repository snapshot: 2026-08-10. This is a product and architecture design, not an implementation claim. No Agent capability described as “target” exists merely because it appears here. Current behavior remains documented in [ARCHITECTURE.md](ARCHITECTURE.md), current verification in [VERIFICATION.md](VERIFICATION.md), and the project chronology in [PROJECT_EVOLUTION.md](PROJECT_EVOLUTION.md).

## 1. Executive verdict

Hy3 Study Clinic should become a mixed-initiative, user-governed, auditable Course-Execution / Goal-to-Mastery Learning Agent.

The product should preserve the freedom and teaching quality of a strong conversational model while moving recurring learning-management work into deterministic software. It should remember the learner-confirmed goal, maintain an accepted route, decide and explain the default next action, preserve formal evidence, surface coverage risk, recover after detours, and propose—but never silently impose—meaningful replans.

The target loop is:

~~~text
Course
→ Learning Contract
→ Curriculum
→ accepted versioned StudyPlan
→ dynamic SessionAgenda
→ StudySession
→ Tutor dialogue and learner-directed detours
→ informal checks
→ formal evidence
→ completion decision
→ next action, targeted repair, or proposed replan
→ synthesis and adversarial readiness
→ Goal outcome
~~~

The architecture is an additive evolution of the current product. Existing Workspace, Material, SourceBlock, Concept, Graph, assessment, grading, mistake, mastery, misconception, review, grounding, and history systems remain the substrate. Workspace becomes the course-level aggregate in learner-facing language; the implementation must not create a duplicate Course or concept universe.

The product thesis survives prior-art review only as a systems-integration hypothesis:

> Hy3 Study Clinic is a user-governed, evidence-gated, auditable course-execution agent that preserves a versioned Learning Contract and accepted executable route, lets learners detour without losing that route, separates conversation from formal evidence, exposes course/exam/semantic coverage risks, and actively challenges apparent mastery before declaring readiness.

No individual element is novel. The potentially distinctive value is the way these elements constrain one another and remove multi-session orchestration from the learner. That distinction must be validated in same-model user studies; architecture alone does not prove it.

The operating philosophy is:

> EXECUTE. VERIFY. CHALLENGE.

Execution remains learner-governed, never paternalistic.

## 2. What makes this an Agent rather than an LLM wrapper

An LLM wrapper sends context, receives text, and displays it. The proposed Agent owns durable execution state and performs bounded, verifiable actions through local services.

For every major capability, the Agent test is:

| Capability | Persistent state read/written | Trigger and executed action | Local verification | Manual orchestration removed |
| --- | --- | --- | --- | --- |
| Contract formation | Stable subject scope, logical Material identities/roles, and draft/accepted Contract versions | Course setup or learner-level goal/scope change; calculate feasibility and propose a typed Contract | Schema, deadline/time arithmetic, stable material scope, learner confirmation | Re-explaining the goal, deadline, depth, and constraints every session |
| Curriculum | Active material revisions, SourceBlocks, Concepts, Graph, exam observations; immutable Curriculum candidate/active pointer | Material intake or deliberate refresh; propose hierarchy and bind existing IDs | Known IDs, hierarchy, evidence, bounds, dedupe, cycle and scope checks | Manually reconstructing the whole course structure |
| StudyPlan | Accepted Contract and Curriculum, learner state, risk ledger; immutable plan versions and separate progress | Contract acceptance or meaningful replan trigger; propose an executable route and time budget | Feasibility, prerequisites, launchability, completion rules, version/diff, learner acceptance | Maintaining the original route and deciding the long-term order |
| Pace/risk | PaceBaseline, planned/actual activity time, remaining effort; pace status/events | Session completion, milestone, or budget change; recompute deterministic schedule risk | Reliable-time sufficiency, policy/version, threshold and reason code | Detecting deadline drift and recalculating feasibility |
| SessionAgenda | Accepted plan, due reviews, open mistakes, risks, availability; agenda and item events | Session start or explicit insert; compose and reorder today’s launchable work | Time bound, capability check, accepted-version fingerprint, visible rationale | Deciding what to do now and reconciling reviews with planned work |
| Detour and return | Agenda, route stack, transcript, origin/resume item | Learner asks to explore; push detour, execute bounded teaching, then restore route | Origin exists, detour is scoped, no plan mutation, stale-route revalidation | Remembering where the planned journey was interrupted |
| Formal checkpoint | Unit objectives, assessment policy, attempt history; existing quiz/result plus progression decision | Plan milestone, direct learner request, or repair completion | Existing assessment/grading/transactional safety and formal-evidence rules | Deciding when confidence should be tested rather than discussed |
| Completion/progression | Contract-specific criteria, formal evidence, mistakes, reviews, synthesis; append-only decision | New valid formal evidence or explicit defer; reconcile unit state and next action | Rule version, evidence IDs, no duplicate application, transaction, audit event | Remembering what was actually verified and whether to continue |
| Coverage/Risk Ledger | Sources, mappings, Curriculum, exams, formal evidence, AI candidates; typed risk entries and resolutions | Intake, mapping, exam analysis, evidence, scan, source revision | Provenance, separate scope/truth authority, known IDs, dedupe, status transitions; no completeness claim | Tracking omissions, exam risks, and unverified supplements across sessions |
| Meaningful replan | Contract, accepted plan, progress, time, risks; successor proposal and diff | Deadline/goal/scope change or strong repeated evidence/risk signal | Trigger threshold, bounded changes, old plan preserved, explicit acceptance | Detecting drift and rebuilding a route without losing history |
| Adversarial readiness | Scope, objectives, Blueprint, risk candidates, existing evidence; scan/check records and formal results | Readiness gate or learner challenge request | Separate scope/truth authority, evidence, question validation, grading isolation | Inventing fair ways to test representation and transfer gaps |
| Goal outcome | Accepted Contract/Plan, completion/readiness evidence, deferred/blocked risks; immutable outcome | Criteria satisfied, learner finishes with gaps/abandons, deadline closure, or successor activation | Outcome policy, evidence/gap snapshot, learner authority where required | Deciding whether the goal actually ended and remembering unresolved gaps |
| Source revision | Material/revision bytes, parser results, lineage, historical evidence; candidate/active revision pointers | Add, reprocess, remove/retire, or improve extraction | Parser/schema/grounding checks, lineage uncertainty, no automatic completion transfer | Rebuilding materials without losing the longitudinal record |
| Cost control | Cache, operation ledger, course/session IDs, and optional learner/operator spending policy; logical calls and physical attempts | Every semantic operation | Usage parsing, attempt accounting, configured-cap enforcement, cache fingerprint | Guessing whether a study session is affordable or wasteful |

If a proposed feature cannot name its state, trigger, action, verifier, and removed orchestration burden, it is either ordinary Tutor conversation or should be cut.

## 3. User/job boundary

The learner owns:

- the intention and accepted Learning Contract;
- the decision to accept or reject a StudyPlan or meaningful successor;
- permission for consequential scope changes;
- free conversational questions, detours, deep dives, and direct checkpoints;
- explicit defer/skip decisions;
- corrections to self-report, schedule, source scope, and exam context;
- the choice to stop, pause, resume, or leave.

Deterministic software owns:

- accepted-version pointers and immutable history;
- deadline and time-budget calculations;
- plan and agenda state transitions;
- launchability and permissions;
- ID, evidence, schema, grounding, and scope validation;
- objective score arithmetic;
- formal state mutation, transactions, idempotency, and stale checks;
- risk aggregation and status reconciliation;
- route restoration after a detour;
- runtime/operation safety bounds, telemetry, cache validity, and any explicitly configured spending policy.

Hy3 owns semantic work:

- Curriculum, StudyPlan, replan, and risk proposals;
- grounded course-relationship proposals;
- conversational teaching and alternate explanations;
- informal checks;
- grounded assessment content and semantic rubric judgments;
- synthesis and adversarial candidate/check proposals;
- concise rationales for recommendations.

Hy3 does not accept its own proposals, mutate the learner’s persistent state directly, treat conversation as mastery, or turn a risk candidate into course truth.

## 4. Current vs target loop

### Implemented current product

The code currently implements:

~~~text
Workspace
→ Materials
→ SourceBlocks
→ section-aware additive Concepts
→ optional canonical alignment
→ versioned grounded Graph
→ lesson / assessment / remediation
→ formal Quiz grading
→ Mistakes / Mastery / Misconceptions / Review
→ derived DailyQueue
→ bounded single-concept Tutor planning run
~~~

The current Tutor is a bounded read-only planner with a safe event timeline and one launchable recommended activity. It is not a conversational StudySession. The current RemediationPlan is not a course StudyPlan. The current QuestionBlueprint is not an Exam/Question Blueprint. The current DailyQueue is not a persisted SessionAgenda. Current graph overlay status is not LearningUnit completion.

Current strengths to preserve are exact-quote grounding, explicit provenance, schema validation, additive concept IDs, graph candidate activation, launchability validation, atomic once-only grading, immutable attempt snapshots, deterministic mastery/mistake/misconception/review transitions, Fake/Hy3 parity, bounded operations, cancellation, and stale-response protection.

### Target correction

The target adds course execution state above the reliable substrate:

~~~text
existing course truth and learner state
                 ↓
Contract → Curriculum → accepted Plan
                 ↓
           dynamic Agenda
                 ↓
 conversational Session ↔ controlled detours
                 ↓
     existing formal evidence machinery
                 ↓
 completion / repair / synthesis / risk / replan
~~~

Graph becomes supporting Explore infrastructure. Course Home and Study Session become the primary learner journey.

## 5. Competitive and prior-art analysis

### Research method and inspected revisions

The review used current public repository source trees, root documentation, release notes, architecture/status documents, and license files as of 2026-08-10. Marketing claims were not treated as proof. The inspected HEAD revisions were:

| Project | Inspected HEAD | Current license | What the source/release record establishes |
| --- | --- | --- | --- |
| [OpenTutor](https://github.com/zijinz456/OpenTutor) | 5f1aefdf9a93cdb65645f3e474b2c90cc568971e | MIT | Local single-user public beta with a block workspace, grounded Tutor chat, PDF/DOCX/PPTX intake, quizzes, flashcards, plan/calendar, FSRS, multiple providers, and explicit experimental flags for advanced graph/semantic-review flows |
| [DeepTutor](https://github.com/HKUDS/DeepTutor) | 456f9c24226e008f1ff07a7e3455d7b4d39f6221 | Apache-2.0 | A broad agent-native tutoring platform with a shared agent loop, persistent conversations, restart-safe turn handling, HTTP/SSE, three-layer inspectable memory, mastery paths, typed learning books, versioned knowledge indexes, and selectable document parsers |
| [Engram](https://github.com/nagisanzenin/engram) | d0a61cd671301ce7fe05d46616d1fbc7e2af6382 | MIT | A shipped file-backed learning engine for Claude Code with first-principles curricula, Tutor/assessor separation, blind free-recall grading, evidence receipts, deterministic FSRS scheduling, adversarial grader audits, and explicit source artifacts |
| [Studyield](https://github.com/studyield/studyield) | 32d2bf35739ecea599160046e899d5b117635777 | AGPL-3.0 | Source modules and UI surfaces for exam cloning, chat, problem solving, knowledge bases, learning paths, quizzes, research, teach-back, streaming, and analytics on a large NestJS/React/Postgres/Redis/Qdrant/ClickHouse stack; its own project brief also records incomplete integration and deployment work |

Studyield has contradictory stale licensing statements: its root license and current README footer identify AGPL-3.0, while its NOTICE, an older project brief, and a README comparison row still say Apache-2.0. The conservative reuse decision is therefore AGPL-3.0 and no source reuse.

No source is proposed for reuse from any of the four. If that decision changes, OpenTutor/Engram MIT source requires preservation of copyright and license notices; DeepTutor Apache-2.0 source requires the license, modification notices, applicable NOTICE content, and patent-term review; Studyield source must be avoided unless its controlling license is clarified and the AGPL obligations are deliberately accepted. High-level ideas and independently implemented patterns do not import code lineage, but research links remain recorded here.

### OpenTutor

Actual overlap:

- course/material intake, grounded chat, generated notes/questions, error tracking;
- a learner-visible study plan and calendar;
- FSRS review and adaptive practice;
- knowledge graph and learner-adaptation ideas;
- multiple provider routing and circuit-breaker-style operational concerns;
- a block-based workspace that treats study artifacts as composable.

Source-level implementation details strengthen the overlap:

- durable agent tasks persist status, bounded attempts, risk/approval fields, checkpoints, step results, provenance, cancellation, retry, and status history;
- an agenda engine ranks/deduplicates signals and queues/resumes tasks;
- incremental summaries, memory flushing, emergency trimming, token estimates, and tool-schema pruning bound context;
- model-call usage records attribute provider/model, input/output tokens, estimated cost, cache/agent/course, and operational metadata;
- extractors cover PDF, DOCX, PPTX, XLSX, CSV, and text, with important fidelity differences by adapter.

Useful patterns:

- Course Home should combine current work, plan, review, and artifacts without forcing graph navigation.
- Format ingestion and provider routing are commodity concerns.
- Advanced research-derived adaptations should be explicitly feature-gated and labeled experimental.

Tradeoffs to avoid:

- copying its Python/Next architecture, hybrid vector retrieval, or broad multi-provider surface;
- treating behavioral signals such as message brevity as authoritative cognitive state;
- conflating an adaptive layout, a plan, and evidence-gated course execution.

Its study-plan JSON is not established as a learner-accepted immutable version with a machine diff, and its agenda primarily coordinates agent tasks rather than the learner-visible today/now route defined here. Study Clinic difference: accepted versioned execution state, formal evidence isolation, route-preserving detours, explicit risk accounting, and learner-confirmed consequential changes are not established as OpenTutor’s organizing contract.

### DeepTutor

Actual overlap:

- natural multi-turn tutoring, question generation, quizzes, mastery paths, and persistent learning artifacts;
- resumable conversations and a restart-safe turn runtime;
- bounded tool/capability surfaces, SSE, event correlation, and memory consolidation;
- typed course/book structures with learner review of an outline;
- versioned knowledge indexes that preserve the working version during rebuild;
- parser adapters including Docling, MinerU, markitdown, and PyMuPDF4LLM.

The shipped runtime persists sessions, messages, turns, and ordered turn events; supports request snapshots, event replay/live catch-up, cancellation with partial-output preservation, and orphan recovery. Its parser protocol produces a canonical parsed-document shape with blocks/assets, stable parser signatures, content-addressed caches, manifest-last writes, and failed-cache cleanup. Lightweight Office adapters retain page/slide/sheet identity. Per-turn token and cost estimates exist, though the reviewed design is less clearly centralized around Course/Session/operation attribution than OpenTutor’s call ledger.

Useful patterns:

- persist a turn before execution, detect orphaned work after restart, and terminate streams honestly;
- keep raw events beneath curated summaries and make summary lineage inspectable;
- stage a replacement artifact and activate it only after validation;
- separate parser adapters from a normalized document representation.

Tradeoffs to avoid:

- adopting a full agent framework, vector/RAG platform, multi-user/auth surface, or Python service;
- importing its much broader tools, partner agents, MCP, research, media, and provider ecosystems;
- treating generic memory consolidation as formal learning evidence.

Its mastery-path implementation also demonstrates a boundary to avoid: some qualitative concept/design assessment can accept a Tutor-provided passed value and record mastery. Study Clinic requires independent formal evidence and local reconciliation. Model-authored mastery-map replacement also needs stronger revision lineage than the reviewed source exposes.

Study Clinic difference: DeepTutor demonstrates that persistence, agent loops, learning paths, and conversational breadth are not novel. Study Clinic’s narrower claim is deterministic course execution governed by accepted route versions and formal progression evidence.

### Engram

Actual overlap:

- curriculum construction and prerequisite ordering;
- ordinary Tutor dialogue separated from a blind assessor;
- “no receipt, no mastery claim” evidence discipline;
- deterministic scheduling, free recall, transfer/procedure probes, and adversarial grader evaluation;
- append-only file artifacts, inspectable audits, and learner-controlled adaptations.

The concrete safety patterns are strong: learner productions are stashed before grading; fresh-context assessment sees rubric/probe/production but not Tutor dialogue; stable settlement IDs make stash→assessment→receipt application idempotent; append-only receipts gate progression; and harder transfer failure does not erase valid memory evidence. Its public adversarial gold set measures leniency, agreement, test-retest behavior, and external adjudication.

Useful patterns:

- strict separation of the party that teaches from the authority that advances state;
- conservative grading and explicit receipts;
- adversarial gold sets, independent adjudication, and evaluation of the evaluator;
- a short daily review habit driven by durable evidence rather than Tutor enthusiasm.

Tradeoffs to avoid:

- copying its Claude Code/plugin workflow or file schema into the SQLite web application;
- assuming first-principles dependency order should always override a supplied course’s learner-visible organization;
- treating one blind assessor or one model family as ground truth.

Engram has no general document/SourceBlock intake, durable web StudySession turn runtime, provider abstraction, or API-cost ledger. It directly invalidates any claim that “blind examiner,” evidence receipts, deterministic scheduling, Tutor/examiner separation, route parking, or adversarial grading are novel. Study Clinic’s proposed contribution is their integration with source-grounded multi-document course scope, an accepted route, mixed-initiative detours, a Coverage/Risk Ledger, and local transactional learner state.

### Studyield

Actual overlap:

- exam-clone, teach-back, learning-path, quiz, knowledge-base, chat, research, and problem-solver modules;
- streaming multi-agent problem solving;
- exam-oriented practice and progress analytics;
- broad study-tool information architecture.

The source persists chat/citations, sequential analysis→solver→verifier stage outputs, generated learning-path JSON, exam analysis/generation/attempts/reviews, teach-back scores/misconceptions, and PDF/text/DOCX knowledge-base intake. This is real feature code, not only screenshots. Its own project brief nevertheless records missing endpoints, duplicate migration numbers, incomplete Docker files, and unfinished polish.

Useful patterns:

- past-exam artifacts deserve their own intake and analysis path;
- question format, representation, and combinations are useful observed evidence;
- rich assessment and teach-back surfaces can coexist with conversational learning.

Tradeoffs to avoid:

- its large operational footprint and dependencies explicitly disallowed here;
- source reuse under the current AGPL license;
- language such as “perfectly matched” future exams or implied prediction from a small historical sample;
- equating module presence or generated output with verified progression.

Specific evidence boundaries are weaker than required here: learning-path progress is a manual completed flag; important generated JSON is often parsed/cast without an equivalent runtime contract; exam analysis converts a small observed sample into model-authored percentages; a teach-back challenge can be generated and accepted by the same model; OCR confidence can be synthetic rather than measured; and the reviewed streaming path has no comparable durable event/idempotency/restart ledger. Provider usage is returned in places, but no persistent Course/Session token-cost ledger was found.

Study Clinic difference: Exam/Question Blueprint observations are evidence for priority and risk, never an oracle. State-changing assessment remains isolated and deterministic.

### Prior-art verdict

The search substantially narrows the thesis. AI tutors, study plans, curricula, persistent sessions, knowledge graphs, exam cloning, quizzes, mastery paths, FSRS, blind assessors, evidence receipts, source citations, multiple agents, and durable runtime patterns all have relevant prior art.

No inspected project clearly establishes the exact combined contract of:

1. a learner-confirmed, versioned Learning Contract;
2. an accepted executable StudyPlan distinct from a flexible SessionAgenda;
3. free detours with a persisted return path;
4. conversation that cannot silently become formal evidence;
5. a provenance-bearing Coverage/Risk Ledger that admits semantic unknowns;
6. adversarial readiness integrated with progression and user-confirmed replanning.

That is evidence of a meaningful product positioning, not a novelty or exclusivity proof. A broader market search could still find the same combination.

## 6. What is explicitly NOT novel

Study Clinic must not present any of the following as a differentiator by itself:

- AI Tutor or natural-language chat;
- course outline or Curriculum;
- study plan, learning path, calendar, or next-action recommendation;
- graph, concept map, or prerequisite ordering;
- grounded RAG, citations, document chat, or source evidence;
- PDF, DOCX, PPTX, image, or OCR intake;
- quizzes, teach-back, mastery, mistakes, or progress tracking;
- spaced repetition or FSRS;
- persistent transcripts, memory, resume, streaming, or cancellation;
- multi-agent systems, tools, MCP, or provider abstraction;
- blind examiner, separate assessor, adversarial question, or evidence receipt;
- exam cloning or question-format analysis;
- cost/token telemetry, caching, or audit logs.

These are established capabilities or commodity infrastructure. Study Clinic should reuse libraries or adapt proven patterns where possible and invest product reasoning in execution semantics.

## 7. Proposed product differentiation

The serious-learner value is not “a smarter answer.” It is a trustworthy execution scaffold around the same strong model:

- the accepted goal and route survive across sessions;
- the software explains why the next action is next;
- a spontaneous question does not destroy the route;
- only valid formal evidence advances progression;
- easier evidence remains valid when a stretch challenge fails;
- unresolved, deferred, and semantically uncertain areas stay visible;
- past-exam evidence informs priorities without pretending to predict the future;
- apparently strong mastery is challenged across representation and transfer;
- consequential changes arrive as a proposal with trigger, version, and diff;
- the complete state and cost history is inspectable.

### Falsification conditions

The thesis should be rejected or narrowed if same-model studies show that:

- learners do not return more reliably across sessions;
- manual “what next?” and plan-repair interventions do not decrease;
- accepted routes create more friction than clarity;
- risk ledgers produce noise without finding meaningful gaps;
- adversarial checks mainly generate unfair or out-of-scope questions;
- formal evidence gates make learning feel bureaucratic without reducing false completion;
- a plain conversational Tutor achieves equal drift, completion, retention, and cost outcomes;
- users routinely abandon Study Clinic for general chat.

The product must earn its scaffold.

## 8. Learning Contract

The Learning Contract is the smallest persisted, learner-confirmed representation of intention and constraints. It replaces prompt-only intent and the historical design’s looser LearningGoal concept.

### Contract fields

Prefer orthogonal fields over one overloaded mode enum:

| Field | Required? | Meaning |
| --- | --- | --- |
| intent | yes | Short learner-owned purpose: pass, score target, durable understanding, review, repair, or a custom outcome |
| targetOutcome | yes | Qualitative outcome plus optional measurable score/credential |
| deadline | optional | Date/time and timezone; absence means open-ended |
| studyBudget | yes | Available minutes per day/week, session preference, and known unavailable periods |
| desiredDepth | yes | pass-oriented, working fluency, high-performance, or deep/transfer; labels may evolve |
| courseScope | yes | Stable learner-language subject boundaries plus included logical Material IDs, learner-confirmed role assignments (value plus audit/version identity), and explicit exclusions; it contains no parser/extraction revision IDs or version-local Curriculum node IDs |
| learnerSelfReport | optional | Prior study, confidence, known strengths/gaps; evidence class is self-report only |
| examContext | optional | Exam date, intended scope, supplied question sets, permitted formats, constraints |
| riskTolerance | optional | What may be deferred and how much unresolved risk is acceptable |
| status/version | yes | `draft`, `proposed`, `learner_confirmed`, `active`, `closed`, `superseded`, or `withdrawn`; immutable version plus an active pointer |

“Systematic,” “exam sprint,” “deep study,” “review,” and “gap repair” are useful setup presets, not necessarily durable domain enums. A preset populates visible fields; the learner edits those fields before acceptance. Gap repair is often a response strategy, not an enduring intent.

`courseScope` records learner intention over stable, learner-meaningful Material identity: “this textbook belongs to the course,” “this artifact is a past exam,” “this reference is supplementary,” or “exclude this Material.” Exact MaterialRevision IDs, parser/extraction fingerprints, SourceBlock revisions, lineage mappings, and active-revision pointers are execution identities. They belong to Curriculum, StudyPlan/source-context fingerprints, risk reconciliation, and evidence provenance—not to the Contract.

Reprocessing or improving extraction for the same logical Material therefore never creates a successor Contract by itself. It may stale downstream mappings and require a successor Curriculum, StudyPlan reconciliation/replan, or fresh evidence. Adding/removing a logical Material or changing its learner-confirmed role requires a successor Contract only when that change alters the accepted learner-level intention or study scope.

Contract confirmation grants **scope authority** only: it decides what the learner intends to study. It does not verify any factual claim, expected answer, rubric premise, or model-generated supplement inside that scope. Truth and assessment-premise authority follow the separate rules in §15.

### Material effect

The Contract must change local policy, not prompt wording:

| Contract difference | Deterministic/validated effect |
| --- | --- |
| Three-day pass-oriented sprint | prioritize explicit course/exam scope and prerequisites; shorter explanations; fewer optional supplements; minimum fair synthesis; expose deferred risks |
| Target 90–95+ | higher checkpoint difficulty, more representation variants, more cross-unit synthesis, stronger adversarial readiness, tighter unresolved-risk gate |
| Deep study | broader connections and transfer, derivations, spaced synthesis, standard-course supplement candidates, no deadline-driven unsafe deferral |
| Review | diagnostic/direct checkpoints first, then targeted teaching; avoid replaying already verified basics |
| Persistent time-budget reduction | recompute feasibility and propose a meaningful replan; never silently delete work |

Local feasibility returns projected minutes, slack, risk, and assumptions. A model may propose priorities, but local code owns deadline math and must say when the goal appears infeasible.

### Contract lifecycle

~~~text
draft → proposed → learner_confirmed → active → closed
   ↘ withdrawn          ↘ withdrawn       ↘ superseded
~~~

This is the canonical persisted enum. Only the learner confirms. `draft` and `proposed` Contracts cannot own a Plan. A `learner_confirmed` Contract may own candidate or proposed Curriculum and StudyPlan versions, but it is not executable and cannot own an accepted Plan. A Contract becomes `active` only in the same transaction that accepts its compatible StudyPlan and installs both active pointers; therefore even first-time setup never exposes an active Contract without an accepted route. An `active` Contract owns exactly one accepted Plan, except during the same atomic pointer-swap transaction. `closed`, `superseded`, and `withdrawn` are terminal and cannot own active or accepted Plans.

When an active Plan already exists, a confirmed successor Contract remains pending activation while the old active Contract/Plan pair stays executable. Accepting a compatible successor Plan atomically activates the successor pair, records predecessor links, terminates the old pair as specified under Goal / Plan outcome, and recomposes the Agenda. A generation failure or learner rejection leaves the old pair active. Withdrawing applies only before activation; stopping an active goal uses an `abandoned` GoalOutcome rather than rewriting the Contract as withdrawn.

A learner-level logical-material/role/exam-scope change, deadline change, target change, or sustained study-time-budget change may create a successor proposal. Reprocessing the same logical Material does not. Curriculum mappings and their exact MaterialRevision/SourceBlock bindings are derived after Contract confirmation and live in Curriculum/Plan versions, not inside the Contract’s stable scope.

## 9. Curriculum

Curriculum answers:

> What is the coherent learner-visible structure of this course?

It is a versioned projection over the existing truth substrate:

~~~text
Course (existing Workspace)
  Chapter
    Section
      LearningUnit
~~~

A LearningUnit references, rather than duplicates:

- existing source Concept IDs and optional canonical group IDs;
- source sections and SourceBlock evidence;
- graph prerequisite/relationship evidence;
- learning objectives;
- prerequisite units;
- synthesis memberships;
- source/exam/risk ledger references.

Each Curriculum version binds the Contract’s stable logical-Material scope to an explicit set of accepted MaterialRevision IDs, SourceBlock revisions, parser/extraction fingerprints, and mapping results. Activating a new revision for the same Material may produce a successor Curriculum or reconciliation, but it does not redefine learner intention or require a successor Contract. Exact revision binding preserves provenance even though Contract scope remains stable.

A learner may include a topic or supplement in scope before authoritative source truth exists. The Curriculum may represent that objective with an explicit truth-unverified/advisory status, but inclusion never promotes AI Teaching or an AI Risk Candidate into Course Truth. Such an objective may be taught and probed nonblockingly until the independent truth-authority process in §15 succeeds.

### Separation from adjacent objects

| Object | Question answered | Mutability |
| --- | --- | --- |
| Source outline | How is each supplied document physically/structurally organized? | Derived per material revision |
| Concept/Graph | What concepts and evidence-backed relations exist? | Versioned supporting model |
| Curriculum | What coherent structure should the learner understand? | Candidate/accepted versions |
| StudyPlan | In what bounded route will this learner pursue this Contract? | Accepted immutable versions plus separate progress |
| SessionAgenda | What is useful and executable now/today? | Flexible within guardrails |

The Curriculum may reorganize source order for cognitive coherence, but learner-visible provenance must show where units came from. Deterministic structural mapping remains an observed fact, never proof that all important ideas were captured.

### Generation and activation

1. Deterministic code builds the source outline, known IDs, observed exam facts, and hard bounds.
2. Hy3 proposes a typed hierarchy, mappings, objectives, prerequisites, and synthesis groups.
3. Local validation rejects unknown IDs, invalid evidence, cycles, duplicate mappings, excessive depth/size, and unsupported claims.
4. A valid candidate becomes ready.
5. Learner review or an explicit acceptance policy activates it atomically.
6. Failure preserves the active Curriculum or falls back to the deterministic source outline.

Curriculum completeness is never asserted. Unmapped sections, unrepresented exam observations, and AI supplement candidates enter the Coverage/Risk Ledger.

## 10. StudyPlan

StudyPlan is the learner-accepted executable route toward one accepted Learning Contract over one accepted Curriculum.

### Plan version

A plan version contains:

- contractVersionId and curriculumVersionId;
- the exact execution-source-manifest fingerprint inherited from that Curriculum;
- ordered phases and plan items;
- rationale and estimated minutes;
- target depth and objectives;
- prerequisites;
- completion-policy reference;
- checkpoint, synthesis, and adversarial expectations;
- intentional deferrals and their risk;
- total time, slack, and feasibility assumptions;
- proposal trigger, predecessor, machine-readable diff, status, and acceptance record.

A plan item contains the stable intended work. Mutable progress—started, completed, repair-needed, deferred, or obsolete—lives in separate event/decision records so the accepted plan snapshot remains diffable.

Before acceptance, the learner can edit route inclusion within the accepted Contract, order, time allocation, depth, and explicit deferrals through typed draft commands such as add, remove-with-reason, reorder, resize-time, change-depth, and defer. Known IDs, prerequisites, Contract scope, time feasibility, completion policy, and risk are revalidated after every edit. A draft edit that would change stable learner intention, logical-Material membership, or material role must instead create a linked successor Contract/Plan proposal. Editing a Plan draft does not mutate either the Contract or the previously accepted Plan.

Acceptance validation performs a known-scope accounting check: every required in-scope Curriculum unit and objective is included, or appears in a learner-visible explicit defer/exclude record with reason and risk. A plan that silently omits known required work is invalid. Scope inclusion is not truth validation: truth-unverified objectives retain that label and cannot acquire blocking completion criteria merely by appearing in an accepted Plan.

### Pace baseline

Plan acceptance persists a versioned PaceBaseline:

- planned cumulative minutes and milestone dates in the Contract timezone;
- expected session cadence and explicit slack;
- estimate confidence and source;
- the accepted Plan/Contract versions.

Actual study time comes from persisted StudySession activity intervals and formal activity durations, with learner correction controls. Wall-clock time while a tab is idle is not silently counted as study.

Deterministic policy reports pace as unknown, on_track, or at_risk with reason codes. Unknown applies when there is too little reliable elapsed-time evidence. At-risk requires a documented threshold for persistent cumulative slippage, missed milestone, remaining-effort/deadline infeasibility, or sustained budget change; one long conversation does not trigger it. Thresholds and policy versions are visible and testable.

### State and authority

~~~text
candidate → proposed → accepted → superseded
                     ↘ closed
candidate/proposed → rejected
~~~

Hy3 may propose. Local code validates. The learner accepts. There is exactly one accepted StudyPlan per active Contract until that Plan is superseded or closed. A failure never overwrites the accepted Plan.

Pausing study is execution state, not a StudyPlan-version state. The immutable Plan remains `accepted`, and the Course execution projection, active Agenda, and/or StudySession records the pause. Resume revalidates the accepted Contract/Plan, exact Curriculum/execution-source-manifest fingerprint, launchability, and route origin before continuing or visibly recomposing the Agenda. Pause/resume alone never creates a Plan version.

For a successor Contract, Plan acceptance and Contract activation use the atomic pair handoff defined above; an accepted Plan can never remain active against a different active Contract version.

### Executability

Each item must resolve to locally supported actions: teach a unit, launch an informal check, launch a formal checkpoint, run synthesis, perform targeted repair, do a due review, or execute an adversarial readiness check. Reuse the existing activity-launchability pattern: server-owned capability checks and launch requests, completion-time and launch-time revalidation, visible deterministic fallback only where semantics remain valid.

### Goal / Plan outcome

The Course records an immutable GoalOutcome when the accepted Contract route terminates:

- achieved: all required outcome policy and readiness criteria satisfied;
- finished_with_gaps: learner explicitly closes the goal with named deferred/unresolved/blocked areas;
- expired_unfinished: the deadline passed without satisfying the outcome; the learner may continue under a successor Contract;
- abandoned: learner explicitly stops pursuing it;
- superseded: a successor Contract replaces the intended outcome.

Deadline passage alone does not invent failure evidence or delete the route. It changes feasibility/risk and may produce expired_unfinished only when the outcome is closed or superseded under policy. Every outcome stores Contract/Plan versions, formal evidence summary, unresolved gaps/risks, reason, actor, and time. “Finished with gaps” can never display as unqualified achievement.

### Terminal transaction

Closing or superseding a goal is one idempotent, expected-version transaction. It:

1. validates that the referenced Contract/Plan pair is still the active pair and that no GoalOutcome already exists for that route termination;
2. appends the immutable GoalOutcome and audit event;
3. moves the Plan from `accepted` to `closed` for `achieved`, `finished_with_gaps`, `expired_unfinished`, or `abandoned`, and moves its Contract from `active` to `closed`;
4. for `superseded`, moves the old Plan and Contract to `superseded` while atomically installing the already validated, learner-accepted successor Contract/Plan pair;
5. closes the old active Agenda, marks its unfinished items `cancelled_goal_terminal` or `carried_to_successor` with explicit provenance, and either clears the Agenda pointer or installs a newly composed successor Agenda;
6. ends any open StudySession against the old route with a typed `goal_terminal` or `route_superseded` reason, fences pending Tutor operations so they cannot finalize against that route, and preserves the transcript, summary, formal launches, and audit events; and
7. clears the Course active Contract/Plan/Agenda pointers when there is no successor, or swaps all three pointers to the successor consistently when there is one.

An assessment already submitted may still finish through the existing grading transaction and remains valid historical evidence, but its later progression reconciliation sees the closed/superseded expected versions and cannot reopen or advance the route. Reviews, attempts, mistakes, mastery, risks, and historical plans remain accessible in Progress; none is cascade-deleted. Starting again requires an explicit successor Contract/Plan, and carrying unfinished items or evidence into it follows visible lineage and fresh acceptance rules. Repeating the terminal command returns the recorded outcome rather than duplicating it.

## 11. SessionAgenda

SessionAgenda answers:

> What am I doing now or today?

It is intentionally more flexible than the StudyPlan. Agenda changes do not create plan versions unless they change the long-term accepted route.

Agenda items may be:

- due review;
- targeted repair;
- current LearningUnit teaching;
- informal check;
- formal checkpoint;
- section/chapter synthesis;
- learner-requested detour;
- short prerequisite repair;
- stretch/deep-dive challenge;
- adversarial readiness check.

Each item records origin, reason, estimated minutes, linked plan item if any, launch capability, priority, state, and time impact.

### Composition

At session start, deterministic code:

1. reads the accepted plan and progress;
2. adds due reviews and unresolved high-priority repairs;
3. selects the next prerequisite-valid plan item;
4. applies the learner’s available minutes;
5. optionally includes a checkpoint/synthesis/readiness item required by policy;
6. validates launchability;
7. explains the chosen order and any displaced work.

When no due repair blocks progress, composition advances to prerequisite-valid unassessed Plan units. It must not loop indefinitely over already-known mistakes/reviews while accepted units remain unreachable.

Hy3 may rank semantically equivalent choices or explain why; it does not own queue mutation.

### Agenda state

~~~text
draft → active → completed
             ↘ paused
             ↘ abandoned
item: queued → active → completed
              ↘ deferred
              ↘ cancelled
              ↘ blocked
~~~

Agenda history is auditable but can be edited fluidly. “I have 20 minutes” recomposes today’s items and reports the impact; it does not rewrite the Plan.

`paused` and `abandoned` above are Agenda/execution states only. They are not StudyPlan-version states and do not change the accepted Plan pointer.

## 12. Mixed-initiative learner controls

The Agent owns the default route. The learner owns intention.

### A. Explore / Detour

When the learner asks to review Bayes, inspect Chapter 5, or explore a relationship:

1. persist a detour event with origin agenda/plan item and reason;
2. push the current route location onto a session route stack;
3. create a bounded detour agenda item;
4. teach conversationally;
5. record ordinary transcript/history evidence only;
6. optionally launch a separately labeled formal activity;
7. offer or automatically perform return-to-route when the detour ends.

A detour does not change the Plan.

Detours may nest only to a small local limit. Each route-stack frame records parent frame, origin Agenda/Plan item, active Contract/Plan/Agenda versions, reason, and resume policy. Finishing or deferring the top detour pops one frame and revalidates the next origin. Stop preserves the stack for resume; abandoning the session closes all frames with explicit events. Plan supersession marks old origins stale and recomposes a new route rather than jumping to an obsolete item.

### B. Insert into SessionAgenda

“Add a 10-minute review” inserts an agenda item, re-estimates today’s session, and shows what moves later. It changes no long-term route.

### C. Stretch / Deep Dive

A stretch overlay may increase explanation depth, objective complexity, or challenge difficulty for the current unit. Successful formal evidence can add a higher-level evidence record. Failure adds a bounded stretch/transfer gap and recommended repair; it never erases valid evidence for simpler objectives.

### D. Direct Checkpoint

“I already know this” may bypass teaching when an appropriate formal checkpoint is launchable. Progress advances only if existing formal validation and Contract-specific completion rules accept the result.

### E. Explicit Defer / Skip

The learner can defer an item with optional reason and revisit date. The plan-progress state becomes deferred, the risk ledger remains open, feasibility is recalculated, and no completion evidence is invented.

### F. Promote to Plan

If a detour becomes a sustained objective, Hy3 may propose a successor plan. Local code shows added/removed/reordered work and time/risk impact. Only learner acceptance changes the active route.

### G. Meaningful Replan

Deadline, goal, sustained study-time budget, learner-level logical-material/role/exam scope, revision-driven route invalidation, repeated formal evidence, synthesis failure, strong prerequisite failure, or meaningful coverage risk may create a replan proposal. Reprocessing the same logical Material does not create a successor Contract, and ordinary agenda movement does not create a replan.

### Explicit transition model

| Current session state | Event | Local action | Plan effect | Next state |
| --- | --- | --- | --- | --- |
| on_route | learner.detour_requested | Push origin; insert detour item | none | detour_active |
| detour_active | learner.detour_question | Append bounded exchange | none | detour_active |
| detour_active | learner.formal_check_requested | Launch isolated formal activity if valid | progress may later reconcile from evidence; no route rewrite | detour_active |
| detour_active | detour.finished | Restore and revalidate origin | none | return_pending |
| return_pending | origin.valid | Activate prior/next route item | none | on_route |
| return_pending | origin.stale_or_blocked | Recompose agenda and explain | none unless a separate replan is proposed | on_route |
| on_route or detour_active | learner.agenda_inserted | Insert/reorder and show time impact | none | same |
| on_route or detour_active | learner.deep_dive | Attach depth overlay | none | same |
| any active | learner.defer | Persist visible gap and risk | item progress deferred, accepted snapshot unchanged | on_route or execution_paused |
| any active | learner.pause | Persist Course/Agenda/Session execution pause; interrupt or detach the active attempt safely; preserve route stack | none; accepted Plan remains `accepted` | execution_paused |
| execution_paused | learner.resume | Revalidate Contract/Plan/Curriculum/execution-source-manifest versions, route origin, and launchability; resume or visibly recompose | none unless a separate replan is proposed | on_route |
| detour_active | learner.promote | Create successor-plan proposal/diff | none until acceptance | detour_active |
| any active | replan.triggered | Create bounded proposal sidecar | none; current route continues | same route state + proposal pending |
| any + proposal pending | learner.accepted | Atomically activate successor Contract/Plan pair where applicable, invalidate/rebase route frames, and recompose agenda | successor becomes active | on_route |
| any + proposal pending | learner.rejected | Preserve old plan/route and record decision | none | same route state |

Navigation away is not necessarily cancellation. The server persists the session and marks the client detached. An explicit Stop aborts the active provider attempt, records interruption, and leaves durable state resumable.

Replan proposal status is orthogonal to on_route/detour_active/return_pending. Opening a proposal never strands the active StudySession. Deferring an origin item marks that frame resolved and returns to the next valid frame; stale origins are popped with visible audit events until a valid route item is found or the Agenda is recomposed.

## 13. StudySession / Tutor

StudySession is the primary learning workspace and execution container. It spans an Agenda slice, route stack, one or more Tutor turns/threads, learner interruptions, informal probes, and separately launched formal activities. A Tutor thread is conversation inside a StudySession, not the owner of session completion or route state. The existing TutorRun remains historical current behavior until deliberately migrated; it must not be silently reinterpreted.

Learners may naturally ask:

- 为什么？
- 我没懂。
- 换一种说法。
- 举个例子。
- 这和前面的 X 有什么关系？
- 我理解成 X 对吗？
- 如果考试这么问呢？
- 给我一道题检查一下。
- 我突然想复习 Y。
- 这部分我想深入学。
- 来点真正能把我难倒的。

### Turn lifecycle

~~~text
command accepted
→ session/turn/version preflight
→ context manifest built
→ logical model call created
→ one or more physical attempts streamed
→ output and permitted actions validated
→ transcript/summary/audit finalized
→ optional local command executed
~~~

Tutor language can be fluid. State-changing actions are typed commands selected from a capability list. A text claim such as “mark this complete” has no authority.

### Persistence and resume

Persist:

- user and Tutor exchanges with stable sequence IDs;
- turn state: queued, running, completed, failed, interrupted, cancelled;
- context manifest/fingerprint and transcript watermark;
- safe tool/action events;
- provider attempt and cost links;
- rolling summary versions;
- current route stack and agenda position;
- Course/Agenda/Session execution pause/resume events, without changing the accepted StudyPlan.

After restart, an orphaned running attempt becomes interrupted. The learner can retry idempotently from the last completed watermark. Never pretend the exact provider generation can resume unless the provider supports a verified continuation contract.

## 14. Tutor context strategy

Bounded context is assembled, not accumulated forever.

### Priority layers

1. system authority and permitted actions;
2. accepted Course/Contract/Curriculum/Plan/Agenda versions;
3. current unit objectives, completion criteria, prerequisites, and synthesis role;
4. selected course-truth SourceBlocks and existing cached lesson artifacts;
5. relevant formal evidence, open mistakes, misconceptions, and due review state;
6. relevant Coverage/Risk and Exam Blueprint entries;
7. recent raw exchanges;
8. rolling summary up to a recorded transcript watermark.

Deterministic retrieval selects IDs and enforces budgets. Hy3 does not browse the entire database or silently retrieve outside scope.

### Rolling summary contract

A summary is a derived, replaceable cache with:

- sessionId and summary version;
- throughExchangeSeq watermark;
- stable Contract-scope fingerprint plus Contract/Plan/Agenda/Curriculum versions and the exact execution-source manifest fingerprint (MaterialRevision, SourceBlock revision, parser/extraction identity);
- learner questions and unresolved confusion;
- explanations tried and learner reactions;
- provisional conversational understanding, explicitly non-formal;
- detour origin/return state;
- open actions and safety flags.

It contains no private chain-of-thought. Raw exchanges remain authoritative for audit. A mismatched fingerprint makes the summary stale; regenerate or omit it.

Normal turns do not trigger a hidden second call: the terminal Tutor response may include a bounded structured summary delta within the same logical call, which local code validates and applies to the prior summary. A separate summarizeStudySession operation is allowed only for explicit compaction/regeneration after a watermark threshold or stale-summary recovery. It is independently budgeted, cached by transcript/version fingerprint, attributed to the Session, and visible in telemetry.

### Staleness and cancellation

Every asynchronous turn carries the stable Course/Contract-scope identity separately from exact MaterialRevision/source-manifest, Contract, Plan, Agenda, Session, and transcript-watermark expectations. Before finalization, local code rechecks them. A stale turn may remain visible as interrupted history but cannot execute actions or update the current summary.

Client take-latest epochs, AbortSignal propagation, request disconnect handling, and workspace/session identity checks extend the current cancellation model.

## 15. Source truth vs AI teaching vs AI risk candidates

Three authority classes are mandatory.

### Scope authority is not truth authority

Two independent authority axes apply:

- **Scope authority** determines which topics, objectives, logical Materials, and material roles belong to what the learner intends to study. The learner authoritatively confirms this axis through the Learning Contract and later governed scope changes.
- **Truth / assessment-premise authority** determines whether a factual claim, expected answer, rubric premise, or blocking assessment basis is sufficiently verified to affect formal progression. Learner confirmation of a topic, objective, Material, role, Curriculum unit, or Plan item is never sufficient for this axis.

| Scope status | Truth/premise status | Permitted behavior |
| --- | --- | --- |
| In scope | Independently verified | Teach; use as a blocking formal premise when the accepted completion policy permits |
| In scope | Unverified/model-only | Clearly labeled AI Teaching, route inclusion, risk tracking, and advisory/nonblocking probes only |
| Out of scope | Independently verified source claim | Preserve provenance and show as out-of-scope context/risk; do not make it a required route or blocking criterion until scope is confirmed |
| Out of scope | Unverified/model-only | Risk/supplement candidate only |

A separately validated authoritative-source addition is distinct from Contract acceptance. It records the logical source, exact accepted MaterialRevision and SourceBlock/claim provenance, admitted premise scope, authority policy/basis, validation result, conflict status, actor, and audit/version history. The source evidence and important model output still pass the existing grounding, schema, ID, and domain checks. Exact quotation establishes occurrence at the claimed location, not complete semantic entailment; ambiguous or conflicting premises remain nonblocking until the authority policy resolves them. Learner scope confirmation alone can never create this record or promote model prose.

### A. COURSE TRUTH

Verified, material-derived course-specific content from a source admitted by the separate truth-authority policy:

- terminology and notation;
- claims and definitions;
- examples and source-stated applicability/boundaries;
- assessment premises where applicable.

Every claim used as grounded course truth retains SourceBlock and material-revision provenance. Exact quotation proves location, not full semantic entailment.

### B. AI TEACHING

Model-generated explanation:

- intuition, derivation, analogy, alternate phrasing;
- generated examples and broader connections;
- prerequisite explanation;
- pedagogical sequencing.

AI teaching may go beyond literal source wording and is labeled accordingly. It can support learning but is not automatically grading evidence or course truth.

### C. AI RISK / SUPPLEMENT CANDIDATES

Model-generated hypotheses:

- standard-course supplements;
- alternate notation or representation;
- likely blind spots;
- prerequisite risks;
- possible exam variations;
- transfer or integration risks.

Candidates enter the Coverage/Risk Ledger as unresolved with origin/model/prompt version. They become eligible Course Truth only through independently verified source evidence under the truth-authority policy or the separately validated authoritative-source addition process above. Learner acceptance into study scope does not perform that promotion. Candidates may justify a learner-visible advisory check without being asserted as fact.

If AI teaching conflicts with verified course truth, course truth wins for this Course. The product may disclose the conflict and broader convention; it must not silently rewrite the course.

### Operation-level authority policy

Authority is constrained before generation, not assigned only after text appears:

- teaching may use Course Truth and clearly labeled AI Teaching;
- ordinary course assessment premises and required answers use independently authorized Course Truth;
- risk scans may output AI Risk Candidates;
- a risk candidate may select an advisory probe, but cannot become a blocking completion premise by prompt fiat;
- Plan/risk rationales record scope authority and truth/premise authority separately for every premise.

### Segment provenance and conflicts

Teaching artifacts use structured segments. A source-backed segment carries server-verified materialRevisionId, SourceBlock, quote, offsets, and the exact claim it is allowed to support. An AI-teaching segment carries no false citation. The server, not the model, assigns the final displayed class.

If a required course-grounded claim has invalid evidence, the operation receives at most one bounded targeted repair or fails. An optional invalid citation may be dropped or relabeled AI Teaching only when local policy confirms that the segment is optional, contains no course-specific assessment premise, and the label is honest; otherwise it is removed.

If two verified course sources conflict, preserve and show both claims and provenance. The learner may identify the intended course convention or preferred route, but formal assessment remains blocked until a separate versioned truth-authority policy chooses among already verified sources and records its basis. The learner cannot resolve a source conflict by validating unsupported model prose. Without an eligible policy decision, the area remains a source-conflict risk and no model silently chooses the winner.

### Admissibility tiers for checks

1. Blocking formal evidence: every state-crediting answer/rubric premise is grounded in independently authorized Course Truth, including any separately admitted and validated authoritative source. Being present in the Contract, Curriculum, or Plan is necessary for scope but insufficient for truth authority.
2. Derived representation evidence: an alternate representation is locally or formally validated as equivalent to grounded Course Truth; it may affect the specifically declared robustness criterion.
3. AI-only teaching/supplement/adversarial probe: it may be inside learner-confirmed scope and is useful as advisory diagnostic history and a Risk Ledger update, but is nonblocking; it cannot complete a required objective, prevent otherwise valid completion, or mutate mastery unless its premises later gain independent truth authority and a new tier-1/2 formal activity is performed. Old tier-3 results are never retroactively promoted.

## 16. Formal evidence boundary

The system distinguishes three channels:

| Channel | Purpose | May update formal learner state? |
| --- | --- | --- |
| Conversational teaching | Explain, question, explore, connect, encourage | No |
| Informal check | Low-stakes comprehension probe used to choose the next teaching move | No |
| Formal assessment | Versioned, launchable, isolated activity with validated grading and audit | Yes, through existing local grading services only |

“懂了,” confident prose, Tutor approval, time spent, content viewed, or an informal correct answer never completes a LearningUnit.

Persisting a formally presented attempt is not sufficient to make it state-crediting evidence. Only tier-1 or validated tier-2 premises may enter the existing grading-to-progression mutation path. Tier-3 probes may retain answers, feedback, and diagnostic history, but their result is non-state-changing even when the learner requested or accepted the topic.

Formal evidence reuses and extends the current reliable machinery:

- public quizzes omit answers/rubrics;
- objective answers are local;
- semantic coverage is runtime-validated and points recomputed locally;
- duplicate/stale submissions have zero duplicate effect;
- the existing grading transaction rechecks state, records the immutable attempt, and applies its current mistakes, mastery, misconceptions, review, and state-change snapshot exactly once;
- state-changing writes are idempotent and correlated;
- failure or cancellation preserves the prior valid state.

New LearningUnit progression is intentionally reconciled after valid grading commits. A unique reconciliation record keyed by gradingResultId + completionPolicyVersion + unit/objective scope transitions from reconciliation_pending to applied or rejected/stale. It is independently retryable and idempotent. A stale Plan, completion-policy bug, or progression write failure must not roll back or discard an otherwise valid immutable grading result.

Each formal evidence record identifies assessment kind, primary objective ID, explicitly scored secondary objective IDs if any, difficulty/depth, representation kind, stable learner scope, exact premise-authority claim IDs and MaterialRevision/SourceBlock provenance, admissibility tier, Contract/Plan/Curriculum/source-manifest versions, grading result, and evidence limitations. Every state-crediting question has one primary objective. Contextual appearance of another concept earns it no completion credit unless a separate explicit rubric point and validated attribution exists. This prevents broad questions from overcrediting many objectives.

The model never writes mastery or completion.

## 17. LearningUnit completion

Completion is a deterministic, auditable decision over formal evidence under the accepted Contract’s policy. It is not an alias for the current mastery score or graph overlay.

### Unit state

~~~text
not_started → active → evidence_pending
                    → completed
                    → repair_needed
                    → deferred
completed → review_due
~~~

History is append-only; the current state is a projection. A source revision may make prior evidence non-current or scope-limited, but does not delete it.

After grading commits, a unit may display evidence_recorded / reconciliation_pending until the unique progression reconciliation succeeds. It must not display completed early, and a retry does not regrade or reapply the grading transaction.

### Completion policy

A versioned policy can require:

- coverage of specified objectives;
- minimum validated score/required-point coverage;
- absence or acknowledged status of blocking mistakes;
- evidence at required depth;
- prerequisite evidence;
- representation or transfer evidence for high-performance goals;
- required synthesis/readiness outcomes;
- recency where the Contract makes readiness time-sensitive.

Policies are Contract-sensitive. A pass sprint, a 95+ target, and deep study do not share one universal threshold. Policy presets remain visible and testable; arbitrary model-authored thresholds are rejected.

No Contract or completion policy can override admissibility. Every blocking criterion must be satisfied by tier-1 or validated tier-2 evidence; an in-scope but truth-unverified objective may remain a visible route goal, but its tier-3 probe cannot block or complete formal progression.

### Decision outcomes

- complete: all required criteria satisfied;
- continue: evidence is valid but insufficient;
- targeted repair: named objectives/mistakes need bounded repair;
- deferred: learner explicitly accepts the visible gap/risk;
- replan candidate: repeated or structurally significant evidence indicates the route is no longer feasible.

The decision stores criteria evaluated, evidence IDs, failures, rule version, resulting state, and next-action reason.

## 18. Synthesis

Synthesis verifies that locally learned units compose.

Levels:

- section synthesis: connect and discriminate nearby units;
- chapter synthesis: integrate a coherent larger structure;
- course/goal synthesis: apply the intended outcome across major areas;
- transfer synthesis: use knowledge in a changed surface context.

Synthesis is a formal activity when it affects progression. Generation references only known objectives, concepts, evidence scopes, and allowed representations. Local code validates breadth, learner scope, independent truth/premise authority, exact source provenance, question structure, and grading contracts.

A synthesis failure:

- creates named integration/transfer gaps;
- may reopen the current readiness decision or trigger repair/replan;
- does not erase valid lower-level evidence;
- never automatically reduces unrelated mastery;
- records which composition failed and at what difficulty.

Synthesis is necessary but insufficient for high-stakes readiness; adversarial representation and blind-spot checks are separate.

## 19. Meaningful replanning

A replan is a successor proposal to an accepted StudyPlan. It is not routine agenda recomposition.

### Eligible triggers

- deadline or target-outcome change;
- sustained available-time change beyond a configured tolerance;
- deterministic PaceBaseline status remaining at_risk across the configured persistence window;
- learner-confirmed stable logical-Material/role/topic/exam scope change;
- repeated formal evidence that changes time/depth assumptions;
- synthesis failure spanning multiple units;
- strong prerequisite failure that blocks several items;
- active MaterialRevision/source-manifest change that invalidates route mappings;
- meaningful unresolved coverage/readiness risk;
- learner promotion of a detour into a long-term objective.

The trigger determines which aggregate changes. A learner-level intention, logical-Material membership, or role/scope change may require a successor Contract plus compatible Curriculum/Plan. A new parser/extraction revision of the same logical Material keeps the Contract unchanged and may instead require a successor Curriculum and StudyPlan under that Contract. Reconciliation must never disguise revision churn as learner intent.

### Ineligible by themselves

- asking an exploratory question;
- inserting one short review;
- one informal answer;
- moving today’s agenda;
- one provider failure;
- one harder-than-required stretch failure.

### Proposal contract

Every proposal records:

- trigger type and evidence;
- predecessor and successor version IDs;
- item-level added, removed, reordered, deferred, time, depth, and criterion changes;
- new feasibility and risk;
- concise learner-visible rationale;
- validation results;
- learner decision.

Pace-triggered proposals include the planned-versus-actual cumulative minutes, remaining effort, deadline slack, confidence, threshold/policy version, and reason code. If actual-time evidence is insufficient, status stays unknown and cannot autonomously trigger a replan.

Acceptance atomically supersedes the pointer and recomposes the agenda. Rejection preserves the route. The Agent must support “keep my plan and just repair this gap.”

## 20. Coverage / Risk Ledger

The ledger makes omission and readiness risk inspectable without claiming semantic completeness.

### Required categories

- explicitly present in course material;
- structurally mapped;
- included in Curriculum;
- observed in supplied past exams/questions;
- formally taught;
- formally assessed;
- AI-suggested standard-course supplement;
- prerequisite risk;
- representation/notation variant risk;
- transfer/integration risk;
- adversarial blind-spot candidate;
- unresolved/unverified risk;
- intentionally deferred area.

These categories are facets, not a single forced status. A topic may be present, mapped, included, taught, and still not assessed. Another may be an unverified supplement candidate.

### Entry shape

Each entry has:

- stable ID plus stable Course/Contract/topic/objective/logical-Material scope identity;
- revision-bound observations with exact active MaterialRevision/SourceBlock/source-manifest provenance and reconciliation status;
- category/facets, scope-authority status, and truth/premise-authority status as separate fields;
- referenced source, Curriculum, concept, exam observation, objective, or evidence IDs;
- origin: deterministic, source, learner, exam observation, or model candidate;
- status: open, acknowledged, planned, checking, resolved, rejected, deferred, stale;
- severity/priority and Contract sensitivity;
- explicit claim and uncertainty;
- first-observed and last-verified times;
- resolution evidence or learner decision;
- model/provider/prompt metadata when semantic.

### Local rules

- Structural mapping proves mapping only.
- Formal teaching/assessment facets come only from recorded actions/evidence.
- AI candidates remain candidates.
- Unknown IDs or invalid evidence are rejected.
- Normalized duplicates merge provenance without losing history.
- Contract/Curriculum/source-manifest changes mark affected observations stale for reconciliation while preserving a stable risk identity where the underlying learner-scope concern remains the same.
- Learner scope confirmation can move an entry into planned/in-scope state but cannot resolve truth-unverified status or authorize a blocking premise.
- Risk aggregation is deterministic and bounded.
- Ordinary learning continues if a semantic risk scan is unavailable.

The product claim is:

> systematically reduce and expose omission risk

It is never:

> guarantee that every important concept has been covered

Unknown unknowns have no ledger row until detected. The UI must explain this limitation.

## 21. Exam / Question Blueprint

An Exam/Question Blueprint is a lightweight, versioned analysis of supplied past exams, exercise sheets, or question sets. It is separate from the existing assessment-generation QuestionBlueprint.

Each logical Material has a learner-confirmed role assignment: course_material, supplementary_reference, past_exam, exercise_sheet, or question_set. The assignment is versioned independently from parser revisions and constrains scope and how evidence may be considered; it does not verify every embedded claim or answer. A past exam is Course Truth about what that verified artifact asked and how it represented the task, but not automatically Course Truth for every embedded answer/claim, and it is not silently added to ordinary course scope. Reprocessing the same Material preserves its role assignment. Changing a role creates a new role-assignment version, stales affected Blueprint/Curriculum/risk mappings, and requires Contract reconciliation or a successor only when learner-level intention/scope changes.

### Observations

It may record:

- observed topic/objective mappings;
- question and response types;
- representations, notation, wording, and data forms;
- recurring combinations of concepts;
- required abilities: recall, explanation, procedure, proof, application, transfer;
- rough observed difficulty signals;
- raw counts and relative frequency within the supplied sample;
- unmapped or ambiguous items;
- exact question-set/page/block provenance.

### Epistemic rule

Observed frequency means only “frequency in these supplied artifacts.” It must not be presented as probability of future appearance. “Exam clone” means style/scope-informed practice, not prediction.

### Interaction

- Learning Contract: exam date, target, and format determine weight and urgency.
- Curriculum: observed topics/abilities map to units; unmapped observations create risks.
- StudyPlan: priority/time and checkpoint mix may change after confirmation.
- Coverage/Risk Ledger: observed-but-unplanned representations or combinations remain open.
- Completion: high-score policies may require more observed representation coverage only through admissible tier-1/2 premises.
- Examiner Mode: the Blueprint calibrates fair formats and combinations without bounding all possible future questions.

Hy3 proposes semantic mappings. Local code validates question IDs, source locations, counts, controlled enums, and duplicate observations.

## 22. Blind-spot / Adversarial Risk Scan

The scan asks:

> Within the intended scope, where might apparent mastery remain shallow, memorized, representation-bound, or non-transferable?

Inputs are bounded: Contract, Curriculum/objectives, course truth, exam observations, formal evidence patterns, mistakes/misconceptions, and selected AI teaching artifacts.

Candidate types include:

- alternate notation;
- equivalent representation;
- unusual but fair phrasing;
- hidden assumptions or boundary conditions;
- neighboring-concept confusion;
- changed surface context;
- multi-concept composition;
- transfer;
- unfamiliar-but-standard representation;
- standard-course knowledge not expanded in supplied material.

Output is a typed set of AI Risk Candidates with scope, rationale, expected diagnostic value, proposed evidence kind, difficulty, and provenance to the inputs that motivated it. Local validation rejects unknown entities, any AI candidate represented as Course Truth without independent premise authority even when it is in learner scope, duplicates, invalid evidence, technical/runtime bound overflow, and any configured spending-policy violation.

The scan changes no mastery or completion. Failure marks risk analysis unavailable/stale and does not block normal learning.

## 23. Examiner / Adversarial Readiness

Examiner Mode is not “generate a hard quiz.” It selects worthwhile risk candidates and tests them fairly.

### Stage A: candidate selection

Local policy combines:

- Contract target/deadline/time;
- unresolved ledger severity;
- objective importance and synthesis role;
- prior evidence strength and representation diversity;
- observed exam formats;
- candidate validation/confidence;
- remaining configured cost budget, if any, plus the learner’s time budget.

For a 95+ goal, selection is broader and more aggressive. Deep study emphasizes transfer and integration. A short pass sprint prioritizes high-value in-scope risks and explicitly defers the rest.

### Stage B: formal check

Evidence kinds include:

- representation robustness;
- notation recognition;
- transfer;
- hidden-condition recognition;
- integration;
- high-difficulty stability.

The assessment pipeline independently validates scope authority, truth/premise authority, admissibility tier, exact premise provenance, known IDs, answer secrecy, rubrics, grounding, and launchability; it never trusts the model’s own authority label. Grading uses the formal boundary. Successful tier 1 or validated tier 2 evidence can satisfy the explicitly declared higher-depth criterion. Tier 3 results remain advisory/nonblocking. Failure:

- creates or updates a specific risk/gap;
- proposes targeted repair;
- may affect blocking readiness or trigger a replan only when the check is tier 1/2 and the accepted Contract policy declares that criterion; tier 3 remains advisory;
- never erases already valid simpler-objective evidence;
- never invents a course fact from a candidate.

Both Agent-triggered readiness gates and learner-triggered “try to really challenge me” detours are supported. A learner-triggered challenge remains a detour unless its formal result is explicitly reconciled with plan objectives.

Engram proves that blind/adversarial assessment and receipts are prior art. Study Clinic’s design focus is integration with accepted plan state, source/exam risk, mixed initiative, and transactional progression.

## 24. Input Fidelity / material roadmap

Ingestion is commodity infrastructure, not product moat. All formats normalize into one Study Clinic-owned pipeline:

~~~text
Material
→ immutable MaterialRevision
→ parser adapter
→ typed structural units
→ normalized content and hierarchy
→ page / slide / sheet / image identity
→ SourceBlock-compatible projection
→ grounding, mapping, Curriculum, and risk
~~~

Every adapter emits typed warnings, partial/failure status, parser/version metadata, original-asset identity, and derivation provenance. OCR text is explicitly marked OCR-derived with confidence/region metadata. A table or formula is not claimed as structured if only flattened text survived.

Material role is stored against stable logical Material identity, independently from parser result, and confirmed before semantic use. Parser output or revision activation never creates or changes that learner-confirmed role. The role constrains scope/evidence eligibility but does not itself grant truth authority to embedded claims, answers, or model interpretations.

### Priority roadmap

| Priority | Scope | Decision and exit gate |
| --- | --- | --- |
| Keep reliable | pasted text, Markdown, TXT, text-layer PDF, DOCX | Keep existing unpdf/PDF.js and Mammoth adapters; strengthen revision lineage, security, warnings, and normalized structural units |
| First expansion | PPTX | Fixture/security spike officeParser for slide identity, order, notes, images, tables, equations, abort, ZIP limits; adopt only if representative fixtures pass |
| Second expansion | screenshots/images and scanned PDF | PDF.js render + Sharp normalization + bounded Tesseract.js workers; ship only with multilingual accuracy, resource, cancellation, and provenance gates |
| Selective fidelity | embedded DOCX/PPTX images and simple tables/formulas | Extract original assets and structured OOXML nodes where reliable; preserve fallback image/text and warnings |
| Later/conditional | XLSX or structured data | Add only if learner evidence shows a real course need; retain sheet/cell/range identity and one normalized model |
| Deferred | general diagram understanding, handwriting, complete math OCR, arbitrary complex layout | Do not claim support until fixture-based fidelity and license/operations review succeeds |

Docling’s unified document representation, staged conversion, partial results, and typed provenance are useful architecture patterns. Its Python/native/model-heavy full pipeline is not adopted because it conflicts with the current TypeScript backend and small local deployment. officeParser is a better TypeScript candidate for a bounded PPTX spike, but its broad/fast-moving dependency surface requires pinning and SBOM/security review.

### Failure recovery

- preserve original bytes and prior active revision;
- isolate parser work with size, time, decompression, page, and memory limits;
- allow per-page/slide retry where the adapter permits;
- activate a revision only after normalized validation;
- expose skipped/uncertain regions as risks;
- never replace valid extracted truth with a failed candidate.

## 25. Reuse Decision Matrix

Decision meanings:

- BUILD: product-specific semantics belong in the current codebase.
- ADAPT PATTERN: independently implement a proven architecture idea.
- USE LIBRARY: depend on a maintained library behind a Study Clinic adapter.
- REUSE SOURCE: copy/adapt upstream source with revision and notices.
- DEFER: do not add now; preserve an extension seam.

No source-level reuse is proposed in this design.

| Capability | Study Clinic need | Relevant prior art | Underlying project/library/standard | What is reusable | Decision | License | Attribution/NOTICE impact | Integration risk | Maintenance risk | Effect on product differentiation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Text PDF | Page-aware text/source identity | OpenTutor, DeepTutor, Docling | [unpdf](https://github.com/unjs/unpdf) / [PDF.js](https://github.com/mozilla/pdf.js) | Existing extraction/render APIs | USE LIBRARY | MIT / Apache-2.0 | Retain licenses and any PDF.js NOTICE | Medium: reading order/layout | Medium: pin runtime-compatible versions | None; commodity |
| Scanned PDF/OCR | Recover printed scans with page/region provenance | DeepTutor parser choices; Docling | [Tesseract.js](https://github.com/naptha/tesseract.js) after PDF.js page render | OCR worker and word/region output after a future gate | DEFER | Apache-2.0; model data separately | License/NOTICE and language-model inventory | High: CPU, layout, math, language | Medium/high | None; commodity |
| DOCX | Semantic headings/lists/tables/images | OpenTutor, DeepTutor | [Mammoth](https://github.com/mwilliamson/mammoth.js) | Existing semantic conversion and image hooks | USE LIBRARY | BSD-2-Clause | Preserve copyright/license | Medium: sanitize, no page identity | Low/medium | None |
| PPTX | Slide/notes/order/assets/tables/equations | OpenTutor, DeepTutor | [officeParser](https://github.com/harshankur/officeParser) candidate | Typed AST and AbortSignal after fixture/security spike | DEFER | MIT | Preserve license; audit transitive SBOM | High: broad deps, OOXML edge cases | Medium/high: fast-moving | None |
| Images/screenshots | Original asset plus OCR-ready derivative | Docling; OpenTutor multimodal intake | [Sharp](https://github.com/lovell/sharp) + Tesseract.js | Decode/rotate/resize plus OCR after a future gate | DEFER | Apache-2.0 | Preserve notices; audit libvips/model terms | High: native binaries/resource bounds | Medium | None |
| Tables/formulas | Preserve structure or declare loss | Docling, officeParser | Docling structural model; OOXML nodes | Typed node/partial-result pattern | DEFER | MIT code; model licenses vary | No copied source; later model audit | High | High | None |
| Normalized intake | One truth path for all formats | Docling, officeParser | Study Clinic schema over parser adapters | Structural-unit and warning pattern | BUILD | Existing project; pattern only | None | Medium | Medium | Supports trust, but not a moat |
| Transcript persistence | Durable ordered exchanges/resume | DeepTutor | SQLite | Append-only exchanges, watermarks, statuses | BUILD | SQLite public domain | None | Medium: ordering/idempotency | Low | Core enabling semantics |
| Rolling context summary | Bounded long sessions with lineage | DeepTutor three-layer memory | Zod + SQLite | Raw-to-derived layering and provenance | BUILD | MIT existing Zod; SQLite public domain | Existing notices only | High: summary drift | Medium | Supporting, not differentiating alone |
| Streaming/cancellation | Responsive turns and honest interruption | DeepTutor restart-safe SSE | WHATWG Streams, AbortSignal; current NDJSON | Standards and current requestSignal/epochs | ADAPT PATTERN | Open standards | None | Medium: late chunks are not rollback | Low | Reliability, not novelty |
| Retry/idempotency | At-most-once actions; billed-attempt audit | DeepTutor runtime; current grading | SQLite unique constraints and transactions | Command IDs, expected versions, fencing | BUILD | No new license | None | Medium/high | Low | Essential core guarantee |
| Provider abstraction | Fake/Hy3 parity and typed operations | OpenTutor/DeepTutor multi-provider routing | Existing LlmProvider | Narrow operation contracts, usage metadata | BUILD | Existing project | None | Medium | Medium | None; avoid generic expansion |
| Structured output validation | Runtime contracts and bounded repair | Broad prior art | [Zod](https://github.com/colinhacks/zod) | Existing schemas/validation | USE LIBRARY | MIT | Existing license inventory | Low; semantic checks still local | Low | Trust enabler, not novel |
| Semantic caching | Reuse setup/artifacts safely | General LLM platforms | SQLite; [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111) concepts | Content fingerprints/invalidation concepts | BUILD | Public domain / standard | None | High: false hits | Medium | Cost enabler |
| Token/cost telemetry | Session/course/operation cost answers | OpenTutor call ledger; DeepTutor turn estimates | [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai) | Field naming and trace correlation | BUILD | Apache-2.0 | Pattern only; license if SDK later used | Medium: provider usage gaps | Medium: evolving convention | Necessary economics, not novel |
| Spaced repetition | Durable review scheduling | OpenTutor, Engram | Current scheduler; [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) if migration justified | Mature FSRS implementation later | DEFER | MIT | Preserve license if adopted | High: due-date/history migration | Medium | Explicitly not differentiating |
| Question/assessment rendering | Accessible typed formal activities | All four projects | Existing QuizView/ResultsView | Existing UI and attempt isolation | BUILD | Existing project | None | Medium | Low/medium | Formal boundary is core; widgets are not |
| Markdown/LaTeX rendering | Safe explanations, tables, formulas, code | DeepTutor, Studyield | [react-markdown](https://github.com/remarkjs/react-markdown), remark-gfm, remark-math, rehype-katex, [KaTeX](https://github.com/KaTeX/KaTeX), rehype-sanitize | Maintained parse/render/sanitize stack | USE LIBRARY | MIT | Preserve licenses and KaTeX font notices | Medium: sanitization/bundle | Low/medium | None |
| Curriculum UX | Hierarchy, route mapping, risk/progress | OpenTutor blocks, DeepTutor books, Engram maps | Existing React plus adapted patterns | Outline review, typed blocks, progress disclosure | BUILD | Pattern only | None | Medium | Medium | Product semantics remain core |
| Session UX | Free chat plus current route/actions | OpenTutor, DeepTutor | Existing React and streaming stack | Transcript/recents/interruption patterns | BUILD | Pattern only | None | Medium/high | Medium | Integrated route/evidence semantics matter |
| Agent workflow/runtime | Durable bounded execution | DeepTutor; Temporal patterns | SQLite state machine; [XState](https://github.com/statelyai/xstate) as reference; [Temporal](https://github.com/temporalio/temporal) only as reference | Explicit transitions, durable history, signals; frameworks remain unadopted | BUILD | Pattern refs MIT | No source reuse | Medium | Low/medium locally; framework would be high | Core execution semantics |
| Audit/event logs | Causation, version, validation history | Engram receipts, DeepTutor trace | [CloudEvents](https://github.com/cloudevents/spec), W3C Trace Context | Envelope/correlation vocabulary | BUILD | Apache-2.0 / standard | Pattern only | Medium: privacy/payload growth | Low | Core audit integration |
| Evaluation infrastructure | Fixtures, replay, ablation, human review | Engram grader audit | Existing Vitest/eval scripts; [Promptfoo](https://github.com/promptfoo/promptfoo) later | Existing harness; generic runner only if scale demands | BUILD | MIT | Existing notices; add if later adopted | Medium: LLM judge bias | Medium | Proves value; not product feature |
| Full observability platform | Optional future trace export | DeepTutor operational surfaces | OTel export; Langfuse considered | Export seam only | DEFER | OTel Apache-2.0; Langfuse core MIT with separately licensed areas | Audit on adoption | High operational footprint | High | None |

### Reuse policy

For a future dependency:

1. obtain authorization in the separate implementation task under repository dependency rules;
2. pin a version and record the decision;
3. run representative correctness, security, cancellation, resource, and platform fixtures;
4. inspect transitive dependencies and model/data licenses;
5. preserve required LICENSE/NOTICE/font/model attribution;
6. keep the Study Clinic adapter and normalized schema authoritative;
7. record why a library remains preferable to local code.

MIT/BSD notices must accompany applicable distributions. Apache-2.0 dependencies require preservation of the license and any upstream NOTICE. Model files need a separate license audit. AGPL Studyield source must not be copied. There is currently no exact module/file/revision proposed for source reuse because the decision is none.

This design does not authorize adding officeParser, Sharp, Tesseract.js, react-markdown, remark, rehype, or KaTeX. Each remains a future gated dependency decision.

## 26. Cost architecture

API cost is a product constraint and a domain record.

### Operation classes

| Class | Examples | Cache/reuse policy |
| --- | --- | --- |
| One-time course setup | semantic concept extraction, Curriculum proposal, initial Exam Blueprint, initial risk scan | Persist by exact material/contract/schema/provider fingerprints; regenerate only when stale or requested |
| Cached/reusable artifact | lesson card, source explanation, exam observation, validated risk candidates | Reuse across sessions while dependencies match |
| Per LearningUnit | unit teaching setup, objective-specific examples, checkpoint proposal | Cache stable artifacts; do not cache learner-specific state effects |
| Per Tutor turn | explanation or question response, bounded action proposal | Use compact context; no automatic multi-agent fan-out |
| Per summary compaction | explicit watermark compaction or stale-summary regeneration only | Cache by exact transcript/version fingerprint; ordinary turns use an in-response summary delta |
| Per assessment | question proposal and semantic rubric grading | Reuse accepted question artifact where valid; every attempt/result remains distinct |
| Per synthesis | section/chapter/course integration proposal and grading | Run only at explicit gates |
| Per adversarial scan | bounded candidate discovery | Run by policy/on request; persist candidates |
| Per adversarial check | selected formal challenge generation/grading | Pay only for chosen risks, not the entire candidate set |
| Per meaningful replan | successor-plan proposal | Run only after a qualified trigger and deterministic feasibility preflight |

Local logic owns state transitions, deadline math, agenda edits, risk aggregation, completion reconciliation, launchability, history, plan execution, and most routing. These do not consume model calls.

### Telemetry model

Separate a logical call from physical attempts:

- logicalCallId, operation type, Course/Session/Unit/assessment attribution;
- cache lookup and hit/miss reason;
- provider/model and pricing-table version;
- each physical attempt: original, repair, retry, fallback;
- input, output, reasoning, and provider-cache token counts when supplied;
- latency, time to first token, completion state, timeout/cancel/error;
- estimated cost, currency, source of price, and “unknown” where not computable;
- prompt/schema/policy/material/plan fingerprints without storing private content by default.

One logical call may have a failed original and one schema-repair attempt; billing and reliability reports count both. A retry never masquerades as a single physical request.

### Budget behavior

Monetary cost caps are an optional learner/operator policy. They are distinct from the learner’s study-time budget and from mandatory technical bounds such as context size, output size, attempt count, timeout, and concurrency. Usage, cache, latency, provider/model, logical-call, and physical-attempt telemetry is recorded regardless of whether a monetary cap exists.

If no monetary cap is configured, Study Clinic invents no arbitrary product-level spending ceiling: model-dependent capabilities run under their normal product/runtime limits. If a cap is configured per operation, Session, day, or Course, local policy estimates worst-case spend and may permit, ask for confirmation, use an already-authorized cache or semantically equivalent lower-cost configured option, or temporarily decline.

Cost optimization must never silently weaken educational correctness, grounding, truth/admissibility requirements, formal-evidence guarantees, or the coherent execution loop. A cheaper option/fallback is allowed only when its capability contract and quality/authority requirements remain satisfied. Otherwise the product asks for confirmation or refuses visibly rather than silently degrading the result.

When a configured cap is reached:

- local/cached lessons, evidence, plans, agenda edits, reviews, and history remain usable;
- no valid state is downgraded;
- risk/adversarial scans may be marked unavailable;
- the learner sees which model-dependent actions are paused.

The Progress/Session cost view answers:

> This session cost approximately X: N logical operations, M physical attempts, token totals, cache savings, latency, and which completed learning actions they supported.

It must not claim “useful” from cost alone; usefulness is linked to completed activities, valid evidence, or learner feedback.

## 27. Data model

Future implementation appends explicit migrations after the current twelve. Exact SQL is implementation work; these are domain boundaries.

### Existing aggregates to retain

- workspaces as Courses;
- materials, SourceBlocks, source Concepts, canonical overlays;
- graph versions, edges, and evidence;
- remediation plans, explicitly still concept repair plans;
- quizzes, questions, submissions, grading results, mistakes, mastery;
- misconceptions, review items/events, completed-attempt snapshots;
- current Tutor runs/events and concept lessons.

### New/extended aggregates

| Aggregate | Core records |
| --- | --- |
| Material lineage | material_revisions, material_role_versions, normalized_structural_units, source_block revisions, lineage/retirement mappings, active pointer, parser attempts |
| Learning Contract | immutable contract_versions with stable subject/logical-Material/role-assignment scope references and no MaterialRevision IDs; acceptance/withdrawal events; workspace active pointer |
| Course execution | active/paused execution-status projection and pause/resume events; accepted Contract/Plan pointers remain unchanged by pause alone |
| Source authority | versioned truth_authority_records with logical source, exact accepted revision/claim provenance, admitted premise scope, policy/basis, validation/conflict state, actor, and audit history; separate from Contract scope acceptance |
| Curriculum | immutable curriculum_versions, exact execution-source manifests, nodes/unit mappings/synthesis groups, validation results, active pointer |
| StudyPlan | immutable study_plan_versions/items, execution-source-manifest fingerprint, proposal trigger, acceptance, machine diff, PaceBaseline; separate plan_progress_events/current projection |
| SessionAgenda | agendas/items, item origin/launch spec/time, execution pause/resume and agenda events, active pointer |
| StudySession | sessions, exchanges, turns, turn events, summaries/watermarks, route-stack and execution pause/resume events |
| Formal progression | objective evidence and premise-authority/admissibility links, progression_reconciliations, progression_decisions, completion-policy versions, GoalOutcomes |
| Coverage/Risk | stable risk identities, separate scope/truth authority fields, revision-bound provenance, resolution/reconciliation history events |
| Exam Blueprint | source artifact versions, question observations, typed Blueprint versions and mappings |
| Adversarial readiness | scans, candidate risks, selections/checks, evidence links |
| Agent runtime | commands/operations, idempotency keys, expected-version fingerprints, lease owner/expiry/fencing token, audit events, correlations |
| Cost/cache | logical model calls, physical attempts, usage/cost records, semantic cache entries |

### Invariants

- Immutable proposals/history plus explicit active pointers; no in-place rewrite of accepted versions.
- Every consequential command has a unique idempotency key and expected versions.
- Current projections are rebuildable from accepted snapshots and append-only decisions/events.
- Each accepted state mutation is atomic within its aggregate boundary. Existing grading commits its valid attempt and learner-state effects first; progression reconciliation commits separately and retryably so a progression fault cannot invalidate grading.
- Contract/Plan successor activation is one explicit cross-aggregate transaction because mismatched active pointers are never valid.
- Activating or reprocessing a MaterialRevision cannot mutate stable Contract scope; it stales/reconciles downstream execution-source manifests.
- Learner acceptance of a topic, Material, role, Curriculum, or Plan grants scope authority only and cannot create Course Truth or a blocking assessment premise.
- Pausing execution leaves the accepted StudyPlan snapshot, status, and pointer unchanged; resume revalidates downstream execution context.
- Cost telemetry is unconditional; monetary cap enforcement occurs only under an explicit learner/operator policy and never relaxes grounding, truth authority, or formal evidence.
- Historical evidence references immutable snapshots/revisions, not only live cascading entities.
- Unknown legacy metadata stays null/unknown rather than fabricated.
- Foreign-key rebuild migrations run integrity checks and compatibility fixtures.
- JSON payloads are schema-validated both on write and hydration; indexed identity/version/status fields remain normalized columns.

### Naming boundaries

- RemediationPlan remains current concept repair; StudyPlan is the course route.
- QuestionBlueprint remains current assessment-generation contract; ExamQuestionBlueprint is observed question-set analysis.
- TutorRun remains the bounded current planner until migrated; StudySession is conversational.
- DailyQueue remains a derived current view; SessionAgenda is persisted execution state.
- Concept learner overlay remains descriptive; LearningUnit completion is a separate policy decision.

## 28. Service/provider architecture

### Layering

~~~text
React views
  ↓ typed API commands / streams
Fastify routes (parse, auth-free ownership checks, cancellation only)
  ↓
Domain services (decisions, transitions, validation, transactions)
  ├─ repositories / SQLite
  ├─ grounding / retrieval / launchability / grading
  └─ narrow LlmProvider semantic operations
       ├─ FakeProvider
       └─ Hy3Provider
~~~

Routes and React components do not own domain transitions.

### Services

Add focused services for:

- Learning Contract feasibility/versioning;
- Curriculum proposal/validation/activation;
- StudyPlan proposal/diff/acceptance/progress;
- SessionAgenda composition and mixed-initiative commands;
- StudySession turn/context/summary/resume;
- progression/completion/synthesis;
- Coverage/Risk reconciliation;
- Exam Blueprint observation;
- blind-spot scan/readiness selection;
- source revision/lineage;
- independent source/premise truth-authority validation;
- durable operation/audit/idempotency;
- semantic cache and cost telemetry.

Reuse/extend grounding, lexical retrieval, activity launch, assessment, grading, misconceptions, review, attempts, lessons, Tutor tools, repository transactions, and requestSignal.

### Provider operations

Extend the existing narrow contract with operation-specific methods such as:

- proposeCurriculum;
- proposeStudyPlan / proposeStudyPlanRevision;
- respondToTutorTurn;
- summarizeStudySession, used only for explicit compaction/stale recovery because ordinary turns carry a summary delta;
- observeExamQuestions;
- proposeCoverageRisks;
- proposeSynthesisAssessment;
- proposeAdversarialRisks;
- proposeAdversarialCheck.

Every important output has a shared Zod schema, controlled enums, hard bounds, and downstream local ID/evidence validation. One bounded JSON/schema repair remains the default. Grounding, scope, permissions, configured cost caps, or domain failures do not become infinite repair loops.

Important provider output is never extracted with fragile regular expressions. Balanced transport parsing may locate a JSON payload, but the payload is unusable until schema and domain validation succeed.

FakeProvider implements compatible deterministic behavior for every new operation. Optional multi-provider support is deferred; the contract may carry provider-neutral usage fields without importing a generic SDK.

### Runtime

A lightweight SQLite command/turn state machine is sufficient:

- write command and expected fingerprint;
- claim it transactionally with a unique operation ID, lease owner, expiry, and monotonically increasing fencing token;
- stream safe events with sequence and correlation IDs;
- finalize validated artifacts and state atomically only if the worker still owns the current fencing token;
- mark interruption/orphan honestly;
- retry through a new physical attempt under the same logical call/idempotency contract.

Lease recovery increments the fencing token before a replacement worker runs. A late worker with an older token can append no authoritative event or result. A unique terminal-result constraint permits one accepted outcome. If a process dies after sending a provider request but before recording its response, that physical attempt is outcome_unknown: it may have incurred cost and is never labeled “not called.” A retry is a new physical attempt and remains visible.

No Temporal, LangGraph, LangChain, Redis queue, event bus, or second persistence system is needed.

## 29. API changes

Preserve existing routes and add focused modules under the existing /api/workspaces/:workspaceId scope. Do not label this “API v2.”

Illustrative resources:

- /contract and /contract/versions; propose, accept, supersede;
- /curriculum and /curriculum/versions; propose, validate, activate;
- /study-plans and /study-plans/:id/accept;
- /study-plans/:id/progress and /replans;
- /session-agendas and agenda item commands;
- /study-sessions, /turns, /resume, /stop;
- /progression-decisions and /completion;
- /coverage-risks and risk status commands;
- /exam-blueprints and source-question observations;
- /adversarial-scans and /readiness-checks;
- /operations/:id and /usage;
- /documents/:id/revisions and lineage.

### Command contract

Consequential requests carry:

- commandId/idempotency key;
- expected stable Contract-scope version separately from Curriculum/Plan/Agenda/Session versions and the exact execution-source-manifest fingerprint;
- actor intent and typed command;
- client correlation ID where applicable.

Version conflict returns a structured conflict with current pointers and no mutation. Retrying the same command returns the recorded result.

### Streaming

Use fetch-response NDJSON for POST Tutor turns unless a measured need favors SSE. Events include stable event/turn/correlation IDs and ordered sequence numbers. Reconnection reads persisted events after a sequence; it does not rely on an in-memory stream. Content chunks are provisional; only a terminal validated artifact is authoritative.

Runtime-validate client responses at the boundary where stale or malformed data could cause unsafe UI state, instead of relying only on TypeScript casts.

## 30. Frontend information architecture

GraphWorkspace no longer hosts the primary journey.

### Course Home

Shows:

- Learning Contract and edit/successor status;
- deadline, available time, feasibility, and estimated remaining effort;
- overall formal progress;
- unresolved/high-priority risks and deferred gaps;
- today’s SessionAgenda;
- the next action and why it is next;
- resume/Continue Study as the primary action.

Course Home also opens the full draft/accepted StudyPlan editor and history: item order, time/depth, completion criteria, known-scope accounting, explicit deferrals, version diff, and accept/reject controls. A summary card is not a substitute for Plan inspectability.

### Course Materials

Course Materials is a Course Home subview, not a new primary product center. It visibly separates stable logical Material membership/learner-confirmed role from active/prior parser revisions and independent truth-authority status. It handles import, parser attempts/warnings, uncertain or skipped regions, provenance, reprocess/activate/retire actions, and downstream source-manifest impact. Reprocessing never appears as a learner-intention change; destructive purge is visually and operationally distinct from retirement.

### Study Session

Primary workspace:

- persistent Tutor transcript and free-text composer;
- current LearningUnit/objectives and estimated time;
- completion criteria and formal-evidence status;
- compact SessionAgenda and route/return cue;
- explicit detour, insert, deep-dive, direct-checkpoint, defer, and challenge controls;
- source truth/evidence on demand;
- informal checks visually distinct from formal checkpoints;
- interruption/resume and current operation/cost state.

### Curriculum

Shows:

- Course → Chapter → Section → LearningUnit hierarchy;
- plan mapping and progress;
- prerequisite/synthesis relationships;
- source/exam provenance;
- completion, deferred, repair, and risk state;
- accepted-version history.

Curriculum links to a detailed Exam/Question Blueprint inspector showing supplied artifacts, observed counts/representations, mappings, ambiguity, and the no-prediction limitation.

### Progress

Contains:

- formal evidence and progression decisions;
- assessments, mistakes, mastery, misconceptions, and reviews;
- historical Contracts/Plans and replan diffs;
- synthesis and adversarial-readiness evidence;
- session/operation cost and audit views.

Progress contains the full Coverage/Risk Ledger inspector: provenance chain, separate scope and truth/premise authority, admissibility, status history, stale reason, acknowledge/defer/reject/resolve actions, and linked Plan/evidence. Course Home shows only its bounded summary.

### Explore

Contains:

- graph and concepts;
- source relationships/evidence;
- canonical alignment and optional exploratory navigation.

The graph can start a detour or propose an agenda item, but it does not own the Tutor, Plan, or progression.

### UX authority

Use consistent badges:

- Course truth / locally verified anchor;
- in learner scope / truth unverified;
- AI teaching;
- AI risk candidate;
- informal;
- formal evidence;
- deferred/unresolved;
- stale/unavailable.

The UI never renders “complete” from Tutor prose. Plan diffs show material changes, time impact, risk, and confirmation. All async views preserve loading/error/cancel/stale handling when Course, document, plan, session, or workspace changes.

## 31. Source-revision and history migration

Current document reprocessing deletes extraction-dependent state. That is incompatible with longitudinal Agent history.

### Target model

1. Material is the stable learner-meaningful document identity; Contract scope and role assignments reference this identity, not an extraction revision.
2. MaterialRevision is immutable original bytes/text plus parser/version/result metadata.
3. Normalized structural units and SourceBlocks belong to a revision.
4. A material-role assignment is versioned independently from MaterialRevision and survives reprocessing of the same logical Material.
5. A candidate revision is parsed, mapped, and validated without affecting the active revision or Contract scope.
6. Activation changes the execution-source pointer only after validation and stales dependent Curriculum/Plan/context/risk/authority manifests; it never creates a successor Contract by itself.
7. Deterministic exact/near-exact lineage proposes old→new block/concept mappings.
8. Hy3 may propose semantic lineage, but local validation and learner-visible uncertainty apply.
9. Old evidence remains attached to the old revision.
10. Truth-authority records remain tied to their exact admitted revision/claims; a successor revision requires explicit reconciliation and cannot inherit blocking authority merely from lineage.
11. First-release safe default: no active mastery, LearningUnit completion, or blocking readiness decision transfers automatically, even for exact lineage. Old evidence remains visible through lineage; affected current units require new formal evidence. A future separately designed and evaluated transfer policy may relax this only with versioned rules and explicit audit.
12. Retiring a document removes it from active execution-source availability rather than cascading away Course history. It does not silently rewrite the stable Contract; the resulting unavailable/out-of-scope condition remains visible until the learner accepts a scope successor. Permanent purge is a separate explicit destructive action.

### Revision effects

- New document: create a logical Material and initial revision outside accepted Contract scope until the learner assigns a role/inclusion; a genuine accepted learner-scope change may create a successor Contract, then Curriculum/risk/Plan effects.
- Reprocess: stage a new revision for the same logical Material, preserve the active old version on failure, leave the Contract untouched, and reconcile exact downstream execution manifests after activation.
- Extraction improvement: retain both results and lineage; do not silently upgrade evidence, truth authority, or Contract intention.
- Role change: create a role-assignment version independent of parsing; reconcile the Contract and require a successor when accepted learner-level scope/intention changes.
- Remove/retire: make active Curriculum/Plan/source-authority mappings stale or unavailable while leaving stable Contract/history inspectable; only learner-confirmed scope change supersedes the Contract.
- Curriculum successor: old unit decisions remain tied to the old version; mapped evidence may be referenced, never rewritten.

Exact quote re-anchoring proves location, not equivalence of the surrounding semantic claim. Exact lineage therefore transfers history/display linkage only under the initial policy, never active completion.

### Migration compatibility

Existing rows become revision 1 with honest parser/source metadata. Existing attempt snapshots, review events, graph versions, and state remain readable. Legacy null/unknown fields remain honest. Migration tests cover populated databases from the current supported historical versions and foreign-key integrity.

## 32. Failure and fallback behavior

| Failure | Required behavior |
| --- | --- |
| Curriculum proposal/validation | Keep active Curriculum; if none, expose deterministic source outline and unavailable analysis |
| StudyPlan generation | Keep accepted plan; learner can use existing agenda/local actions |
| Replan generation | Keep accepted plan; record failed proposal operation only |
| Tutor turn | Preserve transcript through last completed watermark; mark turn failed/interrupted and resume/retry safely |
| Rolling summary | Use recent raw exchanges and last valid compatible summary; regenerate later |
| Agenda item becomes stale | Revalidate, block or replace with a semantically valid visible fallback; never launch an impossible action |
| Formal assessment generation | No evidence and no state change; preserve prior state |
| Truth/premise-authority validation | Keep the topic teachable/advisory where in scope, but create no blocking evidence or progression mutation |
| Grading timeout/failure | No partial persistent learning-state mutation |
| Risk scan | Do not block ordinary learning; mark coverage analysis stale/unavailable |
| Exam Blueprint | Preserve prior version and raw supplied artifacts |
| Adversarial generation/check | Do not downgrade valid evidence; expose unavailable check |
| Configured cost cap | Cached/local study and history continue; pause model-dependent actions visibly without weakening evidence or grounding rules |
| Source parse/revision | Preserve active revision and valid downstream artifacts |
| Learner detour | Preserve origin and return stack; if origin stales, recompose visibly |
| Client disconnect/navigation | Abort where appropriate or detach; fence late results by version |
| Server restart | Mark orphaned physical attempt interrupted; replay persisted events; permit idempotent retry |

All model-generated candidates have generating/ready/failed lifecycles where a prior valid version exists. “No result” is safer than fabricated continuity.

## 33. Testing strategy

Every persistent subsystem requires migration, repository, service, API, and frontend coverage.

### Deterministic domain tests

- Contract validation, feasibility, presets, versions, and acceptance, including rejection of MaterialRevision/SourceBlock/parser-fingerprint coupling;
- stable logical-Material/role scope surviving same-Material reprocessing with no successor Contract, while genuine learner-level inclusion/exclusion/role change follows Contract successor rules;
- atomic successor Contract/Plan activation with the old pair executable on failure/rejection;
- Curriculum hierarchy, known IDs, evidence, cycles, bounds, exact execution-source manifest, candidate activation, and revision-driven staleness;
- StudyPlan feasibility, immutable snapshots, diffs, acceptance, progress projection, and rejection of silently omitted known-scope objectives;
- execution pause/resume leaving the accepted Plan status/snapshot/pointer unchanged, creating no Plan version, and safely revalidating/recomposing on resume;
- PaceBaseline actual-time rollups, unknown/on-track/at-risk thresholds, reason codes, and drift-trigger qualification;
- terminal GoalOutcome rules, including deadline expiry and explicit finished-with-gaps;
- Agenda composition, time bounds, launchability, insert/defer/reorder;
- every mixed-initiative transition and return-stack recovery;
- completion policy variants and non-regression of simpler evidence;
- synthesis failure isolation;
- replan trigger qualification and rejected/accepted behavior;
- all Risk Ledger facets, stable identity, scope/truth authority separation, revision provenance, dedupe, resolution, and stale reconciliation;
- Exam Blueprint counts/wording with no probability claims;
- adversarial candidate/check scope and evidence isolation;
- learner acceptance of an AI-suggested topic into scope leaving its claims tier 3/nonblocking, with no retroactive promotion of old probes;
- separately validated authoritative-source admission, source-conflict blocking, and tier-1/2 premise eligibility;
- material-role isolation, role-change reconciliation, and proof that a learner-confirmed role does not authorize embedded answers/rubrics;
- cost/cache keys, logical/physical attempts, unconditional telemetry, no-cap default behavior, and configured-cap confirmation/safe-substitution/refusal;
- source-revision lineage, truth-authority staleness, downstream manifest reconciliation, and history preservation;
- weak-heading synthetic-window extraction, size-aware budgets, and legitimate zero-concept sections;
- segment-level lesson provenance, invalid required-claim repair/failure, and source-source conflicts;
- targeted Tutor grounding repair and targeted remediation missing-piece repair without contract relaxation;
- reachability of valid unassessed units and one-primary-objective evidence attribution.

### Failure/concurrency tests

- duplicate commands and submissions;
- concurrent accept/replan/agenda commands;
- expected-version conflicts;
- disconnect during headers/body/stream;
- late provider response after Course/Plan/Session switch;
- stop versus navigation-detach;
- process restart/orphan recovery;
- restart while execution is paused preserving the accepted route and resumable origin;
- lease takeover/fencing that rejects late old-worker finalization and records outcome_unknown attempts;
- failure between each transaction write;
- candidate generation failure preserving active version;
- cache false-hit prevention;
- parser timeout/decompression/partial results.
- grading success followed by retryable progression reconciliation_pending/applied behavior.

### Provider tests

- shared Fake/Hy3 contracts;
- structured parse and one bounded repair;
- unknown IDs/relations/evidence;
- prompt-injection source wrapping;
- invalid risk authority, in-scope AI claims mislabeled as Course Truth, and out-of-scope adversarial content;
- usage absent/partial/present;
- cancellation and timeout;
- no real API in ordinary tests.

### Frontend tests

- Course Home next-action rationale;
- visual authority/formal/informal distinctions;
- visual distinction between learner scope and independently verified truth authority;
- free-text detour and route return;
- nested detour stack cleanup across defer, stop, stale origin, and Plan supersession;
- direct checkpoint/defer/promote/replan diff flows;
- switching/deleting Course/document while operations run;
- transcript stream replay and malformed lines;
- risk/completion states never inferred from prose;
- accessible keyboard/screen-reader behavior for curriculum, agenda, math, and assessments.
- an invariant sweep proving every surfaced startable action launches or visibly revalidates/downgrades under current state.

Cheap fixture-based parser tests must preserve page/slide/sheet identity and honest warnings across supported platforms.

## 34. Evaluation and falsification strategy

Evaluation separates:

1. deterministic safety/invariants;
2. model output quality;
3. learner behavior/usability;
4. learning outcomes;
5. cost and latency.

There are two deliberately different evaluation moments. The required post-Phase-4 product/dogfood gate in §38 tests whether the core execution interaction is usable and removes enough manual orchestration to justify further complexity. It is not the later same-model ablation, human outcome evaluation, or delayed-retention study, and it cannot establish educational effectiveness.

### Measures

- plan drift and omitted accepted items;
- coverage-risk discovery precision/usefulness;
- false completion;
- cross-session recovery;
- next-action clarity;
- manual learner intervention count;
- representation and transfer gaps discovered;
- synthesis performance;
- delayed retention;
- switch-to-general-chat rate and reason;
- Plan acceptance/adherence and replan acceptance;
- time/cost per useful session and per valid evidence event;
- unfair/out-of-scope adversarial question rate.

### Evaluation infrastructure

Extend existing deterministic fake evaluation with:

- versioned Course/Contract/Curriculum/Plan fixtures;
- transcript replay and state-machine invariants;
- fixed model-output fixtures for risk/adversarial failure cases;
- reproducible operation/cost records;
- sanitized evidence exports.

Model-quality evaluation uses fixed prompts/material/model/settings and stores raw outputs privately with sanitized aggregate publication. LLM judges are advisory; important claims use blinded human review. Engram’s adversarial gold-set and adjudication discipline is a useful pattern: measure leniency, consistency, disagreement, and evaluator expiry rather than assuming the grader is an oracle.

Delayed retention requires real follow-up intervals. Architecture and immediate quiz scores cannot prove durable learning.

## 35. Same-model ablation design

Compare:

### Arm A: Plain Hy3 conversational Tutor

- same model and provider settings;
- same material and learner goal;
- ordinary bounded conversation and generated assessments;
- no accepted execution scaffold, risk ledger, route return, or governed replan.

### Arm B: Hy3 + Study Clinic execution scaffold

- same model and source access;
- Contract, Curriculum, accepted Plan, Agenda;
- mixed-initiative detours/return;
- formal evidence/completion;
- risk/adversarial integration and governed replans.

### Controls

- randomize/counterbalance where feasible;
- keep model, temperature/reasoning, material, target, time, and assessment pool equal;
- log every manual orchestration intervention;
- separate scaffold calls from teaching calls;
- blind outcome graders to arm where possible;
- pre-register primary outcomes and stopping rules;
- include delayed follow-up and dropout/abandonment;
- report cost/latency and not just score.

Primary hypothesis: the scaffold reduces plan drift, false completion, cross-session recovery effort, and manual next-action decisions without harming conversational freedom or cost-effectiveness.

Failure to outperform Plain Hy3 means cut or simplify the scaffold, not add more Agent theater.

## 36. Smallest coherent implementation scope

This section defines a **release-level coherent integration target**. It is not implementation authorization, a single-task scope, permission to land all items in one Codex change, or a substitute for the phase gates below. Each phase and implementation slice requires separate future authorization, review, validation, and a focused task.

The post-Phase-4 core is intentionally dogfooded before the release target is complete. Full sophistication for items 11 and 12, and the rest of Phase 5, proceed only after the required product/dogfood gate; its outcome may simplify or narrow them without weakening the approved authority, evidence, or learner-control invariants.

The smallest coherent first Agent release is not every roadmap feature. As a release target, it must still close one truthful execution loop:

1. existing Workspace treated as Course;
2. safe MaterialRevision foundation for newly processed content;
3. one accepted Learning Contract;
4. one accepted hierarchical Curriculum over existing concepts/sources;
5. one versioned accepted StudyPlan;
6. one persisted dynamic SessionAgenda;
7. one conversational StudySession with bounded context and resume;
8. detour/return, agenda insert, direct checkpoint, defer, and promote-to-plan proposal;
9. existing formal assessment/grading/state reused for completion;
10. section synthesis and one targeted repair path;
11. a minimal Coverage/Risk Ledger seeded by source/Curriculum/exam mappings and explicit deferrals;
12. one bounded blind-spot scan and selected adversarial readiness check;
13. meaningful replan proposal/diff/acceptance;
14. logical/physical cost telemetry and idempotent operation audit;
15. Course Home, Study Session, Curriculum, Progress, and Explore shells.

Initial format scope remains current text/Markdown/TXT/text-PDF/DOCX plus a normalized adapter boundary. PPTX/OCR are independent gated increments and must not delay proving the execution loop.

## 37. Explicit non-goals

- a generic document-chat application;
- a general autonomous agent or ChatGPT clone;
- silent autonomous Plan/Contract changes;
- guaranteeing complete course or future exam coverage;
- replacing the existing concept/evidence/grading/state systems;
- making Graph the main shell;
- model-authored persistent state transitions;
- universal hard-coded mastery/completion thresholds;
- behavioral surveillance or inferred emotions as truth;
- authentication, classroom/multi-user administration, social features, or mobile apps;
- LangChain, LangGraph, vector databases, Neo4j, Temporal, microservices, Kubernetes, Redis, or a new backend language;
- arbitrary shell/code execution;
- multi-provider expansion without demonstrated need;
- full multimodal/diagram/handwriting/math-OCR promises;
- an unconfirmed competition-specific design;
- claiming educational effectiveness before evaluation.

## 38. Phased implementation plan

This document authorizes no implementation. A separate future task must approve and execute phases.

### Phase 1 — durable foundations

- material revision lineage;
- stable logical-Material/role scope records separated from revision-bound source/premise truth-authority records;
- command/event/idempotency/version fencing;
- cost/cache schema;
- shared Contract/Curriculum/Plan/Agenda contracts;
- compatibility migrations and tests.

Exit: populated current databases migrate without learning-history loss; failed candidates preserve active data.

### Phase 2 — Course structure and accepted route

- Contract setup/acceptance and feasibility;
- Curriculum proposal/validation/activation;
- StudyPlan proposal/diff/acceptance;
- Course Home/Curriculum;
- deterministic minimal risk ledger.

Exit: learner can inspect and accept a bounded route and every item is launchable.

### Phase 3 — conversational execution and mixed initiative

- persisted StudySession/turns/summary;
- Agenda composition;
- detour/return, insert, deep dive, direct checkpoint, defer;
- Course/Agenda/Session execution pause/resume with unchanged accepted Plan;
- cancellation, stale, restart, and resume.

Exit: a learner can freely interrupt and return without Plan drift.

### Phase 4 — evidence-gated progression and replanning

- objective evidence links/completion policies;
- synthesis and targeted repair;
- meaningful trigger detection;
- successor Plan proposal/diff/acceptance.

Exit: conversation cannot complete units; formal evidence deterministically drives the next action.

### Required Product/Dogfood Gate — after Phase 4, before Phase 5

Phase 5 must not begin merely because Phases 1–4 compile or pass automated tests. First, representative real dogfood must exercise the coherent core loop:

~~~text
Learning Contract
→ Curriculum
→ accepted StudyPlan
→ dynamic SessionAgenda
→ conversational StudySession
→ mixed-initiative detour and return
→ formal evidence
→ deterministic completion or targeted repair
→ meaningful replan proposal, diff, and learner acceptance/rejection
~~~

The gate combines deterministic state/audit inspection, forced restart/stale/rejection/failure scenarios, observed learner sessions with realistic course material, intervention/bypass logs, and concise learner debriefs. The protocol pre-registers its task-success, route-recovery, manual-intervention, bypass, and acceptable-friction criteria before sessions; thresholds are not invented after seeing results.

Gate questions and exit criteria:

1. Can the learner start or resume without manually reconstructing the goal, accepted Plan, prior position, or unresolved work?
2. Is the next action—and why it is next—understandable without asking the Tutor to reconstruct the route?
3. Can the learner detour freely and reliably return, with zero silent Plan mutation or route drift?
4. Do UI state and persisted audit records keep Tutor conversation/informal checks separate from formal evidence and progression, with zero conversation-to-mastery leakage?
5. Does the Plan/Agenda separation help the learner understand long-term route versus current work, rather than feel like duplicate bureaucracy?
6. Can at least one qualified meaningful replan proceed through trigger, proposal, diff, rejection or acceptance, and route recovery with less manual orchestration than rebuilding the plan in ordinary chat?
7. Do provider failure, restart, stale context, rejected proposals, and interrupted sessions recover without losing the accepted route, fabricating completion, or stranding the learner?
8. Does the learner repeatedly bypass the scaffold or switch to general chat? Record the task and reason rather than treating departure as generic dropout.
9. Is interaction friction—setup, confirmation, navigation, and state explanation—acceptable relative to the remembering, next-action, return, and replanning work removed?

Safety/evidence-boundary violations, unrecoverable route drift, or failure to resume are gate blockers regardless of subjective enthusiasm. The gate records one of three outcomes:

- **GO:** hard invariants pass; observed learners can understand, detour, recover, and replan; the scaffold shows credible orchestration reduction with acceptable friction. Phase 5 may be separately authorized.
- **GO WITH SIMPLIFICATION:** the core removes useful orchestration but Plan/Agenda/session interaction or state burden is too heavy. Simplify and re-dogfood the affected core, then authorize only a narrowed Phase 5.
- **STOP/NARROW:** repeated bypass, unacceptable friction, no credible orchestration reduction, unsafe state leakage, or route/recovery failure means broad Phase 5 does not proceed. Preserve the reliable substrate and narrow or remove the scaffold behavior that failed.

This gate establishes product usability and orchestration value only. It does not prove delayed retention, mastery validity, transfer, exam outcomes, or educational effectiveness. A GO result is not itself authorization to implement Phase 5; implementation remains a separate task.

### Phase 5 — risk, exams, and adversarial readiness

This phase is conditional on a recorded gate outcome and separate implementation authorization.

- Exam/Question Blueprint;
- semantic risk scan;
- adversarial candidate selection/check;
- readiness presentation and Contract-sensitive policy.

Exit: risks remain provenance-bearing candidates; harder failure does not erase simpler evidence.

### Phase 6 — intake and evaluation expansion

- gated PPTX, OCR/image pilots;
- Markdown/KaTeX rendering;
- same-model ablation, human review, delayed retention;
- continued cost/usability measurement and formal thesis falsification after the earlier product gate.

Exit: only fixture-verified formats are claimed; product value is measured rather than inferred.

## 39. Concrete current-file change map

This map is for a later implementation task.

### Shared contracts

Add focused modules under packages/shared/src/domain:

- learningContract.ts;
- sourceAuthority.ts;
- curriculum.ts;
- studyPlan.ts;
- sessionAgenda.ts;
- studySession.ts;
- coverageRisk.ts;
- examBlueprint.ts;
- telemetry.ts.

Extend material.ts for revisions/structural units and grading.ts / attempt.ts for formal evidence links. Preserve plan.ts as RemediationPlan and blueprint.ts as current question-generation blueprint. Re-export through packages/shared/src/index.ts. Add provider payload schemas in packages/shared/src/provider/payloads.ts.

### Database/repositories

Append migrations after migration 12 in apps/server/src/db/migrate.ts. Add repositories for each aggregate and register them in apps/server/src/repositories/index.ts. Extend migration compatibility and transaction/cascade tests.

### Services

Reuse or extend:

- apps/server/src/grounding/verify.ts;
- apps/server/src/retrieval/lexical.ts;
- apps/server/src/services/activityLaunch.ts;
- assessment.ts, grading.ts, misconceptions.ts, review.ts, attempts.ts, lessons.ts;
- apps/server/src/tutor/tools.ts;
- apps/server/src/util/requestSignal.ts.

Add focused services for Contract, source/premise truth authority, Curriculum, StudyPlan, Agenda, StudySession/context, progression, risk, exam observation, readiness, replan, revision, operations, cache, and telemetry. Register them in services/index.ts. Do not place orchestration in routes/workspaces.ts.

### Provider

Extend:

- apps/server/src/llm/provider.ts;
- hy3Provider.ts;
- fakeProvider.ts;
- prompts.ts.

Preserve narrow typed methods, one bounded repair, grounding validation, timeout/cancellation, and Fake/Hy3 parity. Add usage and logical/physical attempt metadata.

### API

Register focused route modules from apps/server/src/app.ts rather than expanding one route file indefinitely. Extend typed client code in apps/web/src/api.ts and validate safety-relevant responses at runtime.

### Frontend

Refactor apps/web/src/App.tsx around Course Home, Study Session, Curriculum, Progress, and Explore. Narrow GraphWorkspaceView.tsx to Explore responsibilities. Reuse:

- ConceptGraph.tsx and graph components;
- SourceEvidencePanel.tsx;
- LessonCard.tsx;
- QuizView.tsx;
- ResultsView.tsx;
- QuizHistoryView.tsx;
- MistakesView.tsx and MasteryView.tsx;
- DailyQueue.tsx presentation patterns;
- useAsyncAction.ts.

Add transcript, Agenda, Contract/Plan acceptance/diff, Curriculum, risk, synthesis, readiness, and cost views with the same epoch/cancellation discipline.

### Tests/evaluation

Extend shared schema/back-compat tests, migrate.test.ts, migrateCompat.test.ts, repository/service/route tests, socket cancellation tests, frontend stale-operation tests, and eval/run-fake.mjs. Add the pre-Phase-5 dogfood protocol/instrumentation separately from the later same-model ablation harness; never use real Hy3 in ordinary tests.

## 40. Unresolved product hypotheses

1. Will learners accept an explicit Contract/Plan step, or should a fast-start default allow provisional study before acceptance?
2. Which Contract fields are truly necessary before first study, and which can be inferred as visible drafts?
3. What frequency/size of Plan changes feels “meaningful” rather than bureaucratic?
4. Should route return after a detour be automatic, prompted, or learner-configurable?
5. How much Agenda flexibility preserves freedom without obscuring the accepted route?
6. Which formal evidence policies are defensible for pass, high-score, and deep-study outcomes?
7. How should prior evidence transfer across source/Curriculum revisions without either losing history or overstating equivalence?
8. Which risk categories remain useful after real dogfood, and which become noisy?
9. Can adversarial candidates stay fair and in scope at an acceptable false-positive rate?
10. How often should readiness scans run under realistic cost/time budgets?
11. Do past-exam observations improve prioritization without anchoring the learner too narrowly?
12. Does Plan acceptance improve adherence, or merely add ceremony?
13. Can a rolling summary preserve the learner’s unresolved reasoning without growing indefinitely?
14. Which Tutor turns deserve caching without making teaching feel stale?
15. What is the minimal cost telemetry learners actually understand?
16. Is the complete integrated thesis absent in the wider market, or only in the four projects reviewed?
17. Does the execution scaffold beat Plain Hy3 on delayed retention, or only on organization?

These are research questions, not postponed implementation details disguised as facts.

## 41. Supersession review of historical designs

This review was completed before the historical current-tree reports were retired. Git history and the immutable tags preserve their full text.

### Decision ledger by historical document

| Historical input | Important useful decisions | Disposition in this design |
| --- | --- | --- |
| STUDY_CLINIC_V2_AUDIT.md | Evolve the existing product; preserve grounding, runtime schemas, local authority, deterministic scoring/state, Fake parity, migrations, tests; diagnose graph/tool fragmentation and thin extraction | INHERITED. Graph becomes Explore; current reliable substrate remains. Historical current-state metrics are not future authority. |
| STUDY_CLINIC_FABLE_BLIND_AUDIT.md | Activity recommendations must actually launch; document extraction was too thin; section-aware additive analysis and honest mapping; lesson provenance needs source/AI separation | INHERITED and already implemented. Extended to Agenda action launchability and three authority classes. |
| STUDY_CLINIC_FABLE_SYNTHESIS.md | Minimal bounded pre-dogfood repair; derived structural mapping is not semantic completeness; one concept lesson; deterministic fallback and Fake/eval parity | INHERITED for guarantees. SUPERSEDED as next-product scope because real dogfood exposed orchestration, not just teaching-artifact, limits. |
| STUDY_CLINIC_PRE_DOGFOOD_IMPLEMENTATION_PLAN.md | Targeted missing-piece regeneration without relaxing contracts; once-only/atomic grading; stale/cancel safety; additive concept IDs; launch-time revalidation; migration and evaluation discipline | INHERITED in full as compatibility requirements. It remains implemented history, not the next route. |
| STUDY_CLINIC_TUTOR_PRODUCT_REDESIGN.md | Workspace-as-Course; LearningGoal/Curriculum/accepted Plan/Agenda/Session separation; Course Home; bounded conversational context; formal evidence completion; synthesis; replan diff/acceptance; cost model; source revision need; same-model ablation | MOSTLY INHERITED. LearningGoal becomes a learner-confirmed Learning Contract with orthogonal fields. Mixed initiative is substantially expanded. AI Risk Candidate becomes a third authority class. Coverage weights/completeness proxies are replaced by the Risk Ledger. Exam Blueprint and two-stage adversarial readiness are added. Source lineage becomes a release foundation, not a later cleanup. |

### Guarantee-by-guarantee check

| Guarantee/decision | Final disposition |
| --- | --- |
| Exact grounding and provenance | Inherited; exact quote location still does not prove semantic entailment |
| Model output runtime schemas | Inherited for every important operation |
| Known IDs, controlled relations, evidence, dedupe, cycles, budgets | Inherited and extended to Curriculum, Plan, risk, exams, and readiness |
| Activity launchability | Inherited for every Agenda/Plan action with server-owned launch requests |
| Objective grading and local score arithmetic | Inherited |
| Atomic once-only learner-state mutation | Inherited and extended to progression/commands |
| Conversation/lessons/plans isolated from mastery | Inherited and made a visible three-channel boundary |
| Additive extraction and stable IDs | Inherited; source revision adds immutable lineage/history |
| Lesson provenance and course-vs-AI conflict disclosure | Inherited; adds AI Risk Candidate class |
| Deterministic structural mapping | Inherited as observed mapping only |
| Assessment answer/rubric isolation | Inherited |
| Existing migration compatibility and honest nulls | Inherited |
| Cancellation, take-latest, entity/version stale protection | Inherited and extended to every new async workflow |
| Failed generation preserves last valid version | Inherited |
| Cost awareness and cached semantic artifacts | Inherited and made a persisted logical/physical ledger |
| Bounded context instead of whole course/transcript | Inherited with watermarked summaries/fingerprints |
| User-confirmed meaningful replans | Inherited and explicitly separated from Agenda edits |
| Synthesis preserving lower-level evidence | Inherited |
| Weak/missing-heading extraction | Inherited: deterministic synthetic windows remain the fallback when document headings are insufficient |
| Size-aware extraction and zero-concept honesty | Inherited: long/short sections have bounded budgets and a valid section may yield zero accepted concepts |
| Targeted Tutor grounding repair | Inherited: repair only the invalid grounded portion within one bounded attempt; do not relax evidence rules |
| Targeted remediation missing-piece repair | Inherited: regenerate only required missing pieces once; never weaken the question contract |
| Reachability of unassessed concepts | Inherited: Agenda/next-action composition must advance into valid unassessed units rather than loop only on existing mistakes |
| One-primary-objective evidence attribution | Inherited/strengthened: contextual concepts receive no completion credit without explicit separately scored attribution |
| Source-source conflict behavior | Inherited/strengthened: preserve both verified claims and require an explicit authority rule before assessment |
| PaceBaseline and terminal GoalOutcome | Inherited and made explicit with deterministic pace claims and achieved/finished-with-gaps/expired/abandoned/superseded outcomes |
| Atomic successor handoff | Inherited/strengthened: active Contract and successor Plan pointers swap together; the old pair remains executable until then |
| StudySession versus Tutor thread | Inherited: StudySession owns agenda, route stack, transcript, formal-activity boundaries, and many Tutor turns; a Tutor turn/thread alone is not the session |

### Explicit supersessions and rejections

- REJECT source-only RAG as the teaching boundary; AI teaching beyond literal wording remains labeled.
- REJECT one flat concept graph as the learner journey; Curriculum/Plan/Agenda are distinct.
- REJECT a prompt-only goal; the Learning Contract is persisted, versioned, and confirmed.
- REJECT one overloaded learning-mode enum; presets populate orthogonal visible fields.
- SUPERSEDE restrictive “out-of-plan work is exceptional” semantics with explicit detour, insert, deep dive, direct checkpoint, defer, promote, and return.
- REJECT silent Plan rewriting or model acceptance of its own replan.
- REJECT conversation, confidence, content viewing, or Tutor approval as formal mastery.
- REJECT a duplicate learning-state system; completion references existing formal evidence/state.
- REJECT universal completion thresholds; policy is Contract-sensitive and versioned.
- REJECT structural/weighted coverage as proof of semantic completeness.
- REJECT automatic conversion of standard-course supplements into course truth.
- REJECT “blind examiner” as a novelty claim; Engram is direct prior art.
- SUPERSEDE a single examiner step with candidate risk scan followed by selected formal readiness check.
- REJECT harder-challenge failure erasing valid simpler evidence.
- REJECT relaxing question contracts when generation misses required pieces; retain one targeted bounded regeneration.
- REJECT destructive reprocessing as the future revision model; preserve immutable history/lineage.
- REJECT wholesale source/framework reuse from the reviewed projects; adapt patterns and use maintained libraries.
- REJECT a new provider framework, vector store, agent framework, workflow service, or infrastructure stack without demonstrated need.

Every important still-useful decision from the five historical documents is therefore inherited, explicitly superseded, or intentionally rejected above.

## A. Why would a serious learner open Study Clinic instead of a general conversational AI?

Because Study Clinic should remember and execute the learning journey that a general chat leaves the learner to manage.

It preserves the accepted outcome and route across sessions, chooses and explains a feasible next action, integrates reviews and repairs, lets the learner detour freely and returns them to the route, distinguishes friendly conversation from verified evidence, retains mistakes and progression transactionally, exposes unresolved course/exam/representation risks, challenges apparent mastery fairly, proposes auditable replans rather than drifting, and shows what the session cost.

The model may be the same. The value is durable, inspectable execution around it.

## B. What can Study Clinic still NOT guarantee?

Study Clinic cannot guarantee semantic completeness or learning success.

It cannot eliminate semantic unknown-unknowns; repair incomplete or incorrect source material automatically; guarantee perfect model recall or reasoning; ensure every representation or notation variant is discovered; predict or guarantee future exam coverage from supplied past questions; or measure learning perfectly from finite assessments.

It can also miss relationships, accept a semantically weak but exactly located quotation, generate an unfair risk candidate, choose a suboptimal route, or inconvenience a learner with an unnecessary gate. Its mastery, readiness, and risk states remain evidence-based estimates under explicit policies—not ground truth.

The honest promise is narrower: preserve the learner’s intention and route, execute the next steps reliably, verify consequential progress locally, expose known risks and uncertainty, and actively look for false confidence without pretending that all unknowns have been found.
