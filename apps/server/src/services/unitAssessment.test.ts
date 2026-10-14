import { describe, expect, it, vi } from 'vitest';
import { COURSE_POLICY, type CoursePlan, type CourseQuiz } from '@hy3-clinic/shared';
import { assessmentScope } from './unitAssessment.js';
import { checkPaperCoverage } from './courseQuestions.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { canonical, sha256, stableId } from '../util/canonical.js';

// One broad course pool contains examples for two distinct teaching targets.
// The second target is deliberately absent from the course's core-objective list.
function coarseMap(): CoursePlan {
  return {
    formatVersion: 2,
    id: 'p',
    workspaceId: 'w',
    inventoryId: 'i',
    planningPolicyVersion: COURSE_POLICY,
    title: '资料分析',
    modules: [
      { id: 'm', title: '资料判读' },
      { id: 'other', title: '其他主题' },
    ],
    lessons: [
      {
        id: 'l1',
        moduleId: 'm',
        title: '单条件分析',
        summary: '分析单条件资料',
        knowledgeIds: ['a', 'b', 'c', 'd'],
        objectives: [
          { id: 'method', title: '运用分析方法', knowledgeIds: ['a'], demand: 'apply' },
          {
            id: 'simple',
            title: '对单条件资料建模并判断',
            knowledgeIds: ['b', 'c', 'd'],
            demand: 'apply',
          },
        ],
        prerequisiteLessonIds: [],
        recommendedDepth: 'standard',
        selectedDepth: 'standard',
        estimatedMinutes: 30,
      },
      {
        id: 'l2',
        moduleId: 'm',
        title: '多条件分析',
        summary: '综合交互条件',
        knowledgeIds: ['e', 'f', 'g'],
        objectives: [
          {
            id: 'interacting',
            title: '分析多条件资料的共同作用',
            knowledgeIds: ['e', 'f', 'g'],
            demand: 'apply',
          },
        ],
        prerequisiteLessonIds: ['l1'],
        recommendedDepth: 'standard',
        selectedDepth: 'standard',
        estimatedMinutes: 30,
      },
      {
        id: 'l3',
        moduleId: 'other',
        title: '其他资料',
        summary: '其他内容',
        knowledgeIds: ['z'],
        objectives: [
          { id: 'otherGoal', title: '解释其他资料', knowledgeIds: ['z'], demand: 'understand' },
        ],
        prerequisiteLessonIds: [],
        recommendedDepth: 'standard',
        selectedDepth: 'standard',
        estimatedMinutes: 20,
      },
    ],
    teachingRequiredKnowledgeIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'z'],
    assessmentBlueprint: {
      id: 'bp',
      curriculumId: 'p',
      sourceScopeHash: 'source',
      policyVersion: COURSE_POLICY,
      passThreshold: 0.6,
      domains: [
        {
          id: 'domain',
          title: '分析能力',
          knowledgeIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'z'],
          coreObjectiveIds: ['method', 'simple', 'otherGoal'],
          required: true,
          rationale: '综合考试取样',
        },
      ],
      cells: [
        {
          id: 'cell',
          domainId: 'domain',
          objectiveIds: ['method', 'simple'],
          demand: 'apply',
          difficultyBand: 'standard',
          mandatoryKnowledgeIds: ['a'],
          representativeSets: [
            { id: 'mixed', candidateKnowledgeIds: ['b', 'c', 'd', 'e', 'f', 'g'] },
          ],
          weight: 0.6,
          rationale: '方法与例子代表',
        },
        {
          id: 'otherCell',
          domainId: 'domain',
          objectiveIds: ['otherGoal'],
          demand: 'understand',
          difficultyBand: 'basic',
          mandatoryKnowledgeIds: ['z'],
          representativeSets: [],
          weight: 0.4,
          rationale: '另一个领域',
        },
      ],
      requiredCellIds: ['cell', 'otherCell'],
    },
    status: 'accepted',
    version: 1,
    warnings: [],
  };
}

