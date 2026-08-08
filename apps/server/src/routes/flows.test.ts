import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAMPLE_MATERIAL_CONTENT,
  type Concept,
  type PublicQuiz,
  type Question,
} from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import {
  makeBlock,
  makeConcept,
  makeGrounding,
  makeMaterial,
  makeMistake,
  makeQuestion,
  makeQuiz,
  T0,
} from '../testing/fixtures.js';

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

  it('gives a fresh import of the same content a fresh analysis (no stale reuse)', async () => {
    const first = await importSample();
    await ctx.app.inject({ method: 'POST', url: `/api/materials/${first.materialId}/analyze` });

    const second = await importSample();
    expect(second.materialId).not.toBe(first.materialId);

    // The re-imported material starts without concepts; its analysis is a
    // new run producing concepts bound to ITS blocks, not the old ones.
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${second.materialId}/concepts`,
    });
    expect(before.json().concepts).toEqual([]);

    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${second.materialId}/analyze`,
    });
    expect(analyzed.statusCode).toBe(200);
    for (const concept of analyzed.json().concepts) {
      expect(concept.materialId).toBe(second.materialId);
    }
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

  async function analyzeConcepts(materialId: string): Promise<Concept[]> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().concepts as Concept[];
  }

  function insertConceptMistake(
    materialId: string,
    concept: Concept,
    suffix: string,
    status: 'open' | 'resolved',
  ): void {
    const questionId = `que_${suffix}`;
    const quizId = `qz_${suffix}`;
    const question = makeQuestion({
      id: questionId,
      quizId,
      conceptId: concept.id,
      conceptName: concept.name,
      grounding: concept.grounding,
    });
    ctx.repos.mistakes.insert(
      makeMistake({
        id: `mis_${suffix}`,
        materialId,
        quizId,
        questionId,
        conceptId: concept.id,
        conceptName: concept.name,
        question,
        userAnswer: {
          questionId,
          type: 'single_choice',
          selectedOptionIds: ['B'],
        },
        status,
        resolvedAt: status === 'resolved' ? T0 : null,
      }),
    );
  }

  it('keeps semantically equivalent rubric points covered despite extra intervals', async () => {
    const stem = '资料中列举的常见间隔重复安排是怎样的？请按顺序写出。';
    const expectedAnswer = '学习当天复习一次，三天后一次，一周后一次，一个月后再一次。';
    const rubricKeyPoints = ['当天一次', '三天后一次', '一周后一次', '一个月后一次'];
    const studentAnswer =
      '学习后当天复习，之后分别在 1 天后、3 天后、7 天后、14 天后和 30 天后再次复习。';
    const block = makeBlock({
      content: expectedAnswer,
      startOffset: 0,
      endOffset: expectedAnswer.length,
    });
    const question = makeQuestion({
      id: 'que_semantic_intervals',
      quizId: 'qz_semantic_intervals',
      type: 'short_answer',
      stem,
      options: undefined,
      correctOptionIds: undefined,
      expectedAnswer,
      rubric: { keyPoints: rubricKeyPoints },
      grounding: {
        blockId: block.id,
        quote: expectedAnswer,
        startOffset: 0,
        endOffset: expectedAnswer.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      explanation: '资料按顺序列出了四个间隔。',
      points: 2,
      sourceMistakeIds: [],
    });
    const quiz = makeQuiz({
      id: 'qz_semantic_intervals',
      kind: 'remediation',
      config: { difficulty: 'medium', types: ['short_answer'], countPerType: 1 },
      questions: [question],
      targetConceptIds: [question.conceptId],
    });
    ctx.repos.materials.insertWithBlocks(
      makeMaterial({ content: expectedAnswer, charCount: expectedAnswer.length }),
      [block],
    );
    // The stale-assessment guard requires every quiz concept to exist; give
    // the fixture quiz its real concept row (question uses con_1/mat_1).
    ctx.repos.materials.replaceConcepts('mat_1', [
      makeConcept({
        grounding: makeGrounding({ quote: expectedAnswer, endOffset: expectedAnswer.length }),
      }),
    ]);
    ctx.repos.quizzes.insert(quiz);
    const gradeShortAnswer = vi.spyOn(ctx.provider, 'gradeShortAnswer').mockResolvedValue({
      matchedKeyPointIndexes: [0, 1, 2, 3],
      score: 0.9,
      confidence: 0.95,
      feedback: '四个评分要点均已覆盖;1 天后和 14 天后属于额外安排。',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: [{ questionId: question.id, type: 'short_answer', text: studentAnswer }],
      },
    });

    expect(response.statusCode).toBe(201);
    // Legacy string rubric points load as REQUIRED points (back-compat).
    expect(gradeShortAnswer.mock.calls[0]![0]).toEqual({
      stem,
      expectedAnswer,
      rubricKeyPoints: rubricKeyPoints.map((text) => ({ text, required: true })),
      quote: expectedAnswer,
      answerText: studentAnswer,
    });
    const grading = response.json().grading;
    const grade = grading.grades[0];
    expect(grade.matchedKeyPoints).toEqual(rubricKeyPoints);
    expect(grade.missedKeyPoints).toEqual([]);
    // Score is computed deterministically from required coverage (all four
    // required points fully covered → full credit), NOT from the model's
    // holistic 0.9 — semantically equivalent extra intervals cannot deduct.
    expect(grade).toMatchObject({
      correct: true,
      awardedPoints: 2,
      maxPoints: 2,
      normalizedScore: 1,
      confidence: 0.95,
      needsReview: false,
    });
    expect(grade.feedback).toContain('1 天后和 14 天后');
    expect(grading.totalAwarded).toBe(2);
    expect(grading.totalPossible).toBe(2);
  });

  it('never deducts for missing OPTIONAL rubric points and creates no mistake for them', async () => {
    const stem = '请简述文档中 Chunk 实现的五个等级里的前两个等级及其做法。';
    const content =
      '固定长度:纯代码,每 N 字符切、重叠 M。快但易切断语义。递归分隔符:按优先级逐层切。';
    const block = makeBlock({ content, startOffset: 0, endOffset: content.length });
    const question = makeQuestion({
      id: 'que_chunk_levels',
      quizId: 'qz_chunk_levels',
      type: 'short_answer',
      stem,
      options: undefined,
      correctOptionIds: undefined,
      expectedAnswer: content,
      rubric: {
        keyPoints: [
          { text: '固定长度:每 N 字符切、重叠 M', required: true },
          { text: '递归分隔符:按优先级逐层切', required: true },
          { text: '快但易切断语义', required: false },
        ],
      },
      grounding: {
        blockId: block.id,
        quote: content,
        startOffset: 0,
        endOffset: content.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      explanation: '资料列出了前两个等级及其做法。',
      points: 2,
      sourceMistakeIds: [],
    });
    const quiz = makeQuiz({
      id: 'qz_chunk_levels',
      config: { difficulty: 'medium', types: ['short_answer'], countPerType: 1 },
      questions: [question],
    });
    ctx.repos.materials.insertWithBlocks(makeMaterial({ content, charCount: content.length }), [
      block,
    ]);
    // Stale-assessment guard: the fixture quiz's concept must exist.
    ctx.repos.materials.replaceConcepts('mat_1', [makeConcept()]);
    ctx.repos.quizzes.insert(quiz);
    // The model matches both required points but not the optional drawback,
    // and reports a deflated holistic score — which must NOT drive points.
    vi.spyOn(ctx.provider, 'gradeShortAnswer').mockResolvedValue({
      matchedKeyPointIndexes: [0, 1],
      partialKeyPointIndexes: [],
      score: 0.67,
      confidence: 0.9,
      feedback: '两个等级及其做法均已说明。',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: [
          {
            questionId: question.id,
            type: 'short_answer',
            text: '1. 固定长度:纯代码,每 N 字符切,重叠 M。\n2. 递归分隔符:按优先级逐层切。',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    const grade = body.grading.grades[0];
    expect(grade).toMatchObject({
      correct: true,
      awardedPoints: 2,
      maxPoints: 2,
      normalizedScore: 1,
    });
    expect(grade.missedKeyPoints).toEqual([]);
    expect(grade.enrichmentKeyPoints).toEqual(['快但易切断语义']);
    // Full required coverage → no mistake solely for missing enrichment.
    expect(body.stateChanges.mistakesCreated).toBe(0);
  });

  it('awards deterministic partial credit for partially covered required points', async () => {
    const stem = '说明固定长度切分的做法。';
    const content = '固定长度:纯代码,每 N 字符切、重叠 M。';
    const block = makeBlock({ content, startOffset: 0, endOffset: content.length });
    const question = makeQuestion({
      id: 'que_partial_required',
      quizId: 'qz_partial_required',
      type: 'short_answer',
      stem,
      options: undefined,
      correctOptionIds: undefined,
      expectedAnswer: content,
      rubric: {
        keyPoints: [
          { text: '每 N 字符切', required: true },
          { text: '重叠 M', required: true },
        ],
      },
      grounding: {
        blockId: block.id,
        quote: content,
        startOffset: 0,
        endOffset: content.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      explanation: '资料说明了做法。',
      points: 2,
      sourceMistakeIds: [],
    });
    const quiz = makeQuiz({
      id: 'qz_partial_required',
      config: { difficulty: 'medium', types: ['short_answer'], countPerType: 1 },
      questions: [question],
    });
    ctx.repos.materials.insertWithBlocks(makeMaterial({ content, charCount: content.length }), [
      block,
    ]);
    // Stale-assessment guard: the fixture quiz's concept must exist.
    ctx.repos.materials.replaceConcepts('mat_1', [makeConcept()]);
    ctx.repos.quizzes.insert(quiz);
    vi.spyOn(ctx.provider, 'gradeShortAnswer').mockResolvedValue({
      matchedKeyPointIndexes: [0],
      partialKeyPointIndexes: [1],
      score: 0.9,
      confidence: 0.9,
      feedback: '切分方式正确,但重叠设置只说了一半。',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: [{ questionId: question.id, type: 'short_answer', text: '每 N 字符切,有重叠。' }],
      },
    });

    expect(response.statusCode).toBe(201);
    const grade = response.json().grading.grades[0];
    // (1 full + 0.5 partial) / 2 required = 0.75 — model's 0.9 is ignored.
    expect(grade).toMatchObject({
      correct: true,
      awardedPoints: 1.5,
      maxPoints: 2,
      normalizedScore: 0.75,
    });
    expect(grade.partialKeyPoints).toEqual(['重叠 M']);
    expect(grade.missedKeyPoints).toEqual([]);
  });

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
    expect(remediation.targetConceptIds!.length).toBeLessThanOrEqual(3);
    expect(remediation.questions).toHaveLength(remediation.targetConceptIds!.length * 2);
    expect(remediation.config.types).toEqual(['single_choice', 'short_answer']);
    expect(remediation.config.countPerType).toBe(remediation.targetConceptIds!.length);

    const mistakesBefore = await ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${materialId}/mistakes?status=open`,
    });
    const openBefore = mistakesBefore.json().mistakes.length;
    const openConceptIds = new Set<string>(
      mistakesBefore.json().mistakes.map((mistake: { conceptId: string }) => mistake.conceptId),
    );
    const targetIds = new Set(remediation.targetConceptIds);
    for (const conceptId of targetIds) expect(openConceptIds.has(conceptId)).toBe(true);
    for (const conceptId of targetIds) {
      const types = remediation.questions
        .filter((question) => question.conceptId === conceptId)
        .map((question) => question.type);
      expect(new Set(types)).toEqual(new Set(['single_choice', 'short_answer']));
    }
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

  it('excludes a resolved low-mastery concept when another concept remains open', async () => {
    const { materialId } = await importSample();
    const [resolvedConcept, openConcept] = await analyzeConcepts(materialId);
    expect(resolvedConcept).toBeDefined();
    expect(openConcept).toBeDefined();
    insertConceptMistake(materialId, resolvedConcept!, 'resolved_concept', 'resolved');
    insertConceptMistake(materialId, openConcept!, 'open_concept', 'open');
    ctx.repos.mastery.upsert({
      materialId,
      conceptId: resolvedConcept!.id,
      conceptName: resolvedConcept!.name,
      mastery: 0.55,
      attempts: 2,
      correctCount: 1,
      lastScore: 1,
      updatedAt: T0,
    });

    const generateRemediation = ctx.provider.generateRemediation.bind(ctx.provider);
    const generateSpy = vi
      .spyOn(ctx.provider, 'generateRemediation')
      .mockImplementation(async (input, options) => {
        const payload = await generateRemediation(input, options);
        return {
          questions: payload.questions.flatMap((question) => [
            { ...question, stem: `首个有效：${question.stem}` },
            { ...question, stem: `多余有效：${question.stem}` },
          ]),
        };
      });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/remediation`,
    });

    expect(response.statusCode).toBe(201);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const [providerInput] = generateSpy.mock.calls[0]!;
    expect(providerInput.targets.map((target) => target.concept.id)).toEqual([openConcept!.id]);
    expect(providerInput.targets[0]!.openMistakeCount).toBe(1);

    const remediation = response.json().quiz as PublicQuiz;
    expect(remediation.targetConceptIds).toEqual([openConcept!.id]);
    expect(remediation.questions).toHaveLength(2);
    expect(remediation.questions.map((question) => question.type)).toEqual([
      'single_choice',
      'short_answer',
    ]);
    expect(remediation.questions.every((question) => question.conceptId === openConcept!.id)).toBe(
      true,
    );
    expect(remediation.questions.every((question) => question.stem.startsWith('首个有效：'))).toBe(
      true,
    );
    expect(remediation.config).toEqual({
      difficulty: 'medium',
      types: ['single_choice', 'short_answer'],
      countPerType: 1,
    });

    const storedQuiz = ctx.repos.quizzes.get(remediation.id)!;
    expect(storedQuiz.questions.map((question) => question.index)).toEqual([0, 1]);
    expect(
      storedQuiz.questions.every((question) =>
        question.sourceMistakeIds?.includes('mis_open_concept'),
      ),
    ).toBe(true);
    expect(ctx.repos.mistakes.get('mis_open_concept')?.remediationCount).toBe(1);
    expect(ctx.repos.mistakes.get('mis_resolved_concept')?.remediationCount).toBe(0);
  });

  it('returns a structured failure when a target lacks either required question type', async () => {
    const { materialId } = await importSample();
    const [concept] = await analyzeConcepts(materialId);
    expect(concept).toBeDefined();
    insertConceptMistake(materialId, concept!, 'incomplete_pair', 'open');

    const generateRemediation = ctx.provider.generateRemediation.bind(ctx.provider);
    vi.spyOn(ctx.provider, 'generateRemediation').mockImplementation(async (input, options) => {
      const payload = await generateRemediation(input, options);
      return {
        questions: payload.questions.filter((question) => question.type === 'single_choice'),
      };
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/remediation`,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('GROUNDING_FAILED');
    expect(response.json().error.details.missing).toEqual([
      { conceptId: concept!.id, type: 'short_answer' },
    ]);
    expect(ctx.repos.mistakes.get('mis_incomplete_pair')?.remediationCount).toBe(0);
  });

  it('refuses remediation when no mistakes are open, even if historical mastery is low', async () => {
    const { materialId } = await importSample();
    const [concept] = await analyzeConcepts(materialId);
    expect(concept).toBeDefined();
    ctx.repos.mastery.upsert({
      materialId,
      conceptId: concept!.id,
      conceptName: concept!.name,
      mastery: 0.2,
      attempts: 1,
      correctCount: 0,
      lastScore: 0,
      updatedAt: T0,
    });
    const generateSpy = vi.spyOn(ctx.provider, 'generateRemediation');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/remediation`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toContain('没有未解决的错题');
    expect(generateSpy).not.toHaveBeenCalled();
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
