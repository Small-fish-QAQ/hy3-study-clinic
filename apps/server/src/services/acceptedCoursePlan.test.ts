import { describe, expect, it } from 'vitest';
import { deriveAcceptedCoursePlan } from './acceptedCoursePlan.js';
import type { StudyPlanProposalInput } from '../llm/provider.js';

function input(): StudyPlanProposalInput {
  return {
    contract: { desiredDepth: 'deep_transfer' },
    requiredLearningUnitIds: ['dependent', 'prerequisite', 'independent'],
    units: [
      {
        id: 'dependent',
        title: 'Dependent unit',
        objectiveIds: ['obj2', 'obj3'],
        prerequisiteUnitIds: ['prerequisite'],
      },
      {
        id: 'prerequisite',
        title: 'Prerequisite unit',
        objectiveIds: ['obj1'],
        prerequisiteUnitIds: [],
      },
      {
        id: 'independent',
        title: 'Independent unit',
        objectiveIds: ['obj4'],
        prerequisiteUnitIds: [],
      },
    ],
    launchCapabilities: ['dependent', 'prerequisite', 'independent'].map((id) => ({
      curriculumLearningUnitId: id,
      allowedItemKinds: ['teach_unit'],
      launchableAssessmentModes: [],
    })),
  } as StudyPlanProposalInput;
}
describe('accepted course route compilation', () => {
  it('splits a broad Unit into bounded Lessons and gates its dependent on the final part', () => {
    const context = input();
    context.units[1]!.objectiveIds = ['p1', 'p2', 'p3', 'p4'];
    const result = deriveAcceptedCoursePlan(context);
    expect(result.items.map((item) => item.objectiveIds)).toEqual([
      ['p1', 'p2'],
      ['p3', 'p4'],
      ['obj2', 'obj3'],
      ['obj4'],
    ]);
    expect(result.items[1]!.prerequisiteItemKeys).toEqual([result.items[0]!.key]);
    expect(result.items[2]!.prerequisiteItemKeys).toEqual([result.items[1]!.key]);
    expect(result.items.every((item) => item.targetDepth === 'deep_transfer')).toBe(true);
  });
  it('preserves every accepted objective and Depth while respecting prerequisite order', () => {
    const plan = deriveAcceptedCoursePlan(input());
    expect(plan.items.map((item) => item.curriculumLearningUnitId)).toEqual([
      'prerequisite',
      'dependent',
      'independent',
    ]);
    expect(plan.items.flatMap((item) => item.objectiveIds)).toEqual([
      'obj1',
      'obj2',
      'obj3',
      'obj4',
    ]);
    expect(plan.items[1]!.prerequisiteItemKeys).toEqual([plan.items[0]!.key]);
    expect(
      plan.items.every(
        (item) => item.targetDepth === 'deep_transfer' && item.kind === 'teach_unit',
      ),
    ).toBe(true);
    expect(plan.deferrals).toEqual([]);
  });
  it.each(['missing', 'cycle', 'unlaunchable'])(
    'refuses %s dependencies without proposing a reduced route',
    (kind) => {
      const context = input();
      if (kind === 'missing') context.units[0]!.prerequisiteUnitIds = ['foreign'];
      if (kind === 'cycle') context.units[1]!.prerequisiteUnitIds = ['dependent'];
      if (kind === 'unlaunchable')
        context.launchCapabilities[0]!.allowedItemKinds = ['formal_checkpoint'];
      expect(() => deriveAcceptedCoursePlan(context)).toThrow();
    },
  );
});
