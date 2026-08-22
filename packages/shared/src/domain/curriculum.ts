import { z } from 'zod';
import { CourseExecutionCommandEnvelopeSchema } from './learningContract.js';
import { TruthPremiseStatusSchema } from './sourceAuthority.js';

export const ExecutionSourceRevisionSchema = z
  .object({
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    parserVersion: z.string().max(80).nullable(),
    parserFingerprint: z.string().min(1).max(200).nullable(),
    chunkerVersion: z.string().max(80).nullable().optional(),
    chunkerFingerprint: z.string().min(1).max(200).nullable().optional(),
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
    /** Goal-specific emphasis; Curriculum truth remains unchanged. */
    priority: z.enum(['required', 'high', 'normal', 'optional']).optional(),
    priorityRationale: z.string().min(1).max(500).optional(),
    /** Explicit compatibility result for the Formal Assessment handoff. */
    formalAssessmentReady: z.boolean().optional(),
    formalAssessmentReadinessRationale: z.string().min(1).max(500).optional(),
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

/** Why one exact source region is or is not represented in a Curriculum. */
export const CurriculumCoverageDispositionKindSchema = z.enum([
  'represented_directly',
  'represented_by_parent_or_synthesis',
  'duplicate/redundant',
  'boilerplate/navigation/non-learning-content',
  'explicitly_out_of_scope',
  'unresolved_candidate_gap',
]);
export type CurriculumCoverageDispositionKind = z.infer<
  typeof CurriculumCoverageDispositionKindSchema
>;

export const CurriculumCoverageDispositionSchema = z
  .object({
    sourceRegionId: z.string().min(1).max(200),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    sourceSectionIds: z.array(z.string().min(1)).min(1).max(10_000),
    sourceBlockIds: z.array(z.string().min(1)).min(1).max(10_000),
    meaningful: z.boolean(),
    disposition: CurriculumCoverageDispositionKindSchema,
    rationale: z.string().min(1).max(500),
    curriculumNodeIds: z.array(z.string().min(1)).max(100),
    objectiveIds: z.array(z.string().min(1)).max(100),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (
      (row.disposition === 'represented_directly' ||
        row.disposition === 'represented_by_parent_or_synthesis') &&
      row.curriculumNodeIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['curriculumNodeIds'],
        message: 'represented source regions require Curriculum node identities',
      });
    }
    if (row.disposition === 'unresolved_candidate_gap' && !row.meaningful) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meaningful'],
        message: 'unresolved candidate gaps must remain meaningful source regions',
      });
    }
  });
export type CurriculumCoverageDisposition = z.infer<typeof CurriculumCoverageDispositionSchema>;

export const CurriculumCoverageAccountabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceMapFingerprint: z.string().min(1).max(200),
    scope: z.enum(['systematic_mastery', 'intentional_scope']),
    regions: z.array(CurriculumCoverageDispositionSchema).max(10_000),
    meaningfulRegionCount: z.number().int().nonnegative(),
    dispositionCounts: z.record(z.string(), z.number().int().nonnegative()),
    unresolvedMeaningfulRegionIds: z.array(z.string().min(1)).max(10_000),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    const ids = coverage.regions.map((row) => row.sourceRegionId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regions'],
        message: 'source coverage dispositions must identify each region exactly once',
      });
    }
    const meaningfulCount = coverage.regions.filter((row) => row.meaningful).length;
    if (meaningfulCount !== coverage.meaningfulRegionCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meaningfulRegionCount'],
        message: 'meaningfulRegionCount does not match source disposition rows',
      });
    }
    const unresolved = coverage.regions
      .filter((row) => row.meaningful && row.disposition === 'unresolved_candidate_gap')
      .map((row) => row.sourceRegionId);
    if (
      unresolved.length !== coverage.unresolvedMeaningfulRegionIds.length ||
      unresolved.some((id, index) => id !== coverage.unresolvedMeaningfulRegionIds[index])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unresolvedMeaningfulRegionIds'],
        message: 'unresolved meaningful source regions are inconsistent with dispositions',
      });
    }
  });
export type CurriculumCoverageAccountability = z.infer<
  typeof CurriculumCoverageAccountabilitySchema
>;

export const CurriculumQualityCriterionSchema = z.enum([
  'coverage_accountability',
  'hierarchy_coherence',
  'sequencing',
  'conceptual_cohesion',
  'granularity',
  'objective_alignment',
  'assessment_readiness_compatibility',
]);
export type CurriculumQualityCriterion = z.infer<typeof CurriculumQualityCriterionSchema>;

