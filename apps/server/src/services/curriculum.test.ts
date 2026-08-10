import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CurriculumProposalPayload,
  LearningContract,
  LearningContractDraftFields,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { CurriculumProposalInput, ProviderCallOptions } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';
import {
  buildCurriculumExecutionContext,
  createCurriculumService,
  type CurriculumService,
} from './curriculum.js';
import { createLearningContractService } from './learningContracts.js';
import { createMaterialRoleService } from './materialRoles.js';
import { createSourceAuthorityService } from './sourceAuthority.js';

const QUOTE = 'Working memory is limited.';
const clock = fixedClock(T0);

class ControlledCurriculumProvider extends FakeProvider {
  calls = 0;
  fail = false;
  lastInput: CurriculumProposalInput | null = null;
  makePayload: (input: CurriculumProposalInput) => CurriculumProposalPayload = (input) => ({
    nodes: [
      {
        key: 'chapter-1',
        parentKey: null,
        kind: 'chapter',
        index: 0,
        title: 'Foundations',
        structuralUnitIds: [],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'section-1',
        parentKey: 'chapter-1',
        kind: 'section',
        index: 0,
        title: 'Memory',
        structuralUnitIds: [],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'unit-1',
        parentKey: 'section-1',
        kind: 'learning_unit',
        index: 0,
        title: 'Working memory capacity',
        structuralUnitIds: [],
        sourceEvidence: [{ blockId: input.blocks[0]!.id, quote: QUOTE }],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            key: 'objective-1',
            title: QUOTE,
            description: QUOTE,
            evidence: [{ blockId: input.blocks[0]!.id, quote: QUOTE }],
          },
        ],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
    ],
    synthesisGroups: [],
  });

  override async proposeCurriculum(
    input: CurriculumProposalInput,
    _opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload> {
    this.calls += 1;
    this.lastInput = input;
    if (this.fail) throw new Error('controlled provider failure');
    return this.makePayload(input);
  }
}

let db: SqliteDb;
let repos: Repositories;
let provider: ControlledCurriculumProvider;
let curriculum: CurriculumService;
let contract: LearningContract;

function command(id: string, actor: 'learner' | 'local' = 'local') {
  return { commandId: id, idempotencyKey: id, workspaceId: 'ws_1', actor } as const;
}

function contractFields(roleId: string, roleVersion: number): LearningContractDraftFields {
  return {
    intent: 'Study working memory.',
    targetOutcome: {
      description: 'Explain the source accurately.',
      targetScore: null,
      credential: null,
    },
    deadline: null,
    studyBudget: {
      minutesPerDay: 30,
      minutesPerWeek: null,
      preferredSessionMinutes: 30,
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
      includedTopics: ['Working memory'],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: {
      description: null,
      allowExplicitDeferral: true,
      maximumUnresolvedPriority: null,
    },
  };
}

function proposalRequest(id: string, predecessorCurriculumId: string | null = null) {
  return {
    command: command(id),
    contractId: contract.id,
    expectedContractVersion: contract.version,
    predecessorCurriculumId,
    expectedActiveCurriculumId: null,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace({ name: 'Cognitive science' }));
  repos.materials.insertWithBlocks(
    makeMaterial({ content: QUOTE, charCount: QUOTE.length, title: 'Memory notes' }),
    [
      makeBlock({
        content: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        heading: 'Working memory',
      }),
    ],
  );
  const commands = createCourseCommandService({ repos, clock });
  const roles = createMaterialRoleService({ repos, clock, commands });
  const roleProposal = roles.propose({
    command: command('role-propose'),
    materialId: 'mat_1',
    role: 'course_material',
    expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_1')!.id,
  });
  const role = roles.confirm({
    command: command('role-confirm', 'learner'),
    assignmentId: roleProposal.id,
    expectedVersion: roleProposal.version,
  });
  const contracts = createLearningContractService({ repos, clock, commands });
  const draft = contracts.createDraft({
    command: command('contract-create', 'learner'),
    fields: contractFields(role.id, role.version),
    predecessorContractId: null,
    expectedActiveContractId: null,
  }).contract;
  const proposed = contracts.transition({
    command: command('contract-propose', 'learner'),
    contractId: draft.id,
    expectedVersion: draft.version,
    transition: 'propose',
  }).contract;
  contract = contracts.transition({
    command: command('contract-confirm', 'learner'),
    contractId: proposed.id,
    expectedVersion: proposed.version,
    transition: 'confirm',
  }).contract;
  provider = new ControlledCurriculumProvider();
  curriculum = createCurriculumService({ repos, provider, clock, commands });
});

