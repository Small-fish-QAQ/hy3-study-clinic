import { z } from 'zod';
import { LearningUnitProgressStateSchema } from './formalProgression.js';
import { GraphRelationSchema } from './graph.js';
import { SessionAgendaItemKindSchema, SessionAgendaItemOriginSchema } from './sessionAgenda.js';
import { StudyPlanItemKindSchema, StudyPlanProgressStateSchema } from './studyPlan.js';

export const KNOWLEDGE_MAP_PROJECTION_VERSION = 'knowledge-map-projection-v1' as const;
export const KNOWLEDGE_MAP_PRECEDENCE_POLICY = 'knowledge-map-precedence-v1' as const;
export const MAX_KNOWLEDGE_MAP_NODES = 2000;
export const MAX_KNOWLEDGE_MAP_EDGES = 4000;
export const MAX_KNOWLEDGE_MAP_HISTORY_REFS = 500;

export const KnowledgeMapModeSchema = z.enum([
  'knowledge_structure',
  'learning_progress',
  'learning_route',
  'weakness_map',
]);
export type KnowledgeMapMode = z.infer<typeof KnowledgeMapModeSchema>;

export const KnowledgeMapProjectionStatusSchema = z.enum([
  'unconfigured',
  'current',
  'unknown',
  'partial',
]);
export type KnowledgeMapProjectionStatus = z.infer<typeof KnowledgeMapProjectionStatusSchema>;

export const KnowledgeMapUnknownReasonSchema = z.enum([
  'incomplete_route_pointers',
  'missing_route_artifact',
  'route_not_valid',
  'route_identity_mismatch',
  'stale_source_revision',
  'source_manifest_mismatch',
  'stale_graph_binding',
  'invalid_current_provenance',
  'node_limit_exceeded',
  'edge_limit_exceeded',
]);
export type KnowledgeMapUnknownReason = z.infer<typeof KnowledgeMapUnknownReasonSchema>;

export const KnowledgeMapProvenanceSchema = z
  .object({
    kind: z.enum([
      'source_concept_grounding',
      'graph_edge_evidence',
      'curriculum_source_reference',
    ]),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1).nullable(),
    sourceBlockId: z.string().min(1).nullable(),
    sourceBlockRevisionFingerprint: z.string().min(1).nullable(),
    quote: z.string().min(1).max(2000).nullable(),
    startOffset: z.number().int().nonnegative().nullable(),
    endOffset: z.number().int().positive().nullable(),
    exactQuoteValidated: z.boolean(),
    semanticEntailmentClaimed: z.literal(false),
    current: z.boolean(),
  })
  .strict();
export type KnowledgeMapProvenance = z.infer<typeof KnowledgeMapProvenanceSchema>;

export const KnowledgeMapAuthorityKindSchema = z.enum([
  'concept_graph',
  'curriculum',
  'study_plan',
  'session_agenda',
  'lesson_execution',
  'formal_progression',
  'formal_assessment',
  'repair',
  'review',
  'mistake',
  'legacy_mastery',
  'mastery_red_team_advisory',
]);
export type KnowledgeMapAuthorityKind = z.infer<typeof KnowledgeMapAuthorityKindSchema>;

export const KnowledgeMapAuthorityRefSchema = z
  .object({
    authority: KnowledgeMapAuthorityKindSchema,
    recordId: z.string().min(1),
    recordVersion: z.number().int().nonnegative().nullable(),
    status: z.string().min(1).max(100),
    current: z.boolean(),
  })
  .strict();
export type KnowledgeMapAuthorityRef = z.infer<typeof KnowledgeMapAuthorityRefSchema>;

export const KnowledgeMapWeaknessSignalKindSchema = z.enum([
  'formal_failure',
  'progression_repair_needed',
  'open_mistake',
  'active_repair',
  'review_due',
  'retrievability_concern',
  'legacy_mastery_weak',
  'mastery_red_team_possible_gap',
]);
export type KnowledgeMapWeaknessSignalKind = z.infer<typeof KnowledgeMapWeaknessSignalKindSchema>;

