import type {
  AlignmentLanguage,
  AlignmentProposalPayload,
  AssessmentMode,
  AssessmentProposalPayload,
  Concept,
  ConceptAnalysisPayload,
  ConceptLessonPayload,
  CourseMapProposalPayload,
  Curriculum,
  CurriculumDetailProposalPayload,
  CurriculumProposalPayload,
  DesiredDepth,
  ExecutionSourceManifest,
  GraphEdge,
  GraphProposalPayload,
  GraphRelation,
  LessonDirective,
  MasteryState,
  MaterialRole,
  MisconceptionProposalPayload,
  MisconceptionRecord,
  Option,
  QuestionType,
  QuizConfig,
  QuizGenerationPayload,
  RemediationPlanProposalPayload,
  ReviewItem,
  RubricGrade,
  RubricPoint,
  SourceBlock,
  StructuralUnitKind,
  StudyPlanFeasibility,
  StudyPlanItemKind,
  StudyPlanProposalPayload,
  TeachingBriefProposalPayload,
  TutorStepPayload,
  TutorTurnPayload,
  TutorPedagogicalMove,
  TutorRecentMove,
  TutorSourceRef,
  StudyExchange,
  LessonTutorContext,
  StudySessionSummary,
  TutorToolName,
} from '@hy3-clinic/shared';

/** Options threaded through every provider call. */
export interface ProviderCallOptions {
  /** Abort signal from the HTTP request (client cancellation). */
  signal?: AbortSignal | undefined;
  /** Optional bounded timeout override for the owning operation. */
  timeoutMs?: number | undefined;
  /** Internal telemetry hook: any bounded repair is a new physical request. */
  onRepairAttempt?:
    | ((reason?: ProviderRepairReason, category?: StructuredOutputFailureCategory) => void)
    | undefined;
  /**
   * Local input-aware validation applied after schema parsing. Returning
   * diagnostics consumes the provider's single repair allowance; throwing
   * fails immediately for authoritative conflicts that a model cannot fix.
   */
  validateCandidate?: ((candidate: unknown) => ProviderCandidateValidation) | undefined;
  /** Internal telemetry hook fired immediately before a physical request is sent. */
  onRequestSent?: (() => void) | undefined;
  /** Internal telemetry hook for provider-reported usage of the current request. */
  onUsage?: ((usage: ProviderUsage) => void) | undefined;
  /**
   * Evaluation/debug observer for scalar-redacted structured-output metadata.
   * Production callers must not expose this envelope to learners.
   */
  onStructuredOutputDiagnostic?: ((diagnostic: StructuredOutputDiagnostic) => void) | undefined;
  /** Final authority check immediately before successful ledger completion. */
  beforeTelemetryComplete?: (() => void) | undefined;
  /** Internal authoritative metadata for one logical provider inference. */
  telemetry?: ProviderTelemetryContext | undefined;
}

export type ProviderRepairReason = 'schema' | 'candidate';

export type StructuredOutputFailureCategory =
  | 'TRANSPORT_FAILURE'
  | 'EMPTY_RESPONSE'
  | 'JSON_PARSE_FAILURE'
  | 'SCHEMA_VALIDATION_FAILURE'
  | 'SEMANTIC_VALIDATION_FAILURE'
  | 'TRUNCATED_OUTPUT'
  | 'REPAIR_EXHAUSTED'
  | 'PROVIDER_FORMAT_INCOMPATIBILITY';

export interface StructuredOutputDiagnostic {
  schemaName: string;
  operationType: string | null;
  attemptNumber: 1 | 2;
  attemptKind: 'original' | 'repair';
  provider: 'hy3';
  model: string;
  transportSuccess: boolean;
  httpStatus: number | null;
  responseBodyBytes: number | null;
  contentType: 'string' | 'array' | 'object' | 'null' | 'missing' | 'other';
  contentBytes: number | null;
  contentFingerprint: string | null;
  finishReason:
    | 'stop'
    | 'length'
    | 'sensitive'
    | 'content_filter'
    | 'tool_calls'
    | 'function_call'
    | 'unknown'
    | null;
  truncated: boolean;
  possiblyIncomplete: boolean;
  jsonParseSuccess: boolean;
  jsonFormat: 'direct' | 'markdown_json_fence' | null;
  topLevelType: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | null;
  topLevelKeys: string[];
  schemaIssueCount: number;
  schemaIssues: Array<{ path: string; code: string }>;
  semanticIssueCodes: string[];
  failureCategory: StructuredOutputFailureCategory | null;
  repairAction: 'none' | 'requested' | 'exhausted';
  structuralPreview: unknown;
}

