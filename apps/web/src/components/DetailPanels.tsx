import { useEffect, useState, type KeyboardEvent } from 'react';
import type {
  CanonicalConceptView,
  Concept,
  ConceptLearnerState,
  DocumentSummary,
  GraphEdge,
  MisconceptionRecord,
  RemediationPlan,
  CurrentReviewItem,
  SourceBlock,
  VerifiedGrounding,
} from '@hy3-clinic/shared';
import { SourceEvidencePanel } from './SourceEvidencePanel.js';
import { LessonCard } from './LessonCard.js';
import { Banner, formatPageRange, formatSlideNumber, Loading, MasteryMeter } from './ui.js';
import { RELATION_LABELS } from './ConceptGraph.js';

/**
 * Right-hand inspector: 概览(含误区/复习) · 原文证据 · 学习计划.
 *
 * Labels distinguish provenance explicitly:
 * - 「模型提出」 marks model-proposed content (explanations, plan reasons);
 * - 「本地已验证」 marks locally verified facts (exact quotes, IDs, states).
 * Exact-quote verification proves the quote exists at the cited position in
 * the source; it does not by itself prove the semantic relationship — the UI
 * copy preserves that distinction (kept as a compact disclosure note).
 * Misconception wording is always tentative until locally confirmed:
 * 可能的误区 · 待确认 / 已确认 / 已排除 / 已解除.
 */

const STATE_TEXT: Record<ConceptLearnerState['state'], string> = {
  unassessed: '未评估',
  weak: '薄弱',
  developing: '进步中',
  stable: '稳固',
};

const MISCONCEPTION_STATUS_TEXT: Record<MisconceptionRecord['status'], string> = {
  proposed: '待确认',
  confirmed: '已确认',
  rejected: '已排除',
  resolved: '已解除',
};

const STRATEGY_TEXT: Record<RemediationPlan['strategy'], string> = {
  review: '重读复习',
  contrast: '对比辨析',
  worked_example: '例题精讲',
  retrieval_practice: '检索练习',
  prerequisite_repair: '前置修复',
  application_practice: '应用练习',
};

const DIFFICULTY_TEXT: Record<RemediationPlan['difficulty'], string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
};

const QUESTION_TYPE_TEXT: Record<string, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  short_answer: '简答题',
};

type InspectorTab = 'overview' | 'lesson' | 'evidence' | 'plan';

const TAB_TEXT: Record<InspectorTab, string> = {
  overview: '概览',
  lesson: '讲解',
  evidence: '原文证据',
  plan: '学习计划',
};

function EvidenceDisclaimer() {
  return (
    <details className="evidence-disclaimer small">
      <summary>引文校验说明</summary>
      <p className="muted">引文校验仅证明文字确实出现在来源位置,不等于对语义关系的完全证明。</p>
    </details>
  );
}

function EvidenceList({
  evidence,
  blocks,
  documents,
}: {
  evidence: VerifiedGrounding[];
  blocks: SourceBlock[];
  documents: DocumentSummary[];
}) {
  return (
    <>
      {evidence.map((grounding, i) => {
        const block = blocks.find((b) => b.id === grounding.blockId);
        const doc = block ? documents.find((d) => d.id === block.materialId) : undefined;
        const location = [
          doc ? `文档《${doc.title}》` : null,
          block ? formatPageRange(block.pageNumber, block.pageEnd) : null,
          block ? formatSlideNumber(block.slideNumber) : null,
          block && block.headingPath.length > 0 ? block.headingPath.join(' / ') : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <div key={`${grounding.blockId}-${grounding.startOffset}-${i}`} className="evidence-item">
            {location ? <p className="small muted evidence-location">{location}</p> : null}
            <SourceEvidencePanel grounding={grounding} blocks={blocks} />
          </div>
        );
      })}
    </>
  );
}

function InspectorTabs({
  active,
  onChange,
  planAvailable,
  lessonAvailable = false,
}: {
  active: InspectorTab;
  onChange: (tab: InspectorTab) => void;
  planAvailable: boolean;
  lessonAvailable?: boolean;
}) {
  const tabs: InspectorTab[] = [
    'overview',
    ...(lessonAvailable ? (['lesson'] as InspectorTab[]) : []),
    'evidence',
    ...(planAvailable ? (['plan'] as InspectorTab[]) : []),
  ];

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tab: InspectorTab): void {
    const activeIndex = tabs.indexOf(tab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (activeIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (activeIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]!;
    onChange(next);
    requestAnimationFrame(() => document.getElementById(`graph-detail-tab-${next}`)?.focus());
  }

  return (
    <div className="inspector-tabs" role="tablist" aria-label="详情标签页">
      {tabs.map((tab) => (
        <button
          key={tab}
          id={`graph-detail-tab-${tab}`}
          type="button"
          role="tab"
          aria-selected={active === tab}
          aria-controls={`graph-detail-panel-${tab}`}
          tabIndex={active === tab ? 0 : -1}
          className={active === tab ? 'active' : ''}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => onTabKeyDown(event, tab)}
        >
          {TAB_TEXT[tab]}
        </button>
      ))}
    </div>
  );
}

