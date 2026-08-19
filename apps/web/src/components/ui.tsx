import type { ReactNode } from 'react';

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
