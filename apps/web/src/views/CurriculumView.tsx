import { useEffect, useId, useMemo, useState } from 'react';
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

const CURRICULUM_STATUS_TEXT: Record<string, string> = {
  candidate: '候选版本',
  proposed: '待确认',
  accepted: '已接受',
  rejected: '已拒绝',
  failed: '生成失败',
  superseded: '已由新版本替代',
};

const DIRECT_UNIT_PREVIEW_LIMIT = 12;

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

interface CurriculumTreeNode {
  node: CurriculumHierarchyNodeView;
  children: CurriculumTreeNode[];
}

interface CurriculumTreeResult {
  roots: CurriculumTreeNode[];
  nodeById: ReadonlyMap<string, CurriculumHierarchyNodeView>;
  issues: string[];
}

interface BranchSummary {
  chapterCount: number;
  sectionCount: number;
  learningUnitCount: number;
  objectiveCount: number;
  prerequisiteUnitIds: string[];
  sourceReferenceCount: number;
  routeLinkedCount: number;
  currentUnits: CurriculumHierarchyNodeView[];
  objectiveTitles: string[];
}

function buildCurriculumTree(hierarchy: CurriculumHierarchyView): CurriculumTreeResult {
  const nodeById = new Map<string, CurriculumHierarchyNodeView>();
  const issues: string[] = [];
  const duplicateIds = new Set<string>();

  for (const node of hierarchy.nodes) {
    if (nodeById.has(node.id)) {
      duplicateIds.add(node.id);
      continue;
    }
    nodeById.set(node.id, node);
  }
  if (duplicateIds.size > 0) {
    issues.push(
      `发现重复节点 ID：${[...duplicateIds].join('、')}。页面仅显示每个 ID 的第一条记录。`,
    );
  }

  const childrenById = new Map<string, string[]>();
  const missingChildIds = new Set<string>();
  for (const node of nodeById.values()) {
    const childIds: string[] = [];
    for (const childId of node.childIds) {
      if (!nodeById.has(childId)) {
        missingChildIds.add(childId);
      } else if (!childIds.includes(childId)) {
        childIds.push(childId);
      }
    }
    childrenById.set(node.id, childIds);
  }
  if (missingChildIds.size > 0) {
    issues.push(`部分子节点不存在：${[...missingChildIds].join('、')}。`);
  }

  const missingParentIds = new Set<string>();
  for (const node of nodeById.values()) {
    if (node.parentId === null) continue;
    if (!nodeById.has(node.parentId)) {
      missingParentIds.add(node.parentId);
      continue;
    }
    const siblings = childrenById.get(node.parentId)!;
    if (!siblings.includes(node.id)) siblings.push(node.id);
  }
  if (missingParentIds.size > 0) {
    issues.push(
      `部分父节点不存在：${[...missingParentIds].join('、')}。页面已保留仍可恢复的内容。`,
    );
  }

  const emitted = new Set<string>();
  const cyclicIds = new Set<string>();
  const repeatedLinks = new Set<string>();

  function build(nodeId: string, ancestors: ReadonlySet<string>): CurriculumTreeNode | null {
    const node = nodeById.get(nodeId);
    if (!node) return null;
    if (ancestors.has(nodeId)) {
      cyclicIds.add(nodeId);
      return null;
    }
    if (emitted.has(nodeId)) {
      repeatedLinks.add(nodeId);
      return null;
    }
    emitted.add(nodeId);
    const nextAncestors = new Set(ancestors).add(nodeId);
    const children = (childrenById.get(nodeId) ?? [])
      .map((childId) => build(childId, nextAncestors))
      .filter((child): child is CurriculumTreeNode => child !== null);
    return { node, children };
  }

  const rootCandidates = [
    ...hierarchy.rootNodeIds,
    ...[...nodeById.values()].filter((node) => node.parentId === null).map((node) => node.id),
    ...[...nodeById.values()]
      .filter((node) => node.parentId !== null && !nodeById.has(node.parentId))
      .map((node) => node.id),
  ];
  const roots = rootCandidates
    .filter((nodeId, index) => rootCandidates.indexOf(nodeId) === index)
    .map((nodeId) => build(nodeId, new Set()))
    .filter((node): node is CurriculumTreeNode => node !== null);

  for (const node of [...nodeById.values()].sort(
    (left, right) => left.depth - right.depth || left.index - right.index,
  )) {
    if (emitted.has(node.id)) continue;
    const recovered = build(node.id, new Set());
    if (recovered) roots.push(recovered);
  }

  if (cyclicIds.size > 0) {
    issues.push(`发现循环层级：${[...cyclicIds].join('、')}。循环链接已在显示时截断。`);
  }
  if (repeatedLinks.size > 0) {
    issues.push(`部分节点被多处引用：${[...repeatedLinks].join('、')}。页面仅在首次出现处显示。`);
  }
  return { roots, nodeById, issues };
}

