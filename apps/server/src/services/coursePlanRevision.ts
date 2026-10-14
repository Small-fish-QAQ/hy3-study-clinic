import type { CourseKnowledgeInventory, CoursePreferences } from '@hy3-clinic/shared';
import type { PlanOutput, PlanRevisionInput, PlanRevisionOutput } from '../llm/courseContract.js';
import { demandRank, requireValid, unique, type PlanIssue } from './courseValidation.js';
import { sha256 } from '../util/canonical.js';

export const planningKnowledge = (inventory: CourseKnowledgeInventory['knowledge']) =>
  inventory.map((k) => ({ ...k, sourceSpans: [] }));
/** Set membership is mechanical only when the authored cell already satisfies the declared core target. */
export function normalizePlanReferences(output: PlanOutput): PlanOutput {
  const value = structuredClone(output);
  value.lessons.forEach((l) => {
    l.knowledgeIds = [...new Set(l.knowledgeIds)];
  });
  value.assessmentDesign.requiredCellIds = [...new Set(value.assessmentDesign.requiredCellIds)];
  const objectives = new Map(
    value.lessons.flatMap((l) => l.objectives.map((o) => [o.id, o] as const)),
  );
  for (const domain of value.assessmentDesign.domains.filter((d) => d.required)) {
    for (const id of domain.coreObjectiveIds) {
      const objective = objectives.get(id);
      if (!objective) continue;
      const eligible = value.assessmentDesign.cells.filter(
        (c) =>
          c.domainId === domain.id &&
          c.objectiveIds.includes(id) &&
          demandRank[c.demand] >= demandRank[objective.demand],
      );
      if (eligible.some((c) => value.assessmentDesign.requiredCellIds.includes(c.id))) continue;
      // Several possible cells require an author decision; never invent or broadcast links.
      if (eligible.length === 1) value.assessmentDesign.requiredCellIds.push(eligible[0]!.id);
    }
  }
  return value;
}
export function planRevisionInput(
  output: PlanOutput,
  inventory: CourseKnowledgeInventory,
  findings: PlanIssue[],
  preferences?: CoursePreferences,
): PlanRevisionInput {
  const lessonIds = new Set(findings.flatMap((i) => i.lessonIds ?? []));
  const objectiveIds = new Set(
    output.lessons.filter((l) => lessonIds.has(l.id)).flatMap((l) => l.objectives.map((o) => o.id)),
  );
  const domainIds = new Set(findings.flatMap((i) => i.domainIds ?? []));
  for (const d of output.assessmentDesign.domains)
    if (d.coreObjectiveIds.some((id) => objectiveIds.has(id))) domainIds.add(d.id);
  const cellIds = new Set(findings.flatMap((i) => i.cellIds ?? []));
  for (const c of output.assessmentDesign.cells)
    if (cellIds.has(c.id) || domainIds.has(c.domainId)) {
      cellIds.add(c.id);
      domainIds.add(c.domainId);
    }
  // Include sibling cells of affected domains so their required membership remains explicit.
  for (const c of output.assessmentDesign.cells) if (domainIds.has(c.domainId)) cellIds.add(c.id);
  const lessons = output.lessons.filter((l) => lessonIds.has(l.id));
  const domains = output.assessmentDesign.domains.filter((d) => domainIds.has(d.id));
  const cells = output.assessmentDesign.cells.filter((c) => cellIds.has(c.id));
  const referencedObjectives = new Set([
    ...domains.flatMap((d) => d.coreObjectiveIds),
    ...cells.flatMap((c) => c.objectiveIds),
    ...findings.flatMap((i) => i.objectiveIds ?? []),
  ]);
  const needed = new Set([
    ...lessons.flatMap((l) => l.knowledgeIds),
    ...domains.flatMap((d) => d.knowledgeIds),
    ...cells.flatMap((c) => [
      ...c.mandatoryKnowledgeIds,
      ...c.representativeSets.flatMap((s) => s.candidateKnowledgeIds),
    ]),
    ...findings.flatMap((i) => i.knowledgeIds ?? []),
    ...output.lessons.flatMap((l) =>
      l.objectives.filter((o) => referencedObjectives.has(o.id)).flatMap((o) => o.knowledgeIds),
    ),
  ]);
  const moduleIds = new Set(lessons.map((l) => l.moduleId));
  return {
    ...(preferences ? { preferences } : {}),
    draft: {
      modules: output.modules.filter((m) => moduleIds.has(m.id)),
      lessons,
      assessmentDesign: {
        domains,
        cells,
        requiredCellIds: output.assessmentDesign.requiredCellIds.filter((id) => cellIds.has(id)),
      },
    },
    findings,
    knowledge: planningKnowledge(inventory.knowledge.filter((k) => needed.has(k.id))),
    references: {
      modules: output.modules,
      lessons: output.lessons.map(({ id, moduleId, knowledgeIds, objectives }) => ({
        id,
        moduleId,
        knowledgeIds,
        objectives,
      })),
      assessmentDesign: {
        domains: output.assessmentDesign.domains.map(({ id, knowledgeIds, coreObjectiveIds }) => ({
          id,
          knowledgeIds,
          coreObjectiveIds,
        })),
        cells: output.assessmentDesign.cells.map(({ id, domainId, objectiveIds, demand }) => ({
          id,
          domainId,
          objectiveIds,
          demand,
        })),
        representativeSetIds: output.assessmentDesign.cells.flatMap((c) =>
          c.representativeSets.map((s) => s.id),
        ),
        requiredCellIds: output.assessmentDesign.requiredCellIds,
      },
    },
  };
}
/** Validate repair boundaries independently from the resulting course's structural contract. */
export function mergePlanRevision(
  output: PlanOutput,
  input: PlanRevisionInput,
  patch: PlanRevisionOutput,
): PlanOutput {
  const errors: string[] = [];
  const check = (message: string, valid: boolean) => {
    if (!valid) errors.push(message);
  };
  const affectedLessons = new Set(input.draft.lessons.map((l) => l.id));
  const affectedDomains = new Set(input.draft.assessmentDesign.domains.map((d) => d.id));
  const affectedCells = new Set(input.draft.assessmentDesign.cells.map((c) => c.id));
  const knownK = new Set(input.knowledge.map((k) => k.id));
  const priorObjectives = input.references.lessons.flatMap((l) => l.objectives);
  const validObjective = (domainId: string, id: string) => {
    const matches = priorObjectives.filter((o) => o.id === id);
    const domain = output.assessmentDesign.domains.find((d) => d.id === domainId);
    return (
      matches.length === 1 &&
      matches[0]!.knowledgeIds.every((k) => domain?.knowledgeIds.includes(k))
    );
  };
  const validCellKnowledge = (domainId: string, id: string) =>
    knownK.has(id) &&
    !!output.assessmentDesign.domains.find((d) => d.id === domainId)?.knowledgeIds.includes(id);
  const retain = (next: string[], prior: string[]) => [...new Set([...next, ...prior])];
  patch = structuredClone(patch);
  // A local replacement cannot revoke already declared, valid blueprint membership.
  // Retain it in code, as for requiredCellIds; the resulting domain/cell still has to
  // pass the full structural and semantic contracts. No links or goals are invented.
  for (const domain of patch.assessmentDesign.domains) {
    const old = output.assessmentDesign.domains.find((d) => d.id === domain.id);
    if (!old || !affectedDomains.has(domain.id)) continue;
    domain.knowledgeIds = retain(
      domain.knowledgeIds,
      old.knowledgeIds.filter((id) => knownK.has(id)),
    );
    domain.coreObjectiveIds = retain(
      domain.coreObjectiveIds,
      old.coreObjectiveIds.filter((id) => validObjective(old.id, id)),
    );
  }
  for (const cell of patch.assessmentDesign.cells) {
    const old = output.assessmentDesign.cells.find((c) => c.id === cell.id);
    if (!old || !affectedCells.has(cell.id)) continue;
    cell.mandatoryKnowledgeIds = retain(
      cell.mandatoryKnowledgeIds,
      old.mandatoryKnowledgeIds.filter((id) => validCellKnowledge(old.domainId, id)),
    );
    cell.objectiveIds = retain(
      cell.objectiveIds,
      old.objectiveIds.filter((id) => validObjective(old.domainId, id)),
    );
    for (const prior of old.representativeSets) {
      const candidates = prior.candidateKnowledgeIds.filter((id) =>
        validCellKnowledge(old.domainId, id),
      );
      if (!candidates.length) continue;
      const next = cell.representativeSets.find((s) => s.id === prior.id);
      if (next) next.candidateKnowledgeIds = retain(next.candidateKnowledgeIds, candidates);
      else cell.representativeSets.push({ ...prior, candidateKnowledgeIds: candidates });
    }
  }
  for (const lesson of patch.lessons) {
    const old = output.lessons.find((l) => l.id === lesson.id);
    check(`局部修订改写未受影响Lesson: ${lesson.id}`, !old || affectedLessons.has(lesson.id));
    check(
      `局部Lesson引入范围外知识: ${lesson.id}`,
      lesson.knowledgeIds.every((id) => knownK.has(id)),
    );
    if (old) {
      check(
        `局部修订删除原Lesson知识: ${lesson.id}`,
        old.knowledgeIds
          .filter((id) => knownK.has(id))
          .every((id) => lesson.knowledgeIds.includes(id)),
      );
      for (const o of old.objectives) {
        const next = lesson.objectives.find((n) => n.id === o.id);
        const duplicate = input.findings.some(
          (i) => i.code === 'duplicate_objective' && i.objectiveIds?.includes(o.id),
        );
        check(
          `局部修订删除/降低教学目标: ${o.id}`,
          duplicate ||
            (!!next &&
              demandRank[next.demand] >= demandRank[o.demand] &&
              o.knowledgeIds
                .filter((id) => old.knowledgeIds.includes(id))
                .every((id) => next.knowledgeIds.includes(id))),
        );
      }
    } else
      check(
        `局部修订新增无关Lesson: ${lesson.id}`,
        input.findings.some(
          (i) =>
            i.code === 'unallocated_knowledge' &&
            i.knowledgeIds?.some((id) => lesson.knowledgeIds.includes(id)),
        ),
      );
  }
  for (const domain of patch.assessmentDesign.domains) {
    const old = output.assessmentDesign.domains.find((d) => d.id === domain.id);
    check(`局部修订改写未受影响领域: ${domain.id}`, !old || affectedDomains.has(domain.id));
    check(
      `局部领域引入范围外知识: ${domain.id}`,
      domain.knowledgeIds.every((id) => knownK.has(id)),
    );
    if (old) {
      check(
        `局部修订删除领域范围: ${domain.id}`,
        old.knowledgeIds
          .filter((id) => knownK.has(id))
          .every((id) => domain.knowledgeIds.includes(id)),
      );
      check(`局部修订撤销核心领域: ${domain.id}`, !old.required || domain.required);
      check(
        `局部修订删除核心目标: ${domain.id}`,
        old.coreObjectiveIds
          .filter((id) => validObjective(old.id, id))
          .every((id) => domain.coreObjectiveIds.includes(id)),
      );
    } else
      check(
        `局部修订新增无关领域: ${domain.id}`,
        input.findings.some(
          (i) =>
            i.code === 'unallocated_domain' &&
            i.knowledgeIds?.some((id) => domain.knowledgeIds.includes(id)),
        ),
      );
  }
  for (const cell of patch.assessmentDesign.cells) {
    const old = output.assessmentDesign.cells.find((c) => c.id === cell.id);
    check(
      `局部修订改写未受影响能力: ${cell.id}`,
      old ? affectedCells.has(cell.id) : affectedDomains.has(cell.domainId),
    );
    if (old) {
      check(`局部修订降低考核需求: ${cell.id}`, demandRank[cell.demand] >= demandRank[old.demand]);
      check(
        `局部修订删除必考知识: ${cell.id}`,
        old.mandatoryKnowledgeIds
          .filter((id) => validCellKnowledge(old.domainId, id))
          .every((id) => cell.mandatoryKnowledgeIds.includes(id)),
      );
      for (const set of old.representativeSets) {
        const validMembers = set.candidateKnowledgeIds.filter((id) =>
          validCellKnowledge(old.domainId, id),
        );
        check(
          `局部修订删除代表集合: ${set.id}`,
          !validMembers.length ||
            cell.representativeSets.some(
              (s) =>
                s.id === set.id && validMembers.every((id) => s.candidateKnowledgeIds.includes(id)),
            ),
        );
      }
      for (const id of old.objectiveIds.filter((id) => validObjective(old.domainId, id)))
        check(`局部修订删除能力目标: ${id}`, cell.objectiveIds.includes(id));
    }
  }
  for (const module of patch.modules) {
    const old = output.modules.find((m) => m.id === module.id);
    check(
      `局部修订改写模块: ${module.id}`,
      !old ||
        sha256(old) === sha256(module) ||
        input.findings.some((i) => i.code === 'duplicate_module'),
    );
  }
  const suppliedCells = new Set([
    ...affectedCells,
    ...patch.assessmentDesign.cells.map((c) => c.id),
  ]);
  check(
    '局部修订requiredCellIds引入范围外能力',
    patch.assessmentDesign.requiredCellIds.every((id) => suppliedCells.has(id)),
  );
  // Existing required membership is server-owned. Missing repetition in a patch
  // cannot revoke it or force a new author purchase.
  for (const list of [
    patch.lessons,
    patch.modules,
    patch.assessmentDesign.domains,
    patch.assessmentDesign.cells,
  ])
    check('局部修订ID重复', unique(list.map((item) => item.id)));
  requireValid(errors);
  const merge = <T extends { id: string }>(prior: T[], next: T[]) => [
    ...prior.map((old) => next.find((n) => n.id === old.id) ?? old),
    ...next.filter((n) => !prior.some((old) => old.id === n.id)),
  ];
  return {
    ...output,
    modules: merge(output.modules, patch.modules),
    lessons: merge(output.lessons, patch.lessons),
    assessmentDesign: {
      domains: merge(output.assessmentDesign.domains, patch.assessmentDesign.domains),
      cells: merge(output.assessmentDesign.cells, patch.assessmentDesign.cells),
      requiredCellIds: [
        ...output.assessmentDesign.requiredCellIds.filter(
          (id) =>
            !input.findings.some(
              (i) => i.code === 'unknown_required_cell' && i.cellIds?.includes(id),
            ),
        ),
        ...patch.assessmentDesign.requiredCellIds.filter(
          (id) => !output.assessmentDesign.requiredCellIds.includes(id),
        ),
      ],
    },
  };
}
