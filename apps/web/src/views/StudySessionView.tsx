import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MixedInitiativeCommandRequest,
  PublicQuiz,
  StudyExchange,
  StudySession,
  StudySessionDetailResponse,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

export interface StudySessionRoute {
  contractVersionId: string;
  curriculumVersionId: string;
  studyPlanVersionId: string;
  sessionAgendaId: string;
  executionVersion: number;
}

export interface StudySessionViewProps {
  workspaceId: string | null;
  route: StudySessionRoute | null;
  curriculumUnits?: Array<{ id: string; title: string }>;
  onSessionChanged?: () => void;
  onLaunchQuiz?: (quiz: PublicQuiz) => void;
}

let commandSequence = 0;

function commandId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${commandSequence}`}`;
}

/**
 * The persisted conversation surface. It deliberately renders exchanges as
 * conversation, not as evidence or mastery state; formal progression remains
 * isolated in the assessment workflow.
 */
export function StudySessionView({
  workspaceId,
  route,
  curriculumUnits = [],
  onSessionChanged,
  onLaunchQuiz,
}: StudySessionViewProps) {
  const [detail, setDetail] = useState<StudySessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [detourLearningUnitId, setDetourLearningUnitId] = useState('');
  const epoch = useRef(0);
  const action = useAsyncAction();

  const loadSession = useCallback(
    async (targetWorkspaceId: string, sessionId: string, signal: AbortSignal) => {
      const requestEpoch = ++epoch.current;
      setLoading(true);
      setLoadError(null);
      try {
        const next = await api.getStudySession(targetWorkspaceId, sessionId, signal);
        if (!signal.aborted && requestEpoch === epoch.current) setDetail(next);
      } catch (error) {
        if (!signal.aborted && requestEpoch === epoch.current) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!signal.aborted && requestEpoch === epoch.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const requestEpoch = ++epoch.current;
    setDetail(null);
    setComposer('');
    setDetourLearningUnitId('');
    setLoadError(null);
    if (!workspaceId) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    void api
      .listStudySessions(workspaceId, controller.signal)
      .then(async ({ sessions }) => {
        if (controller.signal.aborted || requestEpoch !== epoch.current) return;
        const current = sessions.find(
          (session) => session.status === 'active' || session.status === 'paused',
        );
        if (!current) return;
        await loadSession(workspaceId, current.id, controller.signal);
      })
      .catch((error) => {
        if (!controller.signal.aborted && requestEpoch === epoch.current) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && requestEpoch === epoch.current) setLoading(false);
      });
    return () => {
      controller.abort();
      epoch.current += 1;
    };
  }, [loadSession, workspaceId]);

  function replaceSession(session: StudySession, agenda = detail?.agenda): void {
    setDetail((current) => (current && agenda ? { ...current, session, agenda } : current));
    onSessionChanged?.();
  }

  async function startSession(): Promise<void> {
    if (!workspaceId || !route) return;
    const response = await action.run((signal) =>
      api.startStudySession(
        workspaceId,
        {
          contractVersionId: route.contractVersionId,
          curriculumVersionId: route.curriculumVersionId,
          studyPlanVersionId: route.studyPlanVersionId,
          sessionAgendaId: route.sessionAgendaId,
          expectedCourseExecutionVersion: route.executionVersion,
        },
        signal,
      ),
    );
    if (!response || !workspaceId) return;
    replaceSession(response.session);
    const controller = new AbortController();
    await loadSession(workspaceId, response.session.id, controller.signal);
  }

  async function submitTurn(): Promise<void> {
    const content = composer.trim();
    if (!workspaceId || !detail || !content || detail.session.status !== 'active') return;
    const sessionId = detail.session.id;
    const expectedVersion = detail.session.version;
    setComposer('');
    const response = await action.run((signal) =>
      api.streamTutorTurn(
        workspaceId,
        sessionId,
        { commandId: commandId('tutor_turn'), expectedSessionVersion: expectedVersion, content },
        (line) => {
          if (line.kind !== 'event') return;
          setDetail((current) => {
            if (!current || current.session.id !== sessionId) return current;
            if (current.turnEvents.some((event) => event.id === line.event.id)) return current;
            return { ...current, turnEvents: [...current.turnEvents, line.event] };
          });
        },
        signal,
      ),
    );
    if (!response || detail.session.id !== sessionId) {
      const controller = new AbortController();
      await loadSession(workspaceId, sessionId, controller.signal);
      return;
    }
    setDetail((current) =>
      current?.session.id === sessionId
        ? {
            ...current,
            session: response.session,
            exchanges: [
              ...current.exchanges,
              ...response.exchanges.filter(
                (exchange) => !current.exchanges.some((stored) => stored.id === exchange.id),
              ),
            ],
            turns: [...current.turns.filter((turn) => turn.id !== response.turn.id), response.turn],
            turnEvents: [
              ...current.turnEvents,
              ...response.events.filter(
                (event) => !current.turnEvents.some((stored) => stored.id === event.id),
              ),
            ],
          }
        : current,
    );
    onSessionChanged?.();
  }

  async function mixedCommand(
    kind: MixedInitiativeCommandRequest['kind'],
    targetAgendaItemId = detail?.session.currentAgendaItemId ?? null,
  ): Promise<void> {
    if (!workspaceId || !detail || detail.session.status !== 'active') return;
    const reason = window.prompt(commandPrompt(kind))?.trim();
    if (!reason) return;
    const sessionId = detail.session.id;
    const acceptsCurriculumTarget =
      kind === 'detour' || kind === 'deep_dive' || kind === 'agenda_insert';
    const currentLearningUnitId = detail.agenda.items.find(
      (item) => item.id === targetAgendaItemId,
    )?.learningUnitId;
    const response = await action.run((signal) =>
      api.studySessionCommand(
        workspaceId,
        sessionId,
        {
          commandId: commandId(`session_${kind}`),
          expectedSessionVersion: detail.session.version,
          kind,
          targetAgendaItemId,
          targetLearningUnitId: acceptsCurriculumTarget
            ? detourLearningUnitId || currentLearningUnitId || null
            : null,
          reason,
        },
        signal,
      ),
    );
    if (!response) return;
    replaceSession(response.session, response.agenda);
    if (kind !== 'direct_checkpoint' || !targetAgendaItemId) return;
    const launchCommandId = commandId('launch_direct_checkpoint');
    const launched = await action.run((signal) =>
      api.launchAgendaItem(
        workspaceId,
        response.agenda.id,
        targetAgendaItemId,
        {
          command: {
            commandId: launchCommandId,
            idempotencyKey: launchCommandId,
            workspaceId,
            actor: 'learner',
          },
          agendaId: response.agenda.id,
          expectedAgendaVersion: response.agenda.version,
          agendaItemId: targetAgendaItemId,
          expectedContractId: response.session.contractVersionId,
          expectedStudyPlanId: response.session.studyPlanVersionId,
          expectedExecutionSourceManifestFingerprint:
            response.session.executionSourceManifestFingerprint,
          studySessionId: sessionId,
        },
        signal,
      ),
    );
    if (launched?.kind === 'assessment') onLaunchQuiz?.(launched.quiz);
  }

  async function lifecycle(actionKind: 'pause' | 'resume' | 'stop'): Promise<void> {
    if (!workspaceId || !detail) return;
    const sessionId = detail.session.id;
    const input = {
      commandId: commandId(`session_${actionKind}`),
      expectedSessionVersion: detail.session.version,
    };
    const operation =
      actionKind === 'pause'
        ? api.pauseStudySession
        : actionKind === 'resume'
          ? api.resumeStudySession
          : api.stopStudySession;
    const response = await action.run((signal) => operation(workspaceId, sessionId, input, signal));
    if (response) replaceSession(response.session, response.agenda);
  }

  if (!workspaceId) return <Banner kind="empty">请先选择课程，再进入学习。</Banner>;
  if (loading && !detail) return <Loading label="加载学习记录…" />;
  if (loadError && !detail) return <Banner kind="error">{loadError}</Banner>;

  if (!detail) {
    return (
      <section className="study-session-empty" aria-label="学习">
        <h3>学习</h3>
        <p className="muted">
          学习会从已接受的路线开始。Tutor 对话和非正式检查不会自动改变掌握状态或完成学习单元。
        </p>
        {!route ? (
          <Banner kind="info">
            还没有可执行的学习路线。请先回到主页设置目标，并查看、接受学习路线。
          </Banner>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={action.loading}
            onClick={() => void startSession()}
          >
            {action.loading ? '正在开始…' : '开始学习'}
          </button>
        )}
        {action.error ? <Banner kind="error">{action.error}</Banner> : null}
      </section>
    );
  }

  const { session } = detail;
  const currentAgendaItem = detail.agenda.items.find(
    (item) => item.id === session.currentAgendaItemId,
  );
  const currentLearningUnit = curriculumUnits.find(
    (unit) => unit.id === currentAgendaItem?.learningUnitId,
  );
  const directCheckpointItem = detail.agenda.items.find(
    (item) =>
      (item.kind === 'formal_checkpoint' ||
        item.kind === 'synthesis' ||
        item.kind === 'due_review' ||
        item.kind === 'targeted_repair') &&
      item.state !== 'completed' &&
      item.state !== 'deferred' &&
      item.state !== 'cancelled' &&
      item.launch.status === 'launchable',
  );
  const currentTurn = detail.turns.at(-1) ?? null;
  const active = session.status === 'active';
  const canPromoteCurrentDetour = Boolean(
    active &&
    currentAgendaItem?.state === 'active' &&
    currentAgendaItem.origin === 'learner_detour' &&
    currentAgendaItem.learningUnitId,
  );
  return (
    <div className="study-session" aria-label="学习">
      {loadError ? <Banner kind="error">{loadError}</Banner> : null}
      {action.error ? <Banner kind="error">{action.error}</Banner> : null}
      <header className="study-session-header">
        <div>
          <p className="eyebrow">当前学习</p>
          <h3>{currentLearningUnit?.title ?? currentAgendaItem?.reason ?? '学习'}</h3>
          <p className="small muted">
            {currentAgendaItem?.reason ?? '等待选择下一项学习内容'}
            {currentAgendaItem ? ` · 约 ${currentAgendaItem.estimatedMinutes} 分钟` : ''}
          </p>
        </div>
        <div className="row">
          {active ? (
            <button type="button" onClick={() => void lifecycle('pause')}>
              暂停
            </button>
          ) : null}
          {session.status === 'paused' ? (
            <button type="button" className="primary" onClick={() => void lifecycle('resume')}>
              继续
            </button>
          ) : null}
          {active || session.status === 'paused' ? (
            <button type="button" className="danger" onClick={() => void lifecycle('stop')}>
              结束本次学习
            </button>
          ) : null}
        </div>
      </header>

      <div className="study-session-layout">
        <section className="study-transcript" aria-label="Tutor 对话">
          <div className="study-transcript-list">
            {detail.exchanges.length === 0 ? (
              <div className="transcript-empty">
                <p>从当前目标开始提问。</p>
                <p className="small muted">可以要求换一种解释、举例，或说明哪里没有理解。</p>
              </div>
            ) : null}
            {detail.exchanges.map((exchange) => (
              <Exchange key={exchange.id} exchange={exchange} />
            ))}
          </div>
          <label className="study-composer">
            <span className="sr-only">向 Tutor 提问</span>
            <textarea
              value={composer}
              disabled={!active || action.loading}
              onChange={(event) => setComposer(event.target.value)}
              placeholder={active ? '输入你的问题或想法…' : '继续本次学习后才能发送消息。'}
              rows={3}
            />
            <button
              type="button"
              className="primary"
              disabled={!active || action.loading || composer.trim().length === 0}
              onClick={() => void submitTurn()}
            >
              发送
            </button>
            {action.loading ? (
              <button type="button" onClick={action.cancel}>
                取消生成
              </button>
            ) : null}
          </label>
        </section>

        <aside className="study-session-sidebar">
          <section className="current-learning-context">
            <p className="eyebrow">当前目标</p>
            <h4>{currentLearningUnit?.title ?? currentAgendaItem?.reason ?? '等待学习内容'}</h4>
            {currentAgendaItem ? (
              <p className="small muted">
                {agendaKindLabel(currentAgendaItem.kind)} · 约 {currentAgendaItem.estimatedMinutes}{' '}
                分钟
              </p>
            ) : null}
            {session.routeStack.length > 0 ? (
              <div className="route-return-cue">
                <span className="pill">临时探索</span>
                <p className="small">{session.routeStack.at(-1)?.reason}</p>
                <button
                  type="button"
                  disabled={!active || action.loading}
                  onClick={() => void mixedCommand('return')}
                >
                  返回原学习路线
                </button>
              </div>
            ) : null}
            {currentTurn?.status === 'running' ? (
              <p className="small muted">Tutor 正在回应…</p>
            ) : null}
          </section>

          <details className="session-disclosure" aria-label="本次学习安排">
            <summary>本次安排（{detail.agenda.items.length} 项）</summary>
            <ol className="study-agenda-list">
              {[...detail.agenda.items]
                .sort((left, right) => left.index - right.index)
                .map((item) => {
                  const current = item.id === session.currentAgendaItemId;
                  return (
                    <li
                      key={item.id}
                      className="study-agenda-item"
                      aria-current={current ? 'step' : undefined}
                      aria-label={`${item.reason}，${current ? '当前，' : ''}${agendaStateLabel(item.state)}`}
                    >
                      <div className="row between">
                        <strong>{item.reason}</strong>
                        {current ? <span className="pill">当前</span> : null}
                      </div>
                      <p className="small muted">
                        {agendaKindLabel(item.kind)} · {item.estimatedMinutes} 分钟 ·{' '}
                        {agendaStateLabel(item.state)}
                      </p>
                    </li>
                  );
                })}
            </ol>
          </details>

          <details className="session-disclosure">
            <summary>调整本次学习</summary>
            {curriculumUnits.length > 0 ? (
              <label className="field">
                <span>想探索的学习单元</span>
                <select
                  value={detourLearningUnitId}
                  disabled={!active || action.loading}
                  onChange={(event) => setDetourLearningUnitId(event.target.value)}
                >
                  <option value="">当前学习单元</option>
                  {curriculumUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="study-session-controls">
              <button
                type="button"
                disabled={!active || action.loading}
                onClick={() => void mixedCommand('detour')}
              >
                临时探索
              </button>
              <button
                type="button"
                disabled={!active || action.loading}
                onClick={() => void mixedCommand('agenda_insert')}
              >
                插入短活动
              </button>
              <button
                type="button"
                disabled={!active || action.loading}
                onClick={() => void mixedCommand('deep_dive')}
              >
                深入学习
              </button>
              <button
                type="button"
                disabled={!active || action.loading || !directCheckpointItem}
                onClick={() => void mixedCommand('direct_checkpoint', directCheckpointItem?.id)}
              >
                发起正式评估
              </button>
              <button
                type="button"
                disabled={!active || action.loading}
                onClick={() => void mixedCommand('defer')}
              >
                延期当前内容
              </button>
              <button
                type="button"
                disabled={action.loading || !canPromoteCurrentDetour}
                onClick={() => void mixedCommand('promote_to_plan')}
              >
                纳入长期路线
              </button>
            </div>
            <p className="small formal-boundary">
              <span className="pill deterministic">正式评估</span>{' '}
              只有单独发起并完成的正式评估，才可能形成进展证据。
            </p>
          </details>
          {detail.latestSummary ? (
            <details className="session-disclosure">
              <summary>待解决问题</summary>
              {detail.latestSummary.unresolvedConfusions.map((item) => (
                <p className="small" key={item}>
                  {item}
                </p>
              ))}
            </details>
          ) : null}
          <Banner kind="info">
            Tutor 对话和非正式检查用于学习反馈，不是正式证据，也不会直接改变掌握状态。
          </Banner>
        </aside>
      </div>
    </div>
  );
}

function Exchange({ exchange }: { exchange: StudyExchange }) {
  const label =
    exchange.role === 'learner' ? '你' : exchange.role === 'tutor' ? 'Hy3 Tutor' : '学习记录';
  return (
    <article className={`study-exchange ${exchange.role} ${exchange.channel}`}>
      <strong>{label}</strong>
      <p>{exchange.content}</p>
      {exchange.channel === 'informal_check' ? <span className="pill">非正式检查</span> : null}
    </article>
  );
}

function commandPrompt(kind: MixedInitiativeCommandRequest['kind']): string {
  switch (kind) {
    case 'detour':
      return '你想临时探索什么？';
    case 'return':
      return '为什么现在返回原学习路线？';
    case 'deep_dive':
      return '你想深入学习什么？';
    case 'direct_checkpoint':
      return '你想正式检验什么能力？';
    case 'defer':
      return '为什么要延期当前内容？';
    case 'agenda_insert':
      return '这次学习中要插入什么短活动？';
    case 'promote_to_plan':
      return '为什么要把这次探索纳入长期学习路线？';
  }
}

function agendaKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    learning_unit_teaching: '学习单元',
    informal_check: '非正式检查',
    formal_checkpoint: '正式评估',
    synthesis: '综合练习',
    due_review: '到期复习',
    targeted_repair: '定向修复',
    learner_detour: '临时探索',
    prerequisite_repair: '先修修复',
    deep_dive: '深入学习',
  };
  return labels[kind] ?? '学习活动';
}

function agendaStateLabel(state: string): string {
  const labels: Record<string, string> = {
    queued: '待开始',
    active: '进行中',
    completed: '已完成',
    deferred: '已延期',
    cancelled: '已取消',
    blocked: '暂时受阻',
  };
  return labels[state] ?? state;
}
