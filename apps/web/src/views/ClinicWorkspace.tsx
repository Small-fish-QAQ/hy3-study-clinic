import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CoursePlan,
  CourseKnowledgeInventory,
  CourseOperation,
  CourseSubmission,
  CourseRepairRound,
  ProviderMode,
  CoursePreferences,
  CourseTutorAnchor,
} from '@hy3-clinic/shared';
import {
  clinicApi,
  api,
  ApiClientError,
  type Classroom,
  type PublicCourseQuiz,
  type LearningRecords,
  type LearningProgress,
  type ClinicMaterialSummary,
  type WorkspaceSummary,
} from '../clinicApi.js';
import { ModelServiceSettings } from './ModelServiceSettings.js';
import { ClinicShell, type ClinicView } from './ClinicShell.js';
import { ClinicCourse, ClinicFormal } from './ClinicCourse.js';
import { ClinicMaterials } from './ClinicMaterials.js';
import { ClinicPreparation, ClinicPreparationStatus } from './ClinicPreparation.js';
import { ClinicClassroom, ClinicQuestions } from './ClinicClassroom.js';
import { ClinicProgress, ClinicRecords, statusLabel, operationLabel } from './ClinicRecords.js';
import { StudyText } from '../components/StudyText.js';
import { LearningCenter, type LearningCenterTab } from './LearningCenter.js';
import { CourseLibrary } from './CourseLibrary.js';
import { OperationFailure } from '../components/OperationFailure.js';

