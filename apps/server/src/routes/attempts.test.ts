import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompletedAttemptDetailSchema,
  CompletedAttemptSummarySchema,
  SAMPLE_MATERIAL_CONTENT,
  type GradingResult,
  type PublicQuiz,
  type SubmissionStateChanges,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import { makeBlock, makeMaterial, makeQuiz, T0 } from '../testing/fixtures.js';

/**
 * Completed-quiz history: durable, read-only replay of graded attempts.
 *
 * The invariants under test:
 * - a successful submission persists everything the immediate result showed
 *   (questions, answers, grades, state changes, provider mode) and the
 *   history endpoints return EXACTLY that snapshot;
 * - opening history performs zero writes — no re-grading, no second
 *   mastery/mistake/misconception/review update;
 * - records are workspace-scoped and newest-first;
 * - legacy rows (pre-snapshot) and deleted/reprocessed sources degrade
 *   honestly instead of fabricating data.
 */

let ctx: TestApp;

beforeEach(() => {
  ctx = buildTestApp();
});

afterEach(async () => {
  await ctx.app.close();
});

/** Tables that hold learning state or attempt records. */
const STATE_TABLES = [
  'quizzes',
  'questions',
  'submissions',
  'grading_results',
  'mistakes',
  'mastery_states',
  'misconceptions',
  'review_items',
  'review_events',
] as const;

function dumpState(app: TestApp): Record<string, unknown[]> {
  const dump: Record<string, unknown[]> = {};
  for (const table of STATE_TABLES) {
    dump[table] = app.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  }
  return dump;
}

async function importSample(app: TestApp): Promise<{ materialId: string; workspaceId: string }> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/materials',
    payload: { content: SAMPLE_MATERIAL_CONTENT, filename: 'sample.md' },
  });
  expect(res.statusCode).toBe(201);
  const material = res.json().material as { id: string; workspaceId: string };
  return { materialId: material.id, workspaceId: material.workspaceId };
}

