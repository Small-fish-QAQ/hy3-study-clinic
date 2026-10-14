import { describe, expect, it } from 'vitest';
import { questionReviewWire } from './questionReviewWire.js';
import type { RubricReviewInput } from './courseContract.js';
import { solutionSchemaFor } from './courseContract.js';

describe('Question review transport identities', () => {
  it('没有请求考核cell时由服务器清空无效标注，真实Formal仍严格校验', () => {
    const candidate = {
      solvable: false,
      answer: ['两种方向'],
      explanation: '两次到达',
      missingConditions: [],
      ambiguities: ['方向不唯一'],
      sourceSupported: true,
      uncertain: false,
      exposureCheck: { novel: true, reason: '新题' },
      assessedKnowledgeIds: ['k'],
      coverage: [
        {
          cellId: '',
          criterionIds: ['answer'],
          assessedKnowledgeIds: ['k'],
          representativeSetIds: [],
          demand: 'apply',
        },
      ],
    };
    const normalized = solutionSchemaFor({ expectedCells: [] }).parse(candidate);
    expect(normalized).toEqual({ ...candidate, coverage: [] });
    expect(
      solutionSchemaFor({
        expectedCells: [{} as RubricReviewInput['expectedCells'][number]],
      }).safeParse(candidate).success,
    ).toBe(false);
    expect(
      solutionSchemaFor({ expectedCells: [] }).safeParse({ ...candidate, explanation: '' }).success,
    ).toBe(false);
  });
  it('aliases requested knowledge and objectives everywhere structurally, restores exact IDs and leaves prose/unknown references unchanged', () => {
    const k = 'knowledge_5079c17479c484a70367be3e082310a9';
    const input = {
      question: {
        id: 'q',
        type: 'short_answer',
        prompt: `K0 is ordinary prose; ${k}`,
        options: [],
      },
      requestedKnowledge: [{ id: k, statement: 'literal K0', relatedKnowledgeIds: [k] }],
      expectedObjectives: [{ id: 'objective_long', knowledgeIds: [k] }],
      rubric: [{ id: 'r', knowledgeIds: [k] }],
      independentSolution: {
        assessedKnowledgeIds: [k],
        assessedObjectiveIds: ['objective_long'],
        coverage: [{ assessedKnowledgeIds: [k], objectiveIds: ['objective_long'] }],
      },
    } as unknown as RubricReviewInput;
    const wire = questionReviewWire(input);
    expect(wire.materialize(wire.input)).toEqual(input);
    expect(JSON.stringify(wire.input)).toContain('"assessedKnowledgeIds":["K0"]');
    expect(JSON.stringify(wire.input)).toContain('"objectiveIds":["O0"]');
    const restored = wire.materialize({
      criterionId: 'r',
      assessedKnowledgeIds: ['K0', 'unknown'],
      reason: 'K0 is a reference in prose',
    });
    expect(restored).toEqual({
      criterionId: 'r',
      assessedKnowledgeIds: [k, 'unknown'],
      reason: 'K0 is a reference in prose',
    });
  });
});
