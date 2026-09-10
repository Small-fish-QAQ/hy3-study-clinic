import { useEffect, useState } from 'react';
import type { CoursePreparation } from '@hy3-clinic/shared';

const STEPS = [
  ['materials', '整理资料'],
  ['concepts', '提取核心内容'],
  ['courseStructure', '设计课程结构'],
  ['coursePlan', '安排学习路线'],
] as const;

const ACTIVITY_TITLES = {
  concepts: '阅读资料，提取核心概念',
  concept_recovery: '补充遗漏段落的概念依据',
  course_map: '组织章节与学习顺序',
  curriculum_details: '细化学习单元与目标',
  validation: '检查课程结构与学习条件',
};

export function CoursePreparationStatus({
  preparation,
  title,
  busy,
  syncError,
}: {
  preparation: CoursePreparation;
  title: string;
  busy: boolean;
  syncError?: string | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const activity = preparation.activity;
  const elapsed = preparation.operationStartedAt
    ? Math.max(0, Math.floor((now - Date.parse(preparation.operationStartedAt)) / 1000))
    : 0;
  const reviewing = preparation.learnerAction === 'review_course_structure';
  const failed = Boolean(preparation.failure);
  const activityTitle =
    busy && activity
      ? ACTIVITY_TITLES[activity.phase]
      : !busy && !failed && preparation.canResume
        ? '课程准备可以继续'
        : title;
  const isConceptWork = activity && ['concepts', 'concept_recovery'].includes(activity.phase);
  return (
    <section className="course-preparation-status" aria-label="课程准备状态" aria-busy={busy}>
      <div className="preparation-heading">
        <div className="section-heading" aria-live="polite">
          <p className="eyebrow">课程准备</p>
          <h3>{activityTitle}</h3>
        </div>
        {busy && preparation.operationStartedAt ? (
          <span className="preparation-elapsed">
            已用时 {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </span>
        ) : null}
      </div>
      <ol>
        {STEPS.map(([key, label], index) => {
          const state = preparation.checkpoints[key];
          const needsReview = key === 'courseStructure' && reviewing;
          const isActive = state === 'in_progress' && busy && !needsReview;
          const stopped = state === 'in_progress' && failed;
          return (
            <li
              key={key}
              data-state={
                isActive
                  ? 'in_progress'
                  : stopped
                    ? 'blocked'
                    : needsReview
                      ? 'review'
                      : state === 'in_progress'
                        ? 'pending'
                        : state
              }
              aria-current={isActive || needsReview ? 'step' : undefined}
            >
              <span className="preparation-step-number" aria-hidden="true">
                {state === 'complete' ? '✓' : index + 1}
              </span>
              <div>
                <strong>{label}</strong>
                <small>
                  {needsReview
                    ? '等待你的审阅'
                    : state === 'complete'
                      ? '已完成'
                      : stopped || state === 'blocked'
                        ? '需要处理'
                        : isActive
                          ? '进行中'
                          : state === 'in_progress'
                            ? '等待继续'
                            : '等待前一步'}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="preparation-observation" aria-live="polite">
        {activity && busy ? (
          <p>
            {isConceptWork ? '当前资料：' : '当前工作：'}
            {activity.label}
          </p>
        ) : null}
        <div className="preparation-facts">
          {busy && activity ? (
            <span>
              {isConceptWork
                ? `已处理 ${activity.completed} / ${activity.total} 段`
                : activity.phase === 'curriculum_details'
                  ? `已完成 ${activity.completed} / ${activity.total} 个学习单元`
                  : activity.phase === 'course_map'
                    ? '正在生成章节草案'
                    : '正在核对原文与学习条件'}
            </span>
          ) : null}
          {preparation.preparedConceptCount !== undefined ? (
            <span>已保存 {preparation.preparedConceptCount} 个有原文依据的概念</span>
          ) : null}
        </div>
        {preparation.blocker ? <p>{preparation.blocker.message}</p> : null}
        {busy ? (
          <p className="small muted">每完成一部分会立即保存。生成课程结构后，需要你审阅确认。</p>
        ) : null}
        {busy && !syncError && activity && now - Date.parse(activity.updatedAt) >= 90_000 ? (
          <p className="small muted">
            模型仍在处理当前步骤，尚未返回新的完成结果。你可以停止，稍后继续。
          </p>
        ) : null}
        {syncError ? <p role="alert">{syncError}</p> : null}
      </div>
    </section>
  );
}
