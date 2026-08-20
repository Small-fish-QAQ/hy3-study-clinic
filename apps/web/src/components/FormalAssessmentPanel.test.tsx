import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LearnerAssessmentExecution } from '@hy3-clinic/shared';
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
    await waitFor(() => expect(submit).toHaveBeenCalledWith(retrying.attempt.id, {}));
    expect(await screen.findByText('本次复习已完成')).toBeInTheDocument();
    expect(screen.getByText(/下次复习：/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续下一项学习' }));
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
