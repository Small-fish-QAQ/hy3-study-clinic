import {
  AlignmentProposalPayloadSchema,
  AssessmentProposalPayloadSchema,
  ConceptAnalysisPayloadSchema,
  ConceptLessonPayloadSchema,
  CurriculumProposalPayloadSchema,
  GraphProposalPayloadSchema,
  MisconceptionProposalPayloadSchema,
  QuizGenerationPayloadSchema,
  RemediationPlanProposalPayloadSchema,
  StudyPlanProposalPayloadSchema,
  RubricGradeSchema,
  TutorStepPayloadSchema,
  type AlignmentProposalPayload,
  type AssessmentProposalPayload,
  type ConceptAnalysisPayload,
  type ConceptLessonPayload,
  type CurriculumProposalPayload,
  type GraphProposalPayload,
  type MisconceptionProposalPayload,
  type QuizGenerationPayload,
  type RemediationPlanProposalPayload,
  type StudyPlanProposalPayload,
  type RubricGrade,
  type TutorStepPayload,
} from '@hy3-clinic/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { ProviderError } from './errors.js';
import { extractJson, JsonExtractionError } from './json.js';
import {
  alignmentProposalMessages,
  assessmentProposalMessages,
  conceptAnalysisMessages,
  conceptLessonMessages,
  curriculumProposalMessages,
  graphProposalMessages,
  misconceptionProposalMessages,
  quizGenerationMessages,
  remediationMessages,
  remediationPlanMessages,
  shortAnswerGradingMessages,
  studyPlanProposalMessages,
  tutorStepMessages,
  type ChatMessage,
} from './prompts.js';
import type {
  AlignmentProposalInput,
  AssessmentProposalInput,
  ConceptAnalysisInput,
  ConceptLessonInput,
  CurriculumProposalInput,
  GraphProposalInput,
  LlmProvider,
  MisconceptionProposalInput,
  ProviderCallOptions,
  QuizGenerationInput,
  RemediationInput,
  RemediationPlanInput,
  ShortAnswerGradingInput,
  StudyPlanProposalInput,
  TutorStepInput,
} from './provider.js';

export interface Hy3ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * OpenAI-compatible HTTP adapter for Hy3.
 *
 * Not tied to any specific commercial endpoint — baseUrl/model/key all come
 * from server-side env config. Enforces per-call timeout + external
 * cancellation, extracts JSON safely, validates with Zod, and grants exactly
 * ONE bounded repair attempt before failing with a structured ProviderError.
 * The API key is only ever sent in the Authorization header; it is never
 * logged or included in any thrown message.
 */
