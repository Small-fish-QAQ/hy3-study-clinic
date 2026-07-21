import type { DailyQueueItem } from '@hy3-clinic/shared';
import { Banner, Loading } from './ui.js';

const KIND_TEXT: Record<DailyQueueItem['kind'], string> = {
  overdue_review: '到期复习',
  misconception_repair: '误区修复',
  open_mistakes: '错题巩固',
  weak_prerequisite: '前置修复',
  due_review: '今日复习',
};

export interface DailyQueueProps {
  items: DailyQueueItem[] | null;
  loading: boolean;
  error: string | null;
  /** True while ANY assessment launch is pending (blocks duplicate starts). */
  launchBusy: boolean;
  /** Concept whose queue item is currently launching (loading label). */
  startingConceptId: string | null;
  /** True while the empty-state diagnostic assessment is being generated. */
  diagnosticStarting: boolean;
  /** The diagnostic needs at least one extracted concept to exist. */
  canDiagnose: boolean;
  onStartItem: (item: DailyQueueItem) => void;
  onStartDiagnostic: () => void;
}

/**
 * 今日学习 — the deterministic daily queue (overdue reviews → confirmed
 * misconception repair → open mistakes → weak prerequisites → due today).
 * Facts only: counts and overdue days, no invented time estimates. The
 * empty state offers the real workspace diagnostic-assessment flow (the
 * same POST /assessments mode=diagnostic used by Tutor activities).
 */
export function DailyQueue({
  items,
  loading,
  error,
  launchBusy,
  startingConceptId,
  diagnosticStarting,
  canDiagnose,
  onStartItem,
  onStartDiagnostic,
}: DailyQueueProps) {
  return (
    <section className="daily-queue" aria-label="今日学习队列">
      <h3>今日学习</h3>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {loading && items === null ? <Loading label="加载学习队列…" /> : null}
      {items !== null && items.length === 0 ? (
        <div className="queue-empty">
          <p className="small muted">
            今天暂无待办。完成一次练习、诊断评估或辅导活动后,系统会根据错题、薄弱概念和复习到期时间生成后续任务。
          </p>
          {canDiagnose ? (
            <p>
              <button
                type="button"
                className="primary small"
                disabled={launchBusy}
                aria-busy={diagnosticStarting}
                onClick={onStartDiagnostic}
              >
                {diagnosticStarting ? '正在生成诊断评估…' : '开始诊断评估'}
              </button>
            </p>
          ) : (
            <p className="small muted">先在下方添加文档并提取概念,之后可以从这里开始诊断评估。</p>
          )}
          <details className="small">
            <summary>任务从哪里来?</summary>
            <ul>
              <li>到期或过期的复习安排</li>
              <li>未解决的错题</li>
              <li>已确认待修复的误区</li>
              <li>薄弱概念的前置概念</li>
              <li>今天稍后到期的复习</li>
            </ul>
          </details>
        </div>
      ) : null}
      {items !== null && items.length > 0 ? (
        <ul className="queue-list">
          {items.map((item) => (
            <li key={`${item.kind}-${item.conceptId}-${item.misconceptionId ?? ''}`}>
              <div className="queue-item-info">
                <span className={`pill queue-kind ${item.kind}`}>{KIND_TEXT[item.kind]}</span>
                <strong>{item.conceptName}</strong>
                <p className="small muted">{item.reason}</p>
              </div>
              <button
                type="button"
                className="primary small"
                disabled={launchBusy}
                aria-busy={startingConceptId === item.conceptId}
                onClick={() => onStartItem(item)}
              >
                {startingConceptId === item.conceptId ? '启动中…' : '开始'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
