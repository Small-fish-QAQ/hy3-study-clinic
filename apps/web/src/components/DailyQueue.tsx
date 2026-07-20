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
  startingConceptId: string | null;
  onStartItem: (item: DailyQueueItem) => void;
}

/**
 * 今日学习 — the deterministic daily queue (overdue reviews → confirmed
 * misconception repair → open mistakes → weak prerequisites → due today).
 * Facts only: counts and overdue days, no invented time estimates.
 */
export function DailyQueue({
  items,
  loading,
  error,
  startingConceptId,
  onStartItem,
}: DailyQueueProps) {
  return (
    <section className="daily-queue" aria-label="今日学习队列">
      <h3>今日学习</h3>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {loading && items === null ? <Loading label="加载学习队列…" /> : null}
      {items !== null && items.length === 0 ? (
        <p className="small muted">今天没有排队的学习任务。完成一次评估后,这里会给出复习安排。</p>
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
                disabled={startingConceptId !== null}
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
