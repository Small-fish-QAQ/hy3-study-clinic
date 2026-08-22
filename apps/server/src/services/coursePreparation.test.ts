import { afterEach, describe, expect, it } from 'vitest';
import {
  ApiErrorCode,
  type ConceptAnalysisPayload,
  type CourseMapProposalPayload,
  type CurriculumDetailProposalPayload,
  type CurriculumProposalPayload,
  type LearningContract,
  type LearningContractDraftFields,
  type StudyPlanProposalPayload,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider, type FakeProviderOptions } from '../llm/fakeProvider.js';
import type {
  ConceptAnalysisInput,
  CourseMapProposalInput,
  CurriculumDetailProposalInput,
  CurriculumProposalInput,
  ProviderCallOptions,
  StudyPlanProposalInput,
} from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeConcept, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { buildTestApp } from '../testing/testApp.js';
import { fixedClock } from '../util/ids.js';
import {
  COURSE_MAP_CURRICULUM_GENERATION_POLICY,
  COURSE_PREPARATION_POLICY_ID,
  LEGACY_CURRICULUM_GENERATION_POLICY,
} from './curriculum.js';
import { createServices, type Services } from './index.js';

const QUOTE = 'Working memory is limited.';
const clock = fixedClock(T0);
const databases: SqliteDb[] = [];

class TrackingProvider extends FakeProvider {
  analyzeCalls = 0;
  curriculumCalls = 0;
  detailCalls = 0;
  studyPlanCalls = 0;
  failCurriculum = false;
  sourceOnlyCurriculum = false;
  onAnalyzeStarted: (() => void) | null = null;
  analyzeGate: Promise<void> | null = null;
  onCurriculumStarted: (() => void) | null = null;
  curriculumGate: Promise<void> | null = null;
  onStudyPlanStarted: (() => void) | null = null;
  studyPlanGate: Promise<void> | null = null;
  onDetailStarted: ((call: number) => void) | null = null;
  detailGateAtCall: number | null = null;
  detailGate: Promise<void> | null = null;
  failDetailAtCall: number | null = null;

  constructor(options: FakeProviderOptions = {}) {
    super(options);
  }

