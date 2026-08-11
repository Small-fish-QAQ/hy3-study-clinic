import {
  fnv1a32,
  type AgendaLaunchCapability,
  type AssessmentMode,
  type CoverageRiskEntry,
  type Curriculum,
  type CurriculumNode,
  type LearningContract,
  type ProposedStudyPlanDeferral,
  type StudyPlan,
  type StudyPlanDiffOperation,
  type StudyPlanFeasibility,
  type StudyPlanItem,
  type StudyPlanItemKind,
  type StudyPlanProposalPayload,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { checkActivityCapability } from './activityLaunch.js';

export const STUDY_PLAN_COMPLETION_POLICY_ID = 'learning-unit-completion';
export const STUDY_PLAN_COMPLETION_POLICY_VERSION = 1;
export const PACE_BASELINE_POLICY_VERSION = 'pace-baseline-v1';

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

function assessmentCapability(
  repos: Repositories,
  clock: Clock,
  workspaceId: string,
  mode: AssessmentMode,
  conceptIds: string[],
): AgendaLaunchCapability {
  const checked = checkActivityCapability(repos, clock, workspaceId, { mode, conceptIds });
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

export function resolveLaunchForPlanItem(
  repos: Repositories,
  clock: Clock,
  workspaceId: string,
  curriculum: Curriculum,
  item: Pick<StudyPlanItem, 'kind' | 'curriculumLearningUnitId' | 'objectiveIds'>,
): AgendaLaunchCapability {
  const unit = item.curriculumLearningUnitId
    ? learningUnits(curriculum).find((candidate) => candidate.id === item.curriculumLearningUnitId)
    : undefined;
  const conceptIds = unit?.learningUnit.conceptIds ?? [];
  switch (item.kind) {
    case 'teach_unit': {
      const conceptId = conceptIds.find((id) => repos.materials.getConcept(id));
      return conceptId
        ? {
            status: 'launchable',
            capability: 'lesson',
            resourceId: JSON.stringify({ conceptId }),
            reason: null,
          }
        : {
            status: 'blocked',
            capability: 'lesson',
            resourceId: null,
            reason: 'This LearningUnit has no current source Concept for lesson launch.',
          };
    }
    case 'formal_checkpoint':
      return assessmentCapability(repos, clock, workspaceId, 'concept_practice', conceptIds);
    case 'targeted_repair':
      return assessmentCapability(repos, clock, workspaceId, 'prerequisite_repair', conceptIds);
    case 'due_review':
      return assessmentCapability(repos, clock, workspaceId, 'review', conceptIds);
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
      const launch = resolveLaunchForPlanItem(repos, clock, workspaceId, curriculum, {
        kind: candidate.kind,
        curriculumLearningUnitId: unit.id,
        objectiveIds: unit.learningUnit.objectives.map((objective) => objective.id),
      });
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
  options: { id?: string; learnerDecisionId?: string | null } = {},
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
  return {
    id: options.id ?? `risk_deferral_${fingerprint}`,
    workspaceId: contract.workspaceId,
    contractVersionId: contract.id,
    stableScopeFingerprint: fingerprint,
    materialId: materialIds.length === 1 ? materialIds[0]! : null,
    topicId: null,
    objectiveId: deferral.objectiveIds.length === 1 ? deferral.objectiveIds[0]! : null,
    facets: ['intentionally_deferred'],
    scopeAuthorityStatus: 'in_scope',
    truthPremiseStatus,
    truthAuthorityRecordIds,
    referencedCurriculumNodeIds: [unit.id],
    referencedConceptIds: unit.learningUnit.conceptIds,
    referencedEvidenceIds: [],
    origin: 'deterministic',
    status: 'deferred',
    severity: 'medium',
    priority: 50,
    contractSensitive: true,
    claim: `The proposed route explicitly defers ${unit.title}.`,
    uncertainty: 'The deferred objectives remain an unresolved visible coverage gap.',
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
    learnerDecisionId: options.learnerDecisionId ?? null,
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
      if (item.curriculumLearningUnitId && owner.unit.id !== item.curriculumLearningUnitId) {
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
      const synthesisGroup =
        item.kind === 'synthesis' && unit
          ? curriculum.synthesisGroups.find(
              (group) =>
                group.learningUnitIds.includes(unit.id) &&
                item.objectiveIds.every((id) => group.objectiveIds.includes(id)),
            )
          : undefined;
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
      }
    }
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
    if (!contract.riskTolerance?.allowExplicitDeferral) {
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
