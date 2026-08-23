import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { ProviderError } from '../llm/errors.js';
import type {
  ProviderCallOptions,
  StructuredOutputDiagnostic,
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
  failTeachingBrief = false;
  failTeachingBriefWithSchemaDetails = false;
  simulateOneCandidateRepair = false;
  lastTeachingBriefInput: TeachingBriefGenerationInput | null = null;
  lastTutorInput: TutorTurnInput | null = null;

  override async generateTeachingBrief(
    input: TeachingBriefGenerationInput,
    opts?: ProviderCallOptions,
  ) {
    this.teachingBriefCalls += 1;
    this.lastTeachingBriefInput = input;
    if (this.failTeachingBrief) throw ProviderError.network();
    if (this.failTeachingBriefWithSchemaDetails) {
      throw ProviderError.invalidOutput(
        'provider-controlled summary must not be persisted',
        'schema',
        'SCHEMA_VALIDATION_FAILURE',
        true,
        undefined,
        {
          schemaName: 'TeachingBriefProposalPayloadSchema',
          operationType: 'prepare_teaching_brief',
          attemptNumber: 2,
          attemptKind: 'repair',
          provider: 'hy3',
          model: 'private-model-name',
          transportSuccess: true,
          httpStatus: 200,
          responseBodyBytes: 1234,
          contentType: 'string',
          contentBytes: 1000,
          contentFingerprint: 'sha256:private',
          finishReason: 'stop',
          truncated: false,
          possiblyIncomplete: false,
          jsonParseSuccess: true,
          jsonFormat: 'direct',
          topLevelType: 'object',
          topLevelKeys: ['segments'],
          schemaIssueCount: 1,
          schemaIssues: [{ path: 'practice.items.0.authority', code: 'invalid_enum_value' }],
          semanticIssueCodes: [],
          failureCategory: 'SCHEMA_VALIDATION_FAILURE',
          repairAction: 'exhausted',
          structuralPreview: { privateSourceText: '<string>' },
        } satisfies StructuredOutputDiagnostic,
      );
    }
    if (this.simulateOneCandidateRepair && opts?.validateCandidate) {
      let evaluatedRepairCandidate = false;
      const validateCandidate = opts.validateCandidate;
      return super.generateTeachingBrief(input, {
        ...opts,
        validateCandidate(candidate) {
          if (!evaluatedRepairCandidate) {
            evaluatedRepairCandidate = true;
            const shallow = structuredClone(candidate) as { segments?: unknown[] };
            if (Array.isArray(shallow.segments)) shallow.segments = shallow.segments.slice(0, 1);
            validateCandidate(shallow);
          }
          return validateCandidate(candidate);
        },
      });
    }
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
  db: SqliteDb;
  repos: Repositories;
  provider: CountingProvider;
  services: Services;
  curriculumId: string;
  planId: string;
  learningUnitId: string;
  manifestFingerprint: string;
}

async function createHarness(providerDelayMs = 0): Promise<Harness> {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrate(db);
  const repos = createRepositories(db);
  const provider = new CountingProvider({ delayMs: providerDelayMs });
  repos.workspaces.insert(makeWorkspace());
  const content = 'Working memory has limited capacity.';
  const visualBytes = Buffer.from('bounded exact visual fixture');
  const visualHash = `sha256:${createHash('sha256').update(visualBytes).digest('hex')}` as const;
  repos.materials.insertWithBlocks(
    makeMaterial({ content, charCount: content.length }),
    [
      makeBlock({
        content,
        startOffset: 0,
        endOffset: content.length,
        heading: 'Memory',
        chunkerVersion: 'structure-aware-v1',
      }),
    ],
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
    providerEndpointIdentity: 'local:fake',
    providerRuntimeIdentity: 'fake-provider-v1',
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
    db,
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

  it('preserves the current source fingerprint when persisting a modern chunked block', async () => {
    const harness = await createHarness();
    const input = {
      workspaceId: 'ws_1',
      curriculumVersionId: harness.curriculumId,
      studyPlanVersionId: harness.planId,
      learningUnitId: harness.learningUnitId,
      commandId: 'brief-modern-chunked-source',
      expectedExecutionSourceManifestFingerprint: harness.manifestFingerprint,
    };

    const prepared = await harness.services.teachingBriefPreparation.prepare(input);

    expect(prepared.status).toBe('prepared');
    expect(prepared.brief.sourceReferences[0]?.sourceBlockRevisionFingerprint).toBe(
      harness.repos.curricula
        .get(harness.curriculumId)!
        .nodes.find((node) => node.id === harness.learningUnitId)!.sourceReferences[0]!
        .sourceBlockRevisionFingerprint,
    );
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      1,
    );
  });

  it('fails closed on changed source bindings without offering a preparation retry', async () => {
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
    const block = harness.repos.materials.getBlock('blk_1')!;
    harness.db
      .prepare('UPDATE source_blocks SET content = ? WHERE id = ?')
      .run(`${block.content} changed after acceptance`, block.id);

    await expect(
      harness.services.lessonExecution.ensure('ws_1', started.session.id, {
        command: command('lesson-invalid-source'),
        expectedSessionVersion: started.session.version,
        expectedAgendaVersion: agenda.version,
        expectedAgendaItemId: started.session.currentAgendaItemId,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const unavailable = harness.services.lessonExecution.get('ws_1', started.session.id);
    expect(unavailable.status).toBe('lesson_unavailable');
    expect(unavailable.allowedActions).toEqual([]);
    expect(unavailable.message).toContain('来源绑定');
    expect(harness.provider.teachingBriefCalls).toBe(0);
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      0,
    );
  });

  it('keeps transient provider failures retryable', async () => {
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
    harness.provider.failTeachingBrief = true;

    const retryable = await harness.services.lessonExecution.ensure('ws_1', started.session.id, {
      command: command('lesson-provider-failure'),
      expectedSessionVersion: started.session.version,
      expectedAgendaVersion: agenda.version,
      expectedAgendaItemId: started.session.currentAgendaItemId,
    });

    expect(retryable.status).toBe('retry_available');
    expect(retryable.allowedActions).toEqual(['retry_preparation']);
    expect(harness.provider.teachingBriefCalls).toBe(1);
  });

  it('persists only sanitized schema issue metadata for a failed Teaching Brief', async () => {
    const harness = await createHarness();
    harness.provider.failTeachingBriefWithSchemaDetails = true;

    await expect(
      harness.services.teachingBriefPreparation.prepare({
        workspaceId: 'ws_1',
        curriculumVersionId: harness.curriculumId,
        studyPlanVersionId: harness.planId,
        learningUnitId: harness.learningUnitId,
        commandId: 'brief-schema-observability',
        expectedExecutionSourceManifestFingerprint: harness.manifestFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });

    const operation = harness.repos.operations
      .listForWorkspace('ws_1', 'prepare_teaching_brief')
      .find((candidate) => candidate.commandId.endsWith('brief-schema-observability'))!;
    const result = harness.repos.operations.getResult(operation.id)!;
    expect(result).toMatchObject({
      status: 'failed',
      payload: {
        structuredFailure: {
          attemptNumber: 2,
          attemptKind: 'repair',
          jsonParseSuccess: true,
          schemaIssueCount: 1,
          schemaIssues: [{ path: 'practice.items.0.authority', code: 'invalid_enum_value' }],
          failureCategory: 'SCHEMA_VALIDATION_FAILURE',
          repairAction: 'exhausted',
        },
      },
    });
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain('provider-controlled summary');
    expect(serialized).not.toContain('private-model-name');
    expect(serialized).not.toContain('privateSourceText');
    expect(serialized).not.toContain('sha256:private');
  });

  it('records one bounded candidate repair only after a fresh passing reevaluation', async () => {
    const harness = await createHarness();
    harness.provider.simulateOneCandidateRepair = true;
    const prepared = await harness.services.teachingBriefPreparation.prepare({
      workspaceId: 'ws_1',
      curriculumVersionId: harness.curriculumId,
      studyPlanVersionId: harness.planId,
      learningUnitId: harness.learningUnitId,
      commandId: 'brief-bounded-candidate-repair',
      expectedExecutionSourceManifestFingerprint: harness.manifestFingerprint,
    });

    expect(prepared.status).toBe('prepared');
    expect(prepared.brief.pedagogyEvaluation).toMatchObject({
      status: 'pass',
      boundedRepairAttempted: true,
      independent: true,
    });
    expect(prepared.brief.practice?.qualityEvaluation).toMatchObject({
      status: 'pass',
      boundedRepairAttempted: true,
      independent: true,
    });
    expect(harness.provider.teachingBriefCalls).toBe(1);
  });

  it('cancels delayed preparation without accepting a late result and permits an explicit retry', async () => {
    const harness = await createHarness(100);
    const agenda = harness.repos.sessionAgendas.list('ws_1').at(-1)!;
    const execution = harness.repos.courseExecution.get('ws_1');
    const started = harness.services.studySessions.start('ws_1', {
      contractVersionId: agenda.contractVersionId,
      curriculumVersionId: agenda.curriculumVersionId,
      studyPlanVersionId: agenda.studyPlanVersionId,
      sessionAgendaId: agenda.id,
      expectedCourseExecutionVersion: execution.version,
    });
    const abort = new AbortController();
    const pending = harness.services.lessonExecution.ensure(
      'ws_1',
      started.session.id,
      {
        command: command('lesson-cancelled-preparation'),
        expectedSessionVersion: started.session.version,
        expectedAgendaVersion: agenda.version,
        expectedAgendaItemId: started.session.currentAgendaItemId,
      },
      { signal: abort.signal },
    );
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    const cancelled = harness.services.lessonExecution.get('ws_1', started.session.id);
    expect(cancelled.status).toBe('retry_available');
    expect(cancelled.allowedActions).toEqual(['retry_preparation']);
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      0,
    );

    const retried = await harness.services.lessonExecution.ensure('ws_1', started.session.id, {
      command: command('lesson-cancelled-preparation-retry'),
      expectedSessionVersion: cancelled.session!.version,
      expectedAgendaVersion: cancelled.agenda!.version,
      expectedAgendaItemId: started.session.currentAgendaItemId,
    });
    expect(retried.status).toBe('ready');
    expect(retried.lesson).not.toBeNull();
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      1,
    );
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
    const authorityBefore = {
      evidence: harness.repos.formalProgression.listEvidenceForWorkspace('ws_1'),
      decisions: harness.repos.formalProgression.listDecisionsForWorkspace('ws_1'),
      unitProgress: harness.repos.formalProgression.listUnitProgress('ws_1', harness.curriculumId),
      mistakes: harness.repos.mistakes.listOpenByWorkspace('ws_1'),
      mastery: harness.repos.mastery.listByWorkspace('ws_1'),
      agendaItemState: harness.repos.sessionAgendas
        .get(agenda.id)!
        .items.find((item) => item.id === session.currentAgendaItemId)!.state,
    };

    let current = harness.services.lessonExecution.get('ws_1', session.id);
    for (let segmentIndex = 1; segmentIndex < current.progress!.segmentCount; segmentIndex += 1) {
      current = await harness.services.lessonExecution.command('ws_1', session.id, {
        command: command(`lesson-segment-${segmentIndex}`),
        expectedSessionVersion: current.session.version,
        expectedAgendaVersion: current.agenda!.version,
        expectedAgendaItemId: session.currentAgendaItemId!,
        expectedLessonStateVersion: current.progress!.stateVersion,
        action: { kind: 'move_to_segment', segmentIndex },
      });
    }
    expect(current.currentInformalCheck?.guidance).toBeNull();
    expect(current.allowedActions).not.toContain('complete_presentation');
    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('lesson-deliberate-response'),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: session.currentAgendaItemId!,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: {
        kind: 'respond_to_informal_check',
        segmentIndex: current.progress!.currentSegmentIndex,
        response: 'The condition changes which candidate remains eligible.',
      },
    });
    expect(current.currentInformalCheck?.guidance).toContain('source-stated condition');
    expect(current.allowedActions).toContain('complete_presentation');
    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('lesson-presentation-complete'),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: session.currentAgendaItemId!,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: { kind: 'complete_presentation' },
    });
    expect(current.practice?.status).toBe('available');
    const initialItem = current.practice!.item!;
    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('practice-wrong-answer'),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: session.currentAgendaItemId!,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: {
        kind: 'submit_practice_response',
        itemIndex: initialItem.index,
        optionId: initialItem.options[1]!.id,
      },
    });
    expect(current.practice?.attempts.at(-1)).toMatchObject({
      correct: false,
      attemptNumber: 1,
      surface: 'initial',
      credit: 'none',
    });
    expect(current.practice?.attempts.at(-1)?.hint).toBeTruthy();
    expect(current.practice?.item?.surface).toBe('retry');
    const retryItem = current.practice!.item!;
    expect(retryItem.prompt).not.toBe(initialItem.prompt);
    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('practice-correct-retry'),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: session.currentAgendaItemId!,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: {
        kind: 'submit_practice_response',
        itemIndex: retryItem.index,
        optionId: retryItem.options[1]!.id,
      },
    });
    expect(current.practice?.status).toBe('completed');
    expect(current.allowedActions).toEqual(['review_lesson']);
    const executionState = harness.repos.lessonExecution.getForSession(
      session.id,
      session.currentAgendaItemId!,
    )!;
    expect(
      harness.repos.lessonExecution.listEvents(executionState.id).map((event) => event.kind),
    ).toEqual(expect.arrayContaining(['practice_response_recorded', 'practice_completed']));

    const authorityAfter = {
      evidence: harness.repos.formalProgression.listEvidenceForWorkspace('ws_1'),
      decisions: harness.repos.formalProgression.listDecisionsForWorkspace('ws_1'),
      unitProgress: harness.repos.formalProgression.listUnitProgress('ws_1', harness.curriculumId),
      mistakes: harness.repos.mistakes.listOpenByWorkspace('ws_1'),
      mastery: harness.repos.mastery.listByWorkspace('ws_1'),
      agendaItemState: harness.repos.sessionAgendas
        .get(agenda.id)!
        .items.find((item) => item.id === session.currentAgendaItemId)!.state,
    };
    expect(authorityAfter).toEqual(authorityBefore);
    expect(harness.repos.formalProgression.listEvidenceForWorkspace('ws_1')).toHaveLength(0);
    expect(harness.repos.mistakes.listOpenByWorkspace('ws_1')).toHaveLength(0);
    expect(harness.repos.mastery.listByWorkspace('ws_1')).toHaveLength(0);
    expect(harness.provider.teachingBriefCalls).toBe(1);
  });
});

function visualAssetId(harness: Harness): string {
  return harness.repos.materials.getAssets('mat_1')[0]!.id;
}
