import type {
  Concept,
  GradingResult,
  MasteryState,
  MistakeRecord,
  PublicQuiz,
  Question,
  SourceBlock,
} from '@hy3-clinic/shared';

/** Deterministic web-test fixtures matching the shared schemas. */

export const T0 = '2026-01-01T00:00:00.000Z';

export const blocks: SourceBlock[] = [
  {
    id: 'blk_0',
    materialId: 'mat_1',
    index: 0,
    heading: '记忆的三种类型',
    headingPath: ['记忆的三种类型'],
    content: '工作记忆的容量十分有限,一般一次只能同时保持大约四个组块。',
    startOffset: 10,
    endOffset: 39,
  },
  {
    id: 'blk_1',
    materialId: 'mat_1',
    index: 1,
    heading: '间隔重复',
    headingPath: ['间隔重复'],
    content: '与其把复习集中在一次完成,不如把同样的时间分散到多次进行。',
    startOffset: 45,
    endOffset: 73,
  },
];

export const material = {
  material: {
    id: 'mat_1',
    title: '认知科学入门:记忆与学习',
    sourceType: 'md' as const,
    content: `# 认知科学入门\n\n${blocks[0]!.content}\n\n${blocks[1]!.content}`,
    charCount: 80,
    createdAt: T0,
  },
  blocks,
};

export const materialSummary = {
  id: material.material.id,
  title: material.material.title,
  sourceType: material.material.sourceType,
  charCount: material.material.charCount,
  blockCount: blocks.length,
  createdAt: material.material.createdAt,
};

export const concepts: Concept[] = [
  {
    id: 'con_0',
    materialId: 'mat_1',
    name: '工作记忆',
    summary: '容量有限的短时加工系统。',
    importance: 'high',
    grounding: {
      blockId: 'blk_0',
      quote: '工作记忆的容量十分有限',
      startOffset: 0,
      endOffset: 11,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: T0,
  },
];

export const quiz: PublicQuiz = {
  id: 'qz_1',
  materialId: 'mat_1',
  kind: 'standard',
  config: { difficulty: 'medium', types: ['single_choice', 'short_answer'], countPerType: 1 },
  createdAt: T0,
  questions: [
    {
      id: 'que_1',
      index: 0,
      type: 'single_choice',
      stem: '关于「工作记忆」,以下哪项表述与资料一致?',
      options: [
        { id: 'A', text: '工作记忆的容量十分有限' },
        { id: 'B', text: '工作记忆容量无限' },
      ],
      conceptId: 'con_0',
      conceptName: '工作记忆',
      grounding: concepts[0]!.grounding,
      points: 1,
    },
    {
      id: 'que_2',
      index: 1,
      type: 'short_answer',
      stem: '请根据资料,简述「工作记忆」的要点。',
      conceptId: 'con_0',
      conceptName: '工作记忆',
      grounding: concepts[0]!.grounding,
      points: 2,
    },
  ],
};

export const fullQuestions: Question[] = [
  {
    id: 'que_1',
    quizId: 'qz_1',
    index: 0,
    type: 'single_choice',
    stem: '关于「工作记忆」,以下哪项表述与资料一致?',
    options: [
      { id: 'A', text: '工作记忆的容量十分有限' },
      { id: 'B', text: '工作记忆容量无限' },
    ],
    correctOptionIds: ['A'],
    conceptId: 'con_0',
    conceptName: '工作记忆',
    grounding: concepts[0]!.grounding,
    explanation: '资料明确指出工作记忆容量十分有限。',
    points: 1,
  },
  {
    id: 'que_2',
    quizId: 'qz_1',
    index: 1,
    type: 'short_answer',
    stem: '请根据资料,简述「工作记忆」的要点。',
    expectedAnswer: '工作记忆容量有限,一次约四个组块。',
    rubric: { keyPoints: ['容量有限', '约四个组块'] },
    conceptId: 'con_0',
    conceptName: '工作记忆',
    grounding: concepts[0]!.grounding,
    explanation: '参考「记忆的三种类型」一节。',
    points: 2,
  },
];

export const grading: GradingResult = {
  id: 'grd_1',
  submissionId: 'sub_1',
  quizId: 'qz_1',
  grades: [
    {
      questionId: 'que_1',
      type: 'single_choice',
      gradedBy: 'deterministic',
      correct: true,
      awardedPoints: 1,
      maxPoints: 1,
      normalizedScore: 1,
      needsReview: false,
    },
    {
      questionId: 'que_2',
      type: 'short_answer',
      gradedBy: 'model',
      correct: false,
      awardedPoints: 0.8,
      maxPoints: 2,
      normalizedScore: 0.4,
      matchedKeyPoints: ['容量有限'],
      missedKeyPoints: ['约四个组块'],
      confidence: 0.72,
      feedback: '已覆盖部分要点,仍需补充:约四个组块。',
      needsReview: false,
    },
  ],
  totalAwarded: 1.8,
  totalPossible: 3,
  overallScore: 0.6,
  createdAt: T0,
};

export const mistakes: MistakeRecord[] = [
  {
    id: 'mis_1',
    materialId: 'mat_1',
    quizId: 'qz_1',
    questionId: 'que_2',
    conceptId: 'con_0',
    conceptName: '工作记忆',
    question: fullQuestions[1]!,
    userAnswer: { questionId: 'que_2', type: 'short_answer', text: '不太记得了' },
    score: 0.4,
    feedback: '已覆盖部分要点,仍需补充:约四个组块。',
    status: 'open',
    remediationCount: 0,
    createdAt: T0,
    resolvedAt: null,
  },
];

export const mastery: MasteryState[] = [
  {
    materialId: 'mat_1',
    conceptId: 'con_0',
    conceptName: '工作记忆',
    mastery: 0.47,
    attempts: 2,
    correctCount: 1,
    lastScore: 0.7,
    updatedAt: T0,
  },
];
