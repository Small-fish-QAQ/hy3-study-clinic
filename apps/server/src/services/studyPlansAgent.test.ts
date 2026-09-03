import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiErrorCode,
  type Curriculum,
  type DesiredDepth,
  type LearningContract,
  type StudyPlanItem,
  type LearningContractFeasibility,
  type StudyPlanProposalPayload,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { AppError } from '../errors.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { ProviderCallOptions, StudyPlanProposalInput } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import {
  makeBlock,
  makeConcept,
  makeMaterial,
  makeSemanticallySupportedObjective,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import { fixedClock, type Clock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';
import { createCourseExecutionService } from './courseExecution.js';
import { buildCurriculumExecutionContext } from './curriculum.js';
import { createSessionAgendaAgentService } from './sessionAgendasAgent.js';
import {
  createStudyPlanAgentService,
  preflightStudyPlan,
  STUDY_PLAN_OPERATION_LEASE_MS,
} from './studyPlansAgent.js';
import { validateStudyPlanScopeAccounting } from './studyPlanValidation.js';
import { createReviewSuccessorService } from './reviewSuccessor.js';

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
  options: ProviderCallOptions | undefined;

  constructor(public output?: StudyPlanProposalPayload) {
    super();
  }

  override async proposeStudyPlan(
    input: StudyPlanProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalPayload> {
    this.calls += 1;
    this.input = input;
    this.inTransaction = db.inTransaction;
    this.options = opts;
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

function proposalWithDeferredOptionalObjective(): StudyPlanProposalPayload {
  return {
    rationale: 'Teach the required objective and explicitly defer the optional extension.',
    items: [
      {
        key: 'teach-required',
        phase: 'Core route',
        kind: 'teach_unit',
        curriculumLearningUnitId: 'unit_1',
        rationale: 'Teach the required working-memory relationship.',
        estimatedMinutes: 20,
        targetDepth: 'working_fluency',
        objectiveIds: ['objective_verified'],
        prerequisiteItemKeys: [],
      },
    ],
    deferrals: [
      {
        curriculumLearningUnitId: 'unit_1',
        objectiveIds: ['objective_unverified'],
        reason: 'Defer the optional recognition extension.',
      },
    ],
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

function removeCanonicalSemanticSupportForLegacyFixture(
  curriculumId: string,
  objectiveId: string,
): void {
  // Explicitly manufacture the state produced by migrating a version-40
  // Curriculum: its objective/index rows exist, but no canonical migration-41
  // semantic-support evidence was fabricated. This test-only transaction
  // restores the production immutability trigger before exposing the fixture.
  db.transaction(() => {
    db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_delete');
    const removed = db
      .prepare(
        `DELETE FROM curriculum_objective_semantic_support
         WHERE curriculum_id = ? AND objective_id = ?`,
      )
      .run(curriculumId, objectiveId);
    if (removed.changes !== 1) {
      throw new Error('Legacy semantic-support fixture objective is missing.');
    }
    db.exec(`
      CREATE TRIGGER prevent_curriculum_objective_semantic_support_delete
      BEFORE DELETE ON curriculum_objective_semantic_support
      WHEN EXISTS (
        SELECT 1 FROM curriculum_objective_index
        WHERE curriculum_id = OLD.curriculum_id AND objective_id = OLD.objective_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Curriculum objective semantic support is immutable');
      END;
    `);
  })();
}

function makePersistedObjectivePropositionStaleForFixture(
  curriculumId: string,
  objectiveId: string,
): void {
  const row = db
    .prepare('SELECT payload FROM curriculum_versions WHERE id = ?')
    .get(curriculumId) as { payload: string } | undefined;
  if (!row) throw new Error('Stale semantic-support fixture Curriculum is missing.');
  const aggregate = JSON.parse(row.payload) as Curriculum;
  const objective = aggregate.nodes
    .flatMap((node) => node.learningUnit?.objectives ?? [])
    .find((candidate) => candidate.id === objectiveId);
  if (!objective) throw new Error('Stale semantic-support fixture objective is missing.');
  objective.description = `${objective.description} Corrupt persisted proposition change.`;
  db.prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?').run(
    JSON.stringify(aggregate),
    curriculumId,
  );
}

function acceptSuccessorCurriculum(id: string): Curriculum {
  const previous = curriculum;
  const proposed: Curriculum = {
    ...previous,
    id,
    version: previous.version + 1,
    predecessorId: previous.id,
    status: 'proposed',
    acceptedAt: null,
  };
  repos.curricula.createVersion(
    proposed,
    {
      id: `${id}_proposed`,
      eventType: 'proposed',
      actor: 'local',
      payload: {},
      createdAt: T2,
    },
    { capabilityRecoveryPredecessorId: null },
  );
  curriculum = repos.curricula.accept(id, T2, {
    id: `${id}_accepted`,
    eventType: 'accepted',
    actor: 'learner',
    payload: {},
    createdAt: T2,
  });
  return curriculum;
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

  const manifest = buildCurriculumExecutionContext(repos, contract).manifest;
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
            makeSemanticallySupportedObjective(
              {
                id: 'objective_verified',
                title: 'Explain capacity',
                description:
                  'Explain the source-stated relationship that working-memory capacity is limited.',
                truthPremiseStatus: 'independently_verified',
                truthAuthorityRecordIds: ['authority_1'],
                authorityClaimIds: ['claim_1'],
                priority: 'required',
                formalAssessmentReady: true,
                formalAssessmentReadinessRationale:
                  'The exact source states the working-memory capacity relationship.',
                formalAssessmentConstruct: 'explain',
                authorityEnvelopeTier: 'formal_sufficient',
                authoritySourceBlockIds: ['blk_1'],
                formalEvidenceSourceBlockIds: ['blk_1'],
              },
              'relationship',
            ),
            makeSemanticallySupportedObjective(
              {
                id: 'objective_unverified',
                title: 'Identify capacity statement',
                description: 'Identify the source-stated limit on working-memory capacity.',
                truthPremiseStatus: 'unverified',
                truthAuthorityRecordIds: ['authority_1'],
                authorityClaimIds: ['claim_1'],
                priority: 'optional',
                formalAssessmentReady: false,
                formalAssessmentReadinessRationale:
                  'This advisory fixture intentionally retains unverified premise status.',
                formalAssessmentConstruct: 'identify',
                authorityEnvelopeTier: 'formal_sufficient',
                authoritySourceBlockIds: ['blk_1'],
                formalEvidenceSourceBlockIds: [],
              },
              'recognition',
            ),
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
  repos.curricula.createVersion(
    proposedCurriculum,
    {
      id: 'curriculum_event_created',
      eventType: 'proposed',
      actor: 'local',
      payload: {},
      createdAt: T0,
    },
    { capabilityRecoveryPredecessorId: null },
  );
  curriculum = repos.curricula.accept(proposedCurriculum.id, T2, {
    id: 'curriculum_event_accepted',
    eventType: 'accepted',
    actor: 'learner',
    payload: {},
    createdAt: T2,
  });
});

function services(provider: CapturingPlanProvider, serviceClock: Clock = clock) {
  const commands = createCourseCommandService({ repos, clock: serviceClock });
  const agendas = createSessionAgendaAgentService({ repos, clock: serviceClock });
  return {
    plans: createStudyPlanAgentService({ repos, provider, clock: serviceClock, commands }),
    execution: createCourseExecutionService({
      repos,
      clock: serviceClock,
      commands,
      agendas,
    }),
    agendas,
    commands,
  };
}

function studyPlanAuthorityPersistenceSnapshot() {
  return {
    plans: structuredClone(repos.studyPlans.list('ws_1')),
    risks: structuredClone(repos.coverageRisks.list('ws_1')),
    agendas: structuredClone(repos.sessionAgendas.list('ws_1')),
    execution: structuredClone(repos.courseExecution.get('ws_1')),
    planEvents: db.prepare('SELECT * FROM study_plan_events ORDER BY plan_id, seq').all(),
    planLaunches: db
      .prepare('SELECT * FROM study_plan_launch_validations ORDER BY plan_id, plan_item_id')
      .all(),
    planDeferrals: db
      .prepare('SELECT * FROM study_plan_deferrals ORDER BY plan_id, curriculum_learning_unit_id')
      .all(),
    planProgress: db
      .prepare('SELECT * FROM study_plan_progress ORDER BY plan_id, plan_item_id')
      .all(),
    riskEvents: db.prepare('SELECT * FROM coverage_risk_events ORDER BY risk_id, seq').all(),
    executionEvents: db
      .prepare('SELECT * FROM course_execution_events ORDER BY workspace_id, seq')
      .all(),
  };
}

interface PlannabilityObjectiveSpec {
  id: string;
  construct: SupportedFixtureConstruct;
  priority: 'required' | 'high' | 'normal' | 'optional';
}

/**
 * Core support type per construct, matching `requiredCore` in
 * `objectiveAuthoritySemanticSupport.ts`. `design` and `evaluate` have no core mapping
 * at all — the still-unlifted U-11 construct ceiling — so they cannot appear in a
 * semantically supported fixture and are deliberately absent here.
 */
const CORE_SUPPORT_TYPE = {
  identify: 'recognition',
  explain: 'relationship',
  apply: 'procedure',
} as const;

type SupportedFixtureConstruct = keyof typeof CORE_SUPPORT_TYPE;

interface PlannabilityUnitSpec {
  id: string;
  title: string;
  objectives: PlannabilityObjectiveSpec[];
}

/**
 * Persists and accepts a successor Curriculum whose LearningUnits carry exactly the
 * declared construct/priority shapes. Every objective declares its construct, so the
 * gate resolves it through the declared path rather than the title cue.
 */
function acceptCurriculumWithTeachingUnits(id: string, units: PlannabilityUnitSpec[]): Curriculum {
  const template = curriculum.nodes.find((node) => node.id === 'unit_1')!;
  const previous = curriculum;
  const nodes = [
    curriculum.nodes.find((node) => node.id === 'course_root')!,
    ...units.map((unit, unitIndex) => ({
      ...template,
      id: unit.id,
      index: unitIndex,
      title: unit.title,
      learningUnit: {
        ...template.learningUnit!,
        objectives: unit.objectives.map((spec) =>
          makeSemanticallySupportedObjective(
            {
              id: spec.id,
              title: `Objective ${spec.id}`,
              description: `Source-stated capability for ${spec.id} in ${unit.title}.`,
              truthPremiseStatus: 'independently_verified' as const,
              truthAuthorityRecordIds: ['authority_1'],
              authorityClaimIds: ['claim_1'],
              priority: spec.priority,
              formalAssessmentReady: true,
              formalAssessmentReadinessRationale:
                'The exact source states this capability for the plannability fixture.',
              formalAssessmentConstruct: spec.construct,
              authorityEnvelopeTier: 'formal_sufficient',
              authoritySourceBlockIds: ['blk_1'],
              formalEvidenceSourceBlockIds: ['blk_1'],
            },
            CORE_SUPPORT_TYPE[spec.construct],
          ),
        ),
        prerequisiteUnitIds: [],
      },
    })),
  ];
  const proposed: Curriculum = {
    ...previous,
    id,
    version: previous.version + 1,
    predecessorId: previous.id,
    status: 'proposed',
    acceptedAt: null,
    nodes,
    synthesisGroups: [],
  };
  repos.curricula.createVersion(
    proposed,
    { id: `${id}_proposed`, eventType: 'proposed', actor: 'local', payload: {}, createdAt: T2 },
    { capabilityRecoveryPredecessorId: null },
  );
  curriculum = repos.curricula.accept(id, T2, {
    id: `${id}_accepted`,
    eventType: 'accepted',
    actor: 'learner',
    payload: {},
    createdAt: T2,
  });
  return curriculum;
}

/** One teach_unit per declared unit, covering every objective so scope accounting passes. */
function teachingProposal(
  units: Array<{ unitId: string; objectiveIds: string[]; minutes: number; depth: DesiredDepth }>,
): StudyPlanProposalPayload {
  return {
    rationale: 'Teach each accepted unit at the requested depth and duration.',
    items: units.map((unit, index) => ({
      key: `teach-${index + 1}`,
      phase: 'Core route',
      kind: 'teach_unit' as const,
      curriculumLearningUnitId: unit.unitId,
      rationale: `Teach the accepted objective set for ${unit.unitId}.`,
      estimatedMinutes: unit.minutes,
      targetDepth: unit.depth,
      objectiveIds: unit.objectiveIds,
      prerequisiteItemKeys: [],
    })),
    deferrals: [],
  };
}

describe('StudyPlan proposal and accepted Course route', () => {
  it('allows synthesis items to account for objectives from every declared synthesis unit', () => {
    const secondUnit = {
      ...curriculum.nodes.find((node) => node.id === 'unit_1')!,
      id: 'unit_2',
      title: 'Working-memory transfer',
      learningUnit: {
        ...curriculum.nodes.find((node) => node.id === 'unit_1')!.learningUnit!,
        objectives: [
          makeSemanticallySupportedObjective(
            {
              id: 'objective_transfer',
              title: 'Identify capacity statement',
              description: 'Identify the source-stated limit on working-memory capacity.',
              truthPremiseStatus: 'unverified' as const,
              truthAuthorityRecordIds: ['authority_1'],
              authorityClaimIds: ['claim_1'],
              priority: 'optional',
              formalAssessmentReady: false,
              formalAssessmentReadinessRationale:
                'This advisory fixture intentionally retains unverified premise status.',
              formalAssessmentConstruct: 'identify',
              authorityEnvelopeTier: 'formal_sufficient',
              authoritySourceBlockIds: ['blk_1'],
              formalEvidenceSourceBlockIds: [],
            },
            'recognition',
          ),
        ],
      },
    };
    const synthesisCurriculum: Curriculum = {
      ...curriculum,
      nodes: [...curriculum.nodes, secondUnit],
      synthesisGroups: [
        {
          id: 'synthesis_1',
          title: 'Cross-unit transfer',
          level: 'course',
          learningUnitIds: ['unit_1', 'unit_2'],
          objectiveIds: ['objective_verified', 'objective_unverified', 'objective_transfer'],
        },
      ],
    };
    const item: StudyPlanItem = {
      id: 'plan_synthesis',
      index: 0,
      phase: 'Core route',
      kind: 'synthesis',
      curriculumLearningUnitId: 'unit_1',
      rationale: 'Connect both units.',
      estimatedMinutes: 20,
      targetDepth: 'working_fluency',
      objectiveIds: ['objective_verified', 'objective_unverified', 'objective_transfer'],
      prerequisitePlanItemIds: [],
      completionPolicy: null,
      completionRequirements: [],
    };

    expect(validateStudyPlanScopeAccounting(synthesisCurriculum, [item], [])).toEqual([]);
  });

  it('reports source-only accepted Curriculum as blocked before provider work', () => {
    const sourceOnly: Curriculum = {
      ...curriculum,
      nodes: curriculum.nodes.map((node) =>
        node.learningUnit
          ? {
              ...node,
              learningUnit: { ...node.learningUnit, conceptIds: [] },
            }
          : node,
      ),
    };

    const preflight = preflightStudyPlan(repos, clock, contract, sourceOnly, 'Memory course');

    expect(preflight).toMatchObject({
      totalLearningUnitCount: 1,
      executableLearningUnitCount: 0,
      nonExecutableLearningUnitCount: 1,
      planningRepresentationCount: 1,
      deferredOrUnplannableCount: 1,
      promptStrategy: 'blocked',
      providerPromptCharacters: null,
      approximatePromptTokens: null,
      canGenerate: false,
      blockers: [{ code: 'no_launchable_learning_unit', affectedLearningUnitCount: 1 }],
    });
    expect(preflight.planningInputCharacters).toBeGreaterThan(0);
    expect(preflight.allowedItemKindCounts.find((entry) => entry.kind === 'none')).toEqual({
      kind: 'none',
      learningUnitCount: 1,
    });
  });

  it('keeps due_review capability scoped to Concepts mapped to the LearningUnit', () => {
    const review = createReviewSuccessorService({ repos, clock });
    review.activate({
      workspaceId: 'ws_1',
      courseId: 'ws_1',
      learningUnitId: 'unit_1',
      objectiveId: 'objective_verified',
      contractVersionId: contract.id,
      curriculumVersionId: curriculum.id,
      manifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      evidenceId: 'evidence_due_review',
      sourceOutcomeId: 'evidence_due_review',
      at: T0,
      eligible: true,
    });
    db.prepare('UPDATE memory_schedule_states SET due_at = ? WHERE review_target_id = ?').run(
      T2,
      'review-target:ws_1:objective_verified',
    );
    const sourceOnly: Curriculum = {
      ...curriculum,
      nodes: curriculum.nodes.map((node) =>
        node.learningUnit
          ? { ...node, learningUnit: { ...node.learningUnit, conceptIds: [] } }
          : node,
      ),
    };

    const unrelated = preflightStudyPlan(repos, clock, contract, sourceOnly, 'Memory course');
    const mapped = preflightStudyPlan(repos, clock, contract, curriculum, 'Memory course');

    expect(unrelated.allowedItemKindCounts).toContainEqual({
      kind: 'none',
      learningUnitCount: 1,
    });
    expect(unrelated.allowedItemKindCounts).toContainEqual({
      kind: 'due_review',
      learningUnitCount: 0,
    });
    expect(mapped.allowedItemKindCounts).toContainEqual({
      kind: 'due_review',
      learningUnitCount: 1,
    });
  });

  it('fails locally without a provider call when no required unit is launchable', async () => {
    repos.materials.replaceConcepts('mat_1', []);
    const provider = new CapturingPlanProvider();
    const { plans } = services(provider);

    await expect(plans.propose(proposalRequest('no-launchable-unit'))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'StudyPlan generation requires at least one currently launchable LearningUnit.',
      details: {
        reason: 'no_launchable_learning_unit',
        requiredLearningUnitCount: 1,
        launchableLearningUnitCount: 0,
      },
    });
    expect(provider.calls).toBe(0);
    expect(repos.studyPlans.list('ws_1')).toHaveLength(0);
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBeNull();
  });

  it('allows an accepted Curriculum without semantic support to reach StudyPlan proposal', async () => {
    const provider = new CapturingPlanProvider();
    const { plans } = services(provider);
    removeCanonicalSemanticSupportForLegacyFixture(curriculum.id, 'objective_verified');
    const before = {
      plans: repos.studyPlans.list('ws_1').length,
      logicalCalls: (
        db.prepare('SELECT COUNT(*) AS count FROM model_logical_calls').get() as { count: number }
      ).count,
      physicalAttempts: (
        db.prepare('SELECT COUNT(*) AS count FROM model_call_attempts').get() as { count: number }
      ).count,
    };

    const proposed = await plans.propose(proposalRequest('artifact-free-curriculum-plan'));

    expect(proposed.studyPlan.status).toBe('proposed');
    expect(provider.calls).toBe(1);
    expect(repos.studyPlans.list('ws_1')).toHaveLength(before.plans + 1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_logical_calls').get()).toEqual({
      count: before.logicalCalls + 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_call_attempts').get()).toEqual({
      count: before.physicalAttempts + 1,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('blocks a direct StudyPlan command after a confirmed scope-role change without provider work', async () => {
    const acceptedSnapshot = structuredClone(repos.learningContracts.get(contract.id));
    const current = repos.materialRoles.getCurrent('mat_1')!;
    const proposal = repos.materialRoles.createVersion({
      id: 'role_scope_changed',
      materialId: 'mat_1',
      version: current.version + 1,
      predecessorId: current.id,
      role: 'supplementary_reference',
      status: 'proposed',
      proposedBy: 'learner',
      learnerConfirmedAt: null,
      createdAt: T2,
    });
    repos.materialRoles.confirm(proposal.id, T2);
    const provider = new CapturingPlanProvider();
    const { plans } = services(provider);

    await expect(plans.propose(proposalRequest('scope-changed-plan'))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: {
        kind: 'learning_contract_scope_changed',
        state: 'reconfirmation_required',
        issues: [
          {
            kind: 'material_role_changed',
            materialId: 'mat_1',
            contractedRole: 'course_material',
            currentConfirmedRole: 'supplementary_reference',
          },
        ],
      },
    });
    expect(provider.calls).toBe(0);
    expect(repos.studyPlans.list('ws_1')).toEqual([]);
    expect(repos.learningContracts.get(contract.id)).toEqual(acceptedSnapshot);
  });

  it('keeps StudyPlan persistence independent when semantic authority changes before commit', async () => {
    const provider = new CapturingPlanProvider(proposalWithDeferredOptionalObjective());
    const { plans } = services(provider);
    const curriculumSnapshot = structuredClone(repos.curricula.get(curriculum.id));
    const riskSnapshot = repos.coverageRisks.list('ws_1');

    const proposed = await plans.propose(
      proposalRequest('semantic-change-before-plan-persist'),
      undefined,
      {
        beforePersist: () =>
          makePersistedObjectivePropositionStaleForFixture(curriculum.id, 'objective_verified'),
      },
    );

    expect(provider.calls).toBe(1);
    expect(proposed.studyPlan.status).toBe('proposed');
    expect(repos.studyPlans.list('ws_1')).toHaveLength(1);
    expect(repos.coverageRisks.list('ws_1').length).toBeGreaterThanOrEqual(riskSnapshot.length);
    expect(repos.curricula.get(curriculum.id)).not.toEqual(curriculumSnapshot);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('fences direct StudyPlan and risk persistence when Contract scope changes before commit', async () => {
    const provider = new CapturingPlanProvider(proposalWithDeferredOptionalObjective());
    const { plans } = services(provider);
    const roleSnapshot = repos.materialRoles.getCurrent('mat_1')!;
    const riskSnapshot = repos.coverageRisks.list('ws_1');

    await expect(
      plans.propose(proposalRequest('scope-change-before-plan-persist'), undefined, {
        beforePersist: () => {
          const proposal = repos.materialRoles.createVersion({
            id: 'role_scope_changed_during_plan',
            materialId: 'mat_1',
            version: roleSnapshot.version + 1,
            predecessorId: roleSnapshot.id,
            role: 'supplementary_reference',
            status: 'proposed',
            proposedBy: 'learner',
            learnerConfirmedAt: null,
            createdAt: T2,
          });
          repos.materialRoles.confirm(proposal.id, T2);
        },
      }),
    ).rejects.toMatchObject({
      code: ApiErrorCode.VersionConflict,
      details: {
        kind: 'learning_contract_scope_changed',
        state: 'reconfirmation_required',
        issues: [
          {
            kind: 'material_role_changed',
            materialId: 'mat_1',
            contractedRole: 'course_material',
            currentConfirmedRole: 'supplementary_reference',
          },
        ],
      },
    });

    expect(provider.calls).toBe(1);
    expect(repos.studyPlans.list('ws_1')).toEqual([]);
    expect(repos.coverageRisks.list('ws_1')).toEqual(riskSnapshot);
    expect(repos.materialRoles.getCurrent('mat_1')).toEqual(roleSnapshot);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back a current-route version race before direct Plan or risk persistence', async () => {
    const initialServices = services(new CapturingPlanProvider());
    const acceptedProposal = await initialServices.plans.propose(
      proposalRequest('accepted-plan-before-proposal-route-race'),
    );
    initialServices.execution.decideStudyPlan(
      decisionRequest(
        'accept-plan-before-proposal-route-race',
        acceptedProposal.studyPlan.id,
        'accept',
      ),
    );
    const provider = new CapturingPlanProvider(proposalWithDeferredOptionalObjective());
    const { plans } = services(provider);
    const before = studyPlanAuthorityPersistenceSnapshot();
    const createRisk = vi.spyOn(repos.coverageRisks, 'create');
    const createPlan = vi.spyOn(repos.studyPlans, 'createVersion');
    const activeState = repos.courseExecution.get('ws_1');

    await expect(
      plans.propose(
        proposalRequest('successor-proposal-route-race', acceptedProposal.studyPlan.id),
        undefined,
        {
          beforePersist: () => {
            repos.courseExecution.transitionExecution({
              workspaceId: 'ws_1',
              expectedVersion: activeState.version,
              expectedAcceptedPlanId: activeState.acceptedPlanId!,
              expectedAgendaId: activeState.activeAgendaId!,
              transition: 'pause',
              eventId: 'execution_event_proposal_route_race',
              reason: 'Simulated proposal route-version race.',
              actor: 'learner',
              at: T2,
            });
          },
        },
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.VersionConflict,
      details: { kind: 'study_plan_route_state_changed' },
    });

    expect(provider.calls).toBe(1);
    expect(createRisk).not.toHaveBeenCalled();
    expect(createPlan).not.toHaveBeenCalled();
    expect(studyPlanAuthorityPersistenceSnapshot()).toEqual(before);
    expect(repos.studyPlans.get(acceptedProposal.studyPlan.id)?.status).toBe('accepted');
  });

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
    const preflight = preflightStudyPlan(repos, clock, contract, curriculum, 'Memory course');
    const request = proposalRequest('plan-propose');
    const first = await plans.propose(request);
    const replay = await plans.propose(request);

    expect(provider.calls).toBe(1);
    expect(preflight).toMatchObject({
      totalLearningUnitCount: 1,
      executableLearningUnitCount: 1,
      nonExecutableLearningUnitCount: 0,
      planningRepresentationCount: 1,
      deferredOrUnplannableCount: 0,
      promptStrategy: 'detailed_units',
      canGenerate: true,
      blockers: [],
    });
    expect(preflight.providerPromptCharacters).toBeGreaterThan(0);
    expect(provider.inTransaction).toBe(false);
    expect(provider.options?.timeoutMs).toBe(240_000);
    expect(replay.studyPlan.id).toBe(first.studyPlan.id);
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 1,
      attemptsWithKnownCost: 1,
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

  it('keeps ownership through a bounded repair that crosses the former five-minute lease', async () => {
    let nowMs = Date.parse(T2);
    const timedClock: Clock = { now: () => new Date(nowMs) };
    class TimedRepairProvider extends CapturingPlanProvider {
      override async proposeStudyPlan(
        input: StudyPlanProposalInput,
        opts?: ProviderCallOptions,
      ): Promise<StudyPlanProposalPayload> {
        this.calls += 1;
        this.input = input;
        this.options = opts;
        nowMs = Date.parse(T2) + 4 * 60 * 1000;
        opts?.onRepairAttempt?.();
        nowMs = Date.parse(T2) + 6 * 60 * 1000;
        return FakeProvider.prototype.proposeStudyPlan.call(this, input, opts);
      }
    }
    const provider = new TimedRepairProvider();
    const { plans } = services(provider, timedClock);

    const proposed = await plans.propose(proposalRequest('long-bounded-repair'));
    const operation = db
      .prepare(
        `SELECT id, lease_expires_at AS leaseExpiresAt
         FROM agent_operations WHERE operation_type = 'propose_study_plan'`,
      )
      .get() as { id: string; leaseExpiresAt: string | null };
    const logical = db
      .prepare('SELECT id FROM model_logical_calls WHERE operation_id = ?')
      .get(operation.id) as { id: string };

    expect(STUDY_PLAN_OPERATION_LEASE_MS).toBe(10 * 60 * 1000);
    expect(proposed.studyPlan.status).toBe('proposed');
    expect(repos.studyPlans.list('ws_1')).toHaveLength(1);
    expect(repos.telemetry.listAttempts(logical.id)).toHaveLength(2);
    expect(operation.leaseExpiresAt).toBeNull();
    expect(repos.operations.getResult(operation.id)?.status).toBe('completed');
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

  it('applies a draft edit when semantic authority becomes stale before completion', async () => {
    const { plans } = services(new CapturingPlanProvider());
    const original = await plans.propose(proposalRequest('plan-before-stale-edit'));
    const request = {
      command: command('plan-edit-stale-semantic'),
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
        riskIds: ['risk_stale_semantic_edit'],
      },
    };
    const curriculumSnapshot = structuredClone(repos.curricula.get(curriculum.id));
    const plansSnapshot = structuredClone(repos.studyPlans.list('ws_1'));
    const riskSnapshot = structuredClone(repos.coverageRisks.list('ws_1'));
    const executionSnapshot = structuredClone(repos.courseExecution.get('ws_1'));
    const eventSnapshot = db
      .prepare(
        `SELECT id, plan_id, seq, event_type, actor, payload, created_at
         FROM study_plan_events WHERE plan_id = ? ORDER BY seq`,
      )
      .all(original.studyPlan.id);

    const edited = plans.applyDraftEdit(request, {
      beforePersist: () =>
        makePersistedObjectivePropositionStaleForFixture(curriculum.id, 'objective_verified'),
    });
    expect(edited.studyPlan.predecessorId).toBe(original.studyPlan.id);
    expect(repos.curricula.get(curriculum.id)).not.toEqual(curriculumSnapshot);
    expect(repos.studyPlans.list('ws_1')).toHaveLength(plansSnapshot.length + 1);
    expect(repos.studyPlans.get(original.studyPlan.id)?.status).toBe('rejected');
    expect(repos.coverageRisks.list('ws_1').length).toBeGreaterThanOrEqual(riskSnapshot.length);
    const eventsAfterEdit = db
      .prepare(
        `SELECT id, plan_id, seq, event_type, actor, payload, created_at
         FROM study_plan_events WHERE plan_id = ? ORDER BY seq`,
      )
      .all(original.studyPlan.id);
    expect(eventsAfterEdit.slice(0, -1)).toEqual(eventSnapshot);
    expect(eventsAfterEdit.at(-1)).toMatchObject({
      plan_id: original.studyPlan.id,
      seq: eventSnapshot.length + 1,
      event_type: 'replaced_by_edit',
      actor: 'learner',
      payload: JSON.stringify({ successorId: edited.studyPlan.id }),
    });
    expect(repos.courseExecution.get('ws_1')).toEqual(executionSnapshot);
  });

  it('rolls back a current-route version race before any draft-edit mutation', async () => {
    const { plans, execution } = services(new CapturingPlanProvider());
    const acceptedProposal = await plans.propose(proposalRequest('plan-before-route-race'));
    execution.decideStudyPlan(
      decisionRequest('accept-plan-before-route-race', acceptedProposal.studyPlan.id, 'accept'),
    );
    const proposed = await plans.propose(
      proposalRequest('successor-before-route-race', acceptedProposal.studyPlan.id),
    );
    const request = {
      command: command('plan-edit-route-race'),
      studyPlanId: proposed.studyPlan.id,
      expectedVersion: proposed.studyPlan.version,
      expectedContractId: contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      edit: {
        kind: 'defer' as const,
        curriculumLearningUnitId: 'unit_1',
        objectiveIds: ['objective_unverified'],
        reason: 'Defer the optional extension after the route race.',
        riskIds: ['risk_route_race_edit'],
      },
    };
    const before = studyPlanAuthorityPersistenceSnapshot();
    const createRisk = vi.spyOn(repos.coverageRisks, 'create');
    const rejectPlan = vi.spyOn(repos.studyPlans, 'reject');
    const createPlan = vi.spyOn(repos.studyPlans, 'createVersion');
    const activeState = repos.courseExecution.get('ws_1');

    expect(() =>
      plans.applyDraftEdit(request, {
        beforePersist: () => {
          repos.courseExecution.transitionExecution({
            workspaceId: 'ws_1',
            expectedVersion: activeState.version,
            expectedAcceptedPlanId: activeState.acceptedPlanId!,
            expectedAgendaId: activeState.activeAgendaId!,
            transition: 'pause',
            eventId: 'execution_event_route_race',
            reason: 'Simulated route-version race.',
            actor: 'learner',
            at: T2,
          });
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: ApiErrorCode.VersionConflict,
        details: expect.objectContaining({ kind: 'study_plan_route_state_changed' }),
      }),
    );

    expect(createRisk).not.toHaveBeenCalled();
    expect(rejectPlan).not.toHaveBeenCalled();
    expect(createPlan).not.toHaveBeenCalled();
    expect(studyPlanAuthorityPersistenceSnapshot()).toEqual(before);
    expect(repos.studyPlans.get(proposed.studyPlan.id)?.status).toBe('proposed');
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

  it('activates an exact Curriculum and StudyPlan successor lineage without rewriting predecessor content', async () => {
    const { plans, execution } = services(new CapturingPlanProvider());
    const predecessorPlanProposal = await plans.propose(
      proposalRequest('semantic-lineage-predecessor-plan'),
    );
    const predecessorRoute = execution.decideStudyPlan(
      decisionRequest(
        'semantic-lineage-predecessor-activate',
        predecessorPlanProposal.studyPlan.id,
        'accept',
      ),
    );
    const predecessorCurriculum = predecessorRoute.activeRoute!.curriculum;
    const predecessorPlan = predecessorRoute.activeRoute!.studyPlan;

    const successorCurriculum = acceptSuccessorCurriculum('curriculum_semantic_successor');
    const successorPlanProposal = await plans.propose(
      proposalRequest('semantic-lineage-successor-plan', predecessorPlan.id),
    );

    expect(successorCurriculum).toMatchObject({
      predecessorId: predecessorCurriculum.id,
      version: predecessorCurriculum.version + 1,
      status: 'accepted',
    });
    expect(successorPlanProposal.studyPlan).toMatchObject({
      predecessorId: predecessorPlan.id,
      curriculumVersionId: successorCurriculum.id,
      version: predecessorPlan.version + 1,
      status: 'proposed',
    });

    const successorRoute = execution.decideStudyPlan(
      decisionRequest(
        'semantic-lineage-successor-activate',
        successorPlanProposal.studyPlan.id,
        'accept',
      ),
    );

    expect(successorRoute.activeRoute).toMatchObject({
      curriculum: { id: successorCurriculum.id, predecessorId: predecessorCurriculum.id },
      studyPlan: {
        id: successorPlanProposal.studyPlan.id,
        predecessorId: predecessorPlan.id,
        curriculumVersionId: successorCurriculum.id,
      },
    });
    const storedPredecessorCurriculum = repos.curricula.get(predecessorCurriculum.id)!;
    const storedPredecessorPlan = repos.studyPlans.get(predecessorPlan.id)!;
    expect(storedPredecessorCurriculum.status).toBe('superseded');
    expect({ ...storedPredecessorCurriculum, status: predecessorCurriculum.status }).toEqual(
      predecessorCurriculum,
    );
    expect(storedPredecessorPlan.status).toBe('superseded');
    expect({ ...storedPredecessorPlan, status: predecessorPlan.status }).toEqual(predecessorPlan);
  });

  it('activates a teaching route even when semantic support is stale', async () => {
    const provider = new CapturingPlanProvider();
    const { plans, execution, agendas } = services(provider);
    const proposed = await plans.propose(proposalRequest('plan-before-semantic-staleness'));
    const executionSnapshot = structuredClone(repos.courseExecution.get('ws_1'));
    const composeDraft = vi.spyOn(agendas, 'composeDraft');
    makePersistedObjectivePropositionStaleForFixture(curriculum.id, 'objective_verified');

    const activated = execution.decideStudyPlan(
      decisionRequest('accept-stale-semantic-route', proposed.studyPlan.id, 'accept'),
    );

    expect(activated.activeRoute?.studyPlan.id).toBe(proposed.studyPlan.id);
    expect(composeDraft).toHaveBeenCalledTimes(1);
    expect(repos.studyPlans.get(proposed.studyPlan.id)?.status).toBe('accepted');
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(1);
    expect(repos.courseExecution.get('ws_1')).not.toEqual(executionSnapshot);
  });

  it('rejects stale Plan acceptance after a newer accepted Curriculum and keeps history auditable', async () => {
    const { plans, execution } = services(new CapturingPlanProvider());
    const initialProposal = await plans.propose(proposalRequest('plan-on-curriculum-1'));
    const initialRoute = execution.decideStudyPlan(
      decisionRequest('accept-plan-on-curriculum-1', initialProposal.studyPlan.id, 'accept'),
    );
    expect(initialRoute.activeRoute?.curriculum.id).toBe('curriculum_1');

    acceptSuccessorCurriculum('curriculum_2');
    const staleProposal = await plans.propose(
      proposalRequest('plan-on-curriculum-2', initialProposal.studyPlan.id),
    );
    const staleDecision = decisionRequest(
      'accept-stale-plan',
      staleProposal.studyPlan.id,
      'accept',
    );
    const curriculum2Snapshot = repos.curricula.get('curriculum_2');
    const curriculum3 = acceptSuccessorCurriculum('curriculum_3');

    expect(() => execution.decideStudyPlan(staleDecision)).toThrow('stale or incompatible');
    expect(repos.studyPlans.get(staleProposal.studyPlan.id)?.status).toBe('proposed');
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe(initialProposal.studyPlan.id);
    expect(repos.curricula.get('curriculum_2')).toEqual(curriculum2Snapshot);
    expect(repos.curricula.get('curriculum_3')).toEqual(curriculum3);

    const currentProposal = await plans.propose(
      proposalRequest('plan-on-curriculum-3', staleProposal.studyPlan.id),
    );
    const accepted = execution.decideStudyPlan(
      decisionRequest('accept-current-plan', currentProposal.studyPlan.id, 'accept'),
    );
    const replay = execution.decideStudyPlan(
      decisionRequest('accept-current-plan', currentProposal.studyPlan.id, 'accept'),
    );
    expect(accepted.activeRoute?.curriculum.id).toBe('curriculum_3');
    expect(replay.activeRoute?.agenda.id).toBe(accepted.activeRoute?.agenda.id);
    expect(repos.studyPlans.get(staleProposal.studyPlan.id)?.status).toBe('proposed');
    expect(
      repos.sessionAgendas.list('ws_1').filter((agenda) => agenda.status === 'active'),
    ).toHaveLength(1);

    const rejected = execution.decideStudyPlan(
      decisionRequest('reject-stale-plan', staleProposal.studyPlan.id, 'reject'),
    );
    expect(rejected.decidedPlan.status).toBe('rejected');
    expect(rejected.retainedRoute?.studyPlan.id).toBe(currentProposal.studyPlan.id);
    expect(repos.curricula.get('curriculum_3')).toEqual(curriculum3);
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

describe('pre-acceptance Lesson plannability gate', () => {
  it('keeps a slot-infeasible 4x explain plan as an editable proposal and refuses acceptance', async () => {
    acceptCurriculumWithTeachingUnits('curriculum_slots', [
      {
        id: 'unit_1',
        title: 'Four explain objectives',
        objectives: [
          { id: 'obj_e1', construct: 'explain', priority: 'required' },
          { id: 'obj_e2', construct: 'explain', priority: 'required' },
          { id: 'obj_e3', construct: 'explain', priority: 'required' },
          { id: 'obj_e4', construct: 'explain', priority: 'required' },
        ],
      },
    ]);
    const provider = new CapturingPlanProvider(
      teachingProposal([
        {
          unitId: 'unit_1',
          objectiveIds: ['obj_e1', 'obj_e2', 'obj_e3', 'obj_e4'],
          minutes: 45,
          depth: 'working_fluency',
        },
      ]),
    );
    const { plans, execution } = services(provider);

    // T1 / T16: the proposal exists, carries the warning, and is not thrown away.
    const proposed = await plans.propose(proposalRequest('propose-slots'));
    expect(proposed.studyPlan.status).toBe('proposed');
    expect(proposed.plannability).toEqual([
      {
        planItemId: proposed.studyPlan.items[0]!.id,
        curriculumLearningUnitId: 'unit_1',
        planningCode: 'lesson_slot_limit_exceeded',
        targetDepth: 'working_fluency',
        estimatedMinutes: 45,
        remedies: ['reduce_depth', 'revise_plan_structure'],
      },
    ]);
    expect(proposed.validationWarnings.join(' ')).toContain(
      'more teaching segments than one Lesson allows',
    );
    expect(repos.studyPlans.get(proposed.studyPlan.id)?.status).toBe('proposed');

    // T11: a slot ceiling must never be presented as repairable by adding minutes.
    expect(proposed.plannability[0]!.remedies).not.toContain('increase_minutes');
    expect(proposed.validationWarnings.join(' ')).toContain(
      'A longer session cannot resolve a segment limit',
    );

    const providerCallsBeforeAcceptance = provider.calls;
    let refusal: unknown;
    try {
      execution.decideStudyPlan(decisionRequest('accept-slots', proposed.studyPlan.id, 'accept'));
      throw new Error('Acceptance should have been refused.');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).code).toBe(ApiErrorCode.ValidationError);
    expect((refusal as AppError).details).toMatchObject({
      reason: 'lesson_plannability_structurally_infeasible',
      items: [
        {
          planItemId: proposed.studyPlan.items[0]!.id,
          targetDepth: 'working_fluency',
        },
      ],
    });

    // T5: feasibility validation is provider-free.
    expect(provider.calls).toBe(providerCallsBeforeAcceptance);
    // T7 (initial-acceptance case): the refusal wrote nothing.
    expect(repos.studyPlans.get(proposed.studyPlan.id)?.status).toBe('proposed');
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(0);
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBeNull();
  });

  it('accepts a duration-infeasible proposal after reconciling to feasible', async () => {
    acceptCurriculumWithTeachingUnits('curriculum_budget', [
      {
        id: 'unit_1',
        title: 'Live three-objective route',
        objectives: [
          { id: 'obj_b1', construct: 'explain', priority: 'required' },
          { id: 'obj_b2', construct: 'apply', priority: 'required' },
          { id: 'obj_b3', construct: 'apply', priority: 'required' },
        ],
      },
    ]);
    // 33 minutes is this route's working_fluency floor; 20 is below it.
    const provider = new CapturingPlanProvider(
      teachingProposal([
        {
          unitId: 'unit_1',
          objectiveIds: ['obj_b1', 'obj_b2', 'obj_b3'],
          minutes: 20,
          depth: 'working_fluency',
        },
      ]),
    );
    const { plans, execution } = services(provider);
    const proposed = await plans.propose(proposalRequest('propose-budget'));

    expect(proposed.plannability[0]).toMatchObject({
      planningCode: 'protected_budget_exceeds_agenda',
      estimatedMinutes: 20,
    });
    // T12: budget failures may offer more minutes, so T11 cannot pass by offering nothing.
    expect(proposed.plannability[0]!.remedies).toEqual(['increase_minutes', 'reduce_depth']);
    expect(proposed.validationWarnings.join(' ')).toContain('does not fit the session length');

    // NEW BEHAVIOR: Acceptance reconciles duration upward to the minimum feasible (33).
    // Duration is advisory; depth is authoritative. The system derives a feasible duration.
    const decision = execution.decideStudyPlan(
      decisionRequest('accept-budget', proposed.studyPlan.id, 'accept'),
    );
    expect(decision.decision).toBe('accepted');
    expect(decision.decidedPlan.status).toBe('accepted');
    expect(decision.decidedPlan.items[0]?.estimatedMinutes).toBe(33);
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe(proposed.studyPlan.id);
  });

  it('repairs a duration-infeasible proposal with resize_time and then accepts', async () => {
    acceptCurriculumWithTeachingUnits('curriculum_resize', [
      {
        id: 'unit_1',
        title: 'Live three-objective route',
        objectives: [
          { id: 'obj_r1', construct: 'explain', priority: 'required' },
          { id: 'obj_r2', construct: 'apply', priority: 'required' },
          { id: 'obj_r3', construct: 'apply', priority: 'required' },
        ],
      },
    ]);
    const provider = new CapturingPlanProvider(
      teachingProposal([
        {
          unitId: 'unit_1',
          objectiveIds: ['obj_r1', 'obj_r2', 'obj_r3'],
          minutes: 20,
          depth: 'working_fluency',
        },
      ]),
    );
    const { plans, execution } = services(provider);
    const proposed = await plans.propose(proposalRequest('propose-resize'));
    expect(proposed.plannability).toHaveLength(1);

    const edited = plans.applyDraftEdit({
      command: command('edit-resize'),
      studyPlanId: proposed.studyPlan.id,
      expectedVersion: proposed.studyPlan.version,
      expectedContractId: proposed.studyPlan.contractVersionId,
      expectedCurriculumId: proposed.studyPlan.curriculumVersionId,
      expectedExecutionSourceManifestFingerprint:
        proposed.studyPlan.executionSourceManifestFingerprint,
      edit: {
        kind: 'resize_time',
        planItemId: proposed.studyPlan.items[0]!.id,
        estimatedMinutes: 35,
        reason: 'Give this unit enough time for its required teaching.',
      },
    });

    // A NEW proposed version, with the predecessor rejected rather than mutated.
    expect(edited.studyPlan.id).not.toBe(proposed.studyPlan.id);
    expect(edited.studyPlan.status).toBe('proposed');
    expect(edited.studyPlan.version).toBe(proposed.studyPlan.version + 1);
    expect(edited.studyPlan.predecessorId).toBe(proposed.studyPlan.id);
    expect(edited.studyPlan.provider).toBe('local');
    expect(repos.studyPlans.get(proposed.studyPlan.id)?.status).toBe('rejected');
    // T17: recomputed for the successor, not the hardcoded empty array.
    expect(edited.plannability).toEqual([]);
    expect(edited.validationWarnings).toEqual([]);
    expect(edited.studyPlan.items[0]!.estimatedMinutes).toBe(35);

    const accepted = execution.decideStudyPlan(
      decisionRequest('accept-resized', edited.studyPlan.id, 'accept'),
    );
    expect(accepted.decision).toBe('accepted');
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe(edited.studyPlan.id);
    expect(provider.calls).toBe(1);
  });

  it('repairs a slot-infeasible proposal with change_depth and then accepts', async () => {
    acceptCurriculumWithTeachingUnits('curriculum_depth', [
      {
        id: 'unit_1',
        title: 'Four explain objectives',
        objectives: [
          { id: 'obj_d1', construct: 'explain', priority: 'required' },
          { id: 'obj_d2', construct: 'explain', priority: 'required' },
          { id: 'obj_d3', construct: 'explain', priority: 'required' },
          { id: 'obj_d4', construct: 'explain', priority: 'required' },
        ],
      },
    ]);
    const provider = new CapturingPlanProvider(
      teachingProposal([
        {
          unitId: 'unit_1',
          objectiveIds: ['obj_d1', 'obj_d2', 'obj_d3', 'obj_d4'],
          minutes: 45,
          depth: 'working_fluency',
        },
      ]),
    );
    const { plans, execution } = services(provider);
    const proposed = await plans.propose(proposalRequest('propose-depth'));
    expect(proposed.plannability[0]!.planningCode).toBe('lesson_slot_limit_exceeded');

    const edited = plans.applyDraftEdit({
      command: command('edit-depth'),
      studyPlanId: proposed.studyPlan.id,
      expectedVersion: proposed.studyPlan.version,
      expectedContractId: proposed.studyPlan.contractVersionId,
      expectedCurriculumId: proposed.studyPlan.curriculumVersionId,
      expectedExecutionSourceManifestFingerprint:
        proposed.studyPlan.executionSourceManifestFingerprint,
      edit: {
        kind: 'change_depth',
        planItemId: proposed.studyPlan.items[0]!.id,
        targetDepth: 'pass_oriented',
        reason: 'Lower the depth so this unit fits one Lesson.',
      },
    });

    expect(edited.studyPlan.id).not.toBe(proposed.studyPlan.id);
    expect(edited.studyPlan.items[0]!.targetDepth).toBe('pass_oriented');
    expect(edited.plannability).toEqual([]);
    expect(edited.validationWarnings).toEqual([]);
    expect(repos.studyPlans.get(proposed.studyPlan.id)?.status).toBe('rejected');

    const accepted = execution.decideStudyPlan(
      decisionRequest('accept-depth', edited.studyPlan.id, 'accept'),
    );
    expect(accepted.decision).toBe('accepted');
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe(edited.studyPlan.id);
  });

  it('checks every teach_unit, including one beyond the first Agenda selection window', async () => {
    acceptCurriculumWithTeachingUnits(
      'curriculum_window',
      [1, 2, 3, 4].map((index) => ({
        id: `unit_${index}`,
        title: `Unit ${index}`,
        objectives: [
          { id: `obj_w${index}`, construct: 'identify' as const, priority: 'required' as const },
        ],
      })),
    );
    // Only the first three items can reach the draft Agenda (selectSessionItems caps at
    // three); the fourth is the one an agenda-only gate would miss.
    const provider = new CapturingPlanProvider(
      teachingProposal([
        { unitId: 'unit_1', objectiveIds: ['obj_w1'], minutes: 12, depth: 'pass_oriented' },
        { unitId: 'unit_2', objectiveIds: ['obj_w2'], minutes: 12, depth: 'pass_oriented' },
        { unitId: 'unit_3', objectiveIds: ['obj_w3'], minutes: 12, depth: 'pass_oriented' },
        { unitId: 'unit_4', objectiveIds: ['obj_w4'], minutes: 240, depth: 'pass_oriented' },
      ]),
    );
    const { plans, execution, agendas } = services(provider);
    const proposed = await plans.propose(proposalRequest('propose-window'));

    const lastItem = proposed.studyPlan.items[3]!;
    expect(proposed.plannability).toEqual([
      {
        planItemId: lastItem.id,
        curriculumLearningUnitId: 'unit_4',
        planningCode: 'agenda_budget_underfilled',
        targetDepth: 'pass_oriented',
        estimatedMinutes: 240,
        remedies: ['reduce_minutes', 'raise_depth'],
      },
    ]);

    // The unplannable item is genuinely outside the agenda the acceptance would build.
    const draft = agendas.composeDraft(contract, curriculum, proposed.studyPlan);
    expect(draft.items.length).toBeLessThan(4);
    expect(draft.items.map((item) => item.linkedPlanItemId)).not.toContain(lastItem.id);

    expect(() =>
      execution.decideStudyPlan(decisionRequest('accept-window', proposed.studyPlan.id, 'accept')),
    ).toThrow(/cannot be planned as a Lesson/u);
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBeNull();
    expect(repos.sessionAgendas.list('ws_1')).toHaveLength(0);
  });

  it('preserves the accepted predecessor and active route when a successor is refused', async () => {
    acceptCurriculumWithTeachingUnits('curriculum_successor', [
      {
        id: 'unit_1',
        title: 'Four explain objectives for slot limit test',
        objectives: [
          { id: 'obj_s1', construct: 'explain', priority: 'required' },
          { id: 'obj_s2', construct: 'explain', priority: 'required' },
          { id: 'obj_s3', construct: 'explain', priority: 'required' },
          { id: 'obj_s4', construct: 'explain', priority: 'required' },
        ],
      },
    ]);
    // First plan: feasible with 4 explain at pass_oriented for 30 minutes.
    const feasible = teachingProposal([
      { unitId: 'unit_1', objectiveIds: ['obj_s1', 'obj_s2', 'obj_s3', 'obj_s4'], minutes: 30, depth: 'pass_oriented' },
    ]);
    const provider = new CapturingPlanProvider(feasible);
    const { plans, execution } = services(provider);

    const first = await plans.propose(proposalRequest('propose-first'));
    execution.decideStudyPlan(decisionRequest('accept-first', first.studyPlan.id, 'accept'));
    const stateAfterAccept = repos.courseExecution.get('ws_1');
    const acceptedPayloadBefore = JSON.stringify(repos.studyPlans.get(first.studyPlan.id));
    const activeAgendaBefore = stateAfterAccept.activeAgendaId;
    expect(stateAfterAccept.acceptedPlanId).toBe(first.studyPlan.id);

    // A successor that is structurally infeasible (4 explain at working_fluency exceeds slot limit).
    provider.output = teachingProposal([
      {
        unitId: 'unit_1',
        objectiveIds: ['obj_s1', 'obj_s2', 'obj_s3', 'obj_s4'],
        minutes: 45,
        depth: 'working_fluency',
      },
    ]);
    const successor = await plans.propose(proposalRequest('propose-successor', first.studyPlan.id));
    expect(successor.plannability).toHaveLength(1);

    let refusal: unknown;
    try {
      execution.decideStudyPlan(
        decisionRequest('accept-successor', successor.studyPlan.id, 'accept'),
      );
      throw new Error('Acceptance should have been refused.');
    } catch (error) {
      refusal = error;
    }

    // NEW BEHAVIOR: Structurally infeasible items (no duration in [1, 480] works) are
    // rejected with the new structurally_infeasible reason.
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).code).toBe(ApiErrorCode.ValidationError);
    expect((refusal as AppError).message).toMatch(
      /structurally infeasible|cannot be planned as a Lesson/u,
    );

    const stateAfterRefusal = repos.courseExecution.get('ws_1');
    // T6: the accepted predecessor payload is byte-identical after the refusal.
    expect(JSON.stringify(repos.studyPlans.get(first.studyPlan.id))).toBe(acceptedPayloadBefore);
    // T7: proposed successor retained, prior route intact, no new agenda, version unmoved.
    expect(repos.studyPlans.get(successor.studyPlan.id)?.status).toBe('proposed');
    expect(repos.studyPlans.get(first.studyPlan.id)?.status).toBe('accepted');
    expect(stateAfterRefusal.acceptedPlanId).toBe(first.studyPlan.id);
    expect(stateAfterRefusal.activeAgendaId).toBe(activeAgendaBefore);
    expect(stateAfterRefusal.version).toBe(stateAfterAccept.version);
    expect(
      repos.sessionAgendas.list('ws_1').filter((agenda) => agenda.status === 'active'),
    ).toHaveLength(1);
  });

  it('adds no refusal at pass_oriented for a shape depth makes infeasible above it', async () => {
    acceptCurriculumWithTeachingUnits('curriculum_baseline', [
      {
        id: 'unit_1',
        title: 'Three apply objectives',
        objectives: [
          { id: 'obj_p1', construct: 'apply', priority: 'required' },
          { id: 'obj_p2', construct: 'apply', priority: 'required' },
          { id: 'obj_p3', construct: 'apply', priority: 'required' },
        ],
      },
    ]);
    // FakeProvider's shipped 25 minutes: feasible at pass_oriented, and the depth-driven
    // regression the audit measured at working_fluency.
    const provider = new CapturingPlanProvider(
      teachingProposal([
        {
          unitId: 'unit_1',
          objectiveIds: ['obj_p1', 'obj_p2', 'obj_p3'],
          minutes: 25,
          depth: 'pass_oriented',
        },
      ]),
    );
    const { plans, execution } = services(provider);
    const proposed = await plans.propose(proposalRequest('propose-baseline'));

    expect(proposed.plannability).toEqual([]);
    expect(proposed.validationWarnings.join(' ')).not.toContain('cannot yet be planned');
    const accepted = execution.decideStudyPlan(
      decisionRequest('accept-baseline', proposed.studyPlan.id, 'accept'),
    );
    expect(accepted.decision).toBe('accepted');
  });
});
