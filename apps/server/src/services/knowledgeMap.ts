import {
  KnowledgeMapProjectionResponseSchema,
  KnowledgeMapProjectionSchema,
  type Concept,
  type Curriculum,
  type FormalEvidenceRecord,
  type KnowledgeMapAuthorityRef,
  type KnowledgeMapEdge,
  type KnowledgeMapLearnerOverlay,
  type KnowledgeMapNode,
  type KnowledgeMapPrimaryState,
  type KnowledgeMapProvenance,
  type KnowledgeMapProjection,
  type KnowledgeMapRouteOverlay,
  type KnowledgeMapStateReason,
  type KnowledgeMapWeaknessSignal,
  type MasteryRedTeamEvaluation,
  type MasteryRedTeamRun,
  type MasterySnapshot,
  type SessionAgenda,
  type StudyPlan,
  type StudyPlanProgressState,
  type SourceBlock,
} from '@hy3-clinic/shared';
import {
  KnowledgeMapAuthorityRefSchema,
  KnowledgeMapModeSchema,
  KnowledgeMapProvenanceSchema,
  StudyPlanProgressStateSchema,
} from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { LearningUnitProgress } from '../repositories/formalProgression.js';
import type { StudyPlanProgressRecord } from '../repositories/studyPlans.js';
import type { GraphService } from './graph.js';
import { curriculumSourceBlockFingerprint } from './curriculumValidation.js';
import type { Clock } from '../util/ids.js';

const MODES = KnowledgeMapModeSchema.options;
const ACTIVE_REPAIR_STATUSES = new Set(['OPEN', 'ACTIVE', 'AWAITING_VERIFICATION']);
const ROUTE_BLOCKING_REASONS = new Set([
  'incomplete_route_pointers',
  'missing_route_artifact',
  'route_not_valid',
  'route_identity_mismatch',
  'stale_source_revision',
  'source_manifest_mismatch',
  'invalid_current_provenance',
]);

type RouteArtifacts = {
  state: ReturnType<Repositories['courseExecution']['get']>;
  contract: NonNullable<ReturnType<Repositories['learningContracts']['get']>> | null;
  curriculum: NonNullable<ReturnType<Repositories['curricula']['get']>> | null;
  plan: NonNullable<ReturnType<Repositories['studyPlans']['get']>> | null;
  agenda: NonNullable<ReturnType<Repositories['sessionAgendas']['get']>> | null;
  current: boolean;
  reasons: KnowledgeMapProjection['route']['unknownReasons'];
};

type ReviewProjectionRecord = ReturnType<Repositories['reviewSuccessor']['listProjectionRecords']>;
type AssessmentProjectionRecord = ReturnType<
  Repositories['formalAssessments']['listProjectionRecords']
>;

type ReviewProjection = {
  record: ReviewProjectionRecord;
  target: ReviewProjectionRecord['targets'][number];
  binding: ReviewProjectionRecord['bindings'][number];
  state: ReviewProjectionRecord['states'][number];
  latestEvent: ReviewProjectionRecord['events'][number] | undefined;
  latestExecution: ReviewProjectionRecord['executions'][number] | undefined;
};

interface UnitFacts {
  unitId: string;
  progress: LearningUnitProgress | null;
  planProgress: StudyPlanProgressRecord[];
  lessonCompleted: boolean;
  lessonStarted: boolean;
  formal: {
    status: 'none' | 'awaiting' | 'supported' | 'failure';
    records: FormalEvidenceRecord[];
  };
  repairs: ReturnType<Repositories['repair']['listByWorkspace']>;
  reviewDue: ReviewProjection[];
  reviewConcern: ReviewProjection[];
  redTeam: Array<{
    evaluation: MasteryRedTeamEvaluation;
    run: MasteryRedTeamRun;
    snapshot: MasterySnapshot;
  }>;
}

function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function sortedIds(values: readonly string[], limit = 500): { ids: string[]; truncated: boolean } {
  const ids = [...new Set(values)].sort();
  return { ids: ids.slice(0, limit), truncated: ids.length > limit };
}

function authority(
  kind: KnowledgeMapAuthorityRef['authority'],
  recordId: string,
  status: string,
  current: boolean,
  recordVersion: number | null = null,
): KnowledgeMapAuthorityRef {
  return KnowledgeMapAuthorityRefSchema.parse({
    authority: kind,
    recordId,
    recordVersion,
    status,
    current,
  });
}

function provenance(input: KnowledgeMapProvenance): KnowledgeMapProvenance {
  return KnowledgeMapProvenanceSchema.parse(input);
}

function sourceProvenance(
  concept: Concept,
  block: SourceBlock | undefined,
  activeRevisionId: string | null,
): KnowledgeMapProvenance {
  const grounding = concept.grounding;
  const exact =
    !!block &&
    block.materialId === concept.materialId &&
    (concept.materialRevisionId ?? activeRevisionId) === block.materialRevisionId &&
    grounding.startOffset >= 0 &&
    grounding.endOffset <= block.content.length &&
    grounding.endOffset > grounding.startOffset &&
    block.content.slice(grounding.startOffset, grounding.endOffset) === grounding.quote;
  return provenance({
    kind: 'source_concept_grounding',
    materialId: concept.materialId,
    materialRevisionId: concept.materialRevisionId ?? activeRevisionId,
    sourceBlockId: grounding.blockId,
    sourceBlockRevisionFingerprint:
      block && activeRevisionId ? curriculumSourceBlockFingerprint(block, activeRevisionId) : null,
    quote: grounding.quote,
    startOffset: grounding.startOffset,
    endOffset: grounding.endOffset,
    exactQuoteValidated: exact,
    semanticEntailmentClaimed: false,
    current:
      exact &&
      !!activeRevisionId &&
      (concept.materialRevisionId ?? activeRevisionId) === activeRevisionId,
  });
}

function curriculumProvenance(
  ref: Curriculum['nodes'][number]['sourceReferences'][number],
  block: SourceBlock | undefined,
  activeRevisionId: string | null,
): KnowledgeMapProvenance {
  const exact =
    !!block &&
    ref.sourceBlockId === block.id &&
    ref.materialRevisionId === block.materialRevisionId &&
    !!ref.sourceBlockRevisionFingerprint &&
    ref.sourceBlockRevisionFingerprint ===
      curriculumSourceBlockFingerprint(block, ref.materialRevisionId);
  return provenance({
    kind: 'curriculum_source_reference',
    materialId: ref.materialId,
    materialRevisionId: ref.materialRevisionId,
    sourceBlockId: ref.sourceBlockId,
    sourceBlockRevisionFingerprint: ref.sourceBlockRevisionFingerprint,
    quote: exact ? block!.content : null,
    startOffset: exact ? block!.startOffset : null,
    endOffset: exact ? block!.endOffset : null,
    exactQuoteValidated: exact,
    semanticEntailmentClaimed: false,
    current:
      !!activeRevisionId &&
      activeRevisionId === ref.materialRevisionId &&
      (!ref.sourceBlockId || exact),
  });
}

