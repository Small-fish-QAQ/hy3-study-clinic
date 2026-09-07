import { z } from 'zod';
import {
  InformalCheckKindSchema,
  PrivateReasoningFields,
  TeachingBriefSegmentPurposeSchema,
  TeachingWorkedProcessInteractionSchema,
  type TeachingBrief,
  type TeachingBriefSegment,
} from './teachingBrief.js';
import { LessonPedagogyEvaluationSchema } from './lessonPractice.js';
import { FormalAssessmentConstructSchema } from './sourceAuthority.js';

export const TEACHING_SKELETON_SCHEMA_VERSION = 1 as const;

const ObjectiveRefSchema = z.string().regex(/^O[1-9][0-9]*$/u);
const SourceAliasSchema = z.string().regex(/^S[1-9][0-9]*$/u);
const VisualAliasSchema = z.string().regex(/^V[1-9][0-9]*$/u);

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function addDuplicateIssue(
  values: string[],
  path: Array<string | number>,
  label: string,
  ctx: z.RefinementCtx,
): void {
  const repeated = duplicates(values);
  if (repeated.length === 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `${label} must be unique: ${repeated.join(', ')}`,
  });
}

export const TeachingActivityBudgetSchema = z
  .object({
    minMinutes: z.number().int().nonnegative().max(480),
    maxMinutes: z.number().int().nonnegative().max(480),
  })
  .strict()
  .superRefine((budget, ctx) => {
    if (budget.maxMinutes < budget.minMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxMinutes'],
        message: 'activity budget maximum must not be below its minimum',
      });
    }
  });
export type TeachingActivityBudget = z.infer<typeof TeachingActivityBudgetSchema>;

/** Authority is selected by local planning; provider slot content cannot alter it. */
export const TeachingSkeletonAuthorityModeSchema = z.enum([
  'exact_source',
  'advisory_visual',
  'bounded_synthesis',
]);
export type TeachingSkeletonAuthorityMode = z.infer<typeof TeachingSkeletonAuthorityModeSchema>;

export const TeachingRelationKindSchema = z.enum([
  'cause_consequence',
  'mechanism_effect',
  'step_purpose',
  'omission_failure',
  'condition_action',
  'misconception_correction',
  'difference_discrimination',
  'evidence_conclusion',
]);
export type TeachingRelationKind = z.infer<typeof TeachingRelationKindSchema>;

export const TeachingSkeletonQualityContractSchema = z.enum([
  'orientation',
  'discrimination',
  'semantic_relation',
  'worked_process',
  'learner_action',
  'boundary_work',
]);
export type TeachingSkeletonQualityContract = z.infer<typeof TeachingSkeletonQualityContractSchema>;

export const TeachingSkeletonObjectiveSchema = z
  .object({
    objectiveRef: ObjectiveRefSchema,
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(1000),
    priority: z.enum(['required', 'high', 'normal', 'optional']),
    construct: FormalAssessmentConstructSchema,
    authorityMode: z.enum(['exact_source', 'advisory_visual']),
    allowedSourceRefs: z.array(SourceAliasSchema).max(32),
    allowedVisualRefs: z.array(VisualAliasSchema).max(8),
  })
  .strict()
  .superRefine((objective, ctx) => {
    addDuplicateIssue(objective.allowedSourceRefs, ['allowedSourceRefs'], 'source aliases', ctx);
    addDuplicateIssue(objective.allowedVisualRefs, ['allowedVisualRefs'], 'visual aliases', ctx);
    if (objective.authorityMode === 'exact_source' && objective.allowedSourceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedSourceRefs'],
        message: 'exact-source objectives require at least one allowed source alias',
      });
    }
    if (objective.authorityMode === 'advisory_visual' && objective.allowedVisualRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedVisualRefs'],
        message: 'advisory-visual objectives require at least one allowed visual alias',
      });
    }
    if (
      objective.authorityMode === 'advisory_visual' &&
      objective.construct !== 'identify' &&
      objective.construct !== 'explain'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['construct'],
        message: 'advisory visual authority cannot authorize apply, design, or evaluate',
      });
    }
  });
export type TeachingSkeletonObjective = z.infer<typeof TeachingSkeletonObjectiveSchema>;

