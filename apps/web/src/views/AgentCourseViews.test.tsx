import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CourseExecutionOverview,
  CoursePreparation,
  CurriculumHierarchyView,
  LearningContract,
  SessionAgenda,
  SourceBlock,
  StudyPlan,
} from '@hy3-clinic/shared';
import { CourseHomeView, type CourseHomeViewProps } from './CourseHomeView.js';
import { CurriculumView } from './CurriculumView.js';
import { StudyPlanPanel } from './StudyPlanPanel.js';
import { AgentCourseShell } from './AgentCourseShell.js';
import { CourseMaterialsView } from './CourseMaterialsView.js';
import { CourseProgressView } from './CourseProgressView.js';
import { api } from '../api.js';
import { documentSummary } from '../test/fixtures.js';

const AT = '2026-08-10T08:00:00.000Z';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function contract(status: LearningContract['status'] = 'active'): LearningContract {
  return {
    id: 'contract_1',
    workspaceId: 'ws_1',
    version: 1,
    predecessorId: null,
    intent: 'Pass the probability exam',
    targetOutcome: { description: 'Score at least 90', targetScore: 90, credential: null },
    deadline: { at: '2026-08-20T08:00:00.000Z', timeZone: 'Asia/Shanghai' },
    studyBudget: {
      minutesPerDay: 60,
      minutesPerWeek: 360,
      preferredSessionMinutes: 30,
      unavailablePeriods: [],
    },
    desiredDepth: 'high_performance',
    courseScope: {
      subjectBoundaries: ['Probability'],
      materials: [],
      includedTopics: ['Bayes theorem'],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: null,
    status,
    proposedBy: 'learner',
    learnerConfirmedAt: status === 'draft' || status === 'proposed' ? null : AT,
    createdAt: AT,
  };
}

function plan(status: StudyPlan['status'] = 'accepted'): StudyPlan {
  const items: StudyPlan['items'] = [
    {
      id: 'plan_item_1',
      index: 0,
      phase: 'Foundations',
      kind: 'teach_unit',
      curriculumLearningUnitId: 'unit_1',
      rationale: 'Build the prerequisite model first.',
      estimatedMinutes: 20,
      targetDepth: 'high_performance',
      objectiveIds: ['objective_1'],
      prerequisitePlanItemIds: [],
      completionPolicy: null,
      completionRequirements: [],
    },
    {
      id: 'plan_item_2',
      index: 1,
      phase: 'Application',
      kind: 'teach_unit',
      curriculumLearningUnitId: 'unit_2',
      rationale: 'Apply the rule to representative cases.',
      estimatedMinutes: 25,
      targetDepth: 'high_performance',
      objectiveIds: ['objective_2'],
      prerequisitePlanItemIds: ['plan_item_1'],
      completionPolicy: null,
      completionRequirements: [],
    },
  ];
  return {
    id: 'plan_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    executionSourceManifestFingerprint: 'manifest_1',
    version: 1,
    predecessorId: null,
    proposalTrigger: 'Initial accepted route',
    status,
    rationale: 'Follow prerequisites before transfer practice.',
    items,
    deferrals: [],
    feasibility: {
      projectedMinutes: 45,
      availableMinutes: 600,
      slackMinutes: 555,
      state: 'feasible',
      assumptions: ['Learner follows the stated daily budget.'],
    },
    paceBaseline:
      status === 'accepted'
        ? {
            id: 'pace_1',
            policyVersion: 'pace-v1',
            contractVersionId: 'contract_1',
            studyPlanVersionId: 'plan_1',
            timeZone: 'Asia/Shanghai',
            expectedSessionCadencePerWeek: 6,
            explicitSlackMinutes: 555,
            estimateConfidence: 'medium',
            estimateSource: 'local',
            milestones: [],
          }
        : null,
    diff: [],
    provider: 'fake',
    providerModel: null,
    learnerAcceptedAt: status === 'accepted' ? AT : null,
    createdAt: AT,
  };
}

function agenda(launchStatus: 'launchable' | 'blocked'): SessionAgenda {
  return {
    id: 'agenda_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    executionSourceManifestFingerprint: 'manifest_1',
    version: 1,
    status: 'active',
    availableMinutes: 30,
    items: [
      {
        id: 'agenda_item_1',
        index: 0,
        kind: 'learning_unit_teaching',
        origin: 'accepted_plan',
        reason: 'Continue Bayes foundations',
        estimatedMinutes: 20,
        linkedPlanItemId: 'plan_item_1',
        learningUnitId: 'unit_1',
        priority: 'high',
        state: launchStatus === 'blocked' ? 'blocked' : 'queued',
        launch: {
          status: launchStatus,
          capability: 'teach_unit',
          resourceId: launchStatus === 'launchable' ? 'concept_1' : null,
          reason: launchStatus === 'blocked' ? 'Source manifest must be revalidated.' : null,
        },
        displacedAgendaItemIds: [],
        timeImpactMinutes: 20,
      },
    ],
    currentItemId: 'agenda_item_1',
    createdAt: AT,
    updatedAt: AT,
  };
}

function overview(launchStatus: 'launchable' | 'blocked'): CourseExecutionOverview {
  const activeAgenda = agenda(launchStatus);
  return {
    workspaceId: 'ws_1',
    courseExecutionVersion: 1,
    setupStage: 'route_active',
    executionStatus: 'active',
    activeContract: contract(),
    pendingContract: null,
    contractFeasibility: {
      state: 'feasible',
      deadlineAt: '2026-08-20T08:00:00.000Z',
      availableMinutes: 600,
      projectedMinutes: 45,
      slackMinutes: 555,
      reasonCodes: ['sufficient_slack'],
      assumptions: [],
      policyVersion: 'contract-feasibility-v1',
      computedAt: AT,
    },
    contractScopeReadiness: { state: 'current', issues: [] },
    acceptedCurriculum: null,
    planningCurriculum: null,
    proposedCurriculum: null,
    curriculumHierarchy: null,
    activeCurriculumHierarchy: null,
    acceptedStudyPlan: plan(),
    proposedStudyPlan: null,
    activeAgenda,
    formalProgress: {
      planItemCount: 1,
      completedPlanItemCount: 0,
      startedPlanItemCount: 0,
      repairNeededPlanItemCount: 0,
      deferredPlanItemCount: 0,
      stateCreditingEvidenceCount: 0,
      advisoryEvidenceCount: 0,
    },
    nextAction: {
      agendaId: activeAgenda.id,
      agendaVersion: activeAgenda.version,
      item: activeAgenda.items[0]!,
      whyNext: 'It is prerequisite-valid and fits the available time.',
    },
    riskSummary: {
      openCount: 0,
      deferredCount: 0,
      staleCount: 0,
      highestOpenSeverity: null,
      deterministicMappingGapCount: 0,
      explicitDeferralCount: 0,
      highlights: [],
      analysisState: 'available',
      computedAt: AT,
    },
    capabilities: {
      canEditContract: false,
      canConfirmContract: false,
      canProposeCurriculum: false,
      canAcceptCurriculum: false,
      canProposeStudyPlan: false,
      canEditStudyPlan: false,
      canAcceptStudyPlan: false,
      canContinueStudy: launchStatus === 'launchable',
    },
    contractHistory: [],
    curriculumHistory: [],
    studyPlanHistory: [],
    generatedAt: AT,
  };
}

function homeProps(value: CourseExecutionOverview): CourseHomeViewProps {
  return {
    courseName: 'Probability',
    overview: value,
    preparation: null,
    preparationError: null,
    loading: false,
    error: null,
    busyAction: null,
    routeGenerationFailure: null,
    actionFailure: null,
    onCreateContract: vi.fn(),
    onEditContract: vi.fn(),
    onConfirmContract: vi.fn(),
    onRunPreparation: vi.fn(),
    onCancelPreparation: vi.fn(),
    onProposeCurriculum: vi.fn(),
    onCancelCurriculum: vi.fn(),
    onOpenCurriculum: vi.fn(),
    onOpenConceptGrounding: vi.fn(),
    onProposeStudyPlan: vi.fn(),
    onDismissRouteGenerationFailure: vi.fn(),
    onOpenSettings: vi.fn(),
    onEditStudyPlan: vi.fn(),
    onAcceptStudyPlan: vi.fn(),
    onRejectStudyPlan: vi.fn(),
    onLaunchNext: vi.fn(),
    onOpenMaterials: vi.fn(),
  };
}

function preparation(overrides: Partial<CoursePreparation> = {}): CoursePreparation {
  return {
    workspaceId: 'ws_1',
    revision: 'preparation-revision-1',
    operationKey: 'prepare-course-ws-1',
    state: 'preparing_concepts',
    machineAction: 'prepare_concepts',
    learnerAction: 'resume_preparation',
    learnerDecisionRequired: false,
    canResume: true,
    canCancel: true,
    checkpoints: {
      materials: 'complete',
      concepts: 'in_progress',
      courseStructure: 'pending',
      coursePlan: 'pending',
    },
    blocker: null,
    failure: null,
    generatedAt: AT,
    ...overrides,
  };
}

function recoveryOverview(
  state: 'concept_grounding_missing' | 'concept_grounding_stale' | 'curriculum_remediation_ready',
): CourseExecutionOverview {
  const value = overview('launchable');
  value.activeContract = null;
  value.acceptedStudyPlan = null;
  value.activeAgenda = null;
  value.nextAction = null;
  value.pendingContract = contract('learner_confirmed');
  value.setupStage = 'plan_required';
  value.capabilities.canProposeStudyPlan = false;
  value.capabilities.canProposeCurriculum = state === 'curriculum_remediation_ready';
  value.studyPlanPreflight = {
    curriculumVersionId: 'curriculum_source_only',
    totalLearningUnitCount: 21,
    executableLearningUnitCount: 0,
    nonExecutableLearningUnitCount: 21,
    planningRepresentationCount: 21,
    deferredOrUnplannableCount: 21,
    allowedItemKindCounts: [{ kind: 'none', learningUnitCount: 21 }],
    promptStrategy: 'blocked',
    planningInputCharacters: 12_000,
    providerPromptCharacters: null,
    approximatePromptTokens: null,
    canGenerate: false,
    blockers: [
      {
        code: 'no_launchable_learning_unit',
        message: 'No accepted Curriculum LearningUnit has a currently launchable capability.',
        affectedLearningUnitCount: 21,
      },
    ],
  };
  const nextAction =
    state === 'concept_grounding_missing'
      ? 'build_concept_grounding'
      : state === 'concept_grounding_stale'
        ? 'rebuild_concept_grounding'
        : 'propose_curriculum_successor';
  value.curriculumRecovery = {
    state,
    nextAction,
    remediationRequired: true,
    includedMaterialCount: 1,
    currentConceptCount: state === 'curriculum_remediation_ready' ? 1 : 0,
    validGroundedConceptCount: state === 'curriculum_remediation_ready' ? 1 : 0,
    staleConceptCount: state === 'concept_grounding_stale' ? 4 : 0,
    invalidGroundingCount: 0,
    canonicalConceptCount: state === 'curriculum_remediation_ready' ? 1 : 0,
    canonicalMembershipCount: state === 'curriculum_remediation_ready' ? 1 : 0,
  };
  return value;
}

function hierarchy(valid = true): CurriculumHierarchyView {
  const manifest = {
    fingerprint: 'manifest_1',
    revisions: [
      {
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        parserVersion: 'text-v1',
        parserFingerprint: 'parser_1',
        sourceBlockRevisionIds: ['block_1'],
      },
    ],
  };
  return {
    curriculumId: 'curriculum_1',
    curriculumVersion: 1,
    status: 'proposed',
    rootNodeIds: ['course_1'],
    nodes: [
      {
        id: 'course_1',
        parentId: null,
        childIds: ['section_1'],
        kind: 'course',
        index: 0,
        depth: 0,
        title: 'Probability',
        breadcrumbTitles: ['Probability'],
        learningUnit: null,
        sourceReferences: [],
        mappedPlanItemIds: [],
        progressState: null,
      },
      {
        id: 'section_1',
        parentId: 'course_1',
        childIds: ['unit_1', 'unit_2'],
        kind: 'section',
        index: 0,
        depth: 1,
        title: 'Conditional probability',
        breadcrumbTitles: ['Probability', 'Conditional probability'],
        learningUnit: null,
        sourceReferences: [],
        mappedPlanItemIds: [],
        progressState: null,
      },
      {
        id: 'unit_1',
        parentId: 'section_1',
        childIds: [],
        kind: 'learning_unit',
        index: 0,
        depth: 2,
        title: 'Verified source objective',
        breadcrumbTitles: ['Probability', 'Conditional probability', 'Verified source objective'],
        learningUnit: {
          conceptIds: ['concept_1'],
          canonicalConceptIds: [],
          objectives: [
            {
              id: 'objective_1',
              title: 'Apply conditional probability',
              description: 'Apply the source-defined ratio.',
              truthPremiseStatus: 'independently_verified',
              truthAuthorityRecordIds: ['authority_1'],
            },
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
        sourceReferences: [],
        mappedPlanItemIds: [],
        progressState: 'not_started',
      },
      {
        id: 'unit_2',
        parentId: 'section_1',
        childIds: [],
        kind: 'learning_unit',
        index: 1,
        depth: 2,
        title: 'Supplement objective',
        breadcrumbTitles: ['Probability', 'Conditional probability', 'Supplement objective'],
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [
            {
              id: 'objective_2',
              title: 'Explore an unsourced extension',
              description: 'Advisory teaching only.',
              truthPremiseStatus: 'unverified',
              truthAuthorityRecordIds: [],
            },
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
        sourceReferences: [],
        mappedPlanItemIds: [],
        progressState: 'not_started',
      },
    ],
    synthesisGroups: [],
    validation: {
      valid,
      errors: valid ? [] : ['Unknown prerequisite unit.'],
      warnings: [],
      unmappedStructuralUnitIds: [],
    },
    executionSourceManifest: manifest,
  };
}

function largeHierarchy(): CurriculumHierarchyView {
  const value = hierarchy();
  const section = value.nodes.find((node) => node.id === 'section_1')!;
  const template = value.nodes.find((node) => node.id === 'unit_1')!;
  const units = Array.from({ length: 277 }, (_, index) => ({
    ...template,
    id: `large_unit_${index + 1}`,
    index,
    title: `Large course unit ${index + 1}`,
    breadcrumbTitles: ['Probability', 'Conditional probability', `Large course unit ${index + 1}`],
    learningUnit: {
      ...template.learningUnit!,
      objectives: [
        {
          ...template.learningUnit!.objectives[0]!,
          id: `large_objective_${index + 1}`,
          title: `Large course objective ${index + 1}`,
        },
      ],
    },
  }));
  section.childIds = units.map((unit) => unit.id);
  value.nodes = [value.nodes[0]!, section, ...units];
  return value;
}

function repeatedSourceFragmentHierarchy(): CurriculumHierarchyView {
  const value = hierarchy();
  const section = value.nodes.find((node) => node.id === 'section_1')!;
  const template = value.nodes.find((node) => node.id === 'unit_2')!;
  const units = Array.from({ length: 5 }, (_, index) => ({
    ...template,
    id: `unit_llm_${index + 1}`,
    index,
    title: '2. LLM',
    breadcrumbTitles: ['Probability', 'Conditional probability', '2. LLM'],
    learningUnit: {
      ...template.learningUnit!,
      conceptIds: [],
      objectives: [
        {
          ...template.learningUnit!.objectives[0]!,
          id: `objective_llm_${index + 1}`,
          title: 'Understand 2. LLM',
          description: 'Explain and apply the central ideas in 2. LLM.',
        },
      ],
    },
    sourceReferences: [
      {
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        structuralUnitId: null,
        sourceBlockId: `source_llm_${index + 1}`,
        sourceBlockRevisionFingerprint: `fingerprint_llm_${index + 1}`,
      },
    ],
  }));
  section.childIds = units.map((unit) => unit.id);
  value.nodes = [value.nodes[0]!, section, ...units];
  return value;
}

const repeatedSourceBlocks = Array.from({ length: 5 }, (_, index) => ({
  id: `source_llm_${index + 1}`,
  materialId: 'material_1',
  materialRevisionId: 'revision_1',
  index,
  heading: '2. LLM',
  headingPath: ['Probability', '2. LLM'],
  pageNumber: index + 2,
  pageEnd: index + 2,
  content: `LLM 第 ${index + 1} 段真实课程资料，说明这一主题的不同侧面。`,
  startOffset: index * 80,
  endOffset: index * 80 + 35,
})) satisfies SourceBlock[];

describe('CourseHomeView action and authority rendering', () => {
  it('opens the learner Knowledge Map from the Course Home shortcut', async () => {
    const value = overview('launchable');
    value.planningCurriculum = {
      version: 1,
    } as NonNullable<CourseExecutionOverview['planningCurriculum']>;
    const props = homeProps(value);
    props.onOpenKnowledgeMap = vi.fn();
    const user = userEvent.setup();

    render(<CourseHomeView {...props} />);

    await user.click(screen.getByText('课程结构与版本'));
    await user.click(screen.getByRole('button', { name: '在知识地图中查看' }));
    expect(props.onOpenKnowledgeMap).toHaveBeenCalledOnce();
  });

  it('renders compact learner-safe Course Preparation checkpoints', () => {
    const props = homeProps(recoveryOverview('concept_grounding_missing'));
    props.preparation = preparation({
      state: 'preparing_course_structure',
      machineAction: 'prepare_course_structure',
      checkpoints: {
        materials: 'complete',
        concepts: 'complete',
        courseStructure: 'in_progress',
        coursePlan: 'pending',
      },
    });

    render(<CourseHomeView {...props} />);

    const status = screen.getByLabelText('课程准备状态');
    expect(within(status).getByRole('heading', { name: '正在设计课程结构' })).toBeVisible();
    expect(within(status).getByText('资料已整理').closest('li')).toHaveAttribute(
      'data-state',
      'complete',
    );
    expect(within(status).getByText('核心内容已准备').closest('li')).toHaveAttribute(
      'data-state',
      'complete',
    );
    expect(within(status).getByText('课程结构已完成').closest('li')).toHaveAttribute(
      'data-state',
      'in_progress',
    );
    expect(within(status).getByText('课程方案已检查').closest('li')).toHaveAttribute(
      'data-state',
      'pending',
    );
    expect(status).not.toHaveTextContent(/concept|graph|prepare-course-ws-1/iu);
  });

  it('offers a learner-safe retry after recoverable preparation failure', async () => {
    const props = homeProps(recoveryOverview('concept_grounding_missing'));
    props.preparation = preparation({
      state: 'failed_recoverable',
      canCancel: false,
      blocker: {
        code: 'preparation_failed',
        message: '课程准备暂未完成，已有有效内容没有被覆盖，可以稍后重试。',
      },
      failure: {
        code: 'PROVIDER_ERROR',
        action: 'prepare_concepts',
        occurredAt: AT,
        retryable: true,
      },
    });
    props.preparationError = 'raw provider operation op_private_123 failed';
    const user = userEvent.setup();

    render(<CourseHomeView {...props} />);

    expect(screen.getByRole('alert')).toHaveTextContent('课程准备暂未完成，已有有效内容保持不变。');
    expect(screen.queryByText(/op_private_123/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试课程准备' }));
    expect(props.onRunPreparation).toHaveBeenCalledOnce();
  });

  it('shows one cancellable in-progress preparation operation', async () => {
    const props = homeProps(recoveryOverview('concept_grounding_missing'));
    props.preparation = preparation();
    props.busyAction = 'prepare-course';
    const user = userEvent.setup();

    render(<CourseHomeView {...props} />);

    const operation = screen.getByRole('status');
    expect(operation).toHaveTextContent('正在理解课程资料的核心内容');
    expect(screen.queryByRole('button', { name: '继续准备课程' })).not.toBeInTheDocument();
    await user.click(within(operation).getByRole('button', { name: '停止' }));
    expect(props.onCancelPreparation).toHaveBeenCalledOnce();
  });

  it('stops at a real learner-governed Course Structure decision', async () => {
    const props = homeProps(recoveryOverview('curriculum_remediation_ready'));
    props.preparation = preparation({
      operationKey: null,
      state: 'awaiting_required_governance',
      machineAction: null,
      learnerAction: 'review_course_structure',
      learnerDecisionRequired: true,
      canResume: false,
      canCancel: false,
      checkpoints: {
        materials: 'complete',
        concepts: 'complete',
        courseStructure: 'in_progress',
        coursePlan: 'pending',
      },
      blocker: {
        code: 'course_structure_review_required',
        message: '已有一份需要你决定的课程结构，系统不会替你接受它。',
      },
    });
    const user = userEvent.setup();

    render(<CourseHomeView {...props} />);

    await user.click(screen.getByRole('button', { name: '检查课程结构' }));
    expect(props.onOpenCurriculum).toHaveBeenCalledOnce();
    expect(props.onRunPreparation).not.toHaveBeenCalled();
    expect(props.onProposeCurriculum).not.toHaveBeenCalled();
    expect(props.onAcceptStudyPlan).not.toHaveBeenCalled();
  });

  it('presents one actionable acceptance control for the ready Course Plan decision', async () => {
    const value = recoveryOverview('curriculum_remediation_ready');
    value.setupStage = 'plan_review';
    value.proposedStudyPlan = plan('proposed');
    const props = homeProps(value);
    props.preparation = preparation({
      operationKey: null,
      state: 'course_plan_ready',
      machineAction: null,
      learnerAction: 'review_course_plan',
      learnerDecisionRequired: true,
      canResume: false,
      canCancel: false,
      checkpoints: {
        materials: 'complete',
        concepts: 'complete',
        courseStructure: 'complete',
        coursePlan: 'complete',
      },
    });
    const user = userEvent.setup();

    render(<CourseHomeView {...props} />);

    const acceptanceControls = screen
      .getAllByRole('button')
      .filter(
        (button) =>
          !button.hasAttribute('disabled') &&
          /^(?:确认课程方案|接受并启用路线)$/.test(button.textContent ?? ''),
      );
    expect(acceptanceControls).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '接受并启用路线' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认课程方案' }));
    expect(props.onAcceptStudyPlan).toHaveBeenCalledOnce();
    expect(props.onRunPreparation).not.toHaveBeenCalled();
    expect(props.onProposeStudyPlan).not.toHaveBeenCalled();
  });

  it('does not display a superseded older Curriculum proposal over its accepted successor', () => {
    const value = overview('launchable');
    value.planningCurriculum = {
      version: 2,
    } as NonNullable<CourseExecutionOverview['planningCurriculum']>;
    value.proposedCurriculum = {
      version: 1,
    } as NonNullable<CourseExecutionOverview['proposedCurriculum']>;

    render(<CourseHomeView {...homeProps(value)} />);

    expect(screen.getByText('当前课程结构版本 2')).toBeInTheDocument();
    expect(screen.queryByText('当前课程结构版本 1')).not.toBeInTheDocument();
  });

  it('shows truthful cancellable Curriculum work without enabling duplicate submission', async () => {
    const user = userEvent.setup();
    const value = overview('launchable');
    value.setupStage = 'curriculum_required';
    value.nextAction = null;
    const props = homeProps(value);
    props.busyAction = 'propose-curriculum';
    render(<CourseHomeView {...props} />);

    expect(screen.getByRole('status')).toHaveTextContent('正在准备课程资料并生成课程结构');
    expect(screen.getByRole('status')).toHaveTextContent('只有需要时才会尝试一次自动修复');
    expect(screen.queryByRole('button', { name: '生成课程结构' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(props.onCancelCurriculum).toHaveBeenCalledTimes(1);
  });

  it('uses learner-safe Curriculum timeout recovery copy without mentioning fake mode', () => {
    render(
      <CourseHomeView
        {...homeProps(overview('launchable'))}
        actionFailure={{
          owner: 'curriculum',
          message: '课程结构生成时间超过预期，本次没有修改现有课程结构。你可以稍后重试。',
          details: { kind: 'curriculum_timeout', timeoutMs: 240_000 },
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('本次没有修改现有课程结构');
    expect(screen.getByRole('alert')).toHaveTextContent('你可以稍后重试');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/fake/iu);
  });

  it('places each learner operation failure beside its owning Home surface', () => {
    const props = homeProps(overview('launchable'));
    const rendered = render(
      <CourseHomeView
        {...props}
        actionFailure={{ owner: 'continue', message: '继续操作失败。' }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('暂时无法继续这项学习。继续操作失败。');

    rendered.rerender(
      <CourseHomeView
        {...props}
        actionFailure={{ owner: 'contract', message: '确认操作失败。' }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('学习目标暂未确认。确认操作失败。');

    rendered.rerender(
      <CourseHomeView
        {...props}
        actionFailure={{ owner: 'curriculum', message: '生成操作失败。' }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('课程结构暂未生成。生成操作失败。');

    rendered.rerender(
      <CourseHomeView {...props} actionFailure={{ owner: 'plan', message: '路线决定失败。' }} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('学习路线决定未完成。路线决定失败。');
  });

  it('shows safe Curriculum evidence diagnostics on Home without exposing raw identifiers', async () => {
    const user = userEvent.setup();
    render(
      <CourseHomeView
        {...homeProps(overview('launchable'))}
        actionFailure={{
          owner: 'curriculum',
          message: '新课程结构没有通过资料一致性检查，原版本未改变。',
          details: {
            kind: 'curriculum_candidate_validation',
            repairAttempted: true,
            errors: ['Unknown or unavailable offered Curriculum evidence ID: cev_private_123'],
            warnings: ['Unmapped source blocks remain visible for risk reconciliation: 204.'],
          },
        }}
      />,
    );

    expect(screen.getByText('有 1 条资料依据无法与本次课程资料的原文精确对应。')).toBeVisible();
    expect(screen.getByText('系统已经尝试了一次自动修复。')).toBeVisible();
    await user.click(screen.getByText('查看原因与技术详情'));
    expect(screen.getByText('仍有 1 项资料覆盖提醒。')).toBeVisible();
    expect(screen.queryByText(/cev_private_123/)).not.toBeInTheDocument();
  });

  it('does not render a start command for a blocked next action', () => {
    render(<CourseHomeView {...homeProps(overview('blocked'))} />);

    expect(screen.getByText('课程资料已有变化，需要重新验证当前学习路线。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续学习' })).not.toBeInTheDocument();
  });

  it('launches only the server-declared launchable next action', async () => {
    const props = homeProps(overview('launchable'));
    const user = userEvent.setup();
    render(<CourseHomeView {...props} />);

    await user.click(screen.getByRole('button', { name: '继续学习' }));
    expect(props.onLaunchNext).toHaveBeenCalledWith(props.overview!.nextAction);
  });

  it('uses the primary Continue action to enter Study when the Course shell provides it', async () => {
    const props = homeProps(overview('launchable'));
    const onOpenStudySession = vi.fn();
    const user = userEvent.setup();
    render(<CourseHomeView {...props} onOpenStudySession={onOpenStudySession} />);

    await user.click(screen.getByRole('button', { name: '继续学习' }));
    expect(onOpenStudySession).toHaveBeenCalledOnce();
    expect(props.onLaunchNext).not.toHaveBeenCalled();
  });

  it('keeps learner scope authority visibly separate from truth authority', () => {
    render(<CourseHomeView {...homeProps(overview('launchable'))} />);

    expect(screen.getByText('学习范围已确认')).toBeInTheDocument();
    expect(screen.getByText('不等于事实或评分依据已验证')).toBeInTheDocument();
    expect(screen.queryByText('事实依据已独立验证')).not.toBeInTheDocument();
  });

  it('does not claim route readiness when deterministic Plan preflight is blocked', async () => {
    const value = overview('launchable');
    value.activeContract = null;
    value.acceptedStudyPlan = null;
    value.activeAgenda = null;
    value.nextAction = null;
    value.pendingContract = contract('learner_confirmed');
    value.setupStage = 'plan_required';
    value.capabilities.canProposeStudyPlan = false;
    value.studyPlanPreflight = {
      curriculumVersionId: 'curriculum_source_only',
      totalLearningUnitCount: 277,
      executableLearningUnitCount: 0,
      nonExecutableLearningUnitCount: 277,
      planningRepresentationCount: 277,
      deferredOrUnplannableCount: 277,
      allowedItemKindCounts: [{ kind: 'none', learningUnitCount: 277 }],
      promptStrategy: 'blocked',
      planningInputCharacters: 100_000,
      providerPromptCharacters: null,
      approximatePromptTokens: null,
      canGenerate: false,
      blockers: [
        {
          code: 'no_launchable_learning_unit',
          message: 'No accepted Curriculum LearningUnit has a currently launchable capability.',
          affectedLearningUnitCount: 277,
        },
      ],
    };
    const props = homeProps(value);
    const user = userEvent.setup();

    render(<CourseHomeView {...props} />);

    expect(
      screen.getAllByText('课程结构已接受，但当前还不能生成可执行的学习路线').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/277 \/ 277 个学习单元缺少当前可执行能力/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成学习路线' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '检查并更新课程结构' }));
    expect(props.onOpenCurriculum).toHaveBeenCalledOnce();
    expect(props.onProposeStudyPlan).not.toHaveBeenCalled();
  });

  it('routes missing Concept grounding to extraction without offering a successor call', async () => {
    const props = homeProps(recoveryOverview('concept_grounding_missing'));
    const user = userEvent.setup();
    render(<CourseHomeView {...props} />);

    expect(
      screen.queryByRole('button', { name: /更新课程结构|提出新版本/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/还没有可用的概念依据/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '提取概念依据' }));
    expect(props.onOpenConceptGrounding).toHaveBeenCalledOnce();
    expect(props.onProposeCurriculum).not.toHaveBeenCalled();
    expect(props.onCreateContract).not.toHaveBeenCalled();
  });

  it('routes stale Concept grounding to rebuilding before Curriculum remediation', async () => {
    const props = homeProps(recoveryOverview('concept_grounding_stale'));
    const user = userEvent.setup();
    render(<CourseHomeView {...props} />);

    expect(screen.getByText(/已有 4 个概念依据不再对应当前资料版本/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新提取概念依据' }));
    expect(props.onOpenConceptGrounding).toHaveBeenCalledOnce();
    expect(props.onOpenCurriculum).not.toHaveBeenCalled();
    expect(props.onProposeCurriculum).not.toHaveBeenCalled();
    expect(props.onCreateContract).not.toHaveBeenCalled();
  });

  it('makes Curriculum remediation reachable once current Concept grounding is valid', async () => {
    const props = homeProps(recoveryOverview('curriculum_remediation_ready'));
    const user = userEvent.setup();
    render(<CourseHomeView {...props} />);

    await user.click(screen.getByRole('button', { name: '检查并更新课程结构' }));
    expect(props.onOpenCurriculum).toHaveBeenCalledOnce();
    expect(props.onOpenConceptGrounding).not.toHaveBeenCalled();
  });

  it('routes a confirmed Material role change to Contract reconfirmation with Chinese detail', async () => {
    const value = recoveryOverview('concept_grounding_missing');
    value.contractScopeReadiness = {
      state: 'reconfirmation_required',
      issues: [
        {
          kind: 'material_role_changed',
          materialId: 'material_1',
          contractedRole: 'course_material',
          currentConfirmedRole: 'supplementary_reference',
        },
      ],
    };
    value.curriculumRecovery = undefined;
    value.studyPlanPreflight = null;
    const props = homeProps(value);
    const user = userEvent.setup();

    render(<CourseHomeView {...props} />);

    expect(screen.getAllByText('课程资料范围发生了变化').length).toBeGreaterThan(0);
    expect(screen.getByText(/课程主资料.*补充参考/)).toBeInTheDocument();
    expect(screen.getByText('学习范围待重新确认')).toBeInTheDocument();
    expect(screen.queryByText('学习范围已确认')).not.toBeInTheDocument();
    expect(screen.queryByText(/pointers are stale/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新确认学习约定' }));
    expect(props.onCreateContract).toHaveBeenCalledOnce();
    expect(props.onOpenConceptGrounding).not.toHaveBeenCalled();
  });

  it('shows the Contract deadline and deterministic formal progress counts', () => {
    const value = overview('launchable');
    value.formalProgress = {
      planItemCount: 5,
      completedPlanItemCount: 2,
      startedPlanItemCount: 1,
      repairNeededPlanItemCount: 1,
      deferredPlanItemCount: 1,
      stateCreditingEvidenceCount: 3,
      advisoryEvidenceCount: 2,
    };

    render(<CourseHomeView {...homeProps(value)} />);

    const progress = screen.getByLabelText('目标与正式进度');
    expect(progress).toHaveTextContent('截止时间');
    expect(progress).toHaveTextContent('Asia/Shanghai');
    expect(progress).toHaveTextContent('已完成 2 / 5 · 进行中 1 · 待修复 1 · 已延期 1');
    expect(screen.getByText('可计入状态的正式证据 3 · 仅供参考的证据 2')).toBeInTheDocument();
  });

  it('forwards enabled Plan edits instead of rendering a dead control', async () => {
    const value = overview('launchable');
    value.activeContract = null;
    value.acceptedStudyPlan = null;
    value.activeAgenda = null;
    value.nextAction = null;
    value.pendingContract = contract('learner_confirmed');
    value.proposedStudyPlan = plan('proposed');
    value.setupStage = 'plan_review';
    value.capabilities.canEditStudyPlan = true;
    value.capabilities.canAcceptStudyPlan = true;
    const props = homeProps(value);
    const user = userEvent.setup();
    render(<CourseHomeView {...props} />);

    await user.click(screen.getAllByRole('button', { name: '上移' })[1]!);
    expect(props.onEditStudyPlan).toHaveBeenCalledWith({
      kind: 'reorder',
      planItemId: 'plan_item_2',
      afterPlanItemId: null,
    });
  });
});

describe('StudyPlanPanel decisions', () => {
  it('exposes learner acceptance and rejection callbacks for a proposed Plan', async () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const user = userEvent.setup();
    render(
      <StudyPlanPanel
        plan={plan('proposed')}
        history={[]}
        canEdit={false}
        canAccept
        busyAction={null}
        launchByPlanItemId={{}}
        onEdit={vi.fn()}
        onAccept={onAccept}
        onReject={onReject}
        onLaunchItem={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '接受并启用路线' }));
    await user.click(screen.getByRole('button', { name: '拒绝提案' }));
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it('renders the complete persisted route diff instead of only its rationale', () => {
    const proposed = plan('proposed');
    proposed.diff = [
      {
        kind: 'reordered',
        planItemId: 'plan_item_2',
        curriculumLearningUnitId: 'unit_2',
        beforeIndex: 1,
        afterIndex: 0,
        beforeMinutes: 25,
        afterMinutes: 35,
        beforeDepth: 'high_performance',
        afterDepth: 'deep_transfer',
        reason: 'Prioritize repair before new material.',
      },
      {
        kind: 'deferred',
        planItemId: null,
        curriculumLearningUnitId: 'unit_3',
        beforeIndex: 2,
        afterIndex: null,
        beforeMinutes: 20,
        afterMinutes: null,
        reason: 'Preserve the accepted deadline.',
      },
    ];

    render(
      <StudyPlanPanel
        plan={proposed}
        history={[]}
        canEdit={false}
        canAccept
        busyAction={null}
        launchByPlanItemId={{}}
        onEdit={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onLaunchItem={vi.fn()}
      />,
    );

    expect(screen.getByText(/顺序 2 → 1/)).toHaveTextContent('时长 25 → 35 分钟');
    expect(screen.getByText(/顺序 2 → 1/)).toHaveTextContent('深度 高水平表现 → 深入迁移');
    expect(screen.getByText(/Preserve the accepted deadline/)).toHaveTextContent('学习单元 unit_3');
  });
});

describe('CurriculumView truth and validation states', () => {
  it('replaces the successor CTA with Concept recovery when grounding is missing', async () => {
    const value = hierarchy();
    value.status = 'accepted';
    const onOpenConceptGrounding = vi.fn();
    const onPropose = vi.fn();
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={value}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept={false}
        recovery={recoveryOverview('concept_grounding_missing').curriculumRecovery}
        busyAction={null}
        onPropose={onPropose}
        onOpenConceptGrounding={onOpenConceptGrounding}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '提出新版本' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '提取概念依据' }));
    expect(onOpenConceptGrounding).toHaveBeenCalledOnce();
    expect(onPropose).not.toHaveBeenCalled();
  });

  it('presents consecutive accepted source fragments as one auditable learner topic', async () => {
    const user = userEvent.setup();
    const onOpenSource = vi.fn();
    render(
      <CurriculumView
        hierarchy={repeatedSourceFragmentHierarchy()}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
        documents={[
          {
            ...documentSummary,
            id: 'material_1',
            title: 'Weknora学习',
            sourceType: 'pdf',
            originalFilename: 'Weknora学习.pdf',
            pageCount: 17,
            blockCount: 5,
          },
        ]}
        sourceBlocks={repeatedSourceBlocks}
        onOpenSource={onOpenSource}
      />,
    );

    expect(screen.getByText('1 个学习主题 · 5 条资料记录')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看内容（1 个学习主题）' }));
    const topicHeading = screen.getByRole('heading', { name: '2. LLM' });
    expect(screen.getAllByRole('heading', { name: '2. LLM' })).toHaveLength(1);
    expect(screen.getAllByText('5 条资料记录')).toHaveLength(2);
    expect(within(topicHeading.closest('article')!).getAllByText('Understand 2. LLM')).toHaveLength(
      1,
    );
    expect(screen.queryByText(/引用概念 0|图关系 0/)).not.toBeInTheDocument();

    const topicBasis = screen.getByText('课程依据（5 处）');
    await user.click(topicBasis);
    const topicBasisDetails = topicBasis.closest('details')!;
    expect(within(topicBasisDetails).getByText('Weknora学习')).toBeInTheDocument();
    expect(topicBasisDetails).toHaveTextContent('PDF · Weknora学习.pdf · 第 2、3、4、5、6 页');
    expect(within(topicBasisDetails).getByText(/LLM 第 1 段真实课程资料/)).toBeInTheDocument();
    expect(screen.getByText(/unit_llm_5/)).not.toBeVisible();
    await user.click(within(topicBasisDetails).getByText('技术详情'));
    expect(screen.getByText(/当前只有资料依据/)).toBeInTheDocument();
    expect(screen.getByText(/LearningUnit ID unit_llm_5/)).toBeInTheDocument();
    expect(screen.getByText(/Source Block source_llm_5/)).toBeInTheDocument();
    await user.click(within(topicBasisDetails).getByRole('button', { name: '查看课程资料' }));
    expect(onOpenSource).toHaveBeenCalledWith('material_1');
  });

  it('never groups same-titled units when their pedagogical mappings differ', async () => {
    const value = repeatedSourceFragmentHierarchy();
    const units = value.nodes.filter((node) => node.kind === 'learning_unit');
    value.nodes = [
      ...value.nodes.filter((node) => node.kind !== 'learning_unit'),
      ...units.slice(0, 2),
    ];
    value.nodes.find((node) => node.id === 'section_1')!.childIds = ['unit_llm_1', 'unit_llm_2'];
    value.nodes.find((node) => node.id === 'unit_llm_2')!.learningUnit!.conceptIds = ['concept_2'];
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={value}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.getByText('2 个学习主题 · 2 条资料记录')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看内容（2 个学习主题）' }));
    expect(screen.getAllByRole('heading', { name: '2. LLM' })).toHaveLength(2);
  });

  it('collapses a redundant single section wrapper without removing its learning units', async () => {
    const value = hierarchy();
    const course = value.nodes.find((node) => node.id === 'course_1')!;
    const section = value.nodes.find((node) => node.id === 'section_1')!;
    course.childIds = ['chapter_1'];
    section.parentId = 'chapter_1';
    section.title = 'Verified source objective';
    value.nodes.splice(1, 0, {
      id: 'chapter_1',
      parentId: 'course_1',
      childIds: ['section_1'],
      kind: 'chapter',
      index: 0,
      depth: 1,
      title: 'Foundations',
      breadcrumbTitles: ['Probability', 'Foundations'],
      learningUnit: null,
      sourceReferences: [],
      mappedPlanItemIds: [],
      progressState: null,
    });
    section.depth = 2;
    for (const node of value.nodes.filter((node) => node.kind === 'learning_unit')) {
      node.depth = 3;
    }

    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={value}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '查看内容（2 个学习主题）' }));
    expect(screen.getAllByRole('heading', { name: 'Verified source objective' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Supplement objective' })).toBeInTheDocument();
  });

  it('keeps a large structure at major-part level until the learner expands it', async () => {
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={largeHierarchy()}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.getByText('277 个学习主题 · 277 条资料记录')).toBeInTheDocument();
    expect(screen.queryByText('Large course unit 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Large course unit 277')).not.toBeInTheDocument();

    const expandSection = screen.getByRole('button', { name: '查看内容（277 个学习主题）' });
    expect(expandSection).toHaveAttribute('aria-expanded', 'false');
    expect(expandSection).toHaveAttribute('aria-controls');
    await user.click(expandSection);

    expect(expandSection).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Large course unit 1')).toBeInTheDocument();
    expect(screen.getByText('Large course unit 12')).toBeInTheDocument();
    expect(screen.queryByText('Large course unit 13')).not.toBeInTheDocument();
    expect(screen.queryByText('Large course unit 277')).not.toBeInTheDocument();

    const showRemaining = screen.getByRole('button', { name: '显示其余 265 个学习主题' });
    expect(showRemaining).toHaveAttribute('aria-expanded', 'false');
    await user.click(showRemaining);
    expect(showRemaining).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Large course unit 277')).toBeInTheDocument();
  });

  it('distinguishes objective truth authority after expanding the relevant part', async () => {
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={hierarchy()}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.queryByText('事实依据已独立验证')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看内容（2 个学习主题）' }));
    expect(screen.getByText('事实依据已独立验证')).toBeInTheDocument();
    expect(screen.getByText('在学习范围内 · 事实依据未验证')).toBeInTheDocument();
  });

  it('renders the persisted parent-child structure on expansion without fabricating current state', async () => {
    const value = hierarchy();
    value.nodes.find((node) => node.id === 'unit_1')!.mappedPlanItemIds = ['plan_item_1'];
    value.nodes.find((node) => node.id === 'unit_1')!.progressState = 'started';
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={value}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    const outline = screen.getByRole('list', { name: '课程层级' });
    const sectionNode = within(outline)
      .getByRole('heading', { name: 'Conditional probability' })
      .closest('li');
    expect(screen.getByText('Verified source objective')).toHaveTextContent(
      'Verified source objective',
    );
    expect(screen.getByText('正在学习')).toBeInTheDocument();
    await user.click(
      within(sectionNode!).getByRole('button', { name: '查看内容（2 个学习主题）' }),
    );
    expect(sectionNode).toContainElement(
      within(outline).getByRole('heading', { name: 'Verified source objective' }).closest('li'),
    );
    expect(screen.getByText('已纳入当前学习路线')).toBeInTheDocument();
    expect(
      within(outline)
        .getByRole('heading', { name: 'Verified source objective' })
        .closest('article'),
    ).toHaveAttribute('aria-current', 'step');
  });

  it('keeps exact revision provenance subordinate and states the quote limitation', async () => {
    const value = hierarchy();
    value.nodes.find((node) => node.id === 'unit_1')!.sourceReferences = [
      {
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        structuralUnitId: 'structural_1',
        sourceBlockId: 'source_block_1',
        sourceBlockRevisionFingerprint: 'source_block_fingerprint_1',
      },
    ];
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={value}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.getByText('manifest_1')).not.toBeVisible();
    const courseBasis = screen.getByText('课程依据（1 份资料）');
    await user.click(courseBasis);
    await user.click(screen.getByText('技术详情与精确版本'));
    expect(screen.getByText('manifest_1')).toBeInTheDocument();
    expect(screen.getByText(/Source Blocks block_1/)).toBeInTheDocument();
    expect(screen.getByText(/不单独证明完整语义蕴含/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看内容（2 个学习主题）' }));
    const unitBasis = screen.getByText('课程依据（1 处）');
    await user.click(unitBasis);
    await user.click(within(unitBasis.closest('details')!).getByText('技术详情'));
    expect(screen.getByText(/Source Block source_block_1/)).toBeInTheDocument();
    expect(screen.getByText(/Block Revision source_block_fingerprint_1/)).toBeInTheDocument();
  });

  it('reports malformed duplicate and cyclic links without mounting repeated branches', () => {
    const value = hierarchy();
    value.nodes.push({ ...value.nodes.find((node) => node.id === 'unit_1')! });
    value.nodes.find((node) => node.id === 'section_1')!.childIds.push('course_1');
    value.nodes.find((node) => node.id === 'unit_2')!.parentId = 'missing_section';

    render(
      <CurriculumView
        hierarchy={value}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.getByText(/发现重复节点 ID：unit_1/)).toBeInTheDocument();
    expect(screen.getByText(/发现循环层级：course_1/)).toBeInTheDocument();
    expect(screen.getByText(/部分父节点不存在：missing_section/)).toBeInTheDocument();
    expect(screen.getByText('学习主题').closest('div')).toHaveTextContent('学习主题2');
  });

  it('keeps the Curriculum page context visible while the outline is loading', () => {
    render(
      <CurriculumView
        hierarchy={null}
        history={[]}
        loading
        error={null}
        canPropose
        canAccept={false}
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('课程结构')).toBeInTheDocument();
    expect(screen.getByText('课程地图')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('加载课程结构…');
    expect(screen.getByRole('button', { name: '生成结构' })).toBeDisabled();
  });

  it('keeps an invalid proposed Curriculum visibly non-acceptable', () => {
    render(
      <CurriculumView
        hierarchy={hierarchy(false)}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.getByText('该候选版本未通过本地结构校验，不能接受。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接受课程结构' })).toBeDisabled();
  });

  it('translates internal unmapped-block diagnostics before primary learner display', () => {
    const value = hierarchy();
    value.validation.warnings = [
      'Unmapped source blocks remain visible for risk reconciliation: 129.',
    ];
    render(
      <CurriculumView
        hierarchy={value}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        '仍有 129 段课程资料尚未被当前课程结构引用。原始资料不会被删除，可在详情中查看。',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Unmapped source blocks/iu)).not.toBeInTheDocument();
  });

  it('renders a persisted historical warning through structured learner-safe data', async () => {
    const raw = 'Unmapped source blocks remain visible for risk reconciliation: 129.';
    const value = hierarchy();
    value.validation.warnings = [raw];
    value.coverageWarnings = [{ code: 'unmapped_source_blocks', count: 129, technicalDetail: raw }];
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={value}
        history={[]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(
      screen.getByText('仍有 129 段课程资料尚未被当前课程结构引用。原始资料仍然保留，可查看详情。'),
    ).toBeVisible();
    expect(screen.getByText(raw)).not.toBeVisible();
    await user.click(screen.getByText('技术详情'));
    expect(screen.getByText(raw)).toBeVisible();
  });

  it('shows a learner-readable proposal failure with optional validation detail', async () => {
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={null}
        history={[]}
        loading={false}
        error="生成的新课程结构没有通过资料一致性检查，原版本未改变。系统已尝试一次修复。"
        errorDetails={{
          kind: 'curriculum_candidate_validation',
          repairAttempted: true,
          errors: ['Curriculum evidence failed exact-quote validation.'],
          warnings: [],
        }}
        canPropose
        canAccept={false}
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('原版本未改变。系统已尝试一次修复。');
    expect(screen.getByText('有 1 条资料依据无法与本次课程资料的原文精确对应。')).toBeVisible();
    expect(screen.getByText('系统已经尝试了一次自动修复。')).toBeVisible();
    const summary = screen.getByText('查看原因与技术详情');
    expect(
      screen.queryByText('Curriculum evidence failed exact-quote validation.'),
    ).not.toBeInTheDocument();
    await user.click(summary);
    expect(screen.getByText('资料依据精确对应检查未通过。')).toBeVisible();
    expect(
      screen.queryByText('Curriculum evidence failed exact-quote validation.'),
    ).not.toBeInTheDocument();
  });

  it('explains an empty execution-remediation frontier without exposing internal diagnostics', () => {
    render(
      <CurriculumView
        hierarchy={hierarchy()}
        history={[]}
        loading={false}
        error="新课程结构仍不能支持下一步学习，因此没有生成新版本。当前已接受版本未改变。"
        errorDetails={{
          kind: 'curriculum_candidate_validation',
          repairAttempted: false,
          errors: [
            'StudyPlan execution repair: 0 of 21 LearningUnits have a supported launch capability.',
          ],
          warnings: [],
        }}
        canPropose
        canAccept={false}
        busyAction={null}
        onPropose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSelectHistory={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('当前已接受版本未改变');
    expect(screen.getByText('新课程结构仍没有可启动的学习单元，因此未生成新版本。')).toBeVisible();
    expect(
      screen.getByText('请先从当前课程资料生成有原文依据的概念，再提出新的课程结构。'),
    ).toBeVisible();
    expect(screen.queryByText(/StudyPlan execution repair/iu)).not.toBeInTheDocument();
  });

  it('preserves proposal acceptance, rejection, and version-history selection', async () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const onSelectHistory = vi.fn();
    const onOpenConceptGrounding = vi.fn();
    const user = userEvent.setup();
    render(
      <CurriculumView
        hierarchy={hierarchy()}
        history={[
          {
            id: 'curriculum_history_1',
            version: 1,
            predecessorId: null,
            contractVersionId: 'contract_1',
            status: 'accepted',
            title: 'Probability',
            learningUnitCount: 2,
            unmappedStructuralUnitCount: 0,
            validationValid: true,
            executionSourceManifestFingerprint: 'manifest_1',
            createdAt: AT,
            acceptedAt: AT,
          },
        ]}
        loading={false}
        error={null}
        canPropose={false}
        canAccept
        busyAction={null}
        onPropose={vi.fn()}
        onOpenConceptGrounding={onOpenConceptGrounding}
        onAccept={onAccept}
        onReject={onReject}
        onSelectHistory={onSelectHistory}
      />,
    );

    expect(screen.getByText('当前已接受版本 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '接受课程结构' }));
    await user.click(screen.getByRole('button', { name: '拒绝候选版本' }));
    await user.click(screen.getByText('版本历史（1）'));
    await user.click(screen.getByRole('button', { name: /版本 1/ }));
    await user.click(screen.getByText('高级课程准备'));
    await user.click(screen.getByRole('button', { name: '打开概念依据与图谱版本' }));
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
    expect(onSelectHistory).toHaveBeenCalledWith('curriculum_history_1');
    expect(onOpenConceptGrounding).toHaveBeenCalledOnce();
  });
});

describe('consolidated Course product shell', () => {
  it('opens the Weakness Map from Progress without inventing a learner-state conclusion', async () => {
    vi.spyOn(api, 'reviewItems').mockResolvedValue({ items: [] });
    const onOpenKnowledgeMap = vi.fn();
    const onOpenAssessment = vi.fn();
    const onSectionChange = vi.fn();
    const user = userEvent.setup();

    render(
      <CourseProgressView
        workspaceId="ws_1"
        documents={[]}
        overview={overview('launchable')}
        refreshKey={0}
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onRemediate={vi.fn()}
        remediationLoading={false}
        remediationError={null}
        operationError={null}
        onOpenKnowledgeMap={onOpenKnowledgeMap}
        onOpenAssessment={onOpenAssessment}
        onSectionChange={onSectionChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: '在知识地图中解释' }));
    expect(onOpenKnowledgeMap).toHaveBeenCalledOnce();
    await user.click(screen.getByText('高级评估'));
    await user.click(screen.getByRole('button', { name: '打开手动评估' }));
    expect(onOpenAssessment).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('tab', { name: '修复' }));
    expect(onSectionChange).toHaveBeenCalledWith('repair');
  });

  it('offers one learner-facing Course navigation model with Chinese Study naming', () => {
    render(
      <AgentCourseShell
        activeView="home"
        courseId="ws_1"
        courseName="Probability"
        courses={[{ id: 'ws_1', name: 'Probability' }]}
        onCourseChange={vi.fn()}
        onViewChange={vi.fn()}
      >
        <p>Course content</p>
      </AgentCourseShell>,
    );

    const navigation = screen.getByRole('navigation', { name: '课程导航' });
    expect(
      within(navigation)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['主页', '学习', '课程结构', '知识地图', '进展']);
    expect(within(navigation).queryByText('Study Session')).not.toBeInTheDocument();
    expect(within(navigation).queryByText('课程执行')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Hy3 Study Clinic · Probability · 主页',
      }),
    ).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: '主页' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps Course switching and Materials secondary while retiring compatibility navigation', async () => {
    const user = userEvent.setup();
    const onCourseChange = vi.fn();
    const onOpenMaterials = vi.fn();
    render(
      <AgentCourseShell
        activeView="home"
        courseId="ws_1"
        courseName="Probability"
        courses={[
          { id: 'ws_1', name: 'Probability' },
          { id: 'ws_2', name: 'Linear Algebra' },
        ]}
        onCourseChange={onCourseChange}
        onViewChange={vi.fn()}
        onOpenMaterials={onOpenMaterials}
      >
        <p>Course content</p>
      </AgentCourseShell>,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: '当前课程' }), 'ws_2');
    expect(onCourseChange).toHaveBeenCalledWith('ws_2');

    const secondary = screen.getByLabelText('课程辅助入口');
    await user.click(within(secondary).getByRole('button', { name: '课程资料' }));
    expect(onOpenMaterials).toHaveBeenCalledTimes(1);
    expect(within(secondary).queryByText('兼容与高级工具')).not.toBeInTheDocument();
  });

  it('presents Settings as the active system destination without selecting a Course view', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const { rerender } = render(
      <AgentCourseShell
        activeView="home"
        courseId="ws_1"
        courseName="Probability"
        courses={[{ id: 'ws_1', name: 'Probability' }]}
        onCourseChange={vi.fn()}
        onViewChange={vi.fn()}
        onOpenSettings={onOpenSettings}
      >
        <p>Course content</p>
      </AgentCourseShell>,
    );

    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    rerender(
      <AgentCourseShell
        activeView="explore"
        courseId="ws_1"
        courseName="Probability"
        courses={[{ id: 'ws_1', name: 'Probability' }]}
        settingsActive
        onCourseChange={vi.fn()}
        onViewChange={vi.fn()}
        onOpenSettings={onOpenSettings}
      >
        <p>Settings content</p>
      </AgentCourseShell>,
    );

    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '知识地图' })).not.toHaveAttribute('aria-current');
    expect(screen.getByLabelText('课程学习空间')).toHaveClass('view-settings');
    expect(screen.getByLabelText('课程学习空间')).not.toHaveClass('view-explore');
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Hy3 Study Clinic · Probability · 设置',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '设置' })).toBeInTheDocument();
  });

  it('persists a compact desktop rail without changing destination semantics', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(
      <AgentCourseShell
        activeView="home"
        courseId="ws_1"
        courseName="Probability"
        courses={[{ id: 'ws_1', name: 'Probability' }]}
        onCourseChange={vi.fn()}
        onViewChange={onViewChange}
      >
        <p>Course content</p>
      </AgentCourseShell>,
    );

    await user.click(screen.getByRole('button', { name: '学习' }));
    expect(onViewChange).toHaveBeenCalledWith('session');
    await user.click(screen.getByRole('button', { name: '折叠课程侧边栏' }));
    expect(screen.getByLabelText('课程侧边栏')).toHaveClass('is-collapsed');
    expect(screen.getByRole('button', { name: '展开课程侧边栏' })).toBeInTheDocument();
    expect(window.localStorage.getItem('hy3-clinic:course-sidebar-collapsed')).toBe('true');
    expect(screen.getByRole('button', { name: '主页' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens the narrow Course drawer, closes it with Escape, and restores focus', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query === '(max-width: 767px)',
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );

    render(
      <AgentCourseShell
        activeView="home"
        courseId="ws_1"
        courseName="Probability"
        courses={[{ id: 'ws_1', name: 'Probability' }]}
        onCourseChange={vi.fn()}
        onViewChange={vi.fn()}
      >
        <p>Course content</p>
      </AgentCourseShell>,
    );

    const opener = screen.getByRole('button', { name: '打开课程导航' });
    const sidebar = screen.getByLabelText('课程侧边栏', { selector: 'aside' });
    expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    await user.click(opener);
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar).not.toHaveAttribute('aria-hidden');
    expect(within(sidebar).getByRole('button', { name: '关闭课程导航' })).toHaveFocus();
    expect(screen.getByText('Course content').closest('.agent-course-content')).toHaveAttribute(
      'inert',
    );

    const lastDrawerControl = within(sidebar).getByRole('button', { name: '进展' });
    lastDrawerControl.focus();
    await user.tab();
    expect(within(sidebar).getByRole('button', { name: '关闭课程导航' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(lastDrawerControl).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    expect(opener).toHaveFocus();
    expect(screen.getByText('Course content').closest('.agent-course-content')).not.toHaveAttribute(
      'inert',
    );
  });

  it('closes the narrow drawer and moves focus to Settings content', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query === '(max-width: 767px)',
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );

    render(
      <AgentCourseShell
        activeView="home"
        courseId="ws_1"
        courseName="Probability"
        courses={[{ id: 'ws_1', name: 'Probability' }]}
        onCourseChange={vi.fn()}
        onViewChange={vi.fn()}
        onOpenSettings={onOpenSettings}
      >
        <p>Settings content</p>
      </AgentCourseShell>,
    );

    await user.click(screen.getByRole('button', { name: '打开课程导航' }));
    const sidebar = screen.getByLabelText('课程侧边栏', { selector: 'aside' });
    const workspace = screen.getByText('Settings content').closest('.agent-course-content');
    expect(workspace).toHaveAttribute('inert');

    await user.click(within(sidebar).getByRole('button', { name: '设置' }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    expect(workspace).not.toHaveAttribute('inert');
    expect(workspace).toHaveFocus();
  });

  it('keeps Course Materials actionable when the Course has no documents', () => {
    render(
      <CourseMaterialsView
        workspaceId="ws_1"
        documents={[]}
        roleHistory={{}}
        onChanged={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText(/这门课程还没有资料，这是新课程的正常状态/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加文本资料' })).toBeDisabled();
    expect(screen.getByLabelText('上传课程资料')).toBeInTheDocument();
  });

  it('keeps logical Material identity distinct from its current processing result', () => {
    render(
      <CourseMaterialsView
        workspaceId="ws_1"
        documents={[
          {
            ...documentSummary,
            id: 'material_1',
            workspaceId: 'ws_1',
            title: 'A very long but still readable course material filename.pdf',
            sourceType: 'pdf',
            parseStatus: 'parsed_with_warnings',
            extractionWarnings: ['Some pages required fallback extraction.'],
          },
        ]}
        roleHistory={{}}
        onChanged={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText(/这是课程中的同一份逻辑资料/)).toBeInTheDocument();
    expect(screen.getByText('逻辑资料 ID')).toBeInTheDocument();
    expect(screen.getByText('material_1')).toBeInTheDocument();
    expect(screen.getByText('已解析，有提示')).toBeInTheDocument();
  });

  it('consolidates assessments, mistakes, reviews, and route history under Progress', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'reviewItems').mockResolvedValue({ items: [] });
    vi.spyOn(api, 'listAttempts').mockResolvedValue({ attempts: [] });
    const progressOverview = overview('launchable');
    progressOverview.contractHistory = [
      {
        id: 'contract_history_1',
        version: 1,
        predecessorId: null,
        status: 'active',
        intent: 'Prepare for the exam',
        targetDescription: '通过期末考试',
        deadlineAt: null,
        desiredDepth: 'working_fluency',
        learnerConfirmedAt: AT,
        createdAt: AT,
      },
    ];
    progressOverview.curriculumHistory = [
      {
        id: 'curriculum_history_1',
        version: 1,
        predecessorId: null,
        contractVersionId: 'contract_history_1',
        status: 'accepted',
        title: '概率论',
        learningUnitCount: 4,
        unmappedStructuralUnitCount: 0,
        validationValid: true,
        executionSourceManifestFingerprint: 'manifest_1',
        createdAt: AT,
        acceptedAt: AT,
      },
    ];
    progressOverview.studyPlanHistory = [
      {
        id: 'plan_history_1',
        version: 1,
        predecessorId: null,
        contractVersionId: 'contract_history_1',
        curriculumVersionId: 'curriculum_history_1',
        status: 'accepted',
        proposalTrigger: 'Initial route',
        itemCount: 4,
        deferredUnitCount: 1,
        projectedMinutes: 90,
        feasibilityState: 'feasible',
        executionSourceManifestFingerprint: 'manifest_1',
        learnerAcceptedAt: AT,
        createdAt: AT,
      },
    ];
    render(
      <CourseProgressView
        workspaceId="ws_1"
        documents={[]}
        overview={progressOverview}
        refreshKey={0}
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onRemediate={vi.fn()}
        remediationLoading={false}
        remediationError={null}
        operationError={null}
      />,
    );

    const navigation = screen.getByRole('tablist', { name: '进展分类' });
    expect(within(navigation).getByRole('tab', { name: '正式证据' })).toBeInTheDocument();
    expect(within(navigation).getByRole('tab', { name: '修复' })).toBeInTheDocument();
    expect(within(navigation).getByRole('tab', { name: '掌握与复习' })).toBeInTheDocument();
    expect(within(navigation).getByRole('tab', { name: '历史与决定' })).toBeInTheDocument();
    expect(screen.getByText(/Tutor 对话和一般活动不会自动成为正式进展/)).toBeInTheDocument();
    expect(screen.getByText('测验、评估与版本记录')).toBeInTheDocument();
    expect(screen.queryByText('正式评估与版本记录')).not.toBeInTheDocument();
    within(navigation).getByRole('tab', { name: '概览' }).focus();
    await user.keyboard('{End}');
    await vi.waitFor(() =>
      expect(within(navigation).getByRole('tab', { name: '历史与决定' })).toHaveFocus(),
    );
    expect(within(navigation).getByRole('tab', { name: '历史与决定' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText(/版本 1 · 通过期末考试/)).toBeInTheDocument();
    expect(screen.getByText(/版本 1 · 概率论/)).toBeInTheDocument();
    expect(screen.getByText(/4 项 · 预计 90 分钟 · 1 项延期/)).toBeInTheDocument();
    expect(screen.getByLabelText('测验与评估历史')).toBeInTheDocument();
    expect(await screen.findByText(/还没有已完成的测验/)).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    await vi.waitFor(() =>
      expect(within(navigation).getByRole('tab', { name: '掌握与复习' })).toHaveFocus(),
    );
    await user.keyboard('{ArrowRight}');
    await vi.waitFor(() =>
      expect(within(navigation).getByRole('tab', { name: '历史与决定' })).toHaveFocus(),
    );
    await user.click(within(navigation).getByRole('tab', { name: '修复' }));
    expect(
      screen.getByText(/课程还没有资料，因此暂时没有可汇总的错题或掌握记录/),
    ).toBeInTheDocument();
  });

  it('reports review-count loading and failure without inventing a zero count', async () => {
    let rejectReviews: ((error: Error) => void) | undefined;
    vi.spyOn(api, 'reviewItems').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectReviews = reject;
        }),
    );

    render(
      <CourseProgressView
        workspaceId="ws_1"
        documents={[documentSummary]}
        overview={overview('launchable')}
        refreshKey={0}
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onRemediate={vi.fn()}
        remediationLoading={false}
        remediationError={null}
        operationError={null}
      />,
    );

    expect(screen.getByText('正在加载复习安排…')).toBeInTheDocument();
    expect(screen.queryByText('0 项复习记录')).not.toBeInTheDocument();

    rejectReviews?.(new Error('review service unavailable'));
    expect(await screen.findByText('复习记录暂时无法读取')).toBeInTheDocument();
    expect(screen.queryByText('0 项复习记录')).not.toBeInTheDocument();
  });

  it('shows learner Review workflow states without scheduler internals in Progress', async () => {
    const user = userEvent.setup();
    const review = {
      reviewTargetId: 'review-target:ws_1:objective_1',
      workspaceId: 'ws_1',
      courseId: 'ws_1',
      learningUnitId: 'unit_1',
      objectiveId: 'objective_1',
      objectiveTitle: '解释工作记忆容量',
      conceptIds: ['concept_1'],
      targetStatus: 'active' as const,
      lifecycleState: 'review' as const,
      dueAt: '2026-08-21T08:00:00.000Z',
      lastReviewedAt: '2026-08-20T08:00:00.000Z',
      stability: 9.876,
      difficulty: 4.321,
      scheduledDays: 3,
      repetitions: 2,
      lapses: 1,
      policyVersion: 'fsrs-policy-hidden-from-learner',
      workflowPhase: 'due' as const,
      schedulingRetryRequired: false,
      createdAt: AT,
      updatedAt: AT,
    };
    vi.spyOn(api, 'reviewItems').mockResolvedValue({
      items: [
        review,
        {
          ...review,
          reviewTargetId: 'review-target:ws_1:objective_2',
          objectiveId: 'objective_2',
          objectiveTitle: '应用容量限制',
          workflowPhase: 'retrieval',
        },
        {
          ...review,
          reviewTargetId: 'review-target:ws_1:objective_3',
          objectiveId: 'objective_3',
          objectiveTitle: '比较容量模型',
          workflowPhase: 'scheduling_retry',
          schedulingRetryRequired: true,
        },
      ],
    });
    vi.spyOn(api, 'listAttempts').mockResolvedValue({ attempts: [] });

    render(
      <CourseProgressView
        workspaceId="ws_1"
        documents={[documentSummary]}
        overview={overview('launchable')}
        refreshKey={0}
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onRemediate={vi.fn()}
        remediationLoading={false}
        remediationError={null}
        operationError={null}
      />,
    );

    await user.click(screen.getByRole('tab', { name: '掌握与复习' }));
    expect(await screen.findByText('解释工作记忆容量')).toBeInTheDocument();
    expect(screen.getByText(/现在到期/)).toBeInTheDocument();
    expect(screen.getByText(/正式回忆进行中/)).toBeInTheDocument();
    expect(screen.getByText(/正式结果已保存，安排待同步/)).toBeInTheDocument();
    expect(screen.queryByText(/9\.876|4\.321|fsrs-policy-hidden/i)).not.toBeInTheDocument();
  });

  it('renders a Progress-owned operation failure inside Progress', () => {
    vi.spyOn(api, 'reviewItems').mockImplementation(() => new Promise(() => {}));

    render(
      <CourseProgressView
        workspaceId="ws_1"
        documents={[]}
        overview={overview('launchable')}
        refreshKey={0}
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onRemediate={vi.fn()}
        remediationLoading={false}
        remediationError={null}
        operationError="路线调整暂时无法保存。"
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      '这次进展操作未完成。路线调整暂时无法保存。',
    );
  });
});
