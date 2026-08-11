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
import { createAttemptsService, type AttemptsService } from './attempts.js';
import { createMisconceptionsService, type MisconceptionsService } from './misconceptions.js';
import { createReviewService, type ReviewService } from './review.js';
import { createQueueService, type QueueService } from './queue.js';
import { createMappingService, type MappingService } from './mapping.js';
import { createLessonsService, type LessonsService } from './lessons.js';
import { createTutorService, type TutorService } from './tutor.js';
import { createSourceAuthorityService, type SourceAuthorityService } from './sourceAuthority.js';
import { createCourseCommandService, type CourseCommandService } from './courseCommands.js';
import { createMaterialRoleService, type MaterialRoleService } from './materialRoles.js';
import {
  createLearningContractService,
  type LearningContractService,
} from './learningContracts.js';
import { createCurriculumService, type CurriculumService } from './curriculum.js';
import { createStudyPlanAgentService, type StudyPlanAgentService } from './studyPlansAgent.js';
import {
  createSessionAgendaAgentService,
  type SessionAgendaAgentService,
} from './sessionAgendasAgent.js';
import { createCourseExecutionService, type CourseExecutionService } from './courseExecution.js';
import { createCourseOverviewService, type CourseOverviewService } from './courseOverview.js';
import {
  createCourseActionLaunchService,
  type CourseActionLaunchService,
} from './courseActionLaunch.js';
import {
  createFormalProgressionService,
  type FormalProgressionService,
} from './formalProgression.js';
import { createStudySessionService, type StudySessionService } from './studySessions.js';

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
  attempts: AttemptsService;
  misconceptions: MisconceptionsService;
  review: ReviewService;
  queue: QueueService;
  mapping: MappingService;
  lessons: LessonsService;
  tutor: TutorService;
  sourceAuthority: SourceAuthorityService;
  courseCommands: CourseCommandService;
  materialRoles: MaterialRoleService;
  learningContracts: LearningContractService;
  curriculum: CurriculumService;
  studyPlansAgent: StudyPlanAgentService;
  sessionAgendasAgent: SessionAgendaAgentService;
  courseExecution: CourseExecutionService;
  courseOverview: CourseOverviewService;
  courseActionLaunch: CourseActionLaunchService;
  formalProgression: FormalProgressionService;
  studySessions: StudySessionService;
}

export interface ServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  /** Model identifier recorded as graph provider metadata (hy3 only). */
  providerModel?: string | undefined;
}

export function createServices({ repos, provider, clock, providerModel }: ServiceDeps): Services {
  const sourceAuthority = createSourceAuthorityService({
    sourceAuthority: repos.sourceAuthority,
    clock,
  });
  const materials = createMaterialService({ repos, clock, sourceAuthority });
  const workspaces = createWorkspaceService({ repos, clock, materials, sourceAuthority });
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
  const attempts = createAttemptsService({ repos });
  const queue = createQueueService({ repos, clock });
  const mapping = createMappingService({ repos });
  const lessons = createLessonsService({ repos, provider, clock, providerModel });
  const tutor = createTutorService({ repos, provider, clock, assessment, providerModel });
  const courseCommands = createCourseCommandService({ repos, clock });
  const materialRoles = createMaterialRoleService({ repos, clock, commands: courseCommands });
  const learningContracts = createLearningContractService({
    repos,
    clock,
    commands: courseCommands,
  });
  const curriculum = createCurriculumService({
    repos,
    provider,
    clock,
    commands: courseCommands,
    providerModel,
    sourceAuthority,
  });
  const studyPlansAgent = createStudyPlanAgentService({
    repos,
    provider,
    clock,
    commands: courseCommands,
    providerModel,
  });
  const sessionAgendasAgent = createSessionAgendaAgentService({ repos, clock });
  const courseExecution = createCourseExecutionService({
    repos,
    clock,
    commands: courseCommands,
    agendas: sessionAgendasAgent,
  });
  const courseOverview = createCourseOverviewService({ repos, clock });
  const formalProgression = createFormalProgressionService({
    repos,
    progression: repos.formalProgression,
    commands: courseCommands,
    clock,
  });
  const courseActionLaunch = createCourseActionLaunchService({
    repos,
    clock,
    commands: courseCommands,
    assessment,
    formalProgression,
    provider,
    providerModel,
  });
  const studySessions = createStudySessionService({
    repos,
    provider,
    providerModel,
    clock,
    replanning: formalProgression,
  });
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
    attempts,
    misconceptions,
    review,
    queue,
    mapping,
    lessons,
    tutor,
    sourceAuthority,
    courseCommands,
    materialRoles,
    learningContracts,
    curriculum,
    studyPlansAgent,
    sessionAgendasAgent,
    courseExecution,
    courseOverview,
    courseActionLaunch,
    formalProgression,
    studySessions,
  };
}
