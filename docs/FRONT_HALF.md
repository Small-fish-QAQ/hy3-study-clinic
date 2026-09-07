# Course preparation and teaching architecture

Materials define the subject. The learner selects a global Depth and optional
Focus, reviews the proposed Course Skeleton, and accepts that version. Preparation
then realizes that agreement as an executable teaching route. Generation, learner
acceptance, and evidence authority have separate responsibilities.

## Responsibilities

| Stage | Responsibility | Durable boundary |
| --- | --- | --- |
| Materials | Immutable revisions, exact source spans, ingestion and concept grounding | Valid source revisions and concepts |
| Course Source Map / Course Map | Account for material regions and organize the subject | Validated private generation dependency |
| Curriculum Detail | Specify bounded Unit objectives inside offered regions | Validated private batch dependency |
| Course Skeleton | Validate hierarchy, coverage, prerequisites and authority | Immutable proposed Curriculum; explicit learner acceptance |
| Ordinary StudyPlan | Compile accepted Units, objectives, prerequisites and Depth | Locally validated plan derived from accepted Curriculum |
| Teaching Skeleton | Set objective obligations, permitted evidence, activities and duration | Deterministic content identity |
| Teaching representation | Choose faithful authored or computable representations where applicable | Private bounded planning result |
| Lesson / Practice authoring | Prepare objective-scoped teaching and independent Practice together | Validated private portions, then immutable accepted Lesson |
| Practice acceptance | Check coverage, novelty, cognitive demand and current authority | Immutable Teaching Brief |
| Learner execution | Present prepared teaching, feedback, scaffold, transfer and Practice | Non-credit responses and exposure events |

The ordinary plan compiler is used only for simplified Course Preparation. It
preserves every accepted objective, uses stable prerequisite ordering, requires
current teaching capability, and derives duration through the existing planner.
Broad Units are partitioned into consecutive Lessons of at most two objectives;
each part follows its predecessor and dependent Units wait for the final part.
This bounds authoring and fits the existing teaching-slot ceiling without changing
Unit identity, accepted scope or Depth.
Advanced and historical planning retain their model proposal path. Formal launch
and evidence reconciliation remain independent and fail closed.

## Dependency recovery

Execution remains sequential. Detail budgets depend on completed objective counts;
later teaching portions receive earlier teaching as exposure. There is no new
workflow engine, background generation queue or concurrency policy.

`generationStages.ts` stores complete, validated results in the existing private
semantic cache. Keys include the full immutable input, stage version,
workspace/session/Unit, provider/model and source identity. Curriculum additionally
binds Contract and predecessor/accepted Curriculum identities. Teaching binds the
exact accepted route and skeleton. Every use revalidates content and authority.
A changed dependency changes descendant identities. Regeneration creates a new
Curriculum proposal rather than returning its predecessor's generation.

A hit records a logical receipt in the current operation linked to the original
completed call. It creates no physical request, token usage or fresh provider claim.
Cancellation, ownership and fencing are checked before invocation and persistence.
Incomplete or rejected provider output is never cached. Cost admission applies
when a new request is needed; exact cache reuse does not spend provider budget.

Quality review is rerun when needed rather than caching a negative verdict into a
permanent retry loop. A rejected unaccepted teaching portion loses cache
eligibility. An explicit retry generates a successor while retaining other valid
portions. Invalidated cache entries remain audit history. The accepted Lesson is a
separate immutable boundary: Practice failure never rewrites it. Brief reuse and
learner commands still apply the existing route, version and source fences.

## Teaching representation and review

Computed working-fluency teaching remains available for faithful finite models,
such as permission rules. Hy3 supplies an explanation, explicit assumptions, a
typed acyclic rule graph and hypothetical input ranges. Local execution constructs
consistent predictions, scaffold steps, governing-condition transfer and diagnostic
Practice. Execution proves consistency with that model, not its domain truth.

A small selection call is made only for objectives otherwise eligible for computed
authoring. If the limited operators would distort the goal, such as a probability
ratio or historical interpretation, the objective uses authored cases. Other depths
and visual teaching retain their own authoring contracts.

Authored portions receive only components required by their actual slots. Revision
receives concrete findings and the affected draft. Transfer and Practice retry must
state their necessary case facts because earlier questions can be replaced on
screen. Teaching and exercises use different cases. Naming a formula or repeating
an already supplied conclusion is insufficient when depth requires reasoning.

One independent content review and at most one revision remain available for
authored content. Reviewers do not receive author answers, expected signals,
debriefs or future worked results. They solve actions from visible facts. Answer
disagreement, evidence insufficiency, grounding, answer leakage and other concrete
defects can reject content. Difficulty opinions, including `shallow_task`, remain
diagnostic; deterministic cognitive contracts and real browser acceptance govern
the teaching-quality claim. Mixed Units review authored Lesson portions
without recomputing all computed feedback traces. Deterministic inventory,
provenance, cognitive coverage and checkpoint validation still govern assembly.
The review prompt is limited to scoped factual correctness, missing causal rules,
answerability and actual answer disclosure. It does not conduct repeated
pedagogical redesign. Scaffold questions are checked independently and clearly
marked as assistance shown after an incorrect guided response.

On completion, the learner can continue by refreshing the existing server-owned
route. An exhausted Agenda shows an explicit end state rather than attempting to
load a nonexistent Lesson. This navigation has no credit or mastery authority.

## Depth, Focus and authority

Depth is the learner's fixed baseline: basic (historical wire value `pass_oriented`),
`working_fluency`, `high_performance` or `deep_transfer`. It flows through Curriculum,
local plan, Teaching Skeleton and authoring. Focus adds teaching investment and
useful reasoning angles at the same depth. Neither setting raises source authority.

Offered references are permissions, not citation quotas. Local citation confinement
retains references only when the complete component is a verbatim passage within
the selected source. Generated paraphrases, models, hypothetical examples and
Practice remain supplementary; they cannot self-certify citation support. Unknown
references still fail ordinary validation. Generation and cache reuse cannot confer
citation, Formal eligibility, credit or mastery. Source authority, construct
support, assessment admission, grading and deterministic reconciliation retain those
responsibilities.

Immutable Briefs, response-aware taught exposure and non-credit Practice events
provide bounded inputs for later Repair and Tutor work. This architecture does not
implement those loops or reinterpret Practice mistakes as durable diagnoses.

## Limits

Generation and semantic review remain fallible. Structured output, rule execution
and positive review are not universal teaching-quality proofs. Acceptance requires
actual provider output and browser study on discriminating subjects/depths, with
failures included in evidence. Token ceilings, timeouts, automatic retries and
review rounds are not increased. Large-corpus behavior and learning effectiveness
beyond exercised cases require separate evidence.
