# Hy3 Study Clinic — Tutor Product Redesign

Status: product and architecture proposal only

Date: 2026-08-09

Implementation status: not implemented

This document replaces the product assumptions behind the deferred pre-dogfood phase. It does not authorize starting that phase as written. It proposes the smallest extension of the validated implementation that can turn Hy3 Study Clinic from a collection of reliable study tools into a coherent learning product.

The current implementation remains the source of truth. This proposal preserves its grounding, grading, persistence, cancellation, stale-response, and learner-state guarantees. It does not propose a clean-slate rewrite or a second concept, graph, or mastery system.

## Evidence reviewed

The design is based on:

- the repository instructions in AGENTS.md and CLAUDE.md;
- the pre-dogfood implementation plan and Fable synthesis;
- the current README, architecture, verification, and dogfood guides;
- the implemented shared schemas, migrations, repositories, services, provider contracts, routes, frontend state, and views;
- the current fake-provider evaluation harness; and
- the supplied real learner feedback.

Baseline before this document was written:

- commit: e9069372eb8eec9d4247417bb8cd4bb46f51b95b;
- npm run build: passed, with the existing Vite large-chunk warning;
- npm run lint: passed;
- npm test: passed, 66 files and 839 tests;
- npm run eval:fake: passed, 44 of 44 checks.

The baseline proves engineering reliability. It does not prove that the product is an effective tutor.

## 1. Executive verdict

### Why the current product feels mechanical

Hy3 Study Clinic currently exposes its internal data model before it establishes the learner's intent. The user imports a document, sees extracted concepts and a relationship graph, chooses a node, reads a lesson card, and may launch a remediation-oriented Tutor flow. Each component can be correct while the overall experience still asks the learner to be their own curriculum designer.

The product answers several local questions well:

- What concepts were found?
- How are two concepts related?
- What does this concept mean?
- Which source block supports this claim?
- What did I answer incorrectly?
- What should I review?

It does not answer the questions that govern serious study:

- What am I trying to achieve?
- What is the coherent shape of this course?
- What should I study now, and why?
- How much time will the whole plan and today's session take?
- What evidence is enough to move on?
- When should several ideas be combined and tested together?
- How does the plan change after I struggle or improve?

The knowledge graph is a relationship model, not a curriculum. DailyQueue is a deterministic prioritizer, not an accepted study plan. A lesson card is reusable teaching content, not a dialogue. The current Tutor is a bounded planner that selects activities; it is not a learner-facing conversation. The concept-local “学习计划” is a remediation plan and therefore mislabels a repair tool as the learner's course plan.

The product is consequently reliable but learner-steered. The learner feels like a “headless fly” because the application provides many valid destinations without owning the journey between them.

### Does Hy3 Study Clinic still have a defensible reason to exist?

Yes, but only conditionally.

It cannot be defended as “ChatGPT with a graph, citations, cards, and quizzes.” A strong general conversational tutor already accepts uploaded materials, asks about goals and deadlines, explains interactively, checks understanding, and adapts its language. OpenAI's current Study Mode explicitly describes Socratic guidance, layered explanations, knowledge checks, personalization, and use of uploaded course materials. See [OpenAI Help Center: Using Study Mode in ChatGPT](https://help.openai.com/en/articles/11780217-study-mode).

The credible product is:

> A conversational tutor backed by an accepted, executable curriculum; verified course-specific truth; formal and auditable learning evidence; and persistent plans, mistakes, mastery, misconceptions, and review history that survive across sessions.

That combination can be stronger than a general chat for a learner who is studying a bounded course over multiple sessions. Its value is not that it can generate another explanation. Its value is that it remembers the agreed destination, knows the verified course structure and definitions, resumes the next justified action, distinguishes conversation from evidence, and changes the plan only when formal evidence warrants it.

This advantage is not automatic. If the Tutor conversation is noticeably worse than a strong general model, if the curriculum feels arbitrary, or if the cost forces shallow interactions, the persistent structure will not compensate. For one-off questions, broad exploration, or open-domain research, a general chat will remain the better product. Hy3 Study Clinic should say so through its product focus rather than imitating every general-chat capability.

### Core product decision

Make Course Home and Study Session the primary product. Treat Curriculum as the learner-visible organizing model. Treat concepts, graph, SourceBlocks, lesson cards, assessments, mastery, mistakes, misconceptions, and review as supporting primitives for one executable learning loop.

Use the existing Workspace as the persisted course boundary. “Course” is the learner-facing term; it is not a duplicate domain object.

Do not start the old deferred phase wholesale. The next phase should be a thin end-to-end tutor loop that proves learner value and cost before adding a broad diagnosis or policy system.

## 2. Current versus target product loop

### Current loop

    Material import
      → SourceBlocks
      → additive concept extraction
      → graph generation
      → learner chooses a concept
      → overview / lesson / evidence / remediation plan
      → Tutor selects an activity
      → assessment and grading
      → mistakes / mastery / misconceptions / review
      → learner returns to the graph and chooses again

This loop is data-structure-first. It is effective for exploration and repair after the learner already knows what to study. It has no accepted definition of the learner's outcome, no course-scale order, and no explicit completion contract.

### Target loop

    Course documents
      → confirmed learning goal
      → deterministic source outline + existing concepts
      → validated learner-visible curriculum
      → proposed, editable, accepted StudyPlan
      → today's deterministic agenda
      → one planned LearningUnit
      → bounded Tutor dialogue
      → low-stakes checks as teaching
      → formal checkpoint as evidence
      → deterministic completion decision
      → local next-item unlock or meaningful replan
      → section/chapter synthesis
      → persistent progress and scheduled review

The goal is learner-visible first. A goal-neutral source outline or cached curriculum may be prepared internally while the learner answers the goal questions, but the product must not dump a graph or outline on the learner before understanding why they are studying.

The shift is not “graph page plus a chat tab.” It changes the product's control center:

| Concern | Current center | Target center |
| --- | --- | --- |
| Course structure | Flat concepts plus graph | Hierarchical Curriculum |
| Learner intent | Implicit | Confirmed LearningGoal |
| Sequence | User navigation / queue priority | Accepted, ordered StudyPlan |
| Teaching | Cached lesson card | Natural bounded Tutor session |
| Quick checking | Quiz or activity launch | Inline low-stakes dialogue checks |
| State evidence | Assessment | Assessment, unchanged as the formal boundary |
| Moving on | Learner inference | Explicit goal-specific completion decision |
| Adaptation | Remediation after errors | Local progression plus evidence-triggered replan |
| Cross-concept learning | Graph inspection | Section/chapter synthesis checkpoints |
| Primary screen | Graph workspace | Course Home and Study Session |

The target loop retains every valuable reliability boundary. It changes orchestration and information architecture, not the ownership of truth.

## 3. Analysis of the dogfood feedback

### 3.1 “I do not know the whole course structure”

The current section-aware extraction improves concept quality, but the extraction section is an internal batching unit. apps/server/src/ingestion/sections.ts groups blocks around a varying heading depth and may split or synthesize windows for extraction. That is appropriate for reliable model context; it is not a full learner-visible heading tree.

The frontend then exposes concepts mainly through a flat list and graph. A learner can infer clusters, but the product has not named chapters, explained their role, or shown where the learner is in the course.

Product consequence: create a versioned Curriculum derived first from the full headingPath hierarchy, then enriched by a model under strict reference validation.

### 3.2 “I do not know what order to learn”

Graph edges express relations such as prerequisite, part-of, or contrast. A dense graph can support sequencing but cannot by itself select a sequence because order depends on goal, time, depth, prior knowledge, and exam scope.

The current DailyQueue ranks review and repair candidates using learner state. It is useful for deciding which debt is urgent, but it cannot explain the intended path through previously unlearned material.

Product consequence: keep graph prerequisites and queue signals as inputs. Add a goal-specific ordered plan whose order, rationale, time budget, and completion criteria are explicit and accepted by the learner.

### 3.3 “I do not know why now or how long”

The current UI has no authoritative total study estimate, session budget, or “why now” attached to a course-scale plan. Any generated prose would also be insufficient because it could not drive progress or be reconciled with completion.

Product consequence: every plan item must carry validated structured fields: estimated minutes, importance, prerequisite rationale, teaching depth, prioritized objectives, checkpoint strategy, and completion rule. Total time is computed locally, never copied from free-form prose.

### 3.4 “I do not know what today's session contains”

The queue presents learning-state tasks, while the graph presents available concepts. Neither reconciles the accepted plan, due review, current unfinished work, and the learner's available minutes.

Product consequence: build today's agenda deterministically from the accepted plan and current evidence. It should normally contain:

1. due review with a bounded time allowance;
2. the current or next available plan item;
3. its planned checkpoint if time permits; and
4. no more work than the learner's session budget unless they opt in.

The agenda is recomputed locally. It does not require an LLM call.

### 3.5 “I do not know when I can move on”

Current mastery and assessment results are real evidence, but there is no goal-specific LearningUnit completion contract. A learner saying “懂了” is conversational feedback, not verified performance. Conversely, requiring deep mastery of every low-priority concept in a three-day sprint would be the wrong contract.

Product consequence: completion is a deterministic decision against the accepted plan's criteria and formal graded evidence. It is scoped to a goal and plan version. “Completed for this plan” must not be presented as universal mastery.

### 3.6 “I cannot combine several concepts”

Concept-local cards and quizzes encourage isolated recall. Graph relations show connections visually but do not require the learner to use several ideas in one explanation, diagnosis, or application.

Product consequence: insert section or chapter synthesis items after coherent groups of LearningUnits. Generate them with the current blueprint and grounding machinery, but require questions that integrate at least two units or concepts.

### 3.7 “I need to interrupt naturally”

LessonCard offers preset enrichment actions, and TutorPanel has no learner text input. The current Tutor endpoint runs a bounded model/tool planning loop and emits an auditable event timeline before launching an activity. That is good infrastructure for safe orchestration, but it does not support “为什么？”, “换一种说法”, or a learner's proposed interpretation.

Product consequence: replace the primary Tutor UI with a real transcript and composer. Use one structured Tutor response per learner turn, assembled from bounded context. Keep the current event timeline only as an optional audit surface.

### 3.8 “The source should not constrain all teaching”

The current provenance work correctly distinguishes verified source material from generated explanation. The risk is treating exact grounding as if every useful sentence must be quoted from the course. That would produce a weaker tutor.

Product consequence: course source controls course-specific truth, scope, definitions, notation, and formal grading. The model may add clearly labeled intuition, prerequisites, examples, derivations, comparisons, and transfer. Exact quotation proves location, not semantic entailment, and the UI and validation must retain that distinction.

### 3.9 What the feedback does not invalidate

The feedback does not justify replacing:

- SourceBlocks or exact quotation validation;
- stable concept IDs;
- graph relation validation and provenance;
- deterministic objective grading;
- transactional mastery, mistake, misconception, and review updates;
- provider schema validation;
- fake-provider determinism;
- cancellation, idempotency, or stale-response handling.

Those are the substrate of the proposed advantage. The redesign should make them less visible as navigation machinery and more valuable as trustworthy Tutor memory.

## 4. Competitive comparison with a strong general conversational tutor

### 4.1 Where Hy3 Study Clinic is currently weaker

| Dimension | Strong general conversational tutor | Current Hy3 Study Clinic |
| --- | --- | --- |
| Goal discovery | Natural dialogue about level, deadline, and desired outcome | No required goal intake |
| Teaching flow | Immediate conversational explanation and follow-up | Static card plus activity-oriented Tutor |
| Interruption | Arbitrary natural-language questions | Preset lesson actions; no Tutor composer |
| Adaptation | Fluid tone, examples, and Socratic checks | Mostly concept selection and remediation |
| Breadth | Broad world knowledge and flexible connections | Deliberately course-bounded |
| Interaction polish | Mature general-chat interface | Graph-centric, multi-surface navigation |
| Perceived cost | Often bundled into an existing subscription | Visible API marginal cost |
| Time to value | Upload and ask | Import, analyze, generate graph, then navigate |

No graph or citation badge closes these gaps.

### 4.2 Where Hy3 Study Clinic can realistically be stronger

| Advantage | Why it matters | Required proof |
| --- | --- | --- |
| Accepted executable plan | The learner can see and edit what will happen, then resume it later | Plan adherence and next-action clarity |
| Verified course truth | Course-specific definitions, notation, and claims are tied to existing source blocks | Low conflict and citation failure rates |
| Formal evidence boundary | Conversation never silently becomes mastery | Low false-completion rate |
| Persistent longitudinal state | Mistakes, misconceptions, reviews, and completed work survive sessions | Better delayed retention and resume success |
| Auditable adaptation | Replans have explicit evidence reasons and preserve history | Replan acceptance and usefulness |
| Cross-concept synthesis | The product checks integrated understanding, not only node recall | Stronger synthesis/transfer performance |
| Cost-aware reuse | Extraction, curriculum, plans, lesson material, and assessments are persisted | Lower cost per useful session over repeated use |

These advantages compound only across a serious multi-session course. That is the intended market boundary.

### 4.3 Where Hy3 Study Clinic should not try to compete

It should not try to become:

- the best generic one-off question-answering chat;
- an open-web research assistant;
- a general writing or coding assistant;
- the broadest source of world knowledge;
- a voice, image, or live-web tutoring suite in this phase;
- a social classroom, learning management system, or administration product.

When a learner only wants a single explanation, opening a general chat is rational. Hy3 Study Clinic should win when the question is “What should I do next in this course, given what I have actually demonstrated?”

### 4.4 Competitive falsification condition

The differentiation is not credible if a controlled dogfood comparison finds that:

- learners frequently leave the Study Session to ask the same course questions in general chat;
- the accepted plan is ignored because it is not useful;
- completion decisions do not predict delayed or synthesis performance;
- source grounding makes explanations substantially less helpful;
- or API cost per useful session is unacceptable relative to perceived value.

If those conditions persist after focused iteration, the honest conclusion is that Hy3 Study Clinic is an engineering system without a strong standalone product case.

## 5. Target learner experience

### 5.1 Import and course creation

1. The learner creates or selects a Course. Internally this remains the existing Workspace.
2. They add one or more documents to that explicit destination. The new UI should stop silently making a separate one-document material_import workspace when the learner intended to add to an existing course.
3. Local parsing runs automatically and produces SourceBlocks plus full heading paths.
4. Course Home invites goal intake immediately; it does not require concept or graph navigation first.
5. A single “Prepare course” action discloses the estimated setup calls and starts any missing section-level concept extraction, the deterministic outline, and the curriculum proposal. Existing valid outputs are reused.
6. The system shows setup progress in learner terms: “Reading source,” “Identifying course ideas,” and “Preparing your curriculum.”
7. Failure at a later setup step never deletes previously valid source or concepts.

The setup state machine is explicit:

    no_documents
      → source_processing
      → heading_outline_ready_needs_analysis
      → concept_analysis_running
      → mapped_fallback_ready
      → curriculum_generating
      → curriculum_ready

source_processing, concept_analysis, and curriculum generation each have failed and retryable states. The heading-only outline is available immediately after parsing; concept extraction enriches it into the mapped fallback Curriculum that can carry objectives and a plan. After concept-analysis or curriculum failure, source and any previous valid results remain usable. Graph generation is optional, separately visible, and never blocks the first usable curriculum.

### 5.2 Goal intake

Before teaching, Course Home asks a small set of consequential questions:

- What outcome do you want?
- Is this building understanding, preparing for an assessment, or refreshing?
- What scope is included?
- Is there a deadline?
- How much total and per-session time is realistic?
- What depth do you want?
- What do you already know?
- If assessment-oriented, what is the exam format and emphasis?

The learner may answer through compact controls, natural text, or both. Structured controls should be sufficient without an LLM call. If natural text is interpreted by a model, the result is shown as an editable draft, never silently activated.

### 5.3 Curriculum and plan proposal

The system first presents a learner-visible hierarchical Curriculum. It then proposes a goal-specific StudyPlan with:

- ordered units and synthesis checkpoints;
- total and per-item time estimates;
- learning objectives;
- importance and scope;
- “why now” and prerequisite rationale;
- teaching depth;
- checkpoint strategy; and
- explicit completion criteria.

The learner can reorder an available unit, change time assumptions, exclude scope, or adjust depth. The server validates the edit. A prerequisite-breaking edit is explained and must become an explicit accepted scope/dependency exception; it is not silently accepted and is distinct from deferring an in-progress item later.

Teaching begins only after the learner accepts the plan.

### 5.4 Course Home and today's session

On every return, Course Home answers five questions without model generation:

1. What is my goal?
2. How far am I?
3. What should I do today?
4. Why is this next?
5. How long will it take?

The primary action is “Continue study,” not “Open graph.”

### 5.5 Study Session

The session opens on one plan item and provides:

- the current unit title and objectives;
- the estimated time and completion criteria;
- a natural Tutor transcript and free-text composer;
- inline examples and low-stakes checks;
- verified course citations when a course claim is used;
- an on-demand source/evidence drawer;
- a visible route to a formal checkpoint;
- the ability to pause with state preserved.

The learner can interrupt at any point. The Tutor can answer, ask a question, reteach, connect a prerequisite, or recommend formal practice. The conversation does not directly change mastery.

### 5.6 Checkpoint, completion, and next action

When the Tutor and learner judge the unit ready, the system launches a formal checkpoint using the existing assessment and grading machinery. The completion service evaluates the accepted criteria against graded evidence.

