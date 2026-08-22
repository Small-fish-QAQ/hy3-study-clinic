import {
  estimateAdaptivePace,
  PaceObservationSchema,
  PaceEstimateResponseSchema,
  RecordPaceObservationRequestSchema,
  type PaceEstimate,
  type PaceObservation,
  type StudyPlan,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import { notFound } from '../errors.js';
import { newId } from '../util/ids.js';
import type { Clock } from '../util/ids.js';

interface AdaptivePaceDeps {
  repos: Repositories;
  clock: Clock;
}

/** Planning-only pace evidence. It cannot write mastery, mistakes, or state. */
export function createAdaptivePaceService({ repos, clock }: AdaptivePaceDeps) {
  function record(
    workspaceId: string,
    plan: StudyPlan,
    input: Omit<PaceObservation, 'id' | 'measuredAt'> & { measuredAt?: string },
  ): PaceObservation {
    if (plan.workspaceId !== workspaceId) throw new Error('StudyPlan belongs to another Course.');
    const item = plan.items.find((candidate) => candidate.id === input.planItemId);
    if (!item) throw new Error('Pace observation references an unknown StudyPlan item.');
    const observation = PaceObservationSchema.parse({
      ...input,
      id: newId('pace_observation'),
      measuredAt: input.measuredAt ?? clock.now().toISOString(),
    });
    return repos.paceObservations.create(observation, workspaceId, plan.id);
  }

  function estimate(plan: StudyPlan, remainingEstimatedMinutes: number | null): PaceEstimate {
    return estimateAdaptivePace(
      repos.paceObservations.listForPlan(plan.id),
      remainingEstimatedMinutes,
    );
  }

  function recordRequest(input: unknown): PaceObservation {
    const parsed = RecordPaceObservationRequestSchema.parse(input);
    const plan = repos.studyPlans.get(parsed.studyPlanId);
    if (!plan || plan.workspaceId !== parsed.command.workspaceId) {
      throw notFound('StudyPlan not found for pace observation.');
    }
    return record(parsed.command.workspaceId, plan, {
      planItemId: parsed.planItemId,
      plannedMinutes: parsed.plannedMinutes,
      actualMinutes: parsed.actualMinutes,
      source: parsed.source,
      measuredAt: parsed.measuredAt,
      activeTimeMeasured: true,
    });
  }

  function response(
    workspaceId: string,
    studyPlanId: string,
    remainingEstimatedMinutes: number | null,
  ) {
    const plan = repos.studyPlans.get(studyPlanId);
    if (!plan || plan.workspaceId !== workspaceId) throw notFound('StudyPlan not found.');
    return PaceEstimateResponseSchema.parse({
      studyPlanId,
      estimate: estimate(plan, remainingEstimatedMinutes),
      observations: repos.paceObservations.listForPlan(plan.id),
    });
  }

  function shouldReplan(plan: StudyPlan, remainingEstimatedMinutes: number | null): boolean {
    return estimate(plan, remainingEstimatedMinutes).shouldReplan;
  }

  return { record, recordRequest, estimate, response, shouldReplan };
}

export type AdaptivePaceService = ReturnType<typeof createAdaptivePaceService>;
