import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isPlannedFormalAgendaItemKind,
  type CourseFormalReadiness,
  type LessonExecutionProjection,
  type MixedInitiativeCommandRequest,
  type PublicQuiz,
  type SubmitTutorTurnRequest,
  type SubmitTutorTurnResponse,
  type StudyExchange,
  type StudySession,
  type StudySessionDetailResponse,
  type TutorTurnMetadata,
  type TutorStudyAnchor,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import { LessonExecutionPanel } from '../components/LessonExecutionPanel.js';
import { StudyTutorSurface } from '../components/StudyTutorSurface.js';
import { StudyInspector, type StudyInspectorTab } from './StudyInspector.js';

const INSPECTOR_MODAL_QUERY = '(max-width: 1279px)';

const QUICK_HELP_PROMPTS = [
  { label: '没听懂', prompt: '没懂，能简单一点吗？' },
  { label: '举个例子', prompt: '举个例子说明一下。' },
  { label: '给点提示', prompt: '请给当前这道题一点思路提示，留下关键判断让我自己完成。' },
] as const;

const TUTOR_MOVE_LABELS: Partial<Record<TutorTurnMetadata['move'], string>> = {
  SIMPLIFY: '换个角度解释',
  GIVE_EXAMPLE: '举个例子',
  GIVE_ANALOGY: '换个角度解释',
  CONTRAST: '对比一下',
  SUMMARIZE: '本节小结',
  RETURN_TO_ROUTE: '回到本节',
  FORMAL_CHECK_READY: '可以正式检验了',
};

const LESSON_PURPOSE_LABELS: Record<string, string> = {
  orientation: '定位重点',
  explanation: '核心解释',
  mechanism: '运行机制',
  worked_example: '示例',
  comparison: '对比',
  common_pitfall: '常见误区',
  guided_practice: '引导练习',
};

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
  formalReadiness?: CourseFormalReadiness | null;
  courseName?: string;
  curriculumUnits?: Array<{ id: string; title: string }>;
  onSessionChanged?: () => void;
  onLaunchQuiz?: (quiz: PublicQuiz) => void;
  onOpenKnowledgeMap?: (learningUnitId: string) => void;
}

let commandSequence = 0;

function commandId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${commandSequence}`}`;
}

interface PendingTutorTurn {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly route: Readonly<StudySessionRoute>;
  readonly input: Readonly<SubmitTutorTurnRequest>;
}

interface TutorReconciliationTarget extends Pick<
  PendingTutorTurn,
  'workspaceId' | 'sessionId' | 'route'
> {
  readonly providerFailure: string;
}

