import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AlignmentProposal,
  CanonicalConceptView,
  Concept,
  DocumentSummary,
  SourceBlock,
} from '@hy3-clinic/shared';
import { api, type AlignmentOverviewResponse } from '../api.js';
import { Banner, Loading } from './ui.js';
import { useAsyncAction } from './useAsyncAction.js';

const RELATION_TEXT: Record<AlignmentProposal['relation'], string> = {
  equivalent: '同一概念',
  alias: '书写变体',
  broader: '更宽泛',
  narrower: '更具体',
  related_but_distinct: '相关但不同',
};

const LANGUAGE_TEXT: Record<AlignmentProposal['sourceLanguage'], string> = {
  zh: '中文',
  en: '英文',
  mixed: '中英混合',
  unknown: '未知语言',
};

export interface AlignmentPanelProps {
  workspaceId: string;
  concepts: Concept[];
  blocks: SourceBlock[];
  documents: DocumentSummary[];
  onClose: () => void;
  /** Called after any accepted/renamed change so the graph can reload. */
  onChanged: () => void;
}

/**
 * 概念对齐审核面板 — reviews Hy3 alignment proposals with enough evidence
 * for a safe decision: names, documents, languages, side-by-side summaries,
 * verified source quotes; supports repairing malformed canonical names both
 * at acceptance time and via later renames.
 */
