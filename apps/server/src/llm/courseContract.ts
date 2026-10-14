import { z } from 'zod';
import type { CourseRubricCriterionSchema } from '@hy3-clinic/shared';
import {
  CourseKnowledgeSchema,
  CourseDispositionSchema,
  CourseLessonSchema,
  AssessmentDomainSchema,
  AssessmentCellSchema,
  LessonAuthorSchema,
  CourseQuestionSchema,
  CourseSourceSpanSchema,
  QuestionCoverageSchema,
  type CourseKnowledge,
  type CourseKnowledgeInventory,
  type CoursePlan,
  type CoursePreferences,
  type CourseLesson,
  type CourseQuestion,
  type CourseAssessmentBlueprint,
  type LessonAuthor,
  type CourseAnswer,
  type CourseQuiz,
  type CourseTutorAnchor,
} from '@hy3-clinic/shared';
import type { ProviderCallOptions } from './provider.js';

export interface SourcePacketBlock {
  id: string;
  revisionId: string;
  text: string;
  headingPath: string[];
  start: number;
  end: number;
}
export interface KnowledgeInput {
  blocks: SourcePacketBlock[];
  /** Read-only full-source context for a located cross-packet correction. */
  referenceText?: string;
  revision?: { draft: unknown; findings: string[]; localRefs?: string[] };
}
export const KnowledgeOutputSchema = z
  .object({
    knowledge: z.array(
      CourseKnowledgeSchema.omit({ id: true }).extend({ localRef: z.string().min(1) }),
    ),
    dispositions: z.array(CourseDispositionSchema).min(1),
  })
  .strict();
