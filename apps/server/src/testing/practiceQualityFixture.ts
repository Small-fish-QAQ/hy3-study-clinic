import type {
  LearnerPracticeSolvingSurface,
  PracticeContentProposalPayload,
  TeachingContentReview,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type {
  PracticeContentGenerationInput,
  TeachingContentReviewInput,
} from '../llm/provider.js';
import { compareLearnerPracticeTasks } from '../services/practiceTaskCanonicalization.js';

/** Finite, independently controlled examples for acceptance regressions. This
 * fixture is not production review and never treats an authored key as truth. */
export type PracticeQualityVariant =
  | 'omitted'
  | 'compact'
  | 'paraphrased'
  | 'repeated_feedback'
  | 'source_quotation'
  | 'option_cases'
  | 'label_mentions'
  | 'conditional_rule'
  | 'symbolic_contrast';

const queueRule =
  'A queue can start only if its required slots do not exceed the 5 available slots. Which offered queue can start?';
const labelPrompt =
  'Allowed labels: Above the limit, At the limit, Below the limit. The measured load is 12 kg and the limit is 10 kg. Which label applies?';
const signRule =
  '对任意有符号数 n：若 n > 0，正确答案是正数；若 n = 0，正确答案是零；若 n < 0，正确答案是负数。';
const signResultDisclosure = ' 本题计算后的数位于零的右侧。';

export function practiceQualityVariant(
  candidate: PracticeContentProposalPayload,
  variant: PracticeQualityVariant,
  context: PracticeContentGenerationInput,
): PracticeContentProposalPayload {
  for (const item of candidate.items) {
    if (variant === 'omitted') {
      delete item.capabilityTested;
      delete item.pedagogicalReason;
      delete item.application;
      for (const surface of [item.initial, item.retry]) {
        delete surface.reasoningOperation;
        delete surface.requiredInference;
        delete surface.decisiveCondition;
        delete surface.evidenceContrast;
      }
    }
    if (variant === 'compact') {
      item.capabilityTested = '识别';
      item.pedagogicalReason = '复习';
      item.application = { startingState: 'x>0', expectedAction: 'x<0' };
      item.initial.evidenceContrast = {
        evidence: '旧任务已结束',
        replacement: '未结束',
        alternativeOptionId: 'C',
      };
    }
    if (variant === 'paraphrased')
      item.retry.evidenceContrast!.evidence = '本次占用计数已经清零，但任务仍在等待。';
    if (variant === 'repeated_feedback')
      for (const surface of [item.initial, item.retry])
        for (const option of surface.options)
          option.feedbackIfSelected =
            'Compare the stated event and current counter with the scheduling rule.';
    if (variant === 'source_quotation')
      item.initial.prompt = context.sourceContext.offers[0]!.text + '\n' + item.initial.prompt;
    if (variant === 'option_cases') {
      for (const [name, cases] of [
        ['initial', ['Queue P needs 4 slots', 'Queue Q needs 7 slots', 'Queue R needs 8 slots']],
        ['retry', ['Queue U needs 9 slots', 'Queue V needs 6 slots', 'Queue W needs 3 slots']],
      ] as const) {
        item[name] = {
          prompt: queueRule,
          options: cases.map((text, index) => ({
            optionRef: 'ABC'[index]!,
            text,
            feedbackIfSelected: 'Compare this queue requirement with 5 available slots.',
          })),
          correctOptionRef: name === 'initial' ? 'A' : 'C',
          hint: 'A requirement at or below 5 fits.',
          explanation:
            name === 'initial'
              ? 'Only P requires at most 5 slots.'
              : 'Only W requires at most 5 slots.',
        };
      }
    }
    if (variant === 'label_mentions') {
      item.initial = {
        prompt: labelPrompt,
        options: ['Above the limit', 'At the limit', 'Below the limit'].map((text, index) => ({
          optionRef: 'ABC'[index]!,
          text,
          feedbackIfSelected: ['12 > 10.', '12 does not equal 10.', '12 is not below 10.'][index]!,
        })),
        correctOptionRef: 'A',
        hint: 'Compare measured and permitted load.',
        explanation: '12 kg exceeds 10 kg.',
      };
    }
    if (variant === 'conditional_rule' || variant === 'symbolic_contrast') {
      item.sourceRefs = [];
      item.visualRefs = [];
      delete item.capabilityTested;
      delete item.pedagogicalReason;
      delete item.application;
      for (const name of ['initial', 'retry'] as const) {
        const expression = name === 'initial' ? '7 - 4' : '2 - 6';
        const result = name === 'initial' ? 3 : -4;
        item[name] = {
          prompt: signRule + `本题 n = ${expression}，应选哪个标签？`,
          options: ['正数', '零', '负数'].map((text, index) => ({
            optionRef: 'ABC'[index]!,
            text,
            feedbackIfSelected: `${expression} = ${result}，请将差值与零比较。`,
          })),
          correctOptionRef: name === 'initial' ? 'A' : 'C',
          hint: '先计算差值，再把结果与零比较。',
          explanation:
            name === 'initial'
              ? '7 - 4 = 3，大于零，因此应选正数。'
              : '2 - 6 = -4，小于零，因此应选负数。',
          ...(variant === 'symbolic_contrast'
            ? {
                evidenceContrast: {
                  evidence: name === 'initial' ? 'n=3' : 'n=-4',
                  replacement: name === 'initial' ? 'n=-4' : 'n=3',
                  alternativeOptionId: name === 'initial' ? 'C' : 'A',
                },
              }
            : {}),
        };
      }
    }
  }
  return candidate;
}

export async function reviewPracticeQualityVariant(
  input: TeachingContentReviewInput,
  variant: PracticeQualityVariant,
  context: PracticeContentGenerationInput,
): Promise<TeachingContentReview> {
  const fake = new FakeProvider();
  const expected = practiceQualityVariant(
    await fake.generatePracticeContent(context),
    variant,
    context,
  );
  if (input.purpose === 'practice_grounding') {
    const findings: TeachingContentReview['findings'] = [];
    for (const item of input.candidate.items) {
      const known = expected.items.find((value) => value.practiceSlotId === item.practiceSlotId);
      for (const name of ['initial', 'retry'] as const) {
        const surface = structuredClone(item[name]);
        const contrast = surface.evidenceContrast;
        if (
          contrast?.evidence.includes('旧任务已结束') &&
          contrast.replacement === contrast.evidence &&
          surface.prompt.includes('完成日志确认旧任务已结束') &&
          surface.options.find((option) => option.optionRef === contrast.alternativeOptionId)
            ?.text === '旧任务仍在运行，所以当前占用计数完全正常。'
        ) {
          findings.push({
            itemId: item.practiceSlotId + '.' + name,
            code: 'accuracy',
            responsibility: 'grounding',
            problem:
              'The replacement still says the old task has completed, but its proposed alternative says the old task is still running. That counterfactual contradicts the unchanged public completion log.',
            repairInstruction: 'Correct or omit the false supplied counterfactual.',
          });
          continue;
        }
        // This one additional statement is true for the known 7 - 4 case;
        // its premature disclosure belongs to public integrity, not grounding.
        if (
          (variant === 'conditional_rule' || variant === 'symbolic_contrast') &&
          name === 'initial' &&
          surface.prompt === known?.initial.prompt + signResultDisclosure
        )
          surface.prompt = known!.initial.prompt;
        // Compare the entire finite teaching surface, including every delayed
        // feedback and authored key. Unknown/incorrect variants receive no proof.
        if (
          !known ||
          JSON.stringify(surface) !== JSON.stringify(known[name]) ||
          JSON.stringify(item.application) !== JSON.stringify(known.application)
        )
          findings.push({
            itemId: item.practiceSlotId + '.' + name,
            code: 'accuracy',
            responsibility: 'grounding',
            problem:
              'The proposed teaching claims differ from the independently controlled correct case.',
            repairInstruction: 'Restore the correct public case, answer and truthful feedback.',
          });
      }
    }
    return { decisions: [], findings };
  }
  if (input.purpose === 'practice_answerability') {
    const surface = input.candidate;
    let answerId: string | null = null;
    if (surface.prompt === queueRule) {
      const offered = surface.options.map((option) => ({
        ...option,
        required: /^Queue [P-W] needs (\d+) slots$/u.exec(option.text)?.[1],
      }));
      const feasible = offered.filter(
        (option) => option.required !== undefined && Number(option.required) <= 5,
      );
      if (offered.every((option) => option.required !== undefined) && feasible.length === 1)
        answerId = feasible[0]!.id;
    } else if (surface.prompt === labelPrompt) {
      const labels = ['Above the limit', 'At the limit', 'Below the limit'];
      if (
        surface.options.length === 3 &&
        surface.options.every((option) => labels.includes(option.text))
      )
        answerId = surface.options.find((option) => option.text === labels[0])?.id ?? null;
    } else if (variant === 'conditional_rule' || variant === 'symbolic_contrast') {
      const prompt = surface.prompt.endsWith(signResultDisclosure)
        ? surface.prompt.slice(0, -signResultDisclosure.length)
        : surface.prompt;
      const operands = prompt.startsWith(signRule)
        ? /^本题 n = (\d+) - (\d+)，应选哪个标签？$/u.exec(prompt.slice(signRule.length))
        : null;
      if (operands) {
        const result = Number(operands[1]) - Number(operands[2]);
        const label = result > 0 ? '正数' : result < 0 ? '负数' : '零';
        const meanings: Record<string, string> = {
          正数: '正数',
          大于零: '正数',
          零: '零',
          等于零: '零',
          负数: '负数',
          小于零: '负数',
        };
        const matching = surface.options.filter((option) => meanings[option.text] === label);
        if (matching.length === 1) answerId = matching[0]!.id;
      }
    } else if (variant === 'source_quotation') {
      const prefix = context.sourceContext.offers[0]!.text + '\n';
      if (surface.prompt.startsWith(prefix)) {
        const solved = await fake.reviewTeachingContent({
          ...input,
          candidate: { ...surface, prompt: surface.prompt.slice(prefix.length) },
        });
        answerId = solved.decisions[0]!.answerId;
      } else return fake.reviewTeachingContent(input);
    } else return fake.reviewTeachingContent(input);
    return {
      decisions: [
        {
          actionId: surface.actionId,
          answerId,
          requiresCaseInference: answerId !== null,
          evidenceUsed:
            'The controlled public rule and offered case facts determine the sole feasible result.',
        },
      ],
      findings: [],
    };
  }
  if (input.purpose === 'practice_integrity') {
    const findings: TeachingContentReview['findings'] = [];
    const candidate = input.candidate as {
      items: Array<{
        practiceSlotId: string;
        initial: LearnerPracticeSolvingSurface;
        retry: LearnerPracticeSolvingSurface;
      }>;
    };
    for (const item of candidate.items) {
      if (compareLearnerPracticeTasks(item.initial, item.retry) === 'equal')
        findings.push({
          itemId: item.practiceSlotId,
          code: 'practice_replay',
          problem: 'Both public surfaces repeat the same deciding case and alternatives.',
          repairInstruction: 'Supply a genuinely different deciding case.',
        });
      for (const name of ['initial', 'retry'] as const)
        if (item[name].prompt.endsWith(signResultDisclosure))
          findings.push({
            itemId: item.practiceSlotId + '.' + name,
            code: 'answer_leak',
            problem:
              'The current prompt states “本题计算后的数位于零的右侧”, already giving the sign of this very calculation before the learner answers.',
            repairInstruction: 'Keep the rule and operands, but withhold the current result.',
          });
    }
    return { decisions: [], findings };
  }
  return fake.reviewTeachingContent(input);
}
