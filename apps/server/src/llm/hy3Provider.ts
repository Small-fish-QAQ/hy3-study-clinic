import {
  AlignmentProposalPayloadSchema,
  AssessmentProposalPayloadSchema,
  ConceptAnalysisPayloadSchema,
  ConceptLessonPayloadSchema,
  CourseMapProposalPayloadSchema,
  CurriculumDetailProposalPayloadSchema,
  CurriculumProposalPayloadSchema,
  GraphProposalPayloadSchema,
  GroupedStudyPlanProposalPayloadSchema,
  MisconceptionProposalPayloadSchema,
  QuizGenerationPayloadSchema,
  RemediationPlanProposalPayloadSchema,
  StudyPlanProposalPayloadSchema,
  TeachingBriefProposalPayloadSchema,
  RubricGradeSchema,
  TutorStepPayloadSchema,
  TutorTurnPayloadSchema,
  type AlignmentProposalPayload,
  type AssessmentProposalPayload,
  type ConceptAnalysisPayload,
  type ConceptLessonPayload,
  type CourseMapProposalPayload,
  type CurriculumDetailProposalPayload,
  type CurriculumProposalPayload,
  type GraphProposalPayload,
  type GroupedStudyPlanProposalPayload,
  type MisconceptionProposalPayload,
  type QuizGenerationPayload,
  type RemediationPlanProposalPayload,
  type StudyPlanProposalPayload,
  type TeachingBriefProposalPayload,
  type RubricGrade,
  type TutorStepPayload,
  type TutorTurnPayload,
  type VisualDescriptionPayload,
} from '@hy3-clinic/shared';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { ProviderError } from './errors.js';
import { extractJsonWithFormat, JsonExtractionError } from './json.js';
import {
  alignmentProposalMessages,
  assessmentProposalMessages,
  conceptAnalysisMessages,
  conceptLessonMessages,
  courseMapProposalMessages,
  curriculumDetailProposalMessages,
  curriculumProposalMessages,
  graphProposalMessages,
  groupedStudyPlanProposalMessages,
  misconceptionProposalMessages,
  quizGenerationMessages,
  remediationMessages,
  remediationPlanMessages,
  shortAnswerGradingMessages,
  studyPlanProposalMessages,
  tutorStepMessages,
  tutorTurnMessages,
  teachingBriefMessages,
  type ChatMessage,
} from './prompts.js';
import type {
  AlignmentProposalInput,
  AssessmentProposalInput,
  ConceptAnalysisInput,
  ConceptLessonInput,
  CourseMapProposalInput,
  CurriculumDetailProposalInput,
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
  TeachingBriefGenerationInput,
  VisualDescriptionInput,
  StructuredOutputDiagnostic,
  StructuredOutputFailureCategory,
  TutorStepInput,
  TutorTurnInput,
} from './provider.js';
import {
  buildStructuredOutputDiagnostic,
  contentShape,
  safeFinishReason,
  type StructuredParseMetadata,
  type StructuredResponseMetadata,
} from './structuredOutputDiagnostics.js';
import { detailedStudyPlanSchema, detailedStudyPlanScopeFromInput } from './studyPlanContract.js';

export interface Hy3ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Observed Curriculum responses peaked at 10,962 tokens; retain bounded headroom. */
export const CURRICULUM_MAX_OUTPUT_TOKENS = 16_000;
export const COURSE_MAP_MAX_OUTPUT_TOKENS = 8_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ChatCompletionResult {
  content: string;
  response: StructuredResponseMetadata;
  envelopeFailure?:
    | {
        category: 'PROVIDER_FORMAT_INCOMPATIBILITY';
        summary: string;
      }
    | undefined;
}

const GROUPED_STUDY_PLAN_KINDS = [
  'teach_unit',
  'informal_check',
  'formal_checkpoint',
  'targeted_repair',
  'due_review',
] as const;

