import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CourseExecutionOverview,
  LearningContractDetailResponse,
  MaterialRoleAssignment,
  MaterialRoleHistoryResponse,
} from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import { documentSummary, workspace, workspaceSummary } from '../test/fixtures.js';
import { AgentCourseWorkspace } from './AgentCourseWorkspace.js';

const AT = '2026-08-12T11:54:07.530Z';
const legacyRole: MaterialRoleAssignment = {
  id: 'role_1',
  materialId: documentSummary.id,
  version: 1,
  predecessorId: null,
  role: 'unknown',
  status: 'proposed',
  proposedBy: 'local',
  learnerConfirmedAt: null,
  createdAt: AT,
};
const strandedProposal: MaterialRoleAssignment = {
  id: 'role_2',
  materialId: documentSummary.id,
  version: 2,
  predecessorId: legacyRole.id,
  role: 'course_material',
  status: 'proposed',
  proposedBy: 'learner',
  learnerConfirmedAt: null,
  createdAt: AT,
};

function contractRequiredOverview(): CourseExecutionOverview {
  return {
    workspaceId: workspace.id,
    setupStage: 'contract_required',
    executionStatus: 'active',
    courseExecutionVersion: 0,
    activeContract: null,
    pendingContract: null,
    contractFeasibility: null,
    acceptedCurriculum: null,
    planningCurriculum: null,
    proposedCurriculum: null,
    curriculumHierarchy: null,
    activeCurriculumHierarchy: null,
    acceptedStudyPlan: null,
    proposedStudyPlan: null,
    activeAgenda: null,
    formalProgress: {
      planItemCount: 0,
      completedPlanItemCount: 0,
      startedPlanItemCount: 0,
      repairNeededPlanItemCount: 0,
      deferredPlanItemCount: 0,
      stateCreditingEvidenceCount: 0,
      advisoryEvidenceCount: 0,
    },
    nextAction: null,
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
      canContinueStudy: false,
    },
    contractHistory: [],
    curriculumHistory: [],
    studyPlanHistory: [],
    generatedAt: AT,
  };
}

function roleHistory(current: MaterialRoleAssignment): MaterialRoleHistoryResponse {
  return {
    materialId: documentSummary.id,
    current,
    history: [legacyRole, current],
  };
}

function renderWorkspace() {
  return render(
    <AgentCourseWorkspace
      workspaceId={workspace.id}
      onWorkspaceChange={vi.fn()}
      onLaunchQuiz={vi.fn()}
      refreshKey={0}
      provider="fake"
    />,
  );
}