function collectBranch(branch: CurriculumTreeNode): CurriculumTreeNode[] {
  return [branch, ...branch.children.flatMap(collectBranch)];
}

function summarizeBranch(branch: CurriculumTreeNode): BranchSummary {
  const entries = collectBranch(branch);
  const prerequisiteUnitIds = new Set<string>();
  const currentUnits: CurriculumHierarchyNodeView[] = [];
  const objectiveTitles: string[] = [];
  let chapterCount = 0;
  let sectionCount = 0;
  let learningUnitCount = 0;
  let objectiveCount = 0;
  let sourceReferenceCount = 0;
  let routeLinkedCount = 0;

  for (const { node } of entries) {
    if (node.kind === 'chapter') chapterCount += 1;
    if (node.kind === 'section') sectionCount += 1;
    if (node.kind === 'learning_unit') learningUnitCount += 1;
    if (node.progressState === 'started') currentUnits.push(node);
    if (node.mappedPlanItemIds.length > 0) routeLinkedCount += 1;
    sourceReferenceCount += node.sourceReferences.length;
    for (const prerequisiteId of node.learningUnit?.prerequisiteUnitIds ?? []) {
      prerequisiteUnitIds.add(prerequisiteId);
    }
    for (const objective of node.learningUnit?.objectives ?? []) {
      objectiveCount += 1;
      objectiveTitles.push(objective.title);
    }
  }

  return {
    chapterCount,
    sectionCount,
    learningUnitCount,
    objectiveCount,
    prerequisiteUnitIds: [...prerequisiteUnitIds],
    sourceReferenceCount,
    routeLinkedCount,
    currentUnits,
    objectiveTitles,
  };
}

function majorBranches(roots: CurriculumTreeNode[]): CurriculumTreeNode[] {
  return roots.flatMap((root) => {
    if (
      root.node.kind === 'course' &&
      root.children.length > 0 &&
      root.children.every((child) => child.node.kind !== 'learning_unit')
    ) {
      return root.children;
    }
    return [root];
  });
}

