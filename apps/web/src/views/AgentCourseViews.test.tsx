import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CourseExecutionOverview,
  CurriculumHierarchyView,
  LearningContract,
  SessionAgenda,
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
    loading: false,
    error: null,
    busyAction: null,
    onCreateContract: vi.fn(),
    onEditContract: vi.fn(),
    onConfirmContract: vi.fn(),
    onProposeCurriculum: vi.fn(),
    onOpenCurriculum: vi.fn(),
    onProposeStudyPlan: vi.fn(),
    onEditStudyPlan: vi.fn(),
    onAcceptStudyPlan: vi.fn(),
    onRejectStudyPlan: vi.fn(),
    onLaunchNext: vi.fn(),
    onOpenMaterials: vi.fn(),
  };
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

describe('CourseHomeView action and authority rendering', () => {
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

    expect(screen.getByText('277 个学习单元 · 277 个学习目标')).toBeInTheDocument();
    expect(screen.queryByText('Large course unit 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Large course unit 277')).not.toBeInTheDocument();

    const expandSection = screen.getByRole('button', { name: '查看内容（277 个单元）' });
    expect(expandSection).toHaveAttribute('aria-expanded', 'false');
    expect(expandSection).toHaveAttribute('aria-controls');
    await user.click(expandSection);

    expect(expandSection).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Large course unit 1')).toBeInTheDocument();
    expect(screen.getByText('Large course unit 12')).toBeInTheDocument();
    expect(screen.queryByText('Large course unit 13')).not.toBeInTheDocument();
    expect(screen.queryByText('Large course unit 277')).not.toBeInTheDocument();

    const showRemaining = screen.getByRole('button', { name: '显示其余 265 个学习单元' });
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
    await user.click(screen.getByRole('button', { name: '查看内容（2 个单元）' }));
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
    await user.click(within(sectionNode!).getByRole('button', { name: '查看内容（2 个单元）' }));
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
    const courseBasis = screen.getByText('课程依据与精确版本');
    await user.click(courseBasis);
    expect(screen.getByText('manifest_1')).toBeInTheDocument();
    expect(screen.getByText('block_1')).toBeInTheDocument();
    expect(screen.getByText(/不单独证明完整语义蕴含/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看内容（2 个单元）' }));
    await user.click(screen.getByText('课程依据（1）'));
    expect(screen.getByText(/来源块 source_block_1/)).toBeInTheDocument();
    expect(screen.getByText(/来源块修订 source_block_fingerprint_1/)).toBeInTheDocument();
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
    expect(screen.getByText('学习单元').closest('div')).toHaveTextContent('学习单元2');
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

  it('preserves proposal acceptance, rejection, and version-history selection', async () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const onSelectHistory = vi.fn();
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
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
    expect(onSelectHistory).toHaveBeenCalledWith('curriculum_history_1');
  });
});

describe('consolidated Course product shell', () => {
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
    ).toEqual(['主页', '学习', '课程结构', '进展', '探索']);
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

  it('keeps Course switching and Materials secondary to the five primary destinations', async () => {
    const user = userEvent.setup();
    const onCourseChange = vi.fn();
    const onOpenMaterials = vi.fn();
    const onOpenAdvancedTools = vi.fn();
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
        onOpenAdvancedTools={onOpenAdvancedTools}
      >
        <p>Course content</p>
      </AgentCourseShell>,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: '当前课程' }), 'ws_2');
    expect(onCourseChange).toHaveBeenCalledWith('ws_2');

    const secondary = screen.getByLabelText('课程辅助入口');
    await user.click(within(secondary).getByRole('button', { name: '课程资料' }));
    expect(onOpenMaterials).toHaveBeenCalledTimes(1);
    await user.click(within(secondary).getByRole('button', { name: '兼容与高级工具' }));
    expect(onOpenAdvancedTools).toHaveBeenCalledTimes(1);
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
        activeView="home"
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
    expect(screen.getByRole('button', { name: '主页' })).not.toHaveAttribute('aria-current');
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
        onOpenAdvancedTools={vi.fn()}
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

    const lastDrawerControl = within(sidebar).getByRole('button', { name: '兼容与高级工具' });
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
      />,
    );

    expect(screen.getByText('正在加载复习安排…')).toBeInTheDocument();
    expect(screen.queryByText('0 项复习记录')).not.toBeInTheDocument();

    rejectReviews?.(new Error('review service unavailable'));
    expect(await screen.findByText('复习记录暂时无法读取')).toBeInTheDocument();
    expect(screen.queryByText('0 项复习记录')).not.toBeInTheDocument();
  });
});
