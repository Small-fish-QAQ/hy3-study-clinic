import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, cmd, GOLDEN_TEXT } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type {
  PlanInput,
  PlanOutput,
  PlanRevisionInput,
  PlanRevisionOutput,
} from '../llm/courseContract.js';
import { ProviderError } from '../llm/errors.js';
import { mergePlanRevision, planRevisionInput } from './coursePlanRevision.js';
import { coursePlanIssues } from './coursePlanValidation.js';
import { sha256 } from '../util/canonical.js';

class LocalPlan extends CourseFakeProvider {
  partial = false;
  timeout = false;
  revisions: PlanRevisionInput[] = [];
  override async generateCoursePlan(input: PlanInput) {
    const value = (await super.generateCoursePlan(input)) as PlanOutput;
    value.lessons[0]!.knowledgeIds.push(value.lessons[1]!.knowledgeIds[0]!);
    value.assessmentDesign.cells.at(-1)!.objectiveIds = [value.lessons[0]!.objectives[0]!.id];
    return value;
  }
  override async reviseCoursePlan(input: PlanRevisionInput): Promise<PlanRevisionOutput> {
    this.calls.reviseCoursePlan = (this.calls.reviseCoursePlan ?? 0) + 1;
    this.revisions.push(structuredClone(input));
    if (this.timeout) {
      this.timeout = false;
      throw ProviderError.timeout(1);
    }
    const value = structuredClone(input.draft);
    for (const lesson of value.lessons)
      for (const id of lesson.knowledgeIds)
        if (!lesson.objectives.some((o) => o.knowledgeIds.includes(id)))
          lesson.objectives.push({
            id: `additional_${id}`,
            title: input.knowledge.find((k) => k.id === id)!.title,
            knowledgeIds: [id],
            demand: 'understand',
          });
    if (!this.partial)
      for (const domain of value.assessmentDesign.domains)
        for (const id of domain.coreObjectiveIds)
          if (
            !value.assessmentDesign.cells.some(
              (c) => c.domainId === domain.id && c.objectiveIds.includes(id),
            )
          )
            value.assessmentDesign.cells
              .find((c) => c.domainId === domain.id)!
              .objectiveIds.push(id);
    return value;
  }
}
const start = (f: ReturnType<typeof fixture>) =>
  f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
    sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
  });

