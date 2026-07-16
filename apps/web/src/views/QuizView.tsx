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
import { api, type SubmissionResponse } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { SourceEvidencePanel } from '../components/SourceEvidencePanel.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

export interface QuizViewProps {
  materialId: string;
  blocks: SourceBlock[];
  hasConcepts: boolean;
  quiz: PublicQuiz | null;
  onQuizGenerated: (quiz: PublicQuiz) => void;
  onGraded: (quiz: PublicQuiz, result: SubmissionResponse, answers: Answer[]) => void;
}

const TYPE_LABELS: Record<QuestionType, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  short_answer: '简答题',
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
  const remediationConceptCount = isRemediation
    ? (quiz.targetConceptIds?.length ?? new Set(quiz.questions.map((q) => q.conceptId)).size)
    : 0;
  const remediationQuestionTypes = isRemediation
    ? Array.from(new Set(quiz.questions.map((q) => q.type)))
    : [];

  function toggleType(type: QuestionType) {
    setTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));
  }

  async function doGenerate() {
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
      if (q.type === 'short_answer') {
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
      return q.type === 'short_answer' ? a.text.trim().length > 0 : a.selectedOptionIds.length > 0;
    }).length;
  }, [answers, quiz]);

  return (
    <div className="stack">
      <section className="card">
        <h2>{isRemediation ? '康复练习' : '配置测验'}</h2>
        {isRemediation ? (
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
                  {(Object.keys(TYPE_LABELS) as QuestionType[]).map((type) => (
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
              disabled={!isRemediation && types.length === 0}
              onClick={() => void doGenerate()}
            >
              {isRemediation ? '重新生成康复练习' : quiz ? '重新生成测验' : '生成测验'}
            </button>
          )}
        </div>
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
                  <span className="pill">{question.conceptName}</span>
                </div>
                <p style={{ whiteSpace: 'pre-wrap', marginTop: '0.4rem' }}>{question.stem}</p>

                {question.type === 'short_answer' ? (
                  <textarea
                    rows={3}
                    placeholder="在此作答……"
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
