import { z } from 'zod';
import { VisualAdvisoryContextSchema } from './visual.js';
import { CourseExecutionCommandEnvelopeSchema } from './learningContract.js';
import { StudySessionStatusSchema } from './studySession.js';
import {
  LearnerPracticeProjectionSchema,
  LessonPracticeAttemptStateSchema,
} from './lessonPractice.js';

/** Weak, session-owned lesson-presentation state. It carries no learning credit. */
export const LessonExecutionPreparationStatusSchema = z.enum([
  'preparing',
  'ready',
  'retryable_failure',
]);
export type LessonExecutionPreparationStatus = z.infer<
  typeof LessonExecutionPreparationStatusSchema
>;

export const LessonWorkedInteractionStateSchema = z
  .object({
    guidedResponse: z.string().min(1).max(80).nullable(),
    guidedRespondedAt: z.string().datetime().nullable(),
    scaffoldResponse: z.string().min(1).max(80).nullable(),
    scaffoldRespondedAt: z.string().datetime().nullable(),
    transferResponse: z.string().min(1).max(80).nullable(),
    transferRespondedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((state, ctx) => {
    for (const [responseKey, timeKey] of [
      ['guidedResponse', 'guidedRespondedAt'],
      ['scaffoldResponse', 'scaffoldRespondedAt'],
      ['transferResponse', 'transferRespondedAt'],
    ] as const) {
      if ((state[responseKey] === null) !== (state[timeKey] === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [responseKey],
          message: 'worked-interaction response and timestamp must be present together',
        });
      }
    }
    if (state.scaffoldResponse !== null && state.guidedResponse === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scaffoldResponse'],
        message: 'worked-interaction scaffold cannot precede the guided response',
      });
    }
    if (state.transferResponse !== null && state.guidedResponse === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transferResponse'],
        message: 'worked-interaction transfer cannot precede the guided response',
      });
    }
  });
export type LessonWorkedInteractionState = z.infer<typeof LessonWorkedInteractionStateSchema>;

export const LessonInformalInteractionStateSchema = z
  .object({
    segmentIndex: z.number().int().nonnegative(),
    presentedAt: z.string().datetime(),
    response: z.string().min(1).max(2000).nullable(),
    respondedAt: z.string().datetime().nullable(),
    /** Absent on historical segment-level informal checks. */
    workedInteraction: LessonWorkedInteractionStateSchema.optional(),
  })
  .strict();
export type LessonInformalInteractionState = z.infer<typeof LessonInformalInteractionStateSchema>;

export const LessonExecutionStateSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    agendaItemId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    learningUnitId: z.string().min(1),
    teachingBriefId: z.string().min(1).nullable(),
    acceptedLessonCheckpointId: z.string().min(1).nullable(),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    sourceContextFingerprint: z.string().min(1).max(200).nullable(),
    preparationStatus: LessonExecutionPreparationStatusSchema,
    preparationOperationId: z.string().min(1).nullable(),
    version: z.number().int().positive(),
    currentSegmentIndex: z.number().int().nonnegative(),
    presentedSegmentIndexes: z.array(z.number().int().nonnegative()).max(12),
    informalInteractions: z.array(LessonInformalInteractionStateSchema).max(12),
    presentationCompletedAt: z.string().datetime().nullable(),
    practiceInteractions: z.array(LessonPracticeAttemptStateSchema).max(16).default([]),
    practiceCompletedAt: z.string().datetime().nullable().default(null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (
      state.preparationStatus === 'ready' &&
      (!state.teachingBriefId || !state.sourceContextFingerprint)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preparationStatus'],
        message: 'ready lesson execution requires an immutable Teaching Brief binding',
      });
    }
    const presented = new Set(state.presentedSegmentIndexes);
    if (presented.size !== state.presentedSegmentIndexes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['presentedSegmentIndexes'],
        message: 'presented lesson segment indexes must be unique',
      });
    }
    if (
      state.presentedSegmentIndexes.some(
        (index, position) => position > 0 && index <= state.presentedSegmentIndexes[position - 1]!,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['presentedSegmentIndexes'],
        message: 'presented lesson segment indexes must be ordered',
      });
    }
    const informalIndexes = state.informalInteractions.map(
      (interaction) => interaction.segmentIndex,
    );
    if (new Set(informalIndexes).size !== informalIndexes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['informalInteractions'],
        message: 'informal interaction state must be unique per segment',
      });
    }
    const practiceAttemptKeys = state.practiceInteractions.map(
      (attempt) => `${attempt.itemIndex}:${attempt.attemptNumber}`,
    );
    if (new Set(practiceAttemptKeys).size !== practiceAttemptKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['practiceInteractions'],
        message: 'Practice attempts must be unique per item and attempt number',
      });
    }
  });
