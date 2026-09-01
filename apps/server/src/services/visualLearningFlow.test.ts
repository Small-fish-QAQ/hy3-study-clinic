import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  ApiErrorCode,
  type ConceptAnalysisPayload,
  type CurriculumProposalPayload,
  type LearningContractDraftFields,
  type ObjectiveAuthoritySemanticEvaluationInput,
  type VisualDescriptionPayload,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type {
  ConceptAnalysisInput,
  CourseMapProposalInput,
  CurriculumDetailProposalInput,
  CurriculumProposalInput,
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  ProviderCallOptions,
  StudyPlanProposalInput,
  TutorTurnInput,
  VisualDescriptionInput,
} from '../llm/provider.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import { T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createServices } from './index.js';

const WORKSPACE_ID = 'ws_1';
const VISUAL_DESCRIPTION =
  'A water cycle diagram shows evaporation rising from a lake, condensation forming clouds, and precipitation returning water to the surface.';
const WATER_CYCLE_AUTHORITY = `# Water cycle

Liquid water evaporates from the surface into water vapor. Cooling water vapor condenses into clouds, and precipitation returns water from clouds to the surface. These stages move water through a repeating cycle.`;
const testApps: TestApp[] = [];

class VisualLearningProvider extends FakeProvider {
  analyzeCalls = 0;
  visualCalls = 0;
  curriculumProposalCalls = 0;
  curriculumInput: CurriculumProposalInput | null = null;
  courseMapInput: CourseMapProposalInput | null = null;
  curriculumDetailInputs: CurriculumDetailProposalInput[] = [];
  lessonSlotContentInput: LessonSlotContentGenerationInput | null = null;
  practiceContentInput: PracticeContentGenerationInput | null = null;
  tutorInput: TutorTurnInput | null = null;
  objectiveAuthorityInputs: ObjectiveAuthoritySemanticEvaluationInput[] = [];

  constructor(private readonly targetVisualCall = 1) {
    super();
  }

  override async describeVisual(
    _input: VisualDescriptionInput,
    opts?: ProviderCallOptions,
  ): Promise<VisualDescriptionPayload> {
    this.visualCalls += 1;
    const target = this.visualCalls === this.targetVisualCall;
    const candidate: VisualDescriptionPayload = target
      ? {
          description: VISUAL_DESCRIPTION,
          visualType: 'diagram',
          visibleText: null,
          importantConcepts: ['water cycle', 'evaporation', 'condensation', 'precipitation'],
          pedagogicalNotes: ['Trace the arrows to explain how water moves between each stage.'],
          uncertainty: [
            'The diagram is advisory and does not independently establish causal claims.',
          ],
        }
      : {
          description: `An ornamental geometry panel number ${this.visualCalls} with repeated shapes.`,
          visualType: 'illustration',
          visibleText: null,
          importantConcepts: [`ornamental pattern ${this.visualCalls}`],
          pedagogicalNotes: ['Use the repeated shapes as optional decorative context.'],
          uncertainty: [],
        };
    const validation = opts?.validateCandidate?.(candidate);
    if (validation && !validation.valid) {
      throw new Error(validation.diagnostics.join('; '));
    }
    return candidate;
  }

