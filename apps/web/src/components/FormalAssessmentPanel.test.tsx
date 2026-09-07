import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LearnerAssessmentExecution, LearnerRepairProjection } from '@hy3-clinic/shared';
import { api } from '../api.js';
import { FormalAssessmentPanel } from './FormalAssessmentPanel.js';

const AT = '2026-08-21T08:00:00.000Z';

function execution(
  phase: NonNullable<LearnerAssessmentExecution['review']>['phase'],
): LearnerAssessmentExecution {
  const submitted = phase !== 'retrieval';
  const resolved = phase === 'resolved';
  return {
    assessmentVersionId: `version_${phase}`,
    title: '到期复习：解释工作记忆容量',
    attempt: {
      id: `attempt_${phase}`,
      assessmentVersionId: `version_${phase}`,
      workspaceId: 'ws_1',
      ordinal: 1,
      status: submitted ? 'submitted' : 'started',
      responses: submitted ? { item_1: 'A durable response' } : {},
      startedAt: AT,
      submittedAt: submitted ? AT : null,
      cancelledAt: null,
    },
    items: [
      {
        itemId: 'item_1',
        prompt: '请解释工作记忆的容量限制。',
        purpose: '独立说明这项目标。',
        sourceReferences: [],
      },
    ],
    result: submitted
      ? {
          gradeRecordId: `grade_${phase}`,
          demonstrated: resolved || phase === 'scheduling_retry',
          summary:
            resolved || phase === 'scheduling_retry'
              ? '你已经展示了这项关键能力。'
              : '这次回答还没有展示出所需的关键能力。',
          minorNotice: null,
          criteria: [],
          sourceReferences: [],
          evidenceStatus: resolved || phase === 'scheduling_retry' ? 'supported' : 'unavailable',
          repairEpisodeId: null,
        }
      : null,
    review: {
      reviewTargetId: 'review-target:ws_1:objective_1',
      objectiveTitle: '解释工作记忆容量',
      dueReason: '这项目标已到复习时间，需要用一次独立回忆确认当前掌握情况。',
      phase,
      dueAt: AT,
      nextDueAt: resolved ? '2026-08-25T08:00:00.000Z' : null,
      schedulingRetryRequired: phase === 'scheduling_retry',
      resolved,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('FormalAssessmentPanel due Review workflow', () => {
  it('starts a due Review through the formal execution contract', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getFormalExecution').mockResolvedValue(null);
    const start = vi.spyOn(api, 'startFormalExecution').mockResolvedValue(execution('retrieval'));

    render(<FormalAssessmentPanel workspaceId="ws_1" versionId="version_retrieval" reviewMode />);

    expect(await screen.findByRole('heading', { name: '先独立回忆这项目标' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始复习' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('ws_1', 'version_retrieval'));
    expect(screen.getByText('正在进行正式回忆')).toBeInTheDocument();
    expect(screen.getByText('解释工作记忆容量')).toBeInTheDocument();
  });

  it.each([
    ['retrieval', '正在进行正式回忆'],
    ['repair', '本次回忆需要针对性修复'],
    ['practice', '正在进行不计分练习'],
    ['fresh_verification', '等待换情境的正式确认'],
    ['resolved', '本次复习已完成'],
    ['scheduling_retry', '正式结果已保存，复习安排待同步'],
  ] as const)('renders the %s learner phase without FSRS internals', async (phase, label) => {
    vi.spyOn(api, 'getFormalExecution').mockResolvedValue(execution(phase));

    render(<FormalAssessmentPanel workspaceId="ws_1" versionId={`version_${phase}`} reviewMode />);

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/stability|difficulty|retrievability/i)).not.toBeInTheDocument();
  });

  it('retries scheduling without offering continuation until the retry succeeds', async () => {
    const user = userEvent.setup();
    const retrying = execution('scheduling_retry');
    const resolved = execution('resolved');
    vi.spyOn(api, 'getFormalExecution').mockResolvedValue(retrying);
    const submit = vi.spyOn(api, 'submitFormalExecution').mockResolvedValue(resolved);
    const onChanged = vi.fn();

    render(
      <FormalAssessmentPanel
        workspaceId="ws_1"
        versionId="version_scheduling_retry"
        reviewMode
        onChanged={onChanged}
      />,
    );

    expect(await screen.findByText('正式结果已保存，复习时间还需要重新同步。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续下一项学习' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试复习安排' }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(retrying.attempt.id, retrying.attempt.responses),
    );
    expect(await screen.findByText('本次复习已完成')).toBeInTheDocument();
    expect(screen.getByText(/下次复习：/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续下一项学习' }));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('recovers a saved answer without a result after reload and retries the same response', async () => {
    const user = userEvent.setup();
    const saved = { ...execution('repair'), result: null, review: null };
    vi.spyOn(api, 'getFormalExecution').mockResolvedValue(saved);
    const submit = vi
      .spyOn(api, 'submitFormalExecution')
      .mockRejectedValueOnce(new Error('grading unavailable'))
      .mockResolvedValueOnce(execution('resolved'));

    render(<FormalAssessmentPanel workspaceId="ws_1" versionId={saved.assessmentVersionId} />);

    expect(await screen.findByText('A durable response')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续检查已保存的回答' }));
    expect(await screen.findByText(/这次检查暂时没有完成/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续检查已保存的回答' }));
    expect(await screen.findByText('你展示了这个关键能力。')).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(2);
    for (const call of submit.mock.calls) {
      expect(call).toEqual([saved.attempt.id, saved.attempt.responses]);
    }
  });

  it('retries missing repair teaching after reload and retains the existing repair controls', async () => {
    const user = userEvent.setup();
    const graded = execution('repair');
    graded.result!.repairEpisodeId = 'repair_1';
    const pending: LearnerRepairProjection = {
      episodeId: 'repair_1',
      status: 'ACTIVE',
      diagnosis: '容量限制还需要说明。',
      target: '工作记忆容量',
      attemptCount: 1,
      packet: null,
      practice: [],
      sourceReferences: [],
      verificationAssessmentVersionId: null,
      resolved: false,
      deeperSupportRecommended: false,
    };
    vi.spyOn(api, 'getFormalExecution').mockResolvedValue(graded);
    vi.spyOn(api, 'getLearnerRepair').mockResolvedValue(pending);
    const prepare = vi
      .spyOn(api, 'startLearnerRepair')
      .mockRejectedValueOnce(new Error('generation unavailable'))
      .mockResolvedValueOnce({
        ...pending,
        packet: {
          interventionLabel: '重新说明',
          explanation: '工作记忆只能同时保持有限内容。',
          practicePrompt: '用一个日常例子说明容量限制。',
          hints: [],
        },
      });

    render(<FormalAssessmentPanel workspaceId="ws_1" versionId={graded.assessmentVersionId} />);

    const retry = await screen.findByRole('button', { name: '重试准备修复讲解' });
    expect(screen.getByRole('button', { name: '稍后继续' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '离开修复' })).toBeInTheDocument();
    await user.click(retry);
    expect(await screen.findByText(/检查结果已保存，修复讲解暂时未准备好/)).toBeInTheDocument();
    await user.click(retry);
    expect(await screen.findByText('工作记忆只能同时保持有限内容。')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '练习回应' })).toBeInTheDocument();
    expect(prepare).toHaveBeenNthCalledWith(1, 'repair_1');
    expect(prepare).toHaveBeenNthCalledWith(2, 'repair_1');
  });
});