export type LessonExecutionState = z.infer<typeof LessonExecutionStateSchema>;

export const LessonExecutionEventSchema = z
  .object({
    id: z.string().min(1),
    lessonExecutionStateId: z.string().min(1),
    seq: z.number().int().positive(),
    commandId: z.string().min(1).max(200),
    kind: z.enum([
      'preparation_started',
      'preparation_ready',
      'preparation_failed',
      'segment_presented',
      'segment_revisited',
      'informal_response_recorded',
      'practice_response_recorded',
      'practice_repair_prepared',
      'practice_retest_started',
      'practice_retest_response_recorded',
      'practice_completed',
      'presentation_completed',
    ]),
    payload: z.record(z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();
export type LessonExecutionEvent = z.infer<typeof LessonExecutionEventSchema>;

export const LessonSourceProjectionSchema = z
  .object({
    referenceKey: z.string().min(1).max(40),
    materialTitle: z.string().min(1).max(500),
    headingPath: z.array(z.string().min(1).max(300)).max(10),
    pageNumber: z.number().int().positive().nullable(),
    slideNumber: z.number().int().positive().nullable().default(null),
    locationLabel: z.string().min(1).max(1000),
    exactExcerpt: z.string().min(1).max(2000),
    classification: z.literal('exact_source_excerpt'),
  })
  .strict();
export type LessonSourceProjection = z.infer<typeof LessonSourceProjectionSchema>;

export const LessonVisualProjectionSchema = VisualAdvisoryContextSchema;
export type LessonVisualProjection = z.infer<typeof LessonVisualProjectionSchema>;

export const LessonTeachingOriginSchema = z.enum(['source_grounded', 'hy3_synthesis']);
export type LessonTeachingOrigin = z.infer<typeof LessonTeachingOriginSchema>;

const LessonIllustrationProjectionSchema = z
  .object({
    text: z.string().min(1).max(1800),
    origin: LessonTeachingOriginSchema,
    sources: z.array(LessonSourceProjectionSchema).max(8),
  })
  .strict();

const LessonInformalCheckProjectionSchema = z
  .object({
    kind: z.enum(['explain_in_your_words', 'predict', 'choose', 'apply']),
    prompt: z.string().min(1).max(700),
    guidance: z.string().max(500).nullable(),
    options: z
      .array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(600) }).strict())
      .max(5)
      .optional(),
    presented: z.boolean(),
    response: z.string().min(1).max(2000).nullable(),
    respondedAt: z.string().datetime().nullable(),
    /** Null for reflective checks that local code cannot grade honestly. */
    correct: z.boolean().nullable().optional(),
    feedback: z.string().max(900).nullable().optional(),
    credit: z.literal('none'),
  })
  .strict();

const LessonWorkedInteractionChoiceProjectionSchema = z
  .object({ id: z.string().min(1).max(80), text: z.string().min(1).max(600) })
  .strict();

const LessonWorkedInteractionMisconceptionProjectionSchema = z
  .object({
    hypothesis: z.string().min(1).max(600),
    whyTempting: z.string().min(1).max(700),
    correction: z.string().min(1).max(900),
  })
  .strict();

const LessonWorkedInteractionResponseProjectionShape = {
  prompt: z.string().min(1).max(900),
  options: z.array(LessonWorkedInteractionChoiceProjectionSchema).min(2).max(5),
  response: z.string().min(1).max(80).nullable(),
  respondedAt: z.string().datetime().nullable(),
  correct: z.boolean().nullable(),
  feedback: z.string().max(900).nullable(),
  debrief: z.string().max(1200).nullable(),
  credit: z.literal('none'),
};