function groupedStudyPlanSchema(
  input: StudyPlanProposalInput,
): ZodType<GroupedStudyPlanProposalPayload, ZodTypeDef, unknown> {
  const requiredIds = new Set(input.requiredLearningUnitIds);
  const unitsById = new Map(input.units.map((unit) => [unit.id, unit]));
  const capabilitiesById = new Map(
    input.launchCapabilities.map((capability) => [capability.curriculumLearningUnitId, capability]),
  );
  return GroupedStudyPlanProposalPayloadSchema.superRefine((payload, ctx) => {
    const accounted = new Set<string>();
    const placed = new Set<string>();
    for (const [groupIndex, group] of payload.groups.entries()) {
      if (!input.allowedDepths.includes(group.targetDepth)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', groupIndex, 'targetDepth'],
          message: `unavailable depth; allowed values: ${input.allowedDepths.join(', ')}`,
        });
      }
      for (const [unitIndex, unitId] of group.curriculumLearningUnitIds.entries()) {
        const unit = unitsById.get(unitId);
        const path = ['groups', groupIndex, 'curriculumLearningUnitIds', unitIndex];
        if (!unit || !requiredIds.has(unitId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `unknown or non-required LearningUnit: ${unitId}`,
          });
          continue;
        }
        const allowedKinds = capabilitiesById
          .get(unitId)
          ?.allowedItemKinds.filter((kind) =>
            GROUPED_STUDY_PLAN_KINDS.includes(kind as (typeof GROUPED_STUDY_PLAN_KINDS)[number]),
          );
        if (!allowedKinds?.includes(group.kind)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['groups', groupIndex, 'kind'],
            message:
              allowedKinds && allowedKinds.length > 0
                ? `${group.kind} is unavailable for LearningUnit ${unitId}; allowed values: ${allowedKinds.join(', ')}`
                : `${group.kind} is unavailable for LearningUnit ${unitId}; allowed values: none, defer this unit`,
          });
        }
        const missingPrerequisite = unit.prerequisiteUnitIds.find(
          (prerequisiteId) => requiredIds.has(prerequisiteId) && !placed.has(prerequisiteId),
        );
        if (missingPrerequisite) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `prerequisite ${missingPrerequisite} must appear earlier`,
          });
        }
        placed.add(unitId);
        accounted.add(unitId);
      }
    }
    for (const [deferralIndex, deferral] of payload.deferrals.entries()) {
      if (!input.contract.allowExplicitDeferral) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deferrals', deferralIndex],
          message: 'deferrals are not allowed by the Contract',
        });
      }
      for (const [unitIndex, unitId] of deferral.curriculumLearningUnitIds.entries()) {
        if (!unitsById.has(unitId) || !requiredIds.has(unitId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['deferrals', deferralIndex, 'curriculumLearningUnitIds', unitIndex],
            message: `unknown or non-required LearningUnit: ${unitId}`,
          });
          continue;
        }
        accounted.add(unitId);
      }
    }
    for (const unitId of input.requiredLearningUnitIds) {
      if (!accounted.has(unitId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups'],
          message: `required LearningUnit is omitted: ${unitId}`,
        });
      }
    }
  });
}

