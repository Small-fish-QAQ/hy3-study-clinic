import type { LlmProvider } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { createMaterialService, type MaterialService } from './materials.js';
import { createAnalysisService, type AnalysisService } from './analysis.js';
import { createQuizService, type QuizService } from './quizzes.js';
import { createGradingService, type GradingService } from './grading.js';
import { createRemediationService, type RemediationService } from './remediation.js';
import { createMistakesService, type MistakesService } from './mistakes.js';

export interface Services {
  materials: MaterialService;
  analysis: AnalysisService;
  quizzes: QuizService;
  grading: GradingService;
  remediation: RemediationService;
  mistakes: MistakesService;
}

export interface ServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
}

export function createServices({ repos, provider, clock }: ServiceDeps): Services {
  const materials = createMaterialService({ repos, clock });
  const analysis = createAnalysisService({ repos, provider, clock });
  const quizzes = createQuizService({ repos, provider, clock, analysis });
  const grading = createGradingService({ repos, provider, clock });
  const remediation = createRemediationService({ repos, provider, clock });
  const mistakes = createMistakesService({ repos });
  return { materials, analysis, quizzes, grading, remediation, mistakes };
}