export const TeachingSkeletonSlotSchema = z
  .object({
    slotId: z.string().regex(/^L[1-9][0-9]*$/u),
    objectiveRefs: z.array(ObjectiveRefSchema).min(1).max(30),
    /** Null is reserved for cross-objective orientation. */
    construct: FormalAssessmentConstructSchema.nullable(),
    role: TeachingBriefSegmentPurposeSchema,
    purpose: z.string().min(1).max(700),
    authorityMode: TeachingSkeletonAuthorityModeSchema,
    allowedSourceRefs: z.array(SourceAliasSchema).max(32),
    allowedVisualRefs: z.array(VisualAliasSchema).max(8),
    protected: z.boolean(),
    activityBudget: TeachingActivityBudgetSchema,
    learnerActionRequired: z.boolean(),
    qualityContract: TeachingSkeletonQualityContractSchema,
    allowedRelations: z.array(TeachingRelationKindSchema).max(8),
  })
  .strict()
  .superRefine((slot, ctx) => {
    addDuplicateIssue(slot.objectiveRefs, ['objectiveRefs'], 'objective references', ctx);
    addDuplicateIssue(slot.allowedSourceRefs, ['allowedSourceRefs'], 'source aliases', ctx);
    addDuplicateIssue(slot.allowedVisualRefs, ['allowedVisualRefs'], 'visual aliases', ctx);
    if (slot.activityBudget.minMinutes === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activityBudget', 'minMinutes'],
        message: 'planned teaching slots require a positive activity minimum',
      });
    }
    if (slot.authorityMode === 'exact_source' && slot.allowedSourceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedSourceRefs'],
        message: 'exact-source teaching slots require an allowed source alias',
      });
    }
    if (slot.authorityMode === 'advisory_visual' && slot.allowedVisualRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedVisualRefs'],
        message: 'advisory-visual teaching slots require an allowed visual alias',
      });
    }
    if (slot.qualityContract === 'orientation') {
      if (slot.role !== 'objective_orientation' || slot.construct !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['qualityContract'],
          message: 'orientation contracts require an objective-orientation role and null construct',
        });
      }
    } else if (slot.construct === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['construct'],
        message: 'only cross-objective orientation may omit a construct',
      });
    }
    if (
      (slot.qualityContract === 'discrimination' || slot.qualityContract === 'learner_action') &&
      !slot.learnerActionRequired
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['learnerActionRequired'],
        message: `${slot.qualityContract} slots require an observable learner action`,
      });
    }
    if (
      (slot.qualityContract === 'semantic_relation' || slot.qualityContract === 'worked_process') &&
      slot.allowedRelations.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedRelations'],
        message: `${slot.qualityContract} slots require a controlled semantic relation`,
      });
    }
    if (slot.qualityContract === 'worked_process' && slot.role !== 'worked_example') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role'],
        message: 'worked-process contracts require a worked-example role',
      });
    }
  });
export type TeachingSkeletonSlot = z.infer<typeof TeachingSkeletonSlotSchema>;

export const TeachingPracticePlanSlotSchema = z
  .object({
    practiceSlotId: z.string().regex(/^PR[1-9][0-9]*$/u),
    objectiveRef: ObjectiveRefSchema,
    construct: FormalAssessmentConstructSchema,
    authorityMode: z.enum(['exact_source', 'advisory_visual']),
    allowedSourceRefs: z.array(SourceAliasSchema).max(32),
    allowedVisualRefs: z.array(VisualAliasSchema).max(8),
    capabilityToObserve: z.string().min(1).max(700),
    prohibitedStrongerConstructs: z.array(FormalAssessmentConstructSchema).max(4),
    retryPermitted: z.boolean(),
    activityBudget: TeachingActivityBudgetSchema,
  })
  .strict()
  .superRefine((slot, ctx) => {
    addDuplicateIssue(slot.allowedSourceRefs, ['allowedSourceRefs'], 'source aliases', ctx);
    addDuplicateIssue(slot.allowedVisualRefs, ['allowedVisualRefs'], 'visual aliases', ctx);
    addDuplicateIssue(
      slot.prohibitedStrongerConstructs,
      ['prohibitedStrongerConstructs'],
      'prohibited constructs',
      ctx,
    );
    if (slot.activityBudget.minMinutes === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activityBudget', 'minMinutes'],
        message: 'planned Practice slots require a positive activity minimum',
      });
    }
    if (slot.authorityMode === 'exact_source' && slot.allowedSourceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedSourceRefs'],
        message: 'exact-source Practice requires an allowed source alias',
      });
    }
    if (slot.authorityMode === 'advisory_visual') {
      if (slot.allowedVisualRefs.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allowedVisualRefs'],
          message: 'advisory-visual Practice requires an allowed visual alias',
        });
      }
      if (slot.construct !== 'identify' && slot.construct !== 'explain') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['construct'],
          message: 'advisory visual Practice is limited to identify or explain',
        });
      }
    }
  });
