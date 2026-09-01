import { z } from 'zod';

export const CourseMapSourceVisibilityEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1).max(100),
    bindingId: z.string().min(1).max(100),
    blockId: z.string().min(1),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    quote: z.string().min(1).max(320),
  })
  .strict();
export type CourseMapSourceVisibilityEvidence = z.infer<
  typeof CourseMapSourceVisibilityEvidenceSchema
>;

export const CourseMapSourceAllocationRegionSchema = z
  .object({
    id: z.string().regex(/^course_map_source_region_[0-9a-f]{24}$/u),
    index: z.number().int().nonnegative(),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    title: z.string().min(1).max(300),
    firstCourseSourceIndex: z.number().int().nonnegative(),
    lastCourseSourceIndex: z.number().int().nonnegative(),
    charCount: z.number().int().nonnegative(),
    sourceSectionIds: z.array(z.string().min(1)).min(1).max(10_000),
    sourceBlockIds: z.array(z.string().min(1)).min(1).max(10_000),
    conceptIds: z.array(z.string().min(1)).max(10_000),
    evidence: z.array(CourseMapSourceVisibilityEvidenceSchema).max(2),
  })
  .strict();
export type CourseMapSourceAllocationRegion = z.infer<typeof CourseMapSourceAllocationRegionSchema>;

export const CourseMapSourceDispositionKindSchema = z.enum([
  'represented_directly',
  'represented_by_parent_or_synthesis',
  'duplicate/redundant',
  'boilerplate/navigation/non-learning-content',
  'explicitly_out_of_scope',
  'unresolved_candidate_gap',
]);
export type CourseMapSourceDispositionKind = z.infer<typeof CourseMapSourceDispositionKindSchema>;

export const CourseMapSourceDispositionSchema = z
  .object({
    sourceAllocationRegionId: z.string().min(1),
    disposition: CourseMapSourceDispositionKindSchema,
    rationale: z.string().min(1).max(500),
    representedRegionRefs: z.array(z.string().regex(/^R[1-9][0-9]*$/u)).max(20),
  })
  .strict();
export type CourseMapSourceDisposition = z.infer<typeof CourseMapSourceDispositionSchema>;

/**
 * The only locally accepted reason a scoped Material may hold zero textual
 * regions: its active revision carries original asset bytes and no authoritative
 * text. A parse failure never reaches this state because empty extraction is
 * refused at ingestion.
 */
export const CourseMapAssetOnlyMaterialReasonSchema = z.literal('no_textual_allocation_surface');
export type CourseMapAssetOnlyMaterialReason = z.infer<
  typeof CourseMapAssetOnlyMaterialReasonSchema
>;

/**
 * Server-owned material-level accounting for a scoped Material that legitimately
 * has no textual allocation surface. Planning/accounting state only: it grants no
 * evidence, mastery, credit, or progression, and the provider never authors it.
 */
export const CourseMapAssetOnlyMaterialDispositionSchema = z
  .object({
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    reason: CourseMapAssetOnlyMaterialReasonSchema,
    originalVisualCount: z.number().int().positive().max(10_000),
  })
  .strict();
export type CourseMapAssetOnlyMaterialDisposition = z.infer<
  typeof CourseMapAssetOnlyMaterialDispositionSchema
>;

