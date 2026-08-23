import { z } from 'zod';
import { FormalAssessmentConstructSchema } from './sourceAuthority.js';

export const LessonPedagogyCriterionSchema = z.enum([
  'objective_alignment',
  'explanation_reasoning',
  'worked_example',
  'learner_activity',
  'misconception_or_contrast',
  'semantic_nonredundancy',
  'duration_plausibility',
  'source_grounding',
]);
export type LessonPedagogyCriterion = z.infer<typeof LessonPedagogyCriterionSchema>;

export const PracticeQualityCriterionSchema = z.enum([
  'objective_construct_alignment',
  'authority_alignment',
  'meaningful_action',
  'source_location_trivia',
  'item_validity',
  'retry_validity',
  'semantic_nonredundancy',
]);
export type PracticeQualityCriterion = z.infer<typeof PracticeQualityCriterionSchema>;

const PedagogyFindingBaseSchema = z
  .object({
    severity: z.enum(['warning', 'error']),
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(800),
  })
  .strict();

export const LessonPedagogyFindingSchema = PedagogyFindingBaseSchema.extend({
  criterion: LessonPedagogyCriterionSchema,
  segmentIndexes: z.array(z.number().int().nonnegative()).max(12),
  objectiveRefs: z.array(z.string().min(1).max(40)).max(30),
}).strict();
export type LessonPedagogyFinding = z.infer<typeof LessonPedagogyFindingSchema>;

export const PracticeQualityFindingSchema = PedagogyFindingBaseSchema.extend({
  criterion: PracticeQualityCriterionSchema,
  itemIndexes: z.array(z.number().int().nonnegative()).max(12),
  objectiveRefs: z.array(z.string().min(1).max(40)).max(30),
}).strict();
export type PracticeQualityFinding = z.infer<typeof PracticeQualityFindingSchema>;

export const LessonPedagogyEvaluationSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().min(1).max(80),
    evaluator: z.literal('independent-deterministic-lesson-evaluator'),
    independent: z.literal(true),
    status: z.enum(['pass', 'fail']),
    boundedRepairAttempted: z.boolean(),
    estimatedActiveMinutes: z
      .object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
      .strict()
      .refine((range) => range.max >= range.min, {
        message: 'maximum active minutes must be at least the minimum',
      }),
    claimedAgendaMinutes: z.number().int().positive(),
    findings: z.array(LessonPedagogyFindingSchema).max(100),
    evaluatedAt: z.string().datetime(),
  })
  .strict();
export type LessonPedagogyEvaluation = z.infer<typeof LessonPedagogyEvaluationSchema>;

export const PracticeQualityEvaluationSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().min(1).max(80),
    evaluator: z.literal('independent-deterministic-practice-evaluator'),
    independent: z.literal(true),
    status: z.enum(['pass', 'fail']),
    boundedRepairAttempted: z.boolean(),
    findings: z.array(PracticeQualityFindingSchema).max(100),
    evaluatedAt: z.string().datetime(),
  })
  .strict();
export type PracticeQualityEvaluation = z.infer<typeof PracticeQualityEvaluationSchema>;

export const LessonPracticeOptionSchema = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().min(1).max(600),
    feedbackIfSelected: z.string().min(1).max(900),
  })
  .strict();
export type LessonPracticeOption = z.infer<typeof LessonPracticeOptionSchema>;

export const LessonPracticeSurfaceSchema = z
  .object({
    prompt: z.string().min(1).max(1200),
    options: z.array(LessonPracticeOptionSchema).min(3).max(5),
    correctOptionId: z.string().min(1).max(80),
    hint: z.string().min(1).max(700),
    explanation: z.string().min(1).max(1200),
  })
  .strict()
  .superRefine((surface, ctx) => {
    const ids = surface.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Practice option identities must be unique',
      });
    }
    if (!ids.includes(surface.correctOptionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctOptionId'],
        message: 'Practice correct option must reference an offered option',
      });
    }
  });
export type LessonPracticeSurface = z.infer<typeof LessonPracticeSurfaceSchema>;

export const LessonPracticeItemSchema = z
  .object({
    id: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveTitle: z.string().min(1).max(300),
    construct: FormalAssessmentConstructSchema,
    capabilityTested: z.string().min(1).max(700),
    pedagogicalReason: z.string().min(1).max(700),
    authority: z.enum(['exact_source', 'advisory_visual']),
    sourceRefIds: z.array(z.string().min(1).max(40)).max(8),
    visualRefIds: z.array(z.string().regex(/^V[1-9][0-9]*$/u)).max(8),
    application: z
      .object({
        startingState: z.string().min(1).max(900),
        sourceRuleOrProcedure: z.string().min(1).max(1200),
        decisionRequired: z.string().min(1).max(700),
        expectedAction: z.string().min(1).max(700),
      })
      .strict()
      .nullable()
      .optional(),
    initial: LessonPracticeSurfaceSchema,
    retry: LessonPracticeSurfaceSchema,
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.authority === 'exact_source' && item.sourceRefIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceRefIds'],
        message: 'exact-source Practice requires a source reference',
      });
    }
    if (item.authority === 'advisory_visual' && item.visualRefIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visualRefIds'],
        message: 'advisory-visual Practice requires a visual reference',
      });
    }
  });
export type LessonPracticeItem = z.infer<typeof LessonPracticeItemSchema>;

/** Immutable informal Practice generated with one exact Teaching Brief. */
export const LessonPracticeSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(LessonPracticeItemSchema).min(1).max(8),
    qualityEvaluation: PracticeQualityEvaluationSchema,
    credit: z.literal('none'),
  })
  .strict();
export type LessonPractice = z.infer<typeof LessonPracticeSchema>;

export const LessonPracticeAttemptStateSchema = z
  .object({
    itemIndex: z.number().int().nonnegative(),
    attemptNumber: z.union([z.literal(1), z.literal(2)]),
    surface: z.enum(['initial', 'retry']),
    selectedOptionId: z.string().min(1).max(80),
    correct: z.boolean(),
    feedback: z.string().min(1).max(1200),
    hint: z.string().min(1).max(700).nullable(),
    respondedAt: z.string().datetime(),
    credit: z.literal('none'),
  })
  .strict();
export type LessonPracticeAttemptState = z.infer<typeof LessonPracticeAttemptStateSchema>;

const LearnerPracticeOptionSchema = z
  .object({ id: z.string().min(1).max(80), text: z.string().min(1).max(600) })
  .strict();

export const LearnerPracticeProjectionSchema = z
  .object({
    status: z.enum(['locked', 'available', 'in_progress', 'completed']),
    currentItemIndex: z.number().int().nonnegative(),
    itemCount: z.number().int().positive(),
    item: z
      .object({
        index: z.number().int().nonnegative(),
        objectiveTitle: z.string().min(1).max(300),
        construct: FormalAssessmentConstructSchema,
        capabilityTested: z.string().min(1).max(700),
        pedagogicalReason: z.string().min(1).max(700),
        surface: z.enum(['initial', 'retry']),
        prompt: z.string().min(1).max(1200),
        options: z.array(LearnerPracticeOptionSchema).min(3).max(5),
      })
      .strict()
      .nullable(),
    attempts: z.array(LessonPracticeAttemptStateSchema).max(16),
    completedAt: z.string().datetime().nullable(),
    credit: z.literal('none'),
  })
  .strict();
export type LearnerPracticeProjection = z.infer<typeof LearnerPracticeProjectionSchema>;