function curriculumEdgeProvenance(
  refs: Curriculum['nodes'][number]['sourceReferences'],
  fallbackRefs: Curriculum['nodes'][number]['sourceReferences'],
  blockById: Map<string, SourceBlock>,
  activeRevisionByMaterial: Map<string, string>,
): KnowledgeMapProvenance[] {
  const candidates = [...refs, ...fallbackRefs];
  const result: KnowledgeMapProvenance[] = [];
  for (const ref of candidates) {
    const item = curriculumProvenance(
      ref,
      ref.sourceBlockId ? blockById.get(ref.sourceBlockId) : undefined,
      activeRevisionByMaterial.get(ref.materialId) ?? null,
    );
    if (item.current && item.exactQuoteValidated) result.push(item);
    if (result.length === 1) break;
  }
  return result;
}

function graphProvenance(
  edge: ReturnType<Repositories['graph']['getEdges']>[number],
  blockById: Map<string, SourceBlock>,
  activeRevisionByMaterial: Map<string, string>,
): KnowledgeMapProvenance[] {
  return edge.evidence.map((evidence) => {
    const block = blockById.get(evidence.blockId);
    const activeRevisionId = block
      ? (activeRevisionByMaterial.get(block.materialId) ?? null)
      : null;
    const exact =
      !!block &&
      evidence.startOffset >= 0 &&
      evidence.endOffset <= block.content.length &&
      evidence.endOffset > evidence.startOffset &&
      block.content.slice(evidence.startOffset, evidence.endOffset) === evidence.quote;
    return provenance({
      kind: 'graph_edge_evidence',
      materialId: block?.materialId ?? 'unknown-material',
      materialRevisionId: block?.materialRevisionId ?? null,
      sourceBlockId: evidence.blockId,
      sourceBlockRevisionFingerprint:
        block && activeRevisionId
          ? curriculumSourceBlockFingerprint(block, activeRevisionId)
          : null,
      quote: evidence.quote,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
      exactQuoteValidated: exact,
      semanticEntailmentClaimed: false,
      current: exact && !!block && block.materialRevisionId === activeRevisionId,
    });
  });
}

