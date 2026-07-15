import { describe, expect, it } from 'vitest';
import type { Concept, ProposedQuestion, SourceBlock } from '@hy3-clinic/shared';
import { assembleQuestions } from './quizzes.js';

const block: SourceBlock = {
  id: 'blk_1',
  materialId: 'mat_1',
  index: 0,
  heading: '记忆',
  headingPath: ['记忆'],
  content: '工作记忆容量有限。长时记忆可以长期保存。',
  startOffset: 0,
  endOffset: 21,
};

const concepts: Concept[] = [
  {
    id: 'con_allowed',
    materialId: 'mat_1',
    name: '工作记忆',
    summary: '容量有限',
    importance: 'high',
    grounding: {
      blockId: block.id,
      quote: '工作记忆容量有限。',
      startOffset: 0,
      endOffset: 9,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: new Date(0).toISOString(),
  },
  {
    id: 'con_other',
    materialId: 'mat_1',
    name: '长时记忆',
    summary: '长期保存',
    importance: 'medium',
    grounding: {
      blockId: block.id,
      quote: '长时记忆可以长期保存。',
      startOffset: 9,
      endOffset: 21,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: new Date(0).toISOString(),
  },
];

function proposed(overrides: Partial<ProposedQuestion> = {}): ProposedQuestion {
  return {
    type: 'single_choice',
    stem: '工作记忆的特点是什么?',
    options: [
      { id: 'A', text: '容量有限' },
      { id: 'B', text: '容量无限' },
    ],
    correctOptionIds: ['A'],
    conceptId: 'con_allowed',
    blockId: block.id,
    quote: '工作记忆容量有限。',
    explanation: '依据原文。',
    ...overrides,
  } as ProposedQuestion;
}

describe('assembleQuestions constraints', () => {
  it('drops provider questions outside the requested type or target concepts', () => {
    const result = assembleQuestions(
      [
        proposed(),
        proposed({
          type: 'multiple_choice',
          correctOptionIds: ['A'],
          stem: '未请求的题型',
        }),
        proposed({
          conceptId: 'con_other',
          quote: '长时记忆可以长期保存。',
          stem: '非目标概念',
        }),
      ],
      {
        quizId: 'qz_1',
        blocks: [block],
        concepts,
        allowedTypes: ['single_choice'],
        allowedConceptIds: ['con_allowed'],
      },
    );

    expect(result.questions).toHaveLength(1);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      '未请求的题型:multiple_choice',
      '非目标概念:con_other',
    ]);
  });
});