function isIndeterminateTutorFailure(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'NETWORK_ERROR'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameRoute(left: Readonly<StudySessionRoute>, right: StudySessionRoute): boolean {
  return (
    left.contractVersionId === right.contractVersionId &&
    left.curriculumVersionId === right.curriculumVersionId &&
    left.studyPlanVersionId === right.studyPlanVersionId &&
    left.sessionAgendaId === right.sessionAgendaId &&
    left.executionVersion === right.executionVersion
  );
}

/**
 * The persisted conversation surface. It deliberately renders exchanges as
 * conversation, not as evidence or mastery state; formal progression remains
 * isolated in the assessment workflow.
 */
export function StudySessionView({
  workspaceId,
  route,
  formalReadiness = null,
  courseName = '当前课程',
  curriculumUnits = [],
  onSessionChanged,
  onLaunchQuiz,
  onOpenKnowledgeMap,
}: StudySessionViewProps) {
  const [detail, setDetail] = useState<StudySessionDetailResponse | null>(null);
  const [lessonProjection, setLessonProjection] = useState<LessonExecutionProjection | null>(null);
  const [formalAssessmentVersionId, setFormalAssessmentVersionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [tutorOpen, setTutorOpen] = useState(false);
  const [studyAnchor, setStudyAnchor] = useState<TutorStudyAnchor | null>(null);
  const [selection, setSelection] = useState<{
    anchor: TutorStudyAnchor;
    x: number;
    y: number;
  } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [detourLearningUnitId, setDetourLearningUnitId] = useState('');
  const [pendingTutorTurn, setPendingTutorTurn] = useState<PendingTutorTurn | null>(null);
  const [tutorLoading, setTutorLoading] = useState(false);
  const [sendingContent, setSendingContent] = useState<string | null>(null);
  const [tutorReconciling, setTutorReconciling] = useState(false);
  const [tutorError, setTutorError] = useState<string | null>(null);
  const [tutorReconciliationTarget, setTutorReconciliationTarget] =
    useState<TutorReconciliationTarget | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<StudyInspectorTab>('agenda');
  const [inspectorModal, setInspectorModal] = useState(
    () => window.matchMedia?.(INSPECTOR_MODAL_QUERY).matches ?? false,
  );
  const epoch = useRef(0);
  const tutorEpoch = useRef(0);
  const tutorController = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const studyFocusTargetRef = useRef<HTMLDivElement>(null);
  const studyPrimaryRef = useRef<HTMLDivElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const sessionChangedRef = useRef(onSessionChanged);
  sessionChangedRef.current = onSessionChanged;
  const inspectorOpenRef = useRef(inspectorOpen);
  inspectorOpenRef.current = inspectorOpen;
  const action = useAsyncAction();
  const routeContractVersionId = route?.contractVersionId;
  const routeCurriculumVersionId = route?.curriculumVersionId;
  const routeStudyPlanVersionId = route?.studyPlanVersionId;
  const routeSessionAgendaId = route?.sessionAgendaId;
  const routeExecutionVersion = route?.executionVersion;
  const currentSessionId = detail?.session.id;
  const restoringTutor =
    !tutorLoading &&
    Boolean(detail?.turns.some((turn) => turn.status === 'running' || turn.status === 'queued'));
  const busy =
    action.loading ||
    tutorLoading ||
    tutorReconciling ||
    restoringTutor ||
    Boolean(pendingTutorTurn);
  useEffect(() => {
    if (!restoringTutor || !workspaceId || !currentSessionId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api
        .getStudySession(workspaceId, currentSessionId, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted)
            setDetail((current) =>
              current?.session.id === currentSessionId &&
              next.session.version >= current.session.version
                ? next
                : current,
            );
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setTutorError('暂时无法同步上一条回答，请稍后重新打开学习页面。');
        });
    }, 1500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [restoringTutor, workspaceId, currentSessionId, detail]);
  const draftKey =
    currentSessionId && workspaceId ? `study-tutor-draft:${workspaceId}:${currentSessionId}` : null;
  const loadedDraftKey = useRef<string | null>(null);
  useEffect(() => {
    if (!draftKey || loadedDraftKey.current === draftKey) return;
    loadedDraftKey.current = draftKey;
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
      if (saved && typeof saved.content === 'string') {
        setComposer(saved.content);
        setStudyAnchor(saved.anchor ?? null);
      }
    } catch {
      /* Storage is optional; server transcript remains durable. */
    }
  }, [draftKey]);
  useEffect(() => {
    if (!draftKey || loadedDraftKey.current !== draftKey) return;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ content: composer, anchor: studyAnchor }));
    } catch {
      /* optional draft */
    }
  }, [draftKey, composer, studyAnchor]);
  useEffect(() => {
    if (tutorOpen)
      requestAnimationFrame(() => {
        const list = transcriptRef.current;
        if (list) list.scrollTop = list.scrollHeight;
      });
  }, [tutorOpen, detail?.exchanges.length, tutorLoading]);
  useEffect(() => {
    const capture = () => {
      const selected = window.getSelection();
      if (
        !selected ||
        selected.isCollapsed ||
        selected.rangeCount === 0 ||
        !lessonProjection?.progress?.stateId
      ) {
        setSelection(null);
        return;
      }
      const range = selected.getRangeAt(0);
      const container = studyPrimaryRef.current?.querySelector('.lesson-execution-panel');
      const text = selected.toString().trim();
      if (
        !container?.contains(range.startContainer) ||
        !container.contains(range.endContainer) ||
        text.length < 2 ||
        text.length > 1800
      ) {
        setSelection(null);
        return;
      }
      const start =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement;
      const segment = start?.closest<HTMLElement>('[data-tutor-segment]');
      const rect = range.getBoundingClientRect();
      setSelection({
        anchor: {
          lessonExecutionStateId: lessonProjection.progress.stateId,
          lessonExecutionVersion: lessonProjection.progress.stateVersion,
          ...(segment ? { segmentIndex: Number(segment.dataset.tutorSegment) } : {}),
          selectedText: text,
        },
        x: Math.max(12, Math.min(window.innerWidth - 138, rect.left)),
        y: Math.max(10, Math.min(window.innerHeight - 50, rect.bottom + 8)),
      });
    };
    document.addEventListener('selectionchange', capture);
    return () => document.removeEventListener('selectionchange', capture);
  }, [lessonProjection]);

  function openTutor(anchor?: TutorStudyAnchor) {
    setInspectorOpen(false);
    if (anchor) setStudyAnchor(anchor);
    setTutorOpen(true);
    setSelection(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  const loadSession = useCallback(
    async (targetWorkspaceId: string, sessionId: string, signal: AbortSignal) => {
      const requestEpoch = ++epoch.current;
      setLoading(true);
      setLoadError(null);
      try {
        let next = await api.getStudySession(targetWorkspaceId, sessionId, signal);
        const loadedSessionVersion = next.session.version;
        const selected = next.agenda.items.find(
          (item) => item.id === next.session.currentAgendaItemId,
        );
        if (
          selected?.state === 'queued' &&
          selected.kind === 'synthesis' &&
          routeContractVersionId &&
          routeCurriculumVersionId &&
          routeStudyPlanVersionId &&
          routeSessionAgendaId &&
          routeExecutionVersion !== undefined
        ) {
          const reconciled = await api.startStudySession(
            targetWorkspaceId,
            {
              contractVersionId: routeContractVersionId,
              curriculumVersionId: routeCurriculumVersionId,
              studyPlanVersionId: routeStudyPlanVersionId,
              sessionAgendaId: routeSessionAgendaId,
              expectedCourseExecutionVersion: routeExecutionVersion,
            },
            signal,
          );
          if (signal.aborted || requestEpoch !== epoch.current) return;
          next = await api.getStudySession(targetWorkspaceId, sessionId, signal);
          if (
            !signal.aborted &&
            requestEpoch === epoch.current &&
            (reconciled.session.version !== loadedSessionVersion ||
              reconciled.session.currentAgendaItemId !== selected.id)
          ) {
            sessionChangedRef.current?.();
          }
        }
        if (!signal.aborted && requestEpoch === epoch.current) {
          setDetail(next);
          setFormalAssessmentVersionId(null);
          const currentItem = next.agenda.items.find(
            (item) => item.id === next.session.currentAgendaItemId,
          );
          if (
            currentItem &&
            (currentItem.kind === 'formal_checkpoint' ||
              currentItem.kind === 'synthesis' ||
              currentItem.kind === 'targeted_repair' ||
              currentItem.kind === 'due_review')
          ) {
            const version = await api.getAgendaFormalAssessment(
              targetWorkspaceId,
              next.agenda.id,
              currentItem.id,
              signal,
            );
            if (!signal.aborted && requestEpoch === epoch.current)
              setFormalAssessmentVersionId(version?.id ?? null);
          }
        }
      } catch (error) {
        if (!signal.aborted && requestEpoch === epoch.current) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!signal.aborted && requestEpoch === epoch.current) setLoading(false);
      }
    },
    [
      routeContractVersionId,
      routeCurriculumVersionId,
      routeExecutionVersion,
      routeSessionAgendaId,
      routeStudyPlanVersionId,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    const requestEpoch = ++epoch.current;
    const inspectorWasOpen = inspectorOpenRef.current;
    setFormalAssessmentVersionId(null);
    tutorEpoch.current += 1;
    tutorController.current?.abort();
    tutorController.current = null;
    setPendingTutorTurn(null);
    setTutorLoading(false);
    setSendingContent(null);
    setTutorReconciling(false);
    setTutorError(null);
    setTutorReconciliationTarget(null);
    setDetail(null);
    setLessonProjection(null);
    setComposer('');
    setStudyAnchor(null);
    setSelection(null);
    setTutorOpen(false);
    setDetourLearningUnitId('');
    setInspectorOpen(false);
    setInspectorTab('agenda');
    setLoadError(null);
    if (inspectorWasOpen) {
      requestAnimationFrame(() => studyFocusTargetRef.current?.focus());
    }
    if (!workspaceId) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    void api
      .listStudySessions(workspaceId, controller.signal)
      .then(async ({ sessions }) => {
        if (controller.signal.aborted || requestEpoch !== epoch.current) return;
        const current = routeContractVersionId
          ? sessions.find(
              (session) =>
                (session.status === 'active' || session.status === 'paused') &&
                session.contractVersionId === routeContractVersionId &&
                session.curriculumVersionId === routeCurriculumVersionId &&
                session.studyPlanVersionId === routeStudyPlanVersionId &&
                session.sessionAgendaId === routeSessionAgendaId,
            )
          : undefined;
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
      tutorEpoch.current += 1;
      tutorController.current?.abort();
      tutorController.current = null;
    };
  }, [
    loadSession,
    routeContractVersionId,
    routeCurriculumVersionId,
    routeExecutionVersion,
    routeSessionAgendaId,
    routeStudyPlanVersionId,
    workspaceId,
  ]);

  useEffect(() => {
    setPendingTutorTurn((current) => {
      if (!current) return null;
      const stillCurrent =
        current.sessionId === currentSessionId &&
        current.route.contractVersionId === routeContractVersionId &&
        current.route.curriculumVersionId === routeCurriculumVersionId &&
        current.route.studyPlanVersionId === routeStudyPlanVersionId &&
        current.route.sessionAgendaId === routeSessionAgendaId &&
        current.route.executionVersion === routeExecutionVersion;
      return stillCurrent ? current : null;
    });
  }, [
    currentSessionId,
    routeContractVersionId,
    routeCurriculumVersionId,
    routeExecutionVersion,
    routeSessionAgendaId,
    routeStudyPlanVersionId,
  ]);

  useEffect(() => {
    const query = window.matchMedia?.(INSPECTOR_MODAL_QUERY);
    if (!query) return;
    const update = () => setInspectorModal(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    const primary = studyPrimaryRef.current;
    if (!primary) return;
    if (inspectorOpen && inspectorModal) primary.setAttribute('inert', '');
    else primary.removeAttribute('inert');
    return () => primary.removeAttribute('inert');
  }, [inspectorModal, inspectorOpen]);

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    requestAnimationFrame(() =>
      (inspectorReturnFocusRef.current ?? inspectorTriggerRef.current)?.focus(),
    );
  }, []);

  function openInspector(
    tab: StudyInspectorTab = inspectorTab,
    returnFocus: HTMLButtonElement | null = inspectorTriggerRef.current,
  ): void {
    inspectorReturnFocusRef.current = returnFocus;
    setTutorOpen(false);
    setInspectorTab(tab);
    setInspectorOpen(true);
  }

  function replaceSession(session: StudySession, agenda = detail?.agenda): void {
    setDetail((current) => (current && agenda ? { ...current, session, agenda } : current));
    onSessionChanged?.();
  }

  const refreshCurrentSession = useCallback(() => {
    if (!workspaceId || !currentSessionId) return;
    void loadSession(workspaceId, currentSessionId, new AbortController().signal);
  }, [currentSessionId, loadSession, workspaceId]);

  const updateLessonProjection = useCallback((projection: LessonExecutionProjection) => {
    setLessonProjection(projection);
    setDetail((current) =>
      current && projection.session.version >= current.session.version
        ? {
            ...current,
            session: { ...current.session, version: projection.session.version },
            agenda: projection.agenda
              ? {
                  ...current.agenda,
                  version: Math.max(current.agenda.version, projection.agenda.version),
                }
              : current.agenda,
          }
        : current,
    );
  }, []);

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

  function canRetryTutorTurn(candidate: PendingTutorTurn | null): candidate is PendingTutorTurn {
    return Boolean(
      candidate &&
      workspaceId &&
      route &&
      detail &&
      candidate.workspaceId === workspaceId &&
      candidate.sessionId === detail.session.id &&
      sameRoute(candidate.route, route),
    );
  }

  function applyTutorResponse(request: PendingTutorTurn, response: SubmitTutorTurnResponse): void {
    setDetail((current) =>
      current?.session.id === request.sessionId
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
    setPendingTutorTurn(null);
    setTutorReconciliationTarget(null);
    setTutorError(null);
    onSessionChanged?.();
    setSendingContent(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function reconcileTutorSession(
    target: TutorReconciliationTarget,
    requestEpoch: number,
    controller: AbortController,
  ): Promise<void> {
    setTutorReconciliationTarget(target);
    setTutorReconciling(true);
    try {
      const authoritative = await api.getStudySession(
        target.workspaceId,
        target.sessionId,
        controller.signal,
      );
      if (requestEpoch !== tutorEpoch.current || controller.signal.aborted) return;
      const authoritativeRoute = authoritative.session;
      if (
        authoritativeRoute.id !== target.sessionId ||
        authoritativeRoute.workspaceId !== target.workspaceId ||
        authoritativeRoute.contractVersionId !== target.route.contractVersionId ||
        authoritativeRoute.curriculumVersionId !== target.route.curriculumVersionId ||
        authoritativeRoute.studyPlanVersionId !== target.route.studyPlanVersionId ||
        authoritativeRoute.sessionAgendaId !== target.route.sessionAgendaId
      ) {
        throw new Error('StudySession route changed while reconciling the failed Tutor turn.');
      }
      setDetail((current) => (current?.session.id === target.sessionId ? authoritative : current));
      if (authoritative.session.currentAgendaItemId) {
        const lesson = await api.getLessonExecution(
          target.workspaceId,
          target.sessionId,
          controller.signal,
        );
        if (requestEpoch !== tutorEpoch.current || controller.signal.aborted) return;
        updateLessonProjection(lesson);
      }
      setTutorReconciliationTarget(null);
      setTutorError(target.providerFailure);
      onSessionChanged?.();
    } catch {
      if (requestEpoch !== tutorEpoch.current || controller.signal.aborted) return;
      setTutorError(
        `${target.providerFailure} 当前学习记录尚未同步，请重新同步后再发送下一条消息。`,
      );
    } finally {
      if (requestEpoch === tutorEpoch.current && !controller.signal.aborted) {
        setTutorReconciling(false);
      }
    }
  }

  async function sendTutorTurn(request: PendingTutorTurn): Promise<void> {
    if (tutorController.current) return;
    const requestEpoch = ++tutorEpoch.current;
    const controller = new AbortController();
    tutorController.current = controller;
    setTutorLoading(true);
    setSendingContent(request.input.content);
    setTutorError(null);
    try {
      const response = await api.streamTutorTurn(
        request.workspaceId,
        request.sessionId,
        request.input,
        (line) => {
          if (requestEpoch !== tutorEpoch.current || line.kind !== 'event') return;
          setDetail((current) => {
            if (!current || current.session.id !== request.sessionId) return current;
            if (current.turnEvents.some((event) => event.id === line.event.id)) return current;
            return { ...current, turnEvents: [...current.turnEvents, line.event] };
          });
        },
        controller.signal,
      );
      if (requestEpoch !== tutorEpoch.current || controller.signal.aborted) return;
      applyTutorResponse(request, response);
    } catch (error) {
      if (requestEpoch !== tutorEpoch.current || controller.signal.aborted) return;
      if (isIndeterminateTutorFailure(error)) {
        setPendingTutorTurn(request);
        setTutorError(errorMessage(error));
      } else {
        setPendingTutorTurn(null);
        setComposer(request.input.content);
        setStudyAnchor(null);
        const providerFailure = errorMessage(error);
        setTutorError(providerFailure);
        setTutorLoading(false);
        await reconcileTutorSession({ ...request, providerFailure }, requestEpoch, controller);
      }
    } finally {
      if (tutorController.current === controller) {
        tutorController.current = null;
        setTutorLoading(false);
      }
    }
  }

  function buildTutorRequest(content: string): PendingTutorTurn | null {
    if (
      !workspaceId ||
      !route ||
      !detail ||
      !content ||
      detail.session.status !== 'active' ||
      pendingTutorTurn ||
      tutorController.current
    )
      return null;
    return Object.freeze({
      workspaceId,
      sessionId: detail.session.id,
      route: Object.freeze({ ...route }),
      input: Object.freeze({
        commandId: commandId('tutor_turn'),
        expectedSessionVersion: detail.session.version,
        content,
        ...(studyAnchor
          ? { studyAnchor }
          : lessonProjection?.progress?.stateId
            ? {
                studyAnchor: {
                  lessonExecutionStateId: lessonProjection.progress.stateId,
                  lessonExecutionVersion: lessonProjection.progress.stateVersion,
                },
              }
            : {}),
      }),
    });
  }

  async function submitTutorIntent(rawContent: string): Promise<void> {
    const content = rawContent.trim();
    const request = buildTutorRequest(content);
    if (!request) return;
    setComposer('');
    setStudyAnchor(null);
    await sendTutorTurn(request);
  }

  async function submitTurn(): Promise<void> {
    await submitTutorIntent(composer);
  }

  async function retryTutorTurn(): Promise<void> {
    const request = pendingTutorTurn;
    if (!canRetryTutorTurn(request)) {
      setPendingTutorTurn(null);
      return;
    }
    await sendTutorTurn(request);
  }

  async function retryTutorReconciliation(): Promise<void> {
    const target = tutorReconciliationTarget;
    if (!target || tutorController.current) return;
    const requestEpoch = ++tutorEpoch.current;
    const controller = new AbortController();
    tutorController.current = controller;
    await reconcileTutorSession(target, requestEpoch, controller);
    if (tutorController.current === controller) tutorController.current = null;
  }

  function abandonTutorRetry(): void {
    tutorEpoch.current += 1;
    tutorController.current?.abort();
    tutorController.current = null;
    setTutorLoading(false);
    setTutorReconciling(false);
    setPendingTutorTurn(null);
    setTutorReconciliationTarget(null);
    setTutorError(null);
  }

  async function cancelTutorTurn(): Promise<void> {
    abandonTutorRetry();
    if (!workspaceId || !detail || !route) return;
    const controller = new AbortController();
    tutorController.current = controller;
    const requestEpoch = ++tutorEpoch.current;
    await reconcileTutorSession(
      {
        workspaceId,
        sessionId: detail.session.id,
        route,
        providerFailure: '已停止。提问保留在对话记录中，可以继续追问。',
      },
      requestEpoch,
      controller,
    );
    if (tutorController.current === controller) tutorController.current = null;
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
    if (launched?.kind === 'assessment') {
      if (launched.formalAssessmentVersionId)
        setFormalAssessmentVersionId(launched.formalAssessmentVersionId);
      else onLaunchQuiz?.(launched.quiz);
    }
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
    return (
      <div ref={studyFocusTargetRef} className="study-session" aria-label="学习" tabIndex={-1}>
        <section className="course-empty-state study-session-empty compact">
          <strong>请先选择课程，再进入学习。</strong>
          <p>学习内容和记录都属于具体课程，请从课程侧边栏选择一门课程。</p>
        </section>
      </div>
    );
  if (loading && !detail)
    return (
      <div ref={studyFocusTargetRef} className="study-session" aria-label="学习" tabIndex={-1}>
        <Loading label="加载学习记录…" />
      </div>
    );
  if (loadError && !detail)
    return (
      <div ref={studyFocusTargetRef} className="study-session" aria-label="学习" tabIndex={-1}>
        <Banner kind="error">{loadError}</Banner>
      </div>
    );

  if (!detail) {
    return (
      <div ref={studyFocusTargetRef} className="study-session" aria-label="学习" tabIndex={-1}>
        <section className="study-session-empty">
          <p className="eyebrow">开始本次学习</p>
          <strong>{route ? '已接受的学习路线已经就绪' : '还没有可执行的学习路线'}</strong>
          <p className="muted">
            Tutor 对话和非正式检查可以帮助理解，但不会自动改变掌握状态或完成学习单元。
          </p>
          {!route ? (
            <p className="study-session-empty-next">请先回到主页设置目标，再查看并接受学习路线。</p>
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
      </div>
    );
  }

  const { session } = detail;
  const currentAgendaItem = detail.agenda.items.find(
    (item) => item.id === session.currentAgendaItemId,
  );
  const currentLearningUnit = curriculumUnits.find(
    (unit) => unit.id === currentAgendaItem?.learningUnitId,
  );
  const formalKinds = new Set(['formal_checkpoint', 'synthesis', 'due_review', 'targeted_repair']);
  const formalAvailable = formalReadiness?.status === 'ready';
  const formalReadinessAllows = (item: (typeof detail.agenda.items)[number]) =>
    !isPlannedFormalAgendaItemKind(item.kind) || formalAvailable;
  const availableFormalItems = detail.agenda.items
    .filter(
      (item) =>
        formalKinds.has(item.kind) &&
        formalReadinessAllows(item) &&
        item.state !== 'completed' &&
        item.state !== 'deferred' &&
        item.state !== 'cancelled' &&
        item.launch.status === 'launchable',
    )
    .sort((left, right) => left.index - right.index);
  // A completed Lesson hands off to the formal checkpoint for the same
  // LearningUnit when one exists. Falling back to the next route checkpoint
  // keeps the route usable for legacy agendas without inventing mastery credit.
  const directCheckpointItem =
    (currentAgendaItem &&
    formalKinds.has(currentAgendaItem.kind) &&
    formalReadinessAllows(currentAgendaItem) &&
    currentAgendaItem.state !== 'completed' &&
    currentAgendaItem.state !== 'deferred' &&
    currentAgendaItem.state !== 'cancelled' &&
    currentAgendaItem.launch.status === 'launchable'
      ? currentAgendaItem
      : undefined) ??
    availableFormalItems.find(
      (item) =>
        currentAgendaItem?.learningUnitId !== null &&
        currentAgendaItem?.learningUnitId !== undefined &&
        item.learningUnitId === currentAgendaItem.learningUnitId,
    ) ??
    availableFormalItems[0];
  const active = session.status === 'active';
  const canPromoteCurrentDetour = Boolean(
    active &&
    currentAgendaItem?.state === 'active' &&
    currentAgendaItem.origin === 'learner_detour' &&
    currentAgendaItem.learningUnitId,
  );
  const orderedAgenda = [...detail.agenda.items].sort((left, right) => left.index - right.index);
  const currentAgendaPosition = currentAgendaItem
    ? orderedAgenda.findIndex((item) => item.id === currentAgendaItem.id) + 1
    : 0;
  const resolvedAgendaItems = orderedAgenda.filter(
    (item) => item.state === 'completed' || item.state === 'deferred' || item.state === 'cancelled',
  ).length;
  const tutorContextTitle =
    lessonProjection?.lesson?.objective.title ?? currentLearningUnit?.title ?? '当前学习内容';
  const tutorContextPurpose = lessonProjection?.progress
    ? LESSON_PURPOSE_LABELS[
        lessonProjection.lesson?.segments[lessonProjection.progress.currentSegmentIndex]?.purpose ??
          ''
      ]
    : null;
  const latestTutorExchange = [...detail.exchanges]
    .reverse()
    .find((exchange) => exchange.role === 'tutor' && exchange.channel === 'conversation');
  const latestTutorTurn = latestTutorExchange
    ? detail.turns.find((turn) => turn.id === latestTutorExchange.turnId)
    : undefined;
  const formalReadyFromTutor = latestTutorTurn?.tutorMetadata?.move === 'FORMAL_CHECK_READY';
  const formalReadyCheckpointItem =
    formalReadyFromTutor && directCheckpointItem?.kind === 'formal_checkpoint'
      ? directCheckpointItem
      : null;
  return (
    <div
      ref={studyFocusTargetRef}
      className={`study-session${inspectorOpen ? ' inspector-open' : ''}`}
      aria-label="学习"
      tabIndex={-1}
    >
      <div ref={studyPrimaryRef} className="study-session-primary">
        {loadError || action.error ? (
          <div className="study-session-alerts" aria-label="学习状态">
            {loadError ? <Banner kind="error">{loadError}</Banner> : null}
            {action.error ? <Banner kind="error">{action.error}</Banner> : null}
          </div>
        ) : null}
        <header className="study-session-header">
          <div className="study-session-header-inner">
            <div className="study-session-heading">
              <p className="eyebrow">当前学习</p>
              <h3>{currentLearningUnit?.title ?? currentAgendaItem?.reason ?? '学习'}</h3>
              <div className="study-session-meta" aria-label="当前学习位置">
                <span>{currentAgendaItem?.reason ?? '等待选择下一项学习内容'}</span>
                {currentAgendaItem ? (
                  <span>约 {currentAgendaItem.estimatedMinutes} 分钟</span>
                ) : null}
                {orderedAgenda.length > 0 ? (
                  <span>
                    安排 {currentAgendaPosition || resolvedAgendaItems}/{orderedAgenda.length}
                  </span>
                ) : null}
              </div>
              {session.routeStack.length > 0 ? (
                <div className="route-return-cue compact" role="status">
                  <span className="pill">临时探索</span>
                  <span>{session.routeStack.at(-1)?.reason}</span>
                  <button
                    type="button"
                    disabled={!active || busy}
                    onClick={() => void mixedCommand('return')}
                  >
                    返回原学习路线
                  </button>
                </div>
              ) : null}
            </div>
            <div className="study-session-header-actions">
              <button
                type="button"
                className="study-tutor-trigger"
                aria-controls="study-tutor"
                aria-expanded={tutorOpen}
                onClick={() => (tutorOpen ? setTutorOpen(false) : openTutor())}
              >
                {tutorOpen ? '收起 Tutor' : '问 Tutor'}
              </button>
              {currentAgendaItem?.learningUnitId && onOpenKnowledgeMap ? (
                <button
                  type="button"
                  className="study-map-trigger"
                  onClick={() => onOpenKnowledgeMap(currentAgendaItem.learningUnitId!)}
                >
                  在知识地图中定位
                </button>
              ) : null}
              <button
                ref={inspectorTriggerRef}
                type="button"
                className="study-inspector-trigger"
                aria-controls="study-inspector"
                aria-expanded={inspectorOpen}
                onClick={(event) =>
                  inspectorOpen
                    ? setInspectorOpen(false)
                    : openInspector('agenda', event.currentTarget)
                }
              >
                <span>学习上下文</span>
                <small>
                  安排 {currentAgendaPosition || resolvedAgendaItems}/{orderedAgenda.length}
                </small>
              </button>
              {directCheckpointItem ? (
                <button
                  type="button"
                  className="study-formal-trigger"
                  onClick={(event) => openInspector('evidence', event.currentTarget)}
                >
                  正式评估可用
                </button>
              ) : null}
              <div className="study-session-lifecycle" aria-label="本次学习控制">
                <span className={`session-status ${session.status}`}>
                  {sessionStatusLabel(session.status)}
                </span>
                {active ? (
                  <button type="button" disabled={busy} onClick={() => void lifecycle('pause')}>
                    暂停
                  </button>
                ) : null}
                {session.status === 'paused' ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void lifecycle('resume')}
                  >
                    继续
                  </button>
                ) : null}
                {active || session.status === 'paused' ? (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void lifecycle('stop')}
                  >
                    结束本次学习
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        <div className="study-session-layout">
          <div className="study-session-learning-stack">
            {currentAgendaItem ? (
              <LessonExecutionPanel
                workspaceId={workspaceId}
                sessionId={session.id}
                sessionVersion={session.version}
                agendaItemId={currentAgendaItem?.id ?? session.currentAgendaItemId ?? ''}
                active={active}
                busy={busy}
                directCheckpointItemId={directCheckpointItem?.id ?? null}
                formalAssessmentVersionId={formalAssessmentVersionId}
                reviewMode={currentAgendaItem?.kind === 'due_review'}
                onResumeStudySession={() => void lifecycle('resume')}
                onStartFormalAssessment={() =>
                  void mixedCommand('direct_checkpoint', directCheckpointItem?.id ?? null)
                }
                onSessionVersionChange={updateLessonProjection}
                onRefreshSession={refreshCurrentSession}
              />
            ) : (
              <section className="lesson-execution-panel" aria-label="当前学习安排">
                <h3>本轮学习安排已结束</h3>
                <p>
                  已完成的讲解与练习已保存。正式掌握仍需独立证据；你可以从课程主页查看后续安排与课程状态。
                </p>
              </section>
            )}
          </div>
          <StudyTutorSurface open={tutorOpen} onClose={() => setTutorOpen(false)}>
            <header className="study-tutor-secondary-header">
              <div>
                <h3>Hy3 Tutor</h3>
                <p className="study-tutor-context" aria-label="当前讲解范围">
                  正在围绕：{tutorContextTitle}
                  {lessonProjection?.practice?.recovery
                    ? ' · 修补 / 再检验'
                    : lessonProjection?.practice?.status === 'in_progress'
                      ? ' · 练习'
                      : tutorContextPurpose
                        ? ` · ${tutorContextPurpose}`
                        : ''}
                </p>
              </div>
              <button type="button" className="ghost small" onClick={() => setTutorOpen(false)}>
                回到讲解
              </button>
            </header>
            <section className="study-transcript" aria-label="Tutor 对话">
              <div
                className="study-transcript-list"
                ref={transcriptRef}
                role="log"
                aria-label="学习对话记录"
                aria-live="polite"
                aria-relevant="additions text"
              >
                <div className="study-transcript-inner">
                  {detail.exchanges.length === 0 ? (
                    <div className="transcript-empty">
                      <p>卡在哪一步？一起把它讲明白。</p>
                      <p className="small muted">
                        可以直接问当前内容，也可以选中讲解中的一句话再提问。
                      </p>
                    </div>
                  ) : null}
                  {detail.exchanges.map((exchange) => {
                    const turn = detail.turns.find((turn) => turn.id === exchange.turnId);
                    const metadata = turn?.tutorMetadata;
                    const metadataMatchesCurrentSegment =
                      metadata?.lessonSegmentIndex !== null &&
                      metadata?.lessonSegmentIndex ===
                        lessonProjection?.progress?.currentSegmentIndex;
                    return (
                      <Exchange
                        key={exchange.id}
                        exchange={exchange}
                        metadata={metadata}
                        anchor={turn?.contextManifest.studyAnchor}
                        failed={
                          exchange.role === 'learner' &&
                          Boolean(
                            turn && ['failed', 'cancelled', 'interrupted'].includes(turn.status),
                          )
                        }
                        editDisabled={busy}
                        onEdit={() => setComposer(exchange.content)}
                        routeTitle={metadataMatchesCurrentSegment ? tutorContextTitle : '本节主线'}
                      />
                    );
                  })}
                  {tutorLoading ? (
                    <div>
                      {sendingContent &&
                      !pendingTutorTurn &&
                      !detail.exchanges.some(
                        (exchange) =>
                          exchange.role === 'learner' && exchange.content === sendingContent,
                      ) ? (
                        <p className="study-tutor-pending-question">
                          <strong>你</strong>
                          <br />
                          {sendingContent}
                        </p>
                      ) : null}
                      <div className="study-tutor-stream" role="status" aria-live="polite">
                        <span className="study-tutor-avatar" aria-hidden="true">
                          H3
                        </span>
                        <div>
                          <strong>Hy3 Tutor</strong>
                          <p>Tutor 正在组织这次回应…</p>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="study-composer-dock">
                {restoringTutor ? <p role="status">正在同步上一条提问的结果…</p> : null}
                {tutorError ? (
                  <div className="study-operation-notice error" role="alert">
                    <strong>这次 Tutor 请求未完成</strong>
                    <span>{tutorError}</span>
                    {tutorReconciliationTarget ? (
                      <button
                        type="button"
                        className="ghost"
                        disabled={tutorReconciling}
                        onClick={() => void retryTutorReconciliation()}
                      >
                        {tutorReconciling ? '正在同步…' : '重新同步学习记录'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {canRetryTutorTurn(pendingTutorTurn) ? (
                  <div className="study-retry" role="alert">
                    <p>
                      Tutor 请求尚未确认完成，原提问已保留：
                      <q>{pendingTutorTurn.input.content}</q>
                    </p>
                    <div className="row">
                      <button
                        type="button"
                        className="primary"
                        disabled={tutorLoading}
                        aria-busy={tutorLoading}
                        onClick={() => void retryTutorTurn()}
                      >
                        重试此条提问
                      </button>
                      <button type="button" onClick={abandonTutorRetry}>
                        放弃重试
                      </button>
                    </div>
                  </div>
                ) : null}
                {formalReadyCheckpointItem ? (
                  <div className="study-formal-ready" role="status">
                    <div>
                      <strong>这部分已经讲到可以检验的程度</strong>
                      <span>正式检验会沿用现有学习记录，不会把 Tutor 对话当作成绩。</span>
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      disabled={!active || busy}
                      onClick={() =>
                        void mixedCommand('direct_checkpoint', formalReadyCheckpointItem.id)
                      }
                    >
                      开始正式检验
                    </button>
                  </div>
                ) : null}
                <div className="study-composer">
                  {studyAnchor?.selectedText ? (
                    <div className="study-tutor-selection">
                      <span>关于这段讲解</span>
                      <blockquote>{studyAnchor.selectedText}</blockquote>
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => setStudyAnchor(null)}
                      >
                        移除引用
                      </button>
                    </div>
                  ) : null}
                  <div className="study-quick-help" aria-label="快速提问">
                    {QUICK_HELP_PROMPTS.map(({ label, prompt }) => (
                      <button
                        key={label}
                        type="button"
                        className="ghost small"
                        disabled={
                          !active ||
                          busy ||
                          Boolean(pendingTutorTurn) ||
                          Boolean(tutorReconciliationTarget)
                        }
                        onClick={() => void submitTutorIntent(prompt)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label htmlFor="study-tutor-composer" className="sr-only">
                    向 Tutor 提问
                  </label>
                  <textarea
                    id="study-tutor-composer"
                    ref={composerRef}
                    value={composer}
                    disabled={
                      !active ||
                      action.loading ||
                      tutorLoading ||
                      tutorReconciling ||
                      restoringTutor ||
                      Boolean(tutorReconciliationTarget)
                    }
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void submitTurn();
                      }
                    }}
                    placeholder={active ? '输入你的问题或想法…' : '继续本次学习后才能发送消息。'}
                    rows={2}
                  />
                  <div className="study-composer-actions">
                    <span className="small muted">Enter 发送 · Shift+Enter 换行</span>
                    <button
                      type="button"
                      className="primary study-send-control"
                      aria-label={tutorLoading ? '停止生成' : '发送'}
                      title={tutorLoading ? '停止生成' : '发送'}
                      aria-busy={tutorLoading}
                      disabled={
                        tutorLoading
                          ? false
                          : !active ||
                            busy ||
                            Boolean(pendingTutorTurn) ||
                            Boolean(tutorReconciliationTarget) ||
                            composer.trim().length === 0
                      }
                      onClick={
                        tutorLoading ? () => void cancelTutorTurn() : () => void submitTurn()
                      }
                    >
                      <span aria-hidden="true">{tutorLoading ? '■' : '↑'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </StudyTutorSurface>
        </div>
      </div>
      {!tutorOpen ? (
        <button
          type="button"
          className="study-tutor-floating"
          onClick={() => openTutor()}
          aria-controls="study-tutor"
          aria-expanded={false}
        >
          {tutorLoading ? 'Tutor 正在回答…' : '问 Tutor'}
        </button>
      ) : null}
      {selection ? (
        <button
          type="button"
          className="study-tutor-selection-trigger"
          style={{ left: selection.x, top: selection.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openTutor(selection.anchor)}
        >
          就这段问 Tutor
        </button>
      ) : null}
      <StudyInspector
        open={inspectorOpen}
        modal={inspectorModal}
        activeTab={inspectorTab}
        courseName={courseName}
        detail={detail}
        curriculumUnits={curriculumUnits}
        detourLearningUnitId={detourLearningUnitId}
        active={active}
        busy={busy}
        actionLoading={action.loading}
        canPromoteCurrentDetour={canPromoteCurrentDetour}
        directCheckpointItemId={directCheckpointItem?.id ?? null}
        onTabChange={setInspectorTab}
        onClose={closeInspector}
        onDetourLearningUnitIdChange={setDetourLearningUnitId}
        onCommand={(kind, targetAgendaItemId) => void mixedCommand(kind, targetAgendaItemId)}
      />
    </div>
  );
}

function Exchange({
  exchange,
  metadata,
  anchor,
  failed,
  editDisabled,
  onEdit,
  routeTitle,
}: {
  exchange: StudyExchange;
  metadata?: TutorTurnMetadata | null;
  anchor?: TutorStudyAnchor;
  failed: boolean;
  editDisabled: boolean;
  onEdit: () => void;
  routeTitle: string;
}) {
  const label =
    exchange.role === 'learner' ? '你' : exchange.role === 'tutor' ? 'Hy3 Tutor' : '学习记录';
  const channelLabel =
    exchange.channel === 'informal_check'
      ? '非正式检查'
      : exchange.channel === 'operation_notice'
        ? '学习状态'
        : '对话';
  return (
    <article
      className={`study-exchange ${exchange.role} ${exchange.channel}`}
      aria-label={`${label}，${channelLabel}`}
    >
      <header className="study-exchange-header">
        {exchange.role === 'tutor' ? (
          <span className="study-tutor-avatar" aria-hidden="true">
            H3
          </span>
        ) : null}
        <strong>{label}</strong>
        {exchange.channel === 'informal_check' ? (
          <span className="study-channel-label informal">非正式 · 不计入进展</span>
        ) : null}
        {exchange.channel === 'operation_notice' ? (
          <span className="study-channel-label">状态</span>
        ) : null}
      </header>
      {exchange.role === 'learner' && metadata?.studyContext ? (
        <div className="study-tutor-turn-context">
          <small>
            {metadata.studyContext.lessonTitle} ·{' '}
            {metadata.studyContext.phase === 'lesson' ? '讲解' : '练习 / 修补'}
          </small>
          {metadata.studyContext.anchor?.selectedText ? (
            <blockquote>{metadata.studyContext.anchor.selectedText}</blockquote>
          ) : null}
        </div>
      ) : null}
      {exchange.role === 'learner' && !metadata?.studyContext && anchor?.selectedText ? (
        <blockquote className="study-tutor-turn-context">{anchor.selectedText}</blockquote>
      ) : null}
      <div className="study-exchange-content">
        {exchange.role === 'tutor' ? <TutorContent content={exchange.content} /> : exchange.content}
      </div>
      {failed ? (
        <p className="study-operation-notice">
          这条提问的回答未完成，问题已保留。
          <button type="button" className="ghost small" disabled={editDisabled} onClick={onEdit}>
            重新编辑提问
          </button>
        </p>
      ) : null}
      {exchange.role === 'tutor' && metadata ? (
        <TutorResponseDetails metadata={metadata} routeTitle={routeTitle} />
      ) : null}
    </article>
  );
}

function TutorContent({ content }: { content: string }) {
  const blocks = content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return (
    <div className="tutor-content-blocks">
      {blocks.length > 0
        ? blocks.map((block, index) => {
            const lines = block.split('\n');
            const bullets = lines.filter((line) => /^\s*[-*•]\s+/.test(line));
            if (bullets.length === lines.length && bullets.length > 0) {
              return (
                <ul key={index}>
                  {bullets.map((line) => (
                    <li key={line}>{line.replace(/^\s*[-*•]\s+/, '')}</li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={index}>
                {lines.map((line, lineIndex) => (
                  <span key={`${index}-${lineIndex}`}>
                    {line}
                    {lineIndex < lines.length - 1 ? <br /> : null}
                  </span>
                ))}
              </p>
            );
          })
        : content}
    </div>
  );
}

function TutorResponseDetails({
  metadata,
  routeTitle,
}: {
  metadata: TutorTurnMetadata;
  routeTitle: string;
}) {
  const moveLabel = TUTOR_MOVE_LABELS[metadata.move];
  const matchedSources = metadata.citations ?? [];
  return (
    <div className="study-tutor-response-details">
      {moveLabel ? <span className="study-tutor-move-cue">{moveLabel}</span> : null}
      {metadata.sourceRefs.length === 0 ? (
        <span className="study-tutor-synthesis-label">Hy3 补充解释</span>
      ) : matchedSources.length > 0 ? (
        <details className="study-tutor-sources">
          <summary>参考资料（{matchedSources.length}）</summary>
          <p className="small muted">
            以下是本次回答参考的原文。举例与延伸说明属于 Tutor 补充讲解。
          </p>
          <ul>
            {matchedSources.map((source) => (
              <li key={source.referenceKey}>
                <strong>{source.title}</strong>
                <span>{source.location}</span>
                <q>{source.excerpt}</q>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <span className="small muted">历史回答未保存来源摘录</span>
      )}
      {metadata.routeSignal === 'detour_started' ? (
        <p className="study-tutor-route-cue">这是一个补充问题，回答完可以回到：{routeTitle}</p>
      ) : null}
      {metadata.routeSignal === 'return_to_route' ? (
        <p className="study-tutor-route-cue">已回到本节：{routeTitle}</p>
      ) : null}
    </div>
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

function sessionStatusLabel(status: StudySession['status']): string {
  const labels: Record<StudySession['status'], string> = {
    active: '学习中',
    paused: '已暂停',
    completed: '已完成',
    abandoned: '已结束',
    interrupted: '已中断',
  };
  return labels[status];
}
