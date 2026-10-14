import type { CoursePlan, CourseQuiz, CourseAssessmentBlueprint } from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { stableId } from '../util/canonical.js';
import { demandRank, difficultyRank } from './courseValidation.js';

/** Compile a unit's confirmed teaching targets locally. No new planning call. */
export function assessmentScope(
  plan: CoursePlan,
  moduleId?: string,
): {
  blueprint: CourseAssessmentBlueprint;
  scope: NonNullable<CourseQuiz['assessmentScope']>;
} {
  const module = moduleId ? plan.modules.find((m) => m.id === moduleId) : undefined;
  if (moduleId && !module) throw new AppError('VALIDATION_ERROR', '考核单元不属于这份课程。');
  const lessons = plan.lessons.filter((l) => !module || l.moduleId === module.id);
  const knowledgeIds = [...new Set(lessons.flatMap((l) => l.knowledgeIds))];
  const scope: NonNullable<CourseQuiz['assessmentScope']> = {
    kind: module ? 'module' : 'course',
    ...(module ? { moduleId: module.id } : {}),
    title: module?.title ?? plan.title,
    lessonIds: lessons.map((l) => l.id),
    knowledgeIds,
  };
  if (!module) return { scope, blueprint: plan.assessmentBlueprint };
  const textbook = new Set(plan.teachingRequiredKnowledgeIds);
  const objectiveRequirements = lessons
    .flatMap((l) => l.objectives)
    .map((o) => ({ ...o, knowledgeIds: o.knowledgeIds.filter((id) => textbook.has(id)) }))
    .filter((o) => o.knowledgeIds.length);
  if (!objectiveRequirements.length)
    throw new AppError('VALIDATION_ERROR', '本单元缺少可考核的教材教学目标。');
  const objectives = new Set(objectiveRequirements.map((o) => o.id));
  const knowledge = new Set(knowledgeIds.filter((id) => textbook.has(id)));
  const project = (c: CourseAssessmentBlueprint['cells'][number]) => ({
    ...c,
    objectiveIds: c.objectiveIds.filter((id) => objectives.has(id)),
    mandatoryKnowledgeIds: c.mandatoryKnowledgeIds.filter((id) => knowledge.has(id)),
    representativeSets: c.representativeSets
      .map((s) => ({
        ...s,
        candidateKnowledgeIds: s.candidateKnowledgeIds.filter((id) => knowledge.has(id)),
      }))
      .filter((s) => s.candidateKnowledgeIds.length),
  });
  const members = (c: CourseAssessmentBlueprint['cells'][number]) => [
    ...c.mandatoryKnowledgeIds,
    ...c.representativeSets.flatMap((s) => s.candidateKnowledgeIds),
  ];
  const cells = plan.assessmentBlueprint.cells
    .filter((c) => c.objectiveIds.some((id) => objectives.has(id)))
    .map(project);
  // A course-wide representative pool can omit a whole unit target. Reuse its
  // source-backed cell when possible, without treating unrelated goals as
  // interchangeable just because they share a domain or a demand label.
  for (const objective of objectiveRequirements) {
    if (cells.some((c) => c.objectiveIds.includes(objective.id))) continue;
    const related = plan.assessmentBlueprint.cells
      .map((c) => ({
        c,
        overlap: members(c).filter((id) => objective.knowledgeIds.includes(id)).length,
      }))
      .filter((entry) => entry.overlap)
      .sort((a, b) => b.overlap - a.overlap || a.c.id.localeCompare(b.c.id))[0]?.c;
    if (related) {
      let cell = cells.find((c) => c.id === related.id);
      if (!cell) {
        cell = project(related);
        cells.push(cell);
      }
      cell.objectiveIds.push(objective.id);
    }
  }
  const missing = objectiveRequirements.filter(
    (o) => !cells.some((c) => c.objectiveIds.includes(o.id)),
  );
  const extraDomains: CourseAssessmentBlueprint['domains'] = [];
  if (missing.length) {
    // The accepted lesson targets remain authoritative even when the course
    // exam treats this material as background. Combine them in one local cell;
    // do not manufacture one compulsory question per knowledge point.
    const domainId = stableId('unit_domain', { moduleId, objectives: missing.map((o) => o.id) });
    extraDomains.push({
      id: domainId,
      title: module.title,
      knowledgeIds: [...new Set(missing.flatMap((o) => o.knowledgeIds))],
      coreObjectiveIds: missing.map((o) => o.id),
      required: true,
      rationale: '本单元已确认的教学目标；综合课程卷未单独取样。',
    });
    const depthBands = lessons
      .filter((l) => l.objectives.some((o) => missing.some((m) => m.id === o.id)))
      .map((l) =>
        l.selectedDepth === 'introductory'
          ? ('basic' as const)
          : l.selectedDepth === 'standard'
            ? ('standard' as const)
            : ('advanced' as const),
      );
    cells.push({
      id: stableId('unit_cell', { moduleId, objectives: missing.map((o) => o.id) }),
      domainId,
      objectiveIds: missing.map((o) => o.id),
      demand: [...missing].sort((a, b) => demandRank[b.demand] - demandRank[a.demand])[0]!.demand,
      difficultyBand: depthBands.sort((a, b) => difficultyRank[b] - difficultyRank[a])[0]!,
      mandatoryKnowledgeIds: [],
      representativeSets: [],
      weight: cells.length ? cells.reduce((sum, c) => sum + c.weight, 0) / cells.length : 1,
      rationale: '按单元教学目标取样，可在同一道综合题中检验多个目标。',
    });
  }
  for (const cell of cells) {
    const goals = objectiveRequirements.filter((o) => cell.objectiveIds.includes(o.id));
    for (const goal of goals) {
      if (demandRank[goal.demand] > demandRank[cell.demand]) cell.demand = goal.demand;
      if (
        cell.mandatoryKnowledgeIds.some((id) => goal.knowledgeIds.includes(id)) ||
        cell.representativeSets.some((s) =>
          s.candidateKnowledgeIds.every((id) => goal.knowledgeIds.includes(id)),
        )
      )
        continue;
      cell.representativeSets.push({
        id: stableId('unit_representative', { cellId: cell.id, objectiveId: goal.id }),
        candidateKnowledgeIds: [...goal.knowledgeIds],
      });
    }
  }
  const domains = plan.assessmentBlueprint.domains
    .filter((d) => cells.some((c) => c.domainId === d.id))
    .map((d) => ({
      ...d,
      knowledgeIds: [
        ...new Set([
          ...d.knowledgeIds.filter((id) => knowledge.has(id)),
          ...cells.filter((c) => c.domainId === d.id).flatMap(members),
        ]),
      ],
      coreObjectiveIds: [
        ...new Set(cells.filter((c) => c.domainId === d.id).flatMap((c) => c.objectiveIds)),
      ],
      required: true,
    }));
  return {
    scope,
    blueprint: {
      ...plan.assessmentBlueprint,
      id: stableId('unit_blueprint', {
        policy: 'unit-objectives-v1',
        blueprint: plan.assessmentBlueprint,
        moduleId,
        objectiveRequirements,
        cells,
      }),
      domains: [...domains, ...extraDomains],
      cells,
      requiredCellIds: cells.map((c) => c.id),
      objectiveRequirements,
    },
  };
}
