import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CourseExecutionOverview,
  CoursePreparation,
  LearningContractDetailResponse,
  MaterialRoleAssignment,
  MaterialRoleHistoryResponse,
} from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import {
  concepts,
  documentSummary,
  material,
  workspace,
  workspaceSummary,
} from '../test/fixtures.js';
import { knowledgeMapProjection } from '../test/knowledgeMapFixture.js';
import { AgentCourseWorkspace } from './AgentCourseWorkspace.js';

const AT = '2026-08-12T11:54:07.530Z';

function mockSettingsConfig(): void {
  vi.spyOn(api, 'config').mockResolvedValue({
    provider: 'fake',
    baseUrl: null,
    model: null,
    apiKeyConfigured: false,
    source: 'default',
    complete: true,
    runtimeGeneration: 1,
    externalConnection: {
      status: 'untested',
      testedGeneration: null,
      testedAt: null,
      message: null,
    },
  });
}

function preparation(overrides: Partial<CoursePreparation> = {}): CoursePreparation {
  return {
    workspaceId: workspace.id,
    revision: 'preparation-revision-1',
    operationKey: null,
    state: 'not_started',
    machineAction: null,
    learnerAction: 'confirm_learning_goal',
    learnerDecisionRequired: false,
    canResume: false,
    canCancel: false,
    checkpoints: {
      materials: 'pending',
      concepts: 'blocked',
      courseStructure: 'pending',
      coursePlan: 'pending',
    },
    blocker: {
      code: 'learning_goal_required',
      message: '请先确认学习目标和课程资料范围。',
    },
    failure: null,
    generatedAt: AT,
    ...overrides,
  };
}
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
    contractScopeReadiness: null,
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

function planRequiredOverview(): CourseExecutionOverview {
  const base = contractRequiredOverview();
  return {
    ...base,
    setupStage: 'plan_required',
    activeContract: {
      id: 'contract_1',
      workspaceId: workspace.id,
      version: 1,
      predecessorId: null,
      intent: '掌握课程内容',
      targetOutcome: { description: '完成课程学习', targetScore: null, credential: null },
      deadline: null,
      studyBudget: {
        minutesPerDay: 30,
        minutesPerWeek: null,
        preferredSessionMinutes: 30,
        unavailablePeriods: [],
      },
      desiredDepth: 'working_fluency',
      courseScope: {
        subjectBoundaries: ['认知科学'],
        materials: [],
        includedTopics: [],
        excludedTopics: [],
      },
      learnerSelfReport: null,
      examContext: null,
      riskTolerance: {
        description: null,
        allowExplicitDeferral: false,
        maximumUnresolvedPriority: null,
      },
      status: 'active',
      proposedBy: 'learner',
      learnerConfirmedAt: AT,
      createdAt: AT,
    },
    planningCurriculum: {
      id: 'curriculum_1',
      workspaceId: workspace.id,
      contractVersionId: 'contract_1',
      version: 1,
      predecessorId: null,
      status: 'accepted',
      executionSourceManifest: { fingerprint: 'manifest_1', revisions: [] },
      nodes: [],
      synthesisGroups: [],
      validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
      provider: 'fake',
      providerModel: null,
      createdAt: AT,
      acceptedAt: AT,
    },
    capabilities: { ...base.capabilities, canProposeStudyPlan: true },
  };
}

function contractReviewOverview(): CourseExecutionOverview {
  const base = planRequiredOverview();
  const pending = {
    ...base.activeContract!,
    status: 'proposed' as const,
    learnerConfirmedAt: null,
  };
  return {
    ...base,
    setupStage: 'contract_review',
    activeContract: null,
    pendingContract: pending,
    contractFeasibility: null,
    acceptedCurriculum: null,
    planningCurriculum: null,
    capabilities: {
      ...base.capabilities,
      canConfirmContract: true,
      canProposeStudyPlan: false,
    },
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
      refreshKey={0}
      provider="fake"
    />,
  );
}

