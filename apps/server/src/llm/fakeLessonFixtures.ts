import {
  LessonSlotContentProposalPayloadSchema,
  type LessonGroundingResult,
  type LessonSlotContentProposalPayload,
} from '@hy3-clinic/shared';
import { isDeepStrictEqual } from 'node:util';
import type { LessonGroundingReviewInput, LessonSlotContentGenerationInput } from './provider.js';
import { confineTeachingCitations } from './teachingCitations.js';

type FixtureContext = {
  courseDesign?: LessonSlotContentGenerationInput['courseDesign'];
  skeleton: Pick<
    LessonSlotContentGenerationInput['skeleton'],
    'learningUnitTitle' | 'objectives' | 'lessonSlots'
  >;
  sourceContext: Pick<LessonSlotContentGenerationInput['sourceContext'], 'offers'>;
  learningContext: Pick<LessonSlotContentGenerationInput['learningContext'], 'nextConnection'>;
};

/** Keep Fake semantic-relation propositions distinct and verbatim-source compatible. */
function relationPropositions(text: string): [string, string] {
  const normalized = text.trim();
  const clauses = normalized
    .split(
      /(?:[.!?;。！？；]+|,\s*(?:and|but|so|then|while|whereas)\s+|，\s*(?:(?:而|但|并且?|所以|因此|然后)\s*)?|\s*(?:→|->)\s*)/iu,
    )
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 8);
  if (clauses.length >= 2) return [clauses[0]!, clauses.slice(1).join(' ')];

  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length >= 4) {
    const windowSize = Math.max(2, Math.ceil(words.length * 0.6));
    return [words.slice(0, windowSize).join(' '), words.slice(-windowSize).join(' ')];
  }

  const characters = [...normalized];
  const windowSize = Math.max(2, Math.ceil(characters.length * 0.6));
  return [characters.slice(0, windowSize).join(''), characters.slice(-windowSize).join('')];
}

/**
 * Controlled offline teaching templates, not a semantic judge. Source teaching
 * copies the authorized excerpt. Supplementary cases state their own givens:
 * 4 - 2 = 2 < 3, 3 - 2 = 1, and the independent spare capacity 3 fits task B.
 * Distractors are intentionally false proposed answers; their corrections and
 * saved keys are fixed by those public givens, never by candidate declarations.
 */
