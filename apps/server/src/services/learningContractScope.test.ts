import { beforeEach, describe, expect, it } from 'vitest';
import type { Curriculum, LearningContract, LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeConcept, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';
import { createLearningContractService } from './learningContracts.js';
import {
  assessLearningContractScope,
  assertLearningContractScopeCurrent,
} from './learningContractScope.js';
import { createMaterialRoleService } from './materialRoles.js';

let db: SqliteDb;
let repos: Repositories;
let contract: LearningContract;
const clock = fixedClock(T0);

function command(id: string) {
  return { commandId: id, idempotencyKey: id, workspaceId: 'ws_1', actor: 'learner' as const };
}

function fields(roleId: string, roleVersion: number): LearningContractDraftFields {
  return {
    intent: 'Master the course.',
    targetOutcome: { description: 'Explain the core ideas.', targetScore: null, credential: null },
    deadline: null,
    studyBudget: {
      minutesPerDay: 30,
      minutesPerWeek: null,
      preferredSessionMinutes: 20,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Cognitive science'],
      materials: [
        {
          materialId: 'mat_1',
          materialRoleAssignmentId: roleId,
          materialRoleAssignmentVersion: roleVersion,
          role: 'course_material',
          disposition: 'included',
        },
      ],
      includedTopics: [],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: null,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
  const commands = createCourseCommandService({ repos, clock });
  const roles = createMaterialRoleService({ repos, clock, commands });
  const proposal = roles.propose({
    command: command('role-proposal'),
    materialId: 'mat_1',
    role: 'course_material',
    expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_1')!.id,
  });
  const role = roles.confirm({
    command: command('role-confirmation'),
    assignmentId: proposal.id,
    expectedVersion: proposal.version,
  });
  const contracts = createLearningContractService({ repos, clock, commands });
  const draft = contracts.createDraft({
    command: command('contract-create'),
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
  contract = contracts.transition({
    command: command('contract-confirm'),
    contractId: proposed.id,
    expectedVersion: proposed.version,
    transition: 'confirm',
  }).contract;
});

describe('Learning Contract stable scope readiness', () => {
  it('keeps the accepted Contract current across reprocessing, parser, Concept, and graph changes', () => {
    const acceptedSnapshot = structuredClone(repos.learningContracts.get(contract.id));
    const material = repos.materials.get('mat_1')!;
    const revisedContent = 'A new parser extraction with current evidence.';
    repos.materialRevisions.stage({
      revisionId: 'revision_2',
      material: {
        ...material,
        content: revisedContent,
        charCount: revisedContent.length,
        parserVersion: 'text-v2',
        updatedAt: T0,
      },
      blocks: [
        makeBlock({
          id: 'block_revision_2',
          content: revisedContent,
          startOffset: 0,
          endOffset: revisedContent.length,
        }),
      ],
      originalData: null,
      parserFingerprint: 'parser-v2',
      contentFingerprint: 'content-v2',
      parserAttemptId: 'parser-attempt-v2',
      createdAt: T0,
    });
    repos.materialRevisions.activate('mat_1', 'revision_2', T0);
    repos.materials.addConcepts([
      makeConcept({
        id: 'concept_revision_2',
        grounding: {
          blockId: 'block_revision_2',
          quote: revisedContent,
          startOffset: 0,
          endOffset: revisedContent.length,
          occurrenceCount: 1,
          reanchored: false,
        },
      }),
    ]);
    repos.graph.insertVersion({
      id: 'graph_revision_2',
      workspaceId: 'ws_1',
      status: 'ready',
      provider: 'fake',
      providerModel: null,
      validationSummary: null,
      errorMessage: null,
      createdAt: T0,
      updatedAt: T0,
    });
    repos.graph.activate('ws_1', 'graph_revision_2', T0);
    const manifest = {
      fingerprint: 'manifest-revision-2',
      revisions: [
        {
          materialId: 'mat_1',
          materialRevisionId: 'revision_2',
          parserVersion: 'text-v2',
          parserFingerprint: 'parser-v2',
          sourceBlockRevisionIds: ['block_revision_2'],
        },
      ],
    };
    repos.curricula.createManifest('manifest_revision_2', 'ws_1', manifest, T0);
    const derivedCurriculum: Curriculum = {
      id: 'curriculum_revision_2',
      workspaceId: 'ws_1',
      contractVersionId: contract.id,
      version: 1,
      predecessorId: null,
      status: 'proposed',
      executionSourceManifest: manifest,
      nodes: [
        {
          id: 'curriculum_root_revision_2',
          parentId: null,
          kind: 'course',
          index: 0,
          title: 'Reprocessed course',
          sourceReferences: [],
          learningUnit: null,
        },
      ],
      synthesisGroups: [],
      validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
      provider: 'fake',
      providerModel: null,
      createdAt: T0,
      acceptedAt: null,
    };
    repos.curricula.createVersion(derivedCurriculum, {
      id: 'curriculum_revision_2_created',
      eventType: 'proposed',
      actor: 'local',
      payload: {},
      createdAt: T0,
    });

    expect(assessLearningContractScope(repos, contract)).toEqual({
      state: 'current',
      issues: [],
    });
    expect(repos.learningContracts.get(contract.id)).toEqual(acceptedSnapshot);
    expect(contract.courseScope.materials[0]).not.toHaveProperty('materialRevisionId');
  });

  it('keeps stable scope current for a pending role proposal and a confirmed same-role successor', () => {
    const commands = createCourseCommandService({ repos, clock });
    const roles = createMaterialRoleService({ repos, clock, commands });
    const current = repos.materialRoles.getCurrent('mat_1')!;
    const proposal = roles.propose({
      command: command('same-role-proposal'),
      materialId: 'mat_1',
      role: 'course_material',
      expectedCurrentAssignmentId: current.id,
    });

    expect(assessLearningContractScope(repos, contract).state).toBe('current');
    roles.confirm({
      command: command('same-role-confirmation'),
      assignmentId: proposal.id,
      expectedVersion: proposal.version,
    });
    expect(assessLearningContractScope(repos, contract)).toEqual({ state: 'current', issues: [] });
    expect(repos.learningContracts.get(contract.id)).toEqual(contract);
  });

  it('requires reconfirmation only after the learner confirms a different Material role', () => {
    const commands = createCourseCommandService({ repos, clock });
    const roles = createMaterialRoleService({ repos, clock, commands });
    const current = repos.materialRoles.getCurrent('mat_1')!;
    const proposal = roles.propose({
      command: command('changed-role-proposal'),
      materialId: 'mat_1',
      role: 'supplementary_reference',
      expectedCurrentAssignmentId: current.id,
    });
    expect(assessLearningContractScope(repos, contract).state).toBe('current');

    roles.confirm({
      command: command('changed-role-confirmation'),
      assignmentId: proposal.id,
      expectedVersion: proposal.version,
    });

    expect(assessLearningContractScope(repos, contract)).toEqual({
      state: 'reconfirmation_required',
      issues: [
        {
          kind: 'material_role_changed',
          materialId: 'mat_1',
          contractedRole: 'course_material',
          currentConfirmedRole: 'supplementary_reference',
        },
      ],
    });
    expect(() => assertLearningContractScopeCurrent(repos, contract)).toThrow(
      '课程资料范围发生了变化',
    );
  });

  it('fails closed when a scoped logical Material is retired', () => {
    repos.materials.insertWithBlocks(makeMaterial({ id: 'mat_replacement' }), [
      makeBlock({ id: 'block_replacement', materialId: 'mat_replacement' }),
    ]);
    repos.materialRevisions.retire('mat_1', T0);

    expect(assessLearningContractScope(repos, contract)).toEqual({
      state: 'reconfirmation_required',
      issues: [
        {
          kind: 'material_retired',
          materialId: 'mat_1',
          contractedRole: 'course_material',
          currentConfirmedRole: null,
        },
      ],
    });
    expect(repos.materials.get('mat_replacement')?.availability).toBe('active');
    expect(repos.learningContracts.get(contract.id)).toEqual(contract);
  });
});
