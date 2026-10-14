import { describe, expect, it } from 'vitest';
import { lessonWire } from './lessonWire.js';
import type { LessonInput } from './courseContract.js';
describe('Lesson精确传输身份', () => {
  it('映射K/目标/来源身份并精确往返，不猜未知ID或改写正文', () => {
    const input = {
      knowledge: [
        {
          id: 'knowledge_long',
          statement: 'knowledge_long 是原文。',
          sourceSpans: [{ blockId: 'source_long', revisionId: 'revision_long', start: 1, end: 5 }],
        },
      ],
      lesson: { objectives: [{ id: 'objective_long', knowledgeIds: ['knowledge_long'] }] },
      sources: [
        {
          id: 'source_long',
          revisionId: 'revision_long',
          text: 'source_long 原文',
          start: 1,
          end: 5,
        },
      ],
    } as unknown as LessonInput;
    const wire = lessonWire(input);
    const sent = wire.input as typeof input;
    expect(sent.knowledge[0]!.id).toBe('K0');
    expect(sent.lesson.objectives[0]!.id).toBe('O0');
    expect(sent.sources[0]!.id).toBe('S0');
    expect(sent.sources[0]!.revisionId).toBe('R0');
    expect(wire.materialize(sent)).toEqual(input);
    const returned = wire.materialize({
      sourceRefs: [{ blockId: 'S0', revisionId: 'R0' }],
      teachingCoverage: [
        { knowledgeId: 'K0', objectiveIds: ['O0', 'O99'], teachingQuote: 'K0和S0原文' },
      ],
      text: 'K0 是正文，未知K99保持',
    });
    expect(returned.sourceRefs[0]).toEqual({ blockId: 'source_long', revisionId: 'revision_long' });
    expect(returned.teachingCoverage[0]).toEqual({
      knowledgeId: 'knowledge_long',
      objectiveIds: ['objective_long', 'O99'],
      teachingQuote: 'K0和S0原文',
    });
    expect(returned.text).toBe('K0 是正文，未知K99保持');
  });
});
