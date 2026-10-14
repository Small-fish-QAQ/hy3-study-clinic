import { it, expect } from 'vitest';
import { planningWire } from './planningWire.js';
import type { PlanInput } from './courseContract.js';
it('规划短知识引用还原原ID，用户文字和自由课/目标ID保持不变', () => {
  const input = {
    title: '长知识ID只是引用',
    mode: 'complete',
    knowledge: [
      {
        id: 'opaque-original',
        title: '定义',
        statement: '条件与结论',
        kind: 'concept',
        origin: 'textbook',
        sourceSpans: [],
        prerequisiteKnowledgeIds: [],
        relatedKnowledgeIds: [],
        uncertaintyCodes: [],
      },
    ],
  } as PlanInput;
  const wire = planningWire(input);
  expect((wire.input as PlanInput).knowledge[0]!.id).toBe('K0');
  const result = wire.materialize({
    lessons: [
      {
        id: 'lesson_1',
        knowledgeIds: ['K0'],
        objectives: [{ id: 'o1', knowledgeIds: ['K0'], title: '解释K0的字符串标签' }],
      },
    ],
  });
  expect(result.lessons[0]).toEqual({
    id: 'lesson_1',
    knowledgeIds: ['opaque-original'],
    objectives: [{ id: 'o1', knowledgeIds: ['opaque-original'], title: '解释K0的字符串标签' }],
  });
});
