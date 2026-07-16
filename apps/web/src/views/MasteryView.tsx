import { useEffect, useState } from 'react';
import { api, type MasteryResponse } from '../api.js';
import { Banner, Loading, MasteryMeter } from '../components/ui.js';

export interface MasteryViewProps {
  materialId: string;
  refreshKey: number;
}

function masteryStatus(value: number): string {
  const percentage = Math.round(value * 100);
  if (percentage <= 59) return '待巩固';
  if (percentage <= 79) return '基本掌握';
  if (percentage <= 89) return '掌握良好';
  return '稳固掌握';
}

/** 综合掌握度视图(Flow B 收尾):每个概念的确定性历史加权掌握度。 */
export function MasteryView({ materialId, refreshKey }: MasteryViewProps) {
  const [data, setData] = useState<MasteryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .mastery(materialId)
      .then((res) => {
        if (alive) setData(res);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [materialId, refreshKey]);

  if (loading) return <Loading label="加载综合掌握度…" />;
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data || data.mastery.length === 0) {
    return (
      <Banner kind="empty">
        还没有综合掌握度数据。完成一次测验判分后,系统会按确定性公式更新每个概念的历史加权掌握度。
      </Banner>
    );
  }

  return (
    <section className="card">
      <h2>综合掌握度（历史加权）</h2>
      <p className="muted small">
        最近得分反映最近一次表现；综合掌握度会结合历次作答逐步更新，单次满分不会立即代表完全掌握。
      </p>
      <details>
        <summary className="small">查看计算方式</summary>
        <p className="muted small">
          综合掌握度按确定性公式更新:m' = clamp01(m + 0.3 ×(得分 − m)),初始 0.5,与模型判断分离。
        </p>
      </details>
      <div className="stack">
        {data.mastery.map((state) => (
          <div
            key={state.conceptId}
            className="row between block-preview"
            style={{ marginBottom: 0 }}
          >
            <div>
              <strong>{state.conceptName}</strong>
              <div className="muted small">
                作答 {state.attempts} 次 · 达标 {state.correctCount} 次
              </div>
              <div className="row" style={{ marginTop: '0.35rem' }}>
                <span className="pill">
                  最近得分{' '}
                  {state.lastScore === null ? '暂无' : `${Math.round(state.lastScore * 100)}%`}
                </span>
              </div>
            </div>
            <div className="stack" style={{ gap: '0.35rem', alignItems: 'flex-end' }}>
              <div className="row">
                <span className="muted small">综合掌握度（历史加权）</span>
                <span className="pill">{masteryStatus(state.mastery)}</span>
              </div>
              <MasteryMeter value={state.mastery} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
