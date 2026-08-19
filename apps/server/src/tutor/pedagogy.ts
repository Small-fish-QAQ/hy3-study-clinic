import {
  TutorTurnPayloadSchema,
  type TutorPedagogicalMove,
  type TutorRecentMove,
  type TutorRouteSignal,
  type TutorSourceRef,
} from '@hy3-clinic/shared';
import type { TutorTurnInput } from '../llm/provider.js';
import type { ProviderCandidateValidation } from '../llm/provider.js';

/** Stable policy identifier stored with each accepted Tutor turn. */
export const TUTOR_PEDAGOGY_POLICY_VERSION = 'lesson-aware-v1';

/** Prompt budgets are deliberately independent of the full Study transcript. */
export const TUTOR_CONTEXT_LIMITS = {
  maxRecentExchanges: 8,
  maxExchangeChars: 1200,
  maxRecentMoves: 4,
  maxSourceRefs: 6,
  maxSourceExcerptChars: 900,
  maxSerializedBytes: 32_000,
} as const;

const confusionPattern =
  /^(?:\?|？|没懂|不懂|没理解|不明白|看不懂|太复杂|还是不清楚|不太会)[.!。！!？?\s]*$/iu;
const examplePattern = /举个例子|给个例子|例子|example|for example/iu;
const analogyPattern = /打个比方|类比|换个说法|换一种说法|通俗|直观点|analogy|simpler/iu;
const contrastPattern = /区别|不同|对比|差异|versus|区别是什么/iu;
const summaryPattern = /总结|概括|小结|要点|summary|summarize/iu;
const continuePattern = /^(?:继续|接着讲|下一段|往下|继续学习|continue|next)[.!。！!\s]*$/iu;
const whyPattern =
  /为什么|为何|怎么会|为什么会|why\b|how\b|如何|怎么做|怎样|什么是|什么叫|what\b/iu;
const directAnswerPattern = /直接告诉我答案|告诉我答案|just tell me the answer/iu;
const explicitSelfExplainPattern = /我来解释|让我解释|用自己的话|自我解释|先考我|self.?explain/iu;
const sideQuestionPattern = /顺便|另外|题外|相关的另一个|side question|顺带/iu;

export function inferRequestedTutorMove(message: string): TutorPedagogicalMove | null {
  const value = message.trim();
  if (continuePattern.test(value)) return 'RETURN_TO_ROUTE';
  if (examplePattern.test(value)) return 'GIVE_EXAMPLE';
  if (contrastPattern.test(value)) return 'CONTRAST';
  if (summaryPattern.test(value)) return 'SUMMARIZE';
  if (analogyPattern.test(value)) return 'SIMPLIFY';
  if (confusionPattern.test(value)) return 'SIMPLIFY';
  if (explicitSelfExplainPattern.test(value)) return 'SELF_EXPLANATION';
  if (sideQuestionPattern.test(value)) return 'DETOUR';
  if (directAnswerPattern.test(value) || whyPattern.test(value) || /[?？]/u.test(value)) {
    return 'ANSWER_QUESTION';
  }
  return null;
}

export function allowedTutorMoves(
  input: Pick<
    TutorTurnInput,
    'session' | 'lessonContext' | 'currentUnit' | 'formalCheckpointAvailable'
  >,
): TutorPedagogicalMove[] {
  const moves: TutorPedagogicalMove[] = [
    'TEACH_NEW',
    'EXPLAIN_DEEPER',
    'SIMPLIFY',
    'GIVE_EXAMPLE',
    'GIVE_ANALOGY',
    'CONTRAST',
    'ANSWER_QUESTION',
    'REPAIR_MISCONCEPTION',
    'ASK_INFORMAL_CHECK',
    'GUIDED_PRACTICE',
    'SELF_EXPLANATION',
    'SUMMARIZE',
  ];
  if (input.lessonContext || input.currentUnit) moves.push('DETOUR');
  // “继续” needs a safe route reconnect signal even when the route is
  // currently on-route and no database command is issued.
  moves.push('RETURN_TO_ROUTE');
  if (input.formalCheckpointAvailable) moves.push('FORMAL_CHECK_READY');
  return [...new Set(moves)];
}

function compatibleDirectMove(
  requested: TutorPedagogicalMove,
  actual: TutorPedagogicalMove,
): boolean {
  if (requested === actual) return true;
  if (requested === 'SIMPLIFY') return actual === 'GIVE_ANALOGY' || actual === 'EXPLAIN_DEEPER';
  if (requested === 'ANSWER_QUESTION')
    return actual === 'EXPLAIN_DEEPER' || actual === 'REPAIR_MISCONCEPTION';
  if (requested === 'RETURN_TO_ROUTE')
    return actual === 'TEACH_NEW' || actual === 'RETURN_TO_ROUTE';
  return false;
}

