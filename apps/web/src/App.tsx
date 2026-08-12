import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  Answer,
  Concept,
  DocumentDeletionResult,
  PublicQuiz,
  SourceBlock,
} from '@hy3-clinic/shared';
import {
  ApiClientError,
  api,
  type MaterialSummary,
  type MaterialWithBlocks,
  type SubmissionResponse,
} from './api.js';
import { useAsyncAction } from './components/useAsyncAction.js';
import { ImportView } from './views/ImportView.js';
import { GraphWorkspaceView, clearLastWorkspaceId } from './views/GraphWorkspaceView.js';
import { QuizView } from './views/QuizView.js';
import { ResultsView } from './views/ResultsView.js';
import { QuizHistoryView } from './views/QuizHistoryView.js';
import { MistakesView } from './views/MistakesView.js';
import { MasteryView } from './views/MasteryView.js';
import { AgentCourseWorkspace } from './views/AgentCourseWorkspace.js';
import { Banner } from './components/ui.js';

type Tab = 'import' | 'course' | 'graph' | 'quiz' | 'results' | 'history' | 'mistakes' | 'mastery';
type PracticeTab = Extract<Tab, 'quiz' | 'results' | 'history'>;

const LAST_MATERIAL_ID_STORAGE_KEY = 'hy3-clinic:last-material-id';

/** Compatibility destinations. The selected Course owns the primary journey. */
type Module = 'import' | 'course' | 'graph' | 'practice' | 'mistakes' | 'mastery';

const MODULE_LABELS: Record<Module, string> = {
  import: '课程资料',
  course: '课程',
  graph: '探索',
  practice: '测验',
  mistakes: '错题与修复',
  mastery: '掌握与复习',
};

const MODULE_OF_TAB: Record<Tab, Module> = {
  import: 'import',
  course: 'course',
  graph: 'graph',
  quiz: 'practice',
  results: 'practice',
  history: 'practice',
  mistakes: 'mistakes',
  mastery: 'mastery',
};

const PRACTICE_TABS: PracticeTab[] = ['quiz', 'results', 'history'];

/** Evidence context of a workspace-scoped (adaptive) assessment. */
interface AssessmentContext {
  workspaceId: string;
  blocks: SourceBlock[];
  documentTitles: Map<string, string>;
}

