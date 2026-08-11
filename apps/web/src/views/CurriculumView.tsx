import type {
  CurriculumHierarchyNodeView,
  CurriculumHierarchyView,
  CurriculumHistoryItem,
} from '@hy3-clinic/shared';
import { Banner, Loading } from '../components/ui.js';

const KIND_TEXT: Record<CurriculumHierarchyNodeView['kind'], string> = {
  course: '课程',
  chapter: '章',
  section: '节',
  learning_unit: '学习单元',
};

export interface CurriculumViewProps {
  hierarchy: CurriculumHierarchyView | null;
  history: CurriculumHistoryItem[];
  loading: boolean;
  error: string | null;
  canPropose: boolean;
  canAccept: boolean;
  busyAction: string | null;
  onPropose: () => void;
  onAccept: () => void;
  onReject: () => void;
  onSelectHistory: (curriculumId: string) => void;
}

const CURRICULUM_STATUS_TEXT: Record<string, string> = {
  candidate: '候选版本',
  proposed: '待确认',
  accepted: '已接受',
  rejected: '已拒绝',
  failed: '生成失败',
  superseded: '已由新版本替代',
};

/** Learner-visible hierarchy over existing Concepts and exact source provenance. */
export function CurriculumView({
  hierarchy,
  history,
  loading,
  error,
  canPropose,
  canAccept,
  busyAction,
  onPropose,
  onAccept,
  onReject,
  onSelectHistory,
}: CurriculumViewProps) {
  if (loading && !hierarchy) return <Loading label="加载课程结构…" />;

  return (
    <div className="stack" aria-label="课程结构">
      {error ? <Banner kind="error">{error}</Banner> : null}
      <section className="card">
        <div className="row between">
          <div>
            <h2 style={{ marginBottom: 0 }}>课程结构</h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              课程结构回答“我正在学什么，以及它们如何组织起来”。它引用现有概念与课程资料，
              不宣称材料内容已被完整覆盖。
            </p>
          </div>
          {canPropose ? (
            <button type="button" disabled={busyAction !== null} onClick={onPropose}>
              {busyAction === 'propose-curriculum'
                ? '正在生成…'
                : hierarchy
                  ? '提出新版本'
                  : '生成结构'}
            </button>
          ) : null}
        </div>

        {hierarchy ? (
          <p className="small">
            <span className="pill">版本 {hierarchy.curriculumVersion}</span>{' '}
            <span className="pill">{CURRICULUM_STATUS_TEXT[hierarchy.status] ?? '已记录'}</span>{' '}
            <span className="pill deterministic">精确资料版本清单</span>
          </p>
        ) : null}
      </section>

      {!hierarchy ? (
        <Banner kind="empty">确认学习约定后，可生成并审阅课程结构。</Banner>
      ) : (
        <section className="card" aria-label="课程层级">
          {!hierarchy.validation.valid ? (
            <Banner kind="error">该候选版本未通过本地结构校验，不能接受。</Banner>
          ) : null}
          {hierarchy.validation.warnings.map((warning) => (
            <Banner key={warning} kind="info">
              {warning}
            </Banner>
          ))}

          <ol className="curriculum-outline" style={{ listStyle: 'none', padding: 0 }}>
            {hierarchy.nodes
              .slice()
              .sort((a, b) => a.depth - b.depth || a.index - b.index || a.id.localeCompare(b.id))
              .map((node) => (
                <li
                  key={node.id}
                  className="block-preview"
                  style={{ marginLeft: `${Math.min(node.depth, 4) * 1.25}rem` }}
                >
                  <div className="row between">
                    <strong>{node.title}</strong>
                    <span className="pill">{KIND_TEXT[node.kind]}</span>
                  </div>
                  {node.learningUnit ? (
                    <div className="small">
                      {node.learningUnit.objectives.map((objective) => (
                        <p key={objective.id}>
                          <span
                            className={
                              objective.truthPremiseStatus === 'independently_verified'
                                ? 'pill deterministic'
                                : 'pill model'
                            }
                          >
                            {objective.truthPremiseStatus === 'independently_verified'
                              ? '事实依据已独立验证'
                              : '在学习范围内 · 事实依据未验证'}
                          </span>{' '}
                          {objective.title}
                        </p>
                      ))}
                      {node.progressState ? (
                        <p>
                          <span className="pill">{progressLabel(node.progressState)}</span>
                        </p>
                      ) : null}
                      <details className="small technical-details">
                        <summary>查看课程依据</summary>
                        <p className="muted">
                          引用概念 {node.learningUnit.conceptIds.length} 个 · 来源锚点{' '}
                          {node.sourceReferences.length} 个
                        </p>
                        {node.learningUnit.prerequisiteUnitIds.length > 0 ? (
                          <p className="muted">
                            先修单元 {node.learningUnit.prerequisiteUnitIds.join('、')}
                          </p>
                        ) : null}
                      </details>
                    </div>
                  ) : null}
                </li>
              ))}
          </ol>

          {hierarchy.status === 'proposed' ? (
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={!canAccept || !hierarchy.validation.valid || busyAction !== null}
                onClick={onAccept}
              >
                {busyAction === 'accept-curriculum' ? '正在接受…' : '接受课程结构'}
              </button>
              <button type="button" disabled={busyAction !== null} onClick={onReject}>
                拒绝候选版本
              </button>
            </div>
          ) : null}
        </section>
      )}

      {history.length > 0 ? (
        <section className="card" aria-label="课程结构历史">
          <h3>版本历史</h3>
          <ol>
            {history.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => onSelectHistory(item.id)}
                >
                  版本 {item.version} · {CURRICULUM_STATUS_TEXT[item.status] ?? '已记录'} ·{' '}
                  {item.learningUnitCount} 个学习单元
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function progressLabel(value: NonNullable<CurriculumHierarchyNodeView['progressState']>): string {
  const labels: Record<typeof value, string> = {
    not_started: '未开始',
    started: '学习中',
    completed: '已完成',
    repair_needed: '需要修复',
    deferred: '已延期',
    obsolete: '已失效',
  };
  return labels[value] ?? value;
}