The transition is explicit:

    Study
      → Ready for a counted checkpoint?
      → checkpoint instructions + permitted-materials policy
      → answer and submit
      → grading saved
      → progression reconciled
      → result: completed / continue / deferred_not_completed
      → resume current unit or open next available agenda item

Each planned checkpoint declares closed_book or source_allowed. A closed-book checkpoint hides exact SourceBlock quotations, lesson answers, and relevant transcript content until submission; results reveal the verified grounding afterward. An open-book checkpoint keeps them accessible and says so. Checkpoints are always scoped to the Course/Workspace and plan item, never inferred from App's old active-material state.

Outcomes are explicit:

- Completed for this plan: unlock the next item.
- Continue: show the unmet objective and resume targeted teaching or practice.
- Deferred by learner: preserve the gap as deferred_not_completed and move on only where plan policy allows.
- Plan needs review: propose a versioned replan only when the evidence is meaningful.

### 5.7 Synthesis and replan

After a section or coherent group, a synthesis checkpoint requires concepts to be combined. A failure does not erase completed units. It records the formal evidence, schedules relevant review, and proposes the smallest repair: a targeted revisit, added practice, or a versioned plan change.

Replanning shows a diff and reason. Previously completed work and historical plans remain visible.

## 6. Curriculum and hierarchy design

### 6.1 Why a new Curriculum layer is needed

Concepts describe atomic ideas. Graph edges describe relationships. Neither represents a stable learner-visible course outline with chapter boundaries, ordered units, objectives, and synthesis points.

A Curriculum layer is therefore justified, but it must be a projection over existing concepts and source structure—not a parallel concept system. LearningUnit is an organizing and execution boundary whose members are existing concept IDs.

### 6.2 Proposed hierarchy

    Workspace, displayed as Course
      CurriculumVersion
        Chapter
          Section
            LearningUnit
              primaryConceptIds
              supportingConceptIds
              sourceRefs
              learningObjectives
            SynthesisDefinition
              precedingLearningUnitIds
              integrativeObjectives

The hierarchy should support shallow documents. A short document may have one chapter with several units. Empty decorative levels should be hidden in the UI.

### 6.3 Deterministic source outline

The server should build a full SourceOutline before any curriculum model call:

1. Build a heading-only trie from every SourceBlock.headingPath immediately after parsing, preserving document identity and block order.
2. Retain heading text, depth, block ranges, document boundaries, and stable source references.
3. After concept extraction, enrich that trie by attaching concepts to the most specific compatible heading node through their verified grounding SourceBlock IDs and reusable deterministic structural-mapping logic.
4. Record unmapped concepts explicitly.
5. Compute separate heading-only and mapped-outline fingerprints from included material revisions, block identities, concept identities where present, and an explicit mapping-algorithm version constant.

This differs from the existing computeSections extraction batching. The extraction grouping can remain unchanged. SourceOutline is a lossless structural projection for curriculum validation and fallback. Current structural mapping is derived, not persisted; Curriculum fingerprints therefore include its inputs and an algorithm-version constant rather than claiming a stored mapping version.

Deterministic structure supplies:

- document and heading hierarchy;
- source order;
- source block membership;
- known concept membership where structurally mapped;
- stable references and fingerprints.

It does not invent pedagogical chapters, unit titles, prerequisites, objectives, or time estimates.

### 6.4 Model-assisted curriculum proposal

One model call may propose:

- learner-friendly chapter and unit names;
- merging overly granular headings;
- splitting a broad source section into bounded units;
- a goal-neutral pedagogical order;
- unit objectives;
- primary versus supporting concept roles;
- prerequisite links;
- base effort estimates;
- synthesis boundaries and course-grounded integrative objectives.

This call is course setup work and should be cached by source fingerprint and prompt version.

The model may reorganize weak document structure, but it must reference only known document, block, section, and concept IDs. It cannot create a new course fact or silently omit an important in-scope concept.

Provider output uses bounded temporary keys or array positions for proposed units and objectives. The server assigns all persistent CurriculumVersion, LearningUnit, and objective IDs after validation; the model never chooses persistent IDs.

Each objective has an authority classification:

- course_grounded: references existing concepts and verified course evidence;
- teaching_enrichment: useful optional intuition, comparison, or exploration that is not formal course truth.

Only course_grounded objectives may become required CompletionRule targets. A novel application or transfer objective can still be course_grounded when its scenario is generated but the principle and grading claims are tied to verified course evidence. Pure enrichment stays optional and cannot silently become grading truth.

Each objective also has orthogonal coursePriority: core, supporting, or optional. The model proposes it from source heading prominence, existing Concept.importance, recurrence, and the role of the concept in validated prerequisites; it must provide those reference IDs as rationale. Local code validates the enum and references, not the pedagogical judgment. The accepted StudyPlan may then map course priority plus goal/exam context into goal-specific required, high, normal, or optional objective priority. teaching_enrichment is always optional regardless of model output.

### 6.5 Local curriculum validation

Runtime validation should enforce:

- all IDs exist in the current workspace;
- all source references point to existing SourceBlocks;
- every LearningUnit has a bounded title, at least one objective, and at least one primary concept;
- every required objective references known concepts and valid source evidence;
- teaching-enrichment objectives are visibly optional and excluded from required completion criteria;
- every objective has a controlled coursePriority and a locally valid reference-based rationale;
- each in-scope concept appears as a primary concept exactly once, unless a controlled omission reason is recorded;
- a concept may appear as supporting context in a bounded number of other units;
- duplicate normalized titles and objectives are rejected or deduplicated;
- unit prerequisites reference known units and form a directed acyclic graph;
- source order violations are allowed only with an explicit pedagogical rationale;
- document and unit count limits are enforced;
- important concepts cannot disappear without a visible exception;
- synthesis boundaries reference two or more preceding related units;
- every synthesis objective references at least two preceding units/concepts and retains verified course evidence for the principles it combines;
- all generated evidence anchors pass the existing grounding checks;
- the proposal's included-revision fingerprint matches the requested active source scope; unrelated later additions do not retroactively invalidate it.

The validator does not pretend that quotation matching proves the curriculum is pedagogically optimal. It proves reference integrity and bounded structure. Pedagogical quality requires evaluation and human acceptance.

### 6.6 Fallback and weak-source behavior

If model generation fails or validation rejects it:

- keep the previously active valid CurriculumVersion;
- for a first curriculum, expose a deterministic outline ordered by document and heading;
- create conservative units from heading nodes and mapped concepts;
- place unmapped concepts in a visible “Additional concepts” group;
- mark learner-facing organization as source-derived or AI-organized;
- allow plan creation from the fallback.

A fallback LearningUnit is created only when a heading group has at least one mapped concept. It receives a source-grounded template objective such as “accurately explain or distinguish [concept name],” backed by that concept's existing verified grounding. Heading-only groups remain visible structure and request deeper extraction or manual scope review instead of inventing a concept.

Fallback effort uses a disclosed deterministic estimate—for example, ten minutes of orientation plus ten minutes per primary concept, clamped to a configurable 15–45 minute unit range. The fallback plan follows source order plus any validated prerequisite edges, uses the same local goal/depth CompletionRule templates, and schedules a normal grounded concept-practice checkpoint. A section with at least two units receives a SynthesisDefinition whose template objective is to combine the listed course-grounded unit objectives; it retains their evidence anchors. The later assessment provider must still generate and validate a genuinely integrative question.

A missing or invalid graph must never block curriculum creation.

### 6.7 Stable IDs and versioning

Within an active material revision, existing concept IDs remain canonical; Curriculum never clones or remints them. A staged reprocess may create new concept IDs because the current extractor does so. The material-revision and concept-lineage design in Section 15 preserves old history and allows only validated reconciliation into the new active revision.

Curriculum unit IDs are server-assigned stable identifiers within a CurriculumVersion. A new source fingerprint or accepted structural edit creates a new immutable version. The workspace points to one active ready version. Old versions remain readable so historical goals, plans, sessions, assessments, and progression decisions retain meaning.

Where a new version contains an equivalent unit, migration logic may record predecessor IDs, but it must not rewrite historical records.

### 6.8 Where the graph remains useful

The graph remains valuable for:

- suggesting and explaining prerequisites;
- finding connections for Tutor responses;
- detecting a missing bridge in curriculum order;
- generating synthesis relationships;
- learner-led exploration after or alongside planned study;
- visualizing mastery and mistakes across concepts.

It should be a secondary Graph Explorer, not the course home, plan, or completion engine. The dependency view is the most pedagogically actionable graph mode. Generic network exploration remains optional. “Weak path” should usually appear as a plan rationale or targeted highlight rather than a separate primary workflow.

## 7. LearningGoal design

### 7.1 Avoid overlapping mode enums

The candidate modes mix intent, depth, and intervention:

- systematic and deep describe study style or depth;
- exam_sprint describes intent plus deadline;
- review describes intent;
- gap_repair describes a system response;
- custom describes input flexibility.

Encoding all six as one enum would create branching policy and ambiguous combinations.

### 7.2 Smallest useful model

A LearningGoal should contain:

| Field | Proposed values or shape | Product purpose |
| --- | --- | --- |
| intent | build_understanding, prepare_assessment, refresh | Why the learner is studying |
| depth | essential, standard, deep | How far beyond core objectives to go |
| outcome | bounded learner-authored text | Concrete desired result |
| scopeDefinition | whole course or stable material IDs plus normalized logical section anchors | Learner intent that survives versioning |
| scopeSnapshot | the material-revision IDs and resolved section/block anchors confirmed at this revision | Exact planning and audit boundary |
| deadline | optional timestamp | Time pressure |
| availability | total minutes, optional minutes/day, preferred session minutes | Executable budget |
| priorKnowledge | bounded self-report plus optional known concepts | Starting assumption, not formal mastery |
| assessmentContext | optional type, emphasis, permitted materials, learner notes | Exam-specific adaptation |
| status | draft, confirmed, closed, archived | Lifecycle; pointer identifies the active confirmed goal, and closed carries achieved, finished_with_gaps, abandoned, or superseded |
| provenance | structured input or interpreted draft | Auditability |

User-facing presets map into these orthogonal fields:

- “Systematic study” → build_understanding + standard;
- “Deep study” → build_understanding + deep;
- “Exam sprint” → prepare_assessment + deadline + essential or standard;
- “Review” → refresh with selected scope.

Gap repair is not a goal intent. It is an evidence-driven repair activity or successor-plan change. Custom goals use the same fields with a custom outcome and scope.

### 7.3 Goal creation and confirmation

The default intake is deterministic structured input. An optional natural-language request such as “三天后考试，每天两小时，重点是检索和权限” can use one model call to propose field values. The server validates dates, positive budgets, workspace scope, and known IDs. The learner sees and confirms the interpretation.

Only a confirmed active goal may own an accepted StudyPlan. Goal scope never stores LearningUnit IDs because those exist only inside a CurriculumVersion; StudyPlan resolves the confirmed source snapshot into units.

If reprocessing or new material changes the resolution of scopeDefinition, create a successor LearningGoal draft with a proposed scopeSnapshot and diff. Planning against replacement revisions requires learner confirmation of that goal revision. Confirmation makes the successor eligible for plan proposal but does not activate it while an old goal/plan pair is active. The previous pair remains active for unaffected work until successor-plan acceptance atomically swaps both workspace pointers and supersedes the old pair. Editing any consequential field uses the same two-phase handoff; it never silently mutates the accepted contract.

### 7.4 Prior knowledge

Self-report affects initial explanation depth and may recommend an early diagnostic. It does not create mastery or complete units. A diagnostic becomes formal evidence only through the current assessment and grading path.

## 8. Executable StudyPlan design

### 8.1 StudyPlan is state, not prose

A StudyPlan is an immutable version tied to one LearningGoal and CurriculumVersion. It has:

- lifecycle status: proposed, accepted, superseded, finished;
- terminal outcome: completed, finished_with_gaps, or null;
- separately derived execution validity: valid, partially_blocked, replan_recommended;
- parent plan and replan reason where applicable;
- ordered PlanItems;
- computed total estimated minutes;
- source, curriculum, graph, learner-state, and prompt fingerprints;
- a deterministic PaceBaseline when deadline/availability permits it;
- proposal and acceptance timestamps;
- a bounded learner-facing summary.

The mutable execution state lives separately in StudyPlanProgress. This avoids rewriting the accepted plan while the learner works through it.

### 8.2 Small PlanItem model

Use two primary item kinds:

1. learning_unit;
2. synthesis.

A routine targeted repair is a bounded remediation or practice activity attached to an existing item's progress and agenda; it does not mutate the immutable plan. Adding or reordering a LearningUnit requires a successor StudyPlan proposal and learner acceptance.

Each item contains:

- item ID and order;
- LearningUnit IDs;
- title;
- estimated minutes;
- importance: required, high, normal, optional;
- “why now” summary;
- prerequisite rationale and referenced unit IDs;
- teaching depth;
- prioritized objective IDs;
- a goal-specific objective-priority map and rationale;
- checkpoint strategy;
- CompletionRule;
- optional defer policy;
- optional repair reason and evidence references.

StudyPlanProgress contains:

- status: blocked, available, in_progress, completed, deferred_not_completed;
- started, last-active, completed, and deferred timestamps;
- actual minutes where measurable;
- latest progression decision ID;
- unmet objective IDs;
- and a learner pause note if provided.

### 8.3 Plan generation

One model call proposes initial order, emphasis, rationales, estimates, checkpoint strategy, and criteria using:

- the accepted goal;
- active CurriculumVersion;
- graph prerequisites where valid;
- current formal mastery, mistakes, misconceptions, and review state;
- available time;
- and deterministic budget summaries.

Local code validates and normalizes the proposal. It must:

- reject unknown goal, curriculum, unit, concept, objective, and evidence IDs;
- cover all required in-scope units or explicitly mark omissions;
- enforce prerequisite order or an explicit accepted dependency/scope exception;
- reject cycles and duplicates;
- keep estimates and counts within configured limits;
- calculate total time locally;
- flag a deadline or total-time mismatch;
- enforce minimum CompletionRule strength for intent and depth;
- carry objective-specific evidence only when its blueprint objective, CompletionRule, and active material revisions remain compatible; legacy or retired-revision assessments may inform planning but do not auto-complete a unit;
- and preserve a previous accepted plan on failure.

### 8.4 Learner acceptance and edits

The proposed plan is not executable until accepted. The learner may:

- adjust availability or depth;
- remove optional scope;
- reorder currently available units;
- request more or less practice;
- or choose between a compressed and full plan.

Edits are structured and validated. Free-form requested edits may be interpreted by a model, but the resulting diff is shown before acceptance. Editing an accepted plan always creates a successor proposal; it never mutates the accepted payload or directly changes formal learner state.

### 8.5 Local progression versus model replanning

Most plan changes are local transitions:

- checkpoint passes → mark item completed and unlock dependents;
- learner pauses → keep item in progress;
- review becomes due → add it to today's agenda without changing the plan;
- learner explicitly defers → record deferred_not_completed and evaluate dependent availability under the accepted defer policy;
- a transient Tutor failure → no plan change.

A meaningful replan is warranted only when:

- goal, deadline, scope, or availability changes materially;
- a required source revision or curriculum reference becomes invalid, or newly added material makes the confirmed scope incomplete;
- a formal unit or synthesis checkpoint reveals a significant gap;
- a new misconception blocks downstream work;
- elapsed time substantially diverges from the accepted budget;
- or the learner explicitly requests a structural change.

Replanning creates a successor proposal in one model call, carries forward only active-revision-compatible completed evidence, and presents a diff. The current accepted plan remains active until the learner accepts the successor. Do not regenerate the plan after every conversation turn or assessment.

### 8.6 Aggregate completion and pacing

PlanOutcomeService evaluates aggregate state locally:

- completed only when every required item is evidence-completed, every required synthesis passed, no required item is blocked, and the confirmed goal's pinned scope has no unincorporated required material;
- finished_with_gaps only after an explicit learner “finish this plan” action when remaining items are deferred_not_completed or blocked; gaps and consequences remain visible and never enter completed counts;
- a deadline passing does not auto-complete or auto-finish a plan;
- a blocked plan remains accepted/partially_blocked until repaired, superseded, or explicitly finished with gaps;
- optional items omitted by the accepted plan do not prevent completion.

When a plan becomes completed, its confirmed LearningGoal closes with terminal_outcome=achieved. A plan finished_with_gaps closes the goal with the same outcome, never “achieved.” Explicit abandonment closes it as abandoned. Closing clears the workspace active goal/plan pointers only after terminal records commit; history and scheduled review remain accessible.

At acceptance, local code persists a versioned PaceBaseline when the goal has enough timing information:

- start timestamp and timezone;
- deadline, if any;
- accepted total minutes and available minutes per day/week;
- target cumulative minutes or item windows;
- scheduling algorithm version.

“On track” compares actual StudySession rollups with that baseline. A successor plan creates a new baseline and preserves the old one. If timing information is insufficient, Course Home shows progress and remaining estimate but does not claim “on track.” Plan-adherence windows use this persisted baseline.

### 8.7 “Why now” must be explainable

Every available item should have a locally reconstructable reason such as:

- next required item in accepted order;
- prerequisite for a named upcoming item;
- due review before advancing;
- repair attached after a named formal result, or a successor-plan item accepted because of that result;
- or learner-selected optional detour.