function addReason(
  reasons: KnowledgeMapProjection['route']['unknownReasons'],
  reason: KnowledgeMapProjection['route']['unknownReasons'][number],
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function checkCurrentManifest(
  curriculum: Curriculum,
  plan: StudyPlan,
  agenda: SessionAgenda,
  activeRevisionByMaterial: Map<string, string>,
  activeBlockIdsByMaterial: Map<string, Set<string>>,
  reasons: KnowledgeMapProjection['route']['unknownReasons'],
): void {
  if (
    plan.executionSourceManifestFingerprint !== curriculum.executionSourceManifest.fingerprint ||
    agenda.executionSourceManifestFingerprint !== plan.executionSourceManifestFingerprint
  ) {
    addReason(reasons, 'source_manifest_mismatch');
  }
  for (const revision of curriculum.executionSourceManifest.revisions) {
    if (activeRevisionByMaterial.get(revision.materialId) !== revision.materialRevisionId) {
      addReason(reasons, 'stale_source_revision');
      continue;
    }
    const activeBlocks = activeBlockIdsByMaterial.get(revision.materialId) ?? new Set<string>();
    if (revision.sourceBlockRevisionIds.some((id) => !activeBlocks.has(id))) {
      addReason(reasons, 'stale_source_revision');
    }
  }
}

function readRoute(
  repos: Repositories,
  workspaceId: string,
  activeRevisionByMaterial: Map<string, string>,
  activeBlockIdsByMaterial: Map<string, Set<string>>,
): RouteArtifacts {
  const state = repos.courseExecution.get(workspaceId);
  const pointers = [
    state.activeContractId,
    state.activeCurriculumId,
    state.acceptedPlanId,
    state.activeAgendaId,
  ];
  const reasons: KnowledgeMapProjection['route']['unknownReasons'] = [];
  if (pointers.every((pointer) => pointer === null)) {
    return {
      state,
      contract: null,
      curriculum: null,
      plan: null,
      agenda: null,
      current: false,
      reasons,
    };
  }
  if (pointers.some((pointer) => pointer === null) || state.updatedAt === null) {
    addReason(reasons, 'incomplete_route_pointers');
    return {
      state,
      contract: null,
      curriculum: null,
      plan: null,
      agenda: null,
      current: false,
      reasons,
    };
  }
  const contract = repos.learningContracts.get(state.activeContractId!);
  const curriculum = repos.curricula.get(state.activeCurriculumId!);
  const plan = repos.studyPlans.get(state.acceptedPlanId!);
  const agenda = repos.sessionAgendas.get(state.activeAgendaId!);
  if (!contract || !curriculum || !plan || !agenda) {
    addReason(reasons, 'missing_route_artifact');
    return {
      state,
      contract: contract ?? null,
      curriculum: curriculum ?? null,
      plan: plan ?? null,
      agenda: agenda ?? null,
      current: false,
      reasons,
    };
  }
  if (state.routeValidationStatus !== 'valid') addReason(reasons, 'route_not_valid');
  if (
    contract.workspaceId !== workspaceId ||
    contract.status !== 'active' ||
    curriculum.workspaceId !== workspaceId ||
    curriculum.status !== 'accepted' ||
    !curriculum.validation.valid ||
    plan.workspaceId !== workspaceId ||
    plan.status !== 'accepted' ||
    agenda.workspaceId !== workspaceId ||
    agenda.status === 'abandoned' ||
    curriculum.contractVersionId !== contract.id ||
    plan.contractVersionId !== contract.id ||
    plan.curriculumVersionId !== curriculum.id ||
    agenda.contractVersionId !== contract.id ||
    agenda.curriculumVersionId !== curriculum.id ||
    agenda.studyPlanVersionId !== plan.id ||
    agenda.executionSourceManifestFingerprint !== plan.executionSourceManifestFingerprint
  )
    addReason(reasons, 'route_identity_mismatch');
  checkCurrentManifest(
    curriculum,
    plan,
    agenda,
    activeRevisionByMaterial,
    activeBlockIdsByMaterial,
    reasons,
  );
  return {
    state,
    contract,
    curriculum,
    plan,
    agenda,
    current: reasons.every((reason) => !ROUTE_BLOCKING_REASONS.has(reason)),
    reasons,
  };
}

function progressionRecordId(workspaceId: string, curriculumId: string, unitId: string): string {
  return `learning-unit-progress:${workspaceId}:${curriculumId}:${unitId}`;
}

function planProgressState(
  records: StudyPlanProgressRecord[],
  itemId: string,
): StudyPlanProgressState {
  return StudyPlanProgressStateSchema.parse(
    records.find((record) => record.planItemId === itemId)?.state ?? 'not_started',
  );
}

function currentPlanItems(
  plan: StudyPlan,
  objectiveIds: Set<string>,
  unitId: string | null,
): StudyPlan['items'] {
  return plan.items.filter((item) => {
    if (unitId && item.curriculumLearningUnitId === unitId) return true;
    return item.objectiveIds.some((id) => objectiveIds.has(id));
  });
}

function routeOverlay(
  unitId: string | null,
  objectiveIds: string[],
  plan: StudyPlan | null,
  planProgress: StudyPlanProgressRecord[],
  agenda: SessionAgenda | null,
  unitById: Map<string, Curriculum['nodes'][number]>,
  nodeIdByUnitId: Map<string, string>,
  nextPlanItemId: string | null,
  progressByUnitId: Map<string, LearningUnitProgress>,
): KnowledgeMapRouteOverlay {
  const objectives = new Set(objectiveIds);
  const planItems = plan ? currentPlanItems(plan, objectives, unitId) : [];
  const agendaItems = agenda
    ? agenda.items.filter(
        (item) =>
          (unitId && item.learningUnitId === unitId) ||
          (item.linkedPlanItemId &&
            planItems.some((planItem) => planItem.id === item.linkedPlanItemId)),
      )
    : [];
  const currentAgenda = agendaItems.some(
    (item) => item.state === 'active' || item.id === agenda?.currentItemId,
  );
  const agendaDiffersFromPlan = agendaItems.some(
    (item) => item.origin !== 'accepted_plan' || !item.linkedPlanItemId,
  );
  const completedPlanItems = new Set(
    planProgress
      .filter((item) => item.state === 'completed' || item.state === 'obsolete')
      .map((item) => item.planItemId),
  );
  const relevantPlanItems = planItems.filter(
    (item) => !['obsolete', 'deferred'].includes(planProgressState(planProgress, item.id)),
  );
  const completed =
    relevantPlanItems.length > 0 &&
    relevantPlanItems.every((item) => completedPlanItems.has(item.id));
  const deferred =
    planItems.length > 0 &&
    planItems.every((item) =>
      ['deferred', 'obsolete'].includes(planProgressState(planProgress, item.id)),
    );
  const lockedByNodeIds = unitId
    ? [...(unitById.get(unitId)?.learningUnit?.prerequisiteUnitIds ?? [])]
        .filter((id) => progressByUnitId.get(id)?.state !== 'complete')
        .map((id) => nodeIdByUnitId.get(id) ?? id)
    : [];
  const prerequisiteLocked = lockedByNodeIds.length > 0;
  let position: KnowledgeMapRouteOverlay['position'] = 'outside_route';
  if (prerequisiteLocked) position = 'locked';
  else if (currentAgenda) position = 'current';
  else if (completed) position = 'completed';
  else if (deferred) position = 'deferred';
  else if (planItems.length > 0)
    position =
      nextPlanItemId && planItems.some((item) => item.id === nextPlanItemId) ? 'next' : 'planned';
  else if (agendaItems.length > 0) position = 'current';
  return {
    position,
    contextOnly: planItems.length === 0 && agendaItems.length > 0,
    acceptedPlanNext: !!nextPlanItemId && planItems.some((item) => item.id === nextPlanItemId),
    currentAgenda,
    agendaDiffersFromPlan,
    prerequisiteLocked,
    lockedByNodeIds,
    planItems: planItems.slice(0, 100).map((item) => ({
      id: item.id,
      index: item.index,
      kind: item.kind,
      objectiveIds: item.objectiveIds,
      progressState: planProgressState(planProgress, item.id),
    })),
    agendaItems: agendaItems.slice(0, 100).map((item) => ({
      id: item.id,
      index: item.index,
      kind: item.kind,
      origin: item.origin,
      state: item.state,
      linkedPlanItemId: item.linkedPlanItemId,
    })),
  };
}

function baseNavigation(
  destination: 'materials' | 'curriculum' | 'study' | 'progress',
  values: Partial<KnowledgeMapNode['navigation'][number]> = {},
) {
  return [
    {
      destination,
      materialId: null,
      sourceBlockId: null,
      learningUnitId: null,
      objectiveId: null,
      agendaItemId: null,
      repairEpisodeId: null,
      reviewTargetId: null,
      ...values,
    },
  ];
}

function buildOverlay(input: {
  primaryState: KnowledgeMapPrimaryState;
  milestones?: KnowledgeMapLearnerOverlay['milestones'];
  formalValidation?: KnowledgeMapLearnerOverlay['formalValidation'];
  progression?: KnowledgeMapLearnerOverlay['progression'];
  legacyMastery?: KnowledgeMapLearnerOverlay['legacyMastery'];
  reasonCodes: KnowledgeMapStateReason[];
  authorityRefs: KnowledgeMapAuthorityRef[];
}): KnowledgeMapLearnerOverlay {
  return {
    primaryState: input.primaryState,
    milestones: [...new Set(input.milestones ?? [])],
    formalValidation: input.formalValidation ?? 'not_applicable',
    progression: input.progression ?? [],
    legacyMastery: input.legacyMastery ?? null,
    reasonCodes: [...new Set(input.reasonCodes)].slice(0, 20),
    authorityRefs: unique(
      input.authorityRefs,
      (ref) => `${ref.authority}:${ref.recordId}:${ref.recordVersion ?? ''}`,
    ).slice(0, 200),
  };
}

function signal(input: KnowledgeMapWeaknessSignal): KnowledgeMapWeaknessSignal {
  return input;
}

function assessmentCurrentEvidence(
  records: AssessmentProjectionRecord,
  route: RouteArtifacts,
): { current: FormalEvidenceRecord[]; historical: string[] } {
  // Assessment evidence uses the learner-facing assessment schema and is not
  // itself the progression authority. Only the formally reconciled
  // FormalEvidenceRecord stream below can credit current state; these rows
  // remain inspectable history unless an explicit progression bridge exists.
  const current: FormalEvidenceRecord[] = [];
  const historical: string[] = [];
  if (!route.current || !route.contract || !route.curriculum || !route.plan || !route.agenda) {
    return { current: [], historical: records.evidence.map((evidence) => evidence.id) };
  }
  for (const evidence of records.evidence) historical.push(evidence.id);
  return { current, historical };
}

export interface KnowledgeMapService {
  get(workspaceId: string): KnowledgeMapProjection;
}

export function createKnowledgeMapService({
  repos,
  graph,
  clock,
}: {
  repos: Repositories;
  graph: GraphService;
  clock: Clock;
}): KnowledgeMapService {
  return {
    get(workspaceId: string): KnowledgeMapProjection {
      const workspace = repos.workspaces.get(workspaceId);
      if (!workspace) throw notFound(`Workspace does not exist: ${workspaceId}`);
      const materials = repos.materials
        .listByWorkspace(workspaceId)
        .filter((material) => material.availability !== 'retired');
      const activeRevisionByMaterial = new Map(
        materials.map((material) => [material.id, material.activeRevisionId ?? '']),
      );
      const blocks = repos.materials.getBlocksByWorkspace(workspaceId);
      const blockById = new Map(blocks.map((block) => [block.id, block]));
      const activeBlockIdsByMaterial = new Map<string, Set<string>>();
      for (const block of blocks) {
        if (activeRevisionByMaterial.get(block.materialId) !== block.materialRevisionId) continue;
        const ids = activeBlockIdsByMaterial.get(block.materialId) ?? new Set<string>();
        ids.add(block.id);
        activeBlockIdsByMaterial.set(block.materialId, ids);
      }
      const allConcepts = repos.materials.getConceptsByWorkspace(workspaceId);
      const concepts = allConcepts.filter(
        (concept) =>
          activeRevisionByMaterial.get(concept.materialId) ===
          (concept.materialRevisionId ?? activeRevisionByMaterial.get(concept.materialId)),
      );
      const route = readRoute(
        repos,
        workspaceId,
        activeRevisionByMaterial,
        activeBlockIdsByMaterial,
      );
      if (
        allConcepts.some(
          (concept) =>
            activeRevisionByMaterial.has(concept.materialId) && !concepts.includes(concept),
        )
      ) {
        addReason(route.reasons, 'invalid_current_provenance');
      }
      if (route.current && route.curriculum) {
        for (const curriculumNode of route.curriculum.nodes) {
          for (const ref of curriculumNode.sourceReferences) {
            const currentRef = curriculumProvenance(
              ref,
              ref.sourceBlockId ? blockById.get(ref.sourceBlockId) : undefined,
              activeRevisionByMaterial.get(ref.materialId) ?? null,
            );
            if (!currentRef.current || !currentRef.exactQuoteValidated)
              addReason(route.reasons, 'invalid_current_provenance');
          }
        }
      }
      const routeUsable = () =>
        route.current && !route.reasons.some((reason) => ROUTE_BLOCKING_REASONS.has(reason));
      const graphData = graph.getActive(workspaceId);
      const graphConceptIds = new Set(concepts.map((concept) => concept.id));
      const mastery = new Map(
        graph.learnerOverlay(workspaceId).map((state) => [state.conceptId, state]),
      );
      const openMistakes = new Map<
        string,
        ReturnType<Repositories['mistakes']['listOpenByWorkspace']>
      >();
      for (const mistake of repos.mistakes.listOpenByWorkspace(workspaceId)) {
        const list = openMistakes.get(mistake.conceptId) ?? [];
        list.push(mistake);
        openMistakes.set(mistake.conceptId, list);
      }
      const canonicalViews = repos.alignment.listCanonical(workspaceId);
      const canonicalBySource = new Map(
        canonicalViews.flatMap((view) =>
          view.members.map((member) => [member.sourceConceptId, view] as const),
        ),
      );
      const nodeIdBySource = new Map(
        concepts.map((concept) => [concept.id, `concept:${concept.id}`]),
      );
      const nodeIdByUnitId = new Map<string, string>();
      const nodes: KnowledgeMapNode[] = [];
      const edges: KnowledgeMapEdge[] = [];
      const allUnitNodes = route.curriculum
        ? route.curriculum.nodes.filter((node) => node.kind === 'learning_unit')
        : [];
      const unitById = new Map(allUnitNodes.map((node) => [node.id, node]));
      if (route.current && route.curriculum) {
        for (const node of allUnitNodes) {
          const unit = node.learningUnit!;
          for (const prerequisite of unit.prerequisiteUnitIds) {
            const prerequisiteNode = unitById.get(prerequisite);
            if (
              prerequisiteNode &&
              curriculumEdgeProvenance(
                node.sourceReferences,
                prerequisiteNode.sourceReferences,
                blockById,
                activeRevisionByMaterial,
              ).length === 0
            ) {
              addReason(route.reasons, 'invalid_current_provenance');
            }
          }
          for (const conceptId of unit.conceptIds) {
            if (
              nodeIdBySource.has(conceptId) &&
              curriculumEdgeProvenance(
                node.sourceReferences,
                [],
                blockById,
                activeRevisionByMaterial,
              ).length === 0
            ) {
              addReason(route.reasons, 'invalid_current_provenance');
            }
          }
        }
        for (const group of route.curriculum.synthesisGroups) {
          for (const unitId of group.learningUnitIds) {
            const member = unitById.get(unitId);
            if (
              member &&
              curriculumEdgeProvenance(
                member.sourceReferences,
                [],
                blockById,
                activeRevisionByMaterial,
              ).length === 0
            ) {
              addReason(route.reasons, 'invalid_current_provenance');
            }
          }
        }
      }
      for (const node of allUnitNodes) nodeIdByUnitId.set(node.id, `learning-unit:${node.id}`);
      const progressByUnitId = new Map<string, LearningUnitProgress>();
      const planProgress = route.plan ? repos.studyPlans.listProgress(route.plan.id) : [];
      if (route.current && route.curriculum) {
        for (const progress of repos.formalProgression.listUnitProgress(
          workspaceId,
          route.curriculum.id,
        ))
          progressByUnitId.set(progress.learningUnitId, progress);
      }
      const planProgressByItem = new Map(planProgress.map((record) => [record.planItemId, record]));
      const nextPlanItem =
        route.plan?.items.find((item) => {
          const state = planProgressByItem.get(item.id)?.state ?? 'not_started';
          if (state === 'completed' || state === 'obsolete' || state === 'deferred') return false;
          return item.prerequisitePlanItemIds.every((id) =>
            ['completed', 'obsolete'].includes(planProgressByItem.get(id)?.state ?? 'not_started'),
          );
        }) ?? null;
      const lessonStates =
        route.current && route.curriculum && route.plan
          ? repos.lessonExecution.listForRoute(workspaceId, route.curriculum.id, route.plan.id)
          : [];
      const lessonByUnit = new Map<string, (typeof lessonStates)[number]>();
      for (const state of lessonStates) {
        const prior = lessonByUnit.get(state.learningUnitId);
        if (!prior || state.updatedAt > prior.updatedAt)
          lessonByUnit.set(state.learningUnitId, state);
      }
      const formalProgressEvidence =
        route.current && route.contract && route.plan
          ? repos.formalProgression.listEvidenceForRoute(
              route.contract.id,
              route.plan.id,
              route.curriculum?.id,
            )
          : [];
      const assessmentRecords = repos.formalAssessments.listProjectionRecords(workspaceId);
      const assessmentCurrent = assessmentCurrentEvidence(assessmentRecords, route);
      const formalEvidenceByUnit = new Map<string, FormalEvidenceRecord[]>();
      for (const evidence of [...formalProgressEvidence, ...assessmentCurrent.current]) {
        const list = formalEvidenceByUnit.get(evidence.curriculumLearningUnitId) ?? [];
        list.push(evidence);
        formalEvidenceByUnit.set(evidence.curriculumLearningUnitId, list);
      }
      const formalFactByUnit = new Map<string, UnitFacts['formal']>();
      for (const [unitId, records] of formalEvidenceByUnit) {
        const currentRecords = unique(records, (record) => record.id).sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
        const latest = currentRecords.at(-1);
        formalFactByUnit.set(unitId, {
          status:
            latest &&
            ((latest.stateCreditable && latest.correct) ||
              (latest.admissibilityTier !== 'tier_3_advisory' &&
                latest.correct &&
                !latest.needsReview))
              ? 'supported'
              : 'failure',
          records: currentRecords,
        });
      }
      const repairs = repos.repair.listByWorkspace(workspaceId);
      const currentAssessmentVersionIds = new Set(
        assessmentRecords.versions
          .filter(
            (version) =>
              version.progressionContext &&
              route.current &&
              route.curriculum &&
              route.plan &&
              version.progressionContext.curriculumVersionId === route.curriculum.id &&
              version.progressionContext.studyPlanVersionId === route.plan.id,
          )
          .map((version) => version.id),
      );
      const repairsByUnit = new Map<string, typeof repairs>();
      for (const repair of repairs) {
        if (route.current && currentAssessmentVersionIds.has(repair.assessmentVersionId)) {
          const list = repairsByUnit.get(repair.targetLearningUnitId) ?? [];
          list.push(repair);
          repairsByUnit.set(repair.targetLearningUnitId, list);
        }
      }
      const reviewRecords = repos.reviewSuccessor.listProjectionRecords(workspaceId);
      const reviewByUnitDue = new Map<string, ReviewProjection[]>();
      const reviewByUnitConcern = new Map<string, ReviewProjection[]>();
      const reviewCurrentTargetRefs = new Map<string, KnowledgeMapAuthorityRef>();
      if (route.current && route.curriculum && route.plan && route.contract && route.agenda) {
        for (const target of reviewRecords.targets) {
          if (
            (target.status !== 'active' && target.status !== 'pending_initial_review') ||
            target.currentBindingVersion === null
          )
            continue;
          const record = reviewRecords;
          const binding = record.bindings.find(
            (candidate) =>
              candidate.reviewTargetId === target.id &&
              candidate.bindingVersion === target.currentBindingVersion &&
              candidate.validTo === null,
          );
          const state = record.states.find((candidate) => candidate.reviewTargetId === target.id);
          if (
            !binding ||
            !state ||
            binding.contractVersionId !== route.contract.id ||
            binding.curriculumVersionId !== route.curriculum.id ||
            binding.learningUnitId === '' ||
            binding.executionSourceManifestFingerprint !==
              route.plan.executionSourceManifestFingerprint
          )
            continue;
          const latestEvent = record.events
            .filter((event) => event.reviewTargetId === target.id)
            .at(-1);
          const latestExecution = record.executions
            .filter((candidate) => candidate.reviewTargetId === target.id)
            .at(-1);
          const projection: ReviewProjection = {
            record,
            target,
            binding,
            state,
            latestEvent,
            latestExecution,
          };
          const unitDue = reviewByUnitDue.get(binding.learningUnitId) ?? [];
          if (new Date(state.dueAt).getTime() <= clock.now().getTime()) unitDue.push(projection);
          reviewByUnitDue.set(binding.learningUnitId, unitDue);
          if (latestEvent?.kind === 'retrieval_failure' || latestExecution?.status === 'failed') {
            const unitConcern = reviewByUnitConcern.get(binding.learningUnitId) ?? [];
            unitConcern.push(projection);
            reviewByUnitConcern.set(binding.learningUnitId, unitConcern);
          }
          reviewCurrentTargetRefs.set(
            target.id,
            authority('review', target.id, state.lifecycleState, true, binding.bindingVersion),
          );
        }
      }
      const redTeamRecords = repos.masteryRedTeam.listProjectionRecords(workspaceId);
      const redTeamByUnit = new Map<string, typeof redTeamRecords>();
      for (const record of redTeamRecords) {
        if (
          !route.current ||
          !route.contract ||
          !route.curriculum ||
          !route.plan ||
          !route.agenda ||
          record.run.status !== 'evaluated' ||
          record.snapshot.route.contractVersionId !== route.contract.id ||
          record.snapshot.route.curriculumVersionId !== route.curriculum.id ||
          record.snapshot.route.studyPlanVersionId !== route.plan.id ||
          record.snapshot.route.agendaId !== route.agenda.id ||
          record.snapshot.route.executionSourceManifestFingerprint !==
            route.plan.executionSourceManifestFingerprint
        )
          continue;
        const list = redTeamByUnit.get(record.snapshot.target.learningUnitId) ?? [];
        list.push(record);
        redTeamByUnit.set(record.snapshot.target.learningUnitId, list);
      }
      const unitFacts = (unitId: string): UnitFacts => ({
        unitId,
        progress: progressByUnitId.get(unitId) ?? null,
        planProgress: planProgress,
        lessonCompleted: !!lessonByUnit.get(unitId)?.presentationCompletedAt,
        lessonStarted: !!lessonByUnit.get(unitId),
        formal: formalFactByUnit.get(unitId) ?? { status: 'none', records: [] },
        repairs: repairsByUnit.get(unitId) ?? [],
        reviewDue: reviewByUnitDue.get(unitId) ?? [],
        reviewConcern: reviewByUnitConcern.get(unitId) ?? [],
        redTeam: (redTeamByUnit.get(unitId) ?? []).sort(
          (a, b) =>
            a.evaluation.createdAt.localeCompare(b.evaluation.createdAt) ||
            a.evaluation.id.localeCompare(b.evaluation.id),
        ),
      });
      const sourceNodeForConcept = (concept: Concept): KnowledgeMapNode => {
        const learnerState = mastery.get(concept.id);
        const mistakes = openMistakes.get(concept.id) ?? [];
        const conceptProvenance = sourceProvenance(
          concept,
          blockById.get(concept.grounding.blockId),
          activeRevisionByMaterial.get(concept.materialId) ?? null,
        );
        if (!conceptProvenance.current) addReason(route.reasons, 'invalid_current_provenance');
        const refs: KnowledgeMapAuthorityRef[] = [
          authority(
            'concept_graph',
            graphData.version?.id ?? `concept:${concept.id}`,
            graphData.version?.status ?? 'absent',
            true,
          ),
        ];
        if (learnerState)
          refs.push(authority('legacy_mastery', concept.id, learnerState.state, true));
        for (const mistake of mistakes)
          refs.push(authority('mistake', mistake.id, mistake.status, true));
        const weaknesses: KnowledgeMapWeaknessSignal[] = [];
        if (mistakes.length)
          weaknesses.push(
            signal({
              kind: 'open_mistake',
              authority: 'mistake',
              recordIds: mistakes.map((mistake) => mistake.id),
              objectiveIds: [],
              current: true,
              advisory: false,
              actionable: true,
              occurredAt: mistakes.at(-1)?.createdAt ?? null,
              summary: 'An open mistake is attached to this source concept.',
            }),
          );
        if (learnerState?.state === 'weak')
          weaknesses.push(
            signal({
              kind: 'legacy_mastery_weak',
              authority: 'legacy_mastery',
              recordIds: [concept.id],
              objectiveIds: [],
              current: true,
              advisory: false,
              actionable: true,
              occurredAt: learnerState.lastActivityAt,
              summary: 'Legacy concept mastery is currently weak.',
            }),
          );
        let primaryState: KnowledgeMapPrimaryState = 'not_started';
        let reason: KnowledgeMapStateReason = 'no_current_learning_activity';
        if (mistakes.length || learnerState?.state === 'weak') {
          primaryState = 'weak';
          reason = mistakes.length ? 'no_current_learning_activity' : 'legacy_mastery_weak';
        } else if (learnerState?.state === 'stable') {
          primaryState = 'mastered';
          reason = 'legacy_mastery_stable';
        } else if (learnerState?.state === 'developing') {
          primaryState = 'developing';
          reason = 'legacy_mastery_developing';
        }
        return {
          id: nodeIdBySource.get(concept.id)!,
          kind: 'concept',
          label: canonicalBySource.get(concept.id)?.displayName ?? concept.name,
          modes: [...MODES],
          current: conceptProvenance.current,
          provenance: [conceptProvenance],
          learner: buildOverlay({
            primaryState,
            legacyMastery:
              learnerState && learnerState.state !== 'unassessed'
                ? {
                    mastery: learnerState.mastery ?? 0,
                    attempts: learnerState.attempts,
                    correctCount: learnerState.correctCount,
                    lastScore: learnerState.lastScore,
                    state: learnerState.state,
                    authority: 'legacy_concept_mastery_only',
                  }
                : null,
            reasonCodes: [reason],
            authorityRefs: refs,
          }),
          route: routeOverlay(
            null,
            [],
            null,
            [],
            null,
            unitById,
            nodeIdByUnitId,
            null,
            progressByUnitId,
          ),
          weaknesses,
          navigation: baseNavigation('materials', {
            materialId: concept.materialId,
            sourceBlockId: concept.grounding.blockId,
          }),
          canonicalConceptId: canonicalBySource.get(concept.id)?.id ?? null,
          sourceConcepts: [
            {
              id: concept.id,
              materialId: concept.materialId,
              materialRevisionId:
                concept.materialRevisionId ??
                activeRevisionByMaterial.get(concept.materialId) ??
                null,
              name: concept.name,
            },
          ],
          learningUnitIds: [],
          objectiveIds: [],
        };
      };
      for (const concept of concepts) nodes.push(sourceNodeForConcept(concept));
      const buildUnitNode = (node: Curriculum['nodes'][number]): KnowledgeMapNode => {
        const unit = node.learningUnit!;
        const refs: KnowledgeMapAuthorityRef[] = [];
        if (route.curriculum)
          refs.push(
            authority(
              'curriculum',
              route.curriculum.id,
              route.curriculum.status,
              route.current,
              route.curriculum.version,
            ),
          );
        if (route.plan)
          refs.push(
            authority(
              'study_plan',
              route.plan.id,
              route.plan.status,
              route.current,
              route.plan.version,
            ),
          );
        const facts = unitFacts(node.id);
        const unitProvenance = node.sourceReferences
          .map((ref) =>
            curriculumProvenance(
              ref,
              ref.sourceBlockId ? blockById.get(ref.sourceBlockId) : undefined,
              activeRevisionByMaterial.get(ref.materialId) ?? null,
            ),
          )
          .slice(0, 100);
        if (
          route.current &&
          unitProvenance.some((item) => !item.current || !item.exactQuoteValidated)
        )
          addReason(route.reasons, 'invalid_current_provenance');
        const repairsForNode = facts.repairs.filter(
          (repair) => repair.status !== 'RESOLVED' && repair.status !== 'CANCELLED',
        );
        const formal = facts.formal;
        const currentPlanItemsForNode = route.plan
          ? currentPlanItems(
              route.plan,
              new Set(unit.objectives.map((objective) => objective.id)),
              node.id,
            )
          : [];
        const planCompleted =
          currentPlanItemsForNode.length > 0 &&
          currentPlanItemsForNode.every((item) =>
            ['completed', 'obsolete'].includes(planProgressState(planProgress, item.id)),
          );
        const planHasFormal = currentPlanItemsForNode.some(
          (item) => item.kind === 'formal_checkpoint' || item.completionRequirements.length > 0,
        );
        let primaryState: KnowledgeMapPrimaryState = 'unknown';
        let reason: KnowledgeMapStateReason = 'route_unavailable';
        if (routeUsable()) {
          if (repairsForNode.some((repair) => ACTIVE_REPAIR_STATUSES.has(repair.status))) {
            primaryState = 'repair';
            reason = 'active_repair';
          } else if (formal.status === 'failure' || facts.progress?.state === 'repair_needed') {
            primaryState = 'weak';
            reason =
              formal.status === 'failure'
                ? 'current_formal_failure'
                : 'current_progression_repair_needed';
          } else if (facts.progress?.state === 'complete' || planCompleted) {
            primaryState = 'evidence_backed';
            reason =
              facts.progress?.state === 'complete'
                ? 'current_progression_complete'
                : 'current_supported_evidence';
          } else if (formal.status === 'supported') {
            primaryState = 'evidence_backed';
            reason = 'current_supported_evidence';
          } else if (facts.lessonCompleted) {
            primaryState = planHasFormal ? 'awaiting_formal_validation' : 'taught';
            reason = planHasFormal ? 'formal_validation_pending' : 'lesson_presentation_completed';
          } else if (facts.lessonStarted || facts.progress?.state === 'in_progress') {
            primaryState = 'currently_learning';
            reason = facts.lessonStarted ? 'lesson_started' : 'active_study_session';
          } else if (currentPlanItemsForNode.length > 0) {
            primaryState = 'planned';
            reason = 'accepted_plan_membership';
          } else primaryState = 'not_started';
        }
        if (formal.records.length)
          for (const evidence of formal.records)
            refs.push(authority('formal_assessment', evidence.id, formal.status, true));
        if (facts.progress)
          refs.push(
            authority(
              'formal_progression',
              progressionRecordId(workspaceId, route.curriculum!.id, node.id),
              facts.progress.state,
              true,
              facts.progress.version,
            ),
          );
        for (const repair of repairsForNode)
          refs.push(authority('repair', repair.id, repair.status, true));
        for (const review of [...facts.reviewDue, ...facts.reviewConcern]) {
          const ref = reviewCurrentTargetRefs.get(review.target.id);
          if (ref) refs.push(ref);
        }
        const weaknesses: KnowledgeMapWeaknessSignal[] = [];
        if (formal.status === 'failure')
          weaknesses.push(
            signal({
              kind: 'formal_failure',
              authority: 'formal_assessment',
              recordIds: formal.records.map((evidence) => evidence.id),
              objectiveIds: unit.objectives.map((objective) => objective.id),
              current: true,
              advisory: false,
              actionable: true,
              occurredAt: formal.records.at(-1)?.createdAt ?? null,
              summary: 'The latest current formal evidence did not support this LearningUnit.',
            }),
          );
        if (facts.progress?.state === 'repair_needed')
          weaknesses.push(
            signal({
              kind: 'progression_repair_needed',
              authority: 'formal_progression',
              recordIds: [progressionRecordId(workspaceId, route.curriculum!.id, node.id)],
              objectiveIds: unit.objectives.map((objective) => objective.id),
              current: true,
              advisory: false,
              actionable: true,
              occurredAt: facts.progress.updatedAt,
              summary: 'Formal progression recorded that this LearningUnit needs repair.',
            }),
          );
        if (repairsForNode.some((repair) => ACTIVE_REPAIR_STATUSES.has(repair.status)))
          weaknesses.push(
            signal({
              kind: 'active_repair',
              authority: 'repair',
              recordIds: repairsForNode
                .filter((repair) => ACTIVE_REPAIR_STATUSES.has(repair.status))
                .map((repair) => repair.id),
              objectiveIds: unit.objectives.map((objective) => objective.id),
              current: true,
              advisory: false,
              actionable: true,
              occurredAt: repairsForNode.at(-1)?.updatedAt ?? null,
              summary: 'An active Repair episode takes precedence for this LearningUnit.',
            }),
          );
        if (facts.reviewDue.length)
          weaknesses.push(
            signal({
              kind: 'review_due',
              authority: 'review',
              recordIds: facts.reviewDue.map((review) => review.target.id),
              objectiveIds: unit.objectives.map((objective) => objective.id),
              current: true,
              advisory: false,
              actionable: true,
              occurredAt: facts.reviewDue.at(-1)?.state.updatedAt ?? null,
              summary:
                'Review scheduling marks this objective as due; this is not a mastery failure.',
            }),
          );
        if (facts.reviewConcern.length)
          weaknesses.push(
            signal({
              kind: 'retrievability_concern',
              authority: 'review',
              recordIds: facts.reviewConcern.map((review) => review.target.id),
              objectiveIds: unit.objectives.map((objective) => objective.id),
              current: true,
              advisory: false,
              actionable: true,
              occurredAt:
                facts.reviewConcern.at(-1)?.latestEvent?.occurredAt ??
                facts.reviewConcern.at(-1)?.latestExecution?.updatedAt ??
                null,
              summary: 'A recent Review retrieval failure is retained as a scheduling concern.',
            }),
          );
        const latestRed = facts.redTeam.at(-1);
        if (latestRed?.evaluation.outcome === 'possible_gap')
          weaknesses.push(
            signal({
              kind: 'mastery_red_team_possible_gap',
              authority: 'mastery_red_team_advisory',
              recordIds: [latestRed.evaluation.id],
              objectiveIds: unit.objectives.map((objective) => objective.id),
              current: true,
              advisory: true,
              actionable: false,
              occurredAt: latestRed.evaluation.createdAt,
              summary:
                'Mastery Red Team reported a possible gap advisory; it does not change formal state.',
            }),
          );
        if (latestRed)
          refs.push(
            authority(
              'mastery_red_team_advisory',
              latestRed.evaluation.id,
              latestRed.evaluation.outcome,
              true,
            ),
          );
        const progression = facts.progress
          ? [
              {
                learningUnitId: node.id,
                state: facts.progress.state,
                version: facts.progress.version,
                lastDecisionId: facts.progress.lastDecisionId,
                updatedAt: facts.progress.updatedAt,
              },
            ]
          : [];
        const overlay = buildOverlay({
          primaryState,
          milestones: [
            ...(currentPlanItemsForNode.length ? ['planned' as const] : []),
            ...(facts.lessonStarted ? ['started' as const] : []),
            ...(facts.lessonCompleted ? ['taught' as const] : []),
            ...(formal.status === 'supported' ? ['formal_evidence_supported' as const] : []),
            ...(facts.progress?.state === 'complete' || planCompleted
              ? ['progression_complete' as const]
              : []),
          ],
          formalValidation:
            formal.status === 'none'
              ? route.current && planHasFormal && !facts.lessonCompleted
                ? 'awaiting'
                : 'not_applicable'
              : formal.status === 'failure'
                ? 'current_failure'
                : formal.status,
          progression,
          reasonCodes: [reason],
          authorityRefs: refs,
        });
        return {
          id: `learning-unit:${node.id}`,
          kind: 'learning_unit',
          label: node.title,
          modes: [...MODES],
          current: routeUsable(),
          provenance: unitProvenance,
          learner: overlay,
          route: routeOverlay(
            node.id,
            unit.objectives.map((objective) => objective.id),
            routeUsable() ? route.plan : null,
            routeUsable() ? planProgress : [],
            routeUsable() ? route.agenda : null,
            unitById,
            nodeIdByUnitId,
            routeUsable() ? (nextPlanItem?.id ?? null) : null,
            routeUsable() ? progressByUnitId : new Map(),
          ),
          weaknesses,
          navigation: baseNavigation('study', {
            learningUnitId: node.id,
            objectiveId: unit.objectives[0]?.id ?? null,
            agendaItemId:
              route.agenda?.items.find((item) => item.learningUnitId === node.id)?.id ?? null,
          }),
          curriculumVersionId: route.curriculum?.id ?? 'unknown-curriculum',
          objectiveIds: unit.objectives.map((objective) => objective.id),
          conceptNodeIds: unit.conceptIds
            .map((id) => nodeIdBySource.get(id))
            .filter((id): id is string => !!id),
          prerequisiteNodeIds: unit.prerequisiteUnitIds.map((id) => `learning-unit:${id}`),
          synthesisGroupIds:
            route.curriculum?.synthesisGroups
              .filter((group) => group.learningUnitIds.includes(node.id))
              .map((group) => group.id) ?? [],
        };
      };
      for (const node of allUnitNodes) {
        nodes.push(buildUnitNode(node));
      }
      for (const group of route.curriculum?.synthesisGroups ?? []) {
        const groupObjectives = new Set(group.objectiveIds);
        const groupPlanItems = route.plan
          ? currentPlanItems(route.plan, groupObjectives, null)
          : [];
        const groupCompleted =
          groupPlanItems.length > 0 &&
          groupPlanItems.every((item) =>
            ['completed', 'obsolete'].includes(planProgressState(planProgress, item.id)),
          );
        const primaryState: KnowledgeMapPrimaryState = !routeUsable()
          ? 'unknown'
          : groupCompleted
            ? 'evidence_backed'
            : groupPlanItems.length
              ? 'planned'
              : 'not_started';
        const refs: KnowledgeMapAuthorityRef[] = [];
        if (route.curriculum)
          refs.push(
            authority(
              'curriculum',
              route.curriculum.id,
              route.curriculum.status,
              route.current,
              route.curriculum.version,
            ),
          );
        if (route.plan && groupPlanItems.length)
          refs.push(
            authority(
              'study_plan',
              route.plan.id,
              route.plan.status,
              route.current,
              route.plan.version,
            ),
          );
        nodes.push({
          id: `synthesis:${group.id}`,
          kind: 'synthesis',
          label: group.title,
          modes: [...MODES],
          current: routeUsable(),
          provenance: [],
          learner: buildOverlay({
            primaryState,
            milestones: groupPlanItems.length ? ['planned'] : [],
            reasonCodes: [
              groupCompleted
                ? 'current_progression_complete'
                : groupPlanItems.length
                  ? 'accepted_plan_membership'
                  : 'route_unavailable',
            ],
            authorityRefs: refs,
          }),
          route: routeOverlay(
            null,
            group.objectiveIds,
            routeUsable() ? route.plan : null,
            routeUsable() ? planProgress : [],
            routeUsable() ? route.agenda : null,
            unitById,
            nodeIdByUnitId,
            routeUsable() ? (nextPlanItem?.id ?? null) : null,
            routeUsable() ? progressByUnitId : new Map(),
          ),
          weaknesses: [],
          navigation: baseNavigation('curriculum', {
            learningUnitId: null,
            objectiveId: group.objectiveIds[0] ?? null,
          }),
          curriculumVersionId: route.curriculum?.id ?? 'unknown-curriculum',
          level: group.level,
          learningUnitNodeIds: group.learningUnitIds.map((id) => `learning-unit:${id}`),
          objectiveIds: group.objectiveIds,
        });
      }
      for (const edge of graphData.edges) {
        if (
          !graphConceptIds.has(edge.sourceConceptId) ||
          !graphConceptIds.has(edge.targetConceptId)
        ) {
          addReason(route.reasons, 'stale_graph_binding');
          continue;
        }
        const edgeProvenance = graphProvenance(edge, blockById, activeRevisionByMaterial);
        if (edgeProvenance.some((item) => !item.current || !item.exactQuoteValidated)) {
          addReason(route.reasons, 'stale_graph_binding');
          continue;
        }
        edges.push({
          id: `graph:${edge.id}`,
          sourceNodeId: nodeIdBySource.get(edge.sourceConceptId)!,
          targetNodeId: nodeIdBySource.get(edge.targetConceptId)!,
          kind: edge.relation,
          modes: ['knowledge_structure', 'learning_route'],
          current: true,
          authority: 'validated_concept_graph',
          sourceRecordIds: [edge.id],
          explanation: edge.explanation,
          provenance: edgeProvenance,
        });
      }
      for (const node of allUnitNodes) {
        const unit = node.learningUnit!;
        for (const prerequisite of unit.prerequisiteUnitIds)
          if (unitById.has(prerequisite)) {
            const prerequisiteNode = unitById.get(prerequisite)!;
            const edgeProvenance = curriculumEdgeProvenance(
              node.sourceReferences,
              prerequisiteNode.sourceReferences,
              blockById,
              activeRevisionByMaterial,
            );
            if (edgeProvenance.length === 0) {
              addReason(route.reasons, 'invalid_current_provenance');
              continue;
            }
            edges.push({
              id: `curriculum-prerequisite:${prerequisite}:${node.id}`,
              sourceNodeId: `learning-unit:${prerequisite}`,
              targetNodeId: `learning-unit:${node.id}`,
              kind: 'curriculum_prerequisite',
              modes: ['knowledge_structure', 'learning_progress', 'learning_route'],
              current: routeUsable(),
              authority: 'accepted_curriculum',
              sourceRecordIds: [route.curriculum!.id],
              explanation: 'Accepted Curriculum prerequisite.',
              provenance: edgeProvenance,
            });
          }
        for (const conceptId of unit.conceptIds)
          if (nodeIdBySource.has(conceptId)) {
            const edgeProvenance = curriculumEdgeProvenance(
              node.sourceReferences,
              [],
              blockById,
              activeRevisionByMaterial,
            );
            if (edgeProvenance.length === 0) {
              addReason(route.reasons, 'invalid_current_provenance');
              continue;
            }
            edges.push({
              id: `unit-concept:${node.id}:${conceptId}`,
              sourceNodeId: `learning-unit:${node.id}`,
              targetNodeId: nodeIdBySource.get(conceptId)!,
              kind: 'unit_contains_concept',
              modes: ['knowledge_structure', 'learning_progress', 'learning_route', 'weakness_map'],
              current: routeUsable(),
              authority: 'accepted_curriculum',
              sourceRecordIds: [node.id],
              explanation:
                'Accepted Curriculum associates this LearningUnit with the source concept.',
              provenance: edgeProvenance,
            });
          }
      }
      for (const group of route.curriculum?.synthesisGroups ?? [])
        for (const unitId of group.learningUnitIds)
          if (unitById.has(unitId)) {
            const member = unitById.get(unitId)!;
            const edgeProvenance = curriculumEdgeProvenance(
              member.sourceReferences,
              [],
              blockById,
              activeRevisionByMaterial,
            );
            if (edgeProvenance.length === 0) {
              addReason(route.reasons, 'invalid_current_provenance');
              continue;
            }
            edges.push({
              id: `synthesis-unit:${group.id}:${unitId}`,
              sourceNodeId: `synthesis:${group.id}`,
              targetNodeId: `learning-unit:${unitId}`,
              kind: 'synthesis_includes_unit',
              modes: ['knowledge_structure', 'learning_progress', 'learning_route'],
              current: routeUsable(),
              authority: 'accepted_curriculum',
              sourceRecordIds: [group.id],
              explanation: 'Accepted Curriculum synthesis membership.',
              provenance: edgeProvenance,
            });
          }
      const historyFormal = repos.formalProgression
        .listEvidenceForWorkspace(workspaceId)
        .filter(
          (evidence) =>
            !formalEvidenceByUnit
              .get(evidence.curriculumLearningUnitId)
              ?.some((current) => current.id === evidence.id),
        )
        .map((evidence) => evidence.id);
      const historyAssessmentIds = [
        ...assessmentCurrent.historical,
        ...assessmentRecords.evidence
          .filter(
            (evidence) => !assessmentCurrent.current.some((current) => current.id === evidence.id),
          )
          .map((evidence) => evidence.id),
      ];
      const curriculumHistory = sortedIds(
        repos.curricula
          .list(workspaceId)
          .filter((item) => item.id !== route.curriculum?.id)
          .map((item) => item.id),
      );
      const planHistory = sortedIds(
        repos.studyPlans
          .list(workspaceId)
          .filter((item) => item.id !== route.plan?.id)
          .map((item) => item.id),
      );
      const nodeCandidates = nodes.length;
      const edgeCandidates = edges.length;
      const nodesTruncated = nodeCandidates > 2000;
      const edgesTruncated = edgeCandidates > 4000;
      if (nodesTruncated) addReason(route.reasons, 'node_limit_exceeded');
      if (edgesTruncated) addReason(route.reasons, 'edge_limit_exceeded');
      const projectedNodes = nodes.slice(0, 2000);
      const projectedNodeIds = new Set(projectedNodes.map((node) => node.id));
      const projectedEdges = edges
        .filter(
          (edge) =>
            projectedNodeIds.has(edge.sourceNodeId) && projectedNodeIds.has(edge.targetNodeId),
        )
        .slice(0, 4000);
      const blockingRouteUnknown = route.reasons.some((reason) =>
        ROUTE_BLOCKING_REASONS.has(reason),
      );
      const status: KnowledgeMapProjection['status'] = blockingRouteUnknown
        ? route.contract || route.curriculum
          ? 'unknown'
          : 'unconfigured'
        : route.reasons.length
          ? 'partial'
          : route.current
            ? 'current'
            : 'unconfigured';
      return KnowledgeMapProjectionSchema.parse({
        schemaVersion: 1,
        projectionVersion: 'knowledge-map-projection-v1',
        precedencePolicyVersion: 'knowledge-map-precedence-v1',
        workspaceId,
        generatedAt: clock.now().toISOString(),
        status,
        route: {
          current: route.current && !blockingRouteUnknown,
          courseExecutionVersion: route.state.version,
          executionStatus: route.state.executionStatus,
          validationStatus: route.state.routeValidationStatus,
          contractVersionId: route.contract?.id ?? null,
          curriculumVersionId: route.curriculum?.id ?? null,
          studyPlanVersionId: route.plan?.id ?? null,
          agendaId: route.agenda?.id ?? null,
          executionSourceManifestFingerprint:
            route.plan?.executionSourceManifestFingerprint ?? null,
          unknownReasons: [...new Set(route.reasons)],
        },
        modes: [...MODES],
        nodes: projectedNodes,
        edges: projectedEdges,
        history: {
          supersededCurriculumIds: curriculumHistory.ids,
          supersededStudyPlanIds: planHistory.ids,
          historicalFormalEvidenceIds: sortedIds(historyFormal).ids,
          historicalAssessmentEvidenceIds: sortedIds(historyAssessmentIds).ids,
          truncated:
            curriculumHistory.truncated ||
            planHistory.truncated ||
            historyFormal.length > 500 ||
            historyAssessmentIds.length > 500,
        },
        limits: {
          maxNodes: 2000,
          maxEdges: 4000,
          totalNodeCandidates: nodeCandidates,
          totalEdgeCandidates: edgeCandidates,
          nodesTruncated,
          edgesTruncated,
        },
      });
    },
  };
}

export function parseKnowledgeMapResponse(value: unknown) {
  return KnowledgeMapProjectionResponseSchema.parse(value);
}
