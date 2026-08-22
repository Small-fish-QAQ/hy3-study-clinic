import { describe, expect, it } from 'vitest';
import { StudyPlanSchema } from '@hy3-clinic/shared';
import { createAdaptivePaceService } from './adaptivePace.js';

const plan = StudyPlanSchema.parse({
  id: 'plan_1',
  workspaceId: 'ws_1',
  contractVersionId: 'contract_1',
  curriculumVersionId: 'curriculum_1',
  executionSourceManifestFingerprint: 'manifest_1',
  version: 1,
  predecessorId: null,
  proposalTrigger: 'initial',
  status: 'accepted',
  rationale: 'Full route.',
  items: [
    {
      id: 'item_1',
      index: 0,
      phase: 'Core',
      kind: 'teach_unit',
      curriculumLearningUnitId: 'unit_1',
      rationale: 'Teach.',
      estimatedMinutes: 30,
      targetDepth: 'working_fluency',
      objectiveIds: ['objective_1'],
      prerequisitePlanItemIds: [],
      completionPolicy: null,
      completionRequirements: [],
    },
  ],
  deferrals: [],
  feasibility: {
    projectedMinutes: 30,
    availableMinutes: 120,
    slackMinutes: 90,
    state: 'feasible',
    assumptions: [],
  },
  paceBaseline: {
    id: 'pace_1',
    policyVersion: 'pace-baseline-v1',
    contractVersionId: 'contract_1',
    studyPlanVersionId: 'plan_1',
    timeZone: 'UTC',
    expectedSessionCadencePerWeek: 4,
    explicitSlackMinutes: 90,
    estimateConfidence: 'medium',
    estimateSource: 'local',
    milestones: [],
  },
  diff: [],
  provider: 'fake',
  providerModel: null,
  learnerAcceptedAt: '2026-08-10T00:00:00.000Z',
  createdAt: '2026-08-10T00:00:00.000Z',
});

describe('adaptive pace service', () => {
  it('persists only explicit active-time observations and reports low-confidence pace early', () => {
    const stored: unknown[] = [];
    const repos = {
      studyPlans: { get: (id: string) => (id === plan.id ? plan : undefined) },
      paceObservations: {
        create: (observation: unknown) => {
          stored.push(observation);
          return observation;
        },
        listForPlan: () => stored,
      },
    } as never;
    const service = createAdaptivePaceService({
      repos,
      clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
    });
    const observation = service.recordRequest({
      command: {
        commandId: 'cmd_1',
        idempotencyKey: 'key_1',
        workspaceId: 'ws_1',
        actor: 'learner',
      },
      studyPlanId: plan.id,
      planItemId: 'item_1',
      plannedMinutes: 30,
      actualMinutes: 35,
      source: 'study_session',
    });
    expect(observation.activeTimeMeasured).toBe(true);
    expect(stored).toHaveLength(1);
    expect(service.estimate(plan, 100)).toMatchObject({
      confidence: 'unknown',
      shouldReplan: false,
    });
  });
});
