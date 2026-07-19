import type { LlmProvider } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { createMaterialService, type MaterialService } from './materials.js';
import { createWorkspaceService, type WorkspaceService } from './workspaces.js';
import { createAnalysisService, type AnalysisService } from './analysis.js';
import { createQuizService, type QuizService } from './quizzes.js';
import { createGradingService, type GradingService } from './grading.js';
import { createRemediationService, type RemediationService } from './remediation.js';
import { createMistakesService, type MistakesService } from './mistakes.js';
import { createGraphService, type GraphService } from './graph.js';
import { createPlannerService, type PlannerService } from './planner.js';

export interface Services {
  materials: MaterialService;
  workspaces: WorkspaceService;
  analysis: AnalysisService;
  quizzes: QuizService;
  grading: GradingService;
  remediation: RemediationService;
  mistakes: MistakesService;
  graph: GraphService;
  planner: PlannerService;
}

export interface ServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  /** Model identifier recorded as graph provider metadata (hy3 only). */
  providerModel?: string | undefined;
}

export function createServices({ repos, provider, clock, providerModel }: ServiceDeps): Services {
  const materials = createMaterialService({ repos, clock });
  const workspaces = createWorkspaceService({ repos, clock, materials });
  const analysis = createAnalysisService({ repos, provider, clock });
  const quizzes = createQuizService({ repos, provider, clock, analysis });
  const grading = createGradingService({ repos, provider, clock });
  const remediation = createRemediationService({ repos, provider, clock });
  const mistakes = createMistakesService({ repos });
  const graph = createGraphService({ repos, provider, clock, providerModel });
  const planner = createPlannerService({ repos, provider, clock, quizzes, remediation });
  return {
    materials,
    workspaces,
    analysis,
    quizzes,
    grading,
    remediation,
    mistakes,
    graph,
    planner,
  };
}