The model may write the concise wording, but the cited structural or evidence reason must exist locally.

## 9. Conversational Tutor architecture

### 9.1 Three deliberately separate layers

The Tutor experience must separate:

**A. Conversational teaching**

- explanations, examples, questions, analogies, connections, and prerequisite detours;
- responsive to the learner's language and current confusion;
- persisted for continuity;
- no direct learner-state mutation.

**B. Low-stakes comprehension checks inside conversation**

- short questions, learner paraphrases, predictions, or “which of these seems right?” prompts;
- used immediately to choose the next teaching move;
- may be summarized as conversational observations;
- never creates mastery, mistakes, misconceptions, review schedules, or unit completion.

**C. Formal state-changing assessment**

- explicit transition into the existing assessment flow;
- validated blueprint and grounded questions;
- deterministic grading where possible and schema-validated semantic grading otherwise;
- the only path that updates mastery, mistakes, misconceptions, review, and completion evidence.

The learner should always know when a check is informal and when an answer will count.

### 9.2 Evolve, do not duplicate, the current Tutor

The current tutor_runs and tutor_events tables, shared Tutor schemas, repository, service, route, provider method, and safe timeline should be evolved. Do not add an unrelated chat subsystem.

Existing Tutor behavior is a legacy planning run:

- the server calls proposeTutorStep repeatedly;
- a small tool whitelist reads current state;
- the run emits bounded safe events;
- the result launches an assessment or activity.

The new teaching run is multi-turn:

- it is tied to a durable StudySession plus course, goal, accepted plan, plan item, and LearningUnit context;
- the learner submits one idempotent message at a time;
- the server assembles bounded context deterministically;
- respondTutorTurn produces one structured response;
- the response is persisted and returned;
- any proposed formal action is validated locally;
- the run can be resumed across browser sessions.

Legacy planning runs remain readable for history and migration. They should be removed from the primary product path after teaching sessions are available.

A StudySession and Tutor run are not synonyms. StudySession is the learner's time-bounded execution episode and may contain due review, one or more planned activities, a Tutor run, and a formal checkpoint. A Tutor run is only the conversational thread for one current plan item. This boundary supplies pause/resume, actual-time, cost, and useful-session correlation without making the transcript own the agenda.

### 9.3 Tutor turn contract

A learner turn request should include:

- run ID;
- StudySession ID;
- unique clientTurnId;
- learner text;
- expected plan ID, item ID, unit ID, and context fingerprint;
- expected prior exchange sequence;
- request cancellation metadata already used by the frontend.

A structured Tutor response should include:

- a concise direct response;
- teachingMove from a controlled enum;
- optional structured explanation sections;
- course-source citations, each using existing verified grounding;
- explicit AI-teaching segments when not sourced;
- optional lowStakesCheck;
- optional referenced concept, unit, or prerequisite IDs;
- optional recommendedAction;
- a bounded rollingSummaryUpdate;
- and a short final rationale suitable for display.

The response must not include:

- mastery deltas;
- commands to close mistakes or misconceptions;
- formal progression decisions;
- arbitrary persistent mutations;
- unknown IDs;
- private chain-of-thought.

Before provider work, the server inserts one pending TutorExchange containing the learner text and expected context. A successful response and rolling-summary update commit atomically to that exchange. A malformed result may use the existing single bounded schema-repair attempt. Failure keeps the learner request and safe error retryable while leaving all formal learning state unchanged.

### 9.4 Controlled teaching moves

The smallest useful set is:

- direct_answer;
- socratic;
- reteach;
- example;
- connect;
- prerequisite_detour;
- low_stakes_check;
- recommend_formal_checkpoint;
- recommend_move_on.

These moves make behavior auditable without reducing the interface to buttons. The learner always types naturally. The model selects a move appropriate to the request and state.

Local policy constrains actions:

- answer directly when the learner asks a concrete question and withholding the answer adds no educational value;
- ask a Socratic question when eliciting a prediction or explanation is useful and not frustrating;
- reteach after explicit confusion or a failed low-stakes check;
- give an example when abstraction is the apparent blocker;
- inspect a prerequisite only when a known prerequisite is relevant, then return to the planned unit;
- recommend formal practice when the learner wants verification or objectives appear ready;
- recommend moving on only when the completion service says the current item is already completed or eligible for an explicit defer.

A relevant prerequisite or broader question can be answered as AI teaching. A materially off-scope question should receive a concise boundary and an offer to park it or create a learner-confirmed plan edit; it must not silently expand course scope.

The enum is a response contract, not a giant policy engine. Pedagogical selection remains a model responsibility within local safety and state boundaries.

### 9.5 One logical call per learner turn

The normal path is exactly one semantic Tutor call per learner message. Relevant repository reads and context selection are deterministic. Do not retain the current hidden loop of up to six model planning iterations before teaching.

One structured call may contain the answer, an optional low-stakes question, citations, the next recommended action, and a rolling-summary update. A schema repair is a transport-level retry, must be separately observed, and must not be described as a cache hit or independent learner turn.

### 9.6 Session lifecycle

A teaching run has:

- created;
- active;
- awaiting_learner;
- awaiting_checkpoint;
- paused;
- completed;
- cancelled;
- failed;
- domain_stale.

The repository has no authentication, device identity, or multi-user learner model. In the smallest scope, enforce one open teaching run per workspace and plan item and at most one pending exchange per run. Retrying the same clientTurnId returns the completed persisted response or continues the pending attempt; a competing clientTurnId with the same prior sequence conflicts instead of forking history.

Server startup or lease expiry may mark genuinely pending provider exchanges interrupted and retryable under the same clientTurnId with a new fencing token. An old worker cannot commit after takeover. It may interrupt abandoned legacy planning runs, but it must not interrupt teaching runs that are paused or awaiting the learner. Explicit Stop cancels the run; ordinary navigation merely detaches the UI.

Completing a Tutor run does not complete a unit. It records that the conversation ended. Unit completion is a separate deterministic decision.

## 10. Context assembly and bounded conversation

### 10.1 Context assembler

Create one TutorContextAssembler service that reads existing repositories and produces a validated, size-bounded context packet. It replaces model-selected read tools in the normal teaching path.

The packet contains:

- course identity and active source fingerprint;
- confirmed LearningGoal;
- accepted StudyPlan and current PlanItem;
- current LearningUnit, objectives, importance, depth, and CompletionRule;
- relevant SourceBlocks and verified concept grounding;
- related source hierarchy;
- validated graph prerequisites and connections;
- cached lesson material if it already exists;
- formal mastery, open mistakes, active misconceptions, and due review relevant to the unit;
- progression decisions and assessment evidence for the current item;
- bounded recent Tutor turns;
- rolling session summary;
- and allowed actions.

The context is a snapshot with a fingerprint. It is not a live object the model can mutate.

### 10.2 Relevance and size strategy

The first version does not require a vector database or embedding search.

Select context in this order:

1. SourceBlocks cited by the unit's primary concepts.
2. Blocks inside the unit's source sections.
3. Existing lexical search hits for named terms in the learner's turn.
4. SourceBlocks tied to a named related or prerequisite concept.
5. A bounded set of graph neighbors or a shortest known path when the learner asks about a relationship.
6. Cached lesson segments relevant to the selected move.

Use explicit configurable budgets rather than “all course context.” A reasonable first bound is:

- current plan item and immediate predecessor/successor summaries;
- current unit plus at most a small number of directly relevant related units;
- at most eight SourceBlocks, consistent with the current search boundary;
- recent eight conversational turns;
- one rolling summary;
- bounded open mistakes, misconceptions, and review entries ranked by relevance and recency.

The exact token budgets should be measured and tuned. Truncation order must preserve the current goal, objectives, completion criteria, course truth, and the learner's latest question before optional history or enrichment.

### 10.3 Long conversation strategy

Persist the complete transcript, but do not resend it forever.

For each response:

- include the most recent bounded turn window;
- include a previously validated rolling summary;
- ask the same Tutor call for a bounded summary update;
- validate referenced IDs, length, and allowed observation types;
- replace the active summary only after the response succeeds.

The rolling summary may record:

- questions already answered;
- explanations or examples that helped;
- unresolved learner questions;
- conversationally observed confusion;
- terms introduced during a prerequisite detour.

It may not assert formal mastery, close a mistake, diagnose a persistent misconception, or claim unit completion. No separate summary model call is required in the normal path.

### 10.4 Context invalidation and stale responses

The fingerprint should include at least:

- the current item/context's required included-MaterialRevision and resolved source-reference fingerprint, plus active CurriculumVersion fingerprint;
- accepted goal and plan version;
- current plan item and unit;
- relevant learner-state version;
- prompt and provider-contract version.

Navigation and domain invalidation are different. If the learner switches the visible Course, the frontend aborts or detaches its view request and refuses to render the old response in the new Course. A durable generation or Tutor operation may still finish and persist to its original Course, saving paid work, if its required included revisions, goal, plan, unit, and relevant learner-state fingerprint remain valid. Returning to that Course refetches the result. Adding an unrelated document changes workspace freshness to has_unincorporated_additions but does not change this domain fingerprint.

Changing the accepted goal or plan, retiring a required source revision, changing the current unit, or committing relevant formal evidence is a domain change. The server compares the expected fingerprint before assistant-response persistence. A late response against obsolete domain state marks the pending exchange domain_stale and does not attach the assistant payload as current teaching. Explicit Stop is the only navigation-level action that requests server cancellation.

The transcript may retain a clearly labeled failed or stale attempt for audit, but the UI should not present it as valid teaching.

### 10.5 Context privacy and observability

LLM telemetry stores operation metadata, token counts, latency, cache state, and cost estimates. It must not store raw prompts, full responses, source text, or hidden reasoning in the usage ledger. Tutor exchanges and displayed citations live in their purpose-built repositories with existing data controls.

## 11. LearningUnit and completion model

### 11.1 What completion means

Completion means:

> For this accepted goal and plan version, the learner has supplied the formal evidence required by the item's CompletionRule.

It does not mean permanent mastery. Mastery remains the current per-concept evolving learner state, and review may become due after a completed unit.

Advancement is a separate notion. A learner may advance past a deferred item only when the accepted plan allows it, but the item remains deferred_not_completed and is excluded from completion counts. Pre-accepted omission of a low-priority objective from an exam-focused CompletionRule is also different from a later learner defer: the former defines honest goal scope; the latter records an unmet item.

### 11.2 Learning objectives

Curriculum objectives are goal-neutral and reference existing concepts and source scope. Each has the authority classification defined by Curriculum and valid source evidence when it is course_grounded. A StudyPlan prioritizes those objectives and assigns an expected evidence kind:

- understand: accurately explain or distinguish;
- apply: use the idea in a bounded problem;
- connect: relate two or more concepts;
- transfer: use the idea in a meaningfully new situation.

This controlled evidence-kind field extends the current assessment blueprint. It does not create a new multidimensional mastery score.

For deterministic attribution, each QuestionBlueprint has exactly one primary learningObjectiveId in the smallest scope. A question may reference several concepts or units, especially in synthesis, but its per-question grade counts only toward that one objective. Multiple objectives require multiple blueprint questions. Do not let one partially correct multi-objective answer satisfy every attached objective.

### 11.3 CompletionRule

A CompletionRule is structured and locally evaluable:

- required objective IDs;
- acceptable question types;
- required evidence kinds;
- minimum passing grade under the existing grading semantics;
- number and freshness of qualifying attempts;
- whether synthesis evidence may satisfy an objective;
- nonblocking objective IDs excluded when the plan was accepted, with an explicit goal-specific reason;
- policy version.

Use the current grading truth. Choice questions pass by deterministic correctness. A nonblank text-answered question, including short_answer and concept_comparison, qualifies when the current semantic grade is correct or mostly_correct and meets the shared SHORT_ANSWER_PASS rule. The completion service should import that rule rather than invent a second numeric cutoff.

Every required objective must be course_grounded, and every qualifying grade must come from a persisted blueprint carrying that exact objective ID. Conversational observations, free-form plan prose, related concept mastery, and legacy assessments without objective IDs may inform planning but do not satisfy an objective-specific CompletionRule.

### 11.4 Goal-aware criteria without a giant policy engine

Use a small deterministic template selected by intent and depth, then let the plan proposal choose objectives within its constraints:

| Goal shape | Minimum completion emphasis |
| --- | --- |
| build_understanding + essential | All core understand objectives; application where the unit defines one as core |
| build_understanding + standard | All core objectives plus at least one planned application or connection when available |
| build_understanding + deep | Core objectives plus application and a connection or transfer objective; synthesis required at section boundaries |
| prepare_assessment | All high-weight or in-scope assessment objectives; lower-priority objectives may be excluded from the accepted CompletionRule with a visible goal-specific reason |
| refresh | Only selected target objectives, usually with a fresh formal check |

“Core” in this table means Curriculum objective coursePriority=core. “High-weight” means the StudyPlan's accepted goal-specific objective priority is required or high, with exam-context rationale. These are minimum policy templates, not hardcoded question scripts. Units without an applicable evidence kind should not receive artificial requirements. The validator checks feasibility against the objective authority, coursePriority, and accepted goal-specific priority fields.

### 11.5 Completion decision

After a formal grade, CompletionService:

1. reads the committed grading result, its persisted blueprints, the immutable plan item, and CompletionRule;
2. selects qualifying per-question evidence carrying the same primary objective IDs;
3. evaluates every requirement deterministically;
4. appends an idempotent UnitProgressionDecision;
5. updates StudyPlanProgress and unlocks dependents or records unmet objectives in a second local transaction;
6. lets the existing grading transaction remain the sole owner of mastery, mistakes, misconceptions, and review.

The existing grading transaction commits first. Completion never wraps or rolls back otherwise valid grading. The post-grade progression transaction is unique on grading-result ID, plan item, and policy version so it can be retried safely. If it fails, the API reports “grade saved, progress reconciliation pending”; the next Course Home or plan-progress read reconciles contextual grading results that have no progression decision.

A progression transaction may store a deterministic needs-replan reason. It must never make a provider call. A successor plan proposal is a later idempotent operation outside both grading and progression transactions.

Decision outcomes:

- completed;
- continue;
- deferred_not_completed.

A plan-level replan_recommended validity reason is a consequence outside the decision result, set only by the meaningful-replan rules.

### 11.6 Learner autonomy

The default path advances only after completion. The learner may:

- continue studying despite qualifying;
- take the formal checkpoint early;
- pause;
- or explicitly defer a gap where policy allows.

Explicit defer is not completion and does not alter mastery. It creates a learner_defer progression decision with nullable assessment references, a required reason, and a visible downstream consequence. It may unlock only the dependents permitted by the accepted defer policy; otherwise they remain blocked. This avoids imprisoning the learner while keeping the evidence honest.

## 12. Section and chapter synthesis assessments

### 12.1 Product purpose

Synthesis checks whether the learner can combine ideas that were taught separately. They should appear after a coherent section or chapter, not after an arbitrary number of concepts.

The active CurriculumVersion owns each SynthesisDefinition and its integrative objectives using the same authority, coursePriority, concept/source provenance, and server-assigned ID schema as unit objectives. StudyPlan decides whether each is required and what evidence kind/depth applies. Assessment generation realizes those persisted objectives as questions; it does not invent a new completion requirement at checkpoint time.

Examples include:

- explaining how embedding choice affects retrieval and downstream RAG behavior;
- diagnosing a system failure using architecture, permissions, and data-flow concepts;
- comparing two mechanisms using the course's definitions and tradeoffs.

### 12.2 Reuse the existing assessment machinery

Extend CreateAssessmentRequest and QuestionBlueprint with optional learning context:

- curriculumVersionId;
- planId and planItemId;
- LearningUnit IDs;
- requested objective IDs on the assessment and exactly one primary learningObjectiveId on each QuestionBlueprint;
- checkpointKind: unit or synthesis;
- required evidence kinds.

The current assessment service remains responsible for validated grounded generation. The current grading service remains responsible for objective and semantic grading and transactional learner-state changes.

For synthesis, local validation additionally requires:

- two or more related LearningUnits or concepts per integrative question;
- a connection, application, or transfer evidence kind;
- valid source grounding for course-specific premises;
- coverage of the synthesis item's required objectives;
- no isolated-recall-only assessment masquerading as synthesis.

A synthesis objective may reference several units and concepts, but it remains one integrative objective for per-question evidence attribution. If a checkpoint needs to prove two distinct integration objectives, it generates at least two blueprints.

### 12.3 Failure and repair

A failed synthesis:

- preserves prior unit progression decisions;
- writes ordinary grading evidence through the existing state machinery;
- identifies unmet integrative objectives;
- may attach a bounded repair activity to the current item or propose a successor plan;
- schedules relevant review where current rules require it.

It does not reset a whole chapter or let the model directly reopen mastery history.

## 13. Source-grounded course truth versus AI teaching

### 13.1 Authority policy

Course source controls:

- scope;
- course-specific definitions and terminology;
- notation;
- claims the course expects the learner to know;
- examples explicitly attributed to the course;
- assessment premises and grading truth.

AI teaching may add:

- prerequisites;
- intuition;
- analogies;
- worked examples;
- derivations;
- comparisons;
- likely misconceptions;
- transfer examples;
- alternate phrasings and explanations.

When generated knowledge conflicts with verified course truth, course truth wins for this course. The Tutor should state the course convention and may separately note that broader usage differs, clearly labeled as AI teaching.

### 13.2 Conversation presentation