export function createFakeLessonFixture(input: FixtureContext): LessonSlotContentProposalPayload {
  const sourceByRef = new Map(input.sourceContext.offers.map((offer) => [offer.sourceRef, offer]));
  const objectiveByRef = new Map(
    input.skeleton.objectives.map((objective) => [objective.objectiveRef, objective]),
  );
  const selectedDepth = input.courseDesign?.desiredDepth ?? 'working_fluency';
  const depthInvestment = {
    pass_oriented: '先建立必要的心智模型，并用一个刻意保持简单的例子说明。',
    working_fluency: '接着把机制和重要边界连起来，再完整推演一个条件发生变化的案例。',
    high_performance: '还要用真实的失败模式、边界情况和相互竞争的取舍来检验这个机制。',
    deep_transfer: '进一步把机制连接到相邻概念，用反例检验它，并迁移到陌生情境。',
  }[selectedDepth];
  const focusInvestment =
    input.courseDesign?.unitFocus === 'focused'
      ? '这里会投入更多讲解，用更丰富的案例、影响结果的边界和有用的后续联系把它讲透。'
      : '我们会完整展开核心思路，同时避免无关岔路。';
  const focusedWorkedInteractionSlotId =
    input.courseDesign !== undefined &&
    input.courseDesign.desiredDepth !== 'pass_oriented' &&
    !input.skeleton.lessonSlots.some((slot) => slot.qualityContract === 'worked_process')
      ? input.skeleton.lessonSlots.find((slot) => slot.learnerActionRequired)?.slotId
      : undefined;
  const payload = LessonSlotContentProposalPayloadSchema.parse({
    narrative: {
      whyNow: `先看一个具体问题：当“${input.skeleton.learningUnitTitle}”中的关键条件改变时，为什么结果会跟着改变？学习它不是为了记住标签，而是为了建立一幅从条件经过机制走向结果的心智模型。${depthInvestment}`,
      summary: `现在回到开头的问题：关键不是孤立事实，而是条件如何启动机制、机制又如何产生结果。用这幅心智模型，就能解释原案例，也能判断条件变化后的新案例。${focusInvestment}`,
      forwardBridge: input.learningContext.nextConnection
        ? `接下来，用这个模型理解“${input.learningContext.nextConnection.title}”。`
        : '接下来把这个模型带入一个陌生案例，判断究竟是哪项条件改变了结果。',
    },
    slots: input.skeleton.lessonSlots.map((slot) => {
      const objective = objectiveByRef.get(slot.objectiveRefs[0]!);
      const sourceRef = slot.allowedSourceRefs[0];
      const visualRef = slot.allowedVisualRefs[0];
      const sourceText = sourceRef ? sourceByRef.get(sourceRef)?.text : undefined;
      const relationSourceText = sourceText?.slice(0, 560);
      const topic = objective?.title ?? input.skeleton.learningUnitTitle;
      const sourceRefs = sourceRef ? [sourceRef] : [];
      const visualRefs = sourceRef || !visualRef ? [] : [visualRef];
      const relationKind = slot.allowedRelations[0];
      const [fromProposition, toProposition] = relationSourceText
        ? relationPropositions(relationSourceText)
        : [
            `辅助图示呈现了“${topic}”的一个有限状态。`,
            `这个图示状态帮助我们对“${topic}”作出有限区分。`,
          ];
      const semanticRelations =
        slot.qualityContract === 'semantic_relation' && relationKind
          ? [
              {
                kind: relationKind,
                fromProposition,
                toProposition,
                relevanceToObjective: `这个联系说明了推理“${topic}”时，为什么该变化会影响结果。`,
                sourceRefs,
              },
            ]
          : [];
      const shouldBuildWorkedInteraction =
        slot.qualityContract === 'worked_process' || slot.slotId === focusedWorkedInteractionSlotId;
      const workedProcess =
        shouldBuildWorkedInteraction && sourceRef && sourceText
          ? {
              startingState: `用一个补充调度案例检验“${topic}”的条件边界：处理器有4个空闲配额，甲、乙尚未启动。`,
              inputs: [
                '甲优先启动，占用2个配额；乙需要3个配额。',
                '运行中的任务完成后才归还配额。',
              ],
              ruleOrProcedure:
                '按优先顺序检查任务需要的配额；启动时从空闲数扣除占用量，完成时归还。',
              steps: [
                {
                  action: '先启动甲，计算当前空闲配额：4减去2。',
                  reason: '甲处于运行状态，占用量计入处理器当前状态。',
                  resultingState: '状态快照：甲运行中，空闲配额为2；乙尚未检查。',
                },
                {
                  action: '比较乙的需求3与当前空闲2，把乙保留在等待队列。',
                  reason: '乙不能拆分启动，因此尚缺的一个配额阻止了这次启动。',
                  resultingState: '只有甲运行；乙等待甲完成并归还配额。',
                },
              ],
              learnerDecision: '用状态快照判断乙能否在甲完成前启动。',
              result: '配额没有超分配，乙的启动被延后。',
              whyResultFollows:
                '启动甲使空闲配额从4变为2，乙却需要3；因此检查当前状态会让乙等待，而只看初始容量会造成超分配。',
              sourceRefs: [],
              interaction: {
                pauseAfterStepIndex: 0,
                sourceRefs: [],
                activity: {
                  reasoningOperation: 'predict_outcome',
                  decisiveCondition: '甲正在运行，当前空闲2个配额，乙需要3个且不能拆分。',
                  evidenceContrast: {
                    evidence: '甲运行中，空闲配额为2',
                    replacement: '甲已完成，空闲配额为4',
                    alternativeOptionId: 'B',
                  },
                  requiredInference: '乙必须留在等待队列，直到至少归还一个配额。',
                  prompt: `把“${topic}”的条件判断落实到刚算出的快照：甲完成前，乙会进入什么状态？`,
                  options: [
                    {
                      id: 'A',
                      text: '乙继续等待，当前快照不足以支持它启动。',
                      feedbackIfSelected: '空闲2小于需求3，因此乙需要等待一次配额归还。',
                      misconception: null,
                    },
                    {
                      id: 'B',
                      text: '乙立即运行，处理器容量4大于它的需求3。',
                      feedbackIfSelected:
                        '容量4是初始数值；甲已经占用2，因此继续用4会把已占用资源再次分配。',
                      misconception: {
                        hypothesis: '把处理器的初始容量当作每次检查时都可用的容量。',
                        whyTempting: '输入中的4确实大于乙的3，但这个比较忽略了甲运行后的快照。',
                        correction:
                          '甲占用的2仍未归还，所以乙面对的是剩余2；先更新状态再检查需求，才能避免重复分配。',
                      },
                    },
                    {
                      id: 'C',
                      text: '乙直接失败退出，配额不足说明任务永远不能运行。',
                      feedbackIfSelected: '配额会在甲完成后归还，因此暂时不能启动不等于永久失败。',
                      misconception: {
                        hypothesis: '把当前资源不足误读为任务本身不合法。',
                        whyTempting: '快照中的2小于需求3，容易把一次检查失败看作永久拒绝。',
                        correction:
                          '完成事件会归还甲的配额，因此限制随状态改变；乙需要等待重新检查，而不是退出。',
                      },
                    },
                  ],
                  correctOptionId: 'A',
                  correctDebrief:
                    '配额是可变化的状态：甲启动后空闲只剩2，而乙一次需要3；因此乙等待一次归还事件，再重新检查准入条件。',
                },
                hint: '对照快照中的空闲数与乙的需求，再看甲何时归还配额。',
                scaffold: {
                  reasoningOperation: 'predict_outcome',
                  decisiveCondition: '乙需要3个配额，快照中空闲2个。',
                  requiredInference: '乙的需求比当前空闲数多一个。',
                  prompt: '先只比较两个数：乙的需求与快照中的空闲数相差多少？',
                  options: [
                    {
                      id: 'A',
                      text: '乙比当前空闲数多需要一个配额。',
                      feedbackIfSelected: '3减2等于1，因此还需要等到一次归还。',
                    },
                    {
                      id: 'B',
                      text: '当前空闲数比乙需要的多一个配额。',
                      feedbackIfSelected: '快照中的2是可用数，3才是需求；比较方向反了。',
                    },
                  ],
                  correctOptionId: 'A',
                  debrief:
                    '缺口是一个配额，因此当前准入条件尚不成立；这个比较建立了等待下一次状态变化的理由。',
                },
                transfer: {
                  reasoningOperation: 'choose_design',
                  requiredInference: '把乙交给独立的备用处理器，保留各自的配额边界。',
                  changedCondition: `“${topic}”案例新增截止约束：乙必须在甲结束前启动；另有一个空闲容量3的独立备用处理器。`,
                  evidenceContrast: {
                    evidence: '乙必须在甲结束前启动；另有一个空闲容量3的独立备用处理器',
                    replacement: '乙允许在甲结束后启动，且没有备用处理器',
                    alternativeOptionId: 'A',
                  },
                  prompt: '怎样安排乙，才能同时满足截止要求和资源限制？',
                  options: [
                    {
                      id: 'A',
                      text: '仍在原处理器等待甲完成后再检查乙。',
                      feedbackIfSelected: '资源不会超分配，但等待甲完成会错过新增截止约束。',
                    },
                    {
                      id: 'B',
                      text: '由备用处理器接收乙，并在它自己的容量内分配资源。',
                      feedbackIfSelected: '备用容量3能覆盖乙需求，因此可以在甲结束前独立启动。',
                    },
                    {
                      id: 'C',
                      text: '把原处理器的容量记录改为5，直接与甲并行。',
                      feedbackIfSelected: '改写计数不会增加真实资源，因此仍然会超分配。',
                    },
                  ],
                  correctOptionId: 'B',
                  debrief:
                    '新增截止要求使等待不再可行，但备用处理器拥有独立容量；因此责任转移到备用处理器，原处理器的配额边界仍然成立。',
                },
              },
            }
          : null;
      const informalCheck =
        slot.learnerActionRequired && !workedProcess
          ? objective?.construct === 'identify' ||
            (input.courseDesign !== undefined && selectedDepth !== 'pass_oriented')
            ? {
                kind: 'choose_alternative' as const,
                reasoningOperation: 'judge_tradeoff' as const,
                decisiveCondition: '请求必须在5秒内完成；甲耗时2秒错误率1%，乙耗时20秒错误率0%。',
                evidenceContrast: {
                  evidence: '请求必须在5秒内完成',
                  replacement: '请求无完成时限，唯一目标是最低错误率',
                  alternativeOptionId: 'B',
                },
                requiredInference: '选择甲并记录误差风险，因为乙无法满足截止约束。',
                prompt: `给“${topic}”增加一个补充比较案例：请求必须在5秒内完成。方案甲耗时2秒、错误率1%；乙耗时20秒、错误率0%。这次应选择哪个方案？`,
                expectedSignal: '截止条件使乙不可行；甲仍有误差，因此需要同时记录风险。',
                options: [
                  {
                    id: 'A',
                    text: '选择甲，完成请求并明确保留的误差风险。',
                    feedbackIfSelected: '甲能在窗口内完成，因此满足时限；1%的误差仍需被明确管理。',
                  },
                  {
                    id: 'B',
                    text: '选择乙，只要错误率为零就可以忽略完成时间。',
                    feedbackIfSelected: '20秒会错过5秒的窗口，因此最高准确率不能满足本次全部约束。',
                  },
                ],
                correctOptionId: 'A',
              }
            : {
                reasoningOperation: 'predict_outcome' as const,
                decisiveCondition: '原来的必要条件被移除，机制的其余步骤保持不变。',
                requiredInference: '依赖被移除条件的那次状态转换不再有依据。',
                kind:
                  objective?.construct === 'apply'
                    ? ('apply_simple_example' as const)
                    : selectedDepth === 'pass_oriented'
                      ? ('own_words' as const)
                      : ('predict_next' as const),
                prompt:
                  objective?.construct === 'apply'
                    ? `换到一个没有讲过的“${topic}”案例：一项关键条件已经被移除。请预测后果，选择下一项有依据的动作，并说明原因。`
                    : selectedDepth === 'pass_oriented'
                      ? `请用自己的话说明“${topic}”中哪个条件会影响结果。`
                      : `换到一个没有讲过的“${topic}”情境：如果移除一项关键条件，接下来最可能发生什么，为什么？`,
                expectedSignal:
                  selectedDepth === 'pass_oriented'
                    ? '用自己的话把关键条件与结果连接起来。'
                    : '先预测变化，再用条件、机制和后果组成完整的因果解释。',
              }
          : undefined;
      const base = {
        slotId: slot.slotId,
        explanation:
          slot.qualityContract === 'orientation'
            ? `先从一个实际问题开始：当“${topic}”背后的关键条件改变时，什么会随之改变？先抓住中心模型——不要把事实分开背，而要沿着“条件如何启动机制、机制如何产生结果”来理解。${depthInvestment}${focusInvestment}`
            : sourceText
              ? `带着这个问题来看，资料给出了关于“${topic}”的这项限定事实：${sourceText}`
              : `辅助图示提供了一种理解“${topic}”的方式，但它属于补充讲解，不是资料证据。`,
        sourceRefs: slot.qualityContract === 'orientation' ? [] : sourceRefs,
        visualRefs,
        semanticRelations,
        workedProcess,
        ...(informalCheck ? { informalCheck } : {}),
      };
      if (slot.role === 'worked_example') {
        return {
          ...base,
          example: {
            text: workedProcess
              ? `把刚才的过程完整走一遍：起点给出当前状态、输入和限制；第一步先检查哪个条件适用，得到可执行动作的范围；第二步执行有依据的动作，观察中间状态怎样改变；最后再检查结果是否仍满足原来的限制。如果省略第一步，表面合理的动作可能在这个案例中根本不适用。`
              : `设想一个具体的“${topic}”案例：起点给出两个表面相似、但关键条件不同的候选。先用中心模型判断哪个条件会启动机制，再追踪它造成的中间变化，最后预测结果；如果移除那个条件，原结论也必须随之改变。`,
            sourceRefs: [],
            visualRefs,
          },
        };
      }
      if (slot.role === 'contrast') {
        return {
          ...base,
          contrast: {
            text: `对“${topic}”的可靠解释会用支配条件和中间机制预测结果；表面相似的回答只会重复标签。边界就在这里：条件不成立时，不能沿用原来的结论。`,
            sourceRefs: [],
            visualRefs,
          },
        };
      }
      if (slot.role === 'misconception') {
        return {
          ...base,
          misconception: {
            hypothesis: `学习者可能只重复“${topic}”的标签，却没有使用资料所述的边界。`,
            correction:
              '回到支配条件，先说明它怎样启动机制，再说明机制怎样造成结果；最后改变该条件，检验原结论是否仍然成立。',
            sourceRefs: [],
            visualRefs,
          },
        };
      }
      return base;
    }),
  });
  return payload;
}

