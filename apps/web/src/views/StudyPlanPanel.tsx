import { useState } from 'react';
import type {
  AgendaLaunchCapability,
  DesiredDepth,
  StudyPlan,
  StudyPlanDraftEdit,
  StudyPlanHistoryItem,
  StudyPlanItemPlannability,
} from '@hy3-clinic/shared';
import { Banner } from '../components/ui.js';
import { StudyPlanDiffList } from './StudyPlanDiffList.js';
import { learnerPlanText } from './learnerLanguage.js';

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
  candidate: '待审核路线',
  proposed: '等待你确认',
  accepted: '当前路线',
  rejected: '已拒绝',
  superseded: '已被新路线替代',
  closed: '已结束',
};

const FEASIBILITY_TEXT: Record<string, string> = {
  feasible: '时间可行',
  at_risk: '时间存在风险',
  infeasible: '时间不足',
  unknown: '等待估算',
};

const RECOMMENDATION_TEXT: Record<string, string> = {
  keep_full_scope: '保留完整范围，接受日期风险',
  increase_study_effort: '增加预计投入或学习频率',
  reduce_teaching_depth: '减少讲解与练习深度，但保留核心范围',
  defer_optional_content: '仅延期可选/补充内容',
  narrow_learner_scope: '由你明确缩小学习范围',
  change_deadline: '调整目标日期',
};

const DEPTH_TEXT: Record<string, string> = {
  pass_oriented: '通过评估',
  working_fluency: '熟练运用',
  high_performance: '高水平表现',
  deep_transfer: '深入迁移',
};

const DEPTH_ORDER: DesiredDepth[] = [
  'pass_oriented',
  'working_fluency',
  'high_performance',
  'deep_transfer',
];

/**
 * Why an item cannot yet be taught. Wording is selected by planning code: a segment
 * ceiling is never described as a duration problem, because more minutes cannot fix it.
 */
const PLANNABILITY_TEXT: Record<StudyPlanItemPlannability['planningCode'], string> = {
  lesson_slot_limit_exceeded:
    '该单元在当前深度下需要的讲解环节超过单节课上限。增加时长无法解决环节数量上限。',
  practice_slot_limit_exceeded: '该单元需要的练习环节超过单节课上限。',
  protected_budget_exceeds_agenda: '该单元在当前深度下需要的讲解放不进当前时长。',
  planned_budget_exceeds_agenda: '该单元在当前深度下需要的讲解放不进当前时长。',
  agenda_budget_underfilled: '当前时长超过该单元在这个深度下可以如实支撑的讲解量。',
};

/** Only remedies the server judged semantically valid for that code are offered. */
const REMEDY_TEXT: Record<StudyPlanItemPlannability['remedies'][number], string> = {
  reduce_depth: '降低该单元的深度',
  raise_depth: '提高该单元的深度',
  increase_minutes: '增加该单元的时长',
  reduce_minutes: '减少该单元的时长',
  revise_plan_structure: '调整提案中该单元的范围或结构',
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
  showAcceptAction?: boolean;
  busyAction: string | null;
  launchByPlanItemId: Record<string, AgendaLaunchCapability>;
  /** Server-computed Lesson plannability for teaching items. Feasible items are absent. */
  plannability?: StudyPlanItemPlannability[];
  onEdit: (edit: StudyPlanDraftEdit) => void;
  onAccept: () => void;
  onReject: () => void;
  onLaunchItem: (planItemId: string) => void;
}

/**
 * Learner-driven depth and duration repair for one proposed teaching item. Both send
 * the existing `edit_plan` command, which creates a new proposed version; neither
 * changes anything by itself, and depth is never adjusted automatically.
 */