function validateWorkedInteractionResponseProjection(
  response: {
    response: string | null;
    respondedAt: string | null;
    correct: boolean | null;
    feedback: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if ((response.response === null) !== (response.respondedAt === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['response'],
      message: 'projected worked-interaction response and timestamp must be present together',
    });
  }
  if (response.response === null && (response.correct !== null || response.feedback !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['feedback'],
      message: 'unanswered worked-interaction choices cannot expose correctness or feedback',
    });
  }
  if (response.response !== null && (response.correct === null || response.feedback === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['feedback'],
      message: 'answered worked-interaction choices require correctness and targeted feedback',
    });
  }
}

const LessonWorkedInteractionResponseProjectionSchema = z
  .object(LessonWorkedInteractionResponseProjectionShape)
  .strict()
  .superRefine(validateWorkedInteractionResponseProjection);

const LessonWorkedInteractionActivityProjectionSchema = z
  .object({
    ...LessonWorkedInteractionResponseProjectionShape,
    misconception: LessonWorkedInteractionMisconceptionProjectionSchema.nullable(),
  })
  .strict()
  .superRefine(validateWorkedInteractionResponseProjection);

const LessonWorkedInteractionTransferProjectionSchema = z
  .object({
    ...LessonWorkedInteractionResponseProjectionShape,
    changedCondition: z.string().min(1).max(800),
  })
  .strict()
  .superRefine(validateWorkedInteractionResponseProjection);

const LessonWorkedInteractionProjectionSchema = z
  .object({
    stage: z.enum(['guided', 'scaffold', 'transfer', 'completed']),
    modelledStepCount: z.number().int().positive().max(7),
    origin: LessonTeachingOriginSchema,
    sources: z.array(LessonSourceProjectionSchema).max(8),
    activity: LessonWorkedInteractionActivityProjectionSchema,
    /** Revealed only after an incorrect guided response. */
    hint: z.string().max(700).nullable(),
    /** Revealed only after an incorrect guided response. */
    scaffold: LessonWorkedInteractionResponseProjectionSchema.nullable(),
    /** Revealed only after the guided decision or its scaffold is resolved. */
    transfer: LessonWorkedInteractionTransferProjectionSchema.nullable(),
  })
  .strict()
  .superRefine((interaction, ctx) => {
    const answered = interaction.activity.response !== null;
    if (
      interaction.stage === 'guided' &&
      (answered ||
        interaction.hint !== null ||
        interaction.scaffold !== null ||
        interaction.transfer !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stage'],
        message: 'guided worked-interaction stage must still await its first response',
      });
    }
    if (interaction.stage === 'scaffold') {
      if (
        interaction.activity.correct !== false ||
        interaction.hint === null ||
        interaction.scaffold === null ||
        interaction.scaffold.response !== null ||
        interaction.transfer !== null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stage'],
          message: 'scaffold stage requires one wrong guided response and unrevealed continuation',
        });
      }
    }
    if (
      interaction.activity.correct === true &&
      (interaction.hint !== null || interaction.scaffold !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hint'],
        message: 'a correct guided response must not expose repair help',
      });
    }
    if (
      interaction.activity.correct === false &&
      interaction.stage !== 'scaffold' &&
      (interaction.hint === null || interaction.scaffold === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hint'],
        message: 'an incorrect guided response must retain its bounded repair help',
      });
    }
    if (interaction.stage === 'transfer') {
      const repairResolved =
        interaction.activity.correct === true ||
        (interaction.activity.correct === false &&
          interaction.hint !== null &&
          interaction.scaffold?.response !== null &&
          interaction.scaffold?.response !== undefined);
      if (!repairResolved || interaction.transfer?.response !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stage'],
          message: 'transfer stage requires a resolved guided path and an unanswered changed case',
        });
      }
    }
    if (interaction.stage === 'completed' && interaction.transfer?.response == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stage'],
        message: 'completed worked interaction requires a changed-case response',
      });
    }
  });

const LessonSegmentPurposeProjectionSchema = z.enum([
  'orientation',
  'explanation',
  'mechanism',
  'worked_example',
  'comparison',
  'common_pitfall',
  'guided_practice',
]);