/** A finite equivalent wording set; candidate keys never decide which feedback is true. */
function allowConciseFeedback(
  expected: LessonSlotContentProposalPayload,
  candidate: LessonSlotContentProposalPayload,
) {
  for (const slot of expected.slots) {
    const actual = candidate.slots.find(({ slotId }) => slotId === slot.slotId);
    const interaction = slot.workedProcess?.interaction;
    const actualInteraction = actual?.workedProcess?.interaction;
    const pairs = [
      [slot.informalCheck, actual?.informalCheck],
      [interaction?.activity, actualInteraction?.activity],
      [interaction?.scaffold, actualInteraction?.scaffold],
      [interaction?.transfer, actualInteraction?.transfer],
    ] as const;
    for (const [action, actualAction] of pairs) {
      if (!action?.options || !actualAction?.options) continue;
      for (const option of action.options) {
        const feedback = actualAction.options.find(
          ({ id }) => id === option.id,
        )?.feedbackIfSelected;
        if (feedback === (option.id === action.correctOptionId ? '对。' : '不对。'))
          option.feedbackIfSelected = feedback;
      }
    }
  }
}

/**
 * Rebuild expectations only from the current local plan and authorized sources.
 * Every authored field, including private declarations and unselected feedback,
 * must match a supported template. computedOutcomes is never a prose certificate.
 * No fuzzy recognition, arbitrary paraphrase acceptance, or general fact solver.
 */