async function openContractEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '设置课程' }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.spyOn(api, 'listWorkspaces').mockResolvedValue({ workspaces: [workspaceSummary] });
  vi.spyOn(api, 'getWorkspace').mockResolvedValue({
    workspace,
    documents: [documentSummary],
  });
  vi.spyOn(api, 'courseExecution').mockResolvedValue({ overview: contractRequiredOverview() });
  vi.spyOn(api, 'coursePreparation').mockResolvedValue({ preparation: preparation() });
  vi.spyOn(api, 'getKnowledgeMap').mockResolvedValue({ projection: knowledgeMapProjection() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LIVE-01 Learning Contract material-role recovery', () => {
  it('LIVE01-A hides role configuration while preserving the authoritative save boundary', async () => {
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    const createContract = vi.spyOn(api, 'createLearningContract');
    const user = userEvent.setup();
    renderWorkspace();

    await openContractEditor(user);

    expect(screen.getByText(documentSummary.title)).toBeInTheDocument();
    expect(screen.queryByLabelText(`${documentSummary.title}资料角色`)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`${documentSummary.title}范围`)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始准备课程' })).toBeInTheDocument();
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
            deadline: input.fields.deadline ?? null,
            studyBudget: input.fields.studyBudget ?? {
              minutesPerDay: null,
              minutesPerWeek: null,
              preferredSessionMinutes: null,
              unavailablePeriods: [],
              availabilityPolicy: 'estimate',
            },
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
    expect(screen.queryByText('你能投入多少时间？')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('每天可用分钟')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('每周可用分钟')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('单次学习分钟（可选）')).not.toBeInTheDocument();
    expect(screen.queryByText('希望何时完成？')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('截止时间（可选）')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('学习意图')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('目标结果')).not.toBeInTheDocument();
    expect(screen.queryByText('目标分数（可选）')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/课程主题范围/)).not.toBeInTheDocument();
    expect(screen.queryByText('既往学习情况（自述）')).not.toBeInTheDocument();
    expect(screen.queryByText('高级范围与考试设置')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('全局学习深度'), 'deep_transfer');
    await user.type(screen.getByLabelText('特别关注的内容（可选）'), 'Embedding、Rerank');
    await user.click(screen.getByRole('button', { name: '开始准备课程' }));

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
    expect(createContract.mock.calls[0]![1].fields).not.toHaveProperty('deadline');
    expect(createContract.mock.calls[0]![1].fields).not.toHaveProperty('studyBudget');
    expect(createContract.mock.calls[0]![1].fields).toMatchObject({
      desiredDepth: 'deep_transfer',
      focusRequest: 'Embedding、Rerank',
      targetOutcome: { targetScore: null },
      courseScope: { includedTopics: [], excludedTopics: [] },
      learnerSelfReport: null,
      examContext: null,
    });

    firstRender.unmount();
    renderWorkspace();
    await openContractEditor(user);
    expect(screen.getByRole('button', { name: '开始准备课程' })).toBeInTheDocument();
  });

  it('LIVE01-A refreshes a concurrent stale conflict and replaces raw server copy', async () => {
    const confirmedRole: MaterialRoleAssignment = {
      ...strandedProposal,
      status: 'learner_confirmed',
      learnerConfirmedAt: AT,
    };
    let current: MaterialRoleAssignment = {
      ...strandedProposal,
      id: 'role_3',
      version: 3,
      predecessorId: confirmedRole.id,
      role: 'supplementary_reference',
    };
    vi.spyOn(api, 'materialRoleHistory').mockImplementation(async () => ({
      materialId: documentSummary.id,
      current,
      history: [legacyRole, confirmedRole, current],
    }));
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
    await user.click(screen.getByRole('button', { name: '开始准备课程' }));

    expect(
      await screen.findByText(
        '课程资料已更新，需要重新确认资料用途。请检查资料状态后再次保存课程设置。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Material role assignment is stale.')).not.toBeInTheDocument();
    expect(createContract).not.toHaveBeenCalled();
  });

  it('replaces a stale Contract predecessor diagnostic with learner-safe Chinese copy', async () => {
    const confirmedRole: MaterialRoleAssignment = {
      ...strandedProposal,
      status: 'learner_confirmed',
      learnerConfirmedAt: AT,
    };
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(confirmedRole));
    vi.spyOn(api, 'createLearningContract').mockRejectedValue(
      new ApiClientError('VERSION_CONFLICT', 'Learning Contract pointers are stale.', 409, {
        kind: 'learning_contract_pointer_conflict',
      }),
    );
    const user = userEvent.setup();
    renderWorkspace();

    await openContractEditor(user);
    await user.click(screen.getByRole('button', { name: '开始准备课程' }));

    expect(
      await screen.findByText('课程设置状态已更新，请检查当前设置后再保存。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Learning Contract pointers are stale.')).not.toBeInTheDocument();
  });

  it('closes the Contract editor when navigating to the Knowledge Map', async () => {
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    const user = userEvent.setup();
    renderWorkspace();

    await openContractEditor(user);
    expect(screen.getByLabelText('课程设计设置')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '知识地图' }));

    expect(screen.queryByLabelText('课程设计设置')).not.toBeInTheDocument();
    expect(screen.getByLabelText('课程学习空间')).toHaveClass('view-explore');
  });

  it('clears a Knowledge Map Progress focus after leaving Progress', async () => {
    vi.spyOn(api, 'reviewItems').mockResolvedValue({ items: [] });
    vi.spyOn(api, 'mistakes').mockResolvedValue({ mistakes: [], weakConcepts: [] });
    vi.spyOn(api, 'getLearnerRepair').mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: '知识地图' }));
    fireEvent.click((await screen.findByText('认知负荷应用')).closest('.react-flow__node')!);
    await user.click(screen.getByRole('button', { name: '查看修复' }));
    expect(await screen.findByLabelText('知识地图定位结果')).toHaveTextContent('查看当前修复');

    await user.click(screen.getByRole('button', { name: '主页' }));
    await user.click(screen.getByRole('button', { name: '进展' }));

    expect(screen.queryByLabelText('知识地图定位结果')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
  });

  it('does not label ordinary Progress navigation as a Knowledge Map focus', async () => {
    vi.spyOn(api, 'reviewItems').mockResolvedValue({ items: [] });
    render(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={vi.fn()}
        refreshKey={0}
        navigationIntent={{ requestId: 1, destination: 'progress-overview' }}
      />,
    );
    expect(await screen.findByRole('tab', { name: '概览' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByLabelText('知识地图定位结果')).not.toBeInTheDocument();
  });

  it('uses the latest confirmed role as the hidden compatibility default', async () => {
    const contractedRole: MaterialRoleAssignment = {
      ...strandedProposal,
      status: 'superseded',
      learnerConfirmedAt: AT,
    };
    const changedRole: MaterialRoleAssignment = {
      ...contractedRole,
      id: 'role_3',
      version: 3,
      predecessorId: contractedRole.id,
      role: 'supplementary_reference',
      status: 'superseded',
    };
    const pendingRole: MaterialRoleAssignment = {
      ...changedRole,
      id: 'role_4',
      version: 4,
      predecessorId: changedRole.id,
      role: 'past_exam',
      status: 'proposed',
      learnerConfirmedAt: null,
    };
    const value = planRequiredOverview();
    value.activeContract!.courseScope.materials = [
      {
        materialId: documentSummary.id,
        materialRoleAssignmentId: contractedRole.id,
        materialRoleAssignmentVersion: contractedRole.version,
        role: 'course_material',
        disposition: 'included',
      },
    ];
    value.contractScopeReadiness = {
      state: 'reconfirmation_required',
      issues: [
        {
          kind: 'material_role_changed',
          materialId: documentSummary.id,
          contractedRole: 'course_material',
          currentConfirmedRole: 'supplementary_reference',
        },
      ],
    };
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: value });
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue({
      materialId: documentSummary.id,
      current: pendingRole,
      history: [legacyRole, contractedRole, changedRole, pendingRole],
    });
    const proposeRole = vi.spyOn(api, 'proposeMaterialRole').mockResolvedValue({
      ...pendingRole,
      id: 'role_5',
      version: 5,
      predecessorId: pendingRole.id,
      role: 'supplementary_reference',
    });
    vi.spyOn(api, 'confirmMaterialRole').mockResolvedValue({
      ...pendingRole,
      id: 'role_5',
      version: 5,
      predecessorId: pendingRole.id,
      role: 'supplementary_reference',
      status: 'learner_confirmed',
      learnerConfirmedAt: AT,
    });
    vi.spyOn(api, 'createLearningContract').mockRejectedValue(new Error('stop after role check'));
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: '重新确认课程设置' }));
    expect(screen.queryByLabelText(`${documentSummary.title}资料角色`)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始准备课程' }));
    await waitFor(() =>
      expect(proposeRole).toHaveBeenCalledWith(
        workspace.id,
        documentSummary.id,
        expect.objectContaining({ role: 'supplementary_reference' }),
        expect.any(AbortSignal),
      ),
    );
  });
});

