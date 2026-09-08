import type { ReactNode } from 'react';

/** Small viewport controls, using the same strokes as Course navigation. */
export function ViewportIcon({ name }: { name: 'fit' | 'reset' | 'focus' }) {
  const paths = {
    fit: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    reset: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
    focus: 'M12 3v3m0 12v3M3 12h3m12 0h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  };
  return (
    <svg className="course-shell-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

/**
 * Human label for a block's page provenance: `第 3 页`, or `第 3–5 页` when a
 * block spans pages (layout-aware PDF ingestion can join a paragraph across
 * a page break). Null when the source is not paginated.
 */
export function formatPageRange(pageNumber: number | null, pageEnd: number | null): string | null {
  if (pageNumber === null) return null;
  if (pageEnd !== null && pageEnd > pageNumber) return `第 ${pageNumber}–${pageEnd} 页`;
  return `第 ${pageNumber} 页`;
}

/** Human label for a block's 1-based presentation slide provenance. */
export function formatSlideNumber(slideNumber: number | null | undefined): string | null {
  return slideNumber == null ? null : `第 ${slideNumber} 张幻灯片`;
}

export function Banner({
  kind,
  children,
}: {
  kind: 'error' | 'info' | 'empty';
  children: ReactNode;
}) {
  return (
    <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <span className="muted" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </span>
  );
}

export function GradedByPill({
  gradedBy,
}: {
  gradedBy: 'deterministic' | 'model' | 'model_fallback';
}) {
  if (gradedBy === 'deterministic') {
    return <span className="pill deterministic">确定性判分</span>;
  }
  return <span className="pill model">模型评分</span>;
}

export function MasteryMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const level = value < 0.4 ? 'low' : value < 0.7 ? 'mid' : 'high';
  return (
    <div
      className="meter-wrap"
      style={{ minWidth: 120 }}
      role="progressbar"
      aria-label="掌握度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`掌握度 ${pct}%`}
    >
      <div className={`meter ${level}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="small muted">{pct}%</span>
    </div>
  );
}