async function openContractEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '设置学习目标' }));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(api, 'listWorkspaces').mockResolvedValue({ workspaces: [workspaceSummary] });
  vi.spyOn(api, 'getWorkspace').mockResolvedValue({
    workspace,
    documents: [documentSummary],
  });
  vi.spyOn(api, 'courseExecution').mockResolvedValue({ overview: contractRequiredOverview() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LIVE-01 Learning Contract material-role recovery', () => {
  it('LIVE01-A shows stale assignment state and does not silently progress', async () => {
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    const createContract = vi.spyOn(api, 'createLearningContract');
    const user = userEvent.setup();
    renderWorkspace();

    await openContractEditor(user);

    expect(screen.getByText('课程资料已更新，需要重新确认资料用途')).toBeInTheDocument();
    expect(screen.getByText(/请检查资料角色与范围，确认后再继续保存学习约定/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认资料用途并保存约定草稿' })).toBeInTheDocument();
    expect(createContract).not.toHaveBeenCalled();
  });

  it('LIVE01-C/D/F confirms the authoritative proposal, saves, refreshes, and survives reload', async () => {
    let current = strandedProposal;
    const history = vi
      .spyOn(api, 'materialRoleHistory')
      .mockImplementation(async () => roleHistory(current));
    const propose = vi.spyOn(api, 'proposeMaterialRole');
    const confirm = vi.spyOn(api, 'confirmMaterialRole').mockImplementation(async () => {
      current = {
        ...strandedProposal,
        status: 'learner_confirmed',
        learnerConfirmedAt: AT,
      };
      return current;
    });
    const createContract = vi
      .spyOn(api, 'createLearningContract')
      .mockImplementation(async (_workspaceId, input) => {
        const response: LearningContractDetailResponse = {
          contract: {
            id: 'contract_1',
            workspaceId: workspace.id,
            version: 1,
            predecessorId: null,
            ...input.fields,
            status: 'draft',
            proposedBy: 'learner',
            learnerConfirmedAt: null,
            createdAt: AT,
          },
          feasibility: {
            state: 'unknown',
            deadlineAt: null,
            availableMinutes: null,
            projectedMinutes: null,
            slackMinutes: null,
            reasonCodes: ['deadline_absent', 'effort_unknown'],
            assumptions: [],
            policyVersion: 'contract-feasibility-v1',
            computedAt: AT,
          },
        };
        return response;
      });
    const user = userEvent.setup();
    const firstRender = renderWorkspace();

    await openContractEditor(user);
    await user.type(screen.getByLabelText('学习意图'), '掌握课程内容');
    await user.type(screen.getByLabelText('目标结果'), '完成课程学习');
    await user.type(screen.getByLabelText('每天可用分钟'), '30');
    await user.type(screen.getByLabelText(/课程主题范围/), '认知科学');
    await user.selectOptions(
      screen.getByLabelText(`${documentSummary.title}资料角色`),
      'course_material',
    );
    await user.click(screen.getByRole('button', { name: '确认资料用途并保存约定草稿' }));

    await waitFor(() => expect(createContract).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith(
      workspace.id,
      documentSummary.id,
      strandedProposal.id,
      expect.objectContaining({
        assignmentId: strandedProposal.id,
        expectedVersion: strandedProposal.version,
      }),
      expect.any(AbortSignal),
    );
    expect(propose).not.toHaveBeenCalled();
    expect(history).toHaveBeenCalledTimes(3);
    expect(createContract.mock.calls[0]![1].fields.courseScope.materials[0]).toMatchObject({
      materialId: documentSummary.id,
      materialRoleAssignmentId: strandedProposal.id,
      materialRoleAssignmentVersion: strandedProposal.version,
      role: 'course_material',
    });

    firstRender.unmount();
    renderWorkspace();
    await openContractEditor(user);
    expect(screen.queryByText('课程资料已更新，需要重新确认资料用途')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存约定草稿' })).toBeInTheDocument();
  });

  it('LIVE01-A refreshes a concurrent stale conflict and replaces raw server copy', async () => {
    const confirmedRole: MaterialRoleAssignment = {
      ...strandedProposal,
      status: 'learner_confirmed',
      learnerConfirmedAt: AT,
    };
    let current = confirmedRole;
    vi.spyOn(api, 'materialRoleHistory').mockImplementation(async () => roleHistory(current));
    vi.spyOn(api, 'proposeMaterialRole').mockImplementation(async () => {
      current = {
        ...strandedProposal,
        id: 'role_3',
        version: 3,
        predecessorId: confirmedRole.id,
        role: 'supplementary_reference',
      };
      throw new ApiClientError('VERSION_CONFLICT', 'Material role assignment is stale.', 409);
    });
    const createContract = vi.spyOn(api, 'createLearningContract');
    const user = userEvent.setup();
    renderWorkspace();

    await openContractEditor(user);
    await user.type(screen.getByLabelText('学习意图'), '掌握课程内容');
    await user.type(screen.getByLabelText('目标结果'), '完成课程学习');
    await user.type(screen.getByLabelText('每天可用分钟'), '30');
    await user.type(screen.getByLabelText(/课程主题范围/), '认知科学');
    await user.selectOptions(
      screen.getByLabelText(`${documentSummary.title}资料角色`),
      'supplementary_reference',
    );
    await user.click(screen.getByRole('button', { name: '确认资料用途并保存约定草稿' }));

    expect(
      await screen.findByText(
        '课程资料已更新，需要重新确认资料用途。请检查资料角色与范围后再次保存学习约定。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Material role assignment is stale.')).not.toBeInTheDocument();
    expect(createContract).not.toHaveBeenCalled();
  });
});

describe('Course Settings navigation continuity', () => {
  it('keeps the same selected Course when opened from every Course destination', async () => {
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    vi.spyOn(api, 'config').mockResolvedValue({
      provider: 'fake',
      baseUrl: null,
      model: null,
      apiKeyConfigured: false,
      source: 'default',
      complete: true,
      runtimeGeneration: 1,
      externalConnection: { status: 'untested', testedGeneration: null, message: null },
    });
    const user = userEvent.setup();
    renderWorkspace();

    const courseSelector = await screen.findByRole('combobox', { name: '当前课程' });
    expect(courseSelector).toHaveValue(workspace.id);

    for (const destination of [
      { label: '主页', className: 'view-home' },
      { label: '探索', className: 'view-explore' },
      { label: '课程结构', className: 'view-curriculum' },
      { label: '进展', className: 'view-progress' },
      { label: '课程资料', className: 'view-materials' },
    ]) {
      await user.click(screen.getByRole('button', { name: destination.label }));
      expect(screen.getByLabelText('课程学习空间')).toHaveClass(destination.className);

      await user.click(screen.getByRole('button', { name: '设置' }));
      const shell = screen.getByLabelText('课程学习空间');
      expect(courseSelector).toHaveValue(workspace.id);
      expect(screen.getByRole('navigation', { name: '课程导航' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('button', { name: destination.label })).not.toHaveAttribute(
        'aria-current',
      );
      expect(shell).toHaveClass('view-settings');
      expect(shell).not.toHaveClass(destination.className);
      expect(screen.getByLabelText('课程连续性')).toHaveTextContent(workspace.name);
    }
  });

  it('opens Settings from the no-Course state without inventing Course context', async () => {
    vi.spyOn(api, 'config').mockResolvedValue({
      provider: 'fake',
      baseUrl: null,
      model: null,
      apiKeyConfigured: false,
      source: 'default',
      complete: true,
      runtimeGeneration: 1,
      externalConnection: { status: 'untested', testedGeneration: null, message: null },
    });
    const user = userEvent.setup();
    render(
      <AgentCourseWorkspace
        workspaceId={null}
        onWorkspaceChange={vi.fn()}
        onLaunchQuiz={vi.fn()}
        refreshKey={0}
        provider="fake"
      />,
    );

    expect(await screen.findByRole('heading', { name: '选择一门课程' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '设置' }));

    expect(screen.getByLabelText('课程学习空间')).toHaveClass('view-settings');
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText('课程连续性')).toHaveTextContent('已启用 · 尚未选择课程');
  });
});