Avoid turning every sentence into badge noise. Use two clear layers:

- course claims carry inline citation chips that open the exact SourceBlock and heading context;
- an unobtrusive message-level label indicates that the Tutor's explanation may include AI-generated teaching beyond the source.

When the learner asks “where does the course say that?”, the Tutor must either return a verified citation or say that the explanation is an AI-provided enrichment and is not stated in the source.

The source drawer shows:

- document and heading path;
- exact verified quotation;
- surrounding SourceBlock context;
- whether the quotation was cited for a course claim or merely supplied teaching context.

For a course claim the drawer says: “Exact location locally verified; semantic support not independently proven.” It must not label entailment as locally validated.

Exact quotation validation establishes that the quoted text exists at the claimed source position. It does not independently establish full semantic entailment. UI copy, provider prompts, and evaluation must preserve this distinction.

### 13.3 Validation outcomes

- A valid course citation is displayed as source-backed.
- An invalid citation on an optional explanatory sentence is removed and the sentence is labeled AI teaching.
- An invalid citation for a required course claim causes response rejection or bounded repair.
- A detected conflict with course truth suppresses the conflicting claim and returns a safe course-grounded response or failure.
- Missing source coverage does not prevent a clearly labeled general explanation, unless the response is being used for formal assessment truth.

This policy avoids both source-only RAG and ungrounded course claims.

The exact-quote validator cannot itself detect semantic contradiction or prove entailment. The smallest scope relies on structured separation of course claims and enrichment, verified citations for course claims, provider instructions, and explicit learner correction. A separate semantic contradiction check would be another model operation; it should be added only if measured conflicts justify its cost, and its result would remain advisory to local citation integrity.

## 14. Runtime cost model

### 14.1 Cost principle

Use deterministic code whenever language intelligence is unnecessary. Generate once and persist when content is reusable. Spend model calls where conversation, semantic generation, or semantic grading provides learner value.

Cost must be visible as a product-quality dimension, not treated only as infrastructure billing.

### 14.2 Operation classification

| Operation | Frequency class | Expected model calls | Cache and persistence | Value justification |
| --- | --- | ---: | --- | --- |
| File extraction, SourceBlocks, heading trie | one-time course setup | 0 | Persist source and fingerprint | Deterministic parsing and structure |
| Section-aware concept extraction | one-time course setup | one per extraction section | Existing concepts persisted; rerun only for explicit deepening or source revision | Semantic concept identification |
| Structural concept mapping | one-time course setup | 0 | Derive deterministically; fingerprint inputs and mapping-algorithm version | Local source structure is sufficient |
| Curriculum proposal | one-time course setup | normally 1 per bounded source fingerprint and prompt version | Immutable CurriculumVersion | Converts source structure into pedagogical units |
| Graph generation | cached/reusable, optional | 0 when valid cached graph exists; normally 1 logical generation call | Existing GraphVersion | Useful for prerequisites/exploration, not required to start |
| Alignment | cached/reusable, optional | 0 or 1 logical call when nonlocal candidates require it | Existing alignment persistence | Cross-source comparison, not normal Tutor cost |
| Goal intake controls | one-time goal setup | 0 | Persist draft/confirmed goal | Structured fields need no model |
| Natural-language goal interpretation | one-time goal setup | 0 or 1 | Persist editable interpretation | Convenience only |
| Initial StudyPlan | per accepted goal | normally 1 over the compact in-scope curriculum | Immutable proposed/accepted version | Goal-specific order and rationale |
| Meaningful replan | per meaningful replan | 1 | Successor plan version | Worth paying only when evidence changes strategy |
| Free-form plan-edit interpretation | per learner-requested semantic edit | 0 or 1 | Persist proposed diff; structured edits cost zero | Convenience without silent mutation |
| Lesson material | per unit or concept, on demand | existing one call when absent | Existing LessonCard cache | Reusable teaching seed; never pre-generate all |
| Tutor response | per conversational turn | 1 logical call | Persist turn; idempotent clientTurnId | Core adaptive interaction |
| Low-stakes check | per conversational turn | 0 additional | Fold into Tutor response | No reason for a separate call |
| Formal assessment generation | per assessment | 1 | Persist quiz and blueprint | Creates auditable evidence opportunity |
| Remediation-plan proposal | per evidence-backed repair when existing plan is insufficient | 0 or 1 | Persist current validated remediation plan | Narrow targeted repair |
| Remediation quiz generation/repair | per launched remediation assessment | 1 logical generation call; physical repair attempt only when validation requires it | Persist quiz and blueprint | Formal repair evidence |
| Multiple-choice grading | per assessment | 0 | Existing attempt persistence | Deterministic |
| Text-answer grading | per semantic answer | existing one call per nonblank short_answer or concept_comparison answer | Persist grade; duplicate submission protected | Semantic evidence requires intelligence |
| Misconception proposal | per assessment | existing bounded calls, currently up to two | Existing validated persistence | Useful only after formal evidence |
| Completion decision | per assessment | 0 | Append decision | Deterministic policy |
| Today's agenda and next action | per view/session | 0 | Recompute from persisted state | Deterministic ordering |
| Rolling conversation summary | per conversational turn | 0 additional | Fold into Tutor response | Bounds future context without another call |
| Progress and cost reporting | per view/session | 0 | Aggregate telemetry | Deterministic |

### 14.3 Likely expensive paths

The most expensive runtime paths are:

1. Tutor turns, because they scale with learner interaction and carry growing context.
2. Formal text-answer assessments. An eight-question semantic assessment can require one generation call, up to eight grading calls, and the existing bounded misconception calls—up to eleven logical calls before any schema-repair attempts.
3. Initial course extraction across many sections.
4. Synthesis generation and grading because their contexts span multiple units.
5. Accidental regeneration of curricula, plans, graphs, or all lesson cards.

The current Tutor planning loop can consume up to six proposal calls before launching an activity. It should be removed from the primary teaching path because those calls do not themselves answer the learner.

Curriculum and plan prompts receive compact headings, concept summaries, derived mapping membership, graph hints, and goal state—not full SourceBlock text. Initial configurable preflight bounds should include at most eight active document revisions, 120 concept summaries, 160 heading nodes, one verified excerpt of at most 240 characters per included concept, and the lower of 24,000 estimated input tokens or the provider context budget after output and repair reserve. Curriculum output is bounded to 60 units and five objectives per unit. StudyPlan input uses at most those 60 unit summaries and 16,000 estimated input tokens, with no raw SourceBlocks.

These starting values are tuning parameters, not claims about pedagogical sufficiency. If a course exceeds them, split curriculum proposal by deterministic top-level source partitions and assemble locally, recording every partition call and any cross-partition prerequisite warning. Prefer narrowing the learner-confirmed scope for StudyPlan generation; do not send an unbounded workspace or conceal a multi-call hierarchy behind a claimed single call.

For a typical unit session:

    logical calls
      = T Tutor turns
      + 1 assessment generation
      + F nonblank text answers
      + up to 2 misconception proposals
      + R meaningful replans

where T is conversation length, F is the number of semantic text answers, and R is normally zero. A structured schema-repair attempt can make a logical call consume a second HTTP request and must be counted separately.

### 14.4 Caching and idempotency

Cache keys should include the smallest relevant fingerprint:

- extraction: document revision + extraction section + provider/prompt version;
- curriculum: included material revisions + compact concept payload + mapping-algorithm version constant + prompt version;
- plan: goal revision + curriculum version + learner-state snapshot + prompt version;
- lesson: concept and evidence fingerprint + prompt version, matching the current one-card-per-concept persistence;
- assessment: an idempotency key for the same creation request or attempt, not a cross-attempt answer-bearing cache;
- Tutor retry: run ID + clientTurnId + context fingerprint.

Never return cached Tutor text for a different learner message or state. A successful duplicate clientTurnId returns the exact persisted response. A pending duplicate attaches to or reports the existing operation.

Persisted assessment questions may be reused to resume the same attempt. A fresh formal retake should generate or select unseen valid questions when reusing the old answers would weaken the evidence; cost caching must not invalidate the checkpoint.

A cache-key design is not a cache. generation_jobs claims persisted reusable artifact work before provider calls and uses unique scope/fingerprint constraints so concurrent equivalent requests deduplicate. Tutor exchanges and grading submissions are their own persisted claims. A failed generation may be retried under an explicit new attempt without overwriting a ready result.

### 14.5 LLM observability

Add one append-only llm_calls row per logical operation or cache lookup and one llm_attempts row per physical provider request.

The logical row carries:

- operation;
- workspace, StudySession, goal, plan, unit, Tutor run, assessment, or extraction scope IDs where relevant;
- prompt and schema version;
- cache-key hash and hit, miss, or bypass;
- idempotency and correlation IDs;
- final logical status and aggregate tokens/cost.

Each attempt row carries:

- logical_call_id, attempt number, and initial, schema_repair, or grounding_repair kind;
- provider and model;
- actual input, cached-input, and output tokens when reported;
- local token estimates and an estimated flag otherwise;
- latency and success/failure classification;
- configured pricing snapshot;
- cost in integer micro-units and currency, or unavailable;
- timestamp.

The current Hy3Provider response type retains choices but discards usage. It should parse OpenAI-compatible usage when available. If token usage or pricing is unknown, the UI must show tokens and “cost unavailable,” not invent precision.

Expose aggregates for:

- LLM call and HTTP-attempt counts;
- cache hit and miss rates;
- input, cached-input, and output tokens;
- estimated setup, session, unit, assessment, and course cost;
- schema and grounding repair rates;
- provider failure rate;
- p50 and p95 latency.

The learner-facing UI needs a compact session estimate and actual usage summary. Detailed call records can remain a developer or evaluation view.

The estimate is a range with assumptions, not a false point value: configured pricing × bounded context/output estimates for the planned checkpoint plus an explicitly shown conversational allowance, such as four Tutor exchanges. The learner can change that allowance or continue past it after a soft warning. Actual cost replaces the estimate as attempts complete. If pricing is unavailable, show expected calls/token ranges only.

### 14.6 Cost guardrails

- Do not automatically generate all lesson cards.
- Do not automatically regenerate a graph to create a curriculum.
- Do not model-rank today's queue.
- Do not call a model merely to decide completion.
- Do not summarize conversation in a second call.
- Do not replan after routine progress.
- Make long optional Tutor detours visible against the session budget.
- Allow a configurable soft session-cost warning and hard provider budget without pretending cached or local fallback is equivalent.

A cost cap may pause optional enrichment. It must not silently lower formal grading validity or fabricate a model response.

## 15. Data-model changes

### 15.1 Reuse Workspace as Course

Do not add a Course table. The existing Workspace already owns documents, graph state, plans, assessments, Tutor history, and learning state. Add learner-facing course metadata only where the product needs it, and display Workspace as Course in the new IA.

### 15.2 New persistent entities

#### material_revisions and reference lineage

Purpose: stage reprocessing without deleting the learner history that currently cascades through SourceBlocks and concepts.

Key fields:

- material_revisions: id, material_id, revision number, content hash, parser/extraction version, status: staging, active, retired, and timestamps;
- source_blocks and concepts gain material_revision_id;
- materials gains active_material_revision_id and retired_at;
- source_block_lineage records old/new block IDs only for deterministic exact normalized-text and compatible location matches;
- concept_lineage records old and new concept IDs, deterministic match method, confidence class, and review status.

Current rows are backfilled into one active revision per material. Reprocessing writes a staging revision, completes and validates extraction, then swaps the active pointer. It never begins by deleting the active revision. Deterministic one-to-one block and concept lineage—such as exact normalized quotation plus compatible heading context, followed by normalized concept identity—supports historical display and successor-goal/curriculum proposals. Ambiguous semantic similarity may be proposed for review.

The safe first version transfers no learner state automatically, even for exact lineage:

- old mastery, mistakes, misconceptions, review items/events, assessments, completion/progression evidence, and Tutor observations remain attached to the retired concept as historical;
- new concepts begin without active mastery or completion evidence;
- old LessonCards, GraphVersions, and alignment overlays remain historical; they may be regenerated or explicitly revalidated against new active evidence, never aliased silently;
- Progress may display the lineage and previous evidence, but queue, completion, grading, and Tutor context cannot count it as current;
- the learner can run a short formal diagnostic to re-establish evidence efficiently.

This avoids double-counting or silently mutating deterministic learner state. A future state-transfer policy would require a separate auditable design and is explicitly out of scope.

For every source-ready, non-retired material, exactly one authoritative active_material_revision_id must reference a revision whose status is active; a first-import material may have only a staging revision until parsing succeeds. A transaction swaps the pointer and retires the predecessor. All ordinary repository reads are active-revision-only by default. Graph, alignment, mapping, assessment, queue, current mastery/review, lessons, and Tutor context must opt into explicit historical queries to see retired rows. This prevents retained history from leaking into current study.

GraphVersion stores its included material-revision IDs and input fingerprint. A graph over retired or changed required revisions is historical and cannot supply active prerequisites or Tutor context; an unrelated added document merely makes it incomplete for the expanded course. Alignment and lesson payloads follow the same active-input freshness rule.

#### curriculum_versions

Purpose: immutable learner-visible structure over existing source and concept IDs.

Key fields:

- id, workspace_id, version;
- generation_status: generating, ready, failed;
- included material revision IDs and source fingerprint;
- idempotency key, prompt version, provider metadata;
- curriculum JSON validated by shared schemas;
- predecessor_version_id;
- created_at, activated_at.

Add active_curriculum_version_id to workspaces. Activate a ready version transactionally with an expected-current pointer. Freshness is derived as current, has_unincorporated_additions, or partially_invalid by comparing its included revision set and required references with active course content; it is not overloaded into generation_status.

#### learning_goals

Purpose: confirmed learner intent and constraints.

Key fields:

- id, workspace_id;
- revision and lifecycle_status: draft, confirmed, closed, archived;
- terminal_outcome: achieved, finished_with_gaps, abandoned, superseded, or null;
- structured intent, depth, outcome text, deadline, availability, self-report, and optional assessment context;
- stable logical scope_definition plus pinned scope_snapshot of material revisions/source anchors—not version-local LearningUnit IDs;
- parent_goal_id and scope-resolution diff for successor confirmation;
- provenance;
- created_at, confirmed_at, archived_at.

Add active_learning_goal_id to workspaces. When no active goal/plan exists, confirming the initial goal may set the pointer. When replacing an active pair, confirmation leaves the successor as confirmed but pending activation and permits StudyPlan proposal against it. Accepting that successor plan transactionally:

1. verifies the expected old active goal/plan and successor confirmed goal;
2. accepts the new plan;
3. swaps active_learning_goal_id and active_study_plan_id together;
4. supersedes the old plan and closes/archives the old goal with terminal_outcome=superseded;
5. marks any open old-plan StudySession plan_superseded.

If any check fails, neither pointer changes. A failed or abandoned successor proposal never displaces the old pair.

#### study_plans

Purpose: immutable proposed and accepted execution contract.

Key fields:

- id, workspace_id, learning_goal_id, curriculum_version_id;
- version, lifecycle_status: proposed, accepted, superseded, finished;
- terminal_outcome: completed, finished_with_gaps, or null;
- derived execution_validity: valid, partially_blocked, replan_recommended;
- parent_plan_id, replan_reason, idempotency key;
- plan JSON and locally computed total minutes;
- PaceBaseline JSON and scheduling algorithm version when timing is sufficient;
- source, state, provider, and prompt fingerprints;
- created_at, accepted_at, superseded_at.

Add active_study_plan_id to workspaces. A needs-replan condition changes derived execution validity and records reasons; it does not make the accepted plan cease being the active plan. Acceptance swaps the pointer transactionally with expected goal, curriculum, and previous-plan versions.

#### study_plan_progress

Purpose: mutable execution state per plan item without rewriting the plan.

Key fields:

- plan_id, item_id;
- status: blocked, available, in_progress, completed, deferred_not_completed;
- actual_minutes;
- started_at, last_active_at, completed_at, deferred_at;
- latest_progression_decision_id;
- optional active_remediation_plan_id, repair status, and triggering formal evidence;
- unmet objective IDs and bounded pause metadata.

#### unit_progression_decisions

Purpose: append-only audit of why an item completed, continued, or advanced only by explicit defer.

Key fields:

- id, workspace_id, goal_id, plan_id, item_id;
- curriculum_version_id and unit IDs;
- trigger_kind: formal_grade or learner_defer;
- triggering quiz and grading-result IDs, nullable only for learner_defer;
- evaluated CompletionRule and qualifying evidence IDs;
- result: completed, continue, deferred_not_completed;
- unmet objective IDs, defer reason and consequence, policy_version, created_at.

Use a uniqueness constraint on grading_result_id plus plan_id plus item_id plus policy_version for formal evidence and a separate idempotency key for learner defer.

#### study_sessions

Purpose: durable learner study episode spanning the selected Today agenda, Tutor dialogue, review, and formal checkpoint so pause/resume, actual time, useful-session metrics, and cost attribution have one boundary.

Key fields:

- id, workspace_id, goal_id, plan_id;
- agenda snapshot, persisted entry states/cursor, and requested session-minute budget;
- current item and agenda-entry IDs;
- status: active, paused, completed, abandoned, plan_superseded;
- learner-visible outcome summary and useful-session evidence references;
- source/plan context fingerprint;
- created_at, last_active_at, ended_at.