export const LessonSegmentProjectionSchema = z
  .object({
    index: z.number().int().nonnegative(),
    purpose: LessonSegmentPurposeProjectionSchema,
    explanation: z.string().min(1).max(2400),
    explanationOrigin: LessonTeachingOriginSchema,
    sources: z.array(LessonSourceProjectionSchema).max(8),
    semanticRelations: z
      .array(
        z
          .object({
            kind: z.enum([
              'cause_consequence',
              'mechanism_effect',
              'step_purpose',
              'omission_failure',
              'condition_action',
              'misconception_correction',
              'difference_discrimination',
              'evidence_conclusion',
            ]),
            fromProposition: z.string().min(1).max(700),
            toProposition: z.string().min(1).max(700),
            /** Historical projections only; current rationale stays private. */
            relevanceToObjective: z.string().min(1).max(700).optional(),
            origin: LessonTeachingOriginSchema.optional(),
            sources: z.array(LessonSourceProjectionSchema).max(8).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    workedProcess: z
      .object({
        startingState: z.string().min(1).max(900),
        inputs: z.array(z.string().min(1).max(500)).max(6).optional(),
        ruleOrProcedure: z.string().min(1).max(1200),
        steps: z
          .array(
            z
              .object({
                action: z.string().min(1).max(700),
                reason: z.string().min(1).max(700),
                resultingState: z.string().min(1).max(700),
              })
              .strict(),
          )
          .min(1)
          .max(8),
        learnerDecision: z.string().min(1).max(700).nullable(),
        /** Null while an interactive continuation is intentionally withheld. */
        result: z.string().min(1).max(900).nullable(),
        /** Null while an interactive continuation is intentionally withheld. */
        whyResultFollows: z.string().min(1).max(900).nullable(),
        origin: LessonTeachingOriginSchema.optional(),
        sources: z.array(LessonSourceProjectionSchema).max(8).optional(),
        interaction: LessonWorkedInteractionProjectionSchema.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    example: LessonIllustrationProjectionSchema.nullable(),
    contrast: LessonIllustrationProjectionSchema.nullable(),
    possibleMisconception: z
      .object({
        hypothesis: z.string().min(1).max(600),
        correction: z.string().min(1).max(1000),
        advisoryOnly: z.literal(true),
        origin: LessonTeachingOriginSchema.optional(),
        sources: z.array(LessonSourceProjectionSchema).max(8),
      })
      .strict()
      .nullable(),
    informalCheck: LessonInformalCheckProjectionSchema.nullable(),
  })
  .strict()
  .superRefine((segment, ctx) => {
    const process = segment.workedProcess;
    if (!process) return;
    const interaction = process.interaction;
    if (!interaction) {
      if (process.result === null || process.whyResultFollows === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workedProcess'],
          message: 'historical non-interactive worked processes cannot withhold their result',
        });
      }
      return;
    }
    const beforeContinuation = interaction.stage === 'guided' || interaction.stage === 'scaffold';
    if (
      interaction.modelledStepCount > process.steps.length ||
      (beforeContinuation && process.steps.length !== interaction.modelledStepCount) ||
      (!beforeContinuation && process.steps.length <= interaction.modelledStepCount)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workedProcess', 'steps'],
        message:
          'worked-process projection must reveal only the steps allowed by its current phase',
      });
    }
    if (beforeContinuation && (process.result !== null || process.whyResultFollows !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workedProcess', 'result'],
        message: 'worked-process continuation and result must remain hidden before repair resolves',
      });
    }
    if (
      interaction.stage === 'transfer' &&
      (process.result === null || process.whyResultFollows !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workedProcess', 'whyResultFollows'],
        message: 'transfer phase reveals the continuation but withholds the final abstraction',
      });
    }
    if (
      interaction.stage === 'completed' &&
      (process.result === null || process.whyResultFollows === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workedProcess', 'whyResultFollows'],
        message: 'completed worked interaction must reveal its result and final abstraction',
      });
    }
  });
export type LessonSegmentProjection = z.infer<typeof LessonSegmentProjectionSchema>;

/**
 * A learner-facing teaching section is derived at read time. It deliberately
 * retains references to the immutable underlying segments instead of copying
 * or merging their content, so segment identity and claim-level provenance stay
 * precise.
 */
export type LearnerTeachingSectionBoundary =
  'inline_check' | 'conceptual_transition' | 'lesson_end';

