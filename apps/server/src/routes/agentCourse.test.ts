import { afterEach, describe, expect, it } from 'vitest';
import { makeBlock, makeMaterial, T0 } from '../testing/fixtures.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

let context: TestApp | undefined;

afterEach(async () => {
  await context?.app.close();
  context = undefined;
});

describe('Material role confirmation route identity', () => {
  it('rejects URL A with body B before any role or command mutation', async () => {
    context = buildTestApp();
    const { app, db, repos } = context;
    for (const materialId of ['mat_a', 'mat_b']) {
      repos.materials.insertWithBlocks(
        makeMaterial({ id: materialId, title: `Material ${materialId}` }),
        [makeBlock({ id: `block_${materialId}`, materialId })],
      );
    }
    const proposalA = repos.materialRoles.createVersion({
      id: 'role_proposal_a',
      materialId: 'mat_a',
      version: 2,
      predecessorId: repos.materialRoles.getCurrent('mat_a')!.id,
      role: 'course_material',
      status: 'proposed',
      proposedBy: 'learner',
      learnerConfirmedAt: null,
      createdAt: T0,
    });
    const proposalB = repos.materialRoles.createVersion({
      id: 'role_proposal_b',
      materialId: 'mat_b',
      version: 2,
      predecessorId: repos.materialRoles.getCurrent('mat_b')!.id,
      role: 'supplementary_reference',
      status: 'proposed',
      proposedBy: 'learner',
      learnerConfirmedAt: null,
      createdAt: T0,
    });
    const historiesBefore = {
      a: repos.materialRoles.listHistory('mat_a'),
      b: repos.materialRoles.listHistory('mat_b'),
    };
    const operationsBefore = db.prepare('SELECT * FROM agent_operations ORDER BY id').all();
    const resultsBefore = db
      .prepare('SELECT * FROM agent_operation_results ORDER BY operation_id')
      .all();

    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/documents/mat_a/role/${proposalA.id}/confirm`,
      payload: {
        command: {
          commandId: 'confirm_role_b',
          idempotencyKey: 'confirm_role_b',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        assignmentId: proposalB.id,
        expectedVersion: proposalB.version,
      },
    });

    expect(mismatch.statusCode).toBe(400);
    expect(repos.materialRoles.listHistory('mat_a')).toEqual(historiesBefore.a);
    expect(repos.materialRoles.listHistory('mat_b')).toEqual(historiesBefore.b);
    expect(repos.materialRoles.get(proposalB.id)?.status).toBe('proposed');
    expect(db.prepare('SELECT * FROM agent_operations ORDER BY id').all()).toEqual(
      operationsBefore,
    );
    expect(db.prepare('SELECT * FROM agent_operation_results ORDER BY operation_id').all()).toEqual(
      resultsBefore,
    );

    const materialMismatch = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/documents/mat_a/role/${proposalB.id}/confirm`,
      payload: {
        command: {
          commandId: 'confirm_role_b_wrong_material',
          idempotencyKey: 'confirm_role_b_wrong_material',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        assignmentId: proposalB.id,
        expectedVersion: proposalB.version,
      },
    });

    expect(materialMismatch.statusCode).toBe(400);
    expect(repos.materialRoles.listHistory('mat_a')).toEqual(historiesBefore.a);
    expect(repos.materialRoles.listHistory('mat_b')).toEqual(historiesBefore.b);
    expect(db.prepare('SELECT * FROM agent_operations ORDER BY id').all()).toEqual(
      operationsBefore,
    );
    expect(db.prepare('SELECT * FROM agent_operation_results ORDER BY operation_id').all()).toEqual(
      resultsBefore,
    );

    const correct = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/documents/mat_b/role/${proposalB.id}/confirm`,
      payload: {
        command: {
          commandId: 'confirm_role_b',
          idempotencyKey: 'confirm_role_b',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        assignmentId: proposalB.id,
        expectedVersion: proposalB.version,
      },
    });

    expect(correct.statusCode).toBe(200);
    expect(correct.json()).toMatchObject({
      assignment: { id: proposalB.id, materialId: 'mat_b', status: 'learner_confirmed' },
    });
    expect(repos.materialRoles.get(proposalA.id)?.status).toBe('proposed');
    expect(repos.materialRoles.get(proposalB.id)?.status).toBe('learner_confirmed');
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_operations').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_operation_results').get()).toEqual({
      count: 1,
    });
  });
});
