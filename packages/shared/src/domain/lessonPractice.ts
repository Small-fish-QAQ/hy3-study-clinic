import { z } from 'zod';
import { FormalAssessmentConstructSchema } from './sourceAuthority.js';
import { PrivateReasoningFields } from './reasoningOperation.js';
import { TeachingDesignSchema } from './teachingDesign.js';
import { DesiredDepthSchema } from './learningContract.js';
import { UnitFocusSchema } from './curriculum.js';

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
  repairInstruction: z.string().min(1).max(1000).optional(),
}).strict();
export type PracticeQualityFinding = z.infer<typeof PracticeQualityFindingSchema>;

const TeachingReviewFindingSchema = z
  .object({
    itemId: z.string().min(1).max(40),
    code: z.enum([
      'answer_leak',
      'insufficient_evidence',
      'shallow_task',
      'weak_transfer',
      'practice_replay',
      'accuracy',
      'grounding',
      'misconception',
      'revealing_hint',
    ]),
    problem: z.string().min(1).max(800),
    repairInstruction: z.string().min(1).max(1000),
  })
  .strict();

const TeachingReviewResponsibilitySchema = z.enum(['grounding', 'answerability', 'integrity']);
const TeachingReviewQualityAspectSchema = z.enum(['difficulty', 'transfer', 'richness', 'style']);

/** Codes describe the concern; only its purpose and evidence establish authority. */
export const TeachingQualityAdvisorySchema = TeachingReviewFindingSchema.extend({
  qualityAspect: TeachingReviewQualityAspectSchema,
});

const MaterialTeachingFindingSchema = TeachingReviewFindingSchema.extend({
  responsibility: TeachingReviewResponsibilitySchema,
});

export const TeachingContentReviewSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            actionId: z.string().min(1).max(40),
            answerId: z
              .string()
              .regex(/^[A-E]$/u)
              .nullable(),
            requiresCaseInference: z.boolean(),
            evidenceUsed: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(40),
    findings: z.array(TeachingReviewFindingSchema).max(30),
  })
  .strict();
// The provider interface covers all purposes; each runtime schema admits only
// its own fields. Keep the completed Lesson/Repair purpose contracts strict.
type TeachingReviewFinding = z.infer<typeof TeachingReviewFindingSchema> & {
  responsibility?: z.infer<typeof TeachingReviewResponsibilitySchema>;
  qualityAspect?: z.infer<typeof TeachingReviewQualityAspectSchema>;
};
export type TeachingContentReview = Omit<
  z.infer<typeof TeachingContentReviewSchema>,
  'findings'
> & {
  findings: TeachingReviewFinding[];
  advisories?: TeachingReviewFinding[];
};

export const LESSON_CONTENT_REVIEW_POLICY_VERSION = 'lesson-content-review-v2-purpose-authority';

export const LessonContentReviewResultSchema = TeachingContentReviewSchema.extend({
  findings: z.array(MaterialTeachingFindingSchema).max(30),
  advisories: z.array(TeachingQualityAdvisorySchema).max(30).optional(),
}).strict();

export const PracticeGroundingResultSchema = LessonContentReviewResultSchema.extend({
  decisions: TeachingContentReviewSchema.shape.decisions.max(0),
  findings: z
    .array(MaterialTeachingFindingSchema.extend({ responsibility: z.literal('grounding') }))
    .max(30),
}).strict();

/** Answerability is established by the sole independent decision, never a quality verdict. */
export const PracticeAnswerabilityResultSchema = TeachingContentReviewSchema.extend({
  decisions: TeachingContentReviewSchema.shape.decisions.length(1),
  findings: TeachingContentReviewSchema.shape.findings.max(0),
  advisories: z.array(TeachingQualityAdvisorySchema).max(30).optional(),
}).strict();

