import type {
  AlignmentProposal,
  ApiErrorCodeValue,
  AssessmentMode,
  CanonicalConcept,
  CanonicalConceptView,
  Concept,
  ConceptLearnerState,
  DailyQueueItem,
  DocumentSummary,
  GradingResult,
  GraphEdge,
  GraphVersion,
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
  WorkspaceSummary,
} from '@hy3-clinic/shared';

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

export const api = {
  health: () => request<{ status: string }>('GET', '/api/health'),
  config: () => request<{ provider: 'fake' | 'hy3' }>('GET', '/api/config'),

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

  getMaterial: (id: string) => request<MaterialWithBlocks>('GET', `/api/materials/${id}`),

  renameMaterial: (id: string, title: string, signal?: AbortSignal) =>
    request<{ material: Material }>('PATCH', `/api/materials/${id}`, { title }, signal),

  deleteMaterial: (id: string, signal?: AbortSignal) =>
    request<void>('DELETE', `/api/materials/${id}`, undefined, signal),

  analyze: (materialId: string, signal?: AbortSignal) =>
    request<{ concepts: Concept[] }>(
      'POST',
      `/api/materials/${materialId}/analyze`,
      undefined,
      signal,
    ),

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
    request<void>(
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
