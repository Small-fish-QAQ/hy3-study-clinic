import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ClinicWorkspace } from './ClinicWorkspace.js';
import { clinicApi } from '../clinicApi.js';
import type {
  CoursePlan,
  CourseOperation,
  CourseSubmission,
  CourseRepairRound,
  CourseLessonContent,
} from '@hy3-clinic/shared';
import type { PublicCourseQuiz } from '../clinicApi.js';
import { clinicRoom } from '../test/clinicRoom.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});
function mockCourse() {
  window.location.hash = 'workspace=w';
  const plan: CoursePlan = {
    formatVersion: 2,
    id: 'p',
    workspaceId: 'w',
    inventoryId: 'i',
    planningPolicyVersion: 'study-clinic-v2.1',
    title: '课程',
    modules: [{ id: 'm', title: '模块' }],
    lessons: [
      {
        id: 'l',
        moduleId: 'm',
        title: '第一课',
        summary: '讲解知识',
        knowledgeIds: ['k'],
        objectives: [{ id: 'o', title: '理解知识', knowledgeIds: ['k'], demand: 'understand' }],
        prerequisiteLessonIds: [],
        recommendedDepth: 'standard',
        selectedDepth: 'standard',
        estimatedMinutes: 10,
      },
    ],
    teachingRequiredKnowledgeIds: ['k'],
    assessmentBlueprint: {
      id: 'b',
      curriculumId: 'p',
      sourceScopeHash: 'hash',
      policyVersion: 'study-clinic-v2.1',
      passThreshold: 0.6,
      domains: [
        {
          id: 'd',
          title: '领域',
          knowledgeIds: ['k'],
          coreObjectiveIds: ['o'],
          required: true,
          rationale: '核心',
        },
      ],
      cells: [
        {
          id: 'c',
          domainId: 'd',
          objectiveIds: ['o'],
          demand: 'understand',
          difficultyBand: 'standard',
          mandatoryKnowledgeIds: ['k'],
          representativeSets: [],
          weight: 1,
          rationale: '核心理解',
        },
      ],
      requiredCellIds: ['c'],
    },
    status: 'draft',
    version: 1,
    warnings: [],
  };
  vi.spyOn(clinicApi, 'workspaces').mockResolvedValue({
    workspaces: [{ id: 'w', title: '课程' }],
  });
  vi.spyOn(clinicApi, 'materials').mockResolvedValue({
    materials: [{ id: 'mat', title: '教材', revisionId: 'r', warnings: [] }],
  });
  vi.spyOn(clinicApi, 'records').mockResolvedValue({
    curricula: [],
    sessions: [],
    submissions: [],
    formalGrades: [],
    repairs: [],
  });
  vi.spyOn(clinicApi, 'progress').mockResolvedValue({
    lessonCount: 1,
    completedLessons: 0,
    completedLessonIds: [],
    learningRouteCompleted: false,
    knowledge: [],
    daily: [],
  });
  vi.spyOn(clinicApi, 'operations').mockResolvedValue({ operations: [] });
  vi.spyOn(clinicApi, 'saveDraft').mockResolvedValue({ saved: true });
  vi.spyOn(clinicApi, 'plan').mockResolvedValue({
    plan,
    inventory: {
      id: 'i',
      workspaceId: 'w',
      sourceScopeHash: 'hash',
      policyVersion: 'study-clinic-v2.1',
      knowledge: [
        {
          id: 'k',
          title: '速度',
          statement: '速度包含方向。',
          kind: 'concept',
          origin: 'textbook',
          sourceSpans: [{ revisionId: 'r', blockId: 'b', start: 0, end: 8 }],
          prerequisiteKnowledgeIds: [],
          relatedKnowledgeIds: [],
          uncertaintyCodes: [],
        },
      ],
      dispositions: [
        {
          span: { revisionId: 'r', blockId: 'b', start: 0, end: 8 },
          knowledgeIds: ['k'],
          exclusion: null,
        },
      ],
    },
  });
  return plan;
}
const completedOperation = (quizId: string): CourseOperation => ({
  id: 'op',
  workspaceId: 'w',
  kind: 'preparePractice',
  resourceKind: 'quiz',
  resourceId: quizId,
  status: 'completed',
  version: 2,
  fence: 1,
  result: null,
  error: null,
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
});
const question = {
  id: 'q1',
  type: 'single_choice' as const,
  prompt: '请选择速度的正确含义',
  options: [
    { id: 'A', text: '速度包含方向' },
    { id: 'B', text: '速度仅有大小' },
  ],
  origin: 'textbook' as const,
  knowledgeIds: ['k'],
  demand: 'understand' as const,
  difficultyBand: 'standard' as const,
  slotId: 'slot',
};
const savedSubmission: CourseSubmission = {
  id: 's',
  workspaceId: 'w',
  quizId: 'q',
  status: 'graded',
  responses: [{ questionId: 'q1', response: ['A'], assistance: 'none' }],
  submittedAt: '2026-10-12T00:00:00.000Z',
  itemGrades: [],
  score: 1,
  passed: true,
  version: 2,
  operationId: 'op',
};
describe('完整规划与独立学习界面', () => {
  it('打开新课堂后进入学习记录会读取最新持久数据，避免仍显示初始0次课堂', async () => {
    const plan = mockCourse();
    vi.mocked(clinicApi.plan).mockResolvedValue({
      plan: { ...plan, status: 'accepted' },
      inventory: null,
    });
    const room = clinicRoom();
    let opened = false;
    vi.spyOn(clinicApi, 'open').mockImplementation(async () => {
      opened = true;
      return room;
    });
    vi.spyOn(clinicApi, 'classroom').mockResolvedValue(room);
    vi.mocked(clinicApi.records).mockImplementation(async () => ({
      curricula: [],
      sessions: opened ? [room.session] : [],
      submissions: [],
      formalGrades: [],
      repairs: [],
    }));
    render(<ClinicWorkspace />);
    await userEvent.click(await screen.findByRole('button', { name: '打开 Lesson' }));
    await screen.findByRole('heading', { name: '第一课正文', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: '学习中心' }));
    await userEvent.click(screen.getByRole('tab', { name: '学习记录' }));
    await screen.findByText('1 次课堂');
    expect(screen.queryByText('打开 Lesson 后，课堂会保存在这里。')).not.toBeInTheDocument();
  });
  it('在成熟课堂中回看历史，新问题只进入独立 revisit，不改写已完成课堂', async () => {
    mockCourse();
    const original = clinicRoom();
    original.session = {
      ...original.session,
      status: 'completed',
      completedAt: '2026-10-12T01:00:00.000Z',
    };
    original.sessions = [original.session];
    vi.mocked(clinicApi.records).mockResolvedValue({
      curricula: [],
      sessions: [original.session],
      submissions: [],
      formalGrades: [],
      repairs: [],
    });
    const revisit = {
      ...original.session,
      id: 'revisit',
      status: 'active' as const,
      purpose: 'revisit' as const,
      originSessionId: original.session.id,
      completedAt: null,
    };
    vi.spyOn(clinicApi, 'classroom').mockImplementation(async (_id, sessionId) =>
      sessionId === 'revisit'
        ? { ...original, session: revisit, sessions: [original.session, revisit] }
        : original,
    );
    const start = vi.spyOn(clinicApi, 'revisit').mockResolvedValue(revisit);
    const tutor = vi.spyOn(clinicApi, 'tutor').mockResolvedValue({});
    const complete = vi.spyOn(clinicApi, 'complete');
    render(<ClinicWorkspace />);
    await screen.findByRole('heading', { name: '第一课', level: 4 });
    await userEvent.click(screen.getByRole('button', { name: '学习中心' }));
    await userEvent.click(screen.getByRole('tab', { name: '学习记录' }));
    await userEvent.click(await screen.findByRole('button', { name: /学习课堂.*只读/u }));
    const question = await screen.findByRole('textbox', { name: '开始独立的回看对话' });
    await userEvent.type(question, '速度与速率的区别？');
    await userEvent.click(screen.getByRole('button', { name: '提问' }));
    await screen.findByRole('textbox', { name: '课堂问题' });
    expect(start).toHaveBeenCalledWith('w', original);
    expect(tutor).toHaveBeenCalledWith('w', 'revisit', '速度与速率的区别？', null);
    expect(complete).not.toHaveBeenCalled();
    expect(original.session.status).toBe('completed');
    expect(screen.queryByRole('button', { name: '我已完成本课' })).not.toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '选择课堂对话' }),
      'session',
    );
    await screen.findByRole('textbox', { name: '开始独立的回看对话' });
  });
  it('切换课程后忽略迟到的 Lesson 响应，不把旧课堂带入新课程', async () => {
    const plan = mockCourse();
    vi.mocked(clinicApi.workspaces).mockResolvedValue({
      workspaces: [
        { id: 'w', title: '课程' },
        { id: 'other', title: '另一门课程' },
      ],
    });
    vi.mocked(clinicApi.plan).mockImplementation(async (id) => ({
      plan: id === 'w' ? { ...plan, status: 'accepted' } : null,
      inventory: null,
    }));
    const original = clinicRoom();
    let resolveOpen!: (value: Awaited<ReturnType<typeof clinicApi.open>>) => void;
    const opening = new Promise<Awaited<ReturnType<typeof clinicApi.open>>>((resolve) => {
      resolveOpen = resolve;
    });
    vi.spyOn(clinicApi, 'open').mockReturnValue(opening);
    const read = vi.spyOn(clinicApi, 'classroom').mockResolvedValue(original);
    render(<ClinicWorkspace />);
    await screen.findByRole('heading', { name: '第一课', level: 4 });
    await userEvent.click(screen.getByRole('button', { name: '打开 Lesson' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '选择课程' }), 'other');
    await screen.findByRole('heading', { name: '准备这门课程' });
    await act(async () => resolveOpen({ session: original.session, content: original.content }));
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '第一课正文' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '准备这门课程' })).toBeInTheDocument();
  });
  it.each(['single_choice', 'short_answer'] as const)(
    '学习记录%s明细展示实际解答，主观题不把作者占位符当可靠答案；关闭返回原入口',
    async (type) => {
      mockCourse();
      vi.mocked(clinicApi.records).mockResolvedValue({
        curricula: [],
        sessions: [],
        submissions: [savedSubmission],
        formalGrades: [],
        repairs: [],
      });
      vi.spyOn(clinicApi, 'submissionDetail').mockResolvedValue({
        submission: savedSubmission,
        quiz: {
          id: 'q',
          workspaceId: 'w',
          purpose: 'practice',
          status: 'ready',
          version: 2,
          items: [{ ...question, type, options: type === 'short_answer' ? [] : question.options }],
          discardedCount: 0,
        },
        solutions: [
          {
            questionId: 'q1',
            answer: type === 'short_answer' ? ['见rubric'] : ['A'],
            explanation: '速度包含方向。',
            rubric: [],
          },
        ],
      });
      render(<ClinicWorkspace />);
      await screen.findByRole('heading', { name: '第一课', level: 4 });
      await userEvent.click(screen.getByRole('button', { name: '学习中心' }));
      await userEvent.click(screen.getByRole('tab', { name: '学习记录' }));
      const opener = screen.getByRole('button', { name: '查看题目和作答' });
      await userEvent.click(opener);
      await waitFor(() => expect(screen.getByRole('article', { name: '作答明细' })).toHaveFocus());
      if (type === 'short_answer') {
        expect(screen.getByText('参考解答')).toBeInTheDocument();
        expect(screen.getByText('速度包含方向。')).toBeInTheDocument();
        expect(screen.queryByText(/见rubric/)).not.toBeInTheDocument();
      } else expect(screen.getByText('可靠答案：速度包含方向')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: '收起作答明细' }));
      await waitFor(() => expect(opener).toHaveFocus());
      expect(screen.queryByRole('article', { name: '作答明细' })).not.toBeInTheDocument();
    },
  );
  it('知识默认折叠，可调深度确认，先修是提醒，Formal独立入口', async () => {
    const plan = mockCourse();
    const depth = vi.spyOn(clinicApi, 'depth').mockResolvedValue({ ...plan, version: 2 });
    const confirm = vi
      .spyOn(clinicApi, 'confirm')
      .mockResolvedValue({ ...plan, status: 'accepted', version: 3 });
    const prepare = vi.spyOn(clinicApi, 'prepare');
    render(<ClinicWorkspace />);
    await screen.findByRole('heading', { name: '第一课', level: 4 });
    const summary = screen.getByText('知识点（1）');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    await userEvent.selectOptions(screen.getByLabelText('第一课讲解深度'), 'advanced');
    await waitFor(() => expect(depth).toHaveBeenCalled());
    expect(prepare).not.toHaveBeenCalled();
    vi.mocked(clinicApi.plan).mockResolvedValue({
      plan: { ...plan, status: 'accepted', version: 3 },
      inventory: null,
    });
    await userEvent.click(screen.getByRole('button', { name: '确认完整规划' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: '打开 Lesson' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '正式考核' }));
    await screen.findByRole('button', { name: '生成单元正式试卷' });
    expect(screen.queryByText('重排')).not.toBeInTheDocument();
  });
  it('准备设置进入一次明确请求，重载恢复运行中真实进度；较旧失败不会覆盖已完成准备', async () => {
    mockCourse();
    vi.mocked(clinicApi.plan).mockResolvedValue({ plan: null, inventory: null });
    const operation: CourseOperation = {
      ...completedOperation('p'),
      kind: 'preparePlan',
      resourceKind: 'curriculum',
      resourceId: null,
      status: 'running',
      preferences: { desiredDepth: 'advanced', focusRequest: '比较条件变化' },
      progress: {
        phase: 'knowledge',
        label: '第二章',
        totalSourceBlocks: 6,
        completedSourceBlocks: 2,
        knowledgeCount: 3,
      },
    };
    const prepare = vi.spyOn(clinicApi, 'prepare').mockResolvedValue(operation);
    const view = render(<ClinicWorkspace />);
    await screen.findByRole('heading', { name: '准备这门课程' });
    await userEvent.selectOptions(screen.getByLabelText('整体学习深度'), 'advanced');
    await userEvent.type(screen.getByLabelText('特别关注的内容（可选）'), '比较条件变化');
    expect(prepare).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '准备完整课程规划' }));
    await screen.findByRole('heading', { name: '第二章' });
    expect(prepare).toHaveBeenCalledWith('w', {
      desiredDepth: 'advanced',
      focusRequest: '比较条件变化',
    });
    expect(screen.getByRole('region', { name: '课程准备状态' })).toHaveTextContent(
      '已保存 2 / 6 个来源片段',
    );
    view.unmount();
    vi.mocked(clinicApi.operations).mockResolvedValue({ operations: [operation] });
    const reloaded = render(<ClinicWorkspace />);
    await screen.findByRole('heading', { name: '第二章' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '停止本次准备' })).toBeEnabled();
    const running = { ...operation, version: operation.version + 1 };
    vi.spyOn(clinicApi, 'operation').mockResolvedValue(running);
    const cancel = vi
      .spyOn(clinicApi, 'cancel')
      .mockResolvedValue({ ...running, status: 'cancelled' });
    await userEvent.click(screen.getByRole('button', { name: '停止本次准备' }));
    await screen.findByRole('heading', { name: '课程准备已停止' });
    expect(cancel).toHaveBeenCalledWith('w', running);
    await userEvent.click(screen.getByRole('button', { name: '继续准备课程' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(prepare).toHaveBeenLastCalledWith('w', operation.preferences);
    reloaded.unmount();
    const plan = mockCourse();
    vi.mocked(clinicApi.operations).mockResolvedValue({
      operations: [
        {
          ...operation,
          resourceId: plan.id,
          status: 'completed',
          progress: { ...operation.progress!, phase: 'ready' },
        },
        { ...operation, id: 'old', status: 'failed' },
      ],
    });
    render(<ClinicWorkspace />);
    await screen.findByRole('heading', { name: '第一课', level: 4 });
    expect(screen.queryByRole('button', { name: '重试未完成部分' })).not.toBeInTheDocument();
    expect(
      screen.getByText('查看准备记录', { exact: false }).closest('details'),
    ).not.toHaveAttribute('open');
  });
  it('打开已完成出题操作恢复冻结作答和成绩，不显示提交或重写草稿', async () => {
    mockCourse();
    vi.mocked(clinicApi.operations).mockResolvedValue({ operations: [completedOperation('q')] });
    vi.mocked(clinicApi.records).mockResolvedValue({
      curricula: [],
      sessions: [],
      submissions: [savedSubmission],
      formalGrades: [],
      repairs: [],
    });
    const quiz: PublicCourseQuiz = {
      id: 'q',
      workspaceId: 'w',
      purpose: 'practice',
      status: 'ready',
      version: 2,
      items: [question],
      discardedCount: 0,
    };
    vi.spyOn(clinicApi, 'quiz').mockResolvedValue(quiz);
    vi.spyOn(clinicApi, 'draft').mockResolvedValue({ answers: [] });
    render(<ClinicWorkspace />);
    await screen.findByRole('heading', { name: '第一课', level: 4 });
    await userEvent.click(screen.getByRole('button', { name: '学习中心' }));
    await userEvent.click(screen.getByRole('tab', { name: '学习记录' }));
    await userEvent.click(screen.getByText('可恢复操作（1）'));
    await userEvent.click(await screen.findByRole('button', { name: '打开已完成结果' }));
    await screen.findByText('得分 100% · 达到本次要求');
    expect(screen.getByRole('radio', { name: '速度包含方向' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '速度包含方向' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '提交作答' })).not.toBeInTheDocument();
    expect(clinicApi.saveDraft).not.toHaveBeenCalled();
  });
  it('回到已结束Retest保留原答案；切回Lesson清除补救，继续后只主动完成当前课', async () => {
    const plan = mockCourse();
    vi.mocked(clinicApi.plan).mockResolvedValue({
      plan: { ...plan, status: 'accepted' },
      inventory: null,
    });
    const round: CourseRepairRound = {
      id: 'r',
      workspaceId: 'w',
      originKind: 'submission',
      originId: 's',
      targetItemIds: ['q1'],
      ordinal: 4,
      status: 'completed',
      learnerOutcome: 'passed',
      explanation: '完整补救说明',
      retestQuizId: 'q',
      retestSubmissionId: 's',
      operationId: 'op',
      version: 3,
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
    };
    vi.mocked(clinicApi.records).mockResolvedValue({
      curricula: [],
      sessions: [],
      submissions: [savedSubmission],
      formalGrades: [],
      repairs: [round],
    });
    vi.spyOn(clinicApi, 'round').mockResolvedValue({
      round,
      quiz: {
        id: 'q',
        workspaceId: 'w',
        purpose: 'retest',
        status: 'ready',
        version: 2,
        items: [question],
        discardedCount: 0,
      },
    });
    vi.spyOn(clinicApi, 'submission').mockResolvedValue(savedSubmission);
    vi.spyOn(clinicApi, 'draft').mockResolvedValue({ answers: [] });
    const session = {
      id: 'session',
      workspaceId: 'w',
      curriculumId: 'p',
      lessonVersionId: 'lv',
      purpose: 'learning' as const,
      originSessionId: null,
      status: 'active' as const,
      createdAt: '2026-10-12T00:00:00.000Z',
      completedAt: null,
    };
    const content: CourseLessonContent = {
      id: 'lv',
      title: '第一课正文',
      lessonId: 'l',
      workspaceId: 'w',
      curriculumId: 'p',
      semanticKey: 'key',
      version: 1,
      sourceScopeHash: 'hash',
      policyVersion: 'study-clinic-v2.1',
      segments: [
        {
          id: 'segment',
          kind: 'explanation',
          origin: 'textbook',
          text: '速度包含方向。',
          sourceRefs: [],
          uncertaintyCodes: [],
        },
      ],
      deliveryCheck: {
        policyVersion: 'study-clinic-v2.1',
        requiredKnowledgeHash: 'k-hash',
        localChecksHash: 'local-hash',
        targetedReceipts: [],
        anchors: [
          {
            knowledgeId: 'k',
            objectiveIds: ['o'],
            segmentId: 'segment',
            start: 0,
            end: 7,
            segmentHash: 'segment-hash',
          },
        ],
      },
      teachingCoverage: [
        {
          knowledgeId: 'k',
          objectiveIds: ['o'],
          segmentId: 'segment',
          teachingQuote: '速度包含方向。',
        },
      ],
    };
    vi.spyOn(clinicApi, 'open').mockResolvedValue({ session, content } as Awaited<
      ReturnType<typeof clinicApi.open>
    >);
    vi.spyOn(clinicApi, 'classroom').mockResolvedValue({
      session,
      content,
      turns: [],
      sessions: [session],
    } as Awaited<ReturnType<typeof clinicApi.classroom>>);
    render(<ClinicWorkspace />);
    await screen.findByRole('heading', { name: '第一课', level: 4 });
    await userEvent.click(screen.getByRole('button', { name: '学习中心' }));
    await userEvent.click(screen.getByRole('tab', { name: '学习记录' }));
    await userEvent.click(await screen.findByRole('button', { name: '回看本轮' }));
    await screen.findByText('第 4 轮补救');
    expect(screen.getByRole('radio', { name: '速度包含方向' })).toBeChecked();
    expect(screen.queryByRole('button', { name: '提交作答' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '课程' }));
    await userEvent.click(screen.getByRole('button', { name: '打开 Lesson' }));
    await screen.findByRole('heading', { name: '第一课正文', level: 1 });
    expect(screen.queryByText('第 4 轮补救')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '我已完成本课' })).toBeEnabled();
    expect(clinicApi.saveDraft).not.toHaveBeenCalled();
  });
});
