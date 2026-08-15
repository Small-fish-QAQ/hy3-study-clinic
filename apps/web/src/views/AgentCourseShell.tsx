import { useEffect, useRef, useState, type ReactNode } from 'react';

export type AgentCourseView = 'home' | 'session' | 'curriculum' | 'progress' | 'explore';

export interface CourseOption {
  id: string;
  name: string;
}

const VIEW_LABELS: Record<AgentCourseView, string> = {
  home: '主页',
  session: '学习',
  curriculum: '课程结构',
  progress: '进展',
  explore: '探索',
};

const VIEW_DESCRIPTIONS: Record<AgentCourseView, string> = {
  home: '目标、下一步与今日路线',
  session: 'Tutor 对话与当前学习安排',
  curriculum: '已验证的课程层级与版本',
  progress: '正式证据、修复与学习记录',
  explore: '概念、关系与来源依据',
};

const SIDEBAR_STORAGE_KEY = 'hy3-clinic:course-sidebar-collapsed';
const NARROW_QUERY = '(max-width: 767px)';
const DRAWER_FOCUSABLE =
  'button:not(:disabled), select:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

export interface AgentCourseShellProps {
  activeView: AgentCourseView;
  courseId: string | null;
  courseName: string | null;
  courses: CourseOption[];
  materialsActive?: boolean;
  settingsActive?: boolean;
  provider?: 'fake' | 'hy3' | null;
  sidebarCollapsed?: boolean;
  onCourseChange: (courseId: string | null) => void;
  onViewChange: (view: AgentCourseView) => void;
  onOpenMaterials?: () => void;
  onOpenSettings?: () => void;
  onOpenAdvancedTools?: () => void;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  children: ReactNode;
}

