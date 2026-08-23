import { z } from 'zod';
import { ExecutionSourceManifestSchema } from './curriculum.js';
import { VisualAdvisoryContextSchema } from './visual.js';
import { LessonPedagogyEvaluationSchema, LessonPracticeSchema } from './lessonPractice.js';
import {
  CurriculumAuthorityEnvelopeTierSchema,
  FormalAssessmentConstructSchema,
} from './sourceAuthority.js';

/** A Teaching Brief teaches from a route snapshot; it is never Course Truth. */
export const TeachingBriefAuthoritySchema = z.enum([
  'source_backed_teaching',
  'ai_teaching_synthesis',
  'pedagogical_risk_candidate',
]);
export type TeachingBriefAuthority = z.infer<typeof TeachingBriefAuthoritySchema>;

export const TeachingBriefSegmentPurposeSchema = z.enum([
  'objective_orientation',
  'explanation',
  'mechanism',
  'worked_example',
  'contrast',
  'misconception',
  'guided_practice',
]);
export type TeachingBriefSegmentPurpose = z.infer<typeof TeachingBriefSegmentPurposeSchema>;

export const InformalCheckKindSchema = z.enum([
  'own_words',
  'predict_next',
  'choose_alternative',
  'apply_simple_example',
]);
export type InformalCheckKind = z.infer<typeof InformalCheckKindSchema>;

/** Exact source identity resolved by local code, not provider output. */
export const TeachingBriefSourceReferenceSchema = z
  .object({
    refId: z.string().min(1).max(40),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    sourceBlockId: z.string().min(1),
    sourceBlockRevisionFingerprint: z.string().min(1).max(200),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    quote: z.string().min(1).max(2000),
    headingPath: z.array(z.string().max(300)).max(10),
    pageNumber: z.number().int().positive().nullable(),
    slideNumber: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .superRefine((reference, ctx) => {
    if (reference.endOffset <= reference.startOffset) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endOffset'],
        message: 'source reference endOffset must be after startOffset',
      });
    }
  });
export type TeachingBriefSourceReference = z.infer<typeof TeachingBriefSourceReferenceSchema>;

/** Private immutable binding for one learner-safe advisory visual projection. */
export const TeachingBriefVisualReferenceSchema = z
  .object({
    refId: z.string().regex(/^V[1-9][0-9]*$/u),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    assetId: z.string().min(1),
    assetByteHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    derivationId: z.string().min(1),
    derivationIdentityFingerprint: z.string().regex(/^visual_derivation_[0-9a-f]{64}$/u),
    context: VisualAdvisoryContextSchema,
  })
  .strict()
  .superRefine((reference, ctx) => {
    if (reference.refId !== reference.context.referenceKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['context', 'referenceKey'],
        message: 'Teaching Brief visual reference key must match its private binding',
      });
    }
  });
export type TeachingBriefVisualReference = z.infer<typeof TeachingBriefVisualReferenceSchema>;

export const TeachingBriefIllustrationSchema = z
  .object({
    text: z.string().min(1).max(1800),
    authority: z.enum(['source_backed_teaching', 'ai_teaching_synthesis']),
    sourceRefIds: z.array(z.string().min(1).max(40)).max(8),
  })
  .strict()
  .superRefine((illustration, ctx) => {
    if (
      illustration.authority === 'source_backed_teaching' &&
      illustration.sourceRefIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceRefIds'],
        message: 'source-backed illustrations require source references',
      });
    }
  });
export type TeachingBriefIllustration = z.infer<typeof TeachingBriefIllustrationSchema>;

export const TeachingBriefMisconceptionSchema = z
  .object({
    authority: z.literal('pedagogical_risk_candidate'),
    hypothesis: z.string().min(1).max(600),
    correction: z.string().min(1).max(1000),
    sourceRefIds: z.array(z.string().min(1).max(40)).max(8),
  })
  .strict();
export type TeachingBriefMisconception = z.infer<typeof TeachingBriefMisconceptionSchema>;

export const TeachingBriefInformalCheckSchema = z
  .object({
    kind: InformalCheckKindSchema,
    prompt: z.string().min(1).max(700),
    expectedSignal: z.string().max(500).nullable(),
  })
  .strict();
export type TeachingBriefInformalCheck = z.infer<typeof TeachingBriefInformalCheckSchema>;

