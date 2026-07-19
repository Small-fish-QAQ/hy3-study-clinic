import { useEffect, useRef, useState } from 'react';
import type { Answer, Concept, PublicQuiz } from '@hy3-clinic/shared';
import {
  ApiClientError,
  api,
  type MaterialSummary,
  type MaterialWithBlocks,
  type SubmissionResponse,
} from './api.js';
import { useAsyncAction } from './components/useAsyncAction.js';
import { ImportView } from './views/ImportView.js';
import { GraphWorkspaceView } from './views/GraphWorkspaceView.js';
import { QuizView } from './views/QuizView.js';
import { ResultsView } from './views/ResultsView.js';
import { MistakesView } from './views/MistakesView.js';
import { MasteryView } from './views/MasteryView.js';
import { Banner } from './components/ui.js';

type Tab = 'import' | 'graph' | 'quiz' | 'results' | 'mistakes' | 'mastery';

const LAST_MATERIAL_ID_STORAGE_KEY = 'hy3-clinic:last-material-id';

/** Module navigation: 练习 covers both answering (quiz) and results. */
type Module = 'import' | 'graph' | 'practice' | 'mistakes' | 'mastery';

const MODULE_LABELS: Record<Module, string> = {
  import: '资料库',
  graph: '学习图谱',
  practice: '练习',
  mistakes: '错题',
  mastery: '学习进展',
};

const MODULE_OF_TAB: Record<Tab, Module> = {
  import: 'import',
  graph: 'graph',
  quiz: 'practice',
  results: 'practice',
  mistakes: 'mistakes',
  mastery: 'mastery',
};

export function App() {
  const [tab, setTab] = useState<Tab>('import');
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
  const [refreshKey, setRefreshKey] = useState(0);
  const materialRequestRef = useRef(0);
  const activeMaterialIdRef = useRef<string | null>(null);
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

        setRecentMaterials(history.materials);
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
    remediationAction.cancel();
    remediationAction.clearError();
    setMaterial(imported);
    setConcepts([]);
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
      setMaterial(restored);
      setConcepts(storedConcepts.concepts);
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

    try {
      await api.deleteMaterial(materialId, signal);
      if (signal.aborted) {
        if (deletingCurrent && activeMaterialIdRef.current === null) {
          activeMaterialIdRef.current = materialId;
        }
        setDeletingCurrentMaterial(false);
        return;
      }
    } catch (error) {
      if (deletingCurrent && activeMaterialIdRef.current === null) {
        activeMaterialIdRef.current = materialId;
      }
      setDeletingCurrentMaterial(false);
      throw error;
    }

    setRecentMaterials((items) => items.filter((item) => item.id !== materialId));
    clearLastMaterialId(materialId);
    setHistoryError(null);
    setDeletingCurrentMaterial(false);
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

  function handleGraded(
    gradedQuiz: PublicQuiz,
    submissionResult: SubmissionResponse,
    answers: Answer[],
  ) {
    if (activeMaterialIdRef.current !== gradedQuiz.materialId) return;
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
   * Launch an assessment produced by an accepted remediation plan: open the
   * quiz's document (blocks are needed for evidence display), then jump to
   * the answering tab. Guarded by the same request epoch as manual opens so
   * a late load can never clobber a newer selection.
   */
  async function handleLaunchFromPlan(launchedQuiz: PublicQuiz) {
    const requestId = ++materialRequestRef.current;
    remediationAction.cancel();
    setOpeningMaterialId(launchedQuiz.materialId);
    try {
      const [restored, storedConcepts] = await Promise.all([
        api.getMaterial(launchedQuiz.materialId),
        api.getConcepts(launchedQuiz.materialId),
      ]);
      if (materialRequestRef.current !== requestId) return;
      activeMaterialIdRef.current = launchedQuiz.materialId;
      setMaterial(restored);
      setConcepts(storedConcepts.concepts);
      setQuiz(launchedQuiz);
      setResult(null);
      setLastAnswers([]);
      setTab('quiz');
      writeLastMaterialId(launchedQuiz.materialId);
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

  function handleModuleChange(module: Module) {
    handleTabChange(module === 'practice' ? 'quiz' : module);
  }

  const materialReady = material !== null && !deletingCurrentMaterial;
  const activeModule = MODULE_OF_TAB[tab];

  return (
    <div className={`app-shell ${tab === 'graph' ? 'module-graph' : ''}`}>
      <header className="app-header">
        <div>
          <h1>Hy3 智学诊所</h1>
          <p className="app-subtitle">
            从课程资料构建可验证的个人学习图谱,并根据薄弱知识规划补救路径
          </p>
        </div>
        <nav className="tabs" aria-label="主导航">
          {(Object.keys(MODULE_LABELS) as Module[]).map((module) => {
            const needsMaterial = module !== 'import' && module !== 'graph';
            const disabled = needsMaterial && (!materialReady || openingMaterialId !== null);
            return (
              <button
                key={module}
                type="button"
                className={activeModule === module ? 'active' : ''}
                disabled={disabled}
                onClick={() => handleModuleChange(module)}
              >
                {MODULE_LABELS[module]}
              </button>
            );
          })}
        </nav>
        {provider ? (
          <span className={`provider-badge ${provider}`}>
            {provider === 'fake' ? '离线模式(Fake Provider,无需 API Key)' : 'Hy3 在线模式'}
          </span>
        ) : null}
      </header>

      {remediationAction.error && tab !== 'mistakes' ? (
        <Banner kind="error">{remediationAction.error}</Banner>
      ) : null}

      <main className={tab === 'graph' ? 'main-graph' : 'main-scroll'}>
        {activeModule === 'practice' ? (
          <div className="practice-switch" role="tablist" aria-label="练习子页">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'quiz'}
              className={tab === 'quiz' ? 'active' : ''}
              onClick={() => handleTabChange('quiz')}
            >
              出题作答
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'results'}
              className={tab === 'results' ? 'active' : ''}
              disabled={!result}
              onClick={() => handleTabChange('results')}
            >
              判分结果
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
          />
        ) : null}

        {tab === 'quiz' && material ? (
          <QuizView
            materialId={material.material.id}
            blocks={material.blocks}
            hasConcepts={concepts.length > 0}
            quiz={quiz}
            onQuizGenerated={(q) => {
              if (activeMaterialIdRef.current !== q.materialId) return;
              setQuiz(q);
              setResult(null);
            }}
            onGraded={handleGraded}
          />
        ) : null}

        {tab === 'results' && material && quiz && result ? (
          <ResultsView
            quiz={quiz}
            result={result}
            answers={lastAnswers}
            blocks={material.blocks}
            onRemediate={() => void doRemediation()}
            remediationLoading={remediationAction.loading}
          />
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
    title: material.title,
    sourceType: material.sourceType,
    charCount: material.charCount,
    blockCount: blocks.length,
    createdAt: material.createdAt,
  };
}
