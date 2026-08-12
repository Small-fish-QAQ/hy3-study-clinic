import { afterEach, describe, expect, it } from 'vitest';
import { makeBlock, makeMaterial, T0 } from '../testing/fixtures.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

let context: TestApp | undefined;

afterEach(async () => {
  await context?.app.close();
  context = undefined;
});

describe('Material role confirmation route identity', () => {
  it('LIVE01-B/D persists confirmation and returns it through authoritative refetch', async () => {
    context = buildTestApp();
    const { app, repos } = context;
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    const materialBefore = repos.materials.get('mat_1')!;
    const initial = repos.materialRoles.getCurrent('mat_1')!;

    const proposed = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws_1/documents/mat_1/role/proposals',
      payload: {
        command: {
          commandId: 'live01-propose',
          idempotencyKey: 'live01-propose',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        materialId: 'mat_1',
        role: 'course_material',
        expectedCurrentAssignmentId: initial.id,
      },
    });

    expect(proposed.statusCode).toBe(201);
    expect(proposed.json()).toMatchObject({
      assignment: {
        materialId: 'mat_1',
        version: initial.version + 1,
        predecessorId: initial.id,
        role: 'course_material',
        status: 'proposed',
      },
    });
    const proposal = proposed.json().assignment as { id: string; version: number };

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws_1/documents/mat_1/role/${proposal.id}/confirm`,
      payload: {
        command: {
          commandId: 'live01-confirm',
          idempotencyKey: 'live01-confirm',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        assignmentId: proposal.id,
        expectedVersion: proposal.version,
      },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      assignment: {
        id: proposal.id,
        materialId: 'mat_1',
        version: proposal.version,
        status: 'learner_confirmed',
        learnerConfirmedAt: T0,
      },
    });

    const refetched = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws_1/documents/mat_1/role',
    });
    expect(refetched.statusCode).toBe(200);
    expect(refetched.json()).toMatchObject({
      materialId: 'mat_1',
      current: {
        id: proposal.id,
        version: proposal.version,
        status: 'learner_confirmed',
      },
    });
    expect(repos.materials.get('mat_1')).toMatchObject({
      id: materialBefore.id,
      activeRevisionId: materialBefore.activeRevisionId,
    });
  });

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
