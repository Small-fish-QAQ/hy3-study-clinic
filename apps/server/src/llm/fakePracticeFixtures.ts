import type { DesiredDepth, LearnerPracticeSolvingSurface } from '@hy3-clinic/shared';

interface FakePracticeFixture {
  prompt: string;
  optionTexts: string[];
  answerText: string;
}

const scenarioDemands = {
  pass_oriented: '在一个简单的新案例中',
  working_fluency: '在一个重要条件已经改变的新案例中',
  high_performance: '在一个存在相互竞争约束的真实失败案例中',
  deep_transfer: '在一个组合了两项相互作用约束的陌生迁移案例中',
} satisfies Record<DesiredDepth, string>;
const applicationStart = '相关流程已经开始，学习者来到一个受条件约束的决策点。';
const focusDetail = ' 请同时考虑会让那个看似诱人的选项失效的边界条件。';
const publicRule =
  '规则：旧任务完成后应归还占用配额；优先级不改变占用计数；计数归零后，新任务仍须满足后续调度条件。';

/** Fully stated public cases shared by Fake authoring and its finite fixture registry. */
export function fakePracticeFixtures(
  depth: DesiredDepth = 'working_fluency',
  focused = false,
  applying = false,
): { initial: FakePracticeFixture; retry: FakePracticeFixture } {
  const initialAnswer = applying
    ? '检查完成事件是否归还配额，再按当前条件执行允许的下一步。'
    : '完成处理没有归还配额，应检查完成事件到计数更新的链路。';
  const retryAnswer = applying
    ? '先排除资源未归还，再检查后续调度条件允许的动作。'
    : '计数恢复使原诊断失去依据，应转查后续调度条件。';
  return {
    initial: {
      prompt: `${scenarioDemands[depth]}，${applying ? applicationStart : ''}${publicRule}完成日志确认旧任务已结束，但占用计数没有减少，新任务一直无法通过条件检查。应先诊断哪个环节？${focused ? focusDetail : ''}`,
      optionTexts: [
        initialAnswer,
        '新任务的优先级太低，只需提高优先级即可恢复配额。',
        '旧任务仍在运行，所以当前占用计数完全正常。',
      ],
      // The public completion event contradicts the unchanged counter. Neither
      // priority nor an unfinished task explains the stated facts under this rule.
      answerText: initialAnswer,
    },
    retry: {
      prompt: `${publicRule}另一次检查中，占用计数已正确归零，新任务仍不能进入执行阶段。此时继续沿用“完成事件未归还资源”的诊断是否合理，下一步应检查什么？`,
      optionTexts: [
        '任务仍在等待，所以必然还是资源未归还。',
        retryAnswer,
        '关闭所有条件检查，任何等待任务都直接启动。',
      ],
      // Zero occupation eliminates the old symptom; the public rule explicitly
      // retains the subsequent scheduling conditions.
      answerText: retryAnswer,
    },
  };
}

const sortingFixture: FakePracticeFixture = {
  prompt:
    '记录集：A(优先级1,时长5), B(优先级1,时长9), C(优先级2,时长2), D(优先级2,时长4)。观察某次排序后顺序为 D, C, B, A。下列哪种显式比较规则能产生此顺序？',
  optionTexts: [
    '主键优先级降序、次键时长降序',
    '主键优先级升序、次键时长升序',
    '主键优先级升序、次键时长降序',
  ],
  // The visible records give priority-2 D(4), C(2), then priority-1 B(9), A(5).
  // The other offered rules give A,B,C,D and B,A,D,C respectively.
  answerText: '主键优先级降序、次键时长降序',
};

const knownFixtures = [
  sortingFixture,
  ...Object.keys(scenarioDemands).flatMap((depth) =>
    [false, true].flatMap((focused) =>
      [false, true].flatMap((applying) =>
        Object.values(fakePracticeFixtures(depth as DesiredDepth, focused, applying)),
      ),
    ),
  ),
];

/** Exact public fixture recognition, never a general language solver or key oracle. */
export function solveFakePracticeFixture(surface: LearnerPracticeSolvingSurface): string | null {
  if (
    surface.options.some((option) => !/^[A-E]$/u.test(option.id)) ||
    new Set(surface.options.map((option) => option.id)).size !== surface.options.length ||
    new Set(surface.options.map((option) => option.text)).size !== surface.options.length
  )
    return null;
  const fixture = knownFixtures.find(
    (known) =>
      surface.prompt === known.prompt &&
      surface.options.length === known.optionTexts.length &&
      surface.options.every((option) => known.optionTexts.includes(option.text)),
  );
  return surface.options.find((option) => option.text === fixture?.answerText)?.id ?? null;
}
