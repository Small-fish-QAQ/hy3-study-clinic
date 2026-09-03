import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssessmentAttemptSchema,
  GradeRecordSchema,
  FormalQuestionContractSchema,
  type Curriculum,
  type FormalAssessmentConstruct,
  type FormalProposalMetadata,
  type LearningContract,
  type LearningContractFeasibility,
  type SessionAgenda,
  type StudyPlan,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { ProviderError } from '../llm/errors.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import {
  makeBlock,
  makeConcept,
  makeGrounding,
  makeMaterial,
  makeQuestion,
  makeQuiz,
  makeSemanticallySupportedObjective,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { seedPresentedTeachingFixture } from '../testing/taughtExposureFixture.js';
import { buildCurriculumExecutionContext } from './curriculum.js';
import {
  assessmentItemFingerprint,
  lessonExecutionExposureFingerprints,
} from './formalAssessments.js';
import { createServices, type Services } from './index.js';
import { createReviewBackfillService } from './reviewBackfill.js';
import { buildFormalAssessmentProposalCatalogue } from './formalProgression.js';

const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const T3 = '2026-01-01T00:03:00.000Z';
const T4 = '2026-01-01T00:04:00.000Z';

let db: SqliteDb;
let repos: Repositories;
let services: Services;
let provider: FakeProvider;
let revisionId: string;
let authorityId: string;
let rubricAuthorityId: string;

function command(commandId: string, actor: 'learner' | 'local' = 'local') {
  return { commandId, idempotencyKey: commandId, workspaceId: 'ws_1', actor };
}

