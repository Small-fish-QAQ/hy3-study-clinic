import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  makeBlock,
  makeConcept,
  makeMaterial,
  makeSemanticallySupportedObjective,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import { buildTestApp } from '../testing/testApp.js';
import { fixedClock } from '../util/ids.js';
import {
  COURSE_MAP_CURRICULUM_GENERATION_POLICY,
  COURSE_PREPARATION_POLICY_ID,
  LEGACY_CURRICULUM_GENERATION_POLICY,
} from './curriculum.js';
import { createServices, type Services } from './index.js';
import { teachThroughLesson } from '../testing/courseWorkflow.js';
import { assessCourseFormalReadiness } from './formalReadiness.js';
import * as curriculumSemanticEvaluator from './curriculumSemanticEvaluator.js';

const SEMANTIC_SUPPORT_MARKERS = '[SUPPORTS:identify] [SUPPORTS:explain]';
const QUOTE = `Working memory is limited ${SEMANTIC_SUPPORT_MARKERS}!`;
const clock = fixedClock(T0);
const databases: SqliteDb[] = [];

class TrackingProvider extends FakeProvider {
  analyzeCalls = 0;
  /**
   * Aggregate first-stage Curriculum proposals, whichever policy produced them.
   * It cannot distinguish the policies, so a test that asserts *which* path ran
   * must use `courseMapCalls` / `legacyCurriculumCalls` instead.
   */
  curriculumCalls = 0;
  /** `proposeCourseMap`: the first stage under course_map_materialization_v1. */
  courseMapCalls = 0;
  /** `proposeCurriculum`: the first stage under legacy_direct_v1 only. */
  legacyCurriculumCalls = 0;
  detailCalls = 0;
  studyPlanCalls = 0;
  lastCourseMapInput: CourseMapProposalInput | null = null;
  lastDetailInputs: CurriculumDetailProposalInput[] = [];
  lastStudyPlanInput: StudyPlanProposalInput | null = null;
  failCurriculum = false;
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
  nextLegacyNonOptionalObjectiveLimit: number | null = null;
  omitCourseMapPrerequisites = false;

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
    this.legacyCurriculumCalls += 1;
    const gate = this.curriculumGate;
    this.curriculumGate = null;
    const started = this.onCurriculumStarted;
    this.onCurriculumStarted = null;
    started?.();
    if (gate) await gate;
    if (this.failCurriculum) throw new Error('controlled Curriculum failure');
    const nonOptionalObjectiveLimit = this.nextLegacyNonOptionalObjectiveLimit;
    this.nextLegacyNonOptionalObjectiveLimit = null;
    return super.proposeCurriculum(
      input,
      nonOptionalObjectiveLimit === null
        ? opts
        : {
            ...opts,
            validateCandidate: (candidate) => {
              let objectiveIndex = 0;
              for (const node of (candidate as CurriculumProposalPayload).nodes) {
                for (const objective of node.objectives) {
                  if (objectiveIndex >= nonOptionalObjectiveLimit) {
                    objective.priority = 'optional';
                    objective.priorityRationale =
                      'This fixture keeps unrelated objectives outside the recovery frontier.';
                  }
                  objectiveIndex += 1;
                }
              }
              return opts?.validateCandidate?.(candidate) ?? { valid: true, diagnostics: [] };
            },
          },
    );
  }

  override async proposeCourseMap(
    input: CourseMapProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CourseMapProposalPayload> {
    this.curriculumCalls += 1;
    this.courseMapCalls += 1;
    this.lastCourseMapInput = structuredClone(input);
    const gate = this.curriculumGate;
    this.curriculumGate = null;
    const started = this.onCurriculumStarted;
    this.onCurriculumStarted = null;
    started?.();
    if (gate) await gate;
    if (this.failCurriculum) throw new Error('controlled Curriculum failure');
    const proposal = await super.proposeCourseMap(input, opts);
    if (this.omitCourseMapPrerequisites) proposal.prerequisites = [];
    return proposal;
  }

  override async proposeCurriculumDetails(
    input: CurriculumDetailProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumDetailProposalPayload> {
    this.detailCalls += 1;
    this.lastDetailInputs.push(structuredClone(input));
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
    this.lastStudyPlanInput = structuredClone(input);
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
    sourceClaimOnly?: boolean;
    substantiveClaims?: boolean;
    minutesPerDay?: number;
    preferredSessionMinutes?: number;
    desiredDepth?: LearningContractDraftFields['desiredDepth'];
    focusRequest?: string | null;
  } = {},
): Harness {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrate(db);
  const repos = createRepositories(db);
  const provider = options.provider ?? new TrackingProvider();
  repos.workspaces.insert(makeWorkspace({ name: 'Memory course' }));
  const sections = Array.from({ length: options.sectionCount ?? 1 }, (_, index) => {
    const base = options.substantiveClaims
      ? `Memory ${index + 1} is bounded ${SEMANTIC_SUPPORT_MARKERS}! Notes preserve excess information;`
      : options.sourceClaimOnly
        ? QUOTE
        : index === 0
          ? `${QUOTE} Working memory section ${index + 1} has a bounded claim.`
          : `Working memory section ${index + 1} has a bounded claim ${SEMANTIC_SUPPORT_MARKERS}!`;
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
  const fields = contractFields(
    role.id,
    role.version,
    options.minutesPerDay,
    options.preferredSessionMinutes,
  );
  fields.desiredDepth = options.desiredDepth ?? fields.desiredDepth;
  if (Object.prototype.hasOwnProperty.call(options, 'focusRequest')) {
    fields.focusRequest = options.focusRequest ?? null;
  }
  const draft = services.learningContracts.createDraft({
    command: command('contract-create'),
    fields,
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
  const { db, repos, services, contract } = harness;
  const originalConcepts = repos.materials.getConcepts('mat_1');
  const authoritySelectionConcepts = repos.materials.getBlocks('mat_1').map((block, index) => {
    const markerEnd = block.content.indexOf('!') + 1;
    const quote = block.content.slice(0, markerEnd);
    return makeConcept({
      id: `con_source_only_authority_${index + 1}`,
      materialId: 'mat_1',
      name: `Source-only authority ${index + 1}`,
      summary: quote,
      grounding: {
        blockId: block.id,
        quote,
        startOffset: 0,
        endOffset: quote.length,
        occurrenceCount: 1,
        reanchored: false,
      },
    });
  });
  repos.materials.replaceConcepts('mat_1', [...originalConcepts, ...authoritySelectionConcepts]);
  try {
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

    // Simulate a readable source-only aggregate. Ordinary Course Preparation
    // deliberately leaves semantic support absent; only the pre-concept
    // Curriculum linkage is removed here and requires a successor.
    const row = db
      .prepare('SELECT payload FROM curriculum_versions WHERE id = ?')
      .get(accepted.id) as {
      payload: string;
    };
    const payload = JSON.parse(row.payload) as typeof accepted;
    for (const node of payload.nodes) {
      if (!node.learningUnit) continue;
      node.learningUnit.conceptIds = [];
      node.learningUnit.canonicalConceptIds = [];
    }
    db.prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify(payload),
      accepted.id,
    );

    const sourceOnly = repos.curricula.get(accepted.id)!;
    expect(sourceOnly.nodes.flatMap((node) => node.learningUnit?.conceptIds ?? [])).toEqual([]);
    expect(
      sourceOnly.nodes
        .flatMap((node) => node.learningUnit?.objectives ?? [])
        .every((objective) => objective.semanticSupport === undefined),
    ).toBe(true);
    expect(repos.studyPlans.list('ws_1')).toEqual([]);
    return accepted.id;
  } finally {
    repos.materials.replaceConcepts('mat_1', originalConcepts);
  }
}

function insertObjectiveSemanticSupport(
  repos: Repositories,
  curriculumId: string,
  verdict: 'pass' | 'fail' = 'pass',
) {
  const curriculum = repos.curricula.get(curriculumId)!;
  const objective = curriculum.nodes.flatMap((node) => node.learningUnit?.objectives ?? [])[0]!;
  if (!objective.formalAssessmentConstruct) {
    throw new Error('Formal-readiness fixture objective is missing its construct.');
  }
  const { semanticSupport: _semanticSupport, ...withoutSemanticSupport } = objective;
  const support = makeSemanticallySupportedObjective(
    {
      ...withoutSemanticSupport,
      formalAssessmentConstruct: objective.formalAssessmentConstruct,
      authoritySourceBlockIds: objective.authoritySourceBlockIds ?? [],
      authorityClaimIds: objective.authorityClaimIds ?? [],
    },
    objective.formalAssessmentConstruct === 'identify' ? 'recognition' : 'relationship',
  ).semanticSupport!;
  if (verdict === 'fail') {
    support.fragments = support.fragments.map((fragment) => ({
      ...fragment,
      status: 'unsupported' as const,
      supportType: null,
      sourceBlockIds: [],
      authorityRecordIds: [],
      authorityClaimIds: [],
    }));
    support.unsupportedFragmentIds = support.fragments.map((fragment) => fragment.fragmentId);
    support.verdict = 'fail';
    support.rationale = 'The exact objective proposition is not supported.';
  }
  return repos.curricula.insertObjectiveSemanticSupportsIfAbsent(curriculumId, [support]);
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
  it.each([1, 6])(
    'earns current deep transfer across %i source sections, including reload and repair',
    async (sectionCount) => {
      const harness = createHarness({
        withConcept: sectionCount === 1,
        sectionCount,
        focusRequest: null,
        compactMaterial: sectionCount === 1,
        sourceClaimOnly: sectionCount === 1,
        substantiveClaims: sectionCount > 1,
        desiredDepth: 'deep_transfer',
      });
      const { repos, provider } = harness;
      if (sectionCount > 1) {
        // Broad Fake material contains padding for source-region partitioning.
        // Keep this workflow fixture's scoring claim inside its exact source quote.
        const propose = provider.proposeAssessment.bind(provider);
        provider.proposeAssessment = async (...args) => {
          const proposal = await propose(...args);
          for (const item of proposal.items) {
            item.question.expectedAnswer = item.question.quote;
            item.question.rubricKeyPoints = [
              {
                text: item.question.quote.slice(0, 80),
                required: true,
                sourceRefs: [item.question.blockId],
              },
            ];
          }
          return proposal;
        };
      }
      const currentClock = fixedClock('2026-09-10T00:00:00.000Z');
      let services = createServices({ repos, provider, clock: currentClock });
      await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
      const curriculum = repos.curricula.list('ws_1').at(-1)!;
      services.curriculum.accept({
        command: command('transfer-accept'),
        curriculumId: curriculum.id,
        expectedVersion: curriculum.version,
        expectedContractId: curriculum.contractVersionId,
        expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
        acceptanceBasis: 'learner_review',
      });
      await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
      const plan = repos.studyPlans.get(repos.courseExecution.get('ws_1').acceptedPlanId!)!;
      const checks = plan.items.filter((item) => item.kind === 'formal_checkpoint');
      const transfers = plan.items.filter((item) => item.synthesisMode === 'unit_transfer');
      expect(checks.length).toBeGreaterThan(0);
      expect(transfers.map((item) => item.objectiveIds)).toEqual(
        checks.map((item) => item.objectiveIds),
      );
      if (sectionCount === 1) expect(curriculum.synthesisGroups).toEqual([]);
      if (sectionCount > 1)
        expect(curriculum.nodes.filter((node) => node.learningUnit).length).toBeGreaterThan(1);
      let repaired = false;
      const agendaWindows = new Set<string>();
      for (let step = 0; step < plan.items.length + 2; step++) {
        const agenda = repos.sessionAgendas.get(repos.courseExecution.get('ws_1').activeAgendaId!)!;
        agendaWindows.add(agenda.id);
        const item = agenda.items.find((entry) => entry.id === agenda.currentItemId);
        if (!item) {
          if (repos.studyPlans.listProgress(plan.id).some((entry) => entry.state !== 'completed'))
            throw new Error(
              JSON.stringify({ agenda, planProgress: repos.studyPlans.listProgress(plan.id) }),
            );
          break;
        }
        if (item.kind === 'learning_unit_teaching') {
          const priorSupport =
            services.courseLearningProgress.get('ws_1').summary.supportedObjectives;
          const taught = await teachThroughLesson(
            { repos, services },
            'ws_1',
            agenda.id,
            item.id,
            `transfer-teach-${step}`,
          );
          expect(taught.projection.status).toBe('ready');
          expect(services.courseLearningProgress.get('ws_1').summary.supportedObjectives).toBe(
            priorSupport,
          );
          continue;
        }
        const launched = await services.courseActionLaunch.launch({
          command: command(`transfer-launch-${step}`),
          agendaId: agenda.id,
          expectedAgendaVersion: agenda.version,
          agendaItemId: item.id,
          expectedContractId: agenda.contractVersionId,
          expectedStudyPlanId: agenda.studyPlanVersionId,
          expectedExecutionSourceManifestFingerprint: agenda.executionSourceManifestFingerprint,
        });
        if (launched.kind !== 'assessment' || !launched.formalAssessmentVersionId)
          throw new Error(`Unreachable transfer route: ${JSON.stringify(launched)}`);
        let execution = services.learnerAssessments.start(
          launched.formalAssessmentVersionId,
          'ws_1',
        );
        services = createServices({ repos, provider, clock: currentClock });
        expect(
          services.learnerAssessments.get(execution.assessmentVersionId, 'ws_1')?.attempt.id,
        ).toBe(execution.attempt.id);
        let version = repos.formalAssessments.getVersion(execution.assessmentVersionId)!;
        const sourceAnswer = () =>
          version.items[0]!.rubric!.filter((point) => !point.transferCriterion)
            .map((point) => point.text)
            .join('；');
        if (item.kind === 'synthesis' && !repaired) {
          const failed = await services.learnerAssessments.submit(execution.attempt.id, {
            [version.items[0]!.id]: sourceAnswer(),
          });
          expect(failed.result?.demonstrated).toBe(false);
          expect(failed.result?.evidenceStatus).toBe('unavailable');
          expect(failed.result?.criteria.some((criterion) => criterion.result === 'met')).toBe(
            true,
          );
          expect(
            failed.result?.criteria.filter((criterion) => criterion.result === 'not_met').length,
          ).toBeGreaterThan(0);
          const episode = failed.result!.repairEpisodeId!;
          expect(episode).toBeTruthy();
          services = createServices({ repos, provider, clock: currentClock });
          await services.learnerAssessments.startRepair(episode);
          services.learnerAssessments.practice(
            episode,
            '改用新情境，解释条件变化。',
            'READY_FOR_VERIFICATION',
          );
          execution = await services.learnerAssessments.createVerification(episode);
          version = repos.formalAssessments.getVersion(execution.assessmentVersionId)!;
          expect(version.items[0]!.transferTask?.priorResponses).toContain(sourceAnswer());
          repaired = true;
        }
        const answer =
          item.kind === 'synthesis'
            ? `新情境：调度员要同时记住多条临时改道信息。依据：${sourceAnswer()} 条件变化：把部分信息写在外部记录中。结果：需要同时保持在记忆中的信息减少，但不能由资料推出精确容量。`
            : sourceAnswer();
        const passed = await services.learnerAssessments.submit(execution.attempt.id, {
          [version.items[0]!.id]: answer,
        });
        expect(passed.result?.demonstrated).toBe(true);
        expect(passed.result?.progressionPending).toBe(false);
        if (item.kind === 'formal_checkpoint')
          expect(
            services.courseLearningProgress
              .get('ws_1')
              .units.find((unit) => unit.id === item.learningUnitId)!.formalState,
          ).not.toBe('complete');
      }
      expect(repaired).toBe(true);
      if (sectionCount > 1) expect(agendaWindows.size).toBeGreaterThan(1);
      expect(
        repos.studyPlans
          .listProgress(plan.id)
          .filter((item) => item.state !== 'completed')
          .map((entry) => ({
            state: entry.state,
            item: plan.items.find((item) => item.id === entry.planItemId),
          })),
      ).toEqual([]);
      const progress = services.courseLearningProgress.get('ws_1');
      expect(progress.units.every((unit) => unit.formalState === 'complete')).toBe(true);
      expect(progress.units.every((unit) => unit.durableMastery?.status !== 'mastered')).toBe(true);
      const records = repos.formalAssessments.listProjectionRecords('ws_1');
      expect(
        records.versions
          .filter((version) => version.items.some((item) => item.transferTask))
          .every((version) =>
            version.items.every(
              (item) =>
                item.representation !== 'synthesis' && item.representation !== 'application',
            ),
          ),
      ).toBe(true);
    },
  );
  it('connects the default route through Lesson, failed Formal check, Repair verification and objective Review', async () => {
    const harness = createHarness({
      withConcept: true,
      focusRequest: null,
      compactMaterial: true,
      sourceClaimOnly: true,
    });
    const { repos, provider, db } = harness;
    // Review activation uses the production cutover; advance only this fixture clock.
    const at = '2026-09-10T00:00:00.000Z';
    const mutableClock = { now: () => new Date(at) };
    const currentServices = createServices({ repos, provider, clock: mutableClock });
    harness.services = currentServices;
    await currentServices.coursePreparation.run(
      runRequest(currentServices.coursePreparation.get('ws_1')),
    );
    const proposed = repos.curricula.list('ws_1').at(-1)!;
    currentServices.curriculum.accept({
      command: command('flow-accept'),
      curriculumId: proposed.id,
      expectedVersion: proposed.version,
      expectedContractId: proposed.contractVersionId,
      expectedExecutionSourceManifestFingerprint: proposed.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    });
    await currentServices.coursePreparation.run(
      runRequest(currentServices.coursePreparation.get('ws_1')),
    );
    const agenda = repos.sessionAgendas.list('ws_1').at(-1)!;
    const checkpoint = agenda.items.find((item) => item.kind === 'formal_checkpoint')!;
    expect(checkpoint).toBeTruthy();
    const early = await currentServices.courseActionLaunch.launch({
      command: command('flow-too-early'),
      agendaId: agenda.id,
      expectedAgendaVersion: agenda.version,
      agendaItemId: checkpoint.id,
      expectedContractId: agenda.contractVersionId,
      expectedStudyPlanId: agenda.studyPlanVersionId,
      expectedExecutionSourceManifestFingerprint: agenda.executionSourceManifestFingerprint,
    });
    expect(early.kind).toBe('blocked');
    await teachThroughLesson(
      harness,
      'ws_1',
      agenda.id,
      agenda.items.find((item) => item.kind === 'learning_unit_teaching')!.id,
      'flow',
      true,
    );
    const learned = currentServices.courseLearningProgress.get('ws_1');
    expect(learned.summary.teachingCompleted).toBe(1);
    expect(learned.summary.supportedObjectives).toBe(0);
    expect(learned.repairs.some((repair) => repair.kind === 'practice' && repair.resolved)).toBe(
      true,
    );
    const nowAgenda = repos.sessionAgendas.get(agenda.id)!;
    const proposeAssessment = provider.proposeAssessment.bind(provider);
    provider.proposeAssessment = async (...args) => {
      const proposal = await proposeAssessment(...args);
      for (const item of proposal.items) item.question.expectedAnswer = 'An unbound scoring claim.';
      return proposal;
    };
    const quizCount = (db.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number }).n;
    await expect(
      currentServices.courseActionLaunch.launch({
        command: command('flow-inadmissible-check'),
        agendaId: nowAgenda.id,
        expectedAgendaVersion: nowAgenda.version,
        agendaItemId: checkpoint.id,
        expectedContractId: nowAgenda.contractVersionId,
        expectedStudyPlanId: nowAgenda.studyPlanVersionId,
        expectedExecutionSourceManifestFingerprint: nowAgenda.executionSourceManifestFingerprint,
      }),
    ).rejects.toThrow('评分依据未通过正式准入');
    expect((db.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number }).n).toBe(
      quizCount,
    );
    expect(repos.formalAssessments.listProjectionRecords('ws_1').versions).toEqual([]);
    provider.proposeAssessment = proposeAssessment;
    const launched = await currentServices.courseActionLaunch.launch({
      command: command('flow-check'),
      agendaId: nowAgenda.id,
      expectedAgendaVersion: nowAgenda.version,
      agendaItemId: checkpoint.id,
      expectedContractId: nowAgenda.contractVersionId,
      expectedStudyPlanId: nowAgenda.studyPlanVersionId,
      expectedExecutionSourceManifestFingerprint: nowAgenda.executionSourceManifestFingerprint,
    });
    expect(launched.kind).toBe('assessment');
    if (launched.kind !== 'assessment' || !launched.formalAssessmentVersionId)
      throw new Error('Expected Formal checkpoint');
    const resumedCheckpoint = await currentServices.courseActionLaunch.launch({
      command: command('flow-reopen-check'),
      agendaId: nowAgenda.id,
      expectedAgendaVersion: nowAgenda.version,
      agendaItemId: checkpoint.id,
      expectedContractId: nowAgenda.contractVersionId,
      expectedStudyPlanId: nowAgenda.studyPlanVersionId,
      expectedExecutionSourceManifestFingerprint: nowAgenda.executionSourceManifestFingerprint,
    });
    expect(resumedCheckpoint).toEqual(launched);
    const started = currentServices.learnerAssessments.start(
      launched.formalAssessmentVersionId,
      'ws_1',
    );
    expect(currentServices.courseLearningProgress.get('ws_1').assessments[0]!.items).toEqual([]);
    const failed = await currentServices.learnerAssessments.submit(
      started.attempt.id,
      Object.fromEntries(started.items.map((item) => [item.itemId, '不知道'])),
    );
    expect(failed.result?.demonstrated).toBe(false);
    const episodeId = failed.result!.repairEpisodeId!;
    expect(episodeId).toBeTruthy();
    const failedProgress = currentServices.courseLearningProgress.get('ws_1');
    expect(
      failedProgress.assessments.some(
        (record) => record.attemptId === started.attempt.id && record.result === 'unsupported',
      ),
    ).toBe(true);
    expect(
      failedProgress.repairs.some(
        (repair) => repair.id === episodeId && repair.current && !repair.resolved,
      ),
    ).toBe(true);
    expect(failedProgress.summary.supportedObjectives).toBe(0);
    await currentServices.learnerAssessments.startRepair(episodeId);
    currentServices.learnerAssessments.practice(
      episodeId,
      '补充练习后的回答',
      'READY_FOR_VERIFICATION',
    );
    const [verification, repeated] = await Promise.all([
      currentServices.learnerAssessments.createVerification(episodeId),
      currentServices.learnerAssessments.createVerification(episodeId),
    ]);
    expect(repeated.attempt.id).toBe(verification.attempt.id);
    expect(
      (await currentServices.learnerAssessments.createVerification(episodeId)).attempt.id,
    ).toBe(verification.attempt.id);
    const version = repos.formalAssessments.getVersion(verification.assessmentVersionId)!;
    const initialVersion = repos.formalAssessments.getVersion(launched.formalAssessmentVersionId)!;
    expect(version.definitionId).toBe(initialVersion.definitionId);
    expect(version.predecessorId).toBe(initialVersion.id);
    expect(
      version.items.every((item) =>
        initialVersion.items.every((prior) => !item.prompt.includes(prior.prompt)),
      ),
    ).toBe(true);
    const passed = await currentServices.learnerAssessments.submit(
      verification.attempt.id,
      Object.fromEntries(
        version.items.map((item) => [item.id, item.rubric!.map((point) => point.text).join('；')]),
      ),
    );
    expect(passed.result?.demonstrated).toBe(true);
    expect(currentServices.learnerAssessments.getRepair(episodeId).resolved).toBe(true);
    const completed = currentServices.courseLearningProgress.get('ws_1');
    expect(
      completed.summary.supportedObjectives,
      JSON.stringify({
        records: repos.formalAssessments.listProjectionRecords('ws_1').reconciliations,
        formal: repos.formalProgression.listEvidenceForWorkspace('ws_1'),
      }),
    ).toBeGreaterThan(0);
    expect(completed.summary.openRepairs).toBe(0);
    expect(completed.units.every((unit) => unit.durableMastery?.status !== 'mastered')).toBe(true);
    expect(completed.assessments).toHaveLength(2);
    expect(
      currentServices.learnerAssessments.get(launched.formalAssessmentVersionId, 'ws_1')?.attempt
        .id,
    ).toBe(verification.attempt.id);
    const reviews = currentServices.reviewSuccessor.listCurrentProjection('ws_1');
    expect(reviews.length).toBeGreaterThan(0);
    repos.workspaces.insert(makeWorkspace({ id: 'ws_other', name: 'Other course' }));
    await expect(
      currentServices.courseActionLaunch.launchReview({
        command: command('foreign-review', 'learner', 'ws_other'),
        targetId: reviews[0]!.reviewTargetId,
        expectedCourseExecutionVersion: repos.courseExecution.get('ws_other').version,
      }),
    ).rejects.toThrow('Review target not found');
    expect(currentServices.courseLearningProgress.get('ws_other').assessments).toEqual([]);
    db.prepare('UPDATE memory_schedule_states SET due_at = ? WHERE review_target_id = ?').run(
      at,
      reviews[0]!.reviewTargetId,
    );
    const reviewLaunch = await currentServices.courseActionLaunch.launchReview({
      command: command('flow-review'),
      targetId: reviews[0]!.reviewTargetId,
      expectedCourseExecutionVersion: repos.courseExecution.get('ws_1').version,
    });
    expect(reviewLaunch.kind).toBe('assessment');
    if (reviewLaunch.kind !== 'assessment' || !reviewLaunch.formalAssessmentVersionId)
      throw new Error('Expected Review');
    const reviewAttempt = currentServices.learnerAssessments.start(
      reviewLaunch.formalAssessmentVersionId,
      'ws_1',
    );
    const reviewVersion = repos.formalAssessments.getVersion(
      reviewLaunch.formalAssessmentVersionId,
    )!;
    const reviewResult = await currentServices.learnerAssessments.submit(
      reviewAttempt.attempt.id,
      Object.fromEntries(
        reviewVersion.items.map((item) => [
          item.id,
          item.rubric!.map((point) => point.text).join('；'),
        ]),
      ),
    );
    expect(reviewResult.result?.demonstrated).toBe(true);
    expect(reviewResult.review?.resolved).toBe(true);
    expect(currentServices.courseLearningProgress.get('ws_1').assessments).toHaveLength(3);
    const changesBefore = db.prepare('SELECT total_changes() AS n').get();
    currentServices.courseLearningProgress.get('ws_1');
    currentServices.courseLearningProgress.get('ws_1');
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changesBefore);
    db.prepare("UPDATE materials SET availability = 'retired' WHERE id = 'mat_1'").run();
    const stale = currentServices.courseLearningProgress.get('ws_1');
    expect(stale.summary.supportedObjectives).toBe(0);
    expect(stale.assessments).toHaveLength(3);
    expect(stale.assessments.every((record) => !record.current && !record.credited)).toBe(true);
    expect(stale.units.every((unit) => unit.formalState === 'stale' && !unit.durableMastery)).toBe(
      true,
    );
  });
  it.each(['during_extraction', 'after_extraction'] as const)(
    'keeps a cancellation recoverable when partial extraction changes the revision: %s',
    async (cancelAt) => {
      const provider = new TrackingProvider();
      const harness = createHarness({
        provider,
        withConcept: false,
        sectionCount: 3,
        focusRequest: null,
      });
      const original = structuredClone(harness.repos.materials.getConcepts('mat_1'));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        if (cancelAt === 'after_extraction') {
          provider.curriculumGate = gate;
          provider.onCurriculumStarted = resolve;
        } else {
          provider.onAnalyzeStarted = () => {
            if (provider.analyzeCalls === 2) {
              provider.analyzeGate = gate;
              resolve();
            }
          };
        }
      });
      const abort = new AbortController();
      const initial = harness.services.coursePreparation.get('ws_1');
      const run = harness.services.coursePreparation.run(runRequest(initial), {
        signal: abort.signal,
      });
      await started;
      const progress = harness.services.coursePreparation.get('ws_1');
      expect(progress.revision).not.toBe(initial.revision);
      expect(progress.preparedConceptCount).toBeGreaterThan(original.length);
      expect(progress.activity?.phase).toBe(
        cancelAt === 'after_extraction' ? 'course_map' : 'concepts',
      );
      expect(progress.canCancel).toBe(true);
      const saved = structuredClone(harness.repos.materials.getConcepts('mat_1'));
      abort.abort();
      release();
      await expect(run).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
      expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
        state: 'failed_recoverable',
        canResume: true,
        canCancel: false,
      });
      expect(harness.repos.materials.getConcepts('mat_1')).toEqual(saved);
      expect(harness.repos.curricula.list('ws_1')).toHaveLength(0);
    },
  );
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
    // The ordinary default is Course Map, so generation is one Course Map call
    // plus its detail batch. Legacy must stay at zero: a silent fallback would
    // show up here as a legacy call alongside the Course Map one.
    expect(provider.courseMapCalls).toBe(1);
    expect(provider.detailCalls).toBe(1);
    expect(provider.legacyCurriculumCalls).toBe(0);
    expect(provider.studyPlanCalls).toBe(1);
    expect(repos.curricula.list('ws_1').map((item) => item.status)).toEqual(['accepted']);
    expect(repos.studyPlans.list('ws_1').map((item) => item.status)).toEqual(['proposed']);
  });

  it('keeps a new depth-and-focus Course Skeleton proposed until one learner acceptance', async () => {
    const { repos, provider, services, contract } = createHarness({
      withConcept: true,
      sectionCount: 3,
      desiredDepth: 'deep_transfer',
      focusRequest: 'Working memory',
    });
    const initial = services.coursePreparation.get('ws_1');

    expect(initial.machineAction).toBe('prepare_course_structure');
    const result = await services.coursePreparation.run(runRequest(initial));

    expect(result.preparation).toMatchObject({
      state: 'awaiting_required_governance',
      machineAction: null,
      learnerAction: 'review_course_structure',
      learnerDecisionRequired: true,
      blocker: { code: 'course_structure_review_required' },
    });
    expect(contract.desiredDepth).toBe('deep_transfer');
    expect(contract.focusRequest).toBe('Working memory');
    expect(provider.lastCourseMapInput?.contract).toMatchObject({
      desiredDepth: 'deep_transfer',
      focusRequest: 'Working memory',
    });
    expect(provider.lastDetailInputs).not.toHaveLength(0);
    expect(
      provider.lastDetailInputs.every(
        (input) =>
          input.contract.desiredDepth === 'deep_transfer' &&
          input.contract.focusRequest === 'Working memory' &&
          input.regions.every((region) => region.focus === 'focused'),
      ),
    ).toBe(true);
    const proposed = repos.curricula.list('ws_1').at(-1)!;
    expect(proposed.status).toBe('proposed');
    // Empty sections remain teachable from exact source references. Preparation
    // must not loop through expensive extraction to pad every section with a Concept.
    expect(provider.analyzeCalls).toBe(0);
    expect(proposed.nodes.some((node) => node.learningUnit?.conceptIds.length === 0)).toBe(true);
    expect(
      proposed.nodes
        .filter((node) => node.learningUnit)
        .every((node) => node.learningUnit?.focus === 'focused'),
    ).toBe(true);
    expect(repos.studyPlans.list('ws_1')).toEqual([]);
    expect(
      repos.curricula
        .listEvents(proposed.id)
        .some(
          (event) =>
            event.eventType === 'accepted' &&
            JSON.stringify(event.payload).includes('explicit_local_policy'),
        ),
    ).toBe(false);
  });

  it('regenerates a proposed Skeleton from the same Materials, depth, and focus', async () => {
    const { repos, provider, services, contract } = createHarness({
      withConcept: true,
      sectionCount: 2,
      desiredDepth: 'high_performance',
      focusRequest: 'Working memory',
    });
    await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
    const first = repos.curricula.list('ws_1').at(-1)!;

    const regenerated = await services.curriculum.propose({
      command: command('regenerate-skeleton'),
      contractId: contract.id,
      expectedContractVersion: contract.version,
      predecessorCurriculumId: first.id,
      expectedActiveCurriculumId: null,
    });

    expect(provider.courseMapCalls).toBe(2);
    expect(provider.lastCourseMapInput?.contract).toMatchObject({
      desiredDepth: 'high_performance',
      focusRequest: 'Working memory',
    });
    expect(regenerated.curriculum).toMatchObject({
      status: 'proposed',
      predecessorId: first.id,
      contractVersionId: contract.id,
      executionSourceManifest: first.executionSourceManifest,
    });
    expect(repos.curricula.get(first.id)?.status).toBe('rejected');
    expect(
      regenerated.curriculum.nodes
        .filter((node) => node.learningUnit)
        .every((node) => node.learningUnit?.focus === 'focused'),
    ).toBe(true);
  });

  it('derives and activates StudyPlan after Skeleton acceptance without a second decision', async () => {
    const { repos, provider, services } = createHarness({
      withConcept: true,
      sectionCount: 3,
      focusRequest: 'Working memory',
    });
    const prepared = await services.coursePreparation.run(
      runRequest(services.coursePreparation.get('ws_1')),
    );
    expect(prepared.preparation.learnerAction).toBe('review_course_structure');
    const proposed = repos.curricula.list('ws_1').at(-1)!;
    const accepted = services.curriculum.accept({
      command: command('accept-simplified-skeleton'),
      curriculumId: proposed.id,
      expectedVersion: proposed.version,
      expectedContractId: proposed.contractVersionId,
      expectedExecutionSourceManifestFingerprint: proposed.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;

    const planning = services.coursePreparation.get('ws_1');
    expect(planning.machineAction).toBe('prepare_course_plan');
    const completed = await services.coursePreparation.run(runRequest(planning));

    expect(completed.preparation).toMatchObject({
      state: 'complete',
      machineAction: null,
      learnerAction: 'continue_study',
      learnerDecisionRequired: false,
    });
    expect(provider.studyPlanCalls).toBe(0);
    const plan = repos.studyPlans.list('ws_1').at(-1)!;
    expect(plan).toMatchObject({
      status: 'accepted',
      acceptanceBasis: 'derived_from_accepted_curriculum',
      learnerAcceptedAt: accepted.acceptedAt,
      provider: 'local',
    });
    expect(
      plan.items.every(
        (item) =>
          ['teach_unit', 'formal_checkpoint'].includes(item.kind) &&
          item.targetDepth === 'working_fluency',
      ),
    ).toBe(true);
    expect(
      plan.items.filter((item) => item.kind === 'teach_unit').flatMap((item) => item.objectiveIds),
    ).toEqual(
      accepted.nodes.flatMap(
        (node) => node.learningUnit?.objectives.map((objective) => objective.id) ?? [],
      ),
    );
    expect(plan.items.every((item) => item.targetDepth === 'working_fluency')).toBe(true);
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      activeContractId: accepted.contractVersionId,
      activeCurriculumId: accepted.id,
      acceptedPlanId: plan.id,
    });
    const activeCurriculum = repos.curricula.get(accepted.id)!;
    const sourceOnlyUnits = activeCurriculum.nodes.filter(
      (node) => node.learningUnit?.conceptIds.length === 0,
    );
    expect(sourceOnlyUnits.length).toBeGreaterThan(0);
    expect(
      sourceOnlyUnits.every((node) =>
        plan.items.some(
          (item) => item.curriculumLearningUnitId === node.id && item.kind === 'teach_unit',
        ),
      ),
    ).toBe(true);
    const focusedUnitIds = activeCurriculum.nodes
      .filter((node) => node.learningUnit?.focus === 'focused')
      .map((node) => node.id);
    expect(focusedUnitIds.length).toBeGreaterThan(0);
    expect(
      plan.items
        .filter((item) => item.curriculumLearningUnitId !== null)
        .some((item) => focusedUnitIds.includes(item.curriculumLearningUnitId!)),
    ).toBe(true);
    expect(
      repos.curricula
        .listEvents(accepted.id)
        .filter((event) => event.eventType === 'accepted')
        .map((event) => event.payload),
    ).toEqual([{ acceptanceBasis: 'learner_review' }]);
  });

  it('keeps abandoned Practice gaps in history without offering an unresumable repair', async () => {
    const harness = createHarness({
      withConcept: true,
      focusRequest: null,
      compactMaterial: true,
      sourceClaimOnly: true,
    });
    const { services, repos, provider } = harness;
    await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
    const curriculum = repos.curricula.list('ws_1').at(-1)!;
    services.curriculum.accept({
      command: command('abandoned-accept'),
      curriculumId: curriculum.id,
      expectedVersion: curriculum.version,
      expectedContractId: curriculum.contractVersionId,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    });
    await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
    const agenda = repos.sessionAgendas.list('ws_1').at(-1)!;
    const teaching = agenda.items.find((item) => item.kind === 'learning_unit_teaching')!;
    provider.generatePracticeRepair = async () => {
      throw new Error('repair interrupted');
    };
    await expect(
      teachThroughLesson(harness, 'ws_1', agenda.id, teaching.id, 'abandoned', true),
    ).rejects.toThrow('repair interrupted');
    expect(services.courseLearningProgress.get('ws_1').summary.openRepairs).toBe(1);
    const session = repos.studySessions.list('ws_1')[0]!;
    services.studySessions.pause('ws_1', session.id, {
      commandId: 'gap-pause',
      expectedSessionVersion: session.version,
    });
    expect(services.courseLearningProgress.get('ws_1').summary.openRepairs).toBe(1);
    services.studySessions.stop('ws_1', session.id, {
      commandId: 'gap-stop',
      expectedSessionVersion: repos.studySessions.get(session.id)!.version,
    });
    const progress = services.courseLearningProgress.get('ws_1');
    expect(progress.summary.openRepairs).toBe(0);
    expect(progress.repairs).toEqual([
      expect.objectContaining({ current: false, resolved: false, sessionId: session.id }),
    ]);
    expect(progress.lessons).toHaveLength(1);
    expect(progress.summary.supportedObjectives).toBe(0);
  });

  it('does not auto-activate a learner-authored Plan on the simplified flow', async () => {
    const { repos, services, contract } = createHarness({
      withConcept: true,
      focusRequest: null,
    });
    await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
    const proposal = repos.curricula.list('ws_1').at(-1)!;
    const accepted = services.curriculum.accept({
      command: command('accept-skeleton-before-learner-plan'),
      curriculumId: proposal.id,
      expectedVersion: proposal.version,
      expectedContractId: proposal.contractVersionId,
      expectedExecutionSourceManifestFingerprint: proposal.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const learnerPlan = await services.studyPlansAgent.propose({
      command: command('learner-authored-plan'),
      contractId: contract.id,
      expectedContractVersion: contract.version,
      curriculumId: accepted.id,
      expectedCurriculumVersion: accepted.version,
      expectedExecutionSourceManifestFingerprint: accepted.executionSourceManifest.fingerprint,
      predecessorStudyPlanId: null,
      expectedAcceptedStudyPlanId: null,
      proposalTrigger: 'Learner requested an explicit route proposal.',
    });

    expect(services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'course_plan_ready',
      machineAction: null,
      learnerAction: 'review_course_plan',
      learnerDecisionRequired: true,
    });
    expect(repos.studyPlans.get(learnerPlan.studyPlan.id)?.status).toBe('proposed');
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBeNull();
  });

  it('keeps absent and unmappable focus balanced without inventing focused Units', async () => {
    for (const focusRequest of [null, 'I want 90 points'] as const) {
      const { repos, services } = createHarness({ withConcept: true, focusRequest });
      await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
      const units = repos.curricula
        .list('ws_1')
        .at(-1)!
        .nodes.filter((node) => node.learningUnit);
      expect(units.length).toBeGreaterThan(0);
      expect(units.every((unit) => unit.learningUnit?.focus === 'normal')).toBe(true);
    }
  });

  it('uses global depth to change Course design granularity without dropping source coverage', async () => {
    const shallow = createHarness({
      withConcept: true,
      sectionCount: 6,
      desiredDepth: 'pass_oriented',
      focusRequest: null,
    });
    const deep = createHarness({
      withConcept: true,
      sectionCount: 6,
      desiredDepth: 'deep_transfer',
      focusRequest: null,
    });

    await shallow.services.coursePreparation.run(
      runRequest(shallow.services.coursePreparation.get('ws_1')),
    );
    await deep.services.coursePreparation.run(
      runRequest(deep.services.coursePreparation.get('ws_1')),
    );
    const shallowCurriculum = shallow.repos.curricula.list('ws_1').at(-1)!;
    const deepCurriculum = deep.repos.curricula.list('ws_1').at(-1)!;

    expect(shallow.provider.lastCourseMapInput?.contract.desiredDepth).toBe('pass_oriented');
    expect(deep.provider.lastCourseMapInput?.contract.desiredDepth).toBe('deep_transfer');
    expect(deepCurriculum.nodes.filter((node) => node.kind === 'chapter').length).toBeGreaterThan(
      shallowCurriculum.nodes.filter((node) => node.kind === 'chapter').length,
    );
    expect(deepCurriculum.nodes.filter((node) => node.kind === 'learning_unit').length).toBe(
      shallowCurriculum.nodes.filter((node) => node.kind === 'learning_unit').length,
    );
    expect(deepCurriculum.validation.unmappedSourceBlockIds ?? []).toEqual([]);
    expect(shallowCurriculum.validation.unmappedSourceBlockIds ?? []).toEqual([]);
  });

  it('versions bounded Skeleton rename, focus, and prerequisite-safe reorder edits', async () => {
    const provider = new TrackingProvider();
    provider.omitCourseMapPrerequisites = true;
    const { repos, services } = createHarness({
      provider,
      withConcept: true,
      sectionCount: 3,
      focusRequest: null,
    });
    await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
    const original = repos.curricula.list('ws_1').at(-1)!;
    const originalUnits = original.nodes.filter((node) => node.learningUnit);
    expect(originalUnits).toHaveLength(3);
    const target = originalUnits[0]!;
    const originalIdentity = {
      id: target.id,
      sourceReferences: target.sourceReferences,
      learningUnit: target.learningUnit,
    };

    const renameRequest = {
      command: command('rename-skeleton-unit'),
      curriculumId: original.id,
      expectedVersion: original.version,
      expectedContractId: original.contractVersionId,
      expectedExecutionSourceManifestFingerprint: original.executionSourceManifest.fingerprint,
      edit: { kind: 'rename_unit', learningUnitId: target.id, title: 'Working memory foundations' },
    } as const;
    const renamed = services.curriculum.applyDraftEdit(renameRequest).curriculum;
    expect(services.curriculum.applyDraftEdit(renameRequest).curriculum).toEqual(renamed);
    const renamedTarget = renamed.nodes.find((node) => node.id === target.id)!;
    expect(renamedTarget.title).toBe('Working memory foundations');
    expect({
      id: renamedTarget.id,
      sourceReferences: renamedTarget.sourceReferences,
      learningUnit: renamedTarget.learningUnit,
    }).toEqual(originalIdentity);
    expect(repos.curricula.get(original.id)?.status).toBe('rejected');

    const focused = services.curriculum.applyDraftEdit({
      command: command('focus-skeleton-unit'),
      curriculumId: renamed.id,
      expectedVersion: renamed.version,
      expectedContractId: renamed.contractVersionId,
      expectedExecutionSourceManifestFingerprint: renamed.executionSourceManifest.fingerprint,
      edit: { kind: 'set_unit_focus', learningUnitId: target.id, focus: 'focused' },
    }).curriculum;
    expect(focused.nodes.find((node) => node.id === target.id)?.learningUnit?.focus).toBe(
      'focused',
    );

    const beforeOrder = focused.nodes.filter((node) => node.learningUnit).map((node) => node.id);
    const movedId = beforeOrder[2]!;
    const reordered = services.curriculum.applyDraftEdit({
      command: command('reorder-skeleton-unit'),
      curriculumId: focused.id,
      expectedVersion: focused.version,
      expectedContractId: focused.contractVersionId,
      expectedExecutionSourceManifestFingerprint: focused.executionSourceManifest.fingerprint,
      edit: { kind: 'reorder_unit', learningUnitId: movedId, direction: 'up' },
    }).curriculum;
    expect(reordered.nodes.filter((node) => node.learningUnit).map((node) => node.id)).toEqual([
      beforeOrder[0],
      beforeOrder[2],
      beforeOrder[1],
    ]);
    expect(reordered.nodes.find((node) => node.id === target.id)?.learningUnit?.focus).toBe(
      'focused',
    );
  });

  it('deterministically rejects a Skeleton reorder that crosses a prerequisite', async () => {
    const { repos, services } = createHarness({
      withConcept: true,
      sectionCount: 3,
      focusRequest: null,
    });
    await services.coursePreparation.run(runRequest(services.coursePreparation.get('ws_1')));
    const proposal = repos.curricula.list('ws_1').at(-1)!;
    const units = proposal.nodes.filter((node) => node.learningUnit);
    expect(units[1]!.learningUnit?.prerequisiteUnitIds).toContain(units[0]!.id);

    expect(() =>
      services.curriculum.applyDraftEdit({
        command: command('invalid-reorder-skeleton-unit'),
        curriculumId: proposal.id,
        expectedVersion: proposal.version,
        expectedContractId: proposal.contractVersionId,
        expectedExecutionSourceManifestFingerprint: proposal.executionSourceManifest.fingerprint,
        edit: { kind: 'reorder_unit', learningUnitId: units[1]!.id, direction: 'up' },
      }),
    ).toThrow('prerequisite after its dependent');
    expect(repos.curricula.list('ws_1')).toHaveLength(1);
    expect(repos.curricula.get(proposal.id)?.status).toBe('proposed');
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
      details: {
        kind: 'curriculum_detail_batch_bound_exceeded',
        maxDetailBatches: 2,
        diagnosticCodes: ['curriculum_detail_planning_failed'],
      },
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
    // Keep one predecessor capability in scope so the recovery path remains
    // exercised without making its independent output budget mask batch 2.
    harness.provider.nextLegacyNonOptionalObjectiveLimit = 1;
    const predecessorId = await acceptSourceOnlyCurriculum(harness);
    const predecessor = structuredClone(harness.repos.curricula.get(predecessorId));
    expect(
      predecessor?.nodes
        .flatMap((node) => node.learningUnit?.objectives ?? [])
        .filter((objective) => objective.priority !== 'optional'),
    ).toHaveLength(1);
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

  it('rejects a globally impossible recovery output before Course Map provider work', async () => {
    const harness = createHarness({
      withConcept: true,
      sectionCount: 49,
    });
    const predecessorId = await acceptSourceOnlyCurriculum(harness);
    const predecessor = structuredClone(harness.repos.curricula.get(predecessorId));
    expect(
      predecessor?.nodes
        .flatMap((node) => node.learningUnit?.objectives ?? [])
        .filter((objective) => objective.priority !== 'optional'),
    ).toHaveLength(49);
    harness.provider.curriculumCalls = 0;
    harness.provider.detailCalls = 0;

    await expect(
      harness.services.curriculum.propose(
        {
          command: command('recovery-detail-output-overflow'),
          contractId: harness.contract.id,
          expectedContractVersion: harness.contract.version,
          predecessorCurriculumId: predecessorId,
          expectedActiveCurriculumId: harness.repos.courseExecution.get('ws_1').activeCurriculumId,
        },
        { generationPolicy: COURSE_MAP_CURRICULUM_GENERATION_POLICY },
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationError,
      details: {
        kind: 'curriculum_detail_batch_bound_exceeded',
        maxDetailBatches: 2,
        diagnosticCodes: ['recovery_capability_detail_output_budget_exceeded'],
      },
    });
    expect(harness.provider.curriculumCalls).toBe(0);
    expect(harness.provider.detailCalls).toBe(0);
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(1);
    expect(harness.repos.curricula.get(predecessorId)).toEqual(predecessor);
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

  it('keeps an active artifact-free route teachable with Formal readiness pending', async () => {
    const harness = createHarness({ withConcept: true });
    const prepared = await harness.services.coursePreparation.run(
      runRequest(harness.services.coursePreparation.get('ws_1')),
    );
    expect(prepared.preparation.state).toBe('course_plan_ready');

    const predecessorPlan = harness.repos.studyPlans.list('ws_1').at(-1)!;
    const predecessorCurriculum = harness.repos.curricula.get(predecessorPlan.curriculumVersionId)!;
    harness.services.courseExecution.decideStudyPlan({
      command: command('accept-predecessor-route'),
      studyPlanId: predecessorPlan.id,
      expectedVersion: predecessorPlan.version,
      expectedContractId: harness.contract.id,
      expectedCurriculumId: predecessorCurriculum.id,
      expectedExecutionSourceManifestFingerprint:
        predecessorCurriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    });

    const artifactFree = harness.repos.curricula.get(predecessorCurriculum.id)!;
    expect(
      artifactFree.nodes
        .flatMap((node) => node.learningUnit?.objectives ?? [])
        .every((objective) => objective.semanticSupport === undefined),
    ).toBe(true);

    const curriculumCallsBefore = harness.provider.curriculumCalls;
    const studyPlanCallsBefore = harness.provider.studyPlanCalls;
    const projection = harness.services.coursePreparation.get('ws_1');
    expect(projection).toMatchObject({
      state: 'complete',
      machineAction: null,
      learnerAction: 'continue_study',
      learnerDecisionRequired: false,
      formalReadiness: { status: 'pending', readyObjectiveCount: 0 },
      checkpoints: { assessmentReadiness: 'pending' },
    });
    expect(harness.provider.curriculumCalls).toBe(curriculumCallsBefore);
    expect(harness.provider.studyPlanCalls).toBe(studyPlanCallsBefore);
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(1);
    expect(harness.repos.studyPlans.list('ws_1')).toHaveLength(1);
    expect(harness.repos.courseExecution.get('ws_1')).toMatchObject({
      activeCurriculumId: predecessorCurriculum.id,
      acceptedPlanId: predecessorPlan.id,
    });
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
      learnerAction: 'none',
      learnerDecisionRequired: false,
      canResume: false,
      operationKey: null,
      blocker: {
        code: 'course_structure_generation_failed',
        message: '课程结构准备未完成。课程结构需要重新组织。 当前有效课程结构没有改变。',
      },
      failure: { action: 'prepare_course_structure', retryable: false },
    });
    expect(harness.services.courseOverview.get('ws_1').capabilities.canProposeCurriculum).toBe(
      false,
    );

    const curriculumCalls = harness.provider.curriculumCalls;
    const result = await harness.services.coursePreparation.run({
      command: command('structural-no-retry'),
      expectedRevision: blocked.revision,
    });
    expect(result.preparation).toEqual(blocked);
    expect(harness.provider.curriculumCalls).toBe(curriculumCalls);
  });

  it('allows reevaluation after a semantic policy update while preserving the previous failure', async () => {
    const harness = createHarness();
    harness.provider.failCurriculum = true;
    const policy = vi
      .spyOn(curriculumSemanticEvaluator, 'CURRICULUM_SEMANTIC_EVALUATOR_POLICY_VERSION', 'get')
      .mockReturnValue(
        'curriculum-semantic-v1' as typeof curriculumSemanticEvaluator.CURRICULUM_SEMANTIC_EVALUATOR_POLICY_VERSION,
      );
    let previousRevision: string;
    let operationId: string;
    try {
      const initial = harness.services.coursePreparation.get('ws_1');
      await expect(harness.services.coursePreparation.run(runRequest(initial))).rejects.toThrow(
        'controlled Curriculum failure',
      );
      operationId = harness.repos.operations.listForWorkspace('ws_1', 'course_preparation')[0]!.id;
      harness.db
        .prepare('UPDATE agent_operation_results SET payload = ? WHERE operation_id = ?')
        .run(
          JSON.stringify({
            code: ApiErrorCode.GroundingFailed,
            details: {
              kind: 'curriculum_candidate_validation',
              errors: ['Pedagogical Curriculum quality: semantic_topic_scattering'],
            },
          }),
          operationId,
        );
      const blocked = harness.services.coursePreparation.get('ws_1');
      expect(blocked).toMatchObject({ state: 'blocked', canResume: false });
      previousRevision = blocked.revision;
    } finally {
      policy.mockRestore();
    }

    const previousFailure = harness.repos.operations.getResult(operationId!);
    const current = harness.services.coursePreparation.get('ws_1');
    expect(current.revision).not.toBe(previousRevision!);
    expect(current).toMatchObject({
      machineAction: 'prepare_course_structure',
      canResume: true,
      failure: null,
    });
    harness.provider.failCurriculum = false;
    await harness.services.coursePreparation.run(runRequest(current));
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(1);
    expect(harness.provider.analyzeCalls).toBe(1);
    expect(harness.repos.operations.getResult(operationId!)).toEqual(previousFailure);
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
    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'complete',
      formalReadiness: { status: 'pending' },
    });

    activateReplacementRevision(harness.repos);

    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'preparing_concepts',
      machineAction: 'prepare_concepts',
      learnerAction: 'resume_preparation',
    });
  });

  it('keeps teaching available while Formal readiness is pending without a semantic row', async () => {
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
      state: 'complete',
      formalReadiness: { status: 'pending', readyObjectiveCount: 0 },
      learnerDecisionRequired: false,
      learnerAction: 'continue_study',
      checkpoints: { assessmentReadiness: 'pending' },
    });
  });

  it('never emits continue_study for a selected queued synthesis that has no executable teaching fallback', async () => {
    const harness = createHarness({ withConcept: true });
    await harness.services.coursePreparation.run(
      runRequest(harness.services.coursePreparation.get('ws_1')),
    );
    const plan = harness.repos.studyPlans.list('ws_1').at(-1)!;
    const curriculum = harness.repos.curricula.get(plan.curriculumVersionId)!;
    harness.services.courseExecution.decideStudyPlan({
      command: command('accept-non-executable-synthesis-route'),
      studyPlanId: plan.id,
      expectedVersion: plan.version,
      expectedContractId: harness.contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    });

    const acceptedPlan = harness.repos.studyPlans.get(plan.id)!;
    const planItem = acceptedPlan.items[0]!;
    const synthesisPlan = {
      ...acceptedPlan,
      items: acceptedPlan.items.map((item) =>
        item.id === planItem.id ? { ...item, kind: 'synthesis' as const } : item,
      ),
    };
    harness.db
      .prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?')
      .run(JSON.stringify(synthesisPlan), acceptedPlan.id);
    harness.db
      .prepare('UPDATE study_plan_items SET kind = ? WHERE plan_id = ? AND plan_item_id = ?')
      .run('synthesis', acceptedPlan.id, planItem.id);

    const activeAgendaId = harness.repos.courseExecution.get('ws_1').activeAgendaId!;
    const agenda = harness.repos.sessionAgendas.get(activeAgendaId)!;
    const agendaItem = agenda.items[0]!;
    const synthesisAgenda = {
      ...agenda,
      items: agenda.items.map((item) =>
        item.id === agendaItem.id
          ? {
              ...item,
              kind: 'synthesis' as const,
              launch: {
                status: 'launchable' as const,
                capability: 'assessment',
                resourceId: '{"mode":"concept_practice"}',
                reason: null,
              },
            }
          : item,
      ),
    };
    harness.db
      .prepare('UPDATE session_agendas SET payload = ? WHERE id = ?')
      .run(JSON.stringify(synthesisAgenda), agenda.id);
    harness.db
      .prepare(
        `UPDATE session_agenda_items
         SET kind = 'synthesis', launch_capability = 'assessment',
             launch_resource_id = '{"mode":"concept_practice"}'
         WHERE agenda_id = ? AND agenda_item_id = ?`,
      )
      .run(agenda.id, agendaItem.id);

    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'blocked',
      learnerAction: 'none',
      learnerDecisionRequired: false,
      formalReadiness: { status: 'pending', readyObjectiveCount: 0 },
      blocker: { code: 'formal_assessment_readiness_unavailable' },
    });
    expect(harness.repos.studyPlans.get(plan.id)?.items[0]?.objectiveIds).toEqual(
      planItem.objectiveIds,
    );
  });

  it('projects a recorded semantic FAIL as Formal-blocked without disabling teaching', async () => {
    const harness = createHarness({
      compactMaterial: true,
      minutesPerDay: 60,
      preferredSessionMinutes: 60,
    });
    await harness.services.coursePreparation.run(
      runRequest(harness.services.coursePreparation.get('ws_1')),
    );
    const plan = harness.repos.studyPlans.list('ws_1').at(-1)!;
    const curriculum = insertObjectiveSemanticSupport(
      harness.repos,
      plan.curriculumVersionId,
      'fail',
    );
    harness.services.courseExecution.decideStudyPlan({
      command: command('accept-semantic-fail-route'),
      studyPlanId: plan.id,
      expectedVersion: plan.version,
      expectedContractId: harness.contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    });

    expect(harness.services.coursePreparation.get('ws_1')).toMatchObject({
      state: 'complete',
      machineAction: null,
      learnerAction: 'continue_study',
      formalReadiness: { status: 'blocked', readyObjectiveCount: 0 },
      checkpoints: { assessmentReadiness: 'blocked' },
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
    const curriculum = insertObjectiveSemanticSupport(harness.repos, plan.curriculumVersionId);
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
    const agenda = harness.repos.sessionAgendas.list('ws_1').at(-1)!;
    // Later Agenda windows contain only a subset of the accepted route. The
    // authority of checkpoints in other windows must not disappear.
    expect(
      assessCourseFormalReadiness(harness.repos, curriculum, {
        studyPlan: harness.repos.studyPlans.get(plan.id)!,
        agenda: {
          ...agenda,
          items: agenda.items.filter((item) => item.kind !== 'formal_checkpoint'),
        },
      }).status,
    ).toBe('ready');
  });

  it('keeps a route teachable when its unevaluated Formal premise is not currently authorized', async () => {
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

    const curriculumCallsBefore = harness.provider.curriculumCalls;
    const projection = harness.services.coursePreparation.get('ws_1');
    expect(projection).toMatchObject({
      state: 'complete',
      machineAction: null,
      checkpoints: { courseStructure: 'complete', assessmentReadiness: 'pending' },
      formalReadiness: { status: 'pending' },
      learnerDecisionRequired: false,
      learnerAction: 'continue_study',
    });
    expect(harness.provider.curriculumCalls).toBe(curriculumCallsBefore);
    expect(harness.repos.curricula.list('ws_1')).toHaveLength(1);
    expect(harness.repos.courseExecution.get('ws_1')).toMatchObject({
      activeCurriculumId: curriculum.id,
      acceptedPlanId: plan.id,
    });
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
