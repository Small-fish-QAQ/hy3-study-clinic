import { beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorCode, type LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import type { AppError } from '../errors.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';
import { createLearningContractService } from './learningContracts.js';
import { createMaterialRoleService } from './materialRoles.js';

let db: SqliteDb;
let repos: Repositories;
const clock = fixedClock(T0);

function command(id: string, actor: 'learner' | 'local' = 'learner') {
  return { commandId: id, idempotencyKey: id, workspaceId: 'ws_1', actor } as const;
}

const fields = (roleId: string, roleVersion: number): LearningContractDraftFields => ({
  intent: 'Prepare for the probability examination.',
  targetOutcome: { description: 'Score at least 90', targetScore: 90, credential: null },
  deadline: { at: '2026-08-17T00:00:00.000Z', timeZone: 'Asia/Shanghai' },
  studyBudget: {
    minutesPerDay: 120,
    minutesPerWeek: null,
    preferredSessionMinutes: 60,
    unavailablePeriods: [],
  },
  desiredDepth: 'high_performance',
  courseScope: {
    subjectBoundaries: ['Probability'],
    materials: [
      {
        materialId: 'mat_1',
        materialRoleAssignmentId: roleId,
        materialRoleAssignmentVersion: roleVersion,
        role: 'course_material',
        disposition: 'included',
      },
    ],
    includedTopics: ['Conditional probability'],
    excludedTopics: [],
  },
  learnerSelfReport: null,
  examContext: null,
  riskTolerance: {
    description: null,
    allowExplicitDeferral: true,
    maximumUnresolvedPriority: null,
  },
});

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  repos.materials.insertWithBlocks(makeMaterial({ id: 'mat_1' }), [
    makeBlock({ id: 'block_1', materialId: 'mat_1' }),
  ]);
});

describe('learner scope and Learning Contracts', () => {
  it('requires a learner-confirmed stable Material role before creating Contract scope', () => {
    const commands = createCourseCommandService({ repos, clock });
    const roles = createMaterialRoleService({ repos, clock, commands });
    const contracts = createLearningContractService({ repos, clock, commands });
    const proposed = roles.propose({
      command: command('role-propose'),
      materialId: 'mat_1',
      role: 'course_material',
      expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_1')!.id,
    });

    expect(() =>
      contracts.createDraft({
        command: command('contract-before-role'),
        fields: fields(proposed.id, proposed.version),
        predecessorContractId: null,
        expectedActiveContractId: null,
      }),
    ).toThrow('learner-confirmed Material role');

    const confirmed = roles.confirm({
      command: command('role-confirm'),
      assignmentId: proposed.id,
      expectedVersion: proposed.version,
    });
    const result = contracts.createDraft({
      command: command('contract-create'),
      fields: fields(confirmed.id, confirmed.version),
      predecessorContractId: null,
      expectedActiveContractId: null,
    });
    expect(result.contract.status).toBe('draft');
    expect(result.contract.courseScope.materials[0]).toEqual({
      materialId: 'mat_1',
      materialRoleAssignmentId: confirmed.id,
      materialRoleAssignmentVersion: confirmed.version,
      role: 'course_material',
      disposition: 'included',
    });
    expect(JSON.stringify(result.contract)).not.toContain('materialRevisionId');
  });

  it('keeps learner confirmation separate from active route installation', () => {
    const commands = createCourseCommandService({ repos, clock });
    const roles = createMaterialRoleService({ repos, clock, commands });
    const contracts = createLearningContractService({ repos, clock, commands });
    const proposedRole = roles.propose({
      command: command('role-propose-2'),
      materialId: 'mat_1',
      role: 'course_material',
      expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_1')!.id,
    });
    const role = roles.confirm({
      command: command('role-confirm-2'),
      assignmentId: proposedRole.id,
      expectedVersion: proposedRole.version,
    });
    const draft = contracts.createDraft({
      command: command('contract-create-2'),
      fields: fields(role.id, role.version),
      predecessorContractId: null,
      expectedActiveContractId: null,
    }).contract;
    const proposed = contracts.transition({
      command: command('contract-propose'),
      contractId: draft.id,
      expectedVersion: draft.version,
      transition: 'propose',
    }).contract;
    const confirmed = contracts.transition({
      command: command('contract-confirm'),
      contractId: proposed.id,
      expectedVersion: proposed.version,
      transition: 'confirm',
    }).contract;
    expect(confirmed.status).toBe('learner_confirmed');
    expect(repos.courseExecution.get('ws_1').activeContractId).toBeNull();
  });

  it('replays one idempotent command without creating another version', () => {
    const commands = createCourseCommandService({ repos, clock });
    const roles = createMaterialRoleService({ repos, clock, commands });
    const request = {
      command: command('same-role-command'),
      materialId: 'mat_1',
      role: 'course_material' as const,
      expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_1')!.id,
    };
    const first = roles.propose(request);
    const replay = roles.propose(request);
    expect(replay).toEqual(first);
    expect(repos.materialRoles.listHistory('mat_1')).toHaveLength(2);
  });

  it('rejects stale expected role state with a structured version conflict', () => {
    const commands = createCourseCommandService({ repos, clock });
    const roles = createMaterialRoleService({ repos, clock, commands });
    expect(() =>
      roles.propose({
        command: command('stale-role'),
        materialId: 'mat_1',
        role: 'course_material',
        expectedCurrentAssignmentId: null,
      }),
    ).toThrowError(expect.objectContaining<AppError>({ code: ApiErrorCode.VersionConflict }));
  });
});
