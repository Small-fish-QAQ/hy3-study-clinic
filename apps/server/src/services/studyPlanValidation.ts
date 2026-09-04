import {
  ApiErrorCode,
  CreateAssessmentRequestSchema,
  fnv1a32,
  type AgendaLaunchCapability,
  type AssessmentMode,
  type CoverageRiskEntry,
  type Curriculum,
  type CurriculumNode,
  type LearningContract,
  type ProposedStudyPlanDeferral,
  type SessionAgendaItem,
  type StudyPlan,
  type StudyPlanDiffOperation,
  type StudyPlanFeasibility,
  type StudyPlanItem,
  type StudyPlanItemKind,
  type StudyPlanItemPlannability,
  type StudyPlanPlannabilityRemedy,
  type StudyPlanProposalPayload,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import { searchRetrievalUnits, visualDerivationToRetrievalUnit } from '../retrieval/lexical.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import {
  checkActivityCapability,
  createActivityCapabilityReadSnapshot,
  type ActivityCapabilityReadSnapshot,
} from './activityLaunch.js';
import {
  validateDetailedStudyPlanProposal,
  type DetailedStudyPlanScope,
} from '../llm/studyPlanContract.js';
import {
  listAcceptedAdvisoryVisuals,
  visualAwareManifestFingerprintFromAcceptedVisuals,
  visualManifestMatchesCurrentDerivations,
  type AcceptedAdvisoryVisual,
} from './advisoryVisuals.js';
import { resolveReviewTargetContext } from './reviewSuccessor.js';
import { deriveTeachingConstruct } from './teachingConstruct.js';
import {
  resolveTeachingSlotFeasibility,
  type TeachingSlotArithmeticErrorCode,
} from './teachingSkeletonPlanner.js';

export const STUDY_PLAN_COMPLETION_POLICY_ID = 'learning-unit-completion';
export const STUDY_PLAN_COMPLETION_POLICY_VERSION = 1;
export const PACE_BASELINE_POLICY_VERSION = 'pace-baseline-v1';

const AGENDA_KIND_BY_PLAN_KIND: Record<StudyPlanItemKind, SessionAgendaItem['kind']> = {
  teach_unit: 'learning_unit_teaching',
  informal_check: 'informal_check',
  formal_checkpoint: 'formal_checkpoint',
  synthesis: 'synthesis',
  targeted_repair: 'targeted_repair',
  due_review: 'due_review',
  adversarial_readiness: 'adversarial_readiness',
};

function contractAllowsDeferral(contract: LearningContract): boolean {
  // Soft availability is advisory: a provider must not turn an estimate into
  // an autonomous scope reduction. Historical records without the field keep
  // their legacy hard-cap interpretation.
  return (
    (contract.riskTolerance?.allowExplicitDeferral ?? false) &&
    contract.studyBudget.availabilityPolicy !== 'estimate'
  );
}

export interface UnitLaunchProfile {
  curriculumLearningUnitId: string;
  conceptIds: string[];
  allowedItemKinds: StudyPlanItemKind[];
  launchableAssessmentModes: AssessmentMode[];
}

export interface ValidatedStudyPlanProposal {
  items: StudyPlanItem[];
  deferrals: StudyPlan['deferrals'];
  risks: CoverageRiskEntry[];
  launches: Array<{
    planItemId: string;
    launch: AgendaLaunchCapability;
    sourceFingerprint: string;
    validatedAt: string;
  }>;
  knownScopeAccounted: boolean;
  launchabilityValid: boolean;
  errors: string[];
  warnings: string[];
}

function learningUnits(
  curriculum: Curriculum,
): Array<CurriculumNode & { learningUnit: NonNullable<CurriculumNode['learningUnit']> }> {
  return curriculum.nodes.filter(
    (
      node,
    ): node is CurriculumNode & { learningUnit: NonNullable<CurriculumNode['learningUnit']> } =>
      node.kind === 'learning_unit' && node.learningUnit !== null,
  );
}

interface UnitLaunchReadSnapshot {
  activity: ActivityCapabilityReadSnapshot;
  currentVisuals: readonly AcceptedAdvisoryVisual[];
  visualManifestCurrent: boolean;
}

function createUnitLaunchReadSnapshot(
  repos: Repositories,
  workspaceId: string,
  curriculum: Curriculum,
): UnitLaunchReadSnapshot {
  const activity = createActivityCapabilityReadSnapshot(repos, workspaceId);
  const materialById = new Map(
    repos.materials
      .listRouteIdentitiesByWorkspace(workspaceId)
      .map((material) => [material.id, material] as const),
  );
  const acceptedVisuals = curriculum.executionSourceManifest.revisions.flatMap((revision) =>
    listAcceptedAdvisoryVisuals(repos, revision.materialId, revision.materialRevisionId),
  );
  const currentVisuals = acceptedVisuals.filter(({ asset }) => {
    const material = materialById.get(asset.materialId);
    return (
      material?.availability === 'active' && material.activeRevisionId === asset.materialRevisionId
    );
  });
  return {
    activity,
    currentVisuals,
    visualManifestCurrent:
      visualAwareManifestFingerprintFromAcceptedVisuals(
        curriculum.executionSourceManifest.revisions,
        acceptedVisuals,
      ) === curriculum.executionSourceManifest.fingerprint,
  };
}

