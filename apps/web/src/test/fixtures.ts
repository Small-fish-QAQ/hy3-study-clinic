import type {
  Concept,
  ConceptLearnerState,
  DocumentSummary,
  GradingResult,
  GraphEdge,
  GraphVersion,
  MasteryState,
  MistakeRecord,
  PublicQuiz,
  Question,
  RemediationPlan,
  SourceBlock,
  Workspace,
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
    pageNumber: null,
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
    pageNumber: null,
    content: '与其把复习集中在一次完成,不如把同样的时间分散到多次进行。',
    startOffset: 45,
    endOffset: 73,
  },
];

export const material = {
  material: {
    id: 'mat_1',
    workspaceId: 'ws_1',
    title: '认知科学入门:记忆与学习',
    sourceType: 'md' as const,
    mediaType: 'text/markdown' as const,
    originalFilename: null,
    content: `# 认知科学入门\n\n${blocks[0]!.content}\n\n${blocks[1]!.content}`,
    charCount: 80,
    parseStatus: 'parsed' as const,
    pageCount: null,
    extractionWarnings: [] as string[],
    parserVersion: 'text-v1',
    createdAt: T0,
    updatedAt: T0,
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

// --- 学习图谱工作台 fixtures ---

export const workspace: Workspace = {
  id: 'ws_1',
  name: '认知科学课程',
  description: null,
  activeGraphVersionId: 'gv_1',
  createdAt: T0,
  updatedAt: T0,
};

export const workspaceSummary = {
  ...workspace,
  documentCount: 1,
  conceptCount: 2,
};

export const documentSummary: DocumentSummary = {
  id: 'mat_1',
  workspaceId: 'ws_1',
  title: material.material.title,
  sourceType: 'md',
  mediaType: 'text/markdown',
  originalFilename: null,
  charCount: material.material.charCount,
  blockCount: blocks.length,
  conceptCount: 2,
  parseStatus: 'parsed',
  pageCount: null,
  extractionWarnings: [],
  parserVersion: 'text-v1',
  createdAt: T0,
  updatedAt: T0,
};

export const graphConcepts: Concept[] = [
  concepts[0]!,
  {
    id: 'con_1',
    materialId: 'mat_1',
    name: '间隔重复',
    summary: '把复习分散到多次进行的策略。',
    importance: 'high',
    grounding: {
      blockId: 'blk_1',
      quote: '与其把复习集中在一次完成,不如把同样的时间分散到多次进行。',
      startOffset: 0,
      endOffset: 28,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: T0,
  },
];

export const graphVersion: GraphVersion = {
  id: 'gv_1',
  workspaceId: 'ws_1',
  status: 'ready',
  provider: 'fake',
  providerModel: null,
  validationSummary: {
    candidateCount: 2,
    acceptedCount: 1,
    rejectedCount: 1,
    duplicateCount: 0,
    droppedEvidenceCount: 0,
    rejected: [
      {
        sourceConceptId: 'con_0',
        targetConceptId: 'con_x',
        relation: 'causes',
        reason: '未知概念:con_x',
      },
    ],
  },
  errorMessage: null,
  createdAt: T0,
  updatedAt: T0,
};

export const graphEdges: GraphEdge[] = [
  {
    id: 'ge_1',
    graphVersionId: 'gv_1',
    sourceConceptId: 'con_0',
    targetConceptId: 'con_1',
    relation: 'prerequisite',
    explanation: '先理解工作记忆的限制,才能理解间隔重复为何有效。',
    evidence: [
      {
        blockId: 'blk_1',
        quote: '与其把复习集中在一次完成,不如把同样的时间分散到多次进行。',
        startOffset: 0,
        endOffset: 28,
        occurrenceCount: 1,
        reanchored: false,
      },
    ],
    createdAt: T0,
  },
];

export const overlayStates: ConceptLearnerState[] = [
  {
    conceptId: 'con_0',
    conceptName: '工作记忆',
    materialId: 'mat_1',
    state: 'weak',
    mastery: 0.47,
    hasEnoughActivity: false,
    attempts: 2,
    correctCount: 1,
    lastScore: 0.7,
    lastActivityAt: T0,
    openMistakes: 1,
    resolvedMistakes: 0,
    treatAsWeak: true,
    prerequisiteConceptIds: [],
  },
  {
    conceptId: 'con_1',
    conceptName: '间隔重复',
    materialId: 'mat_1',
    state: 'unassessed',
    mastery: null,
    hasEnoughActivity: false,
    attempts: 0,
    correctCount: 0,
    lastScore: null,
    lastActivityAt: null,
    openMistakes: 0,
    resolvedMistakes: 0,
    treatAsWeak: false,
    prerequisiteConceptIds: ['con_0'],
  },
];

export const remediationPlan: RemediationPlan = {
  id: 'plan_1',
  workspaceId: 'ws_1',
  conceptId: 'con_0',
  summary: '围绕「工作记忆」的定向巩固计划:共 1 个目标概念、2 个步骤。',
  weaknessHypothesis: '学习者可能混淆了工作记忆容量的具体限制。',
  strategy: 'retrieval_practice',
  difficulty: 'medium',
  questionTypes: ['single_choice', 'short_answer'],
  steps: [
    { index: 0, description: '重读「工作记忆」的原文依据。', conceptId: 'con_0' },
    { index: 1, description: '完成检索练习并提交判分。', conceptId: 'con_0' },
  ],
  targets: [
    {
      conceptId: 'con_0',
      conceptName: '工作记忆',
      reason: '「工作记忆」目前有 1 道未解决错题,需要针对性巩固。',
      evidence: [
        {
          blockId: 'blk_0',
          quote: '工作记忆的容量十分有限',
          startOffset: 0,
          endOffset: 11,
          occurrenceCount: 1,
          reanchored: false,
        },
      ],
    },
  ],
  provider: 'fake',
  createdAt: T0,
};
