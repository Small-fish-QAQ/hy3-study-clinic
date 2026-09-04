# Hy3 Study Clinic — Limitations and known failure modes

This register is part of the product contract. It describes what the current
repository does not guarantee, so reviewers can distinguish implemented safeguards
from open research questions.

## Ingestion and format limits

- PDF import requires an embedded text layer; there is no OCR. Complex multi-column layouts, rotated text, diagrams, PDF figures, and image text are not reconstructed. DOCX provenance has structural order and headings but no page numbers.
- PPTX text follows stable OOXML drawing-layer order, not a guaranteed semantic reading order. Charts, SmartArt, equations, unknown shapes, and unsupported embedded objects are not semantically interpreted; supported original media can be retained with an explicit partial-extraction warning.
- Embedded original images remain immutable source assets. Accepted provider-derived descriptions are available only through explicit advisory projections; they are not visual source truth. HTML/Web Snapshot ingestion is a static, no-JavaScript snapshot path: it captures one public HTTP(S) response, retains exact response bytes and URL/hash provenance, and keeps remote images as reference/alt/caption metadata rather than pretending they were archived.
- The dedicated TokenHub visual path is bounded advisory generation, not perfect OCR, exact chart extraction, formal visual Evidence, multimodal mastery, or proof of pedagogical effectiveness. Provider-visible text and structural interpretation can vary by fixture; unknown image-token accounting and monetary cost are never inferred.

## Graph, retrieval, and course-structure limits

- Curriculum has progressive disclosure rather than search/filter. Its conservative topic presentation retains every accepted LearningUnit identity and never fabricates mappings, a current unit, or progress state; malformed hierarchy recovery is display-only and does not repair stored Curriculum data.
- Historical Curricula created before parser-fragment grouping may contain many source-only LearningUnits and remain accepted history. Their smaller learner-facing topic presentation has no planning authority. When those units lack a launchable capability, the supported repair is a separately proposed and learner-accepted successor Curriculum, not a capability backfill or Plan-only display projection.
- If no current Concept has the exact selected evidence identity, the server will not synthesize one from a LearningUnit title or citation; the learner must first generate revision-grounded Concepts from the Course material, then request the successor.
- 资料映射 reports structural mapping and anchor coverage, never semantic course coverage: a mapped section may still contain uncaptured ideas. Section budgets and the 40-concepts-per-document ceiling bound extraction depth.
- Semantic alignment can be wrong and has no unmerge operation; source concepts and history remain intact underneath.
- Tutor context, graph generation, assessments, remediation, history, and retrieval are deliberately bounded. Dense graph layouts can retain crossings, and lexical retrieval can miss synonyms.
- Course Source Map hierarchy comes only from current parser heading paths and deterministic budgeting sections; it does not create parent summaries or semantic authority. The production reserve guarantees section opportunity under fixed global ceilings, not semantic relevance or complete coverage. The offline policy benchmark uses exact local catalog identities but does not contain raw SourceBlock text, so exact quotation verification remains at catalog construction/materialization. Its token figures are estimates, and the validation cases do not prove teaching quality or make rank-fusion weights universal.
- The production Course Map and detail stages bound provider work and validate structure, evidence ownership, and assembly; they do not prove teaching quality or semantic entailment. The Course Map is operation-local and is never a second accepted course artifact. A Course Map whose details cannot fit within two fixed batches fails without dropping regions or replacing a valid predecessor. Sparse source regions with no executable current Concept can still fail the unchanged StudyPlan preflight; local code does not invent Concept authority to make them launchable.
- Optional Course focus is a narrow semantic mapping performed inside Course Map generation. An unmappable or teaching-style request falls back to balanced `normal` Units; the system does not promise that every informal synonym will be mapped. Learner correction is intentionally limited to Unit rename, prerequisite-safe movement, focus toggle, and regeneration—merge, deletion, objective-graph editing, and per-Unit depth selection are not supported.

## Teaching and pedagogy limits

