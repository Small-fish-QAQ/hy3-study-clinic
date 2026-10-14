import { describe, it, expect } from 'vitest';
import { fixture, cmd, GOLDEN_TEXT } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import { validateCoursePlan } from './coursePlanning.js';
import type { PlanInput, PlanOutput } from '../llm/courseContract.js';
import type { ProviderCallOptions } from '../llm/provider.js';

describe('真实规划暴露的深度归一化与可选领域边界', () => {
  it('选定深度不能因知识kind是习题而降格作者的实际证明目标，解释目标也不强行升为应用', async () => {
    class Intended extends CourseFakeProvider {
      override async extractCourseKnowledge(
        input: Parameters<CourseFakeProvider['extractCourseKnowledge']>[0],
      ) {
        const value = await super.extractCourseKnowledge(input);
        value.knowledge.forEach((k) => {
          k.kind = 'concept';
        });
        return value;
      }
      override async generateCoursePlan(input: PlanInput, options?: ProviderCallOptions) {
        const value = (await super.generateCoursePlan(input, options)) as PlanOutput;
        value.lessons[0]!.objectives[0]!.demand = 'apply';
        value.lessons[0]!.objectives[0]!.title = '完成新情境证明';
        value.lessons[0]!.objectives.push({
          ...value.lessons[0]!.objectives[0]!,
          id: 'explain',
          title: '解释给定命题',
          demand: 'understand',
        });
        value.assessmentDesign.cells[0]!.demand = 'apply';
        return value;
      }
    }
    const f = fixture(new Intended());
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
          sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
          preferences: { desiredDepth: 'standard', focusRequest: '' },
        }),
      );
      const plan = f.c.planning.get(f.workspace.id)!;
      expect(plan.lessons[0]!.objectives[0]!.demand).toBe('apply');
      expect(plan.lessons[0]!.objectives[1]!.demand).toBe('understand');
      expect(plan.assessmentBlueprint.cells[0]!.demand).toBe('apply');
    } finally {
      await f.close();
    }
  });
  it('先应用选定深度并同步蓝图，保留可选领域目标；必考领域仍不能缺能力或降格', async () => {
    class Proposer extends CourseFakeProvider {
      override async generateCoursePlan(input: PlanInput, options?: ProviderCallOptions) {
        const value = (await super.generateCoursePlan(input, options)) as PlanOutput;
        value.lessons.forEach((l) =>
          l.objectives.forEach((o) => {
            o.demand = 'analyze';
          }),
        );
        value.assessmentDesign.cells.forEach((c) => {
          c.demand = 'apply';
        });
        value.assessmentDesign.domains.push({
          ...value.assessmentDesign.domains[0]!,
          id: 'optional',
          title: '可选方法辨析',
          required: false,
        });
        return value;
      }
    }
    const provider = new Proposer();
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
          sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
          preferences: { desiredDepth: 'standard', focusRequest: '' },
        }),
      );
      const plan = f.c.planning.get(f.workspace.id)!;
      const inventory = f.c.planning.inventory(plan);
      expect(provider.calls.generateCoursePlan).toBe(1);
      expect(validateCoursePlan(plan, inventory)).toBeDefined();
      expect(() =>
        validateCoursePlan(
          {
            ...plan,
            assessmentBlueprint: {
              ...plan.assessmentBlueprint,
              domains: plan.assessmentBlueprint.domains.map((d) => ({ ...d, required: true })),
            },
          },
          inventory,
        ),
      ).toThrow('核心');
      expect(() =>
        validateCoursePlan(
          {
            ...plan,
            assessmentBlueprint: {
              ...plan.assessmentBlueprint,
              cells: plan.assessmentBlueprint.cells.map((c) => ({ ...c, demand: 'remember' })),
            },
          },
          inventory,
        ),
      ).toThrow('降格');
    } finally {
      await f.close();
    }
  });
  it('失败校验后保留的完整候选重新校验时保持原始物理出处，正确候选无需重买整个规划', async () => {
    const f = fixture();
    try {
      await f.prepare();
      const call = f.c.repo.row<{ id: string; payload: string }>(
        "SELECT id,payload FROM llm_calls WHERE method='generateCoursePlan'",
      )!;
      f.c.generation.reject(call.id, ['旧校验错误地要求可选目标必考']);
      f.c.repo.run('DELETE FROM curriculum_versions');
      await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
          sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
        }),
      );
      expect(f.provider instanceof CourseFakeProvider && f.provider.calls.generateCoursePlan).toBe(
        1,
      );
      expect(f.c.planning.get(f.workspace.id)?.status).toBe('draft');
      expect(
        f.c.repo.payload<{ contentRejected: boolean }>(
          'SELECT payload FROM llm_calls WHERE id=?',
          call.id,
        )?.contentRejected,
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
});