  override async analyzeConcepts(
    input: ConceptAnalysisInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptAnalysisPayload> {
    this.analyzeCalls += 1;
    this.onAnalyzeStarted?.();
    if (this.analyzeGate) await this.analyzeGate;
    return super.analyzeConcepts(input, opts);
  }

  override async proposeCurriculum(
    input: CurriculumProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload> {
    this.curriculumCalls += 1;
    const gate = this.curriculumGate;
    this.curriculumGate = null;
    const started = this.onCurriculumStarted;
    this.onCurriculumStarted = null;
    started?.();
    if (gate) await gate;
    if (this.failCurriculum) throw new Error('controlled Curriculum failure');
    return super.proposeCurriculum(
      this.sourceOnlyCurriculum
        ? {
            ...input,
            concepts: [],
            canonicalConcepts: [],
            allowedCanonicalConceptIds: [],
            evidenceCatalog: [],
          }
        : input,
      opts,
    );
  }

  override async proposeCourseMap(
    input: CourseMapProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CourseMapProposalPayload> {
    this.curriculumCalls += 1;
    const gate = this.curriculumGate;
    this.curriculumGate = null;
    const started = this.onCurriculumStarted;
    this.onCurriculumStarted = null;
    started?.();
    if (gate) await gate;
    if (this.failCurriculum) throw new Error('controlled Curriculum failure');
    return super.proposeCourseMap(input, opts);
  }

  override async proposeCurriculumDetails(
    input: CurriculumDetailProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumDetailProposalPayload> {
    this.detailCalls += 1;
    const call = this.detailCalls;
    this.onDetailStarted?.(call);
    if (this.detailGateAtCall === call && this.detailGate) await this.detailGate;
    if (this.failDetailAtCall === call) throw new Error('controlled Curriculum detail failure');
    return super.proposeCurriculumDetails(input, opts);
  }

  override async proposeStudyPlan(
    input: StudyPlanProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalPayload> {
    this.studyPlanCalls += 1;
    const gate = this.studyPlanGate;
    this.studyPlanGate = null;
    const started = this.onStudyPlanStarted;
    this.onStudyPlanStarted = null;
    started?.();
    if (gate) await gate;
    return super.proposeStudyPlan(input, opts);
  }
}

interface Harness {
  db: SqliteDb;
  repos: Repositories;
  provider: TrackingProvider;
  services: Services;
  contract: LearningContract;
}

function command(id: string, actor: 'learner' | 'local' = 'learner', workspaceId = 'ws_1') {
  return { commandId: id, idempotencyKey: id, workspaceId, actor } as const;
}

function contractFields(
  roleId: string,
  roleVersion: number,
  minutesPerDay = 30,
  preferredSessionMinutes = 30,
): LearningContractDraftFields {
  return {
    intent: 'Learn working-memory capacity.',
    targetOutcome: {
      description: 'Explain the source accurately.',
      targetScore: null,
      credential: null,
    },
    deadline: null,
    studyBudget: {
      minutesPerDay,
      minutesPerWeek: null,
      preferredSessionMinutes,
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

function createHarness(
  options: {
    provider?: TrackingProvider;
    withConcept?: boolean;
    sectionCount?: number;
    compactMaterial?: boolean;
    minutesPerDay?: number;
    preferredSessionMinutes?: number;
  } = {},
): Harness {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrate(db);
  const repos = createRepositories(db);
  const provider = options.provider ?? new TrackingProvider();
  repos.workspaces.insert(makeWorkspace({ name: 'Memory course' }));
  const sections = Array.from({ length: options.sectionCount ?? 1 }, (_, index) => {
    const base =
      index === 0
        ? `${QUOTE} Working memory section ${index + 1} has a bounded claim.`
        : `Working memory section ${index + 1} has a bounded claim.`;
    return options.compactMaterial ? base : base.padEnd(520, 'x');
  });
  const materialContent = sections.join('\n');
  let sourceOffset = 0;
  const blocks = sections.map((content, index) => {
    const startOffset = sourceOffset;
    sourceOffset += content.length + 1;
    const heading = `Working memory ${index + 1}`;
    return makeBlock({
      id: `blk_${index + 1}`,
      index,
      content,
      startOffset,
      endOffset: startOffset + content.length,
      heading,
      headingPath: [heading],
    });
  });
  repos.materials.insertWithBlocks(
    makeMaterial({
      content: materialContent,
      charCount: materialContent.length,
      title: 'Memory notes',
    }),
    blocks,
  );
  if (options.withConcept) addCurrentConcept(repos, 'con_seed');

  const services = createServices({ repos, provider, clock });
  const roleProposal = services.materialRoles.propose({
    command: command('role-propose', 'local'),
    materialId: 'mat_1',
    role: 'course_material',
    expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_1')!.id,
  });
  const role = services.materialRoles.confirm({
    command: command('role-confirm'),
    assignmentId: roleProposal.id,
    expectedVersion: roleProposal.version,
  });
  const draft = services.learningContracts.createDraft({
    command: command('contract-create'),
    fields: contractFields(
      role.id,
      role.version,
      options.minutesPerDay,
      options.preferredSessionMinutes,
    ),
    predecessorContractId: null,
    expectedActiveContractId: null,
  }).contract;
  const proposed = services.learningContracts.transition({
    command: command('contract-propose'),
    contractId: draft.id,
    expectedVersion: draft.version,
    transition: 'propose',
  }).contract;
  const contract = services.learningContracts.transition({
    command: command('contract-confirm'),
    contractId: proposed.id,
    expectedVersion: proposed.version,
    transition: 'confirm',
  }).contract;
  return { db, repos, provider, services, contract };
}

function addCurrentConcept(repos: Repositories, id: string): void {
  repos.materials.addConcepts([
    makeConcept({
      id,
      materialId: 'mat_1',
      name: `Working memory ${id}`,
      summary: QUOTE,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
    }),
  ]);
}

function runRequest(preparation: ReturnType<Services['coursePreparation']['get']>) {
  if (!preparation.operationKey) throw new Error('Expected resumable Course Preparation.');
  return {
    command: command(preparation.operationKey),
    expectedRevision: preparation.revision,
  };
}

async function acceptSourceOnlyCurriculum(harness: Harness): Promise<string> {
  const { repos, provider, services, contract } = harness;
  provider.sourceOnlyCurriculum = true;
  const proposed = await services.curriculum.propose(
    {
      command: command('source-only-propose'),
      contractId: contract.id,
      expectedContractVersion: contract.version,
      predecessorCurriculumId: null,
      expectedActiveCurriculumId: null,
    },
    { generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY },
  );
  const accepted = services.curriculum.accept({
    command: command('source-only-accept'),
    curriculumId: proposed.curriculum.id,
    expectedVersion: proposed.curriculum.version,
    expectedContractId: contract.id,
    expectedExecutionSourceManifestFingerprint:
      proposed.curriculum.executionSourceManifest.fingerprint,
    acceptanceBasis: 'learner_review',
  }).curriculum;
  provider.sourceOnlyCurriculum = false;
  expect(repos.studyPlans.list('ws_1')).toEqual([]);
  return accepted.id;
}

function activateReplacementRevision(repos: Repositories): void {
  const material = repos.materials.get('mat_1')!;
  const revised = 'Working memory has a revised source.';
  repos.materialRevisions.stage({
    revisionId: 'rev_replacement',
    material: {
      ...material,
      content: revised,
      charCount: revised.length,
      updatedAt: T0,
    },
    blocks: [
      makeBlock({
        id: 'blk_replacement',
        content: revised,
        startOffset: 0,
        endOffset: revised.length,
      }),
    ],
    originalData: null,
    parserFingerprint: 'parser-replacement',
    contentFingerprint: 'content-replacement',
    parserAttemptId: 'parse-replacement',
    createdAt: T0,
  });
  repos.materialRevisions.activate('mat_1', 'rev_replacement', T0);
}

function addReplacementConcept(repos: Repositories): void {
  const revised = 'Working memory has a revised source.';
  repos.materials.addConcepts([
    makeConcept({
      id: 'con_replacement',
      name: 'Revised working memory',
      summary: revised,
      grounding: {
        blockId: 'blk_replacement',
        quote: revised,
        startOffset: 0,
        endOffset: revised.length,
        occurrenceCount: 1,
        reanchored: false,
      },
    }),
  ]);
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()!.close();
});

describe('Course Preparation coordinator', () => {
  it('keeps preparation projection reads side-effect free', () => {
    const { repos, provider, services } = createHarness();

    const first = services.coursePreparation.get('ws_1');
    const second = services.coursePreparation.get('ws_1');

    expect(second).toEqual(first);
    expect(provider.analyzeCalls).toBe(0);
    expect(provider.curriculumCalls).toBe(0);
    expect(provider.studyPlanCalls).toBe(0);
    expect(repos.materials.getConcepts('mat_1')).toEqual([]);
    expect(repos.curricula.list('ws_1')).toEqual([]);
    expect(repos.studyPlans.list('ws_1')).toEqual([]);
    expect(repos.operations.listForWorkspace('ws_1', 'course_preparation')).toEqual([]);
  });

  it('automatically advances a fresh confirmed Course to one course-plan decision', async () => {
    const { repos, provider, services } = createHarness();
    const initial = services.coursePreparation.get('ws_1');

    expect(initial).toMatchObject({
      state: 'preparing_concepts',
      machineAction: 'prepare_concepts',
      learnerAction: 'resume_preparation',
      learnerDecisionRequired: false,
      checkpoints: { materials: 'complete', concepts: 'in_progress' },
    });

    const result = await services.coursePreparation.run(runRequest(initial));

    expect(result.preparation).toMatchObject({
      state: 'course_plan_ready',
      machineAction: null,
      learnerAction: 'review_course_plan',
      learnerDecisionRequired: true,
      checkpoints: {
        materials: 'complete',
        concepts: 'complete',
        courseStructure: 'complete',
        coursePlan: 'complete',
      },
    });
    expect(provider.analyzeCalls).toBe(1);
    expect(provider.curriculumCalls).toBe(1);
    expect(provider.detailCalls).toBe(0);
    expect(provider.studyPlanCalls).toBe(1);
    expect(repos.curricula.list('ws_1').map((item) => item.status)).toEqual(['accepted']);
    expect(repos.studyPlans.list('ws_1').map((item) => item.status)).toEqual(['proposed']);
  });

  it('returns a bounded diagnostic when detail materialization would exceed two batches', async () => {
    const harness = createHarness({ withConcept: true, sectionCount: 120 });

    await expect(
      harness.services.curriculum.propose(
        {
          command: command('detail-batch-overflow'),
          contractId: harness.contract.id,
          expectedContractVersion: harness.contract.version,
          predecessorCurriculumId: null,
          expectedActiveCurriculumId: null,
        },
        { generationPolicy: COURSE_MAP_CURRICULUM_GENERATION_POLICY },
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: { kind: 'curriculum_detail_batch_bound_exceeded', maxDetailBatches: 2 },
    });
    expect(harness.repos.curricula.list('ws_1')).toEqual([]);
  });

  it('fences a stale MaterialRevision during the second fixed detail batch', async () => {
    const provider = new TrackingProvider();
    let releaseDetail = () => undefined;
    provider.detailGateAtCall = 2;
    provider.detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    let signalSecondDetail = () => undefined;
    const secondDetailStarted = new Promise<void>((resolve) => {
      signalSecondDetail = resolve;
    });
    provider.onDetailStarted = (call) => {
      if (call === 2) signalSecondDetail();
    };
    const harness = createHarness({ provider, withConcept: true, sectionCount: 51 });
    const pending = harness.services.curriculum.propose(
      {
        command: command('stale-second-detail'),
        contractId: harness.contract.id,
        expectedContractVersion: harness.contract.version,
        predecessorCurriculumId: null,
        expectedActiveCurriculumId: null,
      },
      { generationPolicy: COURSE_MAP_CURRICULUM_GENERATION_POLICY },
    );

    await secondDetailStarted;
    activateReplacementRevision(harness.repos);
    releaseDetail();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
    expect(provider.detailCalls).toBe(2);
    expect(harness.repos.curricula.list('ws_1')).toEqual([]);
  });

  it('cancels between fixed detail batches without persisting a partial Curriculum', async () => {
    const provider = new TrackingProvider();
    const abort = new AbortController();
    provider.onDetailStarted = (call) => {
      if (call === 2) abort.abort();
    };
    const harness = createHarness({ provider, withConcept: true, sectionCount: 51 });

    await expect(
      harness.services.curriculum.propose(
        {
          command: command('cancel-second-detail'),
          contractId: harness.contract.id,
          expectedContractVersion: harness.contract.version,
          predecessorCurriculumId: null,
          expectedActiveCurriculumId: null,
        },
        {
          generationPolicy: COURSE_MAP_CURRICULUM_GENERATION_POLICY,
          signal: abort.signal,
        },
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
    expect(provider.detailCalls).toBe(2);
    expect(harness.repos.curricula.list('ws_1')).toEqual([]);
  });

  it('preserves an accepted predecessor when the second detail batch fails', async () => {
    const harness = createHarness({ withConcept: true, sectionCount: 51 });
    const predecessorId = await acceptSourceOnlyCurriculum(harness);
    const predecessor = structuredClone(harness.repos.curricula.get(predecessorId));
    harness.provider.detailCalls = 0;
    harness.provider.failDetailAtCall = 2;

    await expect(
      harness.services.curriculum.propose(
        {
          command: command('failed-second-detail'),
          contractId: harness.contract.id,
          expectedContractVersion: harness.contract.version,
          predecessorCurriculumId: predecessorId,
          expectedActiveCurriculumId: harness.repos.courseExecution.get('ws_1').activeCurriculumId,
        },
        { generationPolicy: COURSE_MAP_CURRICULUM_GENERATION_POLICY },
      ),
    ).rejects.toThrow('controlled Curriculum detail failure');
    expect(harness.provider.detailCalls).toBe(2);
    expect(harness.repos.curricula.get(predecessorId)).toEqual(predecessor);
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(1);
  });

  it('rebuilds Concepts for a replacement revision while rejecting the stale request', async () => {
    const { repos, provider, services } = createHarness({ withConcept: true });
    const current = services.coursePreparation.get('ws_1');
    expect(current.machineAction).toBe('prepare_course_structure');
    expect(current.checkpoints.concepts).toBe('complete');

    activateReplacementRevision(repos);
    const stale = services.coursePreparation.get('ws_1');
    expect(stale).toMatchObject({
      state: 'preparing_concepts',
      machineAction: 'prepare_concepts',
      checkpoints: { concepts: 'in_progress' },
    });
    expect(stale.revision).not.toBe(current.revision);
    await expect(services.coursePreparation.run(runRequest(current))).rejects.toMatchObject({
      code: ApiErrorCode.VersionConflict,
    });
    expect(provider.analyzeCalls).toBe(0);
    expect(provider.curriculumCalls).toBe(0);

    const result = await services.coursePreparation.run(runRequest(stale));
    expect(result.preparation.state).toBe('course_plan_ready');
    expect(provider.analyzeCalls).toBe(1);
    expect(provider.curriculumCalls).toBe(1);
    expect(provider.studyPlanCalls).toBe(1);
    expect(repos.materials.getConcepts('mat_1')).not.toEqual([]);
  });

  it('repairs an accepted source-only Curriculum once Concepts are current', async () => {
    const harness = createHarness();
    const predecessorId = await acceptSourceOnlyCurriculum(harness);
    addCurrentConcept(harness.repos, 'con_recovery');
    harness.provider.curriculumCalls = 0;

    const readiness = harness.services.coursePreparation.get('ws_1');
    expect(readiness).toMatchObject({
      machineAction: 'prepare_course_structure',
      learnerDecisionRequired: false,
      checkpoints: { concepts: 'complete', courseStructure: 'in_progress' },
    });
    const result = await harness.services.coursePreparation.run(runRequest(readiness));

    expect(result.preparation.state).toBe('course_plan_ready');
    expect(harness.provider.curriculumCalls).toBe(1);
    expect(harness.repos.curricula.get(predecessorId)?.status).toBe('accepted');
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(2);
    expect(harness.repos.studyPlans.list('ws_1')).toHaveLength(1);
  });

  it('stops at a learner-governed Curriculum proposal and does not duplicate work on reads or run', async () => {
    const harness = createHarness({ withConcept: true });
    await harness.services.curriculum.propose({
      command: command('learner-curriculum-proposal'),
      contractId: harness.contract.id,
      expectedContractVersion: harness.contract.version,
      predecessorCurriculumId: null,
      expectedActiveCurriculumId: null,
    });
    const calls = harness.provider.curriculumCalls;

    const first = harness.services.coursePreparation.get('ws_1');
    const second = harness.services.coursePreparation.get('ws_1');
    expect(first).toMatchObject({
      state: 'awaiting_required_governance',
      machineAction: null,
      learnerAction: 'review_course_structure',
      learnerDecisionRequired: true,
    });
    expect(second).toEqual(first);
    const result = await harness.services.coursePreparation.run({
      command: command('governance-noop'),
      expectedRevision: first.revision,
    });
    expect(result.preparation).toEqual(first);
    expect(harness.provider.curriculumCalls).toBe(calls);
    expect(harness.repos.studyPlans.list('ws_1')).toEqual([]);
  });

  it('does not supersede a learner Curriculum proposal created during preparation', async () => {
    const provider = new TrackingProvider();
    let releaseCurriculum = () => undefined;
    provider.curriculumGate = new Promise<void>((resolve) => {
      releaseCurriculum = resolve;
    });
    const curriculumStarted = new Promise<void>((resolve) => {
      provider.onCurriculumStarted = resolve;
    });
    const harness = createHarness({ provider, withConcept: true });
    const preparation = harness.services.coursePreparation.get('ws_1');
    const pending = harness.services.coursePreparation.run(runRequest(preparation));

    await curriculumStarted;
    const learnerProposal = await harness.services.curriculum.propose({
      command: command('concurrent-learner-curriculum'),
      contractId: harness.contract.id,
      expectedContractVersion: harness.contract.version,
      predecessorCurriculumId: null,
      expectedActiveCurriculumId: null,
    });
    releaseCurriculum();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
    expect(harness.repos.curricula.list('ws_1')).toEqual([learnerProposal.curriculum]);
    expect(
      harness.repos.curricula
        .listEvents(learnerProposal.curriculum.id)
        .find((event) => event.eventType === 'proposed'),
    ).toMatchObject({ actor: 'learner' });
    expect(harness.repos.studyPlans.list('ws_1')).toEqual([]);
    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'awaiting_required_governance',
      learnerAction: 'review_course_structure',
      learnerDecisionRequired: true,
    });
  });

  it('preserves an accepted predecessor and exposes recoverable failure after provider failure', async () => {
    const harness = createHarness();
    const predecessorId = await acceptSourceOnlyCurriculum(harness);
    addCurrentConcept(harness.repos, 'con_failure_recovery');
    const predecessor = structuredClone(harness.repos.curricula.get(predecessorId));
    harness.provider.failCurriculum = true;
    const preparation = harness.services.coursePreparation.get('ws_1');

    await expect(harness.services.coursePreparation.run(runRequest(preparation))).rejects.toThrow(
      'controlled Curriculum failure',
    );

    expect(harness.repos.curricula.get(predecessorId)).toEqual(predecessor);
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(1);
    expect(harness.repos.studyPlans.list('ws_1')).toEqual([]);
    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'failed_recoverable',
      machineAction: 'prepare_course_structure',
      learnerAction: 'resume_preparation',
      failure: { action: 'prepare_course_structure', retryable: true },
    });
  });

  it('retains a structural Curriculum failure after an earlier concept step and does not retry it', async () => {
    const harness = createHarness({ provider: new TrackingProvider() });
    harness.provider.failCurriculum = true;
    const preparation = harness.services.coursePreparation.get('ws_1');

    await expect(harness.services.coursePreparation.run(runRequest(preparation))).rejects.toThrow(
      'controlled Curriculum failure',
    );
    const operation = harness.repos.operations.listForWorkspace('ws_1', 'course_preparation')[0]!;
    harness.db.prepare('UPDATE agent_operation_results SET payload = ? WHERE operation_id = ?').run(
      JSON.stringify({
        code: ApiErrorCode.GroundingFailed,
        message: 'Curriculum candidate failed deterministic quality validation.',
        details: {
          kind: 'curriculum_candidate_validation',
          repairAttempted: true,
          errors: ['Pedagogical Curriculum quality: over_compressed_systematic_route'],
          warnings: [],
        },
      }),
      operation.id,
    );

    const blocked = harness.services.coursePreparation.get('ws_1');
    expect(blocked).toMatchObject({
      state: 'blocked',
      machineAction: null,
      learnerAction: 'review_course_structure',
      learnerDecisionRequired: true,
      canResume: false,
      operationKey: null,
      blocker: {
        code: 'course_structure_review_required',
        message: '课程结构需要重新组织。',
      },
      failure: { action: 'prepare_course_structure', retryable: false },
    });

    const curriculumCalls = harness.provider.curriculumCalls;
    const result = await harness.services.coursePreparation.run({
      command: command('structural-no-retry'),
      expectedRevision: blocked.revision,
    });
    expect(result.preparation).toEqual(blocked);
    expect(harness.provider.curriculumCalls).toBe(curriculumCalls);
  });

  it('cancels in-flight preparation without persisting a Curriculum or StudyPlan', async () => {
    const provider = new TrackingProvider({ delayMs: 50 });
    const harness = createHarness({ provider });
    const preparation = harness.services.coursePreparation.get('ws_1');
    const abort = new AbortController();
    const pending = harness.services.coursePreparation.run(runRequest(preparation), {
      signal: abort.signal,
    });
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
    expect(harness.repos.curricula.list('ws_1')).toEqual([]);
    expect(harness.repos.studyPlans.list('ws_1')).toEqual([]);
    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'failed_recoverable',
      failure: { code: ApiErrorCode.RequestCancelled, retryable: true },
    });
  });

  it('replays an identical successful invocation without duplicate provider work', async () => {
    const harness = createHarness();
    const preparation = harness.services.coursePreparation.get('ws_1');
    const request = runRequest(preparation);
    const first = await harness.services.coursePreparation.run(request);
    const replay = await harness.services.coursePreparation.run(request);

    expect(replay).toEqual(first);
    expect(harness.provider.analyzeCalls).toBe(1);
    expect(harness.provider.curriculumCalls).toBe(1);
    expect(harness.provider.studyPlanCalls).toBe(1);
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(1);
    expect(harness.repos.studyPlans.list('ws_1')).toHaveLength(1);
  });

  it('returns the active operation for an identical concurrent invocation without duplicate work', async () => {
    const provider = new TrackingProvider();
    let releaseAnalyze = () => undefined;
    provider.analyzeGate = new Promise<void>((resolve) => {
      releaseAnalyze = resolve;
    });
    const analyzeStarted = new Promise<void>((resolve) => {
      provider.onAnalyzeStarted = resolve;
    });
    const harness = createHarness({ provider });
    const preparation = harness.services.coursePreparation.get('ws_1');
    const request = runRequest(preparation);
    const pending = harness.services.coursePreparation.run(request);

    await analyzeStarted;
    let concurrent;
    try {
      concurrent = await harness.services.coursePreparation.run(request);
      expect(concurrent.preparation).toMatchObject({
        state: 'preparing_concepts',
        operationKey: preparation.operationKey,
        machineAction: 'prepare_concepts',
        canCancel: true,
      });
      expect(provider.analyzeCalls).toBe(1);
      expect(provider.curriculumCalls).toBe(0);
      expect(provider.studyPlanCalls).toBe(0);
    } finally {
      releaseAnalyze();
    }

    const completed = await pending;
    expect(completed.preparation.state).toBe('course_plan_ready');
    expect(provider.analyzeCalls).toBe(1);
    expect(provider.curriculumCalls).toBe(1);
    expect(provider.studyPlanCalls).toBe(1);
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(1);
    expect(harness.repos.studyPlans.list('ws_1')).toHaveLength(1);
  });

  it('fences Concept persistence when the active MaterialRevision changes in flight', async () => {
    const provider = new TrackingProvider();
    let releaseAnalyze = () => undefined;
    provider.analyzeGate = new Promise<void>((resolve) => {
      releaseAnalyze = resolve;
    });
    const analyzeStarted = new Promise<void>((resolve) => {
      provider.onAnalyzeStarted = resolve;
    });
    const harness = createHarness({ provider });
    const preparation = harness.services.coursePreparation.get('ws_1');
    const pending = harness.services.coursePreparation.run(runRequest(preparation));

    await analyzeStarted;
    activateReplacementRevision(harness.repos);
    releaseAnalyze();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
    expect(harness.repos.materials.getConcepts('mat_1')).toEqual([]);
    expect(harness.repos.curricula.list('ws_1')).toEqual([]);
    expect(harness.repos.studyPlans.list('ws_1')).toEqual([]);
  });

  it('fences StudyPlan persistence when the active MaterialRevision changes in flight', async () => {
    const provider = new TrackingProvider();
    let releaseStudyPlan = () => undefined;
    provider.studyPlanGate = new Promise<void>((resolve) => {
      releaseStudyPlan = resolve;
    });
    const studyPlanStarted = new Promise<void>((resolve) => {
      provider.onStudyPlanStarted = resolve;
    });
    const harness = createHarness({ provider, withConcept: true });
    const originalComplete = harness.services.courseCommands.complete;
    let revisionChanged = false;
    harness.services.courseCommands.complete = ((claim, mutate) => {
      const operation = harness.repos.operations.get(claim.operationId);
      if (!revisionChanged && operation?.operationType === 'propose_study_plan') {
        revisionChanged = true;
        activateReplacementRevision(harness.repos);
      }
      return originalComplete(claim, mutate);
    }) as typeof originalComplete;
    const preparation = harness.services.coursePreparation.get('ws_1');
    const pending = harness.services.coursePreparation.run(runRequest(preparation));

    await studyPlanStarted;
    releaseStudyPlan();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
    expect(revisionChanged).toBe(true);
    expect(provider.studyPlanCalls).toBe(1);
    expect(harness.repos.curricula.list('ws_1').map((item) => item.status)).toEqual(['accepted']);
    expect(harness.repos.studyPlans.list('ws_1')).toEqual([]);
  });

  it('stops for a learner Curriculum proposal created while a StudyPlan is being prepared', async () => {
    const provider = new TrackingProvider();
    let releaseStudyPlan = () => undefined;
    provider.studyPlanGate = new Promise<void>((resolve) => {
      releaseStudyPlan = resolve;
    });
    const studyPlanStarted = new Promise<void>((resolve) => {
      provider.onStudyPlanStarted = resolve;
    });
    const harness = createHarness({ provider, withConcept: true });
    const preparation = harness.services.coursePreparation.get('ws_1');
    const pending = harness.services.coursePreparation.run(runRequest(preparation));

    await studyPlanStarted;
    const accepted = harness.repos.curricula.list('ws_1').at(-1)!;
    const learnerProposal = await harness.services.curriculum.propose({
      command: command('learner-curriculum-during-plan'),
      contractId: harness.contract.id,
      expectedContractVersion: harness.contract.version,
      predecessorCurriculumId: accepted.id,
      expectedActiveCurriculumId: null,
    });
    releaseStudyPlan();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
    expect(harness.repos.studyPlans.list('ws_1')).toEqual([]);
    expect(harness.repos.curricula.list('ws_1').at(-1)).toEqual(learnerProposal.curriculum);
    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'awaiting_required_governance',
      learnerAction: 'review_course_structure',
      learnerDecisionRequired: true,
    });
  });

  it('does not supersede a learner StudyPlan proposal created during preparation', async () => {
    const provider = new TrackingProvider();
    let releaseStudyPlan = () => undefined;
    provider.studyPlanGate = new Promise<void>((resolve) => {
      releaseStudyPlan = resolve;
    });
    const studyPlanStarted = new Promise<void>((resolve) => {
      provider.onStudyPlanStarted = resolve;
    });
    const harness = createHarness({ provider, withConcept: true });
    const preparation = harness.services.coursePreparation.get('ws_1');
    const pending = harness.services.coursePreparation.run(runRequest(preparation));

    await studyPlanStarted;
    const accepted = harness.repos.curricula.list('ws_1').at(-1)!;
    const learnerProposal = await harness.services.studyPlansAgent.propose({
      command: command('concurrent-learner-plan'),
      contractId: harness.contract.id,
      expectedContractVersion: harness.contract.version,
      curriculumId: accepted.id,
      expectedCurriculumVersion: accepted.version,
      expectedExecutionSourceManifestFingerprint: accepted.executionSourceManifest.fingerprint,
      predecessorStudyPlanId: null,
      expectedAcceptedStudyPlanId: null,
      proposalTrigger: 'Learner requested a different route.',
    });
    releaseStudyPlan();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
    expect(harness.repos.studyPlans.list('ws_1')).toEqual([learnerProposal.studyPlan]);
    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'course_plan_ready',
      learnerAction: 'review_course_plan',
      learnerDecisionRequired: true,
    });
  });