export type TeachingPracticePlanSlot = z.infer<typeof TeachingPracticePlanSlotSchema>;

export const TeachingPracticePlanSchema = z
  .object({
    schemaVersion: z.literal(TEACHING_SKELETON_SCHEMA_VERSION),
    slots: z.array(TeachingPracticePlanSlotSchema).min(1).max(8),
    activityBudget: TeachingActivityBudgetSchema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    addDuplicateIssue(
      plan.slots.map((slot) => slot.practiceSlotId),
      ['slots'],
      'Practice slot identities',
      ctx,
    );
    const derived = plan.slots.reduce(
      (sum, slot) => ({
        minMinutes: sum.minMinutes + slot.activityBudget.minMinutes,
        maxMinutes: sum.maxMinutes + slot.activityBudget.maxMinutes,
      }),
      { minMinutes: 0, maxMinutes: 0 },
    );
    if (
      derived.minMinutes !== plan.activityBudget.minMinutes ||
      derived.maxMinutes !== plan.activityBudget.maxMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activityBudget'],
        message: 'Practice activity budget must equal the sum of its planned slots',
      });
    }
  });
export type TeachingPracticePlan = z.infer<typeof TeachingPracticePlanSchema>;

/**
 * Provider-fillable APPLY scenario facts. The local PracticePlan still owns
 * construct, capability, source authority, and whether this structure is required.
 */
export const TeachingPracticeApplicationContentSchema = z
  .object({
    startingState: z.string().min(1).max(900),
    sourceRuleOrProcedure: z.string().min(1).max(1200),
    decisionRequired: z.string().min(1).max(700),
    expectedAction: z.string().min(1).max(700),
  })
  .strict();
export type TeachingPracticeApplicationContent = z.infer<
  typeof TeachingPracticeApplicationContentSchema
>;

