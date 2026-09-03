import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CourseExecutionOverview,
  FormalProgressionOverview,
  ReplanTrigger,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { FormalProgressView } from './FormalProgressView.js';

vi.mock('../api.js', () => ({
  api: {
    formalProgression: vi.fn(),
    reconcileProgression: vi.fn(),
    proposeQualifiedReplan: vi.fn(),
    recordGoalOutcome: vi.fn(),
  },
}));

const progression: FormalProgressionOverview = {
  evidence: [
    {
      id: 'evidence_1',
      formalQuestionContractId: 'contract_question_1',
      gradingResultId: 'grade_1',
      questionId: 'question_1',
      primaryObjectiveId: 'objective_1',
      curriculumLearningUnitId: 'unit_1',
      admissibilityTier: 'tier_2_validated_representation',
      normalizedScore: 0.8,
      correct: true,
      needsReview: false,
      stateCreditable: true,
      assessmentPremiseBindingIds: ['binding_1'],
      limitations: [],
      createdAt: '2026-08-10T00:00:00.000Z',
    },
  ],
  reconciliations: [
    {
      id: 'rec_1',
      workspaceId: 'ws_1',
      gradingResultId: 'grade_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      curriculumLearningUnitId: 'unit_1',
      completionPolicyId: 'policy_1',
      completionPolicyVersion: 1,
      status: 'applied',
      decisionId: 'decision_1',
      reason: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    },
  ],
  decisions: [
    {
      id: 'decision_1',
      workspaceId: 'ws_1',
      curriculumLearningUnitId: 'unit_1',
      completionPolicyId: 'policy_1',
      completionPolicyVersion: 1,
      kind: 'complete',
      priorState: 'in_progress',
      nextState: 'complete',
      evidenceIds: ['evidence_1'],
      reasonCodes: ['sufficient_admissible_evidence'],
      createdAt: '2026-08-10T00:00:00.000Z',
    },
  ],
  replanTriggers: [],
  goalOutcomes: [],
};