export function reviewFakeLessonFixture(input: LessonGroundingReviewInput): LessonGroundingResult {
  const candidate = LessonSlotContentProposalPayloadSchema.parse(input.candidate);
  const context: FixtureContext = {
    courseDesign: input.courseDesign,
    skeleton: { ...input.lessonPlan, objectives: input.objectives },
    sourceContext: { offers: input.sources },
    learningContext: input.learningContext,
  };
  const expected = createFakeLessonFixture(context);
  allowConciseFeedback(expected, candidate);
  const findings: LessonGroundingResult['findings'] = [];
  const unsupported = (itemId: string) =>
    findings.push({
      itemId,
      code: 'insufficient_evidence',
      problem:
        'The complete teaching claims differ from the controlled offline fixture for the current plan and authorized sources. Fake cannot verify these changed or unknown claims.',
      repairInstruction:
        'Restore the supported fixture, including its claims, keys and feedback, or obtain an actual grounding review from a provider that can verify this content.',
    });
  if (!isDeepStrictEqual(candidate.narrative, expected.narrative)) unsupported('lesson.narrative');
  const ids = expected.slots.map(({ slotId }) => slotId);
  if (
    !isDeepStrictEqual(
      candidate.slots.map(({ slotId }) => slotId),
      ids,
    )
  )
    unsupported('lesson.narrative');
  for (const slot of expected.slots) {
    const actual = candidate.slots.find(({ slotId }) => slotId === slot.slotId);
    const plan = input.lessonPlan.lessonSlots.find(({ slotId }) => slotId === slot.slotId)!;
    const sourceRef = plan.allowedSourceRefs[0];
    const source = input.sources.find((offer) => offer.sourceRef === sourceRef);
    if (
      sourceRef &&
      (!source ||
        !plan.objectiveRefs.some((ref) =>
          input.objectives.some(
            (objective) =>
              objective.objectiveRef === ref && objective.allowedSourceRefs.includes(sourceRef),
          ),
        ))
    )
      unsupported(slot.slotId);
    if (
      !sourceRef &&
      plan.allowedVisualRefs[0] &&
      !input.visualContext.offers.some((offer) => offer.referenceKey === plan.allowedVisualRefs[0])
    )
      unsupported(slot.slotId);
    // Capsule fixtures may be authored in smaller portions. Both full-plan and
    // single-slot variants contain the same fixed public cases and verified keys.
    const isolated = createFakeLessonFixture({
      ...context,
      skeleton: {
        ...context.skeleton,
        lessonSlots: context.skeleton.lessonSlots.filter(({ slotId }) => slotId === slot.slotId),
      },
    });
    allowConciseFeedback(isolated, candidate);
    const alternatives = [slot, isolated.slots[0]!].flatMap((known) => {
      const confined = confineTeachingCitations(
        { lesson: { slots: [known] }, practice: { items: [] } },
        {
          lesson: {
            sourceContext: {
              offers: input.sources,
              blockCount: input.sources.length,
              offerCount: input.sources.length,
              serializedBytes: 0,
              materialCount: 0,
              sectionCount: 0,
            },
          },
        },
      ).lesson.slots[0]!;
      return [known, confined].map((variant) => {
        const supported = structuredClone(variant);
        // Omitting an optional relation makes no new factual assertion. Existing
        // Lesson quality contracts own coverage; Fake must not add a richness gate.
        if (actual?.semanticRelations.length === 0) supported.semanticRelations = [];
        return supported;
      });
    });
    if (!alternatives.some((known) => isDeepStrictEqual(actual, known))) unsupported(slot.slotId);
  }
  return { decisions: [], findings: findings.slice(0, 30) };
}
