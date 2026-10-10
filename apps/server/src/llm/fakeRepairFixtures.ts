import { isDeepStrictEqual } from 'node:util';
import {
  PracticeRepairContentSchema,
  type LearnerPracticeSolvingSurface,
  type PracticeRepairContent,
  type TeachingContentReview,
} from '@hy3-clinic/shared';
import type {
  PracticeRepairInput,
  PracticeRepairGroundingReviewInput,
  PracticeRepairIntegrityReviewInput,
} from './provider.js';
import { identicalRepairTasks, repairComparisonTasks } from './practiceRepair.js';
import { ProviderError } from './errors.js';

type Case = {
  prompt: string;
  answers: [string, string, string];
  feedback: [string, string, string];
  hint: string;
  explanation: string;
};
// Finite, independently checked cases: closed/open, AND with one false operand,
// permission absent, OR with one true operand, AND with overdue, barrier down,
// OR with invitation, AND with expired code. Each has exactly one offered result.
const cases: Case[] = [
  {
    prompt:
      '水库规则：水源充足，每个阀门独立控制对应城区；开启即可向对应城区供水，关闭就停止对应城区供水。东阀关闭，西阀开启。哪个城区仍收到供水，为什么？',
    answers: [
      '只有西区供水，因为西阀开启。',
      '两区都供水，因为水库仍有水。',
      '两区都停水，因为东阀关闭。',
    ],
    feedback: [
      '水源充足，西阀开启即可向西区供水；东阀关闭使东区停水，所以只有西区供水。',
      '有水不能替代对应阀门开启的条件。',
      '东阀不控制西区，西阀仍然开启。',
    ],
    hint: '分别检查两个城区对应的阀门。',
    explanation: '水源充足且开启阀门即可供水；两个阀门独立控制对应城区，因此东区停水，西区供水。',
  },
  {
    prompt:
      '快递派送规则：地址有效且邮资已付时才派送，两项同时满足即可派送。包裹地址有效，邮资未付。现在能派送吗？',
    answers: [
      '不能派送，因为邮资未付。',
      '能派送，因为地址有效。',
      '能派送，因为两项中任意一项有效即可。',
    ],
    feedback: [
      '邮资条件未满足，因此不能派送。',
      '地址有效不能替代支付邮资。',
      '这里是同时满足两项的规则，不是任意一项。',
    ],
    hint: '检查规则连接两个条件的方式。',
    explanation: '地址有效而邮资未付，合取条件为假，所以不能派送。',
  },
  {
    prompt:
      '工坊准入规则：只检查是否持有已签字的许可证；持有即可进入，没有则不准进入。学员技术熟练，却没有许可证。可以进入吗？',
    answers: [
      '不能进入，因为没有许可证。',
      '可以进入，因为技术熟练。',
      '可以进入，因为熟练程度可替代许可证。',
    ],
    feedback: [
      '许可证缺失，所以规则不允许进入。',
      '准入规则没有以技术熟练作为许可条件。',
      '这里没有许可证替代条款。',
    ],
    hint: '区分准入条件与技术水平。',
    explanation: '唯一准入条件是许可证；该条件未满足，因此不能进入。',
  },
  {
    prompt:
      '实验室疏散规则：两条独立出口中至少一条通畅即可疏散。甲出口被堵，乙出口通畅。是否必须停止疏散？',
    answers: [
      '不用停止，因为乙出口通畅。',
      '必须停止，因为甲出口被堵。',
      '必须停止，因为规则要求两条都通畅。',
    ],
    feedback: [
      '乙出口通畅满足至少一条通畅的条件。',
      '甲出口被堵不使乙出口失效。',
      '规则是至少一条，不是两条都通畅。',
    ],
    hint: '检查“至少一条”的含义。',
    explanation: '一个出口被堵，另一个通畅；析取条件仍为真，所以可继续疏散。',
  },
  {
    prompt:
      '图书馆借阅规则：会员资格有效且没有逾期书时允许借新书，两项同时满足即可借阅。会员资格有效，但有一本逾期书。能借新书吗？',
    answers: ['不能，因为有逾期书。', '能，因为会员资格有效。', '能，因为只逾期一本不影响条件。'],
    feedback: [
      '没有逾期书的条件未满足，所以不能借新书。',
      '会员资格不能替代无逾期的条件。',
      '规则没有豁免一本逾期书。',
    ],
    hint: '逐项核对两项准入条件。',
    explanation: '有效会员资格为真，无逾期为假；合取为假，不能借新书。',
  },
  {
    prompt:
      '铁路道口通行规则：栏杆升起即可通行，栏杆落下则禁止通行，警示灯不改变此规则。警示灯熄灭，但栏杆仍落下。可以通行吗？',
    answers: [
      '不可以，因为栏杆仍落下。',
      '可以，因为警示灯熄灭。',
      '可以，因为只在警示灯亮时禁止通行。',
    ],
    feedback: [
      '栏杆落下直接触发禁止通行。',
      '灯熄灭没有改变栏杆条件。',
      '禁行条件是栏杆落下，不是灯亮。',
    ],
    hint: '找到规则中真正控制通行的条件。',
    explanation: '栏杆仍落下，因此禁止通行；灯的状态在该显式规则中不改变结果。',
  },
  {
    prompt:
      '赛事准入规则：地区通行证或邀请函至少持有一种即可入场。选手没有地区通行证，但持有邀请函。可以入场吗？',
    answers: [
      '可以，因为邀请函满足任意一种的要求。',
      '不可以，因为没有地区通行证。',
      '不可以，因为必须同时持有两种凭证。',
    ],
    feedback: [
      '邀请函为真，析取条件成立。',
      '地区通行证缺失不使有效邀请函失效。',
      '规则是至少一种，不是同时两种。',
    ],
    hint: '检查条件是“或”还是“且”。',
    explanation: '邀请函有效满足至少一种凭证的条件，所以可以入场。',
  },
  {
    prompt:
      '档案室开门规则：有效证件且当天有效密码同时满足即可开门。证件有效，提供的密码已在昨天过期。现在会开门吗？',
    answers: [
      '不会，因为当天有效密码缺失。',
      '会，因为证件有效。',
      '会，因为曾经有效的密码永远有效。',
    ],
    feedback: [
      '过期密码不满足当天有效的条件。',
      '有效证件不能替代当天有效密码。',
      '题目明确说明密码已过期。',
    ],
    hint: '检查每个条件在当前时刻是否成立。',
    explanation: '证件有效，密码失效；两个条件未同时成立，所以不会开门。',
  },
];