function assessmentCapability(
  repos: Repositories,
  clock: Clock,
  workspaceId: string,
  mode: AssessmentMode,
  conceptIds: string[],
  snapshot?: ActivityCapabilityReadSnapshot,
): AgendaLaunchCapability {
  const checked = checkActivityCapability(
    repos,
    clock,
    workspaceId,
    { mode, conceptIds },
    snapshot,
  );
  if (
    mode === 'review' &&
    (conceptIds.length === 0 ||
      (checked.ok && (checked.launch.mode !== 'review' || !checked.launch.conceptIds?.length)))
  ) {
    return {
      status: 'blocked',
      capability: 'assessment',
      resourceId: null,
      reason: 'This LearningUnit has no mapped Concept with a due review.',
    };
  }
  return checked.ok
    ? {
        status: 'launchable',
        capability: 'assessment',
        resourceId: JSON.stringify(checked.launch),
        reason: null,
      }
    : {
        status: 'blocked',
        capability: 'assessment',
        resourceId: null,
        reason: checked.reason,
      };
}

/** Resolve the exact current Agenda-to-accepted-Plan authority binding. */
export function resolveAgendaBoundPlanItem(
  repos: Repositories,
  plan: StudyPlan,
  item: SessionAgendaItem,
): { ok: true; planItem: StudyPlanItem } | { ok: false; reason: string } {
  if (item.state !== 'queued' && item.state !== 'active') {
    return { ok: false, reason: `Agenda item state ${item.state} is not authorized.` };
  }
  if (!item.linkedPlanItemId) {
    return { ok: false, reason: 'Agenda item is not linked to an accepted Plan item.' };
  }
  const planItem = plan.items.find((candidate) => candidate.id === item.linkedPlanItemId);
  if (!planItem) return { ok: false, reason: 'The accepted Plan no longer contains this item.' };
  if (item.learningUnitId !== planItem.curriculumLearningUnitId) {
    return { ok: false, reason: 'Agenda and Plan LearningUnit identity do not match.' };
  }

  if (item.kind === 'due_review') {
    try {
      const request = CreateAssessmentRequestSchema.parse(JSON.parse(item.launch.resourceId ?? ''));
      const targetId = request.mode === 'review' ? request.conceptIds?.[0] : undefined;
      const target = targetId ? repos.reviewSuccessor.getTarget(targetId) : undefined;
      const binding =
        target?.currentBindingVersion !== null && target?.currentBindingVersion !== undefined
          ? repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion)
          : undefined;
      if (
        request.conceptIds?.length !== 1 ||
        !target ||
        target.status !== 'active' ||
        !binding ||
        binding.learningUnitId !== planItem.curriculumLearningUnitId ||
        !planItem.objectiveIds.includes(binding.objectiveId)
      ) {
        return { ok: false, reason: 'The due Review target no longer matches this Plan item.' };
      }
      return {
        ok: true,
        planItem: { ...planItem, kind: 'due_review', objectiveIds: [binding.objectiveId] },
      };
    } catch {
      return { ok: false, reason: 'The due Review launch binding is invalid.' };
    }
  }

  if (item.kind === 'targeted_repair' && planItem.kind !== 'targeted_repair') {
    const progress = repos.studyPlans
      .listProgress(plan.id)
      .find((entry) => entry.planItemId === planItem.id);
    if (progress?.state !== 'repair_needed') {
      return { ok: false, reason: 'The linked Plan item no longer requires targeted repair.' };
    }
    return { ok: true, planItem: { ...planItem, kind: 'targeted_repair' } };
  }

  if (item.kind !== AGENDA_KIND_BY_PLAN_KIND[planItem.kind]) {
    return { ok: false, reason: 'Agenda item kind is inconsistent with its accepted Plan item.' };
  }
  return { ok: true, planItem };
}