A StudySession is not a second plan. It records execution of an agenda snapshot. One local learner may have at most one open StudySession—active or paused—per workspace in the first scope. Accepting a successor plan marks an open session tied to the old plan plan_superseded; its transcript remains readable, but resuming formal work creates a new session against the successor.

StudySession activity timestamps are the source for measured time. StudyPlanProgress.actual_minutes is a local rollup across linked sessions, not a second independently edited clock.

#### tutor_exchanges

Purpose: learner-facing transcript plus one idempotent learner-request/assistant-response operation.

Key fields:

- id, tutor_run_id, study_session_id, sequence, client_turn_id;
- learner_text persisted before provider work;
- status: pending, interrupted, completed, failed, cancelled, domain_stale;
- expected prior sequence and context fingerprint;
- lease token, lease expiry, and attempt count while pending;
- assistant_payload, teaching move, safe error, and usage correlation;
- created_at, completed_at.

Use a uniqueness constraint on tutor_run_id plus client_turn_id and enforce at most one pending exchange per run. Two different clientTurnIds claiming the same prior sequence conflict instead of forking the transcript. On success, assistant payload and rolling summary update commit together; on failure, the learner request remains retryable.

#### generation_jobs

Purpose: claim a costly durable semantic operation before provider work, deduplicate concurrent requests, expose setup/proposal status, and link a successful domain result to its cost.

Key fields:

- id, workspace_id, operation, idempotency_key, request_fingerprint;
- status: pending, running, interrupted, succeeded, failed, cancelled, domain_stale;
- lease owner/token, heartbeat_at, lease_expires_at, and attempt count;
- logical_call_id;
- result_type and result_id;
- safe error and created/started/completed timestamps.

Use a unique workspace/operation/idempotency key and a scoped unique pending/running request fingerprint. Every persisted reusable semantic artifact—extraction section, graph, alignment, lesson, remediation plan/quiz, Curriculum, StudyPlan/replan or semantic-edit interpretation, checkpoint, and optional goal interpretation—should insert or claim this row transactionally before provider work. A concurrent duplicate observes the same job. The validated immutable domain result and succeeded job linkage commit atomically; retry behavior is explicit and never relies only on detecting a duplicate after paying twice. TutorExchange and grading submission rows are the equivalent claims for per-turn and per-answer work.

Startup and claim-time recovery mark expired pending/running leases interrupted and retryable. The same idempotency key may take a new lease only after expiry; a fencing token prevents an old worker from committing over the new owner. The external provider cannot guarantee exactly-once billing after a crash between request and response, so a takeover may repeat a physical call. Record the orphaned attempt as outcome_unknown, expose that cost uncertainty, and guarantee exactly one accepted domain result/state transition locally.

#### llm_calls and llm_attempts

Purpose: distinguish one logical semantic/cache operation from every physical provider HTTP attempt so cost is neither hidden nor double-counted.

llm_calls records operation scope, logical_call_id, generation_job or TutorExchange correlation, cache state, final status, StudySession correlation, and aggregate tokens/cost. A cache hit has a logical row and zero attempts. llm_attempts records logical_call_id, attempt number and kind, provider/model, actual or estimated tokens, latency, pricing snapshot, cost, and failure classification. Neither stores raw prompts, responses, or hidden reasoning.

### 15.3 Evolve existing entities

#### tutor_runs and tutor_events

Add run kind: legacy_planning or teaching. Teaching runs reference StudySession, goal, StudyPlan, item, and unit context and store a bounded rolling summary.

The current tutor_runs.plan_id is a remediation-plan ID. Preserve that meaning by renaming it to remediation_plan_id during the rebuild or by treating it as an explicitly legacy column; add a separate study_plan_id. Do not reinterpret old values.

The current concept_id is non-null and cascades on concept deletion. Rebuild the table so teaching and synthesis runs can have nullable concept context and preserved historical snapshots. Prefer SET NULL plus snapshotted course, unit, concept-name, and objective display fields over cascading away course-study history.

Current server startup marks all running Tutor runs interrupted because a legacy run lasts one request. Restrict that repair to legacy_planning runs and genuinely pending exchanges. A teaching run awaiting the learner or paused must survive restart.

tutor_events remains the optional safe audit timeline. It is not the primary conversation transcript.

#### quizzes and blueprints

Add optional curriculum, plan, item, unit, objective, StudySession, permitted-materials policy, and checkpoint-kind context. Old quizzes remain valid with null learning context. They may inform planning through current mastery but cannot automatically satisfy new objective-specific completion rules. Extend the blueprint with one primary objective ID and controlled evidence kind while preserving existing question IDs, grounding, and grading compatibility.

Checkpoint creation uses generation_jobs and persists quiz, blueprint, context, and result linkage atomically. Extend submissions with client_submission_id, grading status, lease/fencing token, heartbeat/expiry, and attempt count. The server claims the submitted answers before semantic grading, allows only one live claim per quiz/client key, and returns the existing pending or completed grading result on retry. Expired grading claims become interrupted and may be resumed under the same key; a unique grading result and fenced learner-state transaction allow only one local commit even if an external grading call must be repeated after a crash. This evolves the current duplicate-rejection safeguard into authoritative response replay.

#### workspaces, materials, and source revisions

Adding a document leaves the frozen accepted plan executable and marks the new revision “not yet incorporated.” Deleting, retiring, or reprocessing a required revision blocks only items whose required concept or source references are no longer active. Unaffected items continue. A failed successor curriculum or plan never disables otherwise valid work.

Immutable curriculum, plan, Tutor, and progression payloads retain bounded display snapshots: document title, heading path, concept and unit names, objectives, and cited quotation metadata. If an explicit document deletion removes source text, history remains readable but labels the quotation unavailable; it must not pretend that live verification is still possible.

### 15.4 Why LearningUnit can live inside a versioned document

The current course scale is small and bounded. Curriculum nodes are immutable projections whose history must travel together. Storing the hierarchy as validated JSON in CurriculumVersion:

- avoids a second mutable graph registry;
- makes activation atomic;
- simplifies preservation of old plans;
- matches existing versioned graph and plan patterns;
- keeps concept IDs as the canonical knowledge identity.

Progress and completion require relational rows because they mutate independently and need queryable uniqueness and transactions.

## 16. Service, provider, and API changes

### 16.1 New or evolved domain services

#### CourseOutlineService

- builds the deterministic headingPath trie;
- attaches documents, blocks, and current structural mappings;
- computes source fingerprints;
- supplies deterministic fallback units.

#### CurriculumService and CurriculumValidator

- claims a generation job and requests one provider proposal where enabled;
- validates all references, coverage, bounds, evidence, and prerequisites;
- persists immutable versions;
- activates only ready valid versions;
- preserves prior active data on failure.

#### LearningGoalService

- validates structured intake and scope;
- optionally interprets natural language through a provider;
- requires learner confirmation;
- supports confirmed-pending successor goals and one pointer-selected active goal without deleting history.

#### StudyPlanningService and StudyPlanValidator

- claims a generation job, then proposes and validates initial or successor plans;
- computes totals locally;
- persists immutable versions and acceptance;
- carries only objective-compatible evidence from the same active revision set forward; retired-revision evidence remains historical;
- returns a human-readable diff for replans;
- atomically swaps the successor goal/plan pointers only when the successor plan is accepted.

#### SessionAgendaService

- combines accepted plan progress, due review, unfinished work, prerequisites, and available minutes;
- returns a deterministic Today agenda and “why now” evidence;
- never calls a model.

#### StudySessionService

- snapshots the selected agenda and minute budget;
- owns persisted agenda-entry skip, advance, and server-side repack transitions across review, attached repair, LearningUnit, and checkpoint activities;
- records pause/resume/end and actual time;
- supplies the correlation boundary for Tutor, assessment, usage, and useful-session evaluation;
- never treats the session itself as completion evidence.

#### TutorContextAssembler and ConversationService

- assemble bounded immutable context;
- enforce context fingerprints;
- insert an idempotent pending TutorExchange before provider work;
- call respondTutorTurn once;
- validate citations, moves, IDs, and actions;
- atomically add the assistant payload and summary only on success, while retaining failed learner requests;
- never mutate formal learner state.

#### CompletionService

- evaluates CompletionRule against formal evidence;
- appends progression decisions;
- reconciles committed grades into plan progress and availability in a separate idempotent local transaction;
- records only a needs-replan flag and evidence reason when warranted;
- never calls StudyPlanningService or any provider inside grading/progression transactions.

#### PlanOutcomeService

- deterministically evaluates completed versus finished_with_gaps;
- closes the goal with achieved, finished_with_gaps, or abandoned;
- closes or supersedes any open StudySession consistently with the terminal plan;
- enforces pinned-scope, required-synthesis, blocked-item, and deferred-not-completed rules;
- computes and evaluates versioned PaceBaseline state without a model call.

#### LlmUsageService

- observes logical provider calls, cache events, and physical repair attempts;
- records tokens, cache state, latency, and estimated cost;
- returns course and session aggregates.

#### GenerationJobService

- transactionally claims or returns existing costly generation work;
- links one job to its logical LLM call and commits the immutable domain result plus succeeded linkage atomically;
- exposes durable pending/succeeded/failed status;
- prevents concurrent requests from paying twice for any persisted reusable semantic artifact.

### 16.2 Existing services to extend

- analysis.ts: write staged material revisions, expose source/concept fingerprints, and retain additive extraction.
- graph.ts and graph validation: supply advisory prerequisites and connections; do not own plan order.
- mapping.ts: continue structural mapping and feed CourseOutlineService.
- assessment.ts: accept unit and synthesis learning context, validate evidence-kind coverage, and persist quiz, blueprints, plan context, and idempotency state atomically.
- grading.ts: remain the only mastery/mistake/misconception/review mutation path; after its transaction commits, invoke idempotent progression reconciliation and surface a pending state if that second transaction fails.
- queue.ts and activityLaunch.ts: become inputs to SessionAgendaService and formal checkpoint launch, rather than a competing curriculum.
- lessons.ts: return cached material as optional Tutor context; generation remains on demand.
- tutor.ts: retain legacy-run reading while moving primary teaching behavior to the conversation path.
- workspaces.ts and materials.ts: stage source revisions, atomically activate valid replacements, retire removed source, preserve history snapshots, and derive item-scoped validity.

Domain logic remains outside route handlers and React components.

### 16.3 Provider contract

Extend the existing compatible provider interface with the smallest new semantic operations:

- proposeCurriculum;
- optionally interpretLearningGoal;
- proposeStudyPlan, with initial and replan reason in one contract;
- respondTutorTurn.

Reuse existing:

- analyze;
- graph generation;
- lesson generation;
- assessment generation;
- grading;
- misconception proposal;
- remediation where a targeted repair still needs it.

The fake and Hy3 providers must implement identical runtime-validated payloads. Fake responses remain deterministic and never use an external API.

ProviderCallOptions should accept correlation and trace metadata. Provider results should report usage when available. Domain services should not depend on provider-specific HTTP response shapes.

The current proposeTutorStep contract may remain for legacy histories during migration, then be retired from new UX. Do not place a new tool-calling “agent” behind respondTutorTurn.

### 16.4 API surface

Use workspace-scoped course-study routes, for example:

- GET /api/workspaces/:workspaceId/course-home
- GET /api/workspaces/:workspaceId/course-setup
- POST /api/workspaces/:workspaceId/course-setup/prepare
- GET /api/workspaces/:workspaceId/generation-jobs/:jobId
- GET /api/workspaces/:workspaceId/curriculum
- POST /api/workspaces/:workspaceId/curriculum/generate
- POST /api/workspaces/:workspaceId/curriculum/:versionId/activate
- GET and POST /api/workspaces/:workspaceId/learning-goals
- POST /api/workspaces/:workspaceId/learning-goals/:goalId/revise
- POST /api/workspaces/:workspaceId/learning-goals/:goalId/confirm
- POST /api/workspaces/:workspaceId/study-plans/propose
- POST /api/workspaces/:workspaceId/study-plans/:planId/edits/validate
- POST /api/workspaces/:workspaceId/study-plans/:planId/accept
- POST /api/workspaces/:workspaceId/study-plans/:planId/replan
- POST /api/workspaces/:workspaceId/study-plans/:planId/finish
- GET /api/workspaces/:workspaceId/session-agenda
- POST /api/workspaces/:workspaceId/study-sessions
- GET /api/workspaces/:workspaceId/study-sessions/:sessionId
- POST /api/workspaces/:workspaceId/study-sessions/:sessionId/pause
- POST /api/workspaces/:workspaceId/study-sessions/:sessionId/resume
- POST /api/workspaces/:workspaceId/study-sessions/:sessionId/repack
- POST /api/workspaces/:workspaceId/study-sessions/:sessionId/entries/:entryId/skip
- POST /api/workspaces/:workspaceId/study-sessions/:sessionId/entries/:entryId/advance
- POST /api/workspaces/:workspaceId/study-sessions/:sessionId/end
- POST /api/workspaces/:workspaceId/study-sessions/:sessionId/tutor-runs
- GET /api/workspaces/:workspaceId/tutor-runs/:runId
- POST /api/workspaces/:workspaceId/tutor-runs/:runId/exchanges
- POST /api/workspaces/:workspaceId/tutor-runs/:runId/stop
- POST /api/workspaces/:workspaceId/study-plans/:planId/items/:itemId/checkpoints
- GET /api/workspaces/:workspaceId/submissions/:clientSubmissionId
- POST /api/workspaces/:workspaceId/study-plans/:planId/items/:itemId/defer
- GET /api/workspaces/:workspaceId/progress
- GET /api/workspaces/:workspaceId/source-blocks/:blockId
- GET /api/workspaces/:workspaceId/llm-usage

Exact grouping should follow existing route conventions. Generation endpoints expose durable job status, use persisted idempotency keys, and can detach from navigation. A successor goal's confirm response explicitly says pending_activation; its plan proposal references that goal ID. Successor-plan acceptance carries expected old goal/plan pointers and atomically activates the new pair. Goal revision, plan validation/acceptance, session transitions, defer, checkpoint creation, and Tutor exchange mutations otherwise carry expected source/goal/plan/sequence versions. Confirmed mutations return authoritative state so the client can reconcile an ambiguous transport abort.

Tutor exchanges may use the existing NDJSON streaming transport only if structured completion and domain-stale validation remain reliable; token-by-token streaming is not required for the smallest scope. All Tutor read and mutation routes retain workspace scope and verify ownership.

Every response includes enough version and fingerprint data for the frontend to reject stale state.

## 17. Frontend information architecture and component disposition

### 17.1 Resolve the current split-brain context

App.tsx stores active material separately from GraphWorkspaceView's active workspace. Practice, Mistakes, and Mastery can therefore refer to a different material than the graph workspace.

The redesign should have one active Course/Workspace context at the application shell. Documents are children of that course. Every home, session, curriculum, progress, and graph request derives from the same workspace. A material selector appears only where document-level scope matters.

### 17.2 Primary navigation

Recommended learner navigation:

- Courses;
- Course Home;
- Study;
- Curriculum;
- Progress;
- Explore.

The Course header includes “Documents & settings” so source management never disappears behind ImportView. Mistakes and Review remain quickly reachable inside Progress and Today's agenda. Explore contains the graph and advanced source/alignment exploration. The primary action after course selection is Course Home.

### 17.3 Goal intake and plan acceptance wireframes

    ┌ What are you studying for? ─────────────────────────────────────┐
    │ [Build understanding] [Prepare for assessment] [Refresh]       │
    │ Outcome: ______________________________________________         │
    │ Deadline: ______  Total time: ____  Session: ____ minutes      │
    │ Depth: [Essential] [Standard] [Deep]                            │
    │ Scope: whole course / selected source sections                 │
    │ Prior knowledge and exam context: _______________________       │
    │                                        [Confirm learning goal] │
    └─────────────────────────────────────────────────────────────────┘

    ┌ Review your StudyPlan ──────────────────────────────────────────┐
    │ Expected total: 3 h 40 m · fits 3-day budget                   │
    │ 1  System position       25 m  required  Why: foundation       │
    │ 2  RAG pipeline          30 m  high      Why: connects stages  │
    │ 3  Section synthesis     15 m  required                        │
    │ ...                                                             │
    │ [Adjust scope] [Change depth] [Validate edits] [Accept plan]   │
    └─────────────────────────────────────────────────────────────────┘

Natural-language interpretation produces the same editable fields. A replan uses the plan view as a before/after diff with retained completed items, added/removed/moved items, time delta, trigger evidence, and “Keep current plan” beside “Accept successor.”

### 17.4 Course Home wireframe

    ┌ Course: WeKnora Architecture ────────────────────────────────────┐
    │ [Documents & settings]                         [Switch course]  │
    │ Goal: prepare for exam · 3 days · 2 h/day          [Edit goal] │
    │ 3 h 40 m planned · 1 h 20 m completed · on track               │
    ├ Today's session ────────────────────────────────────────────────┤
    │ I have [50] minutes now                              [Update]   │
    │ 10 min  Due review: vector invalidation                        │
    │ 30 min  Current unit: RAG overall pipeline                     │
    │         Why now: prerequisite for retrieval and reranking      │
    │ 10 min  Unit checkpoint                                       │
    │                                              [Continue study]  │
    ├ Plan progress ─────────────────────────────────────────────────┤
    │ Chapter 1  3/3   Chapter 2  1/4   Next synthesis after Unit 6 │
    ├ Needs attention ───────────────────────────────────────────────┤
    │ 1 open misconception · 2 due reviews · latest checkpoint 72%  │
    ├ Usage ─────────────────────────────────────────────────────────┤
    │ Today's estimated model cost / calls           [Details]      │
    └─────────────────────────────────────────────────────────────────┘

