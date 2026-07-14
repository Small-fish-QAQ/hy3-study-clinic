import type { ReactNode } from 'react';

export function Banner({
  kind,
  children,
}: {
  kind: 'error' | 'info' | 'empty';
  children: ReactNode;
}) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Loading({ label }: { label: string }) {
  return (
    <span className="muted">
      <span className="spinner" /> {label}
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
    <div className="meter-wrap" style={{ minWidth: 120 }}>
      <div className={`meter ${level}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="small muted">{pct}%</span>
    </div>
  );
}
