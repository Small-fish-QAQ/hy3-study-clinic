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

export const LessonInformalInteractionStateSchema = z
  .object({
    segmentIndex: z.number().int().nonnegative(),
    presentedAt: z.string().datetime(),
    response: z.string().min(1).max(2000).nullable(),
    respondedAt: z.string().datetime().nullable(),
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

export const LessonSegmentProjectionSchema = z
  .object({
    index: z.number().int().nonnegative(),
    purpose: z.enum([
      'orientation',
      'explanation',
      'mechanism',
      'worked_example',
      'comparison',
      'common_pitfall',
      'guided_practice',
    ]),
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
            relevanceToObjective: z.string().min(1).max(700),
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
        result: z.string().min(1).max(900),
        whyResultFollows: z.string().min(1).max(900),
        origin: LessonTeachingOriginSchema.optional(),
        sources: z.array(LessonSourceProjectionSchema).max(8).optional(),
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
  .strict();
export type LessonSegmentProjection = z.infer<typeof LessonSegmentProjectionSchema>;

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
  'complete_presentation',
  'submit_practice_response',
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
    objective: z
      .object({
        title: z.string().min(1).max(300),
        whyNow: z.string().min(1).max(700),
      })
      .strict(),
    currentSegment: z
      .object({
        index: z.number().int().nonnegative(),
        purpose: LessonSegmentProjectionSchema.shape.purpose,
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
            purpose: LessonSegmentProjectionSchema.shape.purpose,
            preview: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(2),
    sources: z.array(LessonSourceProjectionSchema).max(4),
    visuals: z.array(LessonVisualProjectionSchema).max(4).optional(),
    summary: z.string().max(700).nullable(),
    nextConnection: z.string().max(500).nullable(),
  })
  .strict();
export type LessonTutorContext = z.infer<typeof LessonTutorContextSchema>;
