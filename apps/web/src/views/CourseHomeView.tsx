import type {
  CourseExecutionOverview,
  CourseNextAction,
  StudyPlanDraftEdit,
} from '@hy3-clinic/shared';
import { Banner, Loading } from '../components/ui.js';
import { StudyPlanPanel } from './StudyPlanPanel.js';

const SETUP_TEXT: Record<CourseExecutionOverview['setupStage'], string> = {
  contract_required: '建立学习约定',
  contract_review: '确认学习约定',
  curriculum_required: '生成课程结构',
  curriculum_review: '审阅课程结构',
  plan_required: '生成学习路线',
  plan_review: '审阅学习路线',
  route_active: '路线已启用',
  goal_closed: '本轮目标已结束',
};

const FEASIBILITY_TEXT: Record<
  NonNullable<CourseExecutionOverview['contractFeasibility']>['state'],
  string
> = {
  feasible: '时间可行',
  at_risk: '时间存在风险',
  infeasible: '按当前约束不可行',
  unknown: '尚无法估算',
};

export interface CourseHomeViewProps {
  courseName: string;
  overview: CourseExecutionOverview | null;
  loading: boolean;
  error: string | null;
  busyAction: string | null;
  onCreateContract: () => void;
  onEditContract: () => void;
  onConfirmContract: () => void;
  onProposeCurriculum: () => void;
  onOpenCurriculum: () => void;
  onProposeStudyPlan: () => void;
  onEditStudyPlan: (edit: StudyPlanDraftEdit) => void;
  onAcceptStudyPlan: () => void;
  onRejectStudyPlan: () => void;
  onLaunchNext: (action: CourseNextAction) => void;
  onOpenMaterials: () => void;
}

