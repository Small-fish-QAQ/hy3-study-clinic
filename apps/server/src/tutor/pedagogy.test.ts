import { describe, expect, it } from 'vitest';
import type { TutorTurnInput } from '../llm/provider.js';
import {
  allowedTutorMoves,
  constrainTutorTurn,
  inferRequestedTutorMove,
  tutorRecentMoves,
  tutorSourceOffers,
  validateTutorTurnCandidate,
} from './pedagogy.js';

function input(
  message: string,
  recentMoves: TutorTurnInput['recentMoves'] = [],
  formal = true,
): TutorTurnInput {
  const base = {
    id: 'session_1',
    routeState: 'on_route' as const,
    currentAgendaItemId: 'agenda_1',
    currentAgendaItem: {
      kind: 'teach_unit',
      reason: 'Explain the current segment.',
      learningUnitId: 'unit_1',
    },
  };
  const lessonContext = {
    objective: { title: 'Current objective', whyNow: 'It is next on the route.' },
    currentSegment: {
      index: 2,
      purpose: 'explanation' as const,
      explanation: 'A bounded explanation.',
      explanationOrigin: 'source_grounded' as const,
      example: 'A concrete example.',
      contrast: null,
      possibleMisconception: null,
      informalCheck: null,
    },
    nearbySegments: [],
    sources: [
      {
        referenceKey: 'S1',
        materialTitle: 'Notes',
        headingPath: [],
        pageNumber: null,
        locationLabel: 'p. 1',
        exactExcerpt: 'Exact source excerpt.',
        classification: 'exact_source_excerpt' as const,
      },
    ],
    summary: null,
    nextConnection: null,
  };
  const allowed = allowedTutorMoves({
    session: base,
    lessonContext,
    currentUnit: null,
    formalCheckpointAvailable: formal,
  });
  return {
    workspaceName: 'Course',
    learnerMessage: message,
    session: base,
    summary: null,
    lessonContext,
    currentUnit: null,
    allowedMoves: allowed,
    recentMoves,
    formalCheckpointAvailable: formal,
    offeredSourceRefs: [{ referenceKey: 'S1', excerpt: 'Exact source excerpt.', origin: 'lesson' }],
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

function payload(move: TutorTurnInput['allowedMoves'][number], sourceRefs: string[] = []) {
  return {
    move,
    text: 'A bounded tutor response.',
    sourceRefs,
    routeSignal: 'stay_on_route' as const,
    summaryDelta: {
      learnerQuestions: [],
      unresolvedConfusion: [],
      explanationsTried: [],
      learnerReactions: [],
      openActions: [],
      safetyFlags: [],
    },
    suggestedActions: [],
  };
}

describe('lesson-aware Tutor pedagogy policy', () => {
  it.each([
    ['?', 'SIMPLIFY'],
    ['没懂', 'SIMPLIFY'],
    ['举个例子', 'GIVE_EXAMPLE'],
    ['换个说法', 'SIMPLIFY'],
    ['A 和 B 有什么区别', 'CONTRAST'],
    ['为什么会这样？', 'ANSWER_QUESTION'],
    ['直接告诉我答案', 'ANSWER_QUESTION'],
    ['总结一下', 'SUMMARIZE'],
    ['继续', 'RETURN_TO_ROUTE'],
    ['顺便问个相关问题', 'DETOUR'],
  ] as const)('honors direct learner intent: %s → %s', (message, expected) => {
    expect(inferRequestedTutorMove(message)).toBe(expected);
    const turnInput = input(message);
    const check = validateTutorTurnCandidate(
      payload(expected, expected === 'ANSWER_QUESTION' ? ['S1'] : []),
      turnInput,
    );
    expect(check.valid).toBe(true);
  });

  it('rejects unknown source identity and unavailable formal readiness', () => {
    const unknown = validateTutorTurnCandidate(
      payload('ANSWER_QUESTION', ['foreign']),
      input('为什么？'),
    );
    expect(unknown.valid).toBe(false);
    expect(unknown.diagnosticCodes).toContain('TUTOR_SOURCE_REF_UNKNOWN');
    const advisoryVisual = input('为什么？');
    advisoryVisual.lessonContext!.visuals = [
      {
        referenceKey: 'V1',
        materialTitle: 'Diagram',
        source: {
          sourceKind: 'embedded',
          mediaType: 'image/png',
          width: 320,
          height: 200,
          location: { pageNumber: 1, slideNumber: null, contextLabel: 'Page 1' },
          authority: 'original_visual',
        },
        explanation: {
          text: 'Hy3 describes a capacity diagram.',
          visualType: 'diagram',
          importantConcepts: ['capacity'],
          pedagogicalNotes: [],
          uncertainty: [],
          contentOrigin: 'derived_visual_description',
          provenanceCategory: 'generated_visual_explanation',
          authority: 'advisory',
          evidenceAdmissibility: 'advisory_nonblocking',
          formalEvidenceEligible: false,
        },
      },
    ];
    const visualCitation = validateTutorTurnCandidate(
      payload('ANSWER_QUESTION', ['V1']),
      advisoryVisual,
    );
    expect(visualCitation.valid).toBe(false);
    expect(visualCitation.diagnosticCodes).toContain('TUTOR_SOURCE_REF_UNKNOWN');
    expect(tutorSourceOffers(advisoryVisual.lessonContext, null)).toEqual([
      { referenceKey: 'S1', excerpt: 'Exact source excerpt.', origin: 'lesson' },
    ]);
    const unavailable = validateTutorTurnCandidate(
      payload('FORMAL_CHECK_READY'),
      input('继续', [], false),
    );
    expect(unavailable.valid).toBe(false);
    expect(unavailable.diagnosticCodes).toContain('TUTOR_FORMAL_CHECK_UNAVAILABLE');
  });

  it('prevents a mechanical repeated self-explanation move and chooses another scaffold', () => {
    const turnInput = input('没懂', [{ move: 'SELF_EXPLANATION', segmentIndex: 2 }]);
    const candidate = payload('SELF_EXPLANATION');
    const check = validateTutorTurnCandidate(candidate, turnInput);
    expect(check.valid).toBe(false);
    expect(check.diagnosticCodes).toContain('TUTOR_DIRECT_INTENT_MISMATCH');
    expect(constrainTutorTurn(candidate, turnInput).move).toBe('SIMPLIFY');
  });

  it('derives recent moves and source offers within bounded windows', () => {
    const turns = Array.from({ length: 8 }, (_, i) => ({
      tutorMetadata: { move: 'GIVE_EXAMPLE' as const, lessonSegmentIndex: i },
    }));
    expect(tutorRecentMoves(turns)).toHaveLength(4);
    expect(tutorSourceOffers(input('?', []).lessonContext, null)).toEqual([
      { referenceKey: 'S1', excerpt: 'Exact source excerpt.', origin: 'lesson' },
    ]);
  });
});