export class Hy3Provider implements LlmProvider {
  readonly name = 'hy3' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: Hy3ProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async analyzeConcepts(
    input: ConceptAnalysisInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptAnalysisPayload> {
    return this.complete(
      conceptAnalysisMessages(input.materialTitle, input.blocks, {
        ...(input.sectionTitle !== undefined ? { sectionTitle: input.sectionTitle } : {}),
        ...(input.maxConcepts !== undefined ? { maxConcepts: input.maxConcepts } : {}),
      }),
      ConceptAnalysisPayloadSchema,
      opts,
    );
  }

  async generateQuiz(
    input: QuizGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload> {
    return this.complete(
      quizGenerationMessages(input.materialTitle, input.blocks, input.concepts, input.config),
      QuizGenerationPayloadSchema,
      opts,
    );
  }

  async gradeShortAnswer(
    input: ShortAnswerGradingInput,
    opts?: ProviderCallOptions,
  ): Promise<RubricGrade> {
    return this.complete(
      shortAnswerGradingMessages(
        input.stem,
        input.expectedAnswer,
        input.rubricKeyPoints,
        input.quote,
        input.answerText,
      ),
      RubricGradeSchema,
      opts,
    );
  }

  async generateRemediation(
    input: RemediationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload> {
    return this.complete(
      remediationMessages(
        input.materialTitle,
        input.blocks,
        input.targets,
        input.questionsPerConcept,
      ),
      QuizGenerationPayloadSchema,
      opts,
    );
  }

  async proposeGraphEdges(
    input: GraphProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<GraphProposalPayload> {
    return this.complete(
      graphProposalMessages(input.workspaceName, input.blocks, input.concepts, input.maxEdges),
      GraphProposalPayloadSchema,
      opts,
    );
  }

  async proposeRemediationPlan(
    input: RemediationPlanInput,
    opts?: ProviderCallOptions,
  ): Promise<RemediationPlanProposalPayload> {
    return this.complete(
      remediationPlanMessages(input),
      RemediationPlanProposalPayloadSchema,
      opts,
    );
  }

  async proposeConceptAlignment(
    input: AlignmentProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<AlignmentProposalPayload> {
    return this.complete(alignmentProposalMessages(input), AlignmentProposalPayloadSchema, opts);
  }

  async proposeAssessment(
    input: AssessmentProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<AssessmentProposalPayload> {
    return this.complete(assessmentProposalMessages(input), AssessmentProposalPayloadSchema, opts);
  }

  async proposeMisconception(
    input: MisconceptionProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<MisconceptionProposalPayload> {
    return this.complete(
      misconceptionProposalMessages(input),
      MisconceptionProposalPayloadSchema,
      opts,
    );
  }

  async generateConceptLesson(
    input: ConceptLessonInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptLessonPayload> {
    return this.complete(conceptLessonMessages(input), ConceptLessonPayloadSchema, opts);
  }

  async proposeTutorStep(
    input: TutorStepInput,
    opts?: ProviderCallOptions,
  ): Promise<TutorStepPayload> {
    return this.complete(tutorStepMessages(input), TutorStepPayloadSchema, opts);
  }

  async proposeCurriculum(
    input: CurriculumProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload> {
    return this.complete(curriculumProposalMessages(input), CurriculumProposalPayloadSchema, opts);
  }

  async proposeStudyPlan(
    input: StudyPlanProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalPayload> {
    return this.complete(studyPlanProposalMessages(input), StudyPlanProposalPayloadSchema, opts);
  }

  /**
   * Core request/validate loop with a single bounded repair attempt.
   * Attempt 1: original messages. Attempt 2 (only on validation failure):
   * original messages + the assistant's bad reply + a repair instruction
   * quoting the Zod errors. After that, fail with a structured error.
   */
  private async complete<T>(
    messages: ChatMessage[],
    schema: ZodType<T, ZodTypeDef, unknown>,
    opts?: ProviderCallOptions,
  ): Promise<T> {
    const raw = await this.chat(messages, opts);
    const first = this.tryParse(raw, schema);
    if (first.ok) return first.value;

    // One bounded repair attempt.
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: [
          '你上一次的输出未通过校验,存在以下问题:',
          first.error,
          '请仅修复这些问题,重新输出符合要求的 JSON。仍然只输出 JSON,不要解释。',
        ].join('\n'),
      },
    ];
    const repaired = await this.chat(repairMessages, opts);
    const second = this.tryParse(repaired, schema);
    if (second.ok) return second.value;

    throw ProviderError.invalidOutput(second.error);
  }

  private tryParse<T>(
    raw: string,
    schema: ZodType<T, ZodTypeDef, unknown>,
  ): { ok: true; value: T } | { ok: false; error: string } {
    let json: unknown;
    try {
      json = extractJson(raw);
    } catch (err) {
      if (err instanceof JsonExtractionError) return { ok: false, error: err.message };
      throw err;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data };
    const summary = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, error: summary };
  }

  /** Single chat completion call with timeout + external cancellation. */
  private async chat(messages: ChatMessage[], opts?: ProviderCallOptions): Promise<string> {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const abortError = (): ProviderError => {
      if (opts?.signal?.aborted) return ProviderError.cancelled();
      if (timedOut) return ProviderError.timeout(this.config.timeoutMs);
      return ProviderError.cancelled();
    };

    try {
      const response = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            temperature: 0.2,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw ProviderError.http(response.status);
      }

      let data: ChatCompletionResponse;
      try {
        data = (await response.json()) as ChatCompletionResponse;
      } catch {
        if (controller.signal.aborted) throw abortError();
        throw ProviderError.invalidOutput('响应不是合法 JSON。');
      }

      // The timeout/cancellation budget covers the complete body read, not
      // merely the arrival of response headers.
      if (controller.signal.aborted) throw abortError();

      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw ProviderError.invalidOutput('响应缺少 message.content。');
      }
      return content;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (controller.signal.aborted) throw abortError();
      throw ProviderError.network();
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
    }
  }
}