export const TeachingSkeletonSchema = z
  .object({
    id: z.string().regex(/^teaching_skeleton_[0-9a-f]{40}$/u),
    schemaVersion: z.literal(TEACHING_SKELETON_SCHEMA_VERSION),
    plannerVersion: z.string().min(1).max(100),
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    learningUnitTitle: z.string().min(1).max(300),
    objectives: z.array(TeachingSkeletonObjectiveSchema).min(1).max(30),
    targetMinutes: z.number().int().positive().max(480),
    acceptableActiveMinutes: TeachingActivityBudgetSchema,
    lessonSlots: z.array(TeachingSkeletonSlotSchema).min(1).max(12),
    practicePlan: TeachingPracticePlanSchema,
    synthesisActivityBudget: TeachingActivityBudgetSchema,
    protectedActivityBudget: TeachingActivityBudgetSchema,
    plannedActivityBudget: TeachingActivityBudgetSchema,
  })
  .strict()
  .superRefine((skeleton, ctx) => {
    addDuplicateIssue(
      skeleton.objectives.map((objective) => objective.objectiveRef),
      ['objectives'],
      'objective references',
      ctx,
    );
    addDuplicateIssue(
      skeleton.lessonSlots.map((slot) => slot.slotId),
      ['lessonSlots'],
      'Lesson slot identities',
      ctx,
    );
    const objectiveByRef = new Map(
      skeleton.objectives.map((objective) => [objective.objectiveRef, objective]),
    );
    for (const [slotIndex, slot] of skeleton.lessonSlots.entries()) {
      const referenced = slot.objectiveRefs.flatMap((objectiveRef) => {
        const objective = objectiveByRef.get(objectiveRef);
        if (!objective) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lessonSlots', slotIndex, 'objectiveRefs'],
            message: `unknown skeleton objective: ${objectiveRef}`,
          });
          return [];
        }
        return [objective];
      });
      const allowedSources = new Set(
        referenced.flatMap((objective) => objective.allowedSourceRefs),
      );
      const allowedVisuals = new Set(
        referenced.flatMap((objective) => objective.allowedVisualRefs),
      );
      if (slot.allowedSourceRefs.some((sourceRef) => !allowedSources.has(sourceRef))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lessonSlots', slotIndex, 'allowedSourceRefs'],
          message: 'Lesson slot source authority must be a subset of its objective authority',
        });
      }
      if (slot.allowedVisualRefs.some((visualRef) => !allowedVisuals.has(visualRef))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lessonSlots', slotIndex, 'allowedVisualRefs'],
          message: 'Lesson slot visual authority must be a subset of its objective authority',
        });
      }
      if (
        slot.construct &&
        referenced.some((objective) => objective.construct !== slot.construct)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lessonSlots', slotIndex, 'construct'],
          message: 'Lesson slot construct must match every referenced objective',
        });
      }
      if (
        slot.authorityMode !== 'bounded_synthesis' &&
        referenced.some((objective) => objective.authorityMode !== slot.authorityMode)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lessonSlots', slotIndex, 'authorityMode'],
          message: 'Lesson slot authority mode must match its objective authority',
        });
      }
    }
    for (const [slotIndex, slot] of skeleton.practicePlan.slots.entries()) {
      const objective = objectiveByRef.get(slot.objectiveRef);
      if (!objective) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['practicePlan', 'slots', slotIndex, 'objectiveRef'],
          message: `unknown Practice objective: ${slot.objectiveRef}`,
        });
        continue;
      }
      if (
        objective.construct !== slot.construct ||
        objective.authorityMode !== slot.authorityMode
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['practicePlan', 'slots', slotIndex],
          message: 'Practice must preserve the exact objective construct and authority mode',
        });
      }
      if (slot.allowedSourceRefs.some((ref) => !objective.allowedSourceRefs.includes(ref))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['practicePlan', 'slots', slotIndex, 'allowedSourceRefs'],
          message: 'Practice source authority must be a subset of its objective authority',
        });
      }
      if (slot.allowedVisualRefs.some((ref) => !objective.allowedVisualRefs.includes(ref))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['practicePlan', 'slots', slotIndex, 'allowedVisualRefs'],
          message: 'Practice visual authority must be a subset of its objective authority',
        });
      }
    }
    for (const objective of skeleton.objectives) {
      if (
        !skeleton.lessonSlots.some((slot) => slot.objectiveRefs.includes(objective.objectiveRef))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lessonSlots'],
          message: `skeleton omits objective ${objective.objectiveRef}`,
        });
      }
      if (
        (objective.priority === 'required' || objective.priority === 'high') &&
        !skeleton.practicePlan.slots.some((slot) => slot.objectiveRef === objective.objectiveRef)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['practicePlan', 'slots'],
          message: `required/high objective ${objective.objectiveRef} needs planned Practice`,
        });
      }
    }
    const lessonBudget = skeleton.lessonSlots.reduce(
      (sum, slot) => ({
        minMinutes: sum.minMinutes + slot.activityBudget.minMinutes,
        maxMinutes: sum.maxMinutes + slot.activityBudget.maxMinutes,
      }),
      { minMinutes: 0, maxMinutes: 0 },
    );
    const planned = {
      minMinutes:
        lessonBudget.minMinutes +
        skeleton.practicePlan.activityBudget.minMinutes +
        skeleton.synthesisActivityBudget.minMinutes,
      maxMinutes:
        lessonBudget.maxMinutes +
        skeleton.practicePlan.activityBudget.maxMinutes +
        skeleton.synthesisActivityBudget.maxMinutes,
    };
    if (
      planned.minMinutes !== skeleton.plannedActivityBudget.minMinutes ||
      planned.maxMinutes !== skeleton.plannedActivityBudget.maxMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plannedActivityBudget'],
        message: 'planned activity budget must equal Lesson, Practice, and synthesis budgets',
      });
    }
    const protectedLessonBudget = skeleton.lessonSlots
      .filter((slot) => slot.protected)
      .reduce(
        (sum, slot) => ({
          minMinutes: sum.minMinutes + slot.activityBudget.minMinutes,
          maxMinutes: sum.maxMinutes + slot.activityBudget.maxMinutes,
        }),
        { minMinutes: 0, maxMinutes: 0 },
      );
    const protectedBudget = {
      minMinutes:
        protectedLessonBudget.minMinutes +
        skeleton.practicePlan.activityBudget.minMinutes +
        skeleton.synthesisActivityBudget.minMinutes,
      maxMinutes:
        protectedLessonBudget.maxMinutes +
        skeleton.practicePlan.activityBudget.maxMinutes +
        skeleton.synthesisActivityBudget.maxMinutes,
    };
    if (
      protectedBudget.minMinutes !== skeleton.protectedActivityBudget.minMinutes ||
      protectedBudget.maxMinutes !== skeleton.protectedActivityBudget.maxMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protectedActivityBudget'],
        message: 'protected activity budget must equal the protected planned work',
      });
    }
    if (
      skeleton.targetMinutes < skeleton.acceptableActiveMinutes.minMinutes ||
      skeleton.targetMinutes > skeleton.acceptableActiveMinutes.maxMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetMinutes'],
        message: 'target minutes must lie inside the accepted active-time window',
      });
    }
    if (
      planned.minMinutes > skeleton.acceptableActiveMinutes.maxMinutes ||
      planned.maxMinutes < skeleton.acceptableActiveMinutes.minMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plannedActivityBudget'],
        message: 'planned learning actions are incompatible with the Agenda duration window',
      });
    }
    if (protectedBudget.minMinutes > skeleton.acceptableActiveMinutes.maxMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protectedActivityBudget'],
        message: 'protected learning actions cannot fit the Agenda duration window',
      });
    }
  });
