import { describe, expect, it } from 'vitest';
import { buildPlanningRecommendations } from './planningRecommendations.js';
import type { Curriculum, LearningContract, StudyPlanFeasibility } from '@hy3-clinic/shared';

const contract = {
  desiredDepth: 'working_fluency',
} as LearningContract;
const curriculum = {
  nodes: [
    {
      id: 'required-unit',
      index: 0,
      kind: 'learning_unit',
      learningUnit: { objectives: [{ id: 'required', priority: 'required' }] },
    },
    {
      id: 'optional-unit',
      index: 1,
      kind: 'learning_unit',
      learningUnit: { objectives: [{ id: 'optional', priority: 'optional' }] },
    },
  ],
} as unknown as Curriculum;

describe('planning recommendations', () => {
  it('keeps complete scope first and only names optional content as deferrable', () => {
    const feasibility = {
      projectedMinutes: 300,
      availableMinutes: 120,
      slackMinutes: -180,
      state: 'at_risk',
      assumptions: [],
    } satisfies StudyPlanFeasibility;
    const recommendations = buildPlanningRecommendations(contract, curriculum, feasibility);
    expect(recommendations[0]?.kind).toBe('keep_full_scope');
    expect(
      recommendations.find((item) => item.kind === 'defer_optional_content')
        ?.affectedCurriculumLearningUnitIds,
    ).toEqual(['optional-unit']);
  });
});
