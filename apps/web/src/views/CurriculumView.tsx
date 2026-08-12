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

interface CurriculumTreeNode {
  node: CurriculumHierarchyNodeView;
  children: CurriculumTreeNode[];
}

function buildCurriculumTree(hierarchy: CurriculumHierarchyView): CurriculumTreeNode[] {
  const nodeById = new Map(hierarchy.nodes.map((node) => [node.id, node]));
  const emitted = new Set<string>();

  function build(nodeId: string, ancestors: ReadonlySet<string>): CurriculumTreeNode | null {
    const node = nodeById.get(nodeId);
    if (!node || emitted.has(nodeId) || ancestors.has(nodeId)) return null;
    emitted.add(nodeId);
    const nextAncestors = new Set(ancestors).add(nodeId);
    const children = node.childIds
      .map((childId) => build(childId, nextAncestors))
      .filter((child): child is CurriculumTreeNode => child !== null);
    return { node, children };
  }

  const orderedCandidates = [
    ...hierarchy.rootNodeIds,
    ...hierarchy.nodes
      .slice()
      .sort((left, right) => left.depth - right.depth || left.index - right.index)
      .map((node) => node.id),
  ];
  return orderedCandidates
    .map((nodeId) => build(nodeId, new Set()))
    .filter((node): node is CurriculumTreeNode => node !== null);
}

function CurriculumBranch({
  branches,
  nodeById,
  level = 1,
}: {
  branches: CurriculumTreeNode[];
  nodeById: ReadonlyMap<string, CurriculumHierarchyNodeView>;
  level?: number;
}) {
  return (
    <ol className="curriculum-level" aria-label={level === 1 ? '课程层级' : undefined}>
      {branches.map(({ node, children }) => {
        const objectives = node.learningUnit?.objectives ?? [];
        const prerequisiteNames = (node.learningUnit?.prerequisiteUnitIds ?? []).map(
          (unitId) => nodeById.get(unitId)?.title ?? unitId,
        );
        return (
          <li className={`curriculum-node kind-${node.kind}`} data-depth={node.depth} key={node.id}>
            <article className="curriculum-node-content">
              <header className="curriculum-node-heading">
                <div>
                  <span className="curriculum-kind">{KIND_TEXT[node.kind]}</span>
                  <h3>{node.title}</h3>
                </div>
                {node.progressState ? (
                  <span className={`curriculum-progress state-${node.progressState}`}>
                    {progressLabel(node.progressState)}
                  </span>
                ) : null}
              </header>

              {node.learningUnit ? (
                <div className="curriculum-unit-detail">
                  {node.mappedPlanItemIds.length > 0 ? (
                    <p className="curriculum-route-note">已纳入当前学习路线</p>
                  ) : null}
                  {objectives.length > 0 ? (
                    <ul className="curriculum-objectives" aria-label={`${node.title}学习目标`}>
                      {objectives.map((objective) => (
                        <li key={objective.id}>
                          <span
                            className={`objective-authority ${
                              objective.truthPremiseStatus === 'independently_verified'
                                ? 'verified'
                                : 'unverified'
                            }`}
                          >
                            {objective.truthPremiseStatus === 'independently_verified'
                              ? '事实依据已独立验证'
                              : '在学习范围内 · 事实依据未验证'}
                          </span>
                          <span>{objective.title}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <details className="small technical-details">
                    <summary>课程依据</summary>
                    <p className="muted">
                      引用概念 {node.learningUnit.conceptIds.length} 个 · 来源锚点{' '}
                      {node.sourceReferences.length} 个
                    </p>
                    {prerequisiteNames.length > 0 ? (
                      <p className="muted">先修单元：{prerequisiteNames.join('、')}</p>
                    ) : null}
                  </details>
                </div>
              ) : null}
            </article>
            {children.length > 0 ? (
              <CurriculumBranch branches={children} nodeById={nodeById} level={level + 1} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

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

  const branches = hierarchy ? buildCurriculumTree(hierarchy) : [];
  const nodeById = new Map(hierarchy?.nodes.map((node) => [node.id, node]) ?? []);
  const learningUnitCount =
    hierarchy?.nodes.filter((node) => node.kind === 'learning_unit').length ?? 0;

  return (
    <div className="curriculum-workspace stack" aria-label="课程结构">
      {error ? <Banner kind="error">{error}</Banner> : null}
      <header className="supporting-page-intro">
        <div className="row between">
          <div>
            <p className="eyebrow">课程地图</p>
            <p className="muted">
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
          <p className="curriculum-version-context small">
            <strong>版本 {hierarchy.curriculumVersion}</strong>
            <span>{CURRICULUM_STATUS_TEXT[hierarchy.status] ?? '已记录'}</span>
            <span>{learningUnitCount} 个学习单元</span>
            <span>基于精确资料版本清单</span>
          </p>
        ) : null}
      </header>

      {!hierarchy ? (
        <Banner kind="empty">确认学习约定后，可生成并审阅课程结构。</Banner>
      ) : (
        <section className="curriculum-outline-section" aria-label="课程层级视图">
          {!hierarchy.validation.valid ? (
            <Banner kind="error">该候选版本未通过本地结构校验，不能接受。</Banner>
          ) : null}
          {hierarchy.validation.warnings.map((warning) => (
            <Banner key={warning} kind="info">
              {warning}
            </Banner>
          ))}

          <CurriculumBranch branches={branches} nodeById={nodeById} />

          {hierarchy.status === 'proposed' ? (
            <div className="row curriculum-decision-bar">
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
        <details className="history-disclosure curriculum-history" aria-label="课程结构历史">
          <summary>版本历史（{history.length}）</summary>
          <ol className="curriculum-history-list">
            {[...history].reverse().map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="ghost small"
                  aria-current={item.id === hierarchy?.curriculumId ? 'true' : undefined}
                  onClick={() => onSelectHistory(item.id)}
                >
                  <strong>版本 {item.version}</strong>
                  <span>{CURRICULUM_STATUS_TEXT[item.status] ?? '已记录'}</span>
                  <span>{item.learningUnitCount} 个学习单元</span>
                </button>
              </li>
            ))}
          </ol>
        </details>
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