export interface ProviderCandidateValidation {
  valid: boolean;
  /** Bounded, sanitized model-correctable reasons only. */
  diagnostics: string[];
  /** Stable codes for private structural diagnostics; never raw model content. */
  diagnosticCodes?: string[] | undefined;
}

/** Usage reported by the provider response. Missing values remain unknown. */
export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  estimatedCostMicrounits: number | null;
  currency: string | null;
  pricingSource: string | null;
  pricingVersion: string | null;
}

/** Metadata only. Prompt/source content must never be placed in this context. */
export interface ProviderTelemetryContext {
  workspaceId: string | null;
  operationType: string;
  operationId?: string | null | undefined;
  studySessionId?: string | null | undefined;
  learningUnitId?: string | null | undefined;
  assessmentId?: string | null | undefined;
  schemaFingerprint?: string | null | undefined;
  policyFingerprint?: string | null | undefined;
  sourceFingerprint?: string | null | undefined;
  fencingToken?: number | null | undefined;
  logicalCallId?: string | undefined;
  attemptKind?: 'original' | 'repair' | 'retry' | 'fallback' | undefined;
  confirmedCostPolicyIds?: string[] | undefined;
}

export interface ConceptAnalysisInput {
  materialTitle: string;
  blocks: SourceBlock[];
  /**
   * Section-aware extraction: the section these blocks belong to (display
   * title) and the size-aware UPPER bound on concepts. When set, the prompt
   * asks for 0..maxConcepts and explicitly allows an empty result; absent,
   * the legacy whole-document 3–8 wording applies.
   */
  sectionTitle?: string;
  maxConcepts?: number;
}

export interface QuizGenerationInput {
  materialTitle: string;
  blocks: SourceBlock[];
  concepts: Concept[];
  config: QuizConfig;
}

export interface ShortAnswerGradingInput {
  stem: string;
  expectedAnswer: string;
  /** Full rubric points including their required/optional classification. */
  rubricKeyPoints: RubricPoint[];
  /** The verified source quote backing the question. */
  quote: string;
  answerText: string;
}

export interface RemediationTarget {
  concept: Concept;
  /** Stems of the questions the learner got wrong for this concept. */
  missedStems: string[];
  openMistakeCount: number;
}

export interface RemediationInput {
  materialTitle: string;
  blocks: SourceBlock[];
  targets: RemediationTarget[];
  /** Number of questions to generate per weak concept (1-3). */
  questionsPerConcept: number;
}

export interface GraphProposalInput {
  workspaceName: string;
  /** All source blocks of the workspace (evidence space). */
  blocks: SourceBlock[];
  /** All concepts of the workspace (the only legal node ids). */
  concepts: Concept[];
  /** Local cap communicated to the model; the validator enforces it anyway. */
  maxEdges: number;
}

/** A direct graph neighbor of the selected concept (bounded, pre-verified). */
export interface PlanNeighbor {
  concept: Concept;
  relation: GraphRelation;
  direction: 'in' | 'out';
}

/** One open mistake summarized for the planner (no answers, no rubric). */
export interface PlanOpenMistake {
  conceptId: string;
  stem: string;
  score: number;
}

export interface RemediationPlanInput {
  workspaceName: string;
  selected: Concept;
  /** Direct prerequisite concepts of the selected concept (bounded). */
  prerequisites: Concept[];
  /** Other direct graph neighbors (bounded). */
  neighbors: PlanNeighbor[];
  /** Source blocks of the involved concepts' documents (evidence space). */
  blocks: SourceBlock[];
  /** Current mastery rows for the involved concepts. */
  masteryStates: MasteryState[];
  /** Open mistakes for the involved concepts (bounded). */
  openMistakes: PlanOpenMistake[];
  /** Question types the learner has already seen (may be empty). */
  usedQuestionTypes: QuestionType[];
}

/** One locally-generated alignment candidate pair offered to the provider. */
export interface AlignmentCandidate {
  source: Concept;
  target: Concept;
  sourceDocumentTitle: string;
  targetDocumentTitle: string;
  sourceLanguage: AlignmentLanguage;
  targetLanguage: AlignmentLanguage;
  /** Deterministic signals that produced this candidate (display strings). */
  signals: string[];
}