describe('Course preparation orchestration', () => {
  it.each(['failed_recoverable', 'course_plan_ready'] as const)(
    'backs off unchanged progress and stops polling at %s even with a pending POST',
    async (state) => {
      vi.mocked(api.courseExecution).mockResolvedValue({ overview: planRequiredOverview() });
      vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
      let current = preparation({
        operationKey: 'prepare-course-ws-1',
        state: 'failed_recoverable',
        machineAction: 'prepare_course_structure',
        learnerAction: 'resume_preparation',
        canResume: true,
        canCancel: false,
        blocker: null,
      });
      vi.mocked(api.coursePreparation).mockImplementation(async () => ({ preparation: current }));
      let finish!: (value: { preparation: CoursePreparation }) => void;
      vi.spyOn(api, 'runCoursePreparation').mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const view = renderWorkspace();
      const button = await screen.findByRole('button', { name: '重试课程准备' });
      vi.useFakeTimers();
      try {
        fireEvent.click(button);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        // A poll can still see the previous failure before the retry POST starts.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
        current = { ...current, state: 'preparing_course_structure', canCancel: true };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        const before = vi.mocked(api.coursePreparation).mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60000);
        });
        const polls = vi.mocked(api.coursePreparation).mock.calls.length - before;
        expect(polls).toBeGreaterThan(0);
        expect(polls).toBeLessThanOrEqual(7);
        current = {
          ...current,
          state,
          canCancel: false,
          failure:
            state === 'failed_recoverable'
              ? {
                  code: 'GROUNDING_FAILED',
                  action: 'prepare_course_structure',
                  occurredAt: AT,
                  retryable: true,
                }
              : null,
        };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30000);
        });
        const stopped = vi.mocked(api.coursePreparation).mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60000);
        });
        expect(api.coursePreparation).toHaveBeenCalledTimes(stopped);
        expect(api.runCoursePreparation).toHaveBeenCalledOnce();
        if (state === 'failed_recoverable') {
          const finishOldRequest = finish;
          fireEvent.click(screen.getByRole('button', { name: '重试课程准备' }));
          await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
          });
          expect(api.runCoursePreparation).toHaveBeenCalledTimes(2);
          await act(async () => {
            finishOldRequest({ preparation: current });
          });
          expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
        }
      } finally {
        view.unmount();
        await act(async () => {
          finish({ preparation: current });
        });
        vi.useRealTimers();
      }
    },
  );
  it('polls saved progress while the run is pending and displays the later stage', async () => {
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: planRequiredOverview() });
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    let current = preparation({
      operationKey: 'prepare-course-ws-1',
      state: 'preparing_concepts',
      machineAction: 'prepare_concepts',
      learnerAction: 'resume_preparation',
      canResume: true,
      canCancel: false,
      blocker: null,
    });
    vi.mocked(api.coursePreparation).mockImplementation(async () => ({ preparation: current }));
    let finish: ((value: { preparation: CoursePreparation }) => void) | undefined;
    vi.spyOn(api, 'runCoursePreparation').mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    const view = renderWorkspace();
    await user.click(await screen.findByRole('button', { name: '继续准备课程' }));
    current = {
      ...current,
      state: 'preparing_course_structure',
      machineAction: 'prepare_course_structure',
      canCancel: true,
      preparedConceptCount: 12,
      activity: {
        phase: 'curriculum_details',
        label: '检索与排序',
        completed: 1,
        total: 3,
        updatedAt: AT,
      },
    };
    expect(await screen.findByText('已完成 1 / 3 个学习单元', {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByText('已保存 12 个有原文依据的概念')).toBeVisible();
    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
    view.unmount();
    finish?.({ preparation: current });
  });
  it('starts preparation automatically after the learner confirms the Contract', async () => {
    const value = contractReviewOverview();
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: value });
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));

    const resumable = preparation({
      revision: 'preparation-revision-2',
      operationKey: 'prepare-course-ws-1',
      state: 'preparing_concepts',
      machineAction: 'prepare_concepts',
      learnerAction: 'resume_preparation',
      canResume: true,
      canCancel: true,
      checkpoints: {
        materials: 'complete',
        concepts: 'in_progress',
        courseStructure: 'pending',
        coursePlan: 'pending',
      },
      blocker: null,
    });
    const ready = preparation({
      revision: 'preparation-revision-3',
      state: 'course_plan_ready',
      learnerAction: 'review_course_plan',
      learnerDecisionRequired: true,
      checkpoints: {
        materials: 'complete',
        concepts: 'complete',
        courseStructure: 'complete',
        coursePlan: 'complete',
      },
      blocker: null,
    });
    let currentPreparation = preparation();
    vi.mocked(api.coursePreparation).mockImplementation(async () => ({
      preparation: currentPreparation,
    }));

    const confirmedContract = {
      ...value.pendingContract!,
      status: 'learner_confirmed' as const,
      learnerConfirmedAt: AT,
    };
    const transition = vi.spyOn(api, 'transitionLearningContract').mockImplementation(async () => {
      currentPreparation = resumable;
      return {
        contract: confirmedContract,
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
    });
    const run = vi.spyOn(api, 'runCoursePreparation').mockImplementation(async () => {
      currentPreparation = ready;
      return { preparation: ready };
    });
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: '开始准备课程' }));

    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(transition).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        command: expect.objectContaining({
          commandId: resumable.operationKey,
          idempotencyKey: resumable.operationKey,
          workspaceId: workspace.id,
          actor: 'learner',
        }),
        expectedRevision: resumable.revision,
      }),
      expect.any(AbortSignal),
    );
  });

  it('keeps Curriculum as an observation surface while preparation owns structure', async () => {
    const value = planRequiredOverview();
    value.capabilities = { ...value.capabilities, canProposeCurriculum: true };
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: value });
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    vi.mocked(api.coursePreparation).mockResolvedValue({
      preparation: preparation({
        operationKey: 'prepare-course-ws-structure',
        state: 'preparing_course_structure',
        machineAction: 'prepare_course_structure',
        learnerAction: 'resume_preparation',
        canResume: true,
        canCancel: true,
        checkpoints: {
          materials: 'complete',
          concepts: 'complete',
          courseStructure: 'in_progress',
          coursePlan: 'pending',
        },
        blocker: null,
      }),
    });

    const user = userEvent.setup();
    renderWorkspace();
    await user.click(await screen.findByRole('button', { name: /^课程结构$/u }));

    await waitFor(() =>
      expect(document.querySelector('[data-course-destination="curriculum"]')).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: '生成结构' })).not.toBeInTheDocument();
  });

  it('aborts an in-flight preparation run when the learner switches Course', async () => {
    const secondWorkspace = {
      ...workspaceSummary,
      id: 'ws_2',
      name: 'Second Course',
    };
    vi.mocked(api.listWorkspaces).mockResolvedValue({
      workspaces: [workspaceSummary, secondWorkspace],
    });
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: planRequiredOverview() });
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    const running = preparation({
      operationKey: 'prepare-course-ws-1',
      state: 'preparing_concepts',
      machineAction: 'prepare_concepts',
      learnerAction: 'resume_preparation',
      canResume: true,
      canCancel: true,
      checkpoints: {
        materials: 'complete',
        concepts: 'in_progress',
        courseStructure: 'pending',
        coursePlan: 'pending',
      },
      blocker: null,
    });
    vi.mocked(api.coursePreparation)
      .mockResolvedValue({ preparation: running })
      .mockResolvedValueOnce({ preparation: { ...running, canCancel: false } });
    let runSignal: AbortSignal | undefined;
    let finishRun: ((value: { preparation: CoursePreparation }) => void) | undefined;
    vi.spyOn(api, 'runCoursePreparation').mockImplementation(
      async (_workspaceId, _input, signal) =>
        new Promise((resolve) => {
          runSignal = signal;
          finishRun = resolve;
        }),
    );
    const onWorkspaceChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={onWorkspaceChange}
        refreshKey={0}
        provider="fake"
      />,
    );

    await user.click(await screen.findByRole('button', { name: '继续准备课程' }));
    await waitFor(() => expect(runSignal).toBeDefined());
    await user.selectOptions(
      screen.getByRole('combobox', { name: '当前课程' }),
      secondWorkspace.id,
    );

    expect(onWorkspaceChange).toHaveBeenCalledWith(secondWorkspace.id);
    expect(runSignal?.aborted).toBe(true);
    finishRun?.({
      preparation: preparation({
        state: 'course_plan_ready',
        learnerAction: 'review_course_plan',
        learnerDecisionRequired: true,
        checkpoints: {
          materials: 'complete',
          concepts: 'complete',
          courseStructure: 'complete',
          coursePlan: 'complete',
        },
        blocker: null,
      }),
    });
    await waitFor(() => expect(screen.queryByLabelText('课程准备状态')).not.toBeInTheDocument());
  });

  it('refreshes authoritative preparation state after same-Course cancellation settles', async () => {
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: planRequiredOverview() });
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    const running = preparation({
      operationKey: 'prepare-course-ws-1',
      state: 'preparing_concepts',
      machineAction: 'prepare_concepts',
      learnerAction: 'resume_preparation',
      canResume: true,
      canCancel: true,
      checkpoints: {
        materials: 'complete',
        concepts: 'in_progress',
        courseStructure: 'pending',
        coursePlan: 'pending',
      },
      blocker: null,
    });
    const cancelled = preparation({
      revision: 'preparation-revision-2',
      operationKey: 'prepare-course-ws-1-retry',
      state: 'failed_recoverable',
      machineAction: 'prepare_concepts',
      learnerAction: 'resume_preparation',
      canResume: true,
      canCancel: false,
      checkpoints: running.checkpoints,
      blocker: {
        code: 'preparation_interrupted',
        message: '课程准备被中断，已完成的有效内容仍然保留，可以安全继续。',
      },
      failure: {
        code: 'REQUEST_CANCELLED',
        action: 'prepare_concepts',
        occurredAt: AT,
        retryable: true,
      },
    });
    let current = { ...running, canCancel: false };
    vi.mocked(api.coursePreparation).mockImplementation(async () => ({ preparation: current }));
    let runSignal: AbortSignal | undefined;
    vi.spyOn(api, 'runCoursePreparation').mockImplementation(
      async (_workspaceId, _input, signal) =>
        new Promise((_resolve, reject) => {
          runSignal = signal;
          current = running;
          signal?.addEventListener(
            'abort',
            () => {
              current = cancelled;
              reject(new ApiClientError('ABORTED', '请求已取消。'));
            },
            { once: true },
          );
        }),
    );
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: '继续准备课程' }));
    await waitFor(() => expect(runSignal).toBeDefined());
    await user.click(screen.getByRole('button', { name: '停止' }));

    expect(runSignal?.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: '重试课程准备' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument();
  });
});

