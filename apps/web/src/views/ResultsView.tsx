import type {
  Answer,
  GradeStatus,
  PublicQuiz,
  Question,
  QuestionGrade,
  SourceBlock,
  SubmissionStateChanges,
} from '@hy3-clinic/shared';
import { classifyGradeStatus, isTextAnswerType } from '@hy3-clinic/shared';
import type { SubmissionResponse } from '../api.js';
import { Banner, GradedByPill } from '../components/ui.js';
import { SourceEvidencePanel } from '../components/SourceEvidencePanel.js';

/**
 * Status badge derived from required-criterion coverage (thresholds live in
 * shared classifyGradeStatus): full required coverage → 正确; passed but
 * incomplete → 基本正确; some coverage → 部分正确; none → 需巩固.
 */
const STATUS_TEXT: Record<GradeStatus, string> = {
  correct: '正确',
  mostly_correct: '基本正确',
  partial: '部分正确',
  insufficient: '需巩固',
};

const STATUS_PILL: Record<GradeStatus, string> = {
  correct: 'correct',
  mostly_correct: 'mostly',
  partial: 'mostly',
  insufficient: 'wrong',
};

export interface ResultsViewProps {
  quiz: PublicQuiz;
  result: SubmissionResponse;
  answers: Answer[];
  blocks: SourceBlock[];
  onRemediate: () => void;
  remediationLoading: boolean;
}

/** 判分结果视图:总分、逐题判定、判分方式标签、状态变化与依据讲解。 */
export function ResultsView({
  quiz,
  result,
  answers,
  blocks,
  onRemediate,
  remediationLoading,
}: ResultsViewProps) {
  const { grading, questions, stateChanges } = result;
  const questionById = new Map<string, Question>(questions.map((q) => [q.id, q]));
  const answerById = new Map(answers.map((a) => [a.questionId, a]));
  const scorePct = Math.round(grading.overallScore * 100);
  const wrongCount = grading.grades.filter((g) => !g.correct).length;
  const isAssessment = quiz.kind === 'adaptive';

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
        {wrongCount > 0 && !isAssessment ? (
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
        ) : null}
        {wrongCount === 0 && !stateChanges ? (
          <Banner kind="info">全部答对!可以到「掌握度」页查看进展。</Banner>
        ) : null}
      </section>

      {stateChanges ? <StateChangesCard changes={stateChanges} /> : null}

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

/**
 * Deterministic explanation of what this graded submission changed:
 * concepts/documents assessed, mistakes, misconception transitions, mastery
 * movement, review scheduling, and the recommended next step.
 */
function StateChangesCard({ changes }: { changes: SubmissionStateChanges }) {
  const misconceptionParts = [
    changes.misconceptionsProposed > 0 ? `新增疑似误区 ${changes.misconceptionsProposed} 个` : null,
    changes.misconceptionsConfirmed > 0 ? `确认误区 ${changes.misconceptionsConfirmed} 个` : null,
    changes.misconceptionsRejected > 0 ? `排除误区 ${changes.misconceptionsRejected} 个` : null,
    changes.misconceptionsResolved > 0 ? `解除误区 ${changes.misconceptionsResolved} 个` : null,
  ].filter((v): v is string => v !== null);

  return (
    <section className="card state-changes" aria-label="本次判分引起的状态变化">
      <h3>学习状态变化</h3>
      <p className="small muted">
        以下变化全部由本地确定性规则计算:评估 {changes.assessedConceptIds.length} 个概念,证据来自{' '}
        {changes.documentIds.length} 份文档。
      </p>
      <ul className="small state-change-list">
        <li>
          错题:新增 {changes.mistakesCreated} 道
          {changes.mistakesResolved > 0 ? ` · 解决 ${changes.mistakesResolved} 道` : ''}
        </li>
        {misconceptionParts.length > 0 ? <li>误区:{misconceptionParts.join(' · ')}</li> : null}
        {changes.masteryChanges.length > 0 ? (
          <li>
            掌握度:
            {changes.masteryChanges
              .map(
                (m) =>
                  `${m.conceptName} ${m.before === null ? '—' : Math.round(m.before * 100) + '%'} → ${Math.round(
                    m.after * 100,
                  )}%`,
              )
              .join(';')}
          </li>
        ) : null}
        {changes.reviewScheduled.length > 0 ? (
          <li>
            复习安排:
            {changes.reviewScheduled
              .map((r) => `${r.conceptName}(${r.rating})→ ${r.dueAt.slice(0, 10)}`)
              .join(';')}
          </li>
        ) : null}
      </ul>
      <p className="small">
        <strong>建议下一步:</strong>
        {changes.recommendedNextStep}
      </p>
    </section>
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
  const status = classifyGradeStatus(grade);

  return (
    <section className="card">
      <div className="row between">
        <h3>
          第 {index + 1} 题{' '}
          <span className={`pill ${STATUS_PILL[status]}`}>{STATUS_TEXT[status]}</span>{' '}
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

      {!isTextAnswerType(question.type) ? (
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
              <ul className="rubric-points" style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {question.rubric.keyPoints.map((point, i) => {
                  const hit = grade.matchedKeyPoints?.includes(point.text) ?? false;
                  const partial = !hit && (grade.partialKeyPoints?.includes(point.text) ?? false);
                  // Optional points are enrichment: their absence is shown as
                  // 可补充, never as a red error marker.
                  const state = hit
                    ? 'hit'
                    : partial
                      ? 'partial'
                      : point.required
                        ? 'missed'
                        : 'enrichment';
                  const marker = hit ? '✓' : partial ? '△' : point.required ? '✗' : '○';
                  return (
                    <li key={`${i}-${point.text}`} className={`rubric-point ${state}`}>
                      <span aria-hidden="true">{marker}</span> 要点 {i + 1}:{point.text}
                      {!point.required ? <span className="pill enrichment">可补充</span> : null}
                      {partial ? <span className="small muted">(部分覆盖)</span> : null}
                      {state === 'hit' || state === 'missed' ? (
                        <span className="visually-hidden">
                          {state === 'hit' ? '(已覆盖)' : '(未覆盖)'}
                        </span>
                      ) : null}
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
      {(question.supplementaryEvidence ?? []).map((evidence, i) => (
        <SourceEvidencePanel
          key={`${evidence.blockId}-${i}`}
          grounding={evidence}
          blocks={blocks}
          defaultOpen
        />
      ))}
    </section>
  );
}
