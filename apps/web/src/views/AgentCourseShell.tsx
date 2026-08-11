import type { ReactNode } from 'react';

export type AgentCourseView = 'home' | 'session' | 'curriculum' | 'progress' | 'explore';

const VIEW_LABELS: Record<AgentCourseView, string> = {
  home: '课程主页',
  curriculum: '课程结构',
  progress: '学习进展',
  explore: '探索',
  session: 'Study Session',
};

export interface AgentCourseShellProps {
  activeView: AgentCourseView;
  courseName: string | null;
  onViewChange: (view: AgentCourseView) => void;
  children: ReactNode;
}

/** Course shell. App owns Course selection, navigation, and async state. */
export function AgentCourseShell({
  activeView,
  courseName,
  onViewChange,
  children,
}: AgentCourseShellProps) {
  return (
    <section className="agent-course-shell" aria-label="课程执行工作区">
      <div className="row between">
        <div>
          <h2 style={{ marginBottom: 0 }}>{courseName ?? '选择课程空间'}</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            {courseName ? '按已确认目标执行学习路线' : '选择或创建课程空间后建立学习目标与路线'}
          </p>
        </div>
        <nav className="tabs" aria-label="课程导航">
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
      </div>
      <div className="agent-course-content">{children}</div>
    </section>
  );
}
