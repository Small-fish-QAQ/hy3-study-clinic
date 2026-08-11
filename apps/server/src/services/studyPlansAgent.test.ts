import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Curriculum,
  type LearningContract,
  type LearningContractFeasibility,
  type StudyPlanProposalPayload,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { ProviderCallOptions, StudyPlanProposalInput } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeConcept, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';
import { createCourseExecutionService } from './courseExecution.js';
import { createSessionAgendaAgentService } from './sessionAgendasAgent.js';
import { createStudyPlanAgentService } from './studyPlansAgent.js';

const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const clock = fixedClock(T2);

let db: SqliteDb;
let repos: Repositories;
let contract: LearningContract;
let curriculum: Curriculum;

function command(id: string) {
  return { commandId: id, idempotencyKey: id, workspaceId: 'ws_1', actor: 'learner' } as const;
}

class CapturingPlanProvider extends FakeProvider {
  calls = 0;
  input: StudyPlanProposalInput | null = null;
  inTransaction = false;

  constructor(private readonly output?: StudyPlanProposalPayload) {
    super();
  }

  override async proposeStudyPlan(
    input: StudyPlanProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalPayload> {
    this.calls += 1;
    this.input = input;
    this.inTransaction = db.inTransaction;
    return this.output ?? super.proposeStudyPlan(input, opts);
  }
}

function proposalRequest(id: string, predecessorStudyPlanId: string | null = null) {
  return {
    command: command(id),
    contractId: contract.id,
    expectedContractVersion: contract.version,
    curriculumId: curriculum.id,
    expectedCurriculumVersion: curriculum.version,
    expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    predecessorStudyPlanId,
    expectedAcceptedStudyPlanId: repos.courseExecution.get('ws_1').acceptedPlanId,
    proposalTrigger: 'Initial learner-confirmed route.',
  };
}

function decisionRequest(id: string, planId: string, decision: 'accept' | 'reject') {
  const plan = repos.studyPlans.get(planId)!;
  return {
    command: command(id),
    studyPlanId: plan.id,
    expectedVersion: plan.version,
    expectedContractId: plan.contractVersionId,
    expectedCurriculumId: plan.curriculumVersionId,
    expectedExecutionSourceManifestFingerprint: plan.executionSourceManifestFingerprint,
    decision,
    reason: decision === 'reject' ? 'Learner wants a different route.' : null,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
  repos.materials.replaceConcepts('mat_1', [makeConcept()]);

  const revision = repos.materialRevisions.getActive('mat_1')!;
  const legacyRole = repos.materialRoles.getCurrent('mat_1')!;
  const proposedRole = repos.materialRoles.createVersion({
    id: 'role_course',
    materialId: 'mat_1',
    version: 2,
    predecessorId: legacyRole.id,
    role: 'course_material',
    status: 'proposed',
    proposedBy: 'learner',
    learnerConfirmedAt: null,
    createdAt: T0,
  });
  const role = repos.materialRoles.confirm(proposedRole.id, T1);
  const block = repos.materials.getBlock('blk_1')!;
  repos.sourceAuthority.createVersion({
    id: 'authority_1',
    workspaceId: 'ws_1',
    logicalSourceId: 'logical_truth_1',
    materialId: 'mat_1',
    materialRevisionId: revision.id,
    predecessorId: null,
    premiseScope: 'verified-objective',
    policyBasis: {
      policyVersion: 'truth-v1',
      premiseKind: 'claim',
      basis: 'exact-source',
    },
    validationState: 'validated',
    conflictState: 'none',
    actor: 'local_validator',
    createdAt: T0,
    updatedAt: T0,
    claims: [
      {
        id: 'claim_1',
        sourceBlockId: block.id,
        claim: 'Working memory has limited capacity.',
        quote: block.content,
        startOffset: 0,
        endOffset: block.content.length,
        occurrenceCount: 1,
        createdAt: T0,
      },
    ],
    event: {
      id: 'authority_event_1',
      eventType: 'validated',
      actor: 'local_validator',
      payload: {},
      createdAt: T0,
    },
  });

  const draftContract: LearningContract = {
    id: 'contract_1',
    workspaceId: 'ws_1',
    version: 1,
    predecessorId: null,
    intent: 'Learn working-memory capacity.',
    targetOutcome: { description: 'Working fluency', targetScore: null, credential: null },
    deadline: null,
    studyBudget: {
      minutesPerDay: 60,
      minutesPerWeek: null,
      preferredSessionMinutes: 30,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Memory'],
      materials: [
        {
          materialId: 'mat_1',
          materialRoleAssignmentId: role.id,
          materialRoleAssignmentVersion: role.version,
          role: role.role,
          disposition: 'included',
        },
      ],
      includedTopics: [],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: {
      description: null,
      allowExplicitDeferral: true,
      maximumUnresolvedPriority: 'high',
    },
    status: 'draft',
    proposedBy: 'learner',
    learnerConfirmedAt: null,
    createdAt: T0,
  };
  const feasibility: LearningContractFeasibility = {
    state: 'unknown',
    deadlineAt: null,
    availableMinutes: null,
    projectedMinutes: null,
    slackMinutes: null,
    reasonCodes: ['deadline_absent'],
    assumptions: ['No deadline supplied.'],
    policyVersion: 'feasibility-v1',
    computedAt: T0,
  };
  repos.learningContracts.createVersion(draftContract, feasibility, {
    id: 'contract_event_created',
    eventType: 'draft_created',
    actor: 'learner',
    payload: {},
    createdAt: T0,
  });
  repos.learningContracts.transition(draftContract.id, 'draft', 'proposed', T1, {
    id: 'contract_event_proposed',
    eventType: 'proposed',
    actor: 'learner',
    payload: {},
    createdAt: T1,
  });
  contract = repos.learningContracts.transition(
    draftContract.id,
    'proposed',
    'learner_confirmed',
    T2,
    {
      id: 'contract_event_confirmed',
      eventType: 'learner_confirmed',
      actor: 'learner',
      payload: {},
      createdAt: T2,
    },
  );

  const manifest = {
    fingerprint: 'manifest-1',
    revisions: [
      {
        materialId: 'mat_1',
        materialRevisionId: revision.id,
        parserVersion: 'text-v1',
        parserFingerprint: null,
        sourceBlockRevisionIds: ['blk_1'],
      },
    ],
  };
  repos.curricula.createManifest('manifest_1', 'ws_1', manifest, T0);
  const proposedCurriculum: Curriculum = {
    id: 'curriculum_1',
    workspaceId: 'ws_1',
    contractVersionId: contract.id,
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: manifest,
    nodes: [
      {
        id: 'course_root',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Memory course',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'unit_1',
        parentId: 'course_root',
        kind: 'learning_unit',
        index: 0,
        title: 'Working-memory capacity',
        sourceReferences: [
          {
            materialId: 'mat_1',
            materialRevisionId: revision.id,
            structuralUnitId: null,
            sourceBlockId: 'blk_1',
            sourceBlockRevisionFingerprint: 'block-fingerprint-1',
          },
        ],
        learningUnit: {
          conceptIds: ['con_1'],
          canonicalConceptIds: [],
          objectives: [
            {
              id: 'objective_verified',
              title: 'Explain capacity',
              description: 'Explain the capacity claim from the source.',
              truthPremiseStatus: 'independently_verified',
              truthAuthorityRecordIds: ['authority_1'],
            },
            {
              id: 'objective_unverified',
              title: 'Speculate about mechanisms',
              description: 'Explore a mechanism not established by Course Truth.',
              truthPremiseStatus: 'unverified',
              truthAuthorityRecordIds: [],
            },
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ],
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fake',
    providerModel: null,
    createdAt: T0,
    acceptedAt: null,
  };
  repos.curricula.createVersion(proposedCurriculum, {
    id: 'curriculum_event_created',
    eventType: 'proposed',
    actor: 'local',
    payload: {},
    createdAt: T0,
  });
  curriculum = repos.curricula.accept(proposedCurriculum.id, T2, {
    id: 'curriculum_event_accepted',
    eventType: 'accepted',
    actor: 'learner',
    payload: {},
    createdAt: T2,
  });
});

function services(provider: CapturingPlanProvider) {
  const commands = createCourseCommandService({ repos, clock });
  const agendas = createSessionAgendaAgentService({ repos, clock });
  return {
    plans: createStudyPlanAgentService({ repos, provider, clock, commands }),
    execution: createCourseExecutionService({ repos, clock, commands, agendas }),
    agendas,
    commands,
  };
}

describe('StudyPlan proposal and accepted Course route', () => {
  it('keeps authority policy, identifiers, and feasibility local and replays exactly once', async () => {
    const provider = new CapturingPlanProvider({
      rationale: 'Check both objectives.',
      items: [
        {
          key: 'formal-1',
          phase: 'Core route',
          kind: 'formal_checkpoint',
          curriculumLearningUnitId: 'unit_1',
          rationale: 'Test the unit.',
          estimatedMinutes: 15,
          targetDepth: 'working_fluency',
          objectiveIds: ['objective_verified', 'objective_unverified'],
          prerequisiteItemKeys: [],
        },
      ],
      deferrals: [],
    });
    const { plans } = services(provider);
    const request = proposalRequest('plan-propose');
    const first = await plans.propose(request);
    const replay = await plans.propose(request);

    expect(provider.calls).toBe(1);
    expect(provider.inTransaction).toBe(false);
    expect(replay.studyPlan.id).toBe(first.studyPlan.id);
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 1,
      attemptsWithKnownCost: 0,
    });
    expect(repos.studyPlans.list('ws_1')).toHaveLength(1);
    expect(provider.input?.launchCapabilities[0]?.allowedItemKinds).toContain('formal_checkpoint');
    expect(provider.input?.contract.materials[0]).not.toHaveProperty('materialRevisionId');
    expect(first.studyPlan.paceBaseline?.estimateSource).toBe('local');
    const requirements = first.studyPlan.items[0]!.completionRequirements;
    expect(
      requirements.find((item) => item.objectiveIds[0] === 'objective_verified'),
    ).toMatchObject({
      blocking: true,
      admissibilityTier: 'tier_1_authorized_truth',
    });
    expect(
      requirements.find((item) => item.objectiveIds[0] === 'objective_unverified'),
    ).toMatchObject({
      blocking: false,
      admissibilityTier: 'tier_3_advisory',
    });
  });

  it('rejects omitted Curriculum work without replacing a prior valid proposal', async () => {
    const validProvider = new CapturingPlanProvider();
    const { plans } = services(validProvider);
    const valid = await plans.propose(proposalRequest('valid-plan'));
    const invalidProvider = new CapturingPlanProvider({
      rationale: 'Omit one objective.',
      items: [
        {
          key: 'teach-1',
          phase: 'Core route',
          kind: 'teach_unit',
          curriculumLearningUnitId: 'unit_1',
          rationale: 'Teach only verified content.',
          estimatedMinutes: 20,
          targetDepth: 'working_fluency',
          objectiveIds: ['objective_verified'],
          prerequisiteItemKeys: [],
        },
      ],
      deferrals: [],
    });
    const invalidPlans = createStudyPlanAgentService({
      repos,
      provider: invalidProvider,
      clock,
      commands: createCourseCommandService({ repos, clock }),
    });

    await expect(
      invalidPlans.propose(proposalRequest('invalid-plan', valid.studyPlan.id)),
    ).rejects.toThrow('failed local validation');
    expect(repos.studyPlans.list('ws_1').map((plan) => plan.id)).toEqual([valid.studyPlan.id]);
  });

  it('edits a deferral atomically, removes planned overlap, and replays without duplication', async () => {
    const { plans } = services(new CapturingPlanProvider());
    const original = await plans.propose(proposalRequest('plan-before-edit'));
    const request = {
      command: command('plan-edit-defer'),
      studyPlanId: original.studyPlan.id,
      expectedVersion: original.studyPlan.version,
      expectedContractId: contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      edit: {
        kind: 'defer' as const,
        curriculumLearningUnitId: 'unit_1',
        objectiveIds: ['objective_unverified'],
        reason: 'Defer the unverified extension.',
        riskIds: ['risk_manual_deferral'],
      },
    };
    const edited = plans.applyDraftEdit(request);
    const replay = plans.applyDraftEdit(request);

    expect(replay.studyPlan.id).toBe(edited.studyPlan.id);
    expect(repos.studyPlans.list('ws_1')).toHaveLength(2);
    expect(repos.coverageRisks.list('ws_1')).toHaveLength(1);
    expect(edited.studyPlan.deferrals[0]).toMatchObject({
      objectiveIds: ['objective_unverified'],
      riskIds: ['risk_manual_deferral'],
    });
    expect(
      edited.studyPlan.items.some((item) => item.objectiveIds.includes('objective_unverified')),
    ).toBe(false);
  });

  it('atomically accepts a launchable route and exact replay creates no second Agenda', async () => {
    const provider = new CapturingPlanProvider();
    const { plans, execution } = services(provider);
    const proposed = await plans.propose(proposalRequest('plan-for-accept'));
    const request = decisionRequest('accept-plan', proposed.studyPlan.id, 'accept');
    const accepted = execution.decideStudyPlan(request);
    const replay = execution.decideStudyPlan(request);

    expect(accepted.activeRoute?.studyPlan.status).toBe('accepted');
    expect(accepted.activeRoute?.contract.status).toBe('active');
    expect(accepted.activeRoute?.agenda.status).toBe('active');
    expect(
      accepted.activeRoute?.agenda.items.every((item) => item.launch.status === 'launchable'),
    ).toBe(true);
    expect(replay.activeRoute?.agenda.id).toBe(accepted.activeRoute?.agenda.id);
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(1);
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe(proposed.studyPlan.id);
  });

  it('rejects a successor proposal while retaining the accepted route', async () => {
    const { plans, execution } = services(new CapturingPlanProvider());
    const first = await plans.propose(proposalRequest('first-plan'));
    execution.decideStudyPlan(decisionRequest('accept-first', first.studyPlan.id, 'accept'));
    const successor = await plans.propose(proposalRequest('successor-plan', first.studyPlan.id));
    const request = decisionRequest('reject-successor', successor.studyPlan.id, 'reject');
    const rejected = execution.decideStudyPlan(request);
    const replay = execution.decideStudyPlan(request);

    expect(rejected.decidedPlan.status).toBe('rejected');
    expect(rejected.retainedRoute?.studyPlan.id).toBe(first.studyPlan.id);
    expect(replay.retainedRoute?.studyPlan.id).toBe(first.studyPlan.id);
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe(first.studyPlan.id);
  });

  it('rolls back Agenda creation and preserves the proposal when activation cannot validate it', async () => {
    const provider = new CapturingPlanProvider();
    const { plans, agendas, commands } = services(provider);
    const proposed = await plans.propose(proposalRequest('plan-for-failed-accept'));
    const brokenAgendas = {
      composeDraft: (...args: Parameters<typeof agendas.composeDraft>) => ({
        ...agendas.composeDraft(...args),
        executionSourceManifestFingerprint: 'stale-manifest',
      }),
    } as typeof agendas;
    const execution = createCourseExecutionService({
      repos,
      clock,
      commands,
      agendas: brokenAgendas,
    });

    expect(() =>
      execution.decideStudyPlan(
        decisionRequest('accept-invalid-agenda', proposed.studyPlan.id, 'accept'),
      ),
    ).toThrow('incompatible');
    expect(repos.studyPlans.get(proposed.studyPlan.id)?.status).toBe('proposed');
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(0);
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBeNull();
  });
});
