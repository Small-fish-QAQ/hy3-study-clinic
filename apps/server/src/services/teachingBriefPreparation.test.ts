import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type {
  ProviderCallOptions,
  TeachingBriefGenerationInput,
  TutorTurnInput,
} from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeConcept, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createServices, type Services } from './index.js';

const clock = fixedClock(T0);
const databases: SqliteDb[] = [];

class CountingProvider extends FakeProvider {
  teachingBriefCalls = 0;
  lastTeachingBriefInput: TeachingBriefGenerationInput | null = null;
  lastTutorInput: TutorTurnInput | null = null;

  override async generateTeachingBrief(
    input: TeachingBriefGenerationInput,
    opts?: ProviderCallOptions,
  ) {
    this.teachingBriefCalls += 1;
    this.lastTeachingBriefInput = input;
    return super.generateTeachingBrief(input, opts);
  }

  override async respondToTutorTurn(input: TutorTurnInput, opts?: ProviderCallOptions) {
    this.lastTutorInput = input;
    return super.respondToTutorTurn(input, opts);
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
  const visualBytes = Buffer.from('bounded exact visual fixture');
  const visualHash = `sha256:${createHash('sha256').update(visualBytes).digest('hex')}` as const;
  repos.materials.insertWithBlocks(
    makeMaterial({ content, charCount: content.length }),
    [makeBlock({ content, startOffset: 0, endOffset: content.length, heading: 'Memory' })],
    null,
    [],
    {},
    [
      {
        id: 'candidate_visual_1',
        materialId: 'mat_1',
        materialRevisionId: 'mat_1:candidate',
        index: 0,
        parentStructuralUnitId: null,
        sourcePath: 'fixture/image1.png',
        mediaType: 'image/png',
        byteHash: visualHash,
        byteLength: visualBytes.length,
        width: 320,
        height: 200,
        location: { pageNumber: 1 },
        relationshipKind: 'image',
        contentOrigin: 'extracted_original',
        parserVersion: 'fixture-v1',
        bytes: visualBytes,
      },
    ],
  );
  const visualAsset = repos.materials.getAssets('mat_1')[0]!;
  repos.visualDerivations.create({
    id: 'visual_derivation_fixture',
    materialId: visualAsset.materialId,
    materialRevisionId: visualAsset.materialRevisionId,
    assetId: visualAsset.id,
    assetByteHash: visualAsset.byteHash,
    identityFingerprint: `visual_derivation_${'a'.repeat(64)}`,
    semanticIdentityFingerprint: `visual_semantic_${'b'.repeat(64)}`,
    derivationKind: 'visual_description',
    contentOrigin: 'derived_visual_description',
    authority: 'derived',
    evidenceAdmissibility: 'advisory_nonblocking',
    validationStatus: 'accepted',
    generatorIdentity: 'provider_visual_description',
    generatorVersion: 'provider-visual-description-v1',
    provider: 'fake',
    providerModel: null,
    configurationFingerprint: `sha256:${'c'.repeat(64)}`,
    contextMode: 'image_only',
    contextFingerprint: null,
    transport: {
      mediaType: 'image/png',
      width: 320,
      height: 200,
      byteLength: visualBytes.length,
      transformation: 'validated_original',
      preparationVersion: 'sharp-visual-transport-v1',
      fingerprint: visualHash,
    },
    payload: {
      description: 'A capacity diagram links working memory to a bounded container.',
      visualType: 'diagram',
      visibleText: null,
      importantConcepts: ['working memory', 'capacity'],
      pedagogicalNotes: ['Use the diagram only as advisory teaching context.'],
      uncertainty: ['The diagram does not independently prove the capacity claim.'],
    },
    reusedFromDerivationId: null,
    createdAt: T0,
  });
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
    expect(first.brief.visualReferences).toHaveLength(1);
    expect(first.brief.visualReferences[0]).toMatchObject({
      assetId: visualAssetId(harness),
      context: {
        source: { authority: 'original_visual' },
        explanation: {
          authority: 'advisory',
          evidenceAdmissibility: 'advisory_nonblocking',
          formalEvidenceEligible: false,
        },
      },
    });
    expect(harness.provider.lastTeachingBriefInput?.visualContext.offers[0]).not.toHaveProperty(
      'assetId',
    );
    expect(harness.provider.teachingBriefCalls).toBe(1);
    const replay = await harness.services.teachingBriefPreparation.prepare(input);
    expect(replay).toEqual(first);
    expect(harness.provider.teachingBriefCalls).toBe(1);
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      1,
    );
    expect(
      harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)[0]!.visualReferences,
    ).toHaveLength(1);
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

  it('rejects a route when a newer visual derivation identity appears after acceptance', async () => {
    const harness = await createHarness();
    const asset = harness.repos.materials.getAssets('mat_1')[0]!;
    const prior = harness.repos.visualDerivations.listForAsset(asset.id)[0]!;
    harness.repos.visualDerivations.create({
      ...prior,
      id: 'visual_derivation_fixture_v2',
      identityFingerprint: `visual_derivation_${'d'.repeat(64)}`,
      semanticIdentityFingerprint: `visual_semantic_${'e'.repeat(64)}`,
      payload: {
        ...prior.payload,
        description: 'A newer accepted visual explanation that was not in the route snapshot.',
      },
      createdAt: new Date(Date.parse(prior.createdAt) + 1_000).toISOString(),
    });

    await expect(
      harness.services.teachingBriefPreparation.prepare({
        workspaceId: 'ws_1',
        curriculumVersionId: harness.curriculumId,
        studyPlanVersionId: harness.planId,
        learningUnitId: harness.learningUnitId,
        commandId: 'brief-newer-visual-derivation',
        expectedExecutionSourceManifestFingerprint: harness.manifestFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(harness.provider.teachingBriefCalls).toBe(0);
  });

  it('prepares and presents a lesson inside a StudySession without formal credit', async () => {
    const harness = await createHarness();
    const agenda = harness.repos.sessionAgendas.list('ws_1').at(-1)!;
    const execution = harness.repos.courseExecution.get('ws_1');
    const started = harness.services.studySessions.start('ws_1', {
      contractVersionId: agenda.contractVersionId,
      curriculumVersionId: agenda.curriculumVersionId,
      studyPlanVersionId: agenda.studyPlanVersionId,
      sessionAgendaId: agenda.id,
      expectedCourseExecutionVersion: execution.version,
    });
    const session = started.session;
    const initial = harness.services.lessonExecution.get('ws_1', session.id);
    expect(initial.status).toBe('preparation_needed');
    expect(initial.allowedActions).toContain('prepare_lesson');
    const prepared = await harness.services.lessonExecution.ensure('ws_1', session.id, {
      command: command('lesson-prepare'),
      expectedSessionVersion: session.version,
      expectedAgendaVersion: agenda.version,
      expectedAgendaItemId: session.currentAgendaItemId,
    });
    expect(prepared.status).toBe('ready');
    expect(prepared.lesson).not.toBeNull();
    expect(prepared.lesson?.visuals[0]).toMatchObject({
      source: { authority: 'original_visual' },
      explanation: {
        provenanceCategory: 'generated_visual_explanation',
        evidenceAdmissibility: 'advisory_nonblocking',
        formalEvidenceEligible: false,
      },
    });
    expect(prepared.allowedActions).toContain('start_lesson');
    const readyVersion = prepared.progress!.stateVersion;
    const startedLesson = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('lesson-start'),
      expectedSessionVersion: prepared.session.version,
      expectedAgendaVersion: prepared.agenda!.version,
      expectedAgendaItemId: session.currentAgendaItemId!,
      expectedLessonStateVersion: readyVersion,
      action: { kind: 'start_lesson' },
    });
    expect(startedLesson.progress?.presentedSegmentIndexes).toContain(0);
    expect(harness.services.lessonExecution.tutorContext('ws_1', session.id)?.visuals).toHaveLength(
      1,
    );
    await harness.services.studySessions.submitTurn('ws_1', session.id, {
      commandId: 'visual-tutor-turn',
      expectedSessionVersion: startedLesson.session.version,
      content: 'Explain the diagram.',
    });
    expect(harness.provider.lastTutorInput?.lessonContext?.visuals?.[0]).toMatchObject({
      source: { authority: 'original_visual' },
      explanation: { authority: 'advisory', formalEvidenceEligible: false },
    });
    expect(
      harness.provider.lastTutorInput?.offeredSourceRefs.some((reference) =>
        reference.referenceKey.startsWith('V'),
      ),
    ).toBe(false);
    expect(harness.repos.formalProgression.listEvidenceForWorkspace('ws_1')).toHaveLength(0);
    expect(harness.repos.mistakes.listOpenByWorkspace('ws_1')).toHaveLength(0);
    expect(harness.repos.mastery.listByWorkspace('ws_1')).toHaveLength(0);
    expect(harness.provider.teachingBriefCalls).toBe(1);
  });
});

function visualAssetId(harness: Harness): string {
  return harness.repos.materials.getAssets('mat_1')[0]!.id;
}