export interface AlignmentProposalInput {
  workspaceName: string;
  /** Bounded, locally-pruned candidate pairs (never all-pairs). */
  candidates: AlignmentCandidate[];
  /** Source blocks the model may cite evidence from. */
  blocks: SourceBlock[];
}

/** One weak/target concept summary for assessment generation. */
export interface AssessmentTargetSummary {
  concept: Concept;
  documentTitle: string;
  /** Aligned sibling concepts (same canonical group) in OTHER documents. */
  alignedSiblings: Array<{ concept: Concept; documentTitle: string }>;
  mastery: number | null;
  openMistakes: number;
}

export interface AssessmentProposalInput {
  workspaceName: string;
  mode: AssessmentMode;
  targets: AssessmentTargetSummary[];
  /** Source blocks of every involved document (evidence space). */
  blocks: SourceBlock[];
  /** Question types the assessment may use. */
  allowedTypes: QuestionType[];
  questionCount: number;
  /** Misconception to discriminate (misconception_check mode only). */
  misconception: MisconceptionRecord | null;
}

export interface MisconceptionProposalInput {
  conceptName: string;
  stem: string;
  options: Option[];
  correctOptionIds: string[];
  expectedAnswer: string | null;
  learnerSelectedOptionIds: string[];
  learnerText: string | null;
  /** Verified source quote the question was grounded in. */
  sourceQuote: string;
  blockId: string;
}

/** Graph neighbour offered as lesson context (names/relations only). */
export interface LessonNeighbor {
  name: string;
  relation: GraphRelation;
  direction: 'in' | 'out';
}

export interface ConceptLessonInput {
  concept: Concept;
  documentTitle: string;
  /** Section the concept's grounded block belongs to (display title). */
  sectionTitle: string | null;
  /**
   * Bounded context blocks: the concept's own section plus lexical-retrieval
   * hits. The model may anchor segments ONLY to these blocks.
   */
  blocks: SourceBlock[];
  /** Direct graph neighbours (bounded), for connection teaching. */
  neighbors: LessonNeighbor[];
  /** Optional single-turn regeneration directive. */
  directive?: LessonDirective;
}

/** Compact provider view for one route-owned LearningUnit lesson. */
export interface TeachingBriefGenerationInput {
  workspaceName: string;
  learningUnit: {
    title: string;
    objectives: Array<{ objectiveRef: string; title: string; description: string }>;
    concepts: Array<{ name: string; summary: string }>;
    canonicalConcepts: Array<{ name: string }>;
  };
  prerequisites: Array<{
    prerequisiteRef: string;
    title: string;
    objectiveSummaries: string[];
  }>;
  nextConnection: { title: string } | null;
  sourceContext: {
    blockCount: number;
    offerCount: number;
    serializedBytes: number;
    materialCount: number;
    sectionCount: number;
    offers: Array<{
      sourceRef: string;
      materialTitle: string;
      headingPath: string[];
      pageNumber: number | null;
      text: string;
    }>;
  };
  limits: {
    maxSegments: number;
    maxSourceRefsPerSegment: number;
    maxFormalOpportunities: number;
  };
}

/** One prior validated observation shown back to the Tutor model. */
export interface TutorObservation {
  iteration: number;
  /** Executed tool, or 'plan_validation' for a rejected-finalize feedback. */
  tool: TutorToolName | 'plan_validation';
  purpose: string;
  /** Locally-composed bounded JSON summary of the validated tool result. */
  resultSummary: string;
}

export interface TutorStepInput {
  workspaceName: string;
  selected: Concept;
  /** Compact learner-state summary (deterministic local data). */
  stateSummary: {
    mastery: number | null;
    attempts: number;
    openMistakes: number;
    proposedMisconceptions: number;
    confirmedMisconceptions: number;
    reviewDue: boolean;
  };
  /** Tool catalog: names plus one-line usage descriptions. */
  tools: Array<{ name: TutorToolName; description: string }>;
  observations: TutorObservation[];
  remainingIterations: number;
  remainingToolCalls: number;
  /** Concept ids the final plan/activity may reference. */
  allowedConceptIds: string[];
  /** Review items of the workspace concepts (bounded, read-only). */
  reviewItems: Pick<ReviewItem, 'conceptId' | 'dueAt' | 'lastRating'>[];
  /**
   * Activity modes that are executable RIGHT NOW for the selected concept
   * (computed by the deterministic launch resolver). The final activity.mode
   * must come from this list.
   */
  launchableModes: Array<{ mode: AssessmentMode; note: string }>;
  /** Actionable misconception ids usable with misconception_check (bounded). */
  actionableMisconceptions: Array<{ id: string; conceptId: string }>;
}

