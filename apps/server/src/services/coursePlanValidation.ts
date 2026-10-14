import type { CourseKnowledgeInventory, CoursePlan } from '@hy3-clinic/shared';
import type { PlanOutput } from '../llm/courseContract.js';
import { CourseValidationError, unique, demandRank, type PlanIssue } from './courseValidation.js';
import { sha256 } from '../util/canonical.js';

/** One contract, evaluated before ID compilation so repair locations retain author IDs. */
export function coursePlanIssues(
  output: PlanOutput,
  inventory: CourseKnowledgeInventory,
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (
    code: string,
    path: string,
    message: string,
    scope: Omit<PlanIssue, 'code' | 'path' | 'message'> = {},
  ) => issues.push({ code, path, message, ...scope });
  const knowledge = new Map(inventory.knowledge.map((k) => [k.id, k]));
  const required = inventory.knowledge.filter((k) => k.origin === 'textbook').map((k) => k.id);
  const lessons = new Map(output.lessons.map((l) => [l.id, l]));
  const objectives = new Map(
    output.lessons.flatMap((l) => l.objectives.map((o) => [o.id, o] as const)),
  );
  const blueprint = output.assessmentDesign;
  const domains = new Map(blueprint.domains.map((d) => [d.id, d]));
  const cells = new Map(blueprint.cells.map((c) => [c.id, c]));
  const duplicates = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  for (const id of duplicates(output.lessons.map((l) => l.id)))
    add('duplicate_lesson', 'lessons', `课程结构ID重复: ${id}`, { lessonIds: [id] });
  for (const id of duplicates(output.modules.map((m) => m.id)))
    add('duplicate_module', 'modules', `课程模块ID重复: ${id}`, {
      lessonIds: output.lessons.filter((l) => l.moduleId === id).map((l) => l.id),
    });
  for (const id of duplicates(output.lessons.flatMap((l) => l.objectives.map((o) => o.id))))
    add('duplicate_objective', 'lessons.objectives', `目标ID重复: ${id}`, {
      lessonIds: output.lessons
        .filter((l) => l.objectives.some((o) => o.id === id))
        .map((l) => l.id),
      objectiveIds: [id],
    });
  for (const id of required.filter(
    (id) => !output.lessons.some((l) => l.knowledgeIds.includes(id)),
  ))
    add('unallocated_knowledge', 'lessons', `Lesson遗漏必学知识: ${id}`, { knowledgeIds: [id] });
  output.lessons.forEach((lesson, i) => {
    const scope = { lessonIds: [lesson.id] };
    const path = `lessons[${i}](${lesson.id})`;
    if (!output.modules.some((m) => m.id === lesson.moduleId))
      add('unknown_module', `${path}.moduleId`, '模块引用不存在', scope);
    const foreign = lesson.knowledgeIds.filter((id) => !knowledge.has(id));
    if (foreign.length)
      add('foreign_knowledge', `${path}.knowledgeIds`, 'Lesson引用外来知识', {
        ...scope,
        knowledgeIds: foreign,
      });
    if (!unique(lesson.knowledgeIds))
      add('duplicate_knowledge', `${path}.knowledgeIds`, 'Lesson知识重复', scope);
    const invalid = lesson.prerequisiteLessonIds.filter(
      (id) => id === lesson.id || !lessons.has(id),
    );
    if (invalid.length)
      add(
        'invalid_prerequisite',
        `${path}.prerequisiteLessonIds`,
        `先修引用不存在或自环: ${invalid.join(',')}`,
        scope,
      );
    lesson.objectives.forEach((o, j) => {
      const outside = o.knowledgeIds.filter((id) => !lesson.knowledgeIds.includes(id));
      if (outside.length)
        add(
          'objective_outside_lesson',
          `${path}.objectives[${j}](${o.id}).knowledgeIds`,
          '目标绑定课外知识',
          { ...scope, objectiveIds: [o.id], knowledgeIds: outside },
        );
    });
    const missing = lesson.knowledgeIds.filter(
      (id) => !lesson.objectives.some((o) => o.knowledgeIds.includes(id)),
    );
    if (missing.length)
      add('missing_teaching_objective', `${path}.objectives`, '知识缺少教学目标', {
        ...scope,
        knowledgeIds: missing,
      });
  });
  const done = new Set<string>();
  for (;;) {
    const next = output.lessons.find(
      (l) => !done.has(l.id) && l.prerequisiteLessonIds.every((id) => done.has(id)),
    );
    if (!next) break;
    done.add(next.id);
  }
  const unresolved = output.lessons.filter((l) => !done.has(l.id));
  if (
    unresolved.length &&
    !issues.some((i) => i.code === 'invalid_prerequisite' || i.code === 'duplicate_lesson')
  ) {
    // Only nodes in a cycle need repair; dependent nodes keep their valid links.
    const cyclic = unresolved.filter((start) => {
      const seen = new Set<string>();
      const reaches = (id: string): boolean =>
        id === start.id ||
        (!seen.has(id) &&
          (seen.add(id), (lessons.get(id)?.prerequisiteLessonIds ?? []).some(reaches)));
      return start.prerequisiteLessonIds.some(reaches);
    });
    add('prerequisite_cycle', 'lessons.prerequisiteLessonIds', '先修存在环或无法排序', {
      lessonIds: cyclic.map((l) => l.id),
    });
  }
  for (const id of duplicates(blueprint.domains.map((d) => d.id)))
    add('duplicate_domain', 'assessmentDesign.domains', `蓝图领域ID重复: ${id}`, {
      domainIds: [id],
    });
  for (const id of duplicates(blueprint.cells.map((c) => c.id)))
    add('duplicate_cell', 'assessmentDesign.cells', `蓝图能力ID重复: ${id}`, { cellIds: [id] });
  if (!unique(blueprint.requiredCellIds))
    add('duplicate_required_cell', 'assessmentDesign.requiredCellIds', '必考能力ID重复', {
      cellIds: duplicates(blueprint.requiredCellIds),
    });
  for (const id of required.filter(
    (id) => !blueprint.domains.some((d) => d.knowledgeIds.includes(id)),
  ))
    add('unallocated_domain', 'assessmentDesign.domains', `蓝图范围遗漏教材领域: ${id}`, {
      knowledgeIds: [id],
    });
  if (!blueprint.domains.some((d) => d.required))
    add('no_core_domain', 'assessmentDesign.domains', '缺少核心领域', {
      domainIds: blueprint.domains.map((d) => d.id),
    });
  for (const id of blueprint.requiredCellIds.filter((id) => !cells.has(id)))
    add('unknown_required_cell', 'assessmentDesign.requiredCellIds', `必考能力不存在: ${id}`, {
      cellIds: [id],
    });
  blueprint.domains.forEach((domain, i) => {
    const path = `assessmentDesign.domains[${i}](${domain.id})`;
    const scope = { domainIds: [domain.id] };
    const foreign = domain.knowledgeIds.filter((id) => !knowledge.has(id));
    if (foreign.length)
      add('foreign_domain_knowledge', `${path}.knowledgeIds`, '领域引用外来知识', {
        ...scope,
        knowledgeIds: foreign,
      });
    for (const id of domain.coreObjectiveIds) {
      const objective = objectives.get(id);
      if (!objective)
        add('unknown_core_objective', `${path}.coreObjectiveIds`, `领域核心目标不存在: ${id}`, {
          ...scope,
          objectiveIds: [id],
        });
      else if (objective.knowledgeIds.some((k) => !domain.knowledgeIds.includes(k)))
        add(
          'core_objective_outside_domain',
          `${path}.coreObjectiveIds`,
          `核心目标知识超出领域: ${id}`,
          {
            ...scope,
            objectiveIds: [id],
            knowledgeIds: objective.knowledgeIds.filter((k) => !domain.knowledgeIds.includes(k)),
          },
        );
      if (
        domain.required &&
        objective &&
        !blueprint.cells.some(
          (c) =>
            c.domainId === domain.id &&
            blueprint.requiredCellIds.includes(c.id) &&
            c.objectiveIds.includes(id) &&
            demandRank[c.demand] >= demandRank[objective.demand],
        )
      )
        add(
          'missing_core_assessment',
          `${path}.coreObjectiveIds`,
          `核心目标考核需求降格或遗漏: ${id}`,
          {
            ...scope,
            objectiveIds: [id],
            cellIds: blueprint.cells.filter((c) => c.domainId === domain.id).map((c) => c.id),
          },
        );
    }
    if (
      domain.required &&
      (!domain.coreObjectiveIds.length ||
        !blueprint.cells.some(
          (c) => c.domainId === domain.id && blueprint.requiredCellIds.includes(c.id),
        ))
    )
      add('missing_core_cell', path, '核心领域缺少必考能力/目标', scope);
  });
  blueprint.cells.forEach((cell, i) => {
    const path = `assessmentDesign.cells[${i}](${cell.id})`;
    const domain = domains.get(cell.domainId);
    const scope = { cellIds: [cell.id], domainIds: domain ? [domain.id] : [] };
    if (!domain) add('unknown_cell_domain', `${path}.domainId`, '能力领域不存在', scope);
    for (const id of cell.objectiveIds)
      if (!objectives.has(id))
        add('unknown_cell_objective', `${path}.objectiveIds`, `能力目标不存在: ${id}`, {
          ...scope,
          objectiveIds: [id],
        });
    const members = [
      ...cell.mandatoryKnowledgeIds,
      ...cell.representativeSets.flatMap((s) => s.candidateKnowledgeIds),
    ];
    if (!members.length) add('empty_cell_scope', path, '能力无实际知识范围', scope);
    if (domain && members.some((id) => !domain.knowledgeIds.includes(id)))
      add('cell_outside_domain', path, '能力知识超出领域', {
        ...scope,
        knowledgeIds: members.filter((id) => !domain.knowledgeIds.includes(id)),
      });
    if (
      blueprint.requiredCellIds.includes(cell.id) &&
      members.some((id) => knowledge.get(id)?.origin === 'extension')
    )
      add('required_extension', path, '拓展被当作必考教材', scope);
    if (!unique(cell.representativeSets.map((s) => s.id)))
      add('duplicate_representative', `${path}.representativeSets`, '代表集合重复', scope);
  });
  return issues;
}