export interface ConceptDetailPanelProps {
  /** Workspace scope for lesson fetch/generation (讲解 tab). */
  workspaceId: string;
  concept: Concept;
  blocks: SourceBlock[];
  documents: DocumentSummary[];
  state: ConceptLearnerState | undefined;
  edges: GraphEdge[];
  conceptNameById: Map<string, string>;
  /** Canonical group of the concept (aliases, member documents). */
  canonical?: CanonicalConceptView | undefined;
  /** Misconception hypotheses of this concept (all statuses, bounded). */
  misconceptions?: MisconceptionRecord[];
  /** Long-term review state (undefined before the first graded activity). */
  reviewItem?: CurrentReviewItem | undefined;
  plan: RemediationPlan | null;
  planLoading: boolean;
  planError: string | null;
  launchLoading: boolean;
  onGeneratePlan: () => void;
  onCancelPlan: () => void;
  onLaunchPlan: (plan: RemediationPlan) => void;
}

export function ConceptDetailPanel({
  workspaceId,
  concept,
  blocks,
  documents,
  state,
  edges,
  conceptNameById,
  canonical,
  misconceptions = [],
  reviewItem,
  plan,
  planLoading,
  planError,
  launchLoading,
  onGeneratePlan,
  onCancelPlan,
  onLaunchPlan,
}: ConceptDetailPanelProps) {
  const [tab, setTab] = useState<InspectorTab>('overview');
  // A new selection always lands on 概览.
  useEffect(() => {
    setTab('overview');
  }, [concept.id]);

  const incoming = edges.filter((e) => e.targetConceptId === concept.id);
  const outgoing = edges.filter((e) => e.sourceConceptId === concept.id);
  const proposedCount = misconceptions.filter((m) => m.status === 'proposed').length;
  const confirmedCount = misconceptions.filter((m) => m.status === 'confirmed').length;
  const reviewDue = reviewItem ? new Date(reviewItem.dueAt).getTime() <= Date.now() : false;
  const memberDocuments = canonical
    ? canonical.materialIds
        .map((id) => documents.find((d) => d.id === id)?.title ?? id)
        .filter(Boolean)
    : [];

  return (
    <div className="detail-panel" aria-label={`概念详情:${concept.name}`}>
      <div className="inspector-head">
        <h3>{canonical?.displayName ?? concept.name}</h3>
        {state ? (
          <span className={`state-pill ${state.state}`}>{STATE_TEXT[state.state]}</span>
        ) : null}
        {confirmedCount > 0 ? (
          <span className="pill wrong" title="已确认的误区">
            误区 {confirmedCount}
          </span>
        ) : proposedCount > 0 ? (
          <span className="pill" title="可能的误区(待确认)">
            疑似误区 {proposedCount}
          </span>
        ) : null}
        {reviewDue ? (
          <span className="pill review-due" title="复习已到期">
            待复习
          </span>
        ) : null}
      </div>
      {canonical && (canonical.aliases.length > 0 || canonical.materialIds.length > 1) ? (
        <p className="small muted canonical-meta">
          {canonical.aliases.length > 0 ? <>别名:{canonical.aliases.join('、')} · </> : null}
          来自 {canonical.materialIds.length} 份文档
          {memberDocuments.length > 0 ? `(${memberDocuments.join('、')})` : ''}
        </p>
      ) : null}
      <InspectorTabs active={tab} onChange={setTab} planAvailable lessonAvailable />

      {tab === 'lesson' ? (
        <div
          className="inspector-body"
          id={`graph-detail-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`graph-detail-tab-${tab}`}
        >
          <LessonCard
            workspaceId={workspaceId}
            conceptId={concept.id}
            conceptName={canonical?.displayName ?? concept.name}
            blocks={blocks}
            documents={documents}
          />
        </div>
      ) : null}

      {tab === 'overview' ? (
        <div
          className="inspector-body"
          id={`graph-detail-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`graph-detail-tab-${tab}`}
        >
          <p>
            <span className="pill model">模型提出</span> {concept.summary}
          </p>
          <section aria-label="学习状态">
            <h4>学习状态</h4>
            {state ? (
              <>
                <p>
                  状态:<strong>{STATE_TEXT[state.state]}</strong>
                  {state.state === 'unassessed' ? '(还没有判分记录)' : null}
                  {!state.hasEnoughActivity && state.attempts > 0
                    ? `(仅 ${state.attempts} 次作答,掌握度证据尚不充分)`
                    : null}
                </p>
                {state.mastery !== null ? <MasteryMeter value={state.mastery} /> : null}
                <p className="small">
                  作答 {state.attempts} 次 · 正确 {state.correctCount} 次
                  {state.lastScore !== null
                    ? ` · 最近得分 ${Math.round(state.lastScore * 100)}%`
                    : ''}
                </p>
                <p className="small">
                  未解决错题 {state.openMistakes} 道 · 已解决错题 {state.resolvedMistakes} 道
                </p>
              </>
            ) : (
              <p className="small muted">学习状态数据不可用。</p>
            )}
          </section>
          {misconceptions.length > 0 ? (
            <section aria-label="可能的误区">
              <h4>可能的误区</h4>
              <ul className="misconception-list small">
                {misconceptions.map((record) => (
                  <li key={record.id} className={`misconception-item ${record.status}`}>
                    <span className={`pill misconception-status ${record.status}`}>
                      {MISCONCEPTION_STATUS_TEXT[record.status]}
                    </span>{' '}
                    <span className="pill model">模型假设</span> {record.hypothesis}
                  </li>
                ))}
              </ul>
              <p className="small muted">误区仅为假设;只有判别练习的作答结果才会确认或排除它。</p>
            </section>
          ) : null}
          <section aria-label="复习安排">
            <h4>复习安排</h4>
            {reviewItem ? (
              <p className="small">
                <span className="pill deterministic">本地调度</span> 下次复习:
                {formatDue(reviewItem.dueAt)}
                {reviewItem.lifecycleState === 'pending_initial_review'
                  ? ' · 等待首次复习'
                  : ` · 已复习 ${reviewItem.repetitions ?? 0} 次`}
                {(reviewItem.lapses ?? 0) > 0 ? ` · 遗忘 ${reviewItem.lapses} 次` : ''}
                {reviewDue ? ' · 已到期' : ''}
              </p>
            ) : (
              <p className="small muted">完成一次判分后,系统会按遗忘风险安排复习时间。</p>
            )}
            <p className="small muted">
              复习时间与掌握度相互独立:前者估计遗忘风险,后者汇总作答表现。
            </p>
          </section>
          <section aria-label="概念关系">
            <h4>概念关系</h4>
            {incoming.length === 0 && outgoing.length === 0 ? (
              <p className="small muted">当前图谱版本中没有涉及该概念的关系。</p>
            ) : (
              <>
                {incoming.map((edge) => (
                  <RelationRow key={edge.id} edge={edge} direction="in" names={conceptNameById} />
                ))}
                {outgoing.map((edge) => (
                  <RelationRow key={edge.id} edge={edge} direction="out" names={conceptNameById} />
                ))}
              </>
            )}
          </section>
        </div>
      ) : null}

      {tab === 'evidence' ? (
        <div
          className="inspector-body"
          id={`graph-detail-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`graph-detail-tab-${tab}`}
        >
          <section aria-label="原文依据">
            <h4>
              原文依据 <span className="pill deterministic">本地已验证</span>
            </h4>
            <EvidenceList evidence={[concept.grounding]} blocks={blocks} documents={documents} />
            <EvidenceDisclaimer />
          </section>
        </div>
      ) : null}

      {tab === 'plan' ? (
        <div
          className="inspector-body"
          id={`graph-detail-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`graph-detail-tab-${tab}`}
        >
          <section aria-label="康复计划">
            <h4>康复计划</h4>
            {planError ? <Banner kind="error">{planError}</Banner> : null}
            {planLoading ? (
              <p>
                <Loading label="Hy3 正在生成康复计划…" />{' '}
                <button type="button" className="ghost small" onClick={onCancelPlan}>
                  取消
                </button>
              </p>
            ) : (
              <p>
                <button type="button" className={plan ? '' : 'primary'} onClick={onGeneratePlan}>
                  {plan ? '重新生成康复计划' : '生成康复计划'}
                </button>
              </p>
            )}
            {plan ? (
              <div className="plan-card" aria-label="已接受的康复计划">
                <p>
                  <span className="pill deterministic">本地校验通过</span>{' '}
                  <strong>{STRATEGY_TEXT[plan.strategy]}</strong> · 难度{' '}
                  {DIFFICULTY_TEXT[plan.difficulty]} · 题型{' '}
                  {plan.questionTypes.map((t) => QUESTION_TYPE_TEXT[t] ?? t).join('、')}
                </p>
                <p>{plan.summary}</p>
                <p className="small">
                  <span className="pill model">模型假设</span> {plan.weaknessHypothesis}
                </p>
                <ol className="plan-steps">
                  {plan.steps.map((step) => (
                    <li key={step.index}>
                      {step.description}
                      {step.conceptId && conceptNameById.get(step.conceptId)
                        ? `(${conceptNameById.get(step.conceptId)})`
                        : null}
                    </li>
                  ))}
                </ol>
                <h5>目标概念与依据</h5>
                {plan.targets.map((target) => (
                  <div key={target.conceptId} className="plan-target">
                    <p>
                      <strong>{target.conceptName}</strong> —{' '}
                      <span className="pill model">模型提出</span> {target.reason}
                    </p>
                    <EvidenceList
                      evidence={target.evidence}
                      blocks={blocks}
                      documents={documents}
                    />
                  </div>
                ))}
                <p>
                  <button
                    type="button"
                    className="primary"
                    disabled={launchLoading}
                    onClick={() => onLaunchPlan(plan)}
                  >
                    {launchLoading ? '正在启动康复练习…' : '按计划开始康复练习'}
                  </button>
                </p>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function RelationRow({
  edge,
  direction,
  names,
}: {
  edge: GraphEdge;
  direction: 'in' | 'out';
  names: Map<string, string>;
}) {
  const source = names.get(edge.sourceConceptId) ?? edge.sourceConceptId;
  const target = names.get(edge.targetConceptId) ?? edge.targetConceptId;
  return (
    <p className="relation-row small">
      <span className={`relation-tag relation-${edge.relation}`}>
        {RELATION_LABELS[edge.relation]}
      </span>{' '}
      {direction === 'in' ? `${source} → 本概念` : `本概念 → ${target}`}
      <span className="muted">({edge.explanation})</span>
    </p>
  );
}

/** Compact due-date formatting for the review section (local time). */
function formatDue(iso: string): string {
  const due = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((due.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  const date = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(
    due.getDate(),
  ).padStart(2, '0')}`;
  if (diffDays < 0) return `${date}(已过期 ${-diffDays} 天)`;
  if (diffDays === 0) return `${date}(今天)`;
  return `${date}(${diffDays} 天后)`;
}

export interface EdgeDetailPanelProps {
  edge: GraphEdge;
  blocks: SourceBlock[];
  documents: DocumentSummary[];
  conceptNameById: Map<string, string>;
  /** How many underlying edges the canonical view collapsed into this one. */
  mergedEdgeCount?: number;
}

export function EdgeDetailPanel({
  edge,
  blocks,
  documents,
  conceptNameById,
  mergedEdgeCount = 1,
}: EdgeDetailPanelProps) {
  const [tab, setTab] = useState<InspectorTab>('overview');
  useEffect(() => {
    setTab('overview');
  }, [edge.id]);

  const source = conceptNameById.get(edge.sourceConceptId) ?? edge.sourceConceptId;
  const target = conceptNameById.get(edge.targetConceptId) ?? edge.targetConceptId;
  return (
    <div className="detail-panel" aria-label={`关系详情:${source} 与 ${target}`}>
      <div className="inspector-head">
        <h3>
          {source}{' '}
          <span className={`relation-tag relation-${edge.relation}`}>
            {RELATION_LABELS[edge.relation]}
          </span>{' '}
          {target}
        </h3>
      </div>
      <InspectorTabs active={tab} onChange={setTab} planAvailable={false} />

      {tab === 'overview' ? (
        <div
          className="inspector-body"
          id={`graph-detail-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`graph-detail-tab-${tab}`}
        >
          <p>
            <span className="pill model">模型提出</span> {edge.explanation}
          </p>
          <p className="small">
            <span className="pill deterministic">本地已验证</span> 该关系的 {edge.evidence.length}{' '}
            条引文均通过本地证据校验。
            {mergedEdgeCount > 1 ? `(概念对齐后合并了 ${mergedEdgeCount} 条同类关系)` : ''}
          </p>
        </div>
      ) : null}

      {tab === 'evidence' ? (
        <div
          className="inspector-body"
          id={`graph-detail-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`graph-detail-tab-${tab}`}
        >
          <section aria-label="关系依据">
            <h4>
              关系依据 <span className="pill deterministic">本地已验证</span>
            </h4>
            <EvidenceList evidence={edge.evidence} blocks={blocks} documents={documents} />
            <EvidenceDisclaimer />
          </section>
        </div>
      ) : null}
    </div>
  );
}