describe('Curriculum proposal and authority boundaries', () => {
  it('resolves stable Contract Material scope to the exact active revision manifest', () => {
    const before = buildCurriculumExecutionContext(repos, contract).manifest;
    const sameContract = repos.learningContracts.get(contract.id)!;
    repos.materialRevisions.stage({
      revisionId: 'revision-2',
      material: makeMaterial({
        content: `${QUOTE} Updated.`,
        charCount: `${QUOTE} Updated.`.length,
        title: 'Memory notes',
      }),
      blocks: [
        makeBlock({
          id: 'blk_revision_2',
          content: `${QUOTE} Updated.`,
          startOffset: 0,
          endOffset: `${QUOTE} Updated.`.length,
        }),
      ],
      originalData: null,
      parserFingerprint: 'parser-fingerprint-2',
      contentFingerprint: 'content-fingerprint-2',
      parserAttemptId: 'attempt-2',
      createdAt: T0,
    });
    repos.materialRevisions.activate('mat_1', 'revision-2', T0);
    const after = buildCurriculumExecutionContext(repos, contract).manifest;

    expect(repos.learningContracts.get(contract.id)).toEqual(sameContract);
    expect(after.revisions[0]!.materialId).toBe(before.revisions[0]!.materialId);
    expect(after.revisions[0]!.materialRevisionId).not.toBe(
      before.revisions[0]!.materialRevisionId,
    );
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(JSON.stringify(contract.courseScope)).not.toContain('materialRevisionId');
  });

  it('keeps learner scope unverified until separate validated truth authority exists', async () => {
    const first = await curriculum.propose(proposalRequest('curriculum-unverified'));
    expect(
      first.curriculum.nodes.find((node) => node.learningUnit)?.learningUnit?.objectives[0],
    ).toMatchObject({ truthPremiseStatus: 'unverified', truthAuthorityRecordIds: [] });
    const rejected = curriculum.reject({
      command: command('curriculum-reject', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      reason: 'Add independently validated authority first.',
    }).curriculum;

    const authorityService = createSourceAuthorityService({
      sourceAuthority: repos.sourceAuthority,
      clock,
    });
    const revision = repos.materialRevisions.getActive('mat_1')!;
    const candidate = authorityService.createCandidate({
      workspaceId: 'ws_1',
      logicalSourceId: 'material:mat_1',
      materialId: 'mat_1',
      materialRevisionId: revision.id,
      premiseScope: 'Working memory capacity',
      policyBasis: {
        policyVersion: 'source-authority-v1',
        premiseKind: 'claim',
        basis: 'Exact accepted source quotation verified locally.',
      },
      actor: 'local_validator',
      claims: [{ claim: QUOTE, grounding: { blockId: 'blk_1', quote: QUOTE } }],
    });
    authorityService.validate(candidate.record.id, candidate.record.version, 'operator');

    const second = await curriculum.propose(proposalRequest('curriculum-verified', rejected.id));
    expect(
      second.curriculum.nodes.find((node) => node.learningUnit)?.learningUnit?.objectives[0],
    ).toMatchObject({
      truthPremiseStatus: 'independently_verified',
      truthAuthorityRecordIds: [expect.any(String)],
    });
  });

  it('rejects a client-fabricated manifest and resolves provider context locally', async () => {
    const request = {
      ...proposalRequest('curriculum-client-manifest'),
      executionSourceManifest: {
        fingerprint: 'client-fabricated',
        revisions: [],
      },
    };
    await expect(curriculum.propose(request)).rejects.toThrow('Unrecognized key');
    expect(provider.calls).toBe(0);
    expect(repos.curricula.list('ws_1')).toEqual([]);

    const proposed = await curriculum.propose(proposalRequest('curriculum-server-manifest'));
    expect(provider.lastInput?.executionSourceManifest).toEqual(
      proposed.curriculum.executionSourceManifest,
    );
  });

  it('preserves an accepted Curriculum when successor generation fails', async () => {
    const proposal = proposalRequest('curriculum-first');
    const first = await curriculum.propose(proposal);
    expect(await curriculum.propose(proposal)).toEqual(first);
    expect(provider.calls).toBe(1);
    const acceptance = {
      command: command('curriculum-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review' as const,
    };
    const acceptedResponse = curriculum.accept(acceptance);
    expect(curriculum.accept(acceptance)).toEqual(acceptedResponse);
    const accepted = acceptedResponse.curriculum;
    provider.fail = true;

    await expect(
      curriculum.propose(proposalRequest('curriculum-successor-fails', accepted.id)),
    ).rejects.toThrow('controlled provider failure');
    expect(repos.curricula.get(accepted.id)?.status).toBe('accepted');
    expect(repos.curricula.list('ws_1')).toHaveLength(1);
  });

  it('fails closed on invalid citations and keeps acceptance expected-version safe', async () => {
    provider.makePayload = (input) => {
      const payload = new ControlledCurriculumProvider().makePayload(input);
      payload.nodes[2]!.sourceEvidence = [{ blockId: input.blocks[0]!.id, quote: 'not present' }];
      return payload;
    };
    await expect(curriculum.propose(proposalRequest('curriculum-invalid'))).rejects.toThrow(
      'deterministic local validation',
    );
    expect(repos.curricula.list('ws_1')).toEqual([]);

    provider.makePayload = new ControlledCurriculumProvider().makePayload;
    const proposed = await curriculum.propose(proposalRequest('curriculum-valid'));
    expect(() =>
      curriculum.accept({
        command: command('curriculum-stale-accept', 'learner'),
        curriculumId: proposed.curriculum.id,
        expectedVersion: proposed.curriculum.version + 1,
        expectedContractId: contract.id,
        expectedExecutionSourceManifestFingerprint:
          proposed.curriculum.executionSourceManifest.fingerprint,
        acceptanceBasis: 'learner_review',
      }),
    ).toThrow('acceptance identity is stale');
    expect(repos.curricula.get(proposed.curriculum.id)?.status).toBe('proposed');
  });
});
