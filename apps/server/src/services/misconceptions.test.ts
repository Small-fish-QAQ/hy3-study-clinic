import { beforeEach, describe, expect, it } from 'vitest';
import type { MisconceptionRecord } from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Misconception lifecycle: proposal from wrong workspace-assessment answers,
 * deterministic confirm/reject/resolve through discriminating questions,
 * illegal-transition rejection, and Tutor-facing priority.
 */

const DOC = [
  '# 工作记忆',
  '',
  '工作记忆是容量有限的短时信息加工系统。它一次只能保持大约四个组块。',
  '',
  '# 长时记忆',
  '',
  '长时记忆通过巩固过程形成,睡眠对巩固十分重要。',
].join('\n');

interface Setup {
  ctx: TestApp;
  workspaceId: string;
}

async function setupWorkspace(): Promise<Setup> {
  const ctx = buildTestApp();
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '误区测试' },
  });
  const workspaceId = ws.json().workspace.id as string;
  const doc = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/documents`,
    payload: { kind: 'text', content: DOC },
  });
  await ctx.app.inject({
    method: 'POST',
    url: `/api/materials/${doc.json().material.id}/analyze`,
  });
  return { ctx, workspaceId };
}

/** Answer a workspace assessment wrongly by SELECTING a wrong option. */
async function failAssessmentWithWrongChoices(setup: Setup): Promise<void> {
  const creation = await setup.ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${setup.workspaceId}/assessments`,
    payload: { mode: 'diagnostic' },
  });
  expect(creation.statusCode).toBe(201);
  const quiz = creation.json().quiz as {
    id: string;
    questions: Array<{ id: string; type: string; options?: Array<{ id: string }> }>;
  };
  const full = setup.ctx.repos.quizzes.get(quiz.id)!;
  const submit = await setup.ctx.app.inject({
    method: 'POST',
    url: `/api/quizzes/${quiz.id}/submissions`,
    payload: {
      answers: full.questions.map((q) => {
        if (q.type === 'single_choice' || q.type === 'multiple_choice') {
          const wrong = q.options!.find((o) => !q.correctOptionIds!.includes(o.id))!;
          return { questionId: q.id, type: q.type, selectedOptionIds: [wrong.id] };
        }
        return { questionId: q.id, type: q.type, text: '不对的回答' };
      }),
    },
  });
  expect(submit.statusCode).toBe(201);
}

describe('misconception proposal from wrong answers', () => {
  let setup: Setup;

  beforeEach(async () => {
    setup = await setupWorkspace();
  });

  it('creates PROPOSED hypotheses for substantive wrong answers (never confirmed)', async () => {
    await failAssessmentWithWrongChoices(setup);
    const list = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/misconceptions`,
    });
    const records = list.json().misconceptions as MisconceptionRecord[];
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.length).toBeLessThanOrEqual(2); // bounded per submission
    for (const record of records) {
      expect(record.status).toBe('proposed');
      expect(record.hypothesis).toContain('可能');
      expect(record.originQuizId).toBeTruthy();
    }
  });

  it('does not propose misconceptions for blank answers or document quizzes', async () => {
    // Blank workspace assessment.
    const creation = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    const quiz = creation.json().quiz as {
      id: string;
      questions: Array<{ id: string; type: string }>;
    };
    await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: quiz.questions.map((q) =>
          q.type === 'single_choice' || q.type === 'multiple_choice'
            ? { questionId: q.id, type: q.type, selectedOptionIds: [] }
            : { questionId: q.id, type: q.type, text: '' },
        ),
      },
    });
    const list = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/misconceptions`,
    });
    expect(list.json().misconceptions).toHaveLength(0);
  });
});

describe('misconception discriminating transitions', () => {
  let setup: Setup;
  let misconception: MisconceptionRecord;

  beforeEach(async () => {
    setup = await setupWorkspace();
    await failAssessmentWithWrongChoices(setup);
    const list = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/misconceptions?status=proposed`,
    });
    misconception = (list.json().misconceptions as MisconceptionRecord[])[0]!;
  });

  async function runDiscriminatingActivity(correct: boolean): Promise<void> {
    const creation = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'misconception_check', misconceptionId: misconception.id },
    });
    expect(creation.statusCode).toBe(201);
    const quiz = creation.json().quiz as { id: string };
    const full = setup.ctx.repos.quizzes.get(quiz.id)!;
    expect(full.questions.every((q) => q.misconceptionId === misconception.id)).toBe(true);
    await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: full.questions.map((q) => {
          const ids = correct
            ? q.correctOptionIds!
            : [q.options!.find((o) => !q.correctOptionIds!.includes(o.id))!.id];
          return { questionId: q.id, type: q.type, selectedOptionIds: ids };
        }),
      },
    });
  }

  it('a correct discriminating answer REJECTS the proposed hypothesis', async () => {
    await runDiscriminatingActivity(true);
    const record = setup.ctx.repos.misconceptions.get(misconception.id)!;
    expect(record.status).toBe('rejected');
    expect(record.decidedByQuizId).toBeTruthy();
  });

  it('a wrong discriminating answer CONFIRMS, and later success RESOLVES', async () => {
    await runDiscriminatingActivity(false);
    expect(setup.ctx.repos.misconceptions.get(misconception.id)!.status).toBe('confirmed');

    await runDiscriminatingActivity(true);
    const record = setup.ctx.repos.misconceptions.get(misconception.id)!;
    expect(record.status).toBe('resolved');
  });

  it('terminal states stay put: no further discriminating activity can be created', async () => {
    await runDiscriminatingActivity(true); // → rejected (terminal)
    const again = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'misconception_check', misconceptionId: misconception.id },
    });
    expect(again.statusCode).toBe(400);
  });

  it('rejected hypotheses never drive the daily queue', async () => {
    await runDiscriminatingActivity(true); // → rejected
    const queue = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/queue`,
    });
    const items = queue.json().items as Array<{ kind: string; misconceptionId: string | null }>;
    expect(items.every((i) => i.misconceptionId !== misconception.id)).toBe(true);
  });

  it('confirmed hypotheses appear in the daily queue as repair items', async () => {
    await runDiscriminatingActivity(false); // → confirmed
    const queue = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/queue`,
    });
    const repair = (
      queue.json().items as Array<{ kind: string; misconceptionId: string | null }>
    ).find((i) => i.kind === 'misconception_repair');
    expect(repair?.misconceptionId).toBe(misconception.id);
  });
});
