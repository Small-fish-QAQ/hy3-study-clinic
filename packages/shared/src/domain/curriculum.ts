import { z } from 'zod';
import { TruthPremiseStatusSchema } from './sourceAuthority.js';

export const ExecutionSourceRevisionSchema = z
  .object({
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    parserVersion: z.string().max(80).nullable(),
    parserFingerprint: z.string().min(1).max(200).nullable(),
    sourceBlockRevisionIds: z.array(z.string().min(1)).max(10000),
  })
  .strict();
export type ExecutionSourceRevision = z.infer<typeof ExecutionSourceRevisionSchema>;

/** Exact extraction identity used by a downstream executable artifact. */
export const ExecutionSourceManifestSchema = z
  .object({
    fingerprint: z.string().min(1).max(200),
    revisions: z.array(ExecutionSourceRevisionSchema).min(1).max(100),
  })
  .strict();
export type ExecutionSourceManifest = z.infer<typeof ExecutionSourceManifestSchema>;

export const CurriculumStatusSchema = z.enum([
  'candidate',
  'proposed',
  'accepted',
  'rejected',
  'failed',
  'superseded',
]);
export type CurriculumStatus = z.infer<typeof CurriculumStatusSchema>;

export const CurriculumNodeKindSchema = z.enum(['course', 'chapter', 'section', 'learning_unit']);
export type CurriculumNodeKind = z.infer<typeof CurriculumNodeKindSchema>;

export const CurriculumSourceReferenceSchema = z
  .object({
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    structuralUnitId: z.string().min(1).nullable(),
    sourceBlockId: z.string().min(1).nullable(),
    sourceBlockRevisionFingerprint: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type CurriculumSourceReference = z.infer<typeof CurriculumSourceReferenceSchema>;

export const CurriculumObjectiveSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(1000),
    truthPremiseStatus: TruthPremiseStatusSchema,
    truthAuthorityRecordIds: z.array(z.string().min(1)).max(20),
  })
  .strict()
  .superRefine((objective, ctx) => {
    if (
      objective.truthPremiseStatus === 'independently_verified' &&
      objective.truthAuthorityRecordIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['truthAuthorityRecordIds'],
        message: 'verified objectives require independent truth-authority records',
      });
    }
  });
export type CurriculumObjective = z.infer<typeof CurriculumObjectiveSchema>;

export const CurriculumLearningUnitSchema = z
  .object({
    conceptIds: z.array(z.string().min(1)).max(30),
    canonicalConceptIds: z.array(z.string().min(1)).max(20),
    objectives: z.array(CurriculumObjectiveSchema).min(1).max(30),
    prerequisiteUnitIds: z.array(z.string().min(1)).max(30),
    graphRelationIds: z.array(z.string().min(1)).max(50),
    riskIds: z.array(z.string().min(1)).max(50),
  })
  .strict();
export type CurriculumLearningUnit = z.infer<typeof CurriculumLearningUnitSchema>;

export const CurriculumNodeSchema = z
  .object({
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    kind: CurriculumNodeKindSchema,
    index: z.number().int().nonnegative(),
    title: z.string().min(1).max(300),
    sourceReferences: z.array(CurriculumSourceReferenceSchema).max(100),
    learningUnit: CurriculumLearningUnitSchema.nullable(),
  })
  .strict()
  .superRefine((node, ctx) => {
    if (node.kind === 'learning_unit' && !node.learningUnit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['learningUnit'],
        message: 'learning_unit nodes require learning-unit details',
      });
    }
    if (node.kind !== 'learning_unit' && node.learningUnit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['learningUnit'],
        message: 'only learning_unit nodes may contain learning-unit details',
      });
    }
  });
export type CurriculumNode = z.infer<typeof CurriculumNodeSchema>;

export const CurriculumSynthesisGroupSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(300),
    level: z.enum(['section', 'chapter', 'course', 'transfer']),
    learningUnitIds: z.array(z.string().min(1)).min(2).max(50),
    objectiveIds: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict();
export type CurriculumSynthesisGroup = z.infer<typeof CurriculumSynthesisGroupSchema>;

export const CurriculumValidationSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(z.string().min(1).max(500)).max(100),
    warnings: z.array(z.string().min(1).max(500)).max(100),
    unmappedStructuralUnitIds: z.array(z.string().min(1)).max(1000),
  })
  .strict();

export const CurriculumSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    contractVersionId: z.string().min(1),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    status: CurriculumStatusSchema,
    executionSourceManifest: ExecutionSourceManifestSchema,
    nodes: z.array(CurriculumNodeSchema).min(1).max(2000),
    synthesisGroups: z.array(CurriculumSynthesisGroupSchema).max(200),
    validation: CurriculumValidationSchema,
    provider: z.string().min(1).max(40),
    providerModel: z.string().max(120).nullable(),
    createdAt: z.string().datetime(),
    acceptedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((curriculum, ctx) => {
    if (
      curriculum.status === 'accepted' &&
      (!curriculum.validation.valid || !curriculum.acceptedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an accepted Curriculum must be valid and record acceptance time',
      });
    }
  });
export type Curriculum = z.infer<typeof CurriculumSchema>;