/** Bounded, non-authoritative context for a conversational StudySession turn. */
export interface TutorTurnInput {
  workspaceName: string;
  learnerMessage: string;
  session: {
    id: string;
    routeState: 'on_route' | 'detour_active' | 'return_pending' | 'execution_paused';
    currentAgendaItemId: string | null;
    currentAgendaItem: { kind: string; reason: string; learningUnitId: string | null } | null;
  };
  summary: Pick<
    StudySessionSummary,
    | 'learnerQuestions'
    | 'unresolvedConfusions'
    | 'explanationsTried'
    | 'provisionalUnderstanding'
    | 'openActions'
    | 'safetyFlags'
  > | null;
  /** Bounded Teaching Brief slice for the current lesson execution. */
  lessonContext: LessonTutorContext | null;
  /** Bounded, revision-pinned teaching context for the current LearningUnit. */
  currentUnit: {
    id: string;
    title: string;
    conceptIds: string[];
    objectives: Array<{
      id: string;
      title: string;
      description: string;
      truthPremiseStatus: string;
      truthAuthorityRecordIds: string[];
    }>;
    prerequisiteUnitIds: string[];
    sourceTruth: Array<{
      blockId: string;
      materialId: string;
      materialRevisionId: string;
      heading: string | null;
      contentExcerpt: string;
    }>;
  } | null;
  /** Deterministic local policy inputs; the provider may only choose among them. */
  allowedMoves: TutorPedagogicalMove[];
  recentMoves: TutorRecentMove[];
  formalCheckpointAvailable: boolean;
  offeredSourceRefs: TutorSourceRef[];
  learnerState: {
    formalEvidence: Array<{
      id: string;
      primaryObjectiveId: string;
      normalizedScore: number;
      admissibilityTier: string;
      stateCreditable: boolean;
    }>;
    openMistakes: Array<{ id: string; conceptId: string; score: number; feedback: string | null }>;
    misconceptions: Array<{ id: string; conceptId: string; status: string; hypothesis: string }>;
    reviews: Array<{ conceptId: string; dueAt: string; lastRating: string }>;
    mastery: Array<{ conceptId: string; mastery: number; attempts: number }>;
    riskIds: string[];
  };
  recentExchanges: Array<Pick<StudyExchange, 'role' | 'content' | 'channel'>>;
}

/** Stable learner intent shown to Curriculum/StudyPlan proposal operations. */
export interface CurriculumContractContext {
  contractVersionId: string;
  intent: string;
  targetOutcome: {
    description: string;
    targetScore: number | null;
  };
  desiredDepth: DesiredDepth;
  subjectBoundaries: string[];
  materials: Array<{
    materialId: string;
    title: string;
    materialRoleAssignmentId: string;
    materialRoleAssignmentVersion: number;
    role: MaterialRole;
    disposition: 'included' | 'excluded';
  }>;
  includedTopics: string[];
  excludedTopics: string[];
}

/** Deterministic source-outline entry offered to Curriculum proposal. */
export interface CurriculumOutlineItem {
  /** Null when no honest normalized structural-unit identity exists yet. */
  structuralUnitId: string | null;
  materialId: string;
  materialRevisionId: string;
  parentStructuralUnitId: string | null;
  kind: StructuralUnitKind;
  index: number;
  title: string | null;
  /** Parser-authoritative heading ancestry for anonymous SourceBlock rows. */
  headingPath: string[];
  sourceBlockIds: string[];
}

/** Exact, revision-bound excerpt owned and offered by the local server. */
export interface CurriculumEvidenceOffer {
  /** Short operation-local identity exposed to the provider. */
  id: string;
  /** Hash-bound workspace/revision/span identity retained only by local code. */
  bindingId: string;
  materialId: string;
  materialRevisionId: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  headingPath: string[];
  pageNumber: number | null;
}

/** Scoped canonical identity with only authoritative in-manifest members. */
export interface CurriculumCanonicalConceptOffer {
  id: string;
  displayName: string;
  sourceConceptIds: string[];
}