  override async analyzeConcepts(
    input: ConceptAnalysisInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptAnalysisPayload> {
    this.analyzeCalls += 1;
    return super.analyzeConcepts(input, opts);
  }

  override async proposeCurriculum(
    input: CurriculumProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload> {
    this.curriculumProposalCalls += 1;
    this.curriculumInput = input;
    return super.proposeCurriculum(input, opts);
  }

  override async proposeCourseMap(input: CourseMapProposalInput, opts?: ProviderCallOptions) {
    this.courseMapInput = input;
    return super.proposeCourseMap(input, opts);
  }

  override async proposeCurriculumDetails(
    input: CurriculumDetailProposalInput,
    opts?: ProviderCallOptions,
  ) {
    this.curriculumDetailInputs.push(input);
    return super.proposeCurriculumDetails(input, opts);
  }

  override async proposeStudyPlan(input: StudyPlanProposalInput, opts?: ProviderCallOptions) {
    const targetUnit = input.units.find((unit) =>
      unit.title.toLocaleLowerCase().includes('water cycle'),
    );
    return super.proposeStudyPlan(
      targetUnit
        ? {
            ...input,
            requiredLearningUnitIds: [
              targetUnit.id,
              ...input.requiredLearningUnitIds.filter((unitId) => unitId !== targetUnit.id),
            ],
          }
        : input,
      opts,
    );
  }

  override async evaluateObjectiveAuthoritySupport(
    input: ObjectiveAuthoritySemanticEvaluationInput,
    opts?: ProviderCallOptions,
  ) {
    this.objectiveAuthorityInputs.push(structuredClone(input));
    return super.evaluateObjectiveAuthoritySupport(input, opts);
  }

  override async generateLessonSlotContent(
    input: LessonSlotContentGenerationInput,
    opts?: ProviderCallOptions,
  ) {
    this.lessonSlotContentInput = input;
    return super.generateLessonSlotContent(input, opts);
  }

  override async generatePracticeContent(
    input: PracticeContentGenerationInput,
    opts?: ProviderCallOptions,
  ) {
    this.practiceContentInput = input;
    return super.generatePracticeContent(input, opts);
  }

  override async respondToTutorTurn(input: TutorTurnInput, opts?: ProviderCallOptions) {
    this.tutorInput = input;
    return super.respondToTutorTurn(input, opts);
  }
}

function command(id: string, actor: 'learner' | 'local' = 'learner') {
  return {
    commandId: id,
    idempotencyKey: id,
    workspaceId: WORKSPACE_ID,
    actor,
  } as const;
}

function contractFields(
  materials: LearningContractDraftFields['courseScope']['materials'],
): LearningContractDraftFields {
  return {
    intent: 'Learn the water cycle shown in the course diagram.',
    targetOutcome: {
      description: 'Explain the stages and direction of the water cycle.',
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
      subjectBoundaries: ['Earth science'],
      materials,
      includedTopics: ['Water cycle'],
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

async function pngBase64(variant = 0): Promise<string> {
  return (
    await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 20 + variant, g: 130 + variant, b: 210 - variant },
      },
    })
      .png()
      .toBuffer()
  ).toString('base64');
}

async function addWaterCycleAuthorityMaterial(
  ctx: TestApp,
  services: ReturnType<typeof createServices>,
  commandPrefix: string,
): Promise<LearningContractDraftFields['courseScope']['materials'][number]> {
  const uploaded = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${WORKSPACE_ID}/documents`,
    payload: {
      kind: 'text',
      filename: 'water-cycle-authority.md',
      content: WATER_CYCLE_AUTHORITY,
    },
  });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const materialId = uploaded.json().material.id as string;
  const roleProposal = services.materialRoles.propose({
    command: command(`${commandPrefix}-role-propose`, 'local'),
    materialId,
    role: 'course_material',
    expectedCurrentAssignmentId: ctx.repos.materialRoles.getCurrent(materialId)!.id,
  });
  const role = services.materialRoles.confirm({
    command: command(`${commandPrefix}-role-confirm`),
    assignmentId: roleProposal.id,
    expectedVersion: roleProposal.version,
  });
  return {
    materialId,
    materialRoleAssignmentId: role.id,
    materialRoleAssignmentVersion: role.version,
    role: 'course_material',
    disposition: 'included',
  };
}

afterEach(async () => {
  while (testApps.length > 0) await testApps.pop()!.app.close();
});

describe('prepared standalone-image advisory learning flow', () => {
  it('fails closed when an image-only course has no authoritative text for its objectives', async () => {
    const provider = new VisualLearningProvider();
    const clock = fixedClock(T0);
    const ctx = buildTestApp({ provider, clock });
    testApps.push(ctx);

    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${WORKSPACE_ID}/documents`,
      payload: {
        kind: 'file',
        filename: 'water-cycle-only.png',
        mediaType: 'image/png',
        dataBase64: await pngBase64(),
      },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const materialId = uploaded.json().material.id as string;
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${WORKSPACE_ID}/documents/${materialId}/visuals`,
    });
    const visualRef = listed.json().visuals[0].visualRef as string;
    const preparedVisual = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${WORKSPACE_ID}/documents/${materialId}/visuals/${visualRef}/prepare`,
      payload: { commandId: 'prepare-image-only-water-cycle' },
    });
    expect(preparedVisual.statusCode, preparedVisual.body).toBe(200);

    const services = createServices({ repos: ctx.repos, provider, clock });
    const roleProposal = services.materialRoles.propose({
      command: command('image-only-role-propose', 'local'),
      materialId,
      role: 'course_material',
      expectedCurrentAssignmentId: ctx.repos.materialRoles.getCurrent(materialId)!.id,
    });
    const role = services.materialRoles.confirm({
      command: command('image-only-role-confirm'),
      assignmentId: roleProposal.id,
      expectedVersion: roleProposal.version,
    });
    const draft = services.learningContracts.createDraft({
      command: command('image-only-contract-create'),
      fields: contractFields([
        {
          materialId,
          materialRoleAssignmentId: role.id,
          materialRoleAssignmentVersion: role.version,
          role: 'course_material',
          disposition: 'included',
        },
      ]),
      predecessorContractId: null,
      expectedActiveContractId: null,
    }).contract;
    const proposed = services.learningContracts.transition({
      command: command('image-only-contract-propose'),
      contractId: draft.id,
      expectedVersion: draft.version,
      transition: 'propose',
    }).contract;
    services.learningContracts.transition({
      command: command('image-only-contract-confirm'),
      contractId: proposed.id,
      expectedVersion: proposed.version,
      transition: 'confirm',
    });

    const preparation = services.coursePreparation.get(WORKSPACE_ID);
    await expect(
      services.coursePreparation.run({
        command: command(preparation.operationKey!),
        expectedRevision: preparation.revision,
      }),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ProviderInvalidOutput,
      details: {
        validationKind: 'candidate',
        candidateFailure: {
          kind: 'curriculum_objective_authority_unavailable',
          diagnostics: [
            {
              code: 'visual_only_material_cannot_originate_objective',
              message: expect.stringContaining('advisory visual-only Materials'),
            },
          ],
        },
      },
    });
    expect(provider.analyzeCalls).toBe(0);
    expect(provider.curriculumProposalCalls).toBe(0);
    expect(provider.curriculumInput).toBeNull();
    expect(provider.objectiveAuthorityInputs).toEqual([]);
    expect(ctx.repos.curricula.list(WORKSPACE_ID)).toEqual([]);
    expect(ctx.repos.studyPlans.list(WORKSPACE_ID)).toEqual([]);
    expect(ctx.repos.formalProgression.listEvidenceForWorkspace(WORKSPACE_ID)).toEqual([]);
  });

  it('keeps visual semantics advisory while enabling source-backed teaching through Tutor', async () => {
    const provider = new VisualLearningProvider();
    const clock = fixedClock(T0);
    const ctx = buildTestApp({ provider, clock });
    testApps.push(ctx);

    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${WORKSPACE_ID}/documents`,
      payload: {
        kind: 'file',
        filename: 'misleading-receipt.png',
        mediaType: 'image/png',
        dataBase64: await pngBase64(),
      },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json().blocks).toEqual([]);
    expect(uploaded.json().assets).toHaveLength(1);
    const materialId = uploaded.json().material.id as string;

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${WORKSPACE_ID}/documents/${materialId}/visuals`,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const visualRef = listed.json().visuals[0].visualRef as string;
    const preparedVisual = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${WORKSPACE_ID}/documents/${materialId}/visuals/${visualRef}/prepare`,
      payload: { commandId: 'prepare-water-cycle' },
    });
    expect(preparedVisual.statusCode, preparedVisual.body).toBe(200);
    expect(preparedVisual.json()).toMatchObject({
      status: 'prepared',
      visual: {
        sourceAuthority: 'original_visual',
        description: {
          text: VISUAL_DESCRIPTION,
          authority: 'advisory',
          provenanceCategory: 'generated_visual_explanation',
        },
      },
    });

    const services = createServices({ repos: ctx.repos, provider, clock });
    const authorityMaterial = await addWaterCycleAuthorityMaterial(
      ctx,
      services,
      'water-cycle-authority',
    );
    const roleProposal = services.materialRoles.propose({
      command: command('role-propose', 'local'),
      materialId,
      role: 'course_material',
      expectedCurrentAssignmentId: ctx.repos.materialRoles.getCurrent(materialId)!.id,
    });
    const role = services.materialRoles.confirm({
      command: command('role-confirm'),
      assignmentId: roleProposal.id,
      expectedVersion: roleProposal.version,
    });
    const draft = services.learningContracts.createDraft({
      command: command('contract-create'),
      fields: contractFields([
        {
          materialId,
          materialRoleAssignmentId: role.id,
          materialRoleAssignmentVersion: role.version,
          role: 'course_material',
          disposition: 'included',
        },
        authorityMaterial,
      ]),
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

    const preparation = services.coursePreparation.get(WORKSPACE_ID);
    expect(preparation.canResume).toBe(true);
    expect(preparation.operationKey).not.toBeNull();
    const preparedCourse = await services.coursePreparation.run({
      command: command(preparation.operationKey!),
      expectedRevision: preparation.revision,
    });
    expect(preparedCourse.preparation).toMatchObject({
      state: 'course_plan_ready',
      learnerAction: 'review_course_plan',
      checkpoints: {
        materials: 'complete',
        concepts: 'complete',
        courseStructure: 'complete',
        coursePlan: 'complete',
      },
    });
    expect(provider.analyzeCalls).toBe(1);
    expect(ctx.repos.materials.getConcepts(materialId)).toEqual([]);

    // Under the course_map_materialization_v1 default, structure is proposed from
    // text regions only, so no visual semantics reach the Course Map or detail
    // stage. Advisory visuals still reach the teaching stages asserted below.
    expect(provider.curriculumProposalCalls).toBe(0);
    expect(provider.courseMapInput).not.toBeNull();
    expect(provider.curriculumDetailInputs.length).toBeGreaterThan(0);
    expect(provider.courseMapInput).not.toHaveProperty('visualContext');
    for (const detailInput of provider.curriculumDetailInputs) {
      expect(detailInput).not.toHaveProperty('visualContext');
    }

    const revision = ctx.repos.materialRevisions.getActive(materialId)!;
    const asset = ctx.repos.materials.getAssets(materialId)[0]!;
    const derivation = ctx.repos.visualDerivations.listForAsset(asset.id)[0]!;
    // No source region is fabricated for the asset-only image material: the only
    // offered region belongs to the text authority material.
    expect(provider.courseMapInput!.sourceRegions).toHaveLength(1);
    for (const region of provider.courseMapInput!.sourceRegions) {
      expect(region.materialId).not.toBe(materialId);
    }

    // Scope: the advisory visual projections themselves. Learning-contract
    // material identity is pre-existing curriculum context, not a visual leak.
    const serializedVisualInput = JSON.stringify({
      lessonSlot: provider.lessonSlotContentInput?.visualContext,
      practice: provider.practiceContentInput?.visualContext,
    });
    for (const privateIdentity of [
      materialId,
      revision.id,
      asset.id,
      asset.byteHash,
      derivation.id,
      derivation.identityFingerprint,
      derivation.semanticIdentityFingerprint,
    ]) {
      expect(serializedVisualInput).not.toContain(privateIdentity);
    }
    expect(serializedVisualInput).not.toContain('sha256:');

    const plan = ctx.repos.studyPlans.list(WORKSPACE_ID).at(-1)!;
    const curriculum = ctx.repos.curricula.get(plan.curriculumVersionId)!;
    const learningUnit = curriculum.nodes.find((node) => node.learningUnit)!;
    expect(learningUnit.title.toLocaleLowerCase()).toContain('water cycle');
    expect(
      curriculum.executionSourceManifest.revisions.some(
        (revisionEntry) => revisionEntry.materialId === materialId,
      ),
    ).toBe(true);
    expect(
      learningUnit.sourceReferences.every((reference) => reference.materialId !== materialId),
    ).toBe(true);
    expect(
      curriculum.nodes
        .flatMap((node) => node.learningUnit?.objectives ?? [])
        .every(
          (objective) =>
            objective.semanticSupport?.verdict === 'pass' &&
            objective.semanticSupport.boundSourceBlockIds.length > 0,
        ),
    ).toBe(true);
    expect(
      curriculum.nodes
        .flatMap((node) => node.learningUnit?.objectives ?? [])
        .flatMap((objective) => [
          ...(objective.semanticSupport?.boundSourceBlockIds ?? []),
          ...(objective.formalEvidenceSourceBlockIds ?? []),
        ])
        .every(
          (sourceBlockId) =>
            ctx.repos.materials.getBlock(sourceBlockId)?.materialId ===
            authorityMaterial.materialId,
        ),
    ).toBe(true);
    expect(
      provider.objectiveAuthorityInputs
        .flatMap((input) => input.objectives)
        .every(
          (objective) =>
            objective.candidates.length > 0 &&
            objective.candidates.every((candidate) => candidate.text !== VISUAL_DESCRIPTION),
        ),
    ).toBe(true);
    expect(
      learningUnit
        .learningUnit!.objectives.map((objective) => `${objective.title} ${objective.description}`)
        .join(' ')
        .toLocaleLowerCase(),
    ).toContain('water cycle');
    expect(learningUnit.title.toLocaleLowerCase()).not.toContain('misleading');
    expect(plan.items.some((item) => item.kind === 'teach_unit')).toBe(true);
    expect(
      plan.items
        .filter((item) => item.kind === 'formal_checkpoint')
        .every((item) =>
          item.objectiveIds.every((objectiveId) =>
            learningUnit.learningUnit!.objectives.some(
              (objective) =>
                objective.id === objectiveId &&
                objective.semanticSupport?.verdict === 'pass' &&
                objective.semanticSupport.boundSourceBlockIds.length > 0,
            ),
          ),
        ),
    ).toBe(true);

    const acceptedRoute = services.courseExecution.decideStudyPlan({
      command: command('plan-accept'),
      studyPlanId: plan.id,
      expectedVersion: plan.version,
      expectedContractId: contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    }).activeRoute!;
    const agenda = acceptedRoute.agenda;
    const teachingItem = agenda.items.find((item) => item.kind === 'learning_unit_teaching')!;
    expect(teachingItem.launch).toMatchObject({ status: 'launchable', capability: 'lesson' });
    const launch = await services.courseActionLaunch.launch({
      command: command('launch-visual-lesson'),
      agendaId: agenda.id,
      expectedAgendaVersion: agenda.version,
      agendaItemId: teachingItem.id,
      expectedContractId: contract.id,
      expectedStudyPlanId: plan.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    });
    expect(launch).toMatchObject({
      kind: 'lesson',
      agendaItemId: teachingItem.id,
      learningUnitId: learningUnit.id,
      conceptId: expect.any(String),
      lessonId: null,
    });

    const execution = ctx.repos.courseExecution.get(WORKSPACE_ID);
    const startedSession = services.studySessions.start(WORKSPACE_ID, {
      contractVersionId: contract.id,
      curriculumVersionId: curriculum.id,
      studyPlanVersionId: plan.id,
      sessionAgendaId: agenda.id,
      expectedCourseExecutionVersion: execution.version,
    }).session;
    const preparedLesson = await services.lessonExecution.ensure(WORKSPACE_ID, startedSession.id, {
      command: command('lesson-prepare'),
      expectedSessionVersion: startedSession.version,
      expectedAgendaVersion: agenda.version,
      expectedAgendaItemId: startedSession.currentAgendaItemId,
    });
    expect(preparedLesson.status).toBe('ready');
    expect(preparedLesson.lesson).toMatchObject({
      sourceReferencesAvailable: true,
      visuals: [
        {
          source: { authority: 'original_visual' },
          explanation: {
            text: VISUAL_DESCRIPTION,
            authority: 'advisory',
            evidenceAdmissibility: 'advisory_nonblocking',
            formalEvidenceEligible: false,
          },
        },
      ],
    });
    const brief = ctx.repos.teachingBriefs.listForUnit(WORKSPACE_ID, learningUnit.id)[0]!;
    expect(brief.sourceReferences.length).toBeGreaterThan(0);
    expect(brief.visualReferences).toHaveLength(1);
    expect(provider.lessonSlotContentInput?.sourceContext.offers.length).toBeGreaterThan(0);
    expect(provider.lessonSlotContentInput?.visualContext.offers).toHaveLength(1);
    expect(provider.practiceContentInput?.sourceContext.offers.length).toBeGreaterThan(0);
    expect(provider.practiceContentInput?.visualContext.offers).toHaveLength(1);
    expect(provider.practiceContentInput?.acceptedLesson).toEqual(
      expect.arrayContaining(
        provider.lessonSlotContentInput!.skeleton.lessonSlots.map((slot) =>
          expect.objectContaining({ slotId: slot.slotId }),
        ),
      ),
    );

    const startedLesson = await services.lessonExecution.command(WORKSPACE_ID, startedSession.id, {
      command: command('lesson-start'),
      expectedSessionVersion: preparedLesson.session.version,
      expectedAgendaVersion: preparedLesson.agenda!.version,
      expectedAgendaItemId: startedSession.currentAgendaItemId!,
      expectedLessonStateVersion: preparedLesson.progress!.stateVersion,
      action: { kind: 'start_lesson' },
    });
    expect(
      services.lessonExecution.tutorContext(WORKSPACE_ID, startedSession.id)?.visuals,
    ).toHaveLength(1);
    const tutorTurn = await services.studySessions.submitTurn(WORKSPACE_ID, startedSession.id, {
      commandId: 'visual-tutor-turn',
      expectedSessionVersion: startedLesson.session.version,
      content: 'Walk me through the water cycle diagram.',
    });
    expect(provider.tutorInput?.lessonContext?.visuals).toHaveLength(1);
    expect(provider.tutorInput?.lessonContext?.visuals[0]?.explanation).toMatchObject({
      text: VISUAL_DESCRIPTION,
      authority: 'advisory',
      formalEvidenceEligible: false,
    });
    expect(
      provider.tutorInput?.offeredSourceRefs.some((reference) =>
        reference.referenceKey.startsWith('V'),
      ),
    ).toBe(false);

    expect(ctx.repos.formalProgression.listEvidenceForWorkspace(WORKSPACE_ID)).toEqual([]);
    expect(ctx.repos.mastery.listByWorkspace(WORKSPACE_ID)).toEqual([]);
    expect(ctx.repos.mistakes.listOpenByWorkspace(WORKSPACE_ID)).toEqual([]);

    ctx.repos.visualDerivations.create({
      ...derivation,
      id: 'visual_derivation_after_route_acceptance',
      identityFingerprint: `visual_derivation_${'d'.repeat(64)}`,
      semanticIdentityFingerprint: `visual_semantic_${'e'.repeat(64)}`,
      payload: {
        ...derivation.payload,
        description: 'A newer accepted explanation that was not in the Course route snapshot.',
      },
      createdAt: new Date(Date.parse(derivation.createdAt) + 1_000).toISOString(),
    });
    const sourceBackedLaunch = await services.courseActionLaunch.launch({
      command: command('launch-after-visual-derivation-change'),
      agendaId: agenda.id,
      expectedAgendaVersion: agenda.version,
      agendaItemId: teachingItem.id,
      expectedContractId: contract.id,
      expectedStudyPlanId: plan.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    });
    expect(sourceBackedLaunch).toMatchObject({
      kind: 'lesson',
      conceptId: expect.any(String),
    });
    const currentAgenda = ctx.repos.sessionAgendas.get(agenda.id)!;
    await expect(
      services.teachingBriefPreparation.prepare({
        workspaceId: WORKSPACE_ID,
        curriculumVersionId: curriculum.id,
        studyPlanVersionId: plan.id,
        learningUnitId: learningUnit.id,
        studySessionId: tutorTurn.session.id,
        sessionAgendaId: currentAgenda.id,
        expectedSessionVersion: tutorTurn.session.version,
        expectedAgendaVersion: currentAgenda.version,
        expectedAgendaItemId: teachingItem.id,
        expectedStudyPlanItemId: teachingItem.linkedPlanItemId!,
        commandId: 'brief-after-visual-derivation-change',
        expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      }),
    ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
  });

  it('retrieves a relevant prepared visual even when its occurrence is ninth', async () => {
    const provider = new VisualLearningProvider(9);
    const clock = fixedClock(T0);
    const ctx = buildTestApp({ provider, clock });
    testApps.push(ctx);
    const services = createServices({ repos: ctx.repos, provider, clock });
    const scope: LearningContractDraftFields['courseScope']['materials'] = [];
    let relevantMaterialId = '';
    let relevantAssetId = '';

    for (let index = 0; index < 9; index += 1) {
      const uploaded = await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${WORKSPACE_ID}/documents`,
        payload: {
          kind: 'file',
          filename: index === 8 ? 'miscellaneous-final.png' : `ornament-${index + 1}.png`,
          mediaType: 'image/png',
          dataBase64: await pngBase64(index + 1),
        },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      const materialId = uploaded.json().material.id as string;
      const listed = await ctx.app.inject({
        method: 'GET',
        url: `/api/workspaces/${WORKSPACE_ID}/documents/${materialId}/visuals`,
      });
      const visualRef = listed.json().visuals[0].visualRef as string;
      const prepared = await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${WORKSPACE_ID}/documents/${materialId}/visuals/${visualRef}/prepare`,
        payload: { commandId: `prepare-ranked-${index + 1}` },
      });
      expect(prepared.statusCode, prepared.body).toBe(200);
      const roleProposal = services.materialRoles.propose({
        command: command(`ranked-role-propose-${index + 1}`, 'local'),
        materialId,
        role: 'course_material',
        expectedCurrentAssignmentId: ctx.repos.materialRoles.getCurrent(materialId)!.id,
      });
      const role = services.materialRoles.confirm({
        command: command(`ranked-role-confirm-${index + 1}`),
        assignmentId: roleProposal.id,
        expectedVersion: roleProposal.version,
      });
      scope.push({
        materialId,
        materialRoleAssignmentId: role.id,
        materialRoleAssignmentVersion: role.version,
        role: 'course_material',
        disposition: 'included',
      });
      if (index === 8) {
        relevantMaterialId = materialId;
        relevantAssetId = ctx.repos.materials.getAssets(materialId)[0]!.id;
      }
    }

    scope.push(await addWaterCycleAuthorityMaterial(ctx, services, 'ranked-authority'));

    const draft = services.learningContracts.createDraft({
      command: command('ranked-contract-create'),
      fields: contractFields(scope),
      predecessorContractId: null,
      expectedActiveContractId: null,
    }).contract;
    const proposedContract = services.learningContracts.transition({
      command: command('ranked-contract-propose'),
      contractId: draft.id,
      expectedVersion: draft.version,
      transition: 'propose',
    }).contract;
    const contract = services.learningContracts.transition({
      command: command('ranked-contract-confirm'),
      contractId: proposedContract.id,
      expectedVersion: proposedContract.version,
      transition: 'confirm',
    }).contract;
    const preparation = services.coursePreparation.get(WORKSPACE_ID);
    expect(preparation.operationKey).not.toBeNull();
    await services.coursePreparation.run({
      command: command(preparation.operationKey!),
      expectedRevision: preparation.revision,
    });
    expect(provider.analyzeCalls).toBe(1);
    const plan = ctx.repos.studyPlans.list(WORKSPACE_ID).at(-1)!;
    const curriculum = ctx.repos.curricula.get(plan.curriculumVersionId)!;
    const relevantUnit = curriculum.nodes.find(
      (node) => node.learningUnit && node.title.toLocaleLowerCase().includes('water cycle'),
    )!;
    expect(relevantUnit).toBeDefined();
    expect(
      curriculum.executionSourceManifest.revisions.some(
        (revisionEntry) => revisionEntry.materialId === relevantMaterialId,
      ),
    ).toBe(true);
    expect(
      relevantUnit.sourceReferences.every(
        (reference) => reference.materialId !== relevantMaterialId,
      ),
    ).toBe(true);
    expect(
      relevantUnit.learningUnit!.objectives.every(
        (objective) =>
          objective.semanticSupport?.verdict === 'pass' &&
          objective.semanticSupport.boundSourceBlockIds.length > 0,
      ),
    ).toBe(true);
    expect(
      relevantUnit
        .learningUnit!.objectives.flatMap((objective) => [
          ...(objective.semanticSupport?.boundSourceBlockIds ?? []),
          ...(objective.formalEvidenceSourceBlockIds ?? []),
        ])
        .every(
          (sourceBlockId) =>
            ctx.repos.materials.getBlock(sourceBlockId)?.materialId !== relevantMaterialId,
        ),
    ).toBe(true);
    const acceptedRoute = services.courseExecution.decideStudyPlan({
      command: command('ranked-plan-accept'),
      studyPlanId: plan.id,
      expectedVersion: plan.version,
      expectedContractId: contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    }).activeRoute!;
    const teachingItem = acceptedRoute.agenda.items.find(
      (item) => item.kind === 'learning_unit_teaching' && item.learningUnitId === relevantUnit.id,
    )!;
    expect(teachingItem.id).toBe(acceptedRoute.agenda.currentItemId);
    expect(teachingItem.linkedPlanItemId).not.toBeNull();
    const execution = ctx.repos.courseExecution.get(WORKSPACE_ID);
    const session = services.studySessions.start(WORKSPACE_ID, {
      contractVersionId: contract.id,
      curriculumVersionId: curriculum.id,
      studyPlanVersionId: plan.id,
      sessionAgendaId: acceptedRoute.agenda.id,
      expectedCourseExecutionVersion: execution.version,
    }).session;

    const result = await services.teachingBriefPreparation.prepare({
      workspaceId: WORKSPACE_ID,
      curriculumVersionId: curriculum.id,
      studyPlanVersionId: plan.id,
      learningUnitId: relevantUnit.id,
      studySessionId: session.id,
      sessionAgendaId: acceptedRoute.agenda.id,
      expectedSessionVersion: session.version,
      expectedAgendaVersion: acceptedRoute.agenda.version,
      expectedAgendaItemId: teachingItem.id,
      expectedStudyPlanItemId: teachingItem.linkedPlanItemId!,
      commandId: 'ranked-brief-prepare',
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    });
    expect(
      result.brief.visualReferences.some((reference) => reference.assetId === relevantAssetId),
    ).toBe(true);
    expect(
      provider.lessonSlotContentInput?.visualContext.offers.some(
        (offer) => offer.explanation.text === VISUAL_DESCRIPTION,
      ),
    ).toBe(true);
    expect(
      provider.practiceContentInput?.visualContext.offers.some(
        (offer) => offer.explanation.text === VISUAL_DESCRIPTION,
      ),
    ).toBe(true);
    expect(
      result.brief.visualReferences.some(
        (reference) => reference.materialId === relevantMaterialId,
      ),
    ).toBe(true);
  });
});