function studyPlanRepairGuidance(input: StudyPlanProposalInput, grouped: boolean): string {
  const supported: ReadonlyArray<StudyPlanProposalInput['allowedItemKinds'][number]> = grouped
    ? GROUPED_STUDY_PLAN_KINDS
    : [
        'teach_unit',
        'informal_check',
        'formal_checkpoint',
        'synthesis',
        'targeted_repair',
        'due_review',
      ];
  const offered = supported.filter((kind) => input.allowedItemKinds.includes(kind));
  return [
    `Allowed kind literals for this request: ${offered.join(', ')}.`,
    'A kind is valid for an item or group only when the exact literal appears in every referenced LearningUnit allowedItemKinds list.',
    input.contract.allowExplicitDeferral
      ? 'A LearningUnit with no allowed kind must be moved to deferrals.'
      : 'Deferrals are forbidden; every LearningUnit must use an explicitly allowed kind.',
    'Never invent, combine, translate, or paraphrase a kind literal. Preserve every otherwise-valid field and exact supplied ID.',
  ].join('\n');
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
  get model(): string {
    return this.config.model;
  }
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: Hy3ProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Deliberate, minimal connectivity probe used only by Settings. */
  async testConnection(opts?: ProviderCallOptions): Promise<void> {
    const result = await this.chat(
      [
        { role: 'system', content: '只回复 OK。不要调用工具,不要生成学习内容。' },
        { role: 'user', content: 'OK' },
      ],
      { ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? 15_000, 15_000) },
      { temperature: 0, maxTokens: 1 },
    );
    if (result.envelopeFailure) {
      throw ProviderError.invalidOutput(
        result.envelopeFailure.summary,
        undefined,
        result.envelopeFailure.category,
      );
    }
    if (result.content.trim().length === 0) {
      throw ProviderError.invalidOutput('响应缺少 message.content。', undefined, 'EMPTY_RESPONSE');
    }
  }

  async describeVisual(
    _input: VisualDescriptionInput,
    opts?: ProviderCallOptions,
  ): Promise<VisualDescriptionPayload> {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    // The configured transport currently documents only string chat content.
    // Phase 6B2B must freeze and evaluate a real image-part contract first.
    throw ProviderError.invalidOutput(
      'Hy3 visual input transport is not configured.',
      undefined,
      'PROVIDER_FORMAT_INCOMPATIBILITY',
    );
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

  async generateTeachingBrief(
    input: TeachingBriefGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<TeachingBriefProposalPayload> {
    return this.complete(
      teachingBriefMessages(input),
      TeachingBriefProposalPayloadSchema,
      opts,
      'Use only offered O*, P*, and S* references; remove duplicates and cover every objective.',
      { maxTokens: 8_000, schemaName: 'teaching-brief-proposal-v1-local-refs' },
    );
  }

  async proposeTutorStep(
    input: TutorStepInput,
    opts?: ProviderCallOptions,
  ): Promise<TutorStepPayload> {
    return this.complete(tutorStepMessages(input), TutorStepPayloadSchema, opts);
  }

  async respondToTutorTurn(
    input: TutorTurnInput,
    opts?: ProviderCallOptions,
  ): Promise<TutorTurnPayload> {
    return this.complete(tutorTurnMessages(input), TutorTurnPayloadSchema, opts);
  }

  async proposeCurriculum(
    input: CurriculumProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload> {
    return this.complete(
      curriculumProposalMessages(input),
      CurriculumProposalPayloadSchema,
      opts,
      undefined,
      {
        maxTokens: CURRICULUM_MAX_OUTPUT_TOKENS,
        schemaName: 'curriculum-proposal-v2-evidence-identity',
      },
    );
  }

  async proposeCourseMap(
    input: CourseMapProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CourseMapProposalPayload> {
    return this.complete(
      courseMapProposalMessages(input),
      CourseMapProposalPayloadSchema,
      opts,
      undefined,
      {
        maxTokens: COURSE_MAP_MAX_OUTPUT_TOKENS,
        schemaName: 'course-map-proposal-v2-local-refs',
      },
    );
  }

  async proposeCurriculumDetails(
    input: CurriculumDetailProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumDetailProposalPayload> {
    return this.complete(
      curriculumDetailProposalMessages(input),
      CurriculumDetailProposalPayloadSchema,
      opts,
      undefined,
      {
        maxTokens: CURRICULUM_MAX_OUTPUT_TOKENS,
        schemaName: 'curriculum-detail-proposal-v1',
      },
    );
  }

  async proposeStudyPlan(
    input: StudyPlanProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalPayload> {
    if (input.units.length >= 80) {
      const grouped = await this.complete(
        groupedStudyPlanProposalMessages(input),
        groupedStudyPlanSchema(input),
        opts,
        studyPlanRepairGuidance(input, true),
      );
      return this.expandGroupedStudyPlan(input, grouped);
    }
    return this.complete(
      studyPlanProposalMessages(input),
      detailedStudyPlanSchema(detailedStudyPlanScopeFromInput(input)),
      opts,
      studyPlanRepairGuidance(input, false),
    );
  }

  private expandGroupedStudyPlan(
    input: StudyPlanProposalInput,
    grouped: GroupedStudyPlanProposalPayload,
  ): StudyPlanProposalPayload {
    const requiredIds = new Set(input.requiredLearningUnitIds);
    const unitsById = new Map(input.units.map((unit) => [unit.id, unit]));
    const capabilitiesById = new Map(
      input.launchCapabilities.map((capability) => [
        capability.curriculumLearningUnitId,
        capability,
      ]),
    );
    const itemKeyByUnitId = new Map<string, string>();
    const accounted = new Set<string>();
    const items: StudyPlanProposalPayload['items'] = [];
    const deferrals: StudyPlanProposalPayload['deferrals'] = [];
    const invalid = (message: string): never => {
      throw ProviderError.invalidOutput(message);
    };

    for (const group of grouped.groups) {
      if (!input.allowedDepths.includes(group.targetDepth)) {
        invalid(`Grouped StudyPlan uses an unavailable depth: ${group.targetDepth}.`);
      }
      for (const unitId of group.curriculumLearningUnitIds) {
        const unit = unitsById.get(unitId);
        if (!unit) {
          throw ProviderError.invalidOutput(
            `Grouped StudyPlan references an unknown LearningUnit: ${unitId}.`,
          );
        }
        if (!requiredIds.has(unitId)) {
          invalid(`Grouped StudyPlan references a non-required LearningUnit: ${unitId}.`);
        }
        if (accounted.has(unitId)) {
          invalid(`Grouped StudyPlan repeats LearningUnit: ${unitId}.`);
        }
        const capability = capabilitiesById.get(unitId);
        if (!capability?.allowedItemKinds.includes(group.kind)) {
          invalid(`Grouped StudyPlan kind ${group.kind} is unavailable for ${unitId}.`);
        }
        const missingPrerequisite = unit.prerequisiteUnitIds.find(
          (prerequisiteId) =>
            requiredIds.has(prerequisiteId) && !itemKeyByUnitId.has(prerequisiteId),
        );
        if (missingPrerequisite) {
          invalid(
            `Grouped StudyPlan must place prerequisite ${missingPrerequisite} before ${unitId}.`,
          );
        }
        const key = `item-${items.length + 1}`;
        items.push({
          key,
          phase: group.phase,
          kind: group.kind,
          curriculumLearningUnitId: unitId,
          rationale: group.rationale,
          estimatedMinutes: group.estimatedMinutesPerUnit,
          targetDepth: group.targetDepth,
          objectiveIds: unit.objectiveIds,
          prerequisiteItemKeys: unit.prerequisiteUnitIds
            .map((prerequisiteId) => itemKeyByUnitId.get(prerequisiteId))
            .filter((itemKey): itemKey is string => Boolean(itemKey)),
        });
        itemKeyByUnitId.set(unitId, key);
        accounted.add(unitId);
      }
    }

    for (const deferral of grouped.deferrals) {
      if (!input.contract.allowExplicitDeferral) {
        invalid('Grouped StudyPlan deferrals are not allowed by the Contract.');
      }
      for (const unitId of deferral.curriculumLearningUnitIds) {
        const unit = unitsById.get(unitId);
        if (!unit) {
          throw ProviderError.invalidOutput(
            `Grouped StudyPlan defers an unknown LearningUnit: ${unitId}.`,
          );
        }
        if (!requiredIds.has(unitId)) {
          invalid(`Grouped StudyPlan defers a non-required LearningUnit: ${unitId}.`);
        }
        if (accounted.has(unitId)) {
          invalid(`Grouped StudyPlan repeats LearningUnit: ${unitId}.`);
        }
        deferrals.push({
          curriculumLearningUnitId: unitId,
          objectiveIds: unit.objectiveIds,
          reason: deferral.reason,
        });
        accounted.add(unitId);
      }
    }

    const omitted = input.requiredLearningUnitIds.find((unitId) => !accounted.has(unitId));
    if (omitted) invalid(`Grouped StudyPlan omits required LearningUnit: ${omitted}.`);
    return StudyPlanProposalPayloadSchema.parse({
      rationale: grouped.rationale,
      items,
      deferrals,
    });
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
    repairGuidance?: string,
    requestOptions: { maxTokens?: number; schemaName?: string } = {},
  ): Promise<T> {
    const schemaName =
      requestOptions.schemaName ??
      opts?.telemetry?.schemaFingerprint ??
      opts?.telemetry?.operationType ??
      'provider-structured-output';
    const original = await this.chatWithDiagnostic(
      messages,
      opts,
      requestOptions,
      schemaName,
      1,
      'original',
    );
    const first = this.tryParse(original, schema, opts);
    this.emitDiagnostic(
      opts,
      buildStructuredOutputDiagnostic({
        schemaName,
        operationType: opts?.telemetry?.operationType ?? null,
        attemptNumber: 1,
        attemptKind: 'original',
        model: this.config.model,
        response: original.response,
        parse: first.parse,
        repairAction: first.ok ? 'none' : first.repairable ? 'requested' : 'none',
      }),
    );
    if (first.ok) return first.value;
    if (!first.repairable) {
      throw ProviderError.invalidOutput(first.error, first.reason, first.category);
    }

    // One bounded repair attempt.
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: original.content },
      {
        role: 'user',
        content: [
          '你上一次的输出未通过校验,存在以下问题:',
          first.error,
          ...(repairGuidance ? ['本次请求的精确修复约束:', repairGuidance] : []),
          '请仅修复这些问题,重新输出符合要求的 JSON。仍然只输出 JSON,不要解释。',
        ].join('\n'),
      },
    ];
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    opts?.onRepairAttempt?.(first.reason, first.category);
    const repaired = await this.chatWithDiagnostic(
      repairMessages,
      opts,
      requestOptions,
      schemaName,
      2,
      'repair',
    );
    const second = this.tryParse(repaired, schema, opts);
    this.emitDiagnostic(
      opts,
      buildStructuredOutputDiagnostic({
        schemaName,
        operationType: opts?.telemetry?.operationType ?? null,
        attemptNumber: 2,
        attemptKind: 'repair',
        model: this.config.model,
        response: repaired.response,
        parse: second.parse,
        repairAction: second.ok ? 'none' : 'exhausted',
      }),
    );
    if (second.ok) return second.value;

    throw ProviderError.invalidOutput(second.error, second.reason, second.category, true);
  }

  private tryParse<T>(
    result: ChatCompletionResult,
    schema: ZodType<T, ZodTypeDef, unknown>,
    opts?: ProviderCallOptions,
  ):
    | { ok: true; value: T; parse: StructuredParseMetadata }
    | {
        ok: false;
        error: string;
        reason: 'schema' | 'candidate';
        category: StructuredOutputFailureCategory;
        repairable: boolean;
        parse: StructuredParseMetadata;
      } {
    const abnormalFinishReason =
      result.response.finishReason === 'sensitive' ||
      result.response.finishReason === 'content_filter' ||
      result.response.finishReason === 'tool_calls' ||
      result.response.finishReason === 'function_call';
    if (result.envelopeFailure) {
      return {
        ok: false,
        error: result.envelopeFailure.summary,
        reason: 'schema',
        category: result.envelopeFailure.category,
        repairable: false,
        parse: {
          jsonParseSuccess: false,
          jsonFormat: null,
          parsed: undefined,
          failureCategory: result.envelopeFailure.category,
        },
      };
    }

    let extracted: ReturnType<typeof extractJsonWithFormat>;
    try {
      extracted = extractJsonWithFormat(result.content);
    } catch (err) {
      if (err instanceof JsonExtractionError) {
        result.response.possiblyIncomplete = err.kind === 'incomplete_json';
        const category: StructuredOutputFailureCategory = abnormalFinishReason
          ? 'PROVIDER_FORMAT_INCOMPATIBILITY'
          : result.response.truncated
            ? 'TRUNCATED_OUTPUT'
            : err.kind === 'empty'
              ? 'EMPTY_RESPONSE'
              : err.kind === 'format_incompatible'
                ? 'PROVIDER_FORMAT_INCOMPATIBILITY'
                : 'JSON_PARSE_FAILURE';
        return {
          ok: false,
          error: err.message,
          reason: 'schema',
          category,
          repairable: !abnormalFinishReason,
          parse: {
            jsonParseSuccess: false,
            jsonFormat: null,
            parsed: undefined,
            failureCategory: category,
          },
        };
      }
      throw err;
    }

    const parsed = schema.safeParse(extracted.value);
    if (abnormalFinishReason) {
      return {
        ok: false,
        error: `模型服务以异常原因结束结构化输出: ${result.response.finishReason}。`,
        reason: 'schema',
        category: 'PROVIDER_FORMAT_INCOMPATIBILITY',
        repairable: false,
        parse: {
          jsonParseSuccess: true,
          jsonFormat: extracted.format,
          parsed: extracted.value,
          ...(!parsed.success ? { schemaIssues: parsed.error.issues } : {}),
          failureCategory: 'PROVIDER_FORMAT_INCOMPATIBILITY',
        },
      };
    }
    if (result.response.truncated) {
      return {
        ok: false,
        error: '模型输出因长度限制而截断。',
        reason: 'schema',
        category: 'TRUNCATED_OUTPUT',
        repairable: true,
        parse: {
          jsonParseSuccess: true,
          jsonFormat: extracted.format,
          parsed: extracted.value,
          ...(!parsed.success ? { schemaIssues: parsed.error.issues } : {}),
          failureCategory: 'TRUNCATED_OUTPUT',
        },
      };
    }
    if (parsed.success) {
      const candidate = opts?.validateCandidate?.(parsed.data);
      if (candidate && !candidate.valid) {
        return {
          ok: false,
          error: candidate.diagnostics.slice(0, 20).join('; ').slice(0, 8_000),
          reason: 'candidate',
          category: 'SEMANTIC_VALIDATION_FAILURE',
          repairable: true,
          parse: {
            jsonParseSuccess: true,
            jsonFormat: extracted.format,
            parsed: extracted.value,
            semanticIssueCodes: candidate.diagnosticCodes ?? ['candidate_validation_failed'],
            failureCategory: 'SEMANTIC_VALIDATION_FAILURE',
          },
        };
      }
      return {
        ok: true,
        value: parsed.data,
        parse: {
          jsonParseSuccess: true,
          jsonFormat: extracted.format,
          parsed: extracted.value,
          failureCategory: null,
        },
      };
    }
    const summary = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      error: summary,
      reason: 'schema',
      category: 'SCHEMA_VALIDATION_FAILURE',
      repairable: true,
      parse: {
        jsonParseSuccess: true,
        jsonFormat: extracted.format,
        parsed: extracted.value,
        schemaIssues: parsed.error.issues,
        failureCategory: 'SCHEMA_VALIDATION_FAILURE',
      },
    };
  }

  private emitDiagnostic(
    opts: ProviderCallOptions | undefined,
    diagnostic: StructuredOutputDiagnostic,
  ): void {
    try {
      opts?.onStructuredOutputDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are observational and must never change provider behavior.
    }
  }

  private async chatWithDiagnostic(
    messages: ChatMessage[],
    opts: ProviderCallOptions | undefined,
    requestOptions: { maxTokens?: number },
    schemaName: string,
    attemptNumber: 1 | 2,
    attemptKind: 'original' | 'repair',
  ): Promise<ChatCompletionResult> {
    try {
      return await this.chat(messages, opts, requestOptions);
    } catch (error) {
      this.emitDiagnostic(
        opts,
        buildStructuredOutputDiagnostic({
          schemaName,
          operationType: opts?.telemetry?.operationType ?? null,
          attemptNumber,
          attemptKind,
          model: this.config.model,
          response: {
            transportSuccess: false,
            httpStatus: error instanceof ProviderError ? (error.technicalHttpStatus ?? null) : null,
            responseBodyBytes: null,
            contentType: 'missing',
            contentBytes: null,
            contentFingerprint: null,
            finishReason: null,
            truncated: false,
            possiblyIncomplete: false,
          },
          parse: {
            jsonParseSuccess: false,
            jsonFormat: null,
            parsed: undefined,
            failureCategory: 'TRANSPORT_FAILURE',
          },
          repairAction: attemptKind === 'repair' ? 'exhausted' : 'none',
        }),
      );
      throw error;
    }
  }

  /** Single chat completion call with timeout + external cancellation. */
  private async chat(
    messages: ChatMessage[],
    opts?: ProviderCallOptions,
    requestOptions: {
      temperature?: number;
      maxTokens?: number;
    } = {},
  ): Promise<ChatCompletionResult> {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();

    const timeoutMs = opts?.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const abortError = (): ProviderError => {
      if (opts?.signal?.aborted) return ProviderError.cancelled();
      if (timedOut) return ProviderError.timeout(timeoutMs);
      return ProviderError.cancelled();
    };

    try {
      opts?.onRequestSent?.();
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
            temperature: requestOptions.temperature ?? 0.2,
            ...(requestOptions.maxTokens !== undefined
              ? { max_tokens: requestOptions.maxTokens }
              : {}),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw ProviderError.http(response.status);
      }

      let body: string;
      try {
        body = await response.text();
      } catch {
        if (controller.signal.aborted) throw abortError();
        throw ProviderError.network();
      }

      // The timeout/cancellation budget covers the complete body read, not
      // merely the arrival of response headers.
      if (controller.signal.aborted) throw abortError();

      const responseBodyBytes = Buffer.byteLength(body, 'utf8');
      let data: ChatCompletionResponse;
      try {
        const parsed = JSON.parse(body) as unknown;
        data =
          parsed !== null && typeof parsed === 'object' ? (parsed as ChatCompletionResponse) : {};
      } catch {
        return {
          content: '',
          response: {
            transportSuccess: true,
            httpStatus: response.status,
            responseBodyBytes,
            contentType: 'missing',
            contentBytes: null,
            contentFingerprint: null,
            finishReason: null,
            truncated: false,
            possiblyIncomplete: false,
          },
          envelopeFailure: {
            category: 'PROVIDER_FORMAT_INCOMPATIBILITY',
            summary: '模型服务响应不是合法 JSON。',
          },
        };
      }

      const nonnegativeInteger = (value: unknown): number | null =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
      opts?.onUsage?.({
        inputTokens: nonnegativeInteger(data.usage?.prompt_tokens),
        outputTokens: nonnegativeInteger(data.usage?.completion_tokens),
        reasoningTokens: nonnegativeInteger(
          data.usage?.completion_tokens_details?.reasoning_tokens,
        ),
        cacheReadTokens: nonnegativeInteger(data.usage?.prompt_tokens_details?.cached_tokens),
        cacheWriteTokens: null,
        estimatedCostMicrounits: null,
        currency: null,
        pricingSource: null,
        pricingVersion: null,
      });

      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      const finishReason = safeFinishReason(choice?.finish_reason);
      const baseResponse = {
        transportSuccess: true,
        httpStatus: response.status,
        responseBodyBytes,
        contentType: contentShape(content),
        contentBytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : null,
        contentFingerprint: null,
        finishReason,
        truncated: finishReason === 'length',
        possiblyIncomplete: false,
      } satisfies StructuredResponseMetadata;
      if (typeof content !== 'string') {
        return {
          content: '',
          response: baseResponse,
          envelopeFailure: {
            category: 'PROVIDER_FORMAT_INCOMPATIBILITY',
            summary: '模型服务响应缺少字符串 message.content。',
          },
        };
      }
      return { content, response: baseResponse };
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