describe('Course Settings navigation continuity', () => {
  it('applies an external advanced-assessment route inside the selected Course shell', async () => {
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    vi.spyOn(api, 'getMaterial').mockResolvedValue(material);
    vi.spyOn(api, 'getConcepts').mockResolvedValue({ concepts });
    const onDestinationChange = vi.fn();
    render(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={vi.fn()}
        refreshKey={0}
        provider="fake"
        navigationIntent={{ requestId: 1, destination: 'assessment' }}
        onDestinationChange={onDestinationChange}
      />,
    );

    expect(await screen.findByLabelText('课程高级评估')).toBeInTheDocument();
    expect(screen.getByLabelText('课程学习空间')).toHaveClass('view-progress');
    expect(screen.queryByText('兼容与高级工具')).not.toBeInTheDocument();
    expect(onDestinationChange).not.toHaveBeenCalled();
  });

  it('applies browser history changes without echoing the previous Progress subsection', async () => {
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    vi.spyOn(api, 'reviewItems').mockResolvedValue({ items: [] });
    vi.spyOn(api, 'mastery').mockResolvedValue({ mastery: [], weakConcepts: [] });
    vi.spyOn(api, 'mistakes').mockResolvedValue({ mistakes: [], weakConcepts: [] });
    const onDestinationChange = vi.fn();
    const user = userEvent.setup();
    const rendered = render(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={vi.fn()}
        refreshKey={0}
        provider="fake"
        navigationIntent={{ requestId: 1, destination: 'progress-overview' }}
        onDestinationChange={onDestinationChange}
      />,
    );

    expect(await screen.findByRole('tab', { name: '概览' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    onDestinationChange.mockClear();

    rendered.rerender(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={vi.fn()}
        refreshKey={0}
        provider="fake"
        navigationIntent={{ requestId: 2, destination: 'progress-mastery' }}
        onDestinationChange={onDestinationChange}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '掌握与复习' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(onDestinationChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: '修复' }));
    expect(onDestinationChange).toHaveBeenLastCalledWith('progress-repair');
  });

  it('does not suppress user navigation after an identical controlled destination', async () => {
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    vi.spyOn(api, 'reviewItems').mockResolvedValue({ items: [] });
    vi.spyOn(api, 'mastery').mockResolvedValue({ mastery: [], weakConcepts: [] });
    vi.spyOn(api, 'mistakes').mockResolvedValue({ mistakes: [], weakConcepts: [] });
    const onDestinationChange = vi.fn();
    const user = userEvent.setup();
    const rendered = render(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={vi.fn()}
        refreshKey={0}
        provider="fake"
        navigationIntent={{ requestId: 1, destination: 'progress-overview' }}
        onDestinationChange={onDestinationChange}
      />,
    );

    expect(await screen.findByRole('tab', { name: '概览' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    onDestinationChange.mockClear();
    rendered.rerender(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={vi.fn()}
        refreshKey={0}
        provider="fake"
        navigationIntent={{ requestId: 2, destination: 'progress-overview' }}
        onDestinationChange={onDestinationChange}
      />,
    );

    await user.click(screen.getByRole('tab', { name: '修复' }));
    expect(onDestinationChange).toHaveBeenLastCalledWith('progress-repair');
  });

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
      externalConnection: {
        status: 'untested',
        testedGeneration: null,
        testedAt: null,
        message: null,
      },
    });
    const runPreparation = vi.spyOn(api, 'runCoursePreparation');
    const user = userEvent.setup();
    renderWorkspace();

    const courseSelector = await screen.findByRole('combobox', { name: '当前课程' });
    expect(courseSelector).toHaveValue(workspace.id);

    for (const destination of [
      { label: '主页', className: 'view-home' },
      { label: '学习', className: 'view-session' },
      { label: '知识地图', className: 'view-explore' },
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
    expect(runPreparation).not.toHaveBeenCalled();
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
      externalConnection: {
        status: 'untested',
        testedGeneration: null,
        testedAt: null,
        message: null,
      },
    });
    const user = userEvent.setup();
    render(
      <AgentCourseWorkspace
        workspaceId={null}
        onWorkspaceChange={vi.fn()}
        refreshKey={0}
        provider="fake"
      />,
    );

    expect(await screen.findByRole('heading', { name: '我的课程' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '设置' }));

    expect(screen.getByLabelText('课程学习空间')).toHaveClass('view-settings');
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText('课程连续性')).toHaveTextContent('已启用 · 尚未选择课程');
  });
});

