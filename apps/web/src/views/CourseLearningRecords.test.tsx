import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CourseLearningProgress, CurrentReviewItem } from '@hy3-clinic/shared';
import { api } from '../api.js';
import { CourseLearningRecords } from './CourseLearningRecords.js';

const at = '2026-09-10T00:00:00.000Z';
const command = () => ({
  commandId: 'review-start',
  idempotencyKey: 'review-start',
  workspaceId: 'ws_1',
  actor: 'learner' as const,
});
function records(): CourseLearningProgress {
  return {
    workspaceId: 'ws_1',
    summary: {
      teachingTotal: 1,
      teachingCompleted: 1,
      objectiveTotal: 2,
      supportedObjectives: 0,
      openRepairs: 2,
    },
    units: [
      {
        id: 'unit_1',
        title: '工作记忆',
        teachingTotal: 1,
        teachingCompleted: 1,
        objectiveTotal: 2,
        supportedObjectives: 0,
        formalState: 'not_started',
        scheduledCheckpoints: 2,
      },
    ],
    assessments: [
      {
        attemptId: 'attempt_failed',
        versionId: 'version_1',
        title: '容量检查',
        learningUnitId: 'unit_1',
        objectiveIds: ['objective_1'],
        current: true,
        status: 'submitted',
        result: 'unsupported',
        credited: false,
        reconciliationPending: false,
        startedAt: at,
        submittedAt: at,
        feedback: '没有说明容量限制。',
        repairEpisodeId: 'repair_1',
        items: [{ prompt: '解释容量限制。', response: '不知道' }],
        criteria: [{ label: '说明容量限制', result: 'not_met' }],
      },
    ],
    repairs: [
      {
        id: 'repair_1',
        kind: 'formal',
        title: '容量检查',
        learningUnitId: 'unit_1',
        status: 'OPEN',
        resolved: false,
        current: true,
        description: '需要补全解释。',
        updatedAt: at,
        versionId: 'version_1',
        sessionId: null,
      },
      {
        id: 'practice_1',
        kind: 'practice',
        title: '课堂练习',
        learningUnitId: 'unit_1',
        status: 'OPEN',
        resolved: false,
        current: true,
        description: '需要再次练习。',
        updatedAt: at,
        versionId: null,
        sessionId: 'session_1',
      },
    ],
    lessons: [],
  };
}
afterEach(() => vi.restoreAllMocks());
describe('current Course progress records', () => {
  it('keeps the initial Review retry reachable even after Formal credit applied', () => {
    const progress = records();
    progress.assessments[0] = {
      ...progress.assessments[0]!,
      result: 'supported',
      credited: true,
      repairEpisodeId: null,
      reviewSchedulingPending: true,
    };
    render(
      <CourseLearningRecords
        workspaceId="ws_1"
        section="evidence"
        progress={progress}
        reviews={[]}
        command={command}
        executionVersion={1}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/正式进展已保存，复习安排待同步/)).toBeVisible();
    expect(screen.getByRole('button', { name: '重试复习安排' })).toBeVisible();
  });
  it('keeps failed submissions in history and never starts or grades while browsing', () => {
    const start = vi.spyOn(api, 'startFormalExecution');
    const submit = vi.spyOn(api, 'submitFormalExecution');
    render(
      <CourseLearningRecords
        workspaceId="ws_1"
        section="history"
        progress={records()}
        reviews={[]}
        command={command}
        executionVersion={1}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('不知道')).toBeVisible();
    expect(screen.getByText('需要修复')).toBeVisible();
    expect(screen.getByText('说明容量限制：未达到')).toBeVisible();
    expect(start).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it('separates classroom repair from Formal repair and resumes their actual surfaces', async () => {
    const goStudy = vi.fn();
    const get = vi.spyOn(api, 'getFormalExecution').mockResolvedValue(null);
    render(
      <CourseLearningRecords
        workspaceId="ws_1"
        section="repair"
        progress={records()}
        reviews={[]}
        command={command}
        executionVersion={1}
        onRefresh={vi.fn()}
        onOpenStudy={goStudy}
      />,
    );
    expect(screen.getByText('正式检查修复')).toBeVisible();
    expect(screen.getByText('课堂练习修复')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '回到学习继续修复' }));
    expect(goStudy).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '继续修复与验证' }));
    expect(await screen.findByRole('button', { name: '开始检查' })).toBeVisible();
    expect(get).toHaveBeenCalledWith('ws_1', 'version_1', expect.any(AbortSignal));
  });
  it('shows objective evidence separately from completed Lessons and launches only due Reviews', async () => {
    const launch = vi
      .spyOn(api, 'launchProgressReview')
      .mockRejectedValue(new Error('复习资料已更新，请刷新。'));
    const reviews = [
      {
        reviewTargetId: 'target_due',
        objectiveTitle: '已到期的目标',
        workflowPhase: 'due',
        dueAt: at,
      },
      {
        reviewTargetId: 'target_later',
        objectiveTitle: '稍后的目标',
        workflowPhase: 'scheduled',
        dueAt: at,
      },
    ] as CurrentReviewItem[];
    render(
      <CourseLearningRecords
        workspaceId="ws_1"
        section="mastery"
        progress={records()}
        reviews={reviews}
        command={command}
        executionVersion={7}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('学习完成 1 / 1 · 有正式通过证据的目标 0 / 2')).toBeVisible();
    expect(screen.getAllByRole('button', { name: '开始复习' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '开始复习' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('复习资料已更新');
    expect(launch).toHaveBeenCalledWith('ws_1', 'target_due', {
      command: command(),
      expectedCourseExecutionVersion: 7,
    });
  });
});
