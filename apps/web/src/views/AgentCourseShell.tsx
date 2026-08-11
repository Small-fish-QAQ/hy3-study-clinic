import type { ReactNode } from 'react';

export type AgentCourseView = 'home' | 'session' | 'curriculum' | 'progress' | 'explore';

const VIEW_LABELS: Record<AgentCourseView, string> = {
  home: '主页',
  session: '学习',
  curriculum: '课程结构',
  progress: '进展',
  explore: '探索',
};

export interface AgentCourseShellProps {
  activeView: AgentCourseView;
  courseName: string | null;
  onViewChange: (view: AgentCourseView) => void;
  children: ReactNode;
}

/** The single learner-facing navigation model for a selected Course. */
export function AgentCourseShell({
  activeView,
  courseName,
  onViewChange,
  children,
}: AgentCourseShellProps) {
  return (
    <section className="agent-course-shell" aria-label="课程学习空间">
      <div className="agent-course-heading row between">
        <div>
          <h2 style={{ marginBottom: 0 }}>{courseName ?? '选择课程空间'}</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            {courseName
              ? '按当前目标继续学习，随时查看进展与课程依据'
              : '选择或创建课程后开始建立学习目标'}
          </p>
        </div>
        {courseName ? (
          <nav className="course-nav" aria-label="课程导航">
            {(Object.keys(VIEW_LABELS) as AgentCourseView[]).map((view) => (
              <button
                key={view}
                type="button"
                className={activeView === view ? 'active' : ''}
                aria-current={activeView === view ? 'page' : undefined}
                onClick={() => onViewChange(view)}
              >
                {VIEW_LABELS[view]}
              </button>
            ))}
          </nav>
        ) : null}
      </div>
      <div className="agent-course-content">{children}</div>
    </section>
  );
}
