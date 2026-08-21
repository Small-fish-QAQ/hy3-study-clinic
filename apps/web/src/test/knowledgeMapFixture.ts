import type {
  KnowledgeMapEdge,
  KnowledgeMapNode,
  KnowledgeMapProjection,
  KnowledgeMapWeaknessSignal,
} from '@hy3-clinic/shared';

export const KNOWLEDGE_MAP_TEST_TIME = '2026-08-22T00:00:00.000Z';

const provenance = {
  kind: 'curriculum_source_reference' as const,
  materialId: 'mat_1',
  materialRevisionId: 'revision_1',
  sourceBlockId: 'block_1',
  sourceBlockRevisionFingerprint: 'block-fingerprint',
  quote: '工作记忆会限制一次能够处理的信息数量。',
  startOffset: 0,
  endOffset: 21,
  exactQuoteValidated: true,
  semanticEntailmentClaimed: false as const,
  current: true,
};

function signal(
  kind: KnowledgeMapWeaknessSignal['kind'],
  overrides: Partial<KnowledgeMapWeaknessSignal> = {},
): KnowledgeMapWeaknessSignal {
  return {
    kind,
    authority:
      kind === 'mastery_red_team_possible_gap'
        ? 'mastery_red_team_advisory'
        : kind === 'active_repair'
          ? 'repair'
          : kind === 'review_due' || kind === 'retrievability_concern'
            ? 'review'
            : 'formal_assessment',
    recordIds: [`record_${kind}`],
    objectiveIds: ['objective_1'],
    current: true,
    advisory: kind === 'mastery_red_team_possible_gap',
    actionable: kind !== 'mastery_red_team_possible_gap',
    occurredAt: KNOWLEDGE_MAP_TEST_TIME,
    summary: `Projected ${kind}`,
    ...overrides,
  };
}

function unitNode(
  id: string,
  label: string,
  overrides: Partial<KnowledgeMapNode> & {
    primaryState?: KnowledgeMapNode['learner']['primaryState'];
    routePosition?: KnowledgeMapNode['route']['position'];
    weaknesses?: KnowledgeMapWeaknessSignal[];
    navigation?: KnowledgeMapNode['navigation'];
  } = {},
): KnowledgeMapNode {
  const objectiveId = `objective_${id}`;
  return {
    id: `learning-unit:${id}`,
    kind: 'learning_unit',
    label,
    modes: ['knowledge_structure', 'learning_progress', 'learning_route', 'weakness_map'],
    current: true,
    provenance: [provenance],
    learner: {
      primaryState: overrides.primaryState ?? 'planned',
      milestones: ['planned'],
      formalValidation:
        overrides.primaryState === 'weak'
          ? 'current_failure'
          : overrides.primaryState === 'evidence_backed'
            ? 'supported'
            : 'awaiting',
      progression: [],
      legacyMastery: null,
      reasonCodes:
        overrides.primaryState === 'repair'
          ? ['active_repair']
          : overrides.primaryState === 'weak'
            ? ['current_formal_failure']
            : overrides.primaryState === 'evidence_backed'
              ? ['current_supported_evidence']
              : ['accepted_plan_membership'],
      authorityRefs: [],
    },
    route: {
      position: overrides.routePosition ?? 'planned',
      contextOnly: false,
      acceptedPlanNext: overrides.routePosition === 'next',
      currentAgenda: overrides.routePosition === 'current',
      agendaDiffersFromPlan: false,
      prerequisiteLocked: overrides.routePosition === 'locked',
      lockedByNodeIds: overrides.routePosition === 'locked' ? ['learning-unit:foundation'] : [],
      planItems: [],
      agendaItems: [],
    },
    weaknesses: overrides.weaknesses ?? [],
    navigation: overrides.navigation ?? [],
    curriculumVersionId: 'curriculum_1',
    objectiveIds: [objectiveId],
    conceptNodeIds: [],
    prerequisiteNodeIds: [],
    synthesisGroupIds: [],
  };
}

function edge(id: string, sourceNodeId: string, targetNodeId: string): KnowledgeMapEdge {
  return {
    id,
    sourceNodeId,
    targetNodeId,
    kind: 'curriculum_prerequisite',
    modes: ['knowledge_structure', 'learning_progress', 'learning_route'],
    current: true,
    authority: 'accepted_curriculum',
    sourceRecordIds: ['curriculum_1'],
    explanation: 'Accepted course prerequisite.',
    provenance: [provenance],
  };
}