/** Bounded visibility over a complete Course Source Map; never source truth. */
export const CourseMapSourceAllocationSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    courseSourceMapFingerprint: z.string().min(1),
    fingerprint: z.string().regex(/^course_map_source_allocation_[0-9a-f]{40}$/u),
    authority: z.literal('planning_visibility_only'),
    materialCount: z.number().int().positive(),
    sourceSectionCount: z.number().int().positive(),
    sourceBlockCount: z.number().int().positive(),
    assetOnlyMaterials: z.array(CourseMapAssetOnlyMaterialDispositionSchema).max(100),
    limits: z
      .object({
        maxRegions: z.number().int().positive().max(120),
        maxEvidenceOffers: z.number().int().nonnegative().max(160),
        maxEvidenceOffersPerRegion: z.number().int().nonnegative().max(2),
      })
      .strict(),
    regions: z.array(CourseMapSourceAllocationRegionSchema).min(1).max(120),
  })
  .strict()
  .superRefine((allocation, ctx) => {
    if (allocation.regions.length > allocation.limits.maxRegions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regions'],
        message: 'Course Map source regions exceed their declared limit.',
      });
    }
    const regionIds = new Set<string>();
    const sourceSectionIds = new Set<string>();
    const sourceBlockIds = new Set<string>();
    const evidenceIds = new Set<string>();
    const evidenceBindingIds = new Set<string>();
    const materialRevisionById = new Map<string, string>();
    let evidenceCount = 0;
    let previousSourceIndex = -1;
    for (const [index, region] of allocation.regions.entries()) {
      if (regionIds.has(region.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regions', index, 'id'],
          message: `duplicate Course Map source region id: ${region.id}`,
        });
      }
      regionIds.add(region.id);
      if (region.index !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regions', index, 'index'],
          message: 'Course Map source region indexes must be contiguous.',
        });
      }
      if (region.firstCourseSourceIndex > region.lastCourseSourceIndex) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regions', index],
          message: 'Course Map source region indexes must be ordered.',
        });
      }
      if (region.firstCourseSourceIndex <= previousSourceIndex) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regions', index, 'firstCourseSourceIndex'],
          message: 'Course Map source regions must preserve source order.',
        });
      }
      previousSourceIndex = region.lastCourseSourceIndex;
      const knownMaterialRevision = materialRevisionById.get(region.materialId);
      if (knownMaterialRevision && knownMaterialRevision !== region.materialRevisionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regions', index, 'materialRevisionId'],
          message: `Course Map Material ${region.materialId} spans inconsistent revisions.`,
        });
      }
      materialRevisionById.set(region.materialId, region.materialRevisionId);
      if (new Set(region.conceptIds).size !== region.conceptIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regions', index, 'conceptIds'],
          message: 'Course Map source-region Concept identities must be unique.',
        });
      }
      for (const sectionId of region.sourceSectionIds) {
        if (sourceSectionIds.has(sectionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['regions', index, 'sourceSectionIds'],
            message: `duplicate Course Map source section id: ${sectionId}`,
          });
        }
        sourceSectionIds.add(sectionId);
      }
      for (const blockId of region.sourceBlockIds) {
        if (sourceBlockIds.has(blockId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['regions', index, 'sourceBlockIds'],
            message: `duplicate Course Map source block id: ${blockId}`,
          });
        }
        sourceBlockIds.add(blockId);
      }
      if (region.evidence.length > allocation.limits.maxEvidenceOffersPerRegion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regions', index, 'evidence'],
          message: 'Course Map source-region evidence exceeds its declared limit.',
        });
      }
      evidenceCount += region.evidence.length;
      for (const [evidenceIndex, evidence] of region.evidence.entries()) {
        if (!region.sourceBlockIds.includes(evidence.blockId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['regions', index, 'evidence', evidenceIndex, 'blockId'],
            message: 'Course Map evidence must belong to its source region.',
          });
        }
        if (evidence.endOffset - evidence.startOffset !== evidence.quote.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['regions', index, 'evidence', evidenceIndex],
            message: 'Course Map evidence offsets must match the offered quote length.',
          });
        }
        if (evidenceIds.has(evidence.evidenceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['regions', index, 'evidence', evidenceIndex, 'evidenceId'],
            message: `duplicate Course Map evidence id: ${evidence.evidenceId}`,
          });
        }
        evidenceIds.add(evidence.evidenceId);
        if (evidenceBindingIds.has(evidence.bindingId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['regions', index, 'evidence', evidenceIndex, 'bindingId'],
            message: `duplicate Course Map evidence binding id: ${evidence.bindingId}`,
          });
        }
        evidenceBindingIds.add(evidence.bindingId);
      }
    }
    if (evidenceCount > allocation.limits.maxEvidenceOffers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regions'],
        message: 'Course Map evidence exceeds its global declared limit.',
      });
    }
    if (sourceSectionIds.size !== allocation.sourceSectionCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regions'],
        message: 'Course Map source sections are not represented exactly once.',
      });
    }
    if (sourceBlockIds.size !== allocation.sourceBlockCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regions'],
        message: 'Course Map source blocks are not represented exactly once.',
      });
    }
    const regionBackedMaterialIds = new Set(allocation.regions.map((region) => region.materialId));
    const assetOnlyMaterialIds = new Set<string>();
    for (const [index, disposition] of allocation.assetOnlyMaterials.entries()) {
      if (assetOnlyMaterialIds.has(disposition.materialId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assetOnlyMaterials', index, 'materialId'],
          message: `duplicate asset-only Course Map Material accounting: ${disposition.materialId}`,
        });
      }
      assetOnlyMaterialIds.add(disposition.materialId);
      if (regionBackedMaterialIds.has(disposition.materialId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assetOnlyMaterials', index, 'materialId'],
          message: `Course Map Material ${disposition.materialId} is both region-backed and asset-only.`,
        });
      }
      const knownRevision = materialRevisionById.get(disposition.materialId);
      if (knownRevision && knownRevision !== disposition.materialRevisionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assetOnlyMaterials', index, 'materialRevisionId'],
          message: `Course Map Material ${disposition.materialId} spans inconsistent revisions.`,
        });
      }
    }
    if (regionBackedMaterialIds.size + assetOnlyMaterialIds.size !== allocation.materialCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regions'],
        message: 'Course Map Material representation is inconsistent with its count.',
      });
    }
  });
