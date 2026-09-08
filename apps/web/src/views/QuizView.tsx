import { useMemo, useState } from 'react';
import type {
  Answer,
  Difficulty,
  PublicQuiz,
  PublicQuestion,
  QuestionType,
  QuizConfig,
  SourceBlock,
} from '@hy3-clinic/shared';
import { isTextAnswerType } from '@hy3-clinic/shared';
import { api, type SubmissionResponse } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { SourceEvidencePanel } from '../components/SourceEvidencePanel.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

export interface QuizViewProps {
  /** Owning document; null for workspace-scoped (adaptive) assessments. */
  materialId: string | null;
  blocks: SourceBlock[];
  hasConcepts: boolean;
  quiz: PublicQuiz | null;
  /** Titles for source-document badges on cross-document questions. */
  documentTitles?: Map<string, string>;
  onQuizGenerated: (quiz: PublicQuiz) => void;
  onGraded: (quiz: PublicQuiz, result: SubmissionResponse, answers: Answer[]) => void;
}

const TYPE_LABELS: Record<QuestionType, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  short_answer: '简答题',
  concept_comparison: '概念对比题',
};

/** Types offered by the per-document generation form (comparison questions
 * only come from workspace assessments, which provide cross-document evidence). */
const CONFIGURABLE_TYPES: QuestionType[] = ['single_choice', 'multiple_choice', 'short_answer'];

/** 评估模式的中文标签(练习页与测验历史共用)。 */
export const ASSESSMENT_MODE_LABELS: Record<string, string> = {
  diagnostic: '诊断评估',
  concept_practice: '概念练习',
  prerequisite_repair: '前置修复',
  cross_document: '跨文档综合',
  review: '复习检测',
  misconception_check: '误区判别',
};

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
};

type AnswerMap = Record<string, { selectedOptionIds: string[]; text: string }>;