describe('canonical Course lifecycle in Settings', () => {
  function renderSettings(overrides: { onWorkspaceChange?: ReturnType<typeof vi.fn> } = {}) {
    const onWorkspaceChange = overrides.onWorkspaceChange ?? vi.fn();
    const onWorkspaceDeleted = vi.fn();
    const rendered = render(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={onWorkspaceChange}
        refreshKey={0}
        provider="fake"
        navigationIntent={{ requestId: 1, destination: 'settings' }}
        onWorkspaceDeleted={onWorkspaceDeleted}
      />,
    );
    return { ...rendered, onWorkspaceChange, onWorkspaceDeleted };
  }

  it('creates another Course and renames the current Course through existing API contracts', async () => {
    const user = userEvent.setup();
    mockSettingsConfig();
    const createdWorkspace = {
      ...workspace,
      id: 'ws_2',
      name: '概率论',
      activeGraphVersionId: null,
    };
    const create = vi
      .spyOn(api, 'createWorkspace')
      .mockResolvedValue({ workspace: createdWorkspace });
    const rename = vi.spyOn(api, 'renameWorkspace').mockResolvedValue({
      workspace: { ...workspace, name: '认知科学进阶' },
    });
    const { onWorkspaceChange } = renderSettings();

    await user.type(await screen.findByLabelText('创建另一门课程'), createdWorkspace.name);
    await user.click(screen.getByRole('button', { name: '创建课程' }));
    expect(create).toHaveBeenCalledWith({ name: createdWorkspace.name }, expect.any(AbortSignal));
    expect(onWorkspaceChange).toHaveBeenCalledWith(createdWorkspace.id);

    const renameInput = screen.getByLabelText('当前课程名称');
    await user.clear(renameInput);
    await user.type(renameInput, '认知科学进阶');
    await user.click(screen.getByRole('button', { name: '保存名称' }));
    expect(rename).toHaveBeenCalledWith(workspace.id, '认知科学进阶', expect.any(AbortSignal));
    expect(screen.getByLabelText('当前课程名称')).toHaveValue('认知科学进阶');
  });

  it('deletes only after server confirmation and reports the canonical deletion callback', async () => {
    const user = userEvent.setup();
    mockSettingsConfig();
    const remove = vi.spyOn(api, 'deleteWorkspace').mockResolvedValue(undefined);
    const { onWorkspaceDeleted } = renderSettings();

    await user.click(await screen.findByRole('button', { name: '删除当前课程' }));
    await user.type(screen.getByLabelText(`输入课程名称 ${workspace.name} 以确认`), workspace.name);
    await user.click(screen.getByRole('button', { name: '永久删除课程' }));

    expect(remove).toHaveBeenCalledWith(workspace.id, expect.any(AbortSignal));
    expect(onWorkspaceDeleted).toHaveBeenCalledWith(workspace.id);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: workspace.name })).not.toBeInTheDocument();
  });

  it('treats a deletion 404 as the already-reached goal state', async () => {
    const user = userEvent.setup();
    mockSettingsConfig();
    vi.spyOn(api, 'deleteWorkspace').mockRejectedValue(
      new ApiClientError('NETWORK_ERROR', '课程已不存在。', 404),
    );
    const { onWorkspaceDeleted } = renderSettings();

    await user.click(await screen.findByRole('button', { name: '删除当前课程' }));
    await user.type(screen.getByLabelText(`输入课程名称 ${workspace.name} 以确认`), workspace.name);
    await user.click(screen.getByRole('button', { name: '永久删除课程' }));

    expect(onWorkspaceDeleted).toHaveBeenCalledWith(workspace.id);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps the current Course available when deletion fails', async () => {
    const user = userEvent.setup();
    mockSettingsConfig();
    vi.spyOn(api, 'deleteWorkspace').mockRejectedValue(
      new ApiClientError('NETWORK_ERROR', '删除服务暂时不可用。', 503),
    );
    const { onWorkspaceDeleted } = renderSettings();

    await user.click(await screen.findByRole('button', { name: '删除当前课程' }));
    await user.type(screen.getByLabelText(`输入课程名称 ${workspace.name} 以确认`), workspace.name);
    await user.click(screen.getByRole('button', { name: '永久删除课程' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      '删除失败，课程及其学习历史没有被删除。 删除服务暂时不可用。',
    );
    expect(onWorkspaceDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: workspace.name })).toBeInTheDocument();
  });

  it('aborts pending Course preparation before deleting the current Course', async () => {
    const user = userEvent.setup();
    mockSettingsConfig();
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: planRequiredOverview() });
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    vi.mocked(api.coursePreparation).mockResolvedValue({
      preparation: preparation({
        operationKey: 'prepare-course-ws-1',
        state: 'preparing_concepts',
        machineAction: 'prepare_concepts',
        learnerAction: 'resume_preparation',
        canResume: true,
        canCancel: false,
        checkpoints: {
          materials: 'complete',
          concepts: 'in_progress',
          courseStructure: 'pending',
          coursePlan: 'pending',
        },
        blocker: null,
      }),
    });
    let preparationSignal: AbortSignal | undefined;
    vi.spyOn(api, 'runCoursePreparation').mockImplementation(
      (_workspaceId, _input, signal) =>
        new Promise<never>(() => {
          preparationSignal = signal;
        }),
    );
    vi.spyOn(api, 'deleteWorkspace').mockResolvedValue(undefined);
    const onWorkspaceDeleted = vi.fn();
    render(
      <AgentCourseWorkspace
        workspaceId={workspace.id}
        onWorkspaceChange={vi.fn()}
        refreshKey={0}
        provider="fake"
        onWorkspaceDeleted={onWorkspaceDeleted}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '继续准备课程' }));
    await waitFor(() => expect(preparationSignal).toBeDefined());
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(await screen.findByRole('button', { name: '删除当前课程' }));
    await user.type(screen.getByLabelText(`输入课程名称 ${workspace.name} 以确认`), workspace.name);
    await user.click(screen.getByRole('button', { name: '永久删除课程' }));

    expect(preparationSignal?.aborted).toBe(true);
    expect(onWorkspaceDeleted).toHaveBeenCalledWith(workspace.id);
  });

  it('does not let a late Course detail response resurrect a deleted Course', async () => {
    const user = userEvent.setup();
    mockSettingsConfig();
    let resolveDetail!: (value: {
      workspace: typeof workspace;
      documents: (typeof documentSummary)[];
    }) => void;
    vi.mocked(api.getWorkspace).mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    vi.spyOn(api, 'deleteWorkspace').mockResolvedValue(undefined);
    const { onWorkspaceDeleted } = renderSettings();

    await user.click(await screen.findByRole('button', { name: '删除当前课程' }));
    await user.type(screen.getByLabelText(`输入课程名称 ${workspace.name} 以确认`), workspace.name);
    await user.click(screen.getByRole('button', { name: '永久删除课程' }));
    expect(onWorkspaceDeleted).toHaveBeenCalledWith(workspace.id);

    resolveDetail({ workspace, documents: [documentSummary] });
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: workspace.name })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(documentSummary.title)).not.toBeInTheDocument();
  });
});