export type CourseMapSourceAllocation = z.infer<typeof CourseMapSourceAllocationSchema>;

export const CourseMapApproximateScopeSchema = z.enum(['focused', 'standard', 'extended']);
export type CourseMapApproximateScope = z.infer<typeof CourseMapApproximateScopeSchema>;

export const CourseMapRegionSchema = z
  .object({
    id: z.string().regex(/^course_map_region_[0-9a-f]{24}$/u),
    proposalKey: z.string().min(1).max(100),
    moduleId: z.string().regex(/^course_map_module_[0-9a-f]{24}$/u),
    index: z.number().int().nonnegative(),
    title: z.string().min(1).max(300),
    learningIntent: z.string().min(1).max(700),
    approximateScope: CourseMapApproximateScopeSchema,
    sourceAllocationRegionIds: z.array(z.string().min(1)).min(1).max(16),
    materialIds: z.array(z.string().min(1)).max(100),
    conceptIds: z.array(z.string().min(1)).max(20),
    canonicalConceptIds: z.array(z.string().min(1)).max(10),
    expectedOutcome: z.string().min(1).max(500).optional(),
    /** Operation-local recovery aliases retained through detail materialization. */
    capabilityRequirementRefs: z.array(z.string().min(1).max(100)).max(4).optional(),
  })
  .strict();
export type CourseMapRegion = z.infer<typeof CourseMapRegionSchema>;

export const CourseMapModuleSchema = z
  .object({
    id: z.string().regex(/^course_map_module_[0-9a-f]{24}$/u),
    proposalKey: z.string().min(1).max(100),
    index: z.number().int().nonnegative(),
    title: z.string().min(1).max(300),
    learningIntent: z.string().min(1).max(700),
    sequenceRationale: z.string().min(1).max(500).optional(),
    regions: z.array(CourseMapRegionSchema).min(1).max(120),
  })
  .strict();
export type CourseMapModule = z.infer<typeof CourseMapModuleSchema>;

export const CourseMapPrerequisiteSchema = z
  .object({
    prerequisiteRegionId: z.string().regex(/^course_map_region_[0-9a-f]{24}$/u),
    dependentRegionId: z.string().regex(/^course_map_region_[0-9a-f]{24}$/u),
    rationale: z.string().min(1).max(500).optional(),
  })
  .strict();
export type CourseMapPrerequisite = z.infer<typeof CourseMapPrerequisiteSchema>;

export const CourseMapSynthesisGroupSchema = z
  .object({
    id: z.string().regex(/^course_map_synthesis_[0-9a-f]{24}$/u),
    proposalKey: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    level: z.enum(['module', 'course', 'transfer']),
    regionIds: z
      .array(z.string().regex(/^course_map_region_[0-9a-f]{24}$/u))
      .min(2)
      .max(50),
  })
  .strict();
export type CourseMapSynthesisGroup = z.infer<typeof CourseMapSynthesisGroupSchema>;

/** Operation-local skeleton proposal. It has no lifecycle or acceptance authority. */
export const CourseMapSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^course_map_[0-9a-f]{24}$/u),
    workspaceId: z.string().min(1),
    courseSourceMapFingerprint: z.string().min(1),
    sourceAllocationFingerprint: z.string().min(1),
    authority: z.literal('planning_proposal_only'),
    modules: z.array(CourseMapModuleSchema).min(1).max(24),
    prerequisites: z.array(CourseMapPrerequisiteSchema).max(384),
    synthesisGroups: z.array(CourseMapSynthesisGroupSchema).max(100),
    sourceDispositions: z.array(CourseMapSourceDispositionSchema).max(120).optional(),
  })
  .strict();
export type CourseMap = z.infer<typeof CourseMapSchema>;

