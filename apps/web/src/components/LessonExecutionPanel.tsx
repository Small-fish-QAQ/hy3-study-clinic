import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LessonExecutionProjection,
  LessonExecutionCommandRequest,
  LessonSegmentProjection,
  LessonSourceProjection,
  EnsureLessonExecutionRequest,
} from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import { Loading } from './ui.js';
import { FormalAssessmentPanel } from './FormalAssessmentPanel.js';

let lessonCommandSequence = 0;

function nextCommandId(prefix: string): string {
  lessonCommandSequence += 1;
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${lessonCommandSequence}`}`;
}

export interface LessonExecutionPanelProps {
  workspaceId: string;
  sessionId: string;
  agendaItemId: string;
  active: boolean;
  busy?: boolean;
  directCheckpointItemId?: string | null;
  formalAssessmentVersionId?: string | null;
  onResumeStudySession?: () => void;
  onStartFormalAssessment?: () => void;
  onSessionVersionChange?: (projection: LessonExecutionProjection) => void;
  onRefreshSession?: () => void;
}

function learnerMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case 'VERSION_CONFLICT':
        return '学习路线刚刚发生变化。正在重新读取当前讲解位置。';
      case 'PROVIDER_TIMEOUT':
        return '讲解准备花的时间比预期长，原有学习记录没有被替换。你可以稍后重试。';
      case 'PROVIDER_ERROR':
      case 'PROVIDER_INVALID_OUTPUT':
        return '这次讲解暂时没有准备好。原有学习记录没有被替换，你可以重试。';
      case 'ABORTED':
        return '';
      default:
        return '讲解暂时不可用，请稍后再试。';
    }
  }
  return '讲解暂时不可用，请稍后再试。';
}

function presentationStateLabel(state: LessonExecutionProjection['progress']): string {
  if (!state) return '尚未开始';
  switch (state.presentationStatus) {
    case 'presentation_completed':
      return '讲解已完成';
    case 'summary_ready':
      return '可以查看总结';
    case 'in_progress':
      return '学习中';
    default:
      return '尚未开始';
  }
}

const PURPOSE_LABELS: Record<LessonSegmentProjection['purpose'], string> = {
  orientation: '导入',
  explanation: '核心解释',
  mechanism: '运作机制',
  worked_example: '示例',
  comparison: '对比',
  common_pitfall: '常见误区',
  guided_practice: '练习',
};

function originLabel(origin: LessonSegmentProjection['explanationOrigin']): string {
  return origin === 'source_grounded' ? '来源原文' : 'Hy3 讲解补充';
}

function formatSourceLocation(source: LessonSourceProjection): string {
  if (source.pageNumber !== null) return `第 ${source.pageNumber} 页`;
  if (source.slideNumber !== null) return `第 ${source.slideNumber} 张幻灯片`;
  if (source.headingPath.length > 0) return source.headingPath.join(' › ');
  return source.locationLabel;
}

/** Compact, learner-safe provenance interaction reusable by lesson and later Tutor surfaces. */
export function LessonSourceReference({ source }: { source: LessonSourceProjection }) {
  return (
    <details className="lesson-source-reference">
      <summary aria-label={`查看来源：${source.materialTitle}，${formatSourceLocation(source)}`}>
        <span className="lesson-source-chip">来源</span>
        <span>{source.materialTitle}</span>
        <span className="lesson-source-location">{formatSourceLocation(source)}</span>
      </summary>
      <div className="lesson-source-detail">
        <strong>{source.materialTitle}</strong>
        <span>{source.locationLabel}</span>
        <blockquote>{source.exactExcerpt}</blockquote>
        <small>这是支撑当前讲解的原文摘录；讲解本身仍可能包含 Hy3 的教学组织。</small>
      </div>
    </details>
  );
}

function SourceReferences({
  sources,
  origin,
}: {
  sources: LessonSourceProjection[];
  origin: LessonSegmentProjection['explanationOrigin'];
}) {
  return (
    <div className="lesson-origin-block">
      <span className={`lesson-origin-label ${origin}`}>{originLabel(origin)}</span>
      {sources.length > 0 ? (
        <div className="lesson-source-list" aria-label="本段来源">
          {sources.map((source) => (
            <LessonSourceReference
              key={`${source.materialTitle}:${source.locationLabel}`}
              source={source}
            />
          ))}
        </div>
      ) : origin === 'hy3_synthesis' ? (
        <span className="lesson-no-source">基于课程材料的教学组织</span>
      ) : null}
    </div>
  );
}

