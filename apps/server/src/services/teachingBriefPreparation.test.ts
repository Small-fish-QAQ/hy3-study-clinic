import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiErrorCode,
  fnv1a32,
  MixedInitiativeCommandRequestSchema,
  PracticeContentProposalPayloadSchema,
  TeachingBriefSchema,
  PRACTICE_ACCEPTANCE_POLICY_VERSION,
  PRACTICE_ANSWERABILITY_POLICY_VERSION,
  LESSON_CONTENT_REVIEW_POLICY_VERSION,
  PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION,
  PRACTICE_REPAIR_GENERATION_VERSION,
  type DesiredDepth,
  type LearningContractDraftFields,
  type LessonSlotContentProposalPayload,
  type LessonExecutionCommandRequest,
  type TeachingBriefInformalCheck,
  type TeachingContentReview,
  type LessonPedagogyEvaluation,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { AppError } from '../errors.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import {
  createFakeLessonFixture,
  createFakeLessonOrdinaryCheck,
  createFakeLessonChangedTransfer,
} from '../llm/fakeLessonFixtures.js';
import { confineTeachingCitations } from '../llm/teachingCitations.js';
import { ProviderError } from '../llm/errors.js';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  PracticeRepairInput,
  ProviderCallOptions,
  StructuredOutputDiagnostic,
  TutorTurnInput,
  TeachingContentReviewInput,
  TeachingCapsuleGenerationInput,
  LessonGroundingReviewInput,
} from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import {
  makeBlock,
  makeConcept,
  makeMaterial,
  makeSemanticallySupportedObjective,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createServices, type Services } from './index.js';
import { deriveTeachUnitDurations, resolveStudyPlanPlannability } from './studyPlanValidation.js';
import { validateLessonSlotContentCandidate } from './teachingBriefContract.js';
import {
  evaluatePlannedPracticeQuality,
  COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
  hasCurrentPracticeAcceptancePolicy,
  practiceAggregateQualityFindings,
  practiceQualityImprovementFindings,
} from './lessonPedagogyEvaluator.js';
import { TEACHING_SKELETON_PLANNER_VERSION } from './teachingSkeletonPlanner.js';
import { hasCurrentPracticeAnswerabilityReview } from './teachingContentReview.js';
import { hasCurrentPreparedPractice } from './practiceAcceptance.js';
import * as generationStages from './generationStages.js';
import { practiceRepairHash } from './practiceRepairAcceptance.js';
import {
  prepareLessonGroundingReview,
  assertPreparedLessonGrounding,
  bindLessonGroundingToCheckpoint,
  checkpointLessonCandidate,
  lessonGroundingHash,
} from './lessonGrounding.js';
import {
  fingerprintObjectiveAuthorityBinding,
  fingerprintObjectiveAuthorityProposition,
  objectiveAuthoritySemanticallySupportedClaimIds,
  validateCurriculumObjectiveAuthoritySemanticSupport,
  validateObjectiveAuthoritySemanticSupport,
} from './objectiveAuthoritySemanticSupport.js';
import {
  serializedTeachingProviderSourceEnvelopeBytes,
  TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES,
} from './teachingBriefContext.js';
import {
  COMPOSITIONAL_PREPARATION_LEASE_MS,
  LESSON_CONTENT_PROMPT_VERSION,
  PRACTICE_CONTENT_PROMPT_VERSION,
  hasCurrentPreparedLesson,
  isCurrentAcceptedLessonCheckpoint,
} from './teachingBriefPreparation.js';

const clock = fixedClock(T0);
const databases: SqliteDb[] = [];
const LESSON_INPUT_MUTATION_SENTINEL = 'LESSON_PROVIDER_INPUT_MUTATION_SENTINEL';
const PRACTICE_INPUT_MUTATION_SENTINEL = 'PRACTICE_PROVIDER_INPUT_MUTATION_SENTINEL';

type LessonChoiceDefect =
  'missing_pair' | 'hidden_key' | 'absent_references' | 'missing_key' | 'binding';
function breakLessonChoice(
  surfaces: Array<{ informalCheck?: TeachingBriefInformalCheck }>,
  defect: LessonChoiceDefect,
) {
  const check = surfaces.find((surface) => surface.informalCheck)!.informalCheck!;
  check.kind = 'choose_alternative';
  check.options ??= [
    {
      id: 'A',
      text: 'Wait for capacity.',
      feedbackIfSelected: 'This satisfies the capacity limit.',
    },
    { id: 'B', text: 'Start immediately.', feedbackIfSelected: 'This exceeds the capacity limit.' },
  ];
  check.correctOptionId ??= 'A';
  if (defect === 'missing_pair') {
    delete check.options;
    delete check.correctOptionId;
  } else if (defect === 'hidden_key') check.kind = 'own_words';
  else if (defect === 'missing_key') delete check.correctOptionId;
  else if (defect === 'binding') check.correctOptionId = 'E';
  else {
    check.kind = 'predict_next';
    delete check.options;
    delete check.correctOptionId;
    delete check.evidenceContrast;
    check.prompt = '请比较选项D和E，并说明哪种方案能满足检索条件。';
  }
}

function breakLessonGrounding(evaluation: LessonPedagogyEvaluation, defect: string) {
  if (defect === 'grounding_missing') delete evaluation.groundingReview;
  else if (defect === 'grounding_version')
    evaluation.groundingReview!.policyVersion = 'lesson-grounding-v1-complete-claims';
  else if (defect === 'grounding_result')
    evaluation.groundingReview!.rounds.at(-1)!.result.findings = [
      {
        itemId: 'lesson.narrative',
        code: 'insufficient_evidence',
        problem: 'The saved rationale contradicts the authorized source.',
        repairInstruction: 'Correct the rationale.',
      },
    ];
  else if (defect === 'grounding_exposure') delete evaluation.groundingReview!.exposureContextHash;
  else {
    const key =
      defect === 'grounding_input'
        ? 'inputHash'
        : defect === 'grounding_candidate'
          ? 'candidateHash'
          : 'claimsHash';
    evaluation.groundingReview!.rounds.at(-1)![key] = `sha256:${'0'.repeat(64)}`;
  }
}