export const CourseMapDiagnosticCodeSchema = z.enum([
  'source_allocation_fingerprint_mismatch',
  'module_limit_exceeded',
  'region_limit_exceeded',
  'invalid_module_order',
  'invalid_region_order',
  'unknown_source_region',
  'duplicate_source_allocation',
  'unallocated_source_region',
  'missing_material_representation',
  'source_allocation_concentration',
  'unsupported_region',
  'unknown_concept_anchor',
  'concept_anchor_outside_allocation',
  'unknown_canonical_anchor',
  'canonical_anchor_outside_allocation',
  'unknown_anchor_option',
  'anchor_option_outside_region',
  'unknown_prerequisite_region',
  'self_prerequisite',
  'duplicate_prerequisite',
  'prerequisite_cycle',
  'prerequisite_wrong_order',
  'prerequisite_edge_limit_exceeded',
  'prerequisite_degree_exceeded',
  'isolated_regions',
  'duplicate_synthesis_group',
  'unknown_synthesis_region',
  'duplicate_synthesis_region',
  'invalid_synthesis_boundary',
  'missing_synthesis_boundary',
  'duplicate_region_intent',
  'near_duplicate_region_intent',
  'flat_hierarchy',
  'unknown_source_disposition_region',
  'source_disposition_inconsistent',
  'recovery_capability_unknown',
  'recovery_capability_missing',
  'recovery_capability_duplicate',
  'recovery_capability_outside_source_envelope',
  'recovery_capability_region_capacity_exceeded',
]);
export type CourseMapDiagnosticCode = z.infer<typeof CourseMapDiagnosticCodeSchema>;

export const CourseMapDiagnosticSchema = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: CourseMapDiagnosticCodeSchema,
    message: z.string().min(1).max(500),
    entityKeys: z.array(z.string().min(1).max(100)).max(20),
  })
  .strict();
export type CourseMapDiagnostic = z.infer<typeof CourseMapDiagnosticSchema>;

export const CourseMapQualityProfileSchema = z
  .object({
    hierarchy: z
      .object({
        moduleCount: z.number().int().nonnegative(),
        regionCount: z.number().int().nonnegative(),
        maxRegionsPerModule: z.number().int().nonnegative(),
        flat: z.boolean(),
      })
      .strict(),
    sourceAllocation: z
      .object({
        sourceRegionCount: z.number().int().nonnegative(),
        allocatedSourceRegionCount: z.number().int().nonnegative(),
        unallocatedSourceRegionCount: z.number().int().nonnegative(),
        duplicateAllocationCount: z.number().int().nonnegative(),
        unsupportedRegionCount: z.number().int().nonnegative(),
        representedMaterialCount: z.number().int().nonnegative(),
        totalMaterialCount: z.number().int().nonnegative(),
        representedSectionCount: z.number().int().nonnegative(),
        totalSectionCount: z.number().int().nonnegative(),
        representedBlockCount: z.number().int().nonnegative(),
        totalBlockCount: z.number().int().nonnegative(),
        maxRegionShare: z.number().min(0).max(1),
      })
      .strict(),
    prerequisites: z
      .object({
        edgeCount: z.number().int().nonnegative(),
        dagValid: z.boolean(),
        maxInDegree: z.number().int().nonnegative(),
        maxOutDegree: z.number().int().nonnegative(),
        isolatedRegionCount: z.number().int().nonnegative(),
      })
      .strict(),
    synthesis: z
      .object({
        groupCount: z.number().int().nonnegative(),
        boundaryRegionCount: z.number().int().nonnegative(),
      })
      .strict(),
    duplication: z
      .object({
        duplicateIntentPairCount: z.number().int().nonnegative(),
        nearDuplicateIntentPairCount: z.number().int().nonnegative(),
      })
      .strict(),
    anchors: z
      .object({
        conceptAnchorCount: z.number().int().nonnegative(),
        canonicalConceptAnchorCount: z.number().int().nonnegative(),
        invalidAnchorCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type CourseMapQualityProfile = z.infer<typeof CourseMapQualityProfileSchema>;

export const CourseMapValidationSchema = z
  .object({
    valid: z.boolean(),
    diagnostics: z.array(CourseMapDiagnosticSchema).max(300),
  })
  .strict();
export type CourseMapValidation = z.infer<typeof CourseMapValidationSchema>;

export const CourseMapAnalysisSchema = z
  .object({
    sourceAllocation: CourseMapSourceAllocationSchema,
    courseMap: CourseMapSchema,
    validation: CourseMapValidationSchema,
    qualityProfile: CourseMapQualityProfileSchema,
  })
  .strict();
export type CourseMapAnalysis = z.infer<typeof CourseMapAnalysisSchema>;
