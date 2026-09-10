import { useState } from 'react';
import type {
  CourseAssessmentRecord,
  CourseLearningProgress,
  CurrentReviewItem,
  CourseExecutionCommandEnvelope,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner } from '../components/ui.js';
import { FormalAssessmentPanel } from '../components/FormalAssessmentPanel.js';

const resultLabels = {
  pending: '等待检查结果',
  supported: '已通过',
  partial: '部分通过',
  unsupported: '需要修复',
};

export function AssessmentRecords({
  records,
  onOpen,
  history = false,
}: {
  records: CourseAssessmentRecord[];
  onOpen: (versionId: string) => void;
  history?: boolean;
}) {
  if (records.length === 0)
    return (
      <p className="muted">还没有正式检查记录。完成讲解和练习后，可以从学习页进入独立检查。</p>
    );
  return (
    <div className="stack">
      {records.map((record) => (
        <article className="card" key={record.attemptId}>
          <div className="row between">
            <h3>{record.title}</h3>
            <span className="pill">
              {record.status === 'cancelled'
                ? '已取消'
                : record.status === 'started'
                  ? '作答中'
                  : resultLabels[record.result]}
            </span>
          </div>
          <p className="small muted">
            {new Date(record.submittedAt ?? record.startedAt).toLocaleString('zh-CN')} ·{' '}
            {record.current
              ? record.reviewSchedulingPending
                ? '正式进展已保存，复习安排待同步'
                : record.credited
                  ? '已计入当前正式进展'
                  : record.reconciliationPending
                    ? '结果已保存，进展待同步'
                    : '尚未取得正式通过证据'
              : '历史路线记录'}
          </p>
          {record.feedback ? <p>{record.feedback}</p> : null}
          {record.items.length > 0 ? (
            <details open={history || undefined}>
              <summary>查看作答与评分标准</summary>
              {record.items.map((item, index) => (
                <div key={index}>
                  <h4>{item.prompt}</h4>
                  <blockquote style={{ whiteSpace: 'pre-wrap' }}>
                    {item.response || '未作答'}
                  </blockquote>
                </div>
              ))}
              <ul>
                {record.criteria.map((criterion, index) => (
                  <li key={index}>
                    {criterion.label}：
                    {criterion.result === 'met'
                      ? '已达到'
                      : criterion.result === 'partial'
                        ? '部分达到'
                        : '未达到'}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {record.current &&
          record.status !== 'cancelled' &&
          (!record.credited || record.reconciliationPending || record.reviewSchedulingPending) ? (
            <button type="button" onClick={() => onOpen(record.versionId)}>
              {record.reviewSchedulingPending
                ? '重试复习安排'
                : record.reconciliationPending
                  ? '继续同步正式结果'
                  : record.repairEpisodeId
                    ? record.repairResolved
                      ? '查看后续验证结果'
                      : '继续修复与验证'
                    : '继续检查'}
            </button>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function CourseLearningRecords({
  workspaceId,
  section,
  progress,
  reviews,
  reviewError,
  command,
  executionVersion,
  onRefresh,
  onOpenStudy,
  focusRepairId,
  focusObjectiveId,
  focusReviewId,
}: {
  workspaceId: string;
  section: 'evidence' | 'repair' | 'mastery' | 'history';
  progress: CourseLearningProgress;
  reviews: CurrentReviewItem[] | null;
  reviewError?: string | null;
  command: (prefix: string) => CourseExecutionCommandEnvelope;
  executionVersion: number;
  onRefresh: () => void;
  onOpenStudy?: () => void;
  focusRepairId?: string | null;
  focusObjectiveId?: string | null;
  focusReviewId?: string | null;
}) {
  const [active, setActive] = useState<{ versionId: string; review: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openAssessment = (versionId: string) => setActive({ versionId, review: false });
  async function startReview(review: CurrentReviewItem) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.launchProgressReview(workspaceId, review.reviewTargetId, {
        command: command('progress-review'),
        expectedCourseExecutionVersion: executionVersion,
      });
      if (result.kind !== 'assessment' || !result.formalAssessmentVersionId)
        throw new Error(result.kind === 'blocked' ? result.reason : '复习检查尚未准备好。');
      setActive({ versionId: result.formalAssessmentVersionId, review: true });
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  if (active)
    return (
      <div className="stack">
        <button
          type="button"
          onClick={() => {
            setActive(null);
            onRefresh();
          }}
        >
          返回进展记录
        </button>
        <FormalAssessmentPanel
          key={active.versionId}
          workspaceId={workspaceId}
          versionId={active.versionId}
          reviewMode={active.review}
          onProgressChanged={onRefresh}
          onChanged={() => {
            setActive(null);
            onRefresh();
            onOpenStudy?.();
          }}
        />
      </div>
    );
  return (
    <div className="stack">
      {error ? <Banner kind="error">{error}</Banner> : null}
      {section === 'evidence' || section === 'history' ? (
        <section aria-label="正式检查记录">
          <h3>{section === 'history' ? '正式检查与作答历史' : '正式检查与证据'}</h3>
          <AssessmentRecords
            records={progress.assessments
              .filter((record) => section === 'history' || record.current)
              .filter(
                (record) => !focusObjectiveId || record.objectiveIds.includes(focusObjectiveId),
              )}
            onOpen={openAssessment}
            history={section === 'history'}
          />
        </section>
      ) : null}
      {section === 'repair' ? (
        <section aria-label="当前修复任务">
          <h3>修复与再检查</h3>
          <p className="muted">课堂练习和正式检查分别记录；修复练习本身不授予正式掌握。</p>
          {progress.repairs.filter((repair) => repair.current).length === 0 ? (
            <p>当前没有需要处理的修复记录。</p>
          ) : null}
          {progress.repairs
            .filter((repair) => repair.current)
            .map((repair) => (
              <article
                className="card"
                key={repair.id}
                aria-current={focusRepairId === repair.id ? 'true' : undefined}
              >
                <h4>
                  {repair.title}{' '}
                  <span className="pill">
                    {repair.kind === 'formal' ? '正式检查修复' : '课堂练习修复'}
                  </span>
                </h4>
                <p>{repair.description}</p>
                <p className="small muted">
                  {repair.resolved
                    ? '已解决'
                    : repair.status === 'DEFERRED'
                      ? '稍后继续'
                      : repair.status === 'CANCELLED'
                        ? '已离开'
                        : '需要处理'}{' '}
                  · {new Date(repair.updatedAt).toLocaleString('zh-CN')}
                </p>
                {!repair.resolved && repair.status !== 'CANCELLED' ? (
                  <button
                    type="button"
                    onClick={() =>
                      repair.versionId ? openAssessment(repair.versionId) : onOpenStudy?.()
                    }
                  >
                    {repair.kind === 'formal' ? '继续修复与验证' : '回到学习继续修复'}
                  </button>
                ) : null}
              </article>
            ))}
        </section>
      ) : null}
      {section === 'mastery' ? (
        <>
          <section aria-label="学习目标掌握">
            <h3>学习与正式掌握</h3>
            <p className="muted">这里分别显示学习完成情况、正式检查证据与延迟复习结果。</p>
            {progress.units.length === 0 ? (
              <p>接受课程结构并安排学习路线后，这里显示每个单元的学习与检查状态。</p>
            ) : null}
            {progress.units.map((unit) => (
              <article className="card" key={unit.id}>
                <h4>{unit.title}</h4>
                <p>
                  学习完成 {unit.teachingCompleted} / {unit.teachingTotal} · 有正式通过证据的目标{' '}
                  {unit.supportedObjectives} / {unit.objectiveTotal}
                  {(unit.scheduledTransfers ?? 0) > 0
                    ? ` · 综合迁移通过 ${unit.completedTransfers ?? 0} / ${unit.scheduledTransfers}`
                    : ''}
                </p>
                <p className="small muted">
                  {unit.formalState === 'stale'
                    ? '资料或学习路线已更新，这些记录保留为历史，需重新核对当前学习目标。'
                    : unit.durableMastery?.status === 'mastered'
                      ? '已达到长期掌握要求：正式检查和延迟复习证据均已核对。'
                      : unit.durableMastery?.reasonCodes.includes('current_review_failure')
                        ? '最近一次复习未通过，需要修复并再次验证。'
                        : unit.formalState === 'complete'
                          ? '已满足当前单元完成要求；长期保持还需延迟复习证据。'
                          : unit.formalState === 'repair_needed'
                            ? '正式检查显示需要修复。'
                            : unit.scheduledCheckpoints === 0
                              ? '当前尚无可执行的正式检查；本单元先用于学习，不声明正式掌握。'
                              : '正式检查与原文核对通过后更新证据状态。'}
                </p>
              </article>
            ))}
          </section>
          <section aria-label="目标复习安排">
            <h3>复习安排</h3>
            {reviewError ? (
              <Banner kind="error">
                复习安排暂时无法读取。{reviewError}
                <button type="button" onClick={onRefresh}>
                  重新读取复习
                </button>
              </Banner>
            ) : null}
            {reviews === null && !reviewError ? <p role="status">正在读取复习安排…</p> : null}
            {reviews?.length === 0 ? (
              <p>还没有复习安排。有效正式证据产生后，系统会安排后续回忆检查。</p>
            ) : null}
            {reviews?.map((review) => (
              <article
                className="card"
                key={review.reviewTargetId}
                aria-current={focusReviewId === review.reviewTargetId ? 'true' : undefined}
              >
                <h4>{review.objectiveTitle}</h4>
                <p>
                  {review.workflowPhase === 'due'
                    ? '现在到期'
                    : review.workflowPhase === 'scheduled'
                      ? '已安排'
                      : '复习进行中'}{' '}
                  · {new Date(review.dueAt).toLocaleString('zh-CN')}
                </p>
                {review.workflowPhase !== 'scheduled' ? (
                  <button type="button" disabled={busy} onClick={() => void startReview(review)}>
                    {busy
                      ? '正在准备复习…'
                      : review.workflowPhase === 'due'
                        ? '开始复习'
                        : '继续复习'}
                  </button>
                ) : null}
              </article>
            ))}
          </section>
        </>
      ) : null}
      {section === 'history' ? (
        <section aria-label="课堂学习记录">
          <h3>讲解与练习记录</h3>
          {progress.lessons.length === 0 ? (
            <p>尚无课堂学习记录。</p>
          ) : (
            progress.lessons.map((lesson) => (
              <p key={lesson.id}>
                {lesson.title} · {lesson.completedAt ? '已完成讲解与练习' : '学习中'} ·{' '}
                {new Date(lesson.updatedAt).toLocaleString('zh-CN')}
              </p>
            ))
          )}
        </section>
      ) : null}
    </div>
  );
}
