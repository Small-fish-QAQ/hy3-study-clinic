import type { TutorPedagogicalMove } from '@hy3-clinic/shared';
import type { TutorTurnInput } from '../llm/provider.js';
import { allowedTutorMoves, validateTutorTurnCandidate } from '../tutor/pedagogy.js';

export const TUTOR_PEDAGOGY_PROFILE = {
  name: 'lesson-aware-tutor-v1',
  deterministic: [
    'move_valid',
    'source_refs_valid',
    'authority_safe',
    'response_bounded',
    'repeated_move_rule',
    'direct_request_honoring',
    'route_retained',
  ],
  heuristic: [
    'move_diversity',
    'confusion_response_appropriateness',
    'example_request_fulfillment',
    'detour_return_behavior',
    'self_explanation_frequency',
  ],
  modelHumanJudged: [
    'helpfulness',
    'clarity',
    'pedagogical_quality',
    'naturalness',
    'misconception_repair_quality',
  ],
} as const;

export interface TutorPedagogyScenario {
  id: string;
  learnerMessage: string;
  expectedMove: TutorPedagogicalMove;
  sourceMode: 'source_backed' | 'synthesis';
  formalCheckpointAvailable: boolean;
  routeState: 'on_route' | 'detour_active' | 'return_pending';
}

