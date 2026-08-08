import { z } from 'zod';
import { VerifiedGroundingSchema } from './material.js';
import { AssessmentModeSchema } from './blueprint.js';

/**
 * Bounded Hy3 Tutor: shared contracts for tool whitelisting, run persistence,
 * and the safe timeline shown to the learner.
 *
 * The Tutor is NOT an unrestricted agent: it selects from a small, typed,
 * read-only tool whitelist, inside explicit local budgets, and its only
 * side effects are the persisted run record and the locally-validated final
 * learning plan. Timeline events carry concise validated summaries only —
 * never chain-of-thought, raw prompts, or raw model output.
 */

/** The complete read-only tool whitelist (single source of truth). */
export const TutorToolNameSchema = z.enum([
  'inspect_learning_state',
  'inspect_concept',
  'inspect_canonical_aliases',
  'get_graph_neighborhood',
  'get_prerequisite_path',
  'search_source_blocks',
  'read_source_block',
  'inspect_open_mistakes',
  'inspect_misconceptions',
  'inspect_review_queue',
]);
export type TutorToolName = z.infer<typeof TutorToolNameSchema>;

export const TUTOR_TOOL_NAMES = TutorToolNameSchema.options;

/** Explicit, tested Tutor loop budgets. */
export const TUTOR_LIMITS = {
  /** Maximum planning iterations (model turns). */
  maxIterations: 6,
  /** Maximum executed tool calls per run. */
  maxToolCalls: 12,
  /** Maximum target concepts of the final plan. */
  maxTargetConcepts: 3,
  /** Maximum source blocks returned per search call. */
  maxBlocksPerSearch: 8,
  /** Maximum evidence records retained across a run. */
  maxRetainedEvidence: 20,
  /** Maximum characters of any single tool observation payload. */
  maxObservationChars: 6000,
} as const;

export const TutorRunStatusSchema = z.enum([
  'running',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
]);
export type TutorRunStatus = z.infer<typeof TutorRunStatusSchema>;

/** Safe timeline event kinds (rendered directly by the UI). */
export const TutorEventKindSchema = z.enum([
  'session_started',
  'state_inspected',
  'neighborhood_inspected',
  'tool_requested',
  'tool_validated',
  'tool_rejected',
  'evidence_accepted',
  'evidence_rejected',
  'gap_identified',
  'misconception_inspected',
  'strategy_selected',
  'activity_adjusted',
  'plan_accepted',
  'session_cancelled',
  'session_failed',
  'session_completed',
]);
export type TutorEventKind = z.infer<typeof TutorEventKindSchema>;

/**
 * One persisted timeline event. `summary` is a concise, locally-composed
 * Chinese sentence safe to display; `detail` carries small structured facts
 * (tool name, counts, concept ids) — never raw model output.
 */
export const TutorEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  kind: TutorEventKindSchema,
  summary: z.string().min(1).max(300),
  detail: z
    .object({
      toolName: TutorToolNameSchema.optional(),
      conceptIds: z.array(z.string()).max(10).optional(),
      evidenceCount: z.number().int().nonnegative().optional(),
      resultCount: z.number().int().nonnegative().optional(),
      iteration: z.number().int().nonnegative().optional(),
      valid: z.boolean().optional(),
      /** activity_adjusted: the mode the model originally recommended. */
      originalMode: z.string().max(40).optional(),
      /** activity_adjusted: the deterministically substituted mode. */
      adjustedMode: z.string().max(40).optional(),
    })
    .optional(),
  createdAt: z.string().datetime(),
});
export type TutorEvent = z.infer<typeof TutorEventSchema>;

/** The activity a completed Tutor run recommends launching. */
export const TutorActivitySchema = z.object({
  mode: AssessmentModeSchema,
  conceptIds: z.array(z.string().min(1)).min(1).max(3),
  /**
   * Concrete misconception bound to a misconception_check activity. Resolved
   * and validated server-side at finalize time; older runs without it remain
   * valid history and are re-resolved at launch time.
   */
  misconceptionId: z.string().min(1).optional(),
});
export type TutorActivity = z.infer<typeof TutorActivitySchema>;

/** A persisted Tutor run. */
export const TutorRunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Selected source concept the session focuses on. */
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  status: TutorRunStatusSchema,
  iterations: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  /** Server-verified evidence accepted during the run (bounded). */
  acceptedEvidence: z.array(VerifiedGroundingSchema).max(TUTOR_LIMITS.maxRetainedEvidence),
  /** Remediation plan persisted by a completed run (existing plan pipeline). */
  planId: z.string().nullable(),
  /** Recommended follow-up activity of a completed run. */
  activity: TutorActivitySchema.nullable(),
  errorMessage: z.string().max(500).nullable(),
  provider: z.string().min(1).max(40),
  providerModel: z.string().max(120).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TutorRun = z.infer<typeof TutorRunSchema>;