/** Persistent Course-first navigation. It owns layout state only, never Course domain state. */
export function AgentCourseShell({
  activeView,
  courseId,
  courseName,
  courses,
  materialsActive = false,
  settingsActive = false,
  provider = null,
  sidebarCollapsed,
  onCourseChange,
  onViewChange,
  onOpenMaterials,
  onOpenSettings,
  onOpenAdvancedTools,
  onSidebarCollapsedChange,
  children,
}: AgentCourseShellProps) {
  const [localCollapsed, setLocalCollapsed] = useState(readSidebarCollapsedPreference);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileOpenerRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);

  const collapsed = sidebarCollapsed ?? localCollapsed;

  useEffect(() => writeSidebarCollapsedPreference(collapsed), [collapsed]);

  useEffect(() => {
    const query = window.matchMedia?.(NARROW_QUERY);
    if (!query) return;
    const update = (event: MediaQueryListEvent | MediaQueryList) => setNarrow(event.matches);
    update(query);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (!narrow) setMobileOpen(false);
  }, [narrow]);

  useEffect(() => {
    if (sidebarRef.current) sidebarRef.current.inert = narrow && !mobileOpen;
  }, [mobileOpen, narrow]);

  useEffect(() => {
    const content = workspaceBodyRef.current;
    if (!content) return;
    if (narrow && mobileOpen) content.setAttribute('inert', '');
    else content.removeAttribute('inert');
    return () => content.removeAttribute('inert');
  }, [mobileOpen, narrow]);

  useEffect(() => {
    if (!mobileOpen) return;
    mobileCloseRef.current?.focus();
    const handleDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        mobileOpenerRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...(sidebarRef.current?.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE) ?? []),
      ].filter(
        (element) =>
          !element.hidden &&
          !element.classList.contains('course-context-compact') &&
          !element.classList.contains('course-sidebar-collapse'),
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (!sidebarRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleDrawerKeyDown);
    return () => window.removeEventListener('keydown', handleDrawerKeyDown);
  }, [mobileOpen]);

  useEffect(() => {
    setMobileOpen(false);
  }, [activeView, courseId, materialsActive, settingsActive]);

  const destinationLabel = settingsActive
    ? '设置'
    : materialsActive
      ? '课程资料'
      : VIEW_LABELS[activeView];
  const destinationDescription = settingsActive
    ? '连接、工作区偏好与应用信息'
    : materialsActive
      ? '课程来源、角色与处理状态'
      : VIEW_DESCRIPTIONS[activeView];
  const visuallyCollapsed = collapsed && !narrow;

  function closeMobile(returnFocus = true): void {
    setMobileOpen(false);
    if (returnFocus) mobileOpenerRef.current?.focus();
  }

  function focusDestination(): void {
    queueMicrotask(() => workspaceBodyRef.current?.focus());
  }

  function selectView(view: AgentCourseView): void {
    onViewChange(view);
    if (narrow) {
      setMobileOpen(false);
      focusDestination();
    }
  }

  function updateCollapsed(next: boolean): void {
    if (sidebarCollapsed === undefined) setLocalCollapsed(next);
    onSidebarCollapsedChange?.(next);
  }

  function selectCourse(nextCourseId: string | null): void {
    onCourseChange(nextCourseId);
    if (narrow) {
      setMobileOpen(false);
      focusDestination();
    }
  }

  function openMaterials(): void {
    onOpenMaterials?.();
    if (narrow) {
      setMobileOpen(false);
      focusDestination();
    }
  }

  function openSettings(): void {
    onOpenSettings?.();
    if (narrow) {
      setMobileOpen(false);
      focusDestination();
    }
  }

  return (
    <section
      className={`agent-course-shell view-${
        settingsActive ? 'settings' : materialsActive ? 'materials' : activeView
      }`}
      aria-label="课程学习空间"
    >
      <h1 className="sr-only">
        Hy3 Study Clinic · {courseName ?? '选择课程'} · {destinationLabel}
      </h1>
      <header className="course-mobile-bar">
        <button
          ref={mobileOpenerRef}
          type="button"
          className="course-mobile-menu"
          aria-label="打开课程导航"
          aria-controls="course-sidebar"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
        >
          <ShellIcon name="menu" />
        </button>
        <div className="course-mobile-identity">
          <strong>{courseName ?? '选择课程'}</strong>
          <span>{destinationLabel}</span>
        </div>
      </header>

      {mobileOpen ? (
        <button
          type="button"
          className="course-sidebar-backdrop"
          aria-label="关闭课程导航"
          onClick={() => closeMobile()}
        />
      ) : null}

      <aside
        ref={sidebarRef}
        id="course-sidebar"
        className={`course-sidebar ${visuallyCollapsed ? 'is-collapsed' : ''} ${mobileOpen ? 'is-mobile-open' : ''}`}
        aria-label="课程侧边栏"
        aria-hidden={narrow && !mobileOpen ? true : undefined}
        role={narrow ? 'dialog' : undefined}
        aria-modal={narrow && mobileOpen ? true : undefined}
      >
        <div className="course-sidebar-brand-row">
          <div className="course-sidebar-brand" aria-label="Hy3 Study Clinic">
            <span className="course-brand-mark" aria-hidden="true">
              <img src="/brand-mark.svg" alt="" />
            </span>
            <span className="course-brand-copy">
              <strong>Hy3 Study Clinic</strong>
              <small>Guided learning workspace</small>
            </span>
          </div>
          <button
            ref={mobileCloseRef}
            type="button"
            className="course-sidebar-mobile-close"
            aria-label="关闭课程导航"
            onClick={() => closeMobile()}
          >
            <ShellIcon name="close" />
          </button>
        </div>

        <div className="course-context">
          <label className="course-context-expanded">
            <span>当前课程</span>
            <select
              aria-label="当前课程"
              value={courseId ?? ''}
              title={courseName ?? '选择课程'}
              onChange={(event) => selectCourse(event.target.value || null)}
            >
              <option value="">选择课程</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="course-context-compact"
            aria-label={`切换课程，当前：${courseName ?? '未选择'}`}
            title={courseName ?? '选择课程'}
            onClick={() => updateCollapsed(false)}
          >
            <ShellIcon name="course" />
          </button>
        </div>

        {courseName ? (
          <nav className="course-sidebar-nav" aria-label="课程导航">
            <span className="course-sidebar-section-label">学习空间</span>
            {(Object.keys(VIEW_LABELS) as AgentCourseView[]).map((view) => {
              const selected = !materialsActive && !settingsActive && activeView === view;
              return (
                <button
                  key={view}
                  type="button"
                  className={selected ? 'active' : ''}
                  aria-current={selected ? 'page' : undefined}
                  aria-label={visuallyCollapsed ? VIEW_LABELS[view] : undefined}
                  title={visuallyCollapsed ? VIEW_LABELS[view] : undefined}
                  onClick={() => selectView(view)}
                >
                  <ShellIcon name={view} />
                  <span className="course-nav-label">{VIEW_LABELS[view]}</span>
                </button>
              );
            })}
          </nav>
        ) : null}

        <div className="course-sidebar-secondary" aria-label="课程辅助入口">
          <span className="course-sidebar-section-label">课程资源</span>
          {courseName && onOpenMaterials ? (
            <button
              type="button"
              className={materialsActive ? 'active' : ''}
              aria-current={materialsActive ? 'page' : undefined}
              aria-label={visuallyCollapsed ? '课程资料' : undefined}
              title={visuallyCollapsed ? '课程资料' : undefined}
              onClick={openMaterials}
            >
              <ShellIcon name="materials" />
              <span className="course-nav-label">课程资料</span>
            </button>
          ) : null}
          {onOpenAdvancedTools ? (
            <button
              type="button"
              aria-label={visuallyCollapsed ? '兼容与高级工具' : undefined}
              title={visuallyCollapsed ? '兼容与高级工具' : undefined}
              onClick={onOpenAdvancedTools}
            >
              <ShellIcon name="advanced" />
              <span className="course-nav-label">兼容与高级工具</span>
            </button>
          ) : null}
        </div>

        <div className="course-sidebar-spacer" />

        <div className="course-sidebar-footer" aria-label="系统">
          <div
            className={`course-provider-status ${provider ?? 'unavailable'}`}
            aria-label={
              provider === 'fake'
                ? '本地模拟模式'
                : provider === 'hy3'
                  ? 'Hy3 模式'
                  : '服务状态不可用'
            }
            title={
              provider === 'fake'
                ? '本地模拟模式'
                : provider === 'hy3'
                  ? 'Hy3 模式'
                  : '服务状态不可用'
            }
          >
            <span className="course-provider-dot" aria-hidden="true" />
            <span className="course-nav-label">
              {provider === 'fake'
                ? '本地模拟模式'
                : provider === 'hy3'
                  ? 'Hy3 模式'
                  : '服务不可用'}
            </span>
          </div>
          {onOpenSettings ? (
            <button
              type="button"
              className={settingsActive ? 'active' : ''}
              aria-current={settingsActive ? 'page' : undefined}
              aria-label={visuallyCollapsed ? '设置' : undefined}
              title={visuallyCollapsed ? '设置' : undefined}
              onClick={openSettings}
            >
              <ShellIcon name="settings" />
              <span className="course-nav-label">设置</span>
            </button>
          ) : null}
          <button
            type="button"
            className="course-sidebar-collapse"
            aria-label={collapsed ? '展开课程侧边栏' : '折叠课程侧边栏'}
            title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
            onClick={() => updateCollapsed(!collapsed)}
          >
            <ShellIcon name="collapse" />
            <span className="course-nav-label">折叠侧边栏</span>
          </button>
        </div>
      </aside>

      <div className="course-workspace">
        <header className="course-workspace-header">
          <div>
            <p>{settingsActive ? 'Hy3 Study Clinic' : (courseName ?? 'Hy3 Study Clinic')}</p>
            <h2>{settingsActive || courseId ? destinationLabel : '选择课程'}</h2>
          </div>
          <span>
            {settingsActive || courseId ? destinationDescription : '选择或创建课程后开始学习'}
          </span>
        </header>
        <div
          ref={workspaceBodyRef}
          className="agent-course-content"
          aria-label={settingsActive || courseId ? destinationLabel : '选择课程'}
          tabIndex={-1}
        >
          {children}
        </div>
      </div>
    </section>
  );
}

