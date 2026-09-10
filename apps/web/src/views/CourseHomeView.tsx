import type {
  CourseExecutionOverview,
  CourseNextAction,
  CoursePreparation,
  LearningContractScopeReadiness,
  MaterialRole,
  StudyPlanDraftEdit,
  StudyPlanItemPlannability,
} from '@hy3-clinic/shared';
import { COURSE_PREPARATION_PLAN_TRIGGER } from '@hy3-clinic/shared';
import { Banner, Loading } from '../components/ui.js';
import { StudyPlanPanel } from './StudyPlanPanel.js';
import { CurriculumFailureDiagnostics } from './CurriculumView.js';
import { learnerPlanText } from './learnerLanguage.js';
import { CoursePreparationStatus } from './CoursePreparationStatus.js';

const SETUP_TEXT: Record<CourseExecutionOverview['setupStage'], string> = {
  contract_required: '选择课程资料、全局深度和可选重点',
  contract_review: '课程设计输入等待提交',
  curriculum_required: '课程设计输入已保存，可以整理课程结构',
  curriculum_review: '课程结构等待你的审阅',
  plan_required: '课程结构已就绪，可以规划学习路线',
  plan_review: '正在完成学习安排',
  route_active: '学习路线已启用',
  goal_closed: '本轮课程学习已结束',
};

const PREPARATION_TEXT: Record<CoursePreparation['state'], string> = {
  not_started: '提交课程设计输入后开始准备',
  preparing_materials: '正在整理课程资料',
  preparing_concepts: '正在理解课程资料的核心内容',
  preparing_course_structure: '正在设计课程结构',
  validating_course_plan: '正在检查课程方案是否可以执行',
  preparing_assessment_readiness: '正在检查正式检验依据',
  course_plan_ready: '课程学习安排已生成',
  awaiting_required_governance: '课程准备需要你的决定',
  failed_recoverable: '课程准备暂时中断',
  blocked: '课程准备需要检查',
  complete: '课程已经准备好',
};

const COURSE_DEPTH_TEXT: Record<string, string> = {
  pass_oriented: '基础理解',
  working_fluency: '熟练运用',
  high_performance: '高水平表现',
  deep_transfer: '深入迁移',
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
    return `课程资料用途已从“${SCOPE_ROLE_TEXT[roleChange.contractedRole]}”改为“${SCOPE_ROLE_TEXT[roleChange.currentConfirmedRole]}”，需要你重新确认课程设置。`;
  }
  const unavailableCount = readiness.issues.filter((issue) =>
    ['material_missing', 'material_retired', 'material_moved'].includes(issue.kind),
  ).length;
  if (unavailableCount > 0) {
    return `课程设置中的 ${unavailableCount} 份资料已被移除或不再属于当前课程，需要你重新确认资料范围。`;
  }
  return '课程资料缺少仍然有效的用途确认，需要你检查资料范围并重新确认课程设置。';
}