export function assertPlanIssues(issues: PlanIssue[]): void {
  if (issues.length)
    throw new CourseValidationError(
      issues.map((i) => `${i.path}: ${i.message}`),
      issues,
    );
}
export function validateCoursePlan(
  plan: CoursePlan,
  inventory: CourseKnowledgeInventory,
): CoursePlan {
  const issues = coursePlanIssues(
    { ...plan, assessmentDesign: plan.assessmentBlueprint },
    inventory,
  );
  const required = inventory.knowledge.filter((k) => k.origin === 'textbook').map((k) => k.id);
  if (sha256([...required].sort()) !== sha256([...plan.teachingRequiredKnowledgeIds].sort()))
    issues.push({
      code: 'inventory_identity',
      path: 'teachingRequiredKnowledgeIds',
      message: '教学知识全集与冻结inventory不符',
    });
  if (
    plan.assessmentBlueprint.curriculumId !== plan.id ||
    plan.assessmentBlueprint.sourceScopeHash !== inventory.sourceScopeHash
  )
    issues.push({
      code: 'blueprint_identity',
      path: 'assessmentBlueprint',
      message: '考核蓝图来源身份错误',
    });
  assertPlanIssues(issues);
  const sorted: CoursePlan['lessons'] = [];
  const done = new Set<string>();
  while (sorted.length < plan.lessons.length) {
    const next = plan.lessons.find(
      (l) => !done.has(l.id) && l.prerequisiteLessonIds.every((id) => done.has(id)),
    )!;
    sorted.push(next);
    done.add(next.id);
  }
  return {
    ...plan,
    lessons: sorted,
    warnings: [
      ...new Set([
        ...plan.warnings,
        ...plan.lessons
          .filter((l) => l.estimatedMinutes > 120)
          .map((l) => `${l.title}建议分时学习。`),
      ]),
    ],
  };
}