type ShellIconName =
  | AgentCourseView
  | 'course'
  | 'materials'
  | 'settings'
  | 'advanced'
  | 'menu'
  | 'close'
  | 'collapse';

const ICON_PATHS: Record<ShellIconName, string> = {
  home: 'M3 10.5 12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H4.5A1.5 1.5 0 0 1 3 19.5z',
  session: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14H7l-3 3z',
  curriculum: 'M5 5h4v4H5zm10 0h4v4h-4zM5 15h4v4H5zm10 0h4v4h-4zM9 7h6M7 9v6m10-6v6M9 17h6',
  progress: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  explore:
    'M6 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM18 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8.2 9.2l7.6 5.6M16.5 6 8 7.5',
  course: 'M4 5.5 12 2l8 3.5v11L12 20l-8-3.5zm0 0 8 3.5 8-3.5M12 9v11',
  materials: 'M6 3h8l4 4v14H6zm8 0v5h4M9 12h6m-6 4h6',
  settings:
    'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm7.4 3.5a7.8 7.8 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a8.8 8.8 0 0 0-1.8-1l-.4-2.6h-4L10.3 6a8.8 8.8 0 0 0-1.8 1L6.1 6l-2 3.4 2 1.6a7.8 7.8 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a8.8 8.8 0 0 0 1.8 1l.4 2.6h4l.4-2.6a8.8 8.8 0 0 0 1.8-1l2.4 1 2-3.4-2-1.6a7.8 7.8 0 0 0 .1-1Z',
  advanced: 'M5 12a1.5 1.5 0 1 0 0 .01M12 12a1.5 1.5 0 1 0 0 .01M19 12a1.5 1.5 0 1 0 0 .01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'm6 6 12 12M18 6 6 18',
  collapse: 'm14 6-6 6 6 6M20 4v16',
};

function ShellIcon({ name }: { name: ShellIconName }) {
  return (
    <svg className="course-shell-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function readSidebarCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsedPreference(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
  } catch {
    // Layout preference is optional when browser storage is unavailable.
  }
}
