import type {
  AlignmentProposal,
  ApiErrorCodeValue,
  AssessmentMode,
  CanonicalConcept,
  CanonicalConceptView,
  CompletedAttemptDetail,
  CompletedAttemptSummary,
  Concept,
  ConceptLearnerState,
  ConceptLesson,
  DailyQueueItem,
  DocumentDeletionResult,
  DocumentSummary,
  GradingResult,
  GraphEdge,
  GraphVersion,
  LessonDirective,
  Material,
  MasteryState,
  MisconceptionRecord,
  MisconceptionStatus,
  MistakeRecord,
  PublicBlueprint,
  PublicQuiz,
  Question,
  QuizConfig,
  RemediationPlan,
  ReviewItem,
  SourceBlock,
  SubmissionStateChanges,
  TutorEvent,
  TutorRun,
  Workspace,
  WorkspaceOrigin,
  WorkspaceSummary,
  SafeProviderConfig,
} from '@hy3-clinic/shared';
import {
  CourseActionLaunchResultSchema,
  CourseExecutionOverviewResponseSchema,
  CurriculumHistoryResponseSchema,
  CurriculumProposalResponseSchema,
  LearningContractDetailResponseSchema,
  LearningContractHistoryResponseSchema,
  MaterialRoleAssignmentResponseSchema,
  MaterialRoleHistoryResponseSchema,
  StudyPlanDecisionResponseSchema,
  StudyPlanHistoryResponseSchema,
  StudyPlanProposalResponseSchema,
  SafeProviderConfigSchema,
  type AcceptCurriculumRequest,
  type ApplyStudyPlanDraftEditRequest,
  type ConfirmMaterialRoleRequest,
  type CourseActionLaunchResult,
  type CourseExecutionOverviewResponse,
  type CreateLearningContractDraftRequest,
  type CurriculumHistoryResponse,
  type CurriculumProposalResponse,
  type DecideStudyPlanRequest,
  type LearningContractDetailResponse,
  type LearningContractHistoryResponse,
  type MaterialRoleAssignment,
  type MaterialRoleHistoryResponse,
  type ProposeMaterialRoleRequest,
  type ProposeStudyPlanRequest,
  type RejectCurriculumRequest,
  type StudyPlanHistoryResponse,
  type StudyPlanProposalResponse,
  type TransitionLearningContractRequest,
  type UpdateLearningContractDraftRequest,
  type ProposeCurriculumRequest,
  type LaunchCourseActionRequest,
  StudySessionDetailResponseSchema,
  StudyTurnEventSchema,
  StartStudySessionResponseSchema,
  SubmitTutorTurnResponseSchema,
  MixedInitiativeCommandResponseSchema,
  SessionExecutionCommandResponseSchema,
  StudySessionSchema,
  type StartStudySessionRequest,
  type StartStudySessionResponse,
  type StudySessionDetailResponse,
  type SubmitTutorTurnRequest,
  type SubmitTutorTurnResponse,
  type MixedInitiativeCommandRequest,
  type MixedInitiativeCommandResponse,
  type SessionExecutionCommandRequest,
  type SessionExecutionCommandResponse,
  type StudySession,
  type StudyTurnEvent,
  FormalProgressionOverviewSchema,
  ProgressionReconciliationResponseSchema,
  ReplanTriggerSchema,
  GoalOutcomeSchema,
  type FormalProgressionOverview,
  type ProgressionReconciliationResponse,
  type QualifyReplanTriggerRequest,
  type ProposeQualifiedReplanRequest,
  type RecordGoalOutcomeRequest,
  type ReconcileProgressionRequest,
  type ReplanTrigger,
  type GoalOutcome,
} from '@hy3-clinic/shared';
import { z } from 'zod';