describe('规划候选、局部修订与持久恢复', () => {
  it('蓝图局部修订可看到健康外部身份，新增能力不覆盖旧cell或目标', async () => {
    const f = fixture();
    try {
      const plan = await f.prepare(),
        inventory = f.c.planning.inventory(plan);
      const raw = f.c.repo.payload<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates',
      )!.value;
      raw.assessmentDesign.cells.forEach((c, i) => {
        c.id = `C${i + 1}`;
      });
      raw.assessmentDesign.requiredCellIds = raw.assessmentDesign.cells.map((c) => c.id);
      const foreign = raw.lessons.at(-1)!.objectives[0]!;
      raw.assessmentDesign.domains[0]!.coreObjectiveIds.push(foreign.id);
      const input = planRevisionInput(raw, inventory, coursePlanIssues(raw, inventory));
      expect(input.draft.lessons).toHaveLength(0);
      expect(input.references.assessmentDesign!.cells).toHaveLength(
        raw.assessmentDesign.cells.length,
      );
      const patch = structuredClone(input.draft),
        domain = patch.assessmentDesign.domains[0]!;
      domain.knowledgeIds.push(...foreign.knowledgeIds);
      const reserved = new Set(input.references.assessmentDesign!.cells.map((c) => c.id));
      let next = 1;
      while (reserved.has(`C${next}`)) next++;
      patch.assessmentDesign.cells.push({
        id: `C${next}`,
        domainId: domain.id,
        objectiveIds: [foreign.id],
        demand: foreign.demand,
        difficultyBand: 'standard',
        mandatoryKnowledgeIds: foreign.knowledgeIds,
        representativeSets: [],
        weight: 0.1,
        rationale: '指定核心目标的真实应用',
      });
      patch.assessmentDesign.requiredCellIds.push(`C${next}`);
      const merged = mergePlanRevision(raw, input, patch);
      expect(coursePlanIssues(merged, inventory)).toEqual([]);
      expect(merged.lessons).toEqual(raw.lessons);
      for (const c of raw.assessmentDesign.cells.filter(
        (c) => !input.draft.assessmentDesign.cells.some((a) => a.id === c.id),
      ))
        expect(merged.assessmentDesign.cells.find((a) => a.id === c.id)).toEqual(c);
    } finally {
      await f.close();
    }
  });
  it('重复目标消歧后不得把坏身份重新加回领域/cell，健康核心目标仍保留', async () => {
    const f = fixture();
    try {
      const plan = await f.prepare(),
        inventory = f.c.planning.inventory(plan);
      const raw = f.c.repo.payload<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates',
      )!.value;
      const duplicate = raw.lessons[0]!.objectives[0]!.id;
      const oldSecond = raw.lessons[1]!.objectives[0]!.id;
      raw.lessons[1]!.objectives[0]!.id = duplicate;
      raw.assessmentDesign.domains[1]!.coreObjectiveIds = [duplicate];
      raw.assessmentDesign.cells[1]!.objectiveIds = [duplicate];
      const input = planRevisionInput(raw, inventory, coursePlanIssues(raw, inventory));
      const patch = structuredClone(input.draft);
      patch.lessons.find((l) => l.id === raw.lessons[1]!.id)!.objectives[0]!.id = oldSecond;
      patch.assessmentDesign.domains.find(
        (d) => d.id === raw.assessmentDesign.domains[1]!.id,
      )!.coreObjectiveIds = [oldSecond];
      patch.assessmentDesign.cells.find(
        (c) => c.id === raw.assessmentDesign.cells[1]!.id,
      )!.objectiveIds = [oldSecond];
      const merged = mergePlanRevision(raw, input, patch);
      expect(coursePlanIssues(merged, inventory)).toEqual([]);
      expect(merged.assessmentDesign.domains[0]!.coreObjectiveIds).toContain(duplicate);
      expect(merged.assessmentDesign.domains[1]!.coreObjectiveIds).not.toContain(duplicate);
      expect(merged.assessmentDesign.cells[1]!.objectiveIds).toEqual([oldSecond]);
    } finally {
      await f.close();
    }
  });
  it('越界成员是待修候选而非有效成果：允许作者移除，同时保留原领域内必考和代表知识', async () => {
    const f = fixture();
    try {
      const plan = await f.prepare();
      const inventory = f.c.planning.inventory(plan);
      const raw = f.c.repo.payloads<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates',
      )[0]!.value;
      const cell = raw.assessmentDesign.cells[0]!;
      const healthyCell = structuredClone(cell);
      const foreign = raw.lessons[1]!.knowledgeIds[0]!;
      cell.mandatoryKnowledgeIds.push(foreign);
      cell.representativeSets[0]!.candidateKnowledgeIds.push(foreign);
      cell.representativeSets.push({ id: 'invalid-only', candidateKnowledgeIds: [foreign] });
      const findings = coursePlanIssues(raw, inventory);
      expect(findings.map((i) => i.code)).toContain('cell_outside_domain');
      const input = planRevisionInput(raw, inventory, findings);
      const patch = structuredClone(input.draft);
      const replacement = patch.assessmentDesign.cells[0]!;
      replacement.mandatoryKnowledgeIds = [];
      replacement.representativeSets = healthyCell.representativeSets.map((s) => ({
        ...s,
        candidateKnowledgeIds: [],
      }));
      const merged = mergePlanRevision(raw, input, patch);
      expect(coursePlanIssues(merged, inventory)).toEqual([]);
      expect(merged.assessmentDesign.cells[0]).toEqual(healthyCell);
      expect(merged.lessons).toEqual(raw.lessons);
      expect(merged.assessmentDesign.requiredCellIds).toEqual(raw.assessmentDesign.requiredCellIds);
      expect(merged.assessmentDesign.cells.slice(1)).toEqual(raw.assessmentDesign.cells.slice(1));
    } finally {
      await f.close();
    }
  });
  it('同时定位Lesson目标和另一领域的蓝图缺口，仅修具体对象并保留健康兄弟', async () => {
    const provider = new LocalPlan();
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      await f.settle(start(f));
      const input = provider.revisions[0]!;
      expect(provider.calls.generateCoursePlan).toBe(1);
      expect(provider.calls.reviseCoursePlan).toBe(1);
      expect(input.draft.lessons).toHaveLength(1);
      expect(input.findings.map((i) => i.code)).toContain('missing_teaching_objective');
      expect(input.findings.map((i) => i.code)).toContain('missing_core_assessment');
      expect(input.findings.every((i) => i.path && i.message)).toBe(true);
      expect(input.knowledge.every((k) => !k.sourceSpans.length)).toBe(true);
      const candidates = f.c.repo.payloads<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates ORDER BY rowid',
      );
      expect(candidates).toHaveLength(2);
      expect(sha256(candidates[0]!.value.lessons[2])).toBe(sha256(candidates[1]!.value.lessons[2]));
      expect(f.c.planning.get(f.workspace.id)!.status).toBe('draft');
    } finally {
      await f.close();
    }
  });
  it('一次修订仍有局部缺口时，冷重启从修订候选继续且只买蓝图修订', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clinic-plan-recovery-'));
    const path = join(dir, 'study.sqlite');
    const provider = new LocalPlan();
    provider.partial = true;
    const f = fixture(provider, path);
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      const first = start(f);
      await f.c.operations.idle(first.id);
      const failed = f.c.operations.get(f.workspace.id, first.id);
      expect(failed.status).toBe('failed');
      expect(f.c.planning.get(f.workspace.id)).toBeNull();
      const workspace = f.workspace.id;
      const repaired = f.c.repo.payloads<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates ORDER BY rowid DESC',
      )[0]!;
      expect(repaired.value.lessons[0]!.objectives).toHaveLength(2);
      await f.close();
      const nextProvider = new LocalPlan();
      const next = fixture(nextProvider, path);
      try {
        expect(nextProvider.calls).toEqual({});
        const operation = next.c.operations.retry(workspace, failed.id, cmd(), failed.version);
        await next.c.operations.idle(operation.id);
        expect(next.c.operations.get(workspace, operation.id).status).toBe('completed');
        expect(nextProvider.calls.generateCoursePlan).toBeUndefined();
        expect(nextProvider.calls.reviseCoursePlan).toBe(1);
        expect(nextProvider.revisions[0]!.draft.lessons).toHaveLength(0);
        expect(nextProvider.revisions[0]!.findings.every((i) => i.domainIds?.length)).toBe(true);
        expect(next.c.repo.rows('SELECT id FROM course_plan_candidates')).toHaveLength(3);
        expect(next.db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        await next.close();
      }
    } finally {
      if (f.db.open) await f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('修订技术超时后显式retry复用原候选、不重买知识或完整规划', async () => {
    const provider = new LocalPlan();
    provider.timeout = true;
    const f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      const first = start(f);
      await f.c.operations.idle(first.id);
      const old = f.c.operations.get(f.workspace.id, first.id);
      expect(old.error?.code).toBe('PROVIDER_TIMEOUT');
      await f.settle(f.c.operations.retry(f.workspace.id, old.id, cmd(), old.version));
      expect(provider.calls.generateCoursePlan).toBe(1);
      expect(provider.calls.extractCourseKnowledge).toBe(1);
      expect(provider.calls.reviseCoursePlan).toBe(2);
      expect(provider.revisions[0]).toEqual(provider.revisions[1]);
    } finally {
      await f.close();
    }
  });
  it('唯一已有能力满足声明核心目标时补必考集合；无需模型改变教学语义', async () => {
    class Membership extends CourseFakeProvider {
      override async generateCoursePlan(input: PlanInput) {
        const value = (await super.generateCoursePlan(input)) as PlanOutput;
        value.assessmentDesign.requiredCellIds = value.assessmentDesign.requiredCellIds.slice(1);
        return value;
      }
    }
    const provider = new Membership();
    const f = fixture(provider);
    try {
      const plan = await f.prepare();
      expect(provider.calls.generateCoursePlan).toBe(1);
      expect(provider.calls.reviseCoursePlan).toBeUndefined();
      expect(plan.assessmentBlueprint.requiredCellIds).toHaveLength(
        plan.assessmentBlueprint.cells.length,
      );
    } finally {
      await f.close();
    }
  });
  it('边界检查拒绝降低核心目标和改写健康Lesson，仍保留未验收状态', async () => {
    const f = fixture();
    try {
      const plan = await f.prepare();
      const inventory = f.c.planning.inventory(plan);
      const raw = f.c.repo.payloads<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates',
      )[0]!.value;
      raw.assessmentDesign.cells[0]!.demand = 'remember';
      const input = planRevisionInput(raw, inventory, coursePlanIssues(raw, inventory));
      const patch = structuredClone(input.draft);
      const retainedMembership = mergePlanRevision(raw, input, {
        ...patch,
        assessmentDesign: { ...patch.assessmentDesign, requiredCellIds: [] },
      });
      expect(retainedMembership.assessmentDesign.requiredCellIds).toEqual(
        raw.assessmentDesign.requiredCellIds,
      );
      patch.assessmentDesign.domains[0]!.required = false;
      expect(() => mergePlanRevision(raw, input, patch)).toThrow('核心领域');
      patch.assessmentDesign.domains[0]!.required = true;
      patch.lessons = [{ ...raw.lessons[1]!, title: '未经许可的新课' }];
      expect(() => mergePlanRevision(raw, input, patch)).toThrow('未受影响Lesson');
    } finally {
      await f.close();
    }
  });
  it('仅修蓝图时携带健康目标的完整知识，漏抄成员由服务器保留且健康Lesson不变', async () => {
    const f = fixture();
    try {
      const plan = await f.prepare();
      const inventory = f.c.planning.inventory(plan);
      const raw = f.c.repo.payloads<{ value: PlanOutput }>(
        'SELECT payload FROM course_plan_candidates',
      )[0]!.value;
      const foreignObjective = raw.lessons[1]!.objectives[0]!;
      const domain = raw.assessmentDesign.domains[0]!;
      domain.coreObjectiveIds.push(foreignObjective.id);
      const issues = coursePlanIssues(raw, inventory);
      expect(issues.some((i) => i.code === 'core_objective_outside_domain')).toBe(true);
      const input = planRevisionInput(raw, inventory, issues);
      expect(input.draft.lessons).toEqual([]);
      expect(
        foreignObjective.knowledgeIds.every((id) => input.knowledge.some((k) => k.id === id)),
      ).toBe(true);
      const patch = structuredClone(input.draft);
      patch.assessmentDesign.domains[0]!.knowledgeIds.push(...foreignObjective.knowledgeIds);
      const cell = patch.assessmentDesign.cells[0]!;
      cell.objectiveIds = [foreignObjective.id];
      cell.mandatoryKnowledgeIds = [];
      cell.representativeSets = [];
      const merged = mergePlanRevision(raw, input, patch);
      expect(coursePlanIssues(merged, inventory)).toEqual([]);
      expect(merged.lessons).toEqual(raw.lessons);
      expect(merged.assessmentDesign.cells[0]!.objectiveIds).toEqual(
        expect.arrayContaining(raw.assessmentDesign.cells[0]!.objectiveIds),
      );
      expect(merged.assessmentDesign.cells[0]!.representativeSets).toEqual(
        raw.assessmentDesign.cells[0]!.representativeSets,
      );
      expect(merged.assessmentDesign.cells[0]!.mandatoryKnowledgeIds).toEqual(
        raw.assessmentDesign.cells[0]!.mandatoryKnowledgeIds,
      );
    } finally {
      await f.close();
    }
  });
});