async function generateQuiz(app: TestApp, materialId: string): Promise<PublicQuiz> {
  const res = await app.app.inject({
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

interface SubmitOutcome {
  quiz: PublicQuiz;
  answers: Array<{ questionId: string; type: string; selectedOptionIds?: string[]; text?: string }>;
  grading: GradingResult;
  questions: unknown[];
  stateChanges: SubmissionStateChanges;
}

/** Submit a quiz with a deterministic mix of answered and blank questions. */
async function submitQuiz(app: TestApp, quiz: PublicQuiz): Promise<SubmitOutcome> {
  const answers = quiz.questions.map((q, i) => {
    if (q.type === 'short_answer' || q.type === 'concept_comparison') {
      return { questionId: q.id, type: q.type, text: i % 2 === 0 ? '容量有限,需要分散复习。' : '' };
    }
    return {
      questionId: q.id,
      type: q.type,
      selectedOptionIds: i % 2 === 0 ? [q.options![0]!.id] : [],
    };
  });
  const res = await app.app.inject({
    method: 'POST',
    url: `/api/quizzes/${quiz.id}/submissions`,
    payload: { answers },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return {
    quiz,
    answers,
    grading: body.grading,
    questions: body.questions,
    stateChanges: body.stateChanges,
  };
}

describe('completed-attempt persistence and round-trip', () => {
  it('lists a graded submission with honest workspace-scoped metadata', async () => {
    const { materialId, workspaceId } = await importSample(ctx);
    const quiz = await generateQuiz(ctx, materialId);
    const submitted = await submitQuiz(ctx, quiz);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/attempts`,
    });
    expect(res.statusCode).toBe(200);
    const { attempts } = res.json();
    expect(attempts).toHaveLength(1);

    const summary = CompletedAttemptSummarySchema.parse(attempts[0]);
    expect(summary.id).toBe(submitted.grading.id);
    expect(summary.quizId).toBe(quiz.id);
    expect(summary.workspaceId).toBe(workspaceId);
    expect(summary.kind).toBe('standard');
    expect(summary.materialId).toBe(materialId);
    expect(summary.materialTitle).toBeTruthy();
    expect(summary.questionCount).toBe(quiz.questions.length);
    expect(summary.totalAwarded).toBe(submitted.grading.totalAwarded);
    expect(summary.totalPossible).toBe(submitted.grading.totalPossible);
    expect(summary.overallScore).toBe(submitted.grading.overallScore);
    expect(summary.provider).toBe('fake');
    expect(summary.completedAt).toBe(submitted.grading.createdAt);
  });

  it('returns the exact original snapshot: questions, answers, grades, state changes', async () => {
    const { materialId, workspaceId } = await importSample(ctx);
    const quiz = await generateQuiz(ctx, materialId);
    const submitted = await submitQuiz(ctx, quiz);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/attempts/${submitted.grading.id}`,
    });
    expect(res.statusCode).toBe(200);
    const detail = CompletedAttemptDetailSchema.parse(res.json());

    // Faithful replay: byte-for-byte the data the immediate result showed.
    expect(detail.grading).toEqual(submitted.grading);
    expect(detail.questions).toEqual(submitted.questions);
    expect(detail.stateChanges).toEqual(submitted.stateChanges);
    expect(detail.answers).toEqual(submitted.answers);
    expect(detail.quiz.id).toBe(quiz.id);
    expect(detail.summary.provider).toBe('fake');

    // Evidence context: every referenced block resolves while the document
    // still exists, so the panel can highlight quotes in full context.
    const blockIds = new Set(detail.blocks.map((b) => b.id));
    for (const question of detail.questions) {
      expect(blockIds.has(question.grounding.blockId)).toBe(true);
    }
  });

  it('orders attempts deterministically, newest first', async () => {
    let offsetMs = 0;
    const stepped = buildTestApp({
      clock: { now: () => new Date(Date.parse(T0) + offsetMs) },
    });
    try {
      const { materialId, workspaceId } = await importSample(stepped);
      const first = await submitQuiz(stepped, await generateQuiz(stepped, materialId));
      offsetMs = 60_000;
      const second = await submitQuiz(stepped, await generateQuiz(stepped, materialId));

      const res = await stepped.app.inject({
        method: 'GET',
        url: `/api/workspaces/${workspaceId}/attempts`,
      });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().attempts as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toEqual([second.grading.id, first.grading.id]);
    } finally {
      await stepped.app.close();
    }
  });
});

describe('history reads are side-effect free', () => {
  it('changes no learning state on repeated list and detail reads', async () => {
    const { materialId, workspaceId } = await importSample(ctx);
    const quiz = await generateQuiz(ctx, materialId);
    const submitted = await submitQuiz(ctx, quiz);

    const before = dumpState(ctx);
    const listUrl = `/api/workspaces/${workspaceId}/attempts`;
    const detailUrl = `${listUrl}/${submitted.grading.id}`;

    const first = await ctx.app.inject({ method: 'GET', url: detailUrl });
    await ctx.app.inject({ method: 'GET', url: listUrl });
    await ctx.app.inject({ method: 'GET', url: listUrl });
    const second = await ctx.app.inject({ method: 'GET', url: detailUrl });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Identical responses on repeated reads…
    expect(second.json()).toEqual(first.json());
    // …and an untouched database: no new mistakes, no mastery movement, no
    // review rescheduling, no misconception transitions, nothing.
    expect(dumpState(ctx)).toEqual(before);
  });

  it('never calls the provider while reading history', async () => {
    const { materialId, workspaceId } = await importSample(ctx);
    const quiz = await generateQuiz(ctx, materialId);
    const submitted = await submitQuiz(ctx, quiz);

    const spies = [
      vi.spyOn(ctx.provider, 'generateQuiz'),
      vi.spyOn(ctx.provider, 'gradeShortAnswer'),
      vi.spyOn(ctx.provider, 'analyzeConcepts'),
      vi.spyOn(ctx.provider, 'proposeMisconception'),
    ];
    await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/attempts` });
    await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/attempts/${submitted.grading.id}`,
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('workspace scoping and failure modes', () => {
  it('scopes the list to the requested workspace and hides foreign attempts', async () => {
    const { materialId, workspaceId } = await importSample(ctx);
    const quiz = await generateQuiz(ctx, materialId);
    const submitted = await submitQuiz(ctx, quiz);

    const otherRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '另一个课程空间' },
    });
    const otherId = otherRes.json().workspace.id as string;

    const otherList = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${otherId}/attempts`,
    });
    expect(otherList.statusCode).toBe(200);
    expect(otherList.json().attempts).toEqual([]);

    // Detail access through the wrong workspace 404s like a missing record.
    const crossRead = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${otherId}/attempts/${submitted.grading.id}`,
    });
    expect(crossRead.statusCode).toBe(404);

    const rightRead = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/attempts/${submitted.grading.id}`,
    });
    expect(rightRead.statusCode).toBe(200);
  });

  it('fails cleanly for unknown workspaces and unknown attempts', async () => {
    const { workspaceId } = await importSample(ctx);
    for (const url of [
      '/api/workspaces/ws_missing/attempts',
      '/api/workspaces/ws_missing/attempts/grd_x',
      `/api/workspaces/${workspaceId}/attempts/grd_missing`,
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('creates no completed attempt when grading fails mid-quiz', async () => {
    const provider = new FakeProvider();
    vi.spyOn(provider, 'gradeShortAnswer').mockRejectedValue(new Error('模拟判分失败'));
    const failing = buildTestApp({ provider });
    try {
      const { materialId, workspaceId } = await importSample(failing);
      const quiz = await generateQuiz(failing, materialId);
      const answers = quiz.questions.map((q) => {
        if (q.type === 'short_answer') {
          return { questionId: q.id, type: q.type, text: '一定会触发模型判分的作答' };
        }
        return { questionId: q.id, type: q.type, selectedOptionIds: [q.options![0]!.id] };
      });
      const res = await failing.app.inject({
        method: 'POST',
        url: `/api/quizzes/${quiz.id}/submissions`,
        payload: { answers },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);

      // Atomicity: no submission, no grading result, no learning-state
      // updates, and therefore no fake history entry.
      for (const table of ['submissions', 'grading_results', 'mistakes', 'mastery_states']) {
        const row = failing.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        };
        expect(row.n, table).toBe(0);
      }
      const list = await failing.app.inject({
        method: 'GET',
        url: `/api/workspaces/${workspaceId}/attempts`,
      });
      expect(list.json().attempts).toEqual([]);
    } finally {
      await failing.app.close();
    }
  });

  it('drops document-quiz attempts together with their deleted document (existing lifecycle)', async () => {
    const { materialId, workspaceId } = await importSample(ctx);
    const quiz = await generateQuiz(ctx, materialId);
    const submitted = await submitQuiz(ctx, quiz);

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/materials/${materialId}` });
    expect(del.statusCode).toBe(204);

    // Same lifecycle as mistakes/mastery: a document deletion removes the
    // learning records bound to it. The list stays honest (no ghost rows)…
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/attempts`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().attempts).toEqual([]);
    // …and the detail read reports the record as gone.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/attempts/${submitted.grading.id}`,
    });
    expect(detail.statusCode).toBe(404);
  });
});