export const PracticeIntegrityResultSchema = TeachingContentReviewSchema.extend({
  decisions: TeachingContentReviewSchema.shape.decisions.max(0),
  findings: TeachingContentReviewSchema.shape.findings.refine(
    (findings) => findings.every(({ code }) => ['practice_replay', 'answer_leak'].includes(code)),
    'Practice integrity findings must establish public replay or leakage.',
  ),
  advisories: z.array(TeachingQualityAdvisorySchema).max(30).optional(),
}).strict();

/** One initial review plus at most two corrections when concrete defects improve. */
export const MAX_TEACHING_CONTENT_REVIEWS = 3;

const TeachingContentReviewReceiptSchema = z
  .object({
    logicalCallId: z.string().min(1),
    candidateHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    result: TeachingContentReviewSchema,
  })
  .strict();

/** Independent of Lesson generation, composition identity and pedagogy severity. */
// V1 could contain Fake suffix guesses; none of those proofs may certify current Practice.
export const PRACTICE_ANSWERABILITY_POLICY_VERSION = 'practice-answerability-v3-purpose-authority';

/** Practice acceptance changes must not invalidate accepted Lesson identity. */
export const PRACTICE_ACCEPTANCE_POLICY_VERSION = 'practice-acceptance-v6-purpose-authority';

/** Complete authored claims, independently of the blind/public review projections. */
export const PRACTICE_GROUNDING_POLICY_VERSION = 'practice-grounding-v2-purpose-authority';

/** Complete Lesson claims, separate from the learner-visible choice contract. */
export const LESSON_GROUNDING_POLICY_VERSION =
  'lesson-grounding-v2-purpose-admission-offline-fixtures';
export const LESSON_GROUNDING_REVIEW_SCHEMA_VERSION = 'lesson-grounding-review-v2';

/** Lesson-only purpose contract: no material finding may be filtered out as quality. */
export const LessonGroundingResultSchema = TeachingContentReviewSchema.extend({
  decisions: TeachingContentReviewSchema.shape.decisions.max(0),
  findings: TeachingContentReviewSchema.shape.findings.refine(
    (findings) =>
      findings.every(({ code }) =>
        ['accuracy', 'grounding', 'insufficient_evidence', 'misconception'].includes(code),
      ),
    'Lesson grounding findings must identify material correctness or source defects.',
  ),
  // Quality opinions never authorize or reject teaching. Keeping them in a
  // separate inventory prevents a generic code from silently erasing a defect.
  advisories: TeachingContentReviewSchema.shape.findings
    .refine(
      (findings) => findings.every(({ code }) => ['shallow_task', 'weak_transfer'].includes(code)),
      'Lesson grounding advisories may contain only quality opinions.',
    )
    .optional(),
}).strict();
export type LessonGroundingResult = z.infer<typeof LessonGroundingResultSchema>;