export const CurriculumQualityFindingSchema = z
  .object({
    criterion: CurriculumQualityCriterionSchema,
    severity: z.enum(['info', 'warning', 'error']),
    code: z.string().min(1).max(120),
    affectedCurriculumNodeIds: z.array(z.string().min(1)).max(100),
    affectedSourceRegionIds: z.array(z.string().min(1)).max(100),
    rationale: z.string().min(1).max(800),
    repairDisposition: z.enum(['none', 'repaired', 'rejected']),
  })
  .strict();
export type CurriculumQualityFinding = z.infer<typeof CurriculumQualityFindingSchema>;

export const CurriculumSemanticEvaluationSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().min(1).max(80),
    evaluator: z.string().min(1).max(120),
    independent: z.literal(true),
    status: z.enum(['pass', 'fail']),
    boundedRepairAttempted: z.boolean(),
    findings: z.array(CurriculumQualityFindingSchema).max(200),
    evaluatedAt: z.string().datetime(),
  })
  .strict();
export type CurriculumSemanticEvaluation = z.infer<typeof CurriculumSemanticEvaluationSchema>;

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

export const CurriculumCoverageWarningCodeSchema = z.enum([
  'unmapped_source_blocks',
  'unmapped_structural_units',
  'other_coverage_warning',
]);
export type CurriculumCoverageWarningCode = z.infer<typeof CurriculumCoverageWarningCodeSchema>;

/** Learner-safe warning identity projected from immutable validation diagnostics. */
export const CurriculumCoverageWarningSchema = z
  .object({
    code: CurriculumCoverageWarningCodeSchema,
    count: z.number().int().nonnegative().nullable(),
    /** Bounded internal detail; clients must keep this behind technical disclosure. */
    technicalDetail: z.string().min(1).max(500),
  })
  .strict();
export type CurriculumCoverageWarning = z.infer<typeof CurriculumCoverageWarningSchema>;

export const CurriculumRecoveryStateSchema = z.enum([
  'not_required',
  'concept_grounding_missing',
  'concept_grounding_stale',
  'curriculum_remediation_ready',
  'curriculum_candidate_ready',
]);
export type CurriculumRecoveryState = z.infer<typeof CurriculumRecoveryStateSchema>;

export const CurriculumRecoveryNextActionSchema = z.enum([
  'none',
  'build_concept_grounding',
  'rebuild_concept_grounding',
  'propose_curriculum_successor',
  'review_curriculum_successor',
]);

/** Deterministic prerequisite state for repairing an unexecutable accepted Curriculum. */
export const CurriculumRecoveryReadinessSchema = z
  .object({
    state: CurriculumRecoveryStateSchema,
    nextAction: CurriculumRecoveryNextActionSchema,
    remediationRequired: z.boolean(),
    includedMaterialCount: z.number().int().nonnegative(),
    currentConceptCount: z.number().int().nonnegative(),
    validGroundedConceptCount: z.number().int().nonnegative(),
    staleConceptCount: z.number().int().nonnegative(),
    invalidGroundingCount: z.number().int().nonnegative(),
    canonicalConceptCount: z.number().int().nonnegative(),
    canonicalMembershipCount: z.number().int().nonnegative(),
  })
  .strict();
export type CurriculumRecoveryReadiness = z.infer<typeof CurriculumRecoveryReadinessSchema>;

/** Safe, bounded details for a failed locally validated Curriculum candidate. */
export const CurriculumProposalFailureDetailsSchema = z
  .object({
    kind: z.literal('curriculum_candidate_validation'),
    repairAttempted: z.boolean(),
    errors: z.array(z.string().min(1).max(500)).max(20),
    warnings: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();
export type CurriculumProposalFailureDetails = z.infer<
  typeof CurriculumProposalFailureDetailsSchema
>;

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
    coverageAccountability: CurriculumCoverageAccountabilitySchema.optional(),
    qualityEvaluation: CurriculumSemanticEvaluationSchema.optional(),
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

export const ProposeCurriculumRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    contractId: z.string().min(1),
    expectedContractVersion: z.number().int().positive(),
    confirmedCostPolicyIds: z.array(z.string().min(1)).max(20).optional(),
    executionSourceManifest: ExecutionSourceManifestSchema,
    predecessorCurriculumId: z.string().min(1).nullable(),
    expectedActiveCurriculumId: z.string().min(1).nullable(),
  })
  .strict();
export type ProposeCurriculumRequest = z.infer<typeof ProposeCurriculumRequestSchema>;