export function resolveLaunchForPlanItem(
  repos: Repositories,
  clock: Clock,
  workspaceId: string,
  curriculum: Curriculum,
  item: Pick<StudyPlanItem, 'kind' | 'curriculumLearningUnitId' | 'objectiveIds'>,
  snapshot?: UnitLaunchReadSnapshot,
): AgendaLaunchCapability {
  const unit = item.curriculumLearningUnitId
    ? learningUnits(curriculum).find((candidate) => candidate.id === item.curriculumLearningUnitId)
    : undefined;
  const conceptIds = unit?.learningUnit.conceptIds ?? [];
  switch (item.kind) {
    case 'teach_unit': {
      const conceptId = conceptIds.find((id) =>
        snapshot ? snapshot.activity.conceptsById.has(id) : repos.materials.getConcept(id),
      );
      const currentVisuals = unit
        ? snapshot
          ? snapshot.currentVisuals
          : curriculum.executionSourceManifest.revisions.flatMap((revision) => {
              const material = repos.materials.getRouteIdentity(revision.materialId);
              if (
                material?.workspaceId !== workspaceId ||
                material.availability !== 'active' ||
                material.activeRevisionId !== revision.materialRevisionId
              ) {
                return [];
              }
              return listAcceptedAdvisoryVisuals(
                repos,
                revision.materialId,
                revision.materialRevisionId,
              );
            })
        : [];
      const visualManifestCurrent = snapshot
        ? snapshot.visualManifestCurrent
        : visualManifestMatchesCurrentDerivations(repos, curriculum.executionSourceManifest);
      const visualQuery = unit
        ? [
            unit.title,
            ...unit.learningUnit.objectives.flatMap((objective) => [
              objective.title,
              objective.description,
            ]),
          ].join(' ')
        : '';
      const hasCurrentVisual =
        visualManifestCurrent &&
        searchRetrievalUnits(
          [],
          currentVisuals.map(({ derivation }) => visualDerivationToRetrievalUnit(derivation)),
          visualQuery,
          { limit: 1 },
        ).some((result) => result.kind === 'visual_derivation');
      return conceptId || hasCurrentVisual
        ? {
            status: 'launchable',
            capability: 'lesson',
            resourceId: JSON.stringify({ learningUnitId: unit!.id, conceptId: conceptId ?? null }),
            reason: null,
          }
        : {
            status: 'blocked',
            capability: 'lesson',
            resourceId: null,
            reason: visualManifestCurrent
              ? 'This LearningUnit has no current source Concept or accepted advisory visual for lesson launch.'
              : 'The accepted Course visual source manifest is stale; prepare a new Course route before lesson launch.',
          };
    }
    case 'formal_checkpoint':
      return assessmentCapability(
        repos,
        clock,
        workspaceId,
        'concept_practice',
        conceptIds,
        snapshot?.activity,
      );
    case 'targeted_repair':
      return assessmentCapability(
        repos,
        clock,
        workspaceId,
        'prerequisite_repair',
        conceptIds,
        snapshot?.activity,
      );
    case 'due_review': {
      if (!unit) {
        return {
          status: 'blocked',
          capability: 'assessment',
          resourceId: null,
          reason: 'This Review item has no exact Curriculum LearningUnit binding.',
        };
      }
      const objectiveIds = new Set(item.objectiveIds);
      const reviewTargetIds = (
        snapshot?.activity.currentReviewItems ?? repos.reviewSuccessor.listCurrent(workspaceId)
      ).flatMap(({ target }) => {
        const context = snapshot
          ? snapshot.activity.reviewContextByTargetId.get(target.id)
          : resolveReviewTargetContext(repos, target.id);
        return context &&
          context.binding.learningUnitId === unit.id &&
          objectiveIds.has(context.binding.objectiveId) &&
          context.conceptIds.some((conceptId) => conceptIds.includes(conceptId))
          ? [target.id]
          : [];
      });
      return assessmentCapability(
        repos,
        clock,
        workspaceId,
        'review',
        reviewTargetIds,
        snapshot?.activity,
      );
    }
    case 'synthesis': {
      const group = curriculum.synthesisGroups.find(
        (candidate) =>
          Boolean(item.curriculumLearningUnitId) &&
          candidate.learningUnitIds.includes(item.curriculumLearningUnitId!) &&
          item.objectiveIds.every((objectiveId) => candidate.objectiveIds.includes(objectiveId)),
      );
      if (!group || group.learningUnitIds.length < 2) {
        return {
          status: 'blocked',
          capability: 'assessment',
          resourceId: null,
          reason: 'Synthesis requires a validated multi-unit Curriculum synthesis group.',
        };
      }
      const synthesisConceptIds = learningUnits(curriculum)
        .filter((candidate) => group.learningUnitIds.includes(candidate.id))
        .flatMap((candidate) => candidate.learningUnit.conceptIds)
        .filter((id, index, all) => all.indexOf(id) === index)
        .slice(0, 3);
      return assessmentCapability(
        repos,
        clock,
        workspaceId,
        'concept_practice',
        synthesisConceptIds,
        snapshot?.activity,
      );
    }
    case 'informal_check':
      return {
        status: 'blocked',
        capability: 'study_session',
        resourceId: null,
        reason: 'Conversational informal checks become launchable in Phase 3.',
      };
    case 'adversarial_readiness':
      return {
        status: 'blocked',
        capability: 'adversarial_readiness',
        resourceId: null,
        reason: 'Adversarial readiness is intentionally deferred until Phase 5.',
      };
  }
}

export function buildUnitLaunchProfiles(
  repos: Repositories,
  clock: Clock,
  workspaceId: string,
  curriculum: Curriculum,
): UnitLaunchProfile[] {
  const snapshot = createUnitLaunchReadSnapshot(repos, workspaceId, curriculum);
  return learningUnits(curriculum).map((unit) => {
    const candidates: Array<{ kind: StudyPlanItemKind; mode?: AssessmentMode }> = [
      { kind: 'teach_unit' },
      { kind: 'formal_checkpoint', mode: 'concept_practice' },
      { kind: 'targeted_repair', mode: 'prerequisite_repair' },
      { kind: 'due_review', mode: 'review' },
      { kind: 'synthesis', mode: 'cross_document' },
    ];
    const allowedItemKinds: StudyPlanItemKind[] = [];
    const launchableAssessmentModes: AssessmentMode[] = [];
    for (const candidate of candidates) {
      const launch = resolveLaunchForPlanItem(
        repos,
        clock,
        workspaceId,
        curriculum,
        {
          kind: candidate.kind,
          curriculumLearningUnitId: unit.id,
          objectiveIds: unit.learningUnit.objectives.map((objective) => objective.id),
        },
        snapshot,
      );
      if (launch.status !== 'launchable') continue;
      allowedItemKinds.push(candidate.kind);
      if (candidate.mode) launchableAssessmentModes.push(candidate.mode);
    }
    return {
      curriculumLearningUnitId: unit.id,
      conceptIds: unit.learningUnit.conceptIds,
      allowedItemKinds,
      launchableAssessmentModes,
    };
  });
}

function objectiveMap(curriculum: Curriculum) {
  return new Map(
    learningUnits(curriculum).flatMap((unit) =>
      unit.learningUnit.objectives.map((objective) => [objective.id, { unit, objective }] as const),
    ),
  );
}

function synthesisGroupForItem(curriculum: Curriculum, item: StudyPlanItem) {
  if (item.kind !== 'synthesis' || !item.curriculumLearningUnitId) return undefined;
  return curriculum.synthesisGroups.find(
    (group) =>
      group.learningUnitIds.length >= 2 &&
      group.learningUnitIds.includes(item.curriculumLearningUnitId!) &&
      item.objectiveIds.every((objectiveId) => group.objectiveIds.includes(objectiveId)),
  );
}

function stableRiskFingerprint(contractId: string, deferral: ProposedStudyPlanDeferral): string {
  return fnv1a32(
    JSON.stringify({
      contractId,
      unitId: deferral.curriculumLearningUnitId,
      objectiveIds: [...deferral.objectiveIds].sort(),
    }),
  )
    .toString(16)
    .padStart(8, '0');
}

