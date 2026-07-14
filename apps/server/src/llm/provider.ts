import type {
  Concept,
  ConceptAnalysisPayload,
  QuizConfig,
  QuizGenerationPayload,
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
}