export function App() {
  const [tab, setTab] = useState<Tab>('course');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null | undefined>(
    undefined,
  );
  const [provider, setProvider] = useState<'fake' | 'hy3' | null>(null);
  const [material, setMaterial] = useState<MaterialWithBlocks | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [recentMaterials, setRecentMaterials] = useState<MaterialSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openingMaterialId, setOpeningMaterialId] = useState<string | null>(null);
  const [deletingCurrentMaterial, setDeletingCurrentMaterial] = useState(false);
  const [quiz, setQuiz] = useState<PublicQuiz | null>(null);
  const [result, setResult] = useState<SubmissionResponse | null>(null);
  const [lastAnswers, setLastAnswers] = useState<Answer[]>([]);
  const [assessment, setAssessment] = useState<AssessmentContext | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const materialRequestRef = useRef(0);
  const activeMaterialIdRef = useRef<string | null>(null);
  const activeAssessmentWorkspaceRef = useRef<string | null>(null);
  /** Ref twin of `material` so callbacks never act on a stale closure. */
  const materialRef = useRef<MaterialWithBlocks | null>(null);
  useEffect(() => {
    materialRef.current = material;
  }, [material]);
  /** Monotonic id of history-list refreshes (take-latest, see below). */
  const historyRefreshRef = useRef(0);
  const remediationAction = useAsyncAction();

  useEffect(() => {
    api
      .config()
      .then((c) => setProvider(c.provider))
      .catch(() => setProvider(null));
  }, []);

  useEffect(() => {
    let alive = true;
    const requestId = ++materialRequestRef.current;

    async function loadHistoryAndRestore() {
      setHistoryLoading(true);
      setHistoryError(null);

      try {
        const history = await api.listMaterials();
        if (!alive || materialRequestRef.current !== requestId) return;

        // A concurrent refresh (for example after a course-space deletion)
        // is newer than this initial load; never overwrite its list.
        if (historyRefreshRef.current === 0) {
          setRecentMaterials(history.materials);
        }
        setHistoryLoading(false);

        const savedId = readLastMaterialId();
        if (savedId === null) return;
        if (!savedId || !history.materials.some((item) => item.id === savedId)) {
          clearLastMaterialId(savedId);
          return;
        }

        setOpeningMaterialId(savedId);
        try {
          const [restored, storedConcepts] = await Promise.all([
            api.getMaterial(savedId),
            api.getConcepts(savedId),
          ]);
          if (!alive || materialRequestRef.current !== requestId) return;

          activeMaterialIdRef.current = savedId;
          setMaterial(restored);
          setConcepts(storedConcepts.concepts);
          setQuiz(null);
          setResult(null);
          setLastAnswers([]);
        } catch (error) {
          if (!alive || materialRequestRef.current !== requestId) return;
          if (isNotFound(error)) {
            setRecentMaterials((items) => items.filter((item) => item.id !== savedId));
            clearLastMaterialId(savedId);
          } else {
            setHistoryError(`无法恢复上次资料：${errorMessage(error)}`);
          }
        } finally {
          if (alive && materialRequestRef.current === requestId) {
            setOpeningMaterialId(null);
          }
        }
      } catch (error) {
        if (alive && materialRequestRef.current === requestId) {
          setHistoryError(`无法加载最近资料：${errorMessage(error)}`);
        }
      } finally {
        if (alive && materialRequestRef.current === requestId) {
          setHistoryLoading(false);
        }
      }
    }

    void loadHistoryAndRestore();
    return () => {
      alive = false;
    };
  }, []);

  function handleImported(imported: MaterialWithBlocks) {
    materialRequestRef.current += 1;
    activeMaterialIdRef.current = imported.material.id;
    activeAssessmentWorkspaceRef.current = null;
    remediationAction.cancel();
    remediationAction.clearError();
    setMaterial(imported);
    setConcepts([]);
    setAssessment(null);
    setRecentMaterials((items) => [
      toMaterialSummary(imported),
      ...items.filter((item) => item.id !== imported.material.id),
    ]);
    setHistoryLoading(false);
    setHistoryError(null);
    setOpeningMaterialId(null);
    setQuiz(null);
    setResult(null);
    setLastAnswers([]);
    setRefreshKey((key) => key + 1);
    setTab('import');
    writeLastMaterialId(imported.material.id);
  }

  async function handleOpenMaterial(materialId: string) {
    const requestId = ++materialRequestRef.current;
    const previousMaterialId = activeMaterialIdRef.current;
    activeMaterialIdRef.current = null;
    remediationAction.cancel();
    remediationAction.clearError();
    setHistoryError(null);
    setOpeningMaterialId(materialId);

    try {
      const [restored, storedConcepts] = await Promise.all([
        api.getMaterial(materialId),
        api.getConcepts(materialId),
      ]);
      if (materialRequestRef.current !== requestId) return;

      activeMaterialIdRef.current = materialId;
      activeAssessmentWorkspaceRef.current = null;
      setMaterial(restored);
      setConcepts(storedConcepts.concepts);
      setAssessment(null);
      setQuiz(null);
      setResult(null);
      setLastAnswers([]);
      setRefreshKey((key) => key + 1);
      setTab('import');
      writeLastMaterialId(materialId);
    } catch (error) {
      if (materialRequestRef.current !== requestId) return;
      activeMaterialIdRef.current = previousMaterialId;
      setTab('import');
      if (isNotFound(error)) {
        setRecentMaterials((items) => items.filter((item) => item.id !== materialId));
        clearLastMaterialId(materialId);
        setHistoryError('该历史资料已不存在，已从列表中移除。');
      } else {
        setHistoryError(`无法打开资料：${errorMessage(error)}`);
      }
    } finally {
      if (materialRequestRef.current === requestId) {
        setOpeningMaterialId(null);
      }
    }
  }

  async function handleRenameMaterial(materialId: string, title: string, signal: AbortSignal) {
    const updated = await api.renameMaterial(materialId, title, signal);
    if (signal.aborted) return;
    setRecentMaterials((items) =>
      items.map((item) =>
        item.id === materialId ? { ...item, title: updated.material.title } : item,
      ),
    );
    if (activeMaterialIdRef.current === materialId) {
      setMaterial((current) =>
        current?.material.id === materialId ? { ...current, material: updated.material } : current,
      );
    }
    setHistoryError(null);
  }

  async function handleDeleteMaterial(materialId: string, signal: AbortSignal) {
    const deletingCurrent = activeMaterialIdRef.current === materialId;
    if (deletingCurrent) {
      materialRequestRef.current += 1;
      activeMaterialIdRef.current = null;
      setDeletingCurrentMaterial(true);
      remediationAction.cancel();
      remediationAction.clearError();
    }

    let outcome: DocumentDeletionResult;
    try {
      outcome = await api.deleteMaterial(materialId, signal);
    } catch (error) {
      // No response — the deletion may or may not have reached the server
      // (a genuine cancel rejects with ABORTED before any response). Restore
      // the optimistic state; a truly deleted entry heals on next open
      // (404 → dropped with an explanatory message).
      if (deletingCurrent && activeMaterialIdRef.current === null) {
        activeMaterialIdRef.current = materialId;
      }
      setDeletingCurrentMaterial(false);
      throw error;
    }

    // A resolved response is server truth: the material — and, when
    // reported, its auto-created import workspace — is gone. Reconcile even
    // if the signal was aborted meanwhile (for example by navigating away
    // mid-request): aborting cannot undo a server-confirmed deletion.
    setRecentMaterials((items) => items.filter((item) => item.id !== materialId));
    clearLastMaterialId(materialId);
    setHistoryError(null);
    setDeletingCurrentMaterial(false);

    if (outcome.workspaceDeleted) {
      // The document's auto-created course space retired with it (server
      // confirmed, same transaction): forget the saved 学习图谱 selection
      // and drop a workspace-scoped assessment context that pointed at it,
      // so nothing can resurrect or reference the deleted space.
      clearLastWorkspaceId(outcome.workspaceId);
      if (activeAssessmentWorkspaceRef.current === outcome.workspaceId) {
        activeAssessmentWorkspaceRef.current = null;
        setAssessment(null);
        setQuiz(null);
        setResult(null);
        setLastAnswers([]);
      }
    }

    if (!deletingCurrent || activeMaterialIdRef.current !== null) return;

    setMaterial(null);
    setConcepts([]);
    setQuiz(null);
    setResult(null);
    setLastAnswers([]);
    setOpeningMaterialId(null);
    setHistoryLoading(false);
    setRefreshKey((key) => key + 1);
    setTab('import');
  }

  /**
   * A course space was deleted in 学习图谱 (server-confirmed). Its materials
   * were cascade-deleted with it, so every piece of state that referenced the
   * workspace must be dropped here: the open material and its quiz/result
   * context, a workspace-scoped assessment context, and the 资料库 history
   * list (reloaded from the server as the single source of truth).
   */
  function handleWorkspaceDeleted(workspaceId: string) {
    if (activeAssessmentWorkspaceRef.current === workspaceId) {
      activeAssessmentWorkspaceRef.current = null;
      setAssessment(null);
      setQuiz(null);
      setResult(null);
      setLastAnswers([]);
    }

    const openMaterial = materialRef.current;
    if (openMaterial && openMaterial.material.workspaceId === workspaceId) {
      materialRequestRef.current += 1;
      activeMaterialIdRef.current = null;
      remediationAction.cancel();
      remediationAction.clearError();
      clearLastMaterialId(openMaterial.material.id);
      setMaterial(null);
      setConcepts([]);
      setQuiz(null);
      setResult(null);
      setLastAnswers([]);
      setOpeningMaterialId(null);
      setRefreshKey((key) => key + 1);
    }

    const refreshId = ++historyRefreshRef.current;
    void api
      .listMaterials()
      .then((history) => {
        if (historyRefreshRef.current !== refreshId) return;
        setRecentMaterials(history.materials);
        setHistoryLoading(false);
      })
      .catch(() => {
        // Keep the current list; opening a removed entry already heals it
        // (404 → the entry is dropped with an explanatory message).
      });
  }

  function handleGraded(
    gradedQuiz: PublicQuiz,
    submissionResult: SubmissionResponse,
    answers: Answer[],
  ) {
    if (gradedQuiz.materialId === null) {
      // Workspace assessment: only accept while its context is still active.
      if (activeAssessmentWorkspaceRef.current !== (gradedQuiz.workspaceId ?? null)) return;
    } else if (activeMaterialIdRef.current !== gradedQuiz.materialId) {
      return;
    }
    setQuiz(gradedQuiz);
    setResult(submissionResult);
    setLastAnswers(answers);
    setRefreshKey((k) => k + 1);
    setTab('results');
  }

  async function doRemediation() {
    if (!material) return;
    const materialId = material.material.id;
    if (activeMaterialIdRef.current !== materialId) return;
    const res = await remediationAction.run((signal) => api.remediation(materialId, signal));
    if (res && activeMaterialIdRef.current === materialId && res.quiz.materialId === materialId) {
      setQuiz(res.quiz);
      setResult(null);
      setTab('quiz');
    }
  }

  /**
   * Launch an assessment produced by a plan, the daily queue, or a Tutor
   * activity. Document-scoped quizzes open the quiz's document (blocks are
   * needed for evidence display); workspace-scoped assessments load the
   * evidence blocks of every workspace document instead. Both paths are
   * guarded by the request epoch so a late load can never clobber a newer
   * selection.
   */
  async function handleLaunchFromPlan(launchedQuiz: PublicQuiz) {
    const requestId = ++materialRequestRef.current;
    remediationAction.cancel();

    if (launchedQuiz.materialId === null) {
      const workspaceId = launchedQuiz.workspaceId ?? null;
      if (!workspaceId) return;
      setOpeningMaterialId('workspace-assessment');
      try {
        const detail = await api.getWorkspace(workspaceId);
        const blockLists = await Promise.all(
          detail.documents.map((doc) => api.getMaterial(doc.id).then((m) => m.blocks)),
        );
        if (materialRequestRef.current !== requestId) return;
        activeAssessmentWorkspaceRef.current = workspaceId;
        setAssessment({
          workspaceId,
          blocks: blockLists.flat(),
          documentTitles: new Map(detail.documents.map((doc) => [doc.id, doc.title])),
        });
        setQuiz(launchedQuiz);
        setResult(null);
        setLastAnswers([]);
        setTab('quiz');
      } catch (error) {
        if (materialRequestRef.current !== requestId) return;
        setHistoryError(`无法打开课程空间评估:${errorMessage(error)}`);
      } finally {
        if (materialRequestRef.current === requestId) {
          setOpeningMaterialId(null);
        }
      }
      return;
    }

    const launchedMaterialId = launchedQuiz.materialId;
    setOpeningMaterialId(launchedMaterialId);
    try {
      const [restored, storedConcepts] = await Promise.all([
        api.getMaterial(launchedMaterialId),
        api.getConcepts(launchedMaterialId),
      ]);
      if (materialRequestRef.current !== requestId) return;
      activeMaterialIdRef.current = launchedMaterialId;
      activeAssessmentWorkspaceRef.current = null;
      setAssessment(null);
      setMaterial(restored);
      setConcepts(storedConcepts.concepts);
      setQuiz(launchedQuiz);
      setResult(null);
      setLastAnswers([]);
      setTab('quiz');
      writeLastMaterialId(launchedMaterialId);
    } catch (error) {
      if (materialRequestRef.current !== requestId) return;
      setHistoryError(`无法打开康复练习:${errorMessage(error)}`);
    } finally {
      if (materialRequestRef.current === requestId) {
        setOpeningMaterialId(null);
      }
    }
  }

  function handleTabChange(nextTab: Tab) {
    if (nextTab !== tab && remediationAction.loading) remediationAction.cancel();
    setTab(nextTab);
  }

  function handlePracticeTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    current: PracticeTab,
  ): void {
    const enabledTabs = PRACTICE_TABS.filter((item) => item !== 'results' || result !== null);
    const currentIndex = enabledTabs.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % enabledTabs.length;
    if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = enabledTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = enabledTabs[nextIndex]!;
    handleTabChange(next);
    requestAnimationFrame(() => document.getElementById(`practice-tab-${next}`)?.focus());
  }

  function handleModuleChange(module: Module) {
    handleTabChange(module === 'practice' ? 'quiz' : module);
  }

  const materialReady = material !== null && !deletingCurrentMaterial;
  const assessmentActive = assessment !== null && quiz !== null && quiz.materialId === null;
  const practiceBlocks = assessmentActive ? assessment.blocks : (material?.blocks ?? []);
  const activeModule = MODULE_OF_TAB[tab];

  return (
    <div className={`app-shell module-${activeModule}`}>
      {tab !== 'course' ? (
        <header className="app-header app-utility-header">
          <div className="app-utility-heading">
            <nav className="app-utility-return" aria-label="主导航">
              <button
                type="button"
                className="app-utility-back"
                onClick={() => handleModuleChange('course')}
              >
                <span aria-hidden="true">←</span>
                返回课程
              </button>
            </nav>
            <div className="app-branding">
              <p className="app-utility-kicker">Hy3 Study Clinic</p>
              <h1>兼容与高级工具</h1>
            </div>
          </div>
          <div className="app-utility-controls">
            <details className="legacy-tools" open>
              <summary>工具导航</summary>
              <nav className="legacy-nav" aria-label="兼容工具">
                {(Object.keys(MODULE_LABELS) as Module[])
                  .filter((module) => module !== 'course')
                  .map((module) => {
                    const needsMaterial = module !== 'import' && module !== 'graph';
                    const practiceViaAssessment = module === 'practice' && assessmentActive;
                    const disabled =
                      needsMaterial &&
                      !practiceViaAssessment &&
                      (!materialReady || openingMaterialId !== null);
                    return (
                      <button
                        key={module}
                        type="button"
                        className={activeModule === module ? 'active' : ''}
                        aria-current={activeModule === module ? 'page' : undefined}
                        disabled={disabled}
                        onClick={() => handleModuleChange(module)}
                      >
                        {MODULE_LABELS[module]}
                      </button>
                    );
                  })}
              </nav>
            </details>
            {provider ? (
              <span className={`provider-badge ${provider}`}>
                {provider === 'fake' ? '离线 · 模拟模式' : 'Hy3 在线'}
              </span>
            ) : null}
          </div>
        </header>
      ) : null}

      {remediationAction.error && tab !== 'mistakes' ? (
        <Banner kind="error">{remediationAction.error}</Banner>
      ) : null}

      <main
        className={
          tab === 'graph' ? 'main-graph' : tab === 'course' ? 'main-course' : 'main-scroll'
        }
      >
        {activeModule === 'practice' ? (
          <div className="practice-switch" role="tablist" aria-label="练习子页">
            <button
              id="practice-tab-quiz"
              type="button"
              role="tab"
              aria-selected={tab === 'quiz'}
              aria-controls="practice-panel-quiz"
              tabIndex={tab === 'quiz' ? 0 : -1}
              className={tab === 'quiz' ? 'active' : ''}
              onClick={() => handleTabChange('quiz')}
              onKeyDown={(event) => handlePracticeTabKeyDown(event, 'quiz')}
            >
              出题作答
            </button>
            <button
              id="practice-tab-results"
              type="button"
              role="tab"
              aria-selected={tab === 'results'}
              aria-controls="practice-panel-results"
              tabIndex={tab === 'results' ? 0 : -1}
              className={tab === 'results' ? 'active' : ''}
              disabled={!result}
              onClick={() => handleTabChange('results')}
              onKeyDown={(event) => handlePracticeTabKeyDown(event, 'results')}
            >
              判分结果
            </button>
            <button
              id="practice-tab-history"
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              aria-controls="practice-panel-history"
              tabIndex={tab === 'history' ? 0 : -1}
              className={tab === 'history' ? 'active' : ''}
              onClick={() => handleTabChange('history')}
              onKeyDown={(event) => handlePracticeTabKeyDown(event, 'history')}
            >
              测验历史
            </button>
          </div>
        ) : null}

        {tab === 'import' ? (
          <ImportView
            material={material}
            concepts={concepts}
            recentMaterials={recentMaterials}
            historyLoading={historyLoading}
            historyError={historyError}
            openingMaterialId={openingMaterialId}
            onImported={handleImported}
            onAnalyzed={(materialId, analyzedConcepts) => {
              if (activeMaterialIdRef.current === materialId) {
                setConcepts(analyzedConcepts);
              }
            }}
            onOpenMaterial={(materialId) => void handleOpenMaterial(materialId)}
            onRenameMaterial={handleRenameMaterial}
            onDeleteMaterial={handleDeleteMaterial}
          />
        ) : null}

        {tab === 'graph' ? (
          <GraphWorkspaceView
            refreshKey={refreshKey}
            onLaunchQuiz={(launchedQuiz) => void handleLaunchFromPlan(launchedQuiz)}
            onWorkspaceDeleted={handleWorkspaceDeleted}
            selectedWorkspaceId={selectedWorkspaceId}
            onWorkspaceSelected={setSelectedWorkspaceId}
          />
        ) : null}

        {tab === 'course' ? (
          <AgentCourseWorkspace
            workspaceId={selectedWorkspaceId ?? null}
            onWorkspaceChange={setSelectedWorkspaceId}
            onLaunchQuiz={(launchedQuiz) => void handleLaunchFromPlan(launchedQuiz)}
            refreshKey={refreshKey}
            provider={provider}
            onOpenAdvancedTools={() => handleModuleChange('import')}
            onWorkspaceDeleted={handleWorkspaceDeleted}
          />
        ) : null}

        {tab === 'quiz' && (material || assessmentActive) ? (
          <div id="practice-panel-quiz" role="tabpanel" aria-labelledby="practice-tab-quiz">
            <QuizView
              materialId={assessmentActive ? null : (material?.material.id ?? null)}
              blocks={practiceBlocks}
              hasConcepts={concepts.length > 0}
              quiz={quiz}
              documentTitles={assessmentActive ? assessment.documentTitles : undefined}
              onQuizGenerated={(q) => {
                if (q.materialId !== null && activeMaterialIdRef.current !== q.materialId) return;
                setQuiz(q);
                setResult(null);
              }}
              onGraded={handleGraded}
            />
          </div>
        ) : null}

        {tab === 'results' && quiz && result && (material || assessmentActive) ? (
          <div id="practice-panel-results" role="tabpanel" aria-labelledby="practice-tab-results">
            <ResultsView
              quiz={quiz}
              result={result}
              answers={lastAnswers}
              blocks={practiceBlocks}
              onRemediate={() => void doRemediation()}
              remediationLoading={remediationAction.loading}
            />
          </div>
        ) : null}

        {tab === 'history' && (material || assessmentActive) ? (
          <div id="practice-panel-history" role="tabpanel" aria-labelledby="practice-tab-history">
            <QuizHistoryView
              workspaceId={
                assessmentActive ? assessment.workspaceId : (material?.material.workspaceId ?? null)
              }
            />
          </div>
        ) : null}

        {tab === 'mistakes' && material ? (
          <MistakesView
            materialId={material.material.id}
            refreshKey={refreshKey}
            onRemediate={() => void doRemediation()}
            remediationLoading={remediationAction.loading}
            remediationError={remediationAction.error}
          />
        ) : null}

        {tab === 'mastery' && material ? (
          <MasteryView materialId={material.material.id} refreshKey={refreshKey} />
        ) : null}
      </main>
    </div>
  );
}

function readLastMaterialId(): string | null {
  try {
    return window.localStorage.getItem(LAST_MATERIAL_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastMaterialId(materialId: string): void {
  try {
    window.localStorage.setItem(LAST_MATERIAL_ID_STORAGE_KEY, materialId);
  } catch {
    // Storage can be unavailable (for example, in a locked-down browser).
  }
}

function clearLastMaterialId(expectedId: string): void {
  try {
    if (window.localStorage.getItem(LAST_MATERIAL_ID_STORAGE_KEY) === expectedId) {
      window.localStorage.removeItem(LAST_MATERIAL_ID_STORAGE_KEY);
    }
  } catch {
    // Treat unavailable storage like an absent saved selection.
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 404;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toMaterialSummary({ material, blocks }: MaterialWithBlocks): MaterialSummary {
  return {
    id: material.id,
    workspaceId: material.workspaceId,
    title: material.title,
    sourceType: material.sourceType,
    charCount: material.charCount,
    blockCount: blocks.length,
    createdAt: material.createdAt,
    // A 资料库 import always lands in a freshly auto-created workspace
    // holding exactly this document (the server list reports the same).
    workspaceOrigin: 'material_import',
    workspaceDocumentCount: 1,
  };
}
