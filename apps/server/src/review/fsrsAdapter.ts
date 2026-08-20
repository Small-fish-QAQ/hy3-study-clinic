import { createHash } from 'node:crypto';
import { createEmptyCard, fsrs, type CardInput, type StateType } from 'ts-fsrs';
import {
  REVIEW_ADAPTER_VERSION,
  REVIEW_ALGORITHM_GENERATION,
  REVIEW_MAX_DUE_HORIZON_DAYS,
  REVIEW_PACKAGE_NAME,
  REVIEW_PACKAGE_VERSION,
  REVIEW_POLICY_VERSION,
  REVIEW_RATING_POLICY_VERSION,
  SchedulerConfigurationSchema,
  MemoryScheduleStateSchema,
  ScheduledMemoryScheduleStateSchema,
  type MemoryScheduleState,
  type ScheduledMemoryScheduleState,
  type SchedulerConfiguration,
} from '@hy3-clinic/shared';

const WEIGHTS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
] as const;
const DAY = 86_400_000;
export const CONFIG_HASH = createHash('sha256')
  .update(
    JSON.stringify({
      request_retention: 0.9,
      maximum_interval: 365,
      w: WEIGHTS,
      enable_fuzz: false,
      enable_short_term: false,
      learning_steps: [],
      relearning_steps: [],
    }),
  )
  .digest('hex');
export const DEFAULT_CONFIGURATION = SchedulerConfigurationSchema.parse({
  version: REVIEW_POLICY_VERSION,
  algorithmGeneration: REVIEW_ALGORITHM_GENERATION,
  packageName: REVIEW_PACKAGE_NAME,
  packageVersion: REVIEW_PACKAGE_VERSION,
  localAdapterVersion: REVIEW_ADAPTER_VERSION,
  ratingPolicyVersion: REVIEW_RATING_POLICY_VERSION,
  requestedRetention: 0.9,
  configHash: CONFIG_HASH,
  fuzz: false,
  shortTerm: false,
  maximumDueHorizonDays: 365,
  effectiveAt: '2026-01-01T00:00:00.000Z',
  retiredAt: null,
});
function finite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid scheduler ${name}.`);
  return value;
}
function date(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid scheduler timestamp.');
  return d;
}
export type AdapterOutcome = 'Again' | 'Good';
export interface AdapterInput {
  state: ScheduledMemoryScheduleState | null;
  outcome: AdapterOutcome;
  reviewTime: Date;
  configuration?: SchedulerConfiguration;
}
export interface AdapterResult {
  state: Omit<
    ScheduledMemoryScheduleState,
    'reviewTargetId' | 'policyVersion' | 'rowVersion' | 'createdAt' | 'updatedAt'
  >;
  rawDueAt: string;
}
export function scheduleWithFsrs(input: AdapterInput): AdapterResult {
  const config = SchedulerConfigurationSchema.parse(input.configuration ?? DEFAULT_CONFIGURATION);
  const now = input.reviewTime;
  if (Number.isNaN(now.getTime())) throw new Error('Invalid scheduler timestamp.');
  const engine = fsrs({
    request_retention: 0.9,
    maximum_interval: 365,
    w: [...WEIGHTS],
    enable_fuzz: false,
    enable_short_term: false,
    learning_steps: [],
    relearning_steps: [],
  });
  const card: CardInput = input.state
    ? {
        due: date(input.state.dueAt),
        stability: finite(input.state.stability, 'stability'),
        difficulty: finite(input.state.difficulty, 'difficulty'),
        elapsed_days: 0,
        scheduled_days: finite(input.state.scheduledDays, 'scheduledDays'),
        learning_steps: 0,
        reps: input.state.repetitions,
        lapses: input.state.lapses,
        state: 'Review' as StateType,
        last_review: input.state.lastReviewedAt,
      }
    : createEmptyCard(now);
  const result = engine.next(card, now, input.outcome === 'Again' ? 1 : 3);
  const hardDue = Math.min(
    result.card.due.getTime(),
    now.getTime() + REVIEW_MAX_DUE_HORIZON_DAYS * DAY,
  );
  const dueAt = new Date(hardDue).toISOString();
  const scheduledDays = Math.max(
    0,
    Math.min(REVIEW_MAX_DUE_HORIZON_DAYS, (hardDue - now.getTime()) / DAY),
  );
  const state = {
    lifecycleState: 'review' as const,
    dueAt,
    lastReviewedAt: now.toISOString(),
    stability: finite(result.card.stability, 'stability'),
    difficulty: Math.min(10, Math.max(1, finite(result.card.difficulty, 'difficulty'))),
    scheduledDays,
    repetitions: result.card.reps,
    lapses: result.card.lapses,
    lastReviewEventId: null,
  };
  MemoryScheduleStateSchema.parse({
    ...state,
    reviewTargetId: 'target',
    policyVersion: config.version,
    lastReviewEventId: null,
    rowVersion: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return { state, rawDueAt: result.card.due.toISOString() };
}
export function replayFsrs(
  events: Array<{ outcome: AdapterOutcome; occurredAt: string }>,
  targetId = 'replay',
): MemoryScheduleState {
  let state: ScheduledMemoryScheduleState | null = null;
  for (const event of events) {
    const at = date(event.occurredAt);
    const result = scheduleWithFsrs({ state, outcome: event.outcome, reviewTime: at });
    state = ScheduledMemoryScheduleStateSchema.parse({
      reviewTargetId: targetId,
      policyVersion: DEFAULT_CONFIGURATION.version,
      ...result.state,
      lastReviewEventId: null,
      rowVersion: (state?.rowVersion ?? 0) + 1,
      createdAt: state?.createdAt ?? at.toISOString(),
      updatedAt: at.toISOString(),
    });
  }
  if (!state) throw new Error('Cannot replay empty Review history.');
  return state;
}
