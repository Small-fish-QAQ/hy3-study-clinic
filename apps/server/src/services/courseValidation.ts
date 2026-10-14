import { AppError } from '../errors.js';

export interface PlanIssue {
  code: string;
  path: string;
  message: string;
  lessonIds?: string[];
  domainIds?: string[];
  cellIds?: string[];
  knowledgeIds?: string[];
  objectiveIds?: string[];
  /** A semantic finding only governs the exact reviewed content and provider contract. */
  reviewContextHash?: string;
}
export class CourseValidationError extends AppError {
  constructor(
    readonly findings: string[],
    readonly issues?: PlanIssue[],
  ) {
    super('GROUNDING_FAILED', '内容未通过正确性检查：' + findings.join('；'));
  }
}
export function requireValid(findings: string[]): void {
  if (findings.length) throw new CourseValidationError(findings);
}
export function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}
export const demandRank = {
  remember: 0,
  understand: 1,
  apply: 2,
  analyze: 3,
  evaluate: 4,
  design: 5,
} as const;
export const difficultyRank = { basic: 0, standard: 1, advanced: 2 } as const;
