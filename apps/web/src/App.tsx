import { useEffect, useState } from 'react';
import type { Answer, Concept, PublicQuiz } from '@hy3-clinic/shared';
import { api, type MaterialWithBlocks, type SubmissionResponse } from './api.js';
import { useAsyncAction } from './components/useAsyncAction.js';
import { ImportView } from './views/ImportView.js';
import { QuizView } from './views/QuizView.js';
import { ResultsView } from './views/ResultsView.js';
import { MistakesView } from './views/MistakesView.js';
import { MasteryView } from './views/MasteryView.js';
import { Banner } from './components/ui.js';

type Tab = 'import' | 'quiz' | 'results' | 'mistakes' | 'mastery';

const TAB_LABELS: Record<Tab, string> = {
  import: '① 导入资料',
  quiz: '② 出题作答',
  results: '③ 判分结果',
  mistakes: '④ 错题本',
  mastery: '⑤ 掌握度',
};

export function App() {
  const [tab, setTab] = useState<Tab>('import');
  const [provider, setProvider] = useState<'fake' | 'hy3' | null>(null);
  const [material, setMaterial] = useState<MaterialWithBlocks | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [quiz, setQuiz] = useState<PublicQuiz | null>(null);
  const [result, setResult] = useState<SubmissionResponse | null>(null);
  const [lastAnswers, setLastAnswers] = useState<Answer[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const remediationAction = useAsyncAction();

  useEffect(() => {
    api
      .config()
      .then((c) => setProvider(c.provider))
      .catch(() => setProvider(null));
  }, []);

  function handleImported(imported: MaterialWithBlocks) {
    setMaterial(imported);
    setConcepts([]);
    setQuiz(null);
    setResult(null);
    setLastAnswers([]);
  }

  function handleGraded(
    gradedQuiz: PublicQuiz,
    submissionResult: SubmissionResponse,
    answers: Answer[],
  ) {
    setQuiz(gradedQuiz);
    setResult(submissionResult);
    setLastAnswers(answers);
    setRefreshKey((k) => k + 1);
    setTab('results');
  }

  async function doRemediation() {
    if (!material) return;
    const res = await remediationAction.run((signal) =>
      api.remediation(material.material.id, signal),
    );
    if (res) {
      setQuiz(res.quiz);
      setResult(null);
      setTab('quiz');
    }
  }

  const materialReady = material !== null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Hy3 智学诊所</h1>
          <p className="app-subtitle">证据可溯源的出题 · 判分 · 错题康复练习</p>
        </div>
        {provider ? (
          <span className={`provider-badge ${provider}`}>
            {provider === 'fake' ? '离线模式(Fake Provider,无需 API Key)' : 'Hy3 在线模式'}
          </span>
        ) : null}
      </header>

      <nav className="tabs" aria-label="主导航">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
          const needsMaterial = t !== 'import';
          const needsResult = t === 'results';
          const disabled = (needsMaterial && !materialReady) || (needsResult && !result);
          return (
            <button
              key={t}
              type="button"
              className={tab === t ? 'active' : ''}
              disabled={disabled}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          );
        })}
      </nav>

      {remediationAction.error && tab !== 'mistakes' ? (
        <Banner kind="error">{remediationAction.error}</Banner>
      ) : null}

      <main>
        {tab === 'import' ? (
          <ImportView
            material={material}
            concepts={concepts}
            onImported={handleImported}
            onAnalyzed={setConcepts}
          />
        ) : null}

        {tab === 'quiz' && material ? (
          <QuizView
            materialId={material.material.id}
            blocks={material.blocks}
            hasConcepts={concepts.length > 0}
            quiz={quiz}
            onQuizGenerated={(q) => {
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
