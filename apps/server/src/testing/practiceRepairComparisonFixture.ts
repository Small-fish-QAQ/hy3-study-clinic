import type {
  LessonPracticeSurface,
  LearnerPracticeSolvingSurface,
  PracticeRepairPublicTask,
  PracticeRepairContent,
  TeachingContentReview,
} from '@hy3-clinic/shared';
import type { PracticeRepairIntegrityReviewInput } from '../llm/provider.js';

/** Schema-valid size stressor, deliberately NOT a correctness fixture. It must
 * fail complete-request preflight before any semantic receipt is available. */
export function maximumRepairCandidate(base: PracticeRepairContent): PracticeRepairContent {
  const text = (size: number) => '教'.repeat(size);
  return {
    diagnosis: { observation: text(700), gap: text(700), uncertainty: text(500) },
    explanation: text(1800),
    workedExample: {
      prompt: text(900),
      steps: Array.from({ length: 5 }, () => text(700)),
      conclusion: text(700),
    },
    contrast: text(1000),
    retest: base.retest.map((surface, index) => ({
      ...surface,
      prompt: String(index) + text(1199),
      options: Array.from({ length: 5 }, (_, option) => ({
        id: String.fromCharCode(65 + option),
        text: String(option) + text(599),
        feedbackIfSelected: text(900),
      })),
      correctOptionId: 'A',
      hint: text(700),
      explanation: text(1200),
    })),
  };
}

// Finite independent models, not a natural-language solver. Each row states the
// rule's operands, observation/intervention and the claim offered to the learner.
export const repairTemplate = '依据各选项给出的必要充分规则与事实，哪一项推断成立？';
export const repairParaphrase = '逐项核对规则及事实，选择唯一成立的推断。';

const forwardModels = [
  { token: false, network: true, replacement: true },
  { approval: false, space: true, replacement: true },
  { paper: false, online: false, replacement: true },
];
export const forwardTruth = () => [
  forwardModels[0]!.replacement && forwardModels[0]!.network,
  forwardModels[1]!.approval && forwardModels[1]!.replacement,
  forwardModels[2]!.replacement && forwardModels[2]!.online,
];

export const reverseTruth = () => {
  const models = [false, true].flatMap((a) => [false, true].map((b) => ({ a, b })));
  return [
    models.filter(({ a, b }) => a && b).every(({ a, b }) => a && b),
    models.filter(({ a, b }) => !(a && b)).every(({ a, b }) => !a && !b),
    models.filter(({ a, b }) => !(a && b)).every(({ a, b }) => !a && b),
  ];
};

const interventionModels = {
  admission: { qualification: true, permitBefore: false, permitAfter: true },
  publish: { licence: false, watermarkBefore: false, watermarkAfter: true },
  download: { owner: false, tokenBefore: false, tokenAfter: true },
};
export const interventionTruth = () => [
  interventionModels.admission.qualification && interventionModels.admission.permitAfter,
  interventionModels.publish.licence && interventionModels.publish.watermarkAfter,
  !(interventionModels.download.owner || interventionModels.download.tokenAfter),
];

const task = (
  answers: string[],
  feedback: string[],
  explanation: string,
): LessonPracticeSurface => ({
  prompt: repairTemplate,
  options: answers.map((text, index) => ({
    id: ['A', 'B', 'C'][index]!,
    text,
    feedbackIfSelected: feedback[index]!,
  })),
  correctOptionId: 'A',
  hint: '分别检查每个备选推断的规则与事实。',
  explanation,
});

export const forwardTask = task(
  [
    '读取当且仅当令牌有效且网络接通。令牌无效，网络接通。替换为有效令牌后可以读取。',
    '归档当且仅当获批且空间足够。尚未获批，空间足够。扩大空间后可以归档。',
    '打印当且仅当有纸且在线。无纸，离线。补纸后可以打印。',
  ],
  [
    '替换后令牌有效且网络仍接通，因此可以读取。',
    '扩大空间没有补上审批，仍不能归档。',
    '补纸没有改变离线状态，仍不能打印。',
  ],
  '有效令牌与网络接通使读取成立；另两项干预没有补齐各自的合取条件。',
);

export const reverseTask = task(
  [
    '开门当且仅当证件有效且当天密码有效。已观察到开门，所以两项条件都成立。',
    '删除当且仅当具有所有者身份且管理员批准。未能删除，所以两项条件都不成立。',
    '导出当且仅当许可证有效且水印启用。未能导出，所以许可证无效而水印启用。',
  ],
  [
    '开门意味着合取为真，因此两个必要条件都成立。',
    '删除失败只证明至少一项不成立，不能断言两项都不成立。',
    '导出失败不能唯一定位到许可证；水印缺失也可能使其失败。',
  ],
  '开门这一结果能反推两个必要条件；合取失败不能唯一确定是哪一项失败。',
);

export const interventionTask = task(
  [
    '进场当且仅当已获资格且许可有效。已获资格，许可无效。恢复许可后允许进场。',
    '发布当且仅当许可证有效且水印启用。许可证无效，水印关闭。开启水印后允许发布。',
    '下载当且仅当是所有者或分享令牌有效。非所有者且没有有效令牌。发给有效令牌后仍禁止下载。',
  ],
  [
    '资格保持有效，恢复许可后两项同时成立，允许进场。',
    '许可证仍无效，启用水印不能使合取成立。',
    '有效分享令牌已经满足析取条件，允许下载。',
  ],
  '进场的缺失条件被补齐；发布仍缺许可证，而下载在新增有效令牌后被允许。',
);

