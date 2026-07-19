import type { SqliteDb } from '../db/database.js';
import { createMaterialsRepo, type MaterialsRepo } from './materials.js';
import { createWorkspacesRepo, type WorkspacesRepo } from './workspaces.js';
import { createGraphRepo, type GraphRepo } from './graph.js';
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
  graph: GraphRepo;
  quizzes: QuizzesRepo;
  submissions: SubmissionsRepo;
  mistakes: MistakesRepo;
  mastery: MasteryRepo;
}

export function createRepositories(db: SqliteDb): Repositories {
  return {
    workspaces: createWorkspacesRepo(db),
    materials: createMaterialsRepo(db),
    graph: createGraphRepo(db),
    quizzes: createQuizzesRepo(db),
    submissions: createSubmissionsRepo(db),
    mistakes: createMistakesRepo(db),
    mastery: createMasteryRepo(db),
  };
}
