import { describe, expect, it } from 'vitest';
import { QuestionSchema } from './quiz.js';
import { AnswerSchema } from './grading.js';
import { MasteryStateSchema } from './mistake.js';
import { ApiErrorSchema } from './errors.js';

const baseGrounding = {
  blockId: 'b1',
  quote: '工作记忆',
  startOffset: 0,
  endOffset: 4,
  occurrenceCount: 1,
  reanchored: false,
};

const validSingleChoice = {
  id: 'q1',
  quizId: 'quiz1',
  index: 0,
  type: 'single_choice' as const,
  stem: '工作记忆的容量大约是多少?',
  options: [
    { id: 'A', text: '7±2 个组块' },
    { id: 'B', text: '无限' },
  ],
  correctOptionIds: ['A'],
  conceptId: 'c1',
  conceptName: '工作记忆',
  grounding: baseGrounding,
  explanation: '米勒定律指出短时记忆容量约为 7±2 个组块。',
  points: 1,
};

describe('QuestionSchema', () => {
  it('accepts a valid single_choice question', () => {
    expect(QuestionSchema.parse(validSingleChoice)).toBeTruthy();
  });

  it('rejects single_choice with more than one correct option', () => {
    const bad = { ...validSingleChoice, correctOptionIds: ['A', 'B'] };
    expect(QuestionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a correct option that is not in the options list', () => {
    const bad = { ...validSingleChoice, correctOptionIds: ['C'] };
    expect(QuestionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects choice question without options', () => {
    const { options: _options, ...rest } = validSingleChoice;
    void _options;
    expect(QuestionSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts a valid short_answer question with rubric', () => {
    const sa = {
      id: 'q2',
      quizId: 'quiz1',
      index: 1,
      type: 'short_answer' as const,
      stem: '简述工作记忆与长时记忆的区别。',
      expectedAnswer: '工作记忆容量有限、保持时间短;长时记忆容量大、可长期保存。',
      rubric: { keyPoints: ['容量差异', '保持时间差异'] },
      conceptId: 'c1',
      conceptName: '工作记忆',
      grounding: baseGrounding,
      explanation: '参考教材相关段落。',
      points: 2,
    };
    expect(QuestionSchema.parse(sa)).toBeTruthy();
  });

  it('rejects short_answer without a rubric', () => {
    const bad = {
      id: 'q3',
      quizId: 'quiz1',
      index: 2,
      type: 'short_answer' as const,
      stem: '简述工作记忆。',
      expectedAnswer: '容量有限。',
      conceptId: 'c1',
      conceptName: '工作记忆',
      grounding: baseGrounding,
      explanation: '...',
      points: 2,
    };
    expect(QuestionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('AnswerSchema', () => {
  it('accepts a choice answer with option ids', () => {
    expect(
      AnswerSchema.parse({ questionId: 'q1', type: 'single_choice', selectedOptionIds: ['A'] }),
    ).toBeTruthy();
  });

  it('rejects a choice answer that carries free text', () => {
    const bad = { questionId: 'q1', type: 'single_choice', text: 'hello' };
    expect(AnswerSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a short_answer answer with text', () => {
    expect(
      AnswerSchema.parse({ questionId: 'q2', type: 'short_answer', text: '我的回答' }),
    ).toBeTruthy();
  });
});

describe('MasteryStateSchema', () => {
  it('rejects mastery outside [0, 1]', () => {
    const bad = {
      materialId: 'm1',
      conceptId: 'c1',
      conceptName: '工作记忆',
      mastery: 1.5,
      attempts: 1,
      correctCount: 1,
      lastScore: 1,
      updatedAt: new Date(0).toISOString(),
    };
    expect(MasteryStateSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ApiErrorSchema', () => {
  it('accepts a structured error', () => {
    expect(
      ApiErrorSchema.parse({ error: { code: 'NOT_FOUND', message: '未找到资源' } }),
    ).toBeTruthy();
  });

  it('rejects an unknown error code', () => {
    expect(ApiErrorSchema.safeParse({ error: { code: 'WAT', message: 'x' } }).success).toBe(false);
  });
});
