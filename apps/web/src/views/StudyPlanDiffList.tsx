import type { StudyPlanDiffOperation } from '@hy3-clinic/shared';

export interface StudyPlanDiffListProps {
  changes: StudyPlanDiffOperation[];
}

function valueChange(
  before: string | number | null | undefined,
  after: string | number | null | undefined,
) {
  if (before === null || before === undefined || after === null || after === undefined) return null;
  return `${before} -> ${after}`;
}

/** Renders the complete persisted diff; clients never infer a replan from prose. */
export function StudyPlanDiffList({ changes }: StudyPlanDiffListProps) {
  return (
    <ul className="plan-diff-list">
      {changes.map((change, index) => {
        const order = valueChange(
          change.beforeIndex === null ? null : change.beforeIndex + 1,
          change.afterIndex === null ? null : change.afterIndex + 1,
        );
        const minutes = valueChange(change.beforeMinutes, change.afterMinutes);
        const depth = valueChange(change.beforeDepth, change.afterDepth);
        const details = [
          order ? `order ${order}` : null,
          minutes ? `minutes ${minutes}` : null,
          depth ? `depth ${depth}` : null,
          change.curriculumLearningUnitId
            ? `LearningUnit ${change.curriculumLearningUnitId}`
            : null,
          change.planItemId ? `Plan item ${change.planItemId}` : null,
        ].filter((detail): detail is string => Boolean(detail));
        return (
          <li
            key={`${change.kind}:${change.planItemId ?? change.curriculumLearningUnitId ?? index}`}
          >
            <strong>{change.kind.replaceAll('_', ' ')}</strong>
            {details.length > 0 ? ` | ${details.join(' | ')}` : ''}: {change.reason}
          </li>
        );
      })}
    </ul>
  );
}