/** Normalized client-side API error (mirrors the server's structured body). */
export class ApiClientError extends Error {
  constructor(
    readonly code: ApiErrorCodeValue | 'NETWORK_ERROR' | 'ABORTED',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface MaterialSummary {
  id: string;
  workspaceId?: string;
  title: string;
  sourceType: string;
  charCount: number;
  blockCount: number;
  createdAt: string;
  /** Origin of the owning workspace (decides the deletion lifecycle). */
  workspaceOrigin?: WorkspaceOrigin;
  /** Documents currently in the owning workspace (including this one). */
  workspaceDocumentCount?: number;
}

export interface MaterialWithBlocks {
  material: Material;
  blocks: SourceBlock[];
}

export interface MistakesResponse {
  mistakes: MistakeRecord[];
  weakConcepts: Array<{ conceptId: string; conceptName: string; openMistakes: number }>;
}

export interface MasteryResponse {
  mastery: MasteryState[];
  weakConcepts: Array<{ conceptId: string; conceptName: string; openMistakes: number }>;
}

export interface SubmissionResponse {
  grading: GradingResult;
  stateChanges?: SubmissionStateChanges;
  questions: Question[];
}

export interface AlignmentOverviewResponse {
  canonical: CanonicalConceptView[];
  pendingProposals: AlignmentProposal[];
  decidedProposals: AlignmentProposal[];
}

export interface AlignmentProposeResponse {
  autoAccepted: AlignmentProposal[];
  created: AlignmentProposal[];
  rejected: Array<{
    sourceConceptId: string | null;
    targetConceptId: string | null;
    reason: string;
  }>;
  candidateCount: number;
}

export interface AssessmentResponse {
  quiz: PublicQuiz;
  blueprints: PublicBlueprint[];
  rejected: Array<{ stem: string; reason: string }>;
}

/** Per-section outcome of one extraction run (initial or deepen). */
export interface SectionExtractionReport {
  key: string;
  title: string;
  charCount: number;
  status: 'extracted' | 'empty' | 'failed' | 'skipped_existing' | 'skipped_cap';
  conceptsAdded: number;
}

export interface AnalyzeResponse {
  concepts: Concept[];
  /** Null when concepts already existed and no extraction ran. */
  extraction: {
    sections: SectionExtractionReport[];
    conceptsAdded: number;
    conceptTotal: number;
    capReached: boolean;
  } | null;
}

/** Structural mapping of one document — mapping/anchoring facts only. */
export interface DocumentMapping {
  materialId: string;
  title: string;
  totals: {
    blockCount: number;
    charCount: number;
    conceptCount: number;
    mappedSectionCount: number;
    sectionCount: number;
    anchoredBlockCount: number;
    anchoredCharCount: number;
  };
  sections: Array<{
    key: string;
    title: string;
    fromHeading: boolean;
    blockCount: number;
    charCount: number;
    conceptCount: number;
    anchoredBlockCount: number;
    anchoredCharCount: number;
    mapped: boolean;
  }>;
}

/** Response of the server-owned Tutor activity launch. */
export interface TutorActivityLaunchResponse extends AssessmentResponse {
  /** Mode actually launched (after any deterministic adjustment). */
  launchedMode: AssessmentMode;
  /** Set when the persisted recommendation was substituted at launch time. */
  adjusted: { originalMode: AssessmentMode; reason: string } | null;
}

/** One parsed NDJSON line of the Tutor timeline stream. */
export type TutorStreamLine =
  | { kind: 'event'; event: TutorEvent }
  | { kind: 'run'; run: TutorRun }
  | { kind: 'error'; message: string };

export interface WorkspaceGraphResponse {
  version: GraphVersion | null;
  edges: GraphEdge[];
  concepts: Concept[];
}

export interface GraphGenerationResponse {
  version: GraphVersion;
  edges: GraphEdge[];
}

export interface PlanLaunchResponse {
  quiz: PublicQuiz;
  mode: 'remediation' | 'practice';
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ?? null,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiClientError('ABORTED', '请求已取消。');
    }
    throw new ApiClientError('NETWORK_ERROR', '无法连接服务器,请确认后端已启动。');
  }

