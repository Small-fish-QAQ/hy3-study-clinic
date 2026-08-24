import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiErrorCode, type LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { AppError } from '../errors.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { ProviderError } from '../llm/errors.js';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  ProviderCallOptions,
  StructuredOutputDiagnostic,
  TutorTurnInput,
} from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeConcept, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createServices, type Services } from './index.js';
import {
  fingerprintObjectiveAuthorityBinding,
  fingerprintObjectiveAuthorityProposition,
} from './objectiveAuthoritySemanticSupport.js';
import {
  serializedTeachingProviderSourceEnvelopeBytes,
  TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES,
} from './teachingBriefContext.js';
import {
  COMPOSITIONAL_PREPARATION_LEASE_MS,
  LESSON_CONTENT_PROMPT_VERSION,
  PRACTICE_CONTENT_PROMPT_VERSION,
} from './teachingBriefPreparation.js';

const clock = fixedClock(T0);
const databases: SqliteDb[] = [];
const LESSON_INPUT_MUTATION_SENTINEL = 'LESSON_PROVIDER_INPUT_MUTATION_SENTINEL';
const PRACTICE_INPUT_MUTATION_SENTINEL = 'PRACTICE_PROVIDER_INPUT_MUTATION_SENTINEL';

function operationStudySessionId(db: SqliteDb, operationId: string): string | null | undefined {
  return (
    db
      .prepare('SELECT study_session_id AS studySessionId FROM agent_operations WHERE id = ?')
      .get(operationId) as { studySessionId: string | null } | undefined
  )?.studySessionId;
}

class CountingProvider extends FakeProvider {
  lessonContentCalls = 0;
  practiceContentCalls = 0;
  failLessonContent = false;
  failLessonContentWithSchemaDetails = false;
  failPracticeContentOnce = false;
  failPracticeIndependentEvaluationOnce = false;
  simulateOneCandidateRepair = false;
  simulateLessonSchemaRepair = false;
  simulatePracticeSchemaRepair = false;
  mutateLessonInputAfterGeneration = false;
  mutatePracticeInputAfterGeneration = false;
  onLessonContentGenerated: (() => void | Promise<void>) | null = null;
  onPracticeContentGenerated: (() => void | Promise<void>) | null = null;
  lessonContentFailureGate: Promise<void> | null = null;
  practiceContentGate: Promise<void> | null = null;
  onPracticeContentStarted: (() => void) | null = null;
  acceptedLessonBytesSeenByPractice: string[] = [];
  lessonSkeletonBytesBeforeMutation: string | null = null;
  lessonContentBytesBeforeMutation: string | null = null;
  practiceSkeletonBytesBeforeMutation: string | null = null;
  practiceAcceptedLessonBytesBeforeMutation: string | null = null;
  lastLessonContentInput: LessonSlotContentGenerationInput | null = null;
  lastPracticeContentInput: PracticeContentGenerationInput | null = null;
  lastTutorInput: TutorTurnInput | null = null;
  lessonUsageMicrounits: number | null = null;

  override async generateLessonSlotContent(
    input: LessonSlotContentGenerationInput,
    opts?: ProviderCallOptions,
  ) {
    this.lessonContentCalls += 1;
    this.lastLessonContentInput = input;
    if (this.lessonUsageMicrounits !== null) {
      opts?.onUsage?.({
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostMicrounits: this.lessonUsageMicrounits,
        currency: 'USD',
        pricingSource: 'test-fixture',
        pricingVersion: '1',
      });
    }
    if (this.failLessonContent) {
      if (this.lessonContentFailureGate) await this.lessonContentFailureGate;
      throw ProviderError.network();
    }
    if (this.failLessonContentWithSchemaDetails) {
      throw ProviderError.invalidOutput(
        'provider-controlled summary must not be persisted',
        'schema',
        'SCHEMA_VALIDATION_FAILURE',
        true,
        undefined,
        {
          schemaName: 'LessonSlotContentProposalPayloadSchema',
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
          topLevelKeys: ['slots'],
          schemaIssueCount: 1,
          schemaIssues: [{ path: 'slots.0.sourceRefs', code: 'invalid_type' }],
          semanticIssueCodes: [],
          failureCategory: 'SCHEMA_VALIDATION_FAILURE',
          repairAction: 'exhausted',
          structuralPreview: { privateSourceText: '<string>' },
        } satisfies StructuredOutputDiagnostic,
      );
    }
    if (this.simulateLessonSchemaRepair) {
      this.simulateLessonSchemaRepair = false;
      opts?.onRepairAttempt?.('schema', 'SCHEMA_VALIDATION_FAILURE');
    }
    if (this.simulateOneCandidateRepair && opts?.validateCandidate) {
      let evaluatedRepairCandidate = false;
      const validateCandidate = opts.validateCandidate;
      return super.generateLessonSlotContent(input, {
        ...opts,
        validateCandidate(candidate) {
          if (!evaluatedRepairCandidate) {
            evaluatedRepairCandidate = true;
            const shallow = structuredClone(candidate) as { slots?: unknown[] };
            if (Array.isArray(shallow.slots)) shallow.slots = shallow.slots.slice(0, 1);
            validateCandidate(shallow);
            opts.onRepairAttempt?.('candidate', 'SEMANTIC_VALIDATION_FAILURE');
          }
          return validateCandidate(candidate);
        },
      });
    }
    const payload = await super.generateLessonSlotContent(input, opts);
    await this.onLessonContentGenerated?.();
    if (this.mutateLessonInputAfterGeneration) {
      this.lessonSkeletonBytesBeforeMutation = JSON.stringify(input.skeleton);
      this.lessonContentBytesBeforeMutation = JSON.stringify(payload.slots);
      const objective = input.skeleton.objectives[0]!;
      const slot = input.skeleton.lessonSlots[0]!;
      objective.title = `${objective.title} ${LESSON_INPUT_MUTATION_SENTINEL}`;
      slot.purpose = `${slot.purpose} ${LESSON_INPUT_MUTATION_SENTINEL}`;
    }
    return payload;
  }

  override async generatePracticeContent(
    input: PracticeContentGenerationInput,
    opts?: ProviderCallOptions,
  ) {
    this.practiceContentCalls += 1;
    this.lastPracticeContentInput = input;
    this.acceptedLessonBytesSeenByPractice.push(JSON.stringify(input.acceptedLesson));
    this.onPracticeContentStarted?.();
    if (this.practiceContentGate) await this.practiceContentGate;
    if (this.failPracticeContentOnce) {
      this.failPracticeContentOnce = false;
      throw ProviderError.network();
    }
    if (this.simulatePracticeSchemaRepair) {
      this.simulatePracticeSchemaRepair = false;
      opts?.onRepairAttempt?.('schema', 'SCHEMA_VALIDATION_FAILURE');
    }
    if (this.simulateOneCandidateRepair && opts?.validateCandidate) {
      let evaluatedRepairCandidate = false;
      const validateCandidate = opts.validateCandidate;
      return super.generatePracticeContent(input, {
        ...opts,
        validateCandidate(candidate) {
          if (!evaluatedRepairCandidate) {
            evaluatedRepairCandidate = true;
            const shallow = structuredClone(candidate) as { items?: unknown[] };
            if (Array.isArray(shallow.items)) shallow.items = shallow.items.slice(0, 1);
            validateCandidate(shallow);
            opts.onRepairAttempt?.('candidate', 'SEMANTIC_VALIDATION_FAILURE');
          }
          return validateCandidate(candidate);
        },
      });
    }
    const payload = await super.generatePracticeContent(input, opts);
    await this.onPracticeContentGenerated?.();
    if (this.mutatePracticeInputAfterGeneration) {
      this.practiceSkeletonBytesBeforeMutation = JSON.stringify(input.skeleton);
      this.practiceAcceptedLessonBytesBeforeMutation = JSON.stringify(input.acceptedLesson);
      const slot = input.skeleton.lessonSlots[0]!;
      const lesson = input.acceptedLesson[0]!;
      slot.purpose = `${slot.purpose} ${PRACTICE_INPUT_MUTATION_SENTINEL}`;
      lesson.explanation = `${lesson.explanation} ${PRACTICE_INPUT_MUTATION_SENTINEL}`;
    }
    if (!this.failPracticeIndependentEvaluationOnce) return payload;
    this.failPracticeIndependentEvaluationOnce = false;
    const unrelated = structuredClone(payload);
    const item = unrelated.items[0]!;
    item.capabilityTested = '辨认叶绿体在植物细胞光合作用中的功能。';
    item.pedagogicalReason = '检验对植物细胞器与光能吸收关系的区分。';
    item.initial = {
      prompt: '植物叶片中负责吸收光能的细胞器是哪一个？',
      options: [
        {
          optionRef: 'A',
          text: '叶绿体依靠其中的色素吸收光能。',
          feedbackIfSelected: '正确：叶绿体色素承担吸收光能的功能。',
        },
        {
          optionRef: 'B',
          text: '细胞核负责吸收全部入射光能。',
          feedbackIfSelected: '细胞核主要保存遗传物质，并不承担吸光功能。',
        },
        {
          optionRef: 'C',
          text: '细胞壁把阳光直接转化为遗传物质。',
          feedbackIfSelected: '细胞壁提供结构支撑，不进行这种转化。',
        },
      ],
      correctOptionRef: 'A',
      hint: '关注含有吸光色素的植物细胞器。',
      explanation: '叶绿体色素会吸收光合作用所需的光能。',
    };
    item.retry = {
      prompt: '阴影中的叶片仍由哪个细胞器携带吸光色素？',
      options: [
        {
          optionRef: 'A',
          text: '液泡含有主要的吸光色素。',
          feedbackIfSelected: '液泡主要储存水和溶解物质。',
        },
        {
          optionRef: 'B',
          text: '叶绿体仍然含有吸光色素。',
          feedbackIfSelected: '正确：光照变化不会替换承担该功能的细胞器。',
        },
        {
          optionRef: 'C',
          text: '细胞膜在阴影中会变成吸光细胞器。',
          feedbackIfSelected: '细胞膜仍是边界结构，不会变成该细胞器。',
        },
      ],
      correctOptionRef: 'B',
      hint: '光照条件改变不会替换相关细胞器。',
      explanation: '叶片光照减少时，叶绿体仍保留其色素。',
    };
    return unrelated;
  }

