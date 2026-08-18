import { afterEach, describe, expect, it } from 'vitest';
import type { LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { ProviderCallOptions, TeachingBriefGenerationInput } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeConcept, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createServices, type Services } from './index.js';

const clock = fixedClock(T0);
const databases: SqliteDb[] = [];

class CountingProvider extends FakeProvider {
  teachingBriefCalls = 0;

  override async generateTeachingBrief(
    input: TeachingBriefGenerationInput,
    opts?: ProviderCallOptions,
  ) {
    this.teachingBriefCalls += 1;
    return super.generateTeachingBrief(input, opts);
  }
}

function command(id: string, actor: 'learner' | 'local' = 'learner') {
  return { commandId: id, idempotencyKey: id, workspaceId: 'ws_1', actor } as const;
}

function contractFields(roleId: string, roleVersion: number): LearningContractDraftFields {
  return {
    intent: 'Learn working-memory capacity.',
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

interface Harness {
  repos: Repositories;
  provider: CountingProvider;
  services: Services;
  curriculumId: string;
  planId: string;
  learningUnitId: string;
  manifestFingerprint: string;
}

async function createHarness(): Promise<Harness> {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrate(db);
  const repos = createRepositories(db);
  const provider = new CountingProvider();
  repos.workspaces.insert(makeWorkspace());
  const content = 'Working memory has limited capacity.';
  repos.materials.insertWithBlocks(makeMaterial({ content, charCount: content.length }), [
    makeBlock({ content, startOffset: 0, endOffset: content.length, heading: 'Memory' }),
  ]);
  repos.materials.addConcepts([
    makeConcept({
      grounding: {
        blockId: 'blk_1',
        quote: content,
        startOffset: 0,
        endOffset: content.length,
        occurrenceCount: 1,
        reanchored: false,
      },
    }),
  ]);
  const services = createServices({ repos, provider, clock });
  const proposedRole = services.materialRoles.propose({
    command: command('role-propose', 'local'),
    materialId: 'mat_1',
    role: 'course_material',
    expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_1')!.id,
  });
  const role = services.materialRoles.confirm({
    command: command('role-confirm'),
    assignmentId: proposedRole.id,
    expectedVersion: proposedRole.version,
  });
  const draft = services.learningContracts.createDraft({
    command: command('contract-create'),
    fields: contractFields(role.id, role.version),
    predecessorContractId: null,
    expectedActiveContractId: null,
  }).contract;
  const proposedContract = services.learningContracts.transition({
    command: command('contract-propose'),
    contractId: draft.id,
    expectedVersion: draft.version,
    transition: 'propose',
  }).contract;
  const contract = services.learningContracts.transition({
    command: command('contract-confirm'),
    contractId: proposedContract.id,
    expectedVersion: proposedContract.version,
    transition: 'confirm',
  }).contract;
  const preparation = services.coursePreparation.get('ws_1');
  if (!preparation.operationKey) throw new Error('Expected Course Preparation operation key.');
  await services.coursePreparation.run({
    command: command(preparation.operationKey),
    expectedRevision: preparation.revision,
  });
  const plan = repos.studyPlans.list('ws_1').at(-1)!;
  const curriculum = repos.curricula.get(plan.curriculumVersionId)!;
  services.courseExecution.decideStudyPlan({
    command: command('plan-accept'),
    studyPlanId: plan.id,
    expectedVersion: plan.version,
    expectedContractId: contract.id,
    expectedCurriculumId: curriculum.id,
    expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    decision: 'accept',
    reason: null,
  });
  const item = plan.items.find(
    (candidate) => candidate.kind === 'teach_unit' && candidate.curriculumLearningUnitId,
  )!;
  return {
    repos,
    provider,
    services,
    curriculumId: curriculum.id,
    planId: plan.id,
    learningUnitId: item.curriculumLearningUnitId!,
    manifestFingerprint: curriculum.executionSourceManifest.fingerprint,
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe('Teaching Brief preparation', () => {
  it('prepares and reuses an immutable Brief for the accepted executable route', async () => {
    const harness = await createHarness();
    const input = {
      workspaceId: 'ws_1',
      curriculumVersionId: harness.curriculumId,
      studyPlanVersionId: harness.planId,
      learningUnitId: harness.learningUnitId,
      commandId: 'brief-prepare-1',
      expectedExecutionSourceManifestFingerprint: harness.manifestFingerprint,
    };
    const first = await harness.services.teachingBriefPreparation.prepare(input);
    expect(first.status).toBe('prepared');
    expect(first.brief.sourceReferences.length).toBeGreaterThan(0);
    expect(harness.provider.teachingBriefCalls).toBe(1);
    const replay = await harness.services.teachingBriefPreparation.prepare(input);
    expect(replay).toEqual(first);
    expect(harness.provider.teachingBriefCalls).toBe(1);
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      1,
    );
  });

  it('rejects a non-executable LearningUnit and a stale route before provider work', async () => {
    const harness = await createHarness();
    const curriculum = harness.repos.curricula.get(harness.curriculumId)!;
    const nonUnit = curriculum.nodes.find((node) => !node.learningUnit)!;
    await expect(
      harness.services.teachingBriefPreparation.prepare({
        workspaceId: 'ws_1',
        curriculumVersionId: harness.curriculumId,
        studyPlanVersionId: harness.planId,
        learningUnitId: nonUnit.id,
        commandId: 'brief-non-unit',
        expectedExecutionSourceManifestFingerprint: harness.manifestFingerprint,
      }),
    ).rejects.toThrow('not executable teaching work');
    await expect(
      harness.services.teachingBriefPreparation.prepare({
        workspaceId: 'ws_1',
        curriculumVersionId: harness.curriculumId,
        studyPlanVersionId: harness.planId,
        learningUnitId: harness.learningUnitId,
        commandId: 'brief-stale-route',
        expectedExecutionSourceManifestFingerprint: 'stale-manifest',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(harness.provider.teachingBriefCalls).toBe(0);
  });
});
