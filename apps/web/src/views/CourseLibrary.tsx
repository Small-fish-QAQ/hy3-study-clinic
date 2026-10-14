import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSummary } from '../clinicApi.js';
const date = (value?: string) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
      }).format(new Date(value))
    : null;
const STATUS: Record<string, string> = {
  accepted: '已确认',
  draft: '待确认',
  superseded: '已有规划',
  materials_ready: '待准备',
  empty: '待导入资料',
};
export function CourseLibrary({
  courses,
  busy,
  onOpen,
  onDelete,
}: {
  courses: WorkspaceSummary[];
  busy: boolean;
  onOpen: (id: string) => void;
  onDelete: (ids: string[]) => Promise<boolean>;
}) {
  const [managing, setManaging] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [confirm, setConfirm] = useState(false);
  const dialog = useRef<HTMLDivElement>(null),
    cancel = useRef<HTMLButtonElement>(null),
    opener = useRef<HTMLButtonElement>(null);
  const chosen = courses.filter((c) => selected.includes(c.id));
  useEffect(() => {
    if (!confirm) return;
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        setConfirm(false);
        opener.current?.focus();
      }
      if (event.key === 'Tab') {
        const elements = [
          ...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
        ];
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, busy]);
  return (
    <section className="course-library">
      <div className="course-library-heading">
        <h3>我的课程</h3>
        <div className="clinic-button-row">
          <span>{courses.length} 门课程</span>
          <button
            disabled={busy}
            onClick={() => {
              setManaging(!managing);
              setSelected([]);
            }}
          >
            {managing ? '结束管理' : '管理课程'}
          </button>
        </div>
      </div>
      {managing && (
        <div className="course-library-toolbar">
          <span>已选择 {chosen.length} 门课程</span>
          <button
            ref={opener}
            disabled={busy || !chosen.length}
            className="danger"
            onClick={() => setConfirm(true)}
          >
            删除所选课程
          </button>
        </div>
      )}
      <div className="course-library-grid">
        {courses.map((course, i) => (
          <article
            className={`course-library-card ${selected.includes(course.id) ? 'is-selected' : ''}`}
            key={course.id}
          >
            <div className="course-library-card-top">
              <span className="course-library-number">{String(i + 1).padStart(2, '0')}</span>
              {managing ? (
                <label className="course-select">
                  <input
                    type="checkbox"
                    aria-label={`选择课程 ${String(i + 1).padStart(2, '0')} ${course.title}`}
                    checked={selected.includes(course.id)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected((prior) =>
                        event.target.checked
                          ? [...prior, course.id]
                          : prior.filter((id) => id !== course.id),
                      )
                    }
                  />
                  选择
                </label>
              ) : (
                course.summary && (
                  <span className="pill">
                    {course.summary.activeOperations
                      ? '准备中'
                      : (STATUS[course.summary.status] ?? '已有课程')}
                  </span>
                )
              )}
            </div>
            <strong>{course.title}</strong>
            {course.createdAt && <small className="muted">创建于 {date(course.createdAt)}</small>}
            {course.summary && (
              <>
                <p className="course-library-progress">
                  {course.summary.lessonCount
                    ? `${course.summary.completedLessons} / ${course.summary.lessonCount} 课已完成`
                    : `${course.summary.materialCount} 份课程资料`}
                </p>
                <p
                  className="course-library-source"
                  title={course.summary.materialTitles.join('、')}
                >
                  {course.summary.materialTitles.join('、') || '带上第一份讲义，开始准备课程'}
                </p>
                <small className="muted">最近活动 {date(course.summary.lastActivityAt)}</small>
              </>
            )}
            {!managing && (
              <button
                className="course-library-open"
                disabled={busy}
                onClick={() => onOpen(course.id)}
              >
                进入课程
                <img src="/icons/tabler/arrow-right.svg" width="18" height="18" alt="" />
              </button>
            )}
          </article>
        ))}
      </div>
      {!courses.length && <p className="muted">从第一份讲义开始，建立属于你的学习路线。</p>}
      {confirm && (
        <div className="clinic-dialog-backdrop">
          <div
            ref={dialog}
            className="clinic-delete-dialog card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-courses-title"
            aria-describedby="delete-courses-description"
          >
            <h2 id="delete-courses-title">删除这 {chosen.length} 门课程？</h2>
            <p id="delete-courses-description">
              所选课程的资料、课堂、学习记录、正式成绩和 Evidence
              将一起永久删除。未选课程保留。正在运行的操作会取消。
            </p>
            <ul>
              {chosen.map((c) => (
                <li key={c.id}>
                  {c.title}
                  {c.createdAt && <small> · {date(c.createdAt)} 创建</small>}
                </li>
              ))}
            </ul>
            <div className="clinic-button-row">
              <button
                ref={cancel}
                disabled={busy}
                onClick={() => {
                  setConfirm(false);
                  opener.current?.focus();
                }}
              >
                取消
              </button>
              <button
                className="danger"
                disabled={busy || !chosen.length}
                onClick={() => {
                  void onDelete(chosen.map((c) => c.id)).then((deleted) => {
                    if (deleted) {
                      setConfirm(false);
                      setSelected([]);
                    }
                  });
                }}
              >
                {busy ? '正在删除…' : '确认永久删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