export function materializeDeferralRisk(
  contract: LearningContract,
  curriculum: Curriculum,
  deferral: ProposedStudyPlanDeferral,
  at: string,
  options: { id?: string; learnerDecisionId?: string | null; learnerAccepted?: boolean } = {},
): CoverageRiskEntry {
  const unit = learningUnits(curriculum).find(
    (candidate) => candidate.id === deferral.curriculumLearningUnitId,
  )!;
  const deferredObjectives = unit.learningUnit.objectives.filter((objective) =>
    deferral.objectiveIds.includes(objective.id),
  );
  const statuses = new Set(deferredObjectives.map((objective) => objective.truthPremiseStatus));
  const truthPremiseStatus = statuses.has('conflicted')
    ? 'conflicted'
    : statuses.size === 1 && statuses.has('independently_verified')
      ? 'independently_verified'
      : 'unverified';
  const truthAuthorityRecordIds = [
    ...new Set(deferredObjectives.flatMap((objective) => objective.truthAuthorityRecordIds)),
  ];
  const sourceReferences = unit.sourceReferences.filter((reference) => reference.sourceBlockId);
  const materialIds = [...new Set(sourceReferences.map((reference) => reference.materialId))];
  const fingerprint = stableRiskFingerprint(contract.id, deferral);
  const learnerAccepted = options.learnerAccepted === true;
  return {
    id: options.id ?? `risk_deferral_${fingerprint}`,
    workspaceId: contract.workspaceId,
    contractVersionId: contract.id,
    stableScopeFingerprint: fingerprint,
    materialId: materialIds.length === 1 ? materialIds[0]! : null,
    topicId: null,
    objectiveId: deferral.objectiveIds.length === 1 ? deferral.objectiveIds[0]! : null,
    facets: [learnerAccepted ? 'intentionally_deferred' : 'planning_recommendation'],
    scopeAuthorityStatus: 'in_scope',
    truthPremiseStatus,
    truthAuthorityRecordIds,
    referencedCurriculumNodeIds: [unit.id],
    referencedConceptIds: unit.learningUnit.conceptIds,
    referencedEvidenceIds: [],
    origin: 'deterministic',
    status: learnerAccepted ? 'deferred' : 'planned',
    severity: 'medium',
    priority: 50,
    contractSensitive: true,
    claim: learnerAccepted
      ? `The learner accepted leaving ${unit.title} unfinished in this route.`
      : `The route recommends postponing ${unit.title}; this is not learner acceptance.`,
    uncertainty: learnerAccepted
      ? 'The accepted route retains an unresolved visible coverage gap.'
      : 'This planning recommendation may be rejected or changed before acceptance.',
    observations: sourceReferences.slice(0, 20).map((reference, index) => ({
      id: `risk_observation_${fingerprint}_${index + 1}`,
      materialRevisionId: reference.materialRevisionId,
      sourceBlockId: reference.sourceBlockId,
      sourceBlockRevisionFingerprint: reference.sourceBlockRevisionFingerprint,
      executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      reconciliationStatus: 'current',
      observedAt: at,
      lastVerifiedAt: at,
    })),
    resolutionEvidenceIds: [],
    learnerDecisionId: learnerAccepted ? (options.learnerDecisionId ?? null) : null,
    provider: null,
    providerModel: null,
    promptVersion: null,
    firstObservedAt: at,
    updatedAt: at,
  };
}

/** Local coverage and authority checks used for provider proposals and learner edits. */
export function validateStudyPlanScopeAccounting(
  curriculum: Curriculum,
  items: StudyPlanItem[],
  deferrals: StudyPlan['deferrals'],
): string[] {
  const errors: string[] = [];
  const objectives = objectiveMap(curriculum);
  const itemIndex = new Map(items.map((item) => [item.id, item.index]));
  const planned = new Set<string>();
  const deferred = new Set<string>();

  for (const item of items) {
    const synthesisGroup = synthesisGroupForItem(curriculum, item);
    for (const prerequisiteId of item.prerequisitePlanItemIds) {
      const prerequisiteIndex = itemIndex.get(prerequisiteId);
      if (prerequisiteIndex === undefined) {
        errors.push(`Plan item ${item.id} references an unknown prerequisite item.`);
      } else if (prerequisiteIndex >= item.index) {
        errors.push(`Plan item ${item.id} has a prerequisite that does not precede it.`);
      }
    }
    for (const objectiveId of item.objectiveIds) {
      const owner = objectives.get(objectiveId);
      if (!owner) {
        errors.push(`Unknown Curriculum objective: ${objectiveId}.`);
        continue;
      }
      if (
        item.curriculumLearningUnitId &&
        owner.unit.id !== item.curriculumLearningUnitId &&
        !synthesisGroup?.learningUnitIds.includes(owner.unit.id)
      ) {
        errors.push(
          `Objective ${objectiveId} does not belong to LearningUnit ${item.curriculumLearningUnitId}.`,
        );
      }
      planned.add(objectiveId);
    }
    for (const requirement of item.completionRequirements) {
      for (const objectiveId of requirement.objectiveIds) {
        const objective = objectives.get(objectiveId)?.objective;
        if (!item.objectiveIds.includes(objectiveId)) {
          errors.push(`Completion requirement escapes Plan item ${item.id} objective scope.`);
        }
        if (requirement.blocking && objective?.truthPremiseStatus !== 'independently_verified') {
          errors.push(`Truth-unverified objective ${objectiveId} cannot block Plan completion.`);
        }
      }
    }
  }

  for (const deferral of deferrals) {
    const unit = learningUnits(curriculum).find(
      (candidate) => candidate.id === deferral.curriculumLearningUnitId,
    );
    if (!unit) {
      errors.push(
        `Deferral references unknown LearningUnit: ${deferral.curriculumLearningUnitId}.`,
      );
      continue;
    }
    if (deferral.objectiveIds.length === 0) {
      errors.push(`Deferral for ${unit.title} has no objectives.`);
    }
    for (const objectiveId of deferral.objectiveIds) {
      const owner = objectives.get(objectiveId);
      if (!owner || owner.unit.id !== unit.id) {
        errors.push(
          `Deferral objective ${objectiveId} does not belong to LearningUnit ${unit.id}.`,
        );
        continue;
      }
      if (deferred.has(objectiveId)) {
        errors.push(`Objective ${objectiveId} is deferred more than once.`);
      }
      deferred.add(objectiveId);
    }
  }

  for (const objectiveId of planned) {
    if (deferred.has(objectiveId)) {
      errors.push(`Objective ${objectiveId} cannot be both planned and deferred.`);
    }
  }
  for (const objectiveId of objectives.keys()) {
    if (!planned.has(objectiveId) && !deferred.has(objectiveId)) {
      errors.push(`Known Curriculum objective is omitted: ${objectiveId}.`);
    }
  }
  return [...new Set(errors)].slice(0, 100);
}

