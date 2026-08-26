import { afterEach, describe, expect, it } from 'vitest';
import type { LearningContract, LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeConcept, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createCourseCommandService } from '../services/courseCommands.js';
import { createLearningContractService } from '../services/learningContracts.js';
import { createMaterialRoleService } from '../services/materialRoles.js';
import {
  COURSE_MAP_CURRICULUM_GENERATION_POLICY,
  createCurriculumService,
  LEGACY_CURRICULUM_GENERATION_POLICY,
  type CurriculumService,
} from '../services/curriculum.js';
import { createSourceAuthorityService } from '../services/sourceAuthority.js';
import { createTelemetryProvider } from '../services/providerTelemetry.js';
import {
  prepareCurriculumPolicyEvaluation,
  curriculumSubjectClassTelemetry,
  evaluateCurriculumPolicy,
  CurriculumPolicyEvaluationError,
} from './curriculumPolicyComparison.js';

const clock = fixedClock(T0);
const QUOTE = 'Working memory is limited.';

interface Fixture {
  db: SqliteDb;
  repos: Repositories;
  telemetryDb: SqliteDb;
  telemetryRepos: Repositories;
  contract: LearningContract;
  provider: ReturnType<typeof createTelemetryProvider>;
}

let activeFixtures: Fixture[] = [];

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

function createFixture(withConcept = true): Fixture {
  const db = openDatabase(':memory:');
  migrate(db);
  const repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace({ name: 'Memory course' }));
  repos.materials.insertWithBlocks(
    makeMaterial({
      content: QUOTE,
      charCount: QUOTE.length,
      title: 'Memory notes',
    }),
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
  const currentRole = repos.materialRoles.getCurrent('mat_1')!;
  const role = roles.propose({
    command: command('role-propose'),
    materialId: 'mat_1',
    role: 'course_material',
    expectedCurrentAssignmentId: currentRole.id,
  });
  const confirmedRole = roles.confirm({
    command: command('role-confirm', 'learner'),
    assignmentId: role.id,
    expectedVersion: role.version,
  });
  const contracts = createLearningContractService({ repos, clock, commands });
  const draft = contracts.createDraft({
    command: command('contract-create', 'learner'),
    fields: contractFields(confirmedRole.id, confirmedRole.version),
    predecessorContractId: null,
    expectedActiveContractId: null,
  }).contract;
  const proposed = contracts.transition({
    command: command('contract-propose', 'learner'),
    contractId: draft.id,
    expectedVersion: draft.version,
    transition: 'propose',
  }).contract;
  const contract = contracts.transition({
    command: command('contract-confirm', 'learner'),
    contractId: proposed.id,
    expectedVersion: proposed.version,
    transition: 'confirm',
  }).contract;

  if (withConcept) {
    const concept = makeConcept({
      id: 'con_working_memory',
      materialId: 'mat_1',
      summary: QUOTE,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
    });
    repos.materials.addConcepts([concept]);
    repos.alignment.ensureBaseline('ws_1', [concept], T0);
  }

  const telemetryDb = openDatabase(':memory:');
  migrate(telemetryDb);
  const telemetryRepos = createRepositories(telemetryDb);
  const provider = createTelemetryProvider({
    repos: telemetryRepos,
    clock,
    provider: new FakeProvider(),
    providerGeneration: () => 1,
  });
  const fixture = { db, repos, telemetryDb, telemetryRepos, contract, provider };
  activeFixtures.push(fixture);
  return fixture;
}

function prepare(fixture: Fixture, predecessorCurriculumId: string | null = null) {
  return prepareCurriculumPolicyEvaluation(fixture.repos, {
    workspaceId: 'ws_1',
    contractId: fixture.contract.id,
    expectedContractVersion: fixture.contract.version,
    predecessorCurriculumId,
  });
}

async function evaluate(
  fixture: Fixture,
  policy:
    typeof LEGACY_CURRICULUM_GENERATION_POLICY | typeof COURSE_MAP_CURRICULUM_GENERATION_POLICY,
  predecessorCurriculumId: string | null = null,
) {
  return evaluateCurriculumPolicy(
    prepare(fixture, predecessorCurriculumId),
    policy,
    { provider: fixture.provider, repos: fixture.repos, clock },
    { timeoutMs: 2_000 },
  );
}