export interface LearnerPacingSegment {
  index: number;
  purpose: string;
  explanation: string;
  informalCheck?: unknown | null;
  workedProcess?: {
    startingState: string;
    inputs?: string[];
    ruleOrProcedure: string;
    steps: Array<{ action: string; reason: string; resultingState: string }>;
    learnerDecision: string | null;
    result: string | null;
    whyResultFollows: string | null;
    interaction?: unknown;
  } | null;
  example?: { text: string } | null;
  contrast?: { text: string } | null;
  misconception?: { hypothesis: string; correction: string } | null;
  possibleMisconception?: { hypothesis: string; correction: string } | null;
}

export interface LearnerTeachingSection<T extends LearnerPacingSegment> {
  index: number;
  /** Exact original segment objects, in their persisted order. */
  segments: T[];
  startSegmentIndex: number;
  endSegmentIndex: number;
  boundary: LearnerTeachingSectionBoundary;
}

const SECONDARY_PACING_MIN_VISIBLE_CHARACTERS = 2400;
const MEANINGFUL_TRANSITION_PURPOSES = new Set([
  'worked_example',
  'contrast',
  'comparison',
  'misconception',
  'common_pitfall',
  'guided_practice',
]);

function learnerVisibleCharacterCount(segment: LearnerPacingSegment): number {
  const worked = segment.workedProcess;
  return [
    segment.explanation,
    segment.example?.text,
    segment.contrast?.text,
    segment.misconception?.hypothesis,
    segment.misconception?.correction,
    segment.possibleMisconception?.hypothesis,
    segment.possibleMisconception?.correction,
    worked?.startingState,
    worked?.ruleOrProcedure,
    ...(worked?.steps.flatMap((step) => [step.action, step.reason, step.resultingState]) ?? []),
    worked?.learnerDecision,
    worked?.result,
    worked?.whyResultFollows,
  ].reduce((total, value) => total + (value?.trim().length ?? 0), 0);
}

function beginsMeaningfulTransition(segment: LearnerPacingSegment): boolean {
  return (
    MEANINGFUL_TRANSITION_PURPOSES.has(segment.purpose) ||
    Boolean(
      segment.workedProcess ||
      segment.example ||
      segment.contrast ||
      segment.misconception ||
      segment.possibleMisconception,
    )
  );
}

/**
 * Groups granular Lesson segments for natural learner pacing. Inline checks are
 * the primary stop. A non-check stop is allowed only after a genuinely long
 * uninterrupted block and immediately before a meaningful conceptual shift.
 * Nothing returned by this function is persisted.
 */
export function groupLessonSegmentsForLearner<T extends LearnerPacingSegment>(
  segments: readonly T[],
): LearnerTeachingSection<T>[] {
  const sections: LearnerTeachingSection<T>[] = [];
  let current: T[] = [];
  let visibleCharacters = 0;

  const close = (boundary: LearnerTeachingSectionBoundary) => {
    if (current.length === 0) return;
    sections.push({
      index: sections.length,
      segments: current,
      startSegmentIndex: current[0]!.index,
      endSegmentIndex: current.at(-1)!.index,
      boundary,
    });
    current = [];
    visibleCharacters = 0;
  };

  segments.forEach((segment, index) => {
    current.push(segment);
    visibleCharacters += learnerVisibleCharacterCount(segment);
    if (segment.workedProcess?.interaction || segment.informalCheck) {
      close('inline_check');
      return;
    }
    const next = segments[index + 1];
    if (
      next &&
      visibleCharacters >= SECONDARY_PACING_MIN_VISIBLE_CHARACTERS &&
      beginsMeaningfulTransition(next)
    ) {
      close('conceptual_transition');
    }
  });
  close('lesson_end');
  return sections;
}

export const LessonPresentationStatusSchema = z.enum([
  'not_started',
  'in_progress',
  'summary_ready',
  'presentation_completed',
]);
export type LessonPresentationStatus = z.infer<typeof LessonPresentationStatusSchema>;

export const LessonExecutionAllowedActionSchema = z.enum([
  'prepare_lesson',
  'retry_preparation',
  'start_lesson',
  'move_to_next_segment',
  'revisit_segment',
  'respond_to_informal_check',
  'respond_to_worked_interaction',
  'complete_presentation',
  'submit_practice_response',
  'prepare_practice_repair',
  'start_practice_retest',
  'submit_practice_retest',
  'review_lesson',
  'resume_study_session',
  'wait_for_preparation',
]);
export type LessonExecutionAllowedAction = z.infer<typeof LessonExecutionAllowedActionSchema>;

