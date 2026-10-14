import { useRef, type ReactNode } from 'react';
export type LearningCenterTab = 'progress' | 'records' | 'materials';
const TABS: { id: LearningCenterTab; label: string }[] = [
  { id: 'progress', label: '学习与复习' },
  { id: 'records', label: '学习记录' },
  { id: 'materials', label: '课程资料' },
];
export function LearningCenter({
  active,
  onChange,
  children,
}: {
  active: LearningCenterTab;
  onChange: (tab: LearningCenterTab) => void;
  children: ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <section className="clinic-learning-center" aria-label="学习中心">
      <nav className="clinic-center-tabs" role="tablist" aria-label="学习中心模块">
        {TABS.map((tab, i) => (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[i] = node;
            }}
            role="tab"
            id={`center-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls="center-panel"
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (i + 1) % 3
                  : event.key === 'ArrowLeft'
                    ? (i + 2) % 3
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? 2
                        : null;
              if (next !== null) {
                event.preventDefault();
                onChange(TABS[next]!.id);
                refs.current[next]?.focus();
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div id="center-panel" role="tabpanel" aria-labelledby={`center-tab-${active}`} tabIndex={0}>
        {children}
      </div>
    </section>
  );
}