The page must distinguish estimated study time from estimated API cost.

Course Home is also the setup and recovery controller:

| State | Primary message and action |
| --- | --- |
| No documents | Explain the course boundary; Add documents |
| Source parsing/rereading failed | Preserve prior valid revision; inspect error and retry |
| Source ready, concepts absent | Explain setup call estimate; Prepare course |
| Analysis or curriculum running | Durable progress; learner may leave and return |
| Curriculum failed, fallback available | Use source-derived outline or retry proposal |
| No goal / draft goal | Complete or confirm goal |
| Confirmed goal, no plan | Generate plan |
| Proposed plan | Review/edit/accept; teaching stays locked |
| Active valid plan | Show Today and Continue study |
| Plan has unincorporated additions | Continue unaffected work or review refresh |
| Plan partially blocked | Continue unaffected items; repair source or review successor |
| Provider offline or cost cap reached | Cached/local options with honest limitations |
| All available work deferred or blocked | Explain each blocker; revise plan or revisit a defer |
| Goal achieved | Show outcome evidence, due review, and choose refresh/new goal |
| Plan finished with gaps | Never say achieved; show deferred/blocked gaps and choices to reopen, refresh, or start a revised goal |

### 17.5 Study Session wireframe

    ┌ Agenda / objectives ┐┌ Tutor conversation ─────────┐┌ Course truth ┐
    │ Unit 2 of 4         ││ Tutor explanation           ││ Source quote │
    │ ~30 minutes         ││ [Course citation 1]         ││ Heading path │
    │                     ││                             ││              │
    │ ● formally evidenced││ Learner: 为什么向量会失效？││ Related      │
    │ ◐ covered/informal  ││                             ││ concepts     │
    │ ○ not addressed     ││ Tutor: direct answer...     ││              │
    │                     ││ AI teaching · source chips  ││ Evidence     │
    │ Completion criteria ││                             ││ on demand    │
    │                     ││ [informal check card]       ││              │
    │ [Pause]             ││ Ask anything…        [Send]││              │
    │ [Formal checkpoint] │└─────────────────────────────┘└──────────────┘

On narrow screens, objectives and source become drawers. The composer remains primary. Preset suggestions may exist as examples but never replace free text.

Continue study starts or resumes a StudySession from the deterministic agenda. It dispatches item kinds in order: due review, attached repair, current LearningUnit, then planned checkpoint. The learner can skip a due review without changing the StudyPlan; it remains due. “I have N minutes,” skip, and advance invoke deterministic StudySessionService transitions and return a new persisted agenda cursor; React does not reproduce scheduling policy. Completing an agenda item returns to the next item in the same StudySession or to a concise session wrap-up.

The counted checkpoint replaces the Tutor composer with its permitted-materials instructions and questions. Its result view shows:

    Grade saved · Progress reconciled
    Objective A     passed · formal evidence
    Objective B     unmet · continue
    Unit status     in progress
    [Return to targeted Tutor teaching] [Review course evidence]

For a completed unit, the primary action becomes “Next available item.” For a replan trigger, show “Review proposed plan” only after a successor exists; never hide the saved grade behind generation.

### 17.6 Curriculum wireframe

    Curriculum                         Goal-specific plan
    一、系统定位与整体架构             1 h 10 m · 3/3 complete
      ✓ WeKnora 是什么                 15 m · completed
      ✓ RAG 整体链路                   30 m · completed
      ✓ 系统组件关系                   25 m · completed
      ✓ Section synthesis

    二、Embedding 与检索              2 h 20 m · 1/4 complete
      ✓ Embedding 语义表示             25 m
      → 向量相似度                     30 m · next
      ○ 模型切换与向量失效             25 m · requires previous
      ○ Top-K 与混合检索               40 m
      ○ Section synthesis              20 m

Selecting a unit shows objectives, source scope, prerequisite rationale, completion rule, evidence history, and “Study this unit.” An available unit can start or become the current agenda item. A locked unit is preview-only and explains its prerequisite. A completed unit opens review without changing plan order. An out-of-plan unit requires a learner-confirmed plan edit before it becomes formal work.

### 17.7 Progress and Explore

Progress has a compact overview and focused subviews rather than one dense wall:

- Overview: plan/curriculum completion and recent formal evidence;
- Reviews: due and completed review;
- Gaps: mistakes and misconceptions;
- Assessments: quizzes, unit and synthesis evidence, and history;
- History: old goals, plans, progression decisions, and source-version labels.

Mastery overlays appear where they aid these tasks instead of becoming another top-level control center.

Explore contains:

- searchable concept graph;
- dependency and relationship views;
- concept details and evidence;
- document mapping and alignment where useful.

Explore never hosts the main Tutor, Today agenda, or accepted plan.

Graph-to-curriculum navigation opens the concept's single primary LearningUnit by default and separately lists its bounded supporting occurrences. It never chooses an ambiguous unit silently.

### 17.8 Frontend operation ownership

| Operation class | Navigation behavior | Server behavior | Reconciliation |
| --- | --- | --- | --- |
| View read | Abort where possible and ignore response for old Course/view generation | No persistent work | Refetch in new context |
| Durable extraction/curriculum/plan job | Detach and poll only while visible | Continue for original Course unless explicitly cancelled or domain-invalid | Refetch status on return |
| Confirmed mutation: delete, reprocess, goal/plan acceptance, grade | Do not infer failure from an ambiguous abort | Apply once with idempotency and expected version | Refetch authoritative Course Home and affected resource |
| TutorExchange | Detach on navigation; explicit Stop is separate | Persist pending request, then response only if domain fingerprint remains valid | Resume by run/exchange ID |
| Evidence drawer selection | Abort/ignore older block selection | Read only the requested cited blocks | Render only if selection token still current |
| Course deletion | Close affected view immediately after confirmed success | Transactional scoped delete/archive rules | Return to Courses and select a surviving Course |

After grade reconciliation, refresh Course Home, agenda, Progress, and current item from one authoritative response or invalidation key. Plan acceptance conflicts if goal, curriculum, source scope, or active-plan pointer changed. Replan results that arrive after navigation persist to their original Course as proposals and never auto-activate.

### 17.9 Existing component disposition

| Existing component | Decision | Target role |
| --- | --- | --- |
| ImportView | EVOLVE | Course document management and setup progress; route into goal intake instead of a flat concept destination |
| GraphWorkspaceView | REMOVE / MERGE | Retire as the application shell; decompose useful document, graph, and detail pieces into Course and Explore views |
| Knowledge graph | DEMOTE IN UX | Secondary relationship explorer and backend prerequisite/context primitive |
| Concept detail overview | EVOLVE | Unit/context drawer showing concepts, learner evidence, relations, and source |
| Lesson cards | REUSE AS BACKEND PRIMITIVE | Cached teaching seed and optional reference; not the primary lesson experience |
| Source evidence | KEEP AS CORE | Inline verified course citations plus on-demand Course Truth drawer |
| Current “学习计划/康复计划” | REMOVE / MERGE | Keep remediation service as a narrow repair primitive; attach repair activity to progress/agenda or a successor plan, and remove the misleading course-plan label |
| TutorPanel | REMOVE / MERGE | Retire the current activity-planning UI; evolve its backend contracts and move audit details into the new TutorConversation disclosure |
| DailyQueue | REMOVE / MERGE | Retire the standalone component; reuse its deterministic queue service as one input to SessionAgenda |
| Quiz / Assessment | KEEP AS CORE | Evolve into formal state-changing checkpoints embedded in units and synthesis; keep advanced manual practice available |
| Mistakes | DEMOTE IN UX | Preserve the existing data and repair input; merge primary browsing into Progress |
| Mastery | REUSE AS BACKEND PRIMITIVE | Preserve calculations and overlays; present them through Progress and unit context |
| Review | DEMOTE IN UX | Keep scheduling behavior and data core; present due review in Today's agenda and the focused Progress subview |
| Alignment | DEMOTE IN UX | Preserve its backend and advanced Explore/setup use; remove it from the primary study path |
| Current graph network mode | DEMOTE IN UX | Optional visual exploration |
| Current graph dependency mode | EVOLVE | Most useful graph mode for prerequisite explanation and curriculum inspection |
| Current weak-path mode | REMOVE / MERGE | Express weak prerequisites as Today/plan rationale or graph highlight, not a separate primary mental model |
| Quiz history | REMOVE / MERGE | Fold into Progress and unit evidence history |
| Generic quiz configuration | DEMOTE IN UX | Advanced practice; planned checkpoints are the default |

This classification deliberately spends sunk-cost value where it is useful without preserving the current graph-centric mental model.

## 18. Migration and backward compatibility

### 18.1 Migration principles

- Use explicit SQLite migrations following the existing sequence and test upgrades from populated historical databases.
- Never run an LLM call inside a database migration.
- Preserve all existing concepts, graphs, grounding, lesson cards, quizzes, attempts, mastery, mistakes, misconceptions, review schedules, remediation plans, Tutor runs, and events.
- Add nullable learning-context fields so old records remain valid.
- Activate new generated state only after complete validation.
- Treat source deletion or revision as invalidation, not permission to erase historical learning evidence.

### 18.2 Suggested migration sequence

The exact migration numbers should be assigned when implementation begins after the current twelve migrations. A coherent sequence is:

1. Add material_revisions, active revision pointers, revision references on SourceBlocks/concepts, source-block and concept lineage, tombstone/snapshot fields, and backfill every current material as revision 1.
2. Add curriculum_versions and workspace active curriculum/goal pointers, then learning_goals.
3. Add study_plans, study_plan_progress, unit_progression_decisions, study_sessions, workspace active-plan pointer, and compatible quiz/blueprint learning context.
4. Rebuild tutor_runs for run kind, distinct remediation_plan_id and study_plan_id, nullable multi-unit context, and historical snapshots; preserve existing rows as legacy_planning and add tutor_exchanges.
5. Add generation_jobs, llm_calls, llm_attempts, submission idempotency/status, and required indexes.

Each migration should be independently transactional where SQLite permits and have an explicit rollback-free compatibility test through the current migration runner.

### 18.3 Existing-data behavior

- Every existing Workspace automatically appears as a Course. No duplicate record is created.
- Every existing document, SourceBlock, and concept is assigned to its backfilled active material revision without changing its ID.
- Existing concepts retain their IDs and continue to own mastery and graph overlays.
- Existing graph versions remain available in Explore and may assist a future curriculum proposal.
- Existing lesson cards are reusable Tutor context.
- Existing remediation plans remain historical or targeted repair records; they are not backfilled as StudyPlans.
- Existing quizzes and attempts have null curriculum/plan context and continue to display and affect current learner state exactly as before.
- Existing Tutor runs are labeled legacy planning runs and remain readable with their events.
- Existing workspaces receive no active goal or plan automatically.

On first visit, the product builds a deterministic source outline locally and asks for the learner's goal. It then invites the learner to run any missing concept/curriculum setup with a disclosed call estimate. This avoids surprise setup cost and fabricated intent.

### 18.4 Frontend preference migration

The current UI stores active material and active workspace independently. The new shell should migrate to one active workspace preference:

1. Prefer the last workspace if it still exists.
2. Otherwise find the workspace containing the last active material.
3. Otherwise select the most recently active workspace.
4. Never delete the old preference until the new context has been successfully established.

A Course switch cancels or ignores old-screen reads but merely detaches durable generation and Tutor work. It does not change the original operation's domain fingerprint. Explicit Stop or a real source/goal/plan mutation has the server semantics defined in Section 10.

### 18.5 Source changes

The current reprocessDocumentTx deletes old blocks, concepts, quizzes, mistakes, and mastery, while foreign-key cascades remove additional review, misconception, lesson, Tutor, submission, and grading history. That behavior cannot remain the reprocessing path once an executable plan exists.

For reprocessing:

1. Insert a staging MaterialRevision and its new SourceBlocks/concepts without touching the active revision.
2. Validate extraction and build deterministic SourceBlock/concept-lineage candidates.
3. Atomically switch the material's active revision only after success.
4. Retire, but do not cascade-delete, the old revision.
5. Use deterministic lineage for historical display and a proposed scope-resolution diff, not automatic learner-state transfer.
6. Create a successor LearningGoal draft when its pinned scope changed; require learner confirmation before a StudyPlan targets the replacement revision.
7. Mark only old-plan items whose required references changed as blocked or replan-recommended.

For adding a document:

- leave the current curriculum and plan executable over their frozen included-revision set;
- show “new material not yet incorporated”;
- offer a successor curriculum plus a goal-scope revision before the successor plan;
- require that refresh before declaring a whole-course goal complete, but do not stop unaffected study.

For removing a document from an active Course:

- retire it from active scope;
- retain minimal concept, unit, objective, and assessment display snapshots so history remains comprehensible;
- block only items that require its live evidence;
- label retired evidence historical.

Retiring the final active document transitions the Workspace/Course to no_documents and ends or supersedes open study execution; it does not hard-delete retained revisions through the current final-document cleanup path. Explicit deletion of the entire Course remains a separate destructive action.

If a future explicit permanent source purge is added, source text and quotations must be redacted while non-source learning-history metadata remains, labeled “source removed; live verification unavailable.” Reprocessing or removal must never cascade-delete a historical Tutor transcript.

## 19. Failure and fallback behavior

| Failure | Required behavior | Forbidden behavior |
| --- | --- | --- |
| Source parsing fails | Preserve previous valid material revision; show actionable document error | Partially replace SourceBlocks |
| Concept extraction fails | Preserve previous concepts; deterministic source outline may still display | Erase valid concepts |
| Curriculum generation or validation fails | Keep previous valid version, or use deterministic heading-order fallback | Activate malformed references |
| Graph absent or invalid | Continue with source order and validated curriculum | Block goal or plan creation |
| Goal interpretation fails | Return the structured form with original learner text intact | Guess and activate a goal |
| Source revision changes confirmed goal scope | Keep the old goal for unaffected work; require confirmation of a successor scope snapshot before replacement-source planning | Silently move the goal to new material |
| Plan generation fails | Keep accepted plan; for first plan offer conservative deterministic source/prerequisite order | Store prose as executable state |
| Concurrent duplicate generation request | Return the existing generation job/result and charge one logical operation | Start two provider calls before claiming work |
| Process crashes during provider work | Expire lease, mark interrupted, permit fenced same-key retry, and report possible duplicate external cost | Leave pending forever or accept two domain results |
| Plan edit breaks prerequisites or budget | Explain the conflict and require an explicit valid edit or defer | Silently reorder or ignore constraints |
| Tutor provider fails | Retain the learner turn as retryable; offer cached lesson and source; mutate no state | Invent an answer or duplicate on retry |
| Tutor response fails schema or grounding | Use one bounded repair; otherwise fail safely and preserve prior transcript | Parse important fields with regex |
| UI navigates away | Detach/ignore rendering; let valid durable work persist to its original Course | Treat navigation alone as domain invalidation |
| Learner explicitly stops a Tutor exchange/run | Request provider cancellation, mark cancelled if no valid response committed, retain the learner request | Append a later answer as current |
| Domain context changes in flight | Mark exchange domain_stale and reload current plan/unit context | Land an answer against changed source/goal/plan/state |
| Citation for optional enrichment is invalid | Remove attribution and label the content AI teaching if otherwise safe | Display it as course truth |
| Model or learner identifies a possible course conflict | Show verified course quotation, treat it as authoritative for the course, and repair/suppress the generated claim; disclose that semantic conflict detection is model-dependent | Claim exact matching proved contradiction or entailment |
| Formal generation or grading fails | Leave item unverified and all previous state unchanged | Complete a unit optimistically |
| Grade commits but progression reconciliation fails | Keep the grade and learner-state updates; report progress pending and retry idempotently | Roll back or duplicate the valid grade |
| Submission response is lost | Refetch by clientSubmissionId and replay the pending/completed authoritative result | Submit the same answers as a new attempt |
| Learner says “懂了” | Acknowledge and offer formal verification or continue teaching | Update mastery or completion |
| Learner wants to move on without evidence | Offer a checkpoint or an explicit documented defer | Pretend completion |
| Learner finishes with deferred/blocked work | Close as finished_with_gaps and preserve every gap | Label the plan completed or the goal achieved |
| Synthesis fails | Preserve completed units; record formal gaps and offer targeted repair | Reset the chapter |
| Replan fails | Keep the accepted plan and explain the trigger remains unresolved | Overwrite it with a partial proposal |
| Cost cap is reached | Use cached lesson/source/local agenda, pause optional calls, or ask learner to resume with budget | Secretly downgrade grading validity |
| Usage metadata is absent | Show token estimate or “cost unavailable” | Fabricate a precise price |

Fallbacks must be described honestly. A cached lesson is not a conversational response. A deterministic plan is not claimed to be personalized. An AI explanation without a source citation is not presented as course text.

## 20. Testing and evaluation strategy

### 20.1 Unit and schema tests

Add tests for:

