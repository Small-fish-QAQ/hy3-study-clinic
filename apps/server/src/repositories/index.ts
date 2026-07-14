import type { SqliteDb } from '../db/database.js';
import { createMaterialsRepo, type MaterialsRepo } from './materials.js';
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
  materials: MaterialsRepo;
  quizzes: QuizzesRepo;
  submissions: SubmissionsRepo;
  mistakes: MistakesRepo;
  mastery: MasteryRepo;
}

export function createRepositories(db: SqliteDb): Repositories {
  return {
    materials: createMaterialsRepo(db),
    quizzes: createQuizzesRepo(db),
    submissions: createSubmissionsRepo(db),
    mistakes: createMistakesRepo(db),
    mastery: createMasteryRepo(db),
  };
}