function CurriculumNodeDetail({
  node,
  nodeById,
}: {
  node: CurriculumHierarchyNodeView;
  nodeById: ReadonlyMap<string, CurriculumHierarchyNodeView>;
}) {
  if (!node.learningUnit) return null;
  const prerequisiteNames = node.learningUnit.prerequisiteUnitIds.map(
    (unitId) => nodeById.get(unitId)?.title ?? unitId,
  );

  return (
    <div className="curriculum-unit-detail">
      <section className="curriculum-objective-section" aria-label={`${node.title}学习目标`}>
        <h4>学习目标</h4>
        <ul className="curriculum-objectives">
          {node.learningUnit.objectives.map((objective) => (
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
              <strong>{objective.title}</strong>
              <span className="muted">{objective.description}</span>
            </li>
          ))}
        </ul>
      </section>

      {prerequisiteNames.length > 0 ? (
        <section className="curriculum-prerequisites" aria-label={`${node.title}先修要求`}>
          <h4>先修</h4>
          <p>{prerequisiteNames.join('、')}</p>
        </section>
      ) : null}

      <details className="curriculum-evidence-disclosure small technical-details">
        <summary>课程依据（{node.sourceReferences.length}）</summary>
        <p className="muted">
          来源锚点用于回到课程资料。引文逐字匹配只证明文本出现在标注位置，不单独证明完整语义蕴含。
        </p>
        <dl className="curriculum-evidence-meta">
          <div>
            <dt>引用概念</dt>
            <dd>{node.learningUnit.conceptIds.length} 个</dd>
          </div>
          <div>
            <dt>图关系</dt>
            <dd>{node.learningUnit.graphRelationIds.length} 个</dd>
          </div>
        </dl>
        {node.sourceReferences.length > 0 ? (
          <ol className="curriculum-source-reference-list">
            {node.sourceReferences.map((reference, index) => (
              <li
                key={`${reference.materialId}:${reference.materialRevisionId}:${reference.sourceBlockId ?? index}`}
              >
                <strong>来源锚点 {index + 1}</strong>
                <span>资料 {reference.materialId}</span>
                <span>处理版本 {reference.materialRevisionId}</span>
                {reference.structuralUnitId ? (
                  <span>结构位置 {reference.structuralUnitId}</span>
                ) : null}
                {reference.sourceBlockId ? <span>来源块 {reference.sourceBlockId}</span> : null}
                {reference.sourceBlockRevisionFingerprint ? (
                  <span>来源块修订 {reference.sourceBlockRevisionFingerprint}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">这个单元没有记录来源锚点。</p>
        )}
      </details>
    </div>
  );
}

function CurriculumOutlineNode({
  branch,
  nodeById,
  expandedIds,
  onToggle,
  idPrefix,
  level,
  prominent = false,
}: {
  branch: CurriculumTreeNode;
  nodeById: ReadonlyMap<string, CurriculumHierarchyNodeView>;
  expandedIds: ReadonlySet<string>;
  onToggle: (nodeId: string) => void;
  idPrefix: string;
  level: number;
  prominent?: boolean;
}) {
  const { node, children } = branch;
  const summary = useMemo(() => summarizeBranch(branch), [branch]);
  const isExpanded = expandedIds.has(node.id);
  const isCurrent = node.progressState === 'started';
  const containsCurrent = summary.currentUnits.length > 0;
  const isRouteLinked = node.mappedPlanItemIds.length > 0;
  const contentId = `${idPrefix}-node-${encodeURIComponent(node.id)}`;
  const directUnitsOnly =
    children.length > 0 && children.every(({ node: child }) => child.kind === 'learning_unit');
  const showAllDirectUnits = expandedIds.has(`${node.id}:all-units`);
  const visibleChildren =
    directUnitsOnly && children.length > DIRECT_UNIT_PREVIEW_LIMIT && !showAllDirectUnits
      ? children.slice(0, DIRECT_UNIT_PREVIEW_LIMIT)
      : children;
  const Heading = prominent ? 'h3' : level <= 2 ? 'h4' : 'h5';

  return (
    <li
      className={`curriculum-node kind-${node.kind}${prominent ? ' is-major' : ''}${
        isCurrent || containsCurrent ? ' is-current' : ''
      }`}
      data-depth={node.depth}
    >
      <article className="curriculum-node-content" aria-current={isCurrent ? 'step' : undefined}>
        <header className="curriculum-node-heading">
          <div className="curriculum-node-title">
            <span className="curriculum-kind">{KIND_TEXT[node.kind]}</span>
            <Heading>{node.title}</Heading>
          </div>
          <div className="curriculum-node-state">
            {containsCurrent && !isCurrent ? (
              <span className="curriculum-current-note">包含当前学习位置</span>
            ) : null}
            {isRouteLinked ? (
              <span className="curriculum-route-note">已纳入当前学习路线</span>
            ) : null}
            {node.progressState ? (
              <span className={`curriculum-progress state-${node.progressState}`}>
                {progressLabel(node.progressState)}
              </span>
            ) : null}
          </div>
        </header>

        {prominent ? (
          <div className="curriculum-major-summary">
            <p className="curriculum-major-counts">
              {summary.learningUnitCount} 个学习单元 · {summary.objectiveCount} 个学习目标
              {summary.prerequisiteUnitIds.length > 0
                ? ` · ${summary.prerequisiteUnitIds.length} 项先修关系`
                : ''}
            </p>
            {summary.objectiveTitles.length > 0 ? (
              <p className="curriculum-major-focus">
                <span>学习重点</span>
                {summary.objectiveTitles.slice(0, 3).join('、')}
              </p>
            ) : (
              <p className="muted">这一部分未记录学习目标。</p>
            )}
          </div>
        ) : null}

        {children.length > 0 ? (
          <button
            type="button"
            className="curriculum-expand-button ghost small"
            aria-expanded={isExpanded}
            aria-controls={contentId}
            onClick={() => onToggle(node.id)}
          >
            {isExpanded ? '收起内容' : `查看内容（${summary.learningUnitCount} 个单元）`}
          </button>
        ) : (
          <CurriculumNodeDetail node={node} nodeById={nodeById} />
        )}
      </article>

      {children.length > 0 && isExpanded ? (
        <div className="curriculum-node-children" id={contentId}>
          {node.learningUnit ? <CurriculumNodeDetail node={node} nodeById={nodeById} /> : null}
          <ol className="curriculum-level" id={`${contentId}-units`}>
            {visibleChildren.map((child) => (
              <CurriculumOutlineNode
                key={child.node.id}
                branch={child}
                nodeById={nodeById}
                expandedIds={expandedIds}
                onToggle={onToggle}
                idPrefix={idPrefix}
                level={level + 1}
              />
            ))}
          </ol>
          {directUnitsOnly && children.length > DIRECT_UNIT_PREVIEW_LIMIT ? (
            <button
              type="button"
              className="curriculum-show-all-units ghost small"
              aria-expanded={showAllDirectUnits}
              aria-controls={`${contentId}-units`}
              onClick={() => onToggle(`${node.id}:all-units`)}
            >
              {showAllDirectUnits
                ? `只显示前 ${DIRECT_UNIT_PREVIEW_LIMIT} 个学习单元`
                : `显示其余 ${children.length - visibleChildren.length} 个学习单元`}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function CurriculumManifest({ hierarchy }: { hierarchy: CurriculumHierarchyView }) {
  const sourceBlockRevisionCount = hierarchy.executionSourceManifest.revisions.reduce(
    (count, revision) => count + revision.sourceBlockRevisionIds.length,
    0,
  );

  return (
    <details className="curriculum-course-basis technical-details" aria-label="课程依据与精确版本">
      <summary>课程依据与精确版本</summary>
      <div className="curriculum-course-basis-content">
        <p>
          本结构记录了 {hierarchy.executionSourceManifest.revisions.length} 个资料处理版本和{' '}
          {sourceBlockRevisionCount} 个来源块修订。
        </p>
        <p className="muted">
          精确版本清单固定了生成时使用的资料。引文逐字匹配证明引文存在于标注位置，
          不单独证明完整语义蕴含。
        </p>
        <dl className="curriculum-manifest-summary small">
          <div>
            <dt>清单指纹</dt>
            <dd>{hierarchy.executionSourceManifest.fingerprint}</dd>
          </div>
        </dl>
        <ol className="curriculum-manifest-list">
          {hierarchy.executionSourceManifest.revisions.map((revision, index) => (
            <li key={`${revision.materialId}:${revision.materialRevisionId}`}>
              <h4>资料版本 {index + 1}</h4>
              <dl>
                <div>
                  <dt>资料 ID</dt>
                  <dd>{revision.materialId}</dd>
                </div>
                <div>
                  <dt>处理版本 ID</dt>
                  <dd>{revision.materialRevisionId}</dd>
                </div>
                <div>
                  <dt>解析器</dt>
                  <dd>{revision.parserVersion ?? '未记录'}</dd>
                </div>
                <div>
                  <dt>解析指纹</dt>
                  <dd>{revision.parserFingerprint ?? '未记录'}</dd>
                </div>
                <div>
                  <dt>来源块修订 ID</dt>
                  <dd>
                    {revision.sourceBlockRevisionIds.length > 0
                      ? revision.sourceBlockRevisionIds.join('、')
                      : '无'}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      </div>
    </details>
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
  const idPrefix = useId().replace(/:/g, '');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => (hierarchy ? buildCurriculumTree(hierarchy) : null), [hierarchy]);
  const majors = useMemo(() => majorBranches(tree?.roots ?? []), [tree]);
  const allNodes = tree ? [...tree.nodeById.values()] : [];
  const learningUnitCount = allNodes.filter((node) => node.kind === 'learning_unit').length;
  const chapterCount = allNodes.filter((node) => node.kind === 'chapter').length;
  const sectionCount = allNodes.filter((node) => node.kind === 'section').length;
  const objectiveCount = allNodes.reduce(
    (count, node) => count + (node.learningUnit?.objectives.length ?? 0),
    0,
  );
  const currentUnits = allNodes.filter((node) => node.progressState === 'started');
  const acceptedVersion =
    hierarchy?.status === 'accepted'
      ? hierarchy.curriculumVersion
      : history
          .filter((item) => item.status === 'accepted')
          .sort((left, right) => right.version - left.version)[0]?.version;

  useEffect(() => {
    setExpandedIds(new Set());
  }, [hierarchy?.curriculumId, hierarchy?.curriculumVersion]);

  function toggle(nodeId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  return (
    <div className="curriculum-workspace stack" aria-label="课程结构" aria-busy={loading}>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <header className="supporting-page-intro curriculum-page-intro">
        <div className="row between">
          <div className="curriculum-page-heading">
            <p className="eyebrow">课程地图</p>
            <h2>课程结构</h2>
            <p className="muted">先看课程的主要部分，再按需展开学习目标、先修关系与课程依据。</p>
          </div>
          {canPropose ? (
            <button type="button" disabled={loading || busyAction !== null} onClick={onPropose}>
              {busyAction === 'propose-curriculum'
                ? '正在生成…'
                : hierarchy
                  ? '提出新版本'
                  : '生成结构'}
            </button>
          ) : null}
        </div>

        {hierarchy ? (
          <div className="curriculum-version-overview" aria-label="课程结构版本概览">
            <div className="curriculum-version-identity">
              <span className="curriculum-status-dot" aria-hidden="true" />
              <strong>版本 {hierarchy.curriculumVersion}</strong>
              <span>{CURRICULUM_STATUS_TEXT[hierarchy.status] ?? '已记录'}</span>
              <span>
                {acceptedVersion ? `当前已接受版本 ${acceptedVersion}` : '未提供已接受版本记录'}
              </span>
            </div>
            <dl className="curriculum-counts">
              <div>
                <dt>主要部分</dt>
                <dd>{majors.length}</dd>
              </div>
              <div>
                <dt>章 / 节</dt>
                <dd>
                  {chapterCount} / {sectionCount}
                </dd>
              </div>
              <div>
                <dt>学习单元</dt>
                <dd>{learningUnitCount}</dd>
              </div>
              <div>
                <dt>学习目标</dt>
                <dd>{objectiveCount}</dd>
              </div>
            </dl>
            {currentUnits.length > 0 ? (
              <div className="curriculum-current-location" aria-label="当前学习位置">
                <span>正在学习</span>
                <strong>{currentUnits.map((node) => node.title).join('、')}</strong>
              </div>
            ) : (
              <p className="curriculum-current-location is-unavailable">
                还没有可显示的当前学习位置。
              </p>
            )}
          </div>
        ) : null}
      </header>

      {loading && !hierarchy ? (
        <section
          className="curriculum-state curriculum-loading-state"
          aria-label="正在加载课程结构"
        >
          <Loading label="加载课程结构…" />
        </section>
      ) : !hierarchy ? (
        <section
          className="curriculum-state curriculum-empty-state"
          aria-labelledby="curriculum-empty-title"
        >
          <p className="eyebrow">尚未生成</p>
          <h2 id="curriculum-empty-title">还没有课程结构</h2>
          <p className="muted">确认学习约定后，可让 Hy3 提出一份有资料依据的课程结构供你审阅。</p>
        </section>
      ) : (
        <>
          <section
            className="curriculum-outline-section"
            aria-labelledby="curriculum-outline-title"
          >
            <header className="curriculum-section-heading">
              <div>
                <p className="eyebrow">主要结构</p>
                <h3 id="curriculum-outline-title">课程由 {majors.length} 个主要部分组成</h3>
              </div>
              <p className="muted">展开一个部分，查看其中的章节、单元与目标。</p>
            </header>

            {!hierarchy.validation.valid ? (
              <Banner kind="error">该候选版本未通过本地结构校验，不能接受。</Banner>
            ) : null}
            {hierarchy.validation.warnings.map((warning) => (
              <Banner key={warning} kind="info">
                {warning}
              </Banner>
            ))}
            {tree?.issues.map((issue) => (
              <Banner key={issue} kind="info">
                {issue}
              </Banner>
            ))}

            <ol className="curriculum-level curriculum-major-list" aria-label="课程层级">
              {majors.map((branch) => (
                <CurriculumOutlineNode
                  key={branch.node.id}
                  branch={branch}
                  nodeById={tree?.nodeById ?? new Map()}
                  expandedIds={expandedIds}
                  onToggle={toggle}
                  idPrefix={idPrefix}
                  level={1}
                  prominent
                />
              ))}
            </ol>

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

          <CurriculumManifest hierarchy={hierarchy} />
        </>
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