function TeachingItemRepairControls({
  item,
  disabled,
  onEdit,
}: {
  item: StudyPlan['items'][number];
  disabled: boolean;
  onEdit: (edit: StudyPlanDraftEdit) => void;
}) {
  const [minutes, setMinutes] = useState(String(item.estimatedMinutes));
  const parsedMinutes = Number(minutes);
  const minutesValid =
    /^\d+$/u.test(minutes.trim()) && Number.isInteger(parsedMinutes) && parsedMinutes > 0;
  const minutesChanged = minutesValid && parsedMinutes !== item.estimatedMinutes;
  const depthLabelId = `depth-${item.id}`;
  const minutesLabelId = `minutes-${item.id}`;
  return (
    <div className="row" role="group" aria-label="调整该单元的深度或时长">
      <label className="small" htmlFor={depthLabelId}>
        深度
      </label>
      <select
        id={depthLabelId}
        className="small"
        value={item.targetDepth}
        disabled={disabled}
        onChange={(event) => {
          const targetDepth = event.target.value as DesiredDepth;
          if (targetDepth === item.targetDepth) return;
          onEdit({
            kind: 'change_depth',
            planItemId: item.id,
            targetDepth,
            reason: `学习者将该单元深度由 ${DEPTH_TEXT[item.targetDepth] ?? item.targetDepth} 调整为 ${
              DEPTH_TEXT[targetDepth] ?? targetDepth
            }。`,
          });
        }}
      >
        {DEPTH_ORDER.map((depth) => (
          <option key={depth} value={depth}>
            {DEPTH_TEXT[depth] ?? depth}
          </option>
        ))}
      </select>
      <label className="small" htmlFor={minutesLabelId}>
        时长（分钟）
      </label>
      <input
        id={minutesLabelId}
        className="small"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={minutes}
        disabled={disabled}
        aria-invalid={minutes.trim() === '' ? undefined : !minutesValid}
        onChange={(event) => setMinutes(event.target.value)}
      />
      <button
        type="button"
        className="ghost small"
        disabled={disabled || !minutesChanged}
        onClick={() =>
          onEdit({
            kind: 'resize_time',
            planItemId: item.id,
            estimatedMinutes: parsedMinutes,
            reason: `学习者将该单元时长由 ${item.estimatedMinutes} 分钟调整为 ${parsedMinutes} 分钟。`,
          })
        }
      >
        应用时长
      </button>
      {!minutesValid && minutes.trim() !== '' ? (
        <span className="small wrong">时长需要是正整数分钟。</span>
      ) : null}
    </div>
  );
}

/** Full StudyPlan inspector. Accepted snapshots are never edited in place. */
export function StudyPlanPanel({
  plan,
  history,
  canEdit,
  canAccept,
  showAcceptAction = true,
  busyAction,
  launchByPlanItemId,
  plannability = [],
  onEdit,
  onAccept,
  onReject,
  onLaunchItem,
}: StudyPlanPanelProps) {
  const plannabilityByItemId = new Map(plannability.map((entry) => [entry.planItemId, entry]));
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

      <p>{learnerPlanText(plan.rationale)}</p>
      {plan.feasibility.assumptions.length > 0 ? (
        <details className="small">
          <summary>时间估算依据</summary>
          <ul>
            {plan.feasibility.assumptions.map((assumption) => (
              <li key={assumption}>{learnerPlanText(assumption)}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {plan.recommendations && plan.recommendations.length > 0 ? (
        <div role="region" aria-label="可选策略">
          <h4>可选策略（需要你的决定）</h4>
          {plan.recommendations.map((recommendation) => (
            <p key={recommendation.kind} className="small">
              <span className="pill">
                {RECOMMENDATION_TEXT[recommendation.kind] ?? recommendation.kind}
              </span>{' '}
              {learnerPlanText(recommendation.rationale)}
            </p>
          ))}
          <p className="small muted">当前路线不会因时间估算自动删减内容。</p>
        </div>
      ) : null}

      <ol className="plan-steps">
        {plan.items.map((item, index) => {
          const launch = launchByPlanItemId[item.id];
          const unplannable = plannabilityByItemId.get(item.id);
          return (
            <li key={item.id} className="block-preview">
              <div className="row between">
                <strong>
                  {learnerPlanText(item.phase)} · {KIND_TEXT[item.kind]}
                </strong>
                <span className="small muted">{item.estimatedMinutes} 分钟</span>
              </div>
              <p className="small">{learnerPlanText(item.rationale)}</p>
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

              {unplannable ? (
                <div role="region" aria-label={`该单元暂时无法排课 ${item.id}`}>
                  <Banner kind="info">{PLANNABILITY_TEXT[unplannable.planningCode]}</Banner>
                  <p className="small">
                    可行的调整：
                    {unplannable.remedies.map((remedy) => REMEDY_TEXT[remedy]).join('；')}。
                  </p>
                  <p className="small muted">
                    该提案会保留，你可以调整后再接受路线。通过这项检查只说明讲解环节与时长可以成立，
                    并不代表课程依据已经具备。
                  </p>
                </div>
              ) : null}

              {canEdit && item.kind === 'teach_unit' ? (
                <TeachingItemRepairControls
                  item={item}
                  disabled={busyAction !== null}
                  onEdit={onEdit}
                />
              ) : null}

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
        <div aria-label="已接受的延期">
          <h4>已接受的延期</h4>
          {plan.deferrals.map((deferral) => (
            <p key={deferral.curriculumLearningUnitId} className="small">
              <span className="pill wrong">仍是学习缺口</span> {learnerPlanText(deferral.reason)} ·
              风险 {deferral.riskIds.join('、')}
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
          {showAcceptAction ? (
            <button
              type="button"
              className="primary"
              disabled={!canAccept || busyAction !== null}
              onClick={onAccept}
            >
              {busyAction === 'accept-plan' ? '正在安装路线…' : '接受并启用路线'}
            </button>
          ) : null}
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
                {item.projectedMinutes} 分钟 · {learnerPlanText(item.proposalTrigger)}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
