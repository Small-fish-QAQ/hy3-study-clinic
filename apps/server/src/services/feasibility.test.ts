import { describe, expect, it } from 'vitest';
import { LearningContractSchema, type LearningContract } from '@hy3-clinic/shared';
import { computeContractFeasibility } from './feasibility.js';

const NOW = new Date('2026-08-10T00:00:00.000Z');

function contract(overrides: Partial<LearningContract> = {}): LearningContract {
  return LearningContractSchema.parse({
    id: 'contract_1',
    workspaceId: 'workspace_1',
    version: 1,
    predecessorId: null,
    intent: 'Prepare for the course examination.',
    targetOutcome: { description: 'Score at least 90', targetScore: 90, credential: null },
    deadline: { at: '2026-08-17T00:00:00.000Z', timeZone: 'Asia/Shanghai' },
    studyBudget: {
      minutesPerDay: 120,
      minutesPerWeek: 700,
      preferredSessionMinutes: 60,
      unavailablePeriods: [],
    },
    desiredDepth: 'high_performance',
    courseScope: {
      subjectBoundaries: ['Probability'],
      materials: [],
      includedTopics: [],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: null,
    status: 'learner_confirmed',
    proposedBy: 'learner',
    learnerConfirmedAt: '2026-08-10T00:00:00.000Z',
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  });
}

describe('computeContractFeasibility', () => {
  it('uses the stricter local daily/weekly capacity and computes slack', () => {
    const result = computeContractFeasibility(contract(), 600, NOW);
    expect(result.availableMinutes).toBe(700);
    expect(result.slackMinutes).toBe(100);
    expect(result.state).toBe('feasible');
    expect(result.reasonCodes).toContain('sufficient_slack');
  });

  it('discloses an infeasible target without changing the Contract', () => {
    const source = contract();
    const result = computeContractFeasibility(source, 900, NOW);
    expect(result.state).toBe('infeasible');
    expect(result.reasonCodes).toContain('insufficient_time');
    expect(source.status).toBe('learner_confirmed');
  });

  it('returns unknown effort honestly and subtracts unavailable time', () => {
    const source = contract({
      studyBudget: {
        minutesPerDay: 120,
        minutesPerWeek: null,
        preferredSessionMinutes: 60,
        unavailablePeriods: [
          {
            startsAt: '2026-08-11T00:00:00.000Z',
            endsAt: '2026-08-13T00:00:00.000Z',
            reason: 'Travel',
          },
        ],
      },
    });
    const result = computeContractFeasibility(source, null, NOW);
    expect(result.state).toBe('unknown');
    expect(result.availableMinutes).toBe(600);
    expect(result.slackMinutes).toBeNull();
    expect(result.reasonCodes).toEqual(['unavailable_periods_reduce_capacity', 'effort_unknown']);
  });

  it('does not invent a bounded capacity without a deadline', () => {
    const result = computeContractFeasibility(contract({ deadline: null }), 300, NOW);
    expect(result.state).toBe('unknown');
    expect(result.availableMinutes).toBeNull();
    expect(result.reasonCodes).toEqual(['deadline_absent']);
  });

  it('marks an elapsed deadline without pretending time remains', () => {
    const result = computeContractFeasibility(
      contract({ deadline: { at: '2026-08-09T00:00:00.000Z', timeZone: 'Asia/Shanghai' } }),
      120,
      NOW,
    );
    expect(result.state).toBe('infeasible');
    expect(result.availableMinutes).toBe(0);
    expect(result.slackMinutes).toBe(-120);
    expect(result.reasonCodes).toEqual(['deadline_elapsed']);
  });
});