  it('advances past a source-stale machine-owned Curriculum proposal', async () => {
    const harness = createHarness({ withConcept: true });
    await harness.services.curriculum.propose(
      {
        command: command('abandoned-preparation-curriculum', 'local'),
        contractId: harness.contract.id,
        expectedContractVersion: harness.contract.version,
        predecessorCurriculumId: null,
        expectedActiveCurriculumId: null,
      },
      { preparationPolicyId: COURSE_PREPARATION_POLICY_ID },
    );
    activateReplacementRevision(harness.repos);
    addReplacementConcept(harness.repos);

    const preparation = harness.services.coursePreparation.get('ws_1');
    expect(preparation).toMatchObject({
      state: 'preparing_course_structure',
      machineAction: 'prepare_course_structure',
      learnerDecisionRequired: false,
    });
    const result = await harness.services.coursePreparation.run(runRequest(preparation));

    expect(result.preparation.state).toBe('course_plan_ready');
    expect(harness.repos.curricula.list('ws_1').map((item) => item.status)).toEqual([
      'proposed',
      'accepted',
    ]);
    expect(harness.repos.studyPlans.list('ws_1')).toHaveLength(1);
    const latestCurriculum = harness.repos.curricula.list('ws_1').at(-1)!;
    expect(harness.services.courseOverview.get('ws_1')).toMatchObject({
      planningCurriculum: { id: latestCurriculum.id, status: 'accepted' },
      proposedCurriculum: null,
    });
    expect(harness.services.curriculum.history('ws_1')).toMatchObject({
      acceptedCurriculumId: null,
      proposedCurriculumId: null,
    });
  });