export const LessonGroundingReviewSchema = z
  .object({
    policyVersion: z.string().min(1).max(80),
    rounds: z
      .array(
        TeachingContentReviewReceiptSchema.extend({
          result: LessonGroundingResultSchema,
          inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
          claimsHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        }).strict(),
      )
      .min(1)
      .max(MAX_TEACHING_CONTENT_REVIEWS),
    /** Bound only after verifying the final candidate and current review context. */
    checkpointContextHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    /** The exact Lesson projection, including source/visual authority and local metadata. */
    exposureContextHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
export type LessonGroundingReview = z.infer<typeof LessonGroundingReviewSchema>;

export const PracticeGroundingReviewSchema = z
  .object({
    policyVersion: z.string().min(1).max(80),
    rounds: z
      .array(
        TeachingContentReviewReceiptSchema.extend({
          result: PracticeGroundingResultSchema,
          inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
          claimsHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        }).strict(),
      )
      .min(1)
      .max(MAX_TEACHING_CONTENT_REVIEWS),
    /** Added only after current proofs are checked against the materialized Brief. */
    savedContextHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
export type PracticeGroundingReview = z.infer<typeof PracticeGroundingReviewSchema>;

export const PracticeAnswerabilityReviewSchema = z
  .object({
    policyVersion: z.string().min(1).max(80),
    rounds: z
      .array(
        z
          .object({
            candidateHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
            solves: z
              .array(
                z
                  .object({
                    logicalCallId: z.string().min(1),
                    actionId: z.string().min(1).max(40),
                    itemIndex: z.number().int().min(0).max(7),
                    surface: z.enum(['initial', 'retry']),
                    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
                    result: PracticeAnswerabilityResultSchema,
                  })
                  .strict(),
              )
              .min(2)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TEACHING_CONTENT_REVIEWS),
  })
  .strict();
export type PracticeAnswerabilityReview = z.infer<typeof PracticeAnswerabilityReviewSchema>;

/** Public task comparisons, separate from grounding and isolated answerability. */
export const PracticeIntegrityReviewSchema = z
  .object({
    policyVersion: z.string().min(1).max(80),
    rounds: z
      .array(
        TeachingContentReviewReceiptSchema.extend({
          result: PracticeIntegrityResultSchema,
          inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        }).strict(),
      )
      .min(1)
      .max(MAX_TEACHING_CONTENT_REVIEWS),
  })
  .strict();
export type PracticeIntegrityReview = z.infer<typeof PracticeIntegrityReviewSchema>;

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
    /** Current Lesson acceptance binds its actual exposed choice context.
     * Optional so historical evaluations remain readable. */
    choiceContextFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    contentReview: z
      .array(TeachingContentReviewReceiptSchema.extend({ result: LessonContentReviewResultSchema }))
      .min(1)
      .max(MAX_TEACHING_CONTENT_REVIEWS)
      .optional(),
    contentReviewPolicyVersion: z.string().min(1).max(80).optional(),
    contentReviewQualityDisposition: z.literal('retained').optional(),
    /** Added after evaluation; mandatory at Lesson acceptance and execution. */
    groundingReview: LessonGroundingReviewSchema.optional(),
    teachingDesign: z
      .object({
        logicalCallId: z.string().min(1),
        content: TeachingDesignSchema,
      })
      .strict()
      .optional(),
    jointAuthoring: z
      .object({
        executionVerified: z.boolean().optional(),
        /** Computed Practice can coexist with open-authored Lesson portions. */
        practiceExecutionVerified: z.boolean().optional(),
        logicalCallIds: z.array(z.string().min(1)).min(1).max(12),
        /** Untrusted until the separate Practice validator/review accepts it. Never projected. */
        practiceCandidate: z.unknown(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LessonPedagogyEvaluation = z.infer<typeof LessonPedagogyEvaluationSchema>;

export const PracticeQualityImprovementSchema = z
  .object({
    attempts: z.number().int().min(0).max(1),
    outcome: z.enum([
      'not_needed',
      'retained',
      'improved',
      'exhausted',
      'review_budget_exhausted',
      'rejected',
      'failed',
    ]),
    findingsBefore: z.array(PracticeQualityFindingSchema).max(100),
    failureCode: z.string().min(1).max(100).optional(),
    logicalCallId: z.string().min(1).optional(),
  })
  .strict();
export type PracticeQualityImprovement = z.infer<typeof PracticeQualityImprovementSchema>;

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
    contentReview: z
      .array(TeachingContentReviewReceiptSchema.extend({ result: PracticeGroundingResultSchema }))
      .min(1)
      .max(MAX_TEACHING_CONTENT_REVIEWS)
      .optional(),
    /** Absent on historical Practice; required by the current preparation/reuse gate. */
    answerabilityReview: PracticeAnswerabilityReviewSchema.optional(),
    /** Historical JSON remains readable; current acceptance requires complete grounding. */
    groundingReview: PracticeGroundingReviewSchema.optional(),
    /** Historical JSON remains readable; current acceptance requires this proof. */
    integrityReview: PracticeIntegrityReviewSchema.optional(),
    /** Independent from the evaluator versions used in Lesson checkpoint identity. */
    acceptancePolicyVersion: z.string().min(1).max(80).optional(),
    qualityImprovement: PracticeQualityImprovementSchema.optional(),
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
    ...PrivateReasoningFields,
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
    authority: z.enum(['exact_source', 'advisory_visual', 'ai_teaching_synthesis']),
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
    if (
      item.authority === 'ai_teaching_synthesis' &&
      (item.sourceRefIds.length > 0 || item.visualRefIds.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceRefIds'],
        message: 'supplementary Practice cannot claim source or visual support',
      });
    }
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

/** Supplementary teaching only. Local response policy owns every transition. */
export const PracticeRepairContentSchema = z
  .object({
    diagnosis: z
      .object({
        observation: z.string().min(1).max(700),
        gap: z.string().min(1).max(700),
        uncertainty: z.string().min(1).max(500),
      })
      .strict(),
    explanation: z.string().min(1).max(1800),
    workedExample: z
      .object({
        prompt: z.string().min(1).max(900),
        steps: z.array(z.string().min(1).max(700)).min(2).max(5),
        conclusion: z.string().min(1).max(700),
      })
      .strict(),
    contrast: z.string().min(1).max(1000),
    retest: z.array(LessonPracticeSurfaceSchema).length(2),
  })
  .strict();
export type PracticeRepairContent = z.infer<typeof PracticeRepairContentSchema>;

/** V1 admitted unrevealed Practice hints and necessary-only Fake reservoir
 * premises. Its receipts cannot authorize current Repair packets. */
export const PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION =
  'practice-repair-acceptance-v2-visible-premises';
export const PRACTICE_REPAIR_GENERATION_VERSION = 'practice-repair-v8-visible-premises';

/** Local immutable authoring context. Revision drafts never become evidence. */
export const PracticeRepairContextSchema = z
  .object({
    desiredDepth: DesiredDepthSchema,
    unitFocus: UnitFocusSchema,
    objective: z
      .object({
        objectiveTitle: z.string(),
        construct: FormalAssessmentConstructSchema,
        capabilityTested: z.string(),
      })
      .strict(),
    failedPrompt: z.string(),
    selectedAnswer: z.string(),
    feedback: z.string(),
    failedCase: z
      .object({ options: z.array(z.string()), expectedAnswer: z.string(), explanation: z.string() })
      .strict()
      .optional(),
    learnerNote: z.string(),
    teachingContext: z.array(z.string()),
    sourceExcerpts: z.array(z.string()),
    priorRounds: z.array(PracticeRepairContentSchema).max(3),
    priorResponses: z.array(z.string()),
    unseenPracticePrompts: z.array(z.string()),
    archivedRetestPrompts: z.array(z.string()),
    tutorExplanations: z.array(z.string()).optional(),
    /** Only feedback/hints actually rendered before this packet; never all saved responses. */
    visibleFeedback: z.array(z.string()).optional(),
  })
  .strict();
export type PracticeRepairContext = z.infer<typeof PracticeRepairContextSchema>;

export const PracticeRepairGroundingResultSchema = TeachingContentReviewSchema.extend({
  decisions: TeachingContentReviewSchema.shape.decisions.max(0),
  findings: TeachingContentReviewSchema.shape.findings.refine((findings) =>
    findings.every(({ code }) =>
      ['accuracy', 'grounding', 'insufficient_evidence', 'misconception'].includes(code),
    ),
  ),
  advisories: TeachingContentReviewSchema.shape.findings
    .refine((findings) =>
      findings.every(({ code }) => ['shallow_task', 'weak_transfer'].includes(code)),
    )
    .optional(),
}).strict();
export const PracticeRepairIntegrityResultSchema = PracticeRepairGroundingResultSchema.extend({
  findings: TeachingContentReviewSchema.shape.findings.refine((findings) =>
    findings.every(({ code }) => ['answer_leak', 'practice_replay'].includes(code)),
  ),
}).strict();

const RepairReceiptFields = {
  logicalCallId: z.string().min(1),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
};
export const PracticeRepairAcceptanceSchema = z
  .object({
    policyVersion: z.string().min(1).max(80),
    candidateHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    bindingHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    context: PracticeRepairContextSchema,
    grounding: z
      .object({ ...RepairReceiptFields, result: PracticeRepairGroundingResultSchema })
      .strict(),
    solves: z
      .array(
        z
          .object({
            ...RepairReceiptFields,
            index: z.number().int().min(0).max(1),
            result: TeachingContentReviewSchema,
          })
          .strict(),
      )
      .length(2),
    integrity: z
      .object({ ...RepairReceiptFields, result: PracticeRepairIntegrityResultSchema })
      .strict(),
  })
  .strict();
export type PracticeRepairAcceptance = z.infer<typeof PracticeRepairAcceptanceSchema>;

export const PracticeRecoveryStateSchema = z
  .object({
    preparationOperationId: z.string().min(1).nullable(),
    learnerNote: z.string().max(1000).optional(),
    rounds: z
      .array(
        z
          .object({
            ordinal: z.number().int().positive().optional(),
            content: PracticeRepairContentSchema,
            learnerNote: z.string().max(1000),
            logicalCallId: z.string().min(1),
            reviewLogicalCallId: z.string().min(1).optional(),
            /** Absence never grants current admission; disposable old rounds need re-preparation. */
            acceptance: PracticeRepairAcceptanceSchema.optional(),
            createdAt: z.string().datetime(),
            startedAt: z.string().datetime().nullable(),
            responses: z
              .array(
                z
                  .object({
                    selectedOptionId: z.string().min(1).max(80),
                    correct: z.boolean(),
                    feedback: z.string().min(1).max(2200),
                    respondedAt: z.string().datetime(),
                  })
                  .strict(),
              )
              .max(2),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export type PracticeRecoveryState = z.infer<typeof PracticeRecoveryStateSchema>;

const LessonPracticeAttemptSummarySchema = z
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
    recovered: z.boolean().optional(),
    recoveryFeedback: z.string().max(2200).optional(),
  })
  .strict();
export const LessonPracticeAttemptStateSchema = LessonPracticeAttemptSummarySchema.extend({
  recovery: PracticeRecoveryStateSchema.optional(),
}).strict();
export type LessonPracticeAttemptState = z.infer<typeof LessonPracticeAttemptStateSchema>;

const LearnerPracticeOptionSchema = z
  .object({ id: z.string().min(1).max(80), text: z.string().min(1).max(600) })
  .strict();

export const LearnerPracticeRecoverySchema = z
  .object({
    phase: z.enum(['diagnosis', 'preparing', 'repair', 'retest', 'needs_support']),
    selectedAnswer: z.string().min(1).max(600),
    feedback: z.string().min(1).max(2200),
    learnerNote: z.string().max(1000).optional(),
    round: z.number().int().min(1).max(3),
    diagnosis: PracticeRepairContentSchema.shape.diagnosis.nullable(),
    teaching: PracticeRepairContentSchema.omit({ diagnosis: true, retest: true }).nullable(),
    retest: z
      .object({
        index: z.number().int().min(0).max(1),
        prompt: z.string().min(1).max(1200),
        options: z.array(LearnerPracticeOptionSchema).min(3).max(5),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type LearnerPracticeRecovery = z.infer<typeof LearnerPracticeRecoverySchema>;

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
        surface: z.enum(['initial', 'retry']),
        supplementary: z.boolean().optional(),
        prompt: z.string().min(1).max(1200),
        options: z.array(LearnerPracticeOptionSchema).min(3).max(5),
      })
      .strict()
      .nullable(),
    attempts: z.array(LessonPracticeAttemptSummarySchema).max(16),
    recovery: LearnerPracticeRecoverySchema.nullable().optional(),
    completedAt: z.string().datetime().nullable(),
    credit: z.literal('none'),
  })
  .strict();
export type LearnerPracticeProjection = z.infer<typeof LearnerPracticeProjectionSchema>;
