import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import { createServices } from './index.js';
import { fixedClock } from '../util/ids.js';
import { makeBlock, makeConcept, makeMaterial, T0 } from '../testing/fixtures.js';
import { curriculumSourceBlockFingerprint } from './curriculumValidation.js';

let context: TestApp | undefined;

function installCurrentRoute(
  overrides: {
    progression?: unknown[];
    evidence?: unknown[];
    repairs?: unknown[];
    assessments?: unknown;
    review?: unknown;
    redTeam?: unknown[];
    lesson?: unknown[];
    agendaLaunchStatus?: 'launchable' | 'blocked';
  } = {},
) {
  if (!context) throw new Error('test context is not initialized');
  const { repos } = context;
  const activeRevisionId = repos.materials.get('mat_1')?.activeRevisionId ?? 'revision_1';
  const block = repos.materials.getBlock('blk_1')!;
  const manifest = {
    fingerprint: 'manifest-fp',
    revisions: [
      {
        materialId: 'mat_1',
        materialRevisionId: activeRevisionId,
        sourceBlockRevisionIds: [block.id],
      },
    ],
  };
  const sourceReference = {
    materialId: 'mat_1',
    materialRevisionId: activeRevisionId,
    structuralUnitId: null,
    sourceBlockId: block.id,
    sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(block, activeRevisionId),
  };
  const curriculum = {
    id: 'curriculum_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    version: 1,
    status: 'accepted',
    executionSourceManifest: manifest,
    validation: { valid: true },
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
        title: 'Unit',
        sourceReferences: [sourceReference],
        learningUnit: {
          conceptIds: ['con_1'],
          canonicalConceptIds: [],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
          objectives: [
            {
              id: 'objective_1',
              title: 'Explain',
              description: 'Explain the source.',
              truthPremiseStatus: 'independently_verified',
              truthAuthorityRecordIds: ['authority_1'],
            },
          ],
        },
      },
    ],
    synthesisGroups: [],
  };
  const planItem = {
    id: 'plan_item_1',
    index: 0,
    phase: 'Foundations',
    kind: 'teach_unit',
    curriculumLearningUnitId: 'unit_1',
    rationale: 'Teach the unit.',
    estimatedMinutes: 10,
    targetDepth: 'working_fluency',
    objectiveIds: ['objective_1'],
    prerequisitePlanItemIds: [],
    completionPolicy: null,
    completionRequirements: [],
  };
  const plan = {
    id: 'plan_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    executionSourceManifestFingerprint: manifest.fingerprint,
    version: 1,
    status: 'accepted',
    items: [planItem],
  };
  const agenda = {
    id: 'agenda_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    executionSourceManifestFingerprint: manifest.fingerprint,
    version: 1,
    status: 'active',
    currentItemId: 'agenda_item_1',
    items: [
      {
        id: 'agenda_item_1',
        index: 0,
        kind: 'learning_unit_teaching',
        origin: 'accepted_plan',
        state: 'active',
        linkedPlanItemId: 'plan_item_1',
        learningUnitId: 'unit_1',
        launch: {
          status: overrides.agendaLaunchStatus ?? 'launchable',
          capability: 'teach_unit',
          resourceId: overrides.agendaLaunchStatus === 'blocked' ? null : 'con_1',
          reason:
            overrides.agendaLaunchStatus === 'blocked' ? 'Current source is unavailable.' : null,
        },
      },
    ],
  };
  vi.spyOn(repos.courseExecution, 'get').mockReturnValue({
    workspaceId: 'ws_1',
    version: 1,
    activeContractId: 'contract_1',
    activeCurriculumId: 'curriculum_1',
    acceptedPlanId: 'plan_1',
    activeAgendaId: 'agenda_1',
    routeValidationStatus: 'valid',
    executionStatus: 'active',
    updatedAt: T0,
  } as never);
  vi.spyOn(repos.learningContracts, 'get').mockReturnValue({
    id: 'contract_1',
    workspaceId: 'ws_1',
    status: 'active',
  } as never);
  vi.spyOn(repos.curricula, 'get').mockReturnValue(curriculum as never);
  vi.spyOn(repos.curricula, 'list').mockReturnValue([curriculum] as never);
  vi.spyOn(repos.studyPlans, 'get').mockReturnValue(plan as never);
  vi.spyOn(repos.studyPlans, 'list').mockReturnValue([plan] as never);
  vi.spyOn(repos.studyPlans, 'listProgress').mockReturnValue([]);
  vi.spyOn(repos.sessionAgendas, 'get').mockReturnValue(agenda as never);
  vi.spyOn(repos.formalProgression, 'listUnitProgress').mockReturnValue(
    (overrides.progression ?? []) as never,
  );
  vi.spyOn(repos.formalProgression, 'listEvidenceForRoute').mockReturnValue(
    (overrides.evidence ?? []) as never,
  );
  vi.spyOn(repos.formalProgression, 'listEvidenceForWorkspace').mockReturnValue(
    (overrides.evidence ?? []) as never,
  );
  vi.spyOn(repos.formalAssessments, 'listProjectionRecords').mockReturnValue(
    (overrides.assessments ?? {
      versions: [],
      attempts: [],
      grades: [],
      evidence: [],
      reconciliations: [],
    }) as never,
  );
  vi.spyOn(repos.repair, 'listByWorkspace').mockReturnValue((overrides.repairs ?? []) as never);
  vi.spyOn(repos.lessonExecution, 'listForRoute').mockReturnValue(
    (overrides.lesson ?? []) as never,
  );
  vi.spyOn(repos.reviewSuccessor, 'listProjectionRecords').mockReturnValue(
    (overrides.review ?? {
      targets: [],
      bindings: [],
      states: [],
      executions: [],
      events: [],
    }) as never,
  );
  vi.spyOn(repos.masteryRedTeam, 'listProjectionRecords').mockReturnValue(
    (overrides.redTeam ?? []) as never,
  );
}