function fallbackMove(
  input: Pick<TutorTurnInput, 'lessonContext' | 'currentUnit' | 'recentMoves'>,
): TutorPedagogicalMove {
  const last = input.recentMoves.at(-1)?.move;
  if (last === 'SIMPLIFY' || last === 'EXPLAIN_DEEPER') {
    if (input.lessonContext?.currentSegment.example || input.currentUnit) return 'GIVE_EXAMPLE';
    return 'GIVE_ANALOGY';
  }
  if (last === 'GIVE_EXAMPLE') return 'CONTRAST';
  if (last === 'SELF_EXPLANATION') return 'GIVE_EXAMPLE';
  return 'ANSWER_QUESTION';
}

export interface TutorTurnPolicyResult {
  move: TutorPedagogicalMove;
  routeSignal: TutorRouteSignal;
  lessonSegmentIndex: number | null;
  sourceRefs: string[];
}

/**
 * Local semantic guard. It is intentionally small: identity, authority,
 * repetition, and direct-request constraints are deterministic; the model
 * still writes the natural-language explanation.
 */
export function validateTutorTurnCandidate(
  candidate: unknown,
  input: TutorTurnInput,
): ProviderCandidateValidation {
  const parsed = TutorTurnPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      valid: false,
      diagnostics: ['Tutor structured output failed the runtime contract.'],
      diagnosticCodes: ['TUTOR_SCHEMA_INVALID'],
    };
  }
  const value = parsed.data;
  const diagnostics: string[] = [];
  const codes: string[] = [];
  if (!input.allowedMoves.includes(value.move)) {
    diagnostics.push('Selected pedagogical move is not allowed in the current route.');
    codes.push('TUTOR_MOVE_NOT_ALLOWED');
  }
  const offered = new Set(input.offeredSourceRefs.map((ref) => ref.referenceKey));
  if (value.sourceRefs.some((ref) => !offered.has(ref))) {
    diagnostics.push(
      'Every sourceRefs entry must be one of the offered operation-local references.',
    );
    codes.push('TUTOR_SOURCE_REF_UNKNOWN');
  }
  const requested = inferRequestedTutorMove(input.learnerMessage);
  if (requested && !compatibleDirectMove(requested, value.move)) {
    diagnostics.push(
      `Direct learner intent requires a compatible pedagogical move (${requested}).`,
    );
    codes.push('TUTOR_DIRECT_INTENT_MISMATCH');
  }
  const previous = input.recentMoves.at(-1)?.move;
  if (
    previous === value.move &&
    value.move === 'SELF_EXPLANATION' &&
    !explicitSelfExplainPattern.test(input.learnerMessage)
  ) {
    diagnostics.push(
      'Do not repeat SELF_EXPLANATION after the same move without an explicit request.',
    );
    codes.push('TUTOR_REPEATED_SELF_EXPLANATION');
  }
  if (value.move === 'FORMAL_CHECK_READY' && !input.formalCheckpointAvailable) {
    diagnostics.push(
      'FORMAL_CHECK_READY is unavailable because no launchable checkpoint is offered.',
    );
    codes.push('TUTOR_FORMAL_CHECK_UNAVAILABLE');
  }
  if (diagnostics.length > 0) {
    return { valid: false, diagnostics, diagnosticCodes: codes };
  }
  return { valid: true, diagnostics: [], diagnosticCodes: [] };
}

/** Apply only deterministic policy corrections that are safe to make locally. */
export function constrainTutorTurn(
  payload: ReturnType<typeof TutorTurnPayloadSchema.parse>,
  input: TutorTurnInput,
): ReturnType<typeof TutorTurnPayloadSchema.parse> {
  const requested = inferRequestedTutorMove(input.learnerMessage);
  let move = payload.move;
  if (requested && !compatibleDirectMove(requested, move)) move = requested;
  if (!input.allowedMoves.includes(move)) move = fallbackMove(input);
  if (
    input.recentMoves.at(-1)?.move === move &&
    move === 'SELF_EXPLANATION' &&
    !explicitSelfExplainPattern.test(input.learnerMessage)
  ) {
    move = fallbackMove(input);
  }
  if (move === 'FORMAL_CHECK_READY' && !input.formalCheckpointAvailable) move = fallbackMove(input);
  const offered = new Set(input.offeredSourceRefs.map((ref) => ref.referenceKey));
  if (payload.sourceRefs.some((ref) => !offered.has(ref))) {
    // Unknown identity is an authority failure, not something to guess away.
    throw new Error('Tutor response referenced an unknown source ref.');
  }
  const routeSignal: TutorRouteSignal =
    move === 'DETOUR'
      ? 'detour_started'
      : move === 'RETURN_TO_ROUTE'
        ? 'return_to_route'
        : 'stay_on_route';
  return {
    ...payload,
    move,
    routeSignal,
  };
}