export interface CurriculumProposalInput {
  workspaceName: string;
  contract: CurriculumContractContext;
  /** Exact immutable extraction identity; separate from stable Contract scope. */
  executionSourceManifest: ExecutionSourceManifest;
  outline: CurriculumOutlineItem[];
  /** Existing Concepts remain the only concept universe. */
  concepts: Concept[];
  /** Accepted active graph relations are optional supporting structure. */
  graphEdges: GraphEdge[];
  allowedCanonicalConceptIds: string[];
  canonicalConcepts: CurriculumCanonicalConceptOffer[];
  /** Accepted predecessor used only as compact semantic/locality context. */
  predecessor: Curriculum | null;
  /** Source blocks remain local provider input; output cannot quote them directly. */
  blocks: SourceBlock[];
  /** Exact evidence universe. Curriculum output may select only these identities. */
  evidenceCatalog: CurriculumEvidenceOffer[];
  limits: {
    maxNodes: number;
    maxObjectives: number;
    maxSynthesisGroups: number;
  };
}

/** Compact, bounded visibility for one exact local source-allocation region. */
export interface CourseMapAnchorOptionOffer {
  anchorOptionId: string;
  conceptName: string;
  conceptSummary: string;
  importance: Concept['importance'];
  canonicalConceptName: string | null;
  /** Local authority binding. Prompt construction must not expose these ids. */
  binding: {
    conceptId: string;
    canonicalConceptId: string | null;
  };
}

export interface CourseMapSourceRegionOffer {
  sourceRegionRef: string;
  /** Local authority binding. Prompt construction must not expose this id. */
  sourceAllocationRegionId: string;
  materialId: string;
  materialTitle: string;
  title: string;
  sectionCount: number;
  blockCount: number;
  charCount: number;
  anchorOptions: CourseMapAnchorOptionOffer[];
  evidence: Array<{ evidenceId: string; text: string }>;
}

/** Internal skeleton-generation input. Full SourceBlocks never cross this boundary. */
export interface CourseMapProposalInput {
  contractVersion: 'course_map_proposal_v2';
  workspaceName: string;
  contract: CurriculumContractContext;
  courseSourceMapFingerprint: string;
  sourceAllocationFingerprint: string;
  sourceRegions: CourseMapSourceRegionOffer[];
  limits: {
    maxModules: number;
    maxRegions: number;
    maxPrerequisiteEdges: number;
    maxPrerequisiteDegree: number;
    maxSynthesisGroups: number;
  };
}

export interface CurriculumDetailRegionInput {
  regionId: string;
  moduleId: string;
  moduleIndex: number;
  moduleTitle: string;
  regionIndex: number;
  title: string;
  learningIntent: string;
  approximateScope: 'focused' | 'standard' | 'extended';
  sourceAllocationRegionIds: string[];
  prerequisiteRegionIds: string[];
  synthesisGroups: Array<{
    id: string;
    title: string;
    level: 'module' | 'course' | 'transfer';
  }>;
  concepts: Array<{ id: string; name: string; summary: string }>;
  canonicalConcepts: CurriculumCanonicalConceptOffer[];
  evidence: Array<{ evidenceId: string; sourceAllocationRegionId: string; text: string }>;
}

/** One fixed-batch, operation-local detail request over server-owned Course Map regions. */
export interface CurriculumDetailProposalInput {
  workspaceName: string;
  contract: Pick<
    CurriculumContractContext,
    | 'intent'
    | 'targetOutcome'
    | 'desiredDepth'
    | 'subjectBoundaries'
    | 'includedTopics'
    | 'excludedTopics'
  >;
  courseMapId: string;
  sourceAllocationFingerprint: string;
  batchKey: string;
  regions: CurriculumDetailRegionInput[];
  limits: {
    maxUnits: number;
    maxObjectivesPerUnit: number;
    maxEvidenceSelectionsPerUnit: number;
  };
}

export interface StudyPlanContractContext extends CurriculumContractContext {
  deadline: { at: string; timeZone: string } | null;
  studyBudget: {
    minutesPerDay: number | null;
    minutesPerWeek: number | null;
    preferredSessionMinutes: number | null;
  };
  allowExplicitDeferral: boolean;
}

/** Accepted Curriculum projection; truth eligibility was already derived locally. */
export interface StudyPlanCurriculumUnit {
  id: string;
  title: string;
  objectiveIds: string[];
  objectiveSummaries: Array<{ id: string; title: string; description: string }>;
  prerequisiteUnitIds: string[];
  /** Only these objectives may be offered blocking formal requirements locally. */
  blockingEligibleObjectiveIds: string[];
  synthesisGroupIds: string[];
}

