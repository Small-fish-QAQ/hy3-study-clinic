import { beforeEach, describe, expect, it } from 'vitest';
import {
  FormalQuestionContractSchema,
  type Curriculum,
  type LearningContract,
  type LearningContractFeasibility,
  type SessionAgenda,
  type StudyPlan,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import {
  makeBlock,
  makeConcept,
  makeGrounding,
  makeMaterial,
  makeQuestion,
  makeQuiz,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createServices, type Services } from './index.js';

const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const T3 = '2026-01-01T00:03:00.000Z';

let db: SqliteDb;
let repos: Repositories;
let services: Services;
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
    revisions: [
      {
        materialId: 'mat_1',
        materialRevisionId: revisionId,
        parserVersion: 'text-v1',
        parserFingerprint: null,
        sourceBlockRevisionIds: ['blk_1', 'blk_2'],
      },
    ],
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
            {
              id: 'objective_1',
              title: 'Explain capacity',
              description: 'Explain the capacity limit.',
              truthPremiseStatus: 'independently_verified',
              truthAuthorityRecordIds: [authorityId, rubricAuthorityId],
            },
            {
              id: 'objective_2',
              title: 'Apply capacity',
              description: 'Apply the capacity limit.',
              truthPremiseStatus: 'independently_verified',
              truthAuthorityRecordIds: [authorityId, rubricAuthorityId],
            },
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
  repos.curricula.createVersion(curriculum, {
    id: 'curriculum_created',
    eventType: 'proposed',
    actor: 'local',
    payload: {},
    createdAt: T0,
  });
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
      kind: 'teach_unit' as const,
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
        capability: 'lesson',
        resourceId: JSON.stringify({ conceptId: 'con_1' }),
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
      kind: 'learning_unit_teaching' as const,
      origin: 'accepted_plan' as const,
      reason: item.rationale,
      estimatedMinutes: item.estimatedMinutes,
      linkedPlanItemId: item.id,
      learningUnitId: 'unit_1',
      priority: 'high' as const,
      state: 'queued' as const,
      launch: {
        status: 'launchable' as const,
        capability: 'lesson',
        resourceId: JSON.stringify({ conceptId: 'con_1' }),
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

function insertGrade(suffix: string, score: number, blockId = 'blk_1') {
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
          options: undefined,
          correctOptionIds: undefined,
          expectedAnswer: admittedPremise,
          rubric: { keyPoints: [{ text: admittedPremise, required: true }] },
          grounding: makeGrounding({ blockId }),
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

function installTwoUnitSynthesisRoute() {
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
  const secondAuthorityIds = admitted
    .filter((bundle) => bundle.claims.some((claim) => claim.sourceBlockId === secondBlock.id))
    .map((bundle) => bundle.record.id);
  expect(secondAuthorityIds).toHaveLength(2);

  const curriculum = repos.curricula.get('curriculum_1')!;
  const secondObjectiveId = 'objective_synthesis_2';
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
        sourceBlockRevisionFingerprint: 'block-fp-2',
      },
    ],
    learningUnit: {
      conceptIds: ['con_2'],
      canonicalConceptIds: [],
      objectives: [
        {
          id: secondObjectiveId,
          title: 'Apply the second source premise',
          description: 'Use the second source premise in an integrated response.',
          truthPremiseStatus: 'independently_verified' as const,
          truthAuthorityRecordIds: secondAuthorityIds,
        },
      ],
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
  ).run(curriculum.id, secondUnit.id, 0, 'mat_1', revisionId, null, secondBlock.id, 'block-fp-2');
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
  return { ...actions, secondBlock, secondObjectiveId };
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
  services = createServices({ repos, provider: new FakeProvider(), clock: fixedClock(T3) });
});

describe('formal progression service', () => {
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
                  description: 'Verify the application objective.',
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
    expect(repos.formalProgression.listQuestionContractsForQuiz(launched.quiz.id)[0]).toMatchObject(
      { studySessionId: session.id, admissibilityTier: 'tier_1_authorized_truth' },
    );
    expect(
      repos.telemetry.usageSummaryForScope('ws_1', {
        scopeType: 'session',
        scopeKey: session.id,
      }),
    ).toMatchObject({ logicalCalls: 1, physicalAttempts: 1 });
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
    const grade = insertGrade('ambiguous_objective', 1);

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
});