  if (!response.ok) {
    let code: ApiErrorCodeValue = 'INTERNAL';
    let message = `请求失败(${response.status})。`;
    try {
      const data = (await response.json()) as { error?: { code?: string; message?: string } };
      if (data.error?.code) code = data.error.code as ApiErrorCodeValue;
      if (data.error?.message) message = data.error.message;
    } catch {
      // keep defaults
    }
    throw new ApiClientError(code, message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

const StudySessionListResponseSchema = z.object({ sessions: z.array(StudySessionSchema) }).strict();

export type StudyTurnStreamLine =
  | { kind: 'event'; event: StudyTurnEvent }
  | { kind: 'terminal'; result: SubmitTutorTurnResponse }
  | { kind: 'error'; message: string };

async function requestParsed<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  schema: RuntimeSchema<T>,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const value = await request<unknown>(method, url, body, signal);
  try {
    return schema.parse(value);
  } catch {
    throw new ApiClientError('INTERNAL', '服务端返回了不兼容的课程执行数据。');
  }
}

export const api = {
  health: (signal?: AbortSignal) =>
    request<{ status: string }>('GET', '/api/health', undefined, signal),
  config: (signal?: AbortSignal) =>
    requestParsed<SafeProviderConfig>(
      'GET',
      '/api/config',
      SafeProviderConfigSchema,
      undefined,
      signal,
    ),
  updateConfig: (input: unknown, signal?: AbortSignal) =>
    requestParsed<SafeProviderConfig>(
      'PATCH',
      '/api/config',
      SafeProviderConfigSchema,
      input,
      signal,
    ),
  testProviderConnection: (signal?: AbortSignal) =>
    requestParsed<SafeProviderConfig>(
      'POST',
      '/api/config/test',
      SafeProviderConfigSchema,
      {},
      signal,
    ),

  sampleMaterial: (signal?: AbortSignal) =>
    request<{ title: string; content: string; filename: string }>(
      'GET',
      '/api/sample-material',
      undefined,
      signal,
    ),

  importMaterial: (
    input:
      | { content: string; title?: string; filename?: string }
      | { filename: string; dataBase64: string; title?: string },
    signal?: AbortSignal,
  ) => request<MaterialWithBlocks>('POST', '/api/materials', input, signal),

  listMaterials: () => request<{ materials: MaterialSummary[] }>('GET', '/api/materials'),

  getMaterial: (id: string, signal?: AbortSignal) =>
    request<MaterialWithBlocks>('GET', `/api/materials/${id}`, undefined, signal),

  renameMaterial: (id: string, title: string, signal?: AbortSignal) =>
    request<{ material: Material }>('PATCH', `/api/materials/${id}`, { title }, signal),

  deleteMaterial: (id: string, signal?: AbortSignal) =>
    request<DocumentDeletionResult>('DELETE', `/api/materials/${id}`, undefined, signal),

  analyze: (materialId: string, signal?: AbortSignal, section?: string) =>
    request<AnalyzeResponse>(
      'POST',
      `/api/materials/${materialId}/analyze`,
      section ? { section } : undefined,
      signal,
    ),

  /** Structural mapping of one document (sections, concepts, anchors). */
  documentMapping: (materialId: string, signal?: AbortSignal) =>
    request<DocumentMapping>('GET', `/api/materials/${materialId}/mapping`, undefined, signal),

  getConcepts: (materialId: string) =>
    request<{ concepts: Concept[] }>('GET', `/api/materials/${materialId}/concepts`),

  generateQuiz: (materialId: string, config: QuizConfig, signal?: AbortSignal) =>
    request<{ quiz: PublicQuiz }>('POST', '/api/quizzes', { materialId, config }, signal),

  getQuiz: (quizId: string) => request<{ quiz: PublicQuiz }>('GET', `/api/quizzes/${quizId}`),

  submit: (
    quizId: string,
    answers: Array<{
      questionId: string;
      type: string;
      selectedOptionIds?: string[];
      text?: string;
    }>,
    signal?: AbortSignal,
  ) =>
    request<SubmissionResponse>('POST', `/api/quizzes/${quizId}/submissions`, { answers }, signal),

  mistakes: (materialId: string, status: 'open' | 'all' = 'all') =>
    request<MistakesResponse>('GET', `/api/materials/${materialId}/mistakes?status=${status}`),

  remediation: (materialId: string, signal?: AbortSignal) =>
    request<{ quiz: PublicQuiz }>(
      'POST',
      `/api/materials/${materialId}/remediation`,
      undefined,
      signal,
    ),

  mastery: (materialId: string) =>
    request<MasteryResponse>('GET', `/api/materials/${materialId}/mastery`),

  // --- Course workspaces, documents, concept graph, planner ---

  createWorkspace: (input: { name: string; description?: string }, signal?: AbortSignal) =>
    request<{ workspace: Workspace }>('POST', '/api/workspaces', input, signal),

  listWorkspaces: (signal?: AbortSignal) =>
    request<{ workspaces: WorkspaceSummary[] }>('GET', '/api/workspaces', undefined, signal),

  getWorkspace: (id: string, signal?: AbortSignal) =>
    request<{ workspace: Workspace; documents: DocumentSummary[] }>(
      'GET',
      `/api/workspaces/${id}`,
      undefined,
      signal,
    ),

  deleteWorkspace: (id: string, signal?: AbortSignal) =>
    request<void>('DELETE', `/api/workspaces/${id}`, undefined, signal),

  addDocument: (
    workspaceId: string,
    input:
      | { kind: 'text'; content: string; title?: string; filename?: string }
      | { kind: 'file'; filename: string; dataBase64: string; title?: string },
    signal?: AbortSignal,
  ) =>
    request<MaterialWithBlocks>('POST', `/api/workspaces/${workspaceId}/documents`, input, signal),

  deleteDocument: (workspaceId: string, documentId: string, signal?: AbortSignal) =>
    request<DocumentDeletionResult>(
      'DELETE',
      `/api/workspaces/${workspaceId}/documents/${documentId}`,
      undefined,
      signal,
    ),

  reprocessDocument: (workspaceId: string, documentId: string, signal?: AbortSignal) =>
    request<MaterialWithBlocks>(
      'POST',
      `/api/workspaces/${workspaceId}/documents/${documentId}/reprocess`,
      undefined,
      signal,
    ),

  // --- Learning execution: stable material roles and accepted route ---

  materialRoleHistory: (
    workspaceId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<MaterialRoleHistoryResponse> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/documents/${documentId}/role`,
      MaterialRoleHistoryResponseSchema,
      undefined,
      signal,
    ),

  proposeMaterialRole: (
    workspaceId: string,
    documentId: string,
    input: ProposeMaterialRoleRequest,
    signal?: AbortSignal,
  ): Promise<MaterialRoleAssignment> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/documents/${documentId}/role/proposals`,
      MaterialRoleAssignmentResponseSchema,
      input,
      signal,
    ).then((response) => response.assignment),

  confirmMaterialRole: (
    workspaceId: string,
    documentId: string,
    assignmentId: string,
    input: ConfirmMaterialRoleRequest,
    signal?: AbortSignal,
  ): Promise<MaterialRoleAssignment> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/documents/${documentId}/role/${assignmentId}/confirm`,
      MaterialRoleAssignmentResponseSchema,
      input,
      signal,
    ).then((response) => response.assignment),

  courseExecution: (
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<CourseExecutionOverviewResponse> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/execution`,
      CourseExecutionOverviewResponseSchema,
      undefined,
      signal,
    ),

  learningContractHistory: (
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<LearningContractHistoryResponse> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/contracts`,
      LearningContractHistoryResponseSchema,
      undefined,
      signal,
    ),

  learningContract: (
    workspaceId: string,
    contractId: string,
    signal?: AbortSignal,
  ): Promise<LearningContractDetailResponse> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/contracts/${contractId}`,
      LearningContractDetailResponseSchema,
      undefined,
      signal,
    ),

  createLearningContract: (
    workspaceId: string,
    input: CreateLearningContractDraftRequest,
    signal?: AbortSignal,
  ): Promise<LearningContractDetailResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/contracts`,
      LearningContractDetailResponseSchema,
      input,
      signal,
    ),

  updateLearningContract: (
    workspaceId: string,
    contractId: string,
    input: UpdateLearningContractDraftRequest,
    signal?: AbortSignal,
  ): Promise<LearningContractDetailResponse> =>
    requestParsed(
      'PATCH',
      `/api/workspaces/${workspaceId}/contracts/${contractId}`,
      LearningContractDetailResponseSchema,
      input,
      signal,
    ),

  transitionLearningContract: (
    workspaceId: string,
    contractId: string,
    input: TransitionLearningContractRequest,
    signal?: AbortSignal,
  ): Promise<LearningContractDetailResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/contracts/${contractId}/transition`,
      LearningContractDetailResponseSchema,
      input,
      signal,
    ),