export interface StudyPlanLearnerState {
  curriculumLearningUnitId: string;
  state: 'unassessed' | 'in_progress' | 'formally_supported' | 'repair_needed' | 'deferred';
  observedMinutes: number | null;
  openMistakes: number;
}

export interface StudyPlanLaunchCapability {
  curriculumLearningUnitId: string;
  allowedItemKinds: StudyPlanItemKind[];
  launchableAssessmentModes: AssessmentMode[];
}

export interface StudyPlanProposalInput {
  workspaceName: string;
  contract: StudyPlanContractContext;
  curriculumVersionId: string;
  executionSourceManifestFingerprint: string;
  units: StudyPlanCurriculumUnit[];
  synthesisGroups: Array<{
    id: string;
    title: string;
    level: 'section' | 'chapter' | 'course' | 'transfer';
    learningUnitIds: string[];
    objectiveIds: string[];
  }>;
  /** Deterministic learner state; conversation and self-report are not evidence. */
  learnerState: StudyPlanLearnerState[];
  requiredLearningUnitIds: string[];
  allowedItemKinds: StudyPlanItemKind[];
  allowedDepths: DesiredDepth[];
  launchCapabilities: StudyPlanLaunchCapability[];
  /** Result of local deadline/time arithmetic, never recalculated by the model. */
  feasibility: StudyPlanFeasibility;
}

/**
 * Narrow interface every LLM backend implements. All methods return
 * Zod-validated payloads; implementations must never throw raw HTTP errors —
 * only ProviderError (see errors.ts).
 */
export interface LlmProvider {
  readonly name: 'fake' | 'hy3';
  /** Non-secret model identifier for auditable provider metadata. */
  readonly model?: string | undefined;
  /** Minimal, state-free connectivity check. Called only by the explicit Settings action. */
  testConnection(opts?: ProviderCallOptions): Promise<void>;
  analyzeConcepts(
    input: ConceptAnalysisInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptAnalysisPayload>;
  generateQuiz(
    input: QuizGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload>;
  gradeShortAnswer(
    input: ShortAnswerGradingInput,
    opts?: ProviderCallOptions,
  ): Promise<RubricGrade>;
  generateRemediation(
    input: RemediationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload>;
  /** Propose typed, evidence-cited relationships between EXISTING concepts. */
  proposeGraphEdges(
    input: GraphProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<GraphProposalPayload>;
  /** Propose a bounded, evidence-cited remediation plan for one concept. */
  proposeRemediationPlan(
    input: RemediationPlanInput,
    opts?: ProviderCallOptions,
  ): Promise<RemediationPlanProposalPayload>;
  /** Propose alignments between bounded, locally-pruned candidate pairs. */
  proposeConceptAlignment(
    input: AlignmentProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<AlignmentProposalPayload>;
  /** Propose blueprint+question pairs for a workspace assessment. */
  proposeAssessment(
    input: AssessmentProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<AssessmentProposalPayload>;
  /** Propose (or decline) a misconception hypothesis for one wrong answer. */
  proposeMisconception(
    input: MisconceptionProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<MisconceptionProposalPayload>;
  /** Generate a teaching lesson card for one course-confirmed concept. */
  generateConceptLesson(
    input: ConceptLessonInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptLessonPayload>;
  /** Generate semantic teaching content while selecting only offered local refs. */
  generateTeachingBrief(
    input: TeachingBriefGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<TeachingBriefProposalPayload>;
  /** One bounded Tutor iteration: call a whitelisted tool or finalize. */
  proposeTutorStep(input: TutorStepInput, opts?: ProviderCallOptions): Promise<TutorStepPayload>;
  /** Generate non-authoritative conversational guidance for a StudySession turn. */
  respondToTutorTurn(input: TutorTurnInput, opts?: ProviderCallOptions): Promise<TutorTurnPayload>;
  /** Propose a planning-only Curriculum skeleton; local code validates every identity and edge. */
  proposeCourseMap(
    input: CourseMapProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CourseMapProposalPayload>;
  /** Materialize semantic LearningUnit details for one fixed Course Map partition. */
  proposeCurriculumDetails(
    input: CurriculumDetailProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumDetailProposalPayload>;
  /** Propose learner-visible Curriculum semantics; local code validates and versions it. */
  proposeCurriculum(
    input: CurriculumProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload>;
  /** Propose an executable route; local code owns feasibility, policy, and acceptance. */
  proposeStudyPlan(
    input: StudyPlanProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalPayload>;
}