export const LearnerLessonProjectionSchema = z
  .object({
    objective: z
      .object({
        title: z.string().min(1).max(300),
        whyNow: z.string().min(1).max(1000),
        outcomes: z
          .array(
            z
              .object({
                title: z.string().min(1).max(300),
                description: z.string().min(1).max(1000),
              })
              .strict(),
          )
          .min(1)
          .max(30),
      })
      .strict(),
    prerequisites: z
      .array(
        z
          .object({
            title: z.string().min(1).max(300),
            reason: z.string().min(1).max(700),
            readinessHint: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .max(30),
    segments: z.array(LessonSegmentProjectionSchema).min(1).max(12),
    sourceReferencesAvailable: z.boolean(),
    visuals: z.array(LessonVisualProjectionSchema).max(8).default([]),
    summary: z
      .object({
        available: z.boolean(),
        text: z.string().min(1).max(1200).nullable(),
        nextConnection: z.string().max(800).nullable(),
        formalOpportunities: z.array(z.string().min(1).max(500)).max(8),
      })
      .strict(),
    plannedTime: z
      .object({
        agendaMinutes: z.number().int().positive(),
        activeMinutesMin: z.number().int().nonnegative(),
        activeMinutesMax: z.number().int().nonnegative(),
        basis: z.literal('locally_evaluated_learning_actions'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LearnerLessonProjection = z.infer<typeof LearnerLessonProjectionSchema>;

export const LessonExecutionProjectionSchema = z
  .object({
    status: z.enum([
      'preparation_needed',
      'preparing',
      'ready',
      'lesson_unavailable',
      'retry_available',
      'practice_retry_available',
    ]),
    message: z.string().min(1).max(500),
    course: z.object({ title: z.string().min(1).max(500) }).strict(),
    session: z
      .object({
        status: StudySessionStatusSchema,
        version: z.number().int().positive(),
      })
      .strict(),
    agenda: z
      .object({
        version: z.number().int().positive(),
        itemState: z.enum(['queued', 'active', 'completed', 'deferred', 'cancelled', 'blocked']),
      })
      .strict()
      .nullable(),
    lesson: LearnerLessonProjectionSchema.nullable(),
    progress: z
      .object({
        stateVersion: z.number().int().nonnegative(),
        stateId: z.string().min(1).optional(),
        currentSegmentIndex: z.number().int().nonnegative(),
        segmentCount: z.number().int().positive(),
        presentedSegmentIndexes: z.array(z.number().int().nonnegative()).max(12),
        presentationStatus: LessonPresentationStatusSchema,
        presentationCompletedAt: z.string().datetime().nullable(),
      })
      .strict()
      .nullable(),
    currentInformalCheck: LessonInformalCheckProjectionSchema.nullable(),
    practice: LearnerPracticeProjectionSchema.nullable().optional(),
    allowedActions: z.array(LessonExecutionAllowedActionSchema).max(10),
  })
  .strict()
  .superRefine((projection, ctx) => {
    if (projection.status !== 'practice_retry_available') return;
    if (!projection.lesson) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lesson'],
        message: 'Practice retry recovery requires the accepted Lesson projection',
      });
    }
    if (!projection.progress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['progress'],
        message: 'Practice retry recovery requires read-only Lesson progress',
      });
    }
    if (projection.practice != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['practice'],
        message: 'Rejected Practice content must not enter the learner projection',
      });
    }
    if (
      projection.allowedActions.length !== 1 ||
      projection.allowedActions[0] !== 'retry_preparation'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedActions'],
        message: 'Practice retry recovery may only retry preparation',
      });
    }
  });
export type LessonExecutionProjection = z.infer<typeof LessonExecutionProjectionSchema>;

export const EnsureLessonExecutionRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    expectedSessionVersion: z.number().int().positive(),
    expectedAgendaVersion: z.number().int().positive(),
    expectedAgendaItemId: z.string().min(1),
    confirmedCostPolicyIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();
export type EnsureLessonExecutionRequest = z.infer<typeof EnsureLessonExecutionRequestSchema>;

