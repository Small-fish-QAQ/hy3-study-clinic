import { useEffect, useState } from 'react';
import { api, type MasteryResponse } from '../api.js';
import { Banner, Loading, MasteryMeter } from '../components/ui.js';

export interface MasteryViewProps {
  materialId: string;
  refreshKey: number;
}

/** 掌握度总览视图(Flow B 收尾):每个概念的确定性掌握度。 */
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

  if (loading) return <Loading label="加载掌握度…" />;
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data || data.mastery.length === 0) {
    return (
      <Banner kind="empty">
        还没有掌握度数据。完成一次测验判分后,系统会按确定性公式更新每个概念的掌握度。
      </Banner>
    );
  }

  return (
    <section className="card">
      <h2>掌握度总览</h2>
      <p className="muted small">
        掌握度按确定性公式更新:m' = clamp01(m + 0.3 ×(得分 − m)),初始 0.5,与模型判断分离。
      </p>
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
                {state.lastScore !== null
                  ? ` · 最近得分 ${Math.round(state.lastScore * 100)}%`
                  : ''}
              </div>
            </div>
            <MasteryMeter value={state.mastery} />
          </div>
        ))}
      </div>
    </section>
  );
}
