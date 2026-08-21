import { useEffect, useRef, useState } from 'react';
import type { Answer, DocumentSummary, PublicQuiz, SourceBlock } from '@hy3-clinic/shared';
import { api, ApiClientError, type SubmissionResponse } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import { QuizView } from './QuizView.js';
import { ResultsView } from './ResultsView.js';

export interface CourseAssessmentViewProps {
  workspaceId: string;
  documents: DocumentSummary[];
  launchedQuiz: PublicQuiz | null;
  onChanged: () => void;
  onBack: () => void;
}

interface AssessmentSourceContext {
  materialId: string | null;
  blocks: SourceBlock[];
  conceptCount: number;
  documentTitles?: Map<string, string>;
}

/** Advanced/manual assessment capability kept inside the Course shell. */
export function CourseAssessmentView({
  workspaceId,
  documents,
  launchedQuiz,
  onChanged,
  onBack,
}: CourseAssessmentViewProps) {
  const [materialId, setMaterialId] = useState(launchedQuiz?.materialId ?? documents[0]?.id ?? '');
  const [context, setContext] = useState<AssessmentSourceContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<PublicQuiz | null>(launchedQuiz);
  const [result, setResult] = useState<SubmissionResponse | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const requestSequence = useRef(0);
  const remediation = useAsyncAction();
  const cancelRemediation = remediation.cancel;
  const clearRemediationError = remediation.clearError;

  useEffect(() => {
    const nextMaterialId = launchedQuiz?.materialId ?? documents[0]?.id ?? '';
    setMaterialId(nextMaterialId);
    setQuiz(launchedQuiz);
    setResult(null);
    setAnswers([]);
    cancelRemediation();
    clearRemediationError();
  }, [cancelRemediation, clearRemediationError, documents, launchedQuiz, workspaceId]);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    setContext(null);
    setContextError(null);

    if (documents.length === 0) {
      setContextLoading(false);
      return () => controller.abort();
    }

    const workspaceScoped = quiz?.materialId === null;
    const selectedId = workspaceScoped ? null : materialId;
    if (!workspaceScoped && !documents.some((document) => document.id === selectedId)) {
      setContextLoading(false);
      return () => controller.abort();
    }

    setContextLoading(true);
    void (async () => {
      try {
        if (workspaceScoped) {
          const materials = await Promise.all(
            documents.map((document) => api.getMaterial(document.id, controller.signal)),
          );
          if (controller.signal.aborted || requestSequence.current !== requestId) return;
          setContext({
            materialId: null,
            blocks: materials.flatMap((material) => material.blocks),
            conceptCount: 1,
            documentTitles: new Map(documents.map((document) => [document.id, document.title])),
          });
        } else {
          const [material, concepts] = await Promise.all([
            api.getMaterial(selectedId!, controller.signal),
            api.getConcepts(selectedId!, controller.signal),
          ]);
          if (controller.signal.aborted || requestSequence.current !== requestId) return;
          setContext({
            materialId: selectedId,
            blocks: material.blocks,
            conceptCount: concepts.concepts.length,
          });
        }
      } catch (error) {
        if (controller.signal.aborted || requestSequence.current !== requestId) return;
        if (error instanceof ApiClientError && error.code === 'ABORTED') return;
        setContextError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!controller.signal.aborted && requestSequence.current === requestId) {
          setContextLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [documents, materialId, quiz?.materialId, workspaceId]);

  function changeMaterial(nextMaterialId: string): void {
    requestSequence.current += 1;
    remediation.cancel();
    remediation.clearError();
    setMaterialId(nextMaterialId);
    setQuiz(null);
    setResult(null);
    setAnswers([]);
  }

  function handleGraded(
    gradedQuiz: PublicQuiz,
    submission: SubmissionResponse,
    gradedAnswers: Answer[],
  ): void {
    if (gradedQuiz.workspaceId && gradedQuiz.workspaceId !== workspaceId) return;
    if (gradedQuiz.materialId && gradedQuiz.materialId !== materialId) return;
    setQuiz(gradedQuiz);
    setResult(submission);
    setAnswers(gradedAnswers);
    onChanged();
  }

  async function startRemediation(): Promise<void> {
    if (!context?.materialId) return;
    const capturedMaterialId = context.materialId;
    const response = await remediation.run((signal) => api.remediation(capturedMaterialId, signal));
    if (!response || context.materialId !== capturedMaterialId) return;
    setQuiz(response.quiz);
    setResult(null);
    setAnswers([]);
  }

  return (
    <div className="course-assessment stack" aria-label="课程高级评估">
      <header className="supporting-page-intro course-page-intro">
        <div>
          <p className="eyebrow">高级工具</p>
          <h2>{launchedQuiz ? '当前练习' : '手动评估'}</h2>
          <p className="muted">
            此处保留手动出题与旧活动兼容能力。只有 Study 中标记为正式检验的流程才会产生 Formal
            Evidence。
          </p>
        </div>
        <button type="button" onClick={onBack}>
          返回进展
        </button>
      </header>

      {!launchedQuiz && documents.length > 1 ? (
        <label className="assessment-material-picker">
          资料范围
          <select value={materialId} onChange={(event) => changeMaterial(event.target.value)}>
            {documents.map((document) => (
              <option key={document.id} value={document.id}>
                {document.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {documents.length === 0 ? (
        <section className="course-empty-state compact" role="status">
          <strong>还没有可以评估的课程资料</strong>
          <p>添加课程资料后，手动评估能力会在这里可用。</p>
        </section>
      ) : contextLoading ? (
        <Loading label="加载评估依据…" />
      ) : contextError ? (
        <Banner kind="error">评估依据暂时无法读取。{contextError}</Banner>
      ) : context && result && quiz ? (
        <>
          <button type="button" className="course-assessment-back" onClick={() => setResult(null)}>
            返回当前评估
          </button>
          <ResultsView
            quiz={quiz}
            result={result}
            answers={answers}
            blocks={context.blocks}
            onRemediate={() => void startRemediation()}
            remediationLoading={remediation.loading}
            readOnly={context.materialId === null}
          />
        </>
      ) : context ? (
        <QuizView
          materialId={context.materialId}
          blocks={context.blocks}
          hasConcepts={context.conceptCount > 0}
          quiz={quiz}
          documentTitles={context.documentTitles}
          onQuizGenerated={(generated) => {
            setQuiz(generated);
            setResult(null);
          }}
          onGraded={handleGraded}
        />
      ) : null}

      {remediation.error ? <Banner kind="error">{remediation.error}</Banner> : null}
    </div>
  );
}