function completionRequirements(
  curriculum: Curriculum,
  item: StudyPlanProposalPayload['items'][number],
) {
  if (item.kind !== 'formal_checkpoint') return [];
  const objectives = objectiveMap(curriculum);
  return item.objectiveIds.map((objectiveId) => {
    const objective = objectives.get(objectiveId)?.objective;
    const blocking = objective?.truthPremiseStatus === 'independently_verified';
    return {
      id: newId('completion_requirement'),
      objectiveIds: [objectiveId],
      description: blocking
        ? `Record eligible formal evidence for ${objective?.title ?? objectiveId}.`
        : `Use this result as advisory evidence for ${objective?.title ?? objectiveId}.`,
      blocking,
      admissibilityTier: blocking
        ? ('tier_1_authorized_truth' as const)
        : ('tier_3_advisory' as const),
    };
  });
}

function objectivePriority(
  curriculum: Curriculum,
  objectiveIds: string[],
): { priority?: StudyPlanItem['priority']; rationale?: string } {
  const priorities = new Map(
    ['optional', 'normal', 'high', 'required'].map((value, index) => [value, index]),
  );
  const objectives = objectiveMap(curriculum);
  const selected = objectiveIds
    .map((id) => objectives.get(id)?.objective)
    .filter((objective): objective is NonNullable<typeof objective> => Boolean(objective));
  const best = selected
    .map((objective) => objective.priority)
    .filter((priority): priority is NonNullable<typeof priority> => Boolean(priority))
    .sort((left, right) => priorities.get(right)! - priorities.get(left)!)[0];
  if (!best) return {};
  const rationale = selected.find((objective) => objective.priority === best)?.priorityRationale;
  return { priority: best, ...(rationale ? { rationale } : {}) };
}

