import {
  StudyPlanProposalPayloadSchema,
  type StudyPlanItemKind,
  type StudyPlanProposalPayload,
} from '@hy3-clinic/shared';
import { z } from 'zod';
import type { StudyPlanProposalInput } from './provider.js';

export interface DetailedStudyPlanScope {
  units: Array<{
    id: string;
    objectiveIds: string[];
    prerequisiteUnitIds: string[];
  }>;
  synthesisGroups: Array<{ learningUnitIds: string[]; objectiveIds: string[] }>;
  requiredLearningUnitIds: string[];
  allowedDepths: StudyPlanProposalInput['allowedDepths'];
  launchCapabilities: Array<{
    curriculumLearningUnitId: string;
    allowedItemKinds: StudyPlanItemKind[];
  }>;
  allowExplicitDeferral: boolean;
}

export function detailedStudyPlanScopeFromInput(
  input: StudyPlanProposalInput,
): DetailedStudyPlanScope {
  return {
    units: input.units.map((unit) => ({
      id: unit.id,
      objectiveIds: unit.objectiveIds,
      prerequisiteUnitIds: unit.prerequisiteUnitIds,
    })),
    synthesisGroups: input.synthesisGroups.map((group) => ({
      learningUnitIds: group.learningUnitIds,
      objectiveIds: group.objectiveIds,
    })),
    requiredLearningUnitIds: input.requiredLearningUnitIds,
    allowedDepths: input.allowedDepths,
    launchCapabilities: input.launchCapabilities.map((capability) => ({
      curriculumLearningUnitId: capability.curriculumLearningUnitId,
      allowedItemKinds: capability.allowedItemKinds,
    })),
    allowExplicitDeferral: input.contract.allowExplicitDeferral,
  };
}

export function validateDetailedStudyPlanProposal(
  proposal: StudyPlanProposalPayload,
  scope: DetailedStudyPlanScope,
): string[] {
  const errors: string[] = [];
  const requiredIds = new Set(scope.requiredLearningUnitIds);
  const unitsById = new Map(scope.units.map((unit) => [unit.id, unit]));
  const objectiveOwner = new Map(
    scope.units.flatMap((unit) =>
      unit.objectiveIds.map((objectiveId) => [objectiveId, unit.id] as const),
    ),
  );
  const capabilities = new Map(
    scope.launchCapabilities.map((capability) => [
      capability.curriculumLearningUnitId,
      capability.allowedItemKinds,
    ]),
  );
  const itemIndexByKey = new Map(proposal.items.map((item, index) => [item.key, index]));
  const plannedObjectives = new Set<string>();
  const deferredObjectives = new Set<string>();

  for (const [index, item] of proposal.items.entries()) {
    if (!scope.allowedDepths.includes(item.targetDepth)) {
      errors.push(`Item ${item.key} uses unavailable depth ${item.targetDepth}.`);
    }
    const unitId = item.curriculumLearningUnitId;
    const unit = unitId ? unitsById.get(unitId) : undefined;
    if (!unit || !requiredIds.has(unit.id)) {
      errors.push(
        `Item ${item.key} references an unknown or non-required LearningUnit: ${unitId ?? 'null'}.`,
      );
      continue;
    }
    if (!capabilities.get(unit.id)?.includes(item.kind)) {
      errors.push(`Item ${item.key} kind ${item.kind} is unavailable for LearningUnit ${unit.id}.`);
    }
    for (const prerequisiteKey of item.prerequisiteItemKeys) {
      const prerequisiteIndex = itemIndexByKey.get(prerequisiteKey);
      if (prerequisiteIndex === undefined || prerequisiteIndex >= index) {
        errors.push(`Item ${item.key} prerequisite ${prerequisiteKey} must appear earlier.`);
      }
    }
    const synthesisGroup =
      item.kind === 'synthesis'
        ? scope.synthesisGroups.find(
            (group) =>
              group.learningUnitIds.includes(unit.id) &&
              item.objectiveIds.every((objectiveId) => group.objectiveIds.includes(objectiveId)),
          )
        : undefined;
    for (const objectiveId of item.objectiveIds) {
      const ownerUnitId = objectiveOwner.get(objectiveId);
      if (!ownerUnitId) {
        errors.push(`Item ${item.key} references an unknown objective: ${objectiveId}.`);
      } else if (
        ownerUnitId !== unit.id &&
        !synthesisGroup?.learningUnitIds.includes(ownerUnitId)
      ) {
        errors.push(`Objective ${objectiveId} does not belong to LearningUnit ${unit.id}.`);
      }
      plannedObjectives.add(objectiveId);
    }
  }

  for (const deferral of proposal.deferrals) {
    const unit = unitsById.get(deferral.curriculumLearningUnitId);
    if (!unit || !requiredIds.has(deferral.curriculumLearningUnitId)) {
      errors.push(
        `Deferral references an unknown or non-required LearningUnit: ${deferral.curriculumLearningUnitId}.`,
      );
      continue;
    }
    if (!scope.allowExplicitDeferral) {
      errors.push(`Deferrals are not allowed by the Contract.`);
    }
    if (deferral.objectiveIds.length === 0) {
      errors.push(`Deferral for ${unit.id} has no objectives.`);
    }
    const allowedObjectives = new Set(unit.objectiveIds);
    for (const objectiveId of deferral.objectiveIds) {
      if (!allowedObjectives.has(objectiveId)) {
        errors.push(
          `Deferral objective ${objectiveId} does not belong to LearningUnit ${unit.id}.`,
        );
      }
      if (plannedObjectives.has(objectiveId)) {
        errors.push(`Objective ${objectiveId} cannot be both planned and deferred.`);
      }
      if (deferredObjectives.has(objectiveId)) {
        errors.push(`Objective ${objectiveId} is deferred more than once.`);
      }
      deferredObjectives.add(objectiveId);
    }
  }

  for (const [objectiveId, unitId] of objectiveOwner) {
    if (!requiredIds.has(unitId)) continue;
    if (!plannedObjectives.has(objectiveId) && !deferredObjectives.has(objectiveId)) {
      errors.push(`Required Curriculum objective is omitted: ${objectiveId}.`);
    }
  }
  return [...new Set(errors)].slice(0, 100);
}

export function detailedStudyPlanSchema(scope: DetailedStudyPlanScope) {
  return StudyPlanProposalPayloadSchema.superRefine((proposal, ctx) => {
    for (const message of validateDetailedStudyPlanProposal(proposal, scope)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message });
    }
  });
}
