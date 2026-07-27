import { useEffect, useRef, useState } from 'react';
import type { CompletedAttemptDetail, CompletedAttemptSummary } from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { ResultsView } from './ResultsView.js';
import { ASSESSMENT_MODE_LABELS } from './QuizView.js';

export interface QuizHistoryViewProps {
  /** Workspace whose completed attempts are browsed (练习区当前上下文). */
  workspaceId: string | null;
}

const KIND_LABELS: Record<CompletedAttemptSummary['kind'], string> = {
  standard: '文档测验',
  remediation: '康复练习',
  adaptive: '课程空间评估',
};

/** Honest provider tag of a persisted attempt — never relabelled. */
function providerLabel(provider: CompletedAttemptSummary['provider']): string {
  if (provider === 'fake') return '离线判分(Fake)';
  if (provider === 'hy3') return 'Hy3 在线判分';
  return '判分模式未记录';
}

function attemptTitle(attempt: CompletedAttemptSummary): string {
  if (attempt.kind === 'adaptive') {
    const mode = attempt.assessmentMode ? ASSESSMENT_MODE_LABELS[attempt.assessmentMode] : null;
    return `${KIND_LABELS.adaptive} · ${mode ?? '综合评估'}`;
  }
  return `${KIND_LABELS[attempt.kind]} · ${attempt.materialTitle ?? '(资料已删除)'}`;
}

function formatLocalDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** True when some verified evidence no longer resolves to a live block. */
function hasUnavailableSource(detail: CompletedAttemptDetail): boolean {
  const available = new Set(detail.blocks.map((b) => b.id));
  return detail.questions.some(
    (q) =>
      !available.has(q.grounding.blockId) ||
      (q.supplementaryEvidence ?? []).some((e) => !available.has(e.blockId)),
  );
}

/**
 * 测验历史:已完成测验的只读回看。
 *
 * 列表与详情都只发起 GET 请求 —— 打开历史绝不会重新出题、重新判分,也不会
 * 再次改动掌握度、错题、误区或复习计划(这些只在当初提交判分时发生一次)。
 */
export function QuizHistoryView({ workspaceId }: QuizHistoryViewProps) {
  const [attempts, setAttempts] = useState<CompletedAttemptSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompletedAttemptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    // Workspace switched (or first mount): drop any open detail and reload.
    requestRef.current += 1;
    const requestId = requestRef.current;
    setDetail(null);
    setDetailLoading(null);
    setDetailError(null);
    setListError(null);

    if (workspaceId === null) {
      setAttempts([]);
      setListLoading(false);
      return;
    }

    const controller = new AbortController();
    setListLoading(true);
    api
      .listAttempts(workspaceId, controller.signal)
      .then((res) => {
        if (requestRef.current !== requestId) return;
        setAttempts(res.attempts);
        setListLoading(false);
      })
      .catch((error) => {
        if (requestRef.current !== requestId) return;
        if (error instanceof ApiClientError && error.code === 'ABORTED') return;
        setListError(error instanceof Error ? error.message : String(error));
        setListLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [workspaceId]);

  async function openAttempt(attemptId: string) {
    if (workspaceId === null) return;
    const requestId = ++requestRef.current;
    setDetailLoading(attemptId);
    setDetailError(null);
    try {
      const loaded = await api.getAttempt(workspaceId, attemptId);
      if (requestRef.current !== requestId) return;
      setDetail(loaded);
    } catch (error) {
      if (requestRef.current !== requestId) return;
      if (error instanceof ApiClientError && error.code === 'ABORTED') return;
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestRef.current === requestId) setDetailLoading(null);
    }
  }

  function backToList() {
    requestRef.current += 1;
    setDetail(null);
    setDetailLoading(null);
    setDetailError(null);
  }

  if (detail) {
    const { summary } = detail;
    return (
      <div className="stack">
        <section className="card">
          <div className="row between">
            <h2>{attemptTitle(summary)}</h2>
            <button type="button" onClick={backToList}>
              返回历史列表
            </button>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: '0.35rem' }}>
            <span className="pill">历史结果(只读)</span>
            <span className="pill">{providerLabel(summary.provider)}</span>
            <span className="muted small">
              完成于{' '}
              <time dateTime={summary.completedAt}>{formatLocalDateTime(summary.completedAt)}</time>{' '}
              · 共 {summary.questionCount} 题
            </span>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            以下为当时判分的原始记录。回看不会重新判分,也不会再次改动掌握度、错题或复习计划。
          </p>
        </section>

        {detail.stateChanges === null ? (
          <Banner kind="info">
            该记录完成于历史版本,未保存「学习状态变化」明细,仅显示判分结果。
          </Banner>
        ) : null}
        {hasUnavailableSource(detail) ? (
          <Banner kind="info">
            部分原文源块已不可用(资料可能已被删除或重新解析)。原文依据仅显示判分时保存的引文,不代表当前资料内容。
          </Banner>
        ) : null}

        <ResultsView
          quiz={detail.quiz}
          result={{
            grading: detail.grading,
            questions: detail.questions,
            ...(detail.stateChanges ? { stateChanges: detail.stateChanges } : {}),
          }}
          answers={detail.answers}
          blocks={detail.blocks}
          onRemediate={() => {}}
          remediationLoading={false}
          readOnly
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="row between">
          <h2>测验历史</h2>
          <span className="muted small">最多显示最近 50 次</span>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          已完成的测验会保留原始题目、作答、判分与依据,可随时只读回看。
        </p>
      </section>

      {listError ? <Banner kind="error">无法加载测验历史:{listError}</Banner> : null}
      {detailError ? <Banner kind="error">无法打开历史结果:{detailError}</Banner> : null}
      {listLoading ? <Loading label="正在加载测验历史…" /> : null}

      {!listLoading && !listError && attempts.length === 0 ? (
        <Banner kind="empty">
          还没有已完成的测验。提交一次判分后,这里会保留可回看的历史结果。
        </Banner>
      ) : null}

      {!listLoading && attempts.length > 0 ? (
        <section className="card">
          <div className="stack">
            {attempts.map((attempt) => {
              const title = attemptTitle(attempt);
              const opening = detailLoading === attempt.id;
              return (
                <div key={attempt.id} className="block-preview">
                  <div className="row between">
                    <strong>{title}</strong>
                    <span className="row" style={{ gap: '0.35rem' }}>
                      <span className="pill">{providerLabel(attempt.provider)}</span>
                      <button
                        type="button"
                        disabled={detailLoading !== null}
                        aria-label={`查看历史结果:${title}`}
                        onClick={() => void openAttempt(attempt.id)}
                      >
                        {opening ? '打开中…' : '查看'}
                      </button>
                    </span>
                  </div>
                  <div className="muted small">
                    完成于{' '}
                    <time dateTime={attempt.completedAt}>
                      {formatLocalDateTime(attempt.completedAt)}
                    </time>{' '}
                    · 共 {attempt.questionCount} 题 · 得分 {Math.round(attempt.overallScore * 100)}{' '}
                    分({attempt.totalAwarded}/{attempt.totalPossible})
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