function Illustration({
  label,
  value,
}: {
  label: string;
  value:
    | NonNullable<LessonSegmentProjection['example']>
    | NonNullable<LessonSegmentProjection['contrast']>;
}) {
  return (
    <aside className="lesson-illustration">
      <strong>{label}</strong>
      <p>{value.text}</p>
      <SourceReferences sources={value.sources} origin={value.origin} />
    </aside>
  );
}

function InformalCheck({
  segment,
  response,
  disabled,
  submitting,
  onResponseChange,
  onSubmit,
}: {
  segment: LessonSegmentProjection;
  response: string;
  disabled: boolean;
  submitting: boolean;
  onResponseChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const check = segment.informalCheck;
  if (!check) return null;
  const responded = Boolean(check.response);
  return (
    <section className="lesson-informal-check" aria-label="练习理解检查">
      <div className="lesson-informal-heading">
        <span className="lesson-check-mark" aria-hidden="true">
          ?
        </span>
        <div>
          <strong>练习理解一下</strong>
          <span>非正式检查 · 不计入正式进展</span>
        </div>
      </div>
      <p>{check.prompt}</p>
      {check.guidance ? <p className="small muted">提示：{check.guidance}</p> : null}
      {responded ? (
        <p className="lesson-check-recorded" role="status">
          已记录你的练习回应。这不会创建正式证据，也不会改变掌握状态。
        </p>
      ) : (
        <>
          <label htmlFor={`lesson-check-${segment.index}`} className="sr-only">
            练习回应
          </label>
          <textarea
            id={`lesson-check-${segment.index}`}
            value={response}
            disabled={disabled}
            onChange={(event) => onResponseChange(event.target.value)}
            placeholder="用自己的话写下想法即可"
            rows={3}
          />
          <button
            type="button"
            className="secondary"
            disabled={disabled || response.trim().length === 0}
            aria-busy={submitting}
            onClick={onSubmit}
          >
            {submitting ? '正在记录…' : '提交练习回应'}
          </button>
        </>
      )}
    </section>
  );
}

function ReadyLesson({
  projection,
  active,
  busy,
  responseDraft,
  commandLoading,
  onAction,
  onResponseChange,
}: {
  projection: LessonExecutionProjection;
  active: boolean;
  busy: boolean;
  responseDraft: string;
  commandLoading: boolean;
  onAction: (action: LessonExecutionCommandRequest['action']) => void;
  onResponseChange: (value: string) => void;
}) {
  const lesson = projection.lesson!;
  const progress = projection.progress!;
  const currentIndex = progress.currentSegmentIndex;
  const presented = new Set(progress.presentedSegmentIndexes);
  const completed = progress.presentationStatus === 'presentation_completed';
  const canStart = projection.allowedActions.includes('start_lesson');
  const canNext = projection.allowedActions.includes('move_to_next_segment');
  const canRevisit = projection.allowedActions.includes('revisit_segment');
  const canComplete = projection.allowedActions.includes('complete_presentation');

  return (
    <>
      <header className="lesson-player-header">
        <div>
          <p className="eyebrow">本节讲解</p>
          <h3>{lesson.objective.title}</h3>
          <p className="lesson-player-status" role="status">
            {presentationStateLabel(projection.progress)} · 已呈现 {presented.size}/
            {lesson.segments.length} 个部分
          </p>
        </div>
        <div className="lesson-segment-progress" aria-label="讲解进度">
          {lesson.segments.map((segment) => (
            <button
              type="button"
              key={segment.index}
              className={
                segment.index === currentIndex
                  ? 'current'
                  : presented.has(segment.index)
                    ? 'presented'
                    : ''
              }
              aria-label={`第 ${segment.index + 1} 部分${segment.index === currentIndex ? '，当前' : ''}`}
              aria-current={segment.index === currentIndex ? 'step' : undefined}
              disabled={
                busy || !active || (!presented.has(segment.index) && segment.index !== currentIndex)
              }
              onClick={() => onAction({ kind: 'move_to_segment', segmentIndex: segment.index })}
            >
              {segment.index + 1}
            </button>
          ))}
        </div>
      </header>

      <section className="lesson-objective" aria-label="本节目标">
        <div>
          <h4>本节目标</h4>
          <ul>
            {lesson.objective.outcomes.map((outcome) => (
              <li key={outcome.title}>
                <strong>{outcome.title}</strong>
                <span>{outcome.description}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="lesson-why-now">
          <h4>为什么现在学</h4>
          <p>{lesson.objective.whyNow}</p>
        </div>
      </section>

      {lesson.prerequisites.length > 0 ? (
        <details className="lesson-prerequisites">
          <summary>先备背景</summary>
          <ul>
            {lesson.prerequisites.map((prerequisite) => (
              <li key={prerequisite.title}>
                <strong>{prerequisite.title}</strong>
                <span>{prerequisite.reason}</span>
                {prerequisite.readinessHint ? <small>{prerequisite.readinessHint}</small> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canStart ? (
        <div className="lesson-start-callout">
          <p>准备好后，从第一部分开始。你可以随时回看已经呈现的内容。</p>
          <button
            type="button"
            className="primary"
            disabled={!active || busy}
            onClick={() => onAction({ kind: 'start_lesson' })}
          >
            开始本节讲解
          </button>
        </div>
      ) : null}

      <ol className="lesson-segment-list" aria-label="有序讲解内容">
        {lesson.segments.map((segment) => {
          const isCurrent = segment.index === currentIndex;
          const isPresented = presented.has(segment.index);
          return (
            <li
              key={segment.index}
              className={`lesson-segment ${isCurrent ? 'current' : ''} ${isPresented ? 'presented' : 'upcoming'}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <div className="lesson-segment-heading">
                <span className="lesson-segment-number">{segment.index + 1}</span>
                <div>
                  <p className="eyebrow">{PURPOSE_LABELS[segment.purpose]}</p>
                  <h4>{isCurrent ? '当前部分' : `第 ${segment.index + 1} 部分`}</h4>
                </div>
                {isPresented ? <span className="lesson-segment-state">已呈现</span> : null}
              </div>
              <p className="lesson-segment-explanation">{segment.explanation}</p>
              <SourceReferences sources={segment.sources} origin={segment.explanationOrigin} />
              {segment.example ? <Illustration label="教学示例" value={segment.example} /> : null}
              {segment.contrast ? <Illustration label="对比一下" value={segment.contrast} /> : null}
              {segment.possibleMisconception ? (
                <aside className="lesson-misconception">
                  <strong>可能混淆的地方</strong>
                  <p>{segment.possibleMisconception.hypothesis}</p>
                  <p>{segment.possibleMisconception.correction}</p>
                  <SourceReferences
                    sources={segment.possibleMisconception.sources}
                    origin="source_grounded"
                  />
                  <small>这是提醒，不是对你的判断。</small>
                </aside>
              ) : null}
              {isCurrent ? (
                <InformalCheck
                  segment={segment}
                  response={responseDraft}
                  disabled={!active || busy || commandLoading}
                  submitting={commandLoading}
                  onResponseChange={onResponseChange}
                  onSubmit={() =>
                    onAction({
                      kind: 'respond_to_informal_check',
                      segmentIndex: segment.index,
                      response: responseDraft.trim(),
                    })
                  }
                />
              ) : null}
              {isCurrent && !completed ? (
                <div className="lesson-segment-actions">
                  {canRevisit && currentIndex > 0 ? (
                    <button
                      type="button"
                      disabled={!active || busy || commandLoading}
                      onClick={() =>
                        onAction({ kind: 'move_to_segment', segmentIndex: currentIndex - 1 })
                      }
                    >
                      回看上一部分
                    </button>
                  ) : null}
                  {canNext ? (
                    <button
                      type="button"
                      className="primary"
                      disabled={!active || busy || commandLoading}
                      onClick={() =>
                        onAction({ kind: 'move_to_segment', segmentIndex: currentIndex + 1 })
                      }
                    >
                      继续到下一部分
                    </button>
                  ) : null}
                  {canComplete ? (
                    <button
                      type="button"
                      className="primary"
                      disabled={!active || busy || commandLoading}
                      onClick={() => onAction({ kind: 'complete_presentation' })}
                    >
                      完成本节讲解
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {lesson.summary.available &&
      (completed || progress.presentationStatus === 'summary_ready') ? (
        <section className="lesson-summary" aria-label="本节总结">
          <p className="eyebrow">本节总结</p>
          {lesson.summary.text ? <p>{lesson.summary.text}</p> : null}
          {lesson.summary.nextConnection ? (
            <div className="lesson-next-connection">
              <strong>接下来</strong>
              <p>{lesson.summary.nextConnection}</p>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

export function LessonExecutionPanel({
  workspaceId,
  sessionId,
  agendaItemId,
  active,
  busy = false,
  directCheckpointItemId = null,
  formalAssessmentVersionId = null,
  onResumeStudySession,
  onStartFormalAssessment,
  onSessionVersionChange,
  onRefreshSession,
}: LessonExecutionPanelProps) {
  const [projection, setProjection] = useState<LessonExecutionProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [commandLoading, setCommandLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [responseDraft, setResponseDraft] = useState('');
  const requestEpoch = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const prepareKey = useRef<string | null>(null);
  const prepareController = useRef<AbortController | null>(null);
  const commandController = useRef<AbortController | null>(null);

  const applyProjection = useCallback(
    (next: LessonExecutionProjection) => {
      setProjection(next);
      setError(null);
      onSessionVersionChange?.(next);
    },
    [onSessionVersionChange],
  );

  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const epoch = ++requestEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.getLessonExecution(workspaceId, sessionId, controller.signal);
      if (!controller.signal.aborted && epoch === requestEpoch.current) applyProjection(next);
    } catch (cause) {
      if (!controller.signal.aborted && epoch === requestEpoch.current) {
        const message = learnerMessage(cause);
        if (message) setError(message);
        if (cause instanceof ApiClientError && cause.code === 'VERSION_CONFLICT') {
          onRefreshSession?.();
        }
      }
    } finally {
      if (refreshController.current === controller) refreshController.current = null;
      if (!controller.signal.aborted && epoch === requestEpoch.current) setLoading(false);
    }
  }, [applyProjection, onRefreshSession, sessionId, workspaceId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestEpoch.current += 1;
      refreshController.current?.abort();
      prepareController.current?.abort();
      commandController.current?.abort();
    };
  }, [refresh, agendaItemId]);

  useEffect(() => {
    if (projection?.status !== 'preparing') return;
    const timer = window.setTimeout(() => void refresh(), 1500);
    return () => window.clearTimeout(timer);
  }, [projection?.status, refresh]);

  const prepare = useCallback(
    async (retry = false) => {
      if (!projection || preparing || prepareController.current) return;
      const key = `${workspaceId}:${sessionId}:${agendaItemId}:${projection.session.version}:${projection.agenda?.version ?? 0}`;
      if (!retry && prepareKey.current === key) return;
      prepareKey.current = key;
      const commandId = nextCommandId('lesson_prepare');
      const input: EnsureLessonExecutionRequest = {
        command: { commandId, idempotencyKey: commandId, workspaceId, actor: 'learner' },
        expectedSessionVersion: projection.session.version,
        expectedAgendaVersion: projection.agenda?.version ?? 1,
        expectedAgendaItemId: agendaItemId,
      };
      const controller = new AbortController();
      prepareController.current = controller;
      setPreparing(true);
      setError(null);
      try {
        const next = await api.prepareLessonExecution(
          workspaceId,
          sessionId,
          input,
          controller.signal,
        );
        if (!controller.signal.aborted) applyProjection(next);
      } catch (cause) {
        if (!controller.signal.aborted) {
          const message = learnerMessage(cause);
          if (message) setError(message);
          if (cause instanceof ApiClientError && cause.code === 'VERSION_CONFLICT') {
            onRefreshSession?.();
            void refresh();
          }
        }
      } finally {
        if (prepareController.current === controller) prepareController.current = null;
        if (!controller.signal.aborted) setPreparing(false);
      }
    },
    [
      agendaItemId,
      applyProjection,
      onRefreshSession,
      preparing,
      projection,
      refresh,
      sessionId,
      workspaceId,
    ],
  );

  useEffect(() => {
    if (projection?.status === 'preparation_needed') void prepare();
  }, [prepare, projection?.status]);

  const command = useCallback(
    async (action: LessonExecutionCommandRequest['action']) => {
      if (!projection?.progress || commandLoading || commandController.current) return;
      if (!active || projection.status !== 'ready') return;
      const commandId = nextCommandId('lesson_command');
      const input: LessonExecutionCommandRequest = {
        command: { commandId, idempotencyKey: commandId, workspaceId, actor: 'learner' },
        expectedSessionVersion: projection.session.version,
        expectedAgendaVersion: projection.agenda?.version ?? 1,
        expectedAgendaItemId: agendaItemId,
        expectedLessonStateVersion: projection.progress.stateVersion,
        action,
      };
      const controller = new AbortController();
      commandController.current = controller;
      setCommandLoading(true);
      setError(null);
      try {
        const next = await api.lessonExecutionCommand(
          workspaceId,
          sessionId,
          input,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setResponseDraft('');
          applyProjection(next);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          const message = learnerMessage(cause);
          if (message) setError(message);
          if (cause instanceof ApiClientError && cause.code === 'VERSION_CONFLICT') {
            onRefreshSession?.();
            void refresh();
          }
        }
      } finally {
        if (commandController.current === controller) commandController.current = null;
        if (!controller.signal.aborted) setCommandLoading(false);
      }
    },
    [
      active,
      agendaItemId,
      applyProjection,
      commandLoading,
      onRefreshSession,
      projection,
      refresh,
      sessionId,
      workspaceId,
    ],
  );

  if (loading && !projection) {
    return (
      <section className="lesson-execution-panel" aria-label="本节讲解">
        <Loading label="正在读取本节讲解…" />
      </section>
    );
  }

  if (error && !projection) {
    return (
      <section className="lesson-execution-panel" aria-label="本节讲解">
        <div className="lesson-error-state" role="alert">
          <strong>{error}</strong>
          <button type="button" className="primary" onClick={() => void refresh()}>
            重新读取讲解
          </button>
        </div>
      </section>
    );
  }

  if (!projection) return null;

  if (projection.status === 'lesson_unavailable') {
    return (
      <section className="lesson-execution-panel" aria-label="本节讲解">
        <div className="lesson-empty-state">
          <p className="eyebrow">当前安排</p>
          <h3>这项内容暂时没有可展示的讲解</h3>
          <p>请从学习安排选择一个可教的学习单元，或稍后重新读取当前课程。</p>
          <button type="button" onClick={() => void refresh()}>
            重新读取安排
          </button>
        </div>
      </section>
    );
  }

  if (
    projection.status === 'preparing' ||
    preparing ||
    projection.status === 'preparation_needed'
  ) {
    return (
      <section className="lesson-execution-panel" aria-label="本节讲解">
        <div className="lesson-preparing-state">
          <p className="eyebrow">本节讲解</p>
          <h3>正在准备一节有顺序的讲解</h3>
          <Loading label="正在整理目标、示例和来源…" />
          <p className="small muted">你不需要手动生成讲义；准备完成后会自动显示在这里。</p>
        </div>
      </section>
    );
  }

  if (projection.status === 'retry_available') {
    return (
      <section className="lesson-execution-panel" aria-label="本节讲解">
        <div className="lesson-error-state">
          <p className="eyebrow">本节讲解</p>
          <h3>讲解还没有准备好</h3>
          <p>{error ?? '这次准备没有完成，但已有的学习记录保持不变。'}</p>
          <button
            type="button"
            className="primary"
            disabled={!active || busy || preparing}
            onClick={() => void prepare(true)}
          >
            重新准备本节讲解
          </button>
        </div>
      </section>
    );
  }

  const completed = projection.progress?.presentationStatus === 'presentation_completed';
  return (
    <section
      className={`lesson-execution-panel ${completed ? 'is-complete' : ''}`}
      aria-label="本节讲解"
    >
      {error ? (
        <div className="lesson-inline-error" role="alert">
          {error}
        </div>
      ) : null}
      <ReadyLesson
        projection={projection}
        active={active}
        busy={busy}
        responseDraft={responseDraft}
        commandLoading={commandLoading}
        onAction={(action) => void command(action)}
        onResponseChange={setResponseDraft}
      />
      {formalAssessmentVersionId ? (
        <FormalAssessmentPanel
          workspaceId={workspaceId}
          versionId={formalAssessmentVersionId}
          onChanged={onRefreshSession}
        />
      ) : null}
      {projection.session.status === 'paused' ? (
        <div className="lesson-paused-state" role="status">
          <strong>本次学习已暂停</strong>
          <p>继续本次学习后，才能记录新的讲解位置。</p>
          {onResumeStudySession ? (
            <button type="button" className="primary" onClick={onResumeStudySession}>
              继续学习
            </button>
          ) : null}
        </div>
      ) : null}
      {completed ? (
        <section className="lesson-handoff" aria-label="正式学习入口">
          <div>
            <p className="eyebrow">讲解完成</p>
            <h3>接下来可以进行正式检验</h3>
            <p>完成讲解只表示你走完了本节教学顺序，不代表已经掌握，也不会自动推进学习安排。</p>
          </div>
          {directCheckpointItemId && onStartFormalAssessment ? (
            <button
              type="button"
              className="primary"
              disabled={!active || busy}
              onClick={onStartFormalAssessment}
            >
              开始正式检验
            </button>
          ) : (
            <p className="small muted">当前安排还没有可直接进入的正式检验入口。</p>
          )}
        </section>
      ) : null}
    </section>
  );
}
