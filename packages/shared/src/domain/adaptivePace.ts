import { z } from 'zod';
import { CourseExecutionCommandEnvelopeSchema } from './learningContract.js';

/** Only explicitly measured active work may influence planning pace. */
export const PaceObservationSchema = z
  .object({
    id: z.string().min(1),
    planItemId: z.string().min(1),
    plannedMinutes: z.number().positive(),
    actualMinutes: z.number().positive(),
    source: z.enum(['study_session', 'formal_attempt', 'repair', 'review']),
    measuredAt: z.string().datetime(),
    activeTimeMeasured: z.literal(true),
  })
  .strict();
export type PaceObservation = z.infer<typeof PaceObservationSchema>;

export const PaceEstimateSchema = z
  .object({
    adjustment: z.number().min(0.5).max(2),
    confidence: z.enum(['unknown', 'low', 'medium', 'high']),
    observationCount: z.number().int().nonnegative(),
    actualMinutes: z.number().nonnegative(),
    plannedMinutes: z.number().nonnegative(),
    remainingMinutes: z.number().nonnegative().nullable(),
    meaningfulEvidence: z.boolean(),
    shouldReplan: z.boolean(),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type PaceEstimate = z.infer<typeof PaceEstimateSchema>;

export const RecordPaceObservationRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    studyPlanId: z.string().min(1),
    planItemId: z.string().min(1),
    plannedMinutes: z.number().positive(),
    actualMinutes: z.number().positive(),
    source: PaceObservationSchema.shape.source,
    measuredAt: z.string().datetime().optional(),
  })
  .strict();
export type RecordPaceObservationRequest = z.infer<typeof RecordPaceObservationRequestSchema>;

export const PaceEstimateResponseSchema = z
  .object({
    studyPlanId: z.string().min(1),
    estimate: PaceEstimateSchema,
    observations: z.array(PaceObservationSchema).max(500),
  })
  .strict();
export type PaceEstimateResponse = z.infer<typeof PaceEstimateResponseSchema>;

export const PaceObservationResponseSchema = z
  .object({ observation: PaceObservationSchema })
  .strict();
export type PaceObservationResponse = z.infer<typeof PaceObservationResponseSchema>;

const MIN_MEANINGFUL_MINUTES = 30;
const MIN_MEANINGFUL_OBSERVATIONS = 2;
const REPLAN_DIVERGENCE = 0.25;

/**
 * Computes a bounded effort multiplier. Browser idle time is excluded by the
 * observation contract, and insufficient evidence remains explicitly unknown.
 */
export function estimateAdaptivePace(
  observations: PaceObservation[],
  remainingEstimatedMinutes: number | null,
): PaceEstimate {
  const valid = observations.map((observation) => PaceObservationSchema.parse(observation));
  const plannedMinutes = valid.reduce((sum, observation) => sum + observation.plannedMinutes, 0);
  const actualMinutes = valid.reduce((sum, observation) => sum + observation.actualMinutes, 0);
  const meaningfulEvidence =
    valid.length >= MIN_MEANINGFUL_OBSERVATIONS && actualMinutes >= MIN_MEANINGFUL_MINUTES;
  if (!meaningfulEvidence || plannedMinutes <= 0) {
    return PaceEstimateSchema.parse({
      adjustment: 1,
      confidence: 'unknown',
      observationCount: valid.length,
      actualMinutes,
      plannedMinutes,
      remainingMinutes: remainingEstimatedMinutes,
      meaningfulEvidence: false,
      shouldReplan: false,
      reason: 'Not enough measured active study time to infer a pace change.',
    });
  }
  const raw = actualMinutes / plannedMinutes;
  const adjustment = Math.max(0.5, Math.min(2, raw));
  const divergence = Math.abs(adjustment - 1);
  const confidence =
    valid.length >= 5 && actualMinutes >= 120 ? 'high' : valid.length >= 3 ? 'medium' : 'low';
  return PaceEstimateSchema.parse({
    adjustment,
    confidence,
    observationCount: valid.length,
    actualMinutes,
    plannedMinutes,
    remainingMinutes:
      remainingEstimatedMinutes === null ? null : Math.ceil(remainingEstimatedMinutes * adjustment),
    meaningfulEvidence: true,
    shouldReplan: divergence >= REPLAN_DIVERGENCE,
    reason:
      divergence >= REPLAN_DIVERGENCE
        ? 'Measured active effort has materially diverged from the baseline.'
        : 'Measured active effort remains within the baseline range.',
  });
}