export function validateAndMaterializeStudyPlanProposal(input: {
  repos: Repositories;
  clock: Clock;
  contract: LearningContract;
  curriculum: Curriculum;
  proposal: StudyPlanProposalPayload;
  profiles: UnitLaunchProfile[];
  manifestFingerprint: string;
  createdAt: string;
}): ValidatedStudyPlanProposal {
  const { repos, clock, contract, curriculum, proposal, profiles, manifestFingerprint, createdAt } =
    input;
  const errors: string[] = [];
  const warnings: string[] = [];
  const units = learningUnits(curriculum);
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const objectives = objectiveMap(curriculum);
  const profilesByUnit = new Map(
    profiles.map((profile) => [profile.curriculumLearningUnitId, profile]),
  );
  const providerScope: DetailedStudyPlanScope = {
    units: units.map((unit) => ({
      id: unit.id,
      objectiveIds: unit.learningUnit.objectives.map((objective) => objective.id),
      prerequisiteUnitIds: unit.learningUnit.prerequisiteUnitIds,
    })),
    synthesisGroups: curriculum.synthesisGroups.map((group) => ({
      learningUnitIds: group.learningUnitIds,
      objectiveIds: group.objectiveIds,
    })),
    requiredLearningUnitIds: units.map((unit) => unit.id),
    allowedDepths: ['pass_oriented', 'working_fluency', 'high_performance', 'deep_transfer'],
    launchCapabilities: profiles.map((profile) => ({
      curriculumLearningUnitId: profile.curriculumLearningUnitId,
      allowedItemKinds: profile.allowedItemKinds,
    })),
    allowExplicitDeferral: contractAllowsDeferral(contract),
  };
  errors.push(...validateDetailedStudyPlanProposal(proposal, providerScope));
  const itemIdByKey = new Map(proposal.items.map((item) => [item.key, newId('plan_item')]));
  const planned = new Map<string, Set<string>>();

  const items: StudyPlanItem[] = proposal.items.map((item, index) => {
    const unit = item.curriculumLearningUnitId
      ? unitsById.get(item.curriculumLearningUnitId)
      : undefined;
    if (item.curriculumLearningUnitId && !unit)
      errors.push(`Unknown LearningUnit: ${item.curriculumLearningUnitId}`);
    if (unit && !profilesByUnit.get(unit.id)?.allowedItemKinds.includes(item.kind)) {
      errors.push(`Plan item ${item.key} is not currently launchable as ${item.kind}.`);
    }
    for (const objectiveId of item.objectiveIds) {
      const owner = objectives.get(objectiveId);
      if (!owner) errors.push(`Unknown Curriculum objective: ${objectiveId}`);
      const synthesisGroup = synthesisGroupForItem(curriculum, {
        id: item.key,
        index,
        phase: item.phase,
        kind: item.kind,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        rationale: item.rationale,
        estimatedMinutes: item.estimatedMinutes,
        targetDepth: item.targetDepth,
        objectiveIds: item.objectiveIds,
        prerequisitePlanItemIds: [],
        completionPolicy: null,
        completionRequirements: [],
      });
      if (
        unit &&
        owner &&
        owner.unit.id !== unit.id &&
        !synthesisGroup?.learningUnitIds.includes(owner.unit.id)
      ) {
        errors.push(`Objective ${objectiveId} does not belong to LearningUnit ${unit.id}.`);
      }
      if (unit) {
        const set = planned.get(unit.id) ?? new Set<string>();
        set.add(objectiveId);
        planned.set(unit.id, set);
        if (synthesisGroup && owner && owner.unit.id !== unit.id) {
          const ownerSet = planned.get(owner.unit.id) ?? new Set<string>();
          ownerSet.add(objectiveId);
          planned.set(owner.unit.id, ownerSet);
        }
      }
    }
    const emphasis = objectivePriority(curriculum, item.objectiveIds);

    return {
      id: itemIdByKey.get(item.key)!,
      index,
      phase: item.phase,
      kind: item.kind,
      curriculumLearningUnitId: item.curriculumLearningUnitId,
      rationale: item.rationale,
      estimatedMinutes: item.estimatedMinutes,
      targetDepth: item.targetDepth,
      objectiveIds: item.objectiveIds,
      prerequisitePlanItemIds: item.prerequisiteItemKeys.map((key) => itemIdByKey.get(key)!),
      completionPolicy:
        item.kind === 'formal_checkpoint'
          ? { id: STUDY_PLAN_COMPLETION_POLICY_ID, version: STUDY_PLAN_COMPLETION_POLICY_VERSION }
          : null,
      completionRequirements: completionRequirements(curriculum, item),
      ...(emphasis.priority ? { priority: emphasis.priority } : {}),
      ...(emphasis.rationale ? { priorityRationale: emphasis.rationale } : {}),
    };
  });

  const deferrals: StudyPlan['deferrals'] = [];
  const risks: CoverageRiskEntry[] = [];
  const deferred = new Map<string, Set<string>>();
  for (const deferral of proposal.deferrals) {
    const unit = unitsById.get(deferral.curriculumLearningUnitId);
    if (!unit) {
      errors.push(`Deferral references unknown LearningUnit: ${deferral.curriculumLearningUnitId}`);
      continue;
    }
    if (!contractAllowsDeferral(contract)) {
      errors.push(`Contract policy does not allow deferring ${unit.title}.`);
      continue;
    }
    const allowedObjectives = new Set(
      unit.learningUnit.objectives.map((objective) => objective.id),
    );
    if (deferral.objectiveIds.length === 0)
      errors.push(`Deferral for ${unit.title} has no objectives.`);
    if (deferral.objectiveIds.some((objectiveId) => !allowedObjectives.has(objectiveId))) {
      errors.push(`Deferral for ${unit.title} contains an objective outside that unit.`);
      continue;
    }
    const overlap = deferral.objectiveIds.filter((objectiveId) =>
      planned.get(unit.id)?.has(objectiveId),
    );
    if (overlap.length > 0) {
      errors.push(`Objectives cannot be both planned and deferred: ${overlap.join(', ')}.`);
      continue;
    }
    const risk = materializeDeferralRisk(contract, curriculum, deferral, createdAt);
    risks.push(risk);
    deferrals.push({
      curriculumLearningUnitId: unit.id,
      objectiveIds: deferral.objectiveIds,
      reason: deferral.reason,
      riskIds: [risk.id],
    });
    deferred.set(unit.id, new Set(deferral.objectiveIds));
  }

  for (const unit of units) {
    for (const objective of unit.learningUnit.objectives) {
      if (!planned.get(unit.id)?.has(objective.id) && !deferred.get(unit.id)?.has(objective.id)) {
        errors.push(`Known Curriculum objective is omitted: ${objective.id}.`);
      }
    }
  }

  errors.push(...validateStudyPlanScopeAccounting(curriculum, items, deferrals));

  const launches = items.map((item) => ({
    planItemId: item.id,
    launch: resolveLaunchForPlanItem(repos, clock, contract.workspaceId, curriculum, item),
    sourceFingerprint: manifestFingerprint,
    validatedAt: createdAt,
  }));
  for (const entry of launches) {
    if (entry.launch.status !== 'launchable') {
      errors.push(
        `Plan item ${entry.planItemId} is not launchable: ${entry.launch.reason ?? 'blocked'}`,
      );
    }
  }
  if (items.every((item) => item.kind !== 'formal_checkpoint')) {
    warnings.push('The proposed route has no formal checkpoint yet.');
  }
  return {
    items,
    deferrals,
    risks,
    launches,
    knownScopeAccounted: !errors.some((error) => error.includes('omitted')),
    launchabilityValid: launches.every((entry) => entry.launch.status === 'launchable'),
    errors: errors.slice(0, 100),
    warnings: warnings.slice(0, 100),
  };
}

/**
 * Local Lesson slot limits, the same constants Lesson preparation passes to the
 * planner (`teachingBriefPreparation.ts` `limits.maxSegments` and its literal 8).
 */
const LESSON_MAX_SLOTS = 12;
const LESSON_MAX_PRACTICE_SLOTS = 8;

/**
 * Remedies that are semantically valid for each arithmetic failure, derived from the
 * code alone.
 *
 * `lesson_slot_limit_exceeded` deliberately omits `increase_minutes`: the 12-slot
 * ceiling is a count, not a budget, so adding minutes cannot repair it. Offering
 * `resize_time` there would be a false statement to the learner.
 */
const PLANNABILITY_REMEDIES: Record<
  TeachingSlotArithmeticErrorCode,
  StudyPlanPlannabilityRemedy[]
> = {
  lesson_slot_limit_exceeded: ['reduce_depth', 'revise_plan_structure'],
  practice_slot_limit_exceeded: ['revise_plan_structure'],
  protected_budget_exceeds_agenda: ['increase_minutes', 'reduce_depth'],
  planned_budget_exceeds_agenda: ['increase_minutes', 'reduce_depth'],
  agenda_budget_underfilled: ['reduce_minutes', 'raise_depth'],
};

