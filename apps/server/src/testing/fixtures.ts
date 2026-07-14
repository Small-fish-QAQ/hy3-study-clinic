import type {
  Concept,
  Material,
  MistakeRecord,
  Question,
  Quiz,
  SourceBlock,
  VerifiedGrounding,
} from '@hy3-clinic/shared';

/** Deterministic domain-object builders shared by server tests. */

export const T0 = '2026-01-01T00:00:00.000Z';

export function makeGrounding(overrides: Partial<VerifiedGrounding> = {}): VerifiedGrounding {
  return {
    blockId: 'blk_1',
    quote: '工作记忆的容量十分有限。',
    startOffset: 0,
    endOffset: 12,
    occurrenceCount: 1,
    reanchored: false,
    ...overrides,
  };
}

export function makeMaterial(overrides: Partial<Material> = {}): Material {
  return {
    id: 'mat_1',
    title: '认知科学入门:记忆与学习',
    sourceType: 'paste',
    content: '# 记忆的类型\n\n工作记忆的容量十分有限。',
    charCount: 20,
    createdAt: T0,
    ...overrides,
  };
}

export function makeBlock(overrides: Partial<SourceBlock> = {}): SourceBlock {
  return {
    id: 'blk_1',
    materialId: 'mat_1',
    index: 0,
    heading: '记忆的类型',
    headingPath: ['记忆的类型'],
    content: '工作记忆的容量十分有限。',
    startOffset: 9,
    endOffset: 21,
    ...overrides,
  };
}

export function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: 'con_1',
    materialId: 'mat_1',
    name: '工作记忆',
    summary: '工作记忆是容量有限的短时信息加工系统。',
    importance: 'high',
    grounding: makeGrounding(),
    createdAt: T0,
    ...overrides,
  };
}

export function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'que_1',
    quizId: 'qz_1',
    index: 0,
    type: 'single_choice',
    stem: '根据资料,工作记忆的容量特点是?',
    options: [
      { id: 'A', text: '十分有限' },
      { id: 'B', text: '无限大' },
      { id: 'C', text: '与长时记忆相同' },
    ],
    correctOptionIds: ['A'],
    conceptId: 'con_1',
    conceptName: '工作记忆',
    grounding: makeGrounding(),
    explanation: '资料明确指出工作记忆的容量十分有限。',
    points: 1,
    ...overrides,
  } as Question;
}

export function makeQuiz(overrides: Partial<Quiz> = {}): Quiz {
  return {
    id: 'qz_1',
    materialId: 'mat_1',
    kind: 'standard',
    config: { difficulty: 'medium', types: ['single_choice'], countPerType: 1 },
    questions: [makeQuestion()],
    createdAt: T0,
    ...overrides,
  };
}

export function makeMistake(overrides: Partial<MistakeRecord> = {}): MistakeRecord {
  return {
    id: 'mis_1',
    materialId: 'mat_1',
    quizId: 'qz_1',
    questionId: 'que_1',
    conceptId: 'con_1',
    conceptName: '工作记忆',
    question: makeQuestion(),
    userAnswer: { questionId: 'que_1', type: 'single_choice', selectedOptionIds: ['B'] },
    score: 0,
    feedback: '正确答案是 A。',
    status: 'open',
    remediationCount: 0,
    createdAt: T0,
    resolvedAt: null,
    ...overrides,
  };
}