export function AlignmentPanel({
  workspaceId,
  concepts,
  blocks,
  documents,
  onClose,
  onChanged,
}: AlignmentPanelProps) {
  const [overview, setOverview] = useState<AlignmentOverviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const epochRef = useRef(0);
  const proposeAction = useAsyncAction();
  const decideAction = useAsyncAction();
  const renameAction = useAsyncAction();

  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const documentTitle = (materialId: string) =>
    documents.find((d) => d.id === materialId)?.title ?? materialId;

  const load = useCallback(async () => {
    const epoch = epochRef.current;
    setLoadError(null);
    try {
      const result = await api.alignmentOverview(workspaceId);
      if (epochRef.current !== epoch) return;
      setOverview(result);
    } catch (error) {
      if (epochRef.current !== epoch) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [workspaceId]);

  useEffect(() => {
    epochRef.current += 1;
    setOverview(null);
    void load();
    return () => {
      epochRef.current += 1;
    };
  }, [load]);

  async function runPropose() {
    const result = await proposeAction.run((signal) => api.proposeAlignment(workspaceId, signal));
    if (!result) return;
    await load();
    if (result.autoAccepted.length > 0) onChanged();
  }

  async function decide(
    proposal: AlignmentProposal,
    decision: 'accept' | 'reject' | 'keep-separate',
  ) {
    const draft = nameDrafts[proposal.id]?.trim();
    const result = await decideAction.run((signal) =>
      api.decideAlignment(
        workspaceId,
        proposal.id,
        decision,
        decision === 'accept' && draft ? { canonicalName: draft } : undefined,
        signal,
      ),
    );
    if (!result) return;
    setOverview(result);
    if (decision === 'accept') onChanged();
  }

  async function renameCanonical(view: CanonicalConceptView) {
    const draft = renameDrafts[view.id]?.trim();
    if (!draft || draft === view.displayName) return;
    const result = await renameAction.run((signal) =>
      api.renameCanonical(workspaceId, view.id, draft, signal),
    );
    if (!result) return;
    setRenameDrafts((prev) => ({ ...prev, [view.id]: '' }));
    await load();
    onChanged();
  }

  const pending = overview?.pendingProposals ?? [];
  const mergedGroups = (overview?.canonical ?? []).filter((c) => c.members.length > 1);

  return (
    <div className="alignment-panel" role="dialog" aria-label="概念对齐审核">
      <div className="panel-head">
        <h3>概念对齐</h3>
        <button type="button" className="ghost small" aria-label="关闭对齐面板" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="small muted">
        Hy3 只提议对齐;是否合并由你决定。接受合并不会改动任何原始概念、证据或学习记录。
      </p>

      {loadError ? <Banner kind="error">{loadError}</Banner> : null}
      {!overview && !loadError ? <Loading label="加载对齐状态…" /> : null}

      <div className="row" style={{ marginBottom: '0.5rem' }}>
        {proposeAction.loading ? (
          <>
            <Loading label="Hy3 正在分析候选概念对…" />
            <button type="button" className="ghost small" onClick={proposeAction.cancel}>
              取消
            </button>
          </>
        ) : (
          <button type="button" className="primary small" onClick={() => void runPropose()}>
            运行对齐分析
          </button>
        )}
      </div>
      {proposeAction.error ? <Banner kind="error">{proposeAction.error}</Banner> : null}
      {decideAction.error ? <Banner kind="error">{decideAction.error}</Banner> : null}

      {overview && pending.length === 0 ? (
        <Banner kind="empty">
          没有待审核的对齐提议。导入新文档或提取新概念后,可再次运行对齐分析。
        </Banner>
      ) : null}

      <ul className="alignment-proposals">
        {pending.map((proposal) => {
          const source = conceptById.get(proposal.sourceConceptId);
          const target = conceptById.get(proposal.targetConceptId);
          return (
            <li key={proposal.id} className="alignment-proposal">
              <p className="alignment-pair">
                <strong>{source?.name ?? proposal.sourceConceptId}</strong>
                <span className={`relation-tag relation-${proposal.relation}`}>
                  {RELATION_TEXT[proposal.relation]}
                </span>
                <strong>{target?.name ?? proposal.targetConceptId}</strong>
              </p>
              <p className="small muted">
                {source ? `《${documentTitle(source.materialId)}》` : ''}(
                {LANGUAGE_TEXT[proposal.sourceLanguage]}) ↔{' '}
                {target ? `《${documentTitle(target.materialId)}》` : ''}(
                {LANGUAGE_TEXT[proposal.targetLanguage]})
              </p>
              {source && target ? (
                <div className="alignment-summaries small">
                  <p>{source.summary}</p>
                  <p>{target.summary}</p>
                </div>
              ) : null}
              <p className="small">
                <span className="pill model">模型理由</span> {proposal.rationale}
              </p>
              {proposal.evidence.map((evidence, i) => {
                const block = blocks.find((b) => b.id === evidence.blockId);
                return (
                  <blockquote key={`${evidence.blockId}-${i}`} className="alignment-quote small">
                    「{evidence.quote}」
                    {block ? (
                      <span className="muted">——《{documentTitle(block.materialId)}》</span>
                    ) : null}
                  </blockquote>
                );
              })}
              {proposal.relation === 'equivalent' || proposal.relation === 'alias' ? (
                <label className="small alignment-name-edit">
                  合并后名称
                  <input
                    value={nameDrafts[proposal.id] ?? proposal.proposedCanonicalName}
                    aria-label="合并后的规范名称"
                    maxLength={80}
                    onChange={(e) =>
                      setNameDrafts((prev) => ({ ...prev, [proposal.id]: e.target.value }))
                    }
                  />
                </label>
              ) : null}
              <div className="row">
                <button
                  type="button"
                  className="primary small"
                  disabled={decideAction.loading}
                  onClick={() => void decide(proposal, 'accept')}
                >
                  接受
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={decideAction.loading}
                  onClick={() => void decide(proposal, 'keep-separate')}
                >
                  保持独立
                </button>
                <button
                  type="button"
                  className="ghost small danger"
                  disabled={decideAction.loading}
                  onClick={() => void decide(proposal, 'reject')}
                >
                  拒绝
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {mergedGroups.length > 0 ? (
        <section aria-label="已合并的规范概念">
          <h4>已合并概念({mergedGroups.length})</h4>
          {renameAction.error ? <Banner kind="error">{renameAction.error}</Banner> : null}
          <ul className="canonical-list">
            {mergedGroups.map((view) => (
              <li key={view.id}>
                <p>
                  <strong>{view.displayName}</strong>{' '}
                  <span className="small muted">
                    {view.members.length} 个来源 · {view.materialIds.length} 份文档
                  </span>
                </p>
                {view.aliases.length > 0 ? (
                  <p className="small muted">别名:{view.aliases.join('、')}</p>
                ) : null}
                <div className="row">
                  <input
                    className="small"
                    placeholder="修改规范名称…"
                    aria-label={`重命名 ${view.displayName}`}
                    maxLength={80}
                    value={renameDrafts[view.id] ?? ''}
                    onChange={(e) =>
                      setRenameDrafts((prev) => ({ ...prev, [view.id]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className="ghost small"
                    disabled={renameAction.loading || !(renameDrafts[view.id] ?? '').trim()}
                    onClick={() => void renameCanonical(view)}
                  >
                    重命名
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
