import type { CourseKnowledgeInventory, CoursePlan, LessonDepth } from '@hy3-clinic/shared';
import type { LearningProgress } from '../clinicApi.js';
import { depthLabel, depthDescription } from './ClinicPreparation.js';

const demandLabel = {
  remember: '识记',
  understand: '理解',
  apply: '应用',
  analyze: '分析',
  evaluate: '评价',
  design: '设计',
};
export function ClinicCourse({
  plan,
  inventory,
  progress,
  busy,
  sourceChanged = false,
  onDepth,
  onConfirm,
  onLesson,
  onFormal,
  onMaterials,
  onPrepare,
}: {
  plan: CoursePlan | null;
  inventory: CourseKnowledgeInventory | null;
  progress: LearningProgress | null;
  busy: boolean;
  sourceChanged?: boolean;
  onDepth: (lessonId: string, depth: LessonDepth) => void;
  onConfirm: () => void;
  onLesson: (lessonId: string) => void;
  onFormal: (moduleId?: string) => void;
  onMaterials: () => void;
  onPrepare?: () => void;
}) {
  if (!plan)
    return (
      <section className="course-empty-state">
        <h2>从课程资料开始</h2>
        <button className="primary" onClick={onMaterials}>
          导入学习资料
        </button>
      </section>
    );
  const draft = plan.status === 'draft';
  const next =
    plan.lessons.find((lesson) => !progress?.completedLessonIds.includes(lesson.id)) ??
    plan.lessons[0];
  const objectives = plan.lessons.flatMap((lesson) => lesson.objectives);
  return (
    <div className="clinic-course-view clinic-planning-view">
      <header className="supporting-page-intro course-page-intro row between">
        <div>
          <p className="eyebrow">课程地图</p>
          <h1>{plan.title}</h1>
          <p className="muted">先看课程的主要部分，再按需展开学习目标、知识点与先修关系。</p>
        </div>
        {onPrepare && (
          <button className="ghost" disabled={busy} onClick={onPrepare}>
            调整准备设置
          </button>
        )}
      </header>
      {sourceChanged && (
        <div className="banner info" role="status">
          <p>
            课程资料范围已改变。可以根据新资料重新准备规划，原规划与已有课堂仍保留。来源不再有效的内容会在打开时检查。
          </p>
          <button disabled={busy} onClick={onPrepare}>
            按当前资料重新准备
          </button>
        </div>
      )}
      <section className="curriculum-version-overview" aria-label="课程规划全貌">
        <div className="preparation-plan-counts">
          <div className="preparation-plan-version">
            <span className="pill success">{draft ? '待你审阅' : '已确认'}</span>
            <p className="small muted">完整课程规划 · 版本 {plan.version}</p>
          </div>
          <dl className="curriculum-counts">
            <div>
              <dt>主要模块</dt>
              <dd>{plan.modules.length}</dd>
            </div>
            <div>
              <dt>Lesson</dt>
              <dd>{plan.lessons.length}</dd>
            </div>
            <div>
              <dt>必学知识</dt>
              <dd>{plan.teachingRequiredKnowledgeIds.length}</dd>
            </div>
            <div>
              <dt>学习目标</dt>
              <dd>{objectives.length}</dd>
            </div>
          </dl>
        </div>
        <p className="preparation-plan-note">
          {draft
            ? '全部必学知识已分配到 Lesson；课文在你打开时生成。先修是学习建议，不会锁住后面的课程。'
            : `已完成 ${progress?.completedLessons ?? 0} / ${plan.lessons.length} 课。学习路线与正式考试结果分别记录。`}
        </p>
        {plan.preferences && (
          <details className="preparation-input-disclosure">
            <summary>课程准备设置 · {depthLabel[plan.preferences.desiredDepth]}</summary>
            <p>{depthDescription[plan.preferences.desiredDepth]}</p>
            <p>特别关注：{plan.preferences.focusRequest || '均衡安排，无额外重点'}</p>
            <p className="small muted">逐课深度以当前 Lesson 的选择为准。</p>
          </details>
        )}
      </section>
      {plan.warnings.map((warning, i) => (
        <p className="banner info" key={i}>
          {warning}
        </p>
      ))}
      {!draft && (
        <section className="next-action next-action-study" aria-label="课程下一步">
          <div>
            <p className="eyebrow">
              {progress?.learningRouteCompleted ? '循证而学，融会贯通' : '继续这一课'}
            </p>
            <h2>{progress?.learningRouteCompleted ? '学习路线已完成' : next?.title}</h2>
            <p>按自己的节奏学习；练习和正式考核都可以稍后进行。</p>
          </div>
          <button
            className="course-primary-cta"
            disabled={busy}
            onClick={() => next && onLesson(next.id)}
          >
            {progress?.learningRouteCompleted ? '回看 Lesson' : '继续学习'}
            <img src="/icons/tabler/arrow-right.svg" width="20" height="20" alt="" />
          </button>
        </section>
      )}
      <div className="clinic-section-heading">
        <div>
          <p className="eyebrow">完整课程规划</p>
          <h2>课程由 {plan.modules.length} 个主要部分组成</h2>
        </div>
        <button className="ghost" onClick={onMaterials}>
          查看课程资料
        </button>
      </div>
      <p className="small muted">
        展开一个模块，查看其中的 Lesson；讲解深度、知识依据与学习目标都在这里。
      </p>
      {plan.modules.map((module, index) => {
        const lessons = plan.lessons.filter((lesson) => lesson.moduleId === module.id);
        return (
          <details
            className="curriculum-node is-major preparation-module"
            key={module.id}
            open={index === 0 ? true : undefined}
          >
            <summary className="curriculum-node-content">
              <div className="curriculum-node-title">
                <span className="curriculum-kind">模块 {String(index + 1).padStart(2, '0')}</span>
                <h3>{module.title}</h3>
                <p className="small muted">
                  {lessons.length} 课 · {new Set(lessons.flatMap((l) => l.knowledgeIds)).size}{' '}
                  个知识点
                </p>
              </div>
              <span className="preparation-module-toggle">
                <span className="preparation-module-closed">展开课程</span>
                <span className="preparation-module-open">收起课程</span>
                <img src="/icons/tabler/arrow-right.svg" width="16" height="16" alt="" />
              </span>
            </summary>
            <div className="preparation-module-lessons">
              {lessons.map((lesson) => (
                <article className="preparation-lesson-row" key={lesson.id}>
                  <div className="preparation-lesson-heading">
                    <div>
                      <p className="eyebrow">
                        Lesson {String(plan.lessons.indexOf(lesson) + 1).padStart(2, '0')}
                      </p>
                      <h4>{lesson.title}</h4>
                    </div>
                    <span
                      className={`pill ${!draft && progress?.completedLessonIds.includes(lesson.id) ? 'success' : ''}`}
                    >
                      {draft
                        ? '规划中'
                        : progress?.completedLessonIds.includes(lesson.id)
                          ? '已学习'
                          : '待学习'}
                    </span>
                  </div>
                  <p className="preparation-lesson-summary">{lesson.summary}</p>
                  <div className="preparation-lesson-options">
                    <label>
                      讲解深度
                      {draft ? (
                        <select
                          aria-label={`${lesson.title}讲解深度`}
                          value={lesson.selectedDepth}
                          disabled={busy || sourceChanged}
                          onChange={(e) => onDepth(lesson.id, e.target.value as LessonDepth)}
                        >
                          {Object.entries(depthLabel).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <strong>{depthLabel[lesson.selectedDepth]}</strong>
                      )}
                    </label>
                    <span className="small muted">
                      建议 {lesson.estimatedMinutes} 分钟 · 模型建议：
                      {depthLabel[lesson.recommendedDepth]}
                    </span>
                    {!draft && (
                      <button className="ghost" disabled={busy} onClick={() => onLesson(lesson.id)}>
                        打开 Lesson
                        <img src="/icons/tabler/arrow-right.svg" width="17" height="17" alt="" />
                      </button>
                    )}
                  </div>
                  <p className="preparation-depth-hint">{depthDescription[lesson.selectedDepth]}</p>
                  <details className="clinic-disclosure preparation-objectives">
                    <summary>学习目标（{lesson.objectives.length}）</summary>
                    <ul>
                      {lesson.objectives.map((objective) => (
                        <li key={objective.id}>
                          <span className="pill">{demandLabel[objective.demand]}</span>
                          <span>{objective.title}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <details className="clinic-disclosure">
                    <summary>知识点（{lesson.knowledgeIds.length}）</summary>
                    <ul>
                      {inventory?.knowledge
                        .filter((k) => lesson.knowledgeIds.includes(k.id))
                        .map((k) => (
                          <li key={k.id}>
                            <strong>{k.title}</strong>
                            <p>{k.statement}</p>
                            {k.origin === 'extension' && <small>教材外拓展</small>}
                          </li>
                        ))}
                    </ul>
                  </details>
                  {lesson.prerequisiteLessonIds.length > 0 && (
                    <p className="clinic-prerequisite">
                      建议先修：
                      {lesson.prerequisiteLessonIds
                        .map((id) => plan.lessons.find((l) => l.id === id)?.title)
                        .join('、')}
                      。可以先学本课，稍后回来。
                    </p>
                  )}
                </article>
              ))}
              {!draft && lessons.every((l) => progress?.completedLessonIds.includes(l.id)) && (
                <div className="clinic-unit-suggestion">
                  <div>
                    <strong>这个单元已学完</strong>
                    <p>可以检验理解，也可以继续下一单元。</p>
                  </div>
                  <button disabled={busy} onClick={() => onFormal(module.id)}>
                    检验这个单元
                  </button>
                </div>
              )}
            </div>
          </details>
        );
      })}
      <details className="course-detail-disclosure preparation-assessment">
        <summary>
          课程考核要求 · {plan.assessmentBlueprint.domains.filter((d) => d.required).length}{' '}
          个核心领域
        </summary>
        <div className="detail-content">
          <p className="small muted">
            按代表性能力检验理解，不要求逐个考完教材知识。确认后可以独立自测；不影响 Lesson 的完成。
          </p>
          {plan.assessmentBlueprint.domains
            .filter((d) => d.required)
            .map((domain) => (
              <div className="preparation-assessment-domain" key={domain.id}>
                <h3>{domain.title}</h3>
                <p>{domain.rationale}</p>
                <ul>
                  {plan.assessmentBlueprint.cells
                    .filter(
                      (cell) =>
                        cell.domainId === domain.id &&
                        plan.assessmentBlueprint.requiredCellIds.includes(cell.id),
                    )
                    .map((cell) => (
                      <li key={cell.id}>
                        <span className="pill">{demandLabel[cell.demand]}</span>
                        {cell.rationale}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
        </div>
      </details>
      {draft ? (
        <section className="preparation-plan-confirm" aria-label="规划确认">
          <div>
            <p className="eyebrow">先确认，再开始</p>
            <h2>这条路线，适合现在的你吗？</h2>
            <p>
              确认会保存当前讲解深度、学习目标和考核范围。之后打开任意
              Lesson，才开始生成讲解；练习和考试仍由你自主选择。
            </p>
          </div>
          <button className="primary" disabled={busy || sourceChanged} onClick={onConfirm}>
            确认完整规划
            <img src="/icons/tabler/arrow-right.svg" width="18" height="18" alt="" />
          </button>
        </section>
      ) : (
        <section className="clinic-formal-invite card">
          <div>
            <p className="eyebrow">检验核心能力</p>
            <h3>正式考核</h3>
            <p>每次生成新卷，历史成绩保留。学习完成与考试通过分开记录。</p>
          </div>
          <button onClick={() => onFormal()}>查看考核与新卷</button>
        </section>
      )}
    </div>
  );
}
