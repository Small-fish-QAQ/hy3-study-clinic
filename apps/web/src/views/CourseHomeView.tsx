import type {
  CourseExecutionOverview,
  CourseNextAction,
  CoursePreparation,
  LearningContractScopeReadiness,
  MaterialRole,
  StudyPlanDraftEdit,
} from '@hy3-clinic/shared';
import { Banner, Loading } from '../components/ui.js';
import { StudyPlanPanel } from './StudyPlanPanel.js';
import { CurriculumFailureDiagnostics } from './CurriculumView.js';

const SETUP_TEXT: Record<CourseExecutionOverview['setupStage'], string> = {
  contract_required: '先明确这次学习要达到什么目标',
  contract_review: '学习目标等待你的确认',
  curriculum_required: '目标已确认，可以整理课程结构',
  curriculum_review: '课程结构等待你的审阅',
  plan_required: '课程结构已就绪，可以规划学习路线',
  plan_review: '学习路线等待你的接受',
  route_active: '学习路线已启用',
  goal_closed: '本轮学习目标已结束',
};

const PREPARATION_TEXT: Record<CoursePreparation['state'], string> = {
  not_started: '确认学习目标后开始准备课程',
  preparing_materials: '正在整理课程资料',
  preparing_concepts: '正在理解课程资料的核心内容',
  preparing_course_structure: '正在设计课程结构',
  validating_course_plan: '正在检查课程方案是否可以执行',
  course_plan_ready: '课程方案等待你的确认',
  awaiting_required_governance: '课程准备需要你的决定',
  failed_recoverable: '课程准备暂时中断',
  blocked: '课程准备需要检查',
  complete: '课程已经准备好',
};

const CHECKPOINT_TEXT: Array<{
  key: keyof CoursePreparation['checkpoints'];
  label: string;
}> = [
  { key: 'materials', label: '资料已整理' },
  { key: 'concepts', label: '核心内容已准备' },
  { key: 'courseStructure', label: '课程结构已完成' },
  { key: 'coursePlan', label: '课程方案已检查' },
];

const FEASIBILITY_TEXT: Record<
  NonNullable<CourseExecutionOverview['contractFeasibility']>['state'],
  string
> = {
  feasible: '按当前时间安排可行',
  at_risk: '当前时间安排存在风险',
  infeasible: '按当前时间安排难以完成',
  unknown: '还没有足够信息估算时间',
};

const SCOPE_ROLE_TEXT: Record<MaterialRole, string> = {
  course_material: '课程主资料',
  supplementary_reference: '补充参考',
  past_exam: '往年试题',
  exercise_sheet: '练习资料',
  question_set: '题目集合',
};

function contractScopeChangeText(readiness: LearningContractScopeReadiness): string {
  const roleChange = readiness.issues.find(
    (issue) => issue.kind === 'material_role_changed' && issue.currentConfirmedRole,
  );
  if (roleChange?.currentConfirmedRole) {
    return `课程资料用途已从“${SCOPE_ROLE_TEXT[roleChange.contractedRole]}”改为“${SCOPE_ROLE_TEXT[roleChange.currentConfirmedRole]}”，需要你重新确认学习约定。`;
  }
  const unavailableCount = readiness.issues.filter((issue) =>
    ['material_missing', 'material_retired', 'material_moved'].includes(issue.kind),
  ).length;
  if (unavailableCount > 0) {
    return `学习约定中的 ${unavailableCount} 份课程资料已被移除或不再属于当前课程，需要你重新确认资料范围。`;
  }
  return '课程资料缺少仍然有效的用途确认，需要你检查资料范围并重新确认学习约定。';
}

function formatDeadline(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
}

