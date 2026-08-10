import {
  ApiErrorCode,
  ConfirmMaterialRoleRequestSchema,
  MaterialRoleHistoryResponseSchema,
  ProposeMaterialRoleRequestSchema,
  type ConfirmMaterialRoleRequest,
  type MaterialRoleAssignment,
  type MaterialRoleHistoryResponse,
  type ProposeMaterialRoleRequest,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { CourseCommandService } from './courseCommands.js';

interface MaterialRoleServiceDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
}

export function createMaterialRoleService({ repos, clock, commands }: MaterialRoleServiceDeps) {
  function requireMaterial(workspaceId: string, materialId: string) {
    const material = repos.materials.get(materialId);
    if (!material || material.workspaceId !== workspaceId) throw notFound('Material not found.');
    return material;
  }

  function history(workspaceId: string, materialId: string): MaterialRoleHistoryResponse {
    requireMaterial(workspaceId, materialId);
    const current = repos.materialRoles.getCurrent(materialId);
    if (!current) throw notFound('Material role history not found.');
    return MaterialRoleHistoryResponseSchema.parse({
      materialId,
      current,
      history: repos.materialRoles.listHistory(materialId),
    });
  }

  function propose(input: ProposeMaterialRoleRequest): MaterialRoleAssignment {
    const parsed = ProposeMaterialRoleRequestSchema.parse(input);
    requireMaterial(parsed.command.workspaceId, parsed.materialId);
    const claim = commands.begin(parsed.command, 'propose_material_role', {
      materialId: parsed.materialId,
      expectedCurrentAssignmentId: parsed.expectedCurrentAssignmentId,
    });
    try {
      return commands.complete(claim, () => {
        const current = repos.materialRoles.getCurrent(parsed.materialId);
        if ((current?.id ?? null) !== parsed.expectedCurrentAssignmentId) {
          throw new AppError(ApiErrorCode.VersionConflict, 'Material role assignment is stale.', {
            currentAssignmentId: current?.id ?? null,
          });
        }
        const now = clock.now().toISOString();
        const proposal: MaterialRoleAssignment = {
          id: newId('role'),
          materialId: parsed.materialId,
          version: (current?.version ?? 0) + 1,
          predecessorId: current?.id ?? null,
          role: parsed.role,
          status: 'proposed',
          proposedBy: parsed.command.actor,
          learnerConfirmedAt: null,
          createdAt: now,
        };
        return repos.materialRoles.createVersion(proposal);
      });
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function confirm(input: ConfirmMaterialRoleRequest): MaterialRoleAssignment {
    const parsed = ConfirmMaterialRoleRequestSchema.parse(input);
    const assignment = repos.materialRoles.get(parsed.assignmentId);
    if (!assignment) throw notFound('Material role assignment not found.');
    requireMaterial(parsed.command.workspaceId, assignment.materialId);
    const claim = commands.begin(parsed.command, 'confirm_material_role', {
      assignmentId: assignment.id,
      expectedVersion: parsed.expectedVersion,
    });
    try {
      return commands.complete(claim, () => {
        const current = repos.materialRoles.get(assignment.id);
        if (
          !current ||
          current.version !== parsed.expectedVersion ||
          current.status !== 'proposed'
        ) {
          throw new AppError(ApiErrorCode.VersionConflict, 'Material role proposal is stale.');
        }
        return repos.materialRoles.confirm(current.id, clock.now().toISOString());
      });
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  return { history, propose, confirm };
}

export type MaterialRoleService = ReturnType<typeof createMaterialRoleService>;