export function literalTask(value: 'a b' | 'ab'): LessonPracticeSurface {
  const allowed = value === 'ab';
  return {
    prompt: `字面量规则：仅允许精确字符串 "ab"，禁止 "a b"。当前字符串为 "${value}"。应当允许吗？`,
    options: [
      { id: 'A', text: '允许。', feedbackIfSelected: allowed ? '精确匹配。' : '包含空格，禁止。' },
      {
        id: 'B',
        text: '禁止。',
        feedbackIfSelected: allowed ? '精确匹配，应允许。' : '包含空格，禁止。',
      },
      {
        id: 'C',
        text: '忽略空格后才允许。',
        feedbackIfSelected: '规则要求精确比较，不能忽略空格。',
      },
    ],
    correctOptionId: allowed ? 'A' : 'B',
    hint: '保留引号内的每一个字符。',
    explanation: allowed ? '当前字符串精确等于允许值。' : '当前字符串与允许值之间多了一个空格。',
  };
}

const finiteCases = [
  { id: 'forward', surface: forwardTask, truth: forwardTruth },
  { id: 'reverse', surface: reverseTask, truth: reverseTruth },
  { id: 'intervention', surface: interventionTask, truth: interventionTruth },
  { id: 'literal spaced', surface: literalTask('a b'), truth: () => [false, true, false] },
  { id: 'literal unspaced', surface: literalTask('ab'), truth: () => [true, false, false] },
];

function finiteCase(task: PracticeRepairPublicTask) {
  return finiteCases.find(
    ({ surface }) =>
      (task.prompt === surface.prompt ||
        (surface.prompt === repairTemplate && task.prompt === repairParaphrase)) &&
      JSON.stringify([...task.options].sort()) ===
        JSON.stringify(surface.options.map(({ text }) => text).sort()),
  );
}

/** Match ONLY these independently specified alternatives, then derive the
 * offered ID from the finite truth table. Never trust a draft key or a letter.
 */
export function solveComparisonFixture(surface: LearnerPracticeSolvingSurface): string | null {
  const known = finiteCase({
    prompt: surface.prompt,
    options: surface.options.map(({ text }) => text),
  });
  if (!known || new Set(surface.options.map(({ id }) => id)).size !== surface.options.length)
    return null;
  const correct = known.surface.options.filter((_, index) => known.truth()[index]);
  if (correct.length !== 1) return null;
  return surface.options.find(({ text }) => text === correct[0]!.text)?.id ?? null;
}

export function groundComparisonFixture(
  surface: LessonPracticeSurface,
  index: number,
): TeachingContentReview['findings'] {
  const known = finiteCase({
    prompt: surface.prompt,
    options: surface.options.map(({ text }) => text),
  });
  if (
    known &&
    solveComparisonFixture(surface) === surface.correctOptionId &&
    surface.hint === known.surface.hint &&
    surface.explanation === known.surface.explanation &&
    surface.options.every(
      (option) =>
        option.feedbackIfSelected ===
        known.surface.options.find(({ text }) => text === option.text)?.feedbackIfSelected,
    )
  )
    return [];
  return [
    {
      itemId: `retest${index}`,
      code: 'accuracy',
      problem:
        'The finite case, key or complete delayed claims differ from independently checked truth.',
      repairInstruction: 'Restore a coherent finite case and its correct explanation/feedback.',
    },
  ];
}

/** Controlled semantic identities are explicitly enumerated, including one
 * paraphrase. This fixture makes no claim to solve arbitrary model semantics.
 */
export function reviewComparisonFixtureIntegrity(
  input: PracticeRepairIntegrityReviewInput,
): TeachingContentReview {
  const findings: TeachingContentReview['findings'] = [];
  for (const [index, surface] of input.candidate.entries()) {
    const known = finiteCase({
      prompt: surface.prompt,
      options: surface.options.map(({ text }) => text),
    });
    if (!known) throw new Error('Unknown integrity fixture: no semantic verdict is available.');
    const comparisons = [
      ...input.comparisonTasks,
      ...input.candidate
        .slice(0, index)
        .map((task) => ({ prompt: task.prompt, options: task.options.map(({ text }) => text) })),
    ];
    if (comparisons.some((task) => finiteCase(task)?.id === known.id))
      findings.push({
        itemId: surface.itemId,
        code: 'practice_replay',
        problem: `The deciding ${known.id} case was already asked or reserved, including its enumerated paraphrase.`,
        repairInstruction: 'Use different deciding facts and a different decision.',
      });
    if (input.priorTeaching.some((text) => text.includes(known.surface.explanation)))
      findings.push({
        itemId: surface.itemId,
        code: 'answer_leak',
        problem: `Public teaching supplied this ${known.id} case result.`,
        repairInstruction: 'Use a case whose deciding result has not been supplied.',
      });
  }
  return { decisions: [], findings };
}
