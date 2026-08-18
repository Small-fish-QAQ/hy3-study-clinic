import type { SqliteDb } from '../db/database.js';
import { createMaterialsRepo, type MaterialsRepo } from './materials.js';
import { createMaterialRevisionsRepo, type MaterialRevisionsRepo } from './materialRevisions.js';
import { createSourceAuthorityRepo, type SourceAuthorityRepo } from './sourceAuthority.js';
import { createWorkspacesRepo, type WorkspacesRepo } from './workspaces.js';
import { createGraphRepo, type GraphRepo } from './graph.js';
import { createLessonsRepo, type LessonsRepo } from './lessons.js';
import { createTeachingBriefsRepo, type TeachingBriefsRepo } from './teachingBriefs.js';
import { createLessonExecutionRepo, type LessonExecutionRepo } from './lessonExecution.js';
import { createAlignmentRepo, type AlignmentRepo } from './alignment.js';
import { createBlueprintsRepo, type BlueprintsRepo } from './blueprints.js';
import { createMisconceptionsRepo, type MisconceptionsRepo } from './misconceptions.js';
import { createReviewRepo, type ReviewRepo } from './review.js';
import { createTutorRepo, type TutorRepo } from './tutor.js';
import { createOperationsRepo, type OperationsRepo } from './operations.js';
import { createTelemetryRepo, type TelemetryRepo } from './telemetry.js';
import { createMaterialRolesRepo, type MaterialRolesRepo } from './materialRoles.js';
import { createLearningContractsRepo, type LearningContractsRepo } from './learningContracts.js';
import { createCurriculaRepo, type CurriculaRepo } from './curricula.js';
import { createStudyPlansRepo, type StudyPlansRepo } from './studyPlans.js';
import { createSessionAgendasRepo, type SessionAgendasRepo } from './sessionAgendas.js';
import { createCoverageRisksRepo, type CoverageRisksRepo } from './coverageRisks.js';
import { createCourseExecutionRepo, type CourseExecutionRepo } from './courseExecution.js';
import { createFormalProgressionRepo, type FormalProgressionRepo } from './formalProgression.js';
import { createStudySessionsRepo, type StudySessionsRepo } from './studySessions.js';
import {
  createQuizzesRepo,
  createSubmissionsRepo,
  type QuizzesRepo,
  type SubmissionsRepo,
} from './quizzes.js';
import {
  createMasteryRepo,
  createMistakesRepo,
  type MasteryRepo,
  type MistakesRepo,
} from './mistakes.js';

export interface Repositories {
  workspaces: WorkspacesRepo;
  materials: MaterialsRepo;
  materialRevisions: MaterialRevisionsRepo;
  sourceAuthority: SourceAuthorityRepo;
  graph: GraphRepo;
  alignment: AlignmentRepo;
  blueprints: BlueprintsRepo;
  misconceptions: MisconceptionsRepo;
  review: ReviewRepo;
  tutor: TutorRepo;
  operations: OperationsRepo;
  telemetry: TelemetryRepo;
  materialRoles: MaterialRolesRepo;
  learningContracts: LearningContractsRepo;
  curricula: CurriculaRepo;
  studyPlans: StudyPlansRepo;
  sessionAgendas: SessionAgendasRepo;
  coverageRisks: CoverageRisksRepo;
  courseExecution: CourseExecutionRepo;
  formalProgression: FormalProgressionRepo;
  studySessions: StudySessionsRepo;
  quizzes: QuizzesRepo;
  submissions: SubmissionsRepo;
  mistakes: MistakesRepo;
  mastery: MasteryRepo;
  lessons: LessonsRepo;
  teachingBriefs: TeachingBriefsRepo;
  lessonExecution: LessonExecutionRepo;
  /**
   * Run `fn` inside ONE database transaction spanning any repository writes
   * it performs. better-sqlite3 transactions are synchronous, so the block
   * executes atomically relative to every other statement on this
   * connection — a throw rolls back every write. Never run provider/network
   * work inside `fn`.
   */
  transaction<T>(fn: () => T): T;
}

export function createRepositories(db: SqliteDb): Repositories {
  return {
    workspaces: createWorkspacesRepo(db),
    materials: createMaterialsRepo(db),
    materialRevisions: createMaterialRevisionsRepo(db),
    sourceAuthority: createSourceAuthorityRepo(db),
    graph: createGraphRepo(db),
    alignment: createAlignmentRepo(db),
    blueprints: createBlueprintsRepo(db),
    misconceptions: createMisconceptionsRepo(db),
    review: createReviewRepo(db),
    tutor: createTutorRepo(db),
    operations: createOperationsRepo(db),
    telemetry: createTelemetryRepo(db),
    materialRoles: createMaterialRolesRepo(db),
    learningContracts: createLearningContractsRepo(db),
    curricula: createCurriculaRepo(db),
    studyPlans: createStudyPlansRepo(db),
    sessionAgendas: createSessionAgendasRepo(db),
    coverageRisks: createCoverageRisksRepo(db),
    courseExecution: createCourseExecutionRepo(db),
    formalProgression: createFormalProgressionRepo(db),
    studySessions: createStudySessionsRepo(db),
    quizzes: createQuizzesRepo(db),
    submissions: createSubmissionsRepo(db),
    mistakes: createMistakesRepo(db),
    mastery: createMasteryRepo(db),
    lessons: createLessonsRepo(db),
    teachingBriefs: createTeachingBriefsRepo(db),
    lessonExecution: createLessonExecutionRepo(db),
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}