export interface StudyPlanItemPlannabilityResult {
  plannability: StudyPlanItemPlannability;
  /** Raw planner `details`, for the acceptance error payload. Not learner-facing. */
  details: Record<string, unknown>;
  message: string;
}

/**
 * Per-item Lesson plannability, structurally parallel to `resolveLaunchForPlanItem`:
 * deterministic, provider-free, and computed from the accepted Curriculum plus the
 * item's own `targetDepth` and `estimatedMinutes`.
 *
 * Reads no authority envelope and fabricates none. Only the arithmetic class is
 * decidable here; `objective_authority_unavailable` and
 * `construct_authority_incompatible` need retrieval-derived authority that first
 * exists at Lesson preparation, and stay reachable there.
 *
 * Returns `null` for a feasible item, a non-teaching item, or an item whose objectives
 * are not resolvable from the curriculum, since those are already refused by scope
 * accounting and launchability.
 */
export function resolveTeachingItemPlannability(
  curriculum: Curriculum,
  item: Pick<
    StudyPlanItem,
    'id' | 'kind' | 'curriculumLearningUnitId' | 'objectiveIds' | 'targetDepth' | 'estimatedMinutes'
  >,
): StudyPlanItemPlannabilityResult | null {
  if (item.kind !== 'teach_unit') return null;
  const objectives = objectiveMap(curriculum);
  const resolved = item.objectiveIds.flatMap((objectiveId, index) => {
    const owner = objectives.get(objectiveId);
    if (!owner) return [];
    return [
      {
        // The planner indexes objectives positionally as O1..On; Lesson preparation
        // builds the same refs from the same ordered objective list.
        objectiveRef: `O${index + 1}`,
        construct: deriveTeachingConstruct(owner.objective),
        priority: owner.objective.priority ?? 'normal',
      },
    ];
  });
  if (resolved.length === 0 || resolved.length !== item.objectiveIds.length) return null;
  const verdict = resolveTeachingSlotFeasibility({
    targetMinutes: item.estimatedMinutes,
    targetDepth: item.targetDepth,
    maxLessonSlots: LESSON_MAX_SLOTS,
    maxPracticeSlots: LESSON_MAX_PRACTICE_SLOTS,
    objectives: resolved,
  });
  if (verdict.feasible) return null;
  return {
    plannability: {
      planItemId: item.id,
      curriculumLearningUnitId: item.curriculumLearningUnitId,
      planningCode: verdict.code,
      targetDepth: item.targetDepth,
      estimatedMinutes: item.estimatedMinutes,
      remedies: PLANNABILITY_REMEDIES[verdict.code],
    },
    details: verdict.details,
    message: verdict.message,
  };
}

/** Every arithmetically unplannable teaching item in a plan, in item order. */
export function resolveStudyPlanPlannability(
  curriculum: Curriculum,
  items: StudyPlanItem[],
): StudyPlanItemPlannabilityResult[] {
  return items.flatMap((item) => {
    const result = resolveTeachingItemPlannability(curriculum, item);
    return result ? [result] : [];
  });
}

const MIN_SUPPORTED_LESSON_MINUTES = 1;
const MAX_SUPPORTED_LESSON_MINUTES = 480;

/**
 * Derive canonical teaching durations from the local Lesson planner. Provider- or
 * learner-supplied minutes are compatibility input only and never act as a lower bound.
 */
export function deriveTeachUnitDurations(
  curriculum: Curriculum,
  items: StudyPlanItem[],
): { derivedItems: StudyPlanItem[]; structurallyInfeasible: string[] } {
  const structurallyInfeasible: string[] = [];
  const derivedItems = items.map((item) => {
    if (item.kind !== 'teach_unit') return item;

    const feasibleMinimum = findMinimumFeasibleDuration(curriculum, {
      kind: item.kind,
      curriculumLearningUnitId: item.curriculumLearningUnitId,
      objectiveIds: item.objectiveIds,
      targetDepth: item.targetDepth,
    });

    if (feasibleMinimum === null) {
      structurallyInfeasible.push(item.id);
      return item;
    }

    return { ...item, estimatedMinutes: feasibleMinimum };
  });

  return { derivedItems, structurallyInfeasible };
}

/** Fail closed before a new proposal identity/version can be persisted. */
export function deriveTeachUnitDurationsOrThrow(
  curriculum: Curriculum,
  items: StudyPlanItem[],
): StudyPlanItem[] {
  const { derivedItems, structurallyInfeasible } = deriveTeachUnitDurations(curriculum, items);
  if (structurallyInfeasible.length === 0) return derivedItems;

  throw new AppError(
    ApiErrorCode.ValidationError,
    `This StudyPlan contains teaching items that are structurally infeasible across the entire planner domain [${MIN_SUPPORTED_LESSON_MINUTES}, ${MAX_SUPPORTED_LESSON_MINUTES} minutes]. Revise the selected depth or objective structure.`,
    {
      reason: 'lesson_plannability_structurally_infeasible',
      recommendationRequired: true,
      items: structurallyInfeasible.map((planItemId) => {
        const item = items.find((candidate) => candidate.id === planItemId);
        return {
          planItemId,
          targetDepth: item?.targetDepth,
          objectiveCount: item?.objectiveIds.length,
        };
      }),
    },
  );
}

/**
 * Find the minimum feasible duration for a teach_unit at the given depth and
 * objectives. Returns the smallest `targetMinutes` that makes the planner succeed,
 * or null if no feasible duration exists in the supported domain [1, 480].
 *
 * No monotonicity assumption is made. The supported domain is deliberately small, so
 * every duration is checked in ascending order and the first exact feasible result wins.
 */