  override async respondToTutorTurn(input: TutorTurnInput, opts?: ProviderCallOptions) {
    this.lastTutorInput = input;
    return super.respondToTutorTurn(input, opts);
  }
}

function command(id: string, actor: 'learner' | 'local' = 'learner') {
  return { commandId: id, idempotencyKey: id, workspaceId: 'ws_1', actor } as const;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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
  const content = '[SUPPORTS:explain] Working memory has limited capacity.';
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

function startTeachingRoute(harness: Harness) {
  const agenda = harness.repos.sessionAgendas.list('ws_1').at(-1)!;
  const execution = harness.repos.courseExecution.get('ws_1');
  const started = harness.services.studySessions.start('ws_1', {
    contractVersionId: agenda.contractVersionId,
    curriculumVersionId: agenda.curriculumVersionId,
    studyPlanVersionId: agenda.studyPlanVersionId,
    sessionAgendaId: agenda.id,
    expectedCourseExecutionVersion: execution.version,
  });
  const agendaItem = agenda.items.find((item) => item.id === started.session.currentAgendaItemId)!;
  if (!agendaItem.linkedPlanItemId) throw new Error('Expected an Agenda-linked teaching item.');
  return { agenda, session: started.session, agendaItem };
}

function setTeachingPlanObjectiveIds(harness: Harness, objectiveIds: string[]): void {
  const plan = structuredClone(harness.repos.studyPlans.get(harness.planId)!);
  const planItem = plan.items.find(
    (item) =>
      item.kind === 'teach_unit' && item.curriculumLearningUnitId === harness.learningUnitId,
  )!;
  planItem.objectiveIds = objectiveIds;
  harness.db
    .prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?')
    .run(JSON.stringify(plan), plan.id);
  harness.db
    .prepare('UPDATE study_plan_items SET objective_ids = ? WHERE plan_id = ? AND plan_item_id = ?')
    .run(JSON.stringify(objectiveIds), plan.id, planItem.id);
}

function addSameUnitRouteAndDeferredObjectives(harness: Harness) {
  const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
  const node = curriculum.nodes.find((candidate) => candidate.id === harness.learningUnitId)!;
  const baseObjective = node.learningUnit!.objectives[0]!;
  const cloneSemanticSupport = (
    id: string,
    title: string,
    description: string,
  ): typeof baseObjective.semanticSupport => {
    const base = structuredClone(baseObjective.semanticSupport!);
    const proposition = `${title}\n${description}`;
    return {
      ...base,
      objectiveId: id,
      proposition,
      propositionFingerprint: fingerprintObjectiveAuthorityProposition(proposition),
      fragments: [
        {
          ...base.fragments[0]!,
          fragmentId: `${id}_fragment`,
          text: proposition,
        },
      ],
    };
  };
  const routeSecondId = 'obj_route_second';
  const routeSecondTitle = 'Route-scoped follow-up objective';
  const routeSecondDescription =
    'Identify a second source-supported capability assigned to this exact accepted Plan item.';
  const routeSecond: typeof baseObjective = {
    ...baseObjective,
    id: routeSecondId,
    title: routeSecondTitle,
    description: routeSecondDescription,
    priority: 'optional',
    semanticSupport: cloneSemanticSupport(routeSecondId, routeSecondTitle, routeSecondDescription),
  };
  const deferredId = 'obj_deferred_same_unit';
  const deferredTitle = 'DEFERRED_OBJECTIVE_MUST_NOT_LEAK';
  const deferredDescription =
    'Identify this exact source-supported objective only when its own Plan item selects it.';
  const deferred: typeof baseObjective = {
    ...baseObjective,
    id: deferredId,
    title: deferredTitle,
    description: deferredDescription,
    priority: 'optional',
    semanticSupport: cloneSemanticSupport(deferredId, deferredTitle, deferredDescription),
  };
  node.learningUnit!.objectives.push(routeSecond, deferred);
  harness.db
    .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
    .run(JSON.stringify(curriculum), curriculum.id);
  for (const objective of [routeSecond, deferred]) {
    const support = objective.semanticSupport!;
    harness.db
      .prepare(
        `INSERT INTO curriculum_objective_index
           (curriculum_id, learning_unit_id, objective_id, truth_premise_status)
         VALUES (?, ?, ?, ?)`,
      )
      .run(curriculum.id, node.id, objective.id, objective.truthPremiseStatus);
    for (const authorityRecordId of objective.truthAuthorityRecordIds) {
      harness.db
        .prepare(
          `INSERT INTO curriculum_objective_authority
             (curriculum_id, objective_id, authority_record_id) VALUES (?, ?, ?)`,
        )
        .run(curriculum.id, objective.id, authorityRecordId);
    }
    harness.db
      .prepare(
        `INSERT INTO curriculum_objective_semantic_support
           (curriculum_id, objective_id, policy_version, evaluator, provider,
            provider_model, status, proposition_fingerprint, binding_fingerprint,
            payload, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        curriculum.id,
        objective.id,
        support.policyVersion,
        support.evaluator,
        support.provider,
        support.providerModel,
        support.verdict,
        support.propositionFingerprint,
        support.bindingFingerprint,
        JSON.stringify(support),
        support.evaluatedAt,
      );
  }
  const routeObjectiveIds = [baseObjective.id];
  setTeachingPlanObjectiveIds(harness, routeObjectiveIds);
  return { routeObjectiveIds, routeSecond, baseObjective, deferred };
}

function configureTeachingSourceEnvelopeBoundary(
  harness: Harness,
  claimLength: number,
  objectiveCount = 4,
  claimCount = 7,
): string[] {
  const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
  const node = curriculum.nodes.find((candidate) => candidate.id === harness.learningUnitId)!;
  const baseObjective = node.learningUnit!.objectives[0]!;
  const supportedClaimId = baseObjective
    .semanticSupport!.fragments.filter((fragment) => fragment.status === 'supported')
    .flatMap((fragment) => fragment.authorityClaimIds)[0]!;
  const authorityRecordId = baseObjective.truthAuthorityRecordIds[0]!;
  const blockId = baseObjective.authoritySourceBlockIds![0]!;
  const claimIds = Array.from({ length: claimCount }, (_, index) =>
    index === 0 ? supportedClaimId : `claim_budget_${index + 1}`,
  );
  const quotes = claimIds.map((_claimId, index) =>
    String.fromCharCode('A'.charCodeAt(0) + index).repeat(claimLength),
  );
  const content = quotes.join('');

  harness.db
    .prepare('UPDATE source_blocks SET content = ?, start_offset = 0, end_offset = ? WHERE id = ?')
    .run(content, content.length, blockId);
  for (const baseClaimId of baseObjective.authorityClaimIds ?? [supportedClaimId]) {
    harness.db
      .prepare(
        `UPDATE truth_authority_claims
         SET quote = ?, start_offset = 0, end_offset = ?, occurrence_count = 1
         WHERE id = ?`,
      )
      .run(quotes[0], claimLength, baseClaimId);
  }
  for (let index = 1; index < claimIds.length; index += 1) {
    harness.db
      .prepare(
        `INSERT INTO truth_authority_claims
           (id, authority_record_id, source_block_id, claim, quote, start_offset,
            end_offset, occurrence_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        claimIds[index],
        authorityRecordId,
        blockId,
        `Supported exact Teaching claim ${index + 1}.`,
        quotes[index],
        index * claimLength,
        (index + 1) * claimLength,
        T0,
      );
  }

  const currentBlock = harness.repos.materials.getBlock(blockId)!;
  const blockFingerprint = curriculumSourceBlockFingerprint(
    currentBlock,
    currentBlock.materialRevisionId!,
  );
  for (const reference of node.sourceReferences) {
    if (reference.sourceBlockId === blockId) {
      reference.sourceBlockRevisionFingerprint = blockFingerprint;
    }
  }
  node.learningUnit!.conceptIds = [];

  const objectives = Array.from({ length: objectiveCount }, (_, index) => {
    const objective = structuredClone(baseObjective);
    if (index === 0) return objective;
    objective.id = `obj_budget_${index + 1}`;
    objective.title = `Budget objective ${index + 1}`;
    objective.description = `Explain supported budget capability ${index + 1}.`;
    objective.priority = 'optional';
    objective.truthAuthorityRecordIds = [authorityRecordId];
    const proposition = `${objective.title}\n${objective.description}`;
    objective.authorityClaimIds = [...claimIds];
    objective.semanticSupport = {
      ...objective.semanticSupport!,
      objectiveId: objective.id,
      proposition,
      propositionFingerprint: fingerprintObjectiveAuthorityProposition(proposition),
      bindingFingerprint: fingerprintObjectiveAuthorityBinding({
        authorityRecordIds: objective.truthAuthorityRecordIds,
        sourceBlockIds: objective.authoritySourceBlockIds ?? [],
        authorityClaimIds: claimIds,
      }),
      boundAuthorityClaimIds: [...claimIds],
      boundAuthorityRecordIds: [authorityRecordId],
      fragments: [
        {
          ...objective.semanticSupport!.fragments[0]!,
          fragmentId: `${objective.id}_fragment`,
          text: proposition,
          authorityRecordIds: [authorityRecordId],
          authorityClaimIds: [...claimIds],
        },
      ],
    };
    return objective;
  });
  node.learningUnit!.objectives = objectives;
  harness.db
    .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
    .run(JSON.stringify(curriculum), curriculum.id);

  for (const objective of objectives) {
    const support = objective.semanticSupport!;
    if (objective.id === baseObjective.id) continue;
    harness.db
      .prepare(
        `INSERT INTO curriculum_objective_index
             (curriculum_id, learning_unit_id, objective_id, truth_premise_status)
           VALUES (?, ?, ?, ?)`,
      )
      .run(curriculum.id, node.id, objective.id, objective.truthPremiseStatus);
    for (const recordId of objective.truthAuthorityRecordIds) {
      harness.db
        .prepare(
          `INSERT INTO curriculum_objective_authority
               (curriculum_id, objective_id, authority_record_id) VALUES (?, ?, ?)`,
        )
        .run(curriculum.id, objective.id, recordId);
    }
    harness.db
      .prepare(
        `INSERT INTO curriculum_objective_semantic_support
             (curriculum_id, objective_id, policy_version, evaluator, provider,
              provider_model, status, proposition_fingerprint, binding_fingerprint,
              payload, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        curriculum.id,
        objective.id,
        support.policyVersion,
        support.evaluator,
        support.provider,
        support.providerModel,
        support.verdict,
        support.propositionFingerprint,
        support.bindingFingerprint,
        JSON.stringify(support),
        support.evaluatedAt,
      );
  }
  const objectiveIds = objectives.map((objective) => objective.id);
  setTeachingPlanObjectiveIds(harness, objectiveIds);
  return quotes;
}

function switchToSuccessorTeachingRoute(harness: Harness, route: TeachingRoute) {
  const agenda = harness.repos.sessionAgendas.get(route.agenda.id)!;
  const successor = {
    ...route.agendaItem,
    id: `${route.agendaItem.id}_successor`,
    index: Math.max(...agenda.items.map((item) => item.index)) + 1,
    state: 'active' as const,
    reason: 'Successor teaching route used to verify stale failure fencing.',
  };
  const nextAgenda = harness.repos.sessionAgendas.update(
    {
      ...agenda,
      version: agenda.version + 1,
      currentItemId: successor.id,
      items: [
        ...agenda.items.map((item) =>
          item.id === route.agendaItem.id
            ? { ...item, state: 'completed' as const }
            : item.state === 'active'
              ? { ...item, state: 'queued' as const }
              : item,
        ),
        successor,
      ],
      updatedAt: T0,
    },
    agenda.version,
    {
      id: `agenda_event_${successor.id}`,
      eventType: 'test_route_switched',
      actor: 'local',
      payload: { successorAgendaItemId: successor.id },
      createdAt: T0,
    },
  );
  const session = harness.repos.studySessions.get(route.session.id)!;
  const nextSession = harness.repos.studySessions.update(
    {
      ...session,
      version: session.version + 1,
      currentAgendaItemId: successor.id,
      updatedAt: T0,
    },
    session.version,
  );
  return { agenda: nextAgenda, session: nextSession, agendaItem: successor };
}

type TeachingRoute = ReturnType<typeof startTeachingRoute>;

function preparationRequest(
  harness: Harness,
  route: TeachingRoute,
  commandId: string,
  overrides: {
    learningUnitId?: string;
    studySessionId?: string;
    expectedExecutionSourceManifestFingerprint?: string;
  } = {},
) {
  return {
    workspaceId: 'ws_1',
    curriculumVersionId: harness.curriculumId,
    studyPlanVersionId: harness.planId,
    learningUnitId: overrides.learningUnitId ?? harness.learningUnitId,
    studySessionId: overrides.studySessionId ?? route.session.id,
    sessionAgendaId: route.agenda.id,
    expectedSessionVersion: route.session.version,
    expectedAgendaVersion: route.agenda.version,
    expectedAgendaItemId: route.agendaItem.id,
    expectedStudyPlanItemId: route.agendaItem.linkedPlanItemId!,
    commandId,
    expectedExecutionSourceManifestFingerprint:
      overrides.expectedExecutionSourceManifestFingerprint ?? harness.manifestFingerprint,
  };
}

function staleCurrentCurriculumSemanticSupport(harness: Harness, reason: string): void {
  const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
  const planItem = harness.repos.studyPlans
    .get(harness.planId)!
    .items.find(
      (item) =>
        item.kind === 'teach_unit' && item.curriculumLearningUnitId === harness.learningUnitId,
    )!;
  const objective = curriculum.nodes
    .find((node) => node.id === harness.learningUnitId)!
    .learningUnit!.objectives.find((candidate) => planItem.objectiveIds.includes(candidate.id))!;
  objective.description = `${objective.description} ${reason}`;
  harness.db
    .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
    .run(JSON.stringify(curriculum), curriculum.id);
}

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe('Teaching Brief preparation', () => {
  it('accepts the exact just-under-budget annotated multi-objective source envelope', () => {
    const buildEnvelope = (quoteLength: number) => {
      const objectiveRefs = ['O1', 'O2', 'O3', 'O4'];
      const offers = Array.from({ length: 7 }, (_, index) => ({
        sourceRef: `S${index + 1}`,
        materialTitle: 'Bounded source',
        headingPath: ['Budget boundary'],
        pageNumber: 1,
        slideNumber: null,
        text: String.fromCharCode('A'.charCodeAt(0) + index).repeat(quoteLength),
        authorizedObjectiveRefs: [...objectiveRefs],
      }));
      return {
        offers,
        objectiveEvidenceAliases: objectiveRefs.map((objectiveRef) => ({
          objectiveRef,
          evidenceAliases: offers.map((offer) => ({
            sourceRef: offer.sourceRef,
            text: offer.text,
          })),
        })),
      };
    };
    let low = 1;
    let high = 2_000;
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      if (
        serializedTeachingProviderSourceEnvelopeBytes(buildEnvelope(candidate)) <=
        TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES
      ) {
        low = candidate;
      } else {
        high = candidate - 1;
      }
    }
    const envelope = buildEnvelope(low);
    const auditedBytes = serializedTeachingProviderSourceEnvelopeBytes(envelope);
    expect(auditedBytes).toBeLessThanOrEqual(TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES);
    expect(serializedTeachingProviderSourceEnvelopeBytes(buildEnvelope(low + 1))).toBeGreaterThan(
      TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES,
    );
    expect(envelope.offers.every((offer) => offer.text.length === low)).toBe(true);
    for (const objective of envelope.objectiveEvidenceAliases) {
      expect(objective.evidenceAliases.map((alias) => alias.text)).toEqual(
        envelope.offers.map((offer) => offer.text),
      );
    }
  });

  it('fails a multi-objective full-claim envelope over 32KB before either provider call', async () => {
    const harness = await createHarness();
    configureTeachingSourceEnvelopeBoundary(harness, 1_100);
    const route = startTeachingRoute(harness);
    const commandId = 'brief-source-envelope-over-budget';

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, commandId),
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      message: 'Teaching Brief exact provider source envelope exceeds the byte budget.',
      details: {
        serializedBytes: expect.any(Number),
        maxSerializedBytes: TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES,
      },
    });

    expect(harness.provider.lessonContentCalls).toBe(0);
    expect(harness.provider.practiceContentCalls).toBe(0);
    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      `teaching-brief:${harness.learningUnitId}:${commandId}`,
    )!;
    expect(operation.status).toBe('failed');
    expect(
      harness.db
        .prepare('SELECT COUNT(*) AS count FROM model_logical_calls WHERE operation_id = ?')
        .get(operation.id),
    ).toEqual({ count: 0 });
  });

  it('prepares and reuses an immutable Brief for the accepted executable route', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const input = preparationRequest(harness, route, 'brief-prepare-1');
    const first = await harness.services.teachingBriefPreparation.prepare(input);
    expect(first.status).toBe('prepared');
    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      `teaching-brief:${harness.learningUnitId}:brief-prepare-1`,
    )!;
    expect(operationStudySessionId(harness.db, operation.id)).toBe(input.studySessionId);
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
    expect(harness.provider.lastLessonContentInput?.visualContext.offers[0]).not.toHaveProperty(
      'assetId',
    );
    const routeObjective = harness.repos.curricula
      .get(harness.curriculumId)!
      .nodes.find((node) => node.id === harness.learningUnitId)!.learningUnit!.objectives[0]!;
    const supportedClaimIds = new Set(
      routeObjective
        .semanticSupport!.fragments.filter((fragment) => fragment.status === 'supported')
        .flatMap((fragment) => fragment.authorityClaimIds),
    );
    const authorizedLessonOffers =
      harness.provider.lastLessonContentInput?.sourceContext.offers.filter((offer) =>
        offer.authorizedObjectiveRefs.includes('O1'),
      ) ?? [];
    expect(authorizedLessonOffers.length).toBeGreaterThan(0);
    for (const offer of authorizedLessonOffers) {
      const reference = first.brief.sourceReferences.find(
        (candidate) => candidate.refId === offer.sourceRef,
      )!;
      expect(reference.authorityClaimIds?.length).toBeGreaterThan(0);
      expect(reference.authorityClaimIds!.every((claimId) => supportedClaimIds.has(claimId))).toBe(
        true,
      );
      const exactClaim = routeObjective.truthAuthorityRecordIds
        .flatMap((recordId) => harness.repos.sourceAuthority.getBundle(recordId)?.claims ?? [])
        .find((claim) => reference.authorityClaimIds!.includes(claim.id))!;
      expect(reference).toMatchObject({
        sourceBlockId: exactClaim.sourceBlockId,
        startOffset: exactClaim.startOffset,
        endOffset: exactClaim.endOffset,
        quote: exactClaim.quote,
      });
      expect(offer.text).toBe(exactClaim.quote);
    }
    expect(
      harness.provider.lastLessonContentInput?.sourceContext.offers.some(
        (offer) => offer.authorizedObjectiveRefs.length === 0,
      ),
    ).toBe(true);
    expect(harness.provider.lastPracticeContentInput?.sourceContext).toEqual(
      harness.provider.lastLessonContentInput?.sourceContext,
    );
    expect(
      harness.provider.lastLessonContentInput?.skeleton.objectives[0]?.allowedSourceRefs,
    ).toEqual(authorizedLessonOffers.map((offer) => offer.sourceRef));
    expect(harness.provider.lastLessonContentInput?.skeleton).not.toHaveProperty('practicePlan');
    expect(harness.provider.lastPracticeContentInput?.acceptedLesson).toEqual(
      harness.provider.lastLessonContentInput?.skeleton.lessonSlots.map((slot) =>
        expect.objectContaining({ slotId: slot.slotId }),
      ),
    );
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    expect(first.brief.composition).toMatchObject({
      lessonLogicalCallId: `teaching-brief:${harness.learningUnitId}:brief-prepare-1:lesson`,
      practiceLogicalCallId: `teaching-brief:${harness.learningUnitId}:brief-prepare-1:practice`,
    });
    const lessonLogicalCall = harness.repos.telemetry.getLogicalCall(
      first.brief.composition!.lessonLogicalCallId!,
    );
    const practiceLogicalCall = harness.repos.telemetry.getLogicalCall(
      first.brief.composition!.practiceLogicalCallId!,
    );
    expect(lessonLogicalCall).toMatchObject({
      operationType: 'prepare_teaching_brief',
      schemaFingerprint: 'lesson-slot-content-proposal-v1',
      status: 'completed',
    });
    expect(practiceLogicalCall).toMatchObject({
      operationType: 'prepare_teaching_brief',
      schemaFingerprint: 'practice-content-proposal-v1',
      status: 'completed',
    });
    expect(lessonLogicalCall?.id).not.toBe(practiceLogicalCall?.id);
    const replay = await harness.services.teachingBriefPreparation.prepare(input);
    expect(replay).toEqual(first);
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      1,
    );
    expect(
      harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)[0]!.visualReferences,
    ).toHaveLength(1);
  });

  for (const corruption of ['tampered', 'missing'] as const) {
    it(`rejects a ${corruption} exact supported authority claim before the Lesson provider call`, async () => {
      const harness = await createHarness();
      const route = startTeachingRoute(harness);
      const curriculum = harness.repos.curricula.get(harness.curriculumId)!;
      const objective = curriculum.nodes.find((node) => node.id === harness.learningUnitId)!
        .learningUnit!.objectives[0]!;
      const claimId = objective
        .semanticSupport!.fragments.filter((fragment) => fragment.status === 'supported')
        .flatMap((fragment) => fragment.authorityClaimIds)[0]!;
      const changed =
        corruption === 'missing'
          ? harness.db.prepare('DELETE FROM truth_authority_claims WHERE id = ?').run(claimId)
          : harness.db
              .prepare('UPDATE truth_authority_claims SET quote = ? WHERE id = ?')
              .run('Tampered but schema-valid quote.', claimId);
      expect(changed.changes).toBe(1);

      let thrown: unknown;
      try {
        await harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `brief-${corruption}-exact-claim`),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as Error).message).toMatch(/semantic|authority|claim|source/iu);
      expect(harness.provider.lessonContentCalls).toBe(0);
      expect(harness.provider.practiceContentCalls).toBe(0);
      const operation = harness.repos.operations.getByIdempotencyKey(
        'ws_1',
        `teaching-brief:${harness.learningUnitId}:brief-${corruption}-exact-claim`,
      )!;
      expect(
        harness.db
          .prepare(
            `SELECT COUNT(DISTINCT calls.id) AS logicalCalls,
                    COUNT(attempts.id) AS attempts
             FROM model_logical_calls calls
             LEFT JOIN model_call_attempts attempts ON attempts.logical_call_id = calls.id
             WHERE calls.operation_id = ?`,
          )
          .get(operation.id),
      ).toEqual({ logicalCalls: 0, attempts: 0 });
    });
  }

  it('rejects corrupt Curriculum semantic support at the Lesson provider boundary without a model call', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const commandId = 'brief-corrupt-objective-semantic-support';
    const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
    const planItem = harness.repos.studyPlans
      .get(harness.planId)!
      .items.find((item) => item.id === route.agendaItem.linkedPlanItemId)!;
    const objective = curriculum.nodes
      .find((node) => node.id === harness.learningUnitId)!
      .learningUnit!.objectives.find((candidate) => planItem.objectiveIds.includes(candidate.id))!;

    // Test-only persistence corruption after route activation: the exact source
    // authority remains untouched, but its accepted semantic artifact is now stale.
    objective.description = `${objective.description} Corrupted after route activation.`;
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(curriculum), curriculum.id);

    let thrown: unknown;
    try {
      await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, commandId),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: {
        kind: 'objective_authority_semantic_support_invalid',
        boundary: 'lesson_provider',
        diagnosticCodes: expect.arrayContaining(['semantic_proposition_mismatch']),
      },
    });
    expect(harness.provider.lessonContentCalls).toBe(0);
    expect(harness.provider.practiceContentCalls).toBe(0);

    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      `teaching-brief:${harness.learningUnitId}:${commandId}`,
    )!;
    expect(operation.status).toBe('failed');
    expect(
      harness.db
        .prepare(
          `SELECT COUNT(DISTINCT calls.id) AS logicalCalls,
                  COUNT(attempts.id) AS attempts
           FROM model_logical_calls calls
           LEFT JOIN model_call_attempts attempts ON attempts.logical_call_id = calls.id
           WHERE calls.operation_id = ?`,
        )
        .get(operation.id),
    ).toEqual({ logicalCalls: 0, attempts: 0 });
    expect(
      harness.db
        .prepare(
          'SELECT COUNT(*) AS checkpoints FROM accepted_lesson_checkpoints WHERE study_session_id = ?',
        )
        .get(route.session.id),
    ).toEqual({ checkpoints: 0 });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      0,
    );
  });

  it('rejects divergent semantic and Formal source envelopes before either provider phase', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const commandId = 'brief-divergent-semantic-formal-envelope';
    const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
    const planItem = harness.repos.studyPlans
      .get(harness.planId)!
      .items.find((item) => item.id === route.agendaItem.linkedPlanItemId)!;
    const objective = curriculum.nodes
      .find((node) => node.id === harness.learningUnitId)!
      .learningUnit!.objectives.find((candidate) => planItem.objectiveIds.includes(candidate.id))!;

    // Test-only persisted corruption: the semantic artifact still binds the
    // original exact objective envelope, while Formal evidence points elsewhere.
    objective.formalEvidenceSourceBlockIds = ['blk_formal_envelope_mismatch'];
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(curriculum), curriculum.id);

    expect(() =>
      harness.services.teachingBriefPreparation.getCurrent(
        preparationRequest(harness, route, 'brief-read-after-semantic-support-staleness'),
      ),
    ).toThrow('Curriculum objective authority is not semantically supported');

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, commandId),
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: {
        kind: 'objective_authority_semantic_support_invalid',
        boundary: 'lesson_provider',
        diagnosticCodes: expect.arrayContaining(['semantic_formal_authority_envelope_mismatch']),
      },
    });
    expect(harness.provider.lessonContentCalls).toBe(0);
    expect(harness.provider.practiceContentCalls).toBe(0);

    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      `teaching-brief:${harness.learningUnitId}:${commandId}`,
    )!;
    expect(operation.status).toBe('failed');
    expect(
      harness.db
        .prepare(
          `SELECT COUNT(DISTINCT calls.id) AS logicalCalls,
                  COUNT(attempts.id) AS attempts
           FROM model_logical_calls calls
           LEFT JOIN model_call_attempts attempts ON attempts.logical_call_id = calls.id
           WHERE calls.operation_id = ?`,
        )
        .get(operation.id),
    ).toEqual({ logicalCalls: 0, attempts: 0 });
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 0 });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
  });

  it('rejects stale semantic support before reusing an immutable Teaching Brief', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const first = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-before-semantic-support-staleness'),
    );
    const briefBytes = JSON.stringify(first.brief);
    const commandId = 'brief-reuse-after-semantic-support-staleness';
    const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
    const objective = curriculum.nodes.find((node) => node.id === harness.learningUnitId)!
      .learningUnit!.objectives[0]!;
    objective.description = `${objective.description} Changed after the immutable Brief was accepted.`;
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(curriculum), curriculum.id);

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, commandId),
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: {
        kind: 'objective_authority_semantic_support_invalid',
        boundary: 'lesson_provider',
        diagnosticCodes: expect.arrayContaining(['semantic_proposition_mismatch']),
      },
    });

    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      1,
    );
    expect(
      JSON.stringify(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)[0]),
    ).toBe(briefBytes);
    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      `teaching-brief:${harness.learningUnitId}:${commandId}`,
    )!;
    expect(operation.status).toBe('failed');
    expect(
      harness.db
        .prepare(
          `SELECT COUNT(DISTINCT calls.id) AS logicalCalls,
                  COUNT(attempts.id) AS attempts
           FROM model_logical_calls calls
           LEFT JOIN model_call_attempts attempts ON attempts.logical_call_id = calls.id
           WHERE calls.operation_id = ?`,
        )
        .get(operation.id),
    ).toEqual({ logicalCalls: 0, attempts: 0 });
  });

  it('rejects stale semantic support before retrying Practice from an accepted Lesson', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.failPracticeContentOnce = true;

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-practice-failure-before-support-staleness'),
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderError });
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    const checkpointRow = harness.db
      .prepare('SELECT id FROM accepted_lesson_checkpoints WHERE study_session_id = ?')
      .get(route.session.id) as { id: string };
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(checkpointRow.id)!;
    const checkpointBytes = JSON.stringify(checkpoint);
    expect(checkpoint).toBeDefined();
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);

    const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
    const objective = curriculum.nodes.find((node) => node.id === harness.learningUnitId)!
      .learningUnit!.objectives[0]!;
    objective.description = `${objective.description} Changed after Lesson acceptance.`;
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(curriculum), curriculum.id);
    expect(() =>
      harness.services.teachingBriefPreparation.getAcceptedLessonPreview(
        preparationRequest(harness, route, 'lesson-preview-after-support-staleness'),
      ),
    ).toThrow('Curriculum objective authority is not semantically supported');
    const commandId = 'brief-practice-retry-after-support-staleness';
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, commandId),
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: {
        kind: 'objective_authority_semantic_support_invalid',
        boundary: 'lesson_provider',
        diagnosticCodes: expect.arrayContaining(['semantic_proposition_mismatch']),
      },
    });

    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpoint.id))).toBe(
      checkpointBytes,
    );
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      `teaching-brief:${harness.learningUnitId}:${commandId}`,
    )!;
    expect(operation.status).toBe('failed');
    expect(
      harness.db
        .prepare(
          `SELECT COUNT(DISTINCT calls.id) AS logicalCalls,
                  COUNT(attempts.id) AS attempts
           FROM model_logical_calls calls
           LEFT JOIN model_call_attempts attempts ON attempts.logical_call_id = calls.id
           WHERE calls.operation_id = ?`,
        )
        .get(operation.id),
    ).toEqual({ logicalCalls: 0, attempts: 0 });
  });

  it('fences stale semantic support after Lesson generation before checkpoint persistence', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.onLessonContentGenerated = () => {
      staleCurrentCurriculumSemanticSupport(harness, 'Changed after Lesson generation.');
    };

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-support-stale-after-lesson-generation'),
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: {
        kind: 'objective_authority_semantic_support_invalid',
        boundary: 'lesson_provider',
        diagnosticCodes: expect.arrayContaining(['semantic_proposition_mismatch']),
      },
    });

    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(0);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 0 });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
  });

  it('preserves the accepted Lesson while fencing support that stales before Practice', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const originalCreate = harness.repos.acceptedLessonCheckpoints.create;
    let acceptedLessonId: string | null = null;
    harness.repos.acceptedLessonCheckpoints.create = (candidate) => {
      const accepted = originalCreate(candidate);
      acceptedLessonId = accepted.id;
      staleCurrentCurriculumSemanticSupport(harness, 'Changed after Lesson acceptance.');
      return accepted;
    };

    try {
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, 'brief-support-stale-before-practice'),
        ),
      ).rejects.toMatchObject({
        code: ApiErrorCode.ValidationError,
        details: {
          kind: 'objective_authority_semantic_support_invalid',
          boundary: 'lesson_provider',
          diagnosticCodes: expect.arrayContaining(['semantic_proposition_mismatch']),
        },
      });
    } finally {
      harness.repos.acceptedLessonCheckpoints.create = originalCreate;
    }

    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(0);
    expect(acceptedLessonId).not.toBeNull();
    expect(harness.repos.acceptedLessonCheckpoints.get(acceptedLessonId!)).toBeDefined();
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 1 });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
  });

  it('preserves the accepted Lesson while fencing stale support after Practice generation', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.onPracticeContentGenerated = () => {
      staleCurrentCurriculumSemanticSupport(harness, 'Changed after Practice generation.');
    };

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-support-stale-after-practice-generation'),
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: {
        kind: 'objective_authority_semantic_support_invalid',
        boundary: 'lesson_provider',
        diagnosticCodes: expect.arrayContaining(['semantic_proposition_mismatch']),
      },
    });

    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 1 });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
  });

  it('isolates the local Teaching Skeleton from Lesson provider input mutation', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.mutateLessonInputAfterGeneration = true;

    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-mutating-lesson-provider'),
    );

    expect(JSON.stringify(harness.provider.lastLessonContentInput)).toContain(
      LESSON_INPUT_MUTATION_SENTINEL,
    );
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
      prepared.brief.composition!.acceptedLessonCheckpointId,
    )!;
    const checkpointLessonSkeleton: LessonSlotContentGenerationInput['skeleton'] = {
      id: checkpoint.skeleton.id,
      schemaVersion: checkpoint.skeleton.schemaVersion,
      plannerVersion: checkpoint.skeleton.plannerVersion,
      fingerprint: checkpoint.skeleton.fingerprint,
      learningUnitTitle: checkpoint.skeleton.learningUnitTitle,
      objectives: checkpoint.skeleton.objectives,
      targetMinutes: checkpoint.skeleton.targetMinutes,
      acceptableActiveMinutes: checkpoint.skeleton.acceptableActiveMinutes,
      lessonSlots: checkpoint.skeleton.lessonSlots,
      synthesisActivityBudget: checkpoint.skeleton.synthesisActivityBudget,
      protectedActivityBudget: checkpoint.skeleton.protectedActivityBudget,
      plannedActivityBudget: checkpoint.skeleton.plannedActivityBudget,
    };
    expect(JSON.stringify(checkpointLessonSkeleton)).toBe(
      harness.provider.lessonSkeletonBytesBeforeMutation,
    );
    expect(JSON.stringify(checkpoint.lessonContent)).toBe(
      harness.provider.lessonContentBytesBeforeMutation,
    );
    expect(checkpoint.skeleton.fingerprint).toBe(
      harness.provider.lastLessonContentInput?.skeleton.fingerprint,
    );
    expect(JSON.stringify(checkpoint)).not.toContain(LESSON_INPUT_MUTATION_SENTINEL);
    const lessonContentBySlotId = new Map(
      checkpoint.lessonContent.map((content) => [content.slotId, content]),
    );
    expect(prepared.brief.segments.map((segment) => segment.explanation)).toEqual(
      checkpoint.skeleton.lessonSlots.map(
        (slot) => lessonContentBySlotId.get(slot.slotId)!.explanation,
      ),
    );
    expect(JSON.stringify(prepared.brief)).not.toContain(LESSON_INPUT_MUTATION_SENTINEL);
  });

  it('isolates the accepted Lesson checkpoint from Practice provider input mutation', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.mutatePracticeInputAfterGeneration = true;

    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-mutating-practice-provider'),
    );

    expect(JSON.stringify(harness.provider.lastPracticeContentInput)).toContain(
      PRACTICE_INPUT_MUTATION_SENTINEL,
    );
    const checkpointId = prepared.brief.composition!.acceptedLessonCheckpointId;
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(checkpointId)!;
    expect(JSON.stringify(checkpoint.skeleton)).toBe(
      harness.provider.practiceSkeletonBytesBeforeMutation,
    );
    expect(JSON.stringify(checkpoint.lessonContent)).toBe(
      harness.provider.practiceAcceptedLessonBytesBeforeMutation,
    );
    expect(checkpoint.skeleton.fingerprint).toBe(
      harness.provider.lastPracticeContentInput?.skeleton.fingerprint,
    );
    expect(JSON.stringify(checkpoint)).not.toContain(PRACTICE_INPUT_MUTATION_SENTINEL);
    expect(prepared.brief.composition?.acceptedLessonCheckpointId).toBe(checkpoint.id);
    const lessonContentBySlotId = new Map(
      checkpoint.lessonContent.map((content) => [content.slotId, content]),
    );
    expect(prepared.brief.segments.map((segment) => segment.explanation)).toEqual(
      checkpoint.skeleton.lessonSlots.map(
        (slot) => lessonContentBySlotId.get(slot.slotId)!.explanation,
      ),
    );
    expect(JSON.stringify(prepared.brief)).not.toContain(PRACTICE_INPUT_MUTATION_SENTINEL);
  });

  it('scopes both provider phases and the final Brief to the exact accepted Plan objective subset', async () => {
    const harness = await createHarness();
    const { routeObjectiveIds, routeSecond, baseObjective, deferred } =
      addSameUnitRouteAndDeferredObjectives(harness);
    const route = startTeachingRoute(harness);

    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-route-objective-scope'),
    );

    expect(
      harness.provider.lastLessonContentInput?.skeleton.objectives.map((objective) => ({
        objectiveRef: objective.objectiveRef,
        title: objective.title,
      })),
    ).toEqual([{ objectiveRef: 'O1', title: baseObjective.title }]);
    expect(harness.provider.lastLessonContentInput?.skeleton).not.toHaveProperty('practicePlan');
    expect(
      harness.provider.lastPracticeContentInput?.skeleton.objectives.map(
        (objective) => objective.title,
      ),
    ).toEqual([baseObjective.title]);
    expect(JSON.stringify(harness.provider.lastLessonContentInput)).not.toContain(routeSecond.id);
    expect(JSON.stringify(harness.provider.lastLessonContentInput)).not.toContain(
      routeSecond.title,
    );
    expect(JSON.stringify(harness.provider.lastLessonContentInput)).not.toContain(deferred.id);
    expect(JSON.stringify(harness.provider.lastLessonContentInput)).not.toContain(deferred.title);
    expect(JSON.stringify(harness.provider.lastPracticeContentInput)).not.toContain(deferred.id);
    expect(JSON.stringify(harness.provider.lastPracticeContentInput)).not.toContain(deferred.title);
    expect(prepared.brief.objective.objectives.map((objective) => objective.id)).toEqual(
      routeObjectiveIds,
    );
    expect(prepared.brief.segments.flatMap((segment) => segment.objectiveIds)).toEqual(
      expect.arrayContaining(routeObjectiveIds),
    );
    expect(
      prepared.brief.segments
        .flatMap((segment) => segment.objectiveIds)
        .every((objectiveId) => routeObjectiveIds.includes(objectiveId)),
    ).toBe(true);
    expect(
      prepared.brief.practice?.items.every((item) => routeObjectiveIds.includes(item.objectiveId)),
    ).toBe(true);
    expect(JSON.stringify(prepared.brief)).not.toContain(deferred.id);
    expect(JSON.stringify(prepared.brief)).not.toContain(deferred.title);
  });

  it('preserves accepted Plan objective order before any Lesson provider response', async () => {
    const harness = await createHarness();
    const { routeSecond, baseObjective } = addSameUnitRouteAndDeferredObjectives(harness);
    setTeachingPlanObjectiveIds(harness, [routeSecond.id, baseObjective.id]);
    const route = startTeachingRoute(harness);
    harness.provider.failLessonContent = true;

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-route-objective-order'),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    expect(
      harness.provider.lastLessonContentInput?.skeleton.objectives.map((objective) => ({
        objectiveRef: objective.objectiveRef,
        title: objective.title,
      })),
    ).toEqual([
      { objectiveRef: 'O1', title: routeSecond.title },
      { objectiveRef: 'O2', title: baseObjective.title },
    ]);
    expect(harness.provider.practiceContentCalls).toBe(0);
  });

  it.each([
    ['empty', () => []],
    ['duplicate', (objectiveId: string) => [objectiveId, objectiveId]],
    ['unknown', () => ['obj_missing_from_learning_unit']],
  ] as const)(
    'rejects an %s accepted Plan objective scope before either provider phase',
    async (_label, objectiveIds) => {
      const harness = await createHarness();
      const objectiveId = harness.repos.curricula
        .get(harness.curriculumId)!
        .nodes.find((node) => node.id === harness.learningUnitId)!.learningUnit!.objectives[0]!.id;
      setTeachingPlanObjectiveIds(harness, objectiveIds(objectiveId));
      const route = startTeachingRoute(harness);

      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `brief-invalid-${_label}-objective-scope`),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(harness.provider.lessonContentCalls).toBe(0);
      expect(harness.provider.practiceContentCalls).toBe(0);
    },
  );

  it('preserves the accepted Lesson checkpoint when Lesson usage reaches the canonical operation cap', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.lessonUsageMicrounits = 100;
    harness.repos.telemetry.upsertCostPolicy({
      id: 'cost_policy_teaching_cap',
      policyKey: 'cost-policy-teaching-cap',
      workspaceId: 'ws_1',
      scopeType: 'operation',
      scopeKey: 'prepare_teaching_brief',
      limitMicrounits: 100,
      currency: 'USD',
      onExceed: 'refuse',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const input = preparationRequest(harness, route, 'brief-lesson-reaches-cost-cap');

    await expect(harness.services.teachingBriefPreparation.prepare(input)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(0);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 1 });
    const lessonLogicalCallId = `teaching-brief:${harness.learningUnitId}:${input.commandId}:lesson`;
    const practiceLogicalCallId = `teaching-brief:${harness.learningUnitId}:${input.commandId}:practice`;
    expect(harness.repos.telemetry.getLogicalCall(lessonLogicalCallId)).toMatchObject({
      operationType: 'prepare_teaching_brief',
      schemaFingerprint: 'lesson-slot-content-proposal-v1',
      status: 'completed',
    });
    expect(harness.repos.telemetry.getLogicalCall(practiceLogicalCallId)).toBeUndefined();
    expect(
      harness.repos.telemetry.usageSummaryForScope('ws_1', {
        scopeType: 'operation',
        scopeKey: 'prepare_teaching_brief',
      }),
    ).toMatchObject({ estimatedCostMicrounits: 100, physicalAttempts: 1 });
  });

  it('rejects a non-executable LearningUnit and a stale route before provider work', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const curriculum = harness.repos.curricula.get(harness.curriculumId)!;
    const nonUnit = curriculum.nodes.find((node) => !node.learningUnit)!;
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-non-unit', {
          learningUnitId: nonUnit.id,
        }),
      ),
    ).rejects.toThrow('exact executable Session Agenda teaching item');
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-stale-route', {
          expectedExecutionSourceManifestFingerprint: 'stale-manifest',
        }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-missing-session', {
          studySessionId: 'study_session_missing',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      message: 'Teaching Brief preparation requires the exact active Session and Agenda route.',
    });
    expect(
      harness.repos.operations.getByIdempotencyKey(
        'ws_1',
        `teaching-brief:${harness.learningUnitId}:brief-missing-session`,
      ),
    ).toBeUndefined();
    harness.repos.workspaces.insert(
      makeWorkspace({ id: 'ws_teaching_other', name: 'Other teaching Course' }),
    );
    harness.db
      .prepare(
        `INSERT INTO study_sessions
           (id, workspace_id, contract_id, curriculum_id, plan_id, agenda_id,
            manifest_fingerprint, version, status, route_state, current_agenda_item_id,
            route_stack, transcript_watermark, created_at, updated_at)
         SELECT ?, ?, contract_id, curriculum_id, plan_id, agenda_id,
            manifest_fingerprint, version, status, route_state, current_agenda_item_id,
            route_stack, transcript_watermark, created_at, updated_at
         FROM study_sessions WHERE id = ?`,
      )
      .run('study_session_teaching_other_workspace', 'ws_teaching_other', route.session.id);
    const crossWorkspaceSession = harness.repos.studySessions.get(
      'study_session_teaching_other_workspace',
    )!;
    const crossWorkspaceStateBefore = harness.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM agent_operations) AS operations,
           (SELECT COUNT(*) FROM model_logical_calls) AS logicalCalls,
           (SELECT COUNT(*) FROM model_call_attempts) AS attempts,
           (SELECT COUNT(*) FROM accepted_lesson_checkpoints) AS lessonCheckpoints,
           (SELECT COUNT(*) FROM teaching_briefs) AS teachingBriefs,
           (SELECT COUNT(*) FROM lesson_execution_states) AS lessonStates`,
      )
      .get();
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-cross-workspace-session', {
          studySessionId: crossWorkspaceSession.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      message: 'Teaching Brief preparation requires the exact active Session and Agenda route.',
    });
    expect(
      harness.repos.operations.getByIdempotencyKey(
        'ws_1',
        `teaching-brief:${harness.learningUnitId}:brief-cross-workspace-session`,
      ),
    ).toBeUndefined();
    expect(harness.repos.studySessions.get(crossWorkspaceSession.id)).toEqual(
      crossWorkspaceSession,
    );
    expect(
      harness.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM agent_operations) AS operations,
             (SELECT COUNT(*) FROM model_logical_calls) AS logicalCalls,
             (SELECT COUNT(*) FROM model_call_attempts) AS attempts,
             (SELECT COUNT(*) FROM accepted_lesson_checkpoints) AS lessonCheckpoints,
             (SELECT COUNT(*) FROM teaching_briefs) AS teachingBriefs,
             (SELECT COUNT(*) FROM lesson_execution_states) AS lessonStates`,
        )
        .get(),
    ).toEqual(crossWorkspaceStateBefore);
    expect(harness.provider.lessonContentCalls).toBe(0);
    expect(harness.provider.practiceContentCalls).toBe(0);
  });

  it('rejects a route when a newer visual derivation identity appears after acceptance', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
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
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-newer-visual-derivation'),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(harness.provider.lessonContentCalls).toBe(0);
    expect(harness.provider.practiceContentCalls).toBe(0);
  });

  it('preserves the current source fingerprint when persisting a modern chunked block', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const input = preparationRequest(harness, route, 'brief-modern-chunked-source');

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
    expect(harness.provider.lessonContentCalls).toBe(0);
    expect(harness.provider.practiceContentCalls).toBe(0);
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
    harness.provider.failLessonContent = true;

    const retryable = await harness.services.lessonExecution.ensure('ws_1', started.session.id, {
      command: command('lesson-provider-failure'),
      expectedSessionVersion: started.session.version,
      expectedAgendaVersion: agenda.version,
      expectedAgendaItemId: started.session.currentAgendaItemId,
    });

    expect(retryable.status).toBe('retry_available');
    expect(retryable.allowedActions).toEqual(['retry_preparation']);
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(0);
    const checkpointCount = harness.db
      .prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints')
      .get() as { count: number };
    expect(checkpointCount.count).toBe(0);
  });

  it('fails pre-provider planning validation without inventing a Lesson checkpoint or preview', async () => {
    const harness = await createHarness();
    setTeachingPlanObjectiveIds(harness, []);
    const route = startTeachingRoute(harness);

    await expect(
      harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        command: command('lesson-pre-provider-planning-validation'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(harness.provider.lessonContentCalls).toBe(0);
    expect(harness.provider.practiceContentCalls).toBe(0);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 0 });
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id),
    ).toMatchObject({
      acceptedLessonCheckpointId: null,
      preparationStatus: 'retryable_failure',
      preparationOperationId: null,
    });
    const retryable = harness.services.lessonExecution.get('ws_1', route.session.id);
    expect(retryable).toMatchObject({
      status: 'retry_available',
      lesson: null,
      allowedActions: ['retry_preparation'],
    });
    expect(retryable).not.toHaveProperty('practice');
    expect(
      harness.db
        .prepare('SELECT status FROM agent_operations WHERE command_id = ?')
        .get('lesson-pre-provider-planning-validation'),
    ).toEqual({ status: 'failed' });
  });

  it('preserves an accepted Lesson preview when independent Practice evaluation rejects content', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.failPracticeIndependentEvaluationOnce = true;

    const retryable = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-practice-independent-evaluation-failure'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });

    expect(retryable.status).toBe('practice_retry_available');
    expect(retryable.lesson).not.toBeNull();
    expect(retryable.practice).toBeNull();
    expect(retryable.currentInformalCheck).toBeNull();
    expect(retryable.allowedActions).toEqual(['retry_preparation']);
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    const failedState = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    expect(failedState).toMatchObject({
      preparationStatus: 'retryable_failure',
      preparationOperationId: null,
    });
    expect(failedState.acceptedLessonCheckpointId).not.toBeNull();
    expect(
      harness.repos.acceptedLessonCheckpoints.get(failedState.acceptedLessonCheckpointId!),
    ).toMatchObject({ lessonEvaluation: { status: 'pass' } });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      0,
    );
    expect(
      harness.db
        .prepare('SELECT status FROM agent_operations WHERE command_id = ?')
        .get('lesson-practice-independent-evaluation-failure'),
    ).toEqual({ status: 'completed' });
  });

  it('recovers an expired exact-route preparation lease as a retry instead of waiting forever', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const failureGate = deferred<void>();
    harness.provider.failLessonContent = true;
    harness.provider.lessonContentFailureGate = failureGate.promise;

    const pending = harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-expired-preparation-lease'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(harness.provider.lessonContentCalls).toBe(1);

    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      'lesson-expired-preparation-lease',
    )!;
    harness.db
      .prepare('UPDATE agent_operations SET lease_expires_at = ? WHERE id = ?')
      .run('2025-12-31T23:59:59.000Z', operation.id);

    const retryable = harness.services.lessonExecution.get('ws_1', route.session.id);
    expect(retryable.status).toBe('retry_available');
    expect(retryable.lesson).toBeNull();
    expect(retryable.allowedActions).toEqual(['retry_preparation']);
    expect(harness.repos.operations.get(operation.id)).toMatchObject({
      status: 'interrupted',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id),
    ).toMatchObject({
      acceptedLessonCheckpointId: null,
      preparationStatus: 'retryable_failure',
      preparationOperationId: null,
    });

    failureGate.resolve(undefined);
    await expect(pending).rejects.toBeDefined();
  });

  it('discovers and binds an accepted Lesson checkpoint after process-restart interruption', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const practiceStarted = deferred<void>();
    const practiceGate = deferred<void>();
    const abort = new AbortController();
    harness.provider.onPracticeContentStarted = () => practiceStarted.resolve(undefined);
    harness.provider.practiceContentGate = practiceGate.promise;

    const pending = harness.services.lessonExecution.ensure(
      'ws_1',
      route.session.id,
      {
        command: command('lesson-restart-after-checkpoint'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      },
      { signal: abort.signal },
    );
    await practiceStarted.promise;

    const checkpointId = (
      harness.db
        .prepare('SELECT id FROM accepted_lesson_checkpoints WHERE study_session_id = ?')
        .get(route.session.id) as { id: string }
    ).id;
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(checkpointId)!;
    const checkpointBytes = JSON.stringify(checkpoint);
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id),
    ).toMatchObject({
      acceptedLessonCheckpointId: null,
      preparationStatus: 'preparing',
    });

    expect(harness.repos.operations.recoverRunningAfterRestart(T0)).toBeGreaterThanOrEqual(2);
    const restartedServices = createServices({
      repos: harness.repos,
      provider: harness.provider,
      clock,
    });
    const recovered = restartedServices.lessonExecution.get('ws_1', route.session.id);

    expect(recovered.status).toBe('practice_retry_available');
    expect(recovered.lesson).not.toBeNull();
    expect(recovered.practice).toBeNull();
    expect(recovered.allowedActions).toEqual(['retry_preparation']);
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id),
    ).toMatchObject({
      acceptedLessonCheckpointId: checkpoint.id,
      preparationStatus: 'retryable_failure',
      preparationOperationId: null,
    });
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpoint.id))).toBe(
      checkpointBytes,
    );

    abort.abort();
    practiceGate.resolve(undefined);
    await expect(pending).rejects.toBeDefined();
  });

  it('keeps the outer Lesson command lease beyond the later child composition lease', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const practiceStarted = deferred<void>();
    const practiceGate = deferred<void>();
    const abort = new AbortController();
    const commandId = 'lesson-parent-child-lease-boundary';
    harness.provider.onPracticeContentStarted = () => practiceStarted.resolve(undefined);
    harness.provider.practiceContentGate = practiceGate.promise;

    const pending = harness.services.lessonExecution.ensure(
      'ws_1',
      route.session.id,
      {
        command: command(commandId),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      },
      { signal: abort.signal },
    );
    await practiceStarted.promise;

    const outer = harness.repos.operations.getByIdempotencyKey('ws_1', commandId)!;
    const child = harness.repos.operations
      .listForWorkspace('ws_1', 'prepare_teaching_brief')
      .find((operation) => operation.commandId.endsWith(`:${outer.id}`))!;
    expect(outer).toMatchObject({ status: 'running' });
    expect(child).toMatchObject({ status: 'running' });
    expect(operationStudySessionId(harness.db, outer.id)).toBe(route.session.id);
    expect(operationStudySessionId(harness.db, child.id)).toBe(route.session.id);
    expect(Date.parse(outer.leaseExpiresAt!) - Date.parse(child.leaseExpiresAt!)).toBe(
      COMPOSITIONAL_PREPARATION_LEASE_MS,
    );

    abort.abort();
    practiceGate.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('preserves the accepted Lesson when cancellation arrives during Practice generation', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const practiceStarted = deferred<void>();
    const practiceGate = deferred<void>();
    const abort = new AbortController();
    harness.provider.onPracticeContentStarted = () => practiceStarted.resolve(undefined);
    harness.provider.practiceContentGate = practiceGate.promise;

    const pending = harness.services.lessonExecution.ensure(
      'ws_1',
      route.session.id,
      {
        command: command('lesson-cancelled-during-practice'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      },
      { signal: abort.signal },
    );
    await practiceStarted.promise;
    const checkpointRow = harness.db
      .prepare('SELECT id FROM accepted_lesson_checkpoints WHERE study_session_id = ?')
      .get(route.session.id) as { id: string };
    const checkpointBytes = JSON.stringify(
      harness.repos.acceptedLessonCheckpoints.get(checkpointRow.id),
    );

    abort.abort();
    practiceGate.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });

    const retryable = harness.services.lessonExecution.get('ws_1', route.session.id);
    expect(retryable.status).toBe('practice_retry_available');
    expect(retryable.lesson).not.toBeNull();
    expect(retryable.practice).toBeNull();
    expect(retryable.allowedActions).toEqual(['retry_preparation']);
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpointRow.id))).toBe(
      checkpointBytes,
    );
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      0,
    );
  });

  it('fences delayed Practice after an Agenda switch without changing its accepted Lesson', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const practiceStarted = deferred<void>();
    const practiceGate = deferred<void>();
    harness.provider.onPracticeContentStarted = () => practiceStarted.resolve(undefined);
    harness.provider.practiceContentGate = practiceGate.promise;

    const pending = harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-practice-after-route-switch'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    await practiceStarted.promise;
    const checkpointRow = harness.db
      .prepare('SELECT id FROM accepted_lesson_checkpoints WHERE study_session_id = ?')
      .get(route.session.id) as { id: string };
    const checkpointBytes = JSON.stringify(
      harness.repos.acceptedLessonCheckpoints.get(checkpointRow.id),
    );

    const successor = switchToSuccessorTeachingRoute(harness, route);
    practiceGate.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      0,
    );
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpointRow.id))).toBe(
      checkpointBytes,
    );
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id),
    ).toMatchObject({
      preparationStatus: 'retryable_failure',
      preparationOperationId: null,
    });
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, successor.agendaItem.id),
    ).toBeUndefined();
    expect(harness.repos.studySessions.get(route.session.id)).toMatchObject({
      currentAgendaItemId: successor.agendaItem.id,
      version: successor.session.version,
    });
    expect(
      harness.db
        .prepare('SELECT status FROM agent_operations WHERE command_id = ?')
        .get('lesson-practice-after-route-switch'),
    ).toEqual({ status: 'failed' });
  });

  it('fails a stale preparation command without updating or returning the successor Agenda route', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const failureGate = deferred<void>();
    harness.provider.failLessonContent = true;
    harness.provider.lessonContentFailureGate = failureGate.promise;

    const pending = harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-provider-failure-after-route-switch'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(harness.provider.lessonContentCalls).toBe(1);

    const successor = switchToSuccessorTeachingRoute(harness, route);
    failureGate.resolve(undefined);

    await expect(pending).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, successor.agendaItem.id),
    ).toBeUndefined();
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id),
    ).toMatchObject({
      preparationStatus: 'retryable_failure',
      preparationOperationId: null,
    });
    expect(harness.repos.studySessions.get(route.session.id)).toMatchObject({
      currentAgendaItemId: successor.agendaItem.id,
      version: successor.session.version,
    });
    expect(
      harness.db
        .prepare('SELECT status FROM agent_operations WHERE command_id = ?')
        .get('lesson-provider-failure-after-route-switch'),
    ).toEqual({ status: 'failed' });
  });

  it('fails command cleanup even when the owning StudySession is deleted during provider failure', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const failureGate = deferred<void>();
    harness.provider.failLessonContent = true;
    harness.provider.lessonContentFailureGate = failureGate.promise;

    const pending = harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-provider-failure-after-session-delete'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(harness.provider.lessonContentCalls).toBe(1);

    harness.db.prepare('DELETE FROM study_sessions WHERE id = ?').run(route.session.id);
    failureGate.resolve(undefined);

    await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      harness.db
        .prepare('SELECT status FROM agent_operations WHERE command_id = ?')
        .get('lesson-provider-failure-after-session-delete'),
    ).toEqual({ status: 'failed' });
    expect(
      harness.db
        .prepare('SELECT COUNT(*) AS count FROM lesson_execution_states WHERE session_id = ?')
        .get(route.session.id),
    ).toEqual({ count: 0 });
  });

  it('preserves one accepted Lesson checkpoint across Practice failure and bounded repair', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.failPracticeContentOnce = true;

    const retryable = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-practice-provider-failure'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });

    expect(retryable.status).toBe('practice_retry_available');
    expect(retryable.allowedActions).toEqual(['retry_preparation']);
    expect(retryable.lesson).not.toBeNull();
    expect(retryable.practice).toBeNull();
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);

    const failedState = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    expect(failedState.acceptedLessonCheckpointId).not.toBeNull();
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
      failedState.acceptedLessonCheckpointId!,
    )!;
    const acceptedLessonBytes = JSON.stringify(checkpoint.lessonContent);
    const projectedLessonBytes = JSON.stringify(retryable.lesson);
    expect(harness.provider.acceptedLessonBytesSeenByPractice).toEqual([acceptedLessonBytes]);
    const checkpointCountBeforeRetry = harness.db
      .prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints')
      .get() as { count: number };
    expect(checkpointCountBeforeRetry.count).toBe(1);

    harness.provider.simulateOneCandidateRepair = true;
    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-practice-provider-retry'),
      expectedSessionVersion: retryable.session.version,
      expectedAgendaVersion: retryable.agenda!.version,
      expectedAgendaItemId: route.agendaItem.id,
    });

    expect(ready.status).toBe('ready');
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(2);
    expect(harness.provider.acceptedLessonBytesSeenByPractice).toEqual([
      acceptedLessonBytes,
      acceptedLessonBytes,
    ]);
    expect(JSON.stringify(ready.lesson)).toBe(projectedLessonBytes);
    const checkpointAfterRetry = harness.repos.acceptedLessonCheckpoints.get(checkpoint.id)!;
    expect(JSON.stringify(checkpointAfterRetry.lessonContent)).toBe(acceptedLessonBytes);
    const checkpointCountAfterRetry = harness.db
      .prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints')
      .get() as { count: number };
    expect(checkpointCountAfterRetry.count).toBe(1);
    const finalBrief = harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)[0]!;
    expect(finalBrief.composition?.acceptedLessonCheckpointId).toBe(checkpoint.id);
    expect(finalBrief.practice?.qualityEvaluation).toMatchObject({
      status: 'pass',
      boundedRepairAttempted: true,
    });
  });

  it('keeps final Lesson composition session-local when another Session finishes first', async () => {
    const harness = await createHarness();
    const routeA = startTeachingRoute(harness);
    harness.provider.failPracticeContentOnce = true;

    const retryableA = await harness.services.lessonExecution.ensure('ws_1', routeA.session.id, {
      command: command('lesson-session-a-practice-failure'),
      expectedSessionVersion: routeA.session.version,
      expectedAgendaVersion: routeA.agenda.version,
      expectedAgendaItemId: routeA.agendaItem.id,
    });
    expect(retryableA.status).toBe('practice_retry_available');
    const stateA = harness.repos.lessonExecution.getForSession(
      routeA.session.id,
      routeA.agendaItem.id,
    )!;
    const checkpointA = harness.repos.acceptedLessonCheckpoints.get(
      stateA.acceptedLessonCheckpointId!,
    )!;
    const lessonABytes = JSON.stringify(checkpointA.lessonContent);
    const projectedLessonABytes = JSON.stringify(retryableA.lesson);

    const sessionB = harness.repos.studySessions.create({
      ...routeA.session,
      id: 'study_session_parallel_b',
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    const readyB = await harness.services.lessonExecution.ensure('ws_1', sessionB.id, {
      command: command('lesson-session-b-success'),
      expectedSessionVersion: sessionB.version,
      expectedAgendaVersion: routeA.agenda.version,
      expectedAgendaItemId: routeA.agendaItem.id,
    });
    expect(readyB.status).toBe('ready');
    const briefB = harness.repos.teachingBriefs
      .listForUnit('ws_1', harness.learningUnitId)
      .find((brief) => brief.composition?.acceptedLessonCheckpointId !== checkpointA.id)!;
    const checkpointBId = briefB.composition!.acceptedLessonCheckpointId;
    expect(checkpointBId).not.toBe(checkpointA.id);
    expect(harness.repos.acceptedLessonCheckpoints.get(checkpointBId!)).toMatchObject({
      studySessionId: sessionB.id,
    });
    expect(
      harness.services.teachingBriefPreparation.getCurrent(
        preparationRequest(harness, routeA, 'lesson-session-a-current-before-retry'),
      ),
    ).toBeNull();

    const readyA = await harness.services.lessonExecution.ensure('ws_1', routeA.session.id, {
      command: command('lesson-session-a-practice-retry'),
      expectedSessionVersion: retryableA.session.version,
      expectedAgendaVersion: retryableA.agenda!.version,
      expectedAgendaItemId: routeA.agendaItem.id,
    });

    expect(readyA.status).toBe('ready');
    expect(JSON.stringify(readyA.lesson)).toBe(projectedLessonABytes);
    expect(harness.provider.lessonContentCalls).toBe(2);
    expect(harness.provider.practiceContentCalls).toBe(3);
    expect(
      JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpointA.id)!.lessonContent),
    ).toBe(lessonABytes);
    const briefs = harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId);
    expect(briefs).toHaveLength(2);
    expect(
      briefs.find((brief) => brief.composition?.acceptedLessonCheckpointId === checkpointA.id),
    ).toBeDefined();
    expect(
      briefs.find((brief) => brief.composition?.acceptedLessonCheckpointId === checkpointBId),
    ).toBeDefined();
  });

  it('does not reuse another Session final before the fresh route accepts its own Lesson', async () => {
    const harness = await createHarness();
    const routeB = startTeachingRoute(harness);
    const finalB = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, routeB, 'brief-session-b-first'),
    );
    expect(finalB.status).toBe('prepared');

    const sessionA = harness.repos.studySessions.create({
      ...routeB.session,
      id: 'study_session_fresh_a',
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    const routeA = { ...routeB, session: sessionA };

    expect(
      harness.services.teachingBriefPreparation.getCurrent(
        preparationRequest(harness, routeA, 'brief-session-a-current'),
      ),
    ).toBeNull();

    const finalA = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, routeA, 'brief-session-a-own-composition'),
    );
    expect(finalA.status).toBe('prepared');
    expect(finalA.brief.id).not.toBe(finalB.brief.id);
    expect(harness.provider.lessonContentCalls).toBe(2);
    expect(harness.provider.practiceContentCalls).toBe(2);
    expect(finalA.brief.composition?.acceptedLessonCheckpointId).not.toBe(
      finalB.brief.composition?.acceptedLessonCheckpointId,
    );
    expect(
      harness.repos.acceptedLessonCheckpoints.get(
        finalA.brief.composition!.acceptedLessonCheckpointId,
      ),
    ).toMatchObject({ studySessionId: sessionA.id });
  });

  it('persists only sanitized schema issue metadata for a failed Teaching Brief', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.failLessonContentWithSchemaDetails = true;

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-schema-observability'),
      ),
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
          schemaIssues: [{ path: 'slots.0.sourceRefs', code: 'invalid_type' }],
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
    const route = startTeachingRoute(harness);
    harness.provider.simulateOneCandidateRepair = true;
    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-bounded-candidate-repair'),
    );

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
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
  });

  it('records schema-repair callbacks in both independent evaluations and physical attempts', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.simulateLessonSchemaRepair = true;
    harness.provider.simulatePracticeSchemaRepair = true;

    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-bounded-schema-repairs'),
    );

    expect(prepared.brief.pedagogyEvaluation).toMatchObject({
      status: 'pass',
      boundedRepairAttempted: true,
    });
    expect(prepared.brief.practice?.qualityEvaluation).toMatchObject({
      status: 'pass',
      boundedRepairAttempted: true,
    });
    const lessonLogicalCallId = prepared.brief.composition!.lessonLogicalCallId!;
    const practiceLogicalCallId = prepared.brief.composition!.practiceLogicalCallId!;
    expect(harness.repos.telemetry.listAttempts(lessonLogicalCallId)).toHaveLength(2);
    expect(harness.repos.telemetry.listAttempts(practiceLogicalCallId)).toHaveLength(2);
    expect(harness.repos.telemetry.listAttempts(lessonLogicalCallId)[0]).toMatchObject({
      attemptKind: 'original',
      errorCode: 'SCHEMA_VALIDATION_FAILURE_REPAIR_REQUIRED',
    });
    expect(harness.repos.telemetry.listAttempts(practiceLogicalCallId)[0]).toMatchObject({
      attemptKind: 'original',
      errorCode: 'SCHEMA_VALIDATION_FAILURE_REPAIR_REQUIRED',
    });
  });

  it('does not reuse a split-version compositional Brief', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const firstInput = preparationRequest(harness, route, 'brief-current-split-versions');
    const first = await harness.services.teachingBriefPreparation.prepare(firstInput);
    const stale = structuredClone(first.brief);
    stale.composition!.practicePromptVersion = 'stale-practice-prompt';
    harness.db
      .prepare('UPDATE teaching_briefs SET payload = ? WHERE id = ?')
      .run(JSON.stringify(stale), first.brief.id);

    expect(harness.services.teachingBriefPreparation.getCurrent(firstInput)).toBeNull();

    // A pre-fence Brief would have carried a different composition fingerprint.
    // Move the synthetic legacy row to that historical key so the current
    // immutable successor can be stored beside it.
    harness.db
      .prepare('UPDATE teaching_briefs SET source_context_fingerprint = ? WHERE id = ?')
      .run('legacy-split-version-fingerprint', first.brief.id);
    const second = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-replace-split-versions'),
    );

    expect(second.status).toBe('prepared');
    expect(second.brief.id).not.toBe(first.brief.id);
    expect(second.brief.composition).toMatchObject({
      lessonPromptVersion: LESSON_CONTENT_PROMPT_VERSION,
      practicePromptVersion: PRACTICE_CONTENT_PROMPT_VERSION,
    });
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(2);
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
    const lessonCommand = harness.repos.operations.getByIdempotencyKey('ws_1', 'lesson-start')!;
    expect(operationStudySessionId(harness.db, lessonCommand.id)).toBe(session.id);
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
    expect(current.currentInformalCheck?.guidance).toContain('locally planned explain capability');
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
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
  });
});

function visualAssetId(harness: Harness): string {
  return harness.repos.materials.getAssets('mat_1')[0]!.id;
}