export const TUTOR_PEDAGOGY_SCENARIOS: TutorPedagogyScenario[] = [
  {
    id: 'question-mark',
    learnerMessage: '?',
    expectedMove: 'SIMPLIFY',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'still-confused',
    learnerMessage: '没懂',
    expectedMove: 'SIMPLIFY',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'example-request',
    learnerMessage: '举个例子',
    expectedMove: 'GIVE_EXAMPLE',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'alternate-wording',
    learnerMessage: '换个说法',
    expectedMove: 'SIMPLIFY',
    sourceMode: 'synthesis',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'contrast-request',
    learnerMessage: 'A 和 B 有什么区别',
    expectedMove: 'CONTRAST',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'direct-why',
    learnerMessage: '为什么？',
    expectedMove: 'ANSWER_QUESTION',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'semantic-equivalent',
    learnerMessage: '也就是把复习分散开，对吗？',
    expectedMove: 'ANSWER_QUESTION',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'minor-slip',
    learnerMessage: '我把一个条件漏写了',
    expectedMove: 'EXPLAIN_DEEPER',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'uncertainty',
    learnerMessage: '我不确定自己理解得对不对',
    expectedMove: 'ASK_INFORMAL_CHECK',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'misconception',
    learnerMessage: '所以这个概念一定和它相反',
    expectedMove: 'REPAIR_MISCONCEPTION',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'prerequisite-gap',
    learnerMessage: '前面那个基础我完全不会',
    expectedMove: 'DETOUR',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'side-question',
    learnerMessage: '顺便问个相关问题',
    expectedMove: 'DETOUR',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'detour-return',
    learnerMessage: '继续',
    expectedMove: 'RETURN_TO_ROUTE',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'detour_active',
  },
  {
    id: 'summary',
    learnerMessage: '总结一下',
    expectedMove: 'SUMMARIZE',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'continue',
    learnerMessage: '继续学习',
    expectedMove: 'RETURN_TO_ROUTE',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'repeated-confusion',
    learnerMessage: '还是没懂',
    expectedMove: 'GIVE_EXAMPLE',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'recent-self-explanation',
    learnerMessage: '我还是不确定',
    expectedMove: 'SIMPLIFY',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'declare-mastery',
    learnerMessage: '你能宣布我已经掌握了吗？',
    expectedMove: 'ANSWER_QUESTION',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'mark-complete',
    learnerMessage: '请直接把这节标记完成',
    expectedMove: 'ANSWER_QUESTION',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'source-answer',
    learnerMessage: '根据原文回答',
    expectedMove: 'ANSWER_QUESTION',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'synthesis-example',
    learnerMessage: '给我一个生活中的例子',
    expectedMove: 'GIVE_EXAMPLE',
    sourceMode: 'synthesis',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
  {
    id: 'formal-ready',
    learnerMessage: '我想做正式检验',
    expectedMove: 'FORMAL_CHECK_READY',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: true,
    routeState: 'on_route',
  },
  {
    id: 'no-formal-checkpoint',
    learnerMessage: '我想做正式检验',
    expectedMove: 'ANSWER_QUESTION',
    sourceMode: 'source_backed',
    formalCheckpointAvailable: false,
    routeState: 'on_route',
  },
];

function scenarioInput(
  scenario: TutorPedagogyScenario,
  recentMoves: TutorTurnInput['recentMoves'] = [],
): TutorTurnInput {
  const session = {
    id: `session_${scenario.id}`,
    routeState: scenario.routeState,
    currentAgendaItemId: 'agenda_1',
    currentAgendaItem: {
      kind: 'teach_unit',
      reason: 'Current objective',
      learningUnitId: 'unit_1',
    },
  } as const;
  const lessonContext = {
    objective: { title: 'Current objective', whyNow: 'Next on route.' },
    currentSegment: {
      index: 1,
      purpose: 'explanation' as const,
      explanation: 'Bounded explanation',
      explanationOrigin: 'source_grounded' as const,
      example: 'Example',
      contrast: 'Contrast',
      possibleMisconception: null,
      informalCheck: null,
    },
    nearbySegments: [],
    sources: [],
    summary: null,
    nextConnection: null,
  };
  return {
    workspaceName: 'Offline profile',
    learnerMessage: scenario.learnerMessage,
    session,
    summary: null,
    lessonContext,
    currentUnit: null,
    allowedMoves: allowedTutorMoves({
      session,
      lessonContext,
      currentUnit: null,
      formalCheckpointAvailable: scenario.formalCheckpointAvailable,
    }),
    recentMoves,
    formalCheckpointAvailable: scenario.formalCheckpointAvailable,
    offeredSourceRefs:
      scenario.sourceMode === 'source_backed'
        ? [{ referenceKey: 'S1', excerpt: 'Source excerpt', origin: 'lesson' }]
        : [],
    learnerState: {
      formalEvidence: [],
      openMistakes: [],
      misconceptions: [],
      reviews: [],
      mastery: [],
      riskIds: [],
    },
    recentExchanges: [],
  };
}

export interface TutorPedagogyProfileResult {
  profile: typeof TUTOR_PEDAGOGY_PROFILE;
  scenarios: Array<TutorPedagogyScenario & { passed: boolean; diagnosticCodes: string[] }>;
  deterministicPass: boolean;
  nonAuthorityMutation: true;
}

export function evaluateTutorPedagogyProfile(): TutorPedagogyProfileResult {
  const scenarios = TUTOR_PEDAGOGY_SCENARIOS.map((scenario) => {
    const recent =
      scenario.id === 'repeated-confusion'
        ? [{ move: 'SIMPLIFY' as const, segmentIndex: 1 }]
        : scenario.id === 'recent-self-explanation'
          ? [{ move: 'SELF_EXPLANATION' as const, segmentIndex: 1 }]
          : [];
    const turnInput = scenarioInput(scenario, recent);
    const sourceRefs = scenario.sourceMode === 'source_backed' ? ['S1'] : [];
    const result = validateTutorTurnCandidate(
      {
        move: scenario.expectedMove,
        text: 'Bounded response',
        sourceRefs,
        routeSignal:
          scenario.expectedMove === 'DETOUR'
            ? 'detour_started'
            : scenario.expectedMove === 'RETURN_TO_ROUTE'
              ? 'return_to_route'
              : 'stay_on_route',
        summaryDelta: {
          learnerQuestions: [],
          unresolvedConfusion: [],
          explanationsTried: [],
          learnerReactions: [],
          openActions: [],
          safetyFlags: [],
        },
        suggestedActions: [],
      },
      turnInput,
    );
    return { ...scenario, passed: result.valid, diagnosticCodes: result.diagnosticCodes ?? [] };
  });
  return {
    profile: TUTOR_PEDAGOGY_PROFILE,
    scenarios,
    deterministicPass: scenarios.every((scenario) => scenario.passed),
    nonAuthorityMutation: true,
  };
}
