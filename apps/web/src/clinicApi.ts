import type {
  CoursePlan,
  CourseKnowledgeInventory,
  CourseOperation,
  CourseLesson,
  CourseLessonContent,
  CourseSession,
  CourseSubmission,
  CourseRepairRound,
  CoursePublicQuestion,
  CourseCommand,
  ProviderConfigUpdate,
  SafeProviderConfig,
  CourseSourceSpan,
  CoursePreferences,
  CourseTutorAnchor,
  LessonReflection,
  CourseQuiz,
} from '@hy3-clinic/shared';
export interface ClinicMaterialSummary {
  id: string;
  title: string;
  revisionId: string;
  warnings: string[];
  filename?: string | null;
  sourceType?: string;
  charCount?: number;
  blockCount?: number;
  pageCount?: number;
  parserVersion?: string;
  createdAt?: string;
}
export interface WorkspaceSummary {
  id: string;
  title: string;
  createdAt?: string;
  summary?: {
    status: string;
    lessonCount: number;
    completedLessons: number;
    materialCount: number;
    materialTitles: string[];
    lastActivityAt: string;
    activeOperations: number;
  };
}
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export interface PublicCourseQuiz {
  id: string;
  workspaceId: string;
  purpose: 'practice' | 'retest' | 'explicit_review' | 'formal';
  status: 'draft' | 'ready';
  version: number;
  items: CoursePublicQuestion[];
  discardedCount: number;
  assessmentScope?: CourseQuiz['assessmentScope'];
}
export interface Classroom {
  session: CourseSession;
  content: CourseLessonContent;
  turns: {
    id: string;
    question: string;
    text: string;
    createdAt: string;
    sourceRefs?: CourseSourceSpan[];
    includesExtension?: boolean;
    anchor?: CourseTutorAnchor;
  }[];
  sessions: CourseSession[];
  sourceQuotes?: { span: CourseSourceSpan; title: string; quote: string }[];
  reflections?: LessonReflection[];
}
export interface DailyTarget {
  id: string;
  knowledgeId: string;
  title: string;
  diagnostic: { sourceKind: string; result: string; assistance: string; occurredAt: string } | null;
  schedule: { dueAt: string; repetitions: number } | null;
  due: boolean;
}
export interface LearningProgress {
  pendingStudyOutcomes?: string[];
  lessonCount: number;
  completedLessons: number;
  completedLessonIds: string[];
  learningRouteCompleted: boolean;
  knowledge: (CourseKnowledgeInventory['knowledge'][number] & {
    planned: boolean;
    delivered: boolean;
    learned: boolean;
    formalStatus: 'untested' | 'partial' | 'supported';
  })[];
  daily: DailyTarget[];
  sourceWarnings?: { title: string; message: string }[];
  classroomTasks?: {
    lessonId: string;
    lessonVersionId: string;
    lessonTitle: string;
    segmentId: string;
    prompt: string;
    status: LessonReflection['status'];
    response: string;
    version: number;
  }[];
}
export interface LearningRecords {
  curricula: CoursePlan[];
  sessions: CourseSession[];
  submissions: CourseSubmission[];
  formalGrades: {
    id: string;
    quizId: string;
    submissionId: string;
    score: number;
    passed: boolean;
    createdAt: string;
    currentSource: boolean;
    assessmentScope?: CourseQuiz['assessmentScope'];
  }[];
  repairs: CourseRepairRound[];
}
export const command = (): CourseCommand => {
  const id = crypto.randomUUID();
  return { commandId: id, idempotencyKey: id };
};
export async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const result = (await response.json()) as T & { error?: { code: string; message: string } };
  if (!response.ok)
    throw new ApiClientError(
      result.error?.code ?? 'INTERNAL',
      result.error?.message ?? '请求未完成。',
      response.status,
    );
  return result;
}
const base = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;
export const clinicApi = {
  workspaces: () => request<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
  deleteWorkspaces: (workspaceIds: string[]) =>
    request<{ removed: true; workspaceIds: string[] }>('/api/workspaces/delete', 'POST', {
      command: command(),
      confirmed: true,
      workspaceIds,
    }),
  createWorkspace: (title: string) =>
    request<{ id: string; title: string }>('/api/workspaces', 'POST', { title }),
  materials: (id: string) =>
    request<{ materials: ClinicMaterialSummary[] }>(`${base(id)}/materials`),
  removeMaterial: (id: string, materialId: string) =>
    request(`${base(id)}/materials/${materialId}`, 'DELETE', { command: command() }),
  renameMaterial: (id: string, materialId: string, title: string) =>
    request(`${base(id)}/materials/${materialId}`, 'PATCH', { command: command(), title }),
  import: (id: string, body: unknown) => request(`${base(id)}/materials`, 'POST', body),
  plan: (id: string) =>
    request<{ plan: CoursePlan | null; inventory: CourseKnowledgeInventory | null }>(
      `${base(id)}/course-plan`,
    ),
  prepare: (id: string, preferences?: CoursePreferences) =>
    request<CourseOperation>(`${base(id)}/course-plan/prepare`, 'POST', {
      command: command(),
      ...(preferences ? { preferences } : {}),
    }),
  depth: (id: string, plan: CoursePlan, lessonId: string, depth: CourseLesson['selectedDepth']) =>
    request<CoursePlan>(`${base(id)}/course-plan/${plan.id}/lesson-depths`, 'PATCH', {
      command: command(),
      expectedVersion: plan.version,
      changes: [{ lessonId, depth }],
    }),
  confirm: (id: string, plan: CoursePlan) =>
    request<CoursePlan>(`${base(id)}/course-plan/${plan.id}/confirm`, 'POST', {
      command: command(),
      expectedVersion: plan.version,
    }),
  lessons: (id: string) =>
    request<{
      lessons: (CourseLesson & {
        completed: boolean;
        content: CourseLessonContent | null;
        prerequisiteWarnings: string[];
      })[];
    }>(`${base(id)}/lessons`),
  open: (id: string, plan: CoursePlan, lessonId: string) =>
    request<CourseOperation | { session: CourseSession; content: CourseLessonContent }>(
      `${base(id)}/lessons/${lessonId}/open`,
      'POST',
      { command: command(), curriculumId: plan.id },
    ),
  classroom: (id: string, sessionId: string) =>
    request<Classroom>(`${base(id)}/study-sessions/${sessionId}`),
  complete: (id: string, room: Classroom) =>
    request<CourseSession>(`${base(id)}/lessons/${room.content.lessonId}/complete`, 'POST', {
      command: command(),
      visitId: room.session.id,
      lessonVersionId: room.content.id,
    }),
  revisit: (id: string, room: Classroom) =>
    request<CourseSession>(`${base(id)}/lessons/${room.content.lessonId}/revisits`, 'POST', {
      command: command(),
      curriculumId: room.session.curriculumId,
      lessonVersionId: room.content.id,
      originSessionId: room.session.id,
    }),
  tutor: (id: string, sessionId: string, question: string, anchor?: CourseTutorAnchor | null) =>
    request(`${base(id)}/study-sessions/${sessionId}/turns`, 'POST', {
      question,
      ...(anchor ? { anchor } : {}),
    }),
  reflection: (
    id: string,
    room: Classroom,
    segmentId: string,
    status: LessonReflection['status'],
    response: string,
  ) =>
    request<LessonReflection>(
      `${base(id)}/lesson-versions/${room.content.id}/reflections/${encodeURIComponent(segmentId)}`,
      'PUT',
      {
        command: command(),
        status,
        response,
        expectedVersion: room.reflections?.find((r) => r.segmentId === segmentId)?.version ?? 0,
      },
    ),
  practice: (id: string, room: Classroom) =>
    request<CourseOperation>(`${base(id)}/lessons/${room.content.lessonId}/practice`, 'POST', {
      command: command(),
      curriculumId: room.session.curriculumId,
      lessonVersionId: room.content.id,
      practiceRequestId: crypto.randomUUID(),
    }),
  formal: (id: string, plan: CoursePlan, moduleId?: string) =>
    request<CourseOperation>(`${base(id)}/formal-exams`, 'POST', {
      command: command(),
      curriculumId: plan.id,
      blueprintId: plan.assessmentBlueprint.id,
      paperRequestId: crypto.randomUUID(),
      ...(moduleId ? { moduleId } : {}),
    }),
  startFormal: (id: string, quizId: string) =>
    request<{ id: string; quiz: PublicCourseQuiz }>(
      `/api/formal-assessment-versions/${quizId}/execution`,
      'POST',
      { command: command(), workspaceId: id },
    ),
  supplementFormal: (workspaceId: string, operation: CourseOperation) =>
    request<CourseOperation>(
      `${base(workspaceId)}/operations/${operation.id}/supplement-formal`,
      'POST',
      {
        command: command(),
        expectedVersion: operation.version,
      },
    ),
  quiz: (id: string) => request<PublicCourseQuiz>(`/api/quizzes/${id}`),
  draft: (workspaceId: string, quiz: PublicCourseQuiz) =>
    request<{ answers: { questionId: string; response: string | string[] }[] }>(
      `${base(workspaceId)}/quizzes/${quiz.id}/draft`,
    ),
  saveDraft: (workspaceId: string, quiz: PublicCourseQuiz, answers: unknown[]) =>
    request(`${base(workspaceId)}/quizzes/${quiz.id}/draft`, 'PUT', {
      answers,
      expectedVersion: quiz.version,
    }),
  hint: (workspaceId: string, quiz: PublicCourseQuiz, questionId: string) =>
    request<{ hint: string }>(`${base(workspaceId)}/quizzes/${quiz.id}/hints`, 'POST', {
      questionId,
    }),
  submissionDetail: (workspaceId: string, id: string) =>
    request<{
      submission: CourseSubmission;
      quiz: PublicCourseQuiz;
      solutions: {
        questionId: string;
        answer: string[];
        explanation: string;
        rubric: { id: string; description: string }[];
      }[];
    }>(`${base(workspaceId)}/submissions/${id}/detail`),
  submit: (
    id: string,
    quiz: PublicCourseQuiz,
    answers: unknown[],
    attemptId?: string,
    round?: CourseRepairRound,
  ) =>
    request<{ submission: CourseSubmission; operation: CourseOperation | null }>(
      round
        ? `/api/repair-rounds/${round.id}/submit`
        : attemptId
          ? `/api/formal-assessment-attempts/${attemptId}/learner-submit`
          : `/api/quizzes/${quiz.id}/submissions`,
      'POST',
      round
        ? { command: command(), workspaceId: id, answers, version: round.version }
        : attemptId
          ? {
              command: command(),
              workspaceId: id,
              responses: answers,
              expectedVersion: quiz.version,
            }
          : { command: command(), workspaceId: id, answers, expectedQuizVersion: quiz.version },
    ),
  submission: (id: string, submissionId: string) =>
    request<CourseSubmission>(`${base(id)}/submissions/${submissionId}`),
  repair: (id: string, submission: CourseSubmission, replace?: CourseRepairRound) =>
    request<CourseRepairRound>(`${base(id)}/repairs`, 'POST', {
      command: command(),
      originKind: 'submission',
      originId: submission.id,
      targetItemIds: submission.itemGrades.filter((g) => g.score < 1).map((g) => g.questionId),
      ...(replace
        ? { replacePendingRoundId: replace.id, expectedRoundVersion: replace.version }
        : {}),
    }),
  round: (id: string) =>
    request<{ round: CourseRepairRound; quiz: PublicCourseQuiz | null }>(
      `/api/repair-rounds/${id}`,
    ),
  records: (id: string) => request<LearningRecords>(`${base(id)}/learning-records`),
  progress: (id: string) => request<LearningProgress>(`${base(id)}/learning-progress`),
  review: (id: string, targetId: string) =>
    request<CourseOperation>(`${base(id)}/review/${targetId}/launch`, 'POST', {
      command: command(),
      expectedBindingVersion: 1,
      practiceRequestId: crypto.randomUUID(),
    }),
  operation: (id: string, operationId: string) =>
    request<CourseOperation>(`${base(id)}/operations/${operationId}`),
  operations: (id: string) => request<{ operations: CourseOperation[] }>(`${base(id)}/operations`),
  retry: (id: string, op: CourseOperation) =>
    request<CourseOperation>(`${base(id)}/operations/${op.id}/retry`, 'POST', {
      command: command(),
      expectedVersion: op.version,
    }),
  cancel: (id: string, op: CourseOperation) =>
    request<CourseOperation>(`${base(id)}/operations/${op.id}/cancel`, 'POST', {
      command: command(),
      expectedVersion: op.version,
    }),
  reconcile: (id: string) =>
    request<LearningProgress>(`${base(id)}/learning-progress/reconcile`, 'POST', {
      command: command(),
    }),
};
export const api = {
  config: (signal?: AbortSignal) =>
    request<SafeProviderConfig>('/api/config', 'GET', undefined, signal),
  updateConfig: (input: ProviderConfigUpdate, signal?: AbortSignal) =>
    request<SafeProviderConfig>('/api/config', 'PUT', input, signal),
  providerModels: (input: ProviderConfigUpdate, signal?: AbortSignal) =>
    request<{ models: string[] }>('/api/config/models', 'POST', input, signal),
  testProviderDraft: (input: ProviderConfigUpdate, signal?: AbortSignal) =>
    request<{ status: 'verified'; message: string }>(
      '/api/config/draft-test',
      'POST',
      input,
      signal,
    ),
  health: (signal?: AbortSignal) =>
    request<{ ok: boolean }>('/api/health', 'GET', undefined, signal),
};
