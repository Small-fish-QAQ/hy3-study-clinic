import type {
  AgendaLaunchCapability,
  StudyPlan,
  StudyPlanDraftEdit,
  StudyPlanHistoryItem,
} from '@hy3-clinic/shared';
import { Banner } from '../components/ui.js';
import { StudyPlanDiffList } from './StudyPlanDiffList.js';

const KIND_TEXT: Record<StudyPlan['items'][number]['kind'], string> = {
  teach_unit: '学习单元',
  informal_check: '非正式检查',
  formal_checkpoint: '正式检查点',
  synthesis: '综合检验',
  targeted_repair: '针对性修复',
  due_review: '到期复习',
  adversarial_readiness: '挑战性准备检查',
};

const PLAN_STATUS_TEXT: Record<string, string> = {
  candidate: '候选路线',
  proposed: '待确认',
  accepted: '已接受',
  rejected: '已拒绝',
  superseded: '已由新路线替代',
  closed: '已结束',
};

const FEASIBILITY_TEXT: Record<string, string> = {
  feasible: '时间可行',
  at_risk: '时间存在风险',
  infeasible: '时间不足',
  unknown: '等待估算',
};

const DEPTH_TEXT: Record<string, string> = {
  pass_oriented: '通过评估',
  working_fluency: '熟练运用',
  high_performance: '高水平表现',
  deep_transfer: '深入迁移',
};

const ADMISSIBILITY_TEXT: Record<string, string> = {
  tier_1_authorized_truth: '已验证课程依据',
  tier_2_validated_representation: '已验证的表示方式',
  tier_3_advisory: '仅供学习参考',
};

export interface StudyPlanPanelProps {
  plan: StudyPlan;
  history: StudyPlanHistoryItem[];
  canEdit: boolean;
  canAccept: boolean;
  busyAction: string | null;
  launchByPlanItemId: Record<string, AgendaLaunchCapability>;
  onEdit: (edit: StudyPlanDraftEdit) => void;
  onAccept: () => void;
  onReject: () => void;
  onLaunchItem: (planItemId: string) => void;
}

/** Full StudyPlan inspector. Accepted snapshots are never edited in place. */
export function StudyPlanPanel({
  plan,
  history,
  canEdit,
  canAccept,
  busyAction,
  launchByPlanItemId,
  onEdit,
  onAccept,
  onReject,
  onLaunchItem,
}: StudyPlanPanelProps) {
  return (
    <section className="card" aria-label="学习路线">
      <div className="row between">
        <div>
          <h3 style={{ marginBottom: 0 }}>学习路线</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            版本 {plan.version} · {PLAN_STATUS_TEXT[plan.status] ?? '已记录'} ·{' '}
            {plan.feasibility.projectedMinutes} 分钟
          </p>
        </div>
        <span className={`pill ${plan.feasibility.state === 'infeasible' ? 'wrong' : ''}`}>
          {FEASIBILITY_TEXT[plan.feasibility.state] ?? '等待估算'}
        </span>
      </div>

      <p>{plan.rationale}</p>
      {plan.feasibility.assumptions.length > 0 ? (
        <details className="small">
          <summary>时间估算依据</summary>
          <ul>
            {plan.feasibility.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <ol className="plan-steps">
        {plan.items.map((item, index) => {
          const launch = launchByPlanItemId[item.id];
          return (
            <li key={item.id} className="block-preview">
              <div className="row between">
                <strong>
                  {item.phase} · {KIND_TEXT[item.kind]}
                </strong>
                <span className="small muted">{item.estimatedMinutes} 分钟</span>
              </div>
              <p className="small">{item.rationale}</p>
              <p className="small muted">
                深度 {DEPTH_TEXT[item.targetDepth] ?? '已设置'} · 目标 {item.objectiveIds.length} 项
              </p>
              {item.completionRequirements.map((requirement) => (
                <p key={requirement.id} className="small">
                  <span className={requirement.blocking ? 'pill deterministic' : 'pill'}>
                    {requirement.blocking ? '正式完成条件' : '非阻断检查'}
                  </span>{' '}
                  {requirement.description} ·{' '}
                  {ADMISSIBILITY_TEXT[requirement.admissibilityTier] ?? '证据规则已记录'}
                </p>
              ))}

              {canEdit ? (
                <div className="row">
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busyAction !== null || index === 0}
                    onClick={() =>
                      onEdit({
                        kind: 'reorder',
                        planItemId: item.id,
                        afterPlanItemId: index > 1 ? plan.items[index - 2]!.id : null,
                      })
                    }
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busyAction !== null || index === plan.items.length - 1}
                    onClick={() =>
                      onEdit({
                        kind: 'reorder',
                        planItemId: item.id,
                        afterPlanItemId: plan.items[index + 1]!.id,
                      })
                    }
                  >
                    下移
                  </button>
                </div>
              ) : null}

              {launch?.status === 'launchable' ? (
                <button
                  type="button"
                  className="primary small"
                  disabled={busyAction !== null}
                  onClick={() => onLaunchItem(item.id)}
                >
                  {busyAction === `launch:${item.id}` ? '正在重新验证…' : '开始'}
                </button>
              ) : launch ? (
                <Banner kind="info">{launch.reason ?? '该路线动作当前不可启动。'}</Banner>
              ) : null}
            </li>
          );
        })}
      </ol>

      {plan.deferrals.length > 0 ? (
        <div aria-label="明确延期">
          <h4>明确延期</h4>
          {plan.deferrals.map((deferral) => (
            <p key={deferral.curriculumLearningUnitId} className="small">
              <span className="pill wrong">仍是学习缺口</span> {deferral.reason} · 风险{' '}
              {deferral.riskIds.join('、')}
            </p>
          ))}
        </div>
      ) : null}

      {plan.diff.length > 0 ? (
        <details className="small">
          <summary>与前一版本的差异（{plan.diff.length}）</summary>
          <StudyPlanDiffList changes={plan.diff} />
        </details>
      ) : null}

      {plan.status === 'proposed' ? (
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={!canAccept || busyAction !== null}
            onClick={onAccept}
          >
            {busyAction === 'accept-plan' ? '正在安装路线…' : '接受并启用路线'}
          </button>
          <button type="button" disabled={busyAction !== null} onClick={onReject}>
            拒绝提案
          </button>
        </div>
      ) : null}

      {history.length > 0 ? (
        <details className="small">
          <summary>路线历史（{history.length}）</summary>
          <ol>
            {history.map((item) => (
              <li key={item.id}>
                版本 {item.version} · {PLAN_STATUS_TEXT[item.status] ?? '已记录'} ·{' '}
                {item.projectedMinutes} 分钟 · {item.proposalTrigger}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
