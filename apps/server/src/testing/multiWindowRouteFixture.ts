import type {
  Curriculum,
  LearningContract,
  LearningContractFeasibility,
  StudyPlan,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import type { Repositories } from '../repositories/index.js';
import { buildCurriculumExecutionContext } from '../services/curriculum.js';
import {
  makeBlock,
  makeConcept,
  makeMaterial,
  makeSemanticallySupportedObjective,
  makeWorkspace,
  T0,
} from './fixtures.js';

const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const T3 = '2026-01-01T00:03:00.000Z';

export interface MultiWindowRouteFixture {
  contract: LearningContract;
  curriculum: Curriculum;
  plan: StudyPlan;
  planItemIds: string[];
  learningUnitId: string;
}

/**
 * An accepted teaching-only Course route whose StudyPlan holds `teachUnitCount`
 * `teach_unit` items, sized so the Contract's session budget yields more than
 * one Agenda window. Built through the same repositories and the same
 * `resolveLaunchForPlanItem`-backed launch validations production uses, so a
 * composed successor Agenda matches its stored launchability exactly.
 */
export function seedMultiWindowTeachingRoute(
  db: SqliteDb,
  repos: Repositories,
  options: {
    teachUnitCount: number;
    preferredSessionMinutes: number;
    estimatedMinutesPerItem: number;
  },
): MultiWindowRouteFixture {
  const objectiveIds = Array.from(
    { length: options.teachUnitCount },
    (_, index) => `objective_${index + 1}`,
  );
  repos.workspaces.insert(makeWorkspace({ name: 'Multi-window course' }));
  repos.materials.insertWithBlocks(makeMaterial({ title: 'Course notes' }), [makeBlock()]);
  repos.materials.replaceConcepts('mat_1', [makeConcept()]);
  const revisionId = repos.materialRevisions.getActive('mat_1')!.id;
  const block = repos.materials.getBlock('blk_1')!;
  for (const [id, premiseKind, claimId, logicalId] of [
    ['authority_1', 'expected_answer', 'claim_1', 'logical_truth_1'],
    ['authority_rubric_1', 'rubric_point', 'claim_rubric_1', 'logical_rubric_1'],
  ] as const) {
    repos.sourceAuthority.createVersion({
      id,
      workspaceId: 'ws_1',
      logicalSourceId: logicalId,
      materialId: 'mat_1',
      materialRevisionId: revisionId,
      predecessorId: null,
      premiseScope: block.content,
      policyBasis: {
        policyVersion: 'truth-v1',
        premiseKind,
        basis: `independently admitted ${premiseKind}`,
      },
      validationState: 'validated',
      conflictState: 'none',
      actor: 'local_validator',
      createdAt: T0,
      updatedAt: T0,
      claims: [
        {
          id: claimId,
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
        id: `${id}_event`,
        eventType: 'validated',
        actor: 'local_validator',
        payload: {},
        createdAt: T0,
      },
    });
  }

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
    intent: 'Learn the source material across several sessions.',
    targetOutcome: { description: 'Working fluency', targetScore: 80, credential: null },
    deadline: null,
    studyBudget: {
      minutesPerDay: options.preferredSessionMinutes,
      minutesPerWeek: null,
      preferredSessionMinutes: options.preferredSessionMinutes,
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
          role: 'course_material',
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
    projectedMinutes: options.estimatedMinutesPerItem * options.teachUnitCount,
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
        title: 'Course',
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
        ],
        learningUnit: {
          conceptIds: ['con_1'],
          canonicalConceptIds: [],
          objectives: objectiveIds.map((objectiveId, index) =>
            makeSemanticallySupportedObjective(
              {
                id: objectiveId,
                title: `Explain part ${index + 1}`,
                description: `Explain source-stated part ${index + 1} of working-memory capacity.`,
                truthPremiseStatus: 'independently_verified',
                truthAuthorityRecordIds: ['authority_1', 'authority_rubric_1'],
                authorityClaimIds: ['claim_1', 'claim_rubric_1'],
                priority: index === 0 ? 'required' : 'normal',
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
          ),
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
    { id: 'curriculum_created', eventType: 'proposed', actor: 'local', payload: {}, createdAt: T0 },
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
    rationale: 'Teach the source in order.',
    items: objectiveIds.map((objectiveId, index) => ({
      id: `plan_item_${index + 1}`,
      index,
      phase: 'Foundations',
      kind: 'teach_unit' as const,
      curriculumLearningUnitId: 'unit_1',
      rationale: `Teach ${objectiveId}.`,
      estimatedMinutes: options.estimatedMinutesPerItem,
      targetDepth: 'working_fluency' as const,
      objectiveIds: [objectiveId],
      prerequisitePlanItemIds: [],
      completionPolicy: { id: 'completion-policy', version: 1 },
      completionRequirements: [
        {
          id: `requirement_${objectiveId}`,
          objectiveIds: [objectiveId],
          description: `Verify ${objectiveId}.`,
          blocking: false,
          admissibilityTier: 'tier_1_authorized_truth' as const,
        },
      ],
    })),
    deferrals: [],
    feasibility: {
      projectedMinutes: options.estimatedMinutesPerItem * options.teachUnitCount,
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
      // Same shape resolveLaunchForPlanItem produces for a teach_unit, so a
      // composed successor Agenda cannot "overstate" its launchability.
      launch: {
        status: 'launchable' as const,
        capability: 'lesson',
        resourceId: JSON.stringify({ learningUnitId: 'unit_1', conceptId: 'con_1' }),
        reason: null,
      },
      sourceFingerprint: 'manifest-fp',
      validatedAt: T2,
    })),
    { id: 'plan_created', eventType: 'proposed', actor: 'local', payload: {}, createdAt: T2 },
  );
  db.prepare(
    `UPDATE curriculum_versions SET manifest_id = 'manifest_1' WHERE id = 'curriculum_1'`,
  ).run();

  return {
    contract: confirmedContract,
    curriculum: acceptedCurriculum,
    plan,
    planItemIds: plan.items.map((item) => item.id),
    learningUnitId: 'unit_1',
  };
}

export { T1, T2, T3 };
