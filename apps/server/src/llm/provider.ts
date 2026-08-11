import type {
  AlignmentLanguage,
  AlignmentProposalPayload,
  AssessmentMode,
  AssessmentProposalPayload,
  Concept,
  ConceptAnalysisPayload,
  ConceptLessonPayload,
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
  TutorStepPayload,
  TutorTurnPayload,
  StudyExchange,
  StudySessionSummary,
  TutorToolName,
} from '@hy3-clinic/shared';

/** Options threaded through every provider call. */
export interface ProviderCallOptions {
  /** Abort signal from the HTTP request (client cancellation). */
  signal?: AbortSignal | undefined;
  /** Internal telemetry hook: a schema repair is a new physical request. */
  onRepairAttempt?: (() => void) | undefined;
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
  sourceBlockIds: string[];
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
  /** Bounded evidence space. Every proposed quote must come from these blocks. */
  blocks: SourceBlock[];
  limits: {
    maxNodes: number;
    maxObjectives: number;
    maxSynthesisGroups: number;
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
  /** One bounded Tutor iteration: call a whitelisted tool or finalize. */
  proposeTutorStep(input: TutorStepInput, opts?: ProviderCallOptions): Promise<TutorStepPayload>;
  /** Generate non-authoritative conversational guidance for a StudySession turn. */
  respondToTutorTurn(input: TutorTurnInput, opts?: ProviderCallOptions): Promise<TutorTurnPayload>;
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