export type TeachingSkeleton = z.infer<typeof TeachingSkeletonSchema>;

export const TeachingSemanticRelationSchema = z
  .object({
    kind: TeachingRelationKindSchema,
    fromProposition: z.string().min(1).max(700),
    toProposition: z.string().min(1).max(700),
    relevanceToObjective: z.string().min(1).max(700),
    sourceRefs: z.array(SourceAliasSchema).max(8),
  })
  .strict()
  .superRefine((relation, ctx) => {
    const normalize = (value: string) =>
      value
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(
          /\b(?:because|therefore|thus|hence|consequently|so)\b|因为|所以|因此|从而|故/gu,
          ' ',
        )
        .replace(/[^\p{L}\p{N}]+/gu, '');
    if (normalize(relation.fromProposition) === normalize(relation.toProposition)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toProposition'],
        message: 'a semantic relation requires two distinct propositions or states',
      });
    }
    addDuplicateIssue(relation.sourceRefs, ['sourceRefs'], 'relation source aliases', ctx);
  });
export type TeachingSemanticRelation = z.infer<typeof TeachingSemanticRelationSchema>;

export const TeachingWorkedProcessSchema = z
  .object({
    startingState: z.string().min(1).max(900),
    /** Optional only for historical non-interactive worked processes. */
    inputs: z.array(z.string().min(1).max(500)).min(1).max(6).optional(),
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
    /** Empty means the worked case is explicitly Hy3 supplementary teaching. */
    sourceRefs: z.array(SourceAliasSchema).max(8),
    /** Absent on historical worked processes. */
    interaction: TeachingWorkedProcessInteractionSchema.optional(),
  })
  .strict()
  .superRefine((process, ctx) => {
    addDuplicateIssue(process.sourceRefs, ['sourceRefs'], 'worked-process source aliases', ctx);
    if (!process.interaction) return;
    addDuplicateIssue(
      process.interaction.sourceRefs,
      ['interaction', 'sourceRefs'],
      'worked-interaction source aliases',
      ctx,
    );
    if (!process.inputs?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputs'],
        message: 'interactive worked processes require explicit relevant inputs',
      });
    }
    if (process.learnerDecision === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['learnerDecision'],
        message: 'interactive worked processes require a concrete learner decision',
      });
    }
    if (process.interaction.pauseAfterStepIndex >= process.steps.length - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interaction', 'pauseAfterStepIndex'],
        message: 'worked interaction must pause after a modelled step and before a continuation',
      });
    }
  });
export type TeachingWorkedProcess = z.infer<typeof TeachingWorkedProcessSchema>;

const TeachingLessonIllustrationContentSchema = z
  .object({
    text: z.string().min(1).max(1800),
    sourceRefs: z.array(SourceAliasSchema).max(8),
    visualRefs: z.array(VisualAliasSchema).max(8),
  })
  .strict();

const TeachingLessonMisconceptionContentSchema = z
  .object({
    hypothesis: z.string().min(1).max(600),
    correction: z.string().min(1).max(1000),
    sourceRefs: z.array(SourceAliasSchema).max(8),
    visualRefs: z.array(VisualAliasSchema).max(8),
  })
  .strict();

export const TeachingInformalCheckOptionSchema = z
  .object({
    id: z.string().regex(/^[A-E]$/u),
    text: z.string().min(1).max(600),
    feedbackIfSelected: z.string().min(1).max(900),
  })
  .strict();
export type TeachingInformalCheckOption = z.infer<typeof TeachingInformalCheckOptionSchema>;

