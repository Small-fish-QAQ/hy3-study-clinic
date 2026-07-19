import type {
  ApiErrorCodeValue,
  Concept,
  ConceptLearnerState,
  DocumentSummary,
  GradingResult,
  GraphEdge,
  GraphVersion,
  Material,
  MasteryState,
  MistakeRecord,
  PublicQuiz,
  Question,
  QuizConfig,
  RemediationPlan,
  SourceBlock,
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
  questions: Question[];
}

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
    input: { content: string; title?: string; filename?: string },
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
};
