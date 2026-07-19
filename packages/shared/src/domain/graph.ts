import { z } from 'zod';
import { VerifiedGroundingSchema } from './material.js';

/**
 * Controlled relation vocabulary for the evidence-grounded concept graph.
 * `source relation target` reads left-to-right, e.g.
 * "工作记忆 prerequisite 长时记忆巩固" = the source must be understood first.
 */
export const GraphRelationSchema = z.enum([
  'prerequisite',
  'part_of',
  'contrasts_with',
  'causes',
  'applies_to',
  'example_of',
]);
export type GraphRelation = z.infer<typeof GraphRelationSchema>;

export const GRAPH_RELATIONS = GraphRelationSchema.options;

/** Relations that must stay acyclic (checked deterministically per relation). */
export const ACYCLIC_RELATIONS: readonly GraphRelation[] = ['prerequisite', 'part_of'];

/** Upper bound on edges accepted into one graph version. */
export const MAX_GRAPH_EDGES = 120;
/** Upper bound on evidence records persisted per edge. */
export const MAX_EDGE_EVIDENCE = 3;
/** How many graph versions are retained per workspace (active always kept). */
export const GRAPH_VERSIONS_RETAINED = 10;

/** Lifecycle of one generated graph version. */
export const GraphVersionStatusSchema = z.enum(['generating', 'ready', 'failed']);
export type GraphVersionStatus = z.infer<typeof GraphVersionStatusSchema>;

/** One locally-validated, persisted edge of a graph version. */
export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  graphVersionId: z.string().min(1),
  sourceConceptId: z.string().min(1),
  targetConceptId: z.string().min(1),
  relation: GraphRelationSchema,
  explanation: z.string().min(1).max(500),
  /** Server-verified evidence quotes; at least one per accepted edge. */
  evidence: z.array(VerifiedGroundingSchema).min(1).max(MAX_EDGE_EVIDENCE),
  createdAt: z.string().datetime(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** A rejected candidate edge, kept for the visible validation summary. */
export const RejectedEdgeSchema = z.object({
  sourceConceptId: z.string().nullable(),
  targetConceptId: z.string().nullable(),
  relation: z.string().nullable(),
  reason: z.string().min(1).max(300),
});
export type RejectedEdge = z.infer<typeof RejectedEdgeSchema>;

/** Deterministic local validation outcome persisted with each version. */
export const GraphValidationSummarySchema = z.object({
  candidateCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  /** Evidence records dropped from otherwise-accepted edges. */
  droppedEvidenceCount: z.number().int().nonnegative(),
  rejected: z.array(RejectedEdgeSchema).max(50),
  /** Set when dependent-document deletion pruned edges from this version. */
  pruned: z
    .object({
      at: z.string().datetime(),
      reason: z.string().min(1).max(200),
    })
    .optional(),
});
export type GraphValidationSummary = z.infer<typeof GraphValidationSummarySchema>;

/** One generated concept-graph version. */
export const GraphVersionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  status: GraphVersionStatusSchema,
  /** Provider that produced the candidate edges ('fake' | 'hy3'). */
  provider: z.string().min(1).max(40),
  /** Model identifier for real providers; null for the fake provider. */
  providerModel: z.string().max(120).nullable(),
  validationSummary: GraphValidationSummarySchema.nullable(),
  errorMessage: z.string().max(500).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GraphVersion = z.infer<typeof GraphVersionSchema>;

/**
 * Deterministic learner state of one concept, derived ONLY from existing
 * mastery rows and mistake records — never invented by a model:
 *
 * - unassessed: no graded attempts recorded;
 * - weak:       open mistakes exist, or mastery < WEAK_MASTERY_THRESHOLD;
 * - stable:     no open mistakes, mastery >= STABLE_MASTERY_THRESHOLD and
 *               at least MIN_SUPPORTED_ATTEMPTS graded attempts;
 * - developing: everything in between.
 */
export const ConceptLearnerStateKindSchema = z.enum(['unassessed', 'weak', 'developing', 'stable']);
export type ConceptLearnerStateKind = z.infer<typeof ConceptLearnerStateKindSchema>;

/** Mastery at or above this level (plus enough attempts) counts as stable. */
export const STABLE_MASTERY_THRESHOLD = 0.85;
/** Attempts needed before mastery is considered well-supported. */
export const MIN_SUPPORTED_ATTEMPTS = 3;

export const ConceptLearnerStateSchema = z.object({
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  materialId: z.string().min(1),
  state: ConceptLearnerStateKindSchema,
  /** Current mastery in [0,1], null when the concept is unassessed. */
  mastery: z.number().min(0).max(1).nullable(),
  /** Whether enough graded activity exists to support the mastery value. */
  hasEnoughActivity: z.boolean(),
  attempts: z.number().int().nonnegative(),
  correctCount: z.number().int().nonnegative(),
  lastScore: z.number().min(0).max(1).nullable(),
  lastActivityAt: z.string().datetime().nullable(),
  openMistakes: z.number().int().nonnegative(),
  resolvedMistakes: z.number().int().nonnegative(),
  /** Whether remediation should treat this concept as a priority. */
  treatAsWeak: z.boolean(),
  /** Direct prerequisite concepts from the active graph (may be empty). */
  prerequisiteConceptIds: z.array(z.string()).max(50),
});
export type ConceptLearnerState = z.infer<typeof ConceptLearnerStateSchema>;