const TeachingLessonInformalCheckContentSchema = z
  .object({
    ...PrivateReasoningFields,
    kind: InformalCheckKindSchema,
    prompt: z.string().min(1).max(700),
    expectedSignal: z.string().max(500).nullable(),
    /** Structured choices are optional only for persisted pre-R1 content. */
    options: z.array(TeachingInformalCheckOptionSchema).min(2).max(5).optional(),
    correctOptionId: z
      .string()
      .regex(/^[A-E]$/u)
      .optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    if ((check.options === undefined) !== (check.correctOptionId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'informal-check choices and correct option must be present together',
      });
    }
    if (check.options) {
      const ids = check.options.map((option) => option.id);
      addDuplicateIssue(ids, ['options'], 'informal-check option identities', ctx);
      if (check.correctOptionId && !ids.includes(check.correctOptionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correctOptionId'],
          message: 'informal-check correct option must reference an offered choice',
        });
      }
    }
  });

/** Learner-facing whole-Lesson prose authored once, before slot fields are filled. */
export const TeachingLessonNarrativeSchema = z
  .object({
    whyNow: z.string().min(1).max(1000),
    summary: z.string().min(1).max(1200),
    forwardBridge: z.string().max(800).nullable(),
  })
  .strict();
export type TeachingLessonNarrative = z.infer<typeof TeachingLessonNarrativeSchema>;

/**
 * Provider-fillable content for exactly one locally owned Lesson slot.
 * Objective, construct, role, duration, protection, and authority are absent by design.
 */
export const TeachingLessonSlotContentSchema = z
  .object({
    slotId: z.string().regex(/^L[1-9][0-9]*$/u),
    /** Present only on the first slot for current generation; optional for historical rows. */
    lessonNarrative: TeachingLessonNarrativeSchema.optional(),
    explanation: z.string().min(1).max(2400),
    sourceRefs: z.array(SourceAliasSchema).max(8),
    visualRefs: z.array(VisualAliasSchema).max(8),
    semanticRelations: z.array(TeachingSemanticRelationSchema).max(4),
    workedProcess: TeachingWorkedProcessSchema.nullable(),
    example: TeachingLessonIllustrationContentSchema.optional(),
    contrast: TeachingLessonIllustrationContentSchema.optional(),
    misconception: TeachingLessonMisconceptionContentSchema.optional(),
    informalCheck: TeachingLessonInformalCheckContentSchema.optional(),
  })
  .strict()
  .superRefine((content, ctx) => {
    addDuplicateIssue(content.sourceRefs, ['sourceRefs'], 'slot source aliases', ctx);
    addDuplicateIssue(content.visualRefs, ['visualRefs'], 'slot visual aliases', ctx);
    if (content.workedProcess?.interaction && content.informalCheck) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['informalCheck'],
        message:
          'an interactive worked process owns its learner action and cannot add a second check',
      });
    }
  });
export type TeachingLessonSlotContent = z.infer<typeof TeachingLessonSlotContentSchema>;

export const TeachingLessonSlotContentsSchema = z
  .array(TeachingLessonSlotContentSchema)
  .min(1)
  .max(12)
  .superRefine((contents, ctx) => {
    addDuplicateIssue(
      contents.map((content) => content.slotId),
      [],
      'Lesson slot-content identities',
      ctx,
    );
  });
export type TeachingLessonSlotContents = z.infer<typeof TeachingLessonSlotContentsSchema>;