const core = (input: Pick<PracticeRepairInput, 'selectedAnswer' | 'objective'>) => ({
  diagnosis: {
    observation: `你选择了：${input.selectedAnswer}`,
    gap: `接下来重新检验：${input.objective.capabilityTested}`,
    uncertainty: '一次选择也可能源于读题疏漏，需要新情境继续检验。',
  },
  explanation:
    '在下面的补充条件模型中，先区分“且”和“或”：且要求每项成立，或要求至少一项成立。再将规则用于当前事实。',
  workedExample: {
    prompt: '补充模型：机器在且仅在护罩关闭且电源开启时运行。护罩开启，电源开启。',
    steps: [
      '护罩关闭的条件为假，电源开启的条件为真。',
      '合取要求两项都为真，所以当前运行条件为假。',
    ],
    conclusion: '按该显式模型，机器不运行。',
  },
  contrast: '“且”规则中一项成立不能替代另一项；“或”规则中至少一项成立即可。',
});

export function createFakePracticeRepairFixture(input: PracticeRepairInput): PracticeRepairContent {
  const reserved = repairComparisonTasks(input);
  const pair = [0, 2, 4, 6].find(
    (start) =>
      !cases
        .slice(start, start + 2)
        .some(
          (known) =>
            reserved.some((task) =>
              identicalRepairTasks(task, { prompt: known.prompt, options: known.answers }),
            ) ||
            (input.tutorExplanations ?? []).some(
              (text) => text.includes(known.prompt) || text.includes(known.explanation),
            ),
        ),
  );
  if (pair === undefined)
    throw ProviderError.invalidOutput('Controlled Fake Repair cases are exhausted.');
  return PracticeRepairContentSchema.parse({
    ...core(input),
    retest: cases.slice(pair, pair + 2).map((known) => ({
      prompt: known.prompt,
      options: known.answers.map((text, index) => ({
        id: ['A', 'B', 'C'][index],
        text,
        feedbackIfSelected: known.feedback[index],
      })),
      correctOptionId: 'A',
      hint: known.hint,
      explanation: known.explanation,
    })),
  });
}