describe('Home-owned learning-route failure', () => {
  beforeEach(() => {
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    vi.spyOn(api, 'getMaterial').mockResolvedValue(material);
    vi.spyOn(api, 'config').mockResolvedValue({
      provider: 'fake',
      baseUrl: null,
      model: null,
      apiKeyConfigured: false,
      source: 'default',
      complete: true,
      runtimeGeneration: 1,
      externalConnection: {
        status: 'untested',
        testedGeneration: null,
        testedAt: null,
        message: null,
      },
    });
  });

  it('stays on Home, cannot become a Study/Explore layout child, survives remount, and clears on success', async () => {
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: planRequiredOverview() });
    const propose = vi
      .spyOn(api, 'proposeStudyPlan')
      .mockRejectedValueOnce(
        new ApiClientError('PROVIDER_TIMEOUT', '模型服务响应超时(240000ms)', 504),
      );
    const user = userEvent.setup();
    const rendered = renderWorkspace();

    await user.click(await screen.findByRole('button', { name: '生成学习路线' }));
    expect(await screen.findByRole('heading', { name: '学习路线暂未生成' })).toBeInTheDocument();
    expect(screen.getByText('Hy3 响应时间过长，这次生成没有完成。')).toBeInTheDocument();

    for (const destination of ['学习', '课程结构', '进展', '知识地图', '课程资料', '设置']) {
      await user.click(screen.getByRole('button', { name: destination }));
      expect(screen.queryByRole('heading', { name: '学习路线暂未生成' })).not.toBeInTheDocument();
      expect(screen.queryByText('模型服务响应超时(240000ms)')).not.toBeInTheDocument();
    }

    await user.click(screen.getByRole('button', { name: '主页' }));
    expect(screen.getByRole('heading', { name: '学习路线暂未生成' })).toBeInTheDocument();

    rendered.unmount();
    renderWorkspace();
    expect(await screen.findByRole('heading', { name: '学习路线暂未生成' })).toBeInTheDocument();

    propose.mockResolvedValueOnce({} as Awaited<ReturnType<typeof api.proposeStudyPlan>>);
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: '学习路线暂未生成' })).not.toBeInTheDocument(),
    );
    expect(propose).toHaveBeenCalledTimes(2);
  });

  it('supports explicit dismissal without changing Course state', async () => {
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: planRequiredOverview() });
    vi.spyOn(api, 'proposeStudyPlan').mockRejectedValue(
      new ApiClientError('PROVIDER_TIMEOUT', '模型服务响应超时(240000ms)', 504),
    );
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: '生成学习路线' }));
    await user.click(await screen.findByRole('button', { name: '关闭学习路线错误' }));

    expect(screen.queryByRole('heading', { name: '学习路线暂未生成' })).not.toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('F-6 operation-owned failures', () => {
  it('keeps a Contract failure on Home, excludes it from Study and Explore, and clears it on retry success', async () => {
    vi.mocked(api.courseExecution).mockResolvedValue({ overview: contractReviewOverview() });
    vi.spyOn(api, 'materialRoleHistory').mockResolvedValue(roleHistory(strandedProposal));
    vi.spyOn(api, 'listStudySessions').mockResolvedValue({ sessions: [] });
    const transition = vi
      .spyOn(api, 'transitionLearningContract')
      .mockRejectedValueOnce(new Error('确认服务暂时不可用。'))
      .mockResolvedValueOnce({
        contract: {
          ...contractReviewOverview().pendingContract!,
          status: 'learner_confirmed',
          learnerConfirmedAt: AT,
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
      });
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole('button', { name: '开始准备课程' }));
    expect(await screen.findByText('课程设置暂未保存。确认服务暂时不可用。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '学习' }));
    expect(screen.getByLabelText('课程学习空间')).toHaveClass('view-session');
    expect(screen.queryByText('确认服务暂时不可用。')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '知识地图' }));
    expect(screen.getByLabelText('课程学习空间')).toHaveClass('view-explore');
    expect(screen.queryByText('确认服务暂时不可用。')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '主页' }));
    expect(screen.getByText('课程设置暂未保存。确认服务暂时不可用。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始准备课程' }));

    await waitFor(() =>
      expect(screen.queryByText('课程设置暂未保存。确认服务暂时不可用。')).not.toBeInTheDocument(),
    );
    expect(transition).toHaveBeenCalledTimes(2);
  });
});
