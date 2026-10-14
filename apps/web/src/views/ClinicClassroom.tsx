import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  CoursePlan,
  CourseRepairRound,
  CourseSubmission,
  CourseSourceSpan,
  CourseTutorAnchor,
  LessonReflection,
} from '@hy3-clinic/shared';
import { lessonReflectionPrompt } from '@hy3-clinic/shared';
import type { Classroom, PublicCourseQuiz } from '../clinicApi.js';
import { StudyText } from '../components/StudyText.js';
import { useLessonSelection } from '../components/useLessonSelection.js';
import { ClinicReflection } from '../components/ClinicReflection.js';

function SourceNotes({ room, spans }: { room: Classroom; spans: CourseSourceSpan[] }) {
  const quotes =
    room.sourceQuotes?.filter((source) =>
      spans.some(
        (span) =>
          span.blockId === source.span.blockId &&
          span.revisionId === source.span.revisionId &&
          span.start === source.span.start &&
          span.end === source.span.end,
      ),
    ) ?? [];
  if (!quotes.length) return null;
  return (
    <details className="study-tutor-sources clinic-source-notes">
      <summary>来源依据（{quotes.length}）</summary>
      <ul>
        {quotes.map((source) => (
          <li key={JSON.stringify(source.span)}>
            <strong>{source.title}</strong>
            <blockquote>{source.quote}</blockquote>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ClinicClassroom({
  room,
  plan,
  busy,
  question,
  onQuestion,
  onTutor,
  onComplete,
  onPractice,
  onLesson,
  onCourse,
  onSession,
  anchor = null,
  onAnchor,
  onReflection,
  initialSegmentId,
  tutorPending = false,
  completedLessonIds = [],
  onFormal,
  activityTitle,
  children,
}: {
  room: Classroom | null;
  plan: CoursePlan | null;
  busy: boolean;
  question: string;
  onQuestion: (text: string) => void;
  onTutor: () => void;
  onComplete: () => void;
  onPractice: () => void;
  onLesson: (id: string) => void;
  onCourse: () => void;
  onSession: (id: string) => void;
  anchor?: CourseTutorAnchor | null;
  onAnchor?: (anchor: CourseTutorAnchor | null) => void;
  onReflection?: (segmentId: string, status: LessonReflection['status'], response: string) => void;
  initialSegmentId?: string | null;
  tutorPending?: boolean;
  completedLessonIds?: string[];
  onFormal?: (moduleId: string) => void;
  activityTitle?: string;
  children?: ReactNode;
}) {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 1100px)').matches ?? false,
  );
  const [tutorOpen, setTutorOpen] = useState(
    () => !(window.matchMedia?.('(max-width: 1100px)').matches ?? false),
  );
  const tutorRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef<HTMLElement>(null);
  const selection = useLessonSelection(readingRef, room?.content);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const sessionId = room?.session.id;
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 1100px)');
    if (!query) return;
    const update = (event: MediaQueryListEvent) => {
      setNarrow(event.matches);
      if (event.matches) setTutorOpen(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  function closeTutor() {
    setTutorOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }
  useEffect(() => {
    if (!narrow || !tutorOpen || !sessionId || !tutorRef.current) return;
    // Isolate the sheet, including navigation outside the classroom. Restore
    // existing inert state when closing; layout never changes domain state.
    const isolated: HTMLElement[] = [];
    let branch: HTMLElement | null = tutorRef.current;
    while (branch && branch !== document.body) {
      for (const sibling of Array.from(branch.parentElement?.children ?? [])) {
        if (
          sibling !== branch &&
          sibling instanceof HTMLElement &&
          !sibling.hasAttribute('inert') &&
          !sibling.classList.contains('study-tutor-backdrop')
        ) {
          sibling.setAttribute('inert', '');
          isolated.push(sibling);
        }
      }
      branch = branch.parentElement;
    }
    composerRef.current?.focus();
    return () => isolated.forEach((element) => element.removeAttribute('inert'));
  }, [narrow, tutorOpen, sessionId]);
  useEffect(() => {
    transcriptRef.current?.scrollTo?.({ top: transcriptRef.current.scrollHeight });
  }, [room?.turns.length]);
  useEffect(() => {
    if (!tutorOpen) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTutor();
      }
      if (event.key !== 'Tab' || !narrow) return;
      const focusable = Array.from(
        tutorRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[href]',
        ) ?? [],
      );
      const first = focusable[0],
        last = focusable.at(-1);
      if (!tutorRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [tutorOpen, narrow]);
  useEffect(() => {
    if (!initialSegmentId) return;
    requestAnimationFrame(() => {
      const target = Array.from(
        readingRef.current?.querySelectorAll<HTMLElement>('[data-tutor-segment]') ?? [],
      ).find((el) => el.dataset.tutorSegment === initialSegmentId);
      target?.scrollIntoView?.({ block: 'center' });
    });
  }, [initialSegmentId, room?.content.id]);
  function openTutor(quote?: CourseTutorAnchor) {
    if (quote) {
      onAnchor?.(quote);
      window.getSelection()?.removeAllRanges();
    }
    setTutorOpen(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  const lesson = plan?.lessons.find((l) => l.id === room?.content.lessonId);
  const choosing = Boolean(plan && !room && !children && !activityTitle);
  return (
    <section
      className={`study-session clinic-study ${choosing ? 'is-choosing' : ''}`}
      aria-label="学习区"
    >
      {!choosing && (
        <header className="study-session-header">
          <div className="study-session-header-inner">
            <div className="study-session-heading">
              <p className="eyebrow">
                {room ? '当前学习' : activityTitle ? '本次作答' : '学习空间'}
              </p>
              <h3>{room?.content.title ?? activityTitle ?? '准备好开始了吗？'}</h3>
              {lesson && (
                <div className="study-session-meta">
                  <span>建议 {lesson.estimatedMinutes} 分钟</span>
                  <span>
                    第 {plan!.lessons.indexOf(lesson) + 1} / {plan?.lessons.length} 课
                  </span>
                </div>
              )}
            </div>
            <div className="study-session-header-actions">
              {room && (
                <button
                  ref={triggerRef}
                  className="study-tutor-trigger"
                  onClick={() => (tutorOpen ? closeTutor() : openTutor())}
                  aria-expanded={tutorOpen}
                  aria-controls="clinic-tutor"
                >
                  {tutorOpen ? '收起 Tutor' : '问 Tutor'}
                </button>
              )}
              {plan && (
                <button onClick={() => setOutlineOpen(!outlineOpen)} aria-expanded={outlineOpen}>
                  课程导航
                </button>
              )}
              {room && (
                <span className={`session-status ${room.session.status}`}>
                  {room.session.status === 'completed'
                    ? '已完成'
                    : room.session.purpose === 'revisit'
                      ? '回看对话'
                      : '学习中'}
                </span>
              )}
            </div>
          </div>
        </header>
      )}
      {(outlineOpen || choosing) && plan && (
        <nav
          className="clinic-lesson-outline"
          aria-label="Lesson 导航"
          data-layout={choosing ? 'start' : 'compact'}
        >
          <header className="clinic-picker-heading">
            <div>
              <p className="eyebrow">课程导航 · {plan.lessons.length} 课</p>
              <h2>{choosing ? '选择一课，开始学习' : '继续选择 Lesson'}</h2>
              <p className="muted">
                按模块浏览，也可以跳到后面的课。先修是建议，已完成的课堂可随时回看。
              </p>
            </div>
            {!choosing && <button onClick={() => setOutlineOpen(false)}>返回讲解</button>}
          </header>
          {plan.status !== 'accepted' && (
            <p>
              请先确认课程规划。<button onClick={onCourse}>返回课程确认</button>
            </p>
          )}
          {plan.modules.map((module, moduleIndex) => (
            <section className="clinic-picker-module" key={module.id}>
              <h3>
                <span>{String(moduleIndex + 1).padStart(2, '0')}</span>
                {module.title}
              </h3>
              <ol>
                {plan.lessons
                  .filter((l) => l.moduleId === module.id)
                  .map((l) => {
                    const i = plan.lessons.indexOf(l);
                    return (
                      <li key={l.id}>
                        <button
                          disabled={busy || plan.status !== 'accepted'}
                          aria-current={l.id === room?.content.lessonId ? 'step' : undefined}
                          onClick={() => {
                            onLesson(l.id);
                            setOutlineOpen(false);
                          }}
                        >
                          <span>{String(i + 1).padStart(2, '0')}</span>
                          <div>
                            <strong>{l.title}</strong>
                            <small>
                              {l.id === room?.content.lessonId
                                ? '当前课'
                                : completedLessonIds.includes(l.id)
                                  ? '已完成 · 可回看'
                                  : '待学习'}{' '}
                              · 建议 {l.estimatedMinutes} 分钟
                            </small>
                          </div>
                        </button>
                      </li>
                    );
                  })}
              </ol>
            </section>
          ))}
        </nav>
      )}
      <div className="study-session-layout">
        <main className="study-session-learning-stack">
          {room ? (
            <article
              ref={readingRef}
              className="lesson-execution-panel clinic-reading-document"
              key={room.content.id}
            >
              <header className="lesson-player-header">
                <div>
                  <p className="eyebrow">本节讲解</p>
                  <h1>{room.content.title}</h1>
                  <p className="lesson-player-status">
                    {room.session.status === 'completed'
                      ? '已完成 · 历史课堂只读'
                      : room.session.purpose === 'revisit'
                        ? '回看对话 · 原课堂保持只读'
                        : '正在学习 · 完整讲解已准备好'}
                  </p>
                </div>
                <span className="clinic-reading-number">
                  {lesson ? String(plan!.lessons.indexOf(lesson) + 1).padStart(2, '0') : 'Lesson'}
                </span>
              </header>
              {lesson && (
                <details className="lesson-orientation">
                  <summary>
                    本节目标 <span>{lesson.objectives.length} 个学习目标</span>
                  </summary>
                  <ul>
                    {lesson.objectives.map((o) => (
                      <li key={o.id}>{o.title}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div>
                {room.content.segments.map((segment, i) => {
                  const task = lessonReflectionPrompt(segment);
                  return (
                    <section
                      id={`reading-${i}`}
                      data-tutor-segment={segment.id}
                      className={`clinic-reading-segment ${segment.kind}`}
                      key={segment.id}
                    >
                      <div className="clinic-segment-meta">
                        <span>
                          {segment.kind === 'worked_example'
                            ? '例题与讲解'
                            : segment.kind === 'calculation'
                              ? '计算与推导'
                              : segment.kind === 'proof'
                                ? '推理过程'
                                : segment.kind === 'optional_prompt'
                                  ? '想一想'
                                  : `讲解 ${String(i + 1).padStart(2, '0')}`}
                        </span>
                        {segment.origin === 'extension' && <span className="pill">教材外拓展</span>}
                      </div>
                      {task && onReflection ? (
                        <>
                          {task.introduction && <StudyText text={task.introduction} />}
                          <ClinicReflection
                            segmentId={segment.id}
                            prompt={task.prompt}
                            record={room.reflections?.find((r) => r.segmentId === segment.id)}
                            busy={busy}
                            onSave={(status, response) =>
                              onReflection(segment.id, status, response)
                            }
                            onTutor={(text) => {
                              openTutor({
                                lessonVersionId: room.content.id,
                                segmentIds: [segment.id],
                                selectedText: task.prompt.slice(0, 1800),
                              });
                              onQuestion(text);
                            }}
                          />
                        </>
                      ) : (
                        <StudyText text={segment.text} />
                      )}
                      <SourceNotes room={room} spans={segment.sourceRefs} />
                    </section>
                  );
                })}
              </div>
              <footer className="clinic-reading-actions">
                {room.session.purpose === 'learning' && room.session.status !== 'completed' ? (
                  <>
                    <p>读完后由你确认学习完成。练习可以稍后再做。</p>
                    <button className="primary" disabled={busy} onClick={onComplete}>
                      我已完成本课
                    </button>
                  </>
                ) : (
                  <>
                    <p>原讲解和对话已保存。继续学习，或用练习检验理解。</p>
                    <button className="primary" disabled={busy} onClick={onPractice}>
                      按需练习
                    </button>
                    <button onClick={onCourse}>继续选择 Lesson</button>
                  </>
                )}
              </footer>
              {lesson &&
                onFormal &&
                plan?.lessons
                  .filter((l) => l.moduleId === lesson.moduleId)
                  .every((l) => completedLessonIds.includes(l.id)) && (
                  <div className="clinic-unit-suggestion">
                    <div>
                      <strong>这个单元已学完</strong>
                      <p>愿意的话，用一次正式考核检验理解；也可以继续下一课。</p>
                    </div>
                    <button disabled={busy} onClick={() => onFormal(lesson.moduleId)}>
                      检验这个单元
                    </button>
                  </div>
                )}
            </article>
          ) : (
            !children && (
              <div className="study-session-empty">
                <img src="/brand/understanding-pine.png" alt="" width="56" height="56" />
                <p className="eyebrow">一步步学明白</p>
                <strong>从课程路线打开任意 Lesson</strong>
                <p>讲解会在需要时准备。先修只是提醒；你可以先学后课，之后回来。</p>
                <button className="primary" onClick={onCourse}>
                  选择 Lesson
                </button>
              </div>
            )
          )}
          {children}
        </main>
        {room && tutorOpen && (
          <>
            <button
              className="study-tutor-backdrop"
              aria-label="关闭 Tutor"
              tabIndex={-1}
              aria-hidden="true"
              onClick={closeTutor}
            />
            <aside
              id="clinic-tutor"
              ref={tutorRef}
              className="study-tutor-secondary"
              aria-label="Tutor 辅助区"
              role={narrow ? 'dialog' : undefined}
              aria-modal={narrow ? true : undefined}
            >
              <header className="study-tutor-secondary-header">
                <div>
                  <h3>
                    <img src="/brand/understanding-pine.png" width="25" height="25" alt="" />
                    Tutor 助教
                  </h3>
                  <p className="study-tutor-context">围绕当前讲解，解释、举例与追问</p>
                </div>
                <button className="ghost" onClick={closeTutor}>
                  回到讲解
                </button>
              </header>
              {room.sessions.length > 1 && (
                <label className="clinic-transcript-select">
                  课堂与回看对话
                  <select
                    aria-label="选择课堂对话"
                    value={room.session.id}
                    disabled={busy}
                    onChange={(e) => onSession(e.target.value)}
                  >
                    {room.sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.purpose === 'revisit' ? '回看对话' : '原学习课堂'} ·{' '}
                        {new Date(s.createdAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="study-transcript" ref={transcriptRef}>
                <div className="study-transcript-inner">
                  {room.turns.length ? (
                    room.turns.map((turn) => (
                      <div className="clinic-tutor-turn" key={turn.id}>
                        <article className="study-exchange learner">
                          {turn.anchor && (
                            <div className="study-tutor-turn-context">
                              <span>关于这段讲解</span>
                              <blockquote>{turn.anchor.selectedText}</blockquote>
                            </div>
                          )}
                          <p>{turn.question}</p>
                        </article>
                        <article className="study-exchange tutor">
                          <header className="study-exchange-header">
                            <img
                              src="/brand/understanding-pine.png"
                              width="22"
                              height="22"
                              alt=""
                            />
                            <strong>Tutor</strong>
                          </header>
                          <div className="study-exchange-content">
                            <StudyText text={turn.text} />
                            {turn.includesExtension && (
                              <p className="clinic-footnote">
                                包含教材外拓展；不作为教材来源证据。
                              </p>
                            )}
                            <SourceNotes room={room} spans={turn.sourceRefs ?? []} />
                          </div>
                        </article>
                      </div>
                    ))
                  ) : (
                    <div className="clinic-tutor-empty">
                      <img src="/brand/understanding-pine.png" width="42" height="42" alt="" />
                      <h4>把没懂的地方说出来</h4>
                      <p>你可以问一个问题，也可以选中正文，让我解释那一段。</p>
                    </div>
                  )}
                  {tutorPending && (
                    <div className="study-tutor-stream" role="status">
                      <strong>Tutor</strong>
                      <p>正在组织这次回应…</p>
                    </div>
                  )}
                </div>
              </div>
              <div className="study-composer-dock">
                <form
                  className="study-composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (question.trim() && !busy) onTutor();
                  }}
                >
                  {anchor && (
                    <div className="study-tutor-selection">
                      <span>关于这段讲解</span>
                      <blockquote>{anchor.selectedText}</blockquote>
                      <button
                        type="button"
                        className="ghost small"
                        disabled={busy}
                        onClick={() => onAnchor?.(null)}
                      >
                        移除引用
                      </button>
                    </div>
                  )}
                  <div className="study-quick-help">
                    {['没听懂', '举个例子', '给点提示'].map((label) => (
                      <button
                        key={label}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onQuestion(
                            label === '没听懂'
                              ? `请换一种方式解释“${room.content.title}”的关键概念。`
                              : label === '举个例子'
                                ? `请为“${room.content.title}”举一个具体例子。`
                                : `理解“${room.content.title}”时应先关注哪些条件？`,
                          );
                          composerRef.current?.focus();
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="sr-only" htmlFor="clinic-tutor-question">
                    {room.session.status === 'completed' ? '开始独立的回看对话' : '课堂问题'}
                  </label>
                  <textarea
                    id="clinic-tutor-question"
                    ref={composerRef}
                    value={question}
                    onChange={(e) => onQuestion(e.target.value)}
                    disabled={busy}
                    rows={3}
                    placeholder="输入你的问题或想法…"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (question.trim() && !busy) onTutor();
                      }
                    }}
                  />
                  <div className="study-composer-actions">
                    <span className="small muted">
                      {room.session.status === 'completed'
                        ? '新问题会开启独立回看对话'
                        : 'Enter 发送 · Shift+Enter 换行'}
                    </span>
                    <button className="primary" disabled={busy || !question.trim()}>
                      提问
                    </button>
                  </div>
                </form>
              </div>
            </aside>
          </>
        )}
      </div>
      {selection && !busy && (
        <button
          type="button"
          className="study-tutor-selection-trigger"
          style={{ left: selection.x, top: selection.y }}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => openTutor(selection.anchor)}
        >
          就这段问 Tutor
        </button>
      )}
    </section>
  );
}

export function ClinicQuestions({
  quiz,
  round,
  submission,
  answers,
  hints,
  busy,
  onAnswers,
  onHint,
  onSubmit,
  onRepair,
  onCourse,
}: {
  quiz: PublicCourseQuiz;
  round?: CourseRepairRound;
  submission: CourseSubmission | null;
  answers: Record<string, string | string[]>;
  hints: Record<string, string>;
  busy: boolean;
  onAnswers: (questionId: string, response: string | string[]) => void;
  onHint: (questionId: string) => void;
  onSubmit: () => void;
  onRepair: () => void;
  onCourse: () => void;
}) {
  const purpose =
    quiz.purpose === 'formal'
      ? quiz.assessmentScope?.kind === 'module'
        ? '单元正式考核'
        : '课程综合考核'
      : quiz.purpose === 'retest'
        ? 'Retest'
        : quiz.purpose === 'explicit_review'
          ? '主动复习'
          : '练习';
  return (
    <div className="clinic-assessment-stack">
      {round && (
        <section className="card clinic-repair-explanation">
          <p className="eyebrow">围绕这次作答</p>
          <h2>第 {round.ordinal} 轮补救</h2>
          <StudyText text={round.explanation} />
          <p className="muted">一轮补救包含一次 Retest；结果不会改写原正式成绩。</p>
        </section>
      )}
      <section className="lesson-execution-panel clinic-question-paper">
        <header className="lesson-player-header">
          <div>
            <p className="eyebrow">
              {quiz.purpose === 'formal' ? '按冻结标准检验核心能力' : '用新的情境检验理解'}
            </p>
            <h1>
              {purpose} · 实际 {quiz.items.length} 题
            </h1>
            {quiz.assessmentScope && (
              <p className="clinic-footnote">
                考核范围：{quiz.assessmentScope.title} · {quiz.assessmentScope.lessonIds.length} 节
                Lesson
              </p>
            )}
            <p className="muted">
              {submission
                ? '冻结的题目与实际作答'
                : quiz.purpose === 'formal'
                  ? '完整作答后交卷，由服务端可靠评分。'
                  : '草稿自动保存。你可以暂离，之后继续。'}
            </p>
          </div>
          <span className="pill">{submission ? '已交卷' : '作答中'}</span>
        </header>
        {quiz.discardedCount > 0 && (
          <p className="banner info">未合格题已丢弃 {quiz.discardedCount} 道，按实际题目作答。</p>
        )}
        {quiz.items.map((q, i) => (
          <fieldset className="clinic-question" key={q.id} disabled={!!submission || busy}>
            <legend>
              <span className="clinic-question-number">{String(i + 1).padStart(2, '0')}</span>
              {q.prompt}
            </legend>
            {q.type === 'short_answer' ? (
              <textarea
                aria-label={q.prompt}
                rows={5}
                placeholder="写下你的思路与答案…"
                value={String(answers[q.id] ?? '')}
                onChange={(e) => onAnswers(q.id, e.target.value)}
              />
            ) : (
              q.options.map((o) => (
                <label
                  className={`clinic-answer-option ${((answers[q.id] as string[]) ?? []).includes(o.id) ? 'is-selected' : ''}`}
                  key={o.id}
                >
                  <input
                    type={q.type === 'multiple_choice' ? 'checkbox' : 'radio'}
                    name={q.id}
                    checked={((answers[q.id] as string[]) ?? []).includes(o.id)}
                    onChange={(e) =>
                      onAnswers(
                        q.id,
                        q.type === 'single_choice'
                          ? [o.id]
                          : e.target.checked
                            ? [...((answers[q.id] as string[]) ?? []), o.id]
                            : ((answers[q.id] as string[]) ?? []).filter((id) => id !== o.id),
                      )
                    }
                  />
                  <span>{o.text}</span>
                </label>
              ))
            )}
            {!submission && quiz.purpose !== 'formal' && (
              <div className="clinic-hint">
                <button type="button" className="ghost" onClick={() => onHint(q.id)}>
                  查看提示
                </button>
                {hints[q.id] && (
                  <div className="banner info">
                    <StudyText text={hints[q.id]!} />
                    <small>本次将记录为有提示作答</small>
                  </div>
                )}
              </div>
            )}
          </fieldset>
        ))}
        {!submission ? (
          <div className="clinic-paper-actions">
            <span className="muted">
              已作答 {quiz.items.filter((q) => (answers[q.id]?.length ?? 0) > 0).length} /{' '}
              {quiz.items.length} 题
            </span>
            <button
              className="primary"
              disabled={
                busy || quiz.items.some((q) => !answers[q.id] || (answers[q.id]?.length ?? 0) === 0)
              }
              onClick={onSubmit}
            >
              提交作答
            </button>
          </div>
        ) : (
          <section
            className={`clinic-score-result ${submission.status === 'graded' && submission.passed ? 'is-passed' : ''}`}
            role="status"
          >
            <p className="eyebrow">
              {submission.status === 'graded' ? '本次作答结果' : '等待可靠评分'}
            </p>
            <h2>
              {submission.status === 'graded'
                ? `得分 ${Math.round((submission.score ?? 0) * 100)}% · ${submission.passed ? '达到本次要求' : '尚未达到本次要求'}`
                : '答案已保存，等待可靠评分；暂未记为答错。'}
            </h2>
            {submission.itemGrades.map((g) => (
              <p key={g.id}>{g.feedback}</p>
            ))}
            <div className="clinic-button-row">
              {submission.status === 'graded' && submission.itemGrades.some((g) => g.score < 1) && (
                <button className="primary" onClick={onRepair}>
                  主动开始一轮补救
                </button>
              )}
              <button onClick={onCourse}>返回课程，继续学习</button>
            </div>
          </section>
        )}
      </section>
    </div>
  );
}
