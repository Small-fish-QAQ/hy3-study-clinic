import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CourseExecutionCommandEnvelope,
  CourseExecutionOverview,
  FormalProgressionOverview,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import { StudyPlanDiffList } from './StudyPlanDiffList.js';

export interface FormalProgressViewProps {
  workspaceId: string | null;
  overview: CourseExecutionOverview | null;
  command: (prefix: string) => CourseExecutionCommandEnvelope;
  onAcceptProposedPlan: () => void;
  onRejectProposedPlan: () => void;
  onCourseChanged: () => void;
  onOpenProgress: (view: 'history' | 'mistakes' | 'mastery') => void;
}

const tierLabel: Record<string, string> = {
  tier_1_authorized_truth: '已验证课程依据',
  tier_2_validated_representation: '已验证的表示方式',
  tier_3_advisory: '仅供参考',
};

const CONTRACT_SUCCESSOR_TRIGGER_KINDS = new Set([
  'deadline_or_target_change',
  'learner_scope_change',
]);

type GoalOutcomeStatus = 'achieved' | 'finished_with_gaps' | 'expired_unfinished' | 'abandoned';

/** Formal evidence and local reconciliation, intentionally separate from Tutor prose. */
export function FormalProgressView({
  workspaceId,
  overview,
  command,
  onAcceptProposedPlan,
  onRejectProposedPlan,
  onCourseChanged,
  onOpenProgress,
}: FormalProgressViewProps) {
  const [progression, setProgression] = useState<FormalProgressionOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomeStatus, setOutcomeStatus] = useState<GoalOutcomeStatus | ''>('');
  const [outcomeReason, setOutcomeReason] = useState('');
  const [selectedRiskIds, setSelectedRiskIds] = useState<string[]>([]);
  const epoch = useRef(0);
  const action = useAsyncAction();

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!workspaceId) return;
      const requestEpoch = ++epoch.current;
      setLoading(true);
      setError(null);
      try {
        const response = await api.formalProgression(workspaceId, signal);
        if (!signal?.aborted && requestEpoch === epoch.current) setProgression(response);
      } catch (cause) {
        if (!signal?.aborted && requestEpoch === epoch.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!signal?.aborted && requestEpoch === epoch.current) setLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setProgression(null);
    setOutcomeStatus('');
    setOutcomeReason('');
    setSelectedRiskIds([]);
    void refresh(controller.signal);
    return () => {
      controller.abort();
      epoch.current += 1;
    };
  }, [refresh]);

  const latestDecisionByUnit = useMemo(() => {
    const map = new Map<string, FormalProgressionOverview['decisions'][number]>();
    for (const decision of progression?.decisions ?? [])
      map.set(decision.curriculumLearningUnitId, decision);
    return map;
  }, [progression]);
  const unitIds = useMemo(
    () => [
      ...new Set([
        ...(progression?.evidence.map((record) => record.curriculumLearningUnitId) ?? []),
        ...latestDecisionByUnit.keys(),
      ]),
    ],
    [latestDecisionByUnit, progression],
  );
  const unitTitleById = useMemo(() => {
    const hierarchy = overview?.activeCurriculumHierarchy ?? overview?.curriculumHierarchy;
    return new Map(
      (hierarchy?.nodes ?? [])
        .filter((node) => node.kind === 'learning_unit')
        .map((node) => [node.id, node.title]),
    );
  }, [overview]);
  const routeReady = Boolean(
    overview?.activeContract &&
    overview.acceptedCurriculum &&
    overview.acceptedStudyPlan &&
    overview.activeAgenda,
  );
  const blockingAgendaItems =
    overview?.activeAgenda?.items.filter(
      (item) =>
        item.linkedPlanItemId !== null &&
        ['queued', 'active', 'deferred', 'blocked'].includes(item.state),
    ) ?? [];
  const hasCurrentOutcomeBlockers =
    blockingAgendaItems.length > 0 ||
    (overview?.formalProgress?.repairNeededPlanItemCount ?? 0) > 0 ||
    (overview?.formalProgress?.deferredPlanItemCount ?? 0) > 0;
  const deferredUnitIds = new Set(
    blockingAgendaItems
      .filter((item) => item.state === 'deferred')
      .map((item) => item.learningUnitId)
      .filter((unitId): unitId is string => unitId !== null),
  );
  const repairUnitIds = new Set(
    blockingAgendaItems
      .filter((item) => item.state === 'blocked')
      .map((item) => item.learningUnitId)
      .filter((unitId): unitId is string => unitId !== null),
  );
  const planDeferralRiskIds = new Set(
    overview?.acceptedStudyPlan?.deferrals?.flatMap((deferral) => deferral.riskIds) ?? [],
  );
  const matchesCurrentOutcomeGap = (
    risk: NonNullable<CourseExecutionOverview['riskSummary']>['highlights'][number],
  ): boolean => {
    if (planDeferralRiskIds.has(risk.id)) return true;
    if (risk.curriculumNodeId === null) return false;
    if (
      deferredUnitIds.has(risk.curriculumNodeId) &&
      risk.facets.includes('intentionally_deferred')
    ) {
      return true;
    }
    return (
      repairUnitIds.has(risk.curriculumNodeId) &&
      (risk.facets.includes('formally_assessed') ||
        risk.facets.includes('prerequisite_risk') ||
        risk.facets.includes('transfer_integration_risk'))
    );
  };
  const outcomeRisks =
    overview?.riskSummary?.highlights.filter(
      (risk) =>
        risk.isCurrent &&
        risk.status !== 'resolved' &&
        risk.status !== 'rejected' &&
        risk.status !== 'stale' &&
        matchesCurrentOutcomeGap(risk),
    ) ?? [];

  useEffect(() => {
    if (outcomeStatus === 'achieved' && hasCurrentOutcomeBlockers) setOutcomeStatus('');
  }, [hasCurrentOutcomeBlockers, outcomeStatus]);

  async function recordOutcome(): Promise<void> {
    if (
      !workspaceId ||
      !overview?.activeContract ||
      !overview.acceptedCurriculum ||
      !overview.acceptedStudyPlan ||
      !overview.activeAgenda
    )
      return;
    const reason = outcomeReason.trim();
    const unresolvedRiskIds = selectedRiskIds;
    if (
      !outcomeStatus ||
      !reason ||
      (outcomeStatus === 'finished_with_gaps' && unresolvedRiskIds.length === 0)
    )
      return;
    const result = await action.run((signal) =>
      api.recordGoalOutcome(
        workspaceId,
        {
          command: command('record_goal_outcome'),
          expectedCourseExecutionVersion: overview.courseExecutionVersion,
          expectedContractVersionId: overview.activeContract!.id,
          expectedCurriculumVersionId: overview.acceptedCurriculum!.id,
          expectedStudyPlanVersionId: overview.acceptedStudyPlan!.id,
          expectedAgendaVersionId: overview.activeAgenda!.id,
          status: outcomeStatus,
          unresolvedRiskIds,
          reason,
        },
        signal,
      ),
    );
    if (!result) return;
    setOutcomeReason('');
    setSelectedRiskIds([]);
    await refresh();
    onCourseChanged();
  }

  async function createReplanProposal(triggerId: string): Promise<void> {
    if (!workspaceId || !overview?.acceptedStudyPlan) return;
    const result = await action.run((signal) =>
      api.proposeQualifiedReplan(
        workspaceId,
        triggerId,
        {
          command: command('propose_qualified_replan'),
          triggerId,
          expectedAcceptedStudyPlanId: overview.acceptedStudyPlan!.id,
        },
        signal,
      ),
    );
    if (!result) return;
    await refresh();
    onCourseChanged();
  }

  async function retryReconciliation(gradingResultId: string): Promise<void> {
    if (!workspaceId || !overview?.acceptedStudyPlan) return;
    const result = await action.run((signal) =>
      api.reconcileProgression(
        workspaceId,
        {
          command: command('retry_progression_reconciliation'),
          gradingResultId,
          expectedStudyPlanId: overview.acceptedStudyPlan!.id,
          expectedExecutionSourceManifestFingerprint:
            overview.acceptedStudyPlan!.executionSourceManifestFingerprint,
        },
        signal,
      ),
    );
    if (!result) return;
    await refresh();
    onCourseChanged();
  }

  if (!workspaceId) return <Banner kind="empty">请先选择课程，再查看正式进展。</Banner>;
  if (loading && !progression) return <Loading label="加载正式进展…" />;

  return (
    <section className="formal-progress stack" aria-label="正式学习进展">
      {error ? <Banner kind="error">{error}</Banner> : null}
      {action.error ? <Banner kind="error">{action.error}</Banner> : null}
      <header className="formal-progress-header">
        <div>
          <h2>正式进展</h2>
          <p className="muted">
            只有经过本地核对并符合规则的证据，才能影响正式进展。Tutor 对话不是正式证据。
          </p>
        </div>
        <div className="row">
          <button type="button" onClick={() => onOpenProgress('history')}>
            测验记录
          </button>
          <button type="button" onClick={() => onOpenProgress('mistakes')}>
            错题与修复
          </button>
          <button type="button" onClick={() => onOpenProgress('mastery')}>
            掌握与复习
          </button>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            刷新
          </button>
        </div>
      </header>

      <section className="progress-band" aria-label="正式证据与可计入状态">
        <h3>正式证据与可计入状态</h3>
        {(progression?.evidence.length ?? 0) === 0 ? (
          <p className="muted">还没有正式证据，这是尚未完成正式评估时的正常状态。</p>
        ) : null}
        <div className="progress-table" role="table" aria-label="正式证据记录">
          <div className="progress-row progress-head" role="row">
            <span role="columnheader">学习单元</span>
            <span role="columnheader">证据级别</span>
            <span role="columnheader">结果</span>
            <span role="columnheader">状态效力</span>
            <span role="columnheader">核对状态</span>
          </div>
          {(progression?.evidence ?? [])
            .slice(-25)
            .reverse()
            .map((evidence) => (
              <div className="progress-row" role="row" key={evidence.id}>
                <span className="progress-unit-name" role="cell">
                  <strong>
                    {unitTitleById.get(evidence.curriculumLearningUnitId) ?? '学习单元'}
                  </strong>
                  <span className="small muted">{evidence.curriculumLearningUnitId}</span>
                </span>
                <span role="cell">{tierLabel[evidence.admissibilityTier] ?? '证据级别已记录'}</span>
                <span role="cell">{Math.round(evidence.normalizedScore * 100)}%</span>
                <span role="cell">{evidence.stateCreditable ? '可计入正式进展' : '仅供参考'}</span>
                <span role="cell">
                  {evidence.needsReview ? '需要复核' : evidence.correct ? '通过' : '未通过'}
                </span>
              </div>
            ))}
        </div>
      </section>

      <section className="progress-band" aria-label="学习单元完成与修复">
        <h3>学习单元完成与修复</h3>
        {unitIds.length === 0 ? (
          <p className="muted">正式证据核对后，学习单元状态会显示在这里。</p>
        ) : null}
        <div className="progress-table" role="table" aria-label="学习单元进展决定">
          <div className="progress-row progress-head progress-row-four" role="row">
            <span role="columnheader">学习单元</span>
            <span role="columnheader">当前状态</span>
            <span role="columnheader">决定</span>
            <span role="columnheader">本地核对理由</span>
          </div>
          {unitIds.map((unitId) => {
            const decision = latestDecisionByUnit.get(unitId);
            return (
              <div className="progress-row progress-row-four" role="row" key={unitId}>
                <span className="progress-unit-name" role="cell">
                  <strong>{unitTitleById.get(unitId) ?? '学习单元'}</strong>
                  <span className="small muted">{unitId}</span>
                </span>
                <span role="cell">
                  <span
                    className={`pill progression-state ${decision?.nextState ?? 'not_started'}`}
                  >
                    {decision?.nextState ? progressionStateLabel(decision.nextState) : '未开始'}
                  </span>
                </span>
                <span role="cell">
                  {decision?.kind ? progressionKindLabel(decision.kind) : '等待核对'}
                </span>
                <span role="cell">
                  {decision?.reasonCodes.map(progressionReasonLabel).join('、') ?? '还没有正式决定'}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="progress-band" aria-label="正式结果核对">
        <h3>正式结果核对</h3>
        {(progression?.reconciliations.length ?? 0) === 0 ? (
          <p className="muted">没有等待核对的判分结果。</p>
        ) : null}
        <div className="progress-table" role="table" aria-label="判分与进展核对记录">
          <div className="progress-row progress-head" role="row">
            <span role="columnheader">学习单元</span>
            <span role="columnheader">核对状态</span>
            <span role="columnheader">说明</span>
            <span role="columnheader">进展决定</span>
            <span role="columnheader">操作</span>
          </div>
          {(progression?.reconciliations ?? [])
            .slice(-25)
            .reverse()
            .map((item) => (
              <div className="progress-row" role="row" key={item.id}>
                <span className="progress-unit-name" role="cell">
                  <strong>{unitTitleById.get(item.curriculumLearningUnitId) ?? '学习单元'}</strong>
                  <span className="small muted">{item.curriculumLearningUnitId}</span>
                </span>
                <span role="cell">
                  <span className={`pill reconciliation ${item.status}`}>
                    {reconciliationLabel(item.status)}
                  </span>
                </span>
                <span role="cell">{item.reason ?? '等待本地核对'}</span>
                <span role="cell">{item.decisionId ?? '尚无决定'}</span>
                <span role="cell">
                  {item.status === 'reconciliation_pending' &&
                  overview?.acceptedStudyPlan?.id === item.studyPlanVersionId ? (
                    <button
                      type="button"
                      disabled={action.loading}
                      onClick={() => void retryReconciliation(item.gradingResultId)}
                    >
                      重新核对
                    </button>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            ))}
        </div>
      </section>

      <section className="progress-band" aria-label="学习路线调整">
        <h3>学习路线调整</h3>
        {(progression?.replanTriggers.length ?? 0) === 0 ? (
          <p className="muted">当前没有需要调整学习路线的条件。</p>
        ) : null}
        {(progression?.replanTriggers ?? [])
          .slice(-12)
          .reverse()
          .map((trigger) => (
            <article className="replan-record" key={trigger.id}>
              <div className="row between">
                <strong>{replanKindLabel(trigger.kind)}</strong>
                <span className="pill">{replanStatusLabel(trigger.status)}</span>
              </div>
              <p>{trigger.reason}</p>
              <p className="small muted">
                受影响单元：{trigger.facts.affectedLearningUnitIds.join('、') || '无'} · 达标次数：
                {trigger.facts.qualifyingOccurrences}
              </p>
              {trigger.status === 'qualified' &&
              CONTRACT_SUCCESSOR_TRIGGER_KINDS.has(trigger.kind) ? (
                <Banner kind="info">
                  请先回到课程主页更新并确认新的学习目标，再提出后续路线。
                </Banner>
              ) : null}
              {trigger.status === 'qualified' &&
              !CONTRACT_SUCCESSOR_TRIGGER_KINDS.has(trigger.kind) &&
              overview?.acceptedStudyPlan &&
              !overview.proposedStudyPlan ? (
                <button
                  type="button"
                  disabled={action.loading}
                  onClick={() => void createReplanProposal(trigger.id)}
                >
                  提出路线调整
                </button>
              ) : null}
            </article>
          ))}
        {overview?.proposedStudyPlan ? (
          <div className="replan-decision">
            <h4>待确认的路线变化</h4>
            {overview.proposedStudyPlan.diff.length === 0 ? (
              <p className="muted">这份路线没有记录项目变化。</p>
            ) : (
              <StudyPlanDiffList changes={overview.proposedStudyPlan.diff} />
            )}
            <div className="row">
              <button type="button" className="primary" onClick={onAcceptProposedPlan}>
                接受路线调整
              </button>
              <button type="button" onClick={onRejectProposedPlan}>
                拒绝路线调整
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="progress-band" aria-label="学习目标结果">
        <h3>学习目标结果</h3>
        {(progression?.goalOutcomes ?? [])
          .slice(-5)
          .reverse()
          .map((outcome) => (
            <article className="goal-outcome" key={outcome.id}>
              <strong>{goalOutcomeLabel(outcome.status)}</strong>
              <p>{outcome.reason}</p>
              <p className="small muted">
                正式证据：{outcome.formalEvidenceIds.length} · 未解决风险：
                {outcome.unresolvedRiskIds.length}
              </p>
            </article>
          ))}
        {!routeReady ? (
          <Banner kind="info">需要先有正在执行的已接受路线，才能记录学习目标结果。</Banner>
        ) : null}
        {routeReady ? (
          <form
            className="goal-outcome-form"
            onSubmit={(event) => {
              event.preventDefault();
              void recordOutcome();
            }}
          >
            <label>
              结果
              <select
                required
                value={outcomeStatus}
                onChange={(event) => setOutcomeStatus(event.target.value as typeof outcomeStatus)}
              >
                <option value="" disabled>
                  请选择结果
                </option>
                <option value="achieved" disabled={hasCurrentOutcomeBlockers}>
                  已达成
                </option>
                <option value="finished_with_gaps">完成但保留缺口</option>
                <option value="expired_unfinished">到期未完成</option>
                <option value="abandoned">主动停止</option>
              </select>
            </label>
            <label>
              说明
              <textarea
                required
                value={outcomeReason}
                onChange={(event) => setOutcomeReason(event.target.value)}
                rows={3}
              />
            </label>
            {outcomeStatus === 'finished_with_gaps' ? (
              <fieldset className="goal-outcome-risks">
                <legend>未解决风险</legend>
                {outcomeRisks.length === 0 ? (
                  <Banner kind="info">当前没有可选的具体风险。请先记录或延期一个明确缺口。</Banner>
                ) : null}
                {outcomeRisks.map((risk) => (
                  <label key={risk.id}>
                    <input
                      type="checkbox"
                      checked={selectedRiskIds.includes(risk.id)}
                      onChange={(event) =>
                        setSelectedRiskIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, risk.id])]
                            : current.filter((id) => id !== risk.id),
                        )
                      }
                    />
                    <span>
                      {risk.claim} <span className="muted">({risk.severity})</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <button
              type="submit"
              className="primary"
              disabled={action.loading || !outcomeStatus || outcomeReason.trim().length === 0}
            >
              记录学习目标结果
            </button>
          </form>
        ) : null}
      </section>
    </section>
  );
}

function progressionStateLabel(value: string): string {
  const labels: Record<string, string> = {
    not_started: '未开始',
    in_progress: '学习中',
    complete: '已完成',
    completed: '已完成',
    repair_needed: '需要修复',
    deferred: '已延期',
    blocked: '暂时受阻',
  };
  return labels[value] ?? value;
}

function progressionKindLabel(value: string): string {
  const labels: Record<string, string> = {
    complete: '完成决定',
    continue: '继续学习',
    targeted_repair: '定向修复',
    deferred: '延期',
    replan_candidate: '建议调整路线',
  };
  return labels[value] ?? '正式进展已更新';
}

function progressionReasonLabel(value: string): string {
  const labels: Record<string, string> = {
    prior_completion_preserved: '保留既有完成状态',
    synthesis_transfer_gap: '综合迁移仍有缺口',
    eligible_evidence_satisfied: '正式证据已满足要求',
    sufficient_admissible_evidence: '可采纳的正式证据已满足要求',
    eligible_evidence_below_policy: '正式结果尚未达到要求',
    synthesis_required: '仍需完成综合评估',
    blocking_objective_evidence_missing: '关键目标缺少正式证据',
    insufficient_eligible_evidence: '正式证据仍不足',
  };
  return labels[value] ?? '请查看正式证据详情';
}

function goalOutcomeLabel(value: string): string {
  const labels: Record<string, string> = {
    achieved: '目标已达成',
    finished_with_gaps: '已结束，但仍有缺口',
    expired_unfinished: '到期未完成',
    abandoned: '已终止',
  };
  return labels[value] ?? '结果已记录';
}

function reconciliationLabel(value: string): string {
  const labels: Record<string, string> = {
    reconciliation_pending: '等待核对',
    applied: '已计入进展',
    reconciled: '已核对',
    stale: '状态已过期',
    rejected: '已拒绝',
  };
  return labels[value] ?? value;
}

function replanKindLabel(value: string): string {
  const labels: Record<string, string> = {
    deadline_or_target_change: '目标或截止时间变化',
    sustained_study_time_change: '可用学习时间持续变化',
    persistent_pace_risk: '持续进度风险',
    learner_scope_change: '学习范围变化',
    repeated_formal_evidence: '多次正式结果提示需要调整',
    synthesis_failure: '综合练习暴露缺口',
    strong_prerequisite_failure: '先修内容仍未通过',
    source_manifest_change: '课程资料需要重新核对',
    promoted_detour: '临时探索已纳入学习路线',
  };
  return labels[value] ?? '路线调整条件';
}

function replanStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    candidate: '等待条件核对',
    qualified: '已满足条件',
    dismissed: '无需调整',
    proposal_created: '待确认',
    resolved: '已处理',
  };
  return labels[value] ?? '已记录';
}