describe('workspace assessments and deleted sources', () => {
  async function createWorkspaceAssessment(): Promise<{
    workspaceId: string;
    documentId: string;
    quiz: PublicQuiz;
  }> {
    const wsRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '认知科学课程空间' },
    });
    const workspaceId = wsRes.json().workspace.id as string;
    const docRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'text', content: SAMPLE_MATERIAL_CONTENT, filename: 'sample.md' },
    });
    expect(docRes.statusCode).toBe(201);
    const documentId = docRes.json().material.id as string;
    const analyze = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${documentId}/analyze`,
    });
    expect(analyze.statusCode).toBe(200);
    const assess = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    expect(assess.statusCode).toBe(201);
    return { workspaceId, documentId, quiz: assess.json().quiz as PublicQuiz };
  }

  it('keeps an assessment attempt reopenable and honest after its document is deleted', async () => {
    const { workspaceId, documentId, quiz } = await createWorkspaceAssessment();
    const submitted = await submitQuiz(ctx, quiz);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/documents/${documentId}`,
    });
    expect(del.statusCode).toBe(204);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/attempts`,
    });
    expect(list.statusCode).toBe(200);
    const attempts = list.json().attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      kind: 'adaptive',
      assessmentMode: 'diagnostic',
      materialId: null,
      materialTitle: null,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/attempts/${submitted.grading.id}`,
    });
    expect(res.statusCode).toBe(200);
    const detail = CompletedAttemptDetailSchema.parse(res.json());
    // The live source blocks are gone — none are fabricated — while the
    // persisted questions still carry their original verified quotes.
    expect(detail.blocks).toEqual([]);
    expect(detail.grading).toEqual(submitted.grading);
    for (const question of detail.questions) {
      expect(question.grounding.quote.length).toBeGreaterThan(0);
    }
  });
});

