import type {
  AlignmentLanguage,
  AlignmentProposalPayload,
  AssessmentMode,
  AssessmentProposalPayload,
  Concept,
  ConceptAnalysisPayload,
  GraphProposalPayload,
  GraphRelation,
  MasteryState,
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
  TutorStepPayload,
  TutorToolName,
} from '@hy3-clinic/shared';

/** Options threaded through every provider call. */
export interface ProviderCallOptions {
  /** Abort signal from the HTTP request (client cancellation). */
  signal?: AbortSignal | undefined;
}

export interface ConceptAnalysisInput {
  materialTitle: string;
  blocks: SourceBlock[];
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
  /** One bounded Tutor iteration: call a whitelisted tool or finalize. */
  proposeTutorStep(input: TutorStepInput, opts?: ProviderCallOptions): Promise<TutorStepPayload>;
}