describe('单元 Formal 的教学目标代表性', () => {
  it('跨课任选池保留原权重与必考命题，但不能用一课代表另一独立目标', () => {
    const plan = coarseMap(),
      before = sha256(plan);
    const { blueprint } = assessmentScope(plan, 'm');
    expect(blueprint.cells).toHaveLength(1); // Three goals do not imply three questions.
    expect(blueprint.objectiveRequirements?.map((o) => o.id)).toEqual([
      'method',
      'simple',
      'interacting',
    ]);
    const cell = blueprint.cells[0]!;
    expect(cell.objectiveIds).toEqual(['method', 'simple', 'interacting']);
    expect(cell.mandatoryKnowledgeIds).toEqual(['a']);
    expect(cell.weight).toBe(0.6);
    expect(cell.demand).toBe('apply');
    expect(cell.representativeSets.map((s) => s.candidateKnowledgeIds)).toEqual([
      ['b', 'c', 'd', 'e', 'f', 'g'],
      ['b', 'c', 'd'],
      ['e', 'f', 'g'],
    ]);
    expect(sha256(plan)).toBe(before);
    expect(assessmentScope(plan).blueprint).toBe(plan.assessmentBlueprint);
  });

  it('课程背景目标、混合选考cell和跨单元cell仍能编译本单元能力，拓展知识不变成必考', () => {
    const plan = coarseMap();
    plan.lessons[2]!.moduleId = 'm';
    plan.assessmentBlueprint.requiredCellIds = ['cell'];
    plan.assessmentBlueprint.cells[0]!.representativeSets[0]!.candidateKnowledgeIds = [
      'b',
      'c',
      'd',
    ];
    plan.lessons[1]!.knowledgeIds.push('extension');
    plan.lessons[1]!.objectives.push({
      id: 'extra',
      title: '拓展设计',
      knowledgeIds: ['extension'],
      demand: 'design',
    });
    const local = assessmentScope(plan, 'm').blueprint;
    expect(local.requiredCellIds).toContain('otherCell');
    expect(local.objectiveRequirements?.map((o) => o.id)).toContain('interacting');
    expect(local.objectiveRequirements?.map((o) => o.id)).not.toContain('extra');
    expect(local.cells).toHaveLength(3);
    expect(local.cells.at(-1)!.mandatoryKnowledgeIds).toEqual([]);
    const deeper = structuredClone(plan);
    deeper.lessons[1]!.selectedDepth = 'proficient';
    expect(assessmentScope(deeper, 'm').blueprint.id).not.toBe(local.id);
    expect(local.cells.at(-1)!.representativeSets[0]!.candidateKnowledgeIds).toEqual([
      'e',
      'f',
      'g',
    ]);
    expect(
      local.cells.flatMap((c) => c.representativeSets.flatMap((s) => s.candidateKnowledgeIds)),
    ).not.toContain('extension');

    const crossing = coarseMap();
    crossing.lessons[0]!.moduleId = 'other';
    const secondUnit = assessmentScope(crossing, 'm').blueprint;
    expect(secondUnit.cells[0]!.objectiveIds).toEqual(['interacting']);
    expect(secondUnit.cells[0]!.mandatoryKnowledgeIds).toEqual([]);
    expect(secondUnit.cells[0]!.representativeSets[0]!.candidateKnowledgeIds).toEqual([
      'e',
      'f',
      'g',
    ]);
  });

  it('同一知识的不同认知目标必须被盲解实际支持，贴目标标签不能让卷就绪或扩大 Evidence', async () => {
    const provider = new CourseFakeProvider(),
      f = fixture(provider);
    try {
      const planAuthor = provider.generateCoursePlan.bind(provider);
      vi.spyOn(provider, 'generateCoursePlan').mockImplementation(async (input, options) => {
        const output = await planAuthor(input, options);
        if (!('lessons' in output)) return output;
        output.lessons[0]!.objectives.push({
          id: 'diagnostic-goal',
          title: '诊断同一资料中的错误及其条件',
          knowledgeIds: [...output.lessons[0]!.knowledgeIds],
          demand: 'analyze',
        });
        return output;
      });
      const plan = f.accept(await f.prepare());
      const target = plan.lessons[0]!.objectives.find((o) => o.demand === 'analyze')!;
      const solve = provider.solveQuestion.bind(provider);
      vi.spyOn(provider, 'solveQuestion').mockImplementation(async (input, options) => {
        const value = await solve(input, options);
        // The knowledge is real, but the task does not require error diagnosis.
        value.assessedObjectiveIds = value.assessedObjectiveIds?.filter((id) => id !== target.id);
        return value;
      });
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareFormal',
        'formal:labels',
        'formal',
        {
          curriculumId: plan.id,
          blueprintId: plan.assessmentBlueprint.id,
          paperRequestId: 'labels',
          moduleId: plan.modules[0]!.id,
        },
      );
      await f.c.operations.idle(op.id);
      expect(f.c.operations.get(f.workspace.id, op.id).status).toBe('failed');
      const quiz = f.c.repo.payloads<CourseQuiz>('SELECT payload FROM quizzes')[0]!;
      expect(quiz.status).toBe('draft');
      expect(quiz.discarded[0]!.reasons).toContain(`实测教学目标缺少独立支持:${target.id}`);
      expect(checkPaperCoverage(quiz)).toContain(`缺少实测教学目标:${target.id}`);
      expect(provider.calls.generateQuestions).toBe(2); // Only the failing cell is replaced once.
      expect(f.c.records(f.workspace.id).formalGrades).toEqual([]);
      expect(f.c.repo.rows('SELECT * FROM evidence')).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('已有单元试卷请求返回冻结蓝图，新请求承接目标；冲突范围仍拒绝且不重购', async () => {
    const f = fixture();
    try {
      const plan = f.accept(await f.prepare());
      const full = await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'prepareFormal', 'formal:old', 'formal', {
          curriculumId: plan.id,
          blueprintId: plan.assessmentBlueprint.id,
          paperRequestId: 'old',
        }),
      );
      const original = f.c.questions.get(f.workspace.id, full.resourceId!);
      const legacy: CourseQuiz = {
        ...original,
        id: stableId('quiz', {
          workspace: f.workspace.id,
          purpose: 'formal',
          requestId: 'legacy-unit',
        }),
        requestId: 'legacy-unit',
        assessmentScope: assessmentScope(plan, plan.modules[0]!.id).scope,
      };
      const bytes = canonical(legacy);
      f.c.repo.run(
        'INSERT INTO quizzes VALUES(?,?,?,?,?,?,?,?)',
        legacy.id,
        f.workspace.id,
        plan.id,
        'formal',
        legacy.requestId,
        legacy.status,
        bytes,
        f.c.repo.now(),
      );
      const author = vi.spyOn(f.provider, 'generateQuestions');
      const request = {
        curriculumId: plan.id,
        blueprintId: plan.assessmentBlueprint.id,
        paperRequestId: 'legacy-unit',
        moduleId: plan.modules[0]!.id,
      };
      const oldOp = await f.settle(
        f.c.operations.start(
          f.workspace.id,
          cmd(),
          'prepareFormal',
          'formal:legacy',
          'formal',
          request,
        ),
      );
      expect(oldOp.resourceId).toBe(legacy.id);
      expect(author).not.toHaveBeenCalled();
      expect(
        f.c.repo.row<{ payload: string }>('SELECT payload FROM quizzes WHERE id=?', legacy.id)!
          .payload,
      ).toBe(bytes);
      const conflict = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareFormal',
        'formal:conflict',
        'formal',
        { ...request, moduleId: undefined },
      );
      await f.c.operations.idle(conflict.id);
      expect(f.c.operations.get(f.workspace.id, conflict.id).error?.code).toBe('VERSION_CONFLICT');
      const fresh = await f.settle(
        f.c.operations.start(f.workspace.id, cmd(), 'prepareFormal', 'formal:fresh', 'formal', {
          ...request,
          paperRequestId: 'fresh-unit',
        }),
      );
      const paper = f.c.questions.get(f.workspace.id, fresh.resourceId!);
      expect(paper.blueprint!.objectiveRequirements).toEqual(
        plan.lessons.flatMap((l) => l.objectives),
      );
      expect(checkPaperCoverage(paper)).toEqual([]);
      expect(
        paper.items.every((q) => q.admission.coverage.some((c) => c.objectiveIds?.length)),
      ).toBe(true);
      expect(
        f.c.repo.row<{ payload: string }>('SELECT payload FROM quizzes WHERE id=?', legacy.id)!
          .payload,
      ).toBe(bytes);
    } finally {
      await f.close();
    }
  });
});
