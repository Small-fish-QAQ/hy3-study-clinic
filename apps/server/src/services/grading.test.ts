import { beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../llm/fakeProvider.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Grading state safety (Phase 0):
 * - the same quiz applies learner state at most once, even under concurrent
 *   or retried submissions (race-safe below the route layer);
 * - stale quizzes whose concepts were deleted/reprocessed are rejected with
 *   zero state mutation;
 * - the complete learner-state write set is one transaction: a mid-write
 *   failure leaves no partial rows behind.
 */

const DOC = [
  '# 工作记忆',
  '',
  '工作记忆的容量十分有限。它一次只能加工少量信息。',
  '',
  '# 长时记忆',
  '',
  '长时记忆负责长期存储。图式化的知识更容易保持。',
].join('\n');

interface Setup {
  ctx: TestApp;
  workspaceId: string;
  materialId: string;
  quizId: string;
  answers: Array<Record<string, unknown>>;
}

async function setupQuiz(ctx: TestApp): Promise<Setup> {
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '判分安全测试' },
  });
  const workspaceId = ws.json().workspace.id as string;
  const doc = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/documents`,
    payload: { kind: 'text', content: DOC },
  });
  const materialId = doc.json().material.id as string;
  const quizRes = await ctx.app.inject({
    method: 'POST',
    url: '/api/quizzes',
    payload: {
      materialId,
      config: { difficulty: 'easy', types: ['single_choice'], countPerType: 2 },
    },
  });
  const quiz = quizRes.json().quiz as {
    id: string;
    questions: Array<{ id: string; type: string; options: Array<{ id: string }> }>;
  };
  const answers = quiz.questions.map((q) => ({
    questionId: q.id,
    type: q.type,
    selectedOptionIds: [q.options[0]!.id],
  }));
  return { ctx, workspaceId, materialId, quizId: quiz.id, answers };
}

function stateRowCounts(ctx: TestApp): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of [
    'submissions',
    'grading_results',
    'mistakes',
    'mastery_states',
    'misconceptions',
    'review_items',
    'review_events',
  ]) {
    counts[table] = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return counts;
}

describe('duplicate submissions', () => {
  let setup: Setup;

  beforeEach(async () => {
    setup = await setupQuiz(buildTestApp());
  });

  it('a second submission of the same quiz is rejected with 409 and applies no state', async () => {
    const first = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${setup.quizId}/submissions`,
      payload: { answers: setup.answers },
    });
    expect(first.statusCode).toBe(201);
    const after = stateRowCounts(setup.ctx);

    const second = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${setup.quizId}/submissions`,
      payload: { answers: setup.answers },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('DUPLICATE_SUBMISSION');
    expect(stateRowCounts(setup.ctx)).toEqual(after);
  });

  it('concurrent submissions of the same quiz apply learner state exactly once', async () => {
    // A provider delay keeps both requests in their async provider phase at
    // the same time; the transaction-local recheck must still serialize them.
    const slow = buildTestApp({ provider: new FakeProvider({ delayMs: 20 }) });
    const s = await setupQuiz(slow);
    const [a, b] = await Promise.all([
      slow.app.inject({
        method: 'POST',
        url: `/api/quizzes/${s.quizId}/submissions`,
        payload: { answers: s.answers },
      }),
      slow.app.inject({
        method: 'POST',
        url: `/api/quizzes/${s.quizId}/submissions`,
        payload: { answers: s.answers },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    expect(
      (slow.db.prepare('SELECT COUNT(*) AS n FROM grading_results').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (slow.db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n,
    ).toBe(1);
    // Mastery advanced exactly once per assessed concept (attempts = its own
    // question count, not doubled).
    const mastery = slow.db.prepare('SELECT attempts FROM mastery_states').all() as Array<{
      attempts: number;
    }>;
    const totalAttempts = mastery.reduce((n, m) => n + m.attempts, 0);
    expect(totalAttempts).toBe(s.answers.length);
  });
});

describe('stale assessments', () => {
  it('rejects a pending quiz whose concepts were deleted, with zero state mutation', async () => {
    const ctx = buildTestApp();
    const setup = await setupQuiz(ctx);
    const before = stateRowCounts(ctx);

    // Reprocess-like staleness: the material's concepts are replaced, so the
    // pending quiz now references concept ids that no longer exist.
    ctx.db.prepare('DELETE FROM concepts WHERE material_id = ?').run(setup.materialId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${setup.quizId}/submissions`,
      payload: { answers: setup.answers },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('已被删除或重新解析');
    expect(stateRowCounts(ctx)).toEqual(before);
  });
});

describe('atomic grading persistence', () => {
  it('a mid-write failure rolls back the COMPLETE learner-state write set', async () => {
    const ctx = buildTestApp();
    const setup = await setupQuiz(ctx);
    const before = stateRowCounts(ctx);

    // Fault injection: the review scheduler write is late in the write set;
    // making it throw must erase the submission/result/mistake/mastery rows
    // written earlier inside the same transaction.
    const originalUpsert = ctx.repos.review.upsert.bind(ctx.repos.review);
    ctx.repos.review.upsert = () => {
      throw new Error('模拟写入故障');
    };
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${setup.quizId}/submissions`,
      payload: { answers: setup.answers },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(stateRowCounts(ctx)).toEqual(before);

    // The quiz remains submittable after the fault clears (no half-state).
    ctx.repos.review.upsert = originalUpsert;
    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${setup.quizId}/submissions`,
      payload: { answers: setup.answers },
    });
    expect(retry.statusCode).toBe(201);
  });
});
