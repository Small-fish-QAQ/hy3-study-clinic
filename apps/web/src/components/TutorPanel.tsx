import { useEffect, useRef, useState } from 'react';
import type { TutorActivity, TutorEvent, TutorRun } from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from './ui.js';

const EVENT_ICONS: Partial<Record<TutorEvent['kind'], string>> = {
  session_started: '▶',
  state_inspected: '☰',
  neighborhood_inspected: '⌘',
  tool_requested: '⚙',
  tool_validated: '✓',
  tool_rejected: '✕',
  evidence_accepted: '❝',
  evidence_rejected: '✕',
  gap_identified: '⚠',
  misconception_inspected: '?',
  strategy_selected: '★',
  activity_adjusted: '⚠',
  plan_accepted: '✓',
  session_cancelled: '⏹',
  session_failed: '✕',
  session_completed: '✓',
};

export const ACTIVITY_TEXT: Record<TutorActivity['mode'], string> = {
  diagnostic: '诊断评估',
  concept_practice: '概念练习',
  prerequisite_repair: '前置修复练习',
  cross_document: '跨文档综合练习',
  review: '复习检测',
  misconception_check: '误区判别练习',
};

export interface TutorPanelProps {
  workspaceId: string;
  conceptId: string;
  conceptName: string;
  /** True while the recommended activity of this panel is being created. */
  activityLaunching: boolean;
  /** Reports the concept ids of the accepted plan for graph highlighting. */
  onPathChange: (conceptIds: ReadonlySet<string>) => void;
  /**
   * Launches the recommended activity of a completed run. The launch itself
   * is server-owned (POST …/tutor/runs/:runId/activity): the backend
   * revalidates the persisted recommendation and builds the request.
   */
  onStartActivity: (run: TutorRun) => void;
  /** Notifies the parent so the accepted plan can be refetched. */
  onPlanAccepted: () => void;
}

type SessionPhase = 'idle' | 'running' | 'done';

/**
 * Hy3 辅导时间线 — streams the safe Tutor timeline while keeping the graph
 * visible. Shows tool names, concise validated purposes, evidence counts and
 * local validation results; never raw JSON or model reasoning. Stale-response
 * protection: switching concepts or unmounting aborts the stream and any
 * late lines are dropped by the epoch check.
 */
export function TutorPanel({
  workspaceId,
  conceptId,
  conceptName,
  activityLaunching,
  onPathChange,
  onStartActivity,
  onPlanAccepted,
}: TutorPanelProps) {
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [events, setEvents] = useState<TutorEvent[]>([]);
  const [run, setRun] = useState<TutorRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  // Concept switches and unmounts invalidate the whole session view.
  useEffect(() => {
    epochRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPhase('idle');
    setEvents([]);
    setRun(null);
    setError(null);
    onPathChange(new Set());
    return () => {
      epochRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, conceptId]);

  async function startSession() {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase('running');
    setEvents([]);
    setRun(null);
    setError(null);
    onPathChange(new Set());

    try {
      await api.streamTutorSession(
        workspaceId,
        conceptId,
        (line) => {
          if (epochRef.current !== epoch) return;
          if (line.kind === 'event') {
            setEvents((prev) => [...prev, line.event]);
            if (line.kind === 'event' && line.event.kind === 'plan_accepted') {
              const ids = line.event.detail?.conceptIds ?? [];
              onPathChange(new Set(ids));
              onPlanAccepted();
            }
          } else if (line.kind === 'run') {
            setRun(line.run);
          } else {
            setError(line.message);
          }
        },
        controller.signal,
      );
      if (epochRef.current !== epoch) return;
      setPhase('done');
    } catch (err) {
      if (epochRef.current !== epoch) return;
      if (controller.signal.aborted) {
        setPhase('done');
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setPhase('done');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function cancelSession() {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }

  return (
    <section className="tutor-panel" aria-label="Hy3 辅导会话">
      <h4>Hy3 辅导</h4>
      {phase === 'idle' ? (
        <p>
          <button type="button" className="primary" onClick={() => void startSession()}>
            围绕「{conceptName}」启动辅导
          </button>
        </p>
      ) : null}
      {phase === 'running' ? (
        <p className="row">
          <Loading label="Hy3 正在有界规划中…" />
          <button type="button" className="ghost small" onClick={cancelSession}>
            取消
          </button>
        </p>
      ) : null}
      {error ? <Banner kind="error">{error}</Banner> : null}

      {events.length > 0 ? (
        <ol className="tutor-timeline" aria-label="辅导时间线">
          {events.map((event) => (
            <li key={event.id} className={`tutor-event kind-${event.kind}`}>
              <span className="tutor-event-icon" aria-hidden="true">
                {EVENT_ICONS[event.kind] ?? '·'}
              </span>
              <span className="tutor-event-body">
                {event.summary}
                {event.detail?.toolName ? (
                  <span className="pill tool-pill">{event.detail.toolName}</span>
                ) : null}
                {event.detail?.evidenceCount !== undefined ? (
                  <span className="small muted"> 证据 {event.detail.evidenceCount} 条</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {run ? (
        <div className="tutor-run-summary" aria-label="辅导会话结果">
          <p className="small">
            会话状态:
            <strong>
              {run.status === 'completed'
                ? '已完成'
                : run.status === 'cancelled'
                  ? '已取消'
                  : run.status === 'failed'
                    ? '失败'
                    : run.status}
            </strong>{' '}
            · {run.iterations} 轮规划 · {run.toolCallCount} 次工具调用 · 采纳证据{' '}
            {run.acceptedEvidence.length} 条
          </p>
          {run.status === 'completed' && run.activity ? (
            <p>
              <button
                type="button"
                className="primary"
                disabled={activityLaunching}
                aria-busy={activityLaunching}
                onClick={() => onStartActivity(run)}
              >
                {activityLaunching
                  ? '正在创建练习…'
                  : `开始推荐活动:${ACTIVITY_TEXT[run.activity.mode]}`}
              </button>
            </p>
          ) : null}
          {run.status === 'failed' && run.errorMessage ? (
            <Banner kind="error">{run.errorMessage}</Banner>
          ) : null}
          {phase === 'done' ? (
            <p>
              <button
                type="button"
                className="ghost small"
                disabled={activityLaunching}
                onClick={() => void startSession()}
              >
                重新启动辅导
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
