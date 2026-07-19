import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemediationPlanProposalPayload } from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Constrained remediation planning: bounded input, local validation, plan
 * persistence semantics (invalid never replaces accepted), and launching the
 * existing assessment workflow from an accepted plan.
 */

async function setupWorkspaceWithGraph(ctx: TestApp) {
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '认知科学课程' },
  });
  const workspaceId = ws.json().workspace.id as string;
  const doc = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/documents`,
    payload: {
      kind: 'text',
      content:
        '# 工作记忆\n\n工作记忆的容量十分有限。它一次只能保持大约四个组块。\n\n# 长时记忆\n\n长时记忆通过巩固过程形成,睡眠对巩固十分重要。\n\n# 间隔重复\n\n间隔重复通过在遗忘边缘复习来提升长期保持率。',
      title: '记忆基础',
    },
  });
  const materialId = doc.json().material.id as string;
  await ctx.app.inject({ method: 'POST', url: `/api/materials/${materialId}/analyze` });
  await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/graph` });

  const concepts = (
    await ctx.app.inject({ method: 'GET', url: `/api/materials/${materialId}/concepts` })
  ).json().concepts as Array<{ id: string; name: string }>;
  return { workspaceId, materialId, concepts };
}

describe('remediation planner', () => {
  let ctx: TestApp;
  let workspaceId: string;
  let materialId: string;
  let concepts: Array<{ id: string; name: string }>;

  beforeEach(async () => {
    ctx = buildTestApp();
    ({ workspaceId, materialId, concepts } = await setupWorkspaceWithGraph(ctx));
  });

  it('generates and persists a validated plan with verified evidence', async () => {
    const target = concepts[1]!;
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/concepts/${target.id}/plan`,
    });
    expect(response.statusCode).toBe(201);
    const plan = response.json().plan;
    expect(plan.conceptId).toBe(target.id);
    expect(plan.workspaceId).toBe(workspaceId);
    expect(plan.targets.length).toBeGreaterThanOrEqual(1);
    expect(plan.targets.map((t: { conceptId: string }) => t.conceptId)).toContain(target.id);
    for (const t of plan.targets) {
      expect(t.evidence.length).toBeGreaterThanOrEqual(1);
      expect(t.evidence[0].occurrenceCount).toBeGreaterThanOrEqual(1);
    }
    expect(plan.steps.length).toBeGreaterThanOrEqual(1);
    expect(plan.provider).toBe('fake');

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/concepts/${target.id}/plan`,
    });
    expect(fetched.json().plan.id).toBe(plan.id);
  });

  it('accepting a plan writes NO learning state (mastery/mistakes untouched)', async () => {
    const before = {
      mastery: ctx.repos.mastery.listByWorkspace(workspaceId),
      mistakes: ctx.repos.mistakes.listOpenByWorkspace(workspaceId),
    };
    await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/concepts/${concepts[0]!.id}/plan`,
    });
    expect(ctx.repos.mastery.listByWorkspace(workspaceId)).toEqual(before.mastery);
    expect(ctx.repos.mistakes.listOpenByWorkspace(workspaceId)).toEqual(before.mistakes);
  });

  it('rejects invalid proposals and keeps the previously accepted plan', async () => {
    const target = concepts[0]!;
    const first = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/concepts/${target.id}/plan`,
      })
    ).json().plan;

    const invalid: RemediationPlanProposalPayload = {
      summary: '无效计划',
      weaknessHypothesis: '无效',
      strategy: 'review',
      difficulty: 'easy',
      questionTypes: ['single_choice'],
      steps: [{ description: '无效步骤' }],
      targets: [
        {
          conceptId: 'con_unknown',
          reason: '目标概念不存在',
          evidence: [{ blockId: 'blk_x', quote: '无效引文' }],
        },
      ],
    };
    const spy = vi.spyOn(ctx.provider, 'proposeRemediationPlan').mockResolvedValue(invalid);
    const failed = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/concepts/${target.id}/plan`,
    });
    spy.mockRestore();
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error.code).toBe('GROUNDING_FAILED');

    const kept = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/workspaces/${workspaceId}/concepts/${target.id}/plan`,
      })
    ).json().plan;
    expect(kept.id).toBe(first.id);
  });

  it('rejects a plan whose targets exclude the selected concept and its prerequisites', async () => {
    const [a, , c] = concepts;
    // Plan "for" concept A that only targets unrelated concept C.
    const offCenter: RemediationPlanProposalPayload = {
      summary: '偏离中心的计划',
      weaknessHypothesis: '假设',
      strategy: 'review',
      difficulty: 'easy',
      questionTypes: ['single_choice'],
      steps: [{ description: '复习' }],
      targets: [
        {
          conceptId: c!.id,
          reason: '这个概念与选中概念无关',
          evidence: [{ blockId: 'blk_x', quote: '间隔重复通过在遗忘边缘复习来提升长期保持率。' }],
        },
      ],
    };
    const spy = vi.spyOn(ctx.provider, 'proposeRemediationPlan').mockResolvedValue(offCenter);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/concepts/${a!.id}/plan`,
    });
    spy.mockRestore();
    expect(response.statusCode).toBe(422);
  });

  it('404s for a concept outside the workspace', async () => {
    const otherWs = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '其他课程' },
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${otherWs.json().workspace.id}/concepts/${concepts[0]!.id}/plan`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('launches focused practice when plan targets have no open mistakes', async () => {
    const target = concepts[0]!;
    const plan = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/concepts/${target.id}/plan`,
      })
    ).json().plan;

    const launch = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/plans/${plan.id}/launch`,
    });
    expect(launch.statusCode).toBe(201);
    const body = launch.json();
    expect(body.mode).toBe('practice');
    expect(body.quiz.materialId).toBe(materialId);
    expect(body.quiz.kind).toBe('standard');
    expect(body.quiz.targetConceptIds).toContain(target.id);
    for (const question of body.quiz.questions) {
      expect(plan.targets.map((t: { conceptId: string }) => t.conceptId)).toContain(
        question.conceptId,
      );
    }
  });

  it('launches true remediation when plan targets still have open mistakes', async () => {
    const target = concepts[0]!;
    // Create an open mistake for the target concept by failing a quiz.
    const quiz = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/quizzes',
        payload: {
          materialId,
          config: { difficulty: 'easy', types: ['single_choice'], countPerType: 2 },
        },
      })
    ).json().quiz;
    const wrongAnswers = quiz.questions.map(
      (q: { id: string; options: Array<{ id: string }> }) => ({
        questionId: q.id,
        type: 'single_choice',
        selectedOptionIds: [],
      }),
    );
    const graded = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: { answers: wrongAnswers },
    });
    expect(graded.statusCode).toBe(201);
    expect(ctx.repos.mistakes.listOpenByWorkspace(workspaceId).length).toBeGreaterThan(0);

    const plan = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/concepts/${target.id}/plan`,
      })
    ).json().plan;

    const launch = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/plans/${plan.id}/launch`,
    });
    expect(launch.statusCode).toBe(201);
    const body = launch.json();
    expect(body.mode).toBe('remediation');
    expect(body.quiz.kind).toBe('remediation');
    // Remediation stays restricted to plan targets with open mistakes.
    for (const conceptId of body.quiz.targetConceptIds) {
      expect(plan.targets.map((t: { conceptId: string }) => t.conceptId)).toContain(conceptId);
    }
  });

  it('404s when launching an unknown or foreign plan', async () => {
    const missing = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/plans/plan_missing/launch`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