- headingPath trie construction across multiple documents, skipped levels, repeated headings, empty headings, and synthetic extraction sections;
- staged MaterialRevision activation, deterministic lineage, zero automatic learner-state transfer, and retired-history rendering;
- active-revision-only default reads across graph/alignment/queue/state/Tutor and explicit historical opt-in;
- source and context fingerprints;
- Curriculum coverage, objective authority/coursePriority/grounding, synthesis objective identity, unknown IDs, duplicate membership, bounded supporting reuse, prerequisite cycles, evidence validity, and source-version mismatch;
- LearningGoal dates, budgets, logical scope/pinned snapshots, source-revision confirmation, terminal transitions, and model-interpretation validation;
- StudyPlan totals, PaceBaseline, prerequisite ordering, allowed defer policy, criteria feasibility, completed/finished-with-gaps outcomes, successor carry-forward, and diff generation;
- SessionAgenda time packing, review priority, unfinished-item preference, and deterministic “why now” reasons;
- StudySession agenda snapshot, time attribution, pause/resume/end, and outcome evidence;
- Tutor context relevance, token-bound truncation order, ID validation, teaching moves, and domain-stale fingerprints;
- pending TutorExchange persistence, expected-sequence conflicts, clientTurnId idempotency, and duplicate in-flight requests;
- generation-job pre-claim/concurrent deduplication and clientSubmissionId result replay;
- lease expiry, startup interruption, fenced takeover, old-worker rejection, and outcome_unknown cost accounting;
- CompletionRule evaluation for single-primary-objective evidence, semantic, stale, duplicate, legacy, and cross-plan evidence;
- synthesis coverage across multiple units;
- LLM usage parsing, cache classification, repair-attempt counting, token estimates, pricing snapshots, aggregation, and unavailable pricing.

### 20.2 Migration and repository tests

Test:

- a fresh database;
- upgrades from every supported historical migration;
- upgrade from a populated current database with graphs, lessons, quizzes, attempts, state, remediation plans, Tutor runs, and events;
- MaterialRevision backfill and tutor_runs rebuild without state/transcript/event loss or plan-ID ambiguity;
- staged source reprocessing, scoped invalidation, retirement, and workspace deletion with new foreign keys;
- GraphVersion input-revision freshness and final-document retirement to no_documents;
- unique active curriculum/goal/plan constraints;
- failed generation preserving the prior active version;
- committed grading followed by idempotent progression reconciliation, including retry after the second transaction fails;
- concurrent plan/checkpoint generation, two-phase successor-goal/plan pointer handoff, plan acceptance, grading replay, and duplicate TutorExchange submission.

### 20.3 Service and provider tests

Both fake and Hy3-compatible providers must satisfy the same contracts for curriculum, optional goal interpretation, plan, and Tutor response. Tests never call the real external API.

Cover:

- unknown and hallucinated IDs;
- invalid citations and exact-quote mismatch;
- schema-repair success and exhaustion;
- course-truth conflict handling;
- provider timeout and cancellation;
- usage present and absent;
- no state mutation from conversational or low-stakes turns;
- exactly one normal Tutor call per learner turn;
- meaningful versus routine replan triggers;
- source change while generation or conversation is in flight.

### 20.4 API and integration tests

The critical end-to-end path is:

    import and parse source
      → create/confirm goal while setup runs
      → generate/activate curriculum or fallback
      → propose/edit/accept plan
      → load Course Home and today's agenda
      → start/resume StudySession and Tutor run
      → ask natural follow-up
      → run low-stakes check without state change
      → launch formal unit checkpoint
      → grade and decide completion
      → unlock next item
      → complete multi-unit synthesis
      → trigger and accept a meaningful replan

Also test UI detachment versus explicit Stop, domain invalidation, deletion, workspace switching, duplicate submission, provider failure, invalid response, permitted-materials enforcement, budget cap, and fallback paths.

### 20.5 Frontend tests

Test:

- a single active Course across every view;
- goal intake and confirmation;
- editable plan diff and acceptance;
- Today agenda time and reason rendering;
- every Course Home setup/no-goal/no-plan/pending/fallback/blocked/completed state;
- transcript resume and idempotent retry;
- composer loading, error, cancellation, and stale-response states;
- clear informal-versus-formal check labeling;
- inline source chips and AI-teaching labels;
- Course Truth drawer exact context;
- closed-book evidence hiding and post-submit reveal;
- progress after evidence-based completion versus deferred_not_completed;
- curriculum hierarchy keyboard and narrow-screen behavior;
- graph navigation returning to the correct unit;
- course/document switch or deletion during every asynchronous workflow.

### 20.6 Evaluation layers

Retain the current fake evaluation for structural determinism and extend it with:

- curriculum reference and coverage checks;
- executable plan invariants;
- Tutor response schema and source-policy checks;
- no-state-change assertions for dialogue;
- completion and synthesis fixtures;
- model-call and cost accounting.

The real-provider evaluation remains optional and credentialed. It should measure contract validity, grounding, repair rate, latency, token usage, and cost. It must not be described as proof of teaching quality.

Teaching quality requires:

1. rubric-based transcript review by humans;
2. immediate objective-aligned checks;
3. delayed retention checks;
4. synthesis and transfer performance;
5. learner-reported clarity and value;
6. controlled comparison against a strong general conversational tutor.

Model-as-judge scoring may triage transcripts, but it cannot be the only outcome measure.

### 20.7 Exact verification commands for implementation rounds

Every implementation phase should run all applicable commands from the repository root:

- npm.cmd run build
- npm.cmd run lint
- npm.cmd test
- npm.cmd run demo:offline
- npm.cmd run demo:graph
- npm.cmd run demo:adaptive
- npm.cmd run eval:fake
- git diff --check
- git status --short

Run npm.cmd run demo:http when its documented local server prerequisite is active. Add and run npm.cmd run demo:study once the accepted-plan smoke script exists. Run npm.cmd run eval:hy3 only when explicitly performing credentialed provider evaluation, never as an ordinary deterministic test.

## 21. Product evaluation against ChatGPT

### 21.1 Evaluation design

Use two complementary comparisons:

**Ecological crossover**

The same learner studies matched sections of the same course with:

- Hy3 Study Clinic; and
- the current strong ChatGPT study experience with the same uploaded material and goal prompt.

Randomize product order and include at least systematic study and time-bounded assessment preparation. Compare immediate learning, delayed retention, synthesis, cost, perceived effort, and product preference.

**Same-model product-layer ablation**

Use the same underlying model and comparable prompts with:

- the Hy3 Study Clinic structured course/plan/evidence loop; and
- a plain conversational session without persistent executable state.

This isolates whether the product architecture adds value beyond model quality.

Do not claim superiority from schema validity or citation accuracy alone.

### 21.2 Core product metrics

A StudySession becomes “started” when its first agenda activity is displayed and becomes “eligible” for outcome metrics after the learner takes one substantive action. Pause is not abandonment; the persisted session may resume. Explicit end, completion, or an inactivity rule closes the measurement window. These definitions and versions are recorded with the metric.

#### Switch-to-general-chat rate

Definition: sessions in which the learner reports leaving to ask a course-study question in a general chat, divided by eligible Study Sessions.

Collect through a lightweight exit/return prompt or diary, not browser surveillance. Segment reasons: answer quality, breadth, latency, UX friction, and cost.

#### Useful study-session completion

Definition: sessions that advance or meaningfully attempt a planned objective, or intentionally pause with a preserved clear next step, and meet a minimum learner helpfulness threshold, divided by started sessions.

Do not count a session as useful merely because a Tutor call succeeded.

#### Plan adherence

Definition: eligible planned minutes or items completed within their planned window, divided by eligible accepted-plan minutes or items.

Exclude learner-approved pre-window plan edits and items made invalid by source changes. Keep explicit deferrals in the eligible denominator and report a separate defer rate so the metric cannot be improved by skipping difficult work. Report both item and time adherence.

#### Unresolved-question rate

Definition: learner-confirmed unresolved questions plus substantively repeated questions, divided by substantive questions asked.

An immediate “yes” is insufficient; sample delayed or end-of-session confirmation.

#### LearningUnit completion quality

Measure:

- immediate objective pass rate;
- delayed pass rate for units the system marked complete;
- synthesis/transfer performance;
- false-completion rate: completed units that fail a matched fresh check soon afterward;
- false-block rate: units held incomplete despite strong matched evidence.

#### API cost per useful session

Definition: total estimated provider cost attributed to eligible Study Sessions, including assessment and repairs, divided by useful sessions.

Also report cost per completed unit, per synthesis checkpoint, and per retained unit at delayed check. Separate one-time course setup cost from recurring study cost.

#### Learner-perceived value

Measure:

- “I knew what to study next”;
- “the Tutor resolved my questions”;
- “the plan fit my time and goal”;
- “the product remembered useful evidence across sessions”;
- willingness to return for the next session;
- forced preference versus general chat for this study task.

### 21.3 Supporting operational metrics

- time from import completion to accepted plan;
- first useful Tutor response latency;
- p50 and p95 turn latency;
- session resume success;
- curriculum and plan acceptance/edit rates;
- replan proposal and acceptance rates;
- cache hit rate;
- schema and grounding repair rate;
- stale/cancelled response rate;
- source-citation open rate, interpreted cautiously;
- formal checkpoint abandonment;
- cost-warning frequency.

### 21.4 Decision thresholds

Set numeric thresholds only after a small baseline cohort; avoid manufacturing targets without data. The continuation decision should nonetheless be explicit:

- Study Clinic must reduce uncertainty about the next action.
- It must achieve conversation helpfulness close enough to the comparison tutor that learners do not routinely switch away.
- Its completion decisions must predict delayed and synthesis performance better than self-report.
- Repeated-session value must offset API cost and setup friction.

If it cannot meet all four after focused iteration, narrow the product further or stop claiming a general serious-study advantage.

## 22. Smallest coherent implementation scope

The minimum useful release is a thin vertical learning loop, not a chat box added to GraphWorkspaceView:

1. Reuse Workspace as Course and unify the active-course frontend context.
2. Introduce staged material revisions so reprocessing cannot erase existing learner history.
3. Build one active versioned Curriculum from deterministic headings plus one validated model proposal and executable fallback.
4. Capture one confirmed LearningGoal using intent, depth, deadline, time, source scope, and self-report.
5. Propose, edit, and accept one versioned executable StudyPlan with ordered LearningUnits and one synthesis item.
6. Make Course Home, Today agenda, Curriculum, and Study Session the primary IA.
7. Persist one StudySession spanning its agenda, one current-unit Tutor run, and a formal checkpoint.
8. Support resumable natural-language Tutor exchanges with bounded context, source/AI distinction, and low-stakes checks that do not change state.
9. Launch one formal unit checkpoint through existing assessment/grading and make an idempotent evidence-based progression decision that unlocks the next item.
10. Run one multi-unit section synthesis checkpoint.
11. Support one evidence-triggered successor plan with a visible diff.
12. Record logical calls, physical attempts, cache state, tokens, latency, and estimated session cost.

Anything smaller fails to prove the proposed advantage:

- curriculum without conversation remains mechanical;
- chat without an accepted plan is a weaker general chat;
- plan without formal completion is generated prose;
- completion without synthesis remains concept-local;
- all of the above without cost telemetry cannot be judged as a daily product.

### Size and risk

This is an extra-large, high-integration product increment, even though it reuses most reliable primitives. A low-confidence order-of-magnitude for one experienced full-stack engineer is 18–28 engineer-weeks: R0 about 2–3, R1 about 3–5, R2 about 3–4, R3 about 4–6, R4 about 4–6, and R5 about 2–4, with some overlap but substantial integration. This excludes open-ended model-quality tuning, recruiting human comparison participants, and multiple dogfood iterations. Parallel work can reduce elapsed time but not the integration and evaluation burden.

Dominant risks:

- conversational quality and latency at acceptable cost;
- selecting enough context without flooding each turn;
- producing curricula and plans learners accept;
- preserving transaction and stale-response guarantees across longer-lived sessions;
- migrating the current Tutor history and unifying split frontend context;
- distinguishing apparent completion from durable learning.

The architecture risk is moderate because it extends established patterns. The product-validation risk is high because the differentiation depends on observed learner behavior.

## 23. What should explicitly not be built yet

Do not build:

- the old deferred phase as written;
- a general-purpose autonomous agent or a multi-model tool loop;
- a large deterministic pedagogical policy engine;
- DiagnosisSnapshot, a broad activity ontology, or a universal reason-code taxonomy;
- multidimensional mastery, BKT, IRT, or a second learner model;
- a second Course, concept, graph, grounding, grading, or persistence system;
- a vector database, LangChain, Neo4j, or semantic retrieval infrastructure;
- automatic full-course lesson-card generation;
- automatic replanning after every turn or score;
- mastery or completion inferred from conversation sentiment;
- open-web enrichment or browsing as normal teaching;
- voice, mobile apps, authentication, collaboration, classrooms, calendars, or notifications;
- social, administration, generic chat, or document-chat features;
- a full visual curriculum authoring suite;
- cross-course personalization;
- model-created concepts or course truth outside the current extraction and grounding boundary.

These may be reconsidered only after the coherent loop beats the relevant baseline and cost is understood.

## 24. Detailed phased implementation plan

These are redesign phases R0–R5, not a continuation of the old deferred Phase 3. R0–R4 are internal increments behind local feature flags; none is a coherent external release alone. The learner-facing release occurs only after R5 removes the two-shell and two-“plan” ambiguity.

### R0 — Contracts, telemetry, and compatibility floor

**Outcome**

Every future semantic call can be measured, and new persisted contracts are agreed before UI work.

**Work**

- add shared schemas for curriculum, goals, plans, conversation, completion, and usage;
- add provider trace metadata and LLM usage observation;
- parse provider-reported token usage;
- add generation/submission/exchange claim leases, fencing, and crash recovery;
- establish source/context fingerprint helpers;
- add staged material-revision/backfill foundations and populated-v12 fixtures so later source work cannot erase history;
- preserve fake-provider parity.

**Tests and gate**

- usage and pricing math;
- provider attempt versus logical-call accounting;
- schema round trips;
- migration rehearsal;
- no raw prompts in telemetry.

Gate: current behavior remains unchanged, every model call is attributable, and baseline verification still passes.

### R1 — Learner-visible curriculum

**Outcome**

An existing course can show a meaningful hierarchy without requiring the graph.

**Work**

- deterministic CourseOutlineService from full headingPath;
- versioned Curriculum schema, repository, service, validator, provider prompt, and fake fixture;
- safe activation and item-scoped source freshness;
- deterministic fallback;
- initial Curriculum view and unit detail;
- graph prerequisites as advisory input.

**Tests and gate**

- multi-document hierarchy and source coverage;
- unknown IDs, cycles, duplicates, omissions, invalid evidence;
- old active curriculum preservation;
- human review of several real course outlines.

Engineering gate: generation failure still yields an executable outline, references validate, and migration/history tests pass. Product evidence checkpoint: on a hand-authored set of must-find concepts and outline tasks, learners can correctly describe the course shape and locate the labeled important ideas. Do not use the undefined claim “every important concept.”

### R2 — Goal, executable plan, and Course Home

**Outcome**

The learner confirms why and how they will study, accepts a bounded plan, and sees a deterministic next action.

**Work**

- LearningGoal lifecycle and optional interpretation;
- immutable StudyPlan, progress, validation, acceptance, and diff;
- persisted PaceBaseline and deterministic aggregate terminal semantics;
- deterministic SessionAgendaService;
- unified active Course context;
- Course Home and goal/plan editors;
- remove GraphWorkspaceView's independent workspace/localStorage ownership, demote graph navigation, and remove the misleading remediation “学习计划” surface.

**Tests and gate**

- budgets, deadlines, prerequisites, edits, acceptance races;
- Today agenda across review, repair, and new learning;
- course switching and stale source;
- plan acceptance and next-action usability sessions.

Gate: a learner can reach an accepted plan quickly and answer what, why, how long, and what next without opening the graph.

### R3 — Bounded conversational Study Session

**Outcome**

The learner can naturally ask, interrupt, clarify, and resume within one planned LearningUnit.

**Work**

- add StudySession persistence, evolve tutor_runs, and add TutorExchange persistence;
- implement TutorContextAssembler and ConversationService;
- add respondTutorTurn provider/fake contracts;
- one-call response, rolling summary, citations, teaching moves, and recommendations;
- idempotency, UI detachment versus Stop, domain-stale fingerprints, and session resume;
- Study Session transcript/composer and Course Truth drawer;
- keep cached lessons as context;
- remove the legacy TutorPanel/activity-planner from the primary path as soon as conversation is enabled.

**Tests and gate**

- no formal state changes from dialogue;
- question types from the dogfood feedback;
- provider and citation failure;
- long-session context bounds;
- course/plan changes in flight;
- transcript human review and switch-to-general-chat observation.

Engineering gate: bounded turns, retry/resume, citations, failure, and no-state-mutation invariants pass. Product evidence checkpoint: learners can resolve ordinary course questions without leaving the session at an acceptable turn cost and latency.

### R4 — Formal completion, synthesis, and meaningful replan

**Outcome**

The plan becomes genuinely executable: evidence determines advancement, and related units are tested together.

**Work**

- extend assessment learning context and evidence kinds;
- CompletionService and append-only UnitProgressionDecisions;
- progress transitions and dependency unlock;
- explicit defer;
- aggregate completed versus finished_with_gaps plan/goal closure;
- unit and synthesis checkpoint UX;
- evidence-triggered replan proposal with preserved accepted plan and diff;
- integrate grading, queue, review, and remediation without duplicate state logic.

**Tests and gate**

