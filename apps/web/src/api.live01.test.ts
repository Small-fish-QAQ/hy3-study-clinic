import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MaterialRoleAssignment } from '@hy3-clinic/shared';
import { api } from './api.js';
import { installFetchMock } from './test/mockFetch.js';

const AT = '2026-08-12T11:54:07.530Z';

const proposal: MaterialRoleAssignment = {
  id: 'role_2',
  materialId: 'mat_1',
  version: 2,
  predecessorId: 'role_1',
  role: 'course_material',
  status: 'proposed',
  proposedBy: 'learner',
  learnerConfirmedAt: null,
  createdAt: AT,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LIVE-01 Material-role API contract', () => {
  it('LIVE01-B parses wrapped proposal and confirmation responses', async () => {
    const confirmed: MaterialRoleAssignment = {
      ...proposal,
      status: 'learner_confirmed',
      learnerConfirmedAt: AT,
    };
    installFetchMock([
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/documents\/mat_1\/role\/proposals$/,
        handler: () => ({ status: 201, body: { assignment: proposal } }),
      },
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/documents\/mat_1\/role\/role_2\/confirm$/,
        handler: () => ({ body: { assignment: confirmed } }),
      },
    ]);

    await expect(
      api.proposeMaterialRole('ws_1', 'mat_1', {
        command: {
          commandId: 'propose_role_2',
          idempotencyKey: 'propose_role_2',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        materialId: 'mat_1',
        role: 'course_material',
        expectedCurrentAssignmentId: 'role_1',
      }),
    ).resolves.toEqual(proposal);
    await expect(
      api.confirmMaterialRole('ws_1', 'mat_1', proposal.id, {
        command: {
          commandId: 'confirm_role_2',
          idempotencyKey: 'confirm_role_2',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        assignmentId: proposal.id,
        expectedVersion: proposal.version,
      }),
    ).resolves.toEqual(confirmed);
  });
});
