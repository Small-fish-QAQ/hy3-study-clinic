import type {
  KnowledgeMapEdge,
  KnowledgeMapMode,
  KnowledgeMapNode,
  KnowledgeMapPrimaryState,
  KnowledgeMapProjection,
  KnowledgeMapWeaknessSignalKind,
} from '@hy3-clinic/shared';

export interface KnowledgeMapModePresentation {
  mode: KnowledgeMapMode;
  label: string;
  question: string;
  summary: string;
}

export const KNOWLEDGE_MAP_MODES: KnowledgeMapModePresentation[] = [
  {
    mode: 'knowledge_structure',
    label: '知识结构',
    question: '这门课程包含什么，彼此如何连接？',
    summary: '查看课程区域、主题、先修关系与有意义的综合任务。',
  },
  {
    mode: 'learning_progress',
    label: '学习进展',
    question: '我学到了什么，还有哪些内容需要验证？',
    summary: '区分讲过、等待正式验证、有证据支持与需要修复。',
  },
  {
    mode: 'learning_route',
    label: '学习路线',
    question: '我在哪里，下一步是什么，为什么？',
    summary: '突出已完成、当前、下一步和先修锁定，不改变已接受路线。',
  },
  {
    mode: 'weakness_map',
    label: '关注地图',
    question: '哪里需要关注，属于哪一种问题？',
    summary: '分别显示正式失败、修复、到期复习、回忆关注与提示性可能缺口。',
  },
];

export const PRIMARY_STATE_LABELS: Record<KnowledgeMapPrimaryState, string> = {
  not_started: '未开始',
  planned: '已纳入路线',
  currently_learning: '正在学习',
  taught: '已讲授',
  awaiting_formal_validation: '等待正式验证',
  evidence_backed: '有正式证据支持',
  mastered: '已稳固掌握',
  developing: '正在发展',
  repair: '修复进行中',
  weak: '当前薄弱',
  unknown: '状态待确认',
};

export const ROUTE_POSITION_LABELS: Record<KnowledgeMapNode['route']['position'], string> = {
  outside_route: '路线之外',
  planned: '路线中',
  current: '当前位置',
  completed: '已完成路线',
  next: '下一步',
  deferred: '已延期',
  locked: '先修未完成',
  unknown: '路线待确认',
};

export const WEAKNESS_PRESENTATION: Record<
  KnowledgeMapWeaknessSignalKind,
  { label: string; detail: string; tone: string }
> = {
  formal_failure: {
    label: '正式检验未通过',
    detail: '当前正式证据没有支持该学习单元。',
    tone: 'formal-failure',
  },
  progression_repair_needed: {
    label: '正式进展需修复',
    detail: '本地正式进展核对要求先完成修复。',
    tone: 'formal-failure',
  },
  open_mistake: {
    label: '仍有未解决错题',
    detail: '当前概念还有未关闭的错误记录。',
    tone: 'weak',
  },
  active_repair: {
    label: '修复进行中',
    detail: '当前修复优先于其他状态显示。',
    tone: 'repair',
  },
  review_due: {
    label: '复习到期',
    detail: '这是复习安排，不等于掌握失败。',
    tone: 'review-due',
  },
  retrievability_concern: {
    label: '回忆稳定性需关注',
    detail: '最近的正式回忆表现提示需要继续巩固。',
    tone: 'retrievability',
  },
  legacy_mastery_weak: {
    label: '当前薄弱',
    detail: '当前概念掌握记录显示仍需加强。',
    tone: 'weak',
  },
  mastery_red_team_possible_gap: {
    label: '可能缺口（提示）',
    detail: '这是可靠性检查给出的提示，不是正式失败，也不会直接改变学习状态。',
    tone: 'advisory',
  },
};

export const STATE_REASON_LABELS: Record<
  KnowledgeMapNode['learner']['reasonCodes'][number],
  string
> = {
  route_unavailable: '当前课程路线暂时无法对应，因此暂不显示学习状态。',
  accepted_plan_membership: '已包含在当前接受的学习路线中。',
  current_agenda_item: '是本次学习安排的当前项目。',
  active_study_session: '当前学习会话正在处理此内容。',
  lesson_started: '本学习单元已经开始讲解。',
  lesson_presentation_completed: '讲解已经完成，但这不等于正式掌握。',
  formal_validation_pending: '讲解已完成，仍等待正式验证。',
  current_supported_evidence: '当前正式证据支持该状态。',
  current_formal_failure: '当前正式证据没有达到要求。',
  current_progression_complete: '本地正式进展核对已确认完成。',
  current_progression_repair_needed: '本地正式进展核对要求修复。',
  active_repair: '当前存在进行中的修复。',
  legacy_mastery_stable: '当前概念掌握记录较稳定。',
  legacy_mastery_developing: '当前概念掌握记录仍在发展。',
  legacy_mastery_weak: '当前概念掌握记录显示薄弱。',
  no_current_learning_activity: '还没有当前学习活动。',
};