export const KnowledgeMapWeaknessSignalSchema = z
  .object({
    kind: KnowledgeMapWeaknessSignalKindSchema,
    authority: KnowledgeMapAuthorityKindSchema,
    recordIds: z.array(z.string().min(1)).min(1).max(50),
    objectiveIds: z.array(z.string().min(1)).max(30),
    current: z.boolean(),
    advisory: z.boolean(),
    actionable: z.boolean(),
    occurredAt: z.string().datetime().nullable(),
    summary: z.string().min(1).max(500),
  })
  .strict();
export type KnowledgeMapWeaknessSignal = z.infer<typeof KnowledgeMapWeaknessSignalSchema>;

export const KnowledgeMapPrimaryStateSchema = z.enum([
  'not_started',
  'planned',
  'currently_learning',
  'taught',
  'awaiting_formal_validation',
  'evidence_backed',
  'mastered',
  'developing',
  'repair',
  'weak',
  'unknown',
]);
export type KnowledgeMapPrimaryState = z.infer<typeof KnowledgeMapPrimaryStateSchema>;

export const KnowledgeMapMilestoneSchema = z.enum([
  'planned',
  'started',
  'taught',
  'formal_evidence_supported',
  'progression_complete',
  'legacy_mastery_stable',
]);

export const KnowledgeMapStateReasonSchema = z.enum([
  'route_unavailable',
  'accepted_plan_membership',
  'current_agenda_item',
  'active_study_session',
  'lesson_started',
  'lesson_presentation_completed',
  'formal_validation_pending',
  'current_supported_evidence',
  'current_formal_failure',
  'current_progression_complete',
  'current_progression_repair_needed',
  'active_repair',
  'legacy_mastery_stable',
  'legacy_mastery_developing',
  'legacy_mastery_weak',
  'no_current_learning_activity',
]);
export type KnowledgeMapStateReason = z.infer<typeof KnowledgeMapStateReasonSchema>;

