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

  if (!workspaceId)
    return <Banner kind="empty">Select a course workspace to begin a study session.</Banner>;
  if (loading && !detail) return <Loading label="Loading study session..." />;
  if (loadError && !detail) return <Banner kind="error">{loadError}</Banner>;

  if (!detail) {
    return (
      <section className="study-session-empty" aria-label="Study session">
        <h3>Study Session</h3>
        <p className="muted">
          Start from the accepted route. Conversation does not change mastery or complete work.
        </p>
        {!route ? (
          <Banner kind="info">
            An accepted course route is required before a session can start.
          </Banner>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={action.loading}
            onClick={() => void startSession()}
          >
            {action.loading ? 'Starting...' : 'Start study session'}
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
    <div className="study-session" aria-label="Study session">
      {loadError ? <Banner kind="error">{loadError}</Banner> : null}
      {action.error ? <Banner kind="error">{action.error}</Banner> : null}
      <header className="study-session-header">
        <div>
          <h3>Study Session</h3>
          <p className="small muted">
            {session.routeState.replace('_', ' ')} | {session.status} | route stack{' '}
            {session.routeStack.length}
          </p>
        </div>
        <div className="row">
          {active ? (
            <button type="button" onClick={() => void lifecycle('pause')}>
              Pause
            </button>
          ) : null}
          {session.status === 'paused' ? (
            <button type="button" className="primary" onClick={() => void lifecycle('resume')}>
              Resume
            </button>
          ) : null}
          {active || session.status === 'paused' ? (
            <button type="button" className="danger" onClick={() => void lifecycle('stop')}>
              Stop
            </button>
          ) : null}
        </div>
      </header>

      <div className="study-session-layout">
        <section className="study-transcript" aria-label="Tutor transcript">
          <div className="study-transcript-list">
            {detail.exchanges.length === 0 ? (
              <p className="muted">Ask a question to begin.</p>
            ) : null}
            {detail.exchanges.map((exchange) => (
              <Exchange key={exchange.id} exchange={exchange} />
            ))}
          </div>
          <label className="study-composer">
            <span className="sr-only">Message the tutor</span>
            <textarea
              value={composer}
              disabled={!active || action.loading}
              onChange={(event) => setComposer(event.target.value)}
              placeholder={active ? 'Ask about this unit...' : 'Resume the session to continue.'}
              rows={3}
            />
            <button
              type="button"
              className="primary"
              disabled={!active || action.loading || composer.trim().length === 0}
              onClick={() => void submitTurn()}
            >
              Send
            </button>
            {action.loading ? (
              <button type="button" onClick={action.cancel}>
                Cancel
              </button>
            ) : null}
          </label>
        </section>

        <aside className="study-session-sidebar">
          <section>
            <h4>Current route</h4>
            <p className="small">
              Agenda item: {currentAgendaItem?.reason ?? 'Waiting for route selection'}
            </p>
            {currentAgendaItem ? (
              <p className="small muted">
                {currentAgendaItem.kind.replaceAll('_', ' ')} | about{' '}
                {currentAgendaItem.estimatedMinutes} minutes | {currentAgendaItem.state}
              </p>
            ) : null}
            {currentTurn ? <p className="small muted">Latest turn: {currentTurn.status}</p> : null}
            {session.routeStack.length > 0 ? (
              <p className="small muted">Detour: {session.routeStack.at(-1)?.reason}</p>
            ) : null}
          </section>
          <section aria-label="Session agenda">
            <h4>Session agenda</h4>
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
                      aria-label={`${item.reason}, ${current ? 'current, ' : ''}${item.state}`}
                    >
                      <div className="row between">
                        <strong>{item.reason}</strong>
                        {current ? <span className="pill">Current</span> : null}
                      </div>
                      <p className="small muted">
                        {item.kind.replaceAll('_', ' ')} | {item.estimatedMinutes} minutes |{' '}
                        {item.state}
                      </p>
                    </li>
                  );
                })}
            </ol>
          </section>
          <section>
            <h4>Session controls</h4>
            {curriculumUnits.length > 0 ? (
              <label className="field">
                <span>Detour target</span>
                <select
                  value={detourLearningUnitId}
                  disabled={!active || action.loading}
                  onChange={(event) => setDetourLearningUnitId(event.target.value)}
                >
                  <option value="">Current LearningUnit</option>
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
                Detour
              </button>
              <button
                type="button"
                disabled={!active || action.loading || session.routeStack.length === 0}
                onClick={() => void mixedCommand('return')}
              >
                Return to route
              </button>
              <button
                type="button"
                disabled={!active || action.loading}
                onClick={() => void mixedCommand('agenda_insert')}
              >
                Insert activity
              </button>
              <button
                type="button"
                disabled={!active || action.loading}
                onClick={() => void mixedCommand('deep_dive')}
              >
                Deep dive
              </button>
              <button
                type="button"
                disabled={!active || action.loading || !directCheckpointItem}
                onClick={() => void mixedCommand('direct_checkpoint', directCheckpointItem?.id)}
              >
                Formal checkpoint
              </button>
              <button
                type="button"
                disabled={!active || action.loading}
                onClick={() => void mixedCommand('defer')}
              >
                Defer
              </button>
              <button
                type="button"
                disabled={action.loading || !canPromoteCurrentDetour}
                onClick={() => void mixedCommand('promote_to_plan')}
              >
                Promote to plan
              </button>
            </div>
          </section>
          {detail.latestSummary ? (
            <section>
              <h4>Open questions</h4>
              {detail.latestSummary.unresolvedConfusions.map((item) => (
                <p className="small" key={item}>
                  {item}
                </p>
              ))}
            </section>
          ) : null}
          <Banner kind="info">
            Tutor dialogue and informal checks are not formal evidence or mastery changes.
          </Banner>
        </aside>
      </div>
    </div>
  );
}

function Exchange({ exchange }: { exchange: StudyExchange }) {
  const label =
    exchange.role === 'learner' ? 'You' : exchange.role === 'tutor' ? 'Hy3 Tutor' : 'Session';
  return (
    <article className={`study-exchange ${exchange.role} ${exchange.channel}`}>
      <strong>{label}</strong>
      <p>{exchange.content}</p>
      {exchange.channel === 'informal_check' ? <span className="pill">Informal check</span> : null}
    </article>
  );
}

function commandPrompt(kind: MixedInitiativeCommandRequest['kind']): string {
  switch (kind) {
    case 'detour':
      return 'What would you like to explore?';
    case 'return':
      return 'Why are you returning to the route?';
    case 'deep_dive':
      return 'What should be explored in more depth?';
    case 'direct_checkpoint':
      return 'What would you like to check formally?';
    case 'defer':
      return 'Why should this item be deferred?';
    case 'agenda_insert':
      return 'What short activity should be inserted into this session?';
    case 'promote_to_plan':
      return 'Why should this detour become part of the long-term plan?';
  }
}