function historicalJ18Item() {
  const captured = JSON.parse(
    readFileSync(
      new URL(
        '../../../../eval/final-showcase/runs/scored-01/cases/J18/final.snapshot.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { rows: { accepted_lesson_checkpoints: Array<{ lesson_evaluation_payload: string }> } };
  const evaluation = JSON.parse(
    captured.rows.accepted_lesson_checkpoints[0]!.lesson_evaluation_payload,
  ) as { jointAuthoring: { practiceCandidate: unknown } };
  return PracticeContentProposalPayloadSchema.parse(evaluation.jointAuthoring.practiceCandidate)
    .items[0]!;
}

function operationStudySessionId(db: SqliteDb, operationId: string): string | null | undefined {
  return (
    db
      .prepare('SELECT study_session_id AS studySessionId FROM agent_operations WHERE id = ?')
      .get(operationId) as { studySessionId: string | null } | undefined
  )?.studySessionId;
}

class CountingProvider extends FakeProvider {
  override async reviewTeachingContent(
    input: TeachingContentReviewInput,
    opts?: ProviderCallOptions,
  ): Promise<TeachingContentReview> {
    opts?.onRequestSent?.();
    if (input.purpose === 'practice_answerability') this.practiceAnswerabilityCalls += 1;
    if (
      input.purpose === 'practice_answerability' ||
      input.purpose === 'practice_grounding' ||
      input.purpose === 'lesson_grounding' ||
      input.purpose?.startsWith('repair_')
    )
      return super.reviewTeachingContent(input, opts);
    return {
      decisions: input.actionIds.map((actionId) => ({
        actionId,
        answerId: actionId.endsWith('.transfer') || actionId.endsWith('.retry') ? 'B' : 'A',
        requiresCaseInference: true,
        evidenceUsed: 'The fixture has explicit current capacity and a changed constraint.',
      })),
      findings: [],
    };
  }
  lessonContentCalls = 0;
  practiceContentCalls = 0;
  practiceAnswerabilityCalls = 0;
  failLessonContent = false;
  failLessonContentWithSchemaDetails = false;
  failLessonIndependentEvaluationOnce = false;
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
    if (this.failLessonIndependentEvaluationOnce) {
      this.failLessonIndependentEvaluationOnce = false;
      const advisory = structuredClone(payload);
      const planned = input.skeleton.lessonSlots.find(
        (slot) => slot.qualityContract === 'semantic_relation',
      );
      const content = advisory.slots.find((slot) => slot.slotId === planned?.slotId);
      if (content) content.semanticRelations = [];
      return advisory;
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
    // Isolate lexical relevance from the hard, case-evidence contract.
    item.initial.explanation = '叶绿体色素会吸收光合作用所需的光能。';
    item.retry.explanation = '叶片光照减少时，叶绿体仍保留其色素。';
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

function contractFields(
  roleId: string,
  roleVersion: number,
  targetConstruct: 'explain' | 'apply' = 'explain',
): LearningContractDraftFields {
  return {
    intent: 'Learn working-memory capacity.',
    targetOutcome: {
      description:
        targetConstruct === 'apply'
          ? 'Apply the source-stated procedure accurately.'
          : 'Explain the source accurately.',
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

async function createHarness(
  providerDelayMs = 0,
  semanticVerdict: 'pass' | 'fail' = 'pass',
  targetConstruct: 'explain' | 'apply' = 'explain',
  desiredDepth: DesiredDepth = 'working_fluency',
): Promise<Harness> {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrate(db);
  const repos = createRepositories(db);
  const provider = new CountingProvider({
    delayMs: providerDelayMs,
    ...(targetConstruct === 'apply' ? { curriculumObjectiveConstructFixture: 'apply' } : {}),
  });
  repos.workspaces.insert(makeWorkspace());
  const content =
    targetConstruct === 'apply'
      ? '[SUPPORTS:apply] Check the current condition, apply the matching action, and inspect the resulting state before continuing.'
      : '[SUPPORTS:explain] Working memory has limited capacity.';
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
    fields: { ...contractFields(role.id, role.version, targetConstruct), desiredDepth },
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
  const acceptedCurriculum = repos.curricula.get(curriculum.id)!;
  const semanticSupports = acceptedCurriculum.nodes
    .flatMap((node) => node.learningUnit?.objectives ?? [])
    .map((objective) => {
      if (!objective.formalAssessmentConstruct) {
        throw new Error('Teaching fixture objective is missing its Formal construct.');
      }
      const { semanticSupport: _semanticSupport, ...withoutSemanticSupport } = objective;
      const support = makeSemanticallySupportedObjective(
        {
          ...withoutSemanticSupport,
          formalAssessmentConstruct: objective.formalAssessmentConstruct,
          authoritySourceBlockIds: objective.authoritySourceBlockIds ?? [],
          authorityClaimIds: objective.authorityClaimIds ?? [],
        },
        objective.formalAssessmentConstruct === 'identify'
          ? 'recognition'
          : objective.formalAssessmentConstruct === 'apply'
            ? 'procedure'
            : 'relationship',
      ).semanticSupport!;
      if (semanticVerdict === 'fail' && support.schemaVersion === 1) {
        support.fragments = support.fragments.map((fragment) => ({
          ...fragment,
          status: 'unsupported' as const,
          supportType: null,
          sourceBlockIds: [],
          authorityRecordIds: [],
          authorityClaimIds: [],
          rationale: 'The independently evaluated objective proposition is unsupported.',
        }));
        support.unsupportedFragmentIds = support.fragments.map((fragment) => fragment.fragmentId);
        support.conflicts = [];
        support.overreach = [];
        support.verdict = 'fail';
        support.rationale = 'The exact objective proposition does not pass semantic support.';
      }
      return support;
    });
  repos.curricula.insertObjectiveSemanticSupportsIfAbsent(curriculum.id, semanticSupports);
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
  plan.items = deriveTeachUnitDurations(
    harness.repos.curricula.get(harness.curriculumId)!,
    plan.items,
  ).derivedItems;
  const derivedPlanItem = plan.items.find((item) => item.id === planItem.id)!;
  harness.db
    .prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?')
    .run(JSON.stringify(plan), plan.id);
  harness.db
    .prepare('UPDATE study_plan_items SET objective_ids = ? WHERE plan_id = ? AND plan_item_id = ?')
    .run(JSON.stringify(objectiveIds), plan.id, planItem.id);
  const agenda = structuredClone(harness.repos.sessionAgendas.list('ws_1').at(-1)!);
  agenda.items = agenda.items.map((item) =>
    item.linkedPlanItemId === derivedPlanItem.id
      ? { ...item, estimatedMinutes: derivedPlanItem.estimatedMinutes }
      : item,
  );
  harness.db
    .prepare('UPDATE session_agendas SET payload = ? WHERE id = ?')
    .run(JSON.stringify(agenda), agenda.id);
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
    const updated = {
      ...base,
      objectiveId: id,
      proposition,
      propositionFingerprint: fingerprintObjectiveAuthorityProposition(proposition),
    };
    return base.schemaVersion === 1
      ? {
          ...updated,
          fragments: [
            {
              ...base.fragments[0]!,
              fragmentId: `${id}_fragment`,
              text: proposition,
            },
          ],
        }
      : updated;
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

function addUnrelatedLearningUnitObjective(harness: Harness, semanticState: 'failed' | 'stale') {
  const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
  const targetNode = curriculum.nodes.find((candidate) => candidate.id === harness.learningUnitId)!;
  const baseObjective = targetNode.learningUnit!.objectives[0]!;
  const unrelatedObjective = structuredClone(baseObjective);
  unrelatedObjective.id = `obj_unrelated_${semanticState}`;
  unrelatedObjective.title = `Unrelated ${semanticState} objective`;
  unrelatedObjective.description =
    'Explain a separate capability that does not belong to the active teaching action.';
  unrelatedObjective.priority = 'optional';
  const proposition = `${unrelatedObjective.title}\n${unrelatedObjective.description}`;
  const support = structuredClone(baseObjective.semanticSupport!);
  support.objectiveId = unrelatedObjective.id;
  support.proposition = proposition;
  support.propositionFingerprint = fingerprintObjectiveAuthorityProposition(proposition);
  if (support.schemaVersion === 1) {
    support.fragments = [
      {
        ...support.fragments[0]!,
        fragmentId: `${unrelatedObjective.id}_fragment`,
        text: proposition,
      },
    ];
    if (semanticState === 'failed') {
      support.fragments[0] = {
        ...support.fragments[0]!,
        status: 'unsupported',
        supportType: null,
        sourceBlockIds: [],
        authorityRecordIds: [],
        authorityClaimIds: [],
        rationale: 'The independently evaluated unrelated proposition is unsupported.',
      };
      support.unsupportedFragmentIds = [support.fragments[0].fragmentId];
      support.conflicts = [];
      support.overreach = [];
      support.verdict = 'fail';
      support.rationale = 'The unrelated objective does not pass semantic support.';
    }
  } else if (semanticState === 'failed') {
    support.supportGroups = [];
    support.verdict = 'fail';
  }
  unrelatedObjective.semanticSupport = support;

  const unrelatedNode = structuredClone(targetNode);
  unrelatedNode.id = `unit_unrelated_${semanticState}`;
  unrelatedNode.index = Math.max(...curriculum.nodes.map((node) => node.index)) + 1;
  unrelatedNode.title = `Unrelated ${semanticState} unit`;
  unrelatedNode.learningUnit = {
    ...unrelatedNode.learningUnit!,
    conceptIds: [],
    canonicalConceptIds: [],
    objectives: [unrelatedObjective],
    prerequisiteUnitIds: [],
    graphRelationIds: [],
    riskIds: [],
  };
  curriculum.nodes.push(unrelatedNode);
  if (semanticState === 'stale') {
    unrelatedObjective.description = `${unrelatedObjective.description} Changed after evaluation.`;
  }

  harness.db.transaction(() => {
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(curriculum), curriculum.id);
    harness.db
      .prepare(
        `INSERT INTO curriculum_node_index
           (curriculum_id, node_id, parent_node_id, kind, idx, title)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        curriculum.id,
        unrelatedNode.id,
        unrelatedNode.parentId,
        unrelatedNode.kind,
        unrelatedNode.index,
        unrelatedNode.title,
      );
    for (const [index, reference] of unrelatedNode.sourceReferences.entries()) {
      harness.db
        .prepare(
          `INSERT INTO curriculum_node_source_refs
             (curriculum_id, node_id, ordinal, material_id, material_revision_id,
              structural_unit_id, source_block_id, source_block_revision_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          curriculum.id,
          unrelatedNode.id,
          index,
          reference.materialId,
          reference.materialRevisionId,
          reference.structuralUnitId,
          reference.sourceBlockId,
          reference.sourceBlockRevisionFingerprint,
        );
    }
    harness.db
      .prepare(
        `INSERT INTO curriculum_objective_index
           (curriculum_id, learning_unit_id, objective_id, truth_premise_status)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        curriculum.id,
        unrelatedNode.id,
        unrelatedObjective.id,
        unrelatedObjective.truthPremiseStatus,
      );
    for (const authorityRecordId of unrelatedObjective.truthAuthorityRecordIds) {
      harness.db
        .prepare(
          `INSERT INTO curriculum_objective_authority
             (curriculum_id, objective_id, authority_record_id) VALUES (?, ?, ?)`,
        )
        .run(curriculum.id, unrelatedObjective.id, authorityRecordId);
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
        unrelatedObjective.id,
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
  })();

  return {
    learningUnitId: unrelatedNode.id,
    objectiveId: unrelatedObjective.id,
    curriculumPayload: (
      harness.db
        .prepare('SELECT payload FROM curriculum_versions WHERE id = ?')
        .get(curriculum.id) as { payload: string }
    ).payload,
    semanticSupportRow: harness.db
      .prepare(
        `SELECT status, proposition_fingerprint AS propositionFingerprint,
                binding_fingerprint AS bindingFingerprint, payload
         FROM curriculum_objective_semantic_support
         WHERE curriculum_id = ? AND objective_id = ?`,
      )
      .get(curriculum.id, unrelatedObjective.id),
  };
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
  const supportedClaimId = objectiveAuthoritySemanticallySupportedClaimIds(
    baseObjective.semanticSupport!,
  )[0]!;
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
    const baseSupport = objective.semanticSupport!;
    const updatedSupport = {
      ...baseSupport,
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
    };
    objective.semanticSupport =
      baseSupport.schemaVersion === 1
        ? {
            ...updatedSupport,
            fragments: [
              {
                ...baseSupport.fragments[0]!,
                fragmentId: `${objective.id}_fragment`,
                text: proposition,
                authorityRecordIds: [authorityRecordId],
                authorityClaimIds: [...claimIds],
              },
            ],
          }
        : {
            ...updatedSupport,
            candidateLabels: baseSupport.candidateLabels.map((candidate, candidateIndex) =>
              candidateIndex === 0
                ? {
                    ...candidate,
                    authorityRecordIds: [authorityRecordId],
                    authorityClaimIds: [...claimIds],
                  }
                : candidate,
            ),
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

const qualityDecisionPrompt =
  '案例规则：旧任务结束后应归还占用配额，调整优先级不会改变占用计数。完成日志确认旧任务已结束，但计数仍满，新任务等待。检查状态更新链路花费1分钟，调整优先级花费5分钟；只能先选一项，希望尽快定位不符合规则的状态。应优先采用哪个方案，为什么？';
const qualityDecisionAnswer = '先检查完成事件到计数更新的链路，以较低成本定位未归还状态。';
const shallowDecisionPrompt =
  '案例规则：系统记录区分任务完成事件、优先级变更和资源计数更新。当前日志明确把记录标为“任务完成事件”。这条记录应归入哪一类？';
const shallowDecisionAnswer = '归入任务完成事件，表示一个任务结束。';

async function aggregateQualityHarness(
  rewrite:
    | 'no_op'
    | 'ineffective'
    | 'improved'
    | 'wrong_key'
    | 'source_alias'
    | 'schema'
    | 'missing_givens'
    | 'grounding'
    | 'invalid_output'
    | 'network'
    | 'review_failure'
    | 'malformed_review'
    | 'label_only'
    | 'trailing_whitespace'
    | 'whitespace_formatting'
    | 'punctuation_only'
    | 'quotation_punctuation'
    | 'bracket_punctuation'
    | 'option_reorder'
    | 'private_only'
    | 'wording_but_still_recognition'
    | 'no_inference'
    | 'missing_contrast'
    | 'leak' = 'no_op',
  initialDefect?: 'missing_givens' | 'wrong_key' | 'authority' | 'grounding',
  shallow?: { depth: DesiredDepth; operation: 'recognize' | 'classify' },
) {
  const harness = await createHarness(0, 'pass', 'explain', shallow?.depth ?? 'deep_transfer');
  const curriculum = harness.repos.curricula.get(harness.curriculumId)!;
  const unit = curriculum.nodes.find((node) => node.id === harness.learningUnitId)!.learningUnit!;
  unit.focus = shallow ? 'normal' : 'focused';
  for (const objective of unit.objectives) objective.priority = 'required';
  harness.db
    .prepare('UPDATE curriculum_versions SET payload=? WHERE id=?')
    .run(JSON.stringify(curriculum), curriculum.id);

  const lesson = harness.provider.generateLessonSlotContent.bind(harness.provider);
  const adaptLessonFixture = (candidate: LessonSlotContentProposalPayload) => {
    if (shallow) {
      for (const slot of candidate.slots) {
        const transfer = slot.workedProcess?.interaction?.transfer;
        if (!transfer) continue;
        transfer.reasoningOperation = 'judge_tradeoff';
        transfer.changedCondition += '备用方案额外耗电；原处理器等待方案省电但无法满足截止要求。';
        transfer.prompt = '本次必须满足截止要求。如何在额外耗电与等待超期之间作出权衡？';
        transfer.requiredInference = '接受备用方案的额外耗电，以满足截止要求和独立配额限制。';
        transfer.options[0]!.text = '在原处理器等待甲完成，优先节省电量，即使错过截止要求。';
        transfer.options[1]!.text = '让备用处理器接收乙，在独立容量内启动，并接受额外耗电。';
      }
      return candidate;
    }
    for (const slot of candidate.slots) {
      if (slot.workedProcess?.interaction) {
        const transfer = slot.workedProcess.interaction.transfer;
        transfer.reasoningOperation = 'diagnose_cause';
        transfer.changedCondition =
          '补充案例：备用处理器容量3，乙需要3；没有运行任务，但备用处理器的空闲记录仍是0，乙因配额不足被拒绝。';
        transfer.requiredInference = '备用处理器的空闲记录未按实际容量初始化。';
        transfer.prompt = '应先诊断哪个环节，才能解释没有运行任务却没有空闲配额？';
        transfer.evidenceContrast = {
          evidence: '没有运行任务，但备用处理器的空闲记录仍是0',
          replacement: '备用处理器已有运行任务占用全部3个配额',
          alternativeOptionId: 'A',
        };
        transfer.options[0]!.text = '运行任务占用了备用处理器的全部配额。';
        transfer.options[0]!.feedbackIfSelected = '可见记录明确排除了正在运行的任务。';
        transfer.options[1]!.text = transfer.requiredInference;
        transfer.options[1]!.feedbackIfSelected = '实际容量与空闲记录不一致，且没有占用事件。';
        transfer.options[2]!.text = '乙需要的配额超过备用处理器的实际容量。';
        transfer.options[2]!.feedbackIfSelected = '乙的需求3等于备用处理器容量3。';
        transfer.debrief = '没有运行任务排除了占用原因，需求未超出容量；应追踪初始空闲状态。';
      }
      if (slot.informalCheck) slot.informalCheck.reasoningOperation = 'identify_missing';
    }
    return candidate;
  };
  harness.provider.generateLessonSlotContent = async (input, opts) =>
    adaptLessonFixture(await lesson(input, opts));

  const qualityRequests: PracticeContentGenerationInput[] = [];
  const practice = harness.provider.generatePracticeContent.bind(harness.provider);
  harness.provider.generatePracticeContent = async (input, opts) => {
    const generated = await practice(input, opts);
    const improving = input.editorialFindings?.some((finding) =>
      /focused_unit_angle_coverage_insufficient|reasoning_demand_below_depth|practice_initial_recognition_at_depth/u.test(
        finding.problem,
      ),
    );
    const candidate = improving ? structuredClone(input.draftForReview!) : generated;
    // The fixture states its synthetic rule explicitly and claims no source citation.
    for (const item of candidate.items) {
      item.sourceRefs = [];
      item.visualRefs = [];
    }
    if (shallow && !improving) {
      candidate.items[0]!.initial = {
        reasoningOperation: shallow.operation,
        requiredInference: '识别日志直接声明的事件类别。',
        decisiveCondition: '日志明确把记录标为任务完成事件。',
        evidenceContrast: {
          evidence: '当前日志明确把记录标为“任务完成事件”',
          replacement: '当前日志明确把记录标为“优先级变更”',
          alternativeOptionId: 'B',
        },
        prompt: shallowDecisionPrompt,
        options: [
          {
            optionRef: 'A',
            text: shallowDecisionAnswer,
            feedbackIfSelected: '日志已经声明了任务完成事件。',
          },
          {
            optionRef: 'B',
            text: '归入优先级变更，表示调度顺序改变。',
            feedbackIfSelected: '日志没有将记录标为优先级变更。',
          },
          {
            optionRef: 'C',
            text: '归入资源计数更新，表示配额数值改变。',
            feedbackIfSelected: '任务完成记录本身没有声明配额数值更新。',
          },
        ],
        correctOptionRef: 'A',
        hint: '读取日志直接给出的类别名称。',
        explanation: '这里只识别记录声明的事件类别，并没有推导随后发生的状态变化。',
      };
    }
    if (improving) {
      qualityRequests.push(structuredClone(input));
      if (rewrite === 'invalid_output')
        throw ProviderError.invalidOutput(
          'Invalid optional rewrite.',
          'schema',
          'SCHEMA_VALIDATION_FAILURE',
          true,
        );
      if (rewrite === 'network') throw ProviderError.network();
      if (rewrite === 'ineffective') candidate.items[0]!.pedagogicalReason += ' 保留相同覆盖缺口。';
      if (
        [
          'label_only',
          'trailing_whitespace',
          'whitespace_formatting',
          'punctuation_only',
          'quotation_punctuation',
          'bracket_punctuation',
          'option_reorder',
          'private_only',
          'wording_but_still_recognition',
          'missing_contrast',
        ].includes(rewrite)
      ) {
        candidate.items[0]!.initial.reasoningOperation = 'diagnose_cause';
        if (rewrite === 'missing_contrast') delete candidate.items[0]!.initial.evidenceContrast;
      }
      const initial = candidate.items[0]!.initial;
      if (rewrite === 'trailing_whitespace') initial.prompt = ` \t${initial.prompt}  \n`;
      if (rewrite === 'whitespace_formatting') {
        initial.prompt = initial.prompt.replace(/[。？]/gu, '$&\n\t');
        for (const option of initial.options) option.text = ` \n${option.text}\t `;
      }
      if (rewrite === 'punctuation_only') {
        initial.prompt = initial.prompt.replace(/？$/u, '?!');
        for (const option of initial.options) option.text = option.text.replace(/。$/u, '！');
      }
      if (rewrite === 'quotation_punctuation') {
        initial.prompt = initial.prompt.replace(/“/gu, '「').replace(/”/gu, '」');
        initial.evidenceContrast!.evidence = initial
          .evidenceContrast!.evidence.replace(/“/gu, '「')
          .replace(/”/gu, '」');
      }
      if (rewrite === 'bracket_punctuation') {
        initial.prompt = `【${initial.prompt}】`;
        for (const option of initial.options) option.text = `(${option.text})`;
      }
      if (rewrite === 'option_reorder') initial.options.reverse();
      if (rewrite === 'private_only') {
        initial.requiredInference += ' 作者希望学习者进行诊断。';
        initial.decisiveCondition += ' 作者私有判断。';
        initial.hint += ' 私有提示改写。';
        initial.explanation += ' 私有解释改写。';
        for (const option of initial.options) option.feedbackIfSelected += ' 私有反馈改写。';
      }
      if (rewrite === 'wording_but_still_recognition') initial.prompt += ' 请读取类别名称。';
      if (rewrite === 'improved' || rewrite === 'no_inference')
        for (const item of candidate.items) {
          item.initial.prompt = qualityDecisionPrompt;
          item.initial.reasoningOperation = 'judge_tradeoff';
          item.initial.requiredInference = qualityDecisionAnswer;
          item.initial.decisiveCondition = '状态更新检查成本较低且计数未随完成事件归还。';
          item.initial.evidenceContrast = {
            evidence: '检查状态更新链路花费1分钟，调整优先级花费5分钟',
            replacement: '检查链路花费10分钟，已有证据定位到优先级配置且调整只需1分钟',
            alternativeOptionId: 'B',
          };
          item.initial.options[0]!.text = qualityDecisionAnswer;
          item.initial.options[1]!.text = '先调整优先级配置，再检查后续允许启动的条件。';
          item.initial.options[2]!.text = '直接停用占用计数检查，让所有等待任务开始。';
          item.initial.explanation =
            '完成日志与满计数不一致，而调整优先级不能归还配额；先检查更新链路也消耗更少时间。';
        }
      if (rewrite === 'wrong_key') {
        candidate.items[0]!.initial.correctOptionRef = 'B';
        candidate.items[0]!.initial.evidenceContrast!.alternativeOptionId = 'C';
      }
      if (rewrite === 'source_alias') candidate.items[0]!.sourceRefs = ['S99'];
      if (rewrite === 'schema') candidate.items[0]!.initial.options[1]!.optionRef = 'A';
      if (rewrite === 'missing_givens')
        candidate.items[0]!.initial.prompt =
          '完成日志确认旧任务已结束，新任务仍等待。应先诊断哪个环节？';
      if (rewrite === 'grounding') {
        candidate.items[0]!.sourceRefs = ['S1'];
        candidate.items[0]!.capabilityTested += ' 材料保证提高优先级就会自动归还配额。';
      }
      if (rewrite === 'leak')
        candidate.items[0]!.initial.prompt += ` 正确答案是${candidate.items[0]!.initial.options[0]!.text}`;
    } else if (initialDefect === 'missing_givens') {
      candidate.items[0]!.initial.prompt =
        '完成日志确认旧任务已结束，新任务仍等待。应先诊断哪个环节？';
    } else if (initialDefect === 'wrong_key') {
      candidate.items[0]!.initial.correctOptionRef = 'B';
      candidate.items[0]!.initial.evidenceContrast!.alternativeOptionId = 'C';
    } else if (initialDefect === 'authority') {
      candidate.items[0]!.sourceRefs = ['S99'];
    } else if (initialDefect === 'grounding') {
      candidate.items[0]!.sourceRefs = ['S1'];
      candidate.items[0]!.capabilityTested += ' 材料保证提高优先级就会自动归还配额。';
    }
    expect(
      (shallow ? practiceQualityImprovementFindings : practiceAggregateQualityFindings)(
        evaluatePlannedPracticeQuality(candidate, input, {
          evaluatedAt: clock.now().toISOString(),
        }),
      ).length > 0,
    ).toBe(
      !(
        improving &&
        [
          'improved',
          'label_only',
          'trailing_whitespace',
          'whitespace_formatting',
          'punctuation_only',
          'quotation_punctuation',
          'bracket_punctuation',
          'option_reorder',
          'private_only',
          'wording_but_still_recognition',
          'missing_contrast',
          'no_inference',
        ].includes(rewrite)
      ),
    );
    return candidate;
  };

  const requests: TeachingContentReviewInput[] = [];
  const review = harness.provider.reviewTeachingContent.bind(harness.provider);
  harness.provider.reviewTeachingContent = async (input, opts) => {
    requests.push(structuredClone(input));
    if (input.purpose === 'lesson_grounding') {
      opts?.onRequestSent?.();
      return reviewKnownLessonVariant(
        input,
        adaptLessonFixture,
        harness.provider.lastLessonContentInput!,
      );
    }
    if (input.purpose === 'practice_grounding' && qualityRequests.length > 0) {
      if (rewrite === 'review_failure') throw ProviderError.timeout(1);
      if (rewrite === 'malformed_review')
        return {
          decisions: [
            {
              actionId: 'unoffered',
              answerId: null,
              requiresCaseInference: false,
              evidenceUsed: 'Invalid review inventory.',
            },
          ],
          findings: [],
        };
    }
    if (
      input.purpose === 'practice_grounding' &&
      (initialDefect === 'grounding' || (rewrite === 'grounding' && qualityRequests.length > 0))
    )
      return {
        decisions: [],
        findings: [
          {
            itemId: 'PR1',
            code: 'grounding',
            problem: 'The cited source does not entail automatic quota release by priority.',
            responsibility: 'grounding',
            repairInstruction: 'Remove the unsupported claim or supply authorized support.',
          },
        ],
      };
    if (
      input.purpose === 'practice_answerability' &&
      shallow &&
      input.candidate.actionId === 'PR1.initial' &&
      input.candidate.prompt.includes('当前日志明确把记录标为')
    )
      return {
        decisions: [
          {
            actionId: input.actionIds[0]!,
            answerId: 'A',
            // Even an overly optimistic review cannot certify cosmetic rewrites.
            requiresCaseInference:
              qualityRequests.length > 0 && rewrite !== 'wording_but_still_recognition',
            evidenceUsed: 'The public log directly states the event category.',
          },
        ],
        findings: [],
      };
    if (
      input.purpose === 'practice_answerability' &&
      input.candidate.prompt === qualityDecisionPrompt
    )
      return {
        decisions: [
          {
            actionId: input.actionIds[0]!,
            answerId: input.candidate.options.find(
              (option) => option.text === qualityDecisionAnswer,
            )!.id,
            requiresCaseInference: rewrite !== 'no_inference',
            evidenceUsed:
              'The visible rule excludes priority as a quota update; the cheaper update check explains the observed inconsistency.',
          },
        ],
        findings: [],
      };
    return review(input, opts);
  };
  return { harness, qualityRequests, requests };
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

/**
 * Rewrite every route objective into the shape a Curriculum accepted before
 * 2026-08-24 carries: no semantic-support artifact, no persisted construct, no
 * persisted tier, no explicit exact block binding, and no Formal claim. The
 * append-only support table is never read back on the teaching path, so the
 * Curriculum payload is the whole of the objective's authority state.
 */
function makeCurrentRouteObjectivesArtifactFree(harness: Harness): string[] {
  const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
  const planItem = harness.repos.studyPlans
    .get(harness.planId)!
    .items.find(
      (item) =>
        item.kind === 'teach_unit' && item.curriculumLearningUnitId === harness.learningUnitId,
    )!;
  const objectives = curriculum.nodes
    .find((node) => node.id === harness.learningUnitId)!
    .learningUnit!.objectives.filter((candidate) => planItem.objectiveIds.includes(candidate.id));
  if (objectives.length === 0) throw new Error('Expected at least one route objective.');
  for (const objective of objectives) {
    delete objective.semanticSupport;
    delete objective.formalAssessmentConstruct;
    delete objective.authorityEnvelopeTier;
    delete objective.authoritySourceBlockIds;
    objective.priority = 'normal';
    objective.formalAssessmentReady = false;
    objective.formalEvidenceSourceBlockIds = [];
  }
  harness.db
    .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
    .run(JSON.stringify(curriculum), curriculum.id);
  // `curricula.get` rehydrates `semanticSupport` from the append-only support table
  // rather than from the version payload, so the artifact only truly disappears once
  // its row does. A genuine pre-artifact Curriculum simply never had one.
  harness.db.exec('DROP TRIGGER IF EXISTS prevent_curriculum_objective_semantic_support_delete');
  const deleteSupport = harness.db.prepare(
    `DELETE FROM curriculum_objective_semantic_support
     WHERE curriculum_id = ? AND objective_id = ?`,
  );
  for (const objective of objectives) deleteSupport.run(harness.curriculumId, objective.id);
  return objectives.map((objective) => objective.id);
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()!.close();
  // Offline providers and SQLite finish synchronously. Let the worker receive
  // its pending progress acknowledgements between the many fixture cases.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

async function ordinaryLessonHarness() {
  const harness = await createHarness();
  const { baseObjective, routeSecond } = addSameUnitRouteAndDeferredObjectives(harness);
  const curriculum = harness.repos.curricula.get(harness.curriculumId)!;
  const unit = curriculum.nodes.find((node) => node.id === harness.learningUnitId)!.learningUnit!;
  unit.objectives.find((objective) => objective.id === routeSecond.id)!.priority = 'required';
  harness.db
    .prepare('UPDATE curriculum_versions SET payload=? WHERE id=?')
    .run(JSON.stringify(curriculum), curriculum.id);
  setTeachingPlanObjectiveIds(harness, [baseObjective.id, routeSecond.id]);
  return harness;
}

/** Explicit expectations for adapted test Lessons, outside production Fake's finite registry. */
function reviewKnownLessonVariant(
  input: LessonGroundingReviewInput,
  transform: (expected: LessonSlotContentProposalPayload) => LessonSlotContentProposalPayload,
  context: LessonSlotContentGenerationInput,
  confined = false,
): TeachingContentReview {
  const known = transform(
    createFakeLessonFixture({
      courseDesign: input.courseDesign,
      skeleton: { ...input.lessonPlan, objectives: input.objectives },
      sourceContext: { offers: input.sources },
      learningContext: input.learningContext,
    }),
  );
  const expected = confined
    ? confineTeachingCitations({ lesson: known, practice: { items: [] } }, { lesson: context })
        .lesson
    : known;
  return {
    decisions: [],
    findings:
      lessonGroundingHash(input.candidate) === lessonGroundingHash(expected)
        ? []
        : [
            {
              itemId: 'lesson.narrative',
              code: 'grounding',
              problem: 'This adapted test Lesson differs from its explicit known-correct fixture.',
              repairInstruction: 'Restore the exact correct test fixture.',
            },
          ],
  };
}

function installKnownLessonVariant(
  harness: Harness,
  transform: (expected: LessonSlotContentProposalPayload) => LessonSlotContentProposalPayload,
) {
  const review = harness.provider.reviewTeachingContent.bind(harness.provider);
  harness.provider.reviewTeachingContent = async (input, opts) => {
    if (input.purpose !== 'lesson_grounding') return review(input, opts);
    opts?.onRequestSent?.();
    return reviewKnownLessonVariant(
      input,
      transform,
      harness.provider.lastLessonContentInput!,
      harness.provider.name === 'hy3',
    );
  };
}

/** An independent offline oracle for fixtures whose task needs D/E contents.
 * The production reference inventory must never decide this semantic fact. */
function reviewMissingAlternativeContents(
  harness: Awaited<ReturnType<typeof ordinaryLessonHarness>>,
  definingText?: string,
  findingCode: TeachingContentReview['findings'][number]['code'] = 'insufficient_evidence',
) {
  const review = harness.provider.reviewTeachingContent.bind(harness.provider);
  harness.provider.reviewTeachingContent = async (input, opts) => {
    const result = await review(input, opts);
    if (!('stage' in input) || input.stage !== 'lesson' || input.purpose === 'lesson_grounding')
      return result;
    const publicText = JSON.stringify(input.candidate);
    expect(publicText).not.toContain('semanticRelations');
    if (definingText && publicText.includes(definingText)) return result;
    const candidate = input.candidate as {
      slots: Array<{ slotId: string; informalCheck?: unknown }>;
    };
    return {
      ...result,
      findings: [
        {
          itemId: candidate.slots.find((slot) => slot.informalCheck)!.slotId,
          code: findingCode,
          problem: 'The alternative contents required by this fixture were not exposed.',
          responsibility: 'answerability',
          repairInstruction: 'Show the required contents before asking this task.',
        },
      ],
    };
  };
}

describe('Teaching Brief preparation', () => {
  it('persists, reads, reuses and executes a current Brief with its complete review receipts', async () => {
    const harness = await createHarness(0, 'pass', 'apply', 'pass_oriented');
    Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
    const route = startTeachingRoute(harness);
    const request = preparationRequest(harness, route, 'current-brief-lifecycle');
    const prepared = await harness.services.teachingBriefPreparation.prepare(request);
    const stored = harness.repos.teachingBriefs.get(prepared.brief.id)!;
    expect(TeachingBriefSchema.parse(stored)).toEqual(prepared.brief);
    expect(stored.pedagogyEvaluation!.contentReview).toHaveLength(1);
    expect(stored.pedagogyEvaluation!.groundingReview!.rounds).toHaveLength(1);
    const practice = stored.practice!.qualityEvaluation;
    expect(practice.contentReview!.length).toBeGreaterThan(0);
    expect(practice.groundingReview!.rounds).toHaveLength(practice.contentReview!.length);
    expect(practice.integrityReview!.rounds).toHaveLength(practice.contentReview!.length);
    expect(practice.answerabilityReview!.rounds.at(-1)!.solves).toHaveLength(
      stored.practice!.items.length * 2,
    );
    expect(hasCurrentPreparedLesson(stored)).toBe(true);
    expect(hasCurrentPreparedPractice(stored)).toBe(true);
    expect(harness.services.teachingBriefPreparation.getCurrent(request)).toEqual(stored);
    expect(await harness.services.teachingBriefPreparation.prepare(request)).toEqual(prepared);
    const reused = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'current-brief-reuse'),
    );
    expect(reused).toMatchObject({ status: 'reused', brief: stored });
    const calls = [harness.provider.lessonContentCalls, harness.provider.practiceContentCalls];
    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('current-brief-bind'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(ready.status).toBe('ready');
    const started = await harness.services.lessonExecution.command('ws_1', route.session.id, {
      command: command('current-brief-start'),
      expectedSessionVersion: ready.session.version,
      expectedAgendaVersion: ready.agenda!.version,
      expectedAgendaItemId: route.agendaItem.id,
      expectedLessonStateVersion: ready.progress!.stateVersion,
      action: { kind: 'start_lesson' },
    });
    expect(started.lesson).not.toBeNull();
    expect(started.progress!.presentedSegmentIndexes.length).toBeGreaterThan(0);
    expect([harness.provider.lessonContentCalls, harness.provider.practiceContentCalls]).toEqual(
      calls,
    );
  });

  it.each(['malformed grounding', 'failed solve', 'missing integrity'] as const)(
    'cannot admit a persisted current Brief with %s through storage or replay',
    async (defect) => {
      const harness = await createHarness(0, 'pass', 'apply', 'pass_oriented');
      const route = startTeachingRoute(harness);
      const request = preparationRequest(harness, route, 'current-invalid-proof-' + defect);
      const prepared = await harness.services.teachingBriefPreparation.prepare(request);
      const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        command: command('current-invalid-bind-' + defect),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      });
      const changed = structuredClone(prepared);
      const evaluation = changed.brief.practice!.qualityEvaluation;
      if (defect === 'malformed grounding')
        evaluation.groundingReview!.rounds.at(-1)!.result.findings.push({
          itemId: 'PR1',
          code: 'accuracy',
          responsibility: 'integrity' as 'grounding',
          problem: 'Wrong-purpose material output cannot certify grounding.',
          repairInstruction: 'Obtain current grounding proof.',
        });
      else if (defect === 'failed solve')
        evaluation.answerabilityReview!.rounds.at(-1)!.solves[0]!.result.decisions[0]!.answerId =
          null;
      else delete evaluation.integrityReview;
      harness.db
        .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
        .run(JSON.stringify(changed.brief), changed.brief.id);
      const operation = harness.repos.operations.getByIdempotencyKey(
        'ws_1',
        `teaching-brief:${harness.learningUnitId}:${request.commandId}`,
      )!;
      harness.db
        .prepare('UPDATE agent_operation_results SET payload=? WHERE operation_id=?')
        .run(JSON.stringify(changed), operation.id);
      const stored = harness.repos.teachingBriefs.get(changed.brief.id);
      if (defect === 'malformed grounding') {
        expect(stored).toBeUndefined();
        expect(() => harness.repos.teachingBriefs.create(changed.brief)).toThrow();
      } else {
        expect(stored).toEqual(changed.brief);
        expect(hasCurrentPreparedPractice(stored!)).toBe(false);
      }
      expect(harness.services.teachingBriefPreparation.getCurrent(request)).toBeNull();
      await expect(
        harness.services.teachingBriefPreparation.prepare(request),
      ).rejects.toMatchObject({
        code: ApiErrorCode.VersionConflict,
      });
      const blocked = harness.services.lessonExecution.get('ws_1', route.session.id);
      expect(blocked.status).toBe('preparation_needed');
      expect(blocked.lesson).toBeNull();
      await expect(
        harness.services.lessonExecution.command('ws_1', route.session.id, {
          command: command('current-invalid-start-' + defect),
          expectedSessionVersion: ready.session.version,
          expectedAgendaVersion: ready.agenda!.version,
          expectedAgendaItemId: route.agendaItem.id,
          expectedLessonStateVersion: ready.progress!.stateVersion,
          action: { kind: 'start_lesson' },
        }),
      ).rejects.toBeDefined();
    },
  );

  it('invalidates incompatible stored receipts without blocking a fresh current preparation', async () => {
    const captured = JSON.parse(
      readFileSync(
        new URL(
          '../../../../eval/final-showcase/runs/scored-01/cases/J18/final.snapshot.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { rows: { teaching_briefs: Array<{ payload: string }> } };
    const oldBrief = JSON.parse(captured.rows.teaching_briefs[0]!.payload);
    expect(TeachingBriefSchema.safeParse(oldBrief).success).toBe(false);
    const harness = await createHarness(0, 'pass', 'apply', 'pass_oriented');
    const route = startTeachingRoute(harness);
    const request = preparationRequest(harness, route, 'incompatible-stored-brief');
    const prepared = await harness.services.teachingBriefPreparation.prepare(request);
    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('incompatible-brief-bind'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    const incompatible = structuredClone(prepared);
    // Preserve the captured receipt, including its obsolete combined decisions.
    incompatible.brief.practice!.qualityEvaluation.contentReview =
      oldBrief.practice.qualityEvaluation.contentReview;
    expect(TeachingBriefSchema.safeParse(incompatible.brief).success).toBe(false);
    harness.db
      .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
      .run(JSON.stringify(incompatible.brief), incompatible.brief.id);
    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      `teaching-brief:${harness.learningUnitId}:${request.commandId}`,
    )!;
    harness.db
      .prepare('UPDATE agent_operation_results SET payload=? WHERE operation_id=?')
      .run(JSON.stringify(incompatible), operation.id);
    expect(harness.repos.teachingBriefs.get(incompatible.brief.id)).toBeUndefined();
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
    expect(harness.services.teachingBriefPreparation.getCurrent(request)).toBeNull();
    expect(harness.services.lessonExecution.get('ws_1', route.session.id).status).toBe(
      'preparation_needed',
    );
    await expect(harness.services.teachingBriefPreparation.prepare(request)).rejects.toMatchObject({
      code: ApiErrorCode.VersionConflict,
      message: expect.stringContaining('new command'),
    });
    const renewed = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('incompatible-brief-renew'),
      expectedSessionVersion: ready.session.version,
      expectedAgendaVersion: ready.agenda!.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(renewed.status).toBe('ready');
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const current = harness.repos.teachingBriefs.get(state.teachingBriefId!)!;
    expect(current.id).not.toBe(incompatible.brief.id);
    expect(TeachingBriefSchema.parse(current)).toEqual(current);
    expect(hasCurrentPreparedLesson(current)).toBe(true);
    expect(hasCurrentPreparedPractice(current)).toBe(true);
    expect(current.composition!.acceptedLessonCheckpointId).toBe(
      prepared.brief.composition!.acceptedLessonCheckpointId,
    );
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([
      current,
    ]);
  });

  it.each(['references removed', 'references still required', 'new grounding defect'] as const)(
    'handles a Fake Lesson correction with %s using only current review authority',
    async (correction) => {
      const harness = await ordinaryLessonHarness();
      const transform = (lesson: LessonSlotContentProposalPayload) => {
        if (harness.provider.lessonContentCalls === 1 || correction === 'references still required')
          breakLessonChoice(lesson.slots, 'absent_references');
        if (harness.provider.lessonContentCalls > 1 && correction === 'new grounding defect')
          lesson.slots[0]!.explanation += ' 补充计算：2 + 2 = 5。';
        return lesson;
      };
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      harness.provider.generateLessonSlotContent = async (input, opts) =>
        transform(await generate(input, opts));
      installKnownLessonVariant(harness, (lesson) => {
        if (harness.provider.lessonContentCalls === 1 || correction === 'references still required')
          breakLessonChoice(lesson.slots, 'absent_references');
        return lesson;
      });
      reviewMissingAlternativeContents(harness);
      const route = startTeachingRoute(harness);
      const request = preparationRequest(harness, route, 'fake-receipt-correction-' + correction);
      if (correction !== 'references removed') {
        await expect(
          harness.services.teachingBriefPreparation.prepare(request),
        ).rejects.toMatchObject({
          code: ApiErrorCode.ProviderInvalidOutput,
        });
        expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual(
          [],
        );
        expect(
          harness.db.prepare('SELECT count(*) AS n FROM accepted_lesson_checkpoints').get(),
        ).toEqual({ n: 0 });
        return;
      }
      const prepared = await harness.services.teachingBriefPreparation.prepare(request);
      expect(harness.provider.name).toBe('fake');
      expect(harness.provider.lessonContentCalls).toBe(2);
      expect(prepared.brief.pedagogyEvaluation!.contentReview).toBeUndefined();
      expect(prepared.brief.pedagogyEvaluation!.groundingReview!.rounds).toHaveLength(2);
      expect(hasCurrentPreparedLesson(prepared.brief)).toBe(true);
      expect(await harness.services.teachingBriefPreparation.prepare(request)).toEqual(prepared);
      const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        command: command('fake-corrected-lesson-bind'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      });
      expect(ready.status).toBe('ready');
      expect(harness.provider.lessonContentCalls).toBe(2);
    },
  );

  it('propagates cancellation during optional Practice improvement and fences its late invalid result', async () => {
    const { harness, qualityRequests, requests } = await aggregateQualityHarness('source_alias');
    const route = startTeachingRoute(harness);
    const started = deferred<void>();
    const released = deferred<void>();
    const generate = harness.provider.generatePracticeContent.bind(harness.provider);
    harness.provider.generatePracticeContent = async (input, opts) => {
      const candidate = await generate(input, opts);
      if (qualityRequests.length) {
        started.resolve();
        // Deliberately ignore cancellation and return a late invalid rewrite.
        await released.promise;
      }
      return candidate;
    };
    const abort = new AbortController();
    const pending = harness.services.lessonExecution.ensure(
      'ws_1',
      route.session.id,
      {
        command: command('cancel-optional-quality'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      },
      { signal: abort.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
    await started.promise;
    expect(qualityRequests).toHaveLength(1);
    expect(requests.filter((input) => input.purpose === 'practice_answerability')).toHaveLength(
      2 * qualityRequests[0]!.draftForReview!.items.length,
    );
    abort.abort();
    released.resolve();
    await rejected;
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
    const cancelled = harness.services.lessonExecution.get('ws_1', route.session.id);
    expect(cancelled.status).toBe('practice_retry_available');
    expect(cancelled.allowedActions).toEqual(['retry_preparation']);
    expect(cancelled.lesson).not.toBeNull();
    expect(cancelled.practice).toBeNull();
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    expect(state.teachingBriefId).toBeNull();
    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      'cancel-optional-quality',
    )!;
    expect(operation.status).not.toBe('completed');
    expect(
      harness.db.prepare("SELECT count(*) AS n FROM agent_operations WHERE status='running'").get(),
    ).toEqual({ n: 0 });
    const lateLease = harness.repos.operations.claim(
      operation.id,
      'late-worker',
      '2099-01-01T00:00:00.000Z',
      clock.now().toISOString(),
    );
    expect(lateLease).toBeUndefined();
    const retried = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('cancel-optional-quality-retry'),
      expectedSessionVersion: cancelled.session.version,
      expectedAgendaVersion: cancelled.agenda!.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(retried.status).toBe('ready');
  });

  it.each(['weak_transfer', 'shallow_task'] as const)(
    'rejects unavailable Lesson premises reported as material %s',
    async (code) => {
      const harness = await ordinaryLessonHarness();
      const transform = (lesson: LessonSlotContentProposalPayload) => {
        breakLessonChoice(lesson.slots, 'absent_references');
        return lesson;
      };
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      harness.provider.generateLessonSlotContent = async (input, opts) =>
        transform(await generate(input, opts));
      installKnownLessonVariant(harness, transform);
      reviewMissingAlternativeContents(harness, undefined, code);
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `lesson-material-${code}`),
        ),
      ).rejects.toMatchObject({
        details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
      });
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
      expect(
        harness.db.prepare('SELECT count(*) AS n FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ n: 0 });
    },
  );

  it.each(['practice_grounding', 'practice_answerability', 'practice_integrity'] as const)(
    'shares one quality attempt for %s advisories and reuses the exhausted accepted Brief',
    async (purpose) => {
      const harness = await createHarness(0, 'pass', 'apply', 'pass_oriented');
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      let reviewCalls = 0;
      harness.provider.reviewTeachingContent = async (input, opts) => {
        reviewCalls++;
        const result = await review(input, opts);
        if (input.purpose === purpose)
          result.advisories = [
            {
              itemId: 'PR1',
              code: 'insufficient_evidence',
              qualityAspect: 'richness',
              problem:
                'The correct capacity case could include a richer comparison of constraints.',
              repairInstruction:
                'Consider an additional comparison without changing source rules or hiding case givens.',
            },
          ];
        return result;
      };
      const route = startTeachingRoute(harness);
      const prepared = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `generic-quality-${purpose}`),
      );
      const evaluation = prepared.brief.practice!.qualityEvaluation;
      expect(evaluation.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'exhausted' });
      expect(evaluation.qualityImprovement!.findingsBefore).toContainEqual(
        expect.objectContaining({
          code: 'practice_review_insufficient_evidence',
          severity: 'warning',
        }),
      );
      expect(evaluation.findings).toContainEqual(
        expect.objectContaining({
          code: 'practice_review_insufficient_evidence',
          severity: 'warning',
        }),
      );
      expect(hasCurrentPreparedPractice(prepared.brief)).toBe(true);
      expect(harness.provider.practiceContentCalls).toBe(2);
      expect(evaluation.contentReview).toHaveLength(2);
      const calls = reviewCalls;
      const reused = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `generic-quality-reuse-${purpose}`),
      );
      expect(reused.status).toBe('reused');
      expect(reused.brief.id).toBe(prepared.brief.id);
      expect(reviewCalls).toBe(calls);
      expect(harness.provider.practiceContentCalls).toBe(2);
      const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        command: command(`generic-quality-execute-${purpose}`),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      });
      expect(ready.status).toBe('ready');
      expect(reviewCalls).toBe(calls);
    },
  );

  it.each(['network', 'false_explanation'] as const)(
    'keeps the currently proven original when a generic quality rewrite has %s failure',
    async (failure) => {
      const harness = await createHarness(0, 'pass', 'apply', 'pass_oriented');
      const generate = harness.provider.generatePracticeContent.bind(harness.provider);
      let optionalAttempts = 0;
      let original: ReturnType<typeof PracticeContentProposalPayloadSchema.parse> | undefined;
      harness.provider.generatePracticeContent = async (input, opts) => {
        const quality = input.editorialFindings?.some((finding) =>
          finding.problem.startsWith('practice_review_'),
        );
        if (quality) optionalAttempts++;
        if (quality && failure === 'network') throw ProviderError.network();
        const candidate = await generate(input, opts);
        if (!input.draftForReview) original = structuredClone(candidate);
        if (input.draftForReview && failure === 'false_explanation')
          candidate.items[0]!.retry.explanation += ' 补充运算：2 + 2 = 5。';
        return candidate;
      };
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      harness.provider.reviewTeachingContent = async (input, opts) => {
        const result = await review(input, opts);
        if (input.purpose === 'practice_grounding') {
          result.advisories = [
            {
              itemId: 'PR1',
              code: 'misconception',
              qualityAspect: 'style',
              problem: 'The correct feedback could use a more memorable teaching contrast.',
              repairInstruction:
                'Consider a clearer contrast while retaining the correct explanation.',
            },
          ];
          if (input.candidate.items[0]!.retry.explanation.includes('2 + 2 = 5'))
            result.findings = [
              {
                itemId: 'PR1.retry',
                code: 'weak_transfer',
                responsibility: 'grounding',
                problem: 'The rewritten explanation states the false sum 2 + 2 = 5.',
                repairInstruction: 'Use the correct sum 4.',
              },
            ];
        }
        return result;
      };
      const route = startTeachingRoute(harness);
      const prepared = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `generic-quality-fallback-${failure}`),
      );
      expect(optionalAttempts).toBe(1);
      const evaluation = prepared.brief.practice!.qualityEvaluation;
      expect(evaluation.qualityImprovement).toMatchObject({
        attempts: 1,
        outcome: failure === 'network' ? 'failed' : 'rejected',
      });
      expect(evaluation.contentReview).toHaveLength(1);
      expect(evaluation.answerabilityReview!.rounds).toHaveLength(1);
      expect(evaluation.integrityReview!.rounds).toHaveLength(1);
      expect(evaluation.groundingReview!.rounds).toHaveLength(1);
      expect(prepared.brief.practice!.items[0]!.retry.explanation).toBe(
        original!.items[0]!.retry.explanation,
      );
      expect(evaluation.findings).toContainEqual(
        expect.objectContaining({ code: 'practice_review_misconception', severity: 'warning' }),
      );
      expect(hasCurrentPreparedPractice(prepared.brief)).toBe(true);
      expect(prepared.brief.composition!.practiceLogicalCallId).not.toContain(
        'quality-improvement',
      );
    },
  );

  it('records Lesson public quality advisories without rerolling a current hard-valid Lesson', async () => {
    const harness = await createHarness(0, 'pass', 'apply', 'pass_oriented');
    Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    let publicReviews = 0;
    harness.provider.reviewTeachingContent = async (input, opts) => {
      const result = await review(input, opts);
      if (input.purpose === 'lesson_public') {
        publicReviews++;
        result.advisories = [
          {
            itemId: (input.candidate as LessonSlotContentProposalPayload).slots[0]!.slotId,
            code: 'insufficient_evidence',
            qualityAspect: 'richness',
            problem: 'The correct introduction could offer more teaching context.',
            repairInstruction: 'Consider another example without changing the established rule.',
          },
        ];
      }
      return result;
    };
    const route = startTeachingRoute(harness);
    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'lesson-generic-quality'),
    );
    const evaluation = prepared.brief.pedagogyEvaluation!;
    expect(publicReviews).toBe(1);
    expect(evaluation.contentReviewPolicyVersion).toBe(LESSON_CONTENT_REVIEW_POLICY_VERSION);
    expect(evaluation.contentReviewQualityDisposition).toBe('retained');
    expect(evaluation.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'lesson_review_insufficient_evidence' }),
    );
    expect(hasCurrentPreparedLesson(prepared.brief)).toBe(true);
    const obsolete = structuredClone(prepared.brief);
    obsolete.pedagogyEvaluation!.contentReviewPolicyVersion = 'teaching-content-review-v1';
    expect(hasCurrentPreparedLesson(obsolete)).toBe(false);
    const material = structuredClone(prepared.brief);
    material.pedagogyEvaluation!.contentReview!.at(-1)!.result.findings = [
      {
        itemId: 'L1',
        code: 'shallow_task',
        responsibility: 'integrity',
        problem: 'The public case result is disclosed before answering.',
        repairInstruction: 'Withhold the result until commitment.',
      },
    ];
    expect(hasCurrentPreparedLesson(material)).toBe(false);
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
      prepared.brief.composition!.acceptedLessonCheckpointId,
    )!;
    expect(checkpoint.lessonEvaluation.contentReview!.at(-1)!.result.advisories).toEqual(
      evaluation.contentReview!.at(-1)!.result.advisories,
    );
    const reused = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'lesson-generic-quality-reuse'),
    );
    expect(reused.status).toBe('reused');
    expect(publicReviews).toBe(1);
  });

  it.each([
    'insufficient_evidence',
    'accuracy',
    'grounding',
    'misconception',
    'answer_leak',
    'revealing_hint',
    'practice_replay',
    'shallow_task',
    'weak_transfer',
  ] as const)(
    'actual Hy3 review and checkpoint acceptance cannot discard material %s',
    async (code) => {
      const harness = await createHarness(0, 'pass', 'apply');
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      let itemId = '';
      harness.provider.generateLessonSlotContent = async (input, opts) => {
        const lesson = await generate(input, opts);
        const slot = lesson.slots.find((slot) => slot.workedProcess)!;
        itemId = slot.slotId;
        slot.workedProcess!.interaction!.activity.correctDebrief =
          '甲占用2后仍有3个空闲配额，因此乙可同时启动。';
        return lesson;
      };
      const groundingProvider = new Hy3Provider({
        baseUrl: 'https://example.test/v1',
        apiKey: 'offline-test',
        model: 'offline-review',
        timeoutMs: 1000,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decisions: [],
                      findings: [
                        {
                          itemId,
                          code,
                          problem:
                            'The delayed debrief is false: 4 minus 2 leaves 2, so the task requiring 3 waits.',
                          repairInstruction:
                            'Correct the current capacity and the delayed conclusion.',
                        },
                      ],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      });
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      harness.provider.reviewTeachingContent = (input, opts) =>
        input.purpose === 'lesson_grounding'
          ? groundingProvider.reviewTeachingContent(input, opts)
          : review(input, opts);
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `grounding-code-${code}`),
        ),
      ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
      expect(
        harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ n: 0 });
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
      expect(
        harness.services.teachingBriefPreparation.getAcceptedLessonPreview(
          preparationRequest(harness, route, `grounding-code-${code}`),
        ),
      ).toBeNull();
    },
  );

  it('accepts and exposes supported concise teaching with quality-only advisories through actual Hy3 review', async () => {
    const harness = await createHarness(0, 'pass', 'apply');
    const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
    harness.provider.generateLessonSlotContent = async (input, opts) => {
      const lesson = await generate(input, opts);
      const interaction = lesson.slots.find((slot) => slot.workedProcess)!.workedProcess!
        .interaction!;
      for (const action of [interaction.activity, interaction.scaffold, interaction.transfer])
        for (const option of action.options)
          option.feedbackIfSelected = option.id === action.correctOptionId ? '对。' : '不对。';
      return lesson;
    };
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    harness.provider.reviewTeachingContent = async (input, opts) => {
      if (input.purpose !== 'lesson_grounding') return review(input, opts);
      const actualFakeResult = await review(input, opts);
      expect(actualFakeResult.findings).toEqual([]);
      return new Hy3Provider({
        baseUrl: 'https://example.test/v1',
        apiKey: 'offline-test',
        model: 'offline-review',
        timeoutMs: 1000,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decisions: [],
                      findings: [],
                      advisories: [
                        {
                          itemId: input.candidate.slots[0]!.slotId,
                          code: 'shallow_task',
                          problem: 'Prefer longer feedback.',
                          repairInstruction: 'Optionally add detail.',
                        },
                        {
                          itemId: 'lesson.narrative',
                          code: 'weak_transfer',
                          problem: 'Prefer richer transfer.',
                          repairInstruction: 'Optionally add a second case.',
                        },
                      ],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      }).reviewTeachingContent(input, opts);
    };
    const route = startTeachingRoute(harness);
    const request = preparationRequest(harness, route, 'grounding-quality-only');
    const accepted = await harness.services.teachingBriefPreparation.prepare(request);
    expect(
      accepted.brief.pedagogyEvaluation!.groundingReview!.rounds.at(-1)!.result.advisories,
    ).toHaveLength(2);
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(
      (
        await harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, 'grounding-quality-reuse'),
        )
      ).status,
    ).toBe('reused');
    const exposed = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('grounding-quality-execution'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(exposed.status).toBe('ready');
    expect(exposed.lesson).not.toBeNull();
  });

  it('unknown Fake teaching cannot acquire a checkpoint or execution proof', async () => {
    const harness = await createHarness(0, 'pass', 'apply');
    const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
    harness.provider.generateLessonSlotContent = async (input, opts) => {
      const lesson = await generate(input, opts);
      lesson.slots.find((slot) => slot.workedProcess)!.workedProcess!.whyResultFollows =
        'This unknown hardware borrows capacity from a future processor state.';
      return lesson;
    };
    const route = startTeachingRoute(harness);
    const result = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('unknown-fake-execution'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(result.status).toBe('retry_available');
    expect(result.lesson).toBeNull();
    expect(harness.services.lessonExecution.get('ws_1', route.session.id).lesson).toBeNull();
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ n: 0 });
  });

  it.each([
    'guided_feedback',
    'guided_correction',
    'correct_debrief',
    'scaffold_feedback',
    'scaffold_debrief',
    'transfer_feedback',
    'transfer_debrief',
    'continuation',
    'result',
    'final_rationale',
    'check_feedback',
    'expected_signal',
    'summary',
    'forward_bridge',
  ] as const)(
    'rejects materially false delayed Lesson %s even with correct saved keys',
    async (field) => {
      const harness =
        field === 'check_feedback' || field === 'expected_signal'
          ? await ordinaryLessonHarness()
          : await createHarness(0, 'pass', 'apply');
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      const falseClaim = ' 补充运算：2 + 2 = 5。';
      harness.provider.generateLessonSlotContent = async (input, opts) => {
        const lesson = await generate(input, opts);
        const process = lesson.slots.find((slot) => slot.workedProcess)?.workedProcess;
        const interaction = process?.interaction;
        if (field === 'guided_feedback')
          interaction!.activity.options[0]!.feedbackIfSelected += falseClaim;
        else if (field === 'guided_correction')
          interaction!.activity.options.find(
            (option) => option.misconception,
          )!.misconception!.correction += falseClaim;
        else if (field === 'correct_debrief') interaction!.activity.correctDebrief += falseClaim;
        else if (field === 'scaffold_feedback')
          interaction!.scaffold.options[0]!.feedbackIfSelected += falseClaim;
        else if (field === 'scaffold_debrief') interaction!.scaffold.debrief += falseClaim;
        else if (field === 'transfer_feedback')
          interaction!.transfer.options[0]!.feedbackIfSelected += falseClaim;
        else if (field === 'transfer_debrief') interaction!.transfer.debrief += falseClaim;
        else if (field === 'continuation') process!.steps.at(-1)!.reason += falseClaim;
        else if (field === 'result') process!.result += falseClaim;
        else if (field === 'final_rationale') process!.whyResultFollows += falseClaim;
        else if (field === 'check_feedback')
          lesson.slots.find(
            (slot) => slot.informalCheck?.options,
          )!.informalCheck!.options![0]!.feedbackIfSelected += falseClaim;
        else if (field === 'expected_signal')
          lesson.slots.find((slot) => slot.informalCheck)!.informalCheck!.expectedSignal +=
            falseClaim;
        else if (field === 'summary') lesson.narrative!.summary += falseClaim;
        else lesson.narrative!.forwardBridge = (lesson.narrative!.forwardBridge ?? '') + falseClaim;
        return lesson;
      };
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      let groundings = 0;
      harness.provider.reviewTeachingContent = async (input, opts) => {
        const result = await review(input, opts);
        if (input.purpose !== 'lesson_grounding') return result;
        groundings += 1;
        expect(input.actionIds).toEqual([]);
        const slot = input.candidate.slots.find((slot) =>
          JSON.stringify(slot).includes(falseClaim.trim()),
        );
        expect(
          slot || JSON.stringify(input.candidate.narrative).includes(falseClaim.trim()),
        ).toBeTruthy();
        // The real Fake reviewer must reject this entire unsupported claim;
        // this wrapper observes the production result and supplies no verdict.
        expect(result.findings.length).toBeGreaterThan(0);
        return result;
      };
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `false-delayed-${field}`),
        ),
      ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
      // The same still-failing candidate reuses its exact negative review; it
      // cannot reroll a passing judgment or exceed the existing candidate budget.
      expect(groundings).toBe(1);
      expect(harness.provider.practiceContentCalls).toBe(0);
      expect(
        harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ n: 0 });
    },
  );

  it('accepts concise correct delayed teaching and intentional distractors with a current Fake grounding proof', async () => {
    const harness = await createHarness(0, 'pass', 'apply');
    const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
    harness.provider.generateLessonSlotContent = async (input, opts) => {
      const lesson = await generate(input, opts);
      const interaction = lesson.slots.find((slot) => slot.workedProcess)!.workedProcess!
        .interaction!;
      for (const action of [interaction.activity, interaction.scaffold, interaction.transfer])
        for (const option of action.options)
          option.feedbackIfSelected = option.id === action.correctOptionId ? '对。' : '不对。';
      return lesson;
    };
    let groundings = 0;
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    harness.provider.reviewTeachingContent = async (input, opts) => {
      if (input.purpose === 'lesson_grounding') {
        groundings += 1;
        const interaction = input.candidate.slots.find((slot) => slot.workedProcess)!.workedProcess!
          .interaction!;
        expect(interaction.activity.options.some((option) => option.misconception !== null)).toBe(
          true,
        );
        expect(interaction.activity.options[0]!.feedbackIfSelected).toBe('对。');
      }
      return review(input, opts);
    };
    const route = startTeachingRoute(harness);
    const request = preparationRequest(harness, route, 'concise-delayed-lesson');
    const prepared = await harness.services.teachingBriefPreparation.prepare(request);
    expect(hasCurrentPreparedLesson(prepared.brief)).toBe(true);
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
      prepared.brief.composition!.acceptedLessonCheckpointId,
    )!;
    const proof = checkpoint.lessonEvaluation.groundingReview!;
    expect(proof.rounds).toHaveLength(1);
    expect(proof.checkpointContextHash).toMatch(/^sha256:/u);
    expect(proof.exposureContextHash).toMatch(/^sha256:/u);
    const context = harness.provider.lastLessonContentInput!;
    expect(
      prepareLessonGroundingReview(context, checkpointLessonCandidate(checkpoint)).inputHash,
    ).toBe(proof.rounds[0]!.inputHash);
    expect(() =>
      assertPreparedLessonGrounding(checkpointLessonCandidate(checkpoint), context, proof),
    ).not.toThrow();
    expect(await harness.services.teachingBriefPreparation.prepare(request)).toEqual(prepared);
    expect(
      (
        await harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, 'reuse-grounded-lesson'),
        )
      ).status,
    ).toBe('reused');
    expect(groundings).toBe(1);
    expect(hasCurrentPreparedPractice(prepared.brief)).toBe(true);
  });

  it('checks actual execution replay and resets incompatible Lesson responses on current regeneration', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const ensure = {
      command: command('grounded-execution'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    };
    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensure);
    const start = {
      ...ensure,
      command: command('grounded-start'),
      expectedLessonStateVersion: ready.progress!.stateVersion,
      action: { kind: 'start_lesson' as const },
    };
    const started = await harness.services.lessonExecution.command('ws_1', route.session.id, start);
    const present = {
      ...start,
      command: command('grounded-present'),
      expectedSessionVersion: started.session.version,
      expectedAgendaVersion: started.agenda.version,
      expectedLessonStateVersion: started.progress!.stateVersion,
      action: { kind: 'move_to_segment' as const, segmentIndex: 0 },
    };
    const presented = await harness.services.lessonExecution.command(
      'ws_1',
      route.session.id,
      present,
    );
    const cachedCommand = {
      ...present,
      command: command('cached-grounded-present'),
      expectedSessionVersion: presented.session.version,
      expectedAgendaVersion: presented.agenda.version,
      expectedLessonStateVersion: presented.progress!.stateVersion,
    };
    // Seed a completed receipt through the real command service at current
    // route versions, so replay reaches the exposure gate rather than the
    // earlier Session-version fence.
    const cachedClaim = harness.services.courseCommands.begin(
      cachedCommand.command,
      'lesson_execution_command',
      {
        sessionId: route.session.id,
        expectedSessionVersion: cachedCommand.expectedSessionVersion,
        expectedAgendaVersion: cachedCommand.expectedAgendaVersion,
        expectedAgendaItemId: cachedCommand.expectedAgendaItemId,
        expectedLessonStateVersion: cachedCommand.expectedLessonStateVersion,
        action: cachedCommand.action,
      },
      { studySessionId: route.session.id },
    );
    harness.services.courseCommands.complete(cachedClaim, () => presented);
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const brief = harness.repos.teachingBriefs.get(state.teachingBriefId!)!;
    brief.segments[0]!.explanation += ' Changed after grounding.';
    harness.db
      .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
      .run(JSON.stringify(brief), brief.id);
    expect(harness.services.lessonExecution.get('ws_1', route.session.id).lesson).toBeNull();
    expect(harness.services.lessonExecution.tutorContext('ws_1', route.session.id)).toBeNull();
    const replay = await harness.services.lessonExecution.command(
      'ws_1',
      route.session.id,
      cachedCommand,
    );
    expect(replay.status).toBe('preparation_needed');
    expect(replay.lesson).toBeNull();
    const renewed = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      ...ensure,
      command: command('regenerate-current-grounding'),
      expectedSessionVersion: presented.session.version,
      expectedAgendaVersion: presented.agenda.version,
    });
    expect(renewed.status, renewed.message ?? '').toBe('ready');
    expect(renewed.progress!.presentedSegmentIndexes).toEqual([]);
    expect(renewed.progress!.currentSegmentIndex).toBe(0);
    expect(renewed.progress!.presentationCompletedAt).toBeNull();
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id)!
        .informalInteractions,
    ).toEqual([]);
    expect(harness.provider.lessonContentCalls).toBe(1);
  });

  it('invalidates accepted, cached and executable Lesson proof when current concept context changes', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const request = preparationRequest(harness, route, 'grounding-context-original');
    const prepared = await harness.services.teachingBriefPreparation.prepare(request);
    const ensure = {
      command: command('grounding-context-bound'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    };
    expect(
      (await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensure)).status,
    ).toBe('ready');
    harness.db
      .prepare('UPDATE concepts SET summary=? WHERE id=?')
      .run('Changed concept context.', 'con_1');
    expect(harness.services.teachingBriefPreparation.getAcceptedLessonPreview(request)).toBeNull();
    expect(harness.services.teachingBriefPreparation.getCurrent(request)).toBeNull();
    expect(harness.services.lessonExecution.get('ws_1', route.session.id).lesson).toBeNull();
    expect(harness.services.lessonExecution.tutorContext('ws_1', route.session.id)).toBeNull();
    await expect(harness.services.teachingBriefPreparation.prepare(request)).rejects.toMatchObject({
      code: ApiErrorCode.VersionConflict,
    });
    const renewed = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      ...ensure,
      command: command('grounding-context-renewed'),
    });
    expect(renewed.status).toBe('ready');
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const current = harness.repos.teachingBriefs.get(state.teachingBriefId!)!;
    expect(current.composition!.acceptedLessonCheckpointId).not.toBe(
      prepared.brief.composition!.acceptedLessonCheckpointId,
    );
    expect(hasCurrentPreparedLesson(current)).toBe(true);
    expect(harness.provider.lessonContentCalls).toBe(2);
    // Grounding context participates in reuse identity even when excerpts and
    // slot planning remain the same.
    expect(current.sourceContextFingerprint).not.toBe(prepared.brief.sourceContextFingerprint);
  });

  it('rejects context changes during the final Lesson grounding call before checkpoint acceptance', async () => {
    const harness = await createHarness();
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    harness.provider.reviewTeachingContent = async (input, opts) => {
      const result = await review(input, opts);
      if (input.purpose === 'lesson_grounding')
        harness.db
          .prepare('UPDATE concepts SET summary=? WHERE id=?')
          .run('Changed during grounding.', 'con_1');
      return result;
    };
    const route = startTeachingRoute(harness);
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'grounding-context-race'),
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({
      count: 0,
    });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
  });

  it.each([true, false])(
    'requires complete grounding for computed capsule acceptance (correct=%s)',
    async (correct) => {
      const harness = await createHarness(0, 'pass', 'apply');
      Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
      const generatePractice = harness.provider.generatePracticeContent.bind(harness.provider);
      harness.provider.generatePracticeContent = async (input, opts) => {
        if (
          input.draftForReview &&
          input.editorialFindings?.some((finding) => finding.problem.startsWith('practice_review_'))
        )
          throw ProviderError.network();
        return generatePractice(input, opts);
      };
      Object.assign(harness.provider, {
        generateTeachingCapsule: async (
          input: TeachingCapsuleGenerationInput,
          opts?: ProviderCallOptions,
        ) => {
          opts?.onRequestSent?.();
          const fake = new FakeProvider();
          const lesson = await fake.generateLessonSlotContent(input.lesson);
          const process = lesson.slots.find((slot) => slot.workedProcess)!.workedProcess!;
          if (!correct) process.interaction!.transfer.debrief += ' 补充运算：2 + 2 = 5。';
          const practice = await fake.generatePracticeContent({
            workspaceName: input.lesson.workspaceName,
            learnerLocale: input.lesson.learnerLocale,
            courseDesign: input.lesson.courseDesign,
            sourceContext: input.lesson.sourceContext,
            visualContext: input.lesson.visualContext,
            acceptedLesson: [...input.priorLesson, ...lesson.slots],
            skeleton: {
              ...input.lesson.skeleton,
              practicePlan: {
                schemaVersion: 1,
                slots: input.practiceSlots,
                activityBudget: { minMinutes: 1, maxMinutes: 1 },
              },
            },
          });
          return { lesson, practice };
        },
      });
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      let groundingCalls = 0;
      harness.provider.reviewTeachingContent = async (input, opts) => {
        const result = await review(input, opts);
        if (input.purpose === 'lesson_public')
          result.advisories = [
            {
              itemId: (input.candidate as LessonSlotContentProposalPayload).slots[0]!.slotId,
              code: 'revealing_hint',
              qualityAspect: 'style',
              problem: 'Correct delayed coaching could invite more independent reflection.',
              repairInstruction: 'Consider a less explicit coaching style after a wrong answer.',
            },
          ];
        if (input.purpose === 'practice_grounding')
          result.advisories = [
            {
              itemId: 'PR1',
              code: 'insufficient_evidence',
              qualityAspect: 'richness',
              problem: 'The correct computed task could explore another constraint.',
              repairInstruction: 'Consider another constraint without changing the sound rule.',
            },
          ];
        if (input.purpose !== 'lesson_grounding') return result;
        groundingCalls += 1;
        expect(input.computedOutcomes).toBe(true);
        const slot = input.candidate.slots.find((slot) => slot.workedProcess)!;
        expect(slot.workedProcess!.steps.length).toBeGreaterThan(1);
        if (!correct)
          expect(slot.workedProcess!.interaction!.transfer.debrief).toContain('2 + 2 = 5');
        expect(result.findings.length > 0).toBe(!correct);
        return result;
      };
      const route = startTeachingRoute(harness);
      const pending = harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `computed-lesson-grounding-${correct}`),
      );
      if (correct) {
        const prepared = await pending;
        expect(hasCurrentPreparedLesson(prepared.brief)).toBe(true);
        expect(prepared.brief.pedagogyEvaluation!.jointAuthoring!.executionVerified).toBe(true);
        expect(prepared.brief.pedagogyEvaluation!.contentReviewQualityDisposition).toBe('retained');
        expect(prepared.brief.practice!.qualityEvaluation.qualityImprovement).toMatchObject({
          attempts: 1,
          outcome: 'failed',
        });
        expect(hasCurrentPreparedPractice(prepared.brief)).toBe(true);
        expect(prepared.brief.composition!.practiceLogicalCallId).toMatch(/:capsule-\d+$/u);
        expect(prepared.brief.practice!.qualityEvaluation.contentReview).toHaveLength(1);
        expect(prepared.brief.pedagogyEvaluation!.groundingReview!.rounds).toHaveLength(1);
        expect(
          (
            await harness.services.teachingBriefPreparation.prepare(
              preparationRequest(harness, route, 'computed-grounding-reuse'),
            )
          ).status,
        ).toBe('reused');
      } else {
        await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
        expect(
          harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
        ).toEqual({ n: 0 });
      }
      expect(groundingCalls).toBe(1);
    },
  );

  it.each(['network', 'cancel', 'inventory'] as const)(
    'keeps grounding failure %s retryable without accepting or exposing a Lesson',
    async (failure) => {
      const harness = await createHarness();
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      harness.provider.reviewTeachingContent = async (input, opts) => {
        if (input.purpose !== 'lesson_grounding') return review(input, opts);
        if (failure === 'network') throw ProviderError.network();
        if (failure === 'cancel') throw ProviderError.cancelled();
        return {
          decisions: [
            {
              actionId: 'L1.check',
              answerId: 'A',
              requiresCaseInference: true,
              evidenceUsed: 'An authored answer cannot certify grounding.',
            },
          ],
          findings: [],
        };
      };
      const route = startTeachingRoute(harness);
      const request = {
        command: command(`grounding-failure-${failure}`),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      };
      const pending = harness.services.lessonExecution.ensure('ws_1', route.session.id, request);
      if (failure === 'cancel')
        await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
      else expect((await pending).status).toBe('retry_available');
      expect(harness.services.lessonExecution.get('ws_1', route.session.id).lesson).toBeNull();
      expect(
        harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ n: 0 });
      harness.provider.reviewTeachingContent = review;
      expect(
        (
          await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
            ...request,
            command: command(`grounding-recovered-${failure}`),
          })
        ).status,
      ).toBe('ready');
    },
  );
  it.each(
    (['initial', 'retry'] as const).flatMap((surface) =>
      (['explanation', 'feedback'] as const).map((claim) => ({ surface, claim })),
    ),
  )(
    'rejects an answerable Practice with a correct key but wrong $surface $claim',
    async ({ surface, claim }) => {
      const harness = await createHarness();
      const generate = harness.provider.generatePracticeContent.bind(harness.provider);
      const keys = new Map<string, string>();
      harness.provider.generatePracticeContent = async (input, opts) => {
        const candidate = await generate(input, opts);
        for (const item of candidate.items)
          for (const name of ['initial', 'retry'] as const)
            keys.set(`${item.practiceSlotId}.${name}`, item[name].correctOptionRef);
        const target = candidate.items[0]![surface];
        if (claim === 'explanation') target.explanation = '计算说明：2 + 2 = 5。';
        else target.options[0]!.feedbackIfSelected = '本选项的计算依据是 2 + 2 = 5。';
        return candidate;
      };
      const requests: TeachingContentReviewInput[] = [];
      const decisions: TeachingContentReview['decisions'] = [];
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      harness.provider.reviewTeachingContent = async (input, opts) => {
        requests.push(structuredClone(input));
        const result = await review(input, opts);
        if (input.purpose === 'practice_answerability') decisions.push(...result.decisions);
        if (input.purpose === 'practice_grounding') {
          // A finite arithmetic review stub inspects the actual production packet,
          // never a separately supplied field or the test's generation flag.
          const item = input.candidate.items.find((item) =>
            [
              item[surface].explanation,
              ...item[surface].options.map((option) => option.feedbackIfSelected),
            ].some((text) => text.includes('2 + 2 = 5')),
          );
          if (item)
            return {
              decisions: [],
              findings: [
                {
                  itemId: `${item.practiceSlotId}.${surface}`,
                  code: 'accuracy',
                  problem: 'The teaching claim 2 + 2 = 5 is false; the sum is 4.',
                  responsibility: 'grounding',
                  repairInstruction: 'Correct the explanation and option feedback.',
                },
              ],
            };
        }
        return result;
      };
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `wrong-teaching-${surface}-${claim}`),
        ),
      ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
      expect(decisions.length).toBeGreaterThan(0);
      for (const decision of decisions) expect(decision.answerId).toBe(keys.get(decision.actionId));
      const rich = requests.find((input) => input.purpose === 'practice_grounding')!;
      expect(JSON.stringify(rich)).toContain('2 + 2 = 5');
      for (const input of requests.filter((input) => input.purpose !== 'practice_grounding')) {
        expect(JSON.stringify(input)).not.toContain('2 + 2 = 5');
        if (input.purpose === 'practice_answerability')
          expect(JSON.stringify(input.candidate)).not.toMatch(
            /correctOptionRef|feedbackIfSelected|"application"|"explanation"/u,
          );
      }
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
      expect(
        harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ count: 1 });
    },
  );

  it.each([true, false])(
    'grounds authored application rules independently of the correct public key (rule correct=%s)',
    async (correct) => {
      const harness = await createHarness(0, 'pass', 'apply');
      const generate = harness.provider.generatePracticeContent.bind(harness.provider);
      const rule = `补充计算规则：2 + 2 = ${correct ? '4' : '5'}。`;
      harness.provider.generatePracticeContent = async (input, opts) => {
        const candidate = await generate(input, opts);
        candidate.items[0]!.application!.sourceRuleOrProcedure += rule;
        return candidate;
      };
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      let reviewedRule = false;
      harness.provider.reviewTeachingContent = async (input, opts) => {
        const result = await review(input, opts);
        if (input.purpose !== 'practice_grounding') {
          expect(JSON.stringify(input)).not.toContain(rule);
          return result;
        }
        const item = input.candidate.items.find((item) =>
          item.application?.sourceRuleOrProcedure.includes('补充计算规则'),
        )!;
        expect(item.application!.sourceRuleOrProcedure).toContain(rule);
        reviewedRule = true;
        if (!item.application!.sourceRuleOrProcedure.includes('2 + 2 = 5')) return result;
        return {
          decisions: [],
          findings: [
            {
              itemId: item.practiceSlotId,
              code: 'accuracy',
              problem: 'The authored rule computes 2 + 2 incorrectly.',
              responsibility: 'grounding',
              repairInstruction: 'Use 4 in the authored rule.',
            },
          ],
        };
      };
      const route = startTeachingRoute(harness);
      const prepared = harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `authored-rule-${correct}`),
      );
      if (correct) {
        const { brief } = await prepared;
        expect(hasCurrentPreparedPractice(brief)).toBe(true);
        expect(brief.practice!.items[0]!.application!.sourceRuleOrProcedure).toContain(rule);
        brief.practice!.items[0]!.application!.sourceRuleOrProcedure += ' 后改的规则。';
        expect(hasCurrentPracticeAnswerabilityReview(brief)).toBe(true);
        expect(hasCurrentPreparedPractice(brief)).toBe(false);
      } else {
        await expect(prepared).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
        expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual(
          [],
        );
      }
      expect(reviewedRule).toBe(true);
    },
  );

  it('accepts correct concise and repetitive Practice feedback with complete grounding through preparation and reuse', async () => {
    const harness = await createHarness();
    const generate = harness.provider.generatePracticeContent.bind(harness.provider);
    harness.provider.generatePracticeContent = async (input, opts) => {
      const candidate = await generate(input, opts);
      for (const item of candidate.items)
        for (const name of ['initial', 'retry'] as const) {
          const surface = item[name];
          surface.explanation = '按题面条件计算。';
          for (const option of surface.options)
            option.feedbackIfSelected =
              option.optionRef === surface.correctOptionRef ? '对。' : '不对。';
        }
      return candidate;
    };
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    let groundingCalls = 0;
    harness.provider.reviewTeachingContent = async (input, opts) => {
      if (input.purpose === 'practice_grounding') {
        groundingCalls += 1;
        for (const item of input.candidate.items)
          for (const name of ['initial', 'retry'] as const) {
            const surface = item[name];
            expect(surface.explanation).toBe('按题面条件计算。');
            for (const option of surface.options)
              expect(option.feedbackIfSelected).toBe(
                option.optionRef === surface.correctOptionRef ? '对。' : '不对。',
              );
          }
      }
      return review(input, opts);
    };
    const route = startTeachingRoute(harness);
    const request = preparationRequest(harness, route, 'concise-grounded-feedback');
    const prepared = await harness.services.teachingBriefPreparation.prepare(request);
    expect(groundingCalls).toBe(1);
    expect(hasCurrentPreparedPractice(prepared.brief)).toBe(true);
    expect(prepared.brief.practice!.qualityEvaluation.groundingReview!.savedContextHash).toMatch(
      /^sha256:/u,
    );
    const reused = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'reuse-concise-grounded-feedback'),
    );
    expect(reused.status).toBe('reused');
    expect(reused.brief.id).toBe(prepared.brief.id);
    expect(groundingCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
  });

  it('refuses optional quality fallback when the original explanation lacks complete grounding', async () => {
    const { harness, qualityRequests } = await aggregateQualityHarness('network', undefined, {
      depth: 'working_fluency',
      operation: 'recognize',
    });
    const generate = harness.provider.generatePracticeContent.bind(harness.provider);
    harness.provider.generatePracticeContent = async (input, opts) => {
      const candidate = await generate(input, opts);
      candidate.items[0]!.initial.explanation = '计算说明：2 + 2 = 5。';
      return candidate;
    };
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    harness.provider.reviewTeachingContent = async (input, opts) => {
      const result = await review(input, opts);
      if (
        input.purpose === 'practice_grounding' &&
        input.candidate.items[0]!.initial.explanation.includes('2 + 2 = 5')
      )
        return {
          decisions: [],
          findings: [
            {
              itemId: 'PR1',
              code: 'accuracy',
              problem: 'False sum in the original explanation.',
              responsibility: 'grounding',
              repairInstruction: 'Correct the sum.',
            },
          ],
        };
      return result;
    };
    const route = startTeachingRoute(harness);
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'ungrounded-original-quality-fallback'),
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
    expect(qualityRequests).toEqual([]);
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
  });

  it.each(['timeout', 'invalid inventory', 'unavailable'] as const)(
    'cannot persist unresolved references when material review has %s',
    async (failure) => {
      const harness = await ordinaryLessonHarness();
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      harness.provider.generateLessonSlotContent = async (input, opts) => {
        const lesson = await generate(input, opts);
        breakLessonChoice(lesson.slots, 'absent_references');
        return lesson;
      };
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      harness.provider.reviewTeachingContent = async (input, opts) => {
        if (!('stage' in input) || input.stage !== 'lesson') return review(input, opts);
        opts?.onRequestSent?.();
        if (failure === 'timeout') throw ProviderError.timeout(30000);
        if (failure === 'unavailable') throw new Error('Offline review unavailable');
        return { decisions: [], findings: [] };
      };
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, 'fail-closed-reference-' + failure),
        ),
      ).rejects.toThrow();
      expect(
        harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ n: 0 });
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
      expect(harness.provider.lessonContentCalls).toBe(1);
      expect(harness.provider.practiceContentCalls).toBe(0);
    },
  );

  it.each([
    'Compare options D and E as letter labels and state which letter comes first alphabetically.',
    'Order option D and option E by the last letter in each printed heading.',
    'Explain how option D functions as a source heading.',
    '比较选项D和选项E这两个标题的字母，并说明它们的区别。',
    '说明选项D这个标识符的字符数。',
  ])('prepares and reuses reviewed label-level tasks: %s', async (prompt) => {
    const harness = await ordinaryLessonHarness();
    const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
    const adaptLessonFixture = (lesson: LessonSlotContentProposalPayload) => {
      const check = lesson.slots.find((slot) => slot.informalCheck)!.informalCheck!;
      check.kind = 'own_words';
      check.prompt += ' ' + prompt;
      delete check.options;
      delete check.correctOptionId;
      delete check.evidenceContrast;
      return lesson;
    };
    harness.provider.generateLessonSlotContent = async (input, opts) =>
      adaptLessonFixture(await generate(input, opts));
    installKnownLessonVariant(harness, adaptLessonFixture);
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    let lessonReviews = 0;
    harness.provider.reviewTeachingContent = async (input, opts) => {
      if ('stage' in input && input.stage === 'lesson' && input.purpose !== 'lesson_grounding') {
        lessonReviews++;
        expect(JSON.stringify(input.candidate)).toContain(prompt);
        expect(JSON.stringify(input.candidate)).not.toContain('semanticRelations');
      }
      return review(input, opts);
    };
    const route = startTeachingRoute(harness);
    const request = preparationRequest(harness, route, 'reviewed-label-level');
    const prepared = await harness.services.teachingBriefPreparation.prepare(request);
    expect(lessonReviews).toBe(1);
    expect(prepared.brief.pedagogyEvaluation!.contentReview).toHaveLength(1);
    expect(hasCurrentPreparedLesson(prepared.brief)).toBe(true);
    expect(await harness.services.teachingBriefPreparation.prepare(request)).toEqual(prepared);
    expect(
      (
        await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
          command: command('bind-reviewed-labels'),
          expectedSessionVersion: route.session.version,
          expectedAgendaVersion: route.agenda.version,
          expectedAgendaItemId: route.agendaItem.id,
        })
      ).status,
    ).toBe('ready');
    expect(lessonReviews).toBe(1);
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    const missingReview = structuredClone(prepared.brief);
    delete missingReview.pedagogyEvaluation!.contentReview;
    expect(hasCurrentPreparedLesson(missingReview)).toBe(false);
  });

  it('prepares, replays and binds answerable open Lesson reasoning with the existing call budget', async () => {
    const harness = await ordinaryLessonHarness();
    const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
    const adaptLessonFixture = (lesson: LessonSlotContentProposalPayload) => {
      const check = lesson.slots.find((slot) => slot.informalCheck)!.informalCheck!;
      check.kind = 'own_words';
      delete check.options;
      delete check.correctOptionId;
      delete check.evidenceContrast;
      check.prompt += '请解释你的设计决定，并给出依据。';
      return lesson;
    };
    harness.provider.generateLessonSlotContent = async (input, opts) =>
      adaptLessonFixture(await generate(input, opts));
    installKnownLessonVariant(harness, adaptLessonFixture);
    const route = startTeachingRoute(harness);
    const request = preparationRequest(harness, route, 'open-lesson-preparation');
    const prepared = await harness.services.teachingBriefPreparation.prepare(request);
    expect(hasCurrentPreparedLesson(prepared.brief)).toBe(true);
    const check = prepared.brief.segments.find((segment) => segment.informalCheck)!.informalCheck!;
    expect(check.kind).toBe('own_words');
    expect(check).not.toHaveProperty('options');
    expect(prepared.brief.pedagogyEvaluation!.findings).toContainEqual(
      expect.objectContaining({ code: 'reasoning_choice_missing', severity: 'warning' }),
    );
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    expect(await harness.services.teachingBriefPreparation.prepare(request)).toEqual(prepared);
    expect(harness.services.teachingBriefPreparation.getCurrent(request)?.id).toBe(
      prepared.brief.id,
    );
    const bound = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('open-lesson-bound'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(bound.status).toBe('ready');
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
  });

  it.each(['visible text', 'serialized relation'] as const)(
    'enforces the exposure boundary for %s at preparation and stored replay/execution',
    async (placement) => {
      const harness = await ordinaryLessonHarness();
      const definitions =
        'Option D means retain a candidate with score 80; Option E means retain a candidate with score 40.';
      reviewMissingAlternativeContents(harness, definitions);
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      const adaptLessonFixture = (lesson: LessonSlotContentProposalPayload) => {
        const check = lesson.slots.find((slot) => slot.informalCheck)!.informalCheck!;
        check.kind = 'own_words';
        delete check.options;
        delete check.correctOptionId;
        delete check.evidenceContrast;
        check.prompt += '请比较选项D和E，并说明哪种方案能满足检索条件。';
        if (placement === 'visible text') lesson.slots[0]!.explanation += ' ' + definitions;
        else
          lesson.slots
            .find((slot) => slot.semanticRelations.length)!
            .semanticRelations.push({
              kind: 'condition_action',
              fromProposition: definitions,
              toProposition: 'The retrieval threshold determines which result survives.',
              relevanceToObjective: 'Use the retrieval condition to justify the decision.',
              sourceRefs: [],
            });
        return lesson;
      };
      harness.provider.generateLessonSlotContent = async (input, opts) =>
        adaptLessonFixture(await generate(input, opts));
      installKnownLessonVariant(harness, adaptLessonFixture);
      const route = startTeachingRoute(harness);
      const request = preparationRequest(harness, route, 'exposure-preparation-' + placement);
      if (placement === 'serialized relation') {
        await expect(
          harness.services.teachingBriefPreparation.prepare(request),
        ).rejects.toMatchObject({
          code: ApiErrorCode.ProviderInvalidOutput,
          details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
        });
        expect(
          harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
        ).toEqual({ n: 0 });
        expect(harness.provider.practiceContentCalls).toBe(0);
        return;
      }
      const prepared = await harness.services.teachingBriefPreparation.prepare(request);
      expect(hasCurrentPreparedLesson(prepared.brief)).toBe(true);
      expect(await harness.services.teachingBriefPreparation.prepare(request)).toEqual(prepared);
      const ensureRequest = {
        command: command('bind-visible-definitions'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      };
      expect(
        (await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest))
          .status,
      ).toBe('ready');

      // Moving the exact same definition into non-rendered metadata must revoke
      // active authority, even while current versions and the checkpoint remain.
      const hidden = structuredClone(prepared);
      const segment = hidden.brief.segments[0]!;
      segment.explanation = segment.explanation.replace(' ' + definitions, '');
      segment.semanticRelations = [
        ...(segment.semanticRelations ?? []),
        {
          kind: 'condition_action',
          fromProposition: definitions,
          toProposition: 'The retrieval threshold determines which result survives.',
          relevanceToObjective: 'Use the retrieval condition to justify the decision.',
          sourceRefIds: [],
        },
      ];
      expect(hasCurrentPreparedLesson(hidden.brief)).toBe(false);
      harness.db
        .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
        .run(JSON.stringify(hidden.brief), hidden.brief.id);
      const operation = harness.repos.operations.getByIdempotencyKey(
        'ws_1',
        'teaching-brief:' + harness.learningUnitId + ':' + request.commandId,
      )!;
      harness.db
        .prepare('UPDATE agent_operation_results SET payload=? WHERE operation_id=?')
        .run(JSON.stringify(hidden), operation.id);
      const bytes = JSON.stringify(harness.repos.teachingBriefs.get(hidden.brief.id));
      const calls = [harness.provider.lessonContentCalls, harness.provider.practiceContentCalls];
      await expect(
        harness.services.teachingBriefPreparation.prepare(request),
      ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
      expect(harness.services.teachingBriefPreparation.getCurrent(request)).toBeNull();
      expect(harness.services.lessonExecution.get('ws_1', route.session.id).status).toBe(
        'preparation_needed',
      );
      expect(
        (await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest))
          .status,
      ).toBe('preparation_needed');
      expect([harness.provider.lessonContentCalls, harness.provider.practiceContentCalls]).toEqual(
        calls,
      );
      expect(JSON.stringify(harness.repos.teachingBriefs.get(hidden.brief.id))).toBe(bytes);
    },
  );

  it.each(['missing_pair', 'hidden_key', 'absent_references', 'missing_key', 'binding'] as const)(
    'rejects a %s Lesson returned after the provider validation callback before saving a checkpoint',
    async (defect) => {
      const harness = await ordinaryLessonHarness();
      if (defect === 'absent_references') reviewMissingAlternativeContents(harness);
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      harness.provider.generateLessonSlotContent = async (input, opts) => {
        const lesson = await generate(input, opts);
        breakLessonChoice(lesson.slots, defect);
        return lesson;
      };
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `bypass-${defect}`),
        ),
      ).rejects.toMatchObject({
        code: ApiErrorCode.ProviderInvalidOutput,
        details: {
          candidateFailure: {
            kind:
              defect === 'absent_references'
                ? 'teaching_content_review_failed'
                : 'lesson_choice_contract_rejection',
          },
        },
      });
      expect(
        harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ n: 0 });
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
      expect(harness.provider.lessonContentCalls).toBe(defect === 'absent_references' ? 2 : 1);
      expect(harness.provider.practiceContentCalls).toBe(0);
    },
  );

  it('rejects hidden choices from a capsule provider that bypasses its validation callback', async () => {
    const harness = await createHarness(0, 'pass', 'explain', 'pass_oriented');
    Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
    let capsules = 0;
    Object.assign(harness.provider, {
      generateTeachingCapsule: async (
        input: TeachingCapsuleGenerationInput,
        opts?: ProviderCallOptions,
      ) => {
        capsules++;
        opts?.onRequestSent?.();
        const provider = new FakeProvider();
        const lesson = await provider.generateLessonSlotContent(input.lesson);
        const practice = input.practiceSlots.length
          ? await provider.generatePracticeContent({
              ...input.lesson,
              skeleton: {
                ...input.lesson.skeleton,
                practicePlan: {
                  schemaVersion: 1,
                  slots: input.practiceSlots,
                  activityBudget: { minMinutes: 1, maxMinutes: 1 },
                },
              },
              acceptedLesson: [...input.priorLesson, ...lesson.slots],
            })
          : { items: [] };
        breakLessonChoice(lesson.slots, 'hidden_key');
        return { lesson, practice };
      },
    });
    const route = startTeachingRoute(harness);
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'capsule-choice-bypass'),
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
    expect(capsules).toBe(1);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ n: 0 });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
  });

  it.each([
    'evaluator',
    'prompt',
    'choice_context',
    'missing_pair',
    'hidden_key',
    'absent_references',
    'grounding_missing',
    'grounding_version',
    'grounding_result',
    'grounding_input',
    'grounding_candidate',
    'grounding_claims',
    'grounding_exposure',
  ] as const)(
    'fences stored Lesson %s from completed replay, fresh reuse and ready bound execution',
    async (defect) => {
      const harness = await ordinaryLessonHarness();
      const route = startTeachingRoute(harness);
      const request = preparationRequest(harness, route, `lesson-current-${defect}`);
      const prepared = await harness.services.teachingBriefPreparation.prepare(request);
      const ensureRequest = {
        command: command(`bound-lesson-${defect}`),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      };
      expect(
        (await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest))
          .status,
      ).toBe('ready');
      const state = harness.repos.lessonExecution.getForSession(
        route.session.id,
        route.agendaItem.id,
      )!;
      const old = structuredClone(prepared);
      if (defect === 'evaluator')
        old.brief.pedagogyEvaluation!.policyVersion = 'lesson-pedagogy-v9-scientific-notation';
      else if (defect === 'prompt')
        old.brief.composition!.lessonPromptVersion =
          'teaching-lesson-content-v18-source-faithful-models';
      else if (defect === 'choice_context')
        delete old.brief.pedagogyEvaluation!.choiceContextFingerprint;
      else if (
        defect === 'grounding_missing' ||
        defect === 'grounding_version' ||
        defect === 'grounding_result' ||
        defect === 'grounding_input' ||
        defect === 'grounding_candidate' ||
        defect === 'grounding_claims' ||
        defect === 'grounding_exposure'
      )
        breakLessonGrounding(old.brief.pedagogyEvaluation!, defect);
      else breakLessonChoice(old.brief.segments, defect);
      expect(hasCurrentPreparedLesson(old.brief)).toBe(false);
      harness.db
        .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
        .run(JSON.stringify(old.brief), old.brief.id);
      const operation = harness.repos.operations.getByIdempotencyKey(
        'ws_1',
        `teaching-brief:${harness.learningUnitId}:${request.commandId}`,
      )!;
      harness.db
        .prepare('UPDATE agent_operation_results SET payload=? WHERE operation_id=?')
        .run(JSON.stringify(old), operation.id);
      const originalBytes = JSON.stringify(harness.repos.teachingBriefs.get(old.brief.id));
      const calls = [harness.provider.lessonContentCalls, harness.provider.practiceContentCalls];
      await expect(
        harness.services.teachingBriefPreparation.prepare(request),
      ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
      expect(harness.services.teachingBriefPreparation.getCurrent(request)).toBeNull();
      const fenced = harness.services.lessonExecution.get('ws_1', route.session.id);
      expect(fenced.status).toBe('preparation_needed');
      expect(fenced.lesson).toBeNull();
      await expect(
        harness.services.lessonExecution.command('ws_1', route.session.id, {
          command: command(`old-lesson-action-${defect}`),
          expectedSessionVersion: route.session.version,
          expectedAgendaVersion: route.agenda.version,
          expectedAgendaItemId: route.agendaItem.id,
          expectedLessonStateVersion: state.version,
          action: { kind: 'start_lesson' },
        }),
      ).rejects.toMatchObject({ code: ApiErrorCode.ValidationError });
      expect(
        (await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest))
          .status,
      ).toBe('preparation_needed');
      expect([harness.provider.lessonContentCalls, harness.provider.practiceContentCalls]).toEqual(
        calls,
      );
      expect(JSON.stringify(harness.repos.teachingBriefs.get(old.brief.id))).toBe(originalBytes);
      const fresh = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        ...ensureRequest,
        command: command(`renew-lesson-${defect}`),
      });
      expect(fresh.status).toBe('ready');
      const renewedState = harness.repos.lessonExecution.getForSession(
        route.session.id,
        route.agendaItem.id,
      )!;
      expect(renewedState.teachingBriefId).not.toBe(old.brief.id);
      expect(
        hasCurrentPreparedLesson(harness.repos.teachingBriefs.get(renewedState.teachingBriefId!)!),
      ).toBe(true);
      expect(harness.provider.lessonContentCalls).toBe(calls[0]);
    },
  );

  it.each([
    'evaluator',
    'prompt',
    'choice_context',
    'missing_pair',
    'hidden_key',
    'absent_references',
    'grounding_missing',
    'grounding_version',
    'grounding_result',
    'grounding_input',
    'grounding_candidate',
    'grounding_claims',
    'grounding_exposure',
  ] as const)(
    'checks a persisted checkpoint with %s independently of the current Brief and completed result',
    async (defect) => {
      const harness = await ordinaryLessonHarness();
      const route = startTeachingRoute(harness);
      const request = preparationRequest(harness, route, `checkpoint-before-${defect}`);
      const prepared = await harness.services.teachingBriefPreparation.prepare(request);
      const ensureRequest = {
        command: command(`bound-checkpoint-${defect}`),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      };
      await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest);
      const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
        prepared.brief.composition!.acceptedLessonCheckpointId,
      )!;
      // Only this in-memory fixture permits seeding a historical/corrupt row.
      harness.db.exec('DROP TRIGGER prevent_accepted_lesson_checkpoint_update');
      if (
        defect === 'evaluator' ||
        defect === 'choice_context' ||
        defect === 'grounding_missing' ||
        defect === 'grounding_version' ||
        defect === 'grounding_result' ||
        defect === 'grounding_input' ||
        defect === 'grounding_candidate' ||
        defect === 'grounding_claims' ||
        defect === 'grounding_exposure'
      ) {
        if (defect === 'evaluator')
          checkpoint.lessonEvaluation.policyVersion = 'lesson-pedagogy-v9-scientific-notation';
        else if (defect === 'choice_context')
          delete checkpoint.lessonEvaluation.choiceContextFingerprint;
        else breakLessonGrounding(checkpoint.lessonEvaluation, defect);
        harness.db
          .prepare('UPDATE accepted_lesson_checkpoints SET lesson_evaluation_payload=? WHERE id=?')
          .run(JSON.stringify(checkpoint.lessonEvaluation), checkpoint.id);
      } else if (defect === 'prompt') {
        checkpoint.promptVersion = 'teaching-lesson-content-v18-source-faithful-models';
        harness.db
          .prepare('UPDATE accepted_lesson_checkpoints SET prompt_version=? WHERE id=?')
          .run(checkpoint.promptVersion, checkpoint.id);
      } else {
        breakLessonChoice(checkpoint.lessonContent, defect);
        harness.db
          .prepare('UPDATE accepted_lesson_checkpoints SET lesson_payload=? WHERE id=?')
          .run(JSON.stringify(checkpoint.lessonContent), checkpoint.id);
      }
      expect(
        isCurrentAcceptedLessonCheckpoint(
          harness.repos.acceptedLessonCheckpoints.get(checkpoint.id),
        ),
      ).toBe(false);
      const bytes = JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpoint.id));
      const calls = [harness.provider.lessonContentCalls, harness.provider.practiceContentCalls];
      await expect(
        harness.services.teachingBriefPreparation.prepare(request),
      ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
      expect(harness.services.teachingBriefPreparation.getCurrent(request)).toBeNull();
      expect(harness.services.lessonExecution.get('ws_1', route.session.id).status).toBe(
        'preparation_needed',
      );
      expect(
        (await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest))
          .status,
      ).toBe('preparation_needed');
      if (defect !== 'prompt')
        await expect(
          harness.services.teachingBriefPreparation.prepare(
            preparationRequest(harness, route, `checkpoint-revalidate-${defect}`),
          ),
        ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
      expect([harness.provider.lessonContentCalls, harness.provider.practiceContentCalls]).toEqual(
        calls,
      );
      expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpoint.id))).toBe(
        bytes,
      );
    },
  );

  it('refuses exposure of obsolete completed Lesson proofs without upgrading their authority', async () => {
    const harness = await ordinaryLessonHarness();
    const route = startTeachingRoute(harness);
    await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('history-lesson'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const brief = harness.repos.teachingBriefs.get(state.teachingBriefId!)!;
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
      brief.composition!.acceptedLessonCheckpointId,
    )!;
    // Seed persisted pre-policy history; production checkpoints stay immutable.
    harness.db.exec('DROP TRIGGER prevent_accepted_lesson_checkpoint_update');
    breakLessonChoice(brief.segments, 'missing_pair');
    breakLessonChoice(checkpoint.lessonContent, 'missing_pair');
    brief.composition!.lessonPromptVersion = 'teaching-lesson-content-v18-source-faithful-models';
    brief.pedagogyEvaluation!.policyVersion = checkpoint.lessonEvaluation.policyVersion =
      'lesson-pedagogy-v9-scientific-notation';
    harness.db
      .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
      .run(JSON.stringify(brief), brief.id);
    harness.db
      .prepare(
        'UPDATE accepted_lesson_checkpoints SET prompt_version=?, lesson_payload=?, lesson_evaluation_payload=? WHERE id=?',
      )
      .run(
        brief.composition!.lessonPromptVersion,
        JSON.stringify(checkpoint.lessonContent),
        JSON.stringify(checkpoint.lessonEvaluation),
        checkpoint.id,
      );
    const briefBytes = JSON.stringify(harness.repos.teachingBriefs.get(brief.id));
    const checkpointBytes = JSON.stringify(
      harness.repos.acceptedLessonCheckpoints.get(checkpoint.id),
    );
    harness.repos.lessonExecution.update(
      {
        ...state,
        presentedSegmentIndexes: brief.segments.map((segment) => segment.index),
        presentationCompletedAt: T0,
        practiceCompletedAt: T0,
        version: state.version + 1,
        updatedAt: T0,
      },
      state.version,
    );
    const agenda = harness.repos.sessionAgendas.get(route.agenda.id)!;
    harness.repos.sessionAgendas.update(
      {
        ...agenda,
        items: agenda.items.map((item) =>
          item.id === route.agendaItem.id ? { ...item, state: 'completed' as const } : item,
        ),
        version: agenda.version + 1,
        updatedAt: T0,
      },
      agenda.version,
      {
        id: 'history-completed-event',
        eventType: 'test_completed_history',
        actor: 'local',
        payload: {},
        createdAt: T0,
      },
    );
    const history = harness.services.lessonExecution.get('ws_1', route.session.id);
    expect(history.status).toBe('preparation_needed');
    expect(history.lesson).toBeNull();
    expect(JSON.stringify(harness.repos.teachingBriefs.get(brief.id))).toBe(briefBytes);
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpoint.id))).toBe(
      checkpointBytes,
    );
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION).not.toBe(
      brief.pedagogyEvaluation!.policyVersion,
    );
  });

  it.each(
    (['initial', 'retry'] as const).flatMap((surface) =>
      (['recognize', 'classify'] as const).map((operation) => ({ surface, operation })),
    ),
  )(
    'reuses the same prepared shallow Practice after deleting only $surface/$operation metadata',
    async ({ surface, operation }) => {
      const { harness, requests } = await aggregateQualityHarness('network', undefined, {
        depth: 'working_fluency',
        operation,
      });
      const generate = harness.provider.generatePracticeContent.bind(harness.provider);
      harness.provider.generatePracticeContent = async (input, opts) => {
        const candidate = await generate(input, opts);
        delete candidate.items[0]!.initial.evidenceContrast;
        return candidate;
      };
      const route = startTeachingRoute(harness);
      const request = preparationRequest(harness, route, 'metadata-invariant-prepared');
      const first = await harness.services.teachingBriefPreparation.prepare(request);
      expect(first.brief.practice!.items[0]!.initial.evidenceContrast).toBeUndefined();
      expect(
        first.brief.practice!.qualityEvaluation.answerabilityReview!.rounds[0]!.solves[0]!.result
          .decisions[0]!.requiresCaseInference,
      ).toBe(false);
      expect(hasCurrentPreparedPractice(first.brief)).toBe(true);
      expect(harness.services.teachingBriefPreparation.getCurrent(request)?.id).toBe(
        first.brief.id,
      );
      const ensureRequest = {
        command: command('metadata-invariant-bound'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.session.currentAgendaItemId!,
      };
      expect(
        (await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest))
          .status,
      ).toBe('ready');
      const checkpointId = first.brief.composition!.acceptedLessonCheckpointId;
      const checkpointBytes = JSON.stringify(
        harness.repos.acceptedLessonCheckpoints.get(checkpointId),
      );
      const providerCalls = [
        harness.provider.lessonContentCalls,
        harness.provider.practiceContentCalls,
        requests.length,
      ];
      const changed = structuredClone(first);
      delete changed.brief.practice!.items[0]![surface].reasoningOperation;
      expect(changed.brief.practice!.qualityEvaluation).toEqual(
        first.brief.practice!.qualityEvaluation,
      );
      harness.db
        .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
        .run(JSON.stringify(changed.brief), changed.brief.id);
      const preparation = harness.repos.operations.getByIdempotencyKey(
        'ws_1',
        `teaching-brief:${harness.learningUnitId}:${request.commandId}`,
      )!;
      harness.db
        .prepare('UPDATE agent_operation_results SET payload=? WHERE operation_id=?')
        .run(JSON.stringify(changed), preparation.id);

      expect(hasCurrentPreparedPractice(changed.brief)).toBe(true);
      expect(harness.services.teachingBriefPreparation.getCurrent(request)).toEqual(changed.brief);
      expect(await harness.services.teachingBriefPreparation.prepare(request)).toEqual(changed);
      const reused = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'metadata-invariant-reused'),
      );
      expect(reused.status).toBe('reused');
      expect(reused.brief).toEqual(changed.brief);
      expect(harness.services.lessonExecution.get('ws_1', route.session.id).status).toBe('ready');
      expect(
        (await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest))
          .status,
      ).toBe('ready');
      expect([
        harness.provider.lessonContentCalls,
        harness.provider.practiceContentCalls,
        requests.length,
      ]).toEqual(providerCalls);
      expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpointId))).toBe(
        checkpointBytes,
      );
    },
  );

  it.each([
    { depth: 'working_fluency', operation: 'recognize' },
    { depth: 'high_performance', operation: 'classify' },
    { depth: 'deep_transfer', operation: 'recognize' },
  ] as const)(
    'persists valid shallow $depth/$operation Practice after one exhausted quality attempt',
    async (shallow) => {
      const { harness, qualityRequests, requests } = await aggregateQualityHarness(
        'no_op',
        undefined,
        shallow,
      );
      const route = startTeachingRoute(harness);
      const result = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `shallow-${shallow.depth}`),
      );
      const evaluation = result.brief.practice!.qualityEvaluation;
      expect(qualityRequests).toHaveLength(1);
      expect(harness.provider.practiceContentCalls).toBe(2);
      expect(evaluation).toMatchObject({
        acceptancePolicyVersion: PRACTICE_ACCEPTANCE_POLICY_VERSION,
        status: 'pass',
        qualityImprovement: { attempts: 1, outcome: 'rejected' },
      });
      expect(practiceQualityImprovementFindings(evaluation)).toEqual([
        expect.objectContaining({
          code: 'practice_initial_recognition_at_depth',
          severity: 'warning',
        }),
      ]);
      expect(practiceAggregateQualityFindings(evaluation)).toEqual([]);
      expect(hasCurrentPracticeAnswerabilityReview(result.brief)).toBe(true);
      expect(hasCurrentPracticeAcceptancePolicy(result.brief)).toBe(true);
      expect(evaluation.contentReview).toHaveLength(1);
      expect(
        evaluation.answerabilityReview!.rounds.map(({ candidateHash }) => candidateHash),
      ).toEqual(evaluation.contentReview!.map(({ candidateHash }) => candidateHash));
      expect(qualityRequests[0]!.courseDesign!.desiredDepth).toBe(shallow.depth);
      expect(qualityRequests[0]!.editorialFindings![0]!.repairInstruction).toContain(
        'not merely a different reasoningOperation label',
      );
      expect(requests.filter((request) => request.purpose === 'practice_grounding')).toHaveLength(
        2,
      );
    },
  );

  it('persists genuine shallow-task reasoning improvement with fresh proofs', async () => {
    const { harness, qualityRequests } = await aggregateQualityHarness('improved', undefined, {
      depth: 'deep_transfer',
      operation: 'classify',
    });
    const route = startTeachingRoute(harness);
    const result = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'shallow-improved'),
    );
    expect(qualityRequests).toHaveLength(1);
    expect(result.brief.practice!.qualityEvaluation.qualityImprovement).toMatchObject({
      attempts: 1,
      outcome: 'improved',
    });
    expect(practiceQualityImprovementFindings(result.brief.practice!.qualityEvaluation)).toEqual(
      [],
    );
    expect(result.brief.practice!.items[0]!.initial.prompt).toBe(qualityDecisionPrompt);
    expect(result.brief.practice!.qualityEvaluation.contentReview![0]!.candidateHash).not.toBe(
      result.brief.practice!.qualityEvaluation.contentReview![1]!.candidateHash,
    );
    expect(hasCurrentPracticeAnswerabilityReview(result.brief)).toBe(true);
  });

  it.each([
    'label_only',
    'trailing_whitespace',
    'whitespace_formatting',
    'punctuation_only',
    'quotation_punctuation',
    'bracket_punctuation',
    'option_reorder',
    'private_only',
    'wording_but_still_recognition',
    'missing_contrast',
    'no_inference',
    'wrong_key',
    'source_alias',
    'grounding',
  ] as const)(
    'discards shallow quality rewrite %s and persists only the current proven original',
    async (rewrite) => {
      const { harness, qualityRequests } = await aggregateQualityHarness(rewrite, undefined, {
        depth: 'working_fluency',
        operation: 'recognize',
      });
      const route = startTeachingRoute(harness);
      const result = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `shallow-rejected-${rewrite}`),
      );
      const evaluation = result.brief.practice!.qualityEvaluation;
      expect(qualityRequests).toHaveLength(1);
      expect(evaluation.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'rejected' });
      expect(result.brief.practice!.items[0]!.initial.prompt).toBe(shallowDecisionPrompt);
      expect(result.brief.practice!.items[0]!.initial.reasoningOperation).toBe('recognize');
      expect(evaluation.contentReview).toHaveLength(1);
      expect(evaluation.answerabilityReview!.rounds).toHaveLength(1);
      expect(evaluation.integrityReview!.rounds).toHaveLength(1);
      expect(hasCurrentPreparedPractice(result.brief)).toBe(true);
      expect(practiceQualityImprovementFindings(evaluation)).toEqual(
        evaluation.qualityImprovement!.findingsBefore,
      );
      expect(hasCurrentPracticeAnswerabilityReview(result.brief)).toBe(true);
    },
  );

  it.each(['missing_givens', 'wrong_key', 'authority', 'grounding'] as const)(
    'rejects an initial shallow Practice %s hard defect without optional fallback',
    async (defect) => {
      const { harness, qualityRequests } = await aggregateQualityHarness('no_op', defect, {
        depth: 'working_fluency',
        operation: 'classify',
      });
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `shallow-hard-${defect}`),
        ),
      ).rejects.toMatchObject({
        details: {
          candidateFailure: {
            kind:
              defect === 'authority'
                ? 'practice_content_rejection'
                : 'teaching_content_review_failed',
          },
        },
      });
      expect(qualityRequests).toEqual([]);
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
    },
  );

  it.each(['no_op', 'ineffective'] as const)(
    'accepts residual Practice aggregate warnings after exactly one %s quality improvement',
    async (rewrite) => {
      const { harness, qualityRequests } = await aggregateQualityHarness(rewrite);
      const route = startTeachingRoute(harness);
      const result = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `aggregate-quality-${rewrite}`),
      );
      const evaluation = result.brief.practice!.qualityEvaluation;
      expect(qualityRequests).toHaveLength(1);
      expect(harness.provider.practiceContentCalls).toBe(2);
      expect(evaluation).toMatchObject({
        acceptancePolicyVersion: PRACTICE_ACCEPTANCE_POLICY_VERSION,
        status: 'pass',
        qualityImprovement: { attempts: 1, outcome: 'exhausted' },
      });
      const quality = practiceAggregateQualityFindings(evaluation);
      expect(quality.map((finding) => finding.code)).toEqual(
        expect.arrayContaining([
          'focused_unit_angle_coverage_insufficient',
          'reasoning_demand_below_depth',
        ]),
      );
      expect(quality).toEqual(evaluation.qualityImprovement!.findingsBefore);
      expect(
        quality.every(
          (finding) =>
            finding.severity === 'warning' &&
            finding.itemIndexes.length > 0 &&
            finding.objectiveRefs.length > 0 &&
            finding.message.length > 0,
        ),
      ).toBe(true);
      expect(hasCurrentPracticeAnswerabilityReview(result.brief)).toBe(true);
      expect(hasCurrentPracticeAcceptancePolicy(result.brief)).toBe(true);
      expect(evaluation.contentReview).toHaveLength(2);
      const hashes = evaluation.contentReview!.map((receipt) => receipt.candidateHash);
      expect(new Set(hashes).size).toBe(rewrite === 'no_op' ? 1 : 2);
      expect(evaluation.answerabilityReview!.rounds.map((round) => round.candidateHash)).toEqual(
        hashes,
      );
      expect(result.brief.composition!.practiceLogicalCallId).toContain(
        ':practice-quality-improvement',
      );
    },
  );

  it('accepts a successful quality rewrite only with fresh independent proofs', async () => {
    const { harness, qualityRequests } = await aggregateQualityHarness('improved');
    const route = startTeachingRoute(harness);
    const result = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'aggregate-quality-improved'),
    );
    const evaluation = result.brief.practice!.qualityEvaluation;
    expect(qualityRequests).toHaveLength(1);
    expect(harness.provider.practiceContentCalls).toBe(2);
    expect(evaluation.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'improved' });
    expect(practiceAggregateQualityFindings(evaluation)).toEqual([]);
    expect(evaluation.contentReview).toHaveLength(2);
    expect(evaluation.contentReview![0]!.candidateHash).not.toBe(
      evaluation.contentReview![1]!.candidateHash,
    );
    expect(hasCurrentPracticeAnswerabilityReview(result.brief)).toBe(true);
    expect(
      result.brief.practice!.items.every((item) => item.initial.prompt === qualityDecisionPrompt),
    ).toBe(true);
  });

  it.each(['missing_givens', 'wrong_key', 'authority', 'grounding'] as const)(
    'keeps an initial %s defect hard despite aggregate quality allowance',
    async (defect) => {
      const { harness, qualityRequests } = await aggregateQualityHarness('no_op', defect);
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `aggregate-hard-${defect}`),
        ),
      ).rejects.toBeDefined();
      expect(qualityRequests).toEqual([]);
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
      expect(
        harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ count: 1 });
    },
  );

  it.each(['wrong_key', 'source_alias', 'schema', 'missing_givens', 'grounding', 'leak'] as const)(
    'discards a quality rewrite introducing %s and accepts only its current proven original',
    async (rewrite) => {
      const { harness, qualityRequests, requests } = await aggregateQualityHarness(rewrite);
      const route = startTeachingRoute(harness);
      const result = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `aggregate-rewrite-hard-${rewrite}`),
      );
      expect(qualityRequests).toHaveLength(1);
      expect(harness.provider.practiceContentCalls).toBe(2);
      const original = qualityRequests[0]!.draftForReview!;
      const originalHash = `sha256:${createHash('sha256').update(JSON.stringify(original)).digest('hex')}`;
      const evaluation = result.brief.practice!.qualityEvaluation;
      expect(evaluation.qualityImprovement).toMatchObject({
        attempts: 1,
        outcome: 'rejected',
        failureCode: expect.any(String),
        logicalCallId: expect.stringContaining(':practice-quality-improvement'),
      });
      expect(practiceAggregateQualityFindings(evaluation)).toEqual(
        evaluation.qualityImprovement!.findingsBefore,
      );
      expect(practiceAggregateQualityFindings(evaluation).map((f) => f.code)).toEqual(
        expect.arrayContaining([
          'reasoning_demand_below_depth',
          'focused_unit_angle_coverage_insufficient',
        ]),
      );
      expect(evaluation.contentReview!.map((receipt) => receipt.candidateHash)).toEqual([
        originalHash,
      ]);
      expect(evaluation.answerabilityReview!.rounds.map((round) => round.candidateHash)).toEqual([
        originalHash,
      ]);
      expect(result.brief.practice!.items.map((item) => item.initial.prompt)).toEqual(
        original.items.map((item) => item.initial.prompt),
      );
      expect(result.brief.practice!.items.map((item) => item.capabilityTested)).toEqual(
        original.items.map((item) => item.capabilityTested),
      );
      expect(
        result.brief.practice!.items.every((item) => item.initial.correctOptionId.endsWith('_A')),
      ).toBe(true);
      expect(result.brief.composition!.practiceLogicalCallId).not.toContain(
        ':practice-quality-improvement',
      );
      expect(hasCurrentPracticeAnswerabilityReview(result.brief)).toBe(true);
      expect(hasCurrentPracticeAcceptancePolicy(result.brief)).toBe(true);
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
        1,
      );
      const originalSolves = requests.filter((input) => input.purpose === 'practice_answerability');
      expect(originalSolves.length).toBeGreaterThan(0);
      if (['wrong_key', 'missing_givens', 'grounding'].includes(rewrite)) {
        expect(originalSolves).toHaveLength(
          4 * qualityRequests[0]!.skeleton.practicePlan.slots.length,
        );
        const groundingReviews = requests.filter((input) => input.purpose === 'practice_grounding');
        expect(groundingReviews).toHaveLength(2);
        // Grounding deliberately hides the saved key. A changed key still owes
        // a new grounding call and blind solves, even with the same projection.
        if (rewrite !== 'wrong_key')
          expect(groundingReviews[1]!.candidate).not.toEqual(groundingReviews[0]!.candidate);
      }
    },
  );

  it.each([
    ['invalid_output', 'rejected'],
    ['network', 'failed'],
    ['review_failure', 'failed'],
    ['malformed_review', 'rejected'],
  ] as const)(
    'accepts the proven original after optional %s failure without another quality attempt',
    async (rewrite, outcome) => {
      const { harness, qualityRequests } = await aggregateQualityHarness(rewrite);
      const route = startTeachingRoute(harness);
      const result = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `aggregate-quality-failure-${rewrite}`),
      );
      const evaluation = result.brief.practice!.qualityEvaluation;
      expect(qualityRequests).toHaveLength(1);
      expect(harness.provider.practiceContentCalls).toBe(2);
      expect(evaluation.qualityImprovement).toMatchObject({
        attempts: 1,
        outcome,
        failureCode: expect.any(String),
      });
      expect(evaluation.contentReview).toHaveLength(1);
      expect(evaluation.answerabilityReview!.rounds).toHaveLength(1);
      expect(evaluation.integrityReview!.rounds).toHaveLength(1);
      expect(hasCurrentPreparedPractice(result.brief)).toBe(true);
      expect(practiceAggregateQualityFindings(evaluation)).toEqual(
        evaluation.qualityImprovement!.findingsBefore,
      );
      expect(hasCurrentPracticeAnswerabilityReview(result.brief)).toBe(true);
      expect(hasCurrentPracticeAcceptancePolicy(result.brief)).toBe(true);
      expect(result.brief.composition!.practiceLogicalCallId).not.toContain(
        ':practice-quality-improvement',
      );
    },
  );

  it.each(['source', 'route', 'lease'] as const)(
    'refuses original fallback when its current %s fence fails',
    async (fence) => {
      const { harness, qualityRequests, requests } = await aggregateQualityHarness('source_alias');
      const route = startTeachingRoute(harness);
      const commandId = `aggregate-fallback-stale-${fence}`;
      let leaseFenceApplied = false;
      const generate = harness.provider.generatePracticeContent.bind(harness.provider);
      harness.provider.generatePracticeContent = async (input, opts) => {
        const candidate = await generate(input, opts);
        if (qualityRequests.length) {
          if (fence === 'source')
            staleCurrentCurriculumSemanticSupport(
              harness,
              'Changed during optional quality improvement.',
            );
          if (fence === 'route') switchToSuccessorTeachingRoute(harness, route);
          if (fence === 'lease') {
            const operation = harness.repos.operations.getByIdempotencyKey(
              'ws_1',
              `teaching-brief:${harness.learningUnitId}:${commandId}`,
            )!;
            leaseFenceApplied =
              harness.db
                .prepare('UPDATE agent_operations SET fencing_token=fencing_token+1 WHERE id=?')
                .run(operation.id).changes === 1;
          }
        }
        return candidate;
      };
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, commandId),
        ),
      ).rejects.toMatchObject({
        code: fence === 'source' ? ApiErrorCode.ValidationError : ApiErrorCode.VersionConflict,
      });
      expect(leaseFenceApplied).toBe(fence === 'lease');
      expect(qualityRequests).toHaveLength(1);
      expect(harness.provider.practiceContentCalls).toBe(2);
      expect(requests.filter((input) => input.purpose === 'practice_grounding')).toHaveLength(1);
      expect(requests.filter((input) => input.purpose === 'practice_answerability')).toHaveLength(
        2 * qualityRequests[0]!.draftForReview!.items.length,
      );
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
      expect(
        harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ count: 1 });
    },
  );

  it.each([
    { complete: false, key: 'A', accepted: false, shallow: false },
    { complete: true, key: 'A', accepted: true, shallow: false },
    { complete: true, key: 'B', accepted: false, shallow: false },
    { complete: false, key: 'A', accepted: false, shallow: true },
    { complete: true, key: 'A', accepted: true, shallow: true },
    { complete: true, key: 'B', accepted: false, shallow: true },
  ])(
    'gates final J18 persistence with visible givens=$complete and saved key=$key (shallow=$shallow)',
    async ({ complete, key, accepted, shallow }) => {
      const j18 = historicalJ18Item();
      const givens =
        '记录集：A(优先级1,时长5), B(优先级1,时长9), C(优先级2,时长2), D(优先级2,时长4)。';
      const harness = await createHarness(
        0,
        'pass',
        'apply',
        shallow ? 'working_fluency' : 'pass_oriented',
      );
      Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
      const generate = harness.provider.generatePracticeContent.bind(harness.provider);
      harness.provider.generatePracticeContent = async (input, opts) => {
        const candidate = await generate(input, opts);
        const item = candidate.items[0]!;
        item.sourceRefs = [];
        item.visualRefs = [];
        item.application = structuredClone(j18.application);
        item.initial = structuredClone(j18.initial);
        if (shallow) item.initial.reasoningOperation = 'recognize';
        item.initial.correctOptionRef = key;
        if (key === 'B') item.initial.evidenceContrast!.alternativeOptionId = 'A';
        if (complete) item.initial.prompt = givens + item.initial.prompt;
        return candidate;
      };
      const requests: TeachingContentReviewInput[] = [];
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      harness.provider.reviewTeachingContent = async (input, opts) => {
        requests.push(structuredClone(input));
        const result = await review(input, opts);
        if (input.purpose === 'practice_grounding') {
          expect(JSON.stringify(input.candidate)).toContain(j18.application!.startingState);
          expect(result.findings).toEqual([]);
        }
        return result;
      };
      const route = startTeachingRoute(harness);
      const pending = harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `j18-${complete}-${key}`),
      );
      if (accepted) {
        const result = await pending;
        expect(result.status).toBe('prepared');
        expect(hasCurrentPracticeAnswerabilityReview(result.brief)).toBe(true);
        expect(result.brief.practice!.items[0]!.initial.correctOptionId).toMatch(/_A$/u);
      } else {
        await expect(pending).rejects.toMatchObject({
          details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
        });
        expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual(
          [],
        );
      }
      expect(
        harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ count: 1 });
      expect(requests.some((input) => input.purpose === 'practice_answerability')).toBe(true);
      for (const input of requests.filter(
        (request) =>
          request.purpose === 'practice_answerability' && request.actionIds[0] === 'PR1.initial',
      )) {
        expect(JSON.stringify(input)).not.toContain('A(1,5)');
        expect(JSON.stringify(input)).not.toContain('"application"');
        expect(JSON.stringify(input)).not.toContain('"correctOptionRef"');
      }
    },
  );

  it('revalidates cached authored J18 with real Fake even when the prior artifact claims execution verification', async () => {
    const harness = await createHarness(0, 'pass', 'apply', 'pass_oriented');
    const route = startTeachingRoute(harness);
    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'cached-practice-before-fake-fix'),
    );
    const checkpointId = prepared.brief.composition!.acceptedLessonCheckpointId;
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(checkpointId)!;
    const checkpointBytes = JSON.stringify(checkpoint);
    const provider = new FakeProvider();
    const cachedCandidate = await provider.generatePracticeContent(
      harness.provider.lastPracticeContentInput!,
    );
    const j18 = historicalJ18Item();
    cachedCandidate.items[0]!.sourceRefs = [];
    cachedCandidate.items[0]!.visualRefs = [];
    cachedCandidate.items[0]!.application = j18.application;
    cachedCandidate.items[0]!.initial = j18.initial;
    // Model the old private authored checkpoint returned by the cache. No
    // review method is overridden; the resumed service uses a real FakeProvider.
    const cachedCheckpoint = structuredClone(checkpoint);
    cachedCheckpoint.lessonEvaluation.jointAuthoring = {
      logicalCallIds: [checkpoint.lessonLogicalCallId!],
      practiceCandidate: cachedCandidate,
      executionVerified: true,
      practiceExecutionVerified: true,
    };
    // Build current offline Lesson review evidence for the simulated computed
    // authoring context. Only cached Practice claims are under test here.
    const currentLessonContext = {
      ...harness.provider.lastLessonContentInput!,
      preparedTogether: true,
      computedCases: true,
    };
    const currentGrounding = prepareLessonGroundingReview(
      currentLessonContext,
      checkpointLessonCandidate(cachedCheckpoint),
    );
    Object.assign(cachedCheckpoint.lessonEvaluation.groundingReview!.rounds[0]!, {
      inputHash: currentGrounding.inputHash,
      candidateHash: currentGrounding.candidateHash,
      claimsHash: currentGrounding.claimsHash,
      result: await provider.reviewTeachingContent(currentGrounding.input),
    });
    bindLessonGroundingToCheckpoint(
      cachedCheckpoint,
      checkpointLessonCandidate(cachedCheckpoint),
      currentLessonContext,
      prepared.brief,
    );
    harness.repos.acceptedLessonCheckpoints.findReusable = () => cachedCheckpoint;
    const oldBrief = structuredClone(prepared.brief);
    oldBrief.practice!.qualityEvaluation.answerabilityReview!.policyVersion =
      'practice-answerability-v1-learner-visible';
    harness.db
      .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
      .run(JSON.stringify(oldBrief), oldBrief.id);
    const services = createServices({ repos: harness.repos, provider, clock });
    const request = preparationRequest(harness, route, 'cached-j18-after-fake-fix');
    await expect(services.teachingBriefPreparation.prepare(request)).rejects.toMatchObject({
      details: { candidateFailure: { kind: 'computed_practice_review_failed' } },
    });
    const operation = harness.repos.operations.getByIdempotencyKey(
      'ws_1',
      `teaching-brief:${harness.learningUnitId}:${request.commandId}`,
    )!;
    expect(
      harness.db
        .prepare(
          'SELECT COUNT(*) AS count FROM model_logical_calls WHERE operation_id=? AND schema_fingerprint=?',
        )
        .get(operation.id, PRACTICE_ANSWERABILITY_POLICY_VERSION),
    ).toEqual({ count: 2 * cachedCandidate.items.length });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
      1,
    );
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpointId))).toBe(
      checkpointBytes,
    );
  });

  it.each([
    'answerability',
    'acceptance',
    'acceptance_v1',
    'acceptance_v2',
    'acceptance_v3',
    'acceptance_v4',
    'grounding_missing',
    'grounding_version',
    'grounding_input',
    'grounding_claims',
    'grounding_context',
    'explanation',
    'feedback',
    'source_context',
    'integrity_missing',
    'integrity_version',
    'integrity_input',
    'integrity_candidate',
  ] as const)(
    'rejects cached old Practice %s policy and revalidates only Practice under the same accepted Lesson',
    async (policy) => {
      const harness = await createHarness();
      const route = startTeachingRoute(harness);
      const request = preparationRequest(harness, route, 'practice-proof-before-policy-change');
      const prepared = await harness.services.teachingBriefPreparation.prepare(request);
      const checkpointId = prepared.brief.composition!.acceptedLessonCheckpointId;
      const checkpointBytes = JSON.stringify(
        harness.repos.acceptedLessonCheckpoints.get(checkpointId),
      );
      const old = structuredClone(prepared);
      if (policy === 'answerability')
        old.brief.practice!.qualityEvaluation.answerabilityReview!.policyVersion =
          'practice-answerability-v1-learner-visible';
      else {
        if (policy === 'grounding_missing')
          delete old.brief.practice!.qualityEvaluation.groundingReview;
        else if (policy === 'grounding_version')
          old.brief.practice!.qualityEvaluation.groundingReview!.policyVersion =
            'grounding-obsolete';
        else if (policy === 'grounding_input')
          old.brief.practice!.qualityEvaluation.groundingReview!.rounds.at(-1)!.inputHash =
            `sha256:${'0'.repeat(64)}`;
        else if (policy === 'grounding_claims')
          old.brief.practice!.qualityEvaluation.groundingReview!.rounds.at(-1)!.claimsHash =
            `sha256:${'0'.repeat(64)}`;
        else if (policy === 'grounding_context')
          delete old.brief.practice!.qualityEvaluation.groundingReview!.savedContextHash;
        else if (policy === 'explanation')
          old.brief.practice!.items[0]!.initial.explanation += ' 保存后改写解释。';
        else if (policy === 'feedback')
          old.brief.practice!.items[0]!.retry.options[0]!.feedbackIfSelected += ' 保存后改写反馈。';
        else if (policy === 'source_context')
          old.brief.sourceContextFingerprint = 'changed-source-context';
        else if (policy === 'acceptance_v4')
          old.brief.practice!.qualityEvaluation.acceptancePolicyVersion =
            'practice-acceptance-v4-public-integrity';
        else if (policy === 'integrity_missing')
          delete old.brief.practice!.qualityEvaluation.integrityReview;
        else if (policy === 'integrity_version')
          old.brief.practice!.qualityEvaluation.integrityReview!.policyVersion =
            'practice-acceptance-v3-inference-quality';
        else if (policy === 'integrity_input')
          old.brief.practice!.qualityEvaluation.integrityReview!.rounds.at(-1)!.inputHash =
            `sha256:${'0'.repeat(64)}`;
        else if (policy === 'integrity_candidate')
          old.brief.practice!.qualityEvaluation.integrityReview!.rounds.at(-1)!.candidateHash =
            `sha256:${'0'.repeat(64)}`;
        else if (policy === 'acceptance_v3')
          old.brief.practice!.qualityEvaluation.acceptancePolicyVersion =
            'practice-acceptance-v3-inference-quality';
        else if (policy === 'acceptance_v1')
          old.brief.practice!.qualityEvaluation.acceptancePolicyVersion =
            'practice-acceptance-v1-aggregate-quality';
        else if (policy === 'acceptance_v2')
          old.brief.practice!.qualityEvaluation.acceptancePolicyVersion =
            'practice-acceptance-v2-explicit-recognition-quality';
        else delete old.brief.practice!.qualityEvaluation.acceptancePolicyVersion;
        delete old.brief.practice!.qualityEvaluation.qualityImprovement;
        expect(hasCurrentPracticeAnswerabilityReview(old.brief)).toBe(true);
      }
      harness.db
        .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
        .run(JSON.stringify(old.brief), old.brief.id);
      if (policy === 'source_context')
        harness.db
          .prepare('UPDATE teaching_briefs SET source_context_fingerprint=? WHERE id=?')
          .run(old.brief.sourceContextFingerprint, old.brief.id);
      const operation = harness.repos.operations.getByIdempotencyKey(
        'ws_1',
        `teaching-brief:${harness.learningUnitId}:${request.commandId}`,
      )!;
      harness.db
        .prepare('UPDATE agent_operation_results SET payload=? WHERE operation_id=?')
        .run(JSON.stringify(old), operation.id);
      const lessonCalls = harness.provider.lessonContentCalls;
      const practiceCalls = harness.provider.practiceContentCalls;
      const answerabilityCalls = harness.provider.practiceAnswerabilityCalls;
      await expect(
        harness.services.teachingBriefPreparation.prepare(request),
      ).rejects.toMatchObject({
        code: ApiErrorCode.VersionConflict,
      });
      expect(harness.services.teachingBriefPreparation.getCurrent(request)).toBeNull();
      const current = await harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'practice-proof-current-policy'),
      );
      expect(current.status).toBe('prepared');
      expect(current.brief.id).not.toBe(old.brief.id);
      expect(hasCurrentPracticeAnswerabilityReview(current.brief)).toBe(true);
      expect(hasCurrentPracticeAcceptancePolicy(current.brief)).toBe(true);
      expect(hasCurrentPreparedPractice(current.brief)).toBe(true);
      expect(harness.provider.lessonContentCalls).toBe(lessonCalls);
      expect(harness.provider.practiceContentCalls).toBeGreaterThan(practiceCalls);
      expect(harness.provider.practiceAnswerabilityCalls - answerabilityCalls).toBe(
        2 * current.brief.practice!.items.length,
      );
      expect(current.brief.composition!.acceptedLessonCheckpointId).toBe(checkpointId);
      expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpointId))).toBe(
        checkpointBytes,
      );
    },
  );

  it.each([
    'answerability',
    'acceptance',
    'acceptance_v1',
    'acceptance_v2',
    'acceptance_v3',
    'acceptance_v4',
    'grounding_missing',
    'grounding_version',
    'grounding_input',
    'grounding_claims',
    'grounding_context',
    'explanation',
    'feedback',
    'source_context',
    'integrity_missing',
    'integrity_version',
    'integrity_input',
    'integrity_candidate',
  ] as const)(
    'fences an already-bound old Practice %s policy and its cached ready projection before a new answer',
    async (policy) => {
      const harness = await createHarness();
      const route = startTeachingRoute(harness);
      const ensureRequest = {
        command: command('bound-practice-before-policy-change'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.session.currentAgendaItemId!,
      };
      await harness.services.lessonExecution.ensure('ws_1', route.session.id, ensureRequest);
      const state = harness.repos.lessonExecution.getForSession(
        route.session.id,
        route.session.currentAgendaItemId!,
      )!;
      const brief = harness.repos.teachingBriefs.get(state.teachingBriefId!)!;
      const checkpointId = brief.composition!.acceptedLessonCheckpointId;
      const checkpointBytes = JSON.stringify(
        harness.repos.acceptedLessonCheckpoints.get(checkpointId),
      );
      // This persisted state represents a learner who already completed the
      // Lesson before the Practice policy update, without answering Practice.
      const readyState = harness.repos.lessonExecution.update(
        {
          ...state,
          presentedSegmentIndexes: brief.segments.map((segment) => segment.index),
          presentationCompletedAt: clock.now().toISOString(),
          version: state.version + 1,
          updatedAt: clock.now().toISOString(),
        },
        state.version,
      );
      expect(harness.services.lessonExecution.get('ws_1', route.session.id).practice?.status).toBe(
        'available',
      );
      if (policy === 'answerability')
        brief.practice!.qualityEvaluation.answerabilityReview!.policyVersion =
          'practice-answerability-obsolete';
      else {
        if (policy === 'grounding_missing')
          delete brief.practice!.qualityEvaluation.groundingReview;
        else if (policy === 'grounding_version')
          brief.practice!.qualityEvaluation.groundingReview!.policyVersion = 'grounding-obsolete';
        else if (policy === 'grounding_input')
          brief.practice!.qualityEvaluation.groundingReview!.rounds.at(-1)!.inputHash =
            `sha256:${'0'.repeat(64)}`;
        else if (policy === 'grounding_claims')
          brief.practice!.qualityEvaluation.groundingReview!.rounds.at(-1)!.claimsHash =
            `sha256:${'0'.repeat(64)}`;
        else if (policy === 'grounding_context')
          delete brief.practice!.qualityEvaluation.groundingReview!.savedContextHash;
        else if (policy === 'explanation')
          brief.practice!.items[0]!.initial.explanation += ' 保存后改写解释。';
        else if (policy === 'feedback')
          brief.practice!.items[0]!.retry.options[0]!.feedbackIfSelected += ' 保存后改写反馈。';
        else if (policy === 'source_context')
          brief.sourceContextFingerprint = 'changed-source-context';
        else if (policy === 'acceptance_v4')
          brief.practice!.qualityEvaluation.acceptancePolicyVersion =
            'practice-acceptance-v4-public-integrity';
        else if (policy === 'integrity_missing')
          delete brief.practice!.qualityEvaluation.integrityReview;
        else if (policy === 'integrity_version')
          brief.practice!.qualityEvaluation.integrityReview!.policyVersion =
            'practice-acceptance-v3-inference-quality';
        else if (policy === 'integrity_input')
          brief.practice!.qualityEvaluation.integrityReview!.rounds.at(-1)!.inputHash =
            `sha256:${'0'.repeat(64)}`;
        else if (policy === 'integrity_candidate')
          brief.practice!.qualityEvaluation.integrityReview!.rounds.at(-1)!.candidateHash =
            `sha256:${'0'.repeat(64)}`;
        else if (policy === 'acceptance_v3')
          brief.practice!.qualityEvaluation.acceptancePolicyVersion =
            'practice-acceptance-v3-inference-quality';
        else if (policy === 'acceptance_v1')
          brief.practice!.qualityEvaluation.acceptancePolicyVersion =
            'practice-acceptance-v1-aggregate-quality';
        else if (policy === 'acceptance_v2')
          brief.practice!.qualityEvaluation.acceptancePolicyVersion =
            'practice-acceptance-v2-explicit-recognition-quality';
        else delete brief.practice!.qualityEvaluation.acceptancePolicyVersion;
        expect(hasCurrentPracticeAnswerabilityReview(brief)).toBe(true);
      }
      harness.db
        .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
        .run(JSON.stringify(brief), brief.id);
      if (policy === 'source_context')
        harness.db
          .prepare('UPDATE teaching_briefs SET source_context_fingerprint=? WHERE id=?')
          .run(brief.sourceContextFingerprint, brief.id);
      const calls = harness.provider.practiceContentCalls;
      const lessonCalls = harness.provider.lessonContentCalls;
      const fenced = harness.services.lessonExecution.get('ws_1', route.session.id);
      expect(fenced.status).toBe('preparation_needed');
      expect(fenced.practice).toBeUndefined();
      expect(fenced.allowedActions).not.toContain('submit_practice_response');
      await expect(
        harness.services.lessonExecution.command('ws_1', route.session.id, {
          command: command('old-practice-answer'),
          expectedSessionVersion: route.session.version,
          expectedAgendaVersion: route.agenda.version,
          expectedAgendaItemId: route.session.currentAgendaItemId!,
          expectedLessonStateVersion: readyState.version,
          action: {
            kind: 'submit_practice_response',
            itemIndex: 0,
            optionId: brief.practice!.items[0]!.initial.correctOptionId,
          },
        }),
      ).rejects.toMatchObject({ code: ApiErrorCode.ValidationError });
      const replay = await harness.services.lessonExecution.ensure(
        'ws_1',
        route.session.id,
        ensureRequest,
      );
      expect(replay.status).toBe('preparation_needed');
      expect(harness.provider.practiceContentCalls).toBe(calls);
      const fresh = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        ...ensureRequest,
        command: command('bound-practice-current-policy'),
      });
      expect(fresh.status).toBe('ready');
      expect(fresh.practice?.status).toBe(policy === 'source_context' ? 'locked' : 'available');
      expect(harness.provider.practiceContentCalls).toBeGreaterThan(calls);
      expect(harness.provider.lessonContentCalls).toBe(lessonCalls);
      expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpointId))).toBe(
        checkpointBytes,
      );
    },
  );
  it('prepares a complete Lesson and Practice from exact unit sources without Concept bindings', async () => {
    const harness = await createHarness();
    const curriculum = harness.repos.curricula.get(harness.curriculumId)!;
    const unit = curriculum.nodes.find((node) => node.id === harness.learningUnitId)!;
    unit.learningUnit!.conceptIds = [];
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(curriculum), curriculum.id);
    harness.db
      .prepare(
        "UPDATE learning_contract_versions SET payload = json_set(payload, '$.focusRequest', NULL) WHERE id = ?",
      )
      .run(curriculum.contractVersionId);
    const route = startTeachingRoute(harness);
    const result = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'source-only-unit-teaching'),
    );
    expect(result.status).toBe('prepared');
    expect(result.brief.composition?.acceptedLessonCheckpointId).toBeTruthy();
    expect(result.brief.practice).toBeTruthy();
    expect(
      harness.repos.curricula.get(curriculum.id)!.nodes.find((node) => node.id === unit.id)!
        .learningUnit!.conceptIds,
    ).toEqual([]);
    expect(harness.provider.lessonContentCalls).toBeGreaterThan(0);
  });

  it.each([false, true, 'rejected'] as const)(
    'assembles private joint authoring with stage recovery=%s and exact provenance',
    async (recover) => {
      const harness = await createHarness(0, 'pass', 'explain', 'pass_oriented');
      Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
      let capsules = 0;
      let reviewInterrupted = false;
      let rejectedReviews = 0;
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      harness.provider.reviewTeachingContent = async (input, opts) => {
        if (
          recover === 'rejected' &&
          input.purpose !== 'lesson_grounding' &&
          rejectedReviews++ < 2
        ) {
          const result = await review(input, opts);
          result.findings = [
            {
              itemId: (input.candidate as { slots: Array<{ slotId: string }> }).slots[0]!.slotId,
              code: 'accuracy',
              problem: 'This capsule has a concrete wrong claim.',
              responsibility: 'grounding',
              repairInstruction: 'Correct the claim in this portion.',
            },
          ] as typeof result.findings;
          return result;
        }
        if (recover === true && !reviewInterrupted) {
          reviewInterrupted = true;
          throw ProviderError.network();
        }
        return review(input, opts);
      };
      Object.assign(harness.provider, {
        generateTeachingCapsule: async (
          input: TeachingCapsuleGenerationInput,
          opts?: ProviderCallOptions,
        ) => {
          capsules += 1;
          opts?.onRequestSent?.();
          const fake = new FakeProvider();
          const lesson = await fake.generateLessonSlotContent(input.lesson);
          const practice = input.practiceSlots.length
            ? await fake.generatePracticeContent({
                workspaceName: input.lesson.workspaceName,
                learnerLocale: input.lesson.learnerLocale,
                courseDesign: input.lesson.courseDesign,
                skeleton: {
                  ...input.lesson.skeleton,
                  practicePlan: {
                    schemaVersion: 1,
                    slots: input.practiceSlots,
                    activityBudget: { minMinutes: 1, maxMinutes: 1 },
                  },
                },
                acceptedLesson: [...input.priorLesson, ...lesson.slots],
                sourceContext: input.lesson.sourceContext,
                visualContext: input.lesson.visualContext,
              })
            : { items: [] };
          return { lesson, practice };
        },
      });
      const route = startTeachingRoute(harness);
      let result = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        command: command('joint-capsule-projection'),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      });
      if (recover) {
        expect(result.status).toBe('retry_available');
        expect(
          capsules,
          JSON.stringify(
            harness.db
              .prepare("SELECT payload FROM agent_operation_results WHERE status='failed'")
              .all(),
          ),
        ).toBe(recover === 'rejected' ? 2 : 1);
        expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual(
          [],
        );
        const restarted = createServices({
          repos: createRepositories(harness.db),
          provider: harness.provider,
          clock,
        });
        result = await restarted.lessonExecution.ensure('ws_1', route.session.id, {
          command: command('joint-capsule-retry'),
          expectedSessionVersion: route.session.version,
          expectedAgendaVersion: route.agenda.version,
          expectedAgendaItemId: route.agendaItem.id,
        });
        const receipts = harness.db
          .prepare(
            "SELECT id FROM model_logical_calls WHERE cache_status='hit' AND schema_fingerprint='teaching-capsule-v1'",
          )
          .all() as { id: string }[];
        expect(receipts).toHaveLength(recover === 'rejected' ? 0 : 1);
        if (recover === true)
          expect(harness.repos.telemetry.listAttempts(receipts[0]!.id)).toEqual([]);
        if (recover === 'rejected') expect(capsules).toBe(3);
      }
      expect(
        result.status,
        JSON.stringify(
          harness.db
            .prepare("SELECT payload FROM agent_operation_results WHERE status='failed'")
            .all(),
        ),
      ).toBe('ready');
      const brief = harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)[0]!;
      const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
        brief.composition!.acceptedLessonCheckpointId,
      )!;
      expect(capsules).toBeGreaterThan(0);
      expect(harness.provider.lessonContentCalls).toBe(0);
      expect(harness.provider.practiceContentCalls).toBe(0);
      expect(checkpoint.lessonEvaluation.jointAuthoring?.logicalCallIds).toHaveLength(
        recover === 'rejected' ? 1 : capsules,
      );
      expect(checkpoint.lessonLogicalCallId).toMatch(/:capsule-\d+$/u);
      expect(brief.composition?.practiceLogicalCallId).toMatch(/:capsule-\d+$/u);
      expect(JSON.stringify(result)).not.toContain('practiceCandidate');
      expect(JSON.stringify(result)).not.toContain('jointAuthoring');
      expect(result.lesson).not.toBeNull();
    },
  );

  it('tracks REAL editorial passes and binds the accepted artifacts to their final calls', async () => {
    const harness = await createHarness();
    Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
    const route = startTeachingRoute(harness);
    harness.provider.failLessonIndependentEvaluationOnce = true;
    const result = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'reviewed-teaching'),
    );
    expect(result.status).toBe('prepared');
    expect(harness.provider.lessonContentCalls).toBe(2);
    expect(harness.provider.practiceContentCalls).toBe(2);
    const reviewedInput = harness.provider.lastLessonContentInput!;
    const relationSlot = reviewedInput.skeleton.lessonSlots.find(
      (slot) => slot.qualityContract === 'semantic_relation',
    )!;
    expect(
      reviewedInput.draftForReview!.slots.find((slot) => slot.slotId === relationSlot.slotId)!
        .semanticRelations,
    ).toEqual([]);
    expect(result.brief.pedagogyEvaluation?.status).toBe('pass');
    expect(harness.provider.lastLessonContentInput?.draftForReview?.slots.length).toBeGreaterThan(
      0,
    );
    expect(harness.provider.lastPracticeContentInput?.draftForReview?.items.length).toBeGreaterThan(
      0,
    );
    expect(result.brief.composition?.lessonLogicalCallId).toMatch(/:lesson-editor$/u);
    expect(result.brief.composition?.practiceLogicalCallId).toMatch(/:practice-editor$/u);
    expect(
      harness.db
        .prepare('SELECT COUNT(*) AS count FROM model_logical_calls WHERE study_session_id=?')
        .get(route.session.id),
    ).toEqual({ count: 8 + 2 * result.brief.practice!.items.length });
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
      result.brief.composition!.acceptedLessonCheckpointId,
    )!;
    expect(checkpoint.lessonLogicalCallId).toBe(result.brief.composition?.lessonLogicalCallId);
    expect(checkpoint.lessonEvaluation.contentReview).toHaveLength(1);
    expect(result.brief.practice?.qualityEvaluation.contentReview).toHaveLength(1);
  });

  it.each([true, false])(
    'keeps scientific notation subject to independent correctness review (correct=%s)',
    async (correct) => {
      const harness = await createHarness(0, 'pass', 'apply', 'pass_oriented');
      Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
      const result = correct ? '5.2×10^0' : '2.4×10^1';
      const claim = `补充计算：0.052×10^2 = ${result}。`;
      let candidateChecks = 0;
      let lessonReviews = 0;
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      harness.provider.generateLessonSlotContent = (input, opts) =>
        generate(input, {
          ...opts,
          validateCandidate: (raw) => {
            const candidate = raw as LessonSlotContentProposalPayload;
            const slot = candidate.slots.find((content) => content.workedProcess)!;
            slot.workedProcess!.result = result;
            slot.explanation += ` ${claim}`;
            const validation = validateLessonSlotContentCandidate(candidate, input);
            expect(validation.valid, validation.diagnostics.join('\n')).toBe(true);
            candidateChecks += 1;
            return opts?.validateCandidate?.(candidate) ?? validation;
          },
        });
      installKnownLessonVariant(harness, (lesson) => {
        const slot = lesson.slots.find((content) => content.workedProcess)!;
        slot.workedProcess!.result = '5.2×10^0';
        slot.explanation += ' 补充计算：0.052×10^2 = 5.2×10^0。';
        return lesson;
      });
      const review = harness.provider.reviewTeachingContent.bind(harness.provider);
      harness.provider.reviewTeachingContent = async (input, opts) => {
        const reviewed = await review(input, opts);
        if (input.stage === 'lesson' && input.purpose !== 'lesson_grounding') {
          lessonReviews += 1;
          const slot = (input.candidate as LessonSlotContentProposalPayload).slots.find((content) =>
            content.explanation.includes(claim),
          )!;
          expect(slot).toBeDefined();
          if (!correct)
            reviewed.findings = [
              {
                itemId: slot.slotId,
                code: 'accuracy',
                problem: '0.052×10^2 equals 5.2, but 2.4×10^1 equals 24.',
                responsibility: 'grounding',
                repairInstruction: 'Correct the calculation and its worked result to 5.2×10^0.',
              },
            ] as typeof reviewed.findings;
        }
        return reviewed;
      };
      const route = startTeachingRoute(harness);
      const preparation = harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, `scientific-notation-correct-${correct}`),
      );
      if (correct) {
        const prepared = await preparation;
        expect(prepared.status).toBe('prepared');
        const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
          prepared.brief.composition!.acceptedLessonCheckpointId,
        )!;
        expect(
          checkpoint.lessonContent.find((slot) => slot.workedProcess)!.workedProcess!.result,
        ).toBe(result);
        expect(checkpoint.lessonEvaluation.contentReview).toHaveLength(1);
        expect(prepared.brief.practice?.qualityEvaluation.contentReview).toHaveLength(1);
        expect(lessonReviews).toBe(1);
        expect(candidateChecks).toBe(2);
      } else {
        await expect(preparation).rejects.toBeDefined();
        expect(lessonReviews).toBe(2);
        expect(candidateChecks).toBe(3);
        expect(harness.provider.practiceContentCalls).toBe(0);
        expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual(
          [],
        );
        expect(
          harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
        ).toEqual({ count: 0 });
        const failures = harness.db
          .prepare("SELECT payload FROM agent_operation_results WHERE status='failed'")
          .all();
        expect(JSON.stringify(failures)).toContain('accuracy');
        expect(JSON.stringify(failures)).not.toContain('worked_process_missing_required_structure');
      }
    },
  );

  it('never checkpoints an unreviewed REAL draft when the editorial pass fails', async () => {
    const harness = await createHarness();
    Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
    const route = startTeachingRoute(harness);
    harness.provider.onLessonContentGenerated = () => {
      harness.provider.failLessonContent = true;
    };
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'failed-teaching-editor'),
      ),
    ).rejects.toBeDefined();
    expect(harness.provider.lessonContentCalls).toBe(2);
    expect(harness.provider.practiceContentCalls).toBe(0);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 0 });
  });

  it('preserves the reviewed Lesson across a Practice editor failure and resumes only Practice', async () => {
    const harness = await createHarness();
    Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
    const route = startTeachingRoute(harness);
    harness.provider.onPracticeContentGenerated = () => {
      harness.provider.failPracticeContentOnce = true;
      harness.provider.onPracticeContentGenerated = null;
    };
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'practice-editor-failure'),
      ),
    ).rejects.toBeDefined();
    const row = harness.db.prepare('SELECT id FROM accepted_lesson_checkpoints').get() as {
      id: string;
    };
    const checkpointBytes = JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(row.id));
    expect(harness.provider.lessonContentCalls).toBe(2);
    expect(harness.provider.practiceContentCalls).toBe(2);
    const ready = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'practice-editor-retry'),
    );
    expect(harness.provider.lessonContentCalls).toBe(2);
    expect(harness.provider.practiceContentCalls).toBe(4);
    expect(ready.brief.composition?.acceptedLessonCheckpointId).toBe(row.id);
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(row.id))).toBe(
      checkpointBytes,
    );
  });

  it('revalidates current authority before sending the Lesson draft to the editor', async () => {
    const harness = await createHarness();
    Object.defineProperty(harness.provider, 'name', { value: 'hy3' });
    const route = startTeachingRoute(harness);
    harness.provider.onLessonContentGenerated = () =>
      staleCurrentCurriculumSemanticSupport(harness, 'Changed before editorial generation.');
    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'editor-stale-authority'),
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.ValidationError });
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(0);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 0 });
  });
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

  it('reaches Lesson preparation with no arithmetic planning failure once the acceptance gate has passed', async () => {
    // The harness accepts its route through the real `decideStudyPlan`, so reaching this
    // point already means every teach_unit passed the pre-acceptance plannability gate.
    const harness = await createHarness();
    const acceptedPlan = harness.repos.studyPlans.get(harness.planId)!;
    const curriculum = harness.repos.curricula.get(harness.curriculumId)!;
    expect(acceptedPlan.status).toBe('accepted');

    // The gate agrees, over the same accepted plan the route now runs on.
    expect(resolveStudyPlanPlannability(curriculum, acceptedPlan.items)).toEqual([]);
    const teachingItems = acceptedPlan.items.filter((item) => item.kind === 'teach_unit');
    expect(teachingItems.length).toBeGreaterThan(0);

    // And real preparation, which builds the planner input from the Agenda and Curriculum
    // rather than from the gate's projection, produces no arithmetic-class failure. This
    // is what pins the two input constructions together: objective order, the
    // `priority ?? 'normal'` default, the construct rule, minutes, and the slot limits.
    const route = startTeachingRoute(harness);
    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-gate-agreement'),
    );
    expect(prepared.status).toBe('prepared');
    const plannedSkeleton = harness.provider.lastLessonContentInput?.skeleton;
    expect(plannedSkeleton?.plannerVersion).toBe(TEACHING_SKELETON_PLANNER_VERSION);
    expect(plannedSkeleton?.targetMinutes).toBe(route.agendaItem.estimatedMinutes);
    expect(plannedSkeleton!.lessonSlots.length).toBeLessThanOrEqual(12);
  });

  it('T1/T2 carries exact depth, independent focus, current Unit, and objectives into teaching', async () => {
    const harness = await createHarness();
    const row = harness.db
      .prepare('SELECT payload FROM curriculum_versions WHERE id = ?')
      .get(harness.curriculumId) as { payload: string };
    const payload = JSON.parse(row.payload) as {
      nodes: Array<{ id: string; learningUnit: { focus?: 'normal' | 'focused' } | null }>;
    };
    payload.nodes.find((node) => node.id === harness.learningUnitId)!.learningUnit!.focus =
      'focused';
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(payload), harness.curriculumId);

    const route = startTeachingRoute(harness);
    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-course-design-context'),
    );

    expect(harness.provider.lastLessonContentInput?.courseDesign).toEqual({
      desiredDepth: 'working_fluency',
      unitFocus: 'focused',
    });
    expect(harness.provider.lastPracticeContentInput?.courseDesign).toEqual({
      desiredDepth: 'working_fluency',
      unitFocus: 'focused',
    });
    expect(harness.provider.lastLessonContentInput?.learnerLocale).toBe('zh-CN');
    expect(harness.provider.lastPracticeContentInput?.learnerLocale).toBe('zh-CN');
    const focusedInteraction = prepared.brief.segments.find(
      (segment) => segment.workedProcess?.interaction,
    );
    expect(focusedInteraction).toMatchObject({
      purpose: 'guided_practice',
      workedProcess: {
        inputs: expect.arrayContaining([expect.any(String)]),
        interaction: {
          activity: { options: expect.any(Array), correctDebrief: expect.any(String) },
          hint: expect.any(String),
          scaffold: { prompt: expect.any(String) },
          transfer: { changedCondition: expect.stringContaining('备用处理器') },
          sourceRefs: [],
        },
      },
    });
    expect(focusedInteraction?.informalCheck).toBeUndefined();
    const curriculum = harness.repos.curricula.get(harness.curriculumId)!;
    const currentUnit = curriculum.nodes.find((node) => node.id === harness.learningUnitId)!;
    expect(harness.provider.lastLessonContentInput?.skeleton).toMatchObject({
      learningUnitTitle: currentUnit.title,
      objectives: currentUnit.learningUnit!.objectives.map((objective, index) => ({
        objectiveRef: `O${index + 1}`,
        title: objective.title,
        description: objective.description,
      })),
    });
    const planItem = harness.repos.studyPlans
      .get(harness.planId)!
      .items.find((item) => item.curriculumLearningUnitId === harness.learningUnitId)!;
    expect(planItem.targetDepth).toBe('working_fluency');
    expect(harness.provider.lastLessonContentInput?.courseDesign).not.toHaveProperty('unitDepth');
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
    expect(first.brief.objective.objectives[0]).toMatchObject({
      authorityEnvelopeTier: routeObjective.authorityEnvelopeTier,
      formalEvidenceSourceBlockIds: routeObjective.formalEvidenceSourceBlockIds,
    });
    expect(first.brief.objective.objectives[0]!.formalAssessmentReady).toBe(
      routeObjective.formalAssessmentReady,
    );
    const sourceBackedSegments = first.brief.segments.filter(
      (segment) => segment.explanationAuthority === 'source_backed_teaching',
    );
    expect(sourceBackedSegments.length).toBeGreaterThan(0);
    expect(sourceBackedSegments.every((segment) => segment.sourceRefIds.length > 0)).toBe(true);
    const supplementarySegments = first.brief.segments.filter(
      (segment) => segment.explanationAuthority === 'ai_teaching_synthesis',
    );
    expect(supplementarySegments.length).toBeGreaterThan(0);
    expect(supplementarySegments.every((segment) => segment.sourceRefIds.length === 0)).toBe(true);
    expect(first.brief.objective.whyNow).not.toBe(route.agendaItem.reason);
    expect(first.brief.summary).not.toContain('locally planned instructional spine');
    const learnerFacingText = [
      first.brief.objective.whyNow,
      first.brief.summary,
      first.brief.nextConnection,
      ...first.brief.segments.flatMap((segment) => [
        segment.explanation,
        segment.example?.text,
        segment.contrast?.text,
        segment.misconception?.hypothesis,
        segment.misconception?.correction,
      ]),
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ');
    expect(learnerFacingText).not.toMatch(
      /\b(?:PR|O|S|L)[1-9][0-9]*\b|instructional spine|locally planned/iu,
    );
    const supportedClaimIds = new Set(
      objectiveAuthoritySemanticallySupportedClaimIds(routeObjective.semanticSupport!),
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
    expect(harness.provider.lastPracticeContentInput?.acceptedLesson[0]?.lessonNarrative).toEqual({
      whyNow: first.brief.objective.whyNow,
      summary: first.brief.summary,
      forwardBridge: first.brief.nextConnection,
    });
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
      const claimId = objectiveAuthoritySemanticallySupportedClaimIds(
        objective.semanticSupport!,
      )[0]!;
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

  it('teaches an artifact-free legacy route at the honest teaching_only tier without Formal authority', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const artifactFreeObjectiveIds = makeCurrentRouteObjectivesArtifactFree(harness);

    // C1: the teaching-entry tier admits exactly this route, while every
    // whole-Curriculum boundary stays closed on the same data.
    const gateCurriculum = harness.repos.curricula.get(harness.curriculumId)!;
    const gateObjectives = gateCurriculum.nodes
      .find((node) => node.id === harness.learningUnitId)!
      .learningUnit!.objectives.filter((candidate) =>
        artifactFreeObjectiveIds.includes(candidate.id),
      );
    expect(
      validateObjectiveAuthoritySemanticSupport(
        gateCurriculum,
        gateObjectives,
        {
          isBlockingEligible: (recordId) =>
            harness.repos.sourceAuthority.isBlockingEligible(recordId),
        },
        'lesson_provider',
      ),
    ).toEqual({ valid: true, diagnostics: [], diagnosticCodes: [] });
    expect(validateCurriculumObjectiveAuthoritySemanticSupport(gateCurriculum).valid).toBe(false);

    const prepared = await harness.services.teachingBriefPreparation.prepare(
      preparationRequest(harness, route, 'brief-artifact-free-1'),
    );

    expect(prepared.status).toBe('prepared');
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    const choiceCheck = prepared.brief.segments
      .map((segment) => segment.workedProcess?.interaction?.activity ?? segment.informalCheck)
      .find((check) => check?.options?.length);
    expect(choiceCheck?.options?.length).toBeGreaterThanOrEqual(2);
    expect(choiceCheck?.correctOptionId).toBeTruthy();

    // C5: the degraded tier is reported honestly rather than silently downgraded to
    // `unavailable` or silently upgraded to a Formal tier.
    const briefObjectives = prepared.brief.objective.objectives;
    expect(briefObjectives.map((objective) => objective.id)).toEqual(artifactFreeObjectiveIds);
    for (const objective of briefObjectives) {
      expect(objective.authorityEnvelopeTier).toBe('teaching_only');
      // C3: teaching runs on a derived construct, and that construct never buys
      // Formal assessment authority.
      expect(objective.construct).toBeTruthy();
      // Preparation propagates the legacy Formal shape instead of recomputing or
      // upgrading it. Actual credit refusal is proven at the credit boundary in
      // `formalProgression.test.ts`, not here: this brief cannot grant credit.
      expect(objective.formalAssessmentReady).toBe(false);
      expect(objective.formalEvidenceSourceBlockIds).toEqual([]);
    }

    // C2: the teaching lane still reaches the provider, and every offer it carries is
    // exactly quoted and manifest-confined.
    const lessonOffers = harness.provider.lastLessonContentInput!.sourceContext.offers;
    expect(lessonOffers.length).toBeGreaterThan(0);
    const manifestBlockIds = new Set(
      harness.repos.curricula
        .get(harness.curriculumId)!
        .executionSourceManifest.revisions.flatMap((revision) => revision.sourceBlockRevisionIds),
    );
    for (const offer of lessonOffers) {
      // `authorizedObjectiveRefs` is claim-identity backed, so an artifact-free
      // objective can never appear there: it owns no supported claim to match. That
      // absence is exactly what keeps the teaching lane out of an exact envelope.
      expect(offer.authorizedObjectiveRefs).toEqual([]);
      const reference = prepared.brief.sourceReferences.find(
        (candidate) => candidate.refId === offer.sourceRef,
      )!;
      expect(reference.authorityClaimIds ?? []).toEqual([]);
      expect(manifestBlockIds.has(reference.sourceBlockId)).toBe(true);
      const block = harness.repos.materials.getBlock(reference.sourceBlockId)!;
      expect(block.content.slice(reference.startOffset, reference.endOffset)).toBe(reference.quote);
      expect(offer.text).toBe(reference.quote);
    }
  });

  it('keeps Lesson and Practice reachable at teaching_only for a current validated semantic FAIL', async () => {
    const harness = await createHarness(0, 'fail');
    const route = startTeachingRoute(harness);
    const curriculumBefore = harness.repos.curricula.get(harness.curriculumId)!;
    const planItem = harness.repos.studyPlans
      .get(harness.planId)!
      .items.find((item) => item.id === route.agendaItem.linkedPlanItemId)!;
    const routeObjectives = curriculumBefore.nodes
      .find((node) => node.id === harness.learningUnitId)!
      .learningUnit!.objectives.filter((objective) => planItem.objectiveIds.includes(objective.id));
    expect(
      routeObjectives.every((objective) => objective.semanticSupport?.verdict === 'fail'),
    ).toBe(true);
    expect(
      validateObjectiveAuthoritySemanticSupport(
        curriculumBefore,
        routeObjectives,
        {
          isBlockingEligible: (recordId) =>
            harness.repos.sourceAuthority.isBlockingEligible(recordId),
        },
        'lesson_provider',
      ),
    ).toEqual({ valid: true, diagnostics: [], diagnosticCodes: [] });
    const failRowsBefore = harness.db
      .prepare(
        `SELECT objective_id AS objectiveId, status, payload
         FROM curriculum_objective_semantic_support
         WHERE curriculum_id = ? ORDER BY objective_id`,
      )
      .all(harness.curriculumId);

    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-valid-semantic-fail'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });

    expect(ready.status).toBe('ready');
    expect(ready.lesson).not.toBeNull();
    expect(ready.practice).not.toBeNull();
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    const briefObjectives = harness.repos.teachingBriefs.listForUnit(
      'ws_1',
      harness.learningUnitId,
    )[0]!.objective.objectives;
    expect(briefObjectives).not.toHaveLength(0);
    for (const objective of briefObjectives) {
      expect(objective).toMatchObject({
        authorityEnvelopeTier: 'teaching_only',
        formalAssessmentReady: false,
        formalEvidenceSourceBlockIds: [],
      });
    }
    expect(
      harness.provider.lastLessonContentInput?.sourceContext.offers.every(
        (offer) => offer.authorizedObjectiveRefs.length === 0,
      ),
    ).toBe(true);
    expect(
      harness.db
        .prepare(
          `SELECT objective_id AS objectiveId, status, payload
           FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? ORDER BY objective_id`,
        )
        .all(harness.curriculumId),
    ).toEqual(failRowsBefore);
  });

  it.each(['malformed', 'stale', 'foreign'] as const)(
    'keeps %s semantic FAIL support fatal before Lesson or Practice provider work',
    async (corruption) => {
      const harness = await createHarness(0, 'fail');
      const route = startTeachingRoute(harness);
      const planItem = harness.repos.studyPlans
        .get(harness.planId)!
        .items.find((item) => item.id === route.agendaItem.linkedPlanItemId)!;
      const objectiveId = planItem.objectiveIds[0]!;
      if (corruption === 'stale') {
        const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
        const objective = curriculum.nodes
          .find((node) => node.id === harness.learningUnitId)!
          .learningUnit!.objectives.find((candidate) => candidate.id === objectiveId)!;
        objective.description = `${objective.description} Stale after semantic evaluation.`;
        harness.db
          .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
          .run(JSON.stringify(curriculum), curriculum.id);
      } else {
        harness.db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_update');
        const row = harness.db
          .prepare(
            `SELECT payload FROM curriculum_objective_semantic_support
             WHERE curriculum_id = ? AND objective_id = ?`,
          )
          .get(harness.curriculumId, objectiveId) as { payload: string };
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        harness.db
          .prepare(
            `UPDATE curriculum_objective_semantic_support SET payload = ?
             WHERE curriculum_id = ? AND objective_id = ?`,
          )
          .run(
            corruption === 'malformed'
              ? JSON.stringify({})
              : JSON.stringify({ ...payload, objectiveId: 'objective_foreign' }),
            harness.curriculumId,
            objectiveId,
          );
      }

      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `brief-invalid-fail-${corruption}`),
        ),
      ).rejects.toThrow();
      expect(harness.provider.lessonContentCalls).toBe(0);
      expect(harness.provider.practiceContentCalls).toBe(0);
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
    },
  );

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

  for (const semanticState of ['failed', 'stale'] as const) {
    it(`delivers Unit A without mutating an unrelated Unit B ${semanticState} semantic artifact`, async () => {
      const harness = await createHarness();
      const unrelated = addUnrelatedLearningUnitObjective(harness, semanticState);
      const invalidBefore = validateCurriculumObjectiveAuthoritySemanticSupport(
        harness.repos.curricula.get(harness.curriculumId)!,
      );
      expect(invalidBefore.valid).toBe(false);
      expect(invalidBefore.diagnosticCodes).toContain(
        semanticState === 'failed' ? 'semantic_support_failed' : 'semantic_proposition_mismatch',
      );
      const route = startTeachingRoute(harness);

      const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        command: command(`lesson-unrelated-${semanticState}-semantic-support`),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      });

      expect(ready.status).toBe('ready');
      expect(ready.lesson).not.toBeNull();
      expect(ready.practice).not.toBeNull();
      expect(ready.allowedActions).toContain('start_lesson');
      expect(harness.provider.lessonContentCalls).toBe(1);
      expect(harness.provider.practiceContentCalls).toBe(1);
      expect(
        harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ count: 1 });
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toHaveLength(
        1,
      );
      expect(harness.repos.teachingBriefs.listForUnit('ws_1', unrelated.learningUnitId)).toEqual(
        [],
      );
      expect(
        (
          harness.db
            .prepare('SELECT payload FROM curriculum_versions WHERE id = ?')
            .get(harness.curriculumId) as { payload: string }
        ).payload,
      ).toBe(unrelated.curriculumPayload);
      expect(
        harness.db
          .prepare(
            `SELECT status, proposition_fingerprint AS propositionFingerprint,
                    binding_fingerprint AS bindingFingerprint, payload
             FROM curriculum_objective_semantic_support
             WHERE curriculum_id = ? AND objective_id = ?`,
          )
          .get(harness.curriculumId, unrelated.objectiveId),
      ).toEqual(unrelated.semanticSupportRow);
    });
  }

  it('blocks a mixed target unit when any selected objective is stale before provider work', async () => {
    const harness = await createHarness();
    const { routeSecond, baseObjective } = addSameUnitRouteAndDeferredObjectives(harness);
    setTeachingPlanObjectiveIds(harness, [baseObjective.id, routeSecond.id]);
    const curriculum = structuredClone(harness.repos.curricula.get(harness.curriculumId)!);
    const staleTarget = curriculum.nodes
      .find((node) => node.id === harness.learningUnitId)!
      .learningUnit!.objectives.find((objective) => objective.id === routeSecond.id)!;
    staleTarget.description = `${staleTarget.description} Changed after semantic evaluation.`;
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(curriculum), curriculum.id);
    const route = startTeachingRoute(harness);

    await expect(
      harness.services.teachingBriefPreparation.prepare(
        preparationRequest(harness, route, 'brief-mixed-target-stale-objective'),
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: {
        kind: 'objective_authority_semantic_support_invalid',
        boundary: 'lesson_provider',
        diagnosticCodes: expect.arrayContaining(['semantic_proposition_mismatch']),
      },
    });

    expect(harness.provider.lessonContentCalls).toBe(0);
    expect(harness.provider.practiceContentCalls).toBe(0);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
    ).toEqual({ count: 0 });
    expect(harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)).toEqual([]);
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
    const checkpointProviderContent = checkpoint.lessonContent.map(
      ({ lessonNarrative: _lessonNarrative, ...content }) => content,
    );
    expect(JSON.stringify(checkpointProviderContent)).toBe(
      harness.provider.lessonContentBytesBeforeMutation,
    );
    expect(checkpoint.lessonContent[0]?.lessonNarrative).toBeDefined();
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

  it('refuses an ungrounded Lesson checkpoint when the canonical operation cap blocks review', async () => {
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
    ).toEqual({ count: 0 });
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

  it('delivers source-valid Lesson and Practice when lexical quality findings are advisory', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.failPracticeIndependentEvaluationOnce = true;

    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-practice-independent-evaluation-failure'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });

    expect(ready.status).toBe('ready');
    expect(ready.lesson).not.toBeNull();
    expect(ready.practice).not.toBeNull();
    expect(ready.allowedActions).toContain('start_lesson');
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    const preparedState = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    expect(preparedState).toMatchObject({
      preparationStatus: 'ready',
      preparationOperationId: null,
    });
    const brief = harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)[0]!;
    expect(preparedState.acceptedLessonCheckpointId).toBe(
      brief.composition!.acceptedLessonCheckpointId,
    );
    expect(
      harness.repos.acceptedLessonCheckpoints.get(brief.composition!.acceptedLessonCheckpointId),
    ).toMatchObject({ lessonEvaluation: { status: 'pass' } });
    expect(brief).toMatchObject({ practice: { qualityEvaluation: { status: 'pass' } } });
    expect(brief.practice!.qualityEvaluation.findings.length).toBeGreaterThan(0);
    expect(
      brief.practice!.qualityEvaluation.findings.every((finding) => finding.severity === 'warning'),
    ).toBe(true);
    expect(
      harness.db
        .prepare('SELECT status FROM agent_operations WHERE command_id = ?')
        .get('lesson-practice-independent-evaluation-failure'),
    ).toEqual({ status: 'completed' });
  });

  it('delivers a hard-valid Lesson with retained quality warnings and truthful pass status', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.failLessonIndependentEvaluationOnce = true;

    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-independent-evaluation-advisory'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });

    expect(ready.status).toBe('ready');
    expect(ready.lesson).not.toBeNull();
    expect(ready.practice).not.toBeNull();
    expect(ready.allowedActions).toContain('start_lesson');
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
    const brief = harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)[0]!;
    expect(brief.pedagogyEvaluation).toMatchObject({
      status: 'pass',
      contentReviewQualityDisposition: 'retained',
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'missing_typed_semantic_relation', severity: 'warning' }),
      ]),
    });
    expect(
      harness.repos.acceptedLessonCheckpoints.get(brief.composition!.acceptedLessonCheckpointId),
    ).toMatchObject({ lessonEvaluation: { status: 'pass' } });
  });

  it.each([
    'annotations',
    'ordinary',
    'worked_example',
    'verification',
    'changed_facts',
    'delayed_hint',
    'boundary_prose',
  ] as const)(
    'prepares, persists and reuses a grounded Lesson with %s without a quality correction',
    async (variant) => {
      const harness = await createHarness(
        0,
        'pass',
        variant === 'worked_example' ? 'apply' : 'explain',
        variant === 'boundary_prose' ? 'deep_transfer' : 'working_fluency',
      );
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      harness.provider.generateLessonSlotContent = async (input, options) => {
        const lesson = await generate(input, options);
        const slot = lesson.slots.find((slot) => slot.workedProcess?.interaction)!;
        const process = slot.workedProcess!;
        const interaction = process.interaction!;
        if (variant === 'annotations') {
          for (const content of lesson.slots) {
            content.semanticRelations = [];
            if (content.workedProcess) content.workedProcess.learnerDecision = null;
            const graph = content.workedProcess?.interaction;
            for (const action of [
              content.informalCheck,
              graph?.activity,
              graph?.scaffold,
              graph?.transfer,
            ]) {
              if (!action) continue;
              delete action.reasoningOperation;
              delete action.requiredInference;
              delete action.evidenceContrast;
              if ('decisiveCondition' in action) delete action.decisiveCondition;
            }
          }
          interaction.scaffold.options[0]!.feedbackIfSelected = '对。';
        } else if (variant === 'ordinary' || variant === 'worked_example') {
          if (variant === 'ordinary') slot.workedProcess = null;
          else delete process.interaction;
          slot.informalCheck = createFakeLessonOrdinaryCheck();
        } else if (variant === 'verification') {
          process.steps.splice(1, 0, {
            action: '复核快照，不启动或结束任何任务。',
            reason: '没有资源事件，空闲数保持不变。',
            resultingState: process.steps[0]!.resultingState,
          });
        } else if (variant === 'changed_facts') {
          interaction.transfer = createFakeLessonChangedTransfer(interaction.activity.prompt);
        } else if (variant === 'delayed_hint') {
          interaction.hint = interaction.activity.options[0]!.text;
          interaction.activity.requiredInference = process.ruleOrProcedure;
        } else {
          const boundary = lesson.slots.find((slot) => slot.contrast)!;
          boundary.explanation += ` ${boundary.contrast!.text}`;
          boundary.sourceRefs = [];
          delete boundary.contrast;
        }
        expect(options?.validateCandidate?.(lesson).valid).toBe(true);
        return lesson;
      };
      const route = startTeachingRoute(harness);
      const request = preparationRequest(harness, route, `lesson-representation-${variant}`);
      const prepared = await harness.services.teachingBriefPreparation.prepare(request);
      const evaluation = prepared.brief.pedagogyEvaluation!;
      expect(evaluation.status).toBe('pass');
      expect(evaluation.findings.every((finding) => finding.severity === 'warning')).toBe(true);
      expect(evaluation.contentReviewQualityDisposition).toBe('retained');
      expect(evaluation.groundingReview!.rounds).toHaveLength(1);
      expect(evaluation.groundingReview!.rounds[0]!.result.findings).toEqual([]);
      expect(harness.provider.lessonContentCalls).toBe(1);
      expect(hasCurrentPreparedLesson(prepared.brief)).toBe(true);
      expect(
        isCurrentAcceptedLessonCheckpoint(
          harness.repos.acceptedLessonCheckpoints.get(
            prepared.brief.composition!.acceptedLessonCheckpointId,
          ),
        ),
      ).toBe(true);
      const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        command: command(`lesson-representation-bind-${variant}`),
        expectedSessionVersion: route.session.version,
        expectedAgendaVersion: route.agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      });
      expect(ready.status).toBe('ready');
      expect(ready.lesson).not.toBeNull();
      expect(harness.provider.lessonContentCalls).toBe(1);
      if (variant === 'ordinary' || variant === 'worked_example')
        expect(
          ready.lesson!.segments.find(
            (segment) => segment.informalCheck?.prompt === createFakeLessonOrdinaryCheck().prompt,
          ),
        ).toBeDefined();
    },
  );

  it.each([
    'false_feedback',
    'false_transition',
    'wrong_key',
    'missing_premise',
    'missing_action',
    'missing_inputs',
    'no_continuation',
  ] as const)(
    'rejects %s after a provider bypasses its callback, without an accepted checkpoint',
    async (defect) => {
      const harness = await createHarness();
      const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
      harness.provider.generateLessonSlotContent = async (input, options) => {
        const lesson = await generate(input, { ...options, validateCandidate: undefined });
        const slot = lesson.slots.find((slot) => slot.workedProcess?.interaction)!;
        const process = slot.workedProcess!;
        const graph = process.interaction!;
        if (defect === 'false_feedback')
          graph.scaffold.options[0]!.feedbackIfSelected = '3减2等于2。';
        if (defect === 'false_transition')
          process.steps[0]!.resultingState = '甲占用2后，空闲配额为3。';
        if (defect === 'wrong_key') graph.transfer.correctOptionId = 'A';
        if (defect === 'missing_premise')
          graph.transfer.changedCondition = '新案例：有一个备用处理器，但容量未给出。';
        if (defect === 'missing_action') {
          slot.workedProcess = null;
          delete slot.informalCheck;
        }
        if (defect === 'missing_inputs') process.inputs = [];
        if (defect === 'no_continuation') graph.pauseAfterStepIndex = process.steps.length - 1;
        return lesson;
      };
      const route = startTeachingRoute(harness);
      await expect(
        harness.services.teachingBriefPreparation.prepare(
          preparationRequest(harness, route, `lesson-hard-${defect}`),
        ),
      ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
      expect(
        harness.db.prepare('SELECT COUNT(*) AS count FROM accepted_lesson_checkpoints').get(),
      ).toEqual({ count: 0 });
      expect(harness.provider.practiceContentCalls).toBe(0);
    },
  );

  it('accepts missing descriptive metadata after callback validation with all current public proofs', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    const generate = harness.provider.generatePracticeContent.bind(harness.provider);
    harness.provider.generatePracticeContent = async (input, options) => {
      const payload = await generate(input, options);
      for (const item of payload.items)
        for (const surface of [item.initial, item.retry]) {
          delete surface.reasoningOperation;
          delete surface.requiredInference;
          delete surface.decisiveCondition;
        }
      return payload;
    };
    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('cognition-missing-private-descriptions'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(ready.status).toBe('ready');
    expect(harness.provider.lessonContentCalls).toBe(1);
    const brief = harness.repos.teachingBriefs.listForUnit('ws_1', harness.learningUnitId)[0]!;
    expect(brief.practice!.qualityEvaluation.integrityReview?.policyVersion).toBe(
      PRACTICE_ACCEPTANCE_POLICY_VERSION,
    );
    expect(hasCurrentPracticeAnswerabilityReview(brief)).toBe(true);
    expect(brief.practice!.qualityEvaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'practice_required_inference_missing',
          severity: 'warning',
        }),
      ]),
    );
    expect(brief.practice!.items[0]!.initial.reasoningOperation).toBeUndefined();
    for (const key of [
      'reasoningOperation',
      'requiredInference',
      'decisiveCondition',
      'evidenceContrast',
      'relevanceToObjective',
      'contentReview',
      'answerabilityReview',
      'integrityReview',
      'teachingDesign',
    ])
      expect(JSON.stringify(ready)).not.toContain(key);
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
    const failedComposition = harness.repos.operations
      .listForWorkspace('ws_1', 'prepare_teaching_brief')
      .find((operation) => operation.status === 'failed')!;
    expect(harness.repos.operations.getResult(failedComposition.id)).toMatchObject({
      status: 'failed',
      payload: {
        preparationFailure: {
          failureClass: 'TRANSPORT',
          failureCode: 'provider_connection_failure',
          phase: 'practice',
          recoveryAction: 'none',
          recoveryExhausted: true,
          checkpointPreserved: true,
        },
      },
    });

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

  it('stages an answer-bearing Summary across Practice failure, reload, retry and delayed help', async () => {
    const harness = await createHarness(0, 'pass', 'apply');
    const transform = (lesson: LessonSlotContentProposalPayload) => {
      const interaction = lesson.slots.find((slot) => slot.workedProcess)!.workedProcess!
        .interaction!;
      const answer = interaction.activity.options.find(
        (option) => option.id === interaction.activity.correctOptionId,
      )!.text;
      const transferAnswer = interaction.transfer.options.find(
        (option) => option.id === interaction.transfer.correctOptionId,
      )!.text;
      // These are true delayed conclusions, permitted outside the pre-response
      // review context but unsafe if recovery displays the entire Lesson.
      lesson.narrative!.summary += ` 案例结论：${answer} 迁移结论：${transferAnswer}`;
      lesson.slots.at(-1)!.explanation += ` 后续回顾：${answer}`;
      return lesson;
    };
    const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
    harness.provider.generateLessonSlotContent = async (input, opts) =>
      transform(await generate(input, opts));
    installKnownLessonVariant(harness, transform);
    const route = startTeachingRoute(harness);
    const prepare = (id: string) => {
      const session = harness.repos.studySessions.get(route.session.id)!;
      const agenda = harness.repos.sessionAgendas.get(route.agenda.id)!;
      return harness.services.lessonExecution.ensure('ws_1', route.session.id, {
        command: command(id),
        expectedSessionVersion: session.version,
        expectedAgendaVersion: agenda.version,
        expectedAgendaItemId: route.agendaItem.id,
      });
    };
    harness.provider.failPracticeContentOnce = true;
    let current = await prepare('summary-leak-practice-failure');
    expect(current.status).toBe('practice_retry_available');
    expect(current.progress).toMatchObject({
      presentedSegmentIndexes: [],
      presentationStatus: 'not_started',
      presentationCompletedAt: null,
    });
    expect(current.lesson!.summary).toEqual({
      available: false,
      text: null,
      nextConnection: null,
      formalOpportunities: [],
    });
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const checkpoint = harness.repos.acceptedLessonCheckpoints.get(
      state.acceptedLessonCheckpointId!,
    )!;
    const acceptedBytes = JSON.stringify(checkpoint);
    expect(checkpoint.lessonContent[0]!.lessonNarrative!.summary).toContain('案例结论：');
    const restartedServices = createServices({
      repos: harness.repos,
      provider: harness.provider,
      clock,
    });
    const reloaded = restartedServices.lessonExecution.get('ws_1', route.session.id);
    expect(reloaded.progress).toEqual(current.progress);
    expect(reloaded.lesson).toEqual(current.lesson);
    current = await prepare('summary-leak-practice-retry');
    expect(current.status).toBe('ready');
    expect(current.progress!.presentedSegmentIndexes).toEqual([]);
    expect(current.lesson!.summary.available).toBe(false);
    expect(harness.provider.lessonContentCalls).toBe(1);

    let actionNumber = 0;
    const act = async (action: LessonExecutionCommandRequest['action']) => {
      current = await harness.services.lessonExecution.command('ws_1', route.session.id, {
        command: command(`summary-leak-action-${++actionNumber}`),
        expectedSessionVersion: current.session.version,
        expectedAgendaVersion: current.agenda!.version,
        expectedAgendaItemId: route.agendaItem.id,
        expectedLessonStateVersion: current.progress!.stateVersion,
        action,
      });
    };
    await act({ kind: 'start_lesson' });
    const workedIndex = current.progress!.currentSegmentIndex;
    const process = () => current.lesson!.segments[workedIndex]!.workedProcess!;
    expect(process().interaction!.stage).toBe('guided');
    expect(process().result).toBeNull();
    expect(current.progress!.presentedSegmentIndexes).not.toContain(
      current.lesson!.segments.at(-1)!.index,
    );
    await act({
      kind: 'respond_to_worked_interaction',
      segmentIndex: workedIndex,
      phase: 'guided',
      response: 'B',
    });
    const revealed = process();
    expect(revealed.interaction!.hint).toEqual(expect.any(String));
    expect(revealed.interaction!.activity.feedback).toEqual(expect.any(String));
    expect(revealed.result).toBeNull();

    // Require fresh Practice proof after actual learner progress; its provider
    // failure must preserve the recorded response and already revealed help.
    const learnedState = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const brief = harness.repos.teachingBriefs.get(learnedState.teachingBriefId!)!;
    delete brief.practice!.qualityEvaluation.integrityReview;
    harness.db
      .prepare('UPDATE teaching_briefs SET payload=? WHERE id=?')
      .run(JSON.stringify(brief), brief.id);
    harness.provider.failPracticeContentOnce = true;
    current = await prepare('summary-leak-progress-practice-failure');
    expect(current.status).toBe('practice_retry_available');
    expect(current.progress!.presentedSegmentIndexes).toEqual(learnedState.presentedSegmentIndexes);
    expect(current.progress!.currentSegmentIndex).toBe(workedIndex);
    expect(current.progress!.presentationStatus).toBe('in_progress');
    expect(process()).toEqual(revealed);
    expect(current.lesson!.summary.available).toBe(false);
    current = restartedServices.lessonExecution.get('ws_1', route.session.id);
    expect(process()).toEqual(revealed);
    expect(current.lesson!.summary.text).toBeNull();
    current = await prepare('summary-leak-progress-practice-retry');
    expect(current.status).toBe('ready');
    expect(process()).toEqual(revealed);
    expect(current.allowedActions).toContain('respond_to_worked_interaction');
    await act({
      kind: 'respond_to_worked_interaction',
      segmentIndex: workedIndex,
      phase: 'scaffold',
      response: 'A',
    });
    expect(process().result).toEqual(expect.any(String));
    expect(process().interaction!.scaffold!.debrief).toEqual(expect.any(String));
    expect(process().whyResultFollows).toBeNull();
    expect(current.lesson!.summary.text).toBeNull();
    await act({
      kind: 'respond_to_worked_interaction',
      segmentIndex: workedIndex,
      phase: 'transfer',
      response: 'B',
    });
    expect(process().whyResultFollows).toEqual(expect.any(String));
    expect(process().interaction!.transfer!.debrief).toEqual(expect.any(String));

    for (
      let step = 0;
      step < 12 && !current.allowedActions.includes('complete_presentation');
      step++
    ) {
      expect(current.lesson!.summary.text).toBeNull();
      if (current.currentInformalCheck && !current.currentInformalCheck.response)
        await act({
          kind: 'respond_to_informal_check',
          segmentIndex: current.progress!.currentSegmentIndex,
          response:
            current.currentInformalCheck.options?.[0]?.id ??
            'The changed condition changes the result.',
        });
      else
        await act({
          kind: 'move_to_segment',
          segmentIndex: current.progress!.currentSegmentIndex + 1,
        });
    }
    expect(current.progress!.presentationStatus).toBe('summary_ready');
    expect(current.lesson!.summary.text).toBe(
      checkpoint.lessonContent[0]!.lessonNarrative!.summary,
    );
    await act({ kind: 'complete_presentation' });
    expect(current.practice!.status).toBe('available');
    expect(current.lesson!.summary.available).toBe(true);
    await act({
      kind: 'submit_practice_response',
      itemIndex: current.practice!.item!.index,
      optionId: current.practice!.item!.options[0]!.id,
    });
    expect(current.practice!.attempts).toHaveLength(1);
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpoint.id))).toBe(
      acceptedBytes,
    );
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(4);
  });

  it('reuses the accepted Lesson after pause/resume version churn on the same exact route', async () => {
    const harness = await createHarness();
    const route = startTeachingRoute(harness);
    harness.provider.failPracticeContentOnce = true;

    const retryable = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-practice-before-pause'),
      expectedSessionVersion: route.session.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: route.agendaItem.id,
    });
    expect(retryable.status).toBe('practice_retry_available');
    const checkpointId = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!.acceptedLessonCheckpointId!;
    const checkpointBefore = harness.repos.acceptedLessonCheckpoints.get(checkpointId)!;

    const paused = harness.services.studySessions.pause('ws_1', route.session.id, {
      commandId: 'pause-after-accepted-lesson',
      expectedSessionVersion: retryable.session.version,
    });
    const resumed = harness.services.studySessions.resume('ws_1', route.session.id, {
      commandId: 'resume-after-accepted-lesson',
      expectedSessionVersion: paused.session.version,
    });
    expect(resumed.session.version).toBeGreaterThan(checkpointBefore.expectedSessionVersion);
    expect(resumed.agenda.version).toBeGreaterThan(checkpointBefore.expectedAgendaVersion);

    const authoritative = harness.services.lessonExecution.get('ws_1', route.session.id);
    expect(authoritative).toMatchObject({
      status: 'practice_retry_available',
      session: { version: resumed.session.version },
      agenda: { version: resumed.agenda.version },
    });
    expect(authoritative.lesson).not.toBeNull();

    const ready = await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
      command: command('lesson-practice-after-pause'),
      expectedSessionVersion: authoritative.session.version,
      expectedAgendaVersion: authoritative.agenda!.version,
      expectedAgendaItemId: route.agendaItem.id,
    });

    expect(ready.status).toBe('ready');
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(2);
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id),
    ).toMatchObject({ acceptedLessonCheckpointId: checkpointId, preparationStatus: 'ready' });
    expect(JSON.stringify(harness.repos.acceptedLessonCheckpoints.get(checkpointId))).toBe(
      JSON.stringify(checkpointBefore),
    );
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
        preparationFailure: {
          failureClass: 'STRUCTURAL',
          failureCode: 'schema_invalid',
          phase: 'lesson',
          validatorCodes: [],
          normalizationRan: false,
          normalizationActions: [],
          recoveryAction: 'none',
          localizedRepair: false,
          affectedItemIds: [],
          affectedComponents: [],
          recoveryExhausted: true,
          terminalReason: 'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
          checkpointPreserved: false,
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
    expect(cancelled.status).toBe('preparation_needed');
    expect(cancelled.message).toContain('cancelled');
    expect(cancelled.allowedActions).toEqual(['prepare_lesson']);
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

  it('prepares and presents a basic lesson inside a StudySession without formal credit', async () => {
    const harness = await createHarness(0, 'pass', 'explain', 'pass_oriented');
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
    const firstCheckIndex = startedLesson.lesson!.segments.findIndex(
      (segment) => segment.informalCheck,
    );
    expect(firstCheckIndex).toBeGreaterThan(0);
    expect(startedLesson.progress?.currentSegmentIndex).toBe(firstCheckIndex);
    expect(startedLesson.progress?.presentedSegmentIndexes).toEqual(
      Array.from({ length: firstCheckIndex + 1 }, (_, index) => index),
    );
    expect(startedLesson.allowedActions).toContain('respond_to_informal_check');
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
    };
    const agendaItemStateBefore = harness.repos.sessionAgendas
      .get(agenda.id)!
      .items.find((item) => item.id === session.currentAgendaItemId)!.state;
    expect(agendaItemStateBefore).toBe('queued');

    let current = harness.services.lessonExecution.get('ws_1', session.id);
    // A learner check is the primary pacing boundary. All short coherent
    // segments before it were presented by the single start command above.
    let respondedToCheck = false;
    let presentationGuard = 0;
    while (!current.allowedActions.includes('complete_presentation') && presentationGuard < 20) {
      presentationGuard += 1;
      if (current.currentInformalCheck && !current.currentInformalCheck.response) {
        expect(current.currentInformalCheck.guidance).toBeNull();
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
        expect(current.currentInformalCheck?.guidance).toContain('条件');
        expect(current.currentInformalCheck?.correct).toBeNull();
        respondedToCheck = true;
        continue;
      }
      current = await harness.services.lessonExecution.command('ws_1', session.id, {
        command: command(`lesson-section-${presentationGuard}`),
        expectedSessionVersion: current.session.version,
        expectedAgendaVersion: current.agenda!.version,
        expectedAgendaItemId: session.currentAgendaItemId!,
        expectedLessonStateVersion: current.progress!.stateVersion,
        action: {
          kind: 'move_to_segment',
          segmentIndex: current.progress!.currentSegmentIndex + 1,
        },
      });
    }
    expect(respondedToCheck).toBe(true);
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
    expect(initialItem).not.toHaveProperty('capabilityTested');
    expect(initialItem).not.toHaveProperty('pedagogicalReason');
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
    expect(current.practice?.item).toBeNull();
    expect(current.practice?.recovery?.phase).toBe('diagnosis');
    let repairCommand = 0;
    const act = async (action: LessonExecutionCommandRequest['action']) => {
      current = await harness.services.lessonExecution.command('ws_1', session.id, {
        command: command(`adaptive-${++repairCommand}`),
        expectedSessionVersion: current.session.version,
        expectedAgendaVersion: current.agenda!.version,
        expectedAgendaItemId: session.currentAgendaItemId!,
        expectedLessonStateVersion: current.progress!.stateVersion,
        action,
      });
    };
    await expect(
      act({ kind: 'submit_practice_response', itemIndex: 0, optionId: 'A' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(act({ kind: 'start_practice_retest' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await act({
      kind: 'prepare_practice_repair',
      learnerNote: 'I assumed one condition was sufficient.',
    });
    expect(current.practice?.recovery?.phase).toBe('repair');
    expect(current.practice?.recovery?.retest).toBeNull();
    expect(JSON.stringify(current.practice)).not.toContain('correctOptionId');
    expect(harness.repos.formalProgression.listEvidenceForWorkspace('ws_1')).toEqual(
      authorityBefore.evidence,
    );
    current = harness.services.lessonExecution.get('ws_1', session.id);
    expect(current.practice?.recovery?.teaching).not.toBeNull();
    await act({ kind: 'start_practice_retest' });
    expect(current.practice?.recovery?.teaching).toBeNull();
    await act({ kind: 'submit_practice_retest', index: 0, optionId: 'B' });
    expect(current.practice?.recovery?.phase).toBe('diagnosis');
    expect(current.practice?.status).toBe('in_progress');
    await act({
      kind: 'prepare_practice_repair',
      learnerNote: 'I missed the necessary condition.',
    });
    await act({ kind: 'start_practice_retest' });
    const retest = current.practice!.recovery!.retest!;
    expect(retest.prompt).not.toBe(initialItem.prompt);
    await act({ kind: 'submit_practice_retest', index: 0, optionId: 'A' });
    expect(current.practice?.status).toBe('in_progress');
    current = harness.services.lessonExecution.get('ws_1', session.id);
    expect(current.practice?.recovery?.retest?.index).toBe(1);
    await expect(
      act({ kind: 'submit_practice_retest', index: 0, optionId: 'A' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await act({ kind: 'submit_practice_retest', index: 1, optionId: 'A' });
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
    };
    expect(authorityAfter).toEqual(authorityBefore);
    // Deliberate change (N-TEACHCOMPLETE, SEMANTICS A): finishing the Lesson and
    // its informal Practice now completes the Agenda item and its linked
    // teach_unit Plan progress as execution bookkeeping. Every formal-authority
    // assertion above still holds unchanged.
    const completedItem = harness.repos.sessionAgendas
      .get(agenda.id)!
      .items.find((item) => item.id === session.currentAgendaItemId)!;
    expect(completedItem.state).toBe('completed');
    expect(
      harness.repos.studyPlans
        .listProgress(harness.planId)
        .find((entry) => entry.planItemId === completedItem.linkedPlanItemId)?.state,
    ).toBe('completed');
    expect(harness.repos.formalProgression.listGoalOutcomes('ws_1')).toHaveLength(0);
    expect(harness.repos.formalProgression.listEvidenceForWorkspace('ws_1')).toHaveLength(0);
    expect(harness.repos.mistakes.listOpenByWorkspace('ws_1')).toHaveLength(0);
    expect(harness.repos.mastery.listByWorkspace('ws_1')).toHaveLength(0);
    expect(harness.provider.lessonContentCalls).toBe(1);
    expect(harness.provider.practiceContentCalls).toBe(1);
  });

  it('runs a prepared worked interaction locally with targeted repair, resume, and fading support', async () => {
    const harness = await createHarness(0, 'pass', 'apply');
    const generate = harness.provider.generateLessonSlotContent.bind(harness.provider);
    const adaptLessonFixture = (lesson: LessonSlotContentProposalPayload) => {
      const process = lesson.slots.find((slot) => slot.workedProcess)?.workedProcess;
      if (process) {
        // Exercise the independent supplementary interaction under a cited source rule.
        process.ruleOrProcedure =
          harness.provider.lastLessonContentInput!.sourceContext.offers[0]!.text;
        process.sourceRefs = [
          harness.provider.lastLessonContentInput!.sourceContext.offers[0]!.sourceRef,
        ];
      }
      return lesson;
    };
    harness.provider.generateLessonSlotContent = async (input, options) =>
      adaptLessonFixture(await generate(input, options));
    installKnownLessonVariant(harness, adaptLessonFixture);
    const unit = harness.repos.curricula
      .get(harness.curriculumId)!
      .nodes.find((node) => node.id === harness.learningUnitId)!;
    expect(unit.learningUnit?.objectives[0]?.formalAssessmentConstruct).toBe('apply');
    const { agenda, session, agendaItem } = startTeachingRoute(harness);
    const prepared = await harness.services.lessonExecution.ensure('ws_1', session.id, {
      command: command('worked-interaction-prepare'),
      expectedSessionVersion: session.version,
      expectedAgendaVersion: agenda.version,
      expectedAgendaItemId: agendaItem.id,
    });
    const authored = prepared.lesson!.segments.find(
      (segment) => segment.workedProcess?.interaction,
    )!;
    expect(authored.workedProcess).toMatchObject({
      inputs: expect.arrayContaining([expect.any(String)]),
      result: null,
      whyResultFollows: null,
      interaction: {
        stage: 'guided',
        origin: 'hy3_synthesis',
        sources: [],
        hint: null,
        scaffold: null,
        transfer: null,
      },
    });
    expect(authored.workedProcess!.sources?.length).toBeGreaterThan(0);
    expect(authored.workedProcess!.learnerDecision).toBeNull();

    const authorityBefore = harness.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM formal_evidence_records) AS formalEvidence,
           (SELECT COUNT(*) FROM mastery_states) AS mastery,
           (SELECT COUNT(*) FROM mistakes) AS mistakes,
           (SELECT COUNT(*) FROM memory_schedule_states) AS schedules`,
      )
      .get();
    const providerCalls = {
      lesson: harness.provider.lessonContentCalls,
      practice: harness.provider.practiceContentCalls,
    };
    let current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('worked-interaction-start'),
      expectedSessionVersion: prepared.session.version,
      expectedAgendaVersion: prepared.agenda!.version,
      expectedAgendaItemId: agendaItem.id,
      expectedLessonStateVersion: prepared.progress!.stateVersion,
      action: { kind: 'start_lesson' },
    });
    expect(current.progress?.currentSegmentIndex).toBe(authored.index);
    expect(current.allowedActions).toContain('respond_to_worked_interaction');
    const guided = current.lesson!.segments[authored.index]!.workedProcess!.interaction!;
    expect(current.lesson!.segments[authored.index]!.workedProcess!.steps).toHaveLength(
      guided.modelledStepCount,
    );
    expect(current.lesson!.segments[authored.index]!.workedProcess!.result).toBeNull();

    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('worked-interaction-wrong'),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItem.id,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: {
        kind: 'respond_to_worked_interaction',
        segmentIndex: authored.index,
        phase: 'guided',
        response: 'B',
      },
    });
    let projected = current.lesson!.segments[authored.index]!.workedProcess!;
    expect(projected.interaction).toMatchObject({
      stage: 'scaffold',
      activity: {
        response: 'B',
        correct: false,
        feedback: expect.any(String),
        misconception: {
          hypothesis: expect.any(String),
          whyTempting: expect.any(String),
          correction: expect.any(String),
        },
      },
      hint: expect.any(String),
      scaffold: { response: null, credit: 'none' },
      transfer: null,
    });
    expect(projected.result).toBeNull();
    expect(current.allowedActions).not.toContain('move_to_next_segment');
    const blockedVersion = current.progress!.stateVersion;
    await expect(
      harness.services.lessonExecution.command('ws_1', session.id, {
        command: command('worked-interaction-skip-blocked'),
        expectedSessionVersion: current.session.version,
        expectedAgendaVersion: current.agenda!.version,
        expectedAgendaItemId: agendaItem.id,
        expectedLessonStateVersion: blockedVersion,
        action: { kind: 'move_to_segment', segmentIndex: authored.index + 1 },
      }),
    ).rejects.toMatchObject({ code: ApiErrorCode.ValidationError });
    await expect(
      harness.services.lessonExecution.command('ws_1', session.id, {
        command: command('worked-interaction-phase-blocked'),
        expectedSessionVersion: current.session.version,
        expectedAgendaVersion: current.agenda!.version,
        expectedAgendaItemId: agendaItem.id,
        expectedLessonStateVersion: blockedVersion,
        action: {
          kind: 'respond_to_worked_interaction',
          segmentIndex: authored.index,
          phase: 'transfer',
          response: 'B',
        },
      }),
    ).rejects.toMatchObject({ code: ApiErrorCode.ValidationError });
    expect(harness.repos.lessonExecution.getForSession(session.id, agendaItem.id)?.version).toBe(
      blockedVersion,
    );

    const reloaded = harness.services.lessonExecution.get('ws_1', session.id);
    expect(
      reloaded.lesson!.segments[authored.index]!.workedProcess!.interaction!.activity.response,
    ).toBe('B');
    expect(
      harness.repos.lessonExecution.getForSession(session.id, agendaItem.id)
        ?.informalInteractions[0]?.workedInteraction,
    ).toMatchObject({ guidedResponse: 'B', scaffoldResponse: null });

    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('worked-interaction-scaffold'),
      expectedSessionVersion: reloaded.session.version,
      expectedAgendaVersion: reloaded.agenda!.version,
      expectedAgendaItemId: agendaItem.id,
      expectedLessonStateVersion: reloaded.progress!.stateVersion,
      action: {
        kind: 'respond_to_worked_interaction',
        segmentIndex: authored.index,
        phase: 'scaffold',
        response: 'A',
      },
    });
    projected = current.lesson!.segments[authored.index]!.workedProcess!;
    expect(projected.steps.length).toBeGreaterThan(guided.modelledStepCount);
    expect(projected.result).toEqual(expect.any(String));
    expect(projected.whyResultFollows).toBeNull();
    expect(projected.interaction).toMatchObject({
      stage: 'transfer',
      activity: { debrief: expect.any(String) },
      scaffold: { response: 'A', correct: true, debrief: expect.any(String) },
      transfer: { response: null, credit: 'none' },
    });
    expect(current.allowedActions).not.toContain('move_to_next_segment');

    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('worked-interaction-transfer'),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItem.id,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: {
        kind: 'respond_to_worked_interaction',
        segmentIndex: authored.index,
        phase: 'transfer',
        response: 'B',
      },
    });
    projected = current.lesson!.segments[authored.index]!.workedProcess!;
    expect(projected.interaction).toMatchObject({
      stage: 'completed',
      transfer: { response: 'B', correct: true, debrief: expect.any(String) },
    });
    expect(projected.whyResultFollows).toEqual(expect.any(String));
    expect(current.allowedActions).not.toContain('respond_to_worked_interaction');
    expect(current.allowedActions).toContain('move_to_next_segment');
    expect(
      harness.repos.lessonExecution
        .listEvents(harness.repos.lessonExecution.getForSession(session.id, agendaItem.id)!.id)
        .filter(
          (event) =>
            event.kind === 'informal_response_recorded' &&
            event.payload.kind === 'respond_to_worked_interaction',
        ),
    ).toHaveLength(3);
    expect({
      lesson: harness.provider.lessonContentCalls,
      practice: harness.provider.practiceContentCalls,
    }).toEqual(providerCalls);
    expect(
      harness.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM formal_evidence_records) AS formalEvidence,
             (SELECT COUNT(*) FROM mastery_states) AS mastery,
             (SELECT COUNT(*) FROM mistakes) AS mistakes,
             (SELECT COUNT(*) FROM memory_schedule_states) AS schedules`,
        )
        .get(),
    ).toEqual(authorityBefore);
  });

  it('gives a correct worked-interaction choice an explanatory debrief without opening repair help', async () => {
    const harness = await createHarness(0, 'pass', 'apply');
    const { agenda, session, agendaItem } = startTeachingRoute(harness);
    let current = await harness.services.lessonExecution.ensure('ws_1', session.id, {
      command: command('worked-correct-prepare'),
      expectedSessionVersion: session.version,
      expectedAgendaVersion: agenda.version,
      expectedAgendaItemId: agendaItem.id,
    });
    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('worked-correct-start'),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItem.id,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: { kind: 'start_lesson' },
    });
    const segment = current.lesson!.segments[current.progress!.currentSegmentIndex]!;
    expect(segment.workedProcess?.interaction?.stage).toBe('guided');
    const before = {
      lesson: harness.provider.lessonContentCalls,
      practice: harness.provider.practiceContentCalls,
    };
    current = await harness.services.lessonExecution.command('ws_1', session.id, {
      command: command('worked-correct-guided'),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItem.id,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: {
        kind: 'respond_to_worked_interaction',
        segmentIndex: segment.index,
        phase: 'guided',
        response: 'A',
      },
    });
    expect(current.lesson!.segments[segment.index]!.workedProcess!.interaction).toMatchObject({
      stage: 'transfer',
      activity: {
        response: 'A',
        correct: true,
        feedback: expect.any(String),
        debrief: expect.any(String),
        misconception: null,
      },
      hint: null,
      scaffold: null,
      transfer: { response: null, credit: 'none' },
    });
    expect({
      lesson: harness.provider.lessonContentCalls,
      practice: harness.provider.practiceContentCalls,
    }).toEqual(before);
  });
});

function visualAssetId(harness: Harness): string {
  return harness.repos.materials.getAssets('mat_1')[0]!.id;
}

describe('embedded Study Tutor', () => {
  it('uses presented teaching and revealed Repair, then only the active Retest question', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    const lesson = harness.services.lessonExecution;
    let state = harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id)!;
    state = harness.repos.lessonExecution.update(
      {
        ...state,
        presentedSegmentIndexes: get().lesson!.segments.map((segment) => segment.index),
        version: state.version + 1,
      },
      state.version,
    );
    const segment = get().lesson!.segments[0]!;
    const anchor = {
      lessonExecutionStateId: state.id,
      lessonExecutionVersion: state.version,
      segmentIndex: 0,
      selectedText: segment.explanation.slice(0, 30),
    };
    const selected = lesson.tutorContext('ws_1', route.session.id, anchor)!;
    expect(selected.selectedText).toBe(anchor.selectedText);
    expect(selected.visibleLesson?.map((value) => value.index)).toEqual(
      state.presentedSegmentIndexes,
    );
    expect(() =>
      lesson.tutorContext('ws_1', route.session.id, {
        ...anchor,
        selectedText: 'forged passage not in this Lesson',
      }),
    ).toThrow(/重新选择/);
    expect(() =>
      lesson.tutorContext('ws_1', route.session.id, {
        ...anchor,
        lessonExecutionVersion: state.version - 1,
      }),
    ).toThrow(/位置已变化/);
    await act({
      kind: 'prepare_practice_repair',
      learnerNote: 'I confused the rule with its example.',
    });
    expect(lesson.tutorContext('ws_1', route.session.id)?.repairTeaching).toContain(
      get().practice!.recovery!.teaching!.workedExample.steps[0],
    );
    expect(lesson.tutorContext('ws_1', route.session.id)?.activeQuestion).toBeUndefined();
    await act({ kind: 'start_practice_retest' });
    const retest = lesson.tutorContext('ws_1', route.session.id)!;
    state = harness.repos.lessonExecution.get(state.id)!;
    const packet = state.practiceInteractions[0]!.recovery!.rounds.at(-1)!.content;
    expect(retest.activeQuestion).toMatchObject({
      kind: 'retest',
      prompt: get().practice!.recovery!.retest!.prompt,
    });
    expect(JSON.stringify(retest)).not.toContain('correctOptionId');
    expect(retest.repairTeaching).toContain(packet.explanation);
    expect(JSON.stringify(retest)).not.toContain(packet.retest[1]!.prompt);
  });

  it('persists exact citations and feeds delivered Tutor teaching to later Repair without progression writes', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const answer =
      'A new supplementary example: compare the mandatory condition with an optional filter.';
    const original = harness.provider.respondToTutorTurn.bind(harness.provider);
    harness.provider.respondToTutorTurn = async (input, opts) => ({
      ...(await original(input, opts)),
      text: answer,
      sourceRefs: input.offeredSourceRefs.slice(0, 1).map((source) => source.referenceKey),
    });
    const request = {
      commandId: 'embedded-tutor-citations',
      expectedSessionVersion: get().session.version,
      content: 'Explain this rule.',
    };
    const response = await harness.services.studySessions.submitTurn(
      'ws_1',
      route.session.id,
      request,
    );
    expect(response.turn.tutorMetadata?.citations?.[0]?.excerpt).toBe(
      harness.provider.lastTutorInput!.offeredSourceRefs[0]!.excerpt,
    );
    expect(harness.repos.lessonExecution.get(state.id)).toEqual(state);
    expect(harness.repos.mastery.listByWorkspace('ws_1')).toHaveLength(0);
    expect(harness.repos.formalProgression.listEvidenceForWorkspace('ws_1')).toHaveLength(0);
    let seen: string[] | undefined;
    const repair = harness.provider.generatePracticeRepair.bind(harness.provider);
    harness.provider.generatePracticeRepair = async (input, opts) => {
      seen = input.tutorExplanations;
      return repair(input, opts);
    };
    await act({ kind: 'prepare_practice_repair', learnerNote: '' });
    expect(seen).toContain(answer);
    expect(
      await harness.services.studySessions.submitTurn('ws_1', route.session.id, request),
    ).toEqual(response);
  });

  it('rejects a late Tutor answer when Practice changes during the request', async () => {
    const { harness, route, get } = await failedPracticeHarness();
    const started = deferred<void>(),
      release = deferred<void>();
    const original = harness.provider.respondToTutorTurn.bind(harness.provider);
    harness.provider.respondToTutorTurn = async (input, opts) => {
      started.resolve(undefined);
      await release.promise;
      return original(input, opts);
    };
    const pending = harness.services.studySessions.submitTurn('ws_1', route.session.id, {
      commandId: 'late-tutor',
      expectedSessionVersion: get().session.version,
      content: 'Help me understand the error.',
    });
    await started.promise;
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    harness.repos.lessonExecution.update({ ...state, version: state.version + 1 }, state.version);
    release.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      harness.repos.studySessions.listExchanges(route.session.id).map((exchange) => exchange.role),
    ).toEqual(['learner']);
    expect(harness.repos.mastery.listByWorkspace('ws_1')).toHaveLength(0);
  });
});

async function failedPracticeHarness() {
  const harness = await createHarness(0, 'pass', 'explain', 'pass_oriented');
  const route = startTeachingRoute(harness);
  await harness.services.lessonExecution.ensure('ws_1', route.session.id, {
    command: command('recovery-fixture-prepare'),
    expectedSessionVersion: route.session.version,
    expectedAgendaVersion: route.agenda.version,
    expectedAgendaItemId: route.agendaItem.id,
  });
  const state = harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id)!;
  const brief = harness.repos.teachingBriefs.get(state.teachingBriefId!)!;
  // This fixture starts at the accepted post-presentation boundary; the preceding
  // integration test exercises the actual presentation commands as well.
  harness.repos.lessonExecution.update(
    { ...state, presentationCompletedAt: T0, version: state.version + 1 },
    state.version,
  );
  let sequence = 0;
  const get = () => harness.services.lessonExecution.get('ws_1', route.session.id);
  const act = (action: LessonExecutionCommandRequest['action'], options?: ProviderCallOptions) => {
    const current = get();
    return harness.services.lessonExecution.command(
      'ws_1',
      route.session.id,
      {
        command: command(`recovery-fixture-${++sequence}`),
        expectedSessionVersion: current.session.version,
        expectedAgendaVersion: current.agenda!.version,
        expectedAgendaItemId: route.agendaItem.id,
        expectedLessonStateVersion: current.progress!.stateVersion,
        action,
      },
      options,
    );
  };
  const item = brief.practice!.items[0]!;
  await act({
    kind: 'submit_practice_response',
    itemIndex: 0,
    optionId: item.initial.options.find((option) => option.id !== item.initial.correctOptionId)!.id,
  });
  return { harness, route, brief, get, act };
}

function recoveryAuthorityDigest(db: SqliteDb) {
  const tables = [
    'formal_evidence_records',
    'assessment_evidence_records',
    'assessment_grade_records',
    'assessment_progression_reconciliations',
    'progression_decisions',
    'progression_reconciliations',
    'learning_unit_progress',
    'mastery_states',
    'goal_outcomes',
    'grading_results',
    'submissions',
    'mistakes',
    'repair_episodes',
    'repair_packets',
    'repair_practice_events',
    'repair_status_events',
    'review_items',
    'review_targets',
    'review_executions',
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

describe('Post-Practice recovery', () => {
  it.each(['stored original hint', 'revealed Tutor hint'] as const)(
    'uses only actually revealed rules in both independent solves after reload (%s)',
    async (exposure) => {
      const { harness, route, get, act } = await failedPracticeHarness();
      const rule = '模型Z准入规则：甲且乙同时为真即可准入；任一为假就禁止准入。';
      const state = harness.repos.lessonExecution.getForSession(
        route.session.id,
        route.agendaItem.id,
      )!;
      harness.repos.lessonExecution.update(
        {
          ...state,
          practiceInteractions: state.practiceInteractions.map((attempt) => ({
            ...attempt,
            hint: rule,
          })),
          version: state.version + 1,
        },
        state.version,
      );
      const reloaded = get();
      expect(reloaded.practice!.attempts[0]!.hint).toBe(rule); // Stored, not rendered by recovery.
      expect(JSON.stringify(reloaded.practice!.recovery)).not.toContain(rule);
      if (exposure === 'revealed Tutor hint') {
        const tutor = harness.provider.respondToTutorTurn.bind(harness.provider);
        harness.provider.respondToTutorTurn = async (input, opts) => ({
          ...(await tutor(input, opts)),
          text: rule,
        });
        const response = await harness.services.studySessions.submitTurn('ws_1', route.session.id, {
          commandId: 'reveal-model-z-rule',
          expectedSessionVersion: get().session.version,
          content: '请说明模型Z的规则。',
        });
        expect(response.exchanges.find((exchange) => exchange.role === 'tutor')?.content).toBe(
          rule,
        );
        expect(
          harness.repos.studySessions
            .listExchanges(route.session.id)
            .findLast((exchange) => exchange.role === 'tutor')?.content,
        ).toBe(rule);
      }
      const firstSavedFeedback = 'FIRST_SUCCESS_SAVED_ONLY';
      const retests = [false, true].map((second, index) => ({
        prompt: `模型Z新情境${index + 1}：甲=真，乙=${second ? '真' : '假'}。按已学规则判断能否准入。`,
        options: [
          {
            id: 'A',
            text: '禁止准入，因为两项未同时成立。',
            feedbackIfSelected: second ? '两项同时成立，应准入。' : '乙为假，所以禁止准入。',
          },
          {
            id: 'B',
            text: '允许准入，因为两项同时成立。',
            feedbackIfSelected: second ? '两项同时为真，所以准入。' : '乙为假，不能准入。',
          },
          {
            id: 'C',
            text: '只要甲为真就准入，无需乙。',
            feedbackIfSelected: '模型Z要求两项同时成立，甲不能替代乙。',
          },
        ],
        correctOptionId: second ? 'B' : 'A',
        hint: rule,
        explanation: second
          ? '甲乙均为真，合取为真，可以准入。'
          : `甲真乙假，合取为假，禁止准入。${firstSavedFeedback}`,
      }));
      const author = harness.provider.generatePracticeRepair.bind(harness.provider);
      const reviewer = harness.provider.reviewTeachingContent.bind(harness.provider);
      const solves: TeachingContentReviewInput[] = [];
      let authorCalls = 0;
      harness.provider.generatePracticeRepair = async (input, opts) => {
        authorCalls++;
        return { ...(await author(input, opts)), retest: structuredClone(retests) };
      };
      harness.provider.reviewTeachingContent = async (input, opts) => {
        if (input.purpose === 'repair_grounding') {
          // This finite supplemental model owns independently checked AND
          // outcomes; rich grounding cannot establish public visibility.
          expect(input.candidate.retest).toEqual(retests);
          expect(input.evidence.visibleFeedback).not.toContain(rule);
          return { decisions: [], findings: [] };
        }
        if (input.purpose === 'repair_integrity') {
          expect(input.candidate.map((surface) => surface.prompt)).toEqual(
            retests.map((surface) => surface.prompt),
          );
          return { decisions: [], findings: [] };
        }
        if (input.purpose === 'repair_answerability') {
          solves.push(structuredClone(input));
          const known = retests.findIndex((surface) => surface.prompt === input.candidate.prompt);
          const hasRule = input.priorTeaching.some((text) => text.includes(rule));
          const answerText =
            known === 0 ? '禁止准入，因为两项未同时成立。' : '允许准入，因为两项同时成立。';
          const answerId =
            known >= 0 && hasRule
              ? (input.candidate.options.find((option) => option.text === answerText)?.id ?? null)
              : null;
          return {
            decisions: [
              {
                actionId: input.candidate.actionId,
                answerId,
                requiresCaseInference: true,
                evidenceUsed: hasRule
                  ? 'Apply the revealed AND rule to this case’s own operands.'
                  : 'Model Z’s governing rule has never been revealed.',
              },
            ],
            findings: [],
          };
        }
        return reviewer(input, opts);
      };
      if (exposure === 'stored original hint') {
        await expect(
          act({ kind: 'prepare_practice_repair', learnerNote: '' }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(authorCalls).toBe(2);
        expect(get().practice?.recovery?.phase).toBe('diagnosis');
        expect(get().practice?.completedAt).toBeNull();
      } else {
        await act({ kind: 'prepare_practice_repair', learnerNote: '' });
        expect(get().practice?.recovery?.phase).toBe('repair');
        await act({ kind: 'start_practice_retest' });
        expect(get().practice?.recovery?.retest?.prompt).toBe(retests[0]!.prompt);
        expect(JSON.stringify(get().practice?.recovery)).not.toContain(retests[1]!.prompt);
        await act({ kind: 'submit_practice_retest', index: 0, optionId: 'A' });
        const second = get();
        expect(second.practice?.recovery?.retest?.prompt).toBe(retests[1]!.prompt);
        expect(JSON.stringify(second.practice?.recovery)).not.toContain(firstSavedFeedback);
        expect(
          JSON.stringify(harness.services.lessonExecution.tutorContext('ws_1', route.session.id)),
        ).not.toContain(firstSavedFeedback);
        expect(
          (await act({ kind: 'submit_practice_retest', index: 1, optionId: 'B' })).practice
            ?.completedAt,
        ).toBeTruthy();
        expect(authorCalls).toBe(1);
      }
      for (const input of solves)
        if (input.purpose === 'repair_answerability') {
          expect(input.priorTeaching.some((text) => text.includes(rule))).toBe(
            exposure === 'revealed Tutor hint',
          );
          expect(JSON.stringify(input)).not.toContain(firstSavedFeedback);
          expect(JSON.stringify(input)).not.toContain('correctOptionId');
          expect(JSON.stringify(input)).not.toContain(
            retests[input.candidate.actionId === 'retest0.check' ? 1 : 0]!.prompt,
          );
        }
    },
  );

  it('retains actually rendered failed Retest feedback after reload without promoting saved hints or successful feedback', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    await act({ kind: 'prepare_practice_repair', learnerNote: '' });
    await act({ kind: 'start_practice_retest' });
    await act({ kind: 'submit_practice_retest', index: 0, optionId: 'B' });
    const visibleFailure = get().practice!.recovery!.feedback;
    const previous = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!.practiceInteractions[0]!.recovery!.rounds[0]!.content;
    const solves: TeachingContentReviewInput[] = [];
    const reviewer = harness.provider.reviewTeachingContent.bind(harness.provider);
    harness.provider.reviewTeachingContent = async (input, opts) => {
      if (input.purpose === 'repair_answerability') solves.push(structuredClone(input));
      return reviewer(input, opts);
    };
    await act({ kind: 'prepare_practice_repair', learnerNote: '' });
    for (const input of solves)
      if (input.purpose === 'repair_answerability') {
        expect(input.priorTeaching).toContain(visibleFailure);
        expect(input.priorTeaching).not.toContain(previous.retest[0]!.hint);
        expect(JSON.stringify(input)).not.toContain(previous.retest[1]!.prompt);
      }
    expect(solves).toHaveLength(2);
    expect(get().practice?.recovery?.phase).toBe('repair');
  });

  it.each(['necessary only', 'sufficient and public'] as const)(
    'requires a determinate reservoir through actual Fake preparation, reload and execution (%s)',
    async (premises) => {
      const { harness, get, act } = await failedPracticeHarness();
      const author = harness.provider.generatePracticeRepair.bind(harness.provider);
      let authorCalls = 0;
      harness.provider.generatePracticeRepair = async (input, opts) => {
        authorCalls++;
        const content = await author(input, opts);
        if (premises === 'necessary only')
          content.retest[0]!.prompt =
            '水库规则：每个阀门独立控制对应城区，阀门开启才供水，关闭就停止供水。东阀关闭，西阀开启。哪个城区仍收到供水，为什么？';
        return content;
      };
      if (premises === 'necessary only') {
        await expect(
          act({ kind: 'prepare_practice_repair', learnerNote: '' }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(authorCalls).toBe(2);
        expect(get().practice?.recovery?.teaching).toBeNull();
        await expect(act({ kind: 'start_practice_retest' })).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
        });
      } else {
        await act({ kind: 'prepare_practice_repair', learnerNote: '' });
        await act({ kind: 'start_practice_retest' });
        expect(get().practice?.recovery?.retest?.prompt).toContain('开启即可向对应城区供水');
        await act({ kind: 'submit_practice_retest', index: 0, optionId: 'A' });
        expect(get().practice?.recovery?.retest?.index).toBe(1);
        expect(
          (await act({ kind: 'submit_practice_retest', index: 1, optionId: 'A' })).practice
            ?.completedAt,
        ).toBeTruthy();
      }
    },
  );

  it('keeps the three-round support boundary when the latest proof becomes stale and recovers with a new learner note', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    for (let index = 0; index < 3; index++) {
      await act({ kind: 'prepare_practice_repair', learnerNote: '' });
      await act({ kind: 'start_practice_retest' });
      await act({ kind: 'submit_practice_retest', index: 0, optionId: 'B' });
    }
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const changed = structuredClone(state);
    changed.practiceInteractions[0]!.recovery!.rounds.at(-1)!.acceptance!.policyVersion =
      'obsolete';
    harness.repos.lessonExecution.update({ ...changed, version: state.version + 1 }, state.version);
    expect(get().practice?.recovery).toMatchObject({
      phase: 'needs_support',
      round: 3,
      teaching: null,
      retest: null,
    });
    await expect(act({ kind: 'prepare_practice_repair', learnerNote: '' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await act({
      kind: 'prepare_practice_repair',
      learnerNote: 'I have reviewed the necessary conditions.',
    });
    expect(get().practice?.recovery?.phase).toBe('repair');
    expect(get().practice?.completedAt).toBeNull();
  });

  it.each(['visible', 'hidden authoring', 'another Retest', 'unrevealed feedback'])(
    'admits a rule learned in Repair only when the new Retest owns its required facts (%s)',
    async (location) => {
      const { harness, route, get, act } = await failedPracticeHarness();
      const author = harness.provider.generatePracticeRepair.bind(harness.provider);
      const reviewer = harness.provider.reviewTeachingContent.bind(harness.provider);
      const seen: TeachingContentReviewInput[] = [];
      let calls = 0;
      const fact = 'PRIVATE_SECOND_FACT: 乙=假';
      const options = [
        {
          id: 'A',
          text: '不准入，两个条件未同时成立。',
          feedbackIfSelected: '甲真乙假，所以合取为假。',
        },
        { id: 'B', text: '准入，至少一个条件成立。', feedbackIfSelected: '合取不能用析取替代。' },
        { id: 'C', text: '准入，只需要甲成立。', feedbackIfSelected: '甲不能替代乙。' },
      ];
      harness.provider.generatePracticeRepair = async (...args) => {
        calls++;
        const packet = await author(...args);
        packet.retest[1] = {
          prompt: `独立准入案例：甲=真；${location === 'visible' ? '乙=假；' : ''}按刚学过的“且”规则判断是否准入。`,
          options,
          correctOptionId: 'A',
          hint: '分别核对两个条件。',
          explanation: fact + '。因此不准入。',
        };
        if (location === 'another Retest')
          packet.retest[0] = {
            ...packet.retest[1],
            prompt: '独立准入案例：甲=真；乙=假；请判断当前合取结果。',
          };
        if (location === 'unrevealed feedback')
          packet.retest[0]!.options[0]!.feedbackIfSelected += fact;
        return packet;
      };
      harness.provider.reviewTeachingContent = async (input, opts) => {
        seen.push(structuredClone(input));
        // The rich reviewers intentionally accept this finite authored model. They
        // cannot discharge the separately tested public solving obligation.
        if (input.purpose === 'repair_grounding') {
          expect(input.evidence.failedCase!.expectedAnswer).toBeTruthy();
          return { decisions: [], findings: [] };
        }
        if (input.purpose === 'repair_integrity') return { decisions: [], findings: [] };
        if (input.purpose === 'repair_answerability') {
          expect(JSON.stringify(input)).not.toContain(fact);
          if (input.candidate.prompt.startsWith('独立准入案例')) {
            // Independent finite solver: AND(true,false)=false. Neither a saved
            // key nor the other task may supply the absent second operand.
            const hasRule = input.priorTeaching.some((text) =>
              text.includes('“且”规则中一项成立不能替代另一项'),
            );
            const complete =
              input.candidate.prompt.includes('甲=真') && input.candidate.prompt.includes('乙=假');
            return {
              decisions: [
                {
                  actionId: input.actionIds[0],
                  answerId: hasRule && complete ? 'A' : null,
                  requiresCaseInference: true,
                  evidenceUsed: complete
                    ? 'Visible true and false operands make the taught conjunction false.'
                    : 'The second operand is absent from this public task.',
                },
              ],
              findings: [],
            };
          }
        }
        return reviewer(input, opts);
      };
      if (location === 'visible') {
        await act({ kind: 'prepare_practice_repair', learnerNote: '' });
        await act({ kind: 'start_practice_retest' });
        await act({ kind: 'submit_practice_retest', index: 0, optionId: 'A' });
        const atSecond = get().practice!.recovery!;
        expect(atSecond.retest?.index).toBe(1);
        expect(JSON.stringify(atSecond)).not.toContain(fact);
        const finished = await act({ kind: 'submit_practice_retest', index: 1, optionId: 'A' });
        expect(finished.practice?.completedAt).toBeTruthy();
        expect(calls).toBe(1);
      } else {
        await expect(
          act({ kind: 'prepare_practice_repair', learnerNote: '' }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(calls).toBe(2);
        expect(get().practice?.completedAt).toBeNull();
        expect(
          harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id)!
            .practiceInteractions[0]!.recovery!.rounds,
        ).toHaveLength(0);
      }
      const solves = seen.filter((input) => input.purpose === 'repair_answerability');
      expect(solves.length).toBeGreaterThanOrEqual(2);
      for (const input of solves)
        if (input.purpose === 'repair_answerability') {
          expect(input.actionIds).toHaveLength(1);
          expect(JSON.stringify(input)).not.toContain('expectedAnswer');
          expect(JSON.stringify(input)).not.toContain('sourceExcerpts');
        }
    },
  );

  it.each([
    'diagnosis',
    'teaching',
    'worked conclusion',
    'contrast',
    'retest explanation',
    'hint',
    'correct feedback',
    'distractor feedback',
  ])(
    'blocks incorrect Repair %s with correct keys through production admission and exactly one packet revision',
    async (field) => {
      const { harness, route, get, act } = await failedPracticeHarness();
      const author = harness.provider.generatePracticeRepair.bind(harness.provider);
      let calls = 0;
      harness.provider.generatePracticeRepair = async (...args) => {
        calls++;
        const packet = await author(...args);
        const wrong = 'A false condition makes every conjunction true.';
        if (field === 'diagnosis') packet.diagnosis.gap = wrong;
        if (field === 'teaching') packet.explanation = wrong;
        if (field === 'worked conclusion') packet.workedExample.conclusion = wrong;
        if (field === 'contrast') packet.contrast = wrong;
        if (field === 'retest explanation') packet.retest[1]!.explanation = wrong;
        if (field === 'hint') packet.retest[0]!.hint = wrong;
        if (field === 'correct feedback') packet.retest[0]!.options[0]!.feedbackIfSelected = wrong;
        if (field === 'distractor feedback')
          packet.retest[1]!.options[2]!.feedbackIfSelected = wrong;
        return packet;
      };
      const authority = recoveryAuthorityDigest(harness.db);
      await expect(act({ kind: 'prepare_practice_repair', learnerNote: '' })).rejects.toMatchObject(
        { code: 'VALIDATION_ERROR' },
      );
      expect(calls).toBe(2);
      expect(get().practice?.recovery?.phase).toBe('diagnosis');
      expect(get().practice?.completedAt).toBeNull();
      expect(
        harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id)!
          .practiceInteractions[0]!.recovery!.rounds,
      ).toHaveLength(0);
      expect(recoveryAuthorityDigest(harness.db)).toEqual(authority);
      harness.provider.generatePracticeRepair = author;
      await act({ kind: 'prepare_practice_repair', learnerNote: '' });
      expect(get().practice?.recovery?.phase).toBe('repair');
    },
  );

  it('rechecks every purpose after a feedback-only packet correction although both public tasks stay identical', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    const author = harness.provider.generatePracticeRepair.bind(harness.provider);
    const reviewer = harness.provider.reviewTeachingContent.bind(harness.provider);
    const seen: TeachingContentReviewInput[] = [];
    harness.provider.generatePracticeRepair = async (input, opts) => {
      const content = await author(input, opts);
      if (!input.revision)
        content.retest[1]!.options[2]!.feedbackIfSelected = 'Wrongly endorses this distractor.';
      return content;
    };
    harness.provider.reviewTeachingContent = async (input, opts) => {
      seen.push(structuredClone(input));
      return reviewer(input, opts);
    };
    await act({ kind: 'prepare_practice_repair', learnerNote: '' });
    expect(get().practice?.recovery?.phase).toBe('repair');
    expect(seen.map((input) => input.purpose)).toEqual([
      'repair_grounding',
      'repair_answerability',
      'repair_answerability',
      'repair_integrity',
      'repair_grounding',
      'repair_answerability',
      'repair_answerability',
      'repair_integrity',
    ]);
    const solves = seen.filter((input) => input.purpose === 'repair_answerability');
    expect(solves[0]).toEqual(solves[2]);
    expect(solves[1]).toEqual(solves[3]);
    const round = harness.repos.lessonExecution
      .getForSession(route.session.id, route.agendaItem.id)!
      .practiceInteractions[0]!.recovery!.rounds.at(-1)!;
    expect(round.acceptance?.grounding.result.findings).toEqual([]);
    expect(round.acceptance?.solves).toHaveLength(2);
  });

  it.each([
    'missing proof',
    'old policy',
    'old policy after first answer',
    'grounding input',
    'solve input',
    'integrity input',
    'binding',
    'feedback',
    'material finding',
  ])(
    'fences stored Repair %s on replay, exposure, start and submission, then allows current re-preparation',
    async (change) => {
      const { harness, route, get, act } = await failedPracticeHarness();
      const before = get();
      await act({ kind: 'prepare_practice_repair', learnerNote: '' });
      await act({ kind: 'start_practice_retest' });
      if (change === 'old policy after first answer')
        await act({ kind: 'submit_practice_retest', index: 0, optionId: 'A' });
      const state = harness.repos.lessonExecution.getForSession(
        route.session.id,
        route.agendaItem.id,
      )!;
      const changed = structuredClone(state);
      const round = changed.practiceInteractions[0]!.recovery!.rounds.at(-1)!;
      const stale = `sha256:${'0'.repeat(64)}`;
      if (change === 'missing proof') delete round.acceptance;
      if (change.startsWith('old policy'))
        round.acceptance!.policyVersion = 'practice-repair-acceptance-v1-purpose-proofs';
      if (change === 'grounding input') round.acceptance!.grounding.inputHash = stale;
      if (change === 'solve input') round.acceptance!.solves[1]!.inputHash = stale;
      if (change === 'integrity input') round.acceptance!.integrity.inputHash = stale;
      if (change === 'binding') round.acceptance!.bindingHash = stale;
      if (change === 'feedback')
        round.content.retest[1]!.options[2]!.feedbackIfSelected = 'Changed after review.';
      if (change === 'material finding')
        round.acceptance!.grounding.result.findings.push({
          itemId: 'repair',
          code: 'accuracy',
          problem: 'False saved claim.',
          repairInstruction: 'Correct it.',
        });
      harness.repos.lessonExecution.update(
        { ...changed, version: state.version + 1 },
        state.version,
      );
      expect(get().practice?.recovery).toMatchObject({
        phase: 'diagnosis',
        teaching: null,
        retest: null,
      });
      expect(
        harness.services.lessonExecution.tutorContext('ws_1', route.session.id)?.activeQuestion,
      ).toBeUndefined();
      await expect(
        harness.services.lessonExecution.command('ws_1', route.session.id, {
          command: command('recovery-fixture-2'),
          expectedSessionVersion: before.session.version,
          expectedAgendaVersion: before.agenda!.version,
          expectedAgendaItemId: route.agendaItem.id,
          expectedLessonStateVersion: before.progress!.stateVersion,
          action: { kind: 'prepare_practice_repair', learnerNote: '' },
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(act({ kind: 'start_practice_retest' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      await expect(
        act({
          kind: 'submit_practice_retest',
          index: change === 'old policy after first answer' ? 1 : 0,
          optionId: 'A',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(get().practice?.completedAt).toBeNull();
      await act({ kind: 'prepare_practice_repair', learnerNote: '' });
      expect(get().practice?.recovery?.phase).toBe('repair');
    },
  );

  it('does not fabricate proof for an unknown Fake Repair, even when its saved key is A', async () => {
    const { harness, route, act } = await failedPracticeHarness();
    const author = harness.provider.generatePracticeRepair.bind(harness.provider);
    let calls = 0;
    harness.provider.generatePracticeRepair = async (...args) => {
      calls++;
      const content = await author(...args);
      content.retest[1]!.prompt = 'Unknown case: use hidden information to decide.';
      return content;
    };
    await expect(act({ kind: 'prepare_practice_repair', learnerNote: '' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(calls).toBe(2);
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id)!
        .practiceInteractions[0]!.recovery!.rounds,
    ).toHaveLength(0);
  });

  it('keeps all quality-only opinions advisory in actual Repair preparation and completion', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    const reviewer = harness.provider.reviewTeachingContent.bind(harness.provider);
    harness.provider.reviewTeachingContent = async (input, opts) => {
      const result = await reviewer(input, opts);
      if (input.purpose === 'repair_grounding' || input.purpose === 'repair_integrity')
        return {
          ...result,
          advisories: [
            {
              itemId: 'repair',
              code: 'weak_transfer' as const,
              problem: 'Prefer more difficult cases.',
              repairInstruction: 'Make them harder.',
            },
          ],
        };
      if (input.purpose === 'repair_answerability')
        result.decisions[0]!.requiresCaseInference = false;
      return result;
    };
    const authority = recoveryAuthorityDigest(harness.db);
    await act({ kind: 'prepare_practice_repair', learnerNote: '' });
    await act({ kind: 'start_practice_retest' });
    await act({ kind: 'submit_practice_retest', index: 0, optionId: 'A' });
    expect(get().practice?.recovery?.retest?.index).toBe(1);
    const completed = await act({ kind: 'submit_practice_retest', index: 1, optionId: 'A' });
    expect(completed.practice?.completedAt).toBeTruthy();
    expect(
      harness.repos.lessonExecution.getForSession(route.session.id, route.agendaItem.id)
        ?.practiceCompletedAt,
    ).toBeTruthy();
    expect(recoveryAuthorityDigest(harness.db)).toEqual(authority);
  });

  it('reuses only current completed author/grounding/first-solve stages after cancellation during the second solve', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    const reviewer = harness.provider.reviewTeachingContent.bind(harness.provider);
    const entered = deferred<void>(),
      release = deferred<void>();
    harness.provider.reviewTeachingContent = async (input, opts) => {
      if (input.purpose === 'repair_answerability' && input.actionIds[0] === 'retest1.check') {
        entered.resolve(undefined);
        await release.promise;
      }
      return reviewer(input, opts);
    };
    const abort = new AbortController();
    const pending = act(
      { kind: 'prepare_practice_repair', learnerNote: 'Keep this reasoning.' },
      { signal: abort.signal },
    );
    await entered.promise;
    abort.abort();
    release.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(get().practice?.recovery?.phase).toBe('diagnosis');
    harness.provider.reviewTeachingContent = reviewer;
    await act({ kind: 'prepare_practice_repair', learnerNote: 'Keep this reasoning.' });
    expect(get().practice?.recovery?.phase).toBe('repair');
    expect(
      harness.db
        .prepare(
          "SELECT count(*) AS n FROM model_logical_calls WHERE workspace_id='ws_1' AND cache_status='hit' AND operation_type IN ('prepare_practice_repair','review_practice_repair')",
        )
        .get(),
    ).toEqual({ n: 3 });
    const round = harness.repos.lessonExecution
      .getForSession(route.session.id, route.agendaItem.id)!
      .practiceInteractions[0]!.recovery!.rounds.at(-1)!;
    expect(round.acceptance!.solves).toHaveLength(2);
  });

  it('ignores completed author and review caches issued under the defective contract on an explicit recovery retry', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    const originalStage = generationStages.runRecoverableGenerationStage;
    const completed: Parameters<typeof originalStage>[0][] = [];
    const spy = vi
      .spyOn(generationStages, 'runRecoverableGenerationStage')
      .mockImplementation((async (stage) => {
        const result = await originalStage(stage);
        completed.push(stage);
        return result;
      }) as typeof originalStage);
    const entered = deferred<void>(),
      release = deferred<void>();
    const reviewer = harness.provider.reviewTeachingContent.bind(harness.provider);
    const author = harness.provider.generatePracticeRepair.bind(harness.provider);
    let authorCalls = 0;
    harness.provider.generatePracticeRepair = async (input, opts) => {
      authorCalls++;
      return author(input, opts);
    };
    harness.provider.reviewTeachingContent = async (input, opts) => {
      if (
        input.purpose === 'repair_answerability' &&
        input.candidate.actionId === 'retest1.check'
      ) {
        entered.resolve(undefined);
        await release.promise;
      }
      return reviewer(input, opts);
    };
    const oldPolicy = 'practice-repair-acceptance-v1-purpose-proofs';
    const oldGeneration = 'practice-repair-v7-purpose-proofs';
    const staleCacheKeys: string[] = [];
    try {
      const abort = new AbortController();
      const pending = act(
        { kind: 'prepare_practice_repair', learnerNote: 'Retain my reasoning.' },
        { signal: abort.signal },
      );
      await entered.promise;
      abort.abort();
      release.resolve(undefined);
      await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      expect(completed).toHaveLength(3);
      expect(PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION).not.toBe(oldPolicy);
      expect(PRACTICE_REPAIR_GENERATION_VERSION).not.toBe(oldGeneration);
      // Keep genuine completed Fake dependencies, but place them exclusively
      // under the old contract identities. No historical upgrade is attempted.
      for (const stage of completed) {
        const event = harness.repos.operations
          .listEvents(stage.operationId)
          .find(
            (entry) =>
              entry.kind === 'generation_stage_completed' &&
              entry.payload.logicalCallId === stage.logicalCallId,
          );
        const currentKey = event!.payload.cacheKey as string;
        const cached = harness.repos.telemetry.peekCache(currentKey)!;
        const input = structuredClone(stage.stageIdentity) as Record<string, unknown>;
        const schemaFingerprint =
          stage.operationType === 'prepare_practice_repair'
            ? oldGeneration
            : stage.schemaFingerprint;
        if ('version' in input) input.version = oldGeneration;
        if ('policyVersion' in input) {
          input.policyVersion = oldPolicy;
          input.inputHash = practiceRepairHash({ policyVersion: oldPolicy, input: input.input });
        }
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify({
              version: 'generation-stage-v1',
              workspaceId: stage.workspaceId,
              studySessionId: stage.studySessionId,
              learningUnitId: stage.learningUnitId,
              assessmentId: stage.assessmentId,
              operationType: stage.operationType,
              schemaFingerprint,
              sourceFingerprint: stage.sourceFingerprint,
              provider: stage.provider.name,
              model: stage.providerModel,
              input,
            }),
          )
          .digest('hex');
        const cacheKey = `generation-stage-v1:${fingerprint}`;
        expect(cacheKey).not.toBe(currentKey);
        harness.db
          .prepare('DELETE FROM semantic_cache_entries WHERE cache_key = ?')
          .run(currentKey);
        harness.repos.telemetry.putCache({
          ...cached,
          cacheKey,
          schemaFingerprint,
          policyFingerprint: oldPolicy,
          validationFingerprint: fingerprint,
        });
        harness.db
          .prepare('UPDATE model_logical_calls SET schema_fingerprint = ? WHERE id = ?')
          .run(schemaFingerprint, stage.logicalCallId);
        staleCacheKeys.push(cacheKey);
      }
    } finally {
      spy.mockRestore();
      release.resolve(undefined);
    }
    harness.provider.reviewTeachingContent = reviewer;
    await act({ kind: 'prepare_practice_repair', learnerNote: 'Retain my reasoning.' });
    expect(authorCalls).toBe(2);
    expect(get().practice?.recovery?.phase).toBe('repair');
    expect(
      harness.db
        .prepare(
          "SELECT count(*) AS n FROM model_logical_calls WHERE cache_status = 'hit' AND operation_type IN ('prepare_practice_repair', 'review_practice_repair')",
        )
        .get(),
    ).toEqual({ n: 0 });
    for (const cacheKey of staleCacheKeys)
      expect(harness.repos.telemetry.peekCache(cacheKey)?.hitCount).toBe(0);
    const round = harness.repos.lessonExecution
      .getForSession(route.session.id, route.agendaItem.id)!
      .practiceInteractions[0]!.recovery!.rounds.at(-1)!;
    expect(round.acceptance!.policyVersion).toBe(PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION);
    expect(round.acceptance!.solves).toHaveLength(2);
  });

  it('persists a fast Repair failure, rejects the stale version, and permits an explicit latest-version retry without Formal consequences', async () => {
    const { harness, route, get, act, brief } = await failedPracticeHarness();
    const before = get();
    const authorityBefore = recoveryAuthorityDigest(harness.db);
    const author = harness.provider.generatePracticeRepair.bind(harness.provider);
    let calls = 0;
    harness.provider.generatePracticeRepair = async () => {
      calls++;
      throw ProviderError.network();
    };
    await expect(
      act({ kind: 'prepare_practice_repair', learnerNote: 'My accepted reasoning.' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const failed = get();
    expect(failed.progress!.stateVersion).toBeGreaterThan(before.progress!.stateVersion);
    expect(failed.practice?.recovery).toMatchObject({
      phase: 'diagnosis',
      learnerNote: 'My accepted reasoning.',
    });
    expect(failed.allowedActions).toContain('prepare_practice_repair');
    expect(failed.practice?.completedAt).toBeNull();
    expect(failed.lesson).toEqual(before.lesson);
    expect(harness.repos.teachingBriefs.get(brief.id)).toEqual(brief);
    expect(
      harness.repos.sessionAgendas
        .get(route.agenda.id)!
        .items.find((item) => item.id === route.agendaItem.id)!.state,
    ).not.toBe('completed');
    await expect(
      harness.services.lessonExecution.command('ws_1', route.session.id, {
        command: command('stale-failed-repair'),
        expectedSessionVersion: failed.session.version,
        expectedAgendaVersion: failed.agenda!.version,
        expectedAgendaItemId: route.agendaItem.id,
        expectedLessonStateVersion: before.progress!.stateVersion,
        action: { kind: 'prepare_practice_repair', learnerNote: 'My accepted reasoning.' },
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(calls).toBe(1);
    expect(recoveryAuthorityDigest(harness.db)).toEqual(authorityBefore);
    harness.provider.generatePracticeRepair = author;
    await act({ kind: 'prepare_practice_repair', learnerNote: 'My accepted reasoning.' });
    expect(get().practice?.recovery?.phase).toBe('repair');
    expect(get().practice?.completedAt).toBeNull();
    expect(get().lesson).toEqual(before.lesson);
    expect(recoveryAuthorityDigest(harness.db)).toEqual(authorityBefore);
  });

  it('reports a held defer command lease as unresolved without mutating its learning route', async () => {
    const { harness, route, get } = await failedPracticeHarness();
    const before = harness.services.studySessions.detail('ws_1', route.session.id);
    const progress = harness.repos.studyPlans.listProgress(harness.planId);
    const risks = harness.repos.coverageRisks.list('ws_1', route.session.contractVersionId);
    const input = MixedInitiativeCommandRequestSchema.parse({
      commandId: 'leased-defer-command',
      expectedSessionVersion: get().session.version,
      kind: 'defer',
      targetAgendaItemId: route.agendaItem.id,
      reason: 'Postpone this unfinished teaching item.',
    });
    const identity = `study-command:${route.session.id}:${input.commandId}`;
    const at = clock.now();
    const { operation } = harness.repos.operations.createOrGet({
      id: 'leased-defer-operation',
      workspaceId: 'ws_1',
      commandId: identity,
      idempotencyKey: identity,
      logicalOperationId: identity,
      operationType: 'study_session_command',
      studySessionId: route.session.id,
      expectedFingerprint: fnv1a32(JSON.stringify({ sessionId: route.session.id, ...input }))
        .toString(16)
        .padStart(8, '0'),
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    });
    expect(
      harness.repos.operations.claim(
        operation.id,
        'original-defer-worker',
        new Date(at.getTime() + 60_000).toISOString(),
        at.toISOString(),
      ),
    ).toBeTruthy();
    expect(() => harness.services.studySessions.command('ws_1', route.session.id, input)).toThrow(
      expect.objectContaining({
        code: 'VERSION_CONFLICT',
        details: { operationId: operation.id, operationPending: true },
      }),
    );
    expect(harness.repos.operations.getResult(operation.id)).toBeUndefined();
    expect(harness.services.studySessions.detail('ws_1', route.session.id)).toEqual(before);
    expect(harness.repos.studyPlans.listProgress(harness.planId)).toEqual(progress);
    expect(harness.repos.coverageRisks.list('ws_1', route.session.contractVersionId)).toEqual(
      risks,
    );
  });

  it('explicitly defers the failed current teaching item and its linked Plan item, replays idempotently, and retains content and the incomplete unit', async () => {
    const { harness, route, get, act, brief } = await failedPracticeHarness();
    const authorityBefore = recoveryAuthorityDigest(harness.db);
    const acceptedPlan = harness.repos.studyPlans.get(harness.planId);
    const progressBefore = harness.repos.studyPlans.listProgress(harness.planId);
    const risksBefore = harness.repos.coverageRisks.list('ws_1', route.session.contractVersionId);
    harness.provider.generatePracticeRepair = async () => {
      throw ProviderError.network();
    };
    await expect(
      act({ kind: 'prepare_practice_repair', learnerNote: 'Keep my reasoning.' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const stateBeforeDefer = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const input = {
      commandId: 'explicit-failed-practice-defer',
      expectedSessionVersion: get().session.version,
      kind: 'defer',
      targetAgendaItemId: route.agendaItem.id,
      reason: '延期本节内容，保留缺口',
    };
    const result = harness.services.studySessions.command('ws_1', route.session.id, input);
    expect(result.agenda.items.find((item) => item.id === route.agendaItem.id)!.state).toBe(
      'deferred',
    );
    const authoritative = harness.services.studySessions.detail('ws_1', route.session.id);
    expect(authoritative.session).toEqual(result.session);
    expect(authoritative.agenda).toEqual(result.agenda);
    expect(result.session.currentAgendaItemId).not.toBe(route.agendaItem.id);
    const planProgress = harness.repos.studyPlans.listProgress(harness.planId);
    expect(
      planProgress.find((item) => item.planItemId === route.agendaItem.linkedPlanItemId)!.state,
    ).toBe('deferred');
    expect(
      planProgress.filter((item) => item.planItemId !== route.agendaItem.linkedPlanItemId),
    ).toEqual(
      progressBefore.filter((item) => item.planItemId !== route.agendaItem.linkedPlanItemId),
    );
    const risks = harness.repos.coverageRisks.list('ws_1', route.session.contractVersionId);
    expect(risks).toHaveLength(risksBefore.length + 1);
    expect(risks.find((risk) => risk.learnerDecisionId === input.commandId)).toMatchObject({
      status: 'deferred',
      facets: ['intentionally_deferred'],
      referencedCurriculumNodeIds: [route.agendaItem.learningUnitId],
      referencedEvidenceIds: [],
    });
    const events = harness.db
      .prepare(
        "SELECT payload FROM session_agenda_events WHERE agenda_id = ? AND event_type = 'agenda_item_deferred'",
      )
      .all(route.agenda.id) as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      agendaItemId: route.agendaItem.id,
      planItemId: route.agendaItem.linkedPlanItemId,
    });
    expect(harness.services.studySessions.command('ws_1', route.session.id, input)).toEqual(result);
    expect(
      harness.services.studySessions.command('ws_1', route.session.id, {
        ...input,
        commandId: 'repeat-failed-practice-defer',
        expectedSessionVersion: result.session.version,
      }),
    ).toEqual(result);
    expect(harness.repos.studySessions.get(route.session.id)).toEqual(result.session);
    expect(harness.repos.sessionAgendas.get(route.agenda.id)).toEqual(result.agenda);
    expect(harness.repos.coverageRisks.list('ws_1', route.session.contractVersionId)).toEqual(
      risks,
    );
    expect(
      harness.db
        .prepare(
          "SELECT count(*) AS n FROM session_agenda_events WHERE agenda_id = ? AND event_type = 'agenda_item_deferred'",
        )
        .get(route.agenda.id),
    ).toEqual({ n: 1 });
    expect(
      harness.db
        .prepare(
          "SELECT count(*) AS n FROM coverage_risk_events WHERE risk_id = ? AND event_type = 'learner_deferred'",
        )
        .get(risks.find((risk) => risk.learnerDecisionId === input.commandId)!.id),
    ).toEqual({ n: 1 });
    expect(harness.repos.studyPlans.listProgress(harness.planId)).toEqual(planProgress);
    expect(harness.repos.lessonExecution.get(stateBeforeDefer.id)).toEqual(stateBeforeDefer);
    expect(stateBeforeDefer.practiceCompletedAt).toBeNull();
    expect(harness.repos.teachingBriefs.get(brief.id)).toEqual(brief);
    expect(harness.repos.studyPlans.get(harness.planId)).toEqual(acceptedPlan);
    const unit = harness.services.courseLearningProgress
      .get('ws_1')
      .units.find((item) => item.id === route.agendaItem.learningUnitId)!;
    expect(unit.teachingCompleted).toBe(0);
    expect(unit.formalState).not.toBe('complete');
    expect(recoveryAuthorityDigest(harness.db)).toEqual(authorityBefore);
    expect(
      harness.services.courseOverview
        .get('ws_1')
        .riskSummary.highlights.some((issue) => issue.category === 'intentional_deferral'),
    ).toBe(true);
  });

  it('replays a historical defer receipt after the live route advances without repeating domain writes', async () => {
    const { harness, route, get, brief } = await failedPracticeHarness();
    const authorityBefore = recoveryAuthorityDigest(harness.db);
    const lessonBefore = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const input = {
      commandId: 'historical-defer-replay',
      expectedSessionVersion: get().session.version,
      kind: 'defer',
      targetAgendaItemId: route.agendaItem.id,
      reason: 'Keep the original defer input unchanged.',
    };
    const receipt = harness.services.studySessions.command('ws_1', route.session.id, input);
    const nextTarget = receipt.agenda.items.find(
      (item) =>
        item.id !== route.agendaItem.id &&
        !['completed', 'deferred', 'cancelled'].includes(item.state),
    );
    expect(nextTarget).toBeDefined();
    harness.services.studySessions.command('ws_1', route.session.id, {
      commandId: 'another-intended-defer',
      expectedSessionVersion: receipt.session.version,
      kind: 'defer',
      targetAgendaItemId: nextTarget!.id,
      reason: 'A separate learner action advances the live route.',
    });
    const live = harness.services.studySessions.detail('ws_1', route.session.id);
    expect(live.session.version).toBeGreaterThan(receipt.session.version);
    expect(live.agenda.version).toBeGreaterThan(receipt.agenda.version);
    const risks = harness.repos.coverageRisks.list('ws_1', route.session.contractVersionId);
    const progress = harness.repos.studyPlans.listProgress(harness.planId);
    const events = harness.db
      .prepare(
        "SELECT * FROM session_agenda_events WHERE agenda_id = ? AND event_type = 'agenda_item_deferred'",
      )
      .all(route.agenda.id);
    const riskEvents = harness.db
      .prepare("SELECT * FROM coverage_risk_events WHERE event_type = 'learner_deferred'")
      .all();
    expect(events).toHaveLength(2);
    expect(riskEvents).toHaveLength(2);
    expect(risks.filter((risk) => risk.learnerDecisionId === input.commandId)).toHaveLength(1);
    expect(harness.services.studySessions.command('ws_1', route.session.id, input)).toEqual(
      receipt,
    );
    expect(harness.services.studySessions.detail('ws_1', route.session.id)).toEqual(live);
    expect(harness.repos.studyPlans.listProgress(harness.planId)).toEqual(progress);
    expect(harness.repos.coverageRisks.list('ws_1', route.session.contractVersionId)).toEqual(
      risks,
    );
    expect(
      harness.db
        .prepare(
          "SELECT * FROM session_agenda_events WHERE agenda_id = ? AND event_type = 'agenda_item_deferred'",
        )
        .all(route.agenda.id),
    ).toEqual(events);
    expect(
      harness.db
        .prepare("SELECT * FROM coverage_risk_events WHERE event_type = 'learner_deferred'")
        .all(),
    ).toEqual(riskEvents);
    expect(
      harness.db
        .prepare(
          'SELECT count(*) AS n FROM agent_operations WHERE workspace_id = ? AND command_id = ?',
        )
        .get('ws_1', `study-command:${route.session.id}:${input.commandId}`),
    ).toEqual({ n: 1 });
    expect(harness.repos.lessonExecution.get(lessonBefore.id)).toEqual(lessonBefore);
    expect(harness.repos.teachingBriefs.get(brief.id)).toEqual(brief);
    expect(recoveryAuthorityDigest(harness.db)).toEqual(authorityBefore);
  });

  it('permits explicit defer while a Repair result is unknown and rejects the running worker when it returns late', async () => {
    const { harness, route, get, act, brief } = await failedPracticeHarness();
    const started = deferred<void>();
    const gate = deferred<void>();
    const author = harness.provider.generatePracticeRepair.bind(harness.provider);
    let calls = 0;
    harness.provider.generatePracticeRepair = async (...args) => {
      calls++;
      started.resolve(undefined);
      await gate.promise;
      return author(...args);
    };
    const authorityBefore = recoveryAuthorityDigest(harness.db);
    const pending = act({
      kind: 'prepare_practice_repair',
      learnerNote: 'The network result is unknown.',
    });
    await started.promise;
    expect(get().practice?.recovery?.phase).toBe('preparing');
    const preparingState = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    const result = harness.services.studySessions.command('ws_1', route.session.id, {
      commandId: 'defer-running-practice-repair',
      expectedSessionVersion: get().session.version,
      kind: 'defer',
      targetAgendaItemId: route.agendaItem.id,
      reason: 'Explicitly postpone while preserving the gap.',
    });
    expect(result.agenda.items.find((item) => item.id === route.agendaItem.id)!.state).toBe(
      'deferred',
    );
    gate.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(calls).toBe(1);
    expect(harness.repos.lessonExecution.get(preparingState.id)).toEqual(preparingState);
    expect(preparingState.practiceCompletedAt).toBeNull();
    expect(harness.repos.teachingBriefs.get(brief.id)).toEqual(brief);
    expect(recoveryAuthorityDigest(harness.db)).toEqual(authorityBefore);
  });

  it('corrects one independently rejected repair within the same preparation without granting credit', async () => {
    const { harness, get, act } = await failedPracticeHarness();
    const author = harness.provider.generatePracticeRepair.bind(harness.provider);
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    const requests: PracticeRepairInput[] = [];
    let reviews = 0;
    harness.provider.generatePracticeRepair = async (input, opts) => {
      requests.push(structuredClone(input));
      const content = await author(input, opts);
      if (!input.revision) content.explanation = 'The explanation omitted the necessary condition.';
      return content;
    };
    harness.provider.reviewTeachingContent = async (input, opts) => {
      const result = await review(input, opts);
      if (reviews++ === 0)
        result.findings.push({
          itemId: 'repair',
          code: 'insufficient_evidence',
          problem: 'The explanation omitted the necessary condition.',
          repairInstruction: 'State the missing condition in the explanation.',
        });
      return result;
    };
    await act({ kind: 'prepare_practice_repair', learnerNote: 'I confused the conditions.' });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.revision?.findings.join(' ')).toContain('necessary condition');
    expect(get().practice?.recovery?.phase).toBe('repair');
    expect(harness.repos.mastery.listByWorkspace('ws_1')).toHaveLength(0);
  });
  it('recovers the accepted author stage after review interruption and fences concurrent preparation', async () => {
    const { harness, get, act } = await failedPracticeHarness();
    const original = harness.provider.generatePracticeRepair.bind(harness.provider);
    let authorCalls = 0;
    harness.provider.generatePracticeRepair = async (...args) => {
      authorCalls++;
      return original(...args);
    };
    const review = harness.provider.reviewTeachingContent.bind(harness.provider);
    const started = deferred<void>();
    const gate = deferred<void>();
    harness.provider.reviewTeachingContent = async (...args) => {
      started.resolve(undefined);
      await gate.promise;
      return review(...args);
    };
    const abort = new AbortController();
    const pending = act(
      { kind: 'prepare_practice_repair', learnerNote: 'I treated one condition as sufficient.' },
      { signal: abort.signal },
    );
    await started.promise;
    expect(get().practice?.recovery).toMatchObject({
      phase: 'preparing',
      learnerNote: 'I treated one condition as sufficient.',
    });
    await expect(act({ kind: 'prepare_practice_repair', learnerNote: '' })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    abort.abort();
    gate.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(get().practice?.recovery?.phase).toBe('diagnosis');
    harness.provider.reviewTeachingContent = review;
    await act({
      kind: 'prepare_practice_repair',
      learnerNote: 'I treated one condition as sufficient.',
    });
    expect(authorCalls).toBe(1);
    expect(get().practice?.recovery?.phase).toBe('repair');
    expect(
      harness.db
        .prepare(
          "SELECT count(*) AS n FROM model_logical_calls WHERE workspace_id='ws_1' AND cache_status='hit'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it('rejects a delayed result after the owning lesson changes and leaves mastery untouched', async () => {
    const { harness, route, act } = await failedPracticeHarness();
    const original = harness.provider.generatePracticeRepair.bind(harness.provider);
    const gate = deferred<void>();
    const started = deferred<void>();
    harness.provider.generatePracticeRepair = async (...args) => {
      started.resolve(undefined);
      await gate.promise;
      return original(...args);
    };
    const pending = act({ kind: 'prepare_practice_repair', learnerNote: '' });
    await started.promise;
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    harness.repos.lessonExecution.update({ ...state, version: state.version + 1 }, state.version);
    gate.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      harness.repos.lessonExecution.get(state.id)!.practiceInteractions[0]!.recovery?.rounds,
    ).toHaveLength(0);
    expect(harness.repos.mastery.listByWorkspace('ws_1')).toHaveLength(0);
  });

  it('retains three failed rounds as unresolved and never advances the course by exhaustion', async () => {
    const { harness, route, get, act } = await failedPracticeHarness();
    for (let i = 0; i < 3; i++) {
      await act({ kind: 'prepare_practice_repair', learnerNote: '' });
      await act({ kind: 'start_practice_retest' });
      await act({ kind: 'submit_practice_retest', index: 0, optionId: 'B' });
    }
    expect(get().practice?.recovery?.phase).toBe('needs_support');
    expect(get().practice?.completedAt).toBeNull();
    await expect(act({ kind: 'prepare_practice_repair', learnerNote: '' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(
      harness.services.lessonExecution.tutorContext('ws_1', route.session.id)?.practiceRecovery,
    ).toMatchObject({ phase: 'needs_support', credit: 'none' });
    await act({
      kind: 'prepare_practice_repair',
      learnerNote: 'After reviewing the rule, I now distinguish the mandatory condition.',
    });
    expect(get().practice?.recovery?.phase).toBe('repair');
    const state = harness.repos.lessonExecution.getForSession(
      route.session.id,
      route.agendaItem.id,
    )!;
    expect(state.practiceInteractions[0]!.recovery!.rounds).toHaveLength(3);
    expect(state.practiceInteractions[0]!.recovery!.rounds.at(-1)!.ordinal).toBe(4);
    expect(
      harness.repos.lessonExecution
        .listEvents(state.id)
        .some((event) => Boolean(event.payload.archivedRound)),
    ).toBe(true);
    expect(harness.repos.studySessions.get(route.session.id)?.currentAgendaItemId).toBe(
      route.agendaItem.id,
    );
    expect(harness.repos.mastery.listByWorkspace('ws_1')).toHaveLength(0);
    expect(harness.repos.formalProgression.listEvidenceForWorkspace('ws_1')).toHaveLength(0);
  });
});