function knownCase(surface: LearnerPracticeSolvingSurface) {
  if (
    new Set(surface.options.map(({ id }) => id)).size !== surface.options.length ||
    new Set(surface.options.map(({ text }) => text)).size !== surface.options.length ||
    surface.options.some(({ id }) => !/^[A-E]$/u.test(id))
  )
    return undefined;
  return cases.find(
    (known) =>
      known.prompt === surface.prompt &&
      surface.options.length === known.answers.length &&
      surface.options.every(({ text }) => known.answers.includes(text)),
  );
}
export function solveFakeRepairFixture(surface: LearnerPracticeSolvingSurface): string | null {
  const known = knownCase(surface);
  return surface.options.find(({ text }) => text === known?.answers[0])?.id ?? null;
}

export function reviewFakeRepairGrounding(
  input: PracticeRepairGroundingReviewInput,
): TeachingContentReview {
  const findings: TeachingContentReview['findings'] = [];
  const expected = core(input.evidence);
  for (const field of ['diagnosis', 'explanation', 'workedExample', 'contrast'] as const) {
    if (!isDeepStrictEqual(input.candidate[field], expected[field]))
      findings.push({
        itemId: 'repair',
        code: 'insufficient_evidence',
        problem: `Unsupported Fake Repair ${field}: ${JSON.stringify(input.candidate[field])}`,
        repairInstruction: 'Use the independently checked controlled teaching fixture.',
      });
  }
  for (const [index, surface] of input.candidate.retest.entries()) {
    const known = knownCase(surface);
    const {
      prompt: _prompt,
      options: _options,
      correctOptionId: _key,
      hint: _hint,
      explanation: _explanation,
      ...privateClaims
    } = surface;
    if (
      !known ||
      Object.keys(privateClaims).length ||
      surface.correctOptionId !== solveFakeRepairFixture(surface) ||
      surface.explanation !== known.explanation ||
      surface.hint !== known.hint ||
      surface.options.some(
        (option) =>
          option.feedbackIfSelected !== known.feedback[known.answers.indexOf(option.text)],
      )
    )
      findings.push({
        itemId: `retest${index}`,
        code: 'accuracy',
        problem: `Retest ${index + 1} does not match verified public case, key and complete delayed teaching expectations.`,
        repairInstruction:
          'Restore the controlled case and every independently checked feedback, hint and explanation.',
      });
  }
  return { decisions: [], findings };
}

export function reviewFakeRepairIntegrity(
  input: PracticeRepairIntegrityReviewInput,
): TeachingContentReview {
  const findings: TeachingContentReview['findings'] = [];
  for (const [index, surface] of input.candidate.entries()) {
    const known = knownCase(surface);
    if (
      [
        ...input.comparisonTasks,
        ...input.candidate.slice(0, index).map((other) => ({
          prompt: other.prompt,
          options: other.options.map(({ text }) => text),
        })),
      ].some((other) =>
        identicalRepairTasks(other, {
          prompt: surface.prompt,
          options: surface.options.map(({ text }) => text),
        }),
      ) ||
      // In this finite catalogue the known prompt owns ALL deciding facts and
      // the decision. This is a controlled case identity, not a generic Tutor
      // template/substring policy for arbitrary tasks.
      (known && input.priorTeaching.some((text) => text.includes(known.prompt)))
    )
      findings.push({
        itemId: surface.itemId,
        code: 'practice_replay',
        problem: 'The same controlled public case is exposed or reserved.',
        repairInstruction: 'Choose a fresh independently checked case.',
      });
    if (input.priorTeaching.some((text) => known && text.includes(known.explanation)))
      findings.push({
        itemId: surface.itemId,
        code: 'answer_leak',
        problem:
          'Prior public teaching already states this specific case or its solved explanation.',
        repairInstruction: 'Choose new case facts without an exposed result.',
      });
  }
  return { decisions: [], findings };
}