export function ClinicWorkspace() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('workspace'),
  );
  const [provider, setProvider] = useState<ProviderMode | null>(null);
  const [tab, setTab] = useState(() => {
    const view = new URLSearchParams(window.location.hash.slice(1)).get('view');
    return view &&
      [
        'course',
        'classroom',
        'formal',
        'graph',
        'progress',
        'records',
        'materials',
        'settings',
      ].includes(view)
      ? view
      : 'course';
  });
  const [centerTab, setCenterTab] = useState<LearningCenterTab>('progress');
  const inCenter = ['progress', 'records', 'materials'].includes(tab);
  const [plan, setPlan] = useState<CoursePlan | null>(null);
  const [inventory, setInventory] = useState<CourseKnowledgeInventory | null>(null);
  const [materials, setMaterials] = useState<ClinicMaterialSummary[]>([]);
  const [preferences, setPreferences] = useState<CoursePreferences>({
    desiredDepth: 'standard',
    focusRequest: '',
  });
  const [editingPreparation, setEditingPreparation] = useState(false);
  const [preparationSyncError, setPreparationSyncError] = useState('');
  const [records, setRecords] = useState<LearningRecords | null>(null);
  const [progress, setProgress] = useState<LearningProgress | null>(null);
  const [room, setRoom] = useState<Classroom | null>(null);
  const [quiz, setQuiz] = useState<PublicCourseQuiz | null>(null);
  const [attemptId, setAttemptId] = useState<string | undefined>();
  const [round, setRound] = useState<CourseRepairRound | undefined>();
  const [submission, setSubmission] = useState<CourseSubmission | null>(null);
  const [op, setOp] = useState<CourseOperation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [courseLoading, setCourseLoading] = useState(Boolean(workspaceId));
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [tutorAnchor, setTutorAnchor] = useState<CourseTutorAnchor | null>(null);
  const [tutorPending, setTutorPending] = useState(false);
  const [reflectionTarget, setReflectionTarget] = useState<string | null>(null);
  const [formalModule, setFormalModule] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[] | string>>({});
  const [hints, setHints] = useState<Record<string, string>>({});
  const [operations, setOperations] = useState<CourseOperation[]>([]);
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof clinicApi.submissionDetail>
  > | null>(null);
  const operationDone = useRef<((op: CourseOperation) => Promise<void>) | null>(null);
  const defaultDone = useRef<(op: CourseOperation) => Promise<void>>(async () => {});
  const workspaceRef = useRef(workspaceId);
  const workspaceEpoch = useRef(0);
  const preferencePlanRef = useRef<string | null>(null);
  if (workspaceRef.current !== workspaceId) {
    workspaceRef.current = workspaceId;
    workspaceEpoch.current += 1;
  }
  const act = useCallback(async (action: () => Promise<void>) => {
    const originEpoch = workspaceEpoch.current;
    setError('');
    setBusy(true);
    try {
      await action();
      return true;
    } catch (e) {
      if (workspaceEpoch.current === originEpoch)
        setError(e instanceof Error ? e.message : '操作未完成。');
      return false;
    } finally {
      if (workspaceEpoch.current === originEpoch) setBusy(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const [p, m, r, g, o] = await Promise.all([
      clinicApi.plan(workspaceId),
      clinicApi.materials(workspaceId),
      clinicApi.records(workspaceId),
      clinicApi.progress(workspaceId),
      clinicApi.operations(workspaceId),
    ]);
    if (workspaceRef.current !== workspaceId) return;
    setPlan(p.plan);
    setInventory(p.inventory);
    setMaterials(m.materials);
    setRecords(r);
    setProgress(g);
    setOperations(o.operations);
    setCourseLoading(false);
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId || !quiz || quiz.workspaceId !== workspaceId || submission) return;
    const timer = setTimeout(() => {
      void clinicApi
        .saveDraft(
          workspaceId,
          quiz,
          Object.entries(answers).map(([questionId, response]) => ({
            questionId,
            response,
            assistance: 'none',
          })),
        )
        .catch((e) => {
          if (workspaceRef.current === workspaceId)
            setError(e instanceof Error ? e.message : '答案草稿未保存。');
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [answers, quiz, submission, workspaceId]);
  useEffect(() => {
    void act(async () => {
      setWorkspaces((await clinicApi.workspaces()).workspaces);
      const config = await api.config().catch(() => null);
      if (config) setProvider(config.provider);
    });
  }, [act]);
  useEffect(() => {
    if (workspaceId) return;
    let current = true;
    void clinicApi
      .workspaces()
      .then((result) => {
        if (current) setWorkspaces(result.workspaces);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [workspaceId]);
  useEffect(() => {
    setCourseLoading(Boolean(workspaceId));
    setRoom(null);
    setQuiz(null);
    setSubmission(null);
    setRound(undefined);
    setOp(null);
    setPlan(null);
    setInventory(null);
    setDetail(null);
    setRecords(null);
    setProgress(null);
    setMaterials([]);
    setAttemptId(undefined);
    setHints({});
    setAnswers({});
    setQuestion('');
    setTutorAnchor(null);
    setReflectionTarget(null);
    setOperations([]);
    setEditingPreparation(false);
    preferencePlanRef.current = null;
    setPreferences({ desiredDepth: 'standard', focusRequest: '' });
    setPreparationSyncError('');
    operationDone.current = null;
    if (workspaceId)
      void clinicApi
        .operations(workspaceId)
        .then((result) => {
          if (workspaceRef.current !== workspaceId) return;
          setOperations(result.operations);
          const latest = result.operations[0];
          const pending =
            result.operations.find((op) => ['queued', 'running'].includes(op.status)) ??
            (latest &&
            (['interrupted', 'failed'].includes(latest.status) || latest.kind === 'preparePlan')
              ? latest
              : undefined);
          if (pending) {
            if (pending.preferences) setPreferences(pending.preferences);
            operationDone.current = (op) => defaultDone.current(op);
            setOp(pending);
          }
        })
        .catch(() => {});
    void act(async () => {
      try {
        await refresh();
      } finally {
        if (workspaceRef.current === workspaceId) setCourseLoading(false);
      }
    });
  }, [workspaceId, refresh, act]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace', workspaceId);
    if (tab !== 'course') params.set('view', tab);
    window.history.replaceState(null, '', `#${params.toString()}`);
  }, [workspaceId, tab]);
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      setWorkspaceId(params.get('workspace'));
      const view = params.get('view');
      setTab(
        view &&
          [
            'course',
            'classroom',
            'formal',
            'graph',
            'progress',
            'records',
            'materials',
            'settings',
          ].includes(view)
          ? view
          : 'course',
      );
    };
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    return () => {
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
    };
  }, []);
  useEffect(() => {
    if (inCenter) setCenterTab(tab as LearningCenterTab);
  }, [tab, inCenter]);
  useEffect(() => {
    if (plan && preferencePlanRef.current !== plan.id) {
      preferencePlanRef.current = plan.id;
      if (
        op?.preferences &&
        ['queued', 'running', 'interrupted', 'failed', 'cancelled'].includes(op.status)
      )
        setPreferences(op.preferences);
      else if (plan.preferences) setPreferences(plan.preferences);
    }
  }, [plan, op]);
  useEffect(() => {
    if (!workspaceId || !op || !['queued', 'running'].includes(op.status)) return;
    let active = true;
    const timer = setInterval(() => {
      void clinicApi
        .operation(workspaceId, op.id)
        .then(async (next) => {
          if (!active) return;
          setOp(next);
          setPreparationSyncError('');
          if (next.status === 'completed') {
            clearInterval(timer);
            const done = operationDone.current;
            operationDone.current = null;
            if (done) await act(() => done(next));
            await refresh();
          }
        })
        .catch((e) => {
          if (active) {
            if (op.kind === 'preparePlan')
              setPreparationSyncError(e instanceof Error ? e.message : '状态查询未完成。');
            else setError(e instanceof Error ? e.message : '状态查询未完成。');
          }
        });
    }, 700);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [workspaceId, op, act, refresh]);
  function follow(operation: CourseOperation, done?: (op: CourseOperation) => Promise<void>) {
    if (operation.workspaceId !== workspaceRef.current) return;
    operationDone.current = done ?? ((op) => defaultDone.current(op));
    setOp(operation);
    if (operation.status === 'completed') {
      const complete = operationDone.current;
      operationDone.current = null;
      void act(async () => {
        if (complete) await complete(operation);
        await refresh();
      });
    }
  }
  const showQuiz = async (quizId: string) => {
    const originWorkspaceId = workspaceId!;
    const next = await clinicApi.quiz(quizId);
    const saved = (await clinicApi.records(originWorkspaceId)).submissions.find(
      (s) => s.quizId === quizId,
    );
    const draft = await clinicApi.draft(originWorkspaceId, next);
    const started =
      next.purpose === 'formal' && !saved
        ? await clinicApi.startFormal(originWorkspaceId, quizId)
        : null;
    if (workspaceRef.current !== originWorkspaceId) return;
    setQuiz(next);
    setRoom(null);
    setHints({});
    setAnswers(
      Object.fromEntries(
        (saved?.responses ?? draft.answers).map((a) => [a.questionId, a.response]),
      ),
    );
    setSubmission(saved ?? null);
    setRound(undefined);
    setAttemptId(started?.id);
    setTab('classroom');
  };
  const showRound = async (roundId: string) => {
    const originWorkspaceId = workspaceId!;
    const ready = await clinicApi.round(roundId);
    const saved = ready.round.retestSubmissionId
      ? await clinicApi.submission(originWorkspaceId, ready.round.retestSubmissionId)
      : null;
    const draft = ready.quiz
      ? await clinicApi.draft(originWorkspaceId, ready.quiz)
      : { answers: [] };
    if (workspaceRef.current !== originWorkspaceId) return;
    setRoom(null);
    setRound(ready.round);
    setQuiz(ready.quiz);
    setSubmission(saved);
    setAnswers(
      Object.fromEntries(
        (saved?.responses ?? draft.answers).map((a) => [a.questionId, a.response]),
      ),
    );
    setAttemptId(undefined);
    setHints({});
    setTab('classroom');
  };
  defaultDone.current = async (operation) => {
    if (!workspaceId || !operation.resourceId || operation.workspaceId !== workspaceId) return;
    if (operation.kind === 'preparePlan') setTab('course');
    else if (operation.kind === 'preparePractice' || operation.kind === 'prepareFormal')
      await showQuiz(operation.resourceId);
    else if (operation.kind === 'prepareLesson') {
      const id = (operation.result as { lessonId?: string })?.lessonId;
      if (id) await openLesson(id);
    } else if (operation.kind === 'prepareRepair') {
      await showRound(operation.resourceId);
    } else if (operation.kind === 'gradeAssessment') {
      const result = await clinicApi.submissionDetail(workspaceId, operation.resourceId);
      if (workspaceRef.current !== workspaceId) return;
      setSubmission(result.submission);
      setQuiz(result.quiz);
      setRoom(null);
      setRound(undefined);
      setAttemptId(undefined);
      setAnswers(
        Object.fromEntries(result.submission.responses.map((a) => [a.questionId, a.response])),
      );
      setTab('classroom');
    }
  };
  const openLesson = async (lessonId: string) => {
    if (!workspaceId || !plan) return;
    const result = await clinicApi.open(workspaceId, plan, lessonId);
    if (workspaceRef.current !== workspaceId) return;
    if ('session' in result) {
      const classroom = await clinicApi.classroom(workspaceId, result.session.id);
      if (workspaceRef.current !== workspaceId) return;
      setRoom(classroom);
      setQuiz(null);
      setSubmission(null);
      setRound(undefined);
      setAttemptId(undefined);
      setAnswers({});
      setHints({});
      setQuestion('');
      setTutorAnchor(null);
      setTab('classroom');
    } else
      follow(result, async () => {
        await openLesson(lessonId);
      });
  };
  async function startRepair(source: CourseSubmission, replace?: CourseRepairRound) {
    const result = await clinicApi.repair(workspaceId!, source, replace);
    if (workspaceRef.current !== workspaceId) return;
    setRound(result);
    const operation = await clinicApi.operation(workspaceId!, result.operationId);
    follow(operation, async () => {
      await showRound(result.id);
    });
  }
  async function upload(file: File, readingTitle: string) {
    const originWorkspaceId = workspaceId!;
    if (!/\.(pdf|docx|pptx|html?|htm)$/iu.test(file.name)) {
      const content = await file.text();
      if (workspaceRef.current !== originWorkspaceId) return;
      await clinicApi.import(originWorkspaceId, {
        filename: file.name,
        content,
        ...(readingTitle.trim() ? { title: readingTitle.trim() } : {}),
      });
      await refresh();
      return;
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.onerror = () => reject(new Error('文件读取失败。'));
      reader.readAsDataURL(file);
    });
    if (workspaceRef.current !== originWorkspaceId) return;
    await clinicApi.import(originWorkspaceId, {
      filename: file.name,
      ...(readingTitle.trim() ? { title: readingTitle.trim() } : {}),
      dataBase64: data,
    });
    await refresh();
  }
  const currentCourse = workspaces.find((w) => w.id === workspaceId);
  const preparing = op?.kind === 'preparePlan' && ['queued', 'running'].includes(op.status);
  const sourceChanged = Boolean(
    plan &&
    inventory &&
    JSON.stringify([...new Set(inventory.dispositions.map((d) => d.span.revisionId))].sort()) !==
      JSON.stringify(materials.map((m) => m.revisionId).sort()),
  );
  const startPreparation = async (frozenPreferences?: CoursePreferences) => {
    const operation = await clinicApi.prepare(workspaceId!, frozenPreferences ?? preferences);
    if (workspaceRef.current !== workspaceId) return;
    setEditingPreparation(false);
    setTab('course');
    follow(operation);
  };
  const retryPreparation = () =>
    void act(async () => {
      if (op?.status === 'cancelled') await startPreparation(op.preferences);
      else if (op) follow(await clinicApi.retry(workspaceId!, op));
    });
  const cancelPreparation = () =>
    void act(async () => {
      if (!op || !workspaceId) return;
      // Dispatch may have advanced queued -> running before the first poll.
      const latest = await clinicApi.operation(workspaceId, op.id);
      if (workspaceRef.current !== workspaceId) return;
      if (!['queued', 'running'].includes(latest.status)) {
        follow(latest);
        return;
      }
      try {
        const cancelled = await clinicApi.cancel(workspaceId, latest);
        if (workspaceRef.current === workspaceId) setOp(cancelled);
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== 'VERSION_CONFLICT') throw error;
        const current = await clinicApi.operation(workspaceId, op.id);
        if (workspaceRef.current !== workspaceId) return;
        if (['queued', 'running'].includes(current.status)) throw error;
        follow(current);
      }
    });
  const viewForTab: Record<string, ClinicView> = {
    course: 'home',
    classroom: 'session',
    formal: 'formal',
    progress: 'progress',
    graph: 'explore',
    records: 'records',
  };
  const tabForView: Record<ClinicView, string> = {
    home: 'course',
    session: 'classroom',
    formal: 'formal',
    progress: 'progress',
    explore: 'graph',
    records: 'records',
    center: centerTab,
  };
  function navigate(destination: string) {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace', workspaceId);
    if (destination !== 'course') params.set('view', destination);
    window.history.pushState(null, '', `#${params.toString()}`);
    setTab(destination);
    setError('');
    if (destination === 'records' || destination === 'progress' || destination === 'formal')
      void act(refresh);
  }
  const createCourse = async () => {
    const workspace = await clinicApi.createWorkspace(title);
    setWorkspaces((previous) => [...previous, workspace]);
    setWorkspaceId(workspace.id);
    setTitle('');
    setTab('materials');
  };
  const openSession = async (sessionId: string) => {
    const originWorkspace = workspaceId!;
    const classroom = await clinicApi.classroom(originWorkspace, sessionId);
    if (workspaceRef.current !== originWorkspace) return;
    setRoom(classroom);
    setQuiz(null);
    setRound(undefined);
    setSubmission(null);
    setQuestion('');
    setTutorAnchor(null);
    setTab('classroom');
  };
  const submitAnswers = async () => {
    if (!quiz || !workspaceId) return;
    const result = await clinicApi.submit(
      workspaceId,
      quiz,
      quiz.items.map((q) => ({ questionId: q.id, response: answers[q.id], assistance: 'none' })),
      attemptId,
      round,
    );
    if (workspaceRef.current !== workspaceId) return;
    setSubmission(result.submission);
    if (result.operation)
      follow(result.operation, async () => {
        const graded = await clinicApi.submission(workspaceId, result.submission.id);
        const updatedRound = round ? (await clinicApi.round(round.id)).round : undefined;
        if (workspaceRef.current !== workspaceId) return;
        setSubmission(graded);
        if (updatedRound) setRound(updatedRound);
      });
  };
  const askTutor = async () => {
    if (!room || !workspaceId) return;
    let current = room;
    if (current.session.status !== 'active') {
      const session = await clinicApi.revisit(workspaceId, current);
      current = await clinicApi.classroom(workspaceId, session.id);
    }
    if (workspaceRef.current !== workspaceId) return;
    setTutorPending(true);
    try {
      await clinicApi.tutor(workspaceId, current.session.id, question, tutorAnchor);
    } finally {
      if (workspaceRef.current === workspaceId) setTutorPending(false);
    }
    const updated = await clinicApi.classroom(workspaceId, current.session.id);
    if (workspaceRef.current !== workspaceId) return;
    setQuestion('');
    setTutorAnchor(null);
    setRoom(updated);
    await refresh();
  };
  const notifications = (
    <>
      {error && (
        <div role="alert" className="banner error">
          {error}
          <button className="ghost" onClick={() => setError('')}>
            关闭提示
          </button>
        </div>
      )}
      {op && op.status !== 'completed' && !(op.kind === 'preparePlan' && tab === 'course') && (
        <div className="clinic-operation" role="status">
          <div>
            <span className="eyebrow">{operationLabel[op.kind]}</span>
            <strong>{statusLabel[op.status]}</strong>
            {op.error && <OperationFailure operation={op} />}
          </div>
          <div className="clinic-button-row">
            {['failed', 'interrupted'].includes(op.status) && op.error?.retryable !== false && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    follow(
                      await clinicApi.retry(workspaceId!, op),
                      operationDone.current ?? undefined,
                    ),
                  )
                }
              >
                重试未完成范围
              </button>
            )}
            {['queued', 'running'].includes(op.status) && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => setOp(await clinicApi.cancel(workspaceId!, op)))
                }
              >
                取消本次操作
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
  const page = (
    <>
      {tab === 'settings' ? (
        <section className="settings-view">
          <header className="settings-page-intro">
            <p className="eyebrow">按你的方式学习</p>
            <h1>设置</h1>
            <p>连接模型，配置请求资源与等待时间。</p>
          </header>
          <ModelServiceSettings onActiveConfig={(config) => setProvider(config.provider)} />
        </section>
      ) : !workspaceId ? (
        <section className="no-course-state" aria-label="选择或创建课程">
          <header className="course-library-intro">
            <img
              className="studio-artwork"
              src="/brand/study-folio.webp"
              srcSet="/brand/study-folio-1080.webp 1080w, /brand/study-folio.webp 1728w"
              sizes="(max-width: 999px) 0px, (max-width: 1200px) 50vw, 770px"
              width="1728"
              height="1024"
              alt=""
            />
            <p className="eyebrow">你的学习工作室</p>
            <h2>
              把不懂的地方，
              <br />
              <em>一步步学明白。</em>
            </h2>
            <p className="muted">
              从你的资料出发，串起讲解、练习与反馈。每次回来，都从上次停下的地方继续。
            </p>
          </header>
          <CourseLibrary
            courses={workspaces}
            busy={busy}
            onOpen={(id) => {
              setWorkspaceId(id);
              setTab('course');
            }}
            onDelete={(ids) =>
              act(async () => {
                const removed = await clinicApi.deleteWorkspaces(ids);
                setWorkspaces((prior) => prior.filter((w) => !removed.workspaceIds.includes(w.id)));
                if (workspaceRef.current && removed.workspaceIds.includes(workspaceRef.current)) {
                  setWorkspaceId(null);
                  setTab('course');
                }
              })
            }
          />
          <section className="clinic-create-course">
            <h3>开始一门新课程</h3>
            <p className="muted">给它起个名字，再带上你想学的资料。</p>
            <form
              className="course-create-inline"
              onSubmit={(e) => {
                e.preventDefault();
                void act(createCourse);
              }}
            >
              <label className="sr-only" htmlFor="new-course-name">
                新课程名称
              </label>
              <input
                id="new-course-name"
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：认知科学导论"
              />
              <button className="primary" disabled={busy || !title.trim()}>
                新建课程
              </button>
            </form>
          </section>
        </section>
      ) : tab === 'course' ? (
        <>
          {courseLoading && !plan && (
            <p className="course-read-status" role="status">
              正在读取课程资料与准备状态…
            </p>
          )}
          {op?.kind === 'preparePlan' &&
            !editingPreparation &&
            (op.status !== 'completed' ||
              (op.resourceId === plan?.id && plan.status === 'draft') ||
              !plan) && (
              <ClinicPreparationStatus
                operation={op}
                plan={plan}
                syncError={preparationSyncError}
                busy={busy}
                onRetry={retryPreparation}
                onCancel={cancelPreparation}
                onSettings={() => {
                  setEditingPreparation(true);
                  setPreparationSyncError('');
                }}
              />
            )}
          {(!plan || editingPreparation) &&
          !courseLoading &&
          !(op?.kind === 'preparePlan' && !editingPreparation) ? (
            <ClinicPreparation
              courseName={currentCourse?.title ?? '课程'}
              materials={materials}
              preferences={preferences}
              busy={busy || Boolean(preparing)}
              hasPlan={Boolean(plan)}
              onPreferences={setPreferences}
              onStart={() => void act(startPreparation)}
              onMaterials={() => navigate('materials')}
              onBack={plan ? () => setEditingPreparation(false) : undefined}
            />
          ) : plan && !editingPreparation && !preparing ? (
            <ClinicCourse
              plan={plan}
              sourceChanged={sourceChanged}
              onPrepare={() => {
                setEditingPreparation(true);
                setOp(null);
              }}
              inventory={inventory}
              progress={progress}
              busy={busy}
              onDepth={(lessonId, depth) =>
                void act(async () => {
                  const updated = await clinicApi.depth(workspaceId, plan!, lessonId, depth);
                  if (workspaceRef.current === workspaceId) setPlan(updated);
                })
              }
              onConfirm={() =>
                void act(async () => {
                  const confirmed = await clinicApi.confirm(workspaceId, plan!);
                  if (workspaceRef.current !== workspaceId) return;
                  setPlan(confirmed);
                  await refresh();
                })
              }
              onLesson={(id) => void act(() => openLesson(id))}
              onFormal={(id) => {
                setFormalModule(id ?? null);
                navigate('formal');
              }}
              onMaterials={() => navigate('materials')}
            />
          ) : null}
        </>
      ) : tab === 'formal' ? (
        <ClinicFormal
          plan={plan}
          progress={progress}
          initialModuleId={formalModule}
          busy={busy}
          onGenerate={(moduleId) =>
            void act(async () =>
              follow(await clinicApi.formal(workspaceId, plan!, moduleId), async (next) =>
                showQuiz(next.resourceId!),
              ),
            )
          }
          onHistory={() => navigate('records')}
        />
      ) : tab === 'materials' ? (
        <ClinicMaterials
          key={workspaceId}
          materials={materials}
          busy={busy || Boolean(preparing)}
          hasPlan={Boolean(plan)}
          onBack={() => navigate('course')}
          onImport={(input) =>
            act(async () => {
              if (input.file) await upload(input.file, input.title);
              else {
                await clinicApi.import(workspaceId, {
                  content: input.content,
                  ...(input.title.trim() ? { title: input.title.trim() } : {}),
                });
                await refresh();
              }
            })
          }
          onRename={(id, readingTitle) =>
            act(async () => {
              await clinicApi.renameMaterial(workspaceId, id, readingTitle);
              await refresh();
            })
          }
          onRemove={(id) =>
            act(async () => {
              await clinicApi.removeMaterial(workspaceId, id);
              await refresh();
            })
          }
        />
      ) : tab === 'classroom' ? (
        <ClinicClassroom
          room={room}
          plan={plan}
          busy={busy}
          question={question}
          activityTitle={
            quiz
              ? round
                ? '补救与 Retest'
                : quiz.purpose === 'formal'
                  ? '正式考核'
                  : quiz.purpose === 'explicit_review'
                    ? '主动复习'
                    : '按需练习'
              : undefined
          }
          onQuestion={setQuestion}
          anchor={tutorAnchor}
          onAnchor={setTutorAnchor}
          tutorPending={tutorPending}
          initialSegmentId={reflectionTarget}
          completedLessonIds={progress?.completedLessonIds}
          onFormal={(id) => {
            setFormalModule(id);
            navigate('formal');
          }}
          onReflection={(segmentId, status, response) =>
            void act(async () => {
              const currentRoom = room!;
              await clinicApi.reflection(workspaceId, currentRoom, segmentId, status, response);
              const updated = await clinicApi.classroom(workspaceId, currentRoom.session.id);
              if (workspaceRef.current === workspaceId) setRoom(updated);
              await refresh();
            })
          }
          onTutor={() => void act(askTutor)}
          onComplete={() =>
            void act(async () => {
              await clinicApi.complete(workspaceId, room!);
              const completed = await clinicApi.classroom(workspaceId, room!.session.id);
              if (workspaceRef.current !== workspaceId) return;
              setRoom(completed);
              await refresh();
            })
          }
          onPractice={() =>
            void act(async () =>
              follow(await clinicApi.practice(workspaceId, room!), async (next) =>
                showQuiz(next.resourceId!),
              ),
            )
          }
          onLesson={(id) => void act(() => openLesson(id))}
          onCourse={() => navigate('course')}
          onSession={(id) => void act(() => openSession(id))}
        >
          {quiz && (
            <ClinicQuestions
              quiz={quiz}
              round={round}
              submission={submission}
              answers={answers}
              hints={hints}
              busy={busy}
              onAnswers={(questionId, response) =>
                setAnswers((previous) => ({ ...previous, [questionId]: response }))
              }
              onHint={(questionId) =>
                void act(async () => {
                  const result = await clinicApi.hint(workspaceId, quiz, questionId);
                  if (workspaceRef.current !== workspaceId) return;
                  setHints((previous) => ({ ...previous, [questionId]: result.hint }));
                })
              }
              onSubmit={() => void act(submitAnswers)}
              onRepair={() => void act(() => startRepair(submission!))}
              onCourse={() => navigate('course')}
            />
          )}
        </ClinicClassroom>
      ) : tab === 'progress' && progress ? (
        <ClinicProgress
          progress={progress}
          busy={busy}
          onLesson={(id, segmentId) =>
            void act(async () => {
              setReflectionTarget(segmentId);
              await openLesson(id);
            })
          }
          onReview={(id) =>
            void act(async () =>
              follow(await clinicApi.review(workspaceId, id), async (next) =>
                showQuiz(next.resourceId!),
              ),
            )
          }
          onReconcile={() =>
            void act(async () => {
              const reconciled = await clinicApi.reconcile(workspaceId);
              if (workspaceRef.current === workspaceId) setProgress(reconciled);
            })
          }
        />
      ) : tab === 'records' && records ? (
        <ClinicRecords
          records={records}
          operations={operations}
          detail={detail}
          busy={busy}
          onSession={(id) => void act(() => openSession(id))}
          onDetail={(id) =>
            void act(async () => {
              const result = await clinicApi.submissionDetail(workspaceId, id);
              if (workspaceRef.current === workspaceId) setDetail(result);
            })
          }
          onCloseDetail={() => setDetail(null)}
          onRepair={(source, replace) => void act(() => startRepair(source, replace))}
          onRound={(id) => void act(() => showRound(id))}
          onRetry={(operation) =>
            void act(async () => follow(await clinicApi.retry(workspaceId, operation)))
          }
          onSupplementFormal={(operation) =>
            void act(async () => follow(await clinicApi.supplementFormal(workspaceId, operation)))
          }
          onResult={(operation) => void act(() => defaultDone.current(operation))}
        />
      ) : tab === 'graph' && plan && inventory ? (
        <section className="clinic-graph-view">
          <header className="course-home-context">
            <p className="eyebrow">从全貌走向理解</p>
            <h1>课程知识关系</h1>
            <p className="muted">
              知识与先修关系来自已确认的课程和来源；它们提供导航，不代表掌握度。
            </p>
          </header>
          {plan.lessons.map((lesson, i) => (
            <article className="card clinic-graph-lesson" key={lesson.id}>
              <div className="clinic-card-meta">
                <span className="eyebrow">Lesson {String(i + 1).padStart(2, '0')}</span>
                {plan.status === 'accepted' && (
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => void act(() => openLesson(lesson.id))}
                  >
                    打开相关 Lesson
                  </button>
                )}
              </div>
              <h2>{lesson.title}</h2>
              <p className="clinic-prerequisite">
                建议先修：
                {lesson.prerequisiteLessonIds.length
                  ? lesson.prerequisiteLessonIds
                      .map((id) => plan.lessons.find((previous) => previous.id === id)?.title)
                      .join('、')
                  : '可直接学习'}
              </p>
              {inventory.knowledge
                .filter((k) => lesson.knowledgeIds.includes(k.id))
                .map((k) => (
                  <details className="clinic-disclosure" key={k.id}>
                    <summary>{k.title}</summary>
                    <StudyText text={k.statement} />
                    <p className="muted">
                      相关知识：
                      {[...k.prerequisiteKnowledgeIds, ...k.relatedKnowledgeIds]
                        .map(
                          (id) => inventory.knowledge.find((previous) => previous.id === id)?.title,
                        )
                        .filter(Boolean)
                        .join('、') || '本课中结合讲解'}
                    </p>
                  </details>
                ))}
            </article>
          ))}
        </section>
      ) : (
        <section className="course-empty-state">
          <h2>这里还没有学习记录</h2>
          <p>准备课程规划，然后从任意 Lesson 开始。</p>
          <button className="primary" onClick={() => navigate('course')}>
            返回课程
          </button>
        </section>
      )}
    </>
  );
  return (
    <ClinicShell
      activeView={viewForTab[tab] ?? 'home'}
      courseId={workspaceId}
      courseName={workspaceId ? (currentCourse?.title ?? '课程') : null}
      courses={workspaces.map((w) => ({ id: w.id, name: w.title }))}
      materialsActive={tab === 'materials'}
      settingsActive={tab === 'settings'}
      provider={provider}
      onCourseChange={(id) => {
        setWorkspaceId(id);
        setTab('course');
      }}
      onViewChange={(view) => navigate(tabForView[view])}
      onOpenMaterials={() => navigate('materials')}
      onOpenSettings={() => navigate('settings')}
      notifications={notifications}
    >
      {inCenter && workspaceId ? (
        <LearningCenter active={tab as LearningCenterTab} onChange={navigate}>
          {page}
        </LearningCenter>
      ) : (
        page
      )}
    </ClinicShell>
  );
}