- objective coverage and completion templates;
- semantic/objective evidence;
- duplicate/stale grades;
- synthesis integration requirements;
- failure preserves unit history;
- delayed and synthesis evaluation.

Engineering gate: grading, progression reconciliation, explicit defer, synthesis, and successor-plan invariants pass without destructive replanning. Product evidence checkpoint: evidence-based unit completion predicts fresh performance better than learner self-report.

### R5 — IA consolidation, cost tuning, and product dogfood

**Outcome**

The new loop is the product, not an optional tab beside the old graph shell.

**Work**

- finish Course Home, Curriculum, Study, Progress, and Explore navigation;
- merge Mistakes, Mastery, Review, and history into Progress while preserving deep links;
- finish removal of old primary graph/Tutor/remediation affordances and compatibility-only routes;
- expose session usage;
- extend fake and optional real-provider evaluations;
- update README, architecture, verification, dogfood, and evidence documentation;
- run controlled comparison and same-model ablation.

**Tests and gate**

- full responsive and accessibility pass;
- all async switch/delete/cancel races;
- complete repository verification;
- product metrics and API-cost review.

Gate: the team can answer the final product question with human evidence. If not, do not broaden scope.

## 25. Concrete file-level change map

This map is based on files that exist in the current repository. “New” paths are proposals, not files created by this design round.

### Shared contracts

| Actual file | Proposed change |
| --- | --- |
| packages/shared/src/index.ts | Export the new schemas without parallel legacy models |
| packages/shared/src/domain/workspace.ts | Add active curriculum/goal/plan pointers and Course Home projection while retaining Workspace identity |
| packages/shared/src/domain/material.ts | Add compatible MaterialRevision identity, retirement/snapshot metadata, and SourceBlock/concept-lineage schemas without cloning either domain |
| packages/shared/src/domain/graph.ts | Add included-revision provenance/freshness to GraphVersion |
| packages/shared/src/domain/blueprint.ts | Add optional unit/synthesis context, one primary objective ID, authority/evidence kind, and permitted-materials contract |
| packages/shared/src/domain/quiz.ts | Add optional plan, StudySession, and checkpoint context compatibly |
| packages/shared/src/domain/tutor.ts | Evolve run kind/lifecycle and preserve legacy remediation-plan semantics |
| packages/shared/src/domain/review.ts | Extend agenda response types only if needed; keep review scheduling semantics |
| packages/shared/src/provider/payloads.ts | Add curriculum, goal interpretation, StudyPlan, and TutorExchange payloads |
| packages/shared/src/domain/curriculum.ts | New: two-pass SourceOutline, CurriculumVersion hierarchy, objective authority/priority, SynthesisDefinition, and limits |
| packages/shared/src/domain/learningGoal.ts | New: orthogonal goal fields, stable scope definition/pinned snapshot, revisions, and terminal outcome |
| packages/shared/src/domain/studyPlan.ts | New: immutable plan, pace baseline, items, completion rules, progress, progression/terminal decisions, replan diff |
| packages/shared/src/domain/studySession.ts | New: persisted agenda cursor, session lifecycle, outcome and correlation |
| packages/shared/src/domain/conversation.ts | New: idempotent exchange request/response, teaching moves, and bounded summary |
| packages/shared/src/domain/llmUsage.ts | New: call metadata and aggregate response schemas |

### Server persistence and repositories

| Actual file | Proposed change |
| --- | --- |
| apps/server/src/db/migrate.ts | Add explicit migrations, indexes, Tutor table rebuild, compatible quiz fields, and populated-old-DB tests |
| apps/server/src/repositories/index.ts | Export and inject the new repositories |
| apps/server/src/repositories/workspaces.ts | Active curriculum/goal/plan pointers and expected-pointer swaps |
| apps/server/src/repositories/materials.ts | Stage/activate/retire MaterialRevisions, enforce active-only default reads, and preserve history references |
| apps/server/src/repositories/graph.ts | Scope current versions to active included revisions while retaining historical versions |
| apps/server/src/repositories/alignment.ts | Default current overlay reads to active revision concepts |
| apps/server/src/repositories/mistakes.ts | Separate active-concept queries from explicit historical evidence reads |
| apps/server/src/repositories/misconceptions.ts | Separate active-concept queries from explicit historical evidence reads |
| apps/server/src/repositories/review.ts | Keep due scheduling active-revision-only and historical rows queryable |
| apps/server/src/repositories/quizzes.ts | Persist optional learning context plus client-submission claim/replay without changing old quiz reads |
| apps/server/src/repositories/tutor.ts | Preserve legacy events/remediation plan IDs; support teaching runs, exchanges, summaries, and idempotency |
| apps/server/src/repositories/curricula.ts | New: immutable versions and atomic activation |
| apps/server/src/repositories/learningGoals.ts | New: revisions and confirmation lifecycle |
| apps/server/src/repositories/studyPlans.ts | New: immutable plans, mutable progress, progression decisions, and reconciliation |
| apps/server/src/repositories/studySessions.ts | New: session lifecycle, agenda/outcome snapshot, time and correlation |
| apps/server/src/repositories/generationJobs.ts | New: pre-provider claims, concurrent deduplication, result linkage, and durable status |
| apps/server/src/repositories/llmUsage.ts | New: append logical calls/physical attempts and aggregate cost/usage |

### Server source, domain services, and orchestration

| Actual file | Proposed change |
| --- | --- |
| apps/server/src/ingestion/sections.ts | Keep extraction batching; share heading normalization where safe, but do not turn it into the curriculum |
| apps/server/src/ingestion/courseOutline.ts | New: full headingPath trie, source membership, derived mapping algorithm/fingerprint, fallback units |
| apps/server/src/services/index.ts | Wire the new services through existing dependency construction |
| apps/server/src/services/analysis.ts | Extract into staging MaterialRevisions and expose revision fingerprints |
| apps/server/src/services/mapping.ts | Feed structural mappings into CourseOutlineService |
| apps/server/src/services/graph.ts | Scope active graph reads/generation to included revisions and expose only fresh advisory prerequisites/connections |
| apps/server/src/services/alignment.ts | Restrict current candidates/overlays to active revisions and preserve historical attribution |
| apps/server/src/services/assessment.ts | Atomically generate unit/synthesis quiz, blueprints, context, objective coverage, and idempotency |
| apps/server/src/services/grading.ts | Preserve learner-state transaction, then invoke separate idempotent progression reconciliation |
| apps/server/src/services/queue.ts | Supply due review/repair candidates to SessionAgendaService |
| apps/server/src/services/mistakes.ts | Filter current repair candidates by active revision while preserving Progress history |
| apps/server/src/services/misconceptions.ts | Filter current misconception work by active revision while preserving Progress history |
| apps/server/src/services/review.ts | Schedule current review only for active or deterministically reconciled concepts |
| apps/server/src/services/activityLaunch.ts | Launch planned formal checkpoints from validated plan context |
| apps/server/src/services/lessons.ts | Supply cached lesson segments to Tutor context; stay on-demand |
| apps/server/src/services/tutor.ts | Retain legacy-run access and migrate primary use to teaching conversations |
| apps/server/src/services/workspaces.ts | Course-home aggregation and source-dependent lifecycle |
| apps/server/src/services/materials.ts | Stage revisions, reconcile concepts conservatively, activate/retire, and derive item-scoped validity |
| apps/server/src/services/curriculum.ts | New: generation, fallback, persistence, activation |
| apps/server/src/services/curriculumValidation.ts | New: reference, coverage, evidence, DAG, and bound checks |
| apps/server/src/services/learningGoals.ts | New: intake, interpretation, confirmation |
| apps/server/src/services/studyPlanning.ts | New: initial/replan proposals, acceptance, carry-forward, diff |
| apps/server/src/services/studyPlanValidation.ts | New: scope, prerequisite, budget, and completion-policy validation |
| apps/server/src/services/sessionAgenda.ts | New: deterministic Today agenda and reasons |
| apps/server/src/services/studySessions.ts | New: agenda execution, pause/resume/end, time/outcome correlation |
| apps/server/src/services/tutorContext.ts | New: relevance selection, budgets, fingerprints |
| apps/server/src/services/conversation.ts | New: pending exchange persistence, idempotent one-call response, validation, and retry |
| apps/server/src/services/completion.ts | New: objective-attributed formal evidence and idempotent progress reconciliation |
| apps/server/src/services/planOutcome.ts | New: aggregate terminal outcomes, goal closure, and PaceBaseline evaluation |
| apps/server/src/services/llmUsage.ts | New: instrumentation and aggregates |
| apps/server/src/services/generationJobs.ts | New: claim costly work before provider calls and return existing job/result on duplicates |

### Provider and Tutor infrastructure

| Actual file | Proposed change |
| --- | --- |
| apps/server/src/llm/provider.ts | Add new provider operations and trace/usage result metadata |
| apps/server/src/llm/prompts.ts | Add versioned curriculum, plan, and conversational Tutor prompts with source/AI policy |
| apps/server/src/llm/fakeProvider.ts | Deterministic compatible outputs for every new operation and failure fixture |
| apps/server/src/llm/hy3Provider.ts | Parse usage, observe initial/repair calls, and implement the new structured operations |
| apps/server/src/llm/factory.ts | Inject tracing without exposing provider HTTP shapes to services |
| apps/server/src/tutor/tools.ts | Reuse pure read helpers in TutorContextAssembler; stop using a model-selected tool loop for ordinary turns |

### Routes and application composition

| Actual file | Proposed change |
| --- | --- |
| apps/server/src/routes/workspaces.ts | Add course home, curriculum, goal, and plan endpoints or delegate to a focused route module |
| apps/server/src/routes/study.ts | Add StudySession, agenda, item-scoped checkpoint/defer, Progress, and workspace-scoped Tutor endpoints |
| apps/server/src/routes/materials.ts | Return revision/fingerprint/setup status, stage reprocess, and serve cited blocks on demand |
| apps/server/src/routes/courseStudy.ts | New if route density warrants it; contains transport only, not domain logic |
| apps/server/src/app.ts | Register new repositories, services, and routes |

### Frontend application and views

| Actual file | Proposed change |
| --- | --- |
| apps/web/src/App.tsx | Replace material/graph split with one active Course shell and new primary navigation |
| apps/web/src/api.ts | Add typed setup, goal, curriculum, plan, StudySession, exchange, checkpoint, progression, evidence, and usage calls with operation-specific abort semantics |
| apps/web/src/styles.css | New responsive shell, transcript, hierarchy, source drawer, plan, progress, and state styles |
| apps/web/src/views/ImportView.tsx | Evolve into Course documents/setup and route to goal creation |
| apps/web/src/views/GraphWorkspaceView.tsx | Decompose and retire as primary shell; preserve useful panels in Explore |
| apps/web/src/views/QuizView.tsx | Support plan-owned formal checkpoints; demote generic configuration |
| apps/web/src/views/ResultsView.tsx | Show saved grade, reconciliation state, objective evidence, progression result, and next action |
| apps/web/src/views/MistakesView.tsx | Merge primary presentation into Progress while preserving filters/deep links |
| apps/web/src/views/MasteryView.tsx | Merge into Progress and unit context |
| apps/web/src/views/QuizHistoryView.tsx | Merge into Progress evidence history |
| apps/web/src/views/CourseHomeView.tsx | New: goal, total progress, Today agenda, current unit, next action, usage |
| apps/web/src/views/CurriculumView.tsx | New: hierarchical course and goal-specific plan state |
| apps/web/src/views/StudySessionView.tsx | New: current unit, transcript, objectives, checkpoint, source drawer |
| apps/web/src/views/ProgressView.tsx | New: combined plan, evidence, mistakes, mastery, misconceptions, review, history |
| apps/web/src/views/GraphExplorerView.tsx | New or extracted: secondary graph and advanced source exploration |

### Frontend components

| Actual file | Proposed change |
| --- | --- |
| apps/web/src/components/DailyQueue.tsx | Retire standalone UI; move reusable presentation only if useful while queue service feeds SessionAgenda |
| apps/web/src/components/DetailPanels.tsx | Split concept/unit/evidence detail; remove misleading “学习计划” |
| apps/web/src/components/LessonCard.tsx | Reuse as optional cached material inside Study or unit detail |
| apps/web/src/components/SourceEvidencePanel.tsx | Evolve into on-demand cited-block Course Truth drawer; stop requiring every document block up front |
| apps/web/src/components/TutorPanel.tsx | Retire/merge current activity planner; preserve audit presentation only |
| apps/web/src/components/ConceptGraph.tsx | Move to Graph Explorer and link nodes back to Curriculum units |
| apps/web/src/components/AlignmentPanel.tsx | Move to advanced setup/Explore |
| apps/web/src/components/useAsyncAction.ts | Separate view abort/ignore, durable-job detach, explicit Stop, domain staleness, and confirmed-mutation reconciliation |
| apps/web/src/components/GoalIntake.tsx | New: structured and optional natural-language intake |
| apps/web/src/components/StudyPlanEditor.tsx | New: proposal, structured edits, acceptance, replan diff |
| apps/web/src/components/TutorConversation.tsx | New: resumable exchanges, composer, moves, inline checks, pending/stop/retry |
| apps/web/src/components/SessionAgenda.tsx | New: time-bounded Today sequence and reasons |
| apps/web/src/components/CurriculumTree.tsx | New: accessible hierarchy and status |
| apps/web/src/components/CourseEvidenceDrawer.tsx | New: exact quote, heading context, provenance distinction |
| apps/web/src/components/UsageSummary.tsx | New: calls, tokens, cost availability, estimate versus actual |

### Concrete existing tests

| Actual file | Proposed coverage |
| --- | --- |
| apps/server/src/db/migrate.test.ts | Fresh schema, revision backfill, new constraints, Tutor rebuild |
| apps/server/src/db/migrateCompat.test.ts | Populated historical upgrades and preserved legacy plan/Tutor/learner history |
| apps/server/src/services/analysis.test.ts | Staged revision success/failure and no destructive replacement |
| apps/server/src/services/assessment.test.ts | Objective authority/mapping, atomic checkpoint persistence, permitted materials |
| apps/server/src/services/grading.test.ts | Grade commit plus progression success, pending reconciliation, and retry |
| apps/server/src/services/tutor.test.ts | Legacy run compatibility, pending exchanges, one-call turn, restart, Stop, and domain staleness |
| apps/server/src/routes/workspaces.test.ts | Workspace-scoped ownership, active-pointer conflicts, setup/goal/plan/session APIs |
| apps/server/src/routes/flows.test.ts | Complete import→goal→plan→session→checkpoint→synthesis flow |
| apps/server/src/llm/fakeProvider.test.ts | Deterministic new provider contracts and usage metadata |
| apps/server/src/llm/hy3Provider.test.ts | Usage parsing and logical versus repair attempt observation |
| packages/shared/src/domain/adaptiveSchemas.test.ts | New adaptive schema bounds and invalid references |
| packages/shared/src/domain/schemas.test.ts | Backward-compatible public payload parsing |
| apps/web/src/App.test.tsx | Single Course context, setup/home state matrix, navigation detachment |
| apps/web/src/views/GraphWorkspaceView.test.tsx | Shell retirement/extraction and preserved Explore behavior |
| apps/web/src/components/AdaptivePanels.test.tsx | Disposition compatibility while new focused component tests are introduced |
| proposed CourseHomeView, StudySessionView, CurriculumView, ProgressView, and TutorConversation tests | Empty/pending/failure/stale, transcript, checkpoint, source, and responsive critical paths |

### Evaluation, scripts, and documentation after implementation

| Actual file | Proposed change |
| --- | --- |
| eval/run-fake.mjs | Add deterministic curriculum, plan, conversation, no-mutation, completion, synthesis, and cost cases |
| eval/run-hy3.mjs | Add optional schema, grounding, latency, token, repair, and cost reporting |
| eval/README.md | Distinguish structural/provider evaluation from human teaching-quality evidence |
| scripts/smoke-adaptive.mjs | Preserve existing adaptive smoke coverage |
| scripts/smoke-study.mjs | New: complete accepted-plan StudySession smoke path, exposed as demo:study |
| README.md | Explain the implemented goal-to-session workflow and honest limits |
| docs/ARCHITECTURE.md | Document new ownership, data flow, state transitions, and cost telemetry |
| docs/VERIFICATION.md | Add exact deterministic and optional provider verification |
| docs/DOGFOOD.md | Replace stale pre-dogfood assumptions with target metrics and comparison protocol |

## 26. Final answer: why open Hy3 Study Clinic instead of ChatGPT?

After this redesign, a learner would open Hy3 Study Clinic when they are not merely asking for an explanation, but trying to finish a bounded course over several sessions.

It would know the course's verified structure and conventions, the goal and deadline the learner accepted, the exact unit that is next and why, the questions and mistakes that persisted from previous sessions, the formal evidence required to move on, and when related ideas need to be synthesized. The Tutor could still converse naturally and use broad teaching knowledge, but it could not quietly turn confidence or chat sentiment into mastery. Every consequential plan and learner-state change would remain inspectable.

That is a credible advantage over a general chat for serious longitudinal study: not better generic conversation, but reliable execution and continuity around good conversation.

The answer remains conditional. If the Tutor is not close to a strong general conversational tutor in clarity and responsiveness, if learners do not accept and follow the curriculum, or if the recurring API cost is too high, then the answer is weak and the user should use ChatGPT. The next implementation should be judged by that falsifiable standard, not by the number of new features shipped.
