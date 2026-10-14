import { useEffect, useState } from 'react';
import type { CoursePlan } from '@hy3-clinic/shared';
import type { LearningProgress } from '../clinicApi.js';
const demandLabel = {
  remember: '识记',
  understand: '理解',
  apply: '应用',
  analyze: '分析',
  evaluate: '评价',
  design: '设计',
};
export function ClinicFormal({
  plan,
  progress,
  busy,
  onGenerate,
  onHistory,
  initialModuleId,
}: {
  plan: CoursePlan | null;
  progress?: LearningProgress | null;
  busy: boolean;
  onGenerate: (moduleId?: string) => void;
  onHistory: () => void;
  initialModuleId?: string | null;
}) {
  const [selected, setSelected] = useState(initialModuleId ?? plan?.modules[0]?.id ?? '');
  const firstModuleId = plan?.modules[0]?.id;
  useEffect(
    () => setSelected(initialModuleId ?? firstModuleId ?? ''),
    [firstModuleId, initialModuleId, plan?.id],
  );
  const module = plan?.modules.find((m) => m.id === selected);
  const lessons = plan?.lessons.filter((l) => l.moduleId === module?.id) ?? [];
  const objectiveIds = lessons.flatMap((l) => l.objectives.map((o) => o.id));
  const cells =
    plan?.assessmentBlueprint.cells.filter((c) =>
      c.objectiveIds.some((id) => objectiveIds.includes(id)),
    ) ?? [];
  const required = cells.filter((c) => plan?.assessmentBlueprint.requiredCellIds.includes(c.id));
  const assessed = required.length ? required : cells;
  const totalWeight = assessed.reduce((n, c) => n + c.weight, 0);
  const completed = lessons.filter((l) => progress?.completedLessonIds.includes(l.id)).length;
  return (
    <section className="clinic-formal-view">
      <header className="course-home-context">
        <p className="eyebrow">检验一个单元的理解</p>
        <h1>正式考核</h1>
        <p className="muted">按学习单元验证能力。自愿参加，什么时候准备好，就什么时候开始。</p>
      </header>
      {!plan || plan.status !== 'accepted' ? (
        <div className="card">
          <p>确认完整课程规划后，可以开始正式考核。</p>
        </div>
      ) : (
        <>
          <div className="clinic-section-heading">
            <h2>选择学习单元</h2>
            <button className="ghost" onClick={onHistory}>
              查看历史成绩
            </button>
          </div>
          <label className="clinic-unit-select">
            考核范围
            <select value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
              {plan.modules.map((m, i) => (
                <option key={m.id} value={m.id}>
                  {String(i + 1).padStart(2, '0')} · {m.title}
                </option>
              ))}
            </select>
          </label>
          <div className="next-action setup-action">
            <div>
              <p className="eyebrow">
                {completed === lessons.length
                  ? '本单元已学完 · 可以检验理解'
                  : `本单元已完成 ${completed} / ${lessons.length} 课`}
              </p>
              <h2>{module?.title}</h2>
              <p>
                {lessons.length} 节 Lesson · {new Set(lessons.flatMap((l) => l.knowledgeIds)).size}{' '}
                个知识点；试卷考查本单元的核心与代表性能力。
              </p>
            </div>
            <button
              className="course-primary-cta"
              disabled={busy || !module || !assessed.length}
              onClick={() => onGenerate(selected)}
            >
              生成单元正式试卷
              <img src="/icons/tabler/arrow-right.svg" alt="" width="20" height="20" />
            </button>
          </div>
          <p className="clinic-footnote">
            不要求先完成 Practice 或 Repair；考试也不会阻止继续学习。未学前提需在题面明确给出。
          </p>
          <div className="clinic-section-heading">
            <h2>这个单元会检验什么</h2>
            <span className="muted">沿用确认的课程目标</span>
          </div>
          <div className="clinic-unit-lessons">
            {lessons.map((l) => (
              <article className="card" key={l.id}>
                <h3>{l.title}</h3>
                <ul>
                  {l.objectives.map((o) => (
                    <li key={o.id}>{o.title}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          {assessed.map((cell) => (
            <article className="card clinic-blueprint" key={cell.id}>
              <div className="clinic-blueprint-cell">
                <span className="pill">{demandLabel[cell.demand]}</span>
                <span>本卷权重 {Math.round((cell.weight / totalWeight) * 100)}%</span>
                <p>{cell.rationale}</p>
              </div>
            </article>
          ))}
          <details className="clinic-disclosure clinic-comprehensive-exam">
            <summary>学完后，也可以参加课程综合考核</summary>
            <p>整合多个单元，沿用完整课程蓝图。每次新卷独立保存，单元成绩与综合成绩清楚区分。</p>
            <button disabled={busy} onClick={() => onGenerate()}>
              生成课程综合试卷
            </button>
          </details>
          <p className="clinic-footnote">
            本次未实测的知识仍显示未实测。日常练习与正式证据分别记录。
          </p>
        </>
      )}
    </section>
  );
}