function stageAndActivateRoute() {
  const legacyRole = repos.materialRoles.getCurrent('mat_1')!;
  const role = repos.materialRoles.confirm(
    repos.materialRoles.createVersion({
      id: 'role_course',
      materialId: 'mat_1',
      version: 2,
      predecessorId: legacyRole.id,
      role: 'course_material',
      status: 'proposed',
      proposedBy: 'learner',
      learnerConfirmedAt: null,
      createdAt: T0,
    }).id,
    T1,
  );
  const contract: LearningContract = {
    id: 'contract_1',
    workspaceId: 'ws_1',
    version: 1,
    predecessorId: null,
    intent: 'Learn memory capacity',
    targetOutcome: { description: 'Working fluency', targetScore: 80, credential: null },
    deadline: null,
    studyBudget: {
      minutesPerDay: 30,
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
    projectedMinutes: 30,
    slackMinutes: null,
    reasonCodes: ['deadline_absent'],
    assumptions: ['No deadline supplied.'],
    policyVersion: 'feasibility-v1',
    computedAt: T0,
  };
  repos.learningContracts.createVersion(contract, feasibility, {
    id: 'contract_created',
    eventType: 'created',
    actor: 'learner',
    payload: {},
    createdAt: T0,
  });
  repos.learningContracts.transition('contract_1', 'draft', 'proposed', T1, {
    id: 'contract_proposed',
    eventType: 'proposed',
    actor: 'learner',
    payload: {},
    createdAt: T1,
  });
  const confirmedContract = repos.learningContracts.transition(
    'contract_1',
    'proposed',
    'learner_confirmed',
    T2,
    {
      id: 'contract_confirmed',
      eventType: 'learner_confirmed',
      actor: 'learner',
      payload: {},
      createdAt: T2,
    },
  );
  const manifest = {
    fingerprint: 'manifest-fp',
    revisions: buildCurriculumExecutionContext(repos, confirmedContract).manifest.revisions,
  };
  repos.curricula.createManifest('manifest_1', 'ws_1', manifest, T0);
  const curriculum: Curriculum = {
    id: 'curriculum_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: manifest,
    nodes: [
      {
        id: 'root_1',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Memory course',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'unit_1',
        parentId: 'root_1',
        kind: 'learning_unit',
        index: 0,
        title: 'Working-memory capacity',
        sourceReferences: [
          {
            materialId: 'mat_1',
            materialRevisionId: revisionId,
            structuralUnitId: null,
            sourceBlockId: 'blk_1',
            sourceBlockRevisionFingerprint: 'block-fp',
          },
          {
            materialId: 'mat_1',
            materialRevisionId: revisionId,
            structuralUnitId: null,
            sourceBlockId: 'blk_2',
            sourceBlockRevisionFingerprint: 'block-fp-2',
          },
        ],
        learningUnit: {
          conceptIds: ['con_1'],
          canonicalConceptIds: [],
          objectives: [
            makeSemanticallySupportedObjective(
              {
                id: 'objective_1',
                title: 'Explain capacity',
                description:
                  'Explain the source-stated relationship that working-memory capacity is limited.',
                truthPremiseStatus: 'independently_verified',
                truthAuthorityRecordIds: [authorityId, rubricAuthorityId],
                authorityClaimIds: ['claim_1', 'claim_rubric_1'],
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
                id: 'objective_2',
                title: 'Identify capacity',
                description: 'Identify the source-stated limit on working-memory capacity.',
                truthPremiseStatus: 'independently_verified',
                truthAuthorityRecordIds: [authorityId, rubricAuthorityId],
                authorityClaimIds: ['claim_1', 'claim_rubric_1'],
                priority: 'normal',
                formalAssessmentReady: true,
                formalAssessmentReadinessRationale:
                  'The exact source states the working-memory capacity limit.',
                formalAssessmentConstruct: 'identify',
                authorityEnvelopeTier: 'formal_sufficient',
                authoritySourceBlockIds: ['blk_1'],
                formalEvidenceSourceBlockIds: ['blk_1'],
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
    curriculum,
    {
      id: 'curriculum_created',
      eventType: 'proposed',
      actor: 'local',
      payload: {},
      createdAt: T0,
    },
    { capabilityRecoveryPredecessorId: null },
  );
  const acceptedCurriculum = repos.curricula.accept('curriculum_1', T2, {
    id: 'curriculum_accepted',
    eventType: 'accepted',
    actor: 'learner',
    payload: {},
    createdAt: T2,
  });
  const plan: StudyPlan = {
    id: 'plan_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    executionSourceManifestFingerprint: 'manifest-fp',
    version: 1,
    predecessorId: null,
    proposalTrigger: 'Initial route',
    status: 'proposed',
    rationale: 'Follow source order.',
    items: ['objective_1', 'objective_2'].map((objectiveId, index) => ({
      id: `plan_item_${index + 1}`,
      index,
      phase: 'Foundations',
      kind: index === 0 ? ('formal_checkpoint' as const) : ('teach_unit' as const),
      curriculumLearningUnitId: 'unit_1',
      rationale: `Teach ${objectiveId}.`,
      estimatedMinutes: 15,
      targetDepth: 'working_fluency' as const,
      objectiveIds: [objectiveId],
      prerequisitePlanItemIds: [],
      completionPolicy: { id: 'completion-policy', version: 1 },
      completionRequirements: [
        {
          id: `requirement_${objectiveId}`,
          objectiveIds: [objectiveId],
          description: `Verify ${objectiveId}.`,
          // The fixture's second route item is intentionally diagnostic rather
          // than a blocking completion premise; dedicated tests add multiple
          // blocking objectives to prove the coverage gate.
          blocking: objectiveId === 'objective_1',
          admissibilityTier: 'tier_1_authorized_truth' as const,
        },
      ],
    })),
    deferrals: [],
    feasibility: {
      projectedMinutes: 30,
      availableMinutes: null,
      slackMinutes: null,
      state: 'unknown',
      assumptions: ['No deadline supplied.'],
    },
    paceBaseline: {
      id: 'pace_1',
      policyVersion: 'pace-v1',
      contractVersionId: 'contract_1',
      studyPlanVersionId: 'plan_1',
      timeZone: 'Asia/Shanghai',
      expectedSessionCadencePerWeek: 3,
      explicitSlackMinutes: 0,
      estimateConfidence: 'medium',
      estimateSource: 'local',
      milestones: [],
    },
    diff: [],
    provider: 'fake',
    providerModel: null,
    learnerAcceptedAt: null,
    createdAt: T0,
  };
  repos.studyPlans.createVersion(
    plan,
    plan.items.map((item) => ({
      planItemId: item.id,
      launch: {
        status: 'launchable' as const,
        capability:
          item.kind === 'formal_checkpoint' ? ('assessment' as const) : ('lesson' as const),
        resourceId:
          item.kind === 'formal_checkpoint' ? null : JSON.stringify({ conceptId: 'con_1' }),
        reason: null,
      },
      sourceFingerprint: 'manifest-fp',
      validatedAt: T2,
    })),
    {
      id: 'plan_created',
      eventType: 'proposed',
      actor: 'local',
      payload: {},
      createdAt: T2,
    },
  );
  const agenda: SessionAgenda = {
    id: 'agenda_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    executionSourceManifestFingerprint: 'manifest-fp',
    version: 1,
    status: 'draft',
    availableMinutes: 30,
    items: plan.items.map((item, index) => ({
      id: `agenda_item_${index + 1}`,
      index,
      kind:
        item.kind === 'formal_checkpoint'
          ? ('formal_checkpoint' as const)
          : ('learning_unit_teaching' as const),
      origin: 'accepted_plan' as const,
      reason: item.rationale,
      estimatedMinutes: item.estimatedMinutes,
      linkedPlanItemId: item.id,
      learningUnitId: 'unit_1',
      priority: 'high' as const,
      state: 'queued' as const,
      launch: {
        status: 'launchable' as const,
        capability:
          item.kind === 'formal_checkpoint' ? ('assessment' as const) : ('lesson' as const),
        resourceId:
          item.kind === 'formal_checkpoint' ? null : JSON.stringify({ conceptId: 'con_1' }),
        reason: null,
      },
      displacedAgendaItemIds: [],
      timeImpactMinutes: 0,
    })),
    currentItemId: null,
    createdAt: T2,
    updatedAt: T2,
  };
  repos.sessionAgendas.create(agenda, {
    id: 'agenda_created',
    eventType: 'composed',
    actor: 'local',
    payload: {},
    createdAt: T2,
  });
  repos.courseExecution.activateRoute({
    workspaceId: 'ws_1',
    contractId: 'contract_1',
    curriculumId: 'curriculum_1',
    planId: 'plan_1',
    agendaId: 'agenda_1',
    expectedStateVersion: 0,
    expectedActiveContractId: null,
    expectedActiveCurriculumId: null,
    expectedAcceptedPlanId: null,
    expectedActiveAgendaId: null,
    eventId: 'route_activated',
    actor: 'learner',
    acceptedAt: T3,
  });
  return { contract: confirmedContract, curriculum: acceptedCurriculum, plan, agenda };
}

function insertGrade(
  suffix: string,
  score: number,
  blockId = 'blk_1',
  stem?: string,
  objectiveRef: string | null = 'O1',
) {
  const quizId = `quiz_${suffix}`;
  const questionId = `question_${suffix}`;
  const admittedPremise = repos.materials.getBlock(blockId)!.content;
  repos.quizzes.insert(
    makeQuiz({
      id: quizId,
      materialId: null,
      workspaceId: 'ws_1',
      kind: 'adaptive',
      assessmentMode: 'formal_checkpoint',
      questions: [
        makeQuestion({
          id: questionId,
          quizId,
          type: 'short_answer',
          ...(stem ? { stem } : {}),
          options: undefined,
          correctOptionIds: undefined,
          expectedAnswer: admittedPremise,
          rubric: { keyPoints: [{ text: admittedPremise, required: true }] },
          grounding: makeGrounding({ blockId }),
          formalProposal: {
            ...(objectiveRef ? { objectiveRef } : {}),
            premises: [
              {
                premiseKey: 'source:0',
                text: admittedPremise,
                sourceRefs: [blockId],
                teachingSurfaceRefs: [],
                learnerVisible: true,
                scenarioLocal: false,
                visibilityBasis: 'cited_source',
              },
            ],
            requiresExternalKnowledge: false,
            ambiguity: 'none',
            undefinedTerms: [],
            rubricSourceRefs: [{ text: admittedPremise, sourceRefs: [blockId] }],
          },
        }),
      ],
    }),
  );
  repos.submissions.insertSubmission({
    id: `submission_${suffix}`,
    quizId,
    answers: [{ questionId, type: 'short_answer', text: admittedPremise }],
    createdAt: T3,
  });
  repos.submissions.insertGradingResult({
    id: `grading_${suffix}`,
    submissionId: `submission_${suffix}`,
    quizId,
    grades: [
      {
        questionId,
        type: 'short_answer',
        gradedBy: 'model',
        correct: score === 1,
        awardedPoints: score,
        maxPoints: 1,
        normalizedScore: score,
        needsReview: false,
      },
    ],
    totalAwarded: score,
    totalPossible: 1,
    overallScore: score,
    createdAt: T3,
  });
  return { quizId, questionId, gradingResultId: `grading_${suffix}` };
}

function createAssessmentEvidence(
  suffix: string,
  createdAt = T3,
  representation: 'recall' | 'application' = 'recall',
  agendaItemId = 'agenda_item_1',
) {
  const source = insertGrade(`assessment_${suffix}`, 1);
  services.formalProgression.registerAssessmentContracts({
    workspaceId: 'ws_1',
    quizId: source.quizId,
    agendaId: 'agenda_1',
    agendaItemId,
    assessmentKind: 'formal_checkpoint',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    executionSourceManifestFingerprint: 'manifest-fp',
  });
  const version = services.formalAssessments.createAcceptedFromQuiz({
    workspaceId: 'ws_1',
    quiz: repos.quizzes.get(source.quizId)!,
    logicalKey: `bridge-${suffix}`,
    title: `Bridge ${suffix}`,
    targetLearningUnitId: 'unit_1',
    targetObjectiveId: 'objective_1',
    representation,
    progressionContext: {
      quizId: source.quizId,
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      agendaId: 'agenda_1',
      agendaItemId,
      assessmentKind: 'formal_checkpoint',
      executionSourceManifestFingerprint: 'manifest-fp',
    },
  });
  const attempt = services.formalAssessments.startAttempt(version.id, 'ws_1');
  const responses = { [version.items[0]!.id]: repos.materials.getBlock('blk_1')!.content };
  services.formalAssessments.submitAttempt(attempt.id, responses);
  const grade = services.formalAssessments.recordGrade(
    GradeRecordSchema.parse({
      id: `assessment_grade_${suffix}`,
      attemptId: attempt.id,
      assessmentVersionId: version.id,
      grader: 'fake',
      rubricVersion: 'formal-short-answer-v1',
      status: 'current',
      judgment: {
        score: 1,
        criterionResults: [{ criterionId: version.items[0]!.rubric![0]!.id, result: 'met' }],
        feedback: 'supported',
      },
      supersedesId: null,
      createdAt,
    }),
  );
  const evidence = services.formalAssessments.deriveEvidence(grade.id)[0]!;
  if (evidence.createdAt !== createdAt) {
    db.prepare('UPDATE assessment_evidence_records SET created_at = ? WHERE id = ?').run(
      createdAt,
      evidence.id,
    );
  }
  return {
    source,
    version,
    attempt,
    responses,
    grade,
    evidence: repos.formalAssessments.getEvidence(evidence.id)!,
  };
}

function createExposureVersion(suffix: string, stem: string) {
  const source = insertGrade(`exposure_${suffix}`, 1, 'blk_1', stem);
  return services.formalAssessments.createAcceptedFromQuiz({
    workspaceId: 'ws_1',
    quiz: repos.quizzes.get(source.quizId)!,
    logicalKey: `exposure-${suffix}`,
    title: `Exposure ${suffix}`,
    targetLearningUnitId: 'unit_1',
    targetObjectiveId: 'objective_1',
    representation: 'recall',
  });
}

function installSameUnitFormalActions() {
  const plan = repos.studyPlans.get('plan_1')!;
  const template = plan.items[0]!;
  const formalItems = [
    { id: 'plan_checkpoint', kind: 'formal_checkpoint' as const },
    { id: 'plan_checkpoint_later', kind: 'formal_checkpoint' as const },
    { id: 'plan_synthesis', kind: 'synthesis' as const },
    { id: 'plan_repair', kind: 'targeted_repair' as const },
  ].map((item, offset) => ({
    ...template,
    ...item,
    index: plan.items.length + offset,
    rationale: `Execute ${item.kind}.`,
  }));
  db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
    JSON.stringify({ ...plan, items: [...plan.items, ...formalItems] }),
    plan.id,
  );
  const insertPlanItem = db.prepare(
    `INSERT INTO study_plan_items
       (plan_id, plan_item_id, idx, kind, curriculum_learning_unit_id,
        objective_ids, completion_requirements)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLaunch = db.prepare(
    `INSERT INTO study_plan_launch_validations
       (plan_id, plan_item_id, status, capability, resource_id, reason,
        source_fingerprint, validated_at)
     VALUES (?, ?, 'launchable', 'assessment', NULL, NULL, 'manifest-fp', ?)`,
  );
  const insertProgress = db.prepare(
    `INSERT INTO study_plan_progress (plan_id, plan_item_id, state, version, updated_at)
     VALUES (?, ?, 'not_started', 1, ?)`,
  );
  for (const item of formalItems) {
    insertPlanItem.run(
      plan.id,
      item.id,
      item.index,
      item.kind,
      item.curriculumLearningUnitId,
      JSON.stringify(item.objectiveIds),
      JSON.stringify(item.completionRequirements),
    );
    insertLaunch.run(plan.id, item.id, T3);
    insertProgress.run(plan.id, item.id, T3);
  }

  const agenda = repos.sessionAgendas.get('agenda_1')!;
  const agendaItems = formalItems.map((item, offset) => ({
    id:
      item.id === 'plan_checkpoint'
        ? 'agenda_formal_checkpoint'
        : item.id === 'plan_checkpoint_later'
          ? 'agenda_formal_checkpoint_later'
          : `agenda_${item.kind}`,
    index: agenda.items.length + offset,
    kind: item.kind,
    origin: 'accepted_plan' as const,
    reason: item.rationale,
    estimatedMinutes: item.estimatedMinutes,
    linkedPlanItemId: item.id,
    learningUnitId: 'unit_1',
    priority: 'high' as const,
    state: 'queued' as const,
    launch: {
      status: 'launchable' as const,
      capability: 'assessment',
      resourceId: null,
      reason: null,
    },
    displacedAgendaItemIds: [],
    timeImpactMinutes: 0,
  }));
  const updatedAgenda = repos.sessionAgendas.update(
    {
      ...agenda,
      version: agenda.version + 1,
      status: 'active',
      items: [...agenda.items, ...agendaItems],
      currentItemId: 'agenda_formal_checkpoint',
      updatedAt: T3,
    },
    agenda.version,
    {
      id: 'agenda_same_unit_actions',
      eventType: 'same_unit_actions_installed',
      actor: 'local',
      payload: {},
      createdAt: T3,
    },
  );
  return {
    agenda: updatedAgenda,
    checkpointAgendaItemId: 'agenda_formal_checkpoint',
    laterCheckpointAgendaItemId: 'agenda_formal_checkpoint_later',
    synthesisAgendaItemId: 'agenda_synthesis',
    repairAgendaItemId: 'agenda_targeted_repair',
  };
}

function installTwoUnitSynthesisRoute(options: { withSecondSemanticSupport?: boolean } = {}) {
  const actions = installSameUnitFormalActions();
  const secondBlock = repos.materials.getBlock('blk_2')!;
  repos.materials.replaceConcepts('mat_1', [
    makeConcept(),
    makeConcept({
      id: 'con_2',
      name: 'Capacity application',
      summary: secondBlock.content,
      grounding: makeGrounding({
        blockId: secondBlock.id,
        quote: secondBlock.content,
        startOffset: 0,
        endOffset: secondBlock.content.length,
        occurrenceCount: 1,
      }),
    }),
  ]);
  const admitted = services.sourceAuthority.ensureVerbatimAssessmentAuthority(
    'ws_1',
    'mat_1',
    revisionId,
  );
  const secondAuthorityBundles = admitted.filter((bundle) =>
    bundle.claims.some((claim) => claim.sourceBlockId === secondBlock.id),
  );
  const secondAuthorityIds = secondAuthorityBundles.map((bundle) => bundle.record.id);
  const secondAuthorityClaimIds = secondAuthorityBundles.flatMap((bundle) =>
    bundle.claims
      .filter((claim) => claim.sourceBlockId === secondBlock.id)
      .map((claim) => claim.id),
  );
  expect(secondAuthorityIds).toHaveLength(2);

  const curriculum = repos.curricula.get('curriculum_1')!;
  const secondObjectiveId = 'objective_synthesis_2';
  const supportedSecondObjective = makeSemanticallySupportedObjective(
    {
      id: secondObjectiveId,
      title: 'Apply the second source premise',
      description: 'Use the second source premise in an integrated response.',
      truthPremiseStatus: 'independently_verified',
      truthAuthorityRecordIds: secondAuthorityIds,
      authorityClaimIds: secondAuthorityClaimIds,
      priority: 'normal',
      formalAssessmentReady: true,
      formalAssessmentReadinessRationale:
        'The exact second source premise is available for an integrated response.',
      formalAssessmentConstruct: 'apply',
      authorityEnvelopeTier: 'formal_sufficient',
      authoritySourceBlockIds: [secondBlock.id],
      formalEvidenceSourceBlockIds: [secondBlock.id],
    },
    'procedure',
  );
  const { semanticSupport: secondSemanticSupport, ...artifactFreeSecondObjective } =
    supportedSecondObjective;
  const secondObjective =
    options.withSecondSemanticSupport === false
      ? artifactFreeSecondObjective
      : supportedSecondObjective;
  const secondUnit = {
    id: 'unit_2',
    parentId: 'root_1',
    kind: 'learning_unit' as const,
    index: 1,
    title: 'Apply working-memory capacity',
    sourceReferences: [
      {
        materialId: 'mat_1',
        materialRevisionId: revisionId,
        structuralUnitId: null,
        sourceBlockId: secondBlock.id,
        sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(secondBlock, revisionId),
      },
    ],
    learningUnit: {
      conceptIds: ['con_2'],
      canonicalConceptIds: [],
      objectives: [secondObjective],
      prerequisiteUnitIds: ['unit_1'],
      graphRelationIds: [],
      riskIds: [],
    },
  };
  db.prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?').run(
    JSON.stringify({
      ...curriculum,
      nodes: [...curriculum.nodes, secondUnit],
      synthesisGroups: [
        {
          id: 'synthesis_group_1',
          title: 'Capacity integration',
          level: 'course',
          learningUnitIds: ['unit_1', 'unit_2'],
          objectiveIds: ['objective_1', secondObjectiveId],
        },
      ],
    }),
    curriculum.id,
  );
  db.prepare(
    `INSERT INTO curriculum_node_index
       (curriculum_id, node_id, parent_node_id, kind, idx, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    curriculum.id,
    secondUnit.id,
    secondUnit.parentId,
    secondUnit.kind,
    secondUnit.index,
    secondUnit.title,
  );
  db.prepare(
    `INSERT INTO curriculum_node_source_refs
       (curriculum_id, node_id, ordinal, material_id, material_revision_id,
        structural_unit_id, source_block_id, source_block_revision_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    curriculum.id,
    secondUnit.id,
    0,
    'mat_1',
    revisionId,
    null,
    secondBlock.id,
    curriculumSourceBlockFingerprint(secondBlock, revisionId),
  );
  db.prepare(
    `INSERT INTO curriculum_objective_index
       (curriculum_id, learning_unit_id, objective_id, truth_premise_status)
     VALUES (?, ?, ?, ?)`,
  ).run(curriculum.id, secondUnit.id, secondObjectiveId, 'independently_verified');
  for (const authorityRecordId of secondAuthorityIds) {
    db.prepare(
      `INSERT INTO curriculum_objective_authority
         (curriculum_id, objective_id, authority_record_id) VALUES (?, ?, ?)`,
    ).run(curriculum.id, secondObjectiveId, authorityRecordId);
  }
  if (options.withSecondSemanticSupport !== false) {
    repos.curricula.insertObjectiveSemanticSupportsIfAbsent(curriculum.id, [
      secondSemanticSupport!,
    ]);
  }
  const plan = repos.studyPlans.get('plan_1')!;
  db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
    JSON.stringify({
      ...plan,
      items: plan.items.map((item) =>
        item.id === 'plan_synthesis'
          ? { ...item, objectiveIds: ['objective_1', secondObjectiveId] }
          : item,
      ),
    }),
    plan.id,
  );
  seedPresentedTeachingFixture({
    db,
    repos,
    workspaceId: 'ws_1',
    curriculum: repos.curricula.get('curriculum_1')!,
    studyPlanVersionId: 'plan_1',
    learningUnitId: secondUnit.id,
    objectiveIds: [secondObjectiveId],
    sessionAgendaId: actions.agenda.id,
    agendaItemId: actions.synthesisAgendaItemId,
    studyPlanItemId: 'plan_synthesis',
    at: T3,
    suffix: 'synthesis_unit_2',
  });
  return { ...actions, secondBlock, secondObjectiveId };
}

function replaceFormalProposal(questionId: string, formalProposal: FormalProposalMetadata) {
  const question = repos.quizzes.getQuestion(questionId)!;
  db.prepare('UPDATE questions SET payload = ? WHERE id = ?').run(
    JSON.stringify({ ...question, formalProposal }),
    questionId,
  );
}

function updateTeachingBrief(
  briefId: string,
  transform: (
    brief: NonNullable<ReturnType<Repositories['teachingBriefs']['get']>>,
  ) => NonNullable<ReturnType<Repositories['teachingBriefs']['get']>>,
) {
  const brief = repos.teachingBriefs.get(briefId)!;
  const updated = transform(brief);
  db.prepare('UPDATE teaching_briefs SET payload = ? WHERE id = ?').run(
    JSON.stringify(updated),
    briefId,
  );
  return updated;
}

function makeAiTeachingBrief(briefId: string, explanation?: string) {
  return updateTeachingBrief(briefId, (brief) => ({
    ...brief,
    segments: brief.segments.map((segment) => ({
      ...segment,
      ...(explanation ? { explanation } : {}),
      explanationAuthority: 'ai_teaching_synthesis' as const,
      sourceRefIds: [],
    })),
  }));
}

function formalProposal(input: {
  objectiveRef?: string;
  premiseText: string;
  sourceRefs?: string[];
  teachingSurfaceRefs?: string[];
  visibilityBasis: FormalProposalMetadata['premises'][number]['visibilityBasis'];
  learnerVisible?: boolean;
  scenarioLocal?: boolean;
  requiresExternalKnowledge?: boolean;
  ambiguity?: FormalProposalMetadata['ambiguity'];
  undefinedTerms?: string[];
  rubricSourceRefs?: string[];
}): FormalProposalMetadata {
  const admittedPremise = repos.materials.getBlock('blk_1')!.content;
  return {
    ...(input.objectiveRef ? { objectiveRef: input.objectiveRef } : {}),
    premises: [
      {
        premiseKey: 'premise:1',
        text: input.premiseText,
        sourceRefs: input.sourceRefs ?? [],
        teachingSurfaceRefs: input.teachingSurfaceRefs ?? [],
        learnerVisible: input.learnerVisible ?? true,
        scenarioLocal: input.scenarioLocal ?? false,
        visibilityBasis: input.visibilityBasis,
      },
    ],
    requiresExternalKnowledge: input.requiresExternalKnowledge ?? false,
    ambiguity: input.ambiguity ?? 'none',
    undefinedTerms: input.undefinedTerms ?? [],
    rubricSourceRefs: [{ text: admittedPremise, sourceRefs: input.rubricSourceRefs ?? ['blk_1'] }],
  };
}

function formalCatalogue(planItemId = 'plan_item_1') {
  const plan = repos.studyPlans.get('plan_1')!;
  return buildFormalAssessmentProposalCatalogue({
    repos,
    workspaceId: 'ws_1',
    curriculum: repos.curricula.get('curriculum_1')!,
    plan,
    planItemId,
    learningUnitId: 'unit_1',
  });
}

function enableRouteItemsAsFormalCheckpoints(
  bindings: Array<{ planItemId: string; agendaItemId: string }> = [
    { planItemId: 'plan_item_1', agendaItemId: 'agenda_item_1' },
  ],
  planId = 'plan_1',
  agendaId = 'agenda_1',
) {
  const plan = repos.studyPlans.get(planId)!;
  const planItemIds = new Set(bindings.map((binding) => binding.planItemId));
  const agendaItemIds = new Set(bindings.map((binding) => binding.agendaItemId));
  db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
    JSON.stringify({
      ...plan,
      items: plan.items.map((item) =>
        planItemIds.has(item.id) ? { ...item, kind: 'formal_checkpoint' as const } : item,
      ),
    }),
    plan.id,
  );
  for (const binding of bindings) {
    db.prepare('UPDATE study_plan_items SET kind = ? WHERE plan_id = ? AND plan_item_id = ?').run(
      'formal_checkpoint',
      plan.id,
      binding.planItemId,
    );
    db.prepare(
      `UPDATE study_plan_launch_validations
       SET capability = 'assessment', resource_id = NULL
       WHERE plan_id = ? AND plan_item_id = ?`,
    ).run(plan.id, binding.planItemId);
  }
  const agenda = repos.sessionAgendas.get(agendaId)!;
  const updated = repos.sessionAgendas.update(
    {
      ...agenda,
      version: agenda.version + 1,
      items: agenda.items.map((item) =>
        agendaItemIds.has(item.id)
          ? {
              ...item,
              kind: 'formal_checkpoint' as const,
              launch: {
                status: 'launchable' as const,
                capability: 'assessment' as const,
                resourceId: null,
                reason: null,
              },
            }
          : item,
      ),
      updatedAt: T3,
    },
    agenda.version,
    {
      id: `agenda_checkpoint_enabled_${agenda.id}_${agenda.version}`,
      eventType: 'test_checkpoint_enabled',
      actor: 'local',
      payload: {},
      createdAt: T3,
    },
  );
  for (const binding of bindings) {
    db.prepare(
      `UPDATE session_agenda_items
       SET kind = 'formal_checkpoint', launch_capability = 'assessment', launch_resource_id = NULL
       WHERE agenda_id = ? AND agenda_item_id = ?`,
    ).run(agenda.id, binding.agendaItemId);
  }
  return updated;
}

function enableFirstRouteItemAsFormalCheckpoint() {
  return enableRouteItemsAsFormalCheckpoints();
}

function insertSynthesisQuiz(includeSecondUnit: boolean, suffix = '') {
  const firstBlock = repos.materials.getBlock('blk_1')!;
  const secondBlock = repos.materials.getBlock('blk_2')!;
  const quizId = `${includeSecondUnit ? 'quiz_synthesis_broad' : 'quiz_synthesis_narrow'}${suffix}`;
  const questionFor = (input: {
    id: string;
    conceptId: string;
    conceptName: string;
    block: typeof firstBlock;
    index: number;
  }) =>
    makeQuestion({
      id: input.id,
      quizId,
      index: input.index,
      type: 'short_answer',
      options: undefined,
      correctOptionIds: undefined,
      expectedAnswer: input.block.content,
      rubric: { keyPoints: [{ text: input.block.content, required: true }] },
      conceptId: input.conceptId,
      conceptName: input.conceptName,
      grounding: makeGrounding({
        blockId: input.block.id,
        quote: input.block.content,
        startOffset: 0,
        endOffset: input.block.content.length,
        occurrenceCount: 1,
      }),
      formalProposal: {
        objectiveRef: `O${input.index + 1}`,
        premises: [
          {
            premiseKey: 'source:0',
            text: input.block.content,
            sourceRefs: [input.block.id],
            teachingSurfaceRefs: [],
            learnerVisible: true,
            scenarioLocal: false,
            visibilityBasis: 'cited_source',
          },
        ],
        requiresExternalKnowledge: false,
        ambiguity: 'none',
        undefinedTerms: [],
        rubricSourceRefs: [{ text: input.block.content, sourceRefs: [input.block.id] }],
      },
    });
  const questions = [
    questionFor({
      id: `${quizId}_q1`,
      conceptId: 'con_1',
      conceptName: 'Working memory',
      block: firstBlock,
      index: 0,
    }),
    ...(includeSecondUnit
      ? [
          questionFor({
            id: `${quizId}_q2`,
            conceptId: 'con_2',
            conceptName: 'Capacity application',
            block: secondBlock,
            index: 1,
          }),
        ]
      : []),
  ];
  repos.quizzes.insert(
    makeQuiz({
      id: quizId,
      materialId: null,
      workspaceId: 'ws_1',
      kind: 'adaptive',
      assessmentMode: 'concept_practice',
      questions,
    }),
  );
  return quizId;
}

function insertSynthesisGrade(score: number, suffix = '') {
  const quizId = insertSynthesisQuiz(true, suffix);
  const quiz = repos.quizzes.get(quizId)!;
  const submissionId = `${quizId}_submission`;
  const gradingResultId = `${quizId}_grading`;
  repos.submissions.insertSubmission({
    id: submissionId,
    quizId,
    answers: quiz.questions.map((question) => ({
      questionId: question.id,
      type: 'short_answer' as const,
      text: question.expectedAnswer!,
    })),
    createdAt: T3,
  });
  repos.submissions.insertGradingResult({
    id: gradingResultId,
    submissionId,
    quizId,
    grades: quiz.questions.map((question) => ({
      questionId: question.id,
      type: 'short_answer' as const,
      gradedBy: 'model' as const,
      correct: score === 1,
      awardedPoints: score,
      maxPoints: 1,
      normalizedScore: score,
      needsReview: false,
    })),
    totalAwarded: score * quiz.questions.length,
    totalPossible: quiz.questions.length,
    overallScore: score,
    createdAt: T3,
  });
  return { quizId, gradingResultId };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace({ name: 'Memory course' }));
  repos.materials.insertWithBlocks(makeMaterial({ title: 'Memory notes' }), [
    makeBlock(),
    makeBlock({
      id: 'blk_2',
      index: 1,
      heading: 'Supplemental claim',
      headingPath: ['Supplemental claim'],
      content: 'An unverified supplemental premise.',
      startOffset: 22,
      endOffset: 57,
    }),
  ]);
  repos.materials.replaceConcepts('mat_1', [makeConcept()]);
  revisionId = repos.materialRevisions.getActive('mat_1')!.id;
  authorityId = 'authority_1';
  rubricAuthorityId = 'authority_rubric_1';
  const block = repos.materials.getBlock('blk_1')!;
  repos.sourceAuthority.createVersion({
    id: authorityId,
    workspaceId: 'ws_1',
    logicalSourceId: 'logical_truth_1',
    materialId: 'mat_1',
    materialRevisionId: revisionId,
    predecessorId: null,
    premiseScope: block.content,
    policyBasis: {
      policyVersion: 'truth-v1',
      premiseKind: 'expected_answer',
      basis: 'independently admitted assessment answer',
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
        claim: block.content,
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
  repos.sourceAuthority.createVersion({
    id: rubricAuthorityId,
    workspaceId: 'ws_1',
    logicalSourceId: 'logical_rubric_truth_1',
    materialId: 'mat_1',
    materialRevisionId: revisionId,
    predecessorId: null,
    premiseScope: block.content,
    policyBasis: {
      policyVersion: 'truth-v1',
      premiseKind: 'rubric_point',
      basis: 'independently admitted verbatim rubric point',
    },
    validationState: 'validated',
    conflictState: 'none',
    actor: 'local_validator',
    createdAt: T0,
    updatedAt: T0,
    claims: [
      {
        id: 'claim_rubric_1',
        sourceBlockId: block.id,
        claim: block.content,
        quote: block.content,
        startOffset: 0,
        endOffset: block.content.length,
        occurrenceCount: 1,
        createdAt: T0,
      },
    ],
    event: {
      id: 'authority_rubric_event_1',
      eventType: 'validated',
      actor: 'local_validator',
      payload: {},
      createdAt: T0,
    },
  });
  stageAndActivateRoute();
  provider = new FakeProvider();
  services = createServices({ repos, provider, clock: fixedClock(T3) });
  correctCurriculumSourceFingerprints();
  seedPresentedTeachingFixture({
    db,
    repos,
    workspaceId: 'ws_1',
    curriculum: repos.curricula.get('curriculum_1')!,
    studyPlanVersionId: 'plan_1',
    learningUnitId: 'unit_1',
    objectiveIds: ['objective_1'],
    sessionAgendaId: 'agenda_1',
    agendaItemId: 'agenda_item_1',
    studyPlanItemId: 'plan_item_1',
    at: T3,
  });
});

function makeDueReview(suffix: string, seedAgendaItemId = 'agenda_item_1') {
  const historical = createAssessmentEvidence(
    `review_seed_${suffix}`,
    T3,
    'recall',
    seedAgendaItemId,
  );
  const reconciliation = services.formalAssessments.reconcileEvidence(historical.evidence.id);
  if (reconciliation.status !== 'applied') throw new Error('Review seed did not reconcile.');
  const targetId = 'review-target:ws_1:objective_1';
  db.prepare('UPDATE memory_schedule_states SET due_at = ? WHERE review_target_id = ?').run(
    T3,
    targetId,
  );
  return { historical, targetId };
}

function dueAgendaItem() {
  services.courseOverview.get('ws_1');
  const agenda = repos.sessionAgendas.get('agenda_1')!;
  const item = agenda.items.find((candidate) => candidate.kind === 'due_review');
  if (!item) throw new Error('Due Review Agenda item was not reconciled.');
  return { agenda, item };
}

async function launchDueReview(suffix: string) {
  const { agenda, item } = dueAgendaItem();
  const request = {
    agendaId: agenda.id,
    expectedAgendaVersion: agenda.version,
    agendaItemId: item.id,
    expectedContractId: 'contract_1',
    expectedStudyPlanId: 'plan_1',
    expectedExecutionSourceManifestFingerprint: 'manifest-fp',
  };
  const launched = await services.courseActionLaunch.launch({
    command: command(`launch_due_review_${suffix}`, 'learner'),
    ...request,
  });
  if (launched.kind !== 'assessment' || !launched.formalAssessmentVersionId) {
    throw new Error('Expected a formal due Review assessment.');
  }
  return { agenda, item, request, launched };
}

function correctCurriculumSourceFingerprints() {
  const curriculum = repos.curricula.get('curriculum_1')!;
  const nodes = curriculum.nodes.map((node) => ({
    ...node,
    sourceReferences: node.sourceReferences.map((reference) => {
      if (!reference.sourceBlockId) return reference;
      const block = repos.materials.getBlock(reference.sourceBlockId)!;
      return {
        ...reference,
        sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(block, revisionId),
      };
    }),
  }));
  db.prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?').run(
    JSON.stringify({ ...curriculum, nodes }),
    curriculum.id,
  );
}

function removePrimarySemanticSupportForFixture() {
  db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_delete');
  const removed = db
    .prepare(
      `DELETE FROM curriculum_objective_semantic_support
       WHERE curriculum_id = ? AND objective_id = ?`,
    )
    .run('curriculum_1', 'objective_1');
  if (removed.changes !== 1) {
    throw new Error('Expected the primary semantic-support fixture row.');
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
}

function makePrimaryObjectiveApplicationCapable(
  formalAssessmentConstruct: FormalAssessmentConstruct = 'apply',
) {
  const curriculum = repos.curricula.get('curriculum_1')!;
  const nodes = curriculum.nodes.map((node) => {
    if (node.id !== 'unit_1' || !node.learningUnit) return node;
    return {
      ...node,
      learningUnit: {
        ...node.learningUnit,
        objectives: node.learningUnit.objectives.map((objective) => {
          if (objective.id !== 'objective_1') return objective;
          const { semanticSupport: _semanticSupport, ...withoutSemanticSupport } = objective;
          return makeSemanticallySupportedObjective(
            {
              ...withoutSemanticSupport,
              formalAssessmentConstruct,
              authoritySourceBlockIds: objective.authoritySourceBlockIds ?? [],
              authorityClaimIds: objective.authorityClaimIds ?? [],
            },
            formalAssessmentConstruct === 'identify'
              ? 'recognition'
              : formalAssessmentConstruct === 'explain'
                ? 'relationship'
                : 'procedure',
          );
        }),
      },
    };
  });
  const updated = { ...curriculum, nodes };
  db.prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?').run(
    JSON.stringify(updated),
    curriculum.id,
  );
  const support = updated.nodes
    .flatMap((node) => node.learningUnit?.objectives ?? [])
    .find((objective) => objective.id === 'objective_1')!.semanticSupport!;
  db.exec('DROP TRIGGER IF EXISTS prevent_curriculum_objective_semantic_support_update');
  db.prepare(
    `UPDATE curriculum_objective_semantic_support
     SET policy_version = ?, evaluator = ?, provider = ?, provider_model = ?, status = ?,
         proposition_fingerprint = ?, binding_fingerprint = ?, payload = ?, evaluated_at = ?
     WHERE curriculum_id = ? AND objective_id = ?`,
  ).run(
    support.policyVersion,
    support.evaluator,
    support.provider,
    support.providerModel,
    support.verdict,
    support.propositionFingerprint,
    support.bindingFingerprint,
    JSON.stringify(support),
    support.evaluatedAt,
    curriculum.id,
    support.objectiveId,
  );
}

async function seedEligibleMasteryRedTeamState(suffix: string) {
  const { historical, targetId } = makeDueReview(suffix);
  const { launched } = await launchDueReview(suffix);
  const execution = services.learnerAssessments.start(launched.formalAssessmentVersionId!, 'ws_1');
  const version = repos.formalAssessments.getVersion(launched.formalAssessmentVersionId!)!;
  const answer = version.items[0]!.rubric!.map((criterion) => criterion.text).join(' ');
  await services.learnerAssessments.submit(execution.attempt.id, {
    [version.items[0]!.id]: answer,
  });
  correctCurriculumSourceFingerprints();
  return { historical, targetId };
}

function authoritativeState(targetId: string) {
  return {
    evidenceCount: (
      db.prepare('SELECT COUNT(*) AS count FROM assessment_evidence_records').get() as {
        count: number;
      }
    ).count,
    reconciliationCount: (
      db.prepare('SELECT COUNT(*) AS count FROM assessment_progression_reconciliations').get() as {
        count: number;
      }
    ).count,
    mastery: repos.mastery.listByWorkspace('ws_1'),
    mistakes: repos.mistakes.listByMaterial('mat_1'),
    repairs: repos.repair.listByWorkspace('ws_1'),
    reviewState: repos.reviewSuccessor.getState(targetId),
    reviewEvents: repos.reviewSuccessor.listEvents(targetId),
    progression: repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1'),
    truthAuthorityCount: (
      db.prepare('SELECT COUNT(*) AS count FROM truth_authority_records').get() as {
        count: number;
      }
    ).count,
  };
}

describe('formal progression service', () => {
  it('reconciles one exact due Review into Agenda and resumes one durable launch', async () => {
    const { targetId } = makeDueReview('launch');
    let agenda = repos.sessionAgendas.get('agenda_1')!;
    if (!agenda.currentItemId) {
      agenda = repos.sessionAgendas.update(
        { ...agenda, version: agenda.version + 1, currentItemId: 'agenda_item_2', updatedAt: T3 },
        agenda.version,
        {
          id: 'agenda_positioned_before_due_review',
          eventType: 'positioned_for_session',
          actor: 'local',
          payload: {},
          createdAt: T3,
        },
      );
    }
    const route = repos.courseExecution.get('ws_1');
    const session = services.studySessions.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: agenda.id,
      expectedCourseExecutionVersion: route.version,
    }).session;
    const priorSessionItemId = session.currentAgendaItemId;
    const beforeVersion = agenda.version;

    const firstOverview = services.courseOverview.get('ws_1');
    const reconciled = repos.sessionAgendas.get('agenda_1')!;
    const dueItems = reconciled.items.filter((item) => item.kind === 'due_review');
    expect(firstOverview.nextAction?.item.kind).not.toBe('due_review');
    expect(services.reviewSuccessor.listCurrentProjection('ws_1')).toContainEqual(
      expect.objectContaining({
        reviewTargetId: targetId,
        objectiveTitle: 'Explain capacity',
        workflowPhase: 'due',
      }),
    );
    expect(dueItems).toHaveLength(1);
    expect(dueItems[0]).toMatchObject({ priority: 'high', state: 'queued' });
    expect(reconciled.version).toBe(beforeVersion + 1);
    expect(repos.studySessions.get(session.id)?.currentAgendaItemId).toBe(priorSessionItemId);

    services.courseOverview.get('ws_1');
    expect(repos.sessionAgendas.get('agenda_1')?.version).toBe(reconciled.version);
    expect(
      repos.sessionAgendas.get('agenda_1')?.items.filter((item) => item.kind === 'due_review'),
    ).toHaveLength(1);

    const proposalCall = vi.spyOn(provider, 'proposeAssessment');
    const launch = await launchDueReview('launch');
    expect(launch.launched).toMatchObject({ assessmentKind: 'due_review' });
    const execution = repos.reviewSuccessor.activeExecution(targetId)!;
    expect(execution).toMatchObject({
      agendaId: 'agenda_1',
      assessmentVersionId: launch.launched.formalAssessmentVersionId,
      attemptId: null,
      status: 'active',
    });

    const replay = await services.courseActionLaunch.launch({
      command: command('launch_due_review_launch_replay', 'learner'),
      ...launch.request,
    });
    expect(replay).toEqual(launch.launched);
    expect(proposalCall).toHaveBeenCalledTimes(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM review_executions').get() as { n: number }).n,
    ).toBe(1);

    await expect(
      services.courseActionLaunch.launch({
        command: command('launch_due_review_stale', 'learner'),
        ...launch.request,
        expectedExecutionSourceManifestFingerprint: 'stale-manifest',
      }),
    ).rejects.toThrow(/stale/i);
    expect(repos.reviewSuccessor.activeExecution(targetId)?.id).toBe(execution.id);
  });

  it('requests and records application demand only for an application-capable due Review', async () => {
    makePrimaryObjectiveApplicationCapable();
    makeDueReview('application_demand');
    const proposeAssessment = provider.proposeAssessment.bind(provider);
    const proposalCall = vi
      .spyOn(provider, 'proposeAssessment')
      .mockImplementation(async (input, options) => {
        const payload = await proposeAssessment(input, options);
        return {
          ...payload,
          items: payload.items.map((item) => ({
            ...item,
            requestedChallengeFamily: 'counterexample',
          })),
        };
      });

    const { launched } = await launchDueReview('application_demand');
    const version = repos.formalAssessments.getVersion(launched.formalAssessmentVersionId!)!;

    expect(proposalCall).toHaveBeenCalledTimes(1);
    expect(proposalCall.mock.calls[0]?.[0].requiredRepresentation).toBe('application');
    expect(proposalCall.mock.calls[0]?.[0].requestedChallengeFamily).toBe('representation_shift');
    expect(version.items).toEqual([
      expect.objectContaining({ representation: 'application', formalEligible: true }),
    ]);
    expect(repos.formalAssessments.getItemIntent(version.id, version.items[0]!.id)).toMatchObject({
      assessmentStage: 'due_review',
      requestedChallengeFamily: 'representation_shift',
      requestedRepresentation: 'application',
      selectionReason: 'representation_diversity_missing',
    });
    expect(
      repos.formalProgression.listQuestionContractsForQuiz(version.progressionContext!.quizId),
    ).toEqual([expect.objectContaining({ representation: 'application' })]);
  });

  /**
   * Slice 5B plus DOGFOOD-02A. `design` and `evaluate` remain valid teaching
   * constructs, but neither has a deterministic Formal evidence predicate.
   * The on-demand authority boundary now refuses the Formal launch before the
   * provider can stamp any demand rung into a question contract.
   */
  it.each(['design', 'evaluate'] as const)(
    'refuses Formal launch for a teaching-only %s objective on the same Review path',
    async (construct) => {
      makeDueReview(`teaching_only_${construct}`);
      makePrimaryObjectiveApplicationCapable(construct);
      const proposalCall = vi.spyOn(provider, 'proposeAssessment');

      await expect(launchDueReview(construct)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: expect.objectContaining({
          boundary: 'formal_provider',
          diagnosticCodes: expect.arrayContaining(['semantic_construct_prohibited_v1']),
        }),
      });
      expect(proposalCall).not.toHaveBeenCalled();
    },
  );

  it('requests transfer through the existing due-Review call after application evidence exists', async () => {
    makePrimaryObjectiveApplicationCapable();
    const application = createAssessmentEvidence('transfer_application', T3, 'application');
    expect(services.formalAssessments.reconcileEvidence(application.evidence.id).status).toBe(
      'applied',
    );
    const actions = installSameUnitFormalActions();
    makeDueReview('transfer', actions.checkpointAgendaItemId);
    const proposalCall = vi.spyOn(provider, 'proposeAssessment');
    const masteryBefore = repos.mastery.listByWorkspace('ws_1');

    const { launched } = await launchDueReview('transfer');
    const version = repos.formalAssessments.getVersion(launched.formalAssessmentVersionId!)!;

    expect(proposalCall).toHaveBeenCalledTimes(1);
    expect(proposalCall.mock.calls[0]?.[0]).toMatchObject({
      requiredRepresentation: 'application',
      requestedChallengeFamily: 'transfer',
    });
    expect(repos.formalAssessments.getItemIntent(version.id, version.items[0]!.id)).toMatchObject({
      assessmentStage: 'due_review',
      requestedChallengeFamily: 'transfer',
      requestedRepresentation: 'application',
      selectionReason: 'transfer_context_missing',
    });
    expect(version.items[0]?.representation).toBe('application');
    expect(repos.mastery.listByWorkspace('ws_1')).toEqual(masteryBefore);
  });

  it('rejects generated Review content when qualifying evidence changes during the provider call', async () => {
    makePrimaryObjectiveApplicationCapable();
    const { historical } = makeDueReview('diversity_stale');
    const { agenda, item } = dueAgendaItem();
    const versionCountBefore =
      repos.formalAssessments.listProjectionRecords('ws_1').versions.length;
    const proposeAssessment = provider.proposeAssessment.bind(provider);
    const proposalCall = vi
      .spyOn(provider, 'proposeAssessment')
      .mockImplementation(async (input, options) => {
        const payload = await proposeAssessment(input, options);
        repos.formalAssessments.insertGrade(
          GradeRecordSchema.parse({
            ...historical.grade,
            id: 'assessment_grade_diversity_stale_superseding',
            status: 'current',
            supersedesId: historical.grade.id,
            createdAt: T4,
          }),
        );
        return payload;
      });

    await expect(
      services.courseActionLaunch.launch({
        command: command('launch_due_review_diversity_stale', 'learner'),
        agendaId: agenda.id,
        expectedAgendaVersion: agenda.version,
        agendaItemId: item.id,
        expectedContractId: 'contract_1',
        expectedStudyPlanId: 'plan_1',
        expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      }),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      message: 'Assessment evidence changed while the question was generated.',
    });

    expect(proposalCall).toHaveBeenCalledTimes(1);
    expect(proposalCall.mock.calls[0]?.[0].requestedChallengeFamily).toBe('representation_shift');
    expect(repos.formalAssessments.listProjectionRecords('ws_1').versions).toHaveLength(
      versionCountBefore,
    );
    expect(repos.formalAssessments.listItemIntentsForWorkspace('ws_1')).toEqual([]);
  });

  it('resolves direct supported recall with one Good and no mastery mutation', async () => {
    const { historical, targetId } = makeDueReview('direct');
    const masteryBefore = repos.mastery.listByWorkspace('ws_1');
    const { launched } = await launchDueReview('direct');
    const first = services.learnerAssessments.start(launched.formalAssessmentVersionId!, 'ws_1');
    const resumed = services.learnerAssessments.start(launched.formalAssessmentVersionId!, 'ws_1');
    expect(resumed.attempt.id).toBe(first.attempt.id);
    expect(first.review).toMatchObject({ phase: 'retrieval', resolved: false });
    const version = repos.formalAssessments.getVersion(launched.formalAssessmentVersionId!)!;
    expect(version.items[0]?.representation).toBe('recall');
    const answer = version.items[0]!.rubric!.map((criterion) => criterion.text).join(' ');

    const result = await services.learnerAssessments.submit(first.attempt.id, {
      [version.items[0]!.id]: answer,
    });
    const execution = repos.reviewSuccessor.findExecutionByAttempt(first.attempt.id)!;
    const executionEvents = repos.reviewSuccessor
      .listEvents(targetId)
      .filter((event) => event.reviewExecutionId === execution.id);
    expect(result.result).toMatchObject({ demonstrated: true, evidenceStatus: 'supported' });
    expect(result.review).toMatchObject({
      phase: 'resolved',
      resolved: true,
      schedulingRetryRequired: false,
      nextDueAt: expect.any(String),
    });
    expect(executionEvents.map((event) => event.rating)).toEqual(['Good']);
    expect(executionEvents.some((event) => event.rating === 'Again')).toBe(false);
    expect(repos.reviewSuccessor.getExecution(execution.id)?.status).toBe('completed');
    expect(repos.formalAssessments.getEvidence(historical.evidence.id)).toEqual(
      historical.evidence,
    );
    expect(repos.mastery.listByWorkspace('ws_1')).toEqual(masteryBefore);
  });

  it('runs failure through Repair and changed-context verification as Again then Good', async () => {
    const { historical, targetId } = makeDueReview('repair');
    installSameUnitFormalActions();
    const { launched } = await launchDueReview('repair');
    const retrieval = services.learnerAssessments.start(
      launched.formalAssessmentVersionId!,
      'ws_1',
    );
    const retrievalVersion = repos.formalAssessments.getVersion(
      launched.formalAssessmentVersionId!,
    )!;
    const failed = await services.learnerAssessments.submit(retrieval.attempt.id, {
      [retrievalVersion.items[0]!.id]: 'unrelated answer',
    });
    const repairId = failed.result?.repairEpisodeId;
    if (!repairId) throw new Error('Expected targeted Repair after failed retrieval.');
    const execution = repos.reviewSuccessor.findExecutionByAttempt(retrieval.attempt.id)!;
    expect(failed.review).toMatchObject({ phase: 'repair', resolved: false });
    expect(
      repos.reviewSuccessor
        .listEvents(targetId)
        .filter((event) => event.reviewExecutionId === execution.id)
        .map((event) => event.rating),
    ).toEqual(['Again']);

    await services.learnerAssessments.startRepair(repairId);
    services.learnerAssessments.practice(
      repairId,
      'The capacity limit constrains active processing.',
      'READY_FOR_VERIFICATION',
    );
    expect(
      repos.reviewSuccessor
        .listEvents(targetId)
        .filter((event) => event.reviewExecutionId === execution.id),
    ).toHaveLength(1);

    const firstVerification = services.learnerAssessments.createVerification(repairId);
    expect(firstVerification.review?.phase).toBe('fresh_verification');
    const firstVerificationVersion = repos.formalAssessments.getVersion(
      firstVerification.assessmentVersionId,
    )!;
    await services.learnerAssessments.submit(firstVerification.attempt.id, {
      [firstVerificationVersion.items[0]!.id]: 'still unrelated',
    });
    expect(
      repos.reviewSuccessor
        .listEvents(targetId)
        .filter((event) => event.reviewExecutionId === execution.id),
    ).toHaveLength(1);
    expect(repos.repair.listByWorkspace('ws_1')).toHaveLength(1);

    services.learnerAssessments.practice(
      repairId,
      'Reworked the explanation with the source premise.',
      'READY_FOR_VERIFICATION',
    );
    const secondVerification = services.learnerAssessments.createVerification(repairId);
    await services.learnerAssessments.submit(firstVerification.attempt.id, {
      [firstVerificationVersion.items[0]!.id]: 'still unrelated',
    });
    expect(repos.repair.listByWorkspace('ws_1')).toHaveLength(1);
    expect(repos.repair.getEpisode(repairId)).toMatchObject({
      status: 'AWAITING_VERIFICATION',
      verificationAttemptId: secondVerification.attempt.id,
    });
    const secondVerificationVersion = repos.formalAssessments.getVersion(
      secondVerification.assessmentVersionId,
    )!;
    const supportedAnswer = secondVerificationVersion.items[0]!.rubric!.map(
      (criterion) => criterion.text,
    ).join(' ');
    const resolved = await services.learnerAssessments.submit(secondVerification.attempt.id, {
      [secondVerificationVersion.items[0]!.id]: supportedAnswer,
    });
    expect(resolved.review).toMatchObject({ phase: 'resolved', resolved: true });
    expect(repos.repair.getEpisode(repairId)).toMatchObject({
      status: 'RESOLVED',
      verificationAttemptId: secondVerification.attempt.id,
    });
    expect(
      repos.reviewSuccessor
        .listEvents(targetId)
        .filter((event) => event.reviewExecutionId === execution.id)
        .map((event) => event.rating),
    ).toEqual(['Again', 'Good']);
    expect(repos.formalAssessments.getEvidence(historical.evidence.id)).toEqual(
      historical.evidence,
    );
    const finalAgenda = repos.sessionAgendas.get('agenda_1')!;
    expect(finalAgenda.items.find((item) => item.kind === 'due_review')?.state).toBe('completed');
    expect(
      finalAgenda.items
        .filter((item) => item.kind === 'targeted_repair')
        .every((item) => item.state === 'cancelled'),
    ).toBe(true);
    expect(finalAgenda.currentItemId).not.toBe(
      finalAgenda.items.find((item) => item.kind === 'due_review')?.id,
    );
  });

  it('preserves Formal state across scheduler failure and retries without regrading', async () => {
    const { targetId } = makeDueReview('scheduler_failure');
    const { launched } = await launchDueReview('scheduler_failure');
    const learner = services.learnerAssessments.start(launched.formalAssessmentVersionId!, 'ws_1');
    const version = repos.formalAssessments.getVersion(launched.formalAssessmentVersionId!)!;
    const answer = version.items[0]!.rubric!.map((criterion) => criterion.text).join(' ');
    const gradeCall = vi.spyOn(provider, 'gradeShortAnswer');
    db.exec(`
      CREATE TRIGGER inject_due_review_scheduler_failure
      BEFORE INSERT ON successor_review_events
      WHEN NEW.kind = 'fresh_verification_success' AND NEW.review_execution_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected due Review scheduler failure'); END;
    `);

    const saved = await services.learnerAssessments.submit(learner.attempt.id, {
      [version.items[0]!.id]: answer,
    });
    const execution = repos.reviewSuccessor.findExecutionByAttempt(learner.attempt.id)!;
    expect(saved.result).toMatchObject({ demonstrated: true, evidenceStatus: 'supported' });
    expect(saved.review).toMatchObject({
      phase: 'scheduling_retry',
      resolved: false,
      schedulingRetryRequired: true,
    });
    expect(repos.formalAssessments.listGrades(learner.attempt.id)).toHaveLength(1);
    expect(
      repos.formalAssessments.getReconciliationForGrade(saved.result!.gradeRecordId),
    ).toMatchObject({
      status: 'applied',
    });
    expect(repos.reviewSuccessor.getExecution(execution.id)).toMatchObject({
      status: 'active',
      failureReason: expect.stringContaining('injected due Review scheduler failure'),
    });
    expect(
      repos.reviewSuccessor
        .listEvents(targetId)
        .filter((event) => event.reviewExecutionId === execution.id),
    ).toHaveLength(0);

    db.exec('DROP TRIGGER inject_due_review_scheduler_failure');
    const retried = await services.learnerAssessments.submit(learner.attempt.id, {
      [version.items[0]!.id]: answer,
    });
    expect(retried.review).toMatchObject({
      phase: 'resolved',
      resolved: true,
      schedulingRetryRequired: false,
    });
    expect(gradeCall).toHaveBeenCalledTimes(1);
    expect(repos.formalAssessments.listGrades(learner.attempt.id)).toHaveLength(1);
    expect(
      repos.reviewSuccessor
        .listEvents(targetId)
        .filter((event) => event.reviewExecutionId === execution.id)
        .map((event) => event.rating),
    ).toEqual(['Good']);
  });

  it('rejects due Review Evidence without a learner-launched execution', () => {
    makeDueReview('unlaunched_execution');
    const { agenda, item } = dueAgendaItem();
    const source = insertGrade('unlaunched_due_review', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: source.quizId,
      agendaId: agenda.id,
      agendaItemId: item.id,
      assessmentKind: 'due_review',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const version = services.formalAssessments.createAcceptedFromQuiz({
      workspaceId: 'ws_1',
      quiz: repos.quizzes.get(source.quizId)!,
      logicalKey: 'unlaunched-due-review',
      title: 'Unlaunched due Review',
      targetLearningUnitId: 'unit_1',
      targetObjectiveId: 'objective_1',
      representation: 'recall',
      progressionContext: {
        quizId: source.quizId,
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        agendaId: agenda.id,
        agendaItemId: item.id,
        assessmentKind: 'due_review',
        executionSourceManifestFingerprint: 'manifest-fp',
      },
    });
    const attempt = services.formalAssessments.startAttempt(version.id, 'ws_1');
    services.formalAssessments.submitAttempt(attempt.id, {
      [version.items[0]!.id]: version.items[0]!.rubric![0]!.text,
    });
    const grade = services.formalAssessments.recordGrade(
      GradeRecordSchema.parse({
        id: 'unlaunched_due_review_grade',
        attemptId: attempt.id,
        assessmentVersionId: version.id,
        grader: 'fake',
        rubricVersion: 'formal-short-answer-v1',
        status: 'current',
        judgment: {
          score: 1,
          criterionResults: [{ criterionId: version.items[0]!.rubric![0]!.id, result: 'met' }],
          feedback: 'supported',
        },
        supersedesId: null,
        createdAt: T3,
      }),
    );
    const evidence = services.formalAssessments.deriveEvidence(grade.id)[0]!;

    expect(() => services.formalAssessments.reconcileEvidence(evidence.id)).toThrow(
      'Due Review Evidence has no learner-launched ReviewExecution.',
    );
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM review_executions').get() as { n: number }).n,
    ).toBe(0);
    expect(
      repos.reviewSuccessor
        .listEvents('review-target:ws_1:objective_1')
        .filter((event) => event.reviewExecutionId !== null),
    ).toHaveLength(0);
  });

  it('records first, reused, and historically unknown exact-item exposure conservatively', () => {
    const historical = createExposureVersion(
      'historical_source',
      'Explain why working-memory capacity is limited.',
    );
    repos.formalAssessments.insertAttempt(
      AssessmentAttemptSchema.parse({
        id: 'historical_attempt_without_exposure',
        assessmentVersionId: historical.id,
        workspaceId: 'ws_1',
        ordinal: 1,
        status: 'started',
        responses: {},
        startedAt: T0,
        submittedAt: null,
        cancelledAt: null,
      }),
    );
    db.prepare('UPDATE assessment_attempts SET exposure_tracking_version = 0 WHERE id = ?').run(
      'historical_attempt_without_exposure',
    );
    services.formalAssessments.recordAttemptExposure('historical_attempt_without_exposure');
    expect(
      repos.formalAssessments.getExposure(
        'historical_attempt_without_exposure',
        historical.items[0]!.id,
      ),
    ).toMatchObject({ seenBeforeAttempt: null });

    const uncertainHistorical = createExposureVersion(
      'historical_uncertain_source',
      'Describe the bounded relationship between processing and available capacity.',
    );
    repos.formalAssessments.insertAttempt(
      AssessmentAttemptSchema.parse({
        id: 'historical_uncertain_attempt',
        assessmentVersionId: uncertainHistorical.id,
        workspaceId: 'ws_1',
        ordinal: 1,
        status: 'started',
        responses: {},
        startedAt: T0,
        submittedAt: null,
        cancelledAt: null,
      }),
    );
    db.prepare('UPDATE assessment_attempts SET exposure_tracking_version = 0 WHERE id = ?').run(
      'historical_uncertain_attempt',
    );
    const historicalReplay = createExposureVersion(
      'historical_replay',
      'Describe the bounded relationship between processing and available capacity.',
    );
    const historicalReplayAttempt = services.formalAssessments.startAttempt(
      historicalReplay.id,
      'ws_1',
    );
    expect(
      repos.formalAssessments.getExposure(
        historicalReplayAttempt.id,
        historicalReplay.items[0]!.id,
      ),
    ).toBeUndefined();
    services.formalAssessments.recordAttemptExposure(historicalReplayAttempt.id);
    expect(
      repos.formalAssessments.getExposure(
        historicalReplayAttempt.id,
        historicalReplay.items[0]!.id,
      ),
    ).toMatchObject({ seenBeforeAttempt: null });

    const first = createExposureVersion(
      'first',
      'State the source relationship between capacity and active processing.',
    );
    const firstAttempt = services.formalAssessments.startAttempt(first.id, 'ws_1');
    expect(
      repos.formalAssessments.getExposure(firstAttempt.id, first.items[0]!.id),
    ).toBeUndefined();
    services.formalAssessments.recordAttemptExposure(firstAttempt.id);
    expect(repos.formalAssessments.getExposure(firstAttempt.id, first.items[0]!.id)).toMatchObject({
      seenBeforeAttempt: false,
    });

    const reused = createExposureVersion(
      'reused',
      'State the source relationship between capacity and active processing.',
    );
    expect(assessmentItemFingerprint(reused.items[0]!)).toBe(
      assessmentItemFingerprint(first.items[0]!),
    );
    const reusedAttempt = services.formalAssessments.startAttempt(reused.id, 'ws_1');
    services.formalAssessments.recordAttemptExposure(reusedAttempt.id);
    expect(
      repos.formalAssessments.getExposure(reusedAttempt.id, reused.items[0]!.id),
    ).toMatchObject({ seenBeforeAttempt: true });
  });

  it('does not treat a current unpresented Attempt as historical exposure uncertainty', () => {
    const prompt = 'Apply the capacity rule to the stated current condition.';
    const unpresented = createExposureVersion('current_unpresented', prompt);
    const unpresentedAttempt = services.formalAssessments.startAttempt(unpresented.id, 'ws_1');
    expect(
      repos.formalAssessments.getExposure(unpresentedAttempt.id, unpresented.items[0]!.id),
    ).toBeUndefined();

    const firstPresentation = createExposureVersion('after_unpresented', prompt);
    const firstPresentationAttempt = services.formalAssessments.startAttempt(
      firstPresentation.id,
      'ws_1',
    );
    services.formalAssessments.recordAttemptExposure(firstPresentationAttempt.id);

    expect(
      repos.formalAssessments.getExposure(
        firstPresentationAttempt.id,
        firstPresentation.items[0]!.id,
      ),
    ).toMatchObject({ seenBeforeAttempt: false });
  });

  it('treats an exact learner-visible Lesson prompt as seen before a formal Attempt', () => {
    const prompt = 'Apply the source rule to the stated working-memory condition.';
    const brief = {
      segments: [{ index: 0, informalCheck: { prompt } }],
      practice: undefined,
    } as unknown as Parameters<typeof lessonExecutionExposureFingerprints>[0];
    const lessonState = {
      teachingBriefId: 'brief_exposure',
      presentedSegmentIndexes: [0],
      presentationCompletedAt: null,
      practiceInteractions: [],
      practiceCompletedAt: null,
    } as unknown as ReturnType<Repositories['lessonExecution']['listForWorkspace']>[number];
    vi.spyOn(repos.lessonExecution, 'listForWorkspace').mockReturnValue([lessonState]);
    vi.spyOn(repos.teachingBriefs, 'get').mockReturnValue(
      brief as ReturnType<Repositories['teachingBriefs']['get']>,
    );

    const version = createExposureVersion('lesson_prompt_reuse', prompt);
    expect(lessonExecutionExposureFingerprints(brief, lessonState)).toEqual([
      assessmentItemFingerprint(version.items[0]!),
    ]);
    const attempt = services.formalAssessments.startAttempt(version.id, 'ws_1');
    services.formalAssessments.recordAttemptExposure(attempt.id);

    expect(repos.formalAssessments.getExposure(attempt.id, version.items[0]!.id)).toMatchObject({
      seenBeforeAttempt: true,
    });
  });

  it('treats the currently presented non-credit Practice prompt as seen', () => {
    const prompt = 'Which action follows from the source rule in this new condition?';
    const options = [
      { id: 'a', text: 'Apply the bounded rule.' },
      { id: 'b', text: 'Ignore the stated condition.' },
      { id: 'c', text: 'Replace the source rule.' },
    ];
    const brief = {
      segments: [{ index: 0, informalCheck: null }],
      practice: {
        items: [
          {
            initial: { prompt, options },
            retry: { prompt: `Retry: ${prompt}`, options },
          },
        ],
      },
    } as unknown as Parameters<typeof lessonExecutionExposureFingerprints>[0];
    const lessonState = {
      teachingBriefId: 'brief_practice_exposure',
      presentedSegmentIndexes: [0],
      presentationCompletedAt: T3,
      practiceInteractions: [],
      practiceCompletedAt: null,
    } as unknown as ReturnType<Repositories['lessonExecution']['listForWorkspace']>[number];
    vi.spyOn(repos.lessonExecution, 'listForWorkspace').mockReturnValue([lessonState]);
    vi.spyOn(repos.teachingBriefs, 'get').mockReturnValue(
      brief as ReturnType<Repositories['teachingBriefs']['get']>,
    );

    const version = createExposureVersion('practice_prompt_reuse', prompt);
    expect(lessonExecutionExposureFingerprints(brief, lessonState)).toContain(
      assessmentItemFingerprint(version.items[0]!),
    );
    const attempt = services.formalAssessments.startAttempt(version.id, 'ws_1');
    services.formalAssessments.recordAttemptExposure(attempt.id);

    expect(repos.formalAssessments.getExposure(attempt.id, version.items[0]!.id)).toMatchObject({
      seenBeforeAttempt: true,
    });
  });

  it('bridges supported Assessment Evidence through the existing progression projection exactly once', () => {
    const source = insertGrade('assessment_bridge', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: source.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const version = services.formalAssessments.createAcceptedFromQuiz({
      workspaceId: 'ws_1',
      quiz: repos.quizzes.get(source.quizId)!,
      logicalKey: 'bridge-assessment',
      title: 'Bridge assessment',
      targetLearningUnitId: 'unit_1',
      targetObjectiveId: 'objective_1',
      representation: 'recall',
      progressionContext: {
        quizId: source.quizId,
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        agendaId: 'agenda_1',
        agendaItemId: 'agenda_item_1',
        assessmentKind: 'formal_checkpoint',
        executionSourceManifestFingerprint: 'manifest-fp',
      },
    });
    const attempt = services.formalAssessments.startAttempt(version.id, 'ws_1');
    services.formalAssessments.submitAttempt(attempt.id, {
      [version.items[0]!.id]: repos.materials.getBlock('blk_1')!.content,
    });
    const criterionId = version.items[0]!.rubric![0]!.id;
    const grade = services.formalAssessments.recordGrade(
      GradeRecordSchema.parse({
        id: 'assessment_bridge_grade',
        attemptId: attempt.id,
        assessmentVersionId: version.id,
        grader: 'fake',
        rubricVersion: 'formal-short-answer-v1',
        status: 'current',
        judgment: {
          score: 1,
          criterionResults: [{ criterionId, result: 'met' }],
          feedback: 'supported',
        },
        supersedesId: null,
        createdAt: T3,
      }),
    );
    const evidence = services.formalAssessments.deriveEvidence(grade.id);
    expect(evidence).toHaveLength(1);
    const originalReconcile = services.formalProgression.reconcileAfterGrading;
    services.formalProgression.reconcileAfterGrading = (() => {
      throw new Error('injected projection failure');
    }) as typeof originalReconcile;
    const failed = services.formalAssessments.reconcileEvidence(evidence[0]!.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('injected projection failure');
    const bridgeResultsAfterFailure = db
      .prepare("SELECT COUNT(*) AS n FROM grading_results WHERE id LIKE 'bridge_grade_%'")
      .get() as { n: number };
    expect(bridgeResultsAfterFailure.n).toBe(1);

    services.formalProgression.reconcileAfterGrading = originalReconcile;
    const first = services.formalAssessments.reconcileEvidence(evidence[0]!.id);
    const replay = services.formalAssessments.reconcileEvidence(evidence[0]!.id);
    expect(first.status).toBe('applied');
    expect(replay).toEqual(first);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM grading_results WHERE id LIKE 'bridge_grade_%'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(repos.formalProgression.listEvidenceForWorkspace('ws_1')).toHaveLength(1);
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1')).toMatchObject(
      {
        state: 'complete',
        version: 1,
      },
    );
    const targetId = 'review-target:ws_1:objective_1';
    expect(repos.reviewSuccessor.listEvents(targetId)).toHaveLength(1);
    expect(repos.reviewSuccessor.listEvents(targetId)[0]).toMatchObject({
      kind: 'activation',
      rating: 'Good',
    });
  });

  it('keeps applied Formal state durable when scheduling fails and retries without regrading', async () => {
    const input = createAssessmentEvidence('scheduler_retry');
    const gradeCall = vi.spyOn(provider, 'gradeShortAnswer');
    db.exec(`
      CREATE TRIGGER inject_activation_failure
      BEFORE INSERT ON successor_review_events
      WHEN NEW.kind = 'activation'
      BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END;
    `);

    expect(() => services.formalAssessments.reconcileEvidence(input.evidence.id)).toThrow(
      /injected activation failure/,
    );
    expect(repos.formalAssessments.getReconciliationForGrade(input.grade.id)).toMatchObject({
      status: 'applied',
    });
    expect(repos.formalProgression.listEvidenceForWorkspace('ws_1')).toHaveLength(1);
    expect(repos.reviewSuccessor.listEvents('review-target:ws_1:objective_1')).toHaveLength(0);
    expect(repos.reviewSuccessor.getState('review-target:ws_1:objective_1')).toMatchObject({
      lifecycleState: 'pending_initial_review',
      lastReviewEventId: null,
    });

    db.exec('DROP TRIGGER inject_activation_failure');
    await services.learnerAssessments.submit(input.attempt.id, input.responses);
    expect(gradeCall).not.toHaveBeenCalled();
    expect(repos.formalAssessments.listGrades(input.attempt.id)).toHaveLength(1);
    expect(repos.reviewSuccessor.listEvents('review-target:ws_1:objective_1')).toHaveLength(1);
    expect(
      repos.reviewSuccessor
        .listBackfillAudits()
        .some((audit) => audit.evidenceId === input.evidence.id),
    ).toBe(false);
  });

  it('backfills eligible pre-cutover Evidence to null-memory pending state idempotently', () => {
    const beforeCutover = '2025-12-31T23:59:59.000Z';
    const input = createAssessmentEvidence('pre_cutover', beforeCutover);
    repos.review.upsert({
      workspaceId: 'ws_1',
      conceptId: 'con_1',
      conceptName: 'Legacy Review history',
      stability: 9,
      difficulty: 4,
      dueAt: T3,
      lastReviewedAt: T2,
      intervalDays: 9,
      reviewCount: 2,
      lapseCount: 1,
      lastRating: 'again',
      schedulerVersion: 'local-fsrs-v1',
      createdAt: T1,
      updatedAt: T2,
    });
    repos.review.insertEvent({
      id: 'legacy_review_event_pre_cutover',
      workspaceId: 'ws_1',
      conceptId: 'con_1',
      quizId: input.source.quizId,
      rating: 'easy',
      score: 1,
      intervalDays: 9,
      dueAt: T3,
      createdAt: T2,
    });
    const legacyBefore = {
      item: repos.review.get('ws_1', 'con_1'),
      events: repos.review.listEvents('ws_1', 'con_1'),
      mastery: repos.mastery.listByWorkspace('ws_1'),
    };

    expect(services.formalAssessments.reconcileEvidence(input.evidence.id).status).toBe('applied');
    expect(repos.reviewSuccessor.listTargets('ws_1')).toHaveLength(0);
    const first = services.reviewBackfill.run();
    const targetId = 'review-target:ws_1:objective_1';
    const firstState = repos.reviewSuccessor.getState(targetId);
    expect(first).toContainEqual(
      expect.objectContaining({
        evidenceId: input.evidence.id,
        outcome: 'created',
        reason: 'eligible_pending_created',
        reviewTargetId: targetId,
      }),
    );
    expect(firstState).toEqual(
      expect.objectContaining({
        lifecycleState: 'pending_initial_review',
        dueAt: '2026-01-01T00:00:00.000Z',
        lastReviewedAt: null,
        stability: null,
        difficulty: null,
        scheduledDays: null,
        repetitions: null,
        lapses: null,
        lastReviewEventId: null,
      }),
    );
    expect(repos.reviewSuccessor.listEvents(targetId)).toHaveLength(0);
    expect(services.reviewSuccessor.listCurrentProjection('ws_1')).toContainEqual(
      expect.objectContaining({
        reviewTargetId: targetId,
        objectiveId: 'objective_1',
        objectiveTitle: 'Explain capacity',
        conceptIds: ['con_1'],
        lifecycleState: 'pending_initial_review',
      }),
    );

    const restarted = createReviewBackfillService({
      repos,
      reviewSuccessor: services.reviewSuccessor,
    });
    const second = restarted.run();
    expect(second).toEqual(first);
    expect(repos.reviewSuccessor.listTargets('ws_1')).toHaveLength(1);
    expect(repos.reviewSuccessor.getState(targetId)).toEqual(firstState);
    expect(repos.reviewSuccessor.listEvents(targetId)).toHaveLength(0);
    expect(repos.review.get('ws_1', 'con_1')).toEqual(legacyBefore.item);
    expect(repos.review.listEvents('ws_1', 'con_1')).toEqual(legacyBefore.events);
    expect(repos.mastery.listByWorkspace('ws_1')).toEqual(legacyBefore.mastery);
  });

  it('audits ambiguous, unsupported, and unreconciled pre-cutover candidates without guessing', () => {
    const beforeCutover = '2025-12-31T23:59:59.000Z';
    const ambiguous = createAssessmentEvidence('ambiguous', beforeCutover);
    expect(services.formalAssessments.reconcileEvidence(ambiguous.evidence.id).status).toBe(
      'applied',
    );
    services.reviewSuccessor.ensureTarget({
      workspaceId: 'ws_1',
      courseId: 'ws_1',
      learningUnitId: 'unit_1',
      objectiveId: 'objective_1',
      contractVersionId: 'different-contract',
      curriculumVersionId: 'curriculum_1',
      manifestFingerprint: 'manifest-fp',
      at: '2026-01-01T00:00:00.000Z',
      pendingDueAt: '2026-01-01T00:00:00.000Z',
    });
    expect(services.reviewBackfill.run()).toContainEqual(
      expect.objectContaining({
        evidenceId: ambiguous.evidence.id,
        outcome: 'skipped',
        reason: 'ambiguous_existing_target',
        reviewTargetId: null,
      }),
    );

    const unsupported = createAssessmentEvidence('unsupported', beforeCutover);
    db.prepare("UPDATE assessment_evidence_records SET conclusion = 'partial' WHERE id = ?").run(
      unsupported.evidence.id,
    );
    const unreconciled = createAssessmentEvidence('unreconciled', beforeCutover);
    const audits = services.reviewBackfill.run();
    expect(audits).toContainEqual(
      expect.objectContaining({
        evidenceId: unsupported.evidence.id,
        outcome: 'skipped',
        reason: 'not_supported',
      }),
    );
    expect(audits).toContainEqual(
      expect.objectContaining({
        evidenceId: unreconciled.evidence.id,
        outcome: 'skipped',
        reason: 'reconciliation_not_applied',
      }),
    );
  });

  it('keeps tier-3 grading advisory and idempotently rejects progression', () => {
    const grade = insertGrade('advisory', 1);
    repos.formalProgression.insertQuestionContracts([
      FormalQuestionContractSchema.parse({
        id: 'formal_advisory',
        workspaceId: 'ws_1',
        quizId: grade.quizId,
        questionId: grade.questionId,
        studySessionId: null,
        agendaItemId: 'agenda_item_1',
        assessmentKind: 'formal_checkpoint',
        primaryObjectiveId: 'objective_1',
        scoredSecondaryObjectiveIds: [],
        curriculumLearningUnitId: 'unit_1',
        difficulty: 'medium',
        targetDepth: 'working_fluency',
        representation: 'recognition',
        admissibilityTier: 'tier_3_advisory',
        stableScopeFingerprint: 'scope-fp',
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        executionSourceManifestFingerprint: 'manifest-fp',
        provenance: [],
        limitations: ['Advisory only.'],
        createdAt: T3,
      }),
    ]);

    const first = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    const replay = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    expect(first.reconciliations[0]?.status).toBe('rejected');
    expect(replay.reconciliations[0]?.id).toBe(first.reconciliations[0]?.id);
    expect(repos.formalProgression.listEvidenceForGrading(grade.gradingResultId)).toHaveLength(1);
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1')).toMatchObject(
      {
        state: 'not_started',
        version: 0,
      },
    );
  });

  it('records tier-3 grading without mutating mastery, mistakes, or reviews', async () => {
    const quizId = 'quiz_advisory_submission';
    const questionId = 'question_advisory_submission';
    repos.quizzes.insert(
      makeQuiz({
        id: quizId,
        materialId: null,
        workspaceId: 'ws_1',
        kind: 'adaptive',
        assessmentMode: 'formal_checkpoint',
        questions: [makeQuestion({ id: questionId, quizId })],
      }),
    );
    repos.formalProgression.insertQuestionContracts([
      FormalQuestionContractSchema.parse({
        id: 'formal_advisory_submission',
        workspaceId: 'ws_1',
        quizId,
        questionId,
        studySessionId: null,
        agendaItemId: 'agenda_item_1',
        assessmentKind: 'formal_checkpoint',
        primaryObjectiveId: 'objective_1',
        scoredSecondaryObjectiveIds: [],
        curriculumLearningUnitId: 'unit_1',
        difficulty: 'medium',
        targetDepth: 'working_fluency',
        representation: 'recognition',
        admissibilityTier: 'tier_3_advisory',
        stableScopeFingerprint: 'scope-fp',
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        executionSourceManifestFingerprint: 'manifest-fp',
        provenance: [],
        limitations: ['Advisory only.'],
        createdAt: T3,
      }),
    ]);

    const outcome = await services.grading.grade(
      {
        quizId,
        answers: [{ questionId, type: 'single_choice', selectedOptionIds: ['A'] }],
      },
      {
        stateCreditResolver: () =>
          new Set(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId) ?? []),
      },
    );

    expect(outcome.stateChanges).toMatchObject({
      assessedConceptIds: [],
      mistakesCreated: 0,
      mistakesResolved: 0,
      misconceptionsProposed: 0,
      masteryChanges: [],
      reviewScheduled: [],
      recommendedNextStep: 'Advisory assessment recorded; formal learner state was not changed.',
    });
    expect(repos.submissions.getGradingResult(outcome.result.id)).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_states').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mistakes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_items').get()).toEqual({ n: 0 });
    const reconciled = services.formalProgression.reconcileAfterGrading(outcome.result.id)!;
    expect(reconciled.reconciliations[0]?.status).toBe('rejected');
  });

  it('rechecks premise authority after launch before grading can mutate state', async () => {
    const quizId = 'quiz_stale_authority';
    const questionId = 'question_stale_authority';
    const admittedPremise = repos.materials.getBlock('blk_1')!.content;
    repos.quizzes.insert(
      makeQuiz({
        id: quizId,
        materialId: null,
        workspaceId: 'ws_1',
        kind: 'adaptive',
        assessmentMode: 'formal_checkpoint',
        questions: [
          makeQuestion({
            id: questionId,
            quizId,
            type: 'short_answer',
            options: undefined,
            correctOptionIds: undefined,
            expectedAnswer: admittedPremise,
            rubric: { keyPoints: [{ text: admittedPremise, required: true }] },
            formalProposal: {
              objectiveRef: 'O1',
              premises: [
                {
                  premiseKey: 'source:0',
                  text: admittedPremise,
                  sourceRefs: ['blk_1'],
                  teachingSurfaceRefs: [],
                  learnerVisible: true,
                  scenarioLocal: false,
                  visibilityBasis: 'cited_source',
                },
              ],
              requiresExternalKnowledge: false,
              ambiguity: 'none',
              undefinedTerms: [],
              rubricSourceRefs: [{ text: admittedPremise, sourceRefs: ['blk_1'] }],
            },
          }),
        ],
      }),
    );
    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    expect(contracts[0]?.admissibilityTier).toBe('tier_1_authorized_truth');
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId)).toEqual([
      questionId,
    ]);
    db.prepare("UPDATE truth_authority_records SET validation_state = 'stale' WHERE id = ?").run(
      authorityId,
    );

    const outcome = await services.grading.grade(
      {
        quizId,
        answers: [{ questionId, type: 'short_answer', text: admittedPremise }],
      },
      {
        stateCreditResolver: () =>
          new Set(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId) ?? []),
      },
    );

    expect(outcome.stateChanges.assessedConceptIds).toEqual([]);
    const reconciled = services.formalProgression.reconcileAfterGrading(outcome.result.id)!;
    expect(reconciled.evidence[0]).toMatchObject({
      admissibilityTier: 'tier_1_authorized_truth',
      stateCreditable: false,
      limitations: ['Premise authority is no longer current; result is advisory only.'],
    });
    expect(reconciled.reconciliations[0]?.status).toBe('rejected');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_states').get()).toEqual({ n: 0 });
  });

  it('makes an admitted Formal question advisory when its exact Agenda item is cancelled before credit', async () => {
    const agenda = enableFirstRouteItemAsFormalCheckpoint();
    const quizId = 'quiz_cancelled_agenda_credit';
    const questionId = 'question_cancelled_agenda_credit';
    const admittedPremise = repos.materials.getBlock('blk_1')!.content;
    repos.quizzes.insert(
      makeQuiz({
        id: quizId,
        materialId: null,
        workspaceId: 'ws_1',
        kind: 'adaptive',
        assessmentMode: 'formal_checkpoint',
        questions: [
          makeQuestion({
            id: questionId,
            quizId,
            type: 'short_answer',
            options: undefined,
            correctOptionIds: undefined,
            expectedAnswer: admittedPremise,
            rubric: { keyPoints: [{ text: admittedPremise, required: true }] },
            formalProposal: {
              objectiveRef: 'O1',
              premises: [
                {
                  premiseKey: 'source:0',
                  text: admittedPremise,
                  sourceRefs: ['blk_1'],
                  teachingSurfaceRefs: [],
                  learnerVisible: true,
                  scenarioLocal: false,
                  visibilityBasis: 'cited_source',
                },
              ],
              requiresExternalKnowledge: false,
              ambiguity: 'none',
              undefinedTerms: [],
              rubricSourceRefs: [{ text: admittedPremise, sourceRefs: ['blk_1'] }],
            },
          }),
        ],
      }),
    );
    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId,
      agendaId: agenda.id,
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    expect(contracts[0]?.admissibilityTier).toBe('tier_1_authorized_truth');
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId)).toEqual([
      questionId,
    ]);

    const currentAgenda = repos.sessionAgendas.get(agenda.id)!;
    repos.sessionAgendas.update(
      {
        ...currentAgenda,
        version: currentAgenda.version + 1,
        items: currentAgenda.items.map((item) =>
          item.id === 'agenda_item_1' ? { ...item, state: 'cancelled' as const } : item,
        ),
        updatedAt: T4,
      },
      currentAgenda.version,
      {
        id: 'agenda_exact_formal_item_cancelled',
        eventType: 'exact_formal_item_cancelled',
        actor: 'local',
        payload: { agendaItemId: 'agenda_item_1' },
        createdAt: T4,
      },
    );
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId)).toEqual([]);

    const grading = await services.grading.grade(
      {
        quizId,
        answers: [{ questionId, type: 'short_answer', text: admittedPremise }],
      },
      {
        stateCreditResolver: () =>
          new Set(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId) ?? []),
      },
    );
    expect(grading.stateChanges).toMatchObject({
      assessedConceptIds: [],
      mistakesCreated: 0,
      mistakesResolved: 0,
      masteryChanges: [],
      reviewScheduled: [],
    });
    const reconciled = services.formalProgression.reconcileAfterGrading(grading.result.id)!;
    expect(reconciled.evidence).toEqual([
      expect.objectContaining({
        questionId,
        admissibilityTier: 'tier_1_authorized_truth',
        stateCreditable: false,
        limitations: [
          'Exact Agenda route authority is no longer current; result is advisory only.',
        ],
      }),
    ]);
    expect(reconciled.reconciliations[0]).toMatchObject({ status: 'rejected' });
    expect(reconciled.decisions).toEqual([]);
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1')).toMatchObject(
      {
        state: 'not_started',
        version: 0,
      },
    );
    expect(
      repos.studyPlans.listProgress('plan_1').find((item) => item.planItemId === 'plan_item_1'),
    ).toMatchObject({ state: 'not_started', version: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_states').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM progression_decisions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_outcomes').get()).toEqual({ n: 0 });
    expect(
      repos.sessionAgendas.get(agenda.id)!.items.find((item) => item.id === 'agenda_item_1')?.state,
    ).toBe('cancelled');
  });

  it('keeps an artifact-free objective advisory even when premise authority exists', () => {
    // `objective_synthesis_2` carries no semantic-support artifact and owns no row
    // in the append-only support table, so it is exactly the legacy teaching shape
    // the teaching-entry tier admits. Premise authority alone must not upgrade
    // the objective into Formal authority.
    const actions = installTwoUnitSynthesisRoute({ withSecondSemanticSupport: false });
    const secondObjective = repos.curricula
      .get('curriculum_1')!
      .nodes.find((node) => node.id === 'unit_2')!
      .learningUnit!.objectives.find((objective) => objective.id === actions.secondObjectiveId)!;
    expect(secondObjective.semanticSupport).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? AND objective_id = ?`,
        )
        .get('curriculum_1', actions.secondObjectiveId),
    ).toEqual({ n: 0 });

    const quizId = insertSynthesisQuiz(true);
    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.synthesisAgendaItemId,
      assessmentKind: 'synthesis',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const artifactFreeContract = contracts.find(
      (contract) => contract.primaryObjectiveId === actions.secondObjectiveId,
    )!;
    expect(artifactFreeContract.admissibilityTier).toBe('tier_3_advisory');
    expect(artifactFreeContract.limitations).toContain(
      'The resolved objective has no current passing semantic-authority support; result is advisory only.',
    );
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId)).toEqual([
      `${quizId}_q1`,
    ]);
  });

  it('revalidates semantic PASS at credit time after an authorized contract loses its sidecar', () => {
    const grade = insertGrade('semantic_credit_revalidation', 1);
    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    expect(contracts[0]?.admissibilityTier).toBe('tier_1_authorized_truth');
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(grade.quizId)).toEqual([
      grade.questionId,
    ]);

    removePrimarySemanticSupportForFixture();

    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(grade.quizId)).toEqual([]);
    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    expect(reconciled.evidence[0]).toMatchObject({
      admissibilityTier: 'tier_1_authorized_truth',
      stateCreditable: false,
    });
    expect(reconciled.reconciliations[0]?.status).toBe('rejected');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_states').get()).toEqual({ n: 0 });
  });

  it('refuses Formal Credit for a teachable artifact-free objective before any state mutation', () => {
    // Same artifact-free objective, but its premise authority goes stale after the
    // contract is registered. Credit must fail closed at credit time and no mastery
    // row may be written, proving the teaching tier grants no residual credit.
    const actions = installTwoUnitSynthesisRoute();
    const synthesis = insertSynthesisGrade(1);
    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: synthesis.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.synthesisAgendaItemId,
      assessmentKind: 'synthesis',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    expect(
      contracts.every((contract) => contract.admissibilityTier === 'tier_1_authorized_truth'),
    ).toBe(true);

    db.prepare("UPDATE truth_authority_records SET validation_state = 'stale'").run();

    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(synthesis.quizId)).toEqual(
      [],
    );
    const reconciled = services.formalProgression.reconcileAfterGrading(synthesis.gradingResultId)!;
    expect(
      reconciled.evidence.every(
        (evidence) =>
          evidence.admissibilityTier === 'tier_1_authorized_truth' &&
          evidence.stateCreditable === false,
      ),
    ).toBe(true);
    expect(reconciled.reconciliations.every((entry) => entry.status === 'rejected')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_states').get()).toEqual({ n: 0 });
  });

  it('applies eligible formal evidence once and preserves grading when a stale retry fails', () => {
    const grade = insertGrade('eligible', 1);
    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    expect(contracts[0]?.admissibilityTier).toBe('tier_1_authorized_truth');

    const first = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    const replay = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    expect(first.decisions[0]?.kind).toBe('complete');
    expect(replay.decisions[0]?.id).toBe(first.decisions[0]?.id);
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1')).toMatchObject(
      {
        state: 'complete',
        version: 1,
      },
    );
    expect(repos.studyPlans.listProgress('plan_1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planItemId: 'plan_item_1', state: 'completed' }),
        expect.objectContaining({ planItemId: 'plan_item_2', state: 'not_started' }),
      ]),
    );
    expect(repos.sessionAgendas.get('agenda_1')?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'agenda_item_1', state: 'completed' }),
        expect.objectContaining({ id: 'agenda_item_2', state: 'queued' }),
      ]),
    );

    expect(() =>
      services.formalProgression.reconcileCommand({
        command: command('stale_reconcile'),
        gradingResultId: grade.gradingResultId,
        expectedStudyPlanId: 'wrong_plan',
        expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      }),
    ).toThrow('stale');
    expect(repos.submissions.getGradingResult(grade.gradingResultId)?.id).toBe(
      grade.gradingResultId,
    );
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1').version).toBe(
      1,
    );
  });

  it('rejects achieved after a real defer and closes finished_with_gaps with the exact gap once', () => {
    const grade = insertGrade('goal_outcome_defer', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    services.formalProgression.reconcileAfterGrading(grade.gradingResultId);

    const execution = repos.courseExecution.get('ws_1');
    const session = services.studySessions.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: execution.version,
    }).session;
    expect(session.currentAgendaItemId).toBe('agenda_item_2');
    const deferred = services.studySessions.command('ws_1', session.id, {
      commandId: 'defer_goal_outcome_work',
      expectedSessionVersion: session.version,
      kind: 'defer',
      targetAgendaItemId: 'agenda_item_2',
      reason: 'Close the current goal without this accepted-route activity.',
    });
    const risk = repos.coverageRisks.list('ws_1', 'contract_1')[0]!;
    expect(deferred.agenda.items.find((item) => item.id === 'agenda_item_2')).toMatchObject({
      state: 'deferred',
    });
    expect(repos.studyPlans.listProgress('plan_1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planItemId: 'plan_item_1', state: 'completed' }),
        expect.objectContaining({ planItemId: 'plan_item_2', state: 'deferred' }),
      ]),
    );
    expect(risk).toMatchObject({
      status: 'deferred',
      facets: ['intentionally_deferred'],
      referencedCurriculumNodeIds: ['unit_1'],
    });

    const terminalOperation = repos.operations.createOrGet({
      id: 'goal_terminal_session_operation',
      workspaceId: 'ws_1',
      studySessionId: session.id,
      commandId: 'goal_terminal_session_operation_command',
      idempotencyKey: 'goal_terminal_session_operation_command',
      logicalOperationId: 'goal_terminal_session_operation_command',
      operationType: 'prepare_lesson_execution',
      expectedFingerprint: 'goal-terminal-session-operation-fingerprint',
      createdAt: T2,
      updatedAt: T2,
    }).operation;
    const terminalClaim = repos.operations.claim(terminalOperation.id, 'terminal-worker', T4, T2)!;
    repos.telemetry.insertLogicalCall({
      id: 'goal_terminal_logical_call',
      operationId: terminalOperation.id,
      workspaceId: 'ws_1',
      studySessionId: session.id,
      learningUnitId: null,
      assessmentId: null,
      operationType: 'prepare_lesson_execution',
      cacheKey: null,
      cacheStatus: 'not_checked',
      promptFingerprint: null,
      schemaFingerprint: 'goal-terminal-operation-v1',
      policyFingerprint: null,
      sourceFingerprint: 'manifest-fp',
      status: 'open',
      createdAt: T2,
      completedAt: null,
    });
    repos.telemetry.insertAttempt({
      id: 'goal_terminal_sent_attempt',
      logicalCallId: 'goal_terminal_logical_call',
      attemptNumber: 1,
      attemptKind: 'original',
      provider: 'fake',
      model: null,
      fencingToken: terminalClaim.fencingToken,
      status: 'sent',
      startedAt: T2,
      sentAt: T2,
      firstTokenAt: null,
      completedAt: null,
      latencyMs: null,
      timeToFirstTokenMs: null,
      errorCode: null,
      errorMessage: null,
    });
    const terminalSession = repos.studySessions.get(session.id)!;
    const terminalAgenda = repos.sessionAgendas.get('agenda_1')!;
    repos.studySessions.insertTurn({
      id: 'goal_terminal_running_turn',
      sessionId: session.id,
      seq: 0,
      commandId: 'goal_terminal_running_turn_command',
      status: 'running',
      contextManifest: {
        fingerprint: 'goal-terminal-turn-context',
        contractScopeFingerprint: 'goal-terminal-contract-scope',
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        sessionAgendaVersionId: `agenda_1:v${terminalAgenda.version}`,
        studySessionVersion: terminalSession.version,
        executionSourceManifestFingerprint: 'manifest-fp',
        transcriptWatermark: terminalSession.transcriptWatermark,
        sourceBlockRevisionIds: ['blk_1'],
        formalEvidenceIds: [],
        riskIds: [risk.id],
      },
      logicalCallId: 'goal_terminal_logical_call',
      errorMessage: null,
      createdAt: T2,
      completedAt: null,
    });
    repos.studySessions.insertTurnEvent({
      id: 'goal_terminal_running_turn_started',
      sessionId: session.id,
      turnId: 'goal_terminal_running_turn',
      seq: 0,
      kind: 'started',
      provisional: true,
      content: null,
      createdAt: T2,
    });

    const activeState = repos.courseExecution.get('ws_1');
    expect(() =>
      services.formalProgression.recordGoalOutcome({
        command: command('invalid_achieved_after_defer', 'learner'),
        expectedCourseExecutionVersion: activeState.version,
        expectedContractVersionId: 'contract_1',
        expectedCurriculumVersionId: 'curriculum_1',
        expectedStudyPlanVersionId: 'plan_1',
        expectedAgendaVersionId: 'agenda_1',
        status: 'achieved',
        unresolvedRiskIds: [],
        reason: 'Incorrectly claim unqualified achievement.',
      }),
    ).toThrow('required work remains incomplete or deferred');
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      acceptedPlanId: 'plan_1',
      activeAgendaId: 'agenda_1',
      executionStatus: 'active',
      version: activeState.version,
    });
    expect(repos.studyPlans.get('plan_1')?.status).toBe('accepted');
    expect(
      repos.sessionAgendas.get('agenda_1')?.items.find((item) => item.id === 'agenda_item_2'),
    ).toMatchObject({ state: 'deferred' });
    expect(repos.coverageRisks.get(risk.id)).toMatchObject({ status: 'deferred' });
    expect(repos.formalProgression.getGoalOutcomeForRoute('contract_1', 'plan_1')).toBeUndefined();

    expect(() =>
      services.formalProgression.recordGoalOutcome({
        command: command('invalid_unrelated_gap', 'learner'),
        expectedCourseExecutionVersion: activeState.version,
        expectedContractVersionId: 'contract_1',
        expectedCurriculumVersionId: 'curriculum_1',
        expectedStudyPlanVersionId: 'plan_1',
        expectedAgendaVersionId: 'agenda_1',
        status: 'finished_with_gaps',
        unresolvedRiskIds: ['missing_risk'],
        reason: 'Try to name a different gap.',
      }),
    ).toThrow('not found');

    const request = {
      command: command('finish_with_deferred_gap', 'learner'),
      expectedCourseExecutionVersion: activeState.version,
      expectedContractVersionId: 'contract_1',
      expectedCurriculumVersionId: 'curriculum_1',
      expectedStudyPlanVersionId: 'plan_1',
      expectedAgendaVersionId: 'agenda_1',
      status: 'finished_with_gaps' as const,
      unresolvedRiskIds: [risk.id],
      reason: 'Learner intentionally closes with the named deferred activity.',
    };
    const outcome = services.formalProgression.recordGoalOutcome(request);
    const replay = services.formalProgression.recordGoalOutcome(request);
    expect(replay).toEqual(outcome);
    expect(outcome).toMatchObject({
      status: 'finished_with_gaps',
      unresolvedRiskIds: [risk.id],
      reason: request.reason,
      actor: 'learner',
    });
    expect(repos.formalProgression.listGoalOutcomes('ws_1')).toEqual([outcome]);
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      acceptedPlanId: null,
      activeAgendaId: null,
      executionStatus: 'stopped',
      version: activeState.version + 1,
    });
    expect(repos.studyPlans.get('plan_1')?.status).toBe('closed');
    expect(repos.studySessions.get(session.id)?.status).toBe('abandoned');
    expect(repos.studySessions.getTurn('goal_terminal_running_turn')).toMatchObject({
      status: 'cancelled',
      errorMessage: expect.stringContaining('goal_terminal'),
      completedAt: T3,
    });
    expect(repos.studySessions.listTurnEvents('goal_terminal_running_turn')).toMatchObject([
      { kind: 'started' },
      { kind: 'cancelled', content: 'goal_terminal' },
    ]);
    expect(repos.telemetry.getLogicalCall('goal_terminal_logical_call')).toMatchObject({
      status: 'cancelled',
      completedAt: T3,
    });
    expect(repos.telemetry.getAttempt('goal_terminal_sent_attempt')).toMatchObject({
      status: 'outcome_unknown',
      errorCode: 'GOAL_TERMINAL',
      completedAt: T3,
    });
    expect(repos.operations.get(terminalOperation.id)).toMatchObject({
      status: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      fencingToken: terminalClaim.fencingToken,
    });
    expect(repos.operations.getResult(terminalOperation.id)).toMatchObject({
      fencingToken: terminalClaim.fencingToken,
      status: 'cancelled',
      payload: {
        reason: 'goal_terminal',
        outcomeId: outcome.id,
        outcomeStatus: 'finished_with_gaps',
      },
    });
    expect(repos.operations.listEvents(terminalOperation.id)).toMatchObject([
      {
        fencingToken: terminalClaim.fencingToken,
        kind: 'operation_interrupted',
        payload: {
          reason: 'goal_terminal',
          outcomeId: outcome.id,
          outcomeStatus: 'finished_with_gaps',
        },
      },
    ]);
    expect(
      repos.operations.finalize(
        {
          operationId: terminalOperation.id,
          status: 'completed',
          payload: { stale: true },
          createdAt: T3,
        },
        'terminal-worker',
        terminalClaim.fencingToken,
      ),
    ).toBe(false);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM course_execution_events
           WHERE workspace_id = ? AND event_type = 'goal_terminal'`,
          )
          .get('ws_1') as { n: number }
      ).n,
    ).toBe(1);
  });

  it('records legitimate achieved only after every required accepted-route item is complete', () => {
    enableRouteItemsAsFormalCheckpoints([
      { planItemId: 'plan_item_1', agendaItemId: 'agenda_item_1' },
      { planItemId: 'plan_item_2', agendaItemId: 'agenda_item_2' },
    ]);
    seedPresentedTeachingFixture({
      db,
      repos,
      workspaceId: 'ws_1',
      curriculum: repos.curricula.get('curriculum_1')!,
      studyPlanVersionId: 'plan_1',
      learningUnitId: 'unit_1',
      objectiveIds: ['objective_2'],
      sessionAgendaId: 'agenda_1',
      agendaItemId: 'agenda_item_2',
      studyPlanItemId: 'plan_item_2',
      at: T3,
      suffix: 'goal_achieved_objective_2',
    });
    for (const [suffix, agendaItemId] of [
      ['goal_achieved_first', 'agenda_item_1'],
      ['goal_achieved_second', 'agenda_item_2'],
    ] as const) {
      const grade = insertGrade(suffix, 1);
      services.formalProgression.registerAssessmentContracts({
        workspaceId: 'ws_1',
        quizId: grade.quizId,
        agendaId: 'agenda_1',
        agendaItemId,
        assessmentKind: 'formal_checkpoint',
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        executionSourceManifestFingerprint: 'manifest-fp',
      });
      services.formalProgression.reconcileAfterGrading(grade.gradingResultId);
    }
    expect(repos.studyPlans.listProgress('plan_1').map((item) => item.state)).toEqual([
      'completed',
      'completed',
    ]);
    expect(repos.sessionAgendas.get('agenda_1')?.items.map((item) => item.state)).toEqual([
      'completed',
      'completed',
    ]);

    const state = repos.courseExecution.get('ws_1');
    const request = {
      command: command('legitimate_achieved', 'learner'),
      expectedCourseExecutionVersion: state.version,
      expectedContractVersionId: 'contract_1',
      expectedCurriculumVersionId: 'curriculum_1',
      expectedStudyPlanVersionId: 'plan_1',
      expectedAgendaVersionId: 'agenda_1',
      status: 'achieved' as const,
      unresolvedRiskIds: [],
      reason: 'All required accepted-route work is complete.',
    };
    const outcome = services.formalProgression.recordGoalOutcome(request);
    expect(services.formalProgression.recordGoalOutcome(request)).toEqual(outcome);
    expect(outcome).toMatchObject({ status: 'achieved', unresolvedRiskIds: [] });
    expect(repos.formalProgression.listGoalOutcomes('ws_1')).toHaveLength(1);
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      acceptedPlanId: null,
      executionStatus: 'stopped',
      version: state.version + 1,
    });
  });

  it('projects completion only to the executed checkpoint among same-unit actions', () => {
    const actions = installSameUnitFormalActions();
    const grade = insertGrade('scoped_checkpoint_projection', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.checkpointAgendaItemId,
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;

    expect(reconciled.decisions[0]?.kind).toBe('complete');
    const progress = new Map(
      repos.studyPlans.listProgress('plan_1').map((item) => [item.planItemId, item.state]),
    );
    expect(progress.get('plan_checkpoint')).toBe('completed');
    expect(progress.get('plan_item_1')).toBe('not_started');
    expect(progress.get('plan_synthesis')).toBe('not_started');
    expect(progress.get('plan_repair')).toBe('not_started');

    const agenda = repos.sessionAgendas.get(actions.agenda.id)!;
    expect(agenda.items.find((item) => item.id === actions.checkpointAgendaItemId)?.state).toBe(
      'completed',
    );
    expect(agenda.items.find((item) => item.id === 'agenda_item_1')?.state).toBe('queued');
    expect(agenda.items.find((item) => item.id === actions.synthesisAgendaItemId)?.state).toBe(
      'queued',
    );
    expect(agenda.items.find((item) => item.id === actions.repairAgendaItemId)?.state).toBe(
      'queued',
    );
  });

  it('makes a later ordinary failure actionable without erasing prior completion evidence', () => {
    const actions = installSameUnitFormalActions();
    const passed = insertGrade('ordinary_pass_before_failure', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: passed.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.checkpointAgendaItemId,
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const completed = services.formalProgression.reconcileAfterGrading(passed.gradingResultId)!;
    expect(completed.decisions[0]?.kind).toBe('complete');

    const failed = insertGrade('ordinary_failure_after_pass', 0);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: failed.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.laterCheckpointAgendaItemId,
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const reconciled = services.formalProgression.reconcileAfterGrading(failed.gradingResultId)!;

    expect(reconciled.decisions[0]).toMatchObject({
      kind: 'targeted_repair',
      priorState: 'complete',
      nextState: 'complete',
      reasonCodes: ['prior_completion_preserved'],
    });
    expect(reconciled.decisions[0]?.evidenceIds).toEqual(
      expect.arrayContaining([completed.evidence[0]!.id, reconciled.evidence[0]!.id]),
    );
    expect(repos.formalProgression.listEvidenceForWorkspace('ws_1')).toHaveLength(2);
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1')).toMatchObject(
      { state: 'complete', version: 2 },
    );
    expect(
      repos.studyPlans
        .listProgress('plan_1')
        .find((item) => item.planItemId === 'plan_checkpoint_later'),
    ).toMatchObject({ state: 'repair_needed' });
    const agenda = repos.sessionAgendas.get(actions.agenda.id)!;
    expect(
      agenda.items.find((item) => item.id === actions.laterCheckpointAgendaItemId),
    ).toMatchObject({ state: 'blocked' });
    expect(agenda.currentItemId).toBe(actions.repairAgendaItemId);

    const sideEffectsBeforeReplay = {
      decisions: (
        db.prepare('SELECT COUNT(*) AS n FROM progression_decisions').get() as { n: number }
      ).n,
      evidence: (
        db.prepare('SELECT COUNT(*) AS n FROM formal_evidence_records').get() as { n: number }
      ).n,
      agendaItems: repos.sessionAgendas.get(actions.agenda.id)!.items.length,
    };
    const replay = services.formalProgression.reconcileAfterGrading(failed.gradingResultId)!;
    expect(replay.decisions[0]?.id).toBe(reconciled.decisions[0]?.id);
    expect({
      decisions: (
        db.prepare('SELECT COUNT(*) AS n FROM progression_decisions').get() as { n: number }
      ).n,
      evidence: (
        db.prepare('SELECT COUNT(*) AS n FROM formal_evidence_records').get() as { n: number }
      ).n,
      agendaItems: repos.sessionAgendas.get(actions.agenda.id)!.items.length,
    }).toEqual(sideEffectsBeforeReplay);
  });

  it('keeps required repair queued and marks only failed synthesis work repair-needed', () => {
    const actions = installTwoUnitSynthesisRoute();
    const checkpoint = insertGrade('projection_checkpoint_pass', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: checkpoint.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.checkpointAgendaItemId,
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    services.formalProgression.reconcileAfterGrading(checkpoint.gradingResultId);

    const afterCheckpoint = repos.sessionAgendas.get(actions.agenda.id)!;
    repos.sessionAgendas.update(
      {
        ...afterCheckpoint,
        version: afterCheckpoint.version + 1,
        currentItemId: actions.synthesisAgendaItemId,
        updatedAt: T3,
      },
      afterCheckpoint.version,
      {
        id: 'agenda_start_synthesis',
        eventType: 'synthesis_started',
        actor: 'local',
        payload: {},
        createdAt: T3,
      },
    );
    const synthesis = insertSynthesisGrade(0);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: synthesis.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.synthesisAgendaItemId,
      assessmentKind: 'synthesis',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    const reconciled = services.formalProgression.reconcileAfterGrading(synthesis.gradingResultId)!;

    expect(reconciled.decisions[0]).toMatchObject({
      kind: 'targeted_repair',
      priorState: 'complete',
      nextState: 'complete',
    });
    const progress = new Map(
      repos.studyPlans.listProgress('plan_1').map((item) => [item.planItemId, item.state]),
    );
    expect(progress.get('plan_checkpoint')).toBe('completed');
    expect(progress.get('plan_synthesis')).toBe('repair_needed');
    expect(progress.get('plan_repair')).toBe('not_started');
    expect(progress.get('plan_item_1')).toBe('not_started');

    const agenda = repos.sessionAgendas.get(actions.agenda.id)!;
    expect(agenda.items.find((item) => item.id === actions.synthesisAgendaItemId)?.state).toBe(
      'blocked',
    );
    expect(agenda.items.find((item) => item.id === actions.repairAgendaItemId)?.state).toBe(
      'queued',
    );
    expect(agenda.currentItemId).toBe(actions.repairAgendaItemId);
  });

  it('attributes a broad synthesis to one objective in each covered Curriculum unit', () => {
    const actions = installTwoUnitSynthesisRoute();
    const quizId = insertSynthesisQuiz(true);

    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.synthesisAgendaItemId,
      assessmentKind: 'synthesis',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts).toHaveLength(2);
    expect(contracts.map((contract) => contract.curriculumLearningUnitId)).toEqual([
      'unit_1',
      'unit_2',
    ]);
    expect(contracts.map((contract) => contract.primaryObjectiveId)).toEqual([
      'objective_1',
      actions.secondObjectiveId,
    ]);
    expect(
      contracts.every((contract) => contract.admissibilityTier === 'tier_1_authorized_truth'),
    ).toBe(true);
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId)).toEqual([
      `${quizId}_q1`,
      `${quizId}_q2`,
    ]);
  });

  it('keeps a one-unit synthesis advisory even when its premise is authoritative', () => {
    const actions = installTwoUnitSynthesisRoute();
    const quizId = insertSynthesisQuiz(false);

    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.synthesisAgendaItemId,
      assessmentKind: 'synthesis',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts[0]).toMatchObject({
      admissibilityTier: 'tier_3_advisory',
      limitations: [expect.stringContaining('at least two Curriculum LearningUnits')],
    });
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId)).toEqual([]);
  });

  it('does not complete a unit while a separate blocking objective is unassessed', () => {
    const plan = repos.studyPlans.get('plan_1')!;
    const firstItem = plan.items[0]!;
    const guardedPlan = {
      ...plan,
      items: plan.items.map((item) =>
        item.id === firstItem.id
          ? {
              ...item,
              completionRequirements: [
                ...item.completionRequirements,
                {
                  id: 'requirement_objective_2_guard',
                  objectiveIds: ['objective_2'],
                  description: 'Verify the capacity-identification objective.',
                  blocking: true,
                  admissibilityTier: 'tier_1_authorized_truth' as const,
                },
              ],
            }
          : item,
      ),
    };
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify(guardedPlan),
      plan.id,
    );

    const grade = insertGrade('missing_blocking_objective', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    expect(reconciled.decisions[0]).toMatchObject({
      kind: 'continue',
      nextState: 'in_progress',
      reasonCodes: ['blocking_objective_evidence_missing'],
    });
  });

  it('evaluates a missing exact Formal objective before assessment generation and reuses the persisted PASS', async () => {
    const actions = installSameUnitFormalActions();
    removePrimarySemanticSupportForFixture();
    expect(
      repos.curricula
        .get('curriculum_1')!
        .nodes.flatMap((node) => node.learningUnit?.objectives ?? [])
        .find((objective) => objective.id === 'objective_1')?.semanticSupport,
    ).toBeUndefined();

    const callOrder: string[] = [];
    const evaluationCall = vi
      .spyOn(provider, 'evaluateObjectiveAuthoritySupport')
      .mockImplementation(async (input, options) => {
        callOrder.push('semantic_evaluation');
        const candidate = {
          schemaVersion: 2 as const,
          evaluations: input.objectives.map((objective) => ({
            objectiveRef: objective.objectiveRef,
            subjectDependency: 'source_specific_required' as const,
            subjectDependencyRationale:
              'The exact source-specific proposition requires the offered source authority.',
            candidateLabels: objective.candidates.map((candidateEvidence) => ({
              evidenceRef: candidateEvidence.evidenceRef,
              relation: 'relevant' as const,
            })),
            supportGroups: [
              {
                evidenceRefs: [objective.candidates[0]!.evidenceRef],
                supportType: 'relationship' as const,
                rationale: 'The exact source relationship supports the complete proposition.',
              },
            ],
          })),
        };
        const validation = options?.validateCandidate?.(candidate);
        if (validation && !validation.valid) {
          throw ProviderError.invalidOutput(validation.diagnostics.join('; '), 'candidate');
        }
        return candidate;
      });
    const proposeAssessment = provider.proposeAssessment.bind(provider);
    const assessmentCall = vi
      .spyOn(provider, 'proposeAssessment')
      .mockImplementation(async (input, options) => {
        callOrder.push('assessment_generation');
        return proposeAssessment(input, options);
      });
    const firstRequest = {
      command: command('launch_on_demand_semantic_pass', 'learner'),
      agendaId: actions.agenda.id,
      expectedAgendaVersion: actions.agenda.version,
      agendaItemId: actions.checkpointAgendaItemId,
      expectedContractId: 'contract_1',
      expectedStudyPlanId: 'plan_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
    };

    const first = await services.courseActionLaunch.launch(firstRequest);
    expect(first.kind).toBe('assessment');
    expect(callOrder).toEqual(['semantic_evaluation', 'assessment_generation']);
    expect(evaluationCall).toHaveBeenCalledTimes(1);
    expect(evaluationCall.mock.calls[0]?.[0].objectives).toHaveLength(1);
    expect(assessmentCall).toHaveBeenCalledTimes(1);
    expect(
      repos.curricula
        .get('curriculum_1')!
        .nodes.flatMap((node) => node.learningUnit?.objectives ?? [])
        .find((objective) => objective.id === 'objective_1')?.semanticSupport,
    ).toMatchObject({ objectiveId: 'objective_1', verdict: 'pass', provider: 'fake' });
    expect(
      db
        .prepare(
          `SELECT status FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? AND objective_id = ?`,
        )
        .get('curriculum_1', 'objective_1'),
    ).toEqual({ status: 'pass' });

    await expect(services.courseActionLaunch.launch(firstRequest)).resolves.toEqual(first);
    const second = await services.courseActionLaunch.launch({
      ...firstRequest,
      command: command('launch_reused_semantic_pass', 'learner'),
      agendaItemId: actions.laterCheckpointAgendaItemId,
    });
    expect(second.kind).toBe('assessment');
    expect(evaluationCall).toHaveBeenCalledTimes(1);
    expect(assessmentCall).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual([
      'semantic_evaluation',
      'assessment_generation',
      'assessment_generation',
    ]);
  });

  it('persists a validated semantic FAIL and refuses later Formal launches without assessment generation', async () => {
    const actions = installSameUnitFormalActions();
    removePrimarySemanticSupportForFixture();
    const evaluationCall = vi
      .spyOn(provider, 'evaluateObjectiveAuthoritySupport')
      .mockImplementation(async (input, options) => {
        const candidate = {
          schemaVersion: 2 as const,
          evaluations: input.objectives.map((objective) => ({
            objectiveRef: objective.objectiveRef,
            subjectDependency: 'source_specific_required' as const,
            subjectDependencyRationale:
              'The exact source-specific proposition was not supported by the offered evidence.',
            candidateLabels: objective.candidates.map((candidateEvidence) => ({
              evidenceRef: candidateEvidence.evidenceRef,
              relation: 'unrelated' as const,
            })),
            supportGroups: [],
          })),
        };
        const validation = options?.validateCandidate?.(candidate);
        if (validation && !validation.valid) {
          throw ProviderError.invalidOutput(validation.diagnostics.join('; '), 'candidate');
        }
        return candidate;
      });
    const assessmentCall = vi.spyOn(provider, 'proposeAssessment');
    const request = {
      agendaId: actions.agenda.id,
      expectedAgendaVersion: actions.agenda.version,
      agendaItemId: actions.checkpointAgendaItemId,
      expectedContractId: 'contract_1',
      expectedStudyPlanId: 'plan_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
    };

    await expect(
      services.courseActionLaunch.launch({
        command: command('launch_on_demand_semantic_fail', 'learner'),
        ...request,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        boundary: 'formal_provider',
        diagnosticCodes: expect.arrayContaining(['semantic_support_failed']),
      }),
    });
    expect(evaluationCall).toHaveBeenCalledTimes(1);
    expect(assessmentCall).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT status FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? AND objective_id = ?`,
        )
        .get('curriculum_1', 'objective_1'),
    ).toEqual({ status: 'fail' });

    await expect(
      services.courseActionLaunch.launch({
        command: command('launch_existing_semantic_fail', 'learner'),
        ...request,
        agendaItemId: actions.laterCheckpointAgendaItemId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(evaluationCall).toHaveBeenCalledTimes(1);
    expect(assessmentCall).not.toHaveBeenCalled();
  });

  it('refuses admission and persists no authoritative question when semantic PASS disappears during provider work', async () => {
    const agenda = enableFirstRouteItemAsFormalCheckpoint();
    const proposeAssessment = provider.proposeAssessment.bind(provider);
    const assessmentCall = vi
      .spyOn(provider, 'proposeAssessment')
      .mockImplementation(async (input, options) => {
        const proposal = await proposeAssessment(input, options);
        removePrimarySemanticSupportForFixture();
        return proposal;
      });
    const countsBefore = {
      quizzes: (db.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number }).n,
      questions: (db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n,
      contracts: (
        db.prepare('SELECT COUNT(*) AS n FROM formal_question_contracts').get() as { n: number }
      ).n,
    };

    await expect(
      services.courseActionLaunch.launch({
        command: command('launch_semantic_admission_fence', 'learner'),
        agendaId: agenda.id,
        expectedAgendaVersion: agenda.version,
        agendaItemId: 'agenda_item_1',
        expectedContractId: 'contract_1',
        expectedStudyPlanId: 'plan_1',
        expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        boundary: 'formal_admission',
        diagnosticCodes: expect.arrayContaining(['semantic_support_missing']),
      }),
    });

    expect(assessmentCall).toHaveBeenCalledTimes(1);
    expect(
      repos.curricula.get('curriculum_1')!.nodes[1]!.learningUnit!.objectives[0]!.semanticSupport,
    ).toBeUndefined();
    expect({
      quizzes: (db.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number }).n,
      questions: (db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n,
      contracts: (
        db.prepare('SELECT COUNT(*) AS n FROM formal_question_contracts').get() as { n: number }
      ).n,
    }).toEqual(countsBefore);
  });

  it('cancels on-demand semantic evaluation without persisting authority or calling the assessment provider', async () => {
    const actions = installSameUnitFormalActions();
    removePrimarySemanticSupportForFixture();
    const controller = new AbortController();
    const evaluationCall = vi
      .spyOn(provider, 'evaluateObjectiveAuthoritySupport')
      .mockImplementation(async (input, options) => {
        const candidate = {
          schemaVersion: 2 as const,
          evaluations: input.objectives.map((objective) => ({
            objectiveRef: objective.objectiveRef,
            subjectDependency: 'source_specific_required' as const,
            subjectDependencyRationale: 'The exact source-specific proposition requires evidence.',
            candidateLabels: objective.candidates.map((candidateEvidence) => ({
              evidenceRef: candidateEvidence.evidenceRef,
              relation: 'relevant' as const,
            })),
            supportGroups: [
              {
                evidenceRefs: [objective.candidates[0]!.evidenceRef],
                supportType: 'relationship' as const,
                rationale: 'The exact relationship supports the complete proposition.',
              },
            ],
          })),
        };
        controller.abort();
        options?.validateCandidate?.(candidate);
        return candidate;
      });
    const assessmentCall = vi.spyOn(provider, 'proposeAssessment');

    await expect(
      services.courseActionLaunch.launch(
        {
          command: command('launch_cancelled_semantic_evaluation', 'learner'),
          agendaId: actions.agenda.id,
          expectedAgendaVersion: actions.agenda.version,
          agendaItemId: actions.checkpointAgendaItemId,
          expectedContractId: 'contract_1',
          expectedStudyPlanId: 'plan_1',
          expectedExecutionSourceManifestFingerprint: 'manifest-fp',
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(evaluationCall).toHaveBeenCalledTimes(1);
    expect(assessmentCall).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? AND objective_id = ?`,
        )
        .get('curriculum_1', 'objective_1'),
    ).toEqual({ n: 0 });
  });

  it('launches a session-bound formal checkpoint through tracked Agent telemetry', async () => {
    const plan = repos.studyPlans.get('plan_1')!;
    const checkpointPlan = {
      ...plan,
      items: plan.items.map((item) =>
        item.id === 'plan_item_1' ? { ...item, kind: 'formal_checkpoint' as const } : item,
      ),
    };
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify(checkpointPlan),
      plan.id,
    );
    const agenda = repos.sessionAgendas.get('agenda_1')!;
    const checkpointAgenda = repos.sessionAgendas.update(
      {
        ...agenda,
        version: agenda.version + 1,
        items: agenda.items.map((item) =>
          item.id === 'agenda_item_1'
            ? {
                ...item,
                kind: 'formal_checkpoint' as const,
                launch: {
                  status: 'launchable' as const,
                  capability: 'assessment' as const,
                  resourceId: null,
                  reason: null,
                },
              }
            : item,
        ),
        updatedAt: T3,
      },
      agenda.version,
      {
        id: 'agenda_checkpoint_enabled',
        eventType: 'test_checkpoint_enabled',
        actor: 'local',
        payload: {},
        createdAt: T3,
      },
    );
    const execution = repos.courseExecution.get('ws_1');
    const { session } = services.studySessions.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: checkpointAgenda.id,
      expectedCourseExecutionVersion: execution.version,
    });
    repos.workspaces.insert(makeWorkspace({ id: 'ws_other', name: 'Other course' }));
    // Bypass the repository's route-coherence guard to exercise the service's
    // cross-workspace ownership boundary against an otherwise resolvable ID.
    db.prepare(
      `INSERT INTO study_sessions
         (id, workspace_id, contract_id, curriculum_id, plan_id, agenda_id,
          manifest_fingerprint, version, status, route_state, current_agenda_item_id,
          route_stack, transcript_watermark, created_at, updated_at)
       SELECT ?, ?, contract_id, curriculum_id, plan_id, agenda_id,
          manifest_fingerprint, version, status, route_state, current_agenda_item_id,
          route_stack, transcript_watermark, created_at, updated_at
       FROM study_sessions WHERE id = ?`,
    ).run('study_session_other_workspace', 'ws_other', session.id);
    const crossWorkspaceSession = repos.studySessions.get('study_session_other_workspace')!;
    for (const [commandId, studySessionId] of [
      ['launch_unknown_session', 'study_session_missing'],
      ['launch_cross_workspace_session', crossWorkspaceSession.id],
    ] as const) {
      await expect(
        services.courseActionLaunch.launch({
          command: command(commandId, 'learner'),
          agendaId: checkpointAgenda.id,
          expectedAgendaVersion: checkpointAgenda.version,
          agendaItemId: 'agenda_item_1',
          expectedContractId: 'contract_1',
          expectedStudyPlanId: 'plan_1',
          expectedExecutionSourceManifestFingerprint: 'manifest-fp',
          studySessionId,
        }),
      ).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        message: 'StudySession launch context is stale.',
      });
      const failedOperation = repos.operations.getByIdempotencyKey('ws_1', commandId)!;
      expect(failedOperation).toMatchObject({ status: 'failed' });
      expect(
        db
          .prepare('SELECT study_session_id AS studySessionId FROM agent_operations WHERE id = ?')
          .get(failedOperation.id),
      ).toEqual({ studySessionId: null });
    }

    const proposalCall = vi.spyOn(provider, 'proposeAssessment');
    const launched = await services.courseActionLaunch.launch({
      command: command('launch_tracked_checkpoint', 'learner'),
      agendaId: checkpointAgenda.id,
      expectedAgendaVersion: checkpointAgenda.version,
      agendaItemId: 'agenda_item_1',
      expectedContractId: 'contract_1',
      expectedStudyPlanId: 'plan_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      studySessionId: session.id,
    });

    expect(launched.kind).toBe('assessment');
    if (launched.kind !== 'assessment') throw new Error('Expected a formal assessment.');
    expect(proposalCall).toHaveBeenCalledTimes(1);
    expect(proposalCall.mock.calls[0]?.[0]).toMatchObject({
      requiredRepresentation: null,
      requestedChallengeFamily: null,
      objectiveCatalogue: [
        {
          objectiveRef: 'O1',
          title: 'Explain capacity',
        },
      ],
      teachingSurfaceCatalogue: [
        expect.objectContaining({
          teachingSurfaceRef: 'T1',
          objectiveRefs: ['O1'],
          surfaceKind: 'explanation',
        }),
      ],
    });
    const providerCatalogue = JSON.stringify({
      objectives: proposalCall.mock.calls[0]?.[0].objectiveCatalogue,
      surfaces: proposalCall.mock.calls[0]?.[0].teachingSurfaceCatalogue,
    });
    expect(providerCatalogue).not.toContain('objective_1');
    expect(providerCatalogue).not.toContain('accepted_lesson');
    expect(providerCatalogue).not.toContain('brief_taught');
    expect(providerCatalogue).not.toContain('source-context');
    expect(providerCatalogue).not.toContain('sha256:');
    const formalVersion = repos.formalAssessments.getVersion(launched.formalAssessmentVersionId!)!;
    expect(
      repos.formalAssessments.getItemIntent(formalVersion.id, formalVersion.items[0]!.id),
    ).toMatchObject({
      assessmentStage: 'formal_checkpoint',
      requestedChallengeFamily: null,
      requestedRepresentation: null,
      selectionReason: 'ordinary_formal_check',
    });
    const launchOperation = repos.operations.getByIdempotencyKey(
      'ws_1',
      'launch_tracked_checkpoint',
    )!;
    expect(
      db
        .prepare('SELECT study_session_id AS studySessionId FROM agent_operations WHERE id = ?')
        .get(launchOperation.id),
    ).toEqual({ studySessionId: session.id });
    expect(repos.formalProgression.listQuestionContractsForQuiz(launched.quiz.id)[0]).toMatchObject(
      { studySessionId: session.id, admissibilityTier: 'tier_1_authorized_truth' },
    );
    expect(
      repos.telemetry.usageSummaryForScope('ws_1', {
        scopeType: 'session',
        scopeKey: session.id,
      }),
    ).toMatchObject({ logicalCalls: 1, physicalAttempts: 1 });

    const storedQuiz = repos.quizzes.get(launched.quiz.id)!;
    const grading = await services.grading.grade(
      {
        quizId: storedQuiz.id,
        answers: storedQuiz.questions.map((question) => ({
          questionId: question.id,
          type: 'short_answer' as const,
          text: question.expectedAnswer!,
        })),
      },
      {
        stateCreditResolver: () =>
          new Set(services.formalProgression.stateCreditingQuestionIdsForQuiz(storedQuiz.id) ?? []),
      },
    );
    const progression = services.formalProgression.reconcileAfterGrading(grading.result.id)!;
    expect(progression.evidence.every((evidence) => evidence.stateCreditable)).toBe(true);
    expect(progression.decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'complete' })]),
    );
  });

  it('launches and credits both objectives of a multi-objective item through FakeProvider aliases', async () => {
    const secondConcept = makeConcept({ id: 'con_2', name: 'Capacity identification' });
    repos.materials.replaceConcepts('mat_1', [makeConcept(), secondConcept]);
    const curriculum = repos.curricula.get('curriculum_1')!;
    db.prepare('UPDATE curriculum_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        ...curriculum,
        nodes: curriculum.nodes.map((node) =>
          node.id === 'unit_1' && node.learningUnit
            ? {
                ...node,
                learningUnit: {
                  ...node.learningUnit,
                  conceptIds: ['con_1', 'con_2'],
                },
              }
            : node,
        ),
      }),
      curriculum.id,
    );
    const plan = repos.studyPlans.get('plan_1')!;
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        ...plan,
        items: plan.items.map((item) =>
          item.id === 'plan_item_1'
            ? {
                ...item,
                kind: 'formal_checkpoint' as const,
                objectiveIds: ['objective_1', 'objective_2'],
              }
            : item,
        ),
      }),
      plan.id,
    );
    seedPresentedTeachingFixture({
      db,
      repos,
      workspaceId: 'ws_1',
      curriculum: repos.curricula.get('curriculum_1')!,
      studyPlanVersionId: 'plan_1',
      learningUnitId: 'unit_1',
      objectiveIds: ['objective_2'],
      sessionAgendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      studyPlanItemId: 'plan_item_1',
      at: T3,
      suffix: 'fake_e2e_multi_objective_2',
    });
    const checkpointAgenda = enableFirstRouteItemAsFormalCheckpoint();
    const proposalCall = vi.spyOn(provider, 'proposeAssessment');

    const launched = await services.courseActionLaunch.launch({
      command: command('launch_fake_multi_objective_checkpoint', 'learner'),
      agendaId: checkpointAgenda.id,
      expectedAgendaVersion: checkpointAgenda.version,
      agendaItemId: 'agenda_item_1',
      expectedContractId: 'contract_1',
      expectedStudyPlanId: 'plan_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(launched.kind).toBe('assessment');
    if (launched.kind !== 'assessment') throw new Error('Expected a formal assessment.');
    expect(proposalCall).toHaveBeenCalledTimes(1);
    expect(
      proposalCall.mock.calls[0]?.[0].objectiveCatalogue?.map((item) => item.objectiveRef),
    ).toEqual(['O1', 'O2']);
    const contracts = repos.formalProgression.listQuestionContractsForQuiz(launched.quiz.id);
    expect(contracts.map((contract) => contract.primaryObjectiveId).sort()).toEqual([
      'objective_1',
      'objective_2',
    ]);
    expect(
      contracts.every((contract) => contract.admissibilityTier === 'tier_1_authorized_truth'),
    ).toBe(true);

    const storedQuiz = repos.quizzes.get(launched.quiz.id)!;
    const grading = await services.grading.grade(
      {
        quizId: storedQuiz.id,
        answers: storedQuiz.questions.map((question) => ({
          questionId: question.id,
          type: 'short_answer' as const,
          text: question.expectedAnswer!,
        })),
      },
      {
        stateCreditResolver: () =>
          new Set(services.formalProgression.stateCreditingQuestionIdsForQuiz(storedQuiz.id) ?? []),
      },
    );
    const reconciled = services.formalProgression.reconcileAfterGrading(grading.result.id)!;
    expect(reconciled.evidence).toHaveLength(2);
    expect(reconciled.evidence.every((evidence) => evidence.stateCreditable)).toBe(true);
  });

  it('keeps every FakeProvider item advisory when the Lesson was skipped', async () => {
    db.prepare('DELETE FROM lesson_execution_states').run();
    const checkpointAgenda = enableFirstRouteItemAsFormalCheckpoint();

    const launched = await services.courseActionLaunch.launch({
      command: command('launch_fake_skipped_lesson_checkpoint', 'learner'),
      agendaId: checkpointAgenda.id,
      expectedAgendaVersion: checkpointAgenda.version,
      agendaItemId: 'agenda_item_1',
      expectedContractId: 'contract_1',
      expectedStudyPlanId: 'plan_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(launched.kind).toBe('assessment');
    if (launched.kind !== 'assessment') throw new Error('Expected a formal assessment.');
    const contracts = repos.formalProgression.listQuestionContractsForQuiz(launched.quiz.id);
    expect(contracts).not.toHaveLength(0);
    expect(contracts.every((contract) => contract.admissibilityTier === 'tier_3_advisory')).toBe(
      true,
    );
    const storedQuiz = repos.quizzes.get(launched.quiz.id)!;
    const grading = await services.grading.grade(
      {
        quizId: storedQuiz.id,
        answers: storedQuiz.questions.map((question) => ({
          questionId: question.id,
          type: 'short_answer' as const,
          text: 'Unsupported learner response.',
        })),
      },
      {
        stateCreditResolver: () =>
          new Set(services.formalProgression.stateCreditingQuestionIdsForQuiz(storedQuiz.id) ?? []),
      },
    );
    const reconciled = services.formalProgression.reconcileAfterGrading(grading.result.id)!;

    expect(reconciled.evidence.every((evidence) => !evidence.stateCreditable)).toBe(true);
    expect(reconciled.reconciliations.every((item) => item.status === 'rejected')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mistakes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_states').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM misconceptions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM progression_decisions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM successor_review_events').get()).toEqual({ n: 0 });
  });

  it('launches repair-needed work only while its targeted-repair prerequisite remains valid', async () => {
    const plan = repos.studyPlans.get('plan_1')!;
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        ...plan,
        items: plan.items.map((item) =>
          item.id === 'plan_item_1' ? { ...item, kind: 'formal_checkpoint' } : item,
        ),
      }),
      plan.id,
    );
    db.prepare(
      `UPDATE study_plan_progress
       SET state = 'repair_needed', version = version + 1, updated_at = ?
       WHERE plan_id = 'plan_1' AND plan_item_id = 'plan_item_1'`,
    ).run(T3);

    const existingConcepts = repos.materials.getConceptsByWorkspace('ws_1');
    const prerequisiteConcept = makeConcept({
      id: 'con_prerequisite',
      name: 'Capacity prerequisite',
      grounding: makeGrounding({
        blockId: 'blk_2',
        quote: repos.materials.getBlock('blk_2')!.content,
      }),
    });
    repos.materials.replaceConcepts('mat_1', [...existingConcepts, prerequisiteConcept]);
    repos.graph.insertVersion({
      id: 'graph_repair_ready',
      workspaceId: 'ws_1',
      status: 'generating',
      provider: 'fake',
      providerModel: null,
      validationSummary: null,
      errorMessage: null,
      createdAt: T3,
      updatedAt: T3,
    });
    repos.graph.finalizeReady(
      'graph_repair_ready',
      'ws_1',
      [
        {
          id: 'edge_repair_prerequisite',
          graphVersionId: 'graph_repair_ready',
          sourceConceptId: prerequisiteConcept.id,
          targetConceptId: 'con_1',
          relation: 'prerequisite',
          explanation: 'The prerequisite supports repair of the target concept.',
          evidence: [makeGrounding()],
          createdAt: T3,
        },
      ],
      {
        candidateCount: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        duplicateCount: 0,
        droppedEvidenceCount: 0,
        rejected: [],
      },
      T3,
    );
    const agenda = repos.sessionAgendas.get('agenda_1')!;
    const repairAgenda = repos.sessionAgendas.update(
      {
        ...agenda,
        version: agenda.version + 1,
        items: agenda.items.map((item) =>
          item.id === 'agenda_item_1'
            ? {
                ...item,
                kind: 'targeted_repair' as const,
                state: 'queued' as const,
                launch: {
                  status: 'launchable' as const,
                  capability: 'assessment',
                  resourceId: null,
                  reason: null,
                },
              }
            : item,
        ),
        updatedAt: T3,
      },
      agenda.version,
      {
        id: 'agenda_repair_needed',
        eventType: 'repair_needed',
        actor: 'local',
        payload: {},
        createdAt: T3,
      },
    );
    const request = {
      agendaId: repairAgenda.id,
      expectedAgendaVersion: repairAgenda.version,
      agendaItemId: 'agenda_item_1',
      expectedContractId: 'contract_1',
      expectedStudyPlanId: 'plan_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
    };

    const launched = await services.courseActionLaunch.launch({
      command: command('launch_valid_targeted_repair', 'learner'),
      ...request,
    });
    expect(launched).toMatchObject({ kind: 'assessment', assessmentKind: 'targeted_repair' });

    repos.graph.insertVersion({
      id: 'graph_repair_invalid',
      workspaceId: 'ws_1',
      status: 'generating',
      provider: 'fake',
      providerModel: null,
      validationSummary: null,
      errorMessage: null,
      createdAt: T3,
      updatedAt: T3,
    });
    repos.graph.finalizeReady(
      'graph_repair_invalid',
      'ws_1',
      [],
      {
        candidateCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        droppedEvidenceCount: 0,
        rejected: [],
      },
      T3,
    );
    const blocked = await services.courseActionLaunch.launch({
      command: command('launch_invalid_targeted_repair', 'learner'),
      ...request,
    });
    expect(blocked).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('前置概念'),
    });
  });

  it('does not launder an unauthorized question through another authorized unit source', () => {
    const grade = insertGrade('wrong_premise', 1, 'blk_2');
    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts[0]).toMatchObject({
      admissibilityTier: 'tier_3_advisory',
      provenance: [{ sourceBlockId: 'blk_2', truthAuthorityClaimIds: [] }],
    });
    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    expect(reconciled.reconciliations[0]?.status).toBe('rejected');
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1').state).toBe(
      'not_started',
    );
  });

  it('keeps a grounded question advisory when its hidden scoring premise is not admitted', () => {
    db.prepare('UPDATE truth_authority_claims SET claim = ? WHERE id = ?').run(
      'A generic fact from the same source block.',
      'claim_1',
    );
    const grade = insertGrade('unbound_answer', 1);

    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts[0]).toMatchObject({
      admissibilityTier: 'tier_3_advisory',
      assessmentPremiseBindings: [
        expect.objectContaining({
          premiseKey: 'rubric_point:0',
          truthAuthorityClaimIds: ['claim_rubric_1'],
        }),
      ],
      provenance: [{ sourceBlockId: 'blk_1', truthAuthorityClaimIds: ['claim_rubric_1'] }],
    });
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(grade.quizId)).toEqual([]);
  });

  it('keeps a choice question advisory when only its correct option has authority', () => {
    const quizId = 'quiz_correct_choice_only';
    const questionId = 'question_correct_choice_only';
    const question = makeQuestion({ id: questionId, quizId });
    db.prepare('UPDATE truth_authority_claims SET claim = ? WHERE id = ?').run(
      question.options![0]!.text,
      'claim_1',
    );
    repos.quizzes.insert(
      makeQuiz({
        id: quizId,
        materialId: null,
        workspaceId: 'ws_1',
        kind: 'adaptive',
        assessmentMode: 'formal_checkpoint',
        questions: [question],
      }),
    );

    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts[0]).toMatchObject({
      admissibilityTier: 'tier_3_advisory',
      assessmentPremiseBindings: [expect.objectContaining({ premiseKind: 'choice_answer' })],
      limitations: [expect.stringContaining('full option set')],
    });
    expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(quizId)).toEqual([]);
  });

  it('requires both expected-answer and required-rubric premise bindings', () => {
    const quizId = 'quiz_partial_rubric_authority';
    const questionId = 'question_partial_rubric_authority';
    const expectedAnswer = 'Working memory has limited capacity.';
    db.prepare('UPDATE truth_authority_claims SET claim = ? WHERE id = ?').run(
      expectedAnswer,
      'claim_1',
    );
    repos.quizzes.insert(
      makeQuiz({
        id: quizId,
        materialId: null,
        workspaceId: 'ws_1',
        kind: 'adaptive',
        assessmentMode: 'formal_checkpoint',
        questions: [
          makeQuestion({
            id: questionId,
            quizId,
            type: 'short_answer',
            options: undefined,
            correctOptionIds: undefined,
            expectedAnswer,
            rubric: {
              keyPoints: [{ text: 'States the bounded capacity.', required: true }],
            },
          }),
        ],
      }),
    );

    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts[0]).toMatchObject({
      admissibilityTier: 'tier_3_advisory',
      assessmentPremiseBindings: [
        expect.objectContaining({ premiseKey: 'expected_answer', premiseKind: 'expected_answer' }),
      ],
    });
    expect(contracts[0]?.limitations[0]).toContain('answer/options/rubric premises');
  });

  it('does not grant objective credit through positional assignment on a multi-objective item', () => {
    const plan = repos.studyPlans.get('plan_1')!;
    const ambiguousPlan = {
      ...plan,
      items: plan.items.map((item) =>
        item.id === 'plan_item_1'
          ? { ...item, objectiveIds: ['objective_1', 'objective_2'] }
          : item,
      ),
    };
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify(ambiguousPlan),
      plan.id,
    );
    const grade = insertGrade('ambiguous_objective', 1, 'blk_1', undefined, null);

    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts[0]).toMatchObject({
      primaryObjectiveId: 'objective_1',
      admissibilityTier: 'tier_3_advisory',
      limitations: [
        'The question has no validated one-to-one objective attribution; result is advisory only.',
      ],
    });
    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    expect(reconciled.reconciliations[0]?.status).toBe('rejected');
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1')).toMatchObject(
      {
        state: 'not_started',
        version: 0,
      },
    );
  });

  it.each([
    [
      'accepted checkpoint without execution',
      () => db.prepare('DELETE FROM lesson_execution_states').run(),
    ],
    [
      'failed preparation',
      () =>
        db
          .prepare("UPDATE lesson_execution_states SET preparation_status = 'retryable_failure'")
          .run(),
    ],
    [
      'stale curriculum',
      () => {
        const current = repos.lessonExecution.listForWorkspace('ws_1');
        vi.spyOn(repos.lessonExecution, 'listForWorkspace').mockReturnValue(
          current.map((state) => ({ ...state, curriculumVersionId: 'curriculum_stale' })),
        );
      },
    ],
    [
      'stale manifest',
      () => {
        const current = repos.lessonExecution.listForWorkspace('ws_1');
        vi.spyOn(repos.lessonExecution, 'listForWorkspace').mockReturnValue(
          current.map((state) => ({
            ...state,
            executionSourceManifestFingerprint: 'manifest_stale',
          })),
        );
      },
    ],
  ] as const)('keeps %s exposure advisory', (_label, invalidateExposure) => {
    invalidateExposure();
    const grade = insertGrade(`untaught_${_label.replaceAll(' ', '_')}`, 1);

    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts[0]).toMatchObject({
      admissibilityTier: 'tier_3_advisory',
      limitations: [expect.stringContaining('no current, presented Lesson exposure')],
    });
  });

  it('credits a partially presented segment while whole-Lesson completion remains null', () => {
    expect(repos.lessonExecution.listForWorkspace('ws_1')[0]).toMatchObject({
      presentedSegmentIndexes: [0],
      presentationCompletedAt: null,
    });
    const grade = insertGrade('partial_presentation_credit', 1);

    const contracts = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    expect(contracts[0]).toMatchObject({
      admissibilityTier: 'tier_1_authorized_truth',
      taughtExposureBindings: [
        expect.objectContaining({ objectiveId: 'objective_1', presentedSegmentIndexes: [0] }),
      ],
    });
  });

  it.each([
    ['stem', 'The stated condition is visible.', [], false],
    ['cited_source', (repos) => repos.materials.getBlock('blk_1')!.content, ['blk_1'], false],
    ['assumed_prerequisite', 'The accepted prerequisite is visible.', [], false],
    ['scenario_local', 'A scenario card is marked red.', [], true],
  ] as const)(
    'accepts the %s structural visibility basis',
    (basis, premiseValue, sourceRefs, scenarioLocal) => {
      const premiseText = typeof premiseValue === 'function' ? premiseValue(repos) : premiseValue;
      const stem = `Use this visible information: ${premiseText}`;
      const grade = insertGrade(`visibility_${basis}`, 1, 'blk_1', stem);
      replaceFormalProposal(
        grade.questionId,
        formalProposal({
          objectiveRef: 'O1',
          premiseText,
          sourceRefs: [...sourceRefs],
          visibilityBasis: basis,
          scenarioLocal,
        }),
      );

      const contract = services.formalProgression.registerAssessmentContracts({
        workspaceId: 'ws_1',
        quizId: grade.quizId,
        agendaId: 'agenda_1',
        agendaItemId: 'agenda_item_1',
        assessmentKind: 'formal_checkpoint',
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        executionSourceManifestFingerprint: 'manifest-fp',
      })[0]!;

      expect(contract).toMatchObject({
        admissibilityTier: 'tier_1_authorized_truth',
        premiseVisibilityVerdict: 'satisfied',
      });
      if (basis === 'scenario_local') {
        expect(contract.declaredPremises?.[0]?.sourceRefIds).toEqual([]);
        expect(contract.provenance.map((item) => item.sourceBlockId)).toEqual(['blk_1']);
      }
    },
  );

  it.each([
    ['hidden prerequisite', 'Hidden prerequisite.', 'assumed_prerequisite', {}, 'Unrelated stem'],
    [
      'uncited source',
      'Unverified source premise.',
      'cited_source',
      { sourceRefs: ['blk_2'] },
      'Question',
    ],
    [
      'course-specific scenario fact',
      'SOURCE',
      'scenario_local',
      { scenarioLocal: true },
      'SOURCE',
    ],
    [
      'external knowledge',
      'Visible premise.',
      'stem',
      { requiresExternalKnowledge: true },
      'Visible premise.',
    ],
    [
      'unresolved ambiguity',
      'Visible premise.',
      'stem',
      { ambiguity: 'unresolved' },
      'Visible premise.',
    ],
    [
      'undefined terms',
      'Visible premise.',
      'stem',
      { undefinedTerms: ['opaque term'] },
      'Visible premise.',
    ],
    [
      'hidden from learner',
      'Visible premise.',
      'stem',
      { learnerVisible: false },
      'Visible premise.',
    ],
    [
      'unbound required rubric',
      'Visible premise.',
      'stem',
      { rubricSourceRefs: [] },
      'Visible premise.',
    ],
  ] as const)('fails closed for %s', (_label, rawPremise, basis, overrides, rawStem) => {
    const sourceText = repos.materials.getBlock('blk_1')!.content;
    const premiseText = rawPremise === 'SOURCE' ? sourceText : rawPremise;
    const stem = rawStem === 'SOURCE' ? sourceText : rawStem;
    const grade = insertGrade(
      `visibility_negative_${_label.replaceAll(' ', '_')}`,
      1,
      'blk_1',
      stem,
    );
    replaceFormalProposal(
      grade.questionId,
      formalProposal({
        objectiveRef: 'O1',
        premiseText,
        visibilityBasis: basis,
        ...overrides,
      }),
    );

    const contract = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    })[0]!;

    expect(contract).toMatchObject({
      admissibilityTier: 'tier_3_advisory',
      premiseVisibilityVerdict: 'unsatisfied',
    });
  });

  it('treats an exact presented AI surface as structurally visible without semantic relevance', () => {
    makeAiTeachingBrief('brief_taught_unit_1');
    const catalogue = formalCatalogue();
    const teachingSurfaceRef = catalogue.teachingSurfaceCatalogue[0]!.teachingSurfaceRef;
    const grade = insertGrade('ai_surface_structural_visibility', 1);
    replaceFormalProposal(
      grade.questionId,
      formalProposal({
        objectiveRef: 'O1',
        premiseText: 'A deliberately unrelated declared premise.',
        teachingSurfaceRefs: [teachingSurfaceRef],
        visibilityBasis: 'taught_exposure',
      }),
    );

    const contract = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
      proposalCatalogue: catalogue,
    })[0]!;

    expect(contract).toMatchObject({
      admissibilityTier: 'tier_1_authorized_truth',
      premiseVisibilityVerdict: 'satisfied',
      presentedTeachingSurfaceBindings: [expect.objectContaining({ surfaceKind: 'explanation' })],
    });
  });

  it.each([
    ['absent', []],
    ['unknown', ['T999']],
  ] as const)('keeps an AI taught premise with %s surface refs advisory', (_label, refs) => {
    makeAiTeachingBrief('brief_taught_unit_1');
    const grade = insertGrade(`ai_surface_${_label}`, 0);
    replaceFormalProposal(
      grade.questionId,
      formalProposal({
        objectiveRef: 'O1',
        premiseText: 'AI-only premise.',
        teachingSurfaceRefs: [...refs],
        visibilityBasis: 'taught_exposure',
      }),
    );

    const contract = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    })[0]!;
    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;

    expect(contract.admissibilityTier).toBe('tier_3_advisory');
    expect(reconciled.reconciliations[0]?.status).toBe('rejected');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mistakes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_states').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM misconceptions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM progression_decisions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM successor_review_events').get()).toEqual({ n: 0 });
  });

  it('rejects cross-objective AI surface borrowing without durable mutation', () => {
    const plan = repos.studyPlans.get('plan_1')!;
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        ...plan,
        items: plan.items.map((item) =>
          item.id === 'plan_item_1'
            ? { ...item, objectiveIds: ['objective_1', 'objective_2'] }
            : item,
        ),
      }),
      plan.id,
    );
    seedPresentedTeachingFixture({
      db,
      repos,
      workspaceId: 'ws_1',
      curriculum: repos.curricula.get('curriculum_1')!,
      studyPlanVersionId: 'plan_1',
      learningUnitId: 'unit_1',
      objectiveIds: ['objective_2'],
      sessionAgendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      studyPlanItemId: 'plan_item_1',
      at: T3,
      suffix: 'cross_objective_2',
    });
    makeAiTeachingBrief('brief_taught_unit_1');
    makeAiTeachingBrief('brief_taught_cross_objective_2');
    const catalogue = formalCatalogue();
    const objectiveOneSurface = catalogue.teachingSurfaceCatalogue.find((surface) =>
      surface.objectiveRefs.includes('O1'),
    )!;
    const grade = insertGrade('cross_objective_surface', 0, 'blk_1', undefined, 'O2');
    replaceFormalProposal(
      grade.questionId,
      formalProposal({
        objectiveRef: 'O2',
        premiseText: 'Borrowed AI premise.',
        teachingSurfaceRefs: [objectiveOneSurface.teachingSurfaceRef],
        visibilityBasis: 'taught_exposure',
      }),
    );

    const contract = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
      proposalCatalogue: catalogue,
    })[0]!;
    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;

    expect(contract).toMatchObject({
      primaryObjectiveId: 'objective_2',
      admissibilityTier: 'tier_3_advisory',
      premiseVisibilityVerdict: 'unsatisfied',
    });
    expect(reconciled.reconciliations[0]?.status).toBe('rejected');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mistakes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_states').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM misconceptions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM progression_decisions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM successor_review_events').get()).toEqual({ n: 0 });
  });

  it('attributes a multi-objective item through a valid provider alias and its resolved exposure', () => {
    const plan = repos.studyPlans.get('plan_1')!;
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        ...plan,
        items: plan.items.map((item) =>
          item.id === 'plan_item_1'
            ? { ...item, objectiveIds: ['objective_1', 'objective_2'] }
            : item,
        ),
      }),
      plan.id,
    );
    seedPresentedTeachingFixture({
      db,
      repos,
      workspaceId: 'ws_1',
      curriculum: repos.curricula.get('curriculum_1')!,
      studyPlanVersionId: 'plan_1',
      learningUnitId: 'unit_1',
      objectiveIds: ['objective_2'],
      sessionAgendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      studyPlanItemId: 'plan_item_1',
      at: T3,
      suffix: 'multi_objective_2',
    });
    const grade = insertGrade('multi_objective_alias', 1, 'blk_1', undefined, 'O2');

    const contract = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    })[0]!;

    expect(contract).toMatchObject({
      primaryObjectiveId: 'objective_2',
      admissibilityTier: 'tier_1_authorized_truth',
      resolvedObjectiveBinding: {
        objectiveRef: 'O2',
        objectiveId: 'objective_2',
        source: 'provider_alias',
      },
      taughtExposureBindings: [expect.objectContaining({ objectiveId: 'objective_2' })],
    });
  });

  it('keeps an unknown objective alias advisory even on a single-objective item', () => {
    const grade = insertGrade('unknown_objective_alias', 1, 'blk_1', undefined, 'O9');

    const contract = services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    })[0]!;

    expect(contract).toMatchObject({
      admissibilityTier: 'tier_3_advisory',
      limitations: [expect.stringContaining('no validated one-to-one objective attribution')],
    });
    expect(contract.resolvedObjectiveBinding).toBeUndefined();
  });

  it.each(['surface', 'skeleton', 'checkpoint', 'route'] as const)(
    'revalidates AI teaching %s identity at credit time',
    (drift) => {
      makeAiTeachingBrief('brief_taught_unit_1');
      const catalogue = formalCatalogue();
      const teachingSurfaceRef = catalogue.teachingSurfaceCatalogue[0]!.teachingSurfaceRef;
      const grade = insertGrade(`ai_credit_drift_${drift}`, 1);
      replaceFormalProposal(
        grade.questionId,
        formalProposal({
          objectiveRef: 'O1',
          premiseText: 'AI-only premise.',
          teachingSurfaceRefs: [teachingSurfaceRef],
          visibilityBasis: 'taught_exposure',
        }),
      );
      services.formalProgression.registerAssessmentContracts({
        workspaceId: 'ws_1',
        quizId: grade.quizId,
        agendaId: 'agenda_1',
        agendaItemId: 'agenda_item_1',
        assessmentKind: 'formal_checkpoint',
        contractVersionId: 'contract_1',
        curriculumVersionId: 'curriculum_1',
        studyPlanVersionId: 'plan_1',
        executionSourceManifestFingerprint: 'manifest-fp',
        proposalCatalogue: catalogue,
      });
      expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(grade.quizId)).toEqual([
        grade.questionId,
      ]);

      if (drift === 'surface') {
        makeAiTeachingBrief('brief_taught_unit_1', 'Changed learner-visible explanation.');
      } else if (drift === 'skeleton') {
        updateTeachingBrief('brief_taught_unit_1', (brief) => ({
          ...brief,
          composition: {
            ...brief.composition!,
            skeletonFingerprint: `sha256:${'0'.repeat(64)}`,
          },
        }));
      } else if (drift === 'checkpoint') {
        db.prepare('UPDATE lesson_execution_states SET accepted_lesson_checkpoint_id = NULL').run();
      } else {
        db.prepare(
          "UPDATE lesson_execution_states SET manifest_fingerprint = 'manifest_stale'",
        ).run();
      }

      expect(services.formalProgression.stateCreditingQuestionIdsForQuiz(grade.quizId)).toEqual([]);
    },
  );

  it('records a named synthesis gap and targeted repair without regressing completion', () => {
    const actions = installTwoUnitSynthesisRoute();
    const checkpoint = insertGrade('checkpoint_pass', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: checkpoint.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.checkpointAgendaItemId,
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    services.formalProgression.reconcileAfterGrading(checkpoint.gradingResultId);
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1').state).toBe(
      'complete',
    );

    const synthesis = insertSynthesisGrade(0);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: synthesis.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.synthesisAgendaItemId,
      assessmentKind: 'synthesis',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const reconciled = services.formalProgression.reconcileAfterGrading(synthesis.gradingResultId)!;
    expect(reconciled.decisions[0]).toMatchObject({
      kind: 'targeted_repair',
      priorState: 'complete',
      nextState: 'complete',
      reasonCodes: ['prior_completion_preserved', 'synthesis_transfer_gap'],
    });
    expect(reconciled.replanTriggers[0]).toMatchObject({
      kind: 'synthesis_failure',
      status: 'qualified',
      acceptedStudyPlanId: 'plan_1',
    });
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1').state).toBe(
      'complete',
    );
    expect(repos.coverageRisks.list('ws_1', 'contract_1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: 'Synthesis gap: Explain capacity',
          status: 'planned',
          facets: expect.arrayContaining(['transfer_integration_risk']),
          referencedEvidenceIds: expect.arrayContaining([reconciled.evidence[0]!.id]),
        }),
      ]),
    );
    const repairedAgenda = repos.sessionAgendas.get(actions.agenda.id)!;
    const repair = repairedAgenda.items.find((item) => item.kind === 'targeted_repair');
    expect(repair).toMatchObject({
      learningUnitId: 'unit_1',
      state: 'queued',
      launch: { status: 'launchable', capability: 'assessment' },
    });
    expect(repairedAgenda.currentItemId).toBe(repair?.id);
  });

  it('resolves a historical synthesis gap after a later qualifying synthesis passes', () => {
    const actions = installTwoUnitSynthesisRoute();
    const checkpoint = insertGrade('checkpoint_before_synthesis_repair', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: checkpoint.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.checkpointAgendaItemId,
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    services.formalProgression.reconcileAfterGrading(checkpoint.gradingResultId);

    const failed = insertSynthesisGrade(0, '_failed');
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: failed.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.synthesisAgendaItemId,
      assessmentKind: 'synthesis',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const failedReconciliation = services.formalProgression.reconcileAfterGrading(
      failed.gradingResultId,
    )!;
    expect(failedReconciliation.decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'targeted_repair' })]),
    );
    expect(
      repos.coverageRisks
        .list('ws_1', 'contract_1')
        .filter((risk) => risk.facets.includes('transfer_integration_risk')),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'planned' })]));

    const agendaAfterRepair = repos.sessionAgendas.get(actions.agenda.id)!;
    repos.sessionAgendas.update(
      {
        ...agendaAfterRepair,
        version: agendaAfterRepair.version + 1,
        items: agendaAfterRepair.items.map((item) =>
          item.id === actions.synthesisAgendaItemId ? { ...item, state: 'queued' as const } : item,
        ),
        currentItemId: actions.synthesisAgendaItemId,
        updatedAt: T4,
      },
      agendaAfterRepair.version,
      {
        id: 'agenda_synthesis_reauthorized_after_repair',
        eventType: 'synthesis_reauthorized_after_repair',
        actor: 'local',
        payload: { agendaItemId: actions.synthesisAgendaItemId },
        createdAt: T4,
      },
    );
    const repaired = insertSynthesisGrade(1, '_repaired');
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: repaired.quizId,
      agendaId: actions.agenda.id,
      agendaItemId: actions.synthesisAgendaItemId,
      assessmentKind: 'synthesis',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const reconciled = services.formalProgression.reconcileAfterGrading(repaired.gradingResultId)!;

    expect(reconciled.decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'complete' })]),
    );
    const historicalEvidence = repos.formalProgression.listEvidenceForWorkspace('ws_1');
    expect(historicalEvidence.some((item) => item.gradingResultId === failed.gradingResultId)).toBe(
      true,
    );
    expect(
      historicalEvidence.some((item) => item.gradingResultId === repaired.gradingResultId),
    ).toBe(true);
    const synthesisRisks = repos.coverageRisks
      .list('ws_1', 'contract_1')
      .filter((risk) => risk.facets.includes('transfer_integration_risk'));
    expect(synthesisRisks).not.toHaveLength(0);
    expect(synthesisRisks.every((risk) => risk.status === 'resolved')).toBe(true);
    expect(synthesisRisks.every((risk) => risk.resolutionEvidenceIds.length > 0)).toBe(true);
    expect(
      repos.formalProgression
        .listReplanTriggers('ws_1')
        .filter((trigger) => trigger.kind === 'synthesis_failure'),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'resolved' })]));
    const agenda = repos.sessionAgendas.get(actions.agenda.id)!;
    expect(agenda.items.find((item) => item.id === actions.synthesisAgendaItemId)?.state).toBe(
      'completed',
    );
    expect(agenda.items.find((item) => item.id === actions.repairAgendaItemId)?.state).toBe(
      'cancelled',
    );
    expect(agenda.currentItemId).not.toBe(actions.repairAgendaItemId);

    const sideEffectsBeforeReplay = {
      decisions: (
        db.prepare('SELECT COUNT(*) AS n FROM progression_decisions').get() as { n: number }
      ).n,
      evidence: (
        db.prepare('SELECT COUNT(*) AS n FROM formal_evidence_records').get() as { n: number }
      ).n,
      riskEvents: (
        db.prepare('SELECT COUNT(*) AS n FROM coverage_risk_events').get() as { n: number }
      ).n,
      agendaItems: agenda.items.length,
    };
    const replay = services.formalProgression.reconcileAfterGrading(repaired.gradingResultId)!;
    expect(replay.decisions.map((item) => item.id)).toEqual(
      reconciled.decisions.map((item) => item.id),
    );
    expect({
      decisions: (
        db.prepare('SELECT COUNT(*) AS n FROM progression_decisions').get() as { n: number }
      ).n,
      evidence: (
        db.prepare('SELECT COUNT(*) AS n FROM formal_evidence_records').get() as { n: number }
      ).n,
      riskEvents: (
        db.prepare('SELECT COUNT(*) AS n FROM coverage_risk_events').get() as { n: number }
      ).n,
      agendaItems: repos.sessionAgendas.get(actions.agenda.id)!.items.length,
    }).toEqual(sideEffectsBeforeReplay);
  });

  it('reconciles successor-Plan evidence without citing predecessor-Plan evidence', () => {
    const predecessorGrade = insertGrade('predecessor_plan', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: predecessorGrade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const predecessor = services.formalProgression.reconcileAfterGrading(
      predecessorGrade.gradingResultId,
    )!;
    expect(predecessor.decisions[0]?.kind).toBe('complete');

    const trigger = services.formalProgression.qualifyReplanTrigger({
      command: command('trigger_successor_evidence', 'learner'),
      expectedAcceptedStudyPlanId: 'plan_1',
      kind: 'promoted_detour',
      evidenceIds: [],
      reason: 'Exercise a successor route.',
      facts: {
        qualifyingOccurrences: 1,
        affectedLearningUnitIds: ['unit_1'],
        affectedPlanItemIds: ['plan_item_2'],
        observedMinutesPerWeek: null,
        sourceManifestFingerprint: null,
        learnerConfirmedChange: true,
      },
    });
    const proposed = services.formalProgression.proposeQualifiedReplan({
      command: command('propose_successor_evidence', 'learner'),
      triggerId: trigger.id,
      expectedAcceptedStudyPlanId: 'plan_1',
    });
    const accepted = services.courseExecution.decideStudyPlan({
      command: command('accept_successor_evidence', 'learner'),
      studyPlanId: proposed.studyPlan.id,
      expectedVersion: proposed.studyPlan.version,
      expectedContractId: 'contract_1',
      expectedCurriculumId: 'curriculum_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      decision: 'accept',
      reason: null,
    });
    const successorPlanId = accepted.activeRoute!.studyPlan.id;
    const successorAgenda = accepted.activeRoute!.agenda;
    expect(repos.studyPlans.listProgress(successorPlanId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planItemId: 'plan_item_1', state: 'completed' }),
      ]),
    );
    expect(successorAgenda.items.some((item) => item.linkedPlanItemId === 'plan_item_1')).toBe(
      false,
    );
    const successorAgendaItem = successorAgenda.items.find(
      (item) => item.linkedPlanItemId === 'plan_item_2',
    )!;
    enableRouteItemsAsFormalCheckpoints(
      [{ planItemId: 'plan_item_2', agendaItemId: successorAgendaItem.id }],
      successorPlanId,
      successorAgenda.id,
    );
    seedPresentedTeachingFixture({
      db,
      repos,
      workspaceId: 'ws_1',
      curriculum: repos.curricula.get('curriculum_1')!,
      studyPlanVersionId: successorPlanId,
      learningUnitId: 'unit_1',
      objectiveIds: ['objective_2'],
      sessionAgendaId: successorAgenda.id,
      agendaItemId: successorAgendaItem.id,
      studyPlanItemId: 'plan_item_2',
      at: T3,
      suffix: 'successor_plan_objective_2',
    });
    const successorGrade = insertGrade('successor_plan', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: successorGrade.quizId,
      agendaId: successorAgenda.id,
      agendaItemId: successorAgendaItem.id,
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: successorPlanId,
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    const reconciled = services.formalProgression.reconcileAfterGrading(
      successorGrade.gradingResultId,
    )!;
    const predecessorEvidenceIds = new Set(predecessor.evidence.map((item) => item.id));
    expect(reconciled.decisions[0]?.evidenceIds).not.toEqual(
      expect.arrayContaining([...predecessorEvidenceIds]),
    );
    expect(reconciled.decisions[0]).toMatchObject({
      kind: 'continue',
      priorState: 'complete',
      nextState: 'complete',
      reasonCodes: ['prior_completion_preserved'],
    });
  });

  it('retains grading and formal evidence while marking reconciliation stale after route change', () => {
    const grade = insertGrade('route_changed_before_reconcile', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });

    const trigger = services.formalProgression.qualifyReplanTrigger({
      command: command('trigger_stale_reconciliation', 'learner'),
      expectedAcceptedStudyPlanId: 'plan_1',
      kind: 'promoted_detour',
      evidenceIds: [],
      reason: 'Change route before formal reconciliation.',
      facts: {
        qualifyingOccurrences: 1,
        affectedLearningUnitIds: ['unit_1'],
        affectedPlanItemIds: ['plan_item_2'],
        observedMinutesPerWeek: null,
        sourceManifestFingerprint: null,
        learnerConfirmedChange: true,
      },
    });
    const proposed = services.formalProgression.proposeQualifiedReplan({
      command: command('propose_stale_reconciliation', 'learner'),
      triggerId: trigger.id,
      expectedAcceptedStudyPlanId: 'plan_1',
    });
    const accepted = services.courseExecution.decideStudyPlan({
      command: command('accept_stale_reconciliation', 'learner'),
      studyPlanId: proposed.studyPlan.id,
      expectedVersion: proposed.studyPlan.version,
      expectedContractId: 'contract_1',
      expectedCurriculumId: 'curriculum_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      decision: 'accept',
      reason: null,
    });
    const successorPlanId = accepted.activeRoute!.studyPlan.id;
    const successorAgendaId = accepted.activeRoute!.agenda.id;
    const successorProgressBefore = repos.studyPlans.listProgress(successorPlanId);
    const successorAgendaBefore = repos.sessionAgendas.get(successorAgendaId);
    const executionBefore = repos.courseExecution.get('ws_1');

    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;

    expect(repos.submissions.getGradingResult(grade.gradingResultId)?.id).toBe(
      grade.gradingResultId,
    );
    expect(repos.formalProgression.listEvidenceForGrading(grade.gradingResultId)).toHaveLength(1);
    expect(reconciled.reconciliations[0]).toMatchObject({
      status: 'stale',
      reason:
        'Accepted StudyPlan changed after grading; evidence is retained but cannot mutate the successor route.',
    });
    expect(reconciled.decisions).toHaveLength(0);
    expect(
      repos.formalProgression.listReconciliationsForGrading(grade.gradingResultId)[0]?.status,
    ).toBe('stale');
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      acceptedPlanId: successorPlanId,
      activeAgendaId: successorAgendaId,
      version: executionBefore.version,
    });
    expect(repos.studyPlans.listProgress(successorPlanId)).toEqual(successorProgressBefore);
    expect(repos.sessionAgendas.get(successorAgendaId)).toEqual(successorAgendaBefore);
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1')).toMatchObject(
      { state: 'not_started', version: 0 },
    );
  });

  it('derives replan duration before persistence and ignores a legacy resize successor input', () => {
    const acceptedPlan = repos.studyPlans.get('plan_1')!;
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        ...acceptedPlan,
        items: acceptedPlan.items.map((item) =>
          item.id === 'plan_item_1' ? { ...item, kind: 'teach_unit' as const } : item,
        ),
      }),
      acceptedPlan.id,
    );
    const trigger = services.formalProgression.qualifyReplanTrigger({
      command: command('trigger_gate_bypass', 'learner'),
      expectedAcceptedStudyPlanId: 'plan_1',
      kind: 'promoted_detour',
      evidenceIds: [],
      reason: 'Promote the detour so a deterministic replan proposes a successor.',
      facts: {
        qualifyingOccurrences: 1,
        affectedLearningUnitIds: ['unit_1'],
        affectedPlanItemIds: ['plan_item_2'],
        observedMinutesPerWeek: null,
        sourceManifestFingerprint: null,
        learnerConfirmedChange: true,
      },
    });
    const replanned = services.formalProgression.proposeQualifiedReplan({
      command: command('propose_gate_bypass', 'learner'),
      triggerId: trigger.id,
      expectedAcceptedStudyPlanId: 'plan_1',
    });

    // A deterministic replan proposes; it never accepts. The accepted route is unmoved,
    // so the successor must still cross the acceptance boundary to become authoritative.
    expect(replanned.studyPlan.status).toBe('proposed');
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe('plan_1');

    const explainItem = replanned.studyPlan.items.find((item) =>
      item.objectiveIds.includes('objective_1'),
    )!;
    const systemMinutes = explainItem.estimatedMinutes;
    expect(systemMinutes).toBeGreaterThan(11);
    expect(repos.studyPlans.get(replanned.studyPlan.id)?.items).toEqual(replanned.studyPlan.items);
    const edited = services.studyPlansAgent.applyDraftEdit({
      command: command('shrink_gate_bypass', 'learner'),
      studyPlanId: replanned.studyPlan.id,
      expectedVersion: replanned.studyPlan.version,
      expectedContractId: 'contract_1',
      expectedCurriculumId: 'curriculum_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      edit: {
        kind: 'resize_time',
        planItemId: explainItem.id,
        estimatedMinutes: 11,
        reason: 'Shrink the teaching item below its required-teaching floor.',
      },
    });
    expect(edited.plannability).toEqual([]);
    expect(
      edited.studyPlan.items.find((item) => item.id === explainItem.id)?.estimatedMinutes,
    ).toBe(systemMinutes);

    const proposedItems = JSON.stringify(edited.studyPlan.items);
    const accepted = services.courseExecution.decideStudyPlan({
      command: command('accept_gate_bypass', 'learner'),
      studyPlanId: edited.studyPlan.id,
      expectedVersion: edited.studyPlan.version,
      expectedContractId: 'contract_1',
      expectedCurriculumId: 'curriculum_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      decision: 'accept',
      reason: null,
    });

    expect(JSON.stringify(accepted.decidedPlan.items)).toBe(proposedItems);
    expect(repos.studyPlans.get(edited.studyPlan.id)?.status).toBe('accepted');
    expect(repos.studyPlans.get('plan_1')?.status).toBe('superseded');
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe(edited.studyPlan.id);
  });

  it('qualifies only meaningful triggers and preserves the route through reject then accept', () => {
    const oneOff = services.formalProgression.qualifyReplanTrigger({
      command: command('trigger_one_off', 'learner'),
      expectedAcceptedStudyPlanId: 'plan_1',
      kind: 'promoted_detour',
      evidenceIds: [],
      reason: 'One isolated result.',
      facts: {
        qualifyingOccurrences: 1,
        affectedLearningUnitIds: ['unit_1'],
        affectedPlanItemIds: ['plan_item_2'],
        observedMinutesPerWeek: null,
        sourceManifestFingerprint: null,
        learnerConfirmedChange: false,
      },
    });
    expect(oneOff.status).toBe('candidate');
    expect(() =>
      services.formalProgression.proposeQualifiedReplan({
        command: command('proposal_invalid'),
        triggerId: oneOff.id,
        expectedAcceptedStudyPlanId: 'plan_1',
      }),
    ).toThrow('qualified');

    const qualified = services.formalProgression.qualifyReplanTrigger({
      command: command('trigger_promoted', 'learner'),
      expectedAcceptedStudyPlanId: 'plan_1',
      kind: 'promoted_detour',
      evidenceIds: [],
      reason: 'Promote the learner detour.',
      facts: {
        qualifyingOccurrences: 1,
        affectedLearningUnitIds: ['unit_1'],
        affectedPlanItemIds: ['plan_item_2'],
        observedMinutesPerWeek: null,
        sourceManifestFingerprint: null,
        learnerConfirmedChange: true,
      },
    });
    const proposed = services.formalProgression.proposeQualifiedReplan({
      command: command('proposal_reject', 'learner'),
      triggerId: qualified.id,
      expectedAcceptedStudyPlanId: 'plan_1',
    });
    expect(proposed.studyPlan.predecessorId).toBe('plan_1');
    expect(proposed.studyPlan.diff).not.toHaveLength(0);
    const rejected = services.courseExecution.decideStudyPlan({
      command: command('reject_replan', 'learner'),
      studyPlanId: proposed.studyPlan.id,
      expectedVersion: proposed.studyPlan.version,
      expectedContractId: 'contract_1',
      expectedCurriculumId: 'curriculum_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      decision: 'reject',
      reason: 'Keep the current route.',
    });
    expect(rejected.decision).toBe('rejected');
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe('plan_1');
    expect(repos.formalProgression.getReplanTrigger(qualified.id)?.status).toBe('resolved');

    const acceptedTrigger = services.formalProgression.qualifyReplanTrigger({
      command: command('trigger_promoted_again', 'learner'),
      expectedAcceptedStudyPlanId: 'plan_1',
      kind: 'promoted_detour',
      evidenceIds: [],
      reason: 'Promote the revised learner detour.',
      facts: {
        qualifyingOccurrences: 1,
        affectedLearningUnitIds: ['unit_1'],
        affectedPlanItemIds: ['plan_item_2'],
        observedMinutesPerWeek: null,
        sourceManifestFingerprint: null,
        learnerConfirmedChange: true,
      },
    });
    const successor = services.formalProgression.proposeQualifiedReplan({
      command: command('proposal_accept', 'learner'),
      triggerId: acceptedTrigger.id,
      expectedAcceptedStudyPlanId: 'plan_1',
    });
    const accepted = services.courseExecution.decideStudyPlan({
      command: command('accept_replan', 'learner'),
      studyPlanId: successor.studyPlan.id,
      expectedVersion: successor.studyPlan.version,
      expectedContractId: 'contract_1',
      expectedCurriculumId: 'curriculum_1',
      expectedExecutionSourceManifestFingerprint: 'manifest-fp',
      decision: 'accept',
      reason: null,
    });
    expect(accepted.activeRoute?.studyPlan.id).toBe(successor.studyPlan.id);
    expect(repos.formalProgression.getReplanTrigger(acceptedTrigger.id)?.status).toBe('resolved');
    expect(repos.formalProgression.getGoalOutcomeForRoute('contract_1', 'plan_1')?.status).toBe(
      'superseded',
    );

    const state = repos.courseExecution.get('ws_1');
    const outcome = services.formalProgression.recordGoalOutcome({
      command: command('abandon_goal', 'learner'),
      expectedCourseExecutionVersion: state.version,
      expectedContractVersionId: state.activeContractId,
      expectedCurriculumVersionId: state.activeCurriculumId,
      expectedStudyPlanVersionId: state.acceptedPlanId,
      expectedAgendaVersionId: state.activeAgendaId,
      status: 'abandoned',
      unresolvedRiskIds: [],
      reason: 'Learner ended the course.',
    });
    expect(outcome.status).toBe('abandoned');
    expect(repos.courseExecution.get('ws_1')).toMatchObject({
      acceptedPlanId: null,
      executionStatus: 'stopped',
    });
    expect(repos.learningContracts.get('contract_1')?.status).toBe('closed');
    expect(repos.studyPlans.get(successor.studyPlan.id)?.status).toBe('closed');
  });

  it('promotes an active detour into an idempotent successor proposal without Plan drift', () => {
    const activeAgenda = repos.sessionAgendas.get('agenda_1')!;
    repos.sessionAgendas.update(
      {
        ...activeAgenda,
        version: activeAgenda.version + 1,
        currentItemId: 'agenda_item_2',
        updatedAt: T3,
      },
      activeAgenda.version,
      {
        id: 'agenda_positioned',
        eventType: 'positioned_for_session',
        actor: 'local',
        payload: {},
        createdAt: T3,
      },
    );
    const execution = repos.courseExecution.get('ws_1');
    const started = services.studySessions.start('ws_1', {
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      sessionAgendaId: 'agenda_1',
      expectedCourseExecutionVersion: execution.version,
    }).session;
    const detour = services.studySessions.command('ws_1', started.id, {
      commandId: 'promotion_detour',
      expectedSessionVersion: started.version,
      kind: 'detour',
      targetAgendaItemId: 'agenda_item_2',
      requestedMinutes: 10,
      reason: 'Explore this unit as a sustained objective.',
    });
    const detourItemId = detour.effect.affectedAgendaItemId!;
    const request = {
      commandId: 'promote_detour',
      expectedSessionVersion: detour.session.version,
      kind: 'promote_to_plan' as const,
      targetAgendaItemId: detourItemId,
      reason: 'Make this detour part of the accepted route proposal.',
    };

    const promotion = services.studySessions.command('ws_1', started.id, request);
    const proposedPlanId = promotion.effect.planChangeRequest?.proposedStudyPlanId;
    expect(promotion.effect.planChangeRequest).toMatchObject({
      predecessorStudyPlanId: 'plan_1',
      targetLearningUnitId: 'unit_1',
      reason: request.reason,
      replanTriggerId: expect.any(String),
      proposedStudyPlanId: expect.any(String),
    });
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe('plan_1');
    expect(repos.studyPlans.get('plan_1')?.status).toBe('accepted');
    expect(repos.studyPlans.get(proposedPlanId!)).toMatchObject({
      status: 'proposed',
      predecessorId: 'plan_1',
    });
    expect(repos.studyPlans.get(proposedPlanId!)?.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'depth_changed',
          planItemId: 'plan_item_1',
          beforeIndex: 0,
          afterIndex: 0,
          beforeDepth: 'working_fluency',
          afterDepth: 'high_performance',
        }),
      ]),
    );
    expect(promotion.session.studyPlanVersionId).toBe('plan_1');

    expect(services.studySessions.command('ws_1', started.id, request)).toEqual(promotion);
    expect(repos.studyPlans.list('ws_1')).toHaveLength(2);
    expect(repos.formalProgression.listReplanTriggers('ws_1')).toHaveLength(1);

    expect(() =>
      services.studySessions.command('ws_1', started.id, {
        ...request,
        reason: 'Reuse the identity for a different promotion.',
      }),
    ).toThrow('identity was reused');
    expect(() =>
      services.studySessions.command('ws_1', started.id, {
        ...request,
        commandId: 'promote_detour_stale',
      }),
    ).toThrow('became stale');
    expect(repos.studyPlans.list('ws_1')).toHaveLength(2);
    expect(repos.courseExecution.get('ws_1').acceptedPlanId).toBe('plan_1');
  });

  it('T16 continues the same Plan when a formal decision drains the Agenda window', () => {
    // Give the accepted route one more teaching item that the current window
    // does not cover, so draining it leaves genuine remaining work.
    const plan = structuredClone(repos.studyPlans.get('plan_1')!);
    const carried = plan.items[1]!;
    const extra = {
      ...carried,
      id: 'plan_item_3',
      index: 2,
      rationale: 'Teach the remaining objective in a later window.',
      completionRequirements: carried.completionRequirements.map((requirement) => ({
        ...requirement,
        id: 'requirement_plan_item_3',
        blocking: false,
      })),
    };
    plan.items = [...plan.items, extra];
    db.prepare('UPDATE study_plan_versions SET payload = ? WHERE id = ?').run(
      JSON.stringify(plan),
      'plan_1',
    );
    db.prepare(
      `INSERT INTO study_plan_items
         (plan_id, plan_item_id, idx, kind, curriculum_learning_unit_id,
          objective_ids, completion_requirements)
       VALUES ('plan_1', 'plan_item_3', 2, 'teach_unit', 'unit_1', ?, ?)`,
    ).run(JSON.stringify(extra.objectiveIds), JSON.stringify(extra.completionRequirements));
    db.prepare(
      `INSERT INTO study_plan_progress (plan_id, plan_item_id, state, version, updated_at)
       VALUES ('plan_1', 'plan_item_3', 'not_started', 1, ?)`,
    ).run(T3);
    db.prepare(
      `INSERT INTO study_plan_launch_validations
         (plan_id, plan_item_id, status, capability, resource_id, reason,
          source_fingerprint, validated_at)
       VALUES ('plan_1', 'plan_item_3', 'launchable', 'lesson', ?, NULL, 'manifest-fp', ?)`,
    ).run(JSON.stringify({ learningUnitId: 'unit_1', conceptId: 'con_1' }), T3);

    // Retire the non-assessed item so the formal decision is the last thing
    // holding the window open.
    const agenda = repos.sessionAgendas.get('agenda_1')!;
    const teachingItem = agenda.items.find((item) => item.linkedPlanItemId === 'plan_item_2')!;
    services.agendaWindow.completeTeachingExecution({
      workspaceId: 'ws_1',
      sessionId: 'session_none',
      agenda,
      item: teachingItem,
      plan: repos.studyPlans.get('plan_1')!,
      planItem: repos.studyPlans.get('plan_1')!.items.find((item) => item.id === 'plan_item_2')!,
      commandId: 'retire-second-item',
      at: T3,
    });
    expect(repos.courseExecution.get('ws_1').activeAgendaId).toBe('agenda_1');

    const grade = insertGrade('formal_drain', 1);
    services.formalProgression.registerAssessmentContracts({
      workspaceId: 'ws_1',
      quizId: grade.quizId,
      agendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
    });
    const reconciled = services.formalProgression.reconcileAfterGrading(grade.gradingResultId)!;
    expect(reconciled.decisions[0]?.kind).toBe('complete');

    const successorId = repos.courseExecution.get('ws_1').activeAgendaId!;
    const successor = repos.sessionAgendas.get(successorId)!;
    expect(successorId).not.toBe('agenda_1');
    expect(repos.sessionAgendas.get('agenda_1')!.status).toBe('completed');
    expect(successor.status).toBe('active');
    expect(successor.items.map((item) => item.linkedPlanItemId)).toEqual(['plan_item_3']);
    expect(repos.studyPlans.get('plan_1')!.status).toBe('accepted');
    expect(repos.formalProgression.listGoalOutcomes('ws_1')).toHaveLength(0);
  });
});

describe('Mastery Red Team shadow service', () => {
  it('starts one grounded shadow challenge and deduplicates the run identity', async () => {
    const { targetId } = await seedEligibleMasteryRedTeamState('red_team_start');

    const first = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-start-1',
    });
    const replay = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-start-1',
    });

    expect(replay.run.id).toBe(first.run.id);
    expect(first.run).toMatchObject({
      status: 'selected',
      selectedFamily: 'near_neighbor_confusion',
    });
    expect(first.snapshot.evidence.length).toBeGreaterThan(0);
    expect(first.snapshot.hypotheses.map((item) => item.family)).toEqual(
      expect.arrayContaining(['transfer', 'boundary_conditions']),
    );
    expect(first.candidates).toHaveLength(3);
    expect(first.candidates.filter((candidate) => candidate.selected)).toHaveLength(1);
    const version = repos.formalAssessments.getVersion(first.run.assessmentVersionId!)!;
    expect(version).toMatchObject({
      status: 'accepted',
      authorityMode: 'mastery_red_team_shadow',
      progressionContext: null,
    });
    expect(() => services.learnerAssessments.start(version.id, 'ws_1')).toThrow(/不存在|失效/);
    expect(() => services.formalAssessments.startAttempt(version.id, 'ws_1')).toThrow(
      /接受的正式评估版本/,
    );
    expect(repos.masteryRedTeam.listRunsForTarget(targetId)).toHaveLength(1);
    await expect(
      services.masteryRedTeam.start({
        workspaceId: 'ws_1',
        reviewTargetId: targetId,
        idempotencyKey: 'red-team-start-1',
        parentRunId: 'different-parent-run',
      }),
    ).rejects.toThrow(/不同的目标或父运行/);
  });

  it('excludes incomplete synthesis units from the frozen challenge scope', async () => {
    const { targetId } = await seedEligibleMasteryRedTeamState('red_team_synthesis_scope');
    installTwoUnitSynthesisRoute();
    correctCurriculumSourceFingerprints();

    const detail = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-synthesis-scope',
    });

    expect(detail.snapshot.target.synthesisGroupIds).toEqual([]);
    expect(
      detail.snapshot.target.relatedObjectives.some(
        (objective) => objective.learningUnitId === 'unit_2',
      ),
    ).toBe(false);
    expect(
      detail.snapshot.sources.every((source) => !source.learningUnitIds.includes('unit_2')),
    ).toBe(true);
  });

  it('projects only operation-local aliases and bounded semantic context to Hy3', async () => {
    const { targetId } = await seedEligibleMasteryRedTeamState('red_team_provider_aliases');
    repos.misconceptions.insert({
      id: 'internal_misconception_do_not_expose',
      workspaceId: 'ws_1',
      conceptId: 'con_1',
      conceptName: 'Working memory',
      originBlueprintId: null,
      originQuestionId: 'question_historical',
      originQuizId: 'quiz_historical',
      learnerAnswer: {
        questionId: 'question_historical',
        type: 'single_choice',
        selectedOptionIds: ['B'],
      },
      evidence: [makeGrounding()],
      category: 'definition_confusion',
      hypothesis: 'The learner may confuse capacity with duration.',
      provider: 'fake',
      status: 'resolved',
      decidedByQuizId: 'quiz_resolution',
      createdAt: T0,
      updatedAt: T3,
    });
    const proposal = vi.spyOn(provider, 'proposeMasteryChallenges');

    await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-provider-aliases',
    });

    const providerInput = proposal.mock.calls[0]![0];
    expect(providerInput.historicalSummaries).toEqual([
      {
        summaryRef: 'H1',
        summary: 'The learner may confuse capacity with duration.',
      },
    ]);
    expect(JSON.stringify(providerInput)).not.toContain('internal_misconception_do_not_expose');
    expect(providerInput.objectives[1]).toMatchObject({
      objectiveRef: 'O2',
      title: 'Identify capacity',
      description: 'Identify the source-stated limit on working-memory capacity.',
      primary: false,
    });
    expect(providerInput.sources.every((source) => /^S[1-9][0-9]*$/.test(source.sourceRef))).toBe(
      true,
    );
  });

  it('bounds mature historical observations instead of rejecting an otherwise eligible snapshot', async () => {
    const { targetId } = await seedEligibleMasteryRedTeamState('red_team_bounded_history');
    for (let index = 0; index < 65; index += 1) {
      repos.misconceptions.insert({
        id: `bounded_history_misconception_${index}`,
        workspaceId: 'ws_1',
        conceptId: 'con_1',
        conceptName: 'Working memory',
        originBlueprintId: null,
        originQuestionId: `bounded_history_question_${index}`,
        originQuizId: `bounded_history_quiz_${index}`,
        learnerAnswer: {
          questionId: `bounded_history_question_${index}`,
          type: 'single_choice',
          selectedOptionIds: ['B'],
        },
        evidence: [makeGrounding()],
        category: 'definition_confusion',
        hypothesis: `Historical bounded misconception ${index}.`,
        provider: 'fake',
        status: 'resolved',
        decidedByQuizId: `bounded_history_resolution_${index}`,
        createdAt: T0,
        updatedAt: T3,
      });
    }
    const proposal = vi.spyOn(provider, 'proposeMasteryChallenges');

    const detail = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-bounded-history',
    });

    expect(detail.snapshot.misconceptionObservations).toHaveLength(60);
    expect(proposal.mock.calls[0]![0].historicalSummaries).toHaveLength(4);
  });

  it('records a reusable shadow GradeRecord without mutating any authoritative learner state', async () => {
    const { historical, targetId } = await seedEligibleMasteryRedTeamState('red_team_grade');
    const started = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-grade-1',
    });
    const before = authoritativeState(targetId);
    const selected = started.candidates.find((candidate) => candidate.selected)!;

    const evaluated = await services.masteryRedTeam.submit('ws_1', started.run.id, {
      answer: selected.candidate.expectedAnswer,
      submissionKey: 'shadow-submit-1',
    });
    const replay = await services.masteryRedTeam.submit('ws_1', started.run.id, {
      answer: selected.candidate.expectedAnswer,
      submissionKey: 'shadow-submit-1',
    });

    expect(evaluated.evaluation).toMatchObject({
      outcome: 'robust_signal',
      evidenceCreated: false,
      masteryMutated: false,
      progressionMutated: false,
      reviewMutated: false,
      repairMutated: false,
    });
    expect(replay.evaluation?.id).toBe(evaluated.evaluation?.id);
    expect(repos.formalAssessments.getEvidence(historical.evidence.id)).toEqual(
      historical.evidence,
    );
    expect(authoritativeState(targetId)).toEqual(before);
    expect(
      repos.formalAssessments.listEvidenceForGrade(evaluated.evaluation!.gradeRecordId),
    ).toEqual([]);
    expect(repos.formalAssessments.listGrades(evaluated.evaluation!.attemptId)).toHaveLength(1);
    await expect(
      services.masteryRedTeam.submit('ws_1', started.run.id, {
        answer: 'A different answer under the same submission identity.',
        submissionKey: 'shadow-submit-1',
      }),
    ).rejects.toThrow(/不同的答案/);
    await expect(
      services.masteryRedTeam.submit('ws_1', started.run.id, {
        answer: selected.candidate.expectedAnswer,
        submissionKey: 'different-submit-key',
      }),
    ).rejects.toThrow(/另一个提交键/);
  });

  it('keeps a failed adversarial signal advisory and preserves lower-level Evidence', async () => {
    const { historical, targetId } = await seedEligibleMasteryRedTeamState('red_team_gap');
    const started = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-gap-1',
    });
    const before = authoritativeState(targetId);

    const evaluated = await services.masteryRedTeam.submit('ws_1', started.run.id, {
      answer: 'I cannot justify the claim from the offered source.',
      submissionKey: 'shadow-gap-submit-1',
    });

    expect(evaluated.evaluation).toMatchObject({
      outcome: 'possible_gap',
      advisoryRisk: 'possible_hidden_gap',
      proposedNextAction: 'propose_fresh_formal_inspection',
      evidenceCreated: false,
    });
    expect(repos.formalAssessments.getEvidence(historical.evidence.id)).toEqual(
      historical.evidence,
    );
    expect(authoritativeState(targetId)).toEqual(before);
  });

  it('allows one explicit discriminative follow-up and rejects a second successor', async () => {
    const { targetId } = await seedEligibleMasteryRedTeamState('red_team_follow_up');
    const parent = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-follow-up-parent',
    });
    const parentResult = await services.masteryRedTeam.submit('ws_1', parent.run.id, {
      answer: 'The prior response does not establish the supplied condition.',
      submissionKey: 'red-team-follow-up-parent-submit',
    });
    expect(parentResult.evaluation?.outcome).toBe('possible_gap');

    const followUp = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-follow-up-child',
      parentRunId: parent.run.id,
    });
    expect(followUp.run).toMatchObject({
      parentRunId: parent.run.id,
      followUpDepth: 1,
      selectedFamily: 'discriminative_follow_up',
      status: 'selected',
    });
    const followUpResult = await services.masteryRedTeam.submit('ws_1', followUp.run.id, {
      answer: 'The remaining claim is still not justified.',
      submissionKey: 'red-team-follow-up-child-submit',
    });
    expect(followUpResult.evaluation?.outcome).toBe('possible_gap');

    await expect(
      services.masteryRedTeam.start({
        workspaceId: 'ws_1',
        reviewTargetId: targetId,
        idempotencyKey: 'red-team-follow-up-grandchild',
        parentRunId: followUp.run.id,
      }),
    ).rejects.toThrow(/只能进行一次/);
  });

  it('retries a failed shadow grade exactly once under the same submission identity', async () => {
    const { targetId } = await seedEligibleMasteryRedTeamState('red_team_retry');
    const started = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-retry-1',
    });
    const selected = started.candidates.find((candidate) => candidate.selected)!;
    vi.spyOn(provider, 'gradeShortAnswer').mockRejectedValueOnce(ProviderError.network());

    await expect(
      services.masteryRedTeam.submit('ws_1', started.run.id, {
        answer: selected.candidate.expectedAnswer,
        submissionKey: 'shadow-retry-submit-1',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(repos.masteryRedTeam.getRun(started.run.id)).toMatchObject({
      status: 'evaluation_failed',
      submissionKey: 'shadow-retry-submit-1',
      failureCode: 'PROVIDER_ERROR',
    });

    const evaluated = await services.masteryRedTeam.submit('ws_1', started.run.id, {
      answer: selected.candidate.expectedAnswer,
      submissionKey: 'shadow-retry-submit-1',
    });
    expect(evaluated.run.status).toBe('evaluated');
    expect(evaluated.evaluation?.outcome).toBe('robust_signal');
    expect(repos.formalAssessments.listGrades(evaluated.evaluation!.attemptId)).toHaveLength(1);
  });

  it('atomically retries evaluation finalization without duplicating the durable shadow grade', async () => {
    const { targetId } = await seedEligibleMasteryRedTeamState('red_team_finalize_retry');
    const started = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-finalize-retry',
    });
    const selected = started.candidates.find((candidate) => candidate.selected)!;
    db.exec(`
      CREATE TRIGGER fail_red_team_evaluation_completion
      BEFORE UPDATE OF status ON mastery_red_team_runs
      WHEN NEW.status = 'evaluated'
      BEGIN SELECT RAISE(ABORT, 'injected evaluation completion failure'); END;
    `);

    await expect(
      services.masteryRedTeam.submit('ws_1', started.run.id, {
        answer: selected.candidate.expectedAnswer,
        submissionKey: 'red-team-finalize-submit',
      }),
    ).rejects.toThrow(/injected evaluation completion failure/);
    expect(repos.masteryRedTeam.getEvaluationForRun(started.run.id)).toBeUndefined();
    expect(repos.masteryRedTeam.getRun(started.run.id)?.status).toBe('evaluation_failed');
    const attempt = repos.formalAssessments
      .listAttemptsForWorkspace('ws_1')
      .find((candidate) => candidate.assessmentVersionId === started.run.assessmentVersionId)!;
    expect(repos.formalAssessments.listGrades(attempt.id)).toHaveLength(1);

    db.exec('DROP TRIGGER fail_red_team_evaluation_completion');
    const evaluated = await services.masteryRedTeam.submit('ws_1', started.run.id, {
      answer: selected.candidate.expectedAnswer,
      submissionKey: 'red-team-finalize-submit',
    });
    expect(evaluated.run.status).toBe('evaluated');
    expect(evaluated.evaluation?.outcome).toBe('robust_signal');
    expect(repos.formalAssessments.listGrades(attempt.id)).toHaveLength(1);
  });

  it.each(['review_binding', 'source_revision'] as const)(
    'fails closed when the frozen %s becomes stale',
    async (kind) => {
      const { targetId } = await seedEligibleMasteryRedTeamState(`red_team_stale_${kind}`);
      const started = await services.masteryRedTeam.start({
        workspaceId: 'ws_1',
        reviewTargetId: targetId,
        idempotencyKey: `red-team-stale-${kind}`,
      });
      if (kind === 'review_binding') {
        db.prepare(
          'UPDATE memory_schedule_states SET row_version = row_version + 1 WHERE review_target_id = ?',
        ).run(targetId);
      } else {
        const nextMaterial = makeMaterial({
          content: '# Revised memory notes\n\nWorking-memory capacity is context dependent.',
          charCount: 63,
          updatedAt: T3,
        });
        repos.materialRevisions.stage({
          revisionId: 'revision_stale_red_team',
          material: nextMaterial,
          blocks: [
            makeBlock({
              id: 'blk_stale_red_team',
              content: 'Working-memory capacity is context dependent.',
              startOffset: 24,
              endOffset: 68,
            }),
          ],
          originalData: null,
          parserFingerprint: 'parser-stale-red-team',
          contentFingerprint: 'content-stale-red-team',
          parserAttemptId: 'parser_attempt_stale_red_team',
          createdAt: T3,
          expectedActiveRevisionId: revisionId,
        });
        repos.materialRevisions.activate('mat_1', 'revision_stale_red_team', T3, revisionId);
      }

      await expect(
        services.masteryRedTeam.submit('ws_1', started.run.id, {
          answer: started.candidates.find((candidate) => candidate.selected)!.candidate
            .expectedAnswer,
          submissionKey: `shadow-stale-${kind}`,
        }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(repos.masteryRedTeam.getEvaluationForRun(started.run.id)).toBeUndefined();
    },
  );

  it.each(['schema_failure', 'candidate_repair_failure'] as const)(
    'persists an auditable fail-closed run for %s',
    async (fixture) => {
      const { targetId } = await seedEligibleMasteryRedTeamState(`red_team_${fixture}`);
      provider = new FakeProvider({ masteryRedTeamFixture: fixture });
      services = createServices({ repos, provider, clock: fixedClock(T3) });

      await expect(
        services.masteryRedTeam.start({
          workspaceId: 'ws_1',
          reviewTargetId: targetId,
          idempotencyKey: `red-team-${fixture}`,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
      expect(
        repos.masteryRedTeam.findRunByIdempotencyKey('ws_1', `red-team-${fixture}`),
      ).toMatchObject({
        status: 'generation_failed',
        repairAttempted: true,
        failureCode: expect.stringMatching(/^REPAIR_EXHAUSTED:/),
      });
    },
  );

  it('records one bounded candidate repair before selecting the repaired payload', async () => {
    const { targetId } = await seedEligibleMasteryRedTeamState('red_team_repaired');
    provider = new FakeProvider({ masteryRedTeamFixture: 'candidate_repair_once' });
    services = createServices({ repos, provider, clock: fixedClock(T3) });

    const detail = await services.masteryRedTeam.start({
      workspaceId: 'ws_1',
      reviewTargetId: targetId,
      idempotencyKey: 'red-team-repaired',
    });

    expect(detail.run).toMatchObject({ status: 'selected', repairAttempted: true });
    expect(detail.candidates.find((candidate) => candidate.selected)?.validation.valid).toBe(true);
    expect(detail.candidates.some((candidate) => !candidate.validation.valid)).toBe(true);
  });
});
