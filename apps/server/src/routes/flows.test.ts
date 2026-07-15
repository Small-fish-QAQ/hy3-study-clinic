import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_MATERIAL_CONTENT, type PublicQuiz, type Question } from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * End-to-end integration tests for both core flows, entirely in fake mode
 * (no network, no API key):
 *
 * Flow A: import → segmentation → concept analysis → grounded quiz
 *         generation → (interactive answering happens client-side)
 * Flow B: submission → grading → mistake notebook → targeted remediation →
 *         mastery updates
 */

let ctx: TestApp;

beforeEach(() => {
  ctx = buildTestApp();
});

afterEach(async () => {
  await ctx.app.close();
});

async function importSample(): Promise<{ materialId: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/materials',
    payload: { content: SAMPLE_MATERIAL_CONTENT, filename: 'sample.md' },
  });
  expect(res.statusCode).toBe(201);
  return { materialId: res.json().material.id };
}

async function generateQuiz(materialId: string): Promise<PublicQuiz> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/quizzes',
    payload: {
      materialId,
      config: {
        difficulty: 'medium',
        types: ['single_choice', 'multiple_choice', 'short_answer'],
        countPerType: 2,
      },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().quiz as PublicQuiz;
}

describe('Flow A: material → analysis → grounded quiz', () => {
  it('analyzes concepts with verified grounding', async () => {
    const { materialId } = await importSample();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    expect(res.statusCode).toBe(200);
    const { concepts } = res.json();
    expect(concepts.length).toBeGreaterThanOrEqual(3);

    // Grounding invariant: every concept's quote is locatable at the stated
    // offsets inside the referenced block.
    const blocksRes = await ctx.app.inject({ method: 'GET', url: `/api/materials/${materialId}` });
    const blocks = blocksRes.json().blocks as Array<{
      id: string;
      content: string;
    }>;
    for (const concept of concepts) {
      const block = blocks.find((b) => b.id === concept.grounding.blockId);
      expect(block).toBeDefined();
      expect(block!.content.slice(concept.grounding.startOffset, concept.grounding.endOffset)).toBe(
        concept.grounding.quote,
      );
    }
  });

  it('returns the existing concept set on repeated analysis so dependent ids stay stable', async () => {
    const { materialId } = await importSample();
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().concepts).toEqual(first.json().concepts);
  });

  it('generates a quiz whose questions never leak answers and carry verified grounding', async () => {
    const { materialId } = await importSample();
    const quiz = await generateQuiz(materialId);

    expect(quiz.kind).toBe('standard');
    expect(quiz.questions).toHaveLength(6);

    const body = JSON.stringify(quiz);
    expect(body).not.toContain('correctOptionIds');
    expect(body).not.toContain('expectedAnswer');
    expect(body).not.toContain('rubric');

    for (const q of quiz.questions) {
      expect(q.grounding.quote.length).toBeGreaterThan(0);
      if (q.type !== 'short_answer') {
        expect((q.options ?? []).length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('supports retrieving a generated quiz by id', async () => {
    const { materialId } = await importSample();
    const quiz = await generateQuiz(materialId);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/quizzes/${quiz.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().quiz.id).toBe(quiz.id);
  });

  it('returns 404 when generating a quiz for a missing material', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/quizzes',
      payload: {
        materialId: 'mat_missing',
        config: { difficulty: 'easy', types: ['single_choice'], countPerType: 1 },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects an invalid quiz config', async () => {
    const { materialId } = await importSample();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/quizzes',
      payload: { materialId, config: { difficulty: 'impossible', types: [], countPerType: 99 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Flow B: submission → grading → mistakes → remediation → mastery', () => {
  interface FlowState {
    materialId: string;
    quiz: PublicQuiz;
    questions: Question[];
    grading: {
      grades: Array<{
        questionId: string;
        gradedBy: string;
        correct: boolean;
        normalizedScore: number;
        confidence?: number;
      }>;
      totalAwarded: number;
      totalPossible: number;
      overallScore: number;
    };
  }

  /** Submit answers built from the revealed key: wrong for `wrongIds`. */
  async function submitWithMistakes(wrongCount: number): Promise<FlowState> {
    const { materialId } = await importSample();
    const quiz = await generateQuiz(materialId);

    // First submission with deliberately wrong answers for the first
    // `wrongCount` questions: pick a non-answer for choices, junk for SA.
    const answers = quiz.questions.map((q, i) => {
      if (q.type === 'short_answer') {
        return {
          questionId: q.id,
          type: q.type,
          text: i < wrongCount ? '完全无关的胡乱回答' : '',
        };
      }
      return { questionId: q.id, type: q.type, selectedOptionIds: [] as string[] };
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: { answers },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { materialId, quiz, questions: body.questions, grading: body.grading };
  }

  it('grades objective questions deterministically and short answers by rubric, labelling gradedBy', async () => {
    const { grading, questions } = await submitWithMistakes(0);

    expect(grading.grades).toHaveLength(questions.length);
    for (const grade of grading.grades) {
      const question = questions.find((q) => q.id === grade.questionId)!;
      if (question.type === 'short_answer') {
        // Blank SA answers are graded deterministically; answered ones by model.
        expect(['model', 'deterministic']).toContain(grade.gradedBy);
      } else {
        expect(grade.gradedBy).toBe('deterministic');
      }
    }
    expect(grading.totalPossible).toBeGreaterThan(0);
    expect(grading.overallScore).toBeGreaterThanOrEqual(0);
    expect(grading.overallScore).toBeLessThanOrEqual(1);
  });

  it('reveals full questions (answers, rubric, explanation) only after grading', async () => {
    const { questions } = await submitWithMistakes(0);
    const choice = questions.find((q) => q.type !== 'short_answer')!;
    expect(choice.correctOptionIds!.length).toBeGreaterThanOrEqual(1);
    const sa = questions.find((q) => q.type === 'short_answer')!;
    expect(sa.expectedAnswer).toBeTruthy();
    expect(sa.rubric!.keyPoints.length).toBeGreaterThanOrEqual(1);
    expect(choice.explanation).toBeTruthy();
  });

  it('persists mistakes for wrong answers and lists weak concepts', async () => {
    const { materialId } = await submitWithMistakes(6);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${materialId}/mistakes?status=open`,
    });
    expect(res.statusCode).toBe(200);
    const { mistakes, weakConcepts } = res.json();
    expect(mistakes.length).toBeGreaterThan(0);
    expect(weakConcepts.length).toBeGreaterThan(0);
    for (const mistake of mistakes) {
      expect(mistake.status).toBe('open');
      expect(mistake.question.stem).toBeTruthy();
      expect(mistake.conceptName).toBeTruthy();
    }
  });

  it('updates mastery deterministically after grading', async () => {
    const { materialId } = await submitWithMistakes(6);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${materialId}/mastery`,
    });
    expect(res.statusCode).toBe(200);
    const { mastery } = res.json();
    expect(mastery.length).toBeGreaterThan(0);
    for (const state of mastery) {
      expect(state.mastery).toBeGreaterThanOrEqual(0);
      expect(state.mastery).toBeLessThanOrEqual(1);
      expect(state.attempts).toBeGreaterThan(0);
      // All answers were wrong/blank → mastery must have moved below 0.5.
      expect(state.mastery).toBeLessThan(0.5);
    }
  });

  it('generates remediation from actual weak concepts and resolves mistakes on success', async () => {
    const { materialId } = await submitWithMistakes(6);

    // Generate remediation — must target concepts that actually have mistakes.
    const remRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/remediation`,
    });
    expect(remRes.statusCode).toBe(201);
    const remediation = remRes.json().quiz as PublicQuiz;
    expect(remediation.kind).toBe('remediation');
    expect(remediation.targetConceptIds!.length).toBeGreaterThan(0);

    const mistakesBefore = await ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${materialId}/mistakes?status=open`,
    });
    const openBefore = mistakesBefore.json().mistakes.length;
    const targetIds = new Set(remediation.targetConceptIds);
    for (const q of remediation.questions) {
      expect(targetIds.has(q.conceptId)).toBe(true);
    }

    // Answer the remediation quiz correctly: fetch revealed questions by
    // submitting once with blanks, then use the revealed key. Instead we
    // grade correctly on the first try by reading the key from the server
    // side (test has repo access).
    const fullQuiz = ctx.repos.quizzes.get(remediation.id)!;
    const answers = fullQuiz.questions.map((q) => {
      if (q.type === 'short_answer') {
        // Answer with the expected answer itself → rubric coverage.
        return { questionId: q.id, type: q.type, text: q.expectedAnswer! };
      }
      return { questionId: q.id, type: q.type, selectedOptionIds: q.correctOptionIds! };
    });
    const submitRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${remediation.id}/submissions`,
      payload: { answers },
    });
    expect(submitRes.statusCode).toBe(201);
    const grading = submitRes.json().grading;
    expect(grading.overallScore).toBeGreaterThan(0.5);

    // Mistakes linked to correctly-answered remediation questions resolve.
    const mistakesAfter = await ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${materialId}/mistakes?status=open`,
    });
    const openAfter = mistakesAfter.json().mistakes.length;
    expect(openAfter).toBeLessThan(openBefore);

    // Mastery for remediated concepts moved upward.
    const masteryRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${materialId}/mastery`,
    });
    const mastery = masteryRes.json().mastery as Array<{
      conceptId: string;
      mastery: number;
      attempts: number;
    }>;
    const remediated = mastery.filter((m) => targetIds.has(m.conceptId));
    expect(remediated.length).toBeGreaterThan(0);
    for (const state of remediated) {
      expect(state.mastery).toBeGreaterThan(0.2);
      expect(state.attempts).toBeGreaterThanOrEqual(2);
    }
  });

  it('refuses remediation when there are no weaknesses yet', async () => {
    const { materialId } = await importSample();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/remediation`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects answers for questions outside the quiz', async () => {
    const { materialId } = await importSample();
    const quiz = await generateQuiz(materialId);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: [
          { questionId: 'que_not_in_quiz', type: 'single_choice', selectedOptionIds: ['A'] },
        ],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