export const TeachingBriefSegmentSchema = z
  .object({
    index: z.number().int().nonnegative(),
    purpose: TeachingBriefSegmentPurposeSchema,
    objectiveIds: z.array(z.string().min(1)).max(30),
    explanation: z.string().min(1).max(2400),
    explanationAuthority: z.enum(['source_backed_teaching', 'ai_teaching_synthesis']),
    sourceRefIds: z.array(z.string().min(1).max(40)).max(8),
    example: TeachingBriefIllustrationSchema.optional(),
    contrast: TeachingBriefIllustrationSchema.optional(),
    misconception: TeachingBriefMisconceptionSchema.optional(),
    informalCheck: TeachingBriefInformalCheckSchema.optional(),
  })
  .strict()
  .superRefine((segment, ctx) => {
    if (
      segment.explanationAuthority === 'source_backed_teaching' &&
      segment.sourceRefIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceRefIds'],
        message: 'source-backed explanations require source references',
      });
    }
    if (segment.misconception && segment.misconception.sourceRefIds.length === 0) {
      // A misconception remains advisory even when it has no source support;
      // the field is kept explicit so it cannot be mistaken for evidence.
      return;
    }
  });
export type TeachingBriefSegment = z.infer<typeof TeachingBriefSegmentSchema>;

export const TeachingBriefPrerequisiteSchema = z
  .object({
    learningUnitId: z.string().min(1),
    title: z.string().min(1).max(300),
    reason: z.string().min(1).max(700),
    readinessHint: z.string().max(500).nullable(),
  })
  .strict();
export type TeachingBriefPrerequisite = z.infer<typeof TeachingBriefPrerequisiteSchema>;

export const TeachingBriefObjectiveSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(1000),
    priority: z.enum(['required', 'high', 'normal', 'optional']).optional(),
    formalAssessmentReady: z.boolean().optional(),
    construct: FormalAssessmentConstructSchema.optional(),
    authorityEnvelopeTier: CurriculumAuthorityEnvelopeTierSchema.optional(),
    formalEvidenceSourceBlockIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict();
export type TeachingBriefObjective = z.infer<typeof TeachingBriefObjectiveSchema>;

export const TeachingBriefQualityProfileSchema = z
  .object({
    objectiveCoverage: z.number().int().nonnegative(),
    segmentCount: z.number().int().nonnegative(),
    sourceBackedSegmentCount: z.number().int().nonnegative(),
    sourceBackedSegmentRatio: z.number().min(0).max(1),
    sourceReferenceCount: z.number().int().nonnegative(),
    sourceMaterialCount: z.number().int().nonnegative(),
    exampleCount: z.number().int().nonnegative(),
    contrastCount: z.number().int().nonnegative(),
    misconceptionCount: z.number().int().nonnegative(),
    informalCheckCount: z.number().int().nonnegative(),
    prerequisiteCount: z.number().int().nonnegative(),
    formalOpportunityCount: z.number().int().nonnegative(),
    hasSummary: z.boolean(),
    hasNextConnection: z.boolean(),
    unsupportedSourceRefCount: z.number().int().nonnegative(),
    duplicatedTeachingIntentCount: z.number().int().nonnegative(),
    dimensions: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            kind: z.enum(['deterministic', 'heuristic', 'model_or_human_judged']),
            note: z.string().min(1).max(400),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    nonclaims: z.array(z.string().min(1).max(300)).min(1).max(10),
  })
  .strict();
export type TeachingBriefQualityProfile = z.infer<typeof TeachingBriefQualityProfileSchema>;