/** 出题配置 + 交互答题视图(Flow A 第二步 / Flow B 第一步)。 */
export function QuizView({
  materialId,
  blocks,
  hasConcepts,
  quiz,
  documentTitles,
  onQuizGenerated,
  onGraded,
}: QuizViewProps) {
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [types, setTypes] = useState<QuestionType[]>(['single_choice', 'short_answer']);
  const [countPerType, setCountPerType] = useState(2);
  const [answers, setAnswers] = useState<AnswerMap>({});

  const generateAction = useAsyncAction();
  const submitAction = useAsyncAction();
  const isRemediation = quiz?.kind === 'remediation';
  const isAssessment = quiz?.kind === 'adaptive';
  const remediationConceptCount = isRemediation
    ? (quiz.targetConceptIds?.length ?? new Set(quiz.questions.map((q) => q.conceptId)).size)
    : 0;
  const remediationQuestionTypes = isRemediation
    ? Array.from(new Set(quiz.questions.map((q) => q.type)))
    : [];
  const blockDocTitle = useMemo(() => {
    const byBlock = new Map<string, string>();
    if (!documentTitles) return byBlock;
    for (const block of blocks) {
      const title = documentTitles.get(block.materialId);
      if (title) byBlock.set(block.id, title);
    }
    return byBlock;
  }, [blocks, documentTitles]);

  function toggleType(type: QuestionType) {
    setTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));
  }

  async function doGenerate() {
    if (materialId === null) return;
    const result = await generateAction.run((signal) => {
      if (isRemediation) return api.remediation(materialId, signal);

      const config: QuizConfig = { difficulty, types, countPerType };
      return api.generateQuiz(materialId, config, signal);
    });
    if (result) {
      setAnswers({});
      onQuizGenerated(result.quiz);
    }
  }

  function setChoice(question: PublicQuestion, optionId: string) {
    setAnswers((prev) => {
      const current = prev[question.id]?.selectedOptionIds ?? [];
      let next: string[];
      if (question.type === 'single_choice') {
        next = [optionId];
      } else {
        next = current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId];
      }
      return {
        ...prev,
        [question.id]: { selectedOptionIds: next, text: prev[question.id]?.text ?? '' },
      };
    });
  }

  function setText(question: PublicQuestion, text: string) {
    setAnswers((prev) => ({
      ...prev,
      [question.id]: { selectedOptionIds: prev[question.id]?.selectedOptionIds ?? [], text },
    }));
  }

  async function doSubmit() {
    if (!quiz) return;
    const payload: Answer[] = quiz.questions.map((q) => {
      if (isTextAnswerType(q.type)) {
        return { questionId: q.id, type: q.type, text: answers[q.id]?.text ?? '' };
      }
      return {
        questionId: q.id,
        type: q.type,
        selectedOptionIds: answers[q.id]?.selectedOptionIds ?? [],
      };
    });
    const result = await submitAction.run((signal) => api.submit(quiz.id, payload, signal));
    if (result) onGraded(quiz, result, payload);
  }

  const answeredCount = useMemo(() => {
    if (!quiz) return 0;
    return quiz.questions.filter((q) => {
      const a = answers[q.id];
      if (!a) return false;
      return isTextAnswerType(q.type) ? a.text.trim().length > 0 : a.selectedOptionIds.length > 0;
    }).length;
  }, [answers, quiz]);

  return (
    <div className="stack">
      <section className="card quiz-config">
        <h2>
          {isAssessment
            ? `课程空间评估 · ${ASSESSMENT_MODE_LABELS[quiz?.assessmentMode ?? ''] ?? '综合评估'}`
            : isRemediation
              ? '康复练习'
              : '配置测验'}
        </h2>
        {isAssessment && quiz ? (
          <div className="stack">
            <p style={{ margin: 0 }}>
              共 {quiz.questions.length} 道题,覆盖{' '}
              {new Set(quiz.questions.map((q) => q.conceptId)).size} 个概念
              {documentTitles && documentTitles.size > 1 ? `,证据来自多份文档` : ''}。
            </p>
            <p className="muted small" style={{ margin: 0 }}>
              题目由课程空间的学习状态生成;答案与评分要点在判分前不会发送到浏览器。
            </p>
          </div>
        ) : isRemediation && quiz ? (
          <div className="stack">
            <p style={{ margin: 0 }}>
              根据 {remediationConceptCount} 个未解决概念自动生成 {quiz.questions.length} 道康复题
            </p>
            <p className="muted small" style={{ margin: 0 }}>
              每个概念 1 道单选题 + 1 道简答题，最多 3 个概念。
            </p>
            <div className="row" aria-label="生成的康复题型">
              <span className="muted small">题型</span>
              {remediationQuestionTypes.map((type) => (
                <span key={type} className="pill">
                  {TYPE_LABELS[type]}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <>
            {!hasConcepts ? (
              <Banner kind="info">
                尚未分析概念。生成测验时会自动先分析,也可以先到「导入」页手动分析。
              </Banner>
            ) : null}
            <div className="stack">
              <div className="field">
                <label htmlFor="difficulty">难度</label>
                <select
                  id="difficulty"
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as Difficulty)}
                >
                  {(Object.keys(DIFFICULTY_LABELS) as Difficulty[]).map((d) => (
                    <option key={d} value={d}>
                      {DIFFICULTY_LABELS[d]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>题型(至少选择一种)</label>
                <div className="row">
                  {CONFIGURABLE_TYPES.map((type) => (
                    <label key={type} className="pill" style={{ cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={types.includes(type)}
                        onChange={() => toggleType(type)}
                      />
                      {TYPE_LABELS[type]}
                    </label>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="count">每种题型数量:{countPerType}</label>
                <input
                  id="count"
                  type="range"
                  min={1}
                  max={5}
                  value={countPerType}
                  onChange={(e) => setCountPerType(Number(e.target.value))}
                />
              </div>
            </div>
          </>
        )}
        {generateAction.error ? <Banner kind="error">{generateAction.error}</Banner> : null}
        {!isAssessment ? (
          <div className="row">
            {generateAction.loading ? (
              <>
                <Loading label={isRemediation ? '正在重新生成康复练习…' : '正在生成测验…'} />
                <button type="button" onClick={generateAction.cancel}>
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={materialId === null || (!isRemediation && types.length === 0)}
                onClick={() => void doGenerate()}
              >
                {isRemediation ? '重新生成康复练习' : quiz ? '重新生成测验' : '生成测验'}
              </button>
            )}
          </div>
        ) : null}
      </section>

      {quiz ? (
        <section className="card">
          <div className="row between">
            <h2>作答({quiz.questions.length} 题)</h2>
            <span className="muted small">
              已作答 {answeredCount}/{quiz.questions.length}
            </span>
          </div>
          {submitAction.error ? <Banner kind="error">{submitAction.error}</Banner> : null}

          <div className="stack">
            {quiz.questions.map((question, i) => (
              <div key={question.id} className="block-preview">
                <div className="row between">
                  <strong>
                    第 {i + 1} 题 · {TYPE_LABELS[question.type]}
                  </strong>
                  <span className="row" style={{ gap: '0.35rem' }}>
                    <span className="pill">{question.conceptName}</span>
                    {questionDocTitles(question, blockDocTitle).map((title) => (
                      <span key={title} className="pill doc-badge" title={`证据来源:${title}`}>
                        {title}
                      </span>
                    ))}
                  </span>
                </div>
                <p style={{ whiteSpace: 'pre-wrap', marginTop: '0.4rem' }}>{question.stem}</p>

                {isTextAnswerType(question.type) ? (
                  <textarea
                    rows={question.type === 'concept_comparison' ? 5 : 3}
                    placeholder={
                      question.type === 'concept_comparison'
                        ? '请综合多份资料的表述作答……'
                        : '在此作答……'
                    }
                    value={answers[question.id]?.text ?? ''}
                    onChange={(e) => setText(question, e.target.value)}
                    aria-label={`第 ${i + 1} 题作答`}
                  />
                ) : (
                  <div>
                    {(question.options ?? []).map((option) => {
                      const selected =
                        answers[question.id]?.selectedOptionIds.includes(option.id) ?? false;
                      return (
                        <label key={option.id} className={`option ${selected ? 'selected' : ''}`}>
                          <input
                            type={question.type === 'single_choice' ? 'radio' : 'checkbox'}
                            name={`q-${question.id}`}
                            checked={selected}
                            onChange={() => setChoice(question, option.id)}
                          />
                          <span>
                            <strong>{option.id}.</strong> {option.text}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}

                <SourceEvidencePanel grounding={question.grounding} blocks={blocks} />
                {(question.supplementaryEvidence ?? []).map((evidence, evidenceIndex) => (
                  <SourceEvidencePanel
                    key={`${evidence.blockId}-${evidenceIndex}`}
                    grounding={evidence}
                    blocks={blocks}
                  />
                ))}
              </div>
            ))}
          </div>

          <div className="row" style={{ marginTop: '0.75rem' }}>
            {submitAction.loading ? (
              <>
                <Loading label="正在判分…" />
                <button type="button" onClick={submitAction.cancel}>
                  取消
                </button>
              </>
            ) : (
              <button type="button" className="primary" onClick={() => void doSubmit()}>
                提交并判分
              </button>
            )}
          </div>
        </section>
      ) : (
        <Banner kind="empty">还没有测验。配置好题型与难度后点击「生成测验」。</Banner>
      )}
    </div>
  );
}

/** Distinct source-document titles of a question's evidence (bounded). */
function questionDocTitles(question: PublicQuestion, blockDocTitle: Map<string, string>): string[] {
  const titles = new Set<string>();
  const primary = blockDocTitle.get(question.grounding.blockId);
  if (primary) titles.add(primary);
  for (const evidence of question.supplementaryEvidence ?? []) {
    const title = blockDocTitle.get(evidence.blockId);
    if (title) titles.add(title);
  }
  // Badges only add signal when evidence spans more than one document.
  return titles.size > 1 ? [...titles].slice(0, 3) : [];
}
