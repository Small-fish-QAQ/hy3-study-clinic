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
  tier_1_authorized_truth: 'Tier 1 authorized',
  tier_2_validated_representation: 'Tier 2 validated',
  tier_3_advisory: 'Tier 3 advisory',
};

const CONTRACT_SUCCESSOR_TRIGGER_KINDS = new Set([
  'deadline_or_target_change',
  'learner_scope_change',
]);

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
  const [outcomeStatus, setOutcomeStatus] = useState<
    'achieved' | 'finished_with_gaps' | 'expired_unfinished' | 'abandoned'
  >('achieved');
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
  const routeReady = Boolean(
    overview?.activeContract &&
    overview.acceptedCurriculum &&
    overview.acceptedStudyPlan &&
    overview.activeAgenda,
  );
  const outcomeRisks =
    overview?.riskSummary?.highlights.filter(
      (risk) => risk.isCurrent && risk.status !== 'resolved' && risk.status !== 'rejected',
    ) ?? [];

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
    if (!reason || (outcomeStatus === 'finished_with_gaps' && unresolvedRiskIds.length === 0))
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

  if (!workspaceId)
    return <Banner kind="empty">Select a course workspace to inspect formal progress.</Banner>;
  if (loading && !progression) return <Loading label="Loading formal progress..." />;

  return (
    <section className="formal-progress stack" aria-label="Formal learning progress">
      {error ? <Banner kind="error">{error}</Banner> : null}
      {action.error ? <Banner kind="error">{action.error}</Banner> : null}
      <header className="formal-progress-header">
        <div>
          <h2>Formal progress</h2>
          <p className="muted">
            Only locally reconciled, admissible evidence can affect this view. Tutor dialogue is not
            evidence.
          </p>
        </div>
        <div className="row">
          <button type="button" onClick={() => onOpenProgress('history')}>
            Attempts
          </button>
          <button type="button" onClick={() => onOpenProgress('mistakes')}>
            Repairs
          </button>
          <button type="button" onClick={() => onOpenProgress('mastery')}>
            Mastery
          </button>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      <section className="progress-band" aria-label="Evidence admissibility">
        <h3>Evidence and admissibility</h3>
        {(progression?.evidence.length ?? 0) === 0 ? (
          <p className="muted">No formal evidence has been recorded.</p>
        ) : null}
        <div className="progress-table" role="table">
          {(progression?.evidence ?? [])
            .slice(-25)
            .reverse()
            .map((evidence) => (
              <div className="progress-row" role="row" key={evidence.id}>
                <span>{evidence.curriculumLearningUnitId}</span>
                <span>{tierLabel[evidence.admissibilityTier] ?? evidence.admissibilityTier}</span>
                <span>{Math.round(evidence.normalizedScore * 100)}%</span>
                <span>{evidence.stateCreditable ? 'Creditable' : 'Advisory only'}</span>
                <span>
                  {evidence.needsReview
                    ? 'Needs review'
                    : evidence.correct
                      ? 'Correct'
                      : 'Incorrect'}
                </span>
              </div>
            ))}
        </div>
      </section>

      <section className="progress-band" aria-label="Unit completion">
        <h3>Unit completion and repair</h3>
        {unitIds.length === 0 ? (
          <p className="muted">Units will appear after formal evidence is reconciled.</p>
        ) : null}
        <div className="progress-table" role="table">
          {unitIds.map((unitId) => {
            const decision = latestDecisionByUnit.get(unitId);
            return (
              <div className="progress-row" role="row" key={unitId}>
                <strong>{unitId}</strong>
                <span className={`pill progression-state ${decision?.nextState ?? 'not_started'}`}>
                  {decision?.nextState?.replaceAll('_', ' ') ?? 'not started'}
                </span>
                <span>{decision?.kind.replaceAll('_', ' ') ?? 'awaiting reconciliation'}</span>
                <span>{decision?.reasonCodes.join(', ') ?? 'No formal decision yet'}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="progress-band" aria-label="Reconciliation state">
        <h3>Reconciliation</h3>
        {(progression?.reconciliations.length ?? 0) === 0 ? (
          <p className="muted">No grading result is awaiting reconciliation.</p>
        ) : null}
        <div className="progress-table" role="table">
          {(progression?.reconciliations ?? [])
            .slice(-25)
            .reverse()
            .map((item) => (
              <div className="progress-row" role="row" key={item.id}>
                <span>{item.curriculumLearningUnitId}</span>
                <span className={`pill reconciliation ${item.status}`}>
                  {item.status.replaceAll('_', ' ')}
                </span>
                <span>{item.reason ?? 'Local reconciliation pending'}</span>
                <span>{item.decisionId ?? 'No decision'}</span>
                {item.status === 'reconciliation_pending' &&
                overview?.acceptedStudyPlan?.id === item.studyPlanVersionId ? (
                  <button
                    type="button"
                    disabled={action.loading}
                    onClick={() => void retryReconciliation(item.gradingResultId)}
                  >
                    Retry reconciliation
                  </button>
                ) : null}
              </div>
            ))}
        </div>
      </section>

      <section className="progress-band" aria-label="Qualified replans">
        <h3>Replan changes</h3>
        {(progression?.replanTriggers.length ?? 0) === 0 ? (
          <p className="muted">No qualified replan trigger is active.</p>
        ) : null}
        {(progression?.replanTriggers ?? [])
          .slice(-12)
          .reverse()
          .map((trigger) => (
            <article className="replan-record" key={trigger.id}>
              <div className="row between">
                <strong>{trigger.kind.replaceAll('_', ' ')}</strong>
                <span className="pill">{trigger.status.replaceAll('_', ' ')}</span>
              </div>
              <p>{trigger.reason}</p>
              <p className="small muted">
                Affected units: {trigger.facts.affectedLearningUnitIds.join(', ') || 'none'} |
                occurrences: {trigger.facts.qualifyingOccurrences}
              </p>
              {trigger.status === 'qualified' &&
              CONTRACT_SUCCESSOR_TRIGGER_KINDS.has(trigger.kind) ? (
                <Banner kind="info">
                  Update and learner-confirm a successor Learning Contract from Course Home before
                  proposing its StudyPlan.
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
                  Create route proposal
                </button>
              ) : null}
            </article>
          ))}
        {overview?.proposedStudyPlan ? (
          <div className="replan-decision">
            <h4>Proposed route diff</h4>
            {overview.proposedStudyPlan.diff.length === 0 ? (
              <p className="muted">The proposed route has no recorded item diff.</p>
            ) : (
              <StudyPlanDiffList changes={overview.proposedStudyPlan.diff} />
            )}
            <div className="row">
              <button type="button" className="primary" onClick={onAcceptProposedPlan}>
                Accept route
              </button>
              <button type="button" onClick={onRejectProposedPlan}>
                Reject route
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="progress-band" aria-label="Goal outcome">
        <h3>Goal outcome</h3>
        {(progression?.goalOutcomes ?? [])
          .slice(-5)
          .reverse()
          .map((outcome) => (
            <article className="goal-outcome" key={outcome.id}>
              <strong>{outcome.status.replaceAll('_', ' ')}</strong>
              <p>{outcome.reason}</p>
              <p className="small muted">
                Formal evidence: {outcome.formalEvidenceIds.length}; unresolved risks:{' '}
                {outcome.unresolvedRiskIds.length}
              </p>
            </article>
          ))}
        {!routeReady ? (
          <Banner kind="info">
            An active accepted route is required to record a goal outcome.
          </Banner>
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
              Status
              <select
                value={outcomeStatus}
                onChange={(event) => setOutcomeStatus(event.target.value as typeof outcomeStatus)}
              >
                <option value="achieved">Achieved</option>
                <option value="finished_with_gaps">Finished with gaps</option>
                <option value="expired_unfinished">Expired unfinished</option>
                <option value="abandoned">Abandoned</option>
              </select>
            </label>
            <label>
              Reason
              <textarea
                required
                value={outcomeReason}
                onChange={(event) => setOutcomeReason(event.target.value)}
                rows={3}
              />
            </label>
            {outcomeStatus === 'finished_with_gaps' ? (
              <fieldset className="goal-outcome-risks">
                <legend>Unresolved risks</legend>
                {outcomeRisks.length === 0 ? (
                  <Banner kind="info">
                    No current named risk is available. Record or defer a specific gap before
                    finishing with gaps.
                  </Banner>
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
              disabled={action.loading || outcomeReason.trim().length === 0}
            >
              Record outcome
            </button>
          </form>
        ) : null}
      </section>
    </section>
  );
}