export const TeachingBriefSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    learningUnitId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    sourceContextFingerprint: z.string().min(1).max(200),
    sourceManifest: ExecutionSourceManifestSchema,
    conceptIds: z.array(z.string().min(1)).max(30),
    canonicalConceptIds: z.array(z.string().min(1)).max(20),
    objective: z
      .object({
        title: z.string().min(1).max(300),
        whyNow: z.string().min(1).max(1000),
        objectives: z.array(TeachingBriefObjectiveSchema).min(1).max(30),
      })
      .strict(),
    prerequisites: z.array(TeachingBriefPrerequisiteSchema).max(30),
    segments: z.array(TeachingBriefSegmentSchema).min(1).max(12),
    formalOpportunities: z.array(z.string().min(1).max(500)).max(8),
    summary: z.string().min(1).max(1200),
    nextConnection: z.string().max(800).nullable(),
    sourceReferences: z.array(TeachingBriefSourceReferenceSchema).max(160),
    visualReferences: z.array(TeachingBriefVisualReferenceSchema).max(8).default([]),
    qualityProfile: TeachingBriefQualityProfileSchema,
    /** Independent local acceptance result; absent only on legacy persisted Briefs. */
    pedagogyEvaluation: LessonPedagogyEvaluationSchema.optional(),
    /** Informal, non-credit Practice; absent only on legacy persisted Briefs. */
    practice: LessonPracticeSchema.optional(),
    provider: z.string().min(1).max(40),
    providerModel: z.string().max(120).nullable(),
    promptVersion: z.string().min(1).max(80),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((brief, ctx) => {
    if (brief.sourceReferences.length === 0 && brief.visualReferences.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceReferences'],
        message: 'Teaching Brief requires exact text or advisory visual context',
      });
    }
    if (brief.sourceManifest.fingerprint !== brief.executionSourceManifestFingerprint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executionSourceManifestFingerprint'],
        message: 'Teaching Brief source manifest fingerprint must match its route snapshot',
      });
    }
    const indexes = brief.segments.map((segment) => segment.index);
    if (indexes.some((index, position) => index !== position)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: 'Teaching Brief segments must be ordered contiguously',
      });
    }
    const ids = new Set(brief.sourceReferences.map((reference) => reference.refId));
    if (ids.size !== brief.sourceReferences.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceReferences'],
        message: 'Teaching Brief source reference identities must be unique',
      });
    }
    const visualIds = new Set(brief.visualReferences.map((reference) => reference.refId));
    if (visualIds.size !== brief.visualReferences.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visualReferences'],
        message: 'Teaching Brief visual reference identities must be unique',
      });
    }
    const objectiveIds = new Set(brief.objective.objectives.map((objective) => objective.id));
    for (const [index, segment] of brief.segments.entries()) {
      for (const objectiveId of segment.objectiveIds) {
        if (!objectiveIds.has(objectiveId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['segments', index, 'objectiveIds'],
            message: `unknown Teaching Brief objective: ${objectiveId}`,
          });
        }
      }
      for (const refId of [
        ...segment.sourceRefIds,
        ...(segment.example?.sourceRefIds ?? []),
        ...(segment.contrast?.sourceRefIds ?? []),
        ...(segment.misconception?.sourceRefIds ?? []),
      ]) {
        if (!ids.has(refId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['segments', index],
            message: `unknown Teaching Brief source reference: ${refId}`,
          });
        }
      }
    }
    if (brief.promptVersion?.startsWith('teaching-brief-v2-pedagogy-practice')) {
      if (brief.pedagogyEvaluation?.status !== 'pass') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pedagogyEvaluation'],
          message: 'current Teaching Briefs require a passing independent Lesson evaluation',
        });
      }
      if (brief.practice?.qualityEvaluation.status !== 'pass') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['practice'],
          message: 'current Teaching Briefs require passing construct-valid informal Practice',
        });
      }
    }
    const objectiveById = new Map(
      brief.objective.objectives.map((objective) => [objective.id, objective]),
    );
    for (const [itemIndex, item] of (brief.practice?.items ?? []).entries()) {
      const objective = objectiveById.get(item.objectiveId);
      if (!objective || (objective.construct && objective.construct !== item.construct)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['practice', 'items', itemIndex, 'objectiveId'],
          message: 'Practice must preserve an exact Teaching Brief objective and construct',
        });
      }
      for (const refId of item.sourceRefIds) {
        if (!ids.has(refId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['practice', 'items', itemIndex, 'sourceRefIds'],
            message: `unknown Practice source reference: ${refId}`,
          });
        }
      }
      for (const refId of item.visualRefIds) {
        if (!visualIds.has(refId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['practice', 'items', itemIndex, 'visualRefIds'],
            message: `unknown Practice visual reference: ${refId}`,
          });
        }
      }
    }
  });
export type TeachingBrief = z.infer<typeof TeachingBriefSchema>;

export const TeachingBriefPreparationRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    learningUnitId: z.string().min(1),
    commandId: z.string().min(1),
    expectedExecutionSourceManifestFingerprint: z.string().min(1).max(200),
    confirmedCostPolicyIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();
export type TeachingBriefPreparationRequest = z.infer<typeof TeachingBriefPreparationRequestSchema>;

export const TeachingBriefPreparationResponseSchema = z
  .object({
    status: z.enum(['prepared', 'reused']),
    staleReason: z.enum(['none', 'route_changed', 'source_changed', 'context_changed']).nullable(),
    brief: TeachingBriefSchema,
  })
  .strict();
export type TeachingBriefPreparationResponse = z.infer<
  typeof TeachingBriefPreparationResponseSchema
>;