export type KnowledgeOutput = z.infer<typeof KnowledgeOutputSchema>;
export const PlanOutputSchema = z
  .object({
    title: z.string().min(1),
    modules: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) }).strict()).min(1),
    lessons: z.array(CourseLessonSchema).min(1),
    assessmentDesign: z
      .object({
        domains: z.array(AssessmentDomainSchema).min(1),
        cells: z.array(AssessmentCellSchema).min(1),
        requiredCellIds: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();
export type PlanOutput = z.infer<typeof PlanOutputSchema>;
// Local revisions may contain only blueprint objects. They do not author a new course.
export const PlanRevisionOutputSchema = z
  .object({
    modules: PlanOutputSchema.shape.modules.element.array(),
    lessons: CourseLessonSchema.array(),
    assessmentDesign: z
      .object({
        domains: AssessmentDomainSchema.array(),
        cells: AssessmentCellSchema.array(),
        requiredCellIds: z.string().min(1).array(),
      })
      .strict(),
  })
  .strict();
export type PlanRevisionOutput = z.infer<typeof PlanRevisionOutputSchema>;
export interface PlanRevisionInput {
  draft: PlanRevisionOutput;
  findings: {
    code: string;
    path: string;
    message: string;
    lessonIds?: string[];
    domainIds?: string[];
    cellIds?: string[];
    knowledgeIds?: string[];
    objectiveIds?: string[];
  }[];
  knowledge: CourseKnowledge[];
  references: {
    modules: PlanOutput['modules'];
    lessons: Pick<CourseLesson, 'id' | 'moduleId' | 'knowledgeIds' | 'objectives'>[];
    /** Read-only global ownership prevents a local author from reusing a healthy ID. */
    assessmentDesign?: {
      domains: Pick<
        PlanOutput['assessmentDesign']['domains'][number],
        'id' | 'knowledgeIds' | 'coreObjectiveIds'
      >[];
      cells: Pick<
        PlanOutput['assessmentDesign']['cells'][number],
        'id' | 'domainId' | 'objectiveIds' | 'demand'
      >[];
      representativeSetIds: string[];
      requiredCellIds: string[];
    };
  };
  preferences?: CoursePreferences;
}
export const PlanBoundarySchema = z
  .object({
    modules: z.array(
      z
        .object({
          id: z.string().min(1),
          title: z.string().min(1),
          knowledgeIds: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    links: z.array(
      z
        .object({ lessonId: z.string().min(1), prerequisiteLessonIds: z.array(z.string().min(1)) })
        .strict(),
    ),
  })
  .strict();
export type PlanBoundary = z.infer<typeof PlanBoundarySchema>;
// Joining preserves the authored modules and knowledge allocation. Only links are consumed.
export const PlanJoinSchema = z.object({ links: PlanBoundarySchema.shape.links });
export type CoursePlanningOutput = PlanOutput | PlanBoundary;
export interface PlanInput {
  preferences?: CoursePreferences;
  title: string;
  knowledge: CourseKnowledge[];
  mode: 'complete' | 'outline' | 'subplan' | 'join';
  moduleBoundary?: string;
  priorPlans?: PlanOutput[];
  revision?: { draft: PlanOutput; findings: string[] };
}
export interface KnowledgeReviewInput {
  blocks: SourcePacketBlock[];
  knowledge: CourseKnowledge[];
  lessons?: CourseLesson[];
  findings: string[];
}
export const ScopeIssueSchema = z
  .object({
    // Older stored reviews did not distinguish the object to repair.
    target: z.enum(['knowledge', 'lesson']).optional(),
    code: z.enum([
      'false_statement',
      'missing_condition',
      'missing_content',
      'unsupported_source',
      'objective_mismatch',
      'unresolved_uncertainty',
    ]),
    knowledgeIds: z.array(z.string().min(1)).min(1),
    lessonIds: z.array(z.string().min(1)),
    message: z.string().min(1),
  })
  .strict();
export const ScopeReviewSchema = z
  .object({
    accepted: z.boolean(),
    findings: z.array(z.string().min(1)),
    checkedKnowledgeIds: z.array(z.string().min(1)),
    issues: ScopeIssueSchema.array().optional(),
  })
  .strict();
export const ScopeReviewWireSchema = z
  .object({
    issues: ScopeIssueSchema.extend({ target: z.enum(['knowledge', 'lesson']) }).array(),
    checkedKnowledgeIds: z.array(z.string().min(1)),
  })
  .strict();
export interface LessonInput {
  interactionPolicy?: 'optional-reflection-v1';
  preferences?: CoursePreferences;
  lesson: CourseLesson;
  knowledge: CourseKnowledge[];
  sources: SourcePacketBlock[];
  revision?: { segmentIds: string[]; draft: LessonAuthor; findings: string[] };
}
export interface LessonScope {
  id: string;
  hash: string;
  segmentIds: string[];
  knowledgeIds: string[];
  reasons: string[];
}
export interface LessonVerificationInput {
  scopes: LessonScope[];
  segments: LessonAuthor['segments'];
  knowledge: CourseKnowledge[];
  sources: SourcePacketBlock[];
}
export const LessonVerificationSchema = z
  .object({
    results: z.array(
      z
        .object({
          scopeId: z.string().min(1),
          scopeHash: z.string().min(1),
          accepted: z.boolean(),
          findings: z.array(z.string().min(1)),
          checkedKnowledgeIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();
export interface QuestionsInput {
  teachingIntent?: {
    lessons: Pick<CourseLesson, 'id' | 'title' | 'selectedDepth' | 'objectives'>[];
    diagnostics: { knowledgeId: string; result: string; feedback: string }[];
  };
  purpose: CourseQuiz['purpose'];
  slots: { id: string; knowledgeIds: string[]; cellIds: string[] }[];
  knowledge: CourseKnowledge[];
  sources: SourcePacketBlock[];
  learnerVisibleContext: string[];
  blueprint: CourseAssessmentBlueprint | null;
  previousQuestions: Pick<CourseQuestion, 'prompt' | 'options'>[];
  revision?: { slotId: string; previous: unknown; findings: string[] };
  previousRejections?: { slotId: string; previous: unknown; findings: string[] }[];
}
export const QuestionsOutputSchema = z.object({ questions: z.array(z.unknown()).min(1) }).strict();
export const QuestionsOutputGuideSchema = z
  .object({ questions: z.array(CourseQuestionSchema).min(1) })
  .strict();
export interface BlindQuestion {
  id: string;
  type: CourseQuestion['type'];
  prompt: string;
  options: CourseQuestion['options'];
}
export interface SolveInput {
  question: BlindQuestion;
  learnerVisibleContext: string[];
  referenceSourcesForFactCheck: SourcePacketBlock[];
  requestedKnowledge: CourseKnowledge[];
  expectedCells: CourseAssessmentBlueprint['cells'];
  expectedObjectives?: NonNullable<CourseAssessmentBlueprint['objectiveRequirements']>;
  previousQuestions: Pick<CourseQuestion, 'prompt' | 'options'>[];
}
export const SolutionSchema = z
  .object({
    solvable: z.boolean(),
    answer: z.array(z.string()).min(1),
    explanation: z.string().min(1),
    missingConditions: z.array(z.string()),
    ambiguities: z.array(z.string()),
    sourceSupported: z.boolean(),
    uncertain: z.boolean(),
    exposureCheck: z.object({ novel: z.boolean(), reason: z.string().min(1) }).strict(),
    assessedKnowledgeIds: z.array(z.string()),
    assessedObjectiveIds: z.array(z.string()).optional(),
    coverage: z.array(QuestionCoverageSchema),
  })
  .strict();
export type QuestionSolution = z.infer<typeof SolutionSchema>;
/** Without requested cells there is no Formal coverage to author or validate. */
export function solutionSchemaFor(
  input: Pick<SolveInput, 'expectedCells'>,
): z.ZodType<QuestionSolution, z.ZodTypeDef, unknown> {
  return input.expectedCells.length
    ? SolutionSchema
    : z.preprocess((candidate) => normalizeSolutionCoverage(input, candidate), SolutionSchema);
}
export function normalizeSolutionCoverage(
  input: Pick<SolveInput, 'expectedCells'>,
  candidate: unknown,
) {
  return !input.expectedCells.length &&
    candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate)
    ? { ...candidate, coverage: [] }
    : candidate;
}
export interface RubricReviewInput extends SolveInput {
  /** The reference to publish, supplied by the independent solution (legacy field name). */
  authorAnswer: string[];
  rubric: z.infer<typeof CourseRubricCriterionSchema>[];
  independentSolution: QuestionSolution;
}
export const RubricReviewSchema = z
  .object({
    accepted: z.boolean(),
    uncertain: z.boolean(),
    findings: z.array(z.string()),
    criteria: z.array(
      z
        .object({
          criterionId: z.string().min(1),
          supported: z.boolean(),
          requiredByQuestion: z.boolean(),
          alternativeChecks: z.array(
            z
              .object({
                text: z.string().min(1),
                equivalent: z.boolean(),
                reason: z.string().min(1),
              })
              .strict(),
          ),
          assessedKnowledgeIds: z.array(z.string()),
        })
        .strict(),
    ),
    coverage: z.array(QuestionCoverageSchema),
  })
  .strict();
export interface RepairRoundInput {
  knowledge: CourseKnowledge[];
  sources: SourcePacketBlock[];
  originalQuestions: CourseQuestion[];
  responses: CourseAnswer[];
  feedback: string[];
  slotId: string;
}
export const RepairRoundOutputSchema = z
  .object({
    explanation: z.string().min(1),
    sourceRefs: z.array(CourseSourceSpanSchema),
    questions: z.array(CourseQuestionSchema).min(1),
    teaching: LessonAuthorSchema,
  })
  .strict();
export interface ShortAnswerInput {
  question: BlindQuestion;
  response: string;
  answer: string[];
  rubric: CourseQuestion['rubric'];
  sources: SourcePacketBlock[];
  revision?: { previous: unknown; findings: string[] };
}
export const CourseShortGradeSchema = z
  .object({
    criteria: z.array(
      z
        .object({ criterionId: z.string().min(1), met: z.boolean(), reason: z.string().min(1) })
        .strict(),
    ),
    feedback: z.string().min(1),
    confidence: z.number().min(0).max(1),
    uncertain: z.boolean(),
    evidenceFlags: z.array(z.string()),
  })
  .strict();
export interface CourseTutorInput {
  lesson: LessonAuthor;
  question: string;
  anchor?: CourseTutorAnchor;
  anchorContext?: { segmentId: string; text: string }[];
  recentTurns: { question: string; text: string }[];
  sources: SourcePacketBlock[];
}
export const CourseTutorOutputSchema = z
  .object({
    text: z.string().min(1),
    sourceRefs: z.array(CourseSourceSpanSchema),
    includesExtension: z.boolean(),
  })
  .strict();

export interface CourseProvider {
  /** Uses the same input/output estimates as the HTTP request preflight. */
  knowledgePacketFits?(blocks: SourcePacketBlock[], singleUnit?: boolean): boolean;
  planningPacketFits?(input: PlanInput, singleUnit?: boolean): boolean;
  readonly name: 'fake' | 'hy3' | 'moma' | 'compatible';
  readonly model?: string;
  readonly endpointIdentity?: string;
  readonly runtimeIdentity?: string;
  /** Keep cache identity scoped to the method whose request profile changed. */
  runtimeIdentityFor?(method: string): string;
  readonly outputCap?: number;
  readonly contextCap?: number;
  readonly longTaskTimeoutMs?: number;
  extractCourseKnowledge(
    input: KnowledgeInput,
    options?: ProviderCallOptions,
  ): Promise<KnowledgeOutput>;
  generateCoursePlan(
    input: PlanInput,
    options?: ProviderCallOptions,
  ): Promise<CoursePlanningOutput>;
  reviseCoursePlan(
    input: PlanRevisionInput,
    options?: ProviderCallOptions,
  ): Promise<PlanRevisionOutput>;
  reviewKnowledgeScope(
    input: KnowledgeReviewInput,
    options?: ProviderCallOptions,
  ): Promise<z.infer<typeof ScopeReviewSchema>>;
  generateLesson(input: LessonInput, options?: ProviderCallOptions): Promise<LessonAuthor>;
  verifyLessonParts(
    input: LessonVerificationInput,
    options?: ProviderCallOptions,
  ): Promise<z.infer<typeof LessonVerificationSchema>>;
  generateQuestions(
    input: QuestionsInput,
    options?: ProviderCallOptions,
  ): Promise<z.infer<typeof QuestionsOutputSchema>>;
  solveQuestion(input: SolveInput, options?: ProviderCallOptions): Promise<QuestionSolution>;
  reviewQuestionRubric(
    input: RubricReviewInput,
    options?: ProviderCallOptions,
  ): Promise<z.infer<typeof RubricReviewSchema>>;
  generateRepairRound(
    input: RepairRoundInput,
    options?: ProviderCallOptions,
  ): Promise<z.infer<typeof RepairRoundOutputSchema>>;
  gradeShortAnswer(
    input: ShortAnswerInput,
    options?: ProviderCallOptions,
  ): Promise<z.infer<typeof CourseShortGradeSchema>>;
  respondToTutorTurn(
    input: CourseTutorInput,
    options?: ProviderCallOptions,
  ): Promise<z.infer<typeof CourseTutorOutputSchema>>;
  testConnection(options?: ProviderCallOptions): Promise<void>;
}
export interface AcceptedKnowledgeContext {
  inventory: CourseKnowledgeInventory;
  plan: CoursePlan;
}
export const COURSE_OUTPUT_SCHEMAS = {
  extractCourseKnowledge: KnowledgeOutputSchema,
  generateCoursePlan: PlanOutputSchema,
  reviseCoursePlan: PlanRevisionOutputSchema,
  reviewKnowledgeScope: ScopeReviewSchema,
  generateLesson: LessonAuthorSchema,
  verifyLessonParts: LessonVerificationSchema,
  generateQuestions: QuestionsOutputSchema,
  solveQuestion: SolutionSchema,
  reviewQuestionRubric: RubricReviewSchema,
  generateRepairRound: RepairRoundOutputSchema,
  gradeShortAnswer: CourseShortGradeSchema,
  respondToTutorTurn: CourseTutorOutputSchema,
};