export function tutorSourceOffers(
  lessonContext: TutorTurnInput['lessonContext'],
  currentUnit: TutorTurnInput['currentUnit'],
): TutorSourceRef[] {
  const offers: TutorSourceRef[] = [];
  for (const source of lessonContext?.sources ?? []) {
    offers.push({
      referenceKey: source.referenceKey,
      excerpt: source.exactExcerpt.slice(0, TUTOR_CONTEXT_LIMITS.maxSourceExcerptChars),
      origin: 'lesson',
    });
  }
  for (const [index, source] of (currentUnit?.sourceTruth ?? []).entries()) {
    if (offers.length >= TUTOR_CONTEXT_LIMITS.maxSourceRefs) break;
    offers.push({
      referenceKey: `U${index + 1}`,
      excerpt: source.contentExcerpt.slice(0, TUTOR_CONTEXT_LIMITS.maxSourceExcerptChars),
      origin: 'course_truth',
    });
  }
  return offers.slice(0, TUTOR_CONTEXT_LIMITS.maxSourceRefs);
}

export function tutorRecentMoves(
  turns: Array<{
    tutorMetadata?: { move: TutorPedagogicalMove; lessonSegmentIndex: number | null } | null;
  }>,
): TutorRecentMove[] {
  return turns
    .flatMap((turn) =>
      turn.tutorMetadata
        ? [{ move: turn.tutorMetadata.move, segmentIndex: turn.tutorMetadata.lessonSegmentIndex }]
        : [],
    )
    .slice(-TUTOR_CONTEXT_LIMITS.maxRecentMoves);
}

/**
 * Final deterministic prompt fence. The normal path is already bounded by
 * the lesson service; this second pass protects against unusually long
 * imported text or summaries without dumping the full Teaching Brief.
 */
export function boundTutorTurnInput(input: TutorTurnInput): TutorTurnInput {
  let bounded: TutorTurnInput = {
    ...input,
    recentExchanges: input.recentExchanges
      .slice(-TUTOR_CONTEXT_LIMITS.maxRecentExchanges)
      .map((exchange) => ({
        ...exchange,
        content: exchange.content.slice(-TUTOR_CONTEXT_LIMITS.maxExchangeChars),
      })),
    offeredSourceRefs: input.offeredSourceRefs
      .slice(0, TUTOR_CONTEXT_LIMITS.maxSourceRefs)
      .map((ref) => ({
        ...ref,
        excerpt: ref.excerpt.slice(0, TUTOR_CONTEXT_LIMITS.maxSourceExcerptChars),
      })),
  };
  if (JSON.stringify(bounded).length <= TUTOR_CONTEXT_LIMITS.maxSerializedBytes) return bounded;

  bounded = {
    ...bounded,
    recentExchanges: bounded.recentExchanges.slice(-4),
    lessonContext: bounded.lessonContext
      ? {
          ...bounded.lessonContext,
          currentSegment: {
            ...bounded.lessonContext.currentSegment,
            explanation: bounded.lessonContext.currentSegment.explanation.slice(0, 900),
            example: bounded.lessonContext.currentSegment.example?.slice(0, 300) ?? null,
            contrast: bounded.lessonContext.currentSegment.contrast?.slice(0, 300) ?? null,
            possibleMisconception:
              bounded.lessonContext.currentSegment.possibleMisconception?.slice(0, 300) ?? null,
          },
          nearbySegments: bounded.lessonContext.nearbySegments.map((segment) => ({
            ...segment,
            preview: segment.preview.slice(0, 120),
          })),
          sources: bounded.lessonContext.sources
            .slice(0, 2)
            .map((source) => ({ ...source, exactExcerpt: source.exactExcerpt.slice(0, 500) })),
          visuals: (bounded.lessonContext.visuals ?? []).slice(0, 2).map((visual) => ({
            ...visual,
            explanation: {
              ...visual.explanation,
              text: visual.explanation.text.slice(0, 500),
              importantConcepts: visual.explanation.importantConcepts.slice(0, 3),
              pedagogicalNotes: visual.explanation.pedagogicalNotes.slice(0, 2),
              uncertainty: visual.explanation.uncertainty.slice(0, 2),
            },
          })),
          summary: bounded.lessonContext.summary?.slice(0, 300) ?? null,
          nextConnection: bounded.lessonContext.nextConnection?.slice(0, 200) ?? null,
        }
      : null,
    currentUnit: bounded.currentUnit
      ? {
          ...bounded.currentUnit,
          sourceTruth: bounded.currentUnit.sourceTruth
            .slice(0, 3)
            .map((source) => ({ ...source, contentExcerpt: source.contentExcerpt.slice(0, 500) })),
        }
      : null,
  };
  if (JSON.stringify(bounded).length <= TUTOR_CONTEXT_LIMITS.maxSerializedBytes) return bounded;
  return {
    ...bounded,
    recentExchanges: bounded.recentExchanges.slice(-2),
    offeredSourceRefs: bounded.offeredSourceRefs.slice(0, 3),
    lessonContext: bounded.lessonContext ? { ...bounded.lessonContext, visuals: [] } : null,
  };
}
