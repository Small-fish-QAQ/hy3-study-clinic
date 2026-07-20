import { describe, expect, it } from 'vitest';
import {
  guessConceptLanguage,
  isMisconceptionTransitionAllowed,
  MISCONCEPTION_TRANSITIONS,
  normalizeConceptKey,
  QuestionSchema,
  QuizSchema,
  ratingForScore,
  TutorStepPayloadSchema,
  type MisconceptionStatus,
} from '../index.js';

describe('normalizeConceptKey', () => {
  it('collapses whitespace, case and punctuation so spelling variants collide', () => {
    expect(normalizeConceptKey('Spaced repetition')).toBe(normalizeConceptKey('Spacedrepetition'));
    expect(normalizeConceptKey('Working Memory')).toBe(normalizeConceptKey('working memory'));
    expect(normalizeConceptKey('工作记忆')).toBe(normalizeConceptKey('工作 记忆')); // stray space
    expect(normalizeConceptKey('长时记忆(LTM)')).toBe(normalizeConceptKey('长时记忆LTM'));
  });

  it('applies safe plural folding only to Latin-only tokens of length >= 4', () => {
    expect(normalizeConceptKey('concepts')).toBe(normalizeConceptKey('concept'));
    expect(normalizeConceptKey('processes')).toBe(normalizeConceptKey('process'));
    expect(normalizeConceptKey('as')).toBe('as'); // too short to fold
  });

  it('never translates: bilingual names produce different keys', () => {
    expect(normalizeConceptKey('工作记忆')).not.toBe(normalizeConceptKey('Working memory'));
  });

  it('is deterministic and NFKC-normalized', () => {
    expect(normalizeConceptKey('Ｗｏｒｋｉｎｇ ｍｅｍｏｒｙ')).toBe(
      normalizeConceptKey('working memory'),
    );
  });
});

describe('guessConceptLanguage', () => {
  it('classifies zh / en / mixed / unknown', () => {
    expect(guessConceptLanguage('工作记忆')).toBe('zh');
    expect(guessConceptLanguage('Working memory')).toBe('en');
    expect(guessConceptLanguage('BM25 算法')).toBe('mixed');
    expect(guessConceptLanguage('123')).toBe('unknown');
  });
});

describe('misconception transition table', () => {
  const ALL: MisconceptionStatus[] = ['proposed', 'confirmed', 'rejected', 'resolved'];

  it('allows exactly the documented transitions', () => {
    expect(MISCONCEPTION_TRANSITIONS.proposed).toEqual(['confirmed', 'rejected']);
    expect(MISCONCEPTION_TRANSITIONS.confirmed).toEqual(['resolved']);
    expect(MISCONCEPTION_TRANSITIONS.rejected).toEqual([]);
    expect(MISCONCEPTION_TRANSITIONS.resolved).toEqual([]);
  });

  it('rejects every transition not in the table (exhaustive)', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const allowed = MISCONCEPTION_TRANSITIONS[from].includes(to);
        expect(isMisconceptionTransitionAllowed(from, to), `${from}→${to}`).toBe(allowed);
      }
    }
  });
});

describe('ratingForScore', () => {
  it('maps scores to ratings with documented boundaries', () => {
    expect(ratingForScore(0)).toBe('again');
    expect(ratingForScore(0.59)).toBe('again');
    expect(ratingForScore(0.6)).toBe('hard');
    expect(ratingForScore(0.74)).toBe('hard');
    expect(ratingForScore(0.75)).toBe('good');
    expect(ratingForScore(0.89)).toBe('good');
    expect(ratingForScore(0.9)).toBe('easy');
    expect(ratingForScore(1)).toBe('easy');
    expect(ratingForScore(Number.NaN)).toBe('again');
  });
});

describe('concept_comparison question schema', () => {
  const base = {
    id: 'que_1',
    quizId: 'qz_1',
    index: 0,
    stem: '比较两份资料对「工作记忆」的表述。',
    conceptId: 'con_1',
    conceptName: '工作记忆',
    grounding: {
      blockId: 'blk_1',
      quote: '工作记忆的容量十分有限。',
      startOffset: 0,
      endOffset: 12,
      occurrenceCount: 1,
      reanchored: false,
    },
    explanation: '两份资料互补。',
    points: 3,
  };

  it('requires expectedAnswer and rubric like short_answer', () => {
    expect(QuestionSchema.safeParse({ ...base, type: 'concept_comparison' }).success).toBe(false);
    expect(
      QuestionSchema.safeParse({
        ...base,
        type: 'concept_comparison',
        expectedAnswer: '两处均指出容量有限。',
        rubric: { keyPoints: ['容量有限'] },
      }).success,
    ).toBe(true);
  });

  it('rejects choice fields on comparison questions', () => {
    expect(
      QuestionSchema.safeParse({
        ...base,
        type: 'concept_comparison',
        expectedAnswer: 'x',
        rubric: { keyPoints: ['x'] },
        options: [
          { id: 'A', text: 'a' },
          { id: 'B', text: 'b' },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('workspace quiz schema', () => {
  const question = {
    id: 'que_1',
    quizId: 'qz_1',
    index: 0,
    type: 'single_choice',
    stem: '题干',
    options: [
      { id: 'A', text: 'a' },
      { id: 'B', text: 'b' },
    ],
    correctOptionIds: ['A'],
    conceptId: 'con_1',
    conceptName: '概念',
    grounding: {
      blockId: 'blk_1',
      quote: '引文。',
      startOffset: 0,
      endOffset: 3,
      occurrenceCount: 1,
      reanchored: false,
    },
    explanation: '解析',
    points: 1,
  };
  const base = {
    id: 'qz_1',
    config: { difficulty: 'medium', types: ['single_choice'], countPerType: 1 },
    questions: [question],
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('adaptive quizzes require workspaceId and allow null materialId', () => {
    expect(QuizSchema.safeParse({ ...base, kind: 'adaptive', materialId: null }).success).toBe(
      false,
    );
    expect(
      QuizSchema.safeParse({ ...base, kind: 'adaptive', materialId: null, workspaceId: 'ws_1' })
        .success,
    ).toBe(true);
  });

  it('document quizzes still require materialId', () => {
    expect(QuizSchema.safeParse({ ...base, kind: 'standard', materialId: null }).success).toBe(
      false,
    );
    expect(QuizSchema.safeParse({ ...base, kind: 'standard', materialId: 'mat_1' }).success).toBe(
      true,
    );
  });
});

describe('tutor step payload schema', () => {
  it('accepts a whitelisted tool call and rejects unknown tools', () => {
    expect(
      TutorStepPayloadSchema.safeParse({
        action: 'call_tool',
        tool: 'inspect_learning_state',
        arguments: { conceptId: 'con_1' },
        purpose: '查看状态',
      }).success,
    ).toBe(true);
    expect(
      TutorStepPayloadSchema.safeParse({
        action: 'call_tool',
        tool: 'run_shell_command',
        arguments: { cmd: 'rm -rf /' },
        purpose: 'x',
      }).success,
    ).toBe(false);
  });
});
