import { describe, expect, it } from 'vitest';
import { QuestionSchema, RubricSchema } from './quiz.js';
import { ProposedQuestionSchema } from '../provider/payloads.js';
import { AnswerSchema, classifyGradeStatus, RubricGradeSchema } from './grading.js';
import { MasteryStateSchema } from './mistake.js';
import { ApiErrorSchema } from './errors.js';
import { MATERIAL_TITLE_MAX_LENGTH, UpdateMaterialTitleRequestSchema } from './material.js';

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

  it('rejects duplicate correct option ids', () => {
    const bad = { ...validSingleChoice, correctOptionIds: ['A', 'A'] };
    expect(QuestionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects choice questions carrying short-answer fields', () => {
    const bad = {
      ...validSingleChoice,
      expectedAnswer: '不应出现',
      rubric: { keyPoints: ['不应出现'] },
    };
    expect(QuestionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects short-answer questions carrying choice fields', () => {
    const bad = {
      id: 'q4',
      quizId: 'quiz1',
      index: 3,
      type: 'short_answer' as const,
      stem: '简述工作记忆。',
      options: validSingleChoice.options,
      correctOptionIds: ['A'],
      expectedAnswer: '容量有限。',
      rubric: { keyPoints: ['容量有限'] },
      conceptId: 'c1',
      conceptName: '工作记忆',
      grounding: baseGrounding,
      explanation: '...',
      points: 2,
    };
    expect(QuestionSchema.safeParse(bad).success).toBe(false);
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

describe('RubricSchema back-compat and required/optional model', () => {
  it('loads legacy string key points as required points', () => {
    const rubric = RubricSchema.parse({ keyPoints: ['容量有限', '约四个组块'] });
    expect(rubric.keyPoints).toEqual([
      { text: '容量有限', required: true },
      { text: '约四个组块', required: true },
    ]);
  });

  it('accepts the new typed form and preserves optional flags', () => {
    const rubric = RubricSchema.parse({
      keyPoints: [
        { text: '每 N 字符切', required: true },
        { text: '快但易切断语义', required: false },
      ],
    });
    expect(rubric.keyPoints[1]).toEqual({ text: '快但易切断语义', required: false });
  });

  it('accepts mixed legacy and typed points', () => {
    const rubric = RubricSchema.parse({
      keyPoints: ['容量有限', { text: '补充说明', required: false }],
    });
    expect(rubric.keyPoints).toEqual([
      { text: '容量有限', required: true },
      { text: '补充说明', required: false },
    ]);
  });

  it('promotes an all-optional rubric to required (zero required weight is unusable)', () => {
    const rubric = RubricSchema.parse({
      keyPoints: [
        { text: 'a要点', required: false },
        { text: 'b要点', required: false },
      ],
    });
    expect(rubric.keyPoints.every((p) => p.required)).toBe(true);
  });
});

describe('RubricGradeSchema', () => {
  const base = { matchedKeyPointIndexes: [0], score: 0.8, confidence: 0.9, feedback: '不错。' };

  it('accepts a legacy grade without partialKeyPointIndexes', () => {
    expect(RubricGradeSchema.parse(base).partialKeyPointIndexes).toBeUndefined();
  });

  it('accepts partial coverage indexes', () => {
    expect(
      RubricGradeSchema.parse({ ...base, partialKeyPointIndexes: [1] }).partialKeyPointIndexes,
    ).toEqual([1]);
  });
});

describe('classifyGradeStatus', () => {
  it('keeps choice questions binary', () => {
    expect(classifyGradeStatus({ type: 'single_choice', correct: true, normalizedScore: 1 })).toBe(
      'correct',
    );
    expect(classifyGradeStatus({ type: 'single_choice', correct: false, normalizedScore: 0 })).toBe(
      'insufficient',
    );
  });

  it('classifies short answers from required coverage', () => {
    const sa = (normalizedScore: number) =>
      classifyGradeStatus({
        type: 'short_answer',
        correct: normalizedScore >= 0.6,
        normalizedScore,
      });
    expect(sa(1)).toBe('correct');
    expect(sa(1 / 3 + 2 / 3)).toBe('correct'); // float accumulation still full
    expect(sa(0.75)).toBe('mostly_correct');
    expect(sa(0.67)).toBe('mostly_correct');
    expect(sa(0.5)).toBe('partial');
    expect(sa(0.25)).toBe('partial');
    expect(sa(0)).toBe('insufficient');
  });

  it('a materially partial score is never labelled fully correct', () => {
    expect(
      classifyGradeStatus({ type: 'short_answer', correct: true, normalizedScore: 0.67 }),
    ).not.toBe('correct');
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

describe('ProposedQuestionSchema', () => {
  const base = {
    stem: '工作记忆容量如何?',
    conceptId: 'c1',
    blockId: 'b1',
    quote: '工作记忆',
    explanation: '依据原文。',
  };

  it('rejects duplicate proposed correct option ids', () => {
    const bad = {
      ...base,
      type: 'multiple_choice' as const,
      options: validSingleChoice.options,
      correctOptionIds: ['A', 'A'],
    };
    expect(ProposedQuestionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects proposed choice questions carrying short-answer fields', () => {
    const bad = {
      ...base,
      type: 'single_choice' as const,
      options: validSingleChoice.options,
      correctOptionIds: ['A'],
      expectedAnswer: '不应出现',
      rubricKeyPoints: ['不应出现'],
    };
    expect(ProposedQuestionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects proposed short answers carrying choice fields', () => {
    const bad = {
      ...base,
      type: 'short_answer' as const,
      options: validSingleChoice.options,
      correctOptionIds: ['A'],
      expectedAnswer: '容量有限。',
      rubricKeyPoints: ['容量有限'],
    };
    expect(ProposedQuestionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ProposedQuestionSchema provider normalization', () => {
  const common = {
    stem: '工作记忆的容量如何?',
    conceptId: 'con_1',
    blockId: 'blk_1',
    quote: '工作记忆容量有限。',
    explanation: '依据原文判断。',
  };

  it('canonicalizes unique loose choice ids and removes empty short-answer placeholders', () => {
    const parsed = ProposedQuestionSchema.parse({
      ...common,
      type: 'single_choice',
      options: [
        { id: '1', text: '有限' },
        { id: '2', text: '无限' },
      ],
      correctOptionIds: ['1'],
      expectedAnswer: '',
      rubricKeyPoints: [],
    });

    expect(parsed.options?.map((option) => option.id)).toEqual(['A', 'B']);
    expect(parsed.correctOptionIds).toEqual(['A']);
    expect(parsed.expectedAnswer).toBeUndefined();
    expect(parsed.rubricKeyPoints).toBeUndefined();
  });

  it('removes empty choice placeholders from a short-answer question', () => {
    const parsed = ProposedQuestionSchema.parse({
      ...common,
      type: 'short_answer',
      options: [],
      correctOptionIds: [],
      expectedAnswer: '工作记忆容量有限。',
      rubricKeyPoints: ['指出容量有限'],
    });

    expect(parsed.options).toBeUndefined();
    expect(parsed.correctOptionIds).toBeUndefined();
  });
});

describe('UpdateMaterialTitleRequestSchema', () => {
  it('trims a non-empty title', () => {
    expect(UpdateMaterialTitleRequestSchema.parse({ title: '  新标题  ' })).toEqual({
      title: '新标题',
    });
  });

  it('rejects blank and overlong titles', () => {
    expect(UpdateMaterialTitleRequestSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(
      UpdateMaterialTitleRequestSchema.safeParse({
        title: 'x'.repeat(MATERIAL_TITLE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unexpected fields', () => {
    expect(
      UpdateMaterialTitleRequestSchema.safeParse({ title: '新标题', content: '不允许修改' })
        .success,
    ).toBe(false);
  });
});
