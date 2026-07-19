import type {
  Concept,
  ConceptAnalysisPayload,
  GraphProposalPayload,
  GraphRelation,
  MasteryState,
  QuestionType,
  QuizConfig,
  QuizGenerationPayload,
  RemediationPlanProposalPayload,
  RubricGrade,
  SourceBlock,
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
  rubricKeyPoints: string[];
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
}
