import { useEffect, useState, type KeyboardEvent } from 'react';
import type {
  CourseExecutionCommandEnvelope,
  CourseExecutionOverview,
  DocumentSummary,
  CurrentReviewItem,
  LearnerRepairProjection,
  CourseLearningProgress,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { FormalProgressView } from './FormalProgressView.js';
import { QuizHistoryView } from './QuizHistoryView.js';
import { MistakesView } from './MistakesView.js';
import { MasteryView } from './MasteryView.js';
import { CourseLearningRecords } from './CourseLearningRecords.js';

export type ProgressSection = 'overview' | 'evidence' | 'repair' | 'mastery' | 'history';

export interface CourseProgressIntent {
  requestId: number;
  section: ProgressSection;
  learningUnitId?: string | null;
  objectiveId?: string | null;
  repairEpisodeId?: string | null;
  reviewTargetId?: string | null;
}

const SECTION_LABELS: Record<ProgressSection, string> = {
  overview: '概览',
  evidence: '正式证据',
  repair: '修复',
  mastery: '掌握与复习',
  history: '历史与决定',
};
const PROGRESS_SECTIONS = Object.keys(SECTION_LABELS) as ProgressSection[];

function CourseHistoryRecords({ overview }: { overview: CourseExecutionOverview | null }) {
  if (
    !overview ||
    (overview.contractHistory.length === 0 &&
      overview.curriculumHistory.length === 0 &&
      overview.studyPlanHistory.length === 0)
  ) {
    return (
      <div className="course-empty-state compact" role="status">
        <strong>还没有版本记录</strong>
        <p>确认学习目标、课程结构或学习路线后，相应决定会保留在这里。</p>
      </div>
    );
  }

  return (
    <div className="course-history-groups">
      {overview.contractHistory.length > 0 ? (
        <section>
          <h3>学习目标决定</h3>
          <ol className="course-history-list">
            {[...overview.contractHistory].reverse().map((item) => (
              <li key={item.id}>
                <strong>
                  版本 {item.version} · {item.targetDescription}
                </strong>
                <span className="small muted">
                  {contractStatusLabel(item.status)} · {formatHistoryDate(item.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {overview.curriculumHistory.length > 0 ? (
        <section>
          <h3>课程结构决定</h3>
          <ol className="course-history-list">
            {[...overview.curriculumHistory].reverse().map((item) => (
              <li key={item.id}>
                <strong>
                  版本 {item.version} · {item.title}
                </strong>
                <span className="small muted">
                  {curriculumStatusLabel(item.status)} · {item.learningUnitCount} 个学习单元 ·{' '}
                  {formatHistoryDate(item.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {overview.studyPlanHistory.length > 0 ? (
        <section>
          <h3>学习路线与调整</h3>
          <ol className="course-history-list">
            {[...overview.studyPlanHistory].reverse().map((item) => (
              <li key={item.id}>
                <strong>版本 {item.version}</strong>
                <span className="small muted">
                  {studyPlanStatusLabel(item.status)} · {item.itemCount} 项 · 预计{' '}
                  {item.projectedMinutes} 分钟
                  {item.deferredUnitCount > 0 ? ` · ${item.deferredUnitCount} 项延期` : ''} ·{' '}
                  {formatHistoryDate(item.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

export interface CourseProgressViewProps {
  workspaceId: string;
  documents: DocumentSummary[];
  overview: CourseExecutionOverview | null;
  refreshKey: number;
  command: (prefix: string) => CourseExecutionCommandEnvelope;
  onAcceptProposedPlan: () => void;
  onRejectProposedPlan: () => void;
  onCourseChanged: () => void;
  onRemediate: (materialId: string) => void;
  remediationLoading: boolean;
  remediationError: string | null;
  operationError: string | null;
  intent?: CourseProgressIntent | null;
  onOpenKnowledgeMap?: () => void;
  onSectionChange?: (section: ProgressSection) => void;
  onOpenAssessment?: () => void;
  onOpenStudy?: () => void;
}

/** Consolidates formal progression and the legacy diagnostic views under one Course destination. */
export function CourseProgressView({
  workspaceId,
  documents,
  overview,
  refreshKey,
  command,
  onAcceptProposedPlan,
  onRejectProposedPlan,
  onCourseChanged,
  onRemediate,
  remediationLoading,
  remediationError,
  operationError,
  intent = null,
  onOpenKnowledgeMap,
  onSectionChange,
  onOpenAssessment,
  onOpenStudy,
}: CourseProgressViewProps) {
  const [section, setSection] = useState<ProgressSection>('overview');
  const [learningProgress, setLearningProgress] = useState<CourseLearningProgress | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  function refreshRecords() {
    setRevision((value) => value + 1);
    onCourseChanged();
  }
  useEffect(() => {
    const controller = new AbortController();
    setProgressError(null);
    void api
      .courseLearningProgress(workspaceId, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setLearningProgress(response);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setProgressError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [workspaceId, refreshKey, revision]);
  const [materialId, setMaterialId] = useState(documents[0]?.id ?? '');
  const [reviews, setReviews] = useState<CurrentReviewItem[] | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [focusedRepair, setFocusedRepair] = useState<LearnerRepairProjection | null>(null);
  const [focusedRepairError, setFocusedRepairError] = useState<string | null>(null);
  const [focusedRepairLoading, setFocusedRepairLoading] = useState(false);

  useEffect(() => {
    if (intent) setSection(intent.section);
  }, [intent]);

  useEffect(() => {
    if (!intent?.repairEpisodeId) {
      setFocusedRepair(null);
      setFocusedRepairError(null);
      setFocusedRepairLoading(false);
      return;
    }
    const controller = new AbortController();
    setFocusedRepair(null);
    setFocusedRepairError(null);
    setFocusedRepairLoading(true);
    void api
      .getLearnerRepair(intent.repairEpisodeId, controller.signal)
      .then((repair) => {
        if (!controller.signal.aborted) setFocusedRepair(repair);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setFocusedRepairError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFocusedRepairLoading(false);
      });
    return () => controller.abort();
  }, [intent?.repairEpisodeId, intent?.requestId]);

  useEffect(() => {
    if (!documents.some((document) => document.id === materialId)) {
      setMaterialId(documents[0]?.id ?? '');
    }
  }, [documents, materialId]);

  useEffect(() => {
    const controller = new AbortController();
    setReviews(null);
    setReviewError(null);
    void api
      .reviewItems(workspaceId, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setReviews(response.items);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setReviewError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [workspaceId, refreshKey, revision]);

  const progress = overview?.formalProgress;
  const learningRecords =
    section !== 'overview' && learningProgress ? (
      <CourseLearningRecords
        key={`${workspaceId}:${section}`}
        workspaceId={workspaceId}
        section={section}
        progress={learningProgress}
        reviews={reviews}
        reviewError={reviewError}
        command={command}
        executionVersion={overview?.courseExecutionVersion ?? 0}
        onRefresh={refreshRecords}
        onOpenStudy={onOpenStudy}
        focusRepairId={intent?.repairEpisodeId}
        focusObjectiveId={section === 'evidence' ? intent?.objectiveId : null}
        focusReviewId={intent?.reviewTargetId}
      />
    ) : null;
  const reviewSummary = reviewError
    ? '复习记录暂时无法读取'
    : reviews === null
      ? '正在加载复习安排…'
      : `${reviews.length} 项复习记录`;

  function changeSection(next: ProgressSection): void {
    setSection(next);
    onSectionChange?.(next);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: ProgressSection): void {
    const currentIndex = PROGRESS_SECTIONS.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % PROGRESS_SECTIONS.length;
    if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + PROGRESS_SECTIONS.length) % PROGRESS_SECTIONS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = PROGRESS_SECTIONS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = PROGRESS_SECTIONS[nextIndex]!;
    changeSection(next);
    requestAnimationFrame(() => document.getElementById(`progress-tab-${next}`)?.focus());
  }

  return (
    <div className="course-progress stack" aria-label="课程进展">
      <header className="supporting-page-intro course-page-intro">
        <div>
          <p className="eyebrow">有依据的学习进展</p>
          <h2>看见理解的积累。</h2>
          <p className="muted">
            正式证据、待修复内容和历史决定都汇集在这里。Tutor 对话和一般活动不会自动成为正式进展。
          </p>
        </div>
        {onOpenKnowledgeMap ? (
          <button type="button" onClick={onOpenKnowledgeMap}>
            在知识地图中解释
          </button>
        ) : null}
      </header>

      {onOpenAssessment ? (
        <details className="technical-details progress-assessment-tools">
          <summary>高级评估</summary>
          <button type="button" className="ghost small" onClick={onOpenAssessment}>
            打开手动评估
          </button>
        </details>
      ) : null}

      {operationError ? <Banner kind="error">这次进展操作未完成。{operationError}</Banner> : null}
      {progressError ? (
        <Banner kind="error">
          学习记录暂时无法读取。{progressError}
          <button type="button" onClick={refreshRecords}>
            重新读取进展
          </button>
        </Banner>
      ) : null}

      {intent &&
      (intent.learningUnitId ||
        intent.objectiveId ||
        intent.repairEpisodeId ||
        intent.reviewTargetId) ? (
        <section className="progress-map-focus" aria-label="知识地图定位结果" role="status">
          <div>
            <span className="eyebrow">来自知识地图</span>
            <strong>
              {intent.repairEpisodeId
                ? '查看当前修复'
                : intent.reviewTargetId
                  ? '查看复习安排'
                  : '查看正式证据'}
            </strong>
          </div>
          {focusedRepairLoading ? <Loading label="读取修复内容…" /> : null}
          {focusedRepairError ? (
            <Banner kind="error">修复内容暂时无法读取。{focusedRepairError}</Banner>
          ) : null}
          {focusedRepair ? (
            <div className="progress-map-repair-detail">
              <p>
                <b>需要修复</b>
                {focusedRepair.diagnosis}
              </p>
              <p>
                <b>修复目标</b>
                {focusedRepair.target}
              </p>
              {focusedRepair.packet ? (
                <p>
                  <b>{focusedRepair.packet.interventionLabel}</b>
                  {focusedRepair.packet.explanation}
                </p>
              ) : null}
              <span className="small muted">
                已练习 {focusedRepair.attemptCount} 次 ·{' '}
                {focusedRepair.resolved ? '已解决' : '仍在进行'}
              </span>
            </div>
          ) : null}
          {intent.reviewTargetId && reviews ? (
            reviews.some((review) => review.reviewTargetId === intent.reviewTargetId) ? (
              <p>已在“掌握与复习”中定位当前复习项目。</p>
            ) : (
              <p className="muted">该复习项目已不在当前安排中，下面显示最新复习状态。</p>
            )
          ) : null}
        </section>
      ) : null}

      <div className="subview-tabs" aria-label="进展分类" role="tablist">
        {PROGRESS_SECTIONS.map((item) => (
          <button
            type="button"
            key={item}
            id={`progress-tab-${item}`}
            role="tab"
            aria-selected={section === item}
            aria-controls={`progress-panel-${item}`}
            tabIndex={section === item ? 0 : -1}
            className={section === item ? 'active' : ''}
            onClick={() => changeSection(item)}
            onKeyDown={(event) => onTabKeyDown(event, item)}
          >
            {SECTION_LABELS[item]}
          </button>
        ))}
      </div>

      {section === 'overview' ? (
        <div
          className="progress-summary"
          id="progress-panel-overview"
          role="tabpanel"
          aria-labelledby="progress-tab-overview"
        >
          <section className="progress-summary-primary" aria-label="正式学习概览">
            <p className="eyebrow">当前学习进度</p>
            <strong className="progress-total">
              {learningProgress
                ? `${learningProgress.summary.teachingCompleted} / ${learningProgress.summary.teachingTotal}`
                : progress
                  ? `${progress.completedPlanItemCount} / ${progress.planItemCount}`
                  : '尚未开始'}
            </strong>
            <p className="muted">已完成的讲解与练习；正式掌握另看检查证据</p>
            <button type="button" className="primary" onClick={() => changeSection('evidence')}>
              查看正式证据
            </button>
          </section>
          <section className="progress-summary-list" aria-label="持久学习状态摘要">
            <button type="button" onClick={() => changeSection('evidence')}>
              <span>有正式通过证据的目标</span>
              <strong>
                {learningProgress
                  ? `${learningProgress.summary.supportedObjectives} / ${learningProgress.summary.objectiveTotal}`
                  : '正在读取…'}
              </strong>
            </button>
            <button type="button" onClick={() => changeSection('repair')}>
              <span>需要修复</span>
              <strong>
                {learningProgress
                  ? `${learningProgress.summary.openRepairs} 项修复待处理`
                  : '正在读取…'}
              </strong>
            </button>
            <button type="button" onClick={() => changeSection('mastery')}>
              <span>掌握与复习</span>
              <strong>{reviewSummary}</strong>
            </button>
            <button type="button" onClick={() => changeSection('history')}>
              <span>历史与决定</span>
              <strong>测验、评估与版本记录</strong>
            </button>
          </section>
          <p className="progress-advisory-note small muted">
            另有 {progress?.advisoryEvidenceCount ?? 0} 项仅供参考证据；它们不会授予正式状态。
          </p>
        </div>
      ) : null}

      {section === 'evidence' ? (
        <div id="progress-panel-evidence" role="tabpanel" aria-labelledby="progress-tab-evidence">
          {learningRecords}
          <details>
            <summary>证据核对与课程结果</summary>
            <FormalProgressView
              workspaceId={workspaceId}
              refreshKey={refreshKey + revision}
              overview={overview}
              command={command}
              onAcceptProposedPlan={onAcceptProposedPlan}
              onRejectProposedPlan={onRejectProposedPlan}
              onCourseChanged={refreshRecords}
              onOpenProgress={(target) =>
                changeSection(
                  target === 'history' ? 'history' : target === 'mistakes' ? 'repair' : 'mastery',
                )
              }
              focusObjectiveId={intent?.section === 'evidence' ? intent.objectiveId : null}
            />
          </details>
        </div>
      ) : null}

      {section === 'history' ? (
        <div
          className="progress-history stack"
          id="progress-panel-history"
          role="tabpanel"
          aria-labelledby="progress-tab-history"
        >
          {learningRecords}
          <section className="progress-history-versions" aria-label="学习目标与路线历史">
            <div className="section-heading">
              <h3>学习目标、课程结构与路线决定</h3>
              <p className="small muted">已确认版本保留为历史记录，不会被后续版本改写。</p>
            </div>
            <CourseHistoryRecords overview={overview} />
          </section>
          <details className="progress-assessment-history" aria-label="测验与评估历史">
            <summary>旧版测验与康复练习记录</summary>
            <QuizHistoryView workspaceId={workspaceId} />
          </details>
          <details>
            <summary>课程结果与历史决定</summary>
            <FormalProgressView
              workspaceId={workspaceId}
              overview={overview}
              command={command}
              onAcceptProposedPlan={onAcceptProposedPlan}
              onRejectProposedPlan={onRejectProposedPlan}
              onCourseChanged={refreshRecords}
              onOpenProgress={() => changeSection('evidence')}
            />
          </details>
        </div>
      ) : null}

      {section === 'repair' || section === 'mastery' ? (
        <section
          className="material-progress-scope"
          id={`progress-panel-${section}`}
          role="tabpanel"
          aria-labelledby={`progress-tab-${section}`}
        >
          {learningRecords}
          <details>
            <summary>旧版按资料的错题与掌握记录</summary>
            {documents.length > 1 ? (
              <label>
                资料范围
                <select value={materialId} onChange={(event) => setMaterialId(event.target.value)}>
                  {documents.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!materialId ? (
              <div className="course-empty-state compact" role="status">
                <strong>还没有可以汇总的学习记录</strong>
                <p>课程还没有资料，因此暂时没有可汇总的错题或掌握记录。请先添加课程资料。</p>
              </div>
            ) : section === 'repair' ? (
              <MistakesView
                materialId={materialId}
                refreshKey={refreshKey}
                onRemediate={() => onRemediate(materialId)}
                remediationLoading={remediationLoading}
                remediationError={remediationError}
              />
            ) : (
              <>
                <MasteryView materialId={materialId} refreshKey={refreshKey} />
                {!learningProgress ? (
                  <section className="review-summary" aria-label="复习安排">
                    <h3>复习安排</h3>
                    {reviewError ? <Banner kind="error">{reviewError}</Banner> : null}
                    {reviews === null && !reviewError ? <Loading label="加载复习安排…" /> : null}
                    {reviews?.length === 0 ? (
                      <div className="course-empty-state compact" role="status">
                        <strong>还没有复习安排</strong>
                        <p>
                          尚未完成正式评估时，这里为空是正常的。完成测验后，需要复习的内容会显示在这里。
                        </p>
                      </div>
                    ) : null}
                    {reviews?.map((review) => (
                      <article
                        className={`review-row${
                          intent?.reviewTargetId === review.reviewTargetId ? ' is-focused' : ''
                        }`}
                        key={review.reviewTargetId}
                        aria-current={
                          intent?.reviewTargetId === review.reviewTargetId ? 'true' : undefined
                        }
                      >
                        <strong>{review.objectiveTitle}</strong>
                        <span className="small muted">
                          {reviewWorkflowLabel(review.workflowPhase)} ·{' '}
                          {review.workflowPhase === 'due' ? '到期时间' : '下次复习'}{' '}
                          {new Date(review.dueAt).toLocaleString('zh-CN')}
                          {review.lifecycleState === 'pending_initial_review'
                            ? ' · 等待首次复习'
                            : ` · 已复习 ${review.repetitions ?? 0} 次`}
                        </span>
                      </article>
                    ))}
                  </section>
                ) : null}
              </>
            )}
          </details>
        </section>
      ) : null}
    </div>
  );
}

function reviewWorkflowLabel(phase: CurrentReviewItem['workflowPhase']): string {
  const labels: Record<CurrentReviewItem['workflowPhase'], string> = {
    scheduled: '已安排',
    due: '现在到期',
    retrieval: '正式回忆进行中',
    repair: '需要针对性修复',
    practice: '修复练习中',
    fresh_verification: '等待换情境确认',
    scheduling_retry: '正式结果已保存，安排待同步',
  };
  return labels[phase];
}

function contractStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    draft: '草稿',
    proposed: '待确认',
    learner_confirmed: '已确认',
    active: '当前目标',
    closed: '已结束',
    superseded: '历史版本',
    withdrawn: '已撤回',
  };
  return labels[value] ?? '已记录';
}

function curriculumStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    candidate: '待审核结构',
    proposed: '等待你确认',
    accepted: '当前结构',
    rejected: '已拒绝',
    failed: '生成未完成',
    superseded: '历史版本',
  };
  return labels[value] ?? '已记录';
}

function studyPlanStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    candidate: '待审核路线',
    proposed: '等待你确认',
    accepted: '当前路线',
    rejected: '已拒绝',
    superseded: '历史路线',
    closed: '已结束',
  };
  return labels[value] ?? '已记录';
}

function formatHistoryDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}