export interface CourseHomeViewProps {
  courseName: string;
  overview: CourseExecutionOverview | null;
  preparation: CoursePreparation | null;
  preparationError: string | null;
  loading: boolean;
  error: string | null;
  busyAction: string | null;
  routeGenerationFailure: {
    kind: 'timeout' | 'provider';
    detail: string;
  } | null;
  actionFailure: {
    owner: 'contract' | 'curriculum' | 'plan' | 'continue';
    message: string;
    details?: unknown;
  } | null;
  onCreateContract: () => void;
  onEditContract: () => void;
  onConfirmContract: () => void;
  onRunPreparation: () => void;
  onCancelPreparation: () => void;
  onProposeCurriculum: () => void;
  onCancelCurriculum: () => void;
  onOpenCurriculum: () => void;
  onOpenConceptGrounding: () => void;
  onOpenKnowledgeMap?: () => void;
  onProposeStudyPlan: () => void;
  onDismissRouteGenerationFailure: () => void;
  onOpenSettings: () => void;
  onEditStudyPlan: (edit: StudyPlanDraftEdit) => void;
  onAcceptStudyPlan: () => void;
  onRejectStudyPlan: () => void;
  onLaunchNext: (action: CourseNextAction) => void;
  onOpenStudySession?: () => void;
  onOpenMaterials: () => void;
}