/** Durable, immutable predecessor retained before Practice generation begins. */
export const AcceptedLessonCheckpointSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    studySessionId: z.string().min(1),
    sessionAgendaId: z.string().min(1),
    agendaItemId: z.string().min(1),
    expectedSessionVersion: z.number().int().positive(),
    expectedAgendaVersion: z.number().int().positive(),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    studyPlanItemId: z.string().min(1),
    learningUnitId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    sourceContextFingerprint: z.string().min(1).max(200),
    skeleton: TeachingSkeletonSchema,
    lessonContent: TeachingLessonSlotContentsSchema,
    lessonEvaluation: LessonPedagogyEvaluationSchema,
    operationId: z.string().min(1),
    /** Null only for migration-compatible checkpoints created before logical-call provenance. */
    lessonLogicalCallId: z.string().min(1).nullable().default(null),
    provider: z.string().min(1).max(40),
    providerModel: z.string().max(120).nullable(),
    promptVersion: z.string().min(1).max(100),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((checkpoint, ctx) => {
    const plannedSlotIds = checkpoint.skeleton.lessonSlots.map((slot) => slot.slotId);
    const contentSlotIds = checkpoint.lessonContent.map((content) => content.slotId);
    const planned = new Set(plannedSlotIds);
    const content = new Set(contentSlotIds);
    const missing = plannedSlotIds.filter((slotId) => !content.has(slotId));
    const unknown = contentSlotIds.filter((slotId) => !planned.has(slotId));
    if (missing.length > 0 || unknown.length > 0 || content.size !== contentSlotIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lessonContent'],
        message: `accepted Lesson content must exactly cover the immutable skeleton slots (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`,
      });
    }
    for (const [contentIndex, slotContent] of checkpoint.lessonContent.entries()) {
      const slot = checkpoint.skeleton.lessonSlots.find(
        (candidate) => candidate.slotId === slotContent.slotId,
      );
      if (!slot) continue;
      const allSourceRefs = [
        ...slotContent.sourceRefs,
        ...slotContent.semanticRelations.flatMap((relation) => relation.sourceRefs),
        ...(slotContent.workedProcess?.sourceRefs ?? []),
        ...(slotContent.workedProcess?.interaction?.sourceRefs ?? []),
        ...(slotContent.example?.sourceRefs ?? []),
        ...(slotContent.contrast?.sourceRefs ?? []),
        ...(slotContent.misconception?.sourceRefs ?? []),
      ];
      const allVisualRefs = [
        ...slotContent.visualRefs,
        ...(slotContent.example?.visualRefs ?? []),
        ...(slotContent.contrast?.visualRefs ?? []),
        ...(slotContent.misconception?.visualRefs ?? []),
      ];
      if (allSourceRefs.some((sourceRef) => !slot.allowedSourceRefs.includes(sourceRef))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lessonContent', contentIndex, 'sourceRefs'],
          message: 'accepted Lesson content selects a source outside its immutable slot authority',
        });
      }
      if (allVisualRefs.some((visualRef) => !slot.allowedVisualRefs.includes(visualRef))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lessonContent', contentIndex, 'visualRefs'],
          message: 'accepted Lesson content selects a visual outside its immutable slot authority',
        });
      }
    }
  });
export type AcceptedLessonCheckpoint = z.infer<typeof AcceptedLessonCheckpointSchema>;

type AcceptedLessonProjectionSource = Pick<
  AcceptedLessonCheckpoint,
  'id' | 'skeleton' | 'lessonContent' | 'lessonEvaluation' | 'promptVersion'
>;

/** Deterministically projects immutable Lesson checkpoint bytes into final Brief segments. */
export function projectAcceptedLessonSegments(
  checkpoint: Pick<AcceptedLessonCheckpoint, 'skeleton' | 'lessonContent'>,
  objectiveIds: readonly string[],
): TeachingBriefSegment[] {
  if (objectiveIds.length !== checkpoint.skeleton.objectives.length) {
    throw new Error(
      'Accepted Lesson projection requires one final objective ID per skeleton objective.',
    );
  }
  const objectiveIdByRef = new Map(
    checkpoint.skeleton.objectives.map((objective, index) => [
      objective.objectiveRef,
      objectiveIds[index]!,
    ]),
  );
  const contentById = new Map(checkpoint.lessonContent.map((content) => [content.slotId, content]));
  return checkpoint.skeleton.lessonSlots.map((slot, index): TeachingBriefSegment => {
    const content = contentById.get(slot.slotId);
    if (!content) {
      throw new Error(`Accepted Lesson projection is missing content for ${slot.slotId}.`);
    }
    const illustration = (
      value: TeachingLessonSlotContent['example'] | TeachingLessonSlotContent['contrast'],
    ) =>
      value
        ? {
            text: value.text,
            authority:
              value.sourceRefs.length > 0
                ? ('source_backed_teaching' as const)
                : ('ai_teaching_synthesis' as const),
            sourceRefIds: value.sourceRefs,
            visualRefIds: value.visualRefs,
          }
        : undefined;
    return {
      index,
      purpose: slot.role,
      objectiveIds: slot.objectiveRefs.map((ref) => objectiveIdByRef.get(ref)!),
      explanation: content.explanation,
      explanationAuthority:
        content.sourceRefs.length > 0
          ? ('source_backed_teaching' as const)
          : ('ai_teaching_synthesis' as const),
      sourceRefIds: content.sourceRefs,
      visualRefIds: content.visualRefs,
      semanticRelations: content.semanticRelations.map(
        ({ sourceRefs, kind, fromProposition, toProposition, relevanceToObjective }) => ({
          kind,
          fromProposition,
          toProposition,
          relevanceToObjective,
          sourceRefIds: sourceRefs,
        }),
      ),
      workedProcess: content.workedProcess
        ? {
            startingState: content.workedProcess.startingState,
            ...(content.workedProcess.inputs ? { inputs: content.workedProcess.inputs } : {}),
            ruleOrProcedure: content.workedProcess.ruleOrProcedure,
            steps: content.workedProcess.steps,
            learnerDecision: content.workedProcess.learnerDecision,
            result: content.workedProcess.result,
            whyResultFollows: content.workedProcess.whyResultFollows,
            sourceRefIds: content.workedProcess.sourceRefs,
            ...(content.workedProcess.interaction
              ? { interaction: content.workedProcess.interaction }
              : {}),
          }
        : null,
      ...(content.example ? { example: illustration(content.example)! } : {}),
      ...(content.contrast ? { contrast: illustration(content.contrast)! } : {}),
      ...(content.misconception
        ? {
            misconception: {
              authority: 'pedagogical_risk_candidate' as const,
              hypothesis: content.misconception.hypothesis,
              correction: content.misconception.correction,
              sourceRefIds: content.misconception.sourceRefs,
              visualRefIds: content.misconception.visualRefs,
            },
          }
        : {}),
      ...(content.informalCheck ? { informalCheck: content.informalCheck } : {}),
    };
  });
}