export const AcceptCurriculumRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    curriculumId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    expectedContractId: z.string().min(1),
    expectedExecutionSourceManifestFingerprint: z.string().min(1).max(200),
    acceptanceBasis: z.enum(['learner_review', 'explicit_local_policy']),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.acceptanceBasis === 'learner_review' && request.command.actor !== 'learner') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command', 'actor'],
        message: 'learner review acceptance requires the learner actor',
      });
    }
  });
export type AcceptCurriculumRequest = z.infer<typeof AcceptCurriculumRequestSchema>;

export const RejectCurriculumRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    curriculumId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type RejectCurriculumRequest = z.infer<typeof RejectCurriculumRequestSchema>;

/** Flat, deterministic hierarchy projection for clients; domain nodes remain canonical. */
export const CurriculumHierarchyNodeViewSchema = z
  .object({
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    childIds: z.array(z.string().min(1)).max(1000),
    kind: CurriculumNodeKindSchema,
    index: z.number().int().nonnegative(),
    depth: z.number().int().nonnegative().max(10),
    title: z.string().min(1).max(300),
    breadcrumbTitles: z.array(z.string().min(1).max(300)).max(10),
    learningUnit: CurriculumLearningUnitSchema.nullable(),
    sourceReferences: z.array(CurriculumSourceReferenceSchema).max(100),
    mappedPlanItemIds: z.array(z.string().min(1)).max(100),
    progressState: z
      .enum(['not_started', 'started', 'completed', 'repair_needed', 'deferred', 'obsolete'])
      .nullable(),
  })
  .strict();
export type CurriculumHierarchyNodeView = z.infer<typeof CurriculumHierarchyNodeViewSchema>;

export const CurriculumHierarchyViewSchema = z
  .object({
    curriculumId: z.string().min(1),
    curriculumVersion: z.number().int().positive(),
    status: CurriculumStatusSchema,
    rootNodeIds: z.array(z.string().min(1)).min(1).max(100),
    nodes: z.array(CurriculumHierarchyNodeViewSchema).min(1).max(2000),
    synthesisGroups: z.array(CurriculumSynthesisGroupSchema).max(200),
    validation: CurriculumValidationSchema,
    /** Structured learner rendering; persisted validation diagnostics remain immutable. */
    coverageWarnings: z.array(CurriculumCoverageWarningSchema).max(100).optional(),
    coverageAccountability: CurriculumCoverageAccountabilitySchema.optional(),
    qualityEvaluation: CurriculumSemanticEvaluationSchema.optional(),
    executionSourceManifest: ExecutionSourceManifestSchema,
  })
  .strict()
  .superRefine((view, ctx) => {
    const ids = new Set(view.nodes.map((node) => node.id));
    for (const id of view.rootNodeIds) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rootNodeIds'],
          message: `unknown Curriculum root node: ${id}`,
        });
      }
    }
    for (const [index, node] of view.nodes.entries()) {
      if (node.parentId !== null && !ids.has(node.parentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'parentId'],
          message: `unknown Curriculum parent node: ${node.parentId}`,
        });
      }
      for (const childId of node.childIds) {
        if (!ids.has(childId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'childIds'],
            message: `unknown Curriculum child node: ${childId}`,
          });
        }
      }
    }
  });
export type CurriculumHierarchyView = z.infer<typeof CurriculumHierarchyViewSchema>;

export const CurriculumHistoryItemSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    contractVersionId: z.string().min(1),
    status: CurriculumStatusSchema,
    title: z.string().min(1).max(300),
    learningUnitCount: z.number().int().nonnegative(),
    unmappedStructuralUnitCount: z.number().int().nonnegative(),
    validationValid: z.boolean(),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    acceptedAt: z.string().datetime().nullable(),
  })
  .strict();
export type CurriculumHistoryItem = z.infer<typeof CurriculumHistoryItemSchema>;

export const CurriculumHistoryResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    acceptedCurriculumId: z.string().min(1).nullable(),
    proposedCurriculumId: z.string().min(1).nullable(),
    items: z.array(CurriculumHistoryItemSchema).max(500),
  })
  .strict();
export type CurriculumHistoryResponse = z.infer<typeof CurriculumHistoryResponseSchema>;

export const CurriculumProposalResponseSchema = z
  .object({
    curriculum: CurriculumSchema,
    hierarchy: CurriculumHierarchyViewSchema,
    retainedAcceptedCurriculumId: z.string().min(1).nullable(),
  })
  .strict();
export type CurriculumProposalResponse = z.infer<typeof CurriculumProposalResponseSchema>;
