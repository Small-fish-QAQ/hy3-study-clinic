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
import { createAlignmentService, type AlignmentService } from './alignment.js';
import { createAssessmentService, type AssessmentService } from './assessment.js';
import { createMisconceptionsService, type MisconceptionsService } from './misconceptions.js';
import { createReviewService, type ReviewService } from './review.js';
import { createQueueService, type QueueService } from './queue.js';
import { createTutorService, type TutorService } from './tutor.js';

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
  alignment: AlignmentService;
  assessment: AssessmentService;
  misconceptions: MisconceptionsService;
  review: ReviewService;
  queue: QueueService;
  tutor: TutorService;
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
  const misconceptions = createMisconceptionsService({ repos, provider, clock });
  const review = createReviewService({ repos, clock });
  const grading = createGradingService({ repos, provider, clock, misconceptions, review });
  const remediation = createRemediationService({ repos, provider, clock });
  const mistakes = createMistakesService({ repos });
  const graph = createGraphService({ repos, provider, clock, providerModel });
  const planner = createPlannerService({ repos, provider, clock, quizzes, remediation });
  const alignment = createAlignmentService({ repos, provider, clock });
  const assessment = createAssessmentService({ repos, provider, clock, misconceptions });
  const queue = createQueueService({ repos, clock });
  const tutor = createTutorService({ repos, provider, clock, providerModel });
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
    alignment,
    assessment,
    misconceptions,
    review,
    queue,
    tutor,
  };
}