function rowCount(db: SqliteDb, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

afterEach(() => {
  for (const fixture of activeFixtures) {
    fixture.db.close();
    fixture.telemetryDb.close();
  }
  activeFixtures = [];
});

describe('Curriculum policy comparison coordinator', () => {
  it('reports subject-class agreement and confined-lane drift without gating', () => {
    const artifact = (subjectDependency: 'general_sufficient' | 'source_specific_required') =>
      ({
        subjectDependency,
        verdict: 'fail',
        construct: 'explain',
        fragments: [{ status: 'unsupported', supportType: null }],
        conflicts: [],
        overreach: [],
      }) as never;
    const report = curriculumSubjectClassTelemetry({
      nodes: [
        {
          learningUnit: {
            objectives: [
              {
                subjectClass: 'general',
                scopeOrigin: 'anchored',
                semanticSupport: artifact('general_sufficient'),
              },
              {
                subjectClass: 'general',
                scopeOrigin: 'anchored',
                semanticSupport: artifact('source_specific_required'),
              },
              {
                subjectClass: 'source_specific',
                scopeOrigin: 'anchored',
                semanticSupport: artifact('general_sufficient'),
              },
              {
                subjectClass: 'source_specific',
                scopeOrigin: 'anchored',
                semanticSupport: artifact('source_specific_required'),
              },
            ],
          },
        },
      ],
    } as never);

    expect(report).toEqual({
      objectiveCount: 4,
      attestedObjectiveCount: 4,
      generatorGeneralCount: 2,
      generatorGeneralShare: 0.5,
      blindGeneralSufficientCount: 2,
      blindGeneralSufficientShare: 0.5,
      toleratedAnchoredGeneralCount: 1,
      toleratedAnchoredGeneralShare: 0.25,
      disagreementCount: 2,
      disagreementShare: 0.5,
    });
  });

  it('freezes a deterministic input fingerprint for identical prepared inputs', () => {
    const fixture = createFixture();
    expect(prepare(fixture).fingerprint).toBe(prepare(fixture).fingerprint);
  });

  it('runs the legacy policy in one logical call and records the call in disposable telemetry', async () => {
    const fixture = createFixture();
    const result = await evaluate(fixture, LEGACY_CURRICULUM_GENERATION_POLICY);

    expect(result.policy).toBe(LEGACY_CURRICULUM_GENERATION_POLICY);
    expect(result.totals.logicalCalls).toBe(1);
    expect(result.totals.physicalCalls).toBeLessThanOrEqual(2);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.stage).toBe('legacy_curriculum');
    expect(
      fixture.telemetryRepos.telemetry.getLogicalCall(result.stages[0]!.logicalCallId),
    ).toBeDefined();
    expect(rowCount(fixture.telemetryDb, 'model_logical_calls')).toBe(1);
    expect(result.courseMap).toBeNull();
  });

  it('runs Course Map materialization within the logical and physical call bounds', async () => {
    const fixture = createFixture();
    const result = await evaluate(fixture, COURSE_MAP_CURRICULUM_GENERATION_POLICY);

    expect(result.policy).toBe(COURSE_MAP_CURRICULUM_GENERATION_POLICY);
    expect(result.totals.logicalCalls).toBeGreaterThanOrEqual(2);
    expect(result.totals.logicalCalls).toBeLessThanOrEqual(3);
    expect(result.totals.physicalCalls).toBeLessThanOrEqual(9);
    expect(result.stages[0]!.stage).toBe('course_map');
    expect(result.stages.slice(1).every((stage) => stage.stage === 'curriculum_detail')).toBe(true);
    expect(result.courseMap).toMatchObject({
      detailBatchCount: expect.any(Number),
      regionAllocationComplete: true,
      lostPrerequisiteCount: 0,
    });
    expect(result.courseMap!.analysis).toBeDefined();
    for (const stage of result.stages) {
      expect(fixture.telemetryRepos.telemetry.getLogicalCall(stage.logicalCallId)).toBeDefined();
    }
  });

  it('does not write source or learner state while evaluating a policy', async () => {
    const fixture = createFixture();
    const tables = [
      'curriculum_versions',
      'curriculum_events',
      'execution_source_manifests',
      'agent_operations',
      'model_logical_calls',
      'coverage_risk_entries',
      'mastery_states',
      'mistakes',
    ];
    const beforeChanges = (
      fixture.db.prepare('SELECT total_changes() AS count').get() as { count: number }
    ).count;
    const before = Object.fromEntries(tables.map((table) => [table, rowCount(fixture.db, table)]));

    await evaluate(fixture, LEGACY_CURRICULUM_GENERATION_POLICY);

    const afterChanges = (
      fixture.db.prepare('SELECT total_changes() AS count').get() as { count: number }
    ).count;
    const after = Object.fromEntries(tables.map((table) => [table, rowCount(fixture.db, table)]));
    expect(afterChanges).toBe(beforeChanges);
    expect(after).toEqual(before);
  });

  it('rejects a generated Course Map Curriculum that fails StudyPlan preflight', async () => {
    const fixture = createFixture(false);

    await expect(evaluate(fixture, COURSE_MAP_CURRICULUM_GENERATION_POLICY)).rejects.toMatchObject({
      name: 'CurriculumPolicyEvaluationError',
      cause: expect.objectContaining({ message: expect.any(String) }),
    });
  });

  it('uses the bounded legacy repair allowance for a preflight-failing predecessor', async () => {
    const fixture = createFixture(false);
    const commands = createCourseCommandService({ repos: fixture.repos, clock });
    const sourceService: CurriculumService = createCurriculumService({
      repos: fixture.repos,
      provider: new FakeProvider(),
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: fixture.repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });
    const first = await sourceService.propose({
      command: command('predecessor-propose'),
      contractId: fixture.contract.id,
      expectedContractVersion: fixture.contract.version,
      predecessorCurriculumId: null,
      expectedActiveCurriculumId: null,
    });
    const accepted = sourceService.accept({
      command: command('predecessor-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: fixture.contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;

    await expect(
      evaluate(fixture, LEGACY_CURRICULUM_GENERATION_POLICY, accepted.id),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(CurriculumPolicyEvaluationError);
      const evaluationError = error as CurriculumPolicyEvaluationError;
      expect(evaluationError.stages[0]!.repairReasons).toContain('candidate');
      expect(evaluationError.stages[0]!.physicalCalls).toBe(2);
      return true;
    });
  });
});