export function knowledgeMapProjection(workspaceId = 'ws_1'): KnowledgeMapProjection {
  const nodes: KnowledgeMapNode[] = [
    unitNode('foundation', '工作记忆基础', {
      primaryState: 'evidence_backed',
      routePosition: 'completed',
      weaknesses: [signal('review_due', { objectiveIds: ['objective_foundation'] })],
      navigation: [
        {
          destination: 'progress',
          materialId: null,
          sourceBlockId: null,
          learningUnitId: 'foundation',
          objectiveId: 'objective_foundation',
          agendaItemId: null,
          repairEpisodeId: null,
          reviewTargetId: 'review_target_foundation',
        },
      ],
    }),
    unitNode('current', '认知负荷应用', {
      primaryState: 'repair',
      routePosition: 'current',
      weaknesses: [
        signal('formal_failure', { objectiveIds: ['objective_current'] }),
        signal('active_repair', { objectiveIds: ['objective_current'] }),
        signal('review_due', { objectiveIds: ['objective_current'] }),
        signal('retrievability_concern', { objectiveIds: ['objective_current'] }),
        signal('mastery_red_team_possible_gap', { objectiveIds: ['objective_current'] }),
      ],
      navigation: [
        {
          destination: 'study',
          materialId: null,
          sourceBlockId: null,
          learningUnitId: 'current',
          objectiveId: 'objective_current',
          agendaItemId: 'agenda_item_current',
          repairEpisodeId: null,
          reviewTargetId: null,
        },
        {
          destination: 'progress',
          materialId: null,
          sourceBlockId: null,
          learningUnitId: 'current',
          objectiveId: 'objective_current',
          agendaItemId: null,
          repairEpisodeId: 'repair_current',
          reviewTargetId: null,
        },
        {
          destination: 'progress',
          materialId: null,
          sourceBlockId: null,
          learningUnitId: 'current',
          objectiveId: 'objective_current',
          agendaItemId: null,
          repairEpisodeId: null,
          reviewTargetId: 'review_target_current',
        },
      ],
    }),
    unitNode('next', '提取练习', {
      primaryState: 'planned',
      routePosition: 'next',
    }),
    unitNode('locked', '迁移练习', {
      primaryState: 'not_started',
      routePosition: 'locked',
    }),
    unitNode('advisory', '间隔效应', {
      primaryState: 'evidence_backed',
      routePosition: 'outside_route',
      weaknesses: [
        signal('mastery_red_team_possible_gap', { objectiveIds: ['objective_advisory'] }),
      ],
    }),
  ];
  const edges = [
    edge('edge_1', nodes[0]!.id, nodes[1]!.id),
    edge('edge_2', nodes[1]!.id, nodes[2]!.id),
    edge('edge_3', nodes[2]!.id, nodes[3]!.id),
  ];
  return {
    schemaVersion: 1,
    projectionVersion: 'knowledge-map-projection-v1',
    precedencePolicyVersion: 'knowledge-map-precedence-v1',
    workspaceId,
    generatedAt: KNOWLEDGE_MAP_TEST_TIME,
    status: 'current',
    route: {
      current: true,
      courseExecutionVersion: 1,
      executionStatus: 'active',
      validationStatus: 'valid',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      agendaId: 'agenda_1',
      executionSourceManifestFingerprint: 'manifest-fingerprint',
      unknownReasons: [],
    },
    modes: ['knowledge_structure', 'learning_progress', 'learning_route', 'weakness_map'],
    nodes,
    edges,
    history: {
      supersededCurriculumIds: [],
      supersededStudyPlanIds: [],
      historicalFormalEvidenceIds: [],
      historicalAssessmentEvidenceIds: [],
      truncated: false,
    },
    limits: {
      maxNodes: 2000,
      maxEdges: 4000,
      totalNodeCandidates: nodes.length,
      totalEdgeCandidates: edges.length,
      nodesTruncated: false,
      edgesTruncated: false,
    },
  };
}

export function largeKnowledgeMapProjection(count = 120): KnowledgeMapProjection {
  const projection = knowledgeMapProjection();
  const nodes = Array.from({ length: count }, (_, index) =>
    unitNode(`large_${index}`, `大型课程学习单元 ${index + 1}`, {
      primaryState: index % 9 === 0 ? 'weak' : index % 4 === 0 ? 'evidence_backed' : 'planned',
      routePosition: index === 0 ? 'current' : index === 1 ? 'next' : 'planned',
      weaknesses: index % 9 === 0 ? [signal('formal_failure')] : [],
    }),
  );
  const edges = nodes
    .slice(1)
    .map((node, index) => edge(`large_edge_${index}`, nodes[index]!.id, node.id));
  return {
    ...projection,
    nodes,
    edges,
    limits: {
      ...projection.limits,
      totalNodeCandidates: nodes.length,
      totalEdgeCandidates: edges.length,
    },
  };
}