export const EDGE_KIND_LABELS: Record<KnowledgeMapEdge['kind'], string> = {
  prerequisite: '先修于',
  part_of: '属于',
  contrasts_with: '对比',
  example_of: '是例子',
  applies_to: '应用于',
  causes: '导致',
  curriculum_prerequisite: '课程先修',
  unit_contains_concept: '包含概念',
  synthesis_includes_unit: '综合任务包含',
  curriculum_contains: '课程包含',
};

export const NODE_KIND_LABELS: Record<KnowledgeMapNode['kind'], string> = {
  curriculum_region: '课程区域',
  concept: '概念',
  learning_unit: '学习单元',
  synthesis: '综合结构',
};

export function modePresentation(mode: KnowledgeMapMode): KnowledgeMapModePresentation {
  return KNOWLEDGE_MAP_MODES.find((item) => item.mode === mode) ?? KNOWLEDGE_MAP_MODES[0]!;
}

export function primaryNodeCue(
  node: KnowledgeMapNode,
  mode: KnowledgeMapMode,
): { label: string; tone: string } {
  if (mode === 'knowledge_structure') {
    return { label: NODE_KIND_LABELS[node.kind], tone: node.kind.replace('_', '-') };
  }
  if (mode === 'learning_progress') {
    return {
      label: PRIMARY_STATE_LABELS[node.learner.primaryState],
      tone: node.learner.primaryState,
    };
  }
  if (mode === 'learning_route') {
    return {
      label: ROUTE_POSITION_LABELS[node.route.position],
      tone: `route-${node.route.position}`,
    };
  }
  if (node.learner.primaryState === 'repair') {
    return { label: PRIMARY_STATE_LABELS.repair, tone: 'repair' };
  }
  const orderedKinds: KnowledgeMapWeaknessSignalKind[] = [
    'formal_failure',
    'progression_repair_needed',
    'retrievability_concern',
    'review_due',
    'open_mistake',
    'legacy_mastery_weak',
    'mastery_red_team_possible_gap',
  ];
  const signal = orderedKinds
    .map((kind) => node.weaknesses.find((item) => item.kind === kind))
    .find(Boolean);
  return signal
    ? {
        label: WEAKNESS_PRESENTATION[signal.kind].label,
        tone: WEAKNESS_PRESENTATION[signal.kind].tone,
      }
    : { label: PRIMARY_STATE_LABELS[node.learner.primaryState], tone: node.learner.primaryState };
}

export function visibleKnowledgeMapNodeIds(
  projection: KnowledgeMapProjection,
  mode: KnowledgeMapMode,
  selectedNodeId: string | null,
  expandedNodeIds: ReadonlySet<string> = new Set(),
): Set<string> {
  const ids = new Set<string>();
  for (const node of projection.nodes) {
    if (node.learnerVisible === false) continue;
    if (!node.modes.includes(mode)) continue;
    if (mode === 'learning_route' && node.route.position === 'outside_route') continue;
    if (
      mode === 'weakness_map' &&
      node.weaknesses.length === 0 &&
      node.learner.primaryState !== 'weak' &&
      node.learner.primaryState !== 'repair'
    ) {
      continue;
    }
    ids.add(node.id);
  }
  for (const expandedId of expandedNodeIds) {
    const node = projection.nodes.find((candidate) => candidate.id === expandedId);
    if (!node) continue;
    const childIds =
      node.kind === 'curriculum_region'
        ? node.childNodeIds
        : node.kind === 'learning_unit'
          ? node.conceptNodeIds
          : node.kind === 'synthesis'
            ? node.learningUnitNodeIds
            : [];
    for (const childId of childIds) {
      const child = projection.nodes.find((candidate) => candidate.id === childId);
      if (child?.modes.includes(mode)) ids.add(childId);
    }
  }
  if (selectedNodeId && projection.nodes.some((node) => node.id === selectedNodeId)) {
    ids.add(selectedNodeId);
  }
  return ids;
}

export function visibleKnowledgeMapEdges(
  projection: KnowledgeMapProjection,
  mode: KnowledgeMapMode,
  nodeIds: ReadonlySet<string>,
): KnowledgeMapEdge[] {
  return projection.edges.filter(
    (edge) =>
      edge.modes.includes(mode) && nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId),
  );
}

export function knowledgeMapIdentity(projection: KnowledgeMapProjection): string {
  return `${projection.workspaceId}:${projection.route.curriculumVersionId ?? 'unconfigured'}`;
}