/** Course Home renders persisted execution facts; it derives no status from Tutor prose. */
export function CourseHomeView({
  courseName,
  overview,
  preparation,
  preparationError,
  loading,
  error,
  busyAction,
  routeGenerationFailure,
  actionFailure,
  onCreateContract,
  onEditContract,
  onConfirmContract,
  onRunPreparation,
  onCancelPreparation,
  onProposeCurriculum,
  onCancelCurriculum,
  onOpenCurriculum,
  onOpenConceptGrounding,
  onOpenKnowledgeMap,
  onProposeStudyPlan,
  onDismissRouteGenerationFailure,
  onOpenSettings,
  onEditStudyPlan,
  onAcceptStudyPlan,
  onRejectStudyPlan,
  onLaunchNext,
  onOpenStudySession,
  onOpenMaterials,
}: CourseHomeViewProps) {
  if (loading && !overview) return <Loading label="加载课程状态…" />;
  if (error && !overview) return <Banner kind="error">{error}</Banner>;
  if (!overview) {
    return (
      <section className="course-empty-state compact" aria-label="课程状态暂不可用">
        <strong>暂时无法读取课程状态</strong>
        <p>课程资料不会因此改变。请稍后重试，也可以先检查课程资料。</p>
      </section>
    );
  }

  const contract = overview.pendingContract ?? overview.activeContract;
  const plan =
    overview.proposedStudyPlan &&
    (!overview.acceptedStudyPlan ||
      overview.proposedStudyPlan.version > overview.acceptedStudyPlan.version)
      ? overview.proposedStudyPlan
      : overview.acceptedStudyPlan;
  const curriculum =
    overview.proposedCurriculum &&
    (!overview.planningCurriculum ||
      overview.proposedCurriculum.version > overview.planningCurriculum.version)
      ? overview.proposedCurriculum
      : overview.planningCurriculum;
  const feasibility = overview.contractFeasibility;
  const next = overview.nextAction;
  const progress = overview.formalProgress;
  const planPreflight = overview.studyPlanPreflight ?? null;
  const curriculumRecovery = overview.curriculumRecovery;
  const contractScopeBlocked = overview.contractScopeReadiness?.state === 'reconfirmation_required';
  const planReadinessBlocked =
    overview.setupStage === 'plan_required' && planPreflight?.canGenerate === false;
  const preparationOwnsSetup =
    preparation !== null && !['not_started', 'complete'].includes(preparation.state);
  const setupText = preparationOwnsSetup
    ? PREPARATION_TEXT[preparation.state]
    : contractScopeBlocked
      ? '课程资料范围发生了变化'
      : planReadinessBlocked && curriculumRecovery?.state === 'concept_grounding_missing'
        ? '先从课程资料提取有原文依据的概念'
        : planReadinessBlocked && curriculumRecovery?.state === 'concept_grounding_stale'
          ? '课程资料已变化，需要重新建立概念依据'
          : planReadinessBlocked
            ? '课程结构已接受，但当前还不能生成可执行的学习路线'
            : SETUP_TEXT[overview.setupStage];
  const agendaItems = overview.activeAgenda?.items
    .filter((item) => !['completed', 'cancelled', 'deferred'].includes(item.state))
    .sort((left, right) => left.index - right.index)
    .slice(0, 3);
  const actionableRisks = overview.riskSummary.highlights.filter(
    (risk) =>
      risk.isCurrent &&
      risk.status !== 'resolved' &&
      risk.status !== 'rejected' &&
      (risk.category === 'intentional_deferral' ||
        risk.category === 'execution_blocker' ||
        risk.category === 'readiness_gap' ||
        risk.severity === 'critical' ||
        risk.severity === 'high'),
  );

  const setupAction = (() => {
    if (preparationOwnsSetup && preparation) {
      if (preparation.canResume) {
        return {
          label: preparation.state === 'failed_recoverable' ? '重试课程准备' : '继续准备课程',
          onClick: onRunPreparation,
          busy: busyAction === 'prepare-course',
        };
      }
      switch (preparation.learnerAction) {
        case 'reconfirm_learning_goal':
          return { label: '重新确认学习目标', onClick: onCreateContract, busy: false };
        case 'review_course_structure':
          return { label: '检查课程结构', onClick: onOpenCurriculum, busy: false };
        case 'review_course_plan':
          return {
            label: '确认课程方案',
            onClick: onAcceptStudyPlan,
            busy: busyAction === 'accept-plan',
          };
        default:
          return null;
      }
    }
    if (contractScopeBlocked) {
      return { label: '重新确认学习约定', onClick: onCreateContract, busy: false };
    }
    switch (overview.setupStage) {
      case 'contract_required':
        return { label: '设置学习目标', onClick: onCreateContract, busy: false };
      case 'contract_review':
        return {
          label: contract?.status === 'draft' ? '提交学习目标' : '确认学习目标',
          onClick: onConfirmContract,
          busy: busyAction === 'confirm-contract',
        };
      case 'curriculum_required':
        return {
          label: '生成课程结构',
          onClick: onProposeCurriculum,
          busy: busyAction === 'propose-curriculum',
        };
      case 'curriculum_review':
        return { label: '查看并审阅课程结构', onClick: onOpenCurriculum, busy: false };
      case 'plan_required':
        if (planReadinessBlocked) {
          if (
            curriculumRecovery?.nextAction === 'build_concept_grounding' ||
            curriculumRecovery?.nextAction === 'rebuild_concept_grounding'
          ) {
            return {
              label:
                curriculumRecovery.nextAction === 'build_concept_grounding'
                  ? '提取概念依据'
                  : '重新提取概念依据',
              onClick: onOpenConceptGrounding,
              busy: false,
            };
          }
          return {
            label: '检查并更新课程结构',
            onClick: onOpenCurriculum,
            busy: false,
          };
        }
        return {
          label: '生成学习路线',
          onClick: onProposeStudyPlan,
          busy: busyAction === 'propose-plan',
        };
      case 'plan_review':
        return {
          label: '接受学习路线',
          onClick: onAcceptStudyPlan,
          busy: busyAction === 'accept-plan',
        };
      case 'goal_closed':
        return { label: '设置新的学习目标', onClick: onCreateContract, busy: false };
      case 'route_active':
        return null;
    }
  })();

  return (
    <div className="course-home stack" aria-label={`${courseName}课程主页`}>
      {error ? <Banner kind="error">{error}</Banner> : null}

      <section className="course-home-hero" aria-label="课程概览">
        <header className="course-page-intro course-home-title row between">
          <div className="course-home-context">
            <p className="eyebrow">学习概览</p>
            <p className="course-page-summary">{setupText}</p>
          </div>
          <button type="button" className="ghost" onClick={onOpenMaterials}>
            管理课程资料
          </button>
        </header>

        {contract ? (
          <div className="course-state-grid" aria-label="目标与正式进度">
            <div>
              <span className="small muted">本轮目标</span>
              <strong>{contract.targetOutcome.description}</strong>
            </div>
            <div>
              <span className="small muted">正式进度</span>
              <strong>
                已完成 {progress.completedPlanItemCount} / {progress.planItemCount}
                {progress.startedPlanItemCount > 0
                  ? ` · 进行中 ${progress.startedPlanItemCount}`
                  : ''}
                {progress.repairNeededPlanItemCount > 0
                  ? ` · 待修复 ${progress.repairNeededPlanItemCount}`
                  : ''}
                {progress.deferredPlanItemCount > 0
                  ? ` · 已延期 ${progress.deferredPlanItemCount}`
                  : ''}
              </strong>
            </div>
            <div>
              <span className="small muted">截止时间</span>
              <strong>
                {contract.deadline ? (
                  <time dateTime={contract.deadline.at}>
                    {formatDeadline(contract.deadline.at, contract.deadline.timeZone)}（
                    {contract.deadline.timeZone}）
                  </time>
                ) : (
                  '未设置'
                )}
              </strong>
            </div>
          </div>
        ) : null}

        {routeGenerationFailure ? (
          <section className="route-generation-failure" aria-label="学习路线生成失败">
            <button
              type="button"
              className="route-generation-failure-dismiss"
              aria-label="关闭学习路线错误"
              title="关闭"
              onClick={onDismissRouteGenerationFailure}
            >
              ×
            </button>
            <div>
              <p className="eyebrow">学习路线暂未生成</p>
              <h3>学习路线暂未生成</h3>
              <p>
                {routeGenerationFailure.kind === 'timeout'
                  ? 'Hy3 响应时间过长，这次生成没有完成。'
                  : 'Hy3 这次没有完成学习路线生成，课程状态与已有路线均未改变。'}
              </p>
              <details>
                <summary>技术详情</summary>
                <code>{routeGenerationFailure.detail}</code>
              </details>
            </div>
            <div className="route-generation-failure-actions">
              <button
                type="button"
                className="primary"
                disabled={busyAction !== null}
                onClick={onProposeStudyPlan}
              >
                {busyAction === 'propose-plan' ? '正在重试…' : '重试'}
              </button>
              <button type="button" className="ghost" onClick={onOpenSettings}>
                检查 Hy3 设置
              </button>
            </div>
          </section>
        ) : null}

        {actionFailure?.owner === 'contract' ? (
          <Banner kind="error">学习目标暂未确认。{actionFailure.message}</Banner>
        ) : null}
        {actionFailure?.owner === 'curriculum' ? (
          <Banner kind="error">
            <p>课程结构暂未生成。{actionFailure.message}</p>
            <CurriculumFailureDiagnostics details={actionFailure.details} />
          </Banner>
        ) : null}
        {actionFailure?.owner === 'continue' ? (
          <Banner kind="error">暂时无法继续这项学习。{actionFailure.message}</Banner>
        ) : null}

        {preparationOwnsSetup && preparation ? (
          <section className="course-preparation-status" aria-label="课程准备状态">
            <div className="section-heading">
              <p className="eyebrow">课程准备</p>
              <h3>{PREPARATION_TEXT[preparation.state]}</h3>
            </div>
            <ol>
              {CHECKPOINT_TEXT.map(({ key, label }) => {
                const state = preparation.checkpoints[key];
                const mark =
                  state === 'complete'
                    ? '✓'
                    : state === 'in_progress'
                      ? '…'
                      : state === 'blocked'
                        ? '!'
                        : '○';
                return (
                  <li key={key} data-state={state}>
                    <span aria-hidden="true">{mark}</span>
                    <span>{label}</span>
                  </li>
                );
              })}
            </ol>
            {preparation.blocker ? (
              <p className="small muted">{preparation.blocker.message}</p>
            ) : null}
            {preparationError && preparation.state === 'failed_recoverable' ? (
              <Banner kind="error">课程准备暂未完成，已有有效内容保持不变。</Banner>
            ) : null}
          </section>
        ) : null}

        {next ? (
          <div className="next-action" aria-label="下一步">
            <div>
              <p className="eyebrow">下一步</p>
              <h3>{next.item.reason}</h3>
              <p>{next.whyNext}</p>
              <p className="small muted">预计 {next.item.estimatedMinutes} 分钟</p>
            </div>
            {next.item.launch.status === 'launchable' ? (
              <button
                type="button"
                className="primary course-primary-cta"
                disabled={busyAction !== null}
                onClick={() => (onOpenStudySession ? onOpenStudySession() : onLaunchNext(next))}
              >
                {busyAction === 'launch-next' ? '正在重新验证…' : '继续学习'}
              </button>
            ) : (
              <div className="course-continuation-blocked">
                <p className="small muted">继续学习暂时受阻</p>
                <Banner kind="info">{launchBlockReason(next.item.launch.reason)}</Banner>
                <button type="button" className="ghost" onClick={onOpenMaterials}>
                  检查课程资料
                </button>
              </div>
            )}
          </div>
        ) : setupAction ? (
          <div className="next-action setup-action" aria-label="下一步">
            <div>
              <p className="eyebrow">下一步</p>
              <h3>{setupText}</h3>
              <p className="muted">
                {preparationOwnsSetup && preparation
                  ? (preparation.blocker?.message ??
                    (preparation.state === 'course_plan_ready'
                      ? '课程结构和学习安排已经合并为一份课程方案。'
                      : '系统正在继续完成课程准备。'))
                  : contractScopeBlocked && overview.contractScopeReadiness
                    ? contractScopeChangeText(overview.contractScopeReadiness)
                    : planReadinessBlocked && planPreflight
                      ? curriculumRecovery?.nextAction === 'build_concept_grounding'
                        ? `当前 ${curriculumRecovery.includedMaterialCount} 份课程资料还没有可用的概念依据。完成提取后，系统会重新检查课程结构修复条件。`
                        : curriculumRecovery?.nextAction === 'rebuild_concept_grounding'
                          ? `已有 ${curriculumRecovery.staleConceptCount} 个概念依据不再对应当前资料版本。重新提取后，系统会重新检查课程结构修复条件。`
                          : `${planPreflight.nonExecutableLearningUnitCount} / ${planPreflight.totalLearningUnitCount} 个学习单元缺少当前可执行能力，需要先审阅课程结构的新版本。`
                      : '完成这一步后，系统才能给出可靠的后续学习动作。'}
              </p>
            </div>
            {busyAction === 'prepare-course' ? (
              <div className="stack curriculum-operation-status" role="status">
                <strong>
                  {preparation ? PREPARATION_TEXT[preparation.state] : '正在准备课程'}
                </strong>
                <span className="small muted">已完成的有效内容会立即保留。</span>
                <button type="button" className="ghost" onClick={onCancelPreparation}>
                  停止
                </button>
              </div>
            ) : busyAction === 'propose-curriculum' ? (
              <div className="stack curriculum-operation-status" role="status">
                <strong>正在准备课程资料并生成课程结构</strong>
                <span className="small muted">
                  生成完成后会检查资料一致性；只有需要时才会尝试一次自动修复。
                </span>
                <button type="button" className="ghost" onClick={onCancelCurriculum}>
                  停止
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="primary course-primary-cta"
                disabled={busyAction !== null}
                onClick={setupAction.onClick}
              >
                {setupAction.busy ? '正在处理…' : setupAction.label}
              </button>
            )}
          </div>
        ) : (
          <div className="course-continuation-blocked course-empty-state compact">
            <strong>当前没有可继续的学习内容</strong>
            <p>可以到“进展”查看待修复内容，或检查课程资料是否仍然适用。</p>
            <button type="button" className="ghost" onClick={onOpenMaterials}>
              检查课程资料
            </button>
          </div>
        )}
      </section>

      {agendaItems && agendaItems.length > 0 ? (
        <section className="today-work" aria-label="今天的学习">
          <div className="section-heading">
            <p className="eyebrow">今天</p>
            <h3>本次学习安排</h3>
          </div>
          <ol>
            {agendaItems.map((item) => (
              <li
                key={item.id}
                aria-current={item.id === overview.activeAgenda?.currentItemId ? 'step' : undefined}
              >
                <span>{item.reason}</span>
                <span className="small muted">约 {item.estimatedMinutes} 分钟</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {actionableRisks.length > 0 || progress.repairNeededPlanItemCount > 0 ? (
        <section className="important-exceptions" aria-label="需要关注">
          <h3>需要关注</h3>
          {progress.repairNeededPlanItemCount > 0 ? (
            <p>有 {progress.repairNeededPlanItemCount} 项正式学习结果需要修复。</p>
          ) : null}
          {actionableRisks.map((risk) => (
            <p key={risk.id}>
              <span className={`pill ${risk.severity === 'critical' ? 'wrong' : ''}`}>
                {risk.category === 'intentional_deferral'
                  ? '已接受延期'
                  : risk.category === 'readiness_gap'
                    ? '待补充依据'
                    : '优先处理'}
              </span>{' '}
              {risk.claim}
            </p>
          ))}
        </section>
      ) : null}

      <details className="course-detail-disclosure">
        <summary>学习目标与时间安排</summary>
        {contract ? (
          <div className="detail-content">
            <p>{contract.intent}</p>
            <p className="small">
              <span className="pill">
                {contractScopeBlocked ? '学习范围待重新确认' : '学习范围已确认'}
              </span>{' '}
              <span className="pill model">不等于事实或评分依据已验证</span>
            </p>
            {feasibility ? <p>{FEASIBILITY_TEXT[feasibility.state]}</p> : null}
            <p className="small muted">
              可计入状态的正式证据 {progress.stateCreditingEvidenceCount} · 仅供参考的证据{' '}
              {progress.advisoryEvidenceCount}
            </p>
            {overview.capabilities.canEditContract ? (
              <button type="button" onClick={onEditContract} disabled={busyAction !== null}>
                编辑学习目标
              </button>
            ) : null}
          </div>
        ) : (
          <p className="muted">设置学习目标后，这里会显示范围、时间预算和可行性。</p>
        )}
      </details>

      <details className="course-detail-disclosure">
        <summary>课程结构与版本</summary>
        <div className="detail-content">
          {curriculum ? (
            <>
              <p>当前课程结构版本 {curriculum.version}</p>
              <button type="button" onClick={onOpenCurriculum}>
                查看完整课程结构
              </button>
              {onOpenKnowledgeMap ? (
                <button type="button" onClick={onOpenKnowledgeMap}>
                  在知识地图中查看
                </button>
              ) : null}
            </>
          ) : (
            <p className="muted">确认学习目标后即可生成课程结构。</p>
          )}
        </div>
      </details>

      {plan ? (
        <details className="course-detail-disclosure" open={plan.status === 'proposed'}>
          <summary>{plan.status === 'proposed' ? '待确认的课程方案' : '完整学习路线'}</summary>
          {actionFailure?.owner === 'plan' ? (
            <Banner kind="error">学习路线决定未完成。{actionFailure.message}</Banner>
          ) : null}
          <StudyPlanPanel
            plan={plan}
            history={overview.studyPlanHistory}
            canEdit={overview.capabilities.canEditStudyPlan}
            canAccept={
              overview.capabilities.canAcceptStudyPlan && preparation?.state !== 'course_plan_ready'
            }
            showAcceptAction={preparation?.state !== 'course_plan_ready'}
            busyAction={busyAction}
            launchByPlanItemId={{}}
            onEdit={onEditStudyPlan}
            onAccept={onAcceptStudyPlan}
            onReject={onRejectStudyPlan}
            onLaunchItem={() => {}}
          />
        </details>
      ) : null}

      {(overview.riskSummary.currentIssueCount ?? overview.riskSummary.openCount) > 0 ||
      overview.riskSummary.explicitDeferralCount > 0 ? (
        <details className="course-detail-disclosure">
          <summary>当前覆盖与路线提醒</summary>
          <div className="detail-content">
            <p>
              当前问题 {overview.riskSummary.currentIssueCount ?? overview.riskSummary.openCount} ·
              资料覆盖观察 {overview.riskSummary.sourceCoverageObservationCount ?? 0} ·
              有意义的课程覆盖缺口 {overview.riskSummary.meaningfulCurriculumGapCount ?? 0} ·
              计划建议 {overview.riskSummary.recommendationCount ?? 0} · 已接受延期{' '}
              {overview.riskSummary.intentionalDeferralCount ??
                overview.riskSummary.explicitDeferralCount}{' '}
              · 历史记录{' '}
              {overview.riskSummary.historicalOnlyCount ?? overview.riskSummary.staleCount}
            </p>
            {overview.riskSummary.highlights.map((risk) => (
              <p key={risk.id} className="small">
                {risk.claim} · <span className="muted">{risk.uncertainty}</span>
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function launchBlockReason(value: string | null): string {
  if (!value) return '当前内容需要重新验证，暂时不能继续。';
  const labels: Record<string, string> = {
    'Source manifest must be revalidated.': '课程资料已有变化，需要重新验证当前学习路线。',
    'This LearningUnit has no current source Concept for lesson launch.':
      '当前学习单元缺少可用的课程概念，暂时不能开始讲解。',
    'Synthesis requires a validated multi-unit Curriculum synthesis group.':
      '综合评估需要经过验证的跨单元课程结构。',
    'Conversational informal checks become launchable in Phase 3.':
      '这项非正式检查当前需要在学习对话中进行。',
    'Adversarial readiness is intentionally deferred until Phase 5.': '这项检查当前尚不可用。',
  };
  return labels[value] ?? '当前学习内容需要重新验证，请检查课程资料或路线状态。';
}