export const LessonExecutionCommandRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    expectedSessionVersion: z.number().int().positive(),
    expectedAgendaVersion: z.number().int().positive(),
    expectedAgendaItemId: z.string().min(1),
    expectedLessonStateVersion: z.number().int().positive(),
    action: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('prepare_practice_repair'),
          learnerNote: z.string().max(1000).default(''),
        })
        .strict(),
      z.object({ kind: z.literal('start_practice_retest') }).strict(),
      z
        .object({
          kind: z.literal('submit_practice_retest'),
          index: z.number().int().min(0).max(1),
          optionId: z.string().min(1).max(80),
        })
        .strict(),
      z.object({ kind: z.literal('start_lesson') }).strict(),
      z
        .object({
          kind: z.literal('move_to_segment'),
          segmentIndex: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('respond_to_informal_check'),
          segmentIndex: z.number().int().nonnegative(),
          response: z.string().trim().min(1).max(2000),
        })
        .strict(),
      z
        .object({
          kind: z.literal('respond_to_worked_interaction'),
          segmentIndex: z.number().int().nonnegative(),
          phase: z.enum(['guided', 'scaffold', 'transfer']),
          response: z.string().trim().min(1).max(80),
        })
        .strict(),
      z.object({ kind: z.literal('complete_presentation') }).strict(),
      z
        .object({
          kind: z.literal('submit_practice_response'),
          itemIndex: z.number().int().nonnegative(),
          optionId: z.string().min(1).max(80),
        })
        .strict(),
    ]),
  })
  .strict();
export type LessonExecutionCommandRequest = z.infer<typeof LessonExecutionCommandRequestSchema>;

/** Deterministic, bounded slice passed to conversational Tutor generation. */
export const LessonTutorContextSchema = z
  .object({
    identity: z
      .object({ stateId: z.string(), version: z.number().int().positive() })
      .strict()
      .optional(),
    phase: z
      .enum([
        'lesson',
        'practice',
        'diagnosis',
        'preparing',
        'repair',
        'retest',
        'needs_support',
        'completed',
      ])
      .optional(),
    selectedText: z.string().max(1800).optional(),
    courseDesign: z.object({ desiredDepth: z.string(), unitFocus: z.string() }).strict().optional(),
    /** Only presented teaching and currently visible question/feedback; never future keys. */
    visibleLesson: z
      .array(z.object({ index: z.number().int(), text: z.string().max(9000) }).strict())
      .max(12)
      .optional(),
    activeQuestion: z
      .object({
        kind: z.enum(['inline_check', 'practice', 'retest']),
        prompt: z.string().max(1200),
        options: z.array(z.object({ id: z.string(), text: z.string().max(600) }).strict()).max(5),
        learnerResponse: z.string().max(2000).nullable(),
      })
      .strict()
      .optional(),
    repairTeaching: z.string().max(7000).optional(),
    practiceRecovery: z
      .object({
        phase: z.string().max(30),
        question: z.string().max(1200),
        selectedAnswer: z.string().max(600),
        feedback: z.string().max(700),
        gap: z.string().max(700).nullable(),
        explanation: z.string().max(900).nullable(),
        learnerNote: z.string().max(1000),
        credit: z.literal('none'),
      })
      .strict()
      .optional(),
    objective: z
      .object({
        title: z.string().min(1).max(300),
        whyNow: z.string().min(1).max(700),
      })
      .strict(),
    currentSegment: z
      .object({
        index: z.number().int().nonnegative(),
        purpose: LessonSegmentPurposeProjectionSchema,
        explanation: z.string().min(1).max(1800),
        explanationOrigin: LessonTeachingOriginSchema,
        example: z.string().max(700).nullable(),
        contrast: z.string().max(700).nullable(),
        possibleMisconception: z.string().max(700).nullable(),
        informalCheck: z
          .object({
            prompt: z.string().min(1).max(700),
            guidance: z.string().max(500).nullable(),
            learnerResponse: z.string().min(1).max(1000).nullable(),
            credit: z.literal('none'),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    nearbySegments: z
      .array(
        z
          .object({
            relation: z.enum(['previous', 'next']),
            purpose: LessonSegmentPurposeProjectionSchema,
            preview: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(2),
    sources: z.array(LessonSourceProjectionSchema).max(6),
    visuals: z.array(LessonVisualProjectionSchema).max(4).optional(),
    summary: z.string().max(700).nullable(),
    nextConnection: z.string().max(500).nullable(),
  })
  .strict();
export type LessonTutorContext = z.infer<typeof LessonTutorContextSchema>;
