import type { CourseKnowledge, CoursePlan } from '@hy3-clinic/shared';

export const isConstraintKnowledge = (k: CourseKnowledge) =>
  k.kind === 'condition' || k.kind === 'exception';

const normalizedQuote = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#+\s/u.test(line))
    .join('\n')
    .replace(/\s/gu, '');

/** Recasting an explicit condition is a semantic change, even if it retains a conditional keyword. */
export const constraintNeedsReview = (k: CourseKnowledge, sourceText: string) =>
  isConstraintKnowledge(k) && normalizedQuote(sourceText) !== normalizedQuote(k.statement);

/** Carry the real governing restrictions into the existing local objective review. */
export function planningReviewLessons(plan: CoursePlan, knowledge: CourseKnowledge[]) {
  const index = new Map(knowledge.map((k) => [k.id, k]));
  const constraints = knowledge.filter(isConstraintKnowledge);
  const governing = (ids: string[]) =>
    constraints.filter((k) =>
      ids.some((id) => {
        const bound = index.get(id)!;
        return (
          k.id === id ||
          k.relatedKnowledgeIds.includes(id) ||
          k.prerequisiteKnowledgeIds.includes(id) ||
          bound.relatedKnowledgeIds.includes(k.id) ||
          bound.prerequisiteKnowledgeIds.includes(k.id)
        );
      }),
    );
  return plan.lessons.flatMap((lesson) => {
    const objectives = lesson.objectives.filter(
      (objective) =>
        governing(objective.knowledgeIds).length > 0 ||
        objective.knowledgeIds.some((id) => {
          const k = index.get(id)!;
          return (
            k.uncertaintyCodes.length > 0 ||
            (k.title.length > 1 &&
              !objective.title.includes(k.title) &&
              /证明|计算|操作步骤/iu.test(objective.title) !==
                /证明|计算|操作步骤/iu.test(k.statement))
          );
        }),
    );
    if (!objectives.length) return [];
    const ids = objectives.flatMap((o) => o.knowledgeIds);
    return [
      {
        ...lesson,
        objectives,
        // The visible title/summary describes the whole lesson. Its valid
        // sibling content is context for this existing targeted check.
        knowledgeIds: [...new Set([...lesson.knowledgeIds, ...governing(ids).map((k) => k.id)])],
      },
    ];
  });
}
