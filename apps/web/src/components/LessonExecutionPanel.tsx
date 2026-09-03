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
  reviewMode?: boolean;
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

function originLabel(origin: LessonSegmentProjection['explanationOrigin']): string {
  return origin === 'source_grounded' ? '资料支持' : 'Hy3 补充讲解';
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
        <span className="lesson-no-source">补充知识 · 不作为资料证据</span>
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
  const options = check.options ?? [];
  const isChoice = check.kind === 'choose' && options.length > 0;
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
      {responded ? (
        <div className="lesson-check-recorded" role="status">
          {isChoice && check.correct !== null && check.correct !== undefined ? (
            <strong>{check.correct ? '回答正确' : '再检查一下你的判断'}</strong>
          ) : (
            <strong>已记录你的想法</strong>
          )}
          {check.feedback ? <p>{check.feedback}</p> : null}
          {check.guidance ? <p className="small muted">讲解提示：{check.guidance}</p> : null}
          {!isChoice ? <p className="small muted">这是反思性检查，系统不会假装判定正误。</p> : null}
          <p className="small muted">非正式检查不会创建正式证据，也不会改变掌握状态。</p>
        </div>
      ) : (
        <>
          {isChoice ? (
            <div className="lesson-check-options" role="radiogroup" aria-label="选择一个答案">
              {options.map((option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={response === option.id}
                  className={response === option.id ? 'selected' : ''}
                  key={option.id}
                  disabled={disabled}
                  onClick={() => onResponseChange(option.id)}
                >
                  {option.text}
                </button>
              ))}
            </div>
          ) : (
            <>
              <label htmlFor={`lesson-check-${segment.index}`} className="sr-only">
                练习回应
              </label>
              {check.kind === 'predict' ? (
                <input
                  id={`lesson-check-${segment.index}`}
                  value={response}
                  disabled={disabled}
                  onChange={(event) => onResponseChange(event.target.value)}
                  placeholder="先写下你的预测"
                />
              ) : (
                <textarea
                  id={`lesson-check-${segment.index}`}
                  value={response}
                  disabled={disabled}
                  onChange={(event) => onResponseChange(event.target.value)}
                  placeholder="用自己的话写下想法即可"
                  rows={3}
                />
              )}
            </>
          )}
          <button
            type="button"
            className="secondary"
            disabled={disabled || response.trim().length === 0}
            aria-busy={submitting}
            onClick={onSubmit}
          >
            {submitting ? '正在记录…' : isChoice ? '提交选择' : '提交练习回应'}
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
  readOnly = false,
  responseDraft,
  commandLoading,
  onAction,
  onResponseChange,
}: {
  projection: LessonExecutionProjection;
  active: boolean;
  busy: boolean;
  readOnly?: boolean;
  responseDraft: string;
  commandLoading: boolean;
  onAction: (action: LessonExecutionCommandRequest['action']) => void;
  onResponseChange: (value: string) => void;
}) {
  const lesson = projection.lesson!;
  const progress = projection.progress!;
  const currentIndex = progress.currentSegmentIndex;
  const presented = new Set(progress.presentedSegmentIndexes);
  const presentationCompleted = progress.presentationStatus === 'presentation_completed';
  const canStart = !readOnly && projection.allowedActions.includes('start_lesson');
  const canNext = !readOnly && projection.allowedActions.includes('move_to_next_segment');
  const canRevisit = !readOnly && projection.allowedActions.includes('revisit_segment');
  const canComplete = !readOnly && projection.allowedActions.includes('complete_presentation');

  return (
    <>
      <header className="lesson-player-header">
        <div>
          <p className="eyebrow">本节讲解</p>
          <h3>{lesson.objective.title}</h3>
          <p className="lesson-player-status" role="status">
            {readOnly ? (
              '讲解内容已接受 · 等待非正式练习'
            ) : (
              <>
                {presentationStateLabel(projection.progress)} · 已呈现 {presented.size}/
                {lesson.segments.length} 个部分
              </>
            )}
          </p>
          {lesson.plannedTime ? (
            <p className="small muted">
              安排约 {lesson.plannedTime.agendaMinutes}{' '}
              分钟；按讲解、推理示例与主动练习，本地评估为约 {lesson.plannedTime.activeMinutesMin}–
              {lesson.plannedTime.activeMinutesMax} 分钟。
            </p>
          ) : null}
        </div>
        {!readOnly ? (
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
                  busy ||
                  !active ||
                  (!presented.has(segment.index) && segment.index !== currentIndex)
                }
                onClick={() => onAction({ kind: 'move_to_segment', segmentIndex: segment.index })}
              >
                {segment.index + 1}
              </button>
            ))}
          </div>
        ) : null}
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

      <div className="lesson-segment-list" aria-label="连贯讲解内容">
        {lesson.segments.map((segment) => {
          const isCurrent = !readOnly && segment.index === currentIndex;
          const isPresented = !readOnly && presented.has(segment.index);
          return (
            <section
              key={segment.index}
              className={`lesson-segment ${isCurrent ? 'current' : ''} ${isPresented ? 'presented' : 'upcoming'}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className="sr-only">讲解第 {segment.index + 1} 部分</span>
              <p className="lesson-segment-explanation">{segment.explanation}</p>
              <SourceReferences sources={segment.sources} origin={segment.explanationOrigin} />
              {segment.workedProcess ? (
                <section className="lesson-worked-process" aria-label="完整推演过程">
                  <strong>完整推演过程</strong>
                  <p>
                    <b>起始状态：</b>
                    {segment.workedProcess.startingState}
                  </p>
                  <p>
                    <b>依据的规则或流程：</b>
                    {segment.workedProcess.ruleOrProcedure}
                  </p>
                  <ol>
                    {segment.workedProcess.steps.map((step, stepIndex) => (
                      <li key={stepIndex}>
                        <p>{step.action}</p>
                        <small>
                          {step.reason} → {step.resultingState}
                        </small>
                      </li>
                    ))}
                  </ol>
                  {segment.workedProcess.learnerDecision ? (
                    <p>
                      <b>需要作出的判断：</b>
                      {segment.workedProcess.learnerDecision}
                    </p>
                  ) : null}
                  <p>
                    <b>结果：</b>
                    {segment.workedProcess.result}
                  </p>
                  <p>
                    <b>为什么得到这个结果：</b>
                    {segment.workedProcess.whyResultFollows}
                  </p>
                  <SourceReferences
                    sources={segment.workedProcess.sources ?? []}
                    origin={segment.workedProcess.origin ?? 'hy3_synthesis'}
                  />
                </section>
              ) : null}
              {segment.example ? <Illustration label="教学示例" value={segment.example} /> : null}
              {segment.contrast ? <Illustration label="对比一下" value={segment.contrast} /> : null}
              {segment.possibleMisconception ? (
                <aside className="lesson-misconception">
                  <strong>可能混淆的地方</strong>
                  <p>{segment.possibleMisconception.hypothesis}</p>
                  <p>{segment.possibleMisconception.correction}</p>
                  <SourceReferences
                    sources={segment.possibleMisconception.sources}
                    origin={segment.possibleMisconception.origin ?? 'hy3_synthesis'}
                  />
                  <small>这是提醒，不是对你的判断。</small>
                </aside>
              ) : null}
              {readOnly && segment.informalCheck ? (
                <section className="lesson-informal-check" aria-label="讲解中的思考点">
                  <p className="eyebrow">讲解中的思考点</p>
                  <h5>{segment.informalCheck.prompt}</h5>
                  <p className="small muted">非正式练习准备完成后即可开始并记录回应。</p>
                </section>
              ) : isCurrent ? (
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
              {!readOnly && isCurrent && !presentationCompleted ? (
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
            </section>
          );
        })}
      </div>

      {lesson.summary.available &&
      (readOnly || presentationCompleted || progress.presentationStatus === 'summary_ready') ? (
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

      {!readOnly && projection.practice && projection.practice.status !== 'locked' ? (
        <section className="lesson-practice" aria-label="本节练习">
          <p className="eyebrow">Practice · 非正式练习</p>
          <h3>
            {projection.practice.status === 'completed'
              ? '练习完成'
              : `第 ${projection.practice.currentItemIndex + 1}/${projection.practice.itemCount} 题`}
          </h3>
          <p className="small muted">
            这里的回应只用于即时反馈，不创建正式证据，也不改变掌握度或课程进度。
          </p>
          {projection.practice.attempts.length > 0 ? (
            <div className="lesson-practice-feedback" aria-live="polite">
              {projection.practice.attempts.map((attempt) => (
                <article key={`${attempt.itemIndex}-${attempt.attemptNumber}`}>
                  <strong>{attempt.correct ? '回答正确' : '再想一步'}</strong>
                  <p>{attempt.feedback}</p>
                  {attempt.hint ? (
                    <p className="lesson-practice-hint">提示：{attempt.hint}</p>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}
          {projection.practice.item ? (
            <div className="lesson-practice-item">
              <div className="lesson-practice-purpose">
                <strong>{projection.practice.item.objectiveTitle}</strong>
                <span>检验能力：{projection.practice.item.capabilityTested}</span>
                <small>为什么练：{projection.practice.item.pedagogicalReason}</small>
              </div>
              <p className="lesson-practice-prompt">{projection.practice.item.prompt}</p>
              <div className="lesson-practice-options">
                {projection.practice.item.options.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    disabled={!active || busy || commandLoading}
                    onClick={() =>
                      onAction({
                        kind: 'submit_practice_response',
                        itemIndex: projection.practice!.item!.index,
                        optionId: option.id,
                      })
                    }
                  >
                    {option.text}
                  </button>
                ))}
              </div>
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
  reviewMode = false,
  onResumeStudySession,
  onStartFormalAssessment,
  onSessionVersionChange,
  onRefreshSession,
}: LessonExecutionPanelProps) {
  const routeIdentity = JSON.stringify([workspaceId, sessionId, agendaItemId]);
  const [projectionState, setProjectionState] = useState<{
    routeIdentity: string;
    value: LessonExecutionProjection;
  } | null>(null);
  const projection =
    projectionState?.routeIdentity === routeIdentity ? projectionState.value : null;
  const routeTransitioning =
    projectionState !== null && projectionState.routeIdentity !== routeIdentity;
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [commandLoading, setCommandLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [responseDraft, setResponseDraft] = useState('');
  const routeEpoch = useRef(0);
  const requestEpoch = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const prepareKey = useRef<string | null>(null);
  const prepareController = useRef<AbortController | null>(null);
  const commandController = useRef<AbortController | null>(null);

  const applyProjection = useCallback(
    (next: LessonExecutionProjection) => {
      setProjectionState({ routeIdentity, value: next });
      setError(null);
      onSessionVersionChange?.(next);
    },
    [onSessionVersionChange, routeIdentity],
  );

  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const epoch = routeEpoch.current;
    const refreshEpoch = ++requestEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.getLessonExecution(workspaceId, sessionId, controller.signal);
      if (
        !controller.signal.aborted &&
        epoch === routeEpoch.current &&
        refreshEpoch === requestEpoch.current
      ) {
        applyProjection(next);
      }
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        epoch === routeEpoch.current &&
        refreshEpoch === requestEpoch.current
      ) {
        const message = learnerMessage(cause);
        if (message) setError(message);
        if (cause instanceof ApiClientError && cause.code === 'VERSION_CONFLICT') {
          onRefreshSession?.();
        }
      }
    } finally {
      if (refreshController.current === controller) refreshController.current = null;
      if (epoch === routeEpoch.current && refreshEpoch === requestEpoch.current) setLoading(false);
    }
  }, [applyProjection, onRefreshSession, sessionId, workspaceId]);

  useEffect(() => {
    routeEpoch.current += 1;
    requestEpoch.current += 1;
    refreshController.current?.abort();
    prepareController.current?.abort();
    commandController.current?.abort();
    refreshController.current = null;
    prepareController.current = null;
    commandController.current = null;
    prepareKey.current = null;
    setProjectionState(null);
    setLoading(true);
    setPreparing(false);
    setCommandLoading(false);
    setError(null);
    setResponseDraft('');

    return () => {
      routeEpoch.current += 1;
      requestEpoch.current += 1;
      refreshController.current?.abort();
      prepareController.current?.abort();
      commandController.current?.abort();
      refreshController.current = null;
      prepareController.current = null;
      commandController.current = null;
    };
  }, [routeIdentity]);

  useEffect(() => {
    void refresh();
  }, [refresh, routeIdentity]);

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
      const epoch = routeEpoch.current;
      setPreparing(true);
      setError(null);
      try {
        const next = await api.prepareLessonExecution(
          workspaceId,
          sessionId,
          input,
          controller.signal,
        );
        if (!controller.signal.aborted && epoch === routeEpoch.current) applyProjection(next);
      } catch (cause) {
        if (!controller.signal.aborted && epoch === routeEpoch.current) {
          const message = learnerMessage(cause);
          if (message) setError(message);
          if (cause instanceof ApiClientError && cause.code === 'VERSION_CONFLICT') {
            onRefreshSession?.();
            void refresh();
          }
        }
      } finally {
        if (prepareController.current === controller) prepareController.current = null;
        if (epoch === routeEpoch.current) setPreparing(false);
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
      const epoch = routeEpoch.current;
      setCommandLoading(true);
      setError(null);
      try {
        const next = await api.lessonExecutionCommand(
          workspaceId,
          sessionId,
          input,
          controller.signal,
        );
        if (!controller.signal.aborted && epoch === routeEpoch.current) {
          setResponseDraft('');
          applyProjection(next);
        }
      } catch (cause) {
        if (!controller.signal.aborted && epoch === routeEpoch.current) {
          const message = learnerMessage(cause);
          if (message) setError(message);
          if (cause instanceof ApiClientError && cause.code === 'VERSION_CONFLICT') {
            onRefreshSession?.();
            void refresh();
          }
        }
      } finally {
        if (commandController.current === controller) commandController.current = null;
        if (epoch === routeEpoch.current) setCommandLoading(false);
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

  if ((loading || routeTransitioning) && !projection) {
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
    if (formalAssessmentVersionId) {
      return (
        <section className="lesson-execution-panel formal-only" aria-label="正式学习活动">
          <FormalAssessmentPanel
            workspaceId={workspaceId}
            versionId={formalAssessmentVersionId}
            reviewMode={reviewMode}
            onChanged={onRefreshSession}
          />
        </section>
      );
    }
    if (reviewMode && directCheckpointItemId && onStartFormalAssessment) {
      return (
        <section className="lesson-execution-panel formal-only" aria-label="到期复习">
          <div className="lesson-empty-state">
            <p className="eyebrow">到期复习</p>
            <h3>先用一次独立回忆确认这项目标</h3>
            <p>系统会准备一题有当前课程来源依据的正式简答题。</p>
            <button
              type="button"
              className="primary"
              disabled={!active || busy}
              onClick={onStartFormalAssessment}
            >
              开始到期复习
            </button>
          </div>
        </section>
      );
    }
    const preparationBlocked = projection.message.includes('来源绑定');
    return (
      <section className="lesson-execution-panel" aria-label="本节讲解">
        <div className="lesson-empty-state">
          <p className="eyebrow">当前安排</p>
          <h3>{preparationBlocked ? '当前讲解无法安全准备' : '这项内容暂时没有可展示的讲解'}</h3>
          <p>{projection.message}</p>
          {preparationBlocked ? (
            <p className="small muted">请使用课程导航回到课程主页，重新准备当前课程路线。</p>
          ) : (
            <button type="button" onClick={() => void refresh()}>
              重新读取安排
            </button>
          )}
        </div>
      </section>
    );
  }

  if (projection.status === 'practice_retry_available') {
    return (
      <section className="lesson-execution-panel" aria-label="本节讲解">
        <div className={preparing ? 'lesson-preparing-state' : 'lesson-error-state'} role="status">
          <p className="eyebrow">Practice · 非正式练习</p>
          <h3>{preparing ? '正在重新准备非正式练习' : '讲解已安全保存，练习还需要重试'}</h3>
          {preparing ? (
            <>
              <Loading label="正在根据已接受的讲解准备非正式练习…" />
              <p className="small muted">只会重新准备练习；下方已接受的讲解保持不变。</p>
            </>
          ) : (
            <>
              <p>{error ?? projection.message}</p>
              <button
                type="button"
                className="primary"
                disabled={!active || busy}
                onClick={() => void prepare(true)}
              >
                重新准备非正式练习
              </button>
            </>
          )}
        </div>
        {projection.lesson && projection.progress ? (
          <ReadyLesson
            projection={projection}
            active={false}
            busy={busy}
            readOnly
            responseDraft=""
            commandLoading={false}
            onAction={(action) => void command(action)}
            onResponseChange={() => undefined}
          />
        ) : null}
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

  const completed = projection.practice?.status === 'completed';
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
      {formalAssessmentVersionId && completed ? (
        <FormalAssessmentPanel
          workspaceId={workspaceId}
          versionId={formalAssessmentVersionId}
          reviewMode={reviewMode}
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
            <p className="eyebrow">Lesson 与 Practice 完成</p>
            <h3>接下来可以进行正式检验</h3>
            <p>
              完成讲解与非正式练习不代表已经掌握，也不会自动推进学习安排；正式检验仍是一个明确、独立的动作。
            </p>
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
            <p className="small muted">
              当前目标还没有可用的正式检验入口。讲解完成不会自动生成正式证据；课程会保留这一限制，直到有可验证的来源依据和正式路线。
            </p>
          )}
        </section>
      ) : null}
    </section>
  );
}
