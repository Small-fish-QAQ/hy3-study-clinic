import type { Answer, PublicQuiz, Question, QuestionGrade, SourceBlock } from '@hy3-clinic/shared';
import type { SubmissionResponse } from '../api.js';
import { Banner, GradedByPill } from '../components/ui.js';
import { SourceEvidencePanel } from '../components/SourceEvidencePanel.js';

export interface ResultsViewProps {
  quiz: PublicQuiz;
  result: SubmissionResponse;
  answers: Answer[];
  blocks: SourceBlock[];
  onRemediate: () => void;
  remediationLoading: boolean;
}

/** 判分结果视图:总分、逐题判定、判分方式标签、依据与讲解(Flow B)。 */
export function ResultsView({
  quiz,
  result,
  answers,
  blocks,
  onRemediate,
  remediationLoading,
}: ResultsViewProps) {
  const { grading, questions } = result;
  const questionById = new Map<string, Question>(questions.map((q) => [q.id, q]));
  const answerById = new Map(answers.map((a) => [a.questionId, a]));
  const scorePct = Math.round(grading.overallScore * 100);
  const wrongCount = grading.grades.filter((g) => !g.correct).length;

  return (
    <div className="stack">
      <section className="card">
        <div className="row between">
          <h2>判分结果</h2>
          <span className="muted small">测验 {quiz.id.slice(0, 12)}…</span>
        </div>
        <div className="row" style={{ gap: '2rem' }}>
          <div>
            <div className="score-big">{scorePct} 分</div>
            <div className="muted small">
              得分 {grading.totalAwarded} / {grading.totalPossible}
            </div>
          </div>
          <div className="stack" style={{ gap: '0.25rem' }}>
            <span className="pill correct">答对 {grading.grades.length - wrongCount} 题</span>
            <span className="pill wrong">待巩固 {wrongCount} 题</span>
          </div>
        </div>
        {wrongCount > 0 ? (
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <button
              type="button"
              className="primary"
              disabled={remediationLoading}
              onClick={onRemediate}
            >
              {remediationLoading ? '正在生成康复练习…' : '针对错题生成康复练习'}
            </button>
            <span className="muted small">错题已记入错题本,可稍后在「错题本」页处理。</span>
          </div>
        ) : (
          <Banner kind="info">全部答对!可以到「掌握度」页查看进展。</Banner>
        )}
      </section>

      {grading.grades.map((grade, i) => {
        const question = questionById.get(grade.questionId);
        if (!question) return null;
        return (
          <QuestionResult
            key={grade.questionId}
            index={i}
            grade={grade}
            question={question}
            answer={answerById.get(grade.questionId)}
            blocks={blocks}
          />
        );
      })}
    </div>
  );
}

function QuestionResult({
  index,
  grade,
  question,
  answer,
  blocks,
}: {
  index: number;
  grade: QuestionGrade;
  question: Question;
  answer: Answer | undefined;
  blocks: SourceBlock[];
}) {
  const selected = new Set(answer?.selectedOptionIds ?? []);
  const correctSet = new Set(question.correctOptionIds ?? []);

  return (
    <section className="card">
      <div className="row between">
        <h3>
          第 {index + 1} 题{' '}
          <span className={`pill ${grade.correct ? 'correct' : 'wrong'}`}>
            {grade.correct ? '正确' : '需巩固'}
          </span>{' '}
          <GradedByPill gradedBy={grade.gradedBy} />
          {grade.confidence !== undefined ? (
            <span className="pill">置信度 {Math.round(grade.confidence * 100)}%</span>
          ) : null}
          {grade.needsReview ? <span className="pill wrong">建议人工复核</span> : null}
        </h3>
        <span className="muted small">
          {grade.awardedPoints}/{grade.maxPoints} 分
        </span>
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{question.stem}</p>

      {question.type !== 'short_answer' ? (
        <div>
          {(question.options ?? []).map((option) => {
            const isCorrect = correctSet.has(option.id);
            const isSelected = selected.has(option.id);
            const cls = isCorrect ? 'correct' : isSelected ? 'incorrect' : '';
            return (
              <div key={option.id} className={`option ${cls}`}>
                <span>
                  <strong>{option.id}.</strong> {option.text}
                  {isCorrect ? ' ✓ 正确答案' : ''}
                  {!isCorrect && isSelected ? ' ✗ 你的选择' : ''}
                  {isCorrect && isSelected ? '(你选对了)' : ''}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="stack" style={{ gap: '0.5rem' }}>
          <div className="block-preview">
            <div className="heading-path">你的回答</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {answer?.text?.trim() ? answer.text : <span className="muted">(未作答)</span>}
            </div>
          </div>
          <div className="block-preview">
            <div className="heading-path">参考答案</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{question.expectedAnswer}</div>
          </div>
          {question.rubric ? (
            <div className="block-preview">
              <div className="heading-path">评分要点</div>
              <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {question.rubric.keyPoints.map((point) => {
                  const hit = grade.matchedKeyPoints?.includes(point) ?? false;
                  return (
                    <li key={point} className={hit ? '' : 'muted'}>
                      {hit ? '✓' : '✗'} {point}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      {grade.feedback ? (
        <p className="small" style={{ marginTop: '0.5rem' }}>
          <strong>评语:</strong>
          {grade.feedback}
        </p>
      ) : null}
      <p className="small muted" style={{ marginTop: '0.25rem' }}>
        <strong>讲解:</strong>
        {question.explanation}
      </p>
      <SourceEvidencePanel grounding={question.grounding} blocks={blocks} defaultOpen />
    </section>
  );
}
