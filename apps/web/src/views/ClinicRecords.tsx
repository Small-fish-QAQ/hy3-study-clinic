import type { CourseOperation, CourseRepairRound, CourseSubmission } from '@hy3-clinic/shared';
import { useEffect, useRef } from 'react';
import type { LearningProgress, LearningRecords, clinicApi } from '../clinicApi.js';
import { StudyText } from '../components/StudyText.js';
import { reflectionStatusLabel } from '../components/ClinicReflection.js';

export const statusLabel = {
  queued: '等待开始',
  running: '正在准备',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
  interrupted: '服务中断',
};
export const operationLabel = {
  preparePlan: '课程规划',
  prepareLesson: 'Lesson课文',
  preparePractice: '练习',
  prepareRepair: '补救与Retest',
  prepareFormal: '正式试卷',
  gradeAssessment: '作答评分',
};
const purposeLabel = {
  practice: '练习',
  retest: 'Retest',
  explicit_review: '主动复习',
  formal: '正式考核',
};
const time = (at: string) => new Date(at).toLocaleString();
export function ClinicProgress({
  progress,
  busy,
  onReview,
  onReconcile,
  onLesson,
}: {
  progress: LearningProgress;
  busy: boolean;
  onReview: (id: string) => void;
  onReconcile: () => void;
  onLesson?: (lessonId: string, segmentId: string) => void;
}) {
  return (
    <section className="clinic-progress-view">
      <header className="course-home-context">
        <p className="eyebrow">每一步，都留下依据</p>
        <h1>学习与复习</h1>
        <p className="muted">学习路线、日常表现和正式证据分别记录。</p>
      </header>
      <section className="card clinic-route-progress">
        <div>
          <p className="eyebrow">学习路线</p>
          <h2>{progress.learningRouteCompleted ? '学习路线已完成' : '继续按自己的节奏'}</h2>
          <p>
            已完成 {progress.completedLessons} / {progress.lessonCount}{' '}
            Lesson。正式考试未参加或失败不会撤销学习完成。
          </p>
        </div>
        <progress
          aria-label="学习路线完成度"
          value={progress.completedLessons}
          max={Math.max(1, progress.lessonCount)}
        />
      </section>
      <div className="clinic-learning-notices" aria-label="需要留意的学习内容">
        <div>
          <strong>{progress.knowledge.filter((k) => !k.learned).length}</strong>
          <span>尚未完成学习</span>
        </div>
        <div>
          <strong>{progress.knowledge.filter((k) => k.formalStatus === 'untested').length}</strong>
          <span>尚未正式验证</span>
        </div>
        <div>
          <strong>
            {progress.classroomTasks?.filter((t) => t.status === 'deferred').length ?? 0}
          </strong>
          <span>课堂思考已延后</span>
        </div>
        <div>
          <strong>
            {progress.daily.filter((t) => t.diagnostic?.result !== 'independent_success').length}
          </strong>
          <span>日常表现待巩固</span>
        </div>
      </div>
      {progress.sourceWarnings?.length ||
      progress.knowledge.some((k) => k.uncertaintyCodes.length) ? (
        <details className="clinic-disclosure clinic-source-cautions">
          <summary>资料中有待核实内容</summary>
          <p>这些提示保留来源的不确定性，不把疑点当作已证明的事实。</p>
          {progress.sourceWarnings?.map((w, i) => (
            <p key={i}>
              <strong>{w.title}</strong> · {w.message}
            </p>
          ))}
          {progress.knowledge
            .filter((k) => k.uncertaintyCodes.length)
            .map((k) => (
              <div key={k.id}>
                <h3>{k.title}</h3>
                <StudyText text={k.statement} />
              </div>
            ))}
        </details>
      ) : null}
      {!!progress.classroomTasks?.length && (
        <>
          <div className="clinic-section-heading">
            <h2>课堂思考备忘</h2>
            <span className="muted">延后和跳过的内容仍可回来</span>
          </div>
          <div className="clinic-reflection-records">
            {progress.classroomTasks.map((task) => (
              <article className="card" key={`${task.lessonVersionId}:${task.segmentId}`}>
                <div className="clinic-card-meta">
                  <span className="eyebrow">{task.lessonTitle}</span>
                  <span className="pill">{reflectionStatusLabel[task.status]}</span>
                </div>
                <StudyText text={task.prompt} />
                {task.response && (
                  <details className="clinic-disclosure">
                    <summary>我的思考</summary>
                    <StudyText text={task.response} />
                  </details>
                )}
                {onLesson && (
                  <button disabled={busy} onClick={() => onLesson(task.lessonId, task.segmentId)}>
                    回到这道思考
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {!!progress.pendingStudyOutcomes?.length && (
        <p className="banner info" role="status">
          有 {progress.pendingStudyOutcomes.length}{' '}
          份可靠评分等待本地画像与复习投影恢复。评分本身已保存。
        </p>
      )}
      <div className="clinic-section-heading">
        <h2>日常表现与复习建议</h2>
        <button className="ghost" disabled={busy} onClick={onReconcile}>
          恢复本地学习记录投影
        </button>
      </div>
      {progress.daily.length ? (
        <div className="clinic-review-grid">
          {progress.daily.map((target) => (
            <article className="card clinic-review-card" key={target.id}>
              <span className="eyebrow">
                {purposeLabel[target.diagnostic?.sourceKind as keyof typeof purposeLabel] ??
                  '日常观察'}{' '}
                · {target.diagnostic?.occurredAt ? time(target.diagnostic.occurredAt) : ''}
              </span>
              <h3>{target.title}</h3>
              <p>
                {target.diagnostic?.assistance === 'hint'
                  ? '在提示下作答'
                  : target.diagnostic?.result === 'independent_success'
                    ? '独立作答成功'
                    : '仍需巩固'}
              </p>
              <p className="muted">
                {target.schedule
                  ? `建议复习：${time(target.schedule.dueAt)}`
                  : '提示下的观察尚不形成独立检索调度'}
              </p>
              <button disabled={busy} onClick={() => onReview(target.id)}>
                主动复习
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p className="clinic-empty-note">完成一次可靠作答后，这里会显示日常表现与复习建议。</p>
      )}
      <div className="clinic-section-heading">
        <h2>知识状态</h2>
        <span className="muted">未实测的知识不会被标为正式掌握</span>
      </div>
      <div className="clinic-knowledge-list">
        {progress.knowledge.map((k) => (
          <article key={k.id}>
            <div>
              <h3>{k.title}</h3>
              <p className="muted">
                规划已分配 · {k.delivered ? '正文已生成并定位' : '正文待生成'} ·{' '}
                {k.learned ? '已学习' : '尚未完成学习'}
              </p>
            </div>
            <span className={`pill ${k.formalStatus === 'supported' ? 'success' : ''}`}>
              正式证据：
              {k.formalStatus === 'untested'
                ? '未实测'
                : k.formalStatus === 'supported'
                  ? '有支持证据'
                  : '尚待支持'}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}
export function ClinicRecords({
  records,
  operations,
  detail,
  busy,
  onSession,
  onDetail,
  onCloseDetail,
  onRepair,
  onRound,
  onRetry,
  onSupplementFormal,
  onResult,
}: {
  records: LearningRecords;
  operations: CourseOperation[];
  detail: Awaited<ReturnType<typeof clinicApi.submissionDetail>> | null;
  busy: boolean;
  onSession: (id: string) => void;
  onDetail: (id: string) => void;
  onCloseDetail: () => void;
  onRepair: (submission: CourseSubmission, round?: CourseRepairRound) => void;
  onRound: (id: string) => void;
  onRetry: (operation: CourseOperation) => void;
  onSupplementFormal?: (operation: CourseOperation) => void;
  onResult: (operation: CourseOperation) => void;
}) {
  const detailRef = useRef<HTMLElement>(null);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  function openDetail(id: string) {
    detailOpenerRef.current = document.activeElement as HTMLElement;
    onDetail(id);
  }
  function closeDetail() {
    onCloseDetail();
    requestAnimationFrame(() => detailOpenerRef.current?.focus());
  }
  useEffect(() => {
    if (!detail) return;
    detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    detailRef.current?.focus({ preventScroll: true });
  }, [detail]);
  const formalSubmissions = new Set(records.formalGrades.map((grade) => grade.submissionId));
  const retestSubmissions = new Set(records.repairs.map((repair) => repair.retestSubmissionId));
  return (
    <section className="clinic-records-view">
      <header className="course-home-context">
        <p className="eyebrow">你的学习档案</p>
        <h1>学习记录</h1>
        <p className="muted">讲解、对话、作答和每一次考核，都保留原来的依据。</p>
      </header>
      <div className="clinic-section-heading">
        <h2>课堂与对话</h2>
        <span className="muted">{records.sessions.length} 次课堂</span>
      </div>
      <div className="clinic-history-sessions">
        {records.sessions.map((s) => (
          <button className="card" key={s.id} disabled={busy} onClick={() => onSession(s.id)}>
            <span className="eyebrow">{s.purpose === 'revisit' ? '回看对话' : '学习课堂'}</span>
            <strong>{time(s.createdAt)}</strong>
            <span className="clinic-session-record-state">
              {s.status === 'completed'
                ? '已完成 · 只读'
                : s.status === 'paused'
                  ? '已暂停'
                  : '继续学习'}
              <img src="/icons/tabler/arrow-right.svg" alt="" width="16" height="16" />
            </span>
          </button>
        ))}
      </div>
      {!records.sessions.length && (
        <p className="clinic-empty-note">打开 Lesson 后，课堂会保存在这里。</p>
      )}
      <div className="clinic-section-heading">
        <h2>全部正式成绩</h2>
        <span className="muted">每次新卷，独立保存</span>
      </div>
      {records.formalGrades.length ? (
        records.formalGrades.map((g) => (
          <article className="card clinic-grade-record" key={g.id}>
            <div>
              <span className="eyebrow">
                {time(g.createdAt)}
                {g.currentSource ? '' : ' · 历史来源'}
              </span>
              <h3>
                {g.assessmentScope?.kind === 'module'
                  ? `单元考核 · ${g.assessmentScope.title}`
                  : '课程综合考核'}
              </h3>
              <p className="muted">{g.passed ? '达到本卷考核标准' : '待再次考核'}</p>
              <button className="ghost" disabled={busy} onClick={() => openDetail(g.submissionId)}>
                查看本次试卷与作答
              </button>
            </div>
            <strong className="clinic-grade-number">
              {Math.round(g.score * 100)}
              <small>%</small>
            </strong>
          </article>
        ))
      ) : (
        <p className="clinic-empty-note">尚无正式成绩。完成学习并不要求先参加考试。</p>
      )}
      <div className="clinic-section-heading">
        <h2>作答与错题</h2>
        <span className="muted">{records.submissions.length} 份作答</span>
      </div>
      <div className="clinic-submissions">
        {records.submissions.map((s) => (
          <article className="card" key={s.id}>
            <div className="clinic-card-meta">
              <span className="eyebrow">{time(s.submittedAt)}</span>
              <span className="pill">
                {s.status === 'graded' ? `${Math.round((s.score ?? 0) * 100)}%` : '评分待完成'}
              </span>
            </div>
            <h3>
              {formalSubmissions.has(s.id)
                ? records.formalGrades.find((g) => g.submissionId === s.id)?.assessmentScope
                    ?.kind === 'module'
                  ? `单元考核 · ${records.formalGrades.find((g) => g.submissionId === s.id)?.assessmentScope?.title}`
                  : '课程综合考核'
                : retestSubmissions.has(s.id)
                  ? 'Retest'
                  : '日常作答'}
            </h3>
            {s.itemGrades.length > 0 && (
              <details className="clinic-disclosure">
                <summary>评分反馈（{s.itemGrades.length}）</summary>
                {s.itemGrades.map((g) => (
                  <p key={g.id}>{g.feedback}</p>
                ))}
              </details>
            )}
            <div className="clinic-button-row">
              <button disabled={busy} onClick={() => openDetail(s.id)}>
                查看题目和作答
              </button>
              {s.status === 'graded' && s.itemGrades.some((g) => g.score < 1) && (
                <button className="ghost" disabled={busy} onClick={() => onRepair(s)}>
                  以后再做一轮补救
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {detail && (
        <article
          className="lesson-execution-panel clinic-record-detail"
          ref={detailRef}
          tabIndex={-1}
          aria-label="作答明细"
        >
          <header className="lesson-player-header">
            <div>
              <p className="eyebrow">
                {purposeLabel[detail.quiz.purpose]} · {time(detail.submission.submittedAt)}
              </p>
              <h2>冻结的题目与实际作答</h2>
            </div>
            <button className="ghost" onClick={closeDetail}>
              收起作答明细
            </button>
          </header>
          {detail.quiz.items.map((q, i) => {
            const response = detail.submission.responses.find(
              (a) => a.questionId === q.id,
            )?.response;
            return (
              <section className="clinic-answer-review" key={q.id}>
                <span className="eyebrow">题目 {String(i + 1).padStart(2, '0')}</span>
                <StudyText text={q.prompt} />
                {q.options.map((o) => (
                  <p key={o.id}>
                    <strong>{o.id}</strong> {o.text}
                  </p>
                ))}
                <div className="clinic-frozen-answer">
                  <span>我的回答</span>
                  <StudyText
                    text={
                      Array.isArray(response)
                        ? response
                            .map((id) => q.options.find((o) => o.id === id)?.text ?? id)
                            .join('；')
                        : (response ?? '')
                    }
                  />
                </div>
                {detail.solutions
                  .filter((solution) => solution.questionId === q.id)
                  .map((solution) => (
                    <div className="clinic-solution" key={solution.questionId}>
                      <strong>
                        {q.type === 'short_answer' ? (
                          '参考解答'
                        ) : (
                          <>
                            可靠答案：
                            {solution.answer
                              .map(
                                (answer) => q.options.find((o) => o.id === answer)?.text ?? answer,
                              )
                              .join('；')}
                          </>
                        )}
                      </strong>
                      <StudyText text={solution.explanation} />
                      {solution.rubric.map((c) => (
                        <p key={c.id}>评分标准：{c.description}</p>
                      ))}
                    </div>
                  ))}
              </section>
            );
          })}
        </article>
      )}
      <div className="clinic-section-heading">
        <h2>补救轮次</h2>
        <span className="muted">主动发起，没有累计次数上限</span>
      </div>
      {records.repairs.map((round) => (
        <article className="card clinic-round-record" key={round.id}>
          <div>
            <span className="eyebrow">
              第 {round.ordinal} 轮 · {time(round.createdAt)}
            </span>
            <h3>
              {round.status === 'completed'
                ? round.learnerOutcome === 'passed'
                  ? '本次补救已改善'
                  : '本轮结束，尚待改善'
                : round.status === 'submitted'
                  ? '作答已保存，评分待完成'
                  : round.status === 'failed'
                    ? '准备失败，可新开一轮'
                    : round.status === 'cancelled'
                      ? '本轮已结束'
                      : round.status === 'ready'
                        ? '可以进行 Retest'
                        : '准备中'}
            </h3>
          </div>
          <div className="clinic-button-row">
            {round.retestQuizId && (
              <button disabled={busy} onClick={() => onRound(round.id)}>
                回看本轮
              </button>
            )}
            {round.status === 'submitted' && (
              <button
                disabled={busy}
                onClick={() => {
                  const originId =
                    round.originKind === 'submission'
                      ? round.originId
                      : records.formalGrades.find((g) => g.id === round.originId)?.submissionId;
                  const source = records.submissions.find((s) => s.id === originId);
                  if (source) onRepair(source, round);
                }}
              >
                结束待评分轮，保留作答并新开补救
              </button>
            )}
          </div>
        </article>
      ))}
      <details className="clinic-operation-history">
        <summary>可恢复操作（{operations.length}）</summary>
        {operations.map((operation) => (
          <article key={operation.id}>
            <div>
              <strong>{operationLabel[operation.kind]}</strong>
              <span className="muted">{statusLabel[operation.status]}</span>
              {operation.error && <p>{operation.error.message}</p>}
            </div>
            {['failed', 'interrupted'].includes(operation.status) &&
              operation.error?.retryable !== false && (
                <button disabled={busy} onClick={() => onRetry(operation)}>
                  恢复未完成范围
                </button>
              )}
            {operation.kind === 'prepareFormal' &&
              operation.status === 'failed' &&
              onSupplementFormal && (
                <button disabled={busy} onClick={() => onSupplementFormal(operation)}>
                  补齐缺失题目
                </button>
              )}
            {operation.status === 'completed' && operation.resourceId && (
              <button disabled={busy} onClick={() => onResult(operation)}>
                打开已完成结果
              </button>
            )}
          </article>
        ))}
      </details>
    </section>
  );
}