/** Course Home renders persisted execution facts; it derives no status from Tutor prose. */
export function CourseHomeView({
  courseName,
  overview,
  loading,
  error,
  busyAction,
  onCreateContract,
  onEditContract,
  onConfirmContract,
  onProposeCurriculum,
  onOpenCurriculum,
  onProposeStudyPlan,
  onEditStudyPlan,
  onAcceptStudyPlan,
  onRejectStudyPlan,
  onLaunchNext,
  onOpenMaterials,
}: CourseHomeViewProps) {
  if (loading && !overview) return <Loading label="加载课程执行状态…" />;
  if (error && !overview) return <Banner kind="error">{error}</Banner>;
  if (!overview) {
    return <Banner kind="empty">课程执行状态暂不可用。现有资料与图谱仍可从探索区访问。</Banner>;
  }

  const contract = overview.activeContract ?? overview.pendingContract;
  const plan = overview.proposedStudyPlan ?? overview.acceptedStudyPlan;
  const feasibility = overview.contractFeasibility;
  const next = overview.nextAction;

  return (
    <div className="stack" aria-label={`${courseName}课程主页`}>
      {error ? <Banner kind="error">{error}</Banner> : null}

      <section className="card" aria-label="课程执行概览">
        <div className="row between">
          <div>
            <h2 style={{ marginBottom: 0 }}>{courseName}</h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              {SETUP_TEXT[overview.setupStage]}
            </p>
          </div>
          <button type="button" className="ghost" onClick={onOpenMaterials}>
            课程资料
          </button>
        </div>

        {next ? (
          <div className="block-preview" aria-label="下一步">
            <strong>下一步：{next.item.reason}</strong>
            <p className="small muted">{next.whyNext}</p>
            <p className="small">
              预计 {next.item.estimatedMinutes} 分钟 · {next.item.launch.capability}
            </p>
            {next.item.launch.status === 'launchable' ? (
              <button
                type="button"
                className="primary"
                disabled={busyAction !== null}
                onClick={() => onLaunchNext(next)}
              >
                {busyAction === 'launch-next' ? '正在重新验证…' : '继续学习'}
              </button>
            ) : (
              <Banner kind="info">
                {next.item.launch.reason ?? '该动作需要重新验证后才能启动。'}
              </Banner>
            )}
          </div>
        ) : overview.setupStage === 'route_active' ? (
          <Banner kind="info">当前没有可启动动作。系统需要重新组合今日安排。</Banner>
        ) : null}
      </section>

      <section className="card" aria-label="学习约定">
        <div className="row between">
          <h3>学习约定</h3>
          {contract ? (
            <span className="pill">
              版本 {contract.version} · {contract.status}
            </span>
          ) : null}
        </div>
        {contract ? (
          <>
            <p>{contract.intent}</p>
            <p className="small">
              目标：{contract.targetOutcome.description} · 深度：{contract.desiredDepth}
            </p>
            <p className="small">
              <span className="pill">学习范围已确认</span>{' '}
              <span className="pill model">不等于事实或评分依据已验证</span>
            </p>
            {feasibility ? (
              <p className="small">
                <strong>{FEASIBILITY_TEXT[feasibility.state]}</strong>
                {feasibility.slackMinutes !== null
                  ? ` · 余量 ${feasibility.slackMinutes} 分钟`
                  : ''}
              </p>
            ) : null}
            <div className="row">
              {overview.capabilities.canEditContract ? (
                <button type="button" disabled={busyAction !== null} onClick={onEditContract}>
                  编辑约定草稿
                </button>
              ) : null}
              {overview.capabilities.canConfirmContract ? (
                <button
                  type="button"
                  className="primary"
                  disabled={busyAction !== null}
                  onClick={onConfirmContract}
                >
                  {busyAction === 'confirm-contract'
                    ? '正在保存…'
                    : contract.status === 'draft'
                      ? '提交约定提案'
                      : '确认学习约定'}
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <button type="button" className="primary" onClick={onCreateContract}>
            建立学习约定
          </button>
        )}
      </section>

      <section className="card" aria-label="课程结构状态">
        <div className="row between">
          <h3>课程结构</h3>
          {overview.acceptedCurriculum || overview.proposedCurriculum ? (
            <button type="button" onClick={onOpenCurriculum}>
              查看完整结构
            </button>
          ) : null}
        </div>
        {overview.acceptedCurriculum || overview.proposedCurriculum ? (
          <p className="small muted">
            当前版本 {(overview.proposedCurriculum ?? overview.acceptedCurriculum)!.version} ·{' '}
            {(overview.proposedCurriculum ?? overview.acceptedCurriculum)!.status}
          </p>
        ) : overview.capabilities.canProposeCurriculum ? (
          <button
            type="button"
            className="primary"
            disabled={busyAction !== null}
            onClick={onProposeCurriculum}
          >
            {busyAction === 'propose-curriculum' ? '正在生成…' : '生成课程结构'}
          </button>
        ) : (
          <p className="small muted">先确认学习约定，再生成课程结构。</p>
        )}
      </section>

      {plan ? (
        <StudyPlanPanel
          plan={plan}
          history={overview.studyPlanHistory}
          canEdit={overview.capabilities.canEditStudyPlan}
          canAccept={overview.capabilities.canAcceptStudyPlan}
          busyAction={busyAction}
          launchByPlanItemId={{}}
          onEdit={onEditStudyPlan}
          onAccept={onAcceptStudyPlan}
          onReject={onRejectStudyPlan}
          onLaunchItem={() => {}}
        />
      ) : (
        <section className="card" aria-label="学习路线">
          <h3>学习路线</h3>
          {overview.capabilities.canProposeStudyPlan ? (
            <button
              type="button"
              className="primary"
              disabled={busyAction !== null}
              onClick={onProposeStudyPlan}
            >
              {busyAction === 'propose-plan' ? '正在规划…' : '生成学习路线'}
            </button>
          ) : (
            <p className="small muted">课程结构通过审阅后可生成学习路线。</p>
          )}
        </section>
      )}

      <section className="card" aria-label="风险与延期">
        <h3>风险与延期</h3>
        <p className="small">
          未解决 {overview.riskSummary.openCount} · 明确延期{' '}
          {overview.riskSummary.explicitDeferralCount}
          {overview.riskSummary.staleCount > 0
            ? ` · 待重新核对 ${overview.riskSummary.staleCount}`
            : ''}
        </p>
        {overview.riskSummary.highlights.map((risk) => (
          <p key={risk.id} className="small">
            <span className={`pill ${risk.severity === 'critical' ? 'wrong' : ''}`}>
              {risk.severity}
            </span>{' '}
            {risk.claim} · <span className="muted">{risk.uncertainty}</span>
          </p>
        ))}
      </section>
    </div>
  );
}