describe('legacy rows and repository-level guarantees', () => {
  function seedManualAttempt(id: string, createdAt: string): GradingResult {
    const material = makeMaterial();
    if (!ctx.repos.materials.get(material.id)) {
      ctx.repos.materials.insertWithBlocks(material, [makeBlock()]);
      ctx.repos.quizzes.insert(makeQuiz());
    }
    const suffix = id.replace(/^grd_/, '');
    ctx.repos.submissions.insertSubmission({
      id: `sub_${suffix}`,
      quizId: 'qz_1',
      answers: [{ questionId: 'que_1', type: 'single_choice', selectedOptionIds: ['A'] }],
      createdAt,
    });
    const grading: GradingResult = {
      id,
      submissionId: `sub_${suffix}`,
      quizId: 'qz_1',
      grades: [
        {
          questionId: 'que_1',
          type: 'single_choice',
          gradedBy: 'deterministic',
          correct: true,
          awardedPoints: 1,
          maxPoints: 1,
          normalizedScore: 1,
          needsReview: false,
        },
      ],
      totalAwarded: 1,
      totalPossible: 1,
      overallScore: 1,
      createdAt,
    };
    // Legacy shape: no provider tag, no state-changes snapshot.
    ctx.repos.submissions.insertGradingResult(grading);
    return grading;
  }

  it('reads pre-snapshot attempts with null provider and null state changes', async () => {
    const grading = seedManualAttempt('grd_legacy', T0);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/workspaces/ws_1/attempts' });
    expect(list.statusCode).toBe(200);
    const summary = CompletedAttemptSummarySchema.parse(list.json().attempts[0]);
    expect(summary.provider).toBeNull();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/ws_1/attempts/${grading.id}`,
    });
    expect(res.statusCode).toBe(200);
    const detail = CompletedAttemptDetailSchema.parse(res.json());
    expect(detail.stateChanges).toBeNull();
    expect(detail.summary.provider).toBeNull();
    expect(detail.grading).toEqual(grading);
  });

  it('treats an unknown persisted provider tag as not recorded', () => {
    const grading = seedManualAttempt('grd_odd', T0);
    ctx.db
      .prepare('UPDATE grading_results SET provider = ? WHERE id = ?')
      .run('mystery', grading.id);
    expect(ctx.repos.submissions.getAttemptRecord(grading.id)!.provider).toBeNull();
  });

  it('bounds the history list and keeps it newest first at the repository level', () => {
    seedManualAttempt('grd_a', '2026-01-01T00:00:00.000Z');
    seedManualAttempt('grd_b', '2026-01-02T00:00:00.000Z');
    seedManualAttempt('grd_c', '2026-01-03T00:00:00.000Z');

    const top2 = ctx.repos.submissions.listCompletedByWorkspace('ws_1', 2);
    expect(top2.map((a) => a.id)).toEqual(['grd_c', 'grd_b']);
  });

  it('records the state-change snapshot write-once (the original is never overwritten)', () => {
    const grading = seedManualAttempt('grd_once', T0);
    const original: SubmissionStateChanges = {
      assessedConceptIds: ['con_1'],
      documentIds: ['mat_1'],
      mistakesCreated: 1,
      mistakesResolved: 0,
      misconceptionsProposed: 0,
      misconceptionsConfirmed: 0,
      misconceptionsRejected: 0,
      misconceptionsResolved: 0,
      masteryChanges: [],
      reviewScheduled: [],
      recommendedNextStep: '第一次记录。',
    };
    ctx.repos.submissions.recordStateChanges(grading.id, original);
    ctx.repos.submissions.recordStateChanges(grading.id, {
      ...original,
      recommendedNextStep: '试图覆盖的第二次记录。',
    });
    expect(ctx.repos.submissions.getAttemptRecord(grading.id)!.stateChanges).toEqual(original);
  });
});
