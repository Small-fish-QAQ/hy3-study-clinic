import { useEffect, useState } from 'react';
import type {
  Concept,
  ConceptLearnerState,
  DocumentSummary,
  GraphEdge,
  RemediationPlan,
  SourceBlock,
  VerifiedGrounding,
} from '@hy3-clinic/shared';
import { SourceEvidencePanel } from './SourceEvidencePanel.js';
import { Banner, Loading, MasteryMeter } from './ui.js';
import { RELATION_LABELS } from './ConceptGraph.js';

/**
 * Right-hand inspector: 概览 · 原文证据 · 学习计划.
 *
 * Labels distinguish provenance explicitly:
 * - 「模型提出」 marks model-proposed content (explanations, plan reasons);
 * - 「本地已验证」 marks locally verified facts (exact quotes, IDs, states).
 * Exact-quote verification proves the quote exists at the cited position in
 * the source; it does not by itself prove the semantic relationship — the UI
 * copy preserves that distinction (kept as a compact disclosure note).
 */

const STATE_TEXT: Record<ConceptLearnerState['state'], string> = {
  unassessed: '未评估',
  weak: '薄弱',
  developing: '进步中',
  stable: '稳固',
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

type InspectorTab = 'overview' | 'evidence' | 'plan';

const TAB_TEXT: Record<InspectorTab, string> = {
  overview: '概览',
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
          block?.pageNumber ? `第 ${block.pageNumber} 页` : null,
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
}: {
  active: InspectorTab;
  onChange: (tab: InspectorTab) => void;
  planAvailable: boolean;
}) {
  const tabs: InspectorTab[] = planAvailable
    ? ['overview', 'evidence', 'plan']
    : ['overview', 'evidence'];
  return (
    <div className="inspector-tabs" role="tablist" aria-label="详情标签页">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={active === tab}
          className={active === tab ? 'active' : ''}
          onClick={() => onChange(tab)}
        >
          {TAB_TEXT[tab]}
        </button>
      ))}
    </div>
  );
}

export interface ConceptDetailPanelProps {
  concept: Concept;
  blocks: SourceBlock[];
  documents: DocumentSummary[];
  state: ConceptLearnerState | undefined;
  edges: GraphEdge[];
  conceptNameById: Map<string, string>;
  plan: RemediationPlan | null;
  planLoading: boolean;
  planError: string | null;
  launchLoading: boolean;
  onGeneratePlan: () => void;
  onCancelPlan: () => void;
  onLaunchPlan: (plan: RemediationPlan) => void;
}

export function ConceptDetailPanel({
  concept,
  blocks,
  documents,
  state,
  edges,
  conceptNameById,
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

  return (
    <div className="detail-panel" aria-label={`概念详情:${concept.name}`}>
      <div className="inspector-head">
        <h3>{concept.name}</h3>
        {state ? (
          <span className={`state-pill ${state.state}`}>{STATE_TEXT[state.state]}</span>
        ) : null}
      </div>
      <InspectorTabs active={tab} onChange={setTab} planAvailable />

      {tab === 'overview' ? (
        <div className="inspector-body">
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
        <div className="inspector-body">
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
        <div className="inspector-body">
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

export interface EdgeDetailPanelProps {
  edge: GraphEdge;
  blocks: SourceBlock[];
  documents: DocumentSummary[];
  conceptNameById: Map<string, string>;
}

export function EdgeDetailPanel({
  edge,
  blocks,
  documents,
  conceptNameById,
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
        <div className="inspector-body">
          <p>
            <span className="pill model">模型提出</span> {edge.explanation}
          </p>
          <p className="small">
            <span className="pill deterministic">本地已验证</span> 该关系的 {edge.evidence.length}{' '}
            条引文均通过本地证据校验。
          </p>
        </div>
      ) : null}

      {tab === 'evidence' ? (
        <div className="inspector-body">
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