afterEach(async () => {
  await context?.app.close();
  context = undefined;
});

describe('Knowledge Map projection service', () => {
  it('projects a fresh course as unconfigured without inventing learner state', () => {
    context = buildTestApp();
    const { repos } = context;
    const before = {
      mastery: repos.mastery.listByWorkspace('ws_1'),
      mistakes: repos.mistakes.listOpenByWorkspace('ws_1'),
      execution: repos.courseExecution.get('ws_1'),
    };
    const services = createServices({ repos, provider: context.provider, clock: fixedClock(T0) });

    const first = services.knowledgeMap.get('ws_1');
    const second = services.knowledgeMap.get('ws_1');

    expect(first.status).toBe('unconfigured');
    expect(first.route.current).toBe(false);
    expect(first.nodes).toEqual([]);
    expect(second).toEqual(first);
    expect(repos.mastery.listByWorkspace('ws_1')).toEqual(before.mastery);
    expect(repos.mistakes.listOpenByWorkspace('ws_1')).toEqual(before.mistakes);
    expect(repos.courseExecution.get('ws_1')).toEqual(before.execution);
  });

  it('is exposed through the course-scoped GET route and returns the shared envelope', async () => {
    context = buildTestApp();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/workspaces/ws_1/knowledge-map',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      projection: { projectionVersion: string; workspaceId: string };
    };
    expect(body.projection).toMatchObject({
      projectionVersion: 'knowledge-map-projection-v1',
      workspaceId: 'ws_1',
    });
  });

  it('projects active source concepts without creating a second mastery authority', () => {
    context = buildTestApp();
    const { repos } = context;
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.materials.addConcepts([makeConcept()]);
    const services = createServices({ repos, provider: context.provider, clock: fixedClock(T0) });

    const projection = services.knowledgeMap.get('ws_1');
    expect(projection.nodes).toHaveLength(1);
    expect(projection.nodes[0]).toMatchObject({
      kind: 'concept',
      id: 'concept:con_1',
      learner: { primaryState: 'not_started', legacyMastery: null },
      weaknesses: [],
    });
    expect(projection.nodes[0]?.provenance[0]).toMatchObject({
      kind: 'source_concept_grounding',
      exactQuoteValidated: true,
      semanticEntailmentClaimed: false,
    });
  });

  it('keeps Repair, Review, formal failure, and Red Team advisory signals distinct', () => {
    context = buildTestApp();
    const { repos } = context;
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.materials.addConcepts([makeConcept()]);
    installCurrentRoute({
      evidence: [
        {
          id: 'formal_failure_1',
          curriculumLearningUnitId: 'unit_1',
          stateCreditable: false,
          correct: false,
          needsReview: false,
          admissibilityTier: 'tier_1_authorized_truth',
          createdAt: T0,
        },
      ],
      repairs: [
        {
          id: 'repair_1',
          status: 'ACTIVE',
          targetLearningUnitId: 'unit_1',
          assessmentVersionId: 'assessment_1',
          updatedAt: T0,
        },
      ],
      assessments: {
        versions: [
          {
            id: 'assessment_1',
            progressionContext: {
              curriculumVersionId: 'curriculum_1',
              studyPlanVersionId: 'plan_1',
            },
          },
        ],
        attempts: [],
        grades: [],
        evidence: [],
        reconciliations: [],
      },
      review: {
        targets: [{ id: 'review_target_1', status: 'active', currentBindingVersion: 1 }],
        bindings: [
          {
            reviewTargetId: 'review_target_1',
            bindingVersion: 1,
            contractVersionId: 'contract_1',
            curriculumVersionId: 'curriculum_1',
            learningUnitId: 'unit_1',
            executionSourceManifestFingerprint: 'manifest-fp',
            validTo: null,
          },
        ],
        states: [
          {
            reviewTargetId: 'review_target_1',
            lifecycleState: 'review',
            dueAt: '2025-12-31T00:00:00.000Z',
            updatedAt: T0,
          },
        ],
        executions: [{ reviewTargetId: 'review_target_1', status: 'completed', updatedAt: T0 }],
        events: [{ reviewTargetId: 'review_target_1', kind: 'retrieval_failure', occurredAt: T0 }],
      },
      redTeam: [
        {
          evaluation: { id: 'red_eval_1', outcome: 'possible_gap', createdAt: T0 },
          run: { status: 'evaluated' },
          snapshot: {
            route: {
              contractVersionId: 'contract_1',
              curriculumVersionId: 'curriculum_1',
              studyPlanVersionId: 'plan_1',
              agendaId: 'agenda_1',
              executionSourceManifestFingerprint: 'manifest-fp',
            },
            target: { learningUnitId: 'unit_1' },
          },
        },
      ],
    });
    const projection = createServices({
      repos,
      provider: context.provider,
      clock: fixedClock(T0),
    }).knowledgeMap.get('ws_1');
    const unit = projection.nodes.find((node) => node.kind === 'learning_unit');
    expect(unit?.learner.primaryState).toBe('repair');
    expect(unit?.weaknesses.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        'formal_failure',
        'active_repair',
        'review_due',
        'retrievability_concern',
        'mastery_red_team_possible_gap',
      ]),
    );
    expect(
      unit?.weaknesses.find((item) => item.kind === 'mastery_red_team_possible_gap'),
    ).toMatchObject({ advisory: true, actionable: false });
    expect(unit?.learner.formalValidation).toBe('current_failure');
    expect(unit?.navigation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destination: 'study', learningUnitId: 'unit_1' }),
        expect.objectContaining({
          destination: 'progress',
          learningUnitId: 'unit_1',
          objectiveId: 'objective_1',
        }),
        expect.objectContaining({
          destination: 'progress',
          repairEpisodeId: 'repair_1',
        }),
        expect.objectContaining({
          destination: 'progress',
          reviewTargetId: 'review_target_1',
        }),
      ]),
    );
  });

  it('does not turn a due Review into weak mastery and clears the concern after recovery', () => {
    context = buildTestApp();
    const { repos } = context;
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.materials.addConcepts([makeConcept()]);
    const review = {
      targets: [{ id: 'review_target_1', status: 'active', currentBindingVersion: 1 }],
      bindings: [
        {
          reviewTargetId: 'review_target_1',
          bindingVersion: 1,
          contractVersionId: 'contract_1',
          curriculumVersionId: 'curriculum_1',
          learningUnitId: 'unit_1',
          executionSourceManifestFingerprint: 'manifest-fp',
          validTo: null,
        },
      ],
      states: [
        {
          reviewTargetId: 'review_target_1',
          lifecycleState: 'review',
          dueAt: '2025-12-31T00:00:00.000Z',
          updatedAt: T0,
        },
      ],
      executions: [],
      events: [
        { reviewTargetId: 'review_target_1', kind: 'fresh_verification_success', occurredAt: T0 },
      ],
    };
    installCurrentRoute({ review });
    const projection = createServices({
      repos,
      provider: context.provider,
      clock: fixedClock(T0),
    }).knowledgeMap.get('ws_1');
    const unit = projection.nodes.find((node) => node.kind === 'learning_unit');
    expect(unit?.learner.primaryState).toBe('planned');
    expect(unit?.learner.primaryState).not.toBe('weak');
    expect(unit?.weaknesses.map((item) => item.kind)).toEqual(['review_due']);
    expect(unit?.weaknesses).not.toContainEqual(
      expect.objectContaining({ kind: 'retrievability_concern' }),
    );
    expect(unit?.navigation).toContainEqual(
      expect.objectContaining({
        destination: 'progress',
        reviewTargetId: 'review_target_1',
      }),
    );
  });

  it('does not project a Study action for a blocked current agenda item', () => {
    context = buildTestApp();
    const { repos } = context;
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.materials.addConcepts([makeConcept()]);
    installCurrentRoute({ agendaLaunchStatus: 'blocked' });

    const projection = createServices({
      repos,
      provider: context.provider,
      clock: fixedClock(T0),
    }).knowledgeMap.get('ws_1');

    expect(
      projection.nodes.find((node) => node.kind === 'learning_unit')?.navigation,
    ).not.toContainEqual(expect.objectContaining({ destination: 'study' }));
  });

  it('fails closed when the accepted route source manifest is stale', () => {
    context = buildTestApp();
    const { repos } = context;
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.materials.addConcepts([makeConcept()]);
    installCurrentRoute();
    const plan = repos.studyPlans.get('plan_1') as { executionSourceManifestFingerprint: string };
    plan.executionSourceManifestFingerprint = 'stale-plan-manifest';
    const projection = createServices({
      repos,
      provider: context.provider,
      clock: fixedClock(T0),
    }).knowledgeMap.get('ws_1');
    expect(projection.status).toBe('unknown');
    expect(projection.route.current).toBe(false);
    expect(projection.route.unknownReasons).toContain('source_manifest_mismatch');
    expect(
      projection.nodes.find((node) => node.kind === 'learning_unit')?.learner.primaryState,
    ).toBe('unknown');
    expect(
      projection.nodes.find((node) => node.kind === 'learning_unit')?.navigation,
    ).not.toContainEqual(expect.objectContaining({ destination: 'study' }));
  });

  it('returns 404 for a foreign workspace without touching state', async () => {
    context = buildTestApp();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/workspaces/does-not-exist/knowledge-map',
    });
    expect(response.statusCode).toBe(404);
  });
});