export function findMinimumFeasibleDuration(
  curriculum: Curriculum,
  item: Pick<StudyPlanItem, 'kind' | 'curriculumLearningUnitId' | 'objectiveIds' | 'targetDepth'>,
): number | null {
  if (item.kind !== 'teach_unit') return null;
  if (item.objectiveIds.length === 0) return null;

  const objectives = objectiveMap(curriculum);
  const resolved = item.objectiveIds.flatMap((objectiveId, index) => {
    const owner = objectives.get(objectiveId);
    if (!owner) return [];
    return [
      {
        objectiveRef: `O${index + 1}`,
        construct: deriveTeachingConstruct(owner.objective),
        priority: owner.objective.priority ?? 'normal',
      },
    ];
  });

  // If any objectives couldn't be resolved, cannot determine feasibility.
  if (resolved.length !== item.objectiveIds.length) return null;

  const arithmeticInput = {
    targetDepth: item.targetDepth,
    maxLessonSlots: LESSON_MAX_SLOTS,
    maxPracticeSlots: LESSON_MAX_PRACTICE_SLOTS,
    objectives: resolved,
  };

  for (
    let targetMinutes = MIN_SUPPORTED_LESSON_MINUTES;
    targetMinutes <= MAX_SUPPORTED_LESSON_MINUTES;
    targetMinutes += 1
  ) {
    if (resolveTeachingSlotFeasibility({ ...arithmeticInput, targetMinutes }).feasible) {
      return targetMinutes;
    }
  }

  return null;
}

/** Bounded learner-facing warning text. Wording is chosen by code, never generic. */
export function plannabilityWarningText(entry: StudyPlanItemPlannability): string {
  const shared = `Plan item ${entry.planItemId} cannot yet be planned as a Lesson at ${entry.targetDepth} in ${entry.estimatedMinutes} minutes`;
  switch (entry.planningCode) {
    case 'lesson_slot_limit_exceeded':
      return `${shared}: it needs more teaching segments than one Lesson allows. Lower the depth for this item, or revise the proposed route. A longer session cannot resolve a segment limit.`;
    case 'practice_slot_limit_exceeded':
      return `${shared}: it needs more Practice slots than one Lesson allows. Revise the proposed route for this item.`;
    case 'protected_budget_exceeds_agenda':
    case 'planned_budget_exceeds_agenda':
      return `${shared}: the required teaching does not fit the session length. Give this item more minutes, or lower its depth.`;
    case 'agenda_budget_underfilled':
      return `${shared}: the session is longer than the planned teaching can honestly fill. Give this item fewer minutes, or raise its depth.`;
  }
}

export function planFeasibilityFromContract(
  availableMinutes: number | null,
  projectedMinutes: number,
  state: StudyPlanFeasibility['state'],
  assumptions: string[],
): StudyPlanFeasibility {
  return {
    projectedMinutes,
    availableMinutes,
    slackMinutes: availableMinutes === null ? null : availableMinutes - projectedMinutes,
    state,
    assumptions,
  };
}

export function diffStudyPlans(
  previous: StudyPlan | undefined,
  items: StudyPlanItem[],
): StudyPlanDiffOperation[] {
  if (!previous) {
    return items.map((item) => ({
      kind: 'added',
      planItemId: item.id,
      curriculumLearningUnitId: item.curriculumLearningUnitId,
      beforeIndex: null,
      afterIndex: item.index,
      beforeMinutes: null,
      afterMinutes: item.estimatedMinutes,
      reason: 'Added to the first executable route.',
    }));
  }
  const operations: StudyPlanDiffOperation[] = [];
  const previousByRouteKey = new Map(
    previous.items.map((item) => [`${item.kind}:${item.curriculumLearningUnitId ?? 'none'}`, item]),
  );
  const nextKeys = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}:${item.curriculumLearningUnitId ?? 'none'}`;
    nextKeys.add(key);
    const before = previousByRouteKey.get(key);
    if (!before) {
      operations.push({
        kind: 'added',
        planItemId: item.id,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        beforeIndex: null,
        afterIndex: item.index,
        beforeMinutes: null,
        afterMinutes: item.estimatedMinutes,
        reason: 'Added by the successor proposal.',
      });
    } else if (before.index !== item.index) {
      operations.push({
        kind: 'reordered',
        planItemId: item.id,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        beforeIndex: before.index,
        afterIndex: item.index,
        beforeMinutes: before.estimatedMinutes,
        afterMinutes: item.estimatedMinutes,
        reason: 'Route order changed.',
      });
    } else if (before.estimatedMinutes !== item.estimatedMinutes) {
      operations.push({
        kind: 'resized',
        planItemId: item.id,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        beforeIndex: before.index,
        afterIndex: item.index,
        beforeMinutes: before.estimatedMinutes,
        afterMinutes: item.estimatedMinutes,
        reason: 'Estimated effort changed.',
      });
    } else if (before.targetDepth !== item.targetDepth) {
      operations.push({
        kind: 'depth_changed',
        planItemId: item.id,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        beforeIndex: before.index,
        afterIndex: item.index,
        beforeMinutes: before.estimatedMinutes,
        afterMinutes: item.estimatedMinutes,
        reason: 'Target depth changed.',
      });
    }
  }
  for (const item of previous.items) {
    const key = `${item.kind}:${item.curriculumLearningUnitId ?? 'none'}`;
    if (nextKeys.has(key)) continue;
    operations.push({
      kind: 'removed',
      planItemId: item.id,
      curriculumLearningUnitId: item.curriculumLearningUnitId,
      beforeIndex: item.index,
      afterIndex: null,
      beforeMinutes: item.estimatedMinutes,
      afterMinutes: null,
      reason: 'Removed by the successor proposal.',
    });
  }
  return operations;
}