- Lesson prose may teach beyond the uploaded text. Such content carries no source reference, is explicitly labeled Hy3 supplementary teaching, is never grading evidence, and its factual quality depends on the configured model. A source marker proves an exact excerpt exists at that location; it does not prove full semantic entailment.
- The Lesson contract asks for a coherent teacher-led arc, central mental model, worked reasoning, causal explanation, boundaries and transfer, but deterministic structure tests cannot prove that a real learner experiences strong teaching. Final acceptance still requires human dogfood of real-provider output; no learning-effectiveness claim follows from prompt compliance.
- Teaching Skeleton minute ranges are deterministic feasibility bounds, not observed learner time or proof of teaching effectiveness. Lexical relevance/compatibility findings are advisory diagnostics; schema, required obligations, source membership/resolution, route, identity, planning-language leakage, and obvious Practice-answer leakage still fail closed. The bounded Practice novelty checks catch substantial verbatim/direct repetition, not semantic paraphrases. An accepted Lesson checkpoint is reusable only for its exact Session/Agenda/Plan route, source context, skeleton, and prompt version.
- Objective repair cannot silently broaden authority, lower a construct, or narrow away an original required capability. If the legitimate LearningUnit source envelope cannot support the objective, preparation stops instead of manufacturing Formal readiness.

## Assessment, mastery, and review limits

- Exact-quote verification establishes location, not semantic entailment. The objective-support evaluator is model-assisted and can still be wrong; structured observations, frozen authority, local construct rules, capability-preservation checks, and downstream revalidation make it auditable and fail closed rather than a formal proof of entailment.
- Mastery and review scheduling are transparent local heuristics, not calibrated cognitive diagnoses. Misconception records remain hypotheses until graded evidence changes their state.
- The fake evaluation checks structure and safety boundaries, not teaching quality or real-provider structured-output behavior. The real evaluation uses small fixtures and depends on the configured model/API; Fake success is not actual-browser acceptance.
- No learning-outcome study has been conducted. This project does not claim measured educational effectiveness.

## Provider and structured-output limits

- Hy3 structured-output capabilities depend on the configured OpenAI-compatible serving backend. The adapter does not assume native `response_format` or JSON Schema support; constrained decoding would require an explicit verified endpoint capability and would remain an additional layer before local Zod and semantic validation.
- The optional visual adapter is disabled in the competition configuration and evaluation runs. It remains advisory-only and can never enter Formal Evidence, grading, mastery, mistakes, Review, Agenda completion, or Plan progression.
- Settings local-service tests cover only local reachability. The separate external Hy3 test is explicit, minimal, timestamped, and may consume provider usage; a passing probe is not a guarantee for later large requests. Provider configuration edits are validated and activated by the server, while the browser receives only safe non-secret state.

## Lifecycle and persistence limits

- Historical Curricula without canonical objective semantic-support rows remain readable audit history but fail the new acceptance, StudyPlan, activation, and pre-Lesson gates until a valid immutable successor is created.
- Material/document retirement is non-destructive to immutable revisions, source provenance, assessments, and longitudinal learning history, but there is no automatic unretire operation. Reprocessing stages and activates an immutable extraction revision while retaining earlier source artifacts and history; failed parsing leaves the prior active revision unchanged. Explicit workspace deletion is irreversible and has no recycle bin.

## Known Hy3 failure modes observed in this project

The project has recorded these qualitative patterns; frequency estimates are not yet
available and no prevalence claim is made:

- When evidence is sufficient, Hy3 can over-expand into general knowledge instead of keeping the explanation tightly scoped.
- When candidate evidence is made of near-neighbor passages, relation classification can be unstable.
- When several passages jointly support a proposition, Hy3 can prefer a single evidence group instead of the minimal joint support.
- Construct depth can be misread, especially when a goal requires application or evaluation rather than identification or explanation.

These failure modes motivate the blind candidate-relation/support-group verifier,
construct-specific local gates, and the planned StudyEval adversarial and validity
protocols. They are not claims of statistical frequency.