  curriculumHistory: (
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<CurriculumHistoryResponse> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/curricula`,
      CurriculumHistoryResponseSchema,
      undefined,
      signal,
    ),

  curriculum: (
    workspaceId: string,
    curriculumId: string,
    signal?: AbortSignal,
  ): Promise<CurriculumProposalResponse> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/curricula/${curriculumId}`,
      CurriculumProposalResponseSchema,
      undefined,
      signal,
    ),

  proposeCurriculum: (
    workspaceId: string,
    input: Omit<ProposeCurriculumRequest, 'executionSourceManifest'>,
    signal?: AbortSignal,
  ): Promise<CurriculumProposalResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/curricula/proposals`,
      CurriculumProposalResponseSchema,
      input,
      signal,
    ),

  acceptCurriculum: (
    workspaceId: string,
    curriculumId: string,
    input: AcceptCurriculumRequest,
    signal?: AbortSignal,
  ): Promise<CurriculumProposalResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/curricula/${curriculumId}/accept`,
      CurriculumProposalResponseSchema,
      input,
      signal,
    ),

  rejectCurriculum: (
    workspaceId: string,
    curriculumId: string,
    input: RejectCurriculumRequest,
    signal?: AbortSignal,
  ): Promise<CurriculumProposalResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/curricula/${curriculumId}/reject`,
      CurriculumProposalResponseSchema,
      input,
      signal,
    ),

  studyPlanHistory: (
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<StudyPlanHistoryResponse> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/study-plans`,
      StudyPlanHistoryResponseSchema,
      undefined,
      signal,
    ),

  proposeStudyPlan: (
    workspaceId: string,
    input: ProposeStudyPlanRequest,
    signal?: AbortSignal,
  ): Promise<StudyPlanProposalResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-plans/proposals`,
      StudyPlanProposalResponseSchema,
      input,
      signal,
    ),

  editStudyPlan: (
    workspaceId: string,
    planId: string,
    input: ApplyStudyPlanDraftEditRequest,
    signal?: AbortSignal,
  ): Promise<StudyPlanProposalResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-plans/${planId}/edits`,
      StudyPlanProposalResponseSchema,
      input,
      signal,
    ),

  decideStudyPlan: (
    workspaceId: string,
    planId: string,
    input: DecideStudyPlanRequest,
    signal?: AbortSignal,
  ) =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-plans/${planId}/decision`,
      StudyPlanDecisionResponseSchema,
      input,
      signal,
    ),

  launchAgendaItem: (
    workspaceId: string,
    agendaId: string,
    agendaItemId: string,
    input: LaunchCourseActionRequest,
    signal?: AbortSignal,
  ): Promise<CourseActionLaunchResult> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/agendas/${agendaId}/items/${agendaItemId}/launch`,
      CourseActionLaunchResultSchema,
      input,
      signal,
    ),

  // --- Persistent conversational Study Sessions ---

  listStudySessions: (
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<{ sessions: StudySession[] }> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/study-sessions`,
      StudySessionListResponseSchema,
      undefined,
      signal,
    ),

  startStudySession: (
    workspaceId: string,
    input: StartStudySessionRequest,
    signal?: AbortSignal,
  ): Promise<StartStudySessionResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-sessions`,
      StartStudySessionResponseSchema,
      input,
      signal,
    ),

  getStudySession: (
    workspaceId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<StudySessionDetailResponse> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/study-sessions/${sessionId}`,
      StudySessionDetailResponseSchema,
      undefined,
      signal,
    ),

  submitTutorTurn: (
    workspaceId: string,
    sessionId: string,
    input: SubmitTutorTurnRequest,
    signal?: AbortSignal,
  ): Promise<SubmitTutorTurnResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-sessions/${sessionId}/turns`,
      SubmitTutorTurnResponseSchema,
      input,
      signal,
    ),

  streamTutorTurn: async (
    workspaceId: string,
    sessionId: string,
    input: SubmitTutorTurnRequest,
    onLine: (line: StudyTurnStreamLine) => void,
    signal?: AbortSignal,
  ): Promise<SubmitTutorTurnResponse> => {
    let response: Response;
    try {
      response = await fetch(
        `/api/workspaces/${workspaceId}/study-sessions/${sessionId}/turns/stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: signal ?? null,
        },
      );
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new ApiClientError('ABORTED', 'Tutor turn cancelled.');
      }
      throw new ApiClientError('NETWORK_ERROR', 'Unable to connect to the StudySession stream.');
    }
    if (!response.ok) {
      throw new ApiClientError(
        'INTERNAL',
        `StudySession turn failed (${response.status}).`,
        response.status,
      );
    }
    if (!response.body) {
      throw new ApiClientError(
        'NETWORK_ERROR',
        'This browser cannot read the StudySession stream.',
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminal: SubmitTutorTurnResponse | null = null;
    const emit = (chunk: string): void => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (raw) {
          const value = JSON.parse(raw) as unknown;
          const envelope = z
            .discriminatedUnion('kind', [
              z.object({ kind: z.literal('event'), event: StudyTurnEventSchema }).strict(),
              z
                .object({ kind: z.literal('terminal'), result: SubmitTutorTurnResponseSchema })
                .strict(),
              z.object({ kind: z.literal('error'), message: z.string().min(1) }).strict(),
            ])
            .parse(value) as StudyTurnStreamLine;
          onLine(envelope);
          if (envelope.kind === 'terminal') terminal = envelope.result;
          if (envelope.kind === 'error') throw new ApiClientError('INTERNAL', envelope.message);
        }
        newline = buffer.indexOf('\n');
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) emit(decoder.decode(value, { stream: true }));
        if (done) break;
      }
      emit(`${decoder.decode()}\n`);
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new ApiClientError('ABORTED', 'Tutor turn cancelled.');
      }
      throw new ApiClientError('NETWORK_ERROR', 'StudySession stream was interrupted.');
    }
    if (!terminal) {
      throw new ApiClientError(
        'NETWORK_ERROR',
        'StudySession stream ended without a terminal result.',
      );
    }
    return terminal;
  },

  studySessionCommand: (
    workspaceId: string,
    sessionId: string,
    input: MixedInitiativeCommandRequest,
    signal?: AbortSignal,
  ): Promise<MixedInitiativeCommandResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-sessions/${sessionId}/commands`,
      MixedInitiativeCommandResponseSchema,
      input,
      signal,
    ),

  pauseStudySession: (
    workspaceId: string,
    sessionId: string,
    input: SessionExecutionCommandRequest,
    signal?: AbortSignal,
  ): Promise<SessionExecutionCommandResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-sessions/${sessionId}/pause`,
      SessionExecutionCommandResponseSchema,
      input,
      signal,
    ),

  resumeStudySession: (
    workspaceId: string,
    sessionId: string,
    input: SessionExecutionCommandRequest,
    signal?: AbortSignal,
  ): Promise<SessionExecutionCommandResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-sessions/${sessionId}/resume`,
      SessionExecutionCommandResponseSchema,
      input,
      signal,
    ),

  stopStudySession: (
    workspaceId: string,
    sessionId: string,
    input: SessionExecutionCommandRequest,
    signal?: AbortSignal,
  ): Promise<SessionExecutionCommandResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/study-sessions/${sessionId}/stop`,
      SessionExecutionCommandResponseSchema,
      input,
      signal,
    ),

  // --- Formal progression: evidence and reconciliation remain local authority ---

  formalProgression: (
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<FormalProgressionOverview> =>
    requestParsed(
      'GET',
      `/api/workspaces/${workspaceId}/progression`,
      FormalProgressionOverviewSchema,
      undefined,
      signal,
    ),

  reconcileProgression: (
    workspaceId: string,
    input: ReconcileProgressionRequest,
    signal?: AbortSignal,
  ): Promise<ProgressionReconciliationResponse> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/progression/reconcile`,
      ProgressionReconciliationResponseSchema,
      input,
      signal,
    ),

  qualifyReplanTrigger: (
    workspaceId: string,
    input: QualifyReplanTriggerRequest,
    signal?: AbortSignal,
  ): Promise<ReplanTrigger> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/replans/triggers`,
      z.object({ trigger: ReplanTriggerSchema }).strict(),
      input,
      signal,
    ).then((response) => response.trigger),

  proposeQualifiedReplan: (
    workspaceId: string,
    triggerId: string,
    input: ProposeQualifiedReplanRequest,
    signal?: AbortSignal,
  ) =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/replans/${triggerId}/proposal`,
      StudyPlanProposalResponseSchema,
      input,
      signal,
    ),

  recordGoalOutcome: (
    workspaceId: string,
    input: RecordGoalOutcomeRequest,
    signal?: AbortSignal,
  ): Promise<GoalOutcome> =>
    requestParsed(
      'POST',
      `/api/workspaces/${workspaceId}/goal-outcomes`,
      z.object({ outcome: GoalOutcomeSchema }).strict(),
      input,
      signal,
    ).then((response) => response.outcome),

  getWorkspaceGraph: (workspaceId: string, signal?: AbortSignal) =>
    request<WorkspaceGraphResponse>(
      'GET',
      `/api/workspaces/${workspaceId}/graph`,
      undefined,
      signal,
    ),

  generateGraph: (workspaceId: string, signal?: AbortSignal) =>
    request<GraphGenerationResponse>(
      'POST',
      `/api/workspaces/${workspaceId}/graph`,
      undefined,
      signal,
    ),

  listGraphVersions: (workspaceId: string, signal?: AbortSignal) =>
    request<{ versions: GraphVersion[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/graph/versions`,
      undefined,
      signal,
    ),

  activateGraphVersion: (workspaceId: string, versionId: string, signal?: AbortSignal) =>
    request<{ version: GraphVersion }>(
      'POST',
      `/api/workspaces/${workspaceId}/graph/versions/${versionId}/activate`,
      undefined,
      signal,
    ),

  learnerOverlay: (workspaceId: string, signal?: AbortSignal) =>
    request<{ states: ConceptLearnerState[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/overlay`,
      undefined,
      signal,
    ),

  generatePlan: (workspaceId: string, conceptId: string, signal?: AbortSignal) =>
    request<{ plan: RemediationPlan }>(
      'POST',
      `/api/workspaces/${workspaceId}/concepts/${conceptId}/plan`,
      undefined,
      signal,
    ),

  getPlan: (workspaceId: string, conceptId: string, signal?: AbortSignal) =>
    request<{ plan: RemediationPlan | null }>(
      'GET',
      `/api/workspaces/${workspaceId}/concepts/${conceptId}/plan`,
      undefined,
      signal,
    ),

  // --- Concept lesson cards (teaching enrichment) ---

  getLesson: (workspaceId: string, conceptId: string, signal?: AbortSignal) =>
    request<{ lesson: ConceptLesson | null }>(
      'GET',
      `/api/workspaces/${workspaceId}/concepts/${conceptId}/lesson`,
      undefined,
      signal,
    ),

  generateLesson: (
    workspaceId: string,
    conceptId: string,
    directive?: LessonDirective,
    signal?: AbortSignal,
  ) =>
    request<{ lesson: ConceptLesson }>(
      'POST',
      `/api/workspaces/${workspaceId}/concepts/${conceptId}/lesson`,
      directive ? { directive } : {},
      signal,
    ),

  launchPlan: (workspaceId: string, planId: string, signal?: AbortSignal) =>
    request<PlanLaunchResponse>(
      'POST',
      `/api/workspaces/${workspaceId}/plans/${planId}/launch`,
      undefined,
      signal,
    ),

  // --- Concept alignment ---

  alignmentOverview: (workspaceId: string, signal?: AbortSignal) =>
    request<AlignmentOverviewResponse>(
      'GET',
      `/api/workspaces/${workspaceId}/alignment`,
      undefined,
      signal,
    ),

  proposeAlignment: (workspaceId: string, signal?: AbortSignal) =>
    request<AlignmentProposeResponse>(
      'POST',
      `/api/workspaces/${workspaceId}/alignment/propose`,
      undefined,
      signal,
    ),

  decideAlignment: (
    workspaceId: string,
    proposalId: string,
    decision: 'accept' | 'reject' | 'keep-separate',
    body?: { canonicalName?: string },
    signal?: AbortSignal,
  ) =>
    request<AlignmentOverviewResponse>(
      'POST',
      `/api/workspaces/${workspaceId}/alignment/proposals/${proposalId}/${decision}`,
      decision === 'accept' ? (body ?? {}) : undefined,
      signal,
    ),

  renameCanonical: (
    workspaceId: string,
    canonicalId: string,
    displayName: string,
    signal?: AbortSignal,
  ) =>
    request<{ canonical: CanonicalConcept }>(
      'PATCH',
      `/api/workspaces/${workspaceId}/canonical/${canonicalId}`,
      { displayName },
      signal,
    ),

  // --- Workspace assessments, misconceptions, review, daily queue ---

  createAssessment: (
    workspaceId: string,
    input: { mode: AssessmentMode; conceptIds?: string[]; misconceptionId?: string },
    signal?: AbortSignal,
  ) =>
    request<AssessmentResponse>(
      'POST',
      `/api/workspaces/${workspaceId}/assessments`,
      input,
      signal,
    ),

  // --- Completed-quiz history (read-only) ---

  listAttempts: (workspaceId: string, signal?: AbortSignal) =>
    request<{ attempts: CompletedAttemptSummary[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/attempts`,
      undefined,
      signal,
    ),

  getAttempt: (workspaceId: string, attemptId: string, signal?: AbortSignal) =>
    request<CompletedAttemptDetail>(
      'GET',
      `/api/workspaces/${workspaceId}/attempts/${attemptId}`,
      undefined,
      signal,
    ),

  misconceptions: (workspaceId: string, status?: MisconceptionStatus, signal?: AbortSignal) =>
    request<{ misconceptions: MisconceptionRecord[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/misconceptions${status ? `?status=${status}` : ''}`,
      undefined,
      signal,
    ),

  reviewItems: (workspaceId: string, signal?: AbortSignal) =>
    request<{ items: ReviewItem[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/review`,
      undefined,
      signal,
    ),

  dailyQueue: (workspaceId: string, signal?: AbortSignal) =>
    request<{ items: DailyQueueItem[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/queue`,
      undefined,
      signal,
    ),

  // --- Bounded Hy3 Tutor ---

  listTutorRuns: (workspaceId: string, signal?: AbortSignal) =>
    request<{ runs: TutorRun[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/tutor/runs`,
      undefined,
      signal,
    ),

  getTutorRun: (workspaceId: string, runId: string, signal?: AbortSignal) =>
    request<{ run: TutorRun; events: TutorEvent[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/tutor/runs/${runId}`,
      undefined,
      signal,
    ),

  /**
   * Launch the recommended activity of a completed Tutor run. The server
   * reloads the persisted recommendation, revalidates it against current
   * state, and constructs the mode-specific assessment itself — the client
   * never assembles launch parameters.
   */
  launchTutorActivity: (workspaceId: string, runId: string, signal?: AbortSignal) =>
    request<TutorActivityLaunchResponse>(
      'POST',
      `/api/workspaces/${workspaceId}/tutor/runs/${runId}/activity`,
      undefined,
      signal,
    ),

  /**
   * Start a Tutor session and stream its NDJSON timeline. `onLine` receives
   * each parsed line as it arrives; the promise settles when the stream ends
   * (or rejects on network failure/abort). Malformed lines are skipped.
   */
  streamTutorSession: async (
    workspaceId: string,
    conceptId: string,
    onLine: (line: TutorStreamLine) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    let response: Response;
    try {
      response = await fetch(`/api/workspaces/${workspaceId}/tutor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conceptId }),
        signal: signal ?? null,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiClientError('ABORTED', '请求已取消。');
      }
      throw new ApiClientError('NETWORK_ERROR', '无法连接服务器,请确认后端已启动。');
    }
    if (!response.ok) {
      let message = `请求失败(${response.status})。`;
      try {
        const data = (await response.json()) as { error?: { message?: string } };
        if (data.error?.message) message = data.error.message;
      } catch {
        // keep default
      }
      throw new ApiClientError('INTERNAL', message, response.status);
    }
    if (!response.body) {
      throw new ApiClientError('NETWORK_ERROR', '浏览器不支持流式响应。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const emit = (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            onLine(JSON.parse(line) as TutorStreamLine);
          } catch {
            // Skip malformed lines; the persisted run remains authoritative.
          }
        }
        newline = buffer.indexOf('\n');
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) emit(decoder.decode(value, { stream: true }));
        if (done) break;
      }
      emit(decoder.decode());
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        throw new ApiClientError('ABORTED', '请求已取消。');
      }
      throw new ApiClientError('NETWORK_ERROR', '时间线流中断。');
    }
  },
};