export const KnowledgeMapLearnerOverlaySchema = z
  .object({
    primaryState: KnowledgeMapPrimaryStateSchema,
    milestones: z.array(KnowledgeMapMilestoneSchema).max(10),
    formalValidation: z.enum([
      'not_applicable',
      'awaiting',
      'supported',
      'current_failure',
      'unknown',
    ]),
    progression: z
      .array(
        z
          .object({
            learningUnitId: z.string().min(1),
            state: LearningUnitProgressStateSchema,
            version: z.number().int().nonnegative(),
            lastDecisionId: z.string().min(1).nullable(),
            updatedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(100),
    legacyMastery: z
      .object({
        mastery: z.number().min(0).max(1),
        attempts: z.number().int().nonnegative(),
        correctCount: z.number().int().nonnegative(),
        lastScore: z.number().min(0).max(1).nullable(),
        state: z.enum(['weak', 'developing', 'stable']),
        authority: z.literal('legacy_concept_mastery_only'),
      })
      .strict()
      .nullable(),
    reasonCodes: z.array(KnowledgeMapStateReasonSchema).min(1).max(20),
    authorityRefs: z.array(KnowledgeMapAuthorityRefSchema).max(200),
  })
  .strict();
export type KnowledgeMapLearnerOverlay = z.infer<typeof KnowledgeMapLearnerOverlaySchema>;

export const KnowledgeMapRoutePositionSchema = z.enum([
  'outside_route',
  'planned',
  'current',
  'completed',
  'next',
  'deferred',
  'locked',
  'unknown',
]);

export const KnowledgeMapRouteOverlaySchema = z
  .object({
    position: KnowledgeMapRoutePositionSchema,
    contextOnly: z.boolean(),
    acceptedPlanNext: z.boolean(),
    currentAgenda: z.boolean(),
    agendaDiffersFromPlan: z.boolean(),
    prerequisiteLocked: z.boolean(),
    lockedByNodeIds: z.array(z.string().min(1)).max(100),
    planItems: z
      .array(
        z
          .object({
            id: z.string().min(1),
            index: z.number().int().nonnegative(),
            kind: StudyPlanItemKindSchema,
            objectiveIds: z.array(z.string().min(1)).max(30),
            progressState: StudyPlanProgressStateSchema,
          })
          .strict(),
      )
      .max(100),
    agendaItems: z
      .array(
        z
          .object({
            id: z.string().min(1),
            index: z.number().int().nonnegative(),
            kind: SessionAgendaItemKindSchema,
            origin: SessionAgendaItemOriginSchema,
            state: z.enum(['queued', 'active', 'completed', 'deferred', 'cancelled', 'blocked']),
            linkedPlanItemId: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type KnowledgeMapRouteOverlay = z.infer<typeof KnowledgeMapRouteOverlaySchema>;

export const KnowledgeMapNavigationSchema = z
  .object({
    destination: z.enum(['materials', 'curriculum', 'study', 'progress']),
    materialId: z.string().min(1).nullable(),
    sourceBlockId: z.string().min(1).nullable(),
    learningUnitId: z.string().min(1).nullable(),
    objectiveId: z.string().min(1).nullable(),
    agendaItemId: z.string().min(1).nullable(),
    repairEpisodeId: z.string().min(1).nullable(),
    reviewTargetId: z.string().min(1).nullable(),
  })
  .strict();

const KnowledgeMapNodeBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(300),
  modes: z.array(KnowledgeMapModeSchema).min(1).max(4),
  current: z.boolean(),
  provenance: z.array(KnowledgeMapProvenanceSchema).max(100),
  learner: KnowledgeMapLearnerOverlaySchema,
  route: KnowledgeMapRouteOverlaySchema,
  weaknesses: z.array(KnowledgeMapWeaknessSignalSchema).max(100),
  navigation: z.array(KnowledgeMapNavigationSchema).max(20),
});

export const KnowledgeMapConceptNodeSchema = KnowledgeMapNodeBaseSchema.extend({
  kind: z.literal('concept'),
  canonicalConceptId: z.string().min(1).nullable(),
  sourceConcepts: z
    .array(
      z
        .object({
          id: z.string().min(1),
          materialId: z.string().min(1),
          materialRevisionId: z.string().min(1).nullable(),
          name: z.string().min(1).max(80),
        })
        .strict(),
    )
    .min(1)
    .max(200),
  learningUnitIds: z.array(z.string().min(1)).max(100),
  objectiveIds: z.array(z.string().min(1)).max(200),
}).strict();

export const KnowledgeMapLearningUnitNodeSchema = KnowledgeMapNodeBaseSchema.extend({
  kind: z.literal('learning_unit'),
  curriculumVersionId: z.string().min(1),
  objectiveIds: z.array(z.string().min(1)).min(1).max(30),
  conceptNodeIds: z.array(z.string().min(1)).max(50),
  prerequisiteNodeIds: z.array(z.string().min(1)).max(30),
  synthesisGroupIds: z.array(z.string().min(1)).max(50),
}).strict();

export const KnowledgeMapSynthesisNodeSchema = KnowledgeMapNodeBaseSchema.extend({
  kind: z.literal('synthesis'),
  curriculumVersionId: z.string().min(1),
  level: z.enum(['section', 'chapter', 'course', 'transfer']),
  learningUnitNodeIds: z.array(z.string().min(1)).min(2).max(50),
  objectiveIds: z.array(z.string().min(1)).min(1).max(100),
}).strict();

export const KnowledgeMapNodeSchema = z.discriminatedUnion('kind', [
  KnowledgeMapConceptNodeSchema,
  KnowledgeMapLearningUnitNodeSchema,
  KnowledgeMapSynthesisNodeSchema,
]);
export type KnowledgeMapNode = z.infer<typeof KnowledgeMapNodeSchema>;

export const KnowledgeMapEdgeKindSchema = z.enum([
  ...GraphRelationSchema.options,
  'curriculum_prerequisite',
  'unit_contains_concept',
  'synthesis_includes_unit',
]);
export type KnowledgeMapEdgeKind = z.infer<typeof KnowledgeMapEdgeKindSchema>;

export const KnowledgeMapEdgeSchema = z
  .object({
    id: z.string().min(1),
    sourceNodeId: z.string().min(1),
    targetNodeId: z.string().min(1),
    kind: KnowledgeMapEdgeKindSchema,
    modes: z.array(KnowledgeMapModeSchema).min(1).max(4),
    current: z.boolean(),
    authority: z.enum(['validated_concept_graph', 'accepted_curriculum']),
    sourceRecordIds: z.array(z.string().min(1)).min(1).max(100),
    explanation: z.string().min(1).max(500),
    provenance: z.array(KnowledgeMapProvenanceSchema).min(1).max(20),
  })
  .strict();
export type KnowledgeMapEdge = z.infer<typeof KnowledgeMapEdgeSchema>;

export const KnowledgeMapProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectionVersion: z.literal(KNOWLEDGE_MAP_PROJECTION_VERSION),
    precedencePolicyVersion: z.literal(KNOWLEDGE_MAP_PRECEDENCE_POLICY),
    workspaceId: z.string().min(1),
    generatedAt: z.string().datetime(),
    status: KnowledgeMapProjectionStatusSchema,
    route: z
      .object({
        current: z.boolean(),
        courseExecutionVersion: z.number().int().nonnegative(),
        executionStatus: z.enum(['active', 'paused', 'stopped']),
        validationStatus: z.enum(['unconfigured', 'valid', 'revalidation_required', 'blocked']),
        contractVersionId: z.string().min(1).nullable(),
        curriculumVersionId: z.string().min(1).nullable(),
        studyPlanVersionId: z.string().min(1).nullable(),
        agendaId: z.string().min(1).nullable(),
        executionSourceManifestFingerprint: z.string().min(1).nullable(),
        unknownReasons: z.array(KnowledgeMapUnknownReasonSchema).max(20),
      })
      .strict(),
    modes: z.array(KnowledgeMapModeSchema).length(4),
    nodes: z.array(KnowledgeMapNodeSchema).max(MAX_KNOWLEDGE_MAP_NODES),
    edges: z.array(KnowledgeMapEdgeSchema).max(MAX_KNOWLEDGE_MAP_EDGES),
    history: z
      .object({
        supersededCurriculumIds: z.array(z.string().min(1)).max(100),
        supersededStudyPlanIds: z.array(z.string().min(1)).max(100),
        historicalFormalEvidenceIds: z.array(z.string().min(1)).max(MAX_KNOWLEDGE_MAP_HISTORY_REFS),
        historicalAssessmentEvidenceIds: z
          .array(z.string().min(1))
          .max(MAX_KNOWLEDGE_MAP_HISTORY_REFS),
        truncated: z.boolean(),
      })
      .strict(),
    limits: z
      .object({
        maxNodes: z.literal(MAX_KNOWLEDGE_MAP_NODES),
        maxEdges: z.literal(MAX_KNOWLEDGE_MAP_EDGES),
        totalNodeCandidates: z.number().int().nonnegative(),
        totalEdgeCandidates: z.number().int().nonnegative(),
        nodesTruncated: z.boolean(),
        edgesTruncated: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((projection, ctx) => {
    const nodeIds = new Set(projection.nodes.map((node) => node.id));
    if (nodeIds.size !== projection.nodes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes'],
        message: 'node IDs must be unique',
      });
    }
    for (const [index, edge] of projection.edges.entries()) {
      if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index],
          message: 'edge endpoints must reference projected nodes',
        });
      }
    }
    const routeBlockingReasons = projection.route.unknownReasons.filter(
      (reason) =>
        reason !== 'stale_graph_binding' &&
        reason !== 'node_limit_exceeded' &&
        reason !== 'edge_limit_exceeded',
    );
    if (projection.route.current && routeBlockingReasons.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['route', 'unknownReasons'],
        message: 'a current route cannot retain route-blocking unknown reasons',
      });
    }
  });
export type KnowledgeMapProjection = z.infer<typeof KnowledgeMapProjectionSchema>;

export const KnowledgeMapProjectionResponseSchema = z
  .object({ projection: KnowledgeMapProjectionSchema })
  .strict();
export type KnowledgeMapProjectionResponse = z.infer<typeof KnowledgeMapProjectionResponseSchema>;