/** Independent persistence fence for final Lesson bytes and skeleton-derived metadata. */
export function teachingBriefMatchesAcceptedLessonProjection(
  brief: TeachingBrief,
  checkpoint: AcceptedLessonProjectionSource,
  objectiveIds: readonly string[],
): boolean {
  const composition = brief.composition;
  const objectives = brief.objective.objectives;
  if (
    !composition ||
    objectives.length !== checkpoint.skeleton.objectives.length ||
    objectives.length !== objectiveIds.length ||
    objectives.some((objective, index) => objective.id !== objectiveIds[index])
  ) {
    return false;
  }
  const objectivesMatch = checkpoint.skeleton.objectives.every((planned, index) => {
    const assembled = objectives[index];
    return (
      assembled !== undefined &&
      assembled.title === planned.title &&
      assembled.description === planned.description &&
      assembled.priority === planned.priority &&
      assembled.construct === planned.construct
    );
  });
  if (!objectivesMatch) return false;
  const expectedSegments = projectAcceptedLessonSegments(checkpoint, objectiveIds);
  const narrative = checkpoint.lessonContent[0]?.lessonNarrative;
  return (
    composition.acceptedLessonCheckpointId === checkpoint.id &&
    composition.skeletonId === checkpoint.skeleton.id &&
    composition.skeletonSchemaVersion === checkpoint.skeleton.schemaVersion &&
    composition.skeletonPlannerVersion === checkpoint.skeleton.plannerVersion &&
    composition.skeletonFingerprint === checkpoint.skeleton.fingerprint &&
    composition.lessonPromptVersion === checkpoint.promptVersion &&
    JSON.stringify(composition.jointAuthoringLogicalCallIds) ===
      JSON.stringify(checkpoint.lessonEvaluation.jointAuthoring?.logicalCallIds) &&
    composition.targetMinutes === checkpoint.skeleton.targetMinutes &&
    composition.acceptableActiveMinutes.min ===
      checkpoint.skeleton.acceptableActiveMinutes.minMinutes &&
    composition.acceptableActiveMinutes.max ===
      checkpoint.skeleton.acceptableActiveMinutes.maxMinutes &&
    composition.protectedActivityMinutes.min ===
      checkpoint.skeleton.protectedActivityBudget.minMinutes &&
    composition.protectedActivityMinutes.max ===
      checkpoint.skeleton.protectedActivityBudget.maxMinutes &&
    composition.plannedActivityMinutes.min ===
      checkpoint.skeleton.plannedActivityBudget.minMinutes &&
    composition.plannedActivityMinutes.max ===
      checkpoint.skeleton.plannedActivityBudget.maxMinutes &&
    (narrative === undefined ||
      (brief.objective.whyNow === narrative.whyNow &&
        brief.summary === narrative.summary &&
        brief.nextConnection === narrative.forwardBridge)) &&
    JSON.stringify(brief.pedagogyEvaluation) === JSON.stringify(checkpoint.lessonEvaluation) &&
    JSON.stringify(brief.segments) === JSON.stringify(expectedSegments)
  );
}
