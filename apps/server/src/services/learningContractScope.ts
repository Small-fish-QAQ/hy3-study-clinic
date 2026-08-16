import {
  ApiErrorCode,
  LearningContractScopeReadinessSchema,
  type LearningContract,
  type LearningContractScopeReadiness,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { Repositories } from '../repositories/index.js';

/**
 * Validate only learner-owned stable scope. MaterialRevision and all derived
 * identities are deliberately absent from this decision.
 */
export function assessLearningContractScope(
  repos: Repositories,
  contract: LearningContract,
): LearningContractScopeReadiness {
  const issues: LearningContractScopeReadiness['issues'] = [];

  for (const scoped of contract.courseScope.materials) {
    const material = repos.materials.get(scoped.materialId);
    if (!material) {
      issues.push({
        kind: 'material_missing',
        materialId: scoped.materialId,
        contractedRole: scoped.role,
        currentConfirmedRole: null,
      });
      continue;
    }
    if (material.workspaceId !== contract.workspaceId) {
      issues.push({
        kind: 'material_moved',
        materialId: scoped.materialId,
        contractedRole: scoped.role,
        currentConfirmedRole: null,
      });
      continue;
    }
    if (material.availability !== 'active') {
      issues.push({
        kind: 'material_retired',
        materialId: scoped.materialId,
        contractedRole: scoped.role,
        currentConfirmedRole: null,
      });
      continue;
    }

    const acceptedAssignment = repos.materialRoles.get(scoped.materialRoleAssignmentId);
    const acceptedAssignmentIsValid =
      acceptedAssignment?.materialId === scoped.materialId &&
      acceptedAssignment.version === scoped.materialRoleAssignmentVersion &&
      acceptedAssignment.role === scoped.role &&
      (acceptedAssignment.status === 'learner_confirmed' ||
        acceptedAssignment.status === 'superseded') &&
      acceptedAssignment.learnerConfirmedAt !== null;
    const latestConfirmed = repos.materialRoles
      .listHistory(scoped.materialId)
      .filter(
        (assignment) =>
          (assignment.status === 'learner_confirmed' || assignment.status === 'superseded') &&
          assignment.learnerConfirmedAt !== null,
      )
      .at(-1);
    const currentConfirmedRole =
      latestConfirmed?.role === 'unknown' || latestConfirmed?.role === 'excluded'
        ? null
        : (latestConfirmed?.role ?? null);

    if (!acceptedAssignmentIsValid || !currentConfirmedRole) {
      issues.push({
        kind: 'role_confirmation_missing',
        materialId: scoped.materialId,
        contractedRole: scoped.role,
        currentConfirmedRole,
      });
      continue;
    }
    if (currentConfirmedRole !== scoped.role) {
      issues.push({
        kind: 'material_role_changed',
        materialId: scoped.materialId,
        contractedRole: scoped.role,
        currentConfirmedRole,
      });
    }
  }

  return LearningContractScopeReadinessSchema.parse({
    state: issues.length === 0 ? 'current' : 'reconfirmation_required',
    issues,
  });
}

export function assertLearningContractScopeCurrent(
  repos: Repositories,
  contract: LearningContract,
): LearningContractScopeReadiness {
  const readiness = assessLearningContractScope(repos, contract);
  if (readiness.state === 'reconfirmation_required') {
    throw new AppError(
      ApiErrorCode.VersionConflict,
      '课程资料范围发生了变化，需要你重新确认学习约定。',
      { kind: 'learning_contract_scope_changed', ...readiness },
    );
  }
  return readiness;
}
