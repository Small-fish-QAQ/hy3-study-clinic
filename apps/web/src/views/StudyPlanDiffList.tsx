import type { StudyPlanDiffOperation } from '@hy3-clinic/shared';

export interface StudyPlanDiffListProps {
  changes: StudyPlanDiffOperation[];
}

function valueChange(
  before: string | number | null | undefined,
  after: string | number | null | undefined,
) {
  if (before === null || before === undefined || after === null || after === undefined) return null;
  return `${before} → ${after}`;
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
        const depth = valueChange(depthLabel(change.beforeDepth), depthLabel(change.afterDepth));
        const details = [
          order ? `顺序 ${order}` : null,
          minutes ? `时长 ${minutes} 分钟` : null,
          depth ? `深度 ${depth}` : null,
          change.curriculumLearningUnitId ? `学习单元 ${change.curriculumLearningUnitId}` : null,
          change.planItemId ? `路线项目 ${change.planItemId}` : null,
        ].filter((detail): detail is string => Boolean(detail));
        return (
          <li
            key={`${change.kind}:${change.planItemId ?? change.curriculumLearningUnitId ?? index}`}
          >
            <strong>{diffKindLabel(change.kind)}</strong>
            {details.length > 0 ? ` | ${details.join(' | ')}` : ''}: {change.reason}
          </li>
        );
      })}
    </ul>
  );
}

function diffKindLabel(value: string): string {
  const labels: Record<string, string> = {
    added: '新增',
    removed: '移除',
    reordered: '调整顺序',
    resized: '调整时长',
    depth_changed: '调整学习深度',
    deferred: '延期',
    schedule_changed: '调整安排',
    source_rebound: '重新核对课程资料',
  };
  return labels[value] ?? '路线变化';
}

function depthLabel(value: string | null | undefined): string | null | undefined {
  const labels: Record<string, string> = {
    pass_oriented: '通过评估',
    working_fluency: '熟练运用',
    high_performance: '高水平表现',
    deep_transfer: '深入迁移',
  };
  return value ? (labels[value] ?? '已调整') : value;
}