export interface CourseHomeViewProps {
  courseName: string;
  overview: CourseExecutionOverview | null;
  preparation: CoursePreparation | null;
  preparationError: string | null;
  preparationSyncError?: string | null;
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
  /** Lesson plannability from the last proposal, edit, or refused acceptance. */
  studyPlanPlannability?: StudyPlanItemPlannability[];
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
  preparationSyncError,
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
  studyPlanPlannability,
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
  const simplifiedCourseDesign = Boolean(
    contract && Object.prototype.hasOwnProperty.call(contract, 'focusRequest'),
  );
  const courseDesignSurface = contract === null || simplifiedCourseDesign;
  const plan =
    overview.proposedStudyPlan &&
    (!overview.acceptedStudyPlan ||
      overview.proposedStudyPlan.version > overview.acceptedStudyPlan.version)
      ? overview.proposedStudyPlan
      : overview.acceptedStudyPlan;
  const derivedPreparationPlan = Boolean(
    simplifiedCourseDesign &&
    plan?.status === 'proposed' &&
    plan.proposalTrigger === COURSE_PREPARATION_PLAN_TRIGGER,
  );
  const curriculum =
    overview.proposedCurriculum &&
    (!overview.planningCurriculum ||
      overview.proposedCurriculum.version > overview.planningCurriculum.version)
      ? overview.proposedCurriculum
      : overview.planningCurriculum;
  const next = overview.nextAction;
  const activeUnits = overview.activeCurriculumHierarchy?.nodes ?? [];
  const nextUnit = activeUnits.find((node) => node.id === next?.item.learningUnitId);
  const progress = overview.formalProgress;
  const planPreflight = overview.studyPlanPreflight ?? null;
  const curriculumRecovery = overview.curriculumRecovery;
  const contractScopeBlocked = overview.contractScopeReadiness?.state === 'reconfirmation_required';
  const planReadinessBlocked =
    overview.setupStage === 'plan_required' && planPreflight?.canGenerate === false;
  const preparationOwnsSetup =
    preparation !== null && !['not_started', 'complete'].includes(preparation.state);
  const preparationBusy = busyAction === 'prepare-course' || preparation?.canCancel === true;
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
        (risk.category === 'readiness_gap' &&
          (preparation === null || preparation.state === 'complete')) ||
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
          return { label: '重新设置课程', onClick: onCreateContract, busy: false };
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
      return { label: '重新确认课程设置', onClick: onCreateContract, busy: false };
    }
    switch (overview.setupStage) {
      case 'contract_required':
        return { label: '设置课程', onClick: onCreateContract, busy: false };
      case 'contract_review':
        return {
          label: contract?.status === 'draft' ? '提交课程设置' : '开始准备课程',
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
        if (derivedPreparationPlan) {
          return {
            label: '继续准备课程',
            onClick: onRunPreparation,
            busy: busyAction === 'prepare-course',
          };
        }
        return {
          label: '接受学习路线',
          onClick: onAcceptStudyPlan,
          busy: busyAction === 'accept-plan',
        };
      case 'goal_closed':
        return { label: '设置新的课程', onClick: onCreateContract, busy: false };
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
            <p className="eyebrow">COURSE / 学习概览</p>
            <h2>{courseName}</h2>
            <p className="course-page-summary">{setupText}</p>
          </div>
          <button type="button" className="ghost" onClick={onOpenMaterials}>
            管理课程资料
          </button>
        </header>

        {contract ? (
          <div
            className="course-state-grid"
            aria-label={simplifiedCourseDesign ? '课程设计与正式进度' : '目标与正式进度'}
          >
            <div>
              <span className="small muted">
                {simplifiedCourseDesign ? '全局深度' : '本轮目标'}
              </span>
              <strong>
                {simplifiedCourseDesign
                  ? (COURSE_DEPTH_TEXT[contract.desiredDepth] ?? contract.desiredDepth)
                  : contract.targetOutcome.description}
              </strong>
              {simplifiedCourseDesign ? (
                <span className="small muted">
                  {contract.focusRequest
                    ? `重点：${contract.focusRequest}`
                    : '均衡安排，无额外重点'}
                </span>
              ) : null}
            </div>
            <div>
              <span className="small muted">正式进度</span>
              <strong>
                {progress.planItemCount === 0
                  ? '尚未开始学习'
                  : `已完成 ${progress.completedPlanItemCount} / ${progress.planItemCount}`}
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
          <Banner kind="error">课程设置暂未保存。{actionFailure.message}</Banner>
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
          <>
            <CoursePreparationStatus
              preparation={preparation}
              title={PREPARATION_TEXT[preparation.state]}
              busy={preparationBusy}
              syncError={preparationSyncError}
            />
            {preparationError && preparation.state === 'failed_recoverable' ? (
              <Banner kind="error">课程准备暂未完成，已有有效内容保持不变。</Banner>
            ) : null}
          </>
        ) : null}

        {next ? (
          <div className="next-action next-action-study" aria-label="下一步">
            <div>
              <p className="eyebrow">
                <img src="/icons/tabler/minus.svg" alt="" aria-hidden="true" />
                下一步
              </p>
              <h3>{nextUnit?.title ?? learnerPlanText(next.item.reason)}</h3>
              {nextUnit ? (
                <details className="next-action-reason">
                  <summary>
                    <img src="/icons/tabler/player-play.svg" alt="" aria-hidden="true" />
                    为什么从这里继续
                  </summary>
                  <p>{learnerPlanText(next.whyNext)}</p>
                </details>
              ) : (
                <p>{learnerPlanText(next.whyNext)}</p>
              )}
              <p className="next-action-duration">
                <img src="/icons/tabler/clock.svg" alt="" aria-hidden="true" />
                预计 {next.item.estimatedMinutes} 分钟
              </p>
            </div>
            {next.item.launch.status === 'launchable' ? (
              <button
                type="button"
                className="primary course-primary-cta"
                disabled={busyAction !== null}
                onClick={() => (onOpenStudySession ? onOpenStudySession() : onLaunchNext(next))}
              >
                {busyAction === 'launch-next' ? '正在重新验证…' : '继续学习'}
                <img src="/icons/tabler/arrow-right.svg" alt="" aria-hidden="true" />
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
          <div
            className={`next-action setup-action${preparationBusy || busyAction === 'propose-curriculum' ? ' is-preparing' : ''}`}
            aria-label="下一步"
          >
            <div>
              <p className="eyebrow">下一步</p>
              <h3>
                {preparationBusy
                  ? '正在为你准备课程'
                  : preparationOwnsSetup && setupAction
                    ? setupAction.label
                    : setupText}
              </h3>
              <p className="muted">
                {preparationOwnsSetup && preparation
                  ? (preparation.blocker?.message ??
                    (preparation.state === 'course_plan_ready'
                      ? '课程结构和学习安排已经合并为一份课程方案。'
                      : preparationBusy
                        ? '系统正在继续完成课程准备。'
                        : '已完成的内容会保留，继续后将接着准备课程。'))
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
              <div className="preparation-controls">
                <span className="small muted">已完成的有效内容会立即保留。</span>
                <button type="button" className="primary" onClick={onCancelPreparation}>
                  停止
                </button>
              </div>
            ) : preparation?.canCancel ? (
              <div className="preparation-controls" role="status">
                <strong>正在接收准备进度</strong>
                <span className="small muted">完成后将自动更新页面。</span>
              </div>
            ) : busyAction === 'propose-curriculum' ? (
              <div className="preparation-controls" role="status">
                <strong>正在准备课程资料并生成课程结构</strong>
                <span className="small muted">
                  生成完成后会检查资料一致性；只有需要时才会尝试一次自动修复。
                </span>
                <button type="button" className="primary" onClick={onCancelCurriculum}>
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
                <img src="/icons/tabler/arrow-right.svg" alt="" aria-hidden="true" />
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
                <span>
                  {activeUnits.find((node) => node.id === item.learningUnitId)?.title ??
                    learnerPlanText(item.reason)}
                </span>
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
              {learnerPlanText(risk.claim)}
            </p>
          ))}
        </section>
      ) : null}

      <details className="course-detail-disclosure">
        <summary>{courseDesignSurface ? '课程设计输入' : '学习目标与范围'}</summary>
        {contract ? (
          <div className="detail-content">
            {simplifiedCourseDesign ? (
              <>
                <p>全局深度：{COURSE_DEPTH_TEXT[contract.desiredDepth] ?? contract.desiredDepth}</p>
                <p>
                  {contract.focusRequest
                    ? `特别关注：${contract.focusRequest}`
                    : '特别关注：无（均衡安排）'}
                </p>
              </>
            ) : (
              <p>{contract.intent}</p>
            )}
            <p className="small">
              <span className="pill">
                {contractScopeBlocked ? '学习范围待重新确认' : '学习范围已确认'}
              </span>{' '}
              <span className="pill model">不等于事实或评分依据已验证</span>
            </p>
            <p className="small muted">
              可计入状态的正式证据 {progress.stateCreditingEvidenceCount} · 仅供参考的证据{' '}
              {progress.advisoryEvidenceCount}
            </p>
            {overview.capabilities.canEditContract ? (
              <button type="button" onClick={onEditContract} disabled={busyAction !== null}>
                编辑课程设置
              </button>
            ) : null}
          </div>
        ) : (
          <p className="muted">设置课程资料、全局深度和可选重点后，这里会显示课程设计输入。</p>
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
            <p className="muted">提交课程设置后即可生成课程结构。</p>
          )}
        </div>
      </details>

      {plan && !derivedPreparationPlan ? (
        <details className="course-detail-disclosure" open={plan.status === 'proposed'}>
          <summary>{plan.status === 'proposed' ? '待确认的课程方案' : '完整学习路线'}</summary>
          {actionFailure?.owner === 'plan' ? (
            <Banner kind="error">学习路线决定未完成。{actionFailure.message}</Banner>
          ) : null}
          <StudyPlanPanel
            plan={plan}
            history={overview.studyPlanHistory}
            canEdit={overview.capabilities.canEditStudyPlan && !derivedPreparationPlan}
            canAccept={
              overview.capabilities.canAcceptStudyPlan && preparation?.state !== 'course_plan_ready'
            }
            showAcceptAction={preparation?.state !== 'course_plan_ready'}
            showDecisionActions={!derivedPreparationPlan}
            busyAction={busyAction}
            launchByPlanItemId={{}}
            {...(plan.status === 'proposed' && studyPlanPlannability
              ? { plannability: studyPlanPlannability }
              : {})}
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
                {learnerPlanText(risk.claim)} ·{' '}
                <span className="muted">{learnerPlanText(risk.uncertainty)}</span>
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