  it('does not project a plan on a source-stale Curriculum as ready', async () => {
    const harness = createHarness({ withConcept: true });
    const preparation = harness.services.coursePreparation.get('ws_1');
    const ready = await harness.services.coursePreparation.run(runRequest(preparation));
    expect(ready.preparation.state).toBe('course_plan_ready');

    activateReplacementRevision(harness.repos);
    addReplacementConcept(harness.repos);

    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'preparing_course_structure',
      machineAction: 'prepare_course_structure',
      learnerDecisionRequired: false,
      checkpoints: { concepts: 'complete', courseStructure: 'in_progress', coursePlan: 'pending' },
    });
  });

  it('does not project an active route as complete after its source changes', async () => {
    const harness = createHarness({ withConcept: true });
    const preparation = harness.services.coursePreparation.get('ws_1');
    await harness.services.coursePreparation.run(runRequest(preparation));
    const plan = harness.repos.studyPlans.list('ws_1').at(-1)!;
    const curriculum = harness.repos.curricula.get(plan.curriculumVersionId)!;
    harness.services.courseExecution.decideStudyPlan({
      command: command('accept-prepared-plan'),
      studyPlanId: plan.id,
      expectedVersion: plan.version,
      expectedContractId: harness.contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    });
    expect(harness.services.coursePreparation.get('ws_1').state).toBe(
      'preparing_assessment_readiness',
    );

    activateReplacementRevision(harness.repos);

    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'preparing_concepts',
      machineAction: 'prepare_concepts',
      learnerAction: 'resume_preparation',
    });
  });

  it('does not declare complete when the accepted route lacks a formal checkpoint path', async () => {
    const harness = createHarness({ withConcept: true });
    const first = await harness.services.coursePreparation.run(
      runRequest(harness.services.coursePreparation.get('ws_1')),
    );
    expect(first.preparation.state).toBe('course_plan_ready');
    const plan = harness.repos.studyPlans.list('ws_1').at(-1)!;
    const curriculum = harness.repos.curricula.get(plan.curriculumVersionId)!;
    harness.services.courseExecution.decideStudyPlan({
      command: command('accept-readiness-route'),
      studyPlanId: plan.id,
      expectedVersion: plan.version,
      expectedContractId: harness.contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    });
    const pending = harness.services.coursePreparation.get('ws_1');
    expect(pending).toMatchObject({
      state: 'preparing_assessment_readiness',
      formalReadiness: { status: 'blocked' },
      learnerDecisionRequired: false,
      learnerAction: 'resume_preparation',
    });
    const blocked = await harness.services.coursePreparation.run(runRequest(pending));
    expect(blocked.preparation).toMatchObject({
      state: 'blocked',
      blocker: { code: 'formal_assessment_readiness_unavailable' },
    });
  });

  it('completes readiness when current premises and a formal checkpoint are valid', async () => {
    const harness = createHarness({
      compactMaterial: true,
      minutesPerDay: 60,
      preferredSessionMinutes: 60,
    });
    const first = await harness.services.coursePreparation.run(
      runRequest(harness.services.coursePreparation.get('ws_1')),
    );
    expect(first.preparation.state).toBe('course_plan_ready');
    const plan = harness.repos.studyPlans.list('ws_1').at(-1)!;
    const curriculum = harness.repos.curricula.get(plan.curriculumVersionId)!;
    harness.services.courseExecution.decideStudyPlan({
      command: command('accept-valid-readiness-route'),
      studyPlanId: plan.id,
      expectedVersion: plan.version,
      expectedContractId: harness.contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    });

    const completed = harness.services.coursePreparation.get('ws_1');
    expect(completed).toMatchObject({
      state: 'complete',
      learnerAction: 'continue_study',
      learnerDecisionRequired: false,
      formalReadiness: {
        status: 'ready',
        requiredObjectiveCount: 1,
        readyObjectiveCount: 1,
        unresolvedObjectiveIds: [],
        teachingOnlyObjectiveIds: [],
      },
      checkpoints: { assessmentReadiness: 'complete' },
    });
  });

  it('fails closed when a teaching-ready objective has no current authorized premise', async () => {
    const harness = createHarness({ withConcept: true });
    const first = await harness.services.coursePreparation.run(
      runRequest(harness.services.coursePreparation.get('ws_1')),
    );
    const plan = harness.repos.studyPlans.list('ws_1').at(-1)!;
    const curriculum = harness.repos.curricula.get(plan.curriculumVersionId)!;
    harness.services.courseExecution.decideStudyPlan({
      command: command('accept-fabricated-authority-route'),
      studyPlanId: plan.id,
      expectedVersion: plan.version,
      expectedContractId: harness.contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    });
    const row = harness.db
      .prepare('SELECT payload FROM curriculum_versions WHERE id = ?')
      .get(curriculum.id) as { payload: string };
    const payload = JSON.parse(row.payload) as typeof curriculum;
    const objective = payload.nodes.find((node) => node.learningUnit)?.learningUnit?.objectives[0];
    expect(objective).toBeDefined();
    objective!.truthPremiseStatus = 'independently_verified';
    objective!.truthAuthorityRecordIds = ['ta_fabricated_not_current'];
    harness.db
      .prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(payload), curriculum.id);

    const blocked = harness.services.coursePreparation.get('ws_1');
    expect(blocked).toMatchObject({
      state: 'preparing_assessment_readiness',
      formalReadiness: {
        status: 'blocked',
        unresolvedObjectiveIds: [objective!.id],
        teachingOnlyObjectiveIds: [objective!.id],
      },
      learnerDecisionRequired: false,
      learnerAction: 'resume_preparation',
    });
    const after = await harness.services.coursePreparation.run(runRequest(blocked));
    expect(after.preparation).toMatchObject({
      state: 'blocked',
      canResume: false,
      learnerDecisionRequired: false,
      blocker: { code: 'formal_assessment_readiness_unavailable' },
      formalReadiness: { status: 'blocked', unresolvedObjectiveIds: [objective!.id] },
    });
    expect(after.preparation.blocker?.message).not.toContain('请你');
    expect(first.preparation.state).toBe('course_plan_ready');
  });

  it('projects an expired preparation lease as retryable and fences it before resuming', async () => {
    const harness = createHarness();
    const initial = harness.services.coursePreparation.get('ws_1');
    const request = runRequest(initial);
    const abandoned = harness.services.courseCommands.begin(
      request.command,
      'course_preparation',
      { revision: initial.revision, machineAction: initial.machineAction },
      { leaseMs: 1 },
    );
    harness.db
      .prepare('UPDATE agent_operations SET lease_expires_at = ? WHERE id = ?')
      .run(T0, abandoned.operationId);

    const retryable = harness.services.coursePreparation.get('ws_1');
    expect(retryable).toMatchObject({
      state: 'failed_recoverable',
      canResume: true,
      canCancel: false,
      blocker: { code: 'preparation_interrupted' },
    });
    expect(retryable.operationKey).not.toBe(initial.operationKey);

    const result = await harness.services.coursePreparation.run(runRequest(retryable));
    expect(result.preparation.state).toBe('course_plan_ready');
    expect(harness.repos.operations.get(abandoned.operationId)?.status).toBe('interrupted');
    expect(harness.provider.analyzeCalls).toBe(1);
    expect(harness.provider.curriculumCalls).toBe(1);
    expect(harness.provider.studyPlanCalls).toBe(1);
  });

  it('rejects explicit local-policy Curriculum acceptance through the public API', async () => {
    const testApp = buildTestApp();
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws_1/curricula/curriculum_1/accept',
      payload: {
        command: command('public-local-accept', 'local'),
        curriculumId: 'curriculum_1',
        expectedVersion: 1,
        expectedContractId: 'contract_1',
        expectedExecutionSourceManifestFingerprint: 'manifest_1',
        acceptanceBasis: 'explicit_local_policy',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.ValidationError } });
    await testApp.app.close();
  });
});