describe('FormalProgressView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows only formal evidence and local reconciliation states', async () => {
    vi.mocked(api.formalProgression).mockResolvedValue(progression);
    render(
      <FormalProgressView
        workspaceId="ws_1"
        overview={null}
        command={() => ({
          commandId: 'cmd_1',
          idempotencyKey: 'cmd_1',
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onOpenProgress={vi.fn()}
      />,
    );
    expect(await screen.findByText('已验证的表示方式')).toBeInTheDocument();
    expect(screen.getAllByText('完成决定')).toHaveLength(1);
    expect(screen.getByText('可采纳的正式证据已满足要求')).toBeInTheDocument();
    expect(screen.queryByText('sufficient_admissible_evidence')).not.toBeInTheDocument();
    expect(screen.getByText('已计入进展')).toBeInTheDocument();
    expect(screen.getByText(/Tutor 对话不是正式证据/)).toBeInTheDocument();

    const expectedLabels = [
      ['学习单元', '证据级别', '结果', '状态效力', '核对状态'],
      ['学习单元', '当前状态', '决定', '本地核对理由'],
      ['学习单元', '核对状态', '说明', '进展决定', '操作'],
    ];
    const tables = [
      screen.getByRole('table', { name: '正式证据记录' }),
      screen.getByRole('table', { name: '学习单元进展决定' }),
      screen.getByRole('table', { name: '判分与进展核对记录' }),
    ];
    tables.forEach((table, index) => {
      const recordRow = within(table).getAllByRole('row')[1]!;
      expect(
        within(recordRow)
          .getAllByRole('cell')
          .map((cell) => cell.getAttribute('data-label')),
      ).toEqual(expectedLabels[index]);
    });
  });

  it('shows the persisted reason when formal evidence is advisory', async () => {
    vi.mocked(api.formalProgression).mockResolvedValue({
      ...progression,
      evidence: [
        {
          ...progression.evidence[0]!,
          admissibilityTier: 'tier_3_advisory',
          stateCreditable: false,
          limitations: [
            'The resolved objective has no current, presented Lesson exposure on this route; result is advisory only.',
          ],
        },
      ],
    });
    render(
      <FormalProgressView
        workspaceId="ws_1"
        overview={null}
        command={() => ({
          commandId: 'cmd_1',
          idempotencyKey: 'cmd_1',
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onOpenProgress={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/仅供参考原因：.*no current, presented Lesson exposure/),
    ).toHaveAttribute('role', 'note');
  });

  it('requires an active route before exposing outcome controls', async () => {
    vi.mocked(api.formalProgression).mockResolvedValue(progression);
    const user = userEvent.setup();
    render(
      <FormalProgressView
        workspaceId="ws_1"
        overview={null}
        command={() => ({
          commandId: 'cmd_1',
          idempotencyKey: 'cmd_1',
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onOpenProgress={vi.fn()}
      />,
    );
    await screen.findByText('学习目标结果');
    expect(screen.getByText(/需要先有正在执行的已接受路线/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '测验记录' }));
  });

  it('does not default or allow achieved while accepted-route work is deferred', async () => {
    vi.mocked(api.formalProgression).mockResolvedValue(progression);
    render(
      <FormalProgressView
        workspaceId="ws_1"
        overview={
          {
            activeContract: { id: 'contract_1' },
            acceptedCurriculum: { id: 'curriculum_1' },
            acceptedStudyPlan: { id: 'plan_1', deferrals: [] },
            activeAgenda: {
              id: 'agenda_1',
              items: [
                {
                  linkedPlanItemId: 'plan_item_2',
                  learningUnitId: 'unit_1',
                  state: 'deferred',
                },
              ],
            },
            formalProgress: {
              repairNeededPlanItemCount: 0,
              deferredPlanItemCount: 1,
            },
            riskSummary: { highlights: [] },
          } as unknown as CourseExecutionOverview
        }
        command={() => ({
          commandId: 'cmd_1',
          idempotencyKey: 'cmd_1',
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onOpenProgress={vi.fn()}
      />,
    );

    const selector = await screen.findByRole('combobox');
    expect(selector).toHaveValue('');
    expect(screen.getByRole('option', { name: '已达成' })).toBeDisabled();
  });

  it('creates a successor proposal from a qualified trigger without accepting it', async () => {
    const user = userEvent.setup();
    const onCourseChanged = vi.fn();
    const trigger: ReplanTrigger = {
      id: 'trigger_1',
      workspaceId: 'ws_1',
      acceptedStudyPlanId: 'plan_1',
      kind: 'synthesis_failure',
      status: 'qualified',
      evidenceIds: ['evidence_1'],
      reason: 'Integration needs repair.',
      facts: {
        qualifyingOccurrences: 1,
        affectedLearningUnitIds: ['unit_1'],
        affectedPlanItemIds: ['plan_item_1'],
        observedMinutesPerWeek: null,
        sourceManifestFingerprint: null,
        learnerConfirmedChange: false,
      },
      proposedStudyPlanId: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    };
    vi.mocked(api.formalProgression)
      .mockResolvedValueOnce({ ...progression, replanTriggers: [trigger] })
      .mockResolvedValueOnce({
        ...progression,
        replanTriggers: [{ ...trigger, status: 'proposal_created', proposedStudyPlanId: 'plan_2' }],
      });
    vi.mocked(api.proposeQualifiedReplan).mockResolvedValue({
      trigger: { ...trigger, status: 'proposal_created', proposedStudyPlanId: 'plan_2' },
      studyPlan: { id: 'plan_2' },
    } as unknown as Awaited<ReturnType<typeof api.proposeQualifiedReplan>>);

    render(
      <FormalProgressView
        workspaceId="ws_1"
        overview={
          {
            acceptedStudyPlan: { id: 'plan_1' },
            proposedStudyPlan: null,
          } as CourseExecutionOverview
        }
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={onCourseChanged}
        onOpenProgress={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '提出路线调整' }));

    await waitFor(() =>
      expect(api.proposeQualifiedReplan).toHaveBeenCalledWith(
        'ws_1',
        'trigger_1',
        expect.objectContaining({
          triggerId: 'trigger_1',
          expectedAcceptedStudyPlanId: 'plan_1',
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(onCourseChanged).toHaveBeenCalledTimes(1);
  });

  it('directs Contract-changing triggers to Contract editing without a dead Plan action', async () => {
    const triggerBase: ReplanTrigger = {
      id: 'trigger_contract_1',
      workspaceId: 'ws_1',
      acceptedStudyPlanId: 'plan_1',
      kind: 'deadline_or_target_change',
      status: 'qualified',
      evidenceIds: [],
      reason: 'The learner changed the accepted deadline.',
      facts: {
        qualifyingOccurrences: 1,
        affectedLearningUnitIds: [],
        affectedPlanItemIds: [],
        observedMinutesPerWeek: null,
        sourceManifestFingerprint: null,
        learnerConfirmedChange: true,
      },
      proposedStudyPlanId: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    };
    vi.mocked(api.formalProgression).mockResolvedValue({
      ...progression,
      replanTriggers: [
        triggerBase,
        {
          ...triggerBase,
          id: 'trigger_contract_2',
          kind: 'learner_scope_change',
          reason: 'The learner changed the accepted scope.',
        },
      ],
    });

    render(
      <FormalProgressView
        workspaceId="ws_1"
        overview={
          {
            acceptedStudyPlan: { id: 'plan_1' },
            proposedStudyPlan: null,
          } as CourseExecutionOverview
        }
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onOpenProgress={vi.fn()}
      />,
    );

    expect(
      await screen.findAllByText(/请先回到课程主页更新课程设置并接受新的课程结构/),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Create route proposal' })).not.toBeInTheDocument();
    expect(api.proposeQualifiedReplan).not.toHaveBeenCalled();
  });

  it('shows the machine-readable details of a proposed route diff', async () => {
    vi.mocked(api.formalProgression).mockResolvedValue(progression);
    render(
      <FormalProgressView
        workspaceId="ws_1"
        overview={
          {
            acceptedStudyPlan: { id: 'plan_1' },
            proposedStudyPlan: {
              diff: [
                {
                  kind: 'resized',
                  planItemId: 'plan_item_1',
                  curriculumLearningUnitId: 'unit_1',
                  beforeIndex: 0,
                  afterIndex: 0,
                  beforeMinutes: 20,
                  afterMinutes: 35,
                  beforeDepth: 'pass_oriented',
                  afterDepth: 'working_fluency',
                  reason: 'Add time for prerequisite repair.',
                },
              ],
            },
          } as CourseExecutionOverview
        }
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={vi.fn()}
        onOpenProgress={vi.fn()}
      />,
    );

    const change = await screen.findByText(/时长 20 → 35 分钟/);
    expect(change).toHaveTextContent('顺序 1 → 1');
    expect(change).toHaveTextContent('深度 通过评估 → 熟练运用');
    expect(change).toHaveTextContent('学习单元 unit_1');
    expect(change).toHaveTextContent('路线项目 plan_item_1');
  });

  it('retries pending reconciliation against the accepted route and refreshes progress', async () => {
    const user = userEvent.setup();
    const onCourseChanged = vi.fn();
    const pending: FormalProgressionOverview = {
      ...progression,
      reconciliations: [
        {
          ...progression.reconciliations[0]!,
          status: 'reconciliation_pending',
          decisionId: null,
          reason: null,
        },
      ],
      decisions: [],
    };
    vi.mocked(api.formalProgression)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(progression);
    vi.mocked(api.reconcileProgression).mockResolvedValue({
      reconciliations: progression.reconciliations,
      decisions: progression.decisions,
      evidence: progression.evidence,
      replanTriggers: [],
    });

    render(
      <FormalProgressView
        workspaceId="ws_1"
        overview={
          {
            acceptedStudyPlan: {
              id: 'plan_1',
              executionSourceManifestFingerprint: 'manifest-fp',
            },
          } as CourseExecutionOverview
        }
        command={(prefix) => ({
          commandId: `${prefix}_1`,
          idempotencyKey: `${prefix}_1`,
          workspaceId: 'ws_1',
          actor: 'learner',
        })}
        onAcceptProposedPlan={vi.fn()}
        onRejectProposedPlan={vi.fn()}
        onCourseChanged={onCourseChanged}
        onOpenProgress={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '重新核对' }));

    await waitFor(() =>
      expect(api.reconcileProgression).toHaveBeenCalledWith(
        'ws_1',
        {
          command: {
            commandId: 'retry_progression_reconciliation_1',
            idempotencyKey: 'retry_progression_reconciliation_1',
            workspaceId: 'ws_1',
            actor: 'learner',
          },
          gradingResultId: 'grade_1',
          expectedStudyPlanId: 'plan_1',
          expectedExecutionSourceManifestFingerprint: 'manifest-fp',
        },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(api.formalProgression).toHaveBeenCalledTimes(2));
    expect(onCourseChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('已计入进展')).toBeInTheDocument();
  });
});
