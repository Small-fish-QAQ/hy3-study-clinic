import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorCode } from '@hy3-clinic/shared';
import type {
  CurriculumProposalPayload,
  LearningContract,
  LearningContractDraftFields,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import type { CurriculumProposalInput, ProviderCallOptions } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock, type Clock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';
import {
  buildCurriculumExecutionContext,
  createCurriculumService,
  CURRICULUM_OPERATION_LEASE_MS,
  type CurriculumService,
} from './curriculum.js';
import { createLearningContractService } from './learningContracts.js';
import { createMaterialRoleService } from './materialRoles.js';
import { createSourceAuthorityService } from './sourceAuthority.js';
import { buildCurriculumEvidenceCatalog } from './curriculumEvidence.js';
import { preflightStudyPlan } from './studyPlansAgent.js';

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
        sourceEvidence: [
          {
            evidenceId:
              input.evidenceCatalog.find((offer) => offer.quote === QUOTE)?.id ??
              input.evidenceCatalog[0]!.id,
          },
        ],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            key: 'objective-1',
            title: QUOTE,
            description: QUOTE,
            evidence: [
              {
                evidenceId:
                  input.evidenceCatalog.find((offer) => offer.quote === QUOTE)?.id ??
                  input.evidenceCatalog[0]!.id,
              },
            ],
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
let commands: ReturnType<typeof createCourseCommandService>;
let roles: ReturnType<typeof createMaterialRoleService>;

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

function currentProposalRequest(id: string, predecessorCurriculumId: string | null = null) {
  return {
    ...proposalRequest(id, predecessorCurriculumId),
    expectedActiveCurriculumId: repos.courseExecution.get('ws_1').activeCurriculumId,
  };
}

function curriculumEvidenceId(): string {
  const context = buildCurriculumExecutionContext(repos, contract);
  return buildCurriculumEvidenceCatalog({
    workspaceId: 'ws_1',
    manifest: context.manifest,
    blocks: context.blocks,
    preferredGroundings: [],
  }).find((offer) => offer.quote === QUOTE)!.id;
}

function payloadForFetch(evidenceId = curriculumEvidenceId()): CurriculumProposalPayload {
  const input = {
    blocks: repos.materials.getBlocks('mat_1'),
    evidenceCatalog: [{ id: evidenceId, quote: QUOTE }],
  } as CurriculumProposalInput;
  const payload = new ControlledCurriculumProvider().makePayload(input);
  payload.nodes[2]!.sourceEvidence = [{ evidenceId }];
  payload.nodes[2]!.objectives[0]!.evidence = [{ evidenceId }];
  return payload;
}

function useMockedHy3(contents: string[], beforeResponse?: (index: number) => void) {
  let index = 0;
  const fetchMock = vi.fn<typeof fetch>(async () => {
    beforeResponse?.(index);
    const content = contents[Math.min(index, contents.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const hy3 = new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key-never-persist',
    model: 'test-model',
    timeoutMs: 30_000,
    fetchImpl: fetchMock,
  });
  curriculum = createCurriculumService({
    repos,
    provider: hy3,
    clock,
    commands: createCourseCommandService({ repos, clock }),
    sourceAuthority: createSourceAuthorityService({
      sourceAuthority: repos.sourceAuthority,
      clock,
    }),
  });
  return fetchMock;
}

function attemptsForCommand(commandId: string) {
  const row = db
    .prepare(
      `SELECT lc.id
       FROM model_logical_calls lc
       JOIN agent_operations op ON op.id = lc.operation_id
       WHERE op.command_id = ?`,
    )
    .get(commandId) as { id: string } | undefined;
  return row ? repos.telemetry.listAttempts(row.id) : [];
}

function usageRowsForCommand(commandId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM model_usage_records u
         JOIN model_call_attempts a ON a.id = u.attempt_id
         JOIN model_logical_calls lc ON lc.id = a.logical_call_id
         JOIN agent_operations op ON op.id = lc.operation_id
         WHERE op.command_id = ?`,
      )
      .get(commandId) as { count: number }
  ).count;
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
  commands = createCourseCommandService({ repos, clock });
  roles = createMaterialRoleService({ repos, clock, commands });
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
  curriculum = createCurriculumService({
    repos,
    provider,
    clock,
    commands,
    sourceAuthority: createSourceAuthorityService({
      sourceAuthority: repos.sourceAuthority,
      clock,
    }),
  });
});

describe('Curriculum proposal and authority boundaries', () => {
  it('LIVE01-E blocks Curriculum when a future role version re-stales Contract scope', async () => {
    const scoped = contract.courseScope.materials[0]!;
    const future = roles.propose({
      command: command('live01-future-role', 'learner'),
      materialId: scoped.materialId,
      role: scoped.role,
      expectedCurrentAssignmentId: scoped.materialRoleAssignmentId,
    });

    await expect(curriculum.propose(proposalRequest('live01-stale-curriculum'))).rejects.toThrow(
      'Material role assignment is stale or unconfirmed',
    );
    expect(provider.calls).toBe(0);
    expect(future).toMatchObject({
      materialId: scoped.materialId,
      predecessorId: scoped.materialRoleAssignmentId,
      version: scoped.materialRoleAssignmentVersion + 1,
      status: 'proposed',
    });
    expect(repos.materials.get(scoped.materialId)?.id).toBe(scoped.materialId);
  });

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

  it('keeps learner scope separate while a local validator admits exact source statements', async () => {
    const revision = repos.materialRevisions.getActive('mat_1')!;
    expect(repos.sourceAuthority.findEligibleByBlock('ws_1', revision.id, 'blk_1')).toEqual([]);

    const proposed = await curriculum.propose(proposalRequest('curriculum-verified'));
    expect(
      proposed.curriculum.nodes.find((node) => node.learningUnit)?.learningUnit?.objectives[0],
    ).toMatchObject({
      truthPremiseStatus: 'independently_verified',
      truthAuthorityRecordIds: [expect.any(String), expect.any(String)],
    });
    const admitted = repos.sourceAuthority.findEligibleByBlock('ws_1', revision.id, 'blk_1');
    expect(admitted.every((bundle) => bundle.record.actor === 'local_validator')).toBe(true);
    expect(
      admitted.flatMap((bundle) => bundle.claims).every((claim) => claim.claim === claim.quote),
    ).toBe(true);
    expect(provider.lastInput?.evidenceCatalog.some((offer) => offer.quote === QUOTE)).toBe(true);
    expect(
      proposed.curriculum.nodes.find((node) => node.learningUnit)?.sourceReferences[0],
    ).toMatchObject({
      materialId: 'mat_1',
      materialRevisionId: revision.id,
      sourceBlockId: 'blk_1',
      sourceBlockRevisionFingerprint: expect.stringMatching(/^block_/),
    });
    expect(attemptsForCommand('curriculum-verified')).toHaveLength(1);
    expect(usageRowsForCommand('curriculum-verified')).toBe(1);
  });

  it('links ordinary Fake Curriculum premises to exact locally admitted source claims', async () => {
    const fake = createCurriculumService({
      repos,
      provider: new FakeProvider(),
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
    });

    const proposed = await fake.propose(proposalRequest('curriculum-fake-authority'));
    const objectives = proposed.curriculum.nodes.flatMap(
      (node) => node.learningUnit?.objectives ?? [],
    );

    expect(objectives).not.toHaveLength(0);
    expect(
      objectives.every((objective) => objective.truthPremiseStatus === 'independently_verified'),
    ).toBe(true);
    expect(objectives.every((objective) => objective.truthAuthorityRecordIds.length >= 2)).toBe(
      true,
    );
    expect(objectives.some((objective) => objective.title.startsWith('Understand '))).toBe(true);
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

  it('offers and validates canonical Concepts backed by scoped source Concepts', async () => {
    const concept = {
      id: 'concept_working_memory',
      materialId: 'mat_1',
      name: 'Working memory',
      summary: QUOTE,
      importance: 'high' as const,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: T0,
    };
    repos.materials.addConcepts([concept]);
    repos.alignment.ensureBaseline('ws_1', [concept], T0);
    const canonicalId = repos.alignment.listCanonical('ws_1')[0]!.id;
    provider.makePayload = (input) => {
      const payload = new ControlledCurriculumProvider().makePayload(input);
      payload.nodes[2]!.conceptIds = [concept.id];
      payload.nodes[2]!.canonicalConceptIds = [canonicalId];
      return payload;
    };

    const proposed = await curriculum.propose(proposalRequest('curriculum-canonical-context'));

    expect(provider.lastInput?.allowedCanonicalConceptIds).toEqual([canonicalId]);
    expect(provider.lastInput?.canonicalConcepts).toEqual([
      {
        id: canonicalId,
        displayName: 'Working memory',
        sourceConceptIds: [concept.id],
      },
    ]);
    expect(
      proposed.curriculum.nodes.find((node) => node.kind === 'learning_unit')?.learningUnit,
    ).toMatchObject({
      conceptIds: [concept.id],
      canonicalConceptIds: [canonicalId],
    });
    const preflight = preflightStudyPlan(
      repos,
      clock,
      contract,
      proposed.curriculum,
      'Memory course',
    );
    expect(preflight.executableLearningUnitCount).toBe(1);
    expect(preflight.canGenerate).toBe(true);
  });

  it('enforces an explicitly configured operation cap before a Curriculum provider call', async () => {
    repos.telemetry.upsertCostPolicy({
      id: 'curriculum_cost_policy',
      policyKey: 'curriculum-cost-policy',
      workspaceId: 'ws_1',
      scopeType: 'operation',
      scopeKey: 'propose_curriculum',
      limitMicrounits: 0,
      currency: 'USD',
      onExceed: 'refuse',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    await expect(curriculum.propose(proposalRequest('curriculum-cost-refused'))).rejects.toThrow(
      'does not permit another provider operation',
    );
    expect(provider.calls).toBe(0);
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 0,
      physicalAttempts: 0,
    });
  });

  it('preserves an accepted Curriculum when successor generation fails', async () => {
    const proposal = proposalRequest('curriculum-first');
    const first = await curriculum.propose(proposal);
    expect(await curriculum.propose(proposal)).toEqual(first);
    expect(provider.calls).toBe(1);
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 1,
      attemptsWithKnownCost: 1,
    });
    expect(usageRowsForCommand('curriculum-first')).toBe(1);
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
      payload.nodes[2]!.sourceEvidence = [{ evidenceId: 'cev_outside_offered_manifest' }];
      return payload;
    };
    await expect(curriculum.propose(proposalRequest('curriculum-invalid'))).rejects.toThrow(
      '资料一致性检查',
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

  it('repairs a schema-valid invalid evidence selection once and persists only the repaired candidate', async () => {
    const invalid = payloadForFetch('cev_not_offered');
    const valid = payloadForFetch();
    const fetchMock = useMockedHy3([JSON.stringify(invalid), JSON.stringify(valid)]);

    const proposed = await curriculum.propose(proposalRequest('curriculum-semantic-repair'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proposed.curriculum.validation.valid).toBe(true);
    expect(repos.curricula.list('ws_1')).toHaveLength(1);
    expect(attemptsForCommand('curriculum-semantic-repair')).toMatchObject([
      {
        attemptKind: 'original',
        status: 'completed',
        errorCode: 'CANDIDATE_VALIDATION_REPAIR_REQUIRED',
      },
      { attemptKind: 'repair', status: 'completed' },
    ]);
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 2,
      attemptsWithKnownCost: 0,
    });
    expect(usageRowsForCommand('curriculum-semantic-repair')).toBe(2);
  });

  it('fails after one semantic repair, preserves the accepted Curriculum, and persists safe details', async () => {
    const first = await curriculum.propose(proposalRequest('curriculum-prior-valid'));
    const accepted = curriculum.accept({
      command: command('curriculum-prior-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const acceptedSnapshot = structuredClone(accepted);
    const executionSnapshot = structuredClone(repos.courseExecution.get('ws_1'));
    const invalid = payloadForFetch('cev_still_not_offered');
    const fetchMock = useMockedHy3([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      curriculum.propose(currentProposalRequest('curriculum-semantic-repair-fails', accepted.id)),
    ).rejects.toMatchObject({
      code: ApiErrorCode.GroundingFailed,
      message: expect.stringContaining('原版本未改变。系统已尝试一次修复。'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attemptsForCommand('curriculum-semantic-repair-fails')).toHaveLength(2);
    expect(usageRowsForCommand('curriculum-semantic-repair-fails')).toBe(2);
    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual([accepted.id]);
    expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);
    expect(repos.courseExecution.get('ws_1')).toEqual(executionSnapshot);
    const operation = db
      .prepare(`SELECT id FROM agent_operations WHERE command_id = ?`)
      .get('curriculum-semantic-repair-fails') as { id: string };
    const result = repos.operations.getResult(operation.id);
    expect(result).toMatchObject({
      status: 'failed',
      payload: {
        code: ApiErrorCode.GroundingFailed,
        details: {
          kind: 'curriculum_candidate_validation',
          repairAttempted: true,
          errors: expect.arrayContaining([
            expect.stringContaining('offered Curriculum evidence ID'),
          ]),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('test-key-never-persist');
  });

  it('does not stack semantic repair after a schema-invalid original consumed the allowance', async () => {
    const invalidSemantic = payloadForFetch('cev_not_offered_after_schema_repair');
    const fetchMock = useMockedHy3(['{}', JSON.stringify(invalidSemantic)]);

    await expect(
      curriculum.propose(proposalRequest('curriculum-schema-then-semantic')),
    ).rejects.toMatchObject({ code: ApiErrorCode.GroundingFailed });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attemptsForCommand('curriculum-schema-then-semantic')).toMatchObject([
      { attemptKind: 'original', errorCode: 'STRUCTURED_OUTPUT_REPAIR_REQUIRED' },
      { attemptKind: 'repair', status: 'failed' },
    ]);
    expect(usageRowsForCommand('curriculum-schema-then-semantic')).toBe(2);
    expect(repos.curricula.list('ws_1')).toEqual([]);
  });

  it('does not ask the model to repair an authoritative manifest change', async () => {
    const invalid = payloadForFetch('cev_not_offered_during_authority_race');
    const fetchMock = useMockedHy3([JSON.stringify(invalid)], (index) => {
      if (index !== 0) return;
      const content = `${QUOTE} Updated.`;
      repos.materialRevisions.stage({
        revisionId: 'revision-during-provider-call',
        material: makeMaterial({ content, charCount: content.length, title: 'Memory notes' }),
        blocks: [
          makeBlock({
            id: 'blk_during_provider_call',
            content,
            startOffset: 0,
            endOffset: content.length,
          }),
        ],
        originalData: null,
        parserFingerprint: 'parser-during-provider-call',
        contentFingerprint: 'content-during-provider-call',
        parserAttemptId: 'attempt-during-provider-call',
        createdAt: T0,
      });
      repos.materialRevisions.activate('mat_1', 'revision-during-provider-call', T0);
    });

    await expect(
      curriculum.propose(proposalRequest('curriculum-authority-race')),
    ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attemptsForCommand('curriculum-authority-race')).toHaveLength(1);
    expect(repos.curricula.list('ws_1')).toEqual([]);
  });

  it('keeps ownership through a bounded Curriculum repair crossing five minutes', async () => {
    let nowMs = Date.parse(T0);
    const timedClock: Clock = { now: () => new Date(nowMs) };
    class TimedRepairProvider extends ControlledCurriculumProvider {
      override async proposeCurriculum(
        input: CurriculumProposalInput,
        opts?: ProviderCallOptions,
      ): Promise<CurriculumProposalPayload> {
        this.calls += 1;
        this.lastInput = input;
        nowMs = Date.parse(T0) + 4 * 60 * 1000;
        opts?.onRepairAttempt?.('candidate');
        nowMs = Date.parse(T0) + 6 * 60 * 1000;
        return this.makePayload(input);
      }
    }
    curriculum = createCurriculumService({
      repos,
      provider: new TimedRepairProvider(),
      clock: timedClock,
      commands: createCourseCommandService({ repos, clock: timedClock }),
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock: timedClock,
      }),
    });

    const proposed = await curriculum.propose(proposalRequest('curriculum-long-repair'));
    const operation = db
      .prepare(
        `SELECT id, lease_expires_at AS leaseExpiresAt FROM agent_operations WHERE command_id = ?`,
      )
      .get('curriculum-long-repair') as { id: string; leaseExpiresAt: string | null };

    expect(CURRICULUM_OPERATION_LEASE_MS).toBe(10 * 60 * 1000);
    expect(proposed.curriculum.status).toBe('proposed');
    expect(attemptsForCommand('curriculum-long-repair')).toHaveLength(2);
    expect(operation.leaseExpiresAt).toBeNull();
    expect(repos.operations.getResult(operation.id)?.status).toBe('completed');
  });
});
