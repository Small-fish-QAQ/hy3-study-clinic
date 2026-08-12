import { useEffect, useState } from 'react';
import type { MistakeRecord } from '@hy3-clinic/shared';
import { api, type MistakesResponse } from '../api.js';
import { Banner, Loading } from '../components/ui.js';

export interface MistakesViewProps {
  materialId: string;
  /** Bumped when grading happens so the list refetches. */
  refreshKey: number;
  onRemediate: () => void;
  remediationLoading: boolean;
  remediationError: string | null;
}

/** 错题本视图(Flow B):按概念聚合的错题与康复练习入口。 */
export function MistakesView({
  materialId,
  refreshKey,
  onRemediate,
  remediationLoading,
  remediationError,
}: MistakesViewProps) {
  const [data, setData] = useState<MistakesResponse | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .mistakes(materialId, statusFilter)
      .then((res) => {
        if (alive) setData(res);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [materialId, statusFilter, refreshKey]);

  const openCount = data?.weakConcepts.reduce((sum, c) => sum + c.openMistakes, 0) ?? 0;

  return (
    <div className="stack">
      <section className="card">
        <div className="row between">
          <h2>错题本</h2>
          <div className="row">
            <select
              aria-label="筛选状态"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'open' | 'all')}
              style={{ width: 'auto' }}
            >
              <option value="open">未解决</option>
              <option value="all">全部</option>
            </select>
            <button
              type="button"
              className="primary"
              disabled={remediationLoading || openCount === 0}
              onClick={onRemediate}
            >
              {remediationLoading ? '正在生成康复练习…' : '生成康复练习'}
            </button>
          </div>
        </div>
        {remediationError ? <Banner kind="error">{remediationError}</Banner> : null}
        {data && openCount === 0 && data.mistakes.length > 0 ? (
          <section className="course-empty-state compact" role="status">
            <strong>当前没有需要修复的错题</strong>
            <p>所有错题都已解决，因此暂时不需要生成康复练习。</p>
          </section>
        ) : null}
        {data && data.weakConcepts.length > 0 ? (
          <div className="row">
            {data.weakConcepts.map((c) => (
              <span key={c.conceptId} className="pill wrong">
                {c.conceptName} · {c.openMistakes} 个未解决
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {loading ? (
        <Loading label="加载错题…" />
      ) : error ? (
        <Banner kind="error">{error}</Banner>
      ) : !data || data.mistakes.length === 0 ? (
        <section className="course-empty-state compact" role="status">
          <strong>{statusFilter === 'open' ? '当前没有需要修复的错题' : '还没有错题记录'}</strong>
          <p>
            {statusFilter === 'open'
              ? '出现需要修复的错题后，可以从这里生成康复练习。'
              : '完成一次测验后，错题和后续修复会保留在这里。'}
          </p>
        </section>
      ) : (
        data.mistakes.map((mistake) => <MistakeCard key={mistake.id} mistake={mistake} />)
      )}
    </div>
  );
}

function MistakeCard({ mistake }: { mistake: MistakeRecord }) {
  const { question } = mistake;
  const selected = new Set(mistake.userAnswer.selectedOptionIds ?? []);
  return (
    <section className="card">
      <div className="row between">
        <h3>
          <span className="pill">{mistake.conceptName}</span>{' '}
          <span className={`pill ${mistake.status === 'open' ? 'wrong' : 'correct'}`}>
            {mistake.status === 'open' ? '未解决' : '已解决'}
          </span>
          {mistake.remediationCount > 0 ? (
            <span className="pill">已练习 {mistake.remediationCount} 次</span>
          ) : null}
        </h3>
        <span className="muted small">原始得分 {Math.round(mistake.score * 100)}%</span>
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{question.stem}</p>

      {question.type !== 'short_answer' ? (
        <div>
          {(question.options ?? []).map((option) => {
            const isCorrect = question.correctOptionIds?.includes(option.id) ?? false;
            const isSelected = selected.has(option.id);
            return (
              <div
                key={option.id}
                className={`option ${isCorrect ? 'correct' : isSelected ? 'incorrect' : ''}`}
              >
                <span>
                  <strong>{option.id}.</strong> {option.text}
                  {isCorrect ? ' ✓' : ''}
                  {isSelected && !isCorrect ? ' ✗ 你的选择' : ''}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="stack" style={{ gap: '0.5rem' }}>
          <div className="block-preview">
            <div className="heading-path">你的回答</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {mistake.userAnswer.text?.trim() ? mistake.userAnswer.text : '(未作答)'}
            </div>
          </div>
          <div className="block-preview">
            <div className="heading-path">参考答案</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{question.expectedAnswer}</div>
          </div>
        </div>
      )}
      {mistake.feedback ? (
        <p className="small muted">
          <strong>评语:</strong>
          {mistake.feedback}
        </p>
      ) : null}
    </section>
  );
}
