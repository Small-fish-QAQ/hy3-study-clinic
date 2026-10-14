import { z } from 'zod';

export const COURSE_POLICY = 'study-clinic-v2.1';
const Id = z.string().trim().min(1).max(256);
const Text = z.string().trim().min(1);
export const LessonDepthSchema = z.enum(['introductory', 'standard', 'proficient', 'advanced']);
export const CoursePreferencesSchema = z
  .object({ desiredDepth: LessonDepthSchema, focusRequest: z.string().trim() })
  .strict();
export type CoursePreferences = z.infer<typeof CoursePreferencesSchema>;
export const CourseTutorAnchorSchema = z
  .object({ lessonVersionId: Id, segmentIds: z.array(Id).min(1), selectedText: Text.max(1800) })
  .strict();
export type CourseTutorAnchor = z.infer<typeof CourseTutorAnchorSchema>;
export const LessonReflectionSchema = z
  .object({
    lessonVersionId: Id,
    segmentId: Id,
    status: z.enum(['open', 'deferred', 'skipped', 'answered']),
    response: z.string().max(20_000),
    version: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type LessonReflection = z.infer<typeof LessonReflectionSchema>;
export const CoursePreparationProgressSchema = z
  .object({
    phase: z.enum(['knowledge', 'planning', 'validation', 'ready']),
    label: Text,
    completedSourceBlocks: z.number().int().nonnegative(),
    totalSourceBlocks: z.number().int().nonnegative(),
    knowledgeCount: z.number().int().nonnegative(),
    lessonCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CoursePreparationProgress = z.infer<typeof CoursePreparationProgressSchema>;
export const DemandSchema = z.enum([
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'design',
]);
export const CourseSourceSpanSchema = z
  .object({
    revisionId: Id,
    blockId: Id,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
export const CourseKnowledgeSchema = z
  .object({
    id: Id,
    title: Text,
    statement: Text,
    kind: z.enum(['concept', 'principle', 'procedure', 'condition', 'exception']),
    origin: z.enum(['textbook', 'extension']),
    sourceSpans: z.array(CourseSourceSpanSchema),
    prerequisiteKnowledgeIds: z.array(Id),
    relatedKnowledgeIds: z.array(Id),
    uncertaintyCodes: z.array(Id),
  })
  .strict();
export const CourseDispositionSchema = z
  .object({
    span: CourseSourceSpanSchema,
    knowledgeIds: z.array(Id),
    exclusion: z
      .object({
        kind: z.enum(['navigation', 'frontmatter', 'duplicate']),
        reason: Text,
        duplicateOf: CourseSourceSpanSchema.optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const CourseKnowledgeInventorySchema = z
  .object({
    id: Id,
    workspaceId: Id,
    sourceScopeHash: Id,
    policyVersion: z.literal(COURSE_POLICY),
    knowledge: z.array(CourseKnowledgeSchema).min(1),
    dispositions: z.array(CourseDispositionSchema).min(1),
  })
  .strict();
export const CourseObjectiveSchema = z
  .object({ id: Id, title: Text, knowledgeIds: z.array(Id).min(1), demand: DemandSchema })
  .strict();
export const CourseLessonSchema = z
  .object({
    id: Id,
    moduleId: Id,
    title: Text,
    summary: Text,
    knowledgeIds: z.array(Id).min(1),
    objectives: z.array(CourseObjectiveSchema).min(1),
    prerequisiteLessonIds: z.array(Id),
    recommendedDepth: LessonDepthSchema,
    selectedDepth: LessonDepthSchema,
    estimatedMinutes: z.number().finite().positive(),
  })
  .strict();
export const AssessmentDomainSchema = z
  .object({
    id: Id,
    title: Text,
    knowledgeIds: z.array(Id).min(1),
    coreObjectiveIds: z.array(Id),
    required: z.boolean(),
    rationale: Text,
  })
  .strict();
export const AssessmentCellSchema = z
  .object({
    id: Id,
    domainId: Id,
    objectiveIds: z.array(Id).min(1),
    demand: DemandSchema,
    difficultyBand: z.enum(['basic', 'standard', 'advanced']),
    mandatoryKnowledgeIds: z.array(Id),
    representativeSets: z.array(
      z.object({ id: Id, candidateKnowledgeIds: z.array(Id).min(1) }).strict(),
    ),
    weight: z.number().finite().positive(),
    rationale: Text,
  })
  .strict();
export const CourseAssessmentBlueprintSchema = z
  .object({
    id: Id,
    curriculumId: Id,
    sourceScopeHash: Id,
    policyVersion: z.literal(COURSE_POLICY),
    passThreshold: z.literal(0.6),
    domains: z.array(AssessmentDomainSchema).min(1),
    cells: z.array(AssessmentCellSchema).min(1),
    requiredCellIds: z.array(Id).min(1),
    // New unit papers freeze the actual teaching targets, rather than inheriting
    // the coarser course-wide sampling decision. Existing papers stay unchanged.
    objectiveRequirements: z.array(CourseObjectiveSchema).min(1).optional(),
  })
  .strict();
export const CoursePlanSchema = z
  .object({
    formatVersion: z.literal(2),
    id: Id,
    workspaceId: Id,
    inventoryId: Id,
    planningPolicyVersion: z.literal(COURSE_POLICY),
    title: Text,
    modules: z.array(z.object({ id: Id, title: Text }).strict()).min(1),
    lessons: z.array(CourseLessonSchema).min(1),
    teachingRequiredKnowledgeIds: z.array(Id).min(1),
    assessmentBlueprint: CourseAssessmentBlueprintSchema,
    version: z.number().int().positive(),
    status: z.enum(['draft', 'accepted', 'superseded']),
    warnings: z.array(Text),
    preferences: CoursePreferencesSchema.optional(),
  })
  .strict();

export const CourseSegmentSchema = z
  .object({
    id: Id,
    kind: z.enum(['explanation', 'worked_example', 'calculation', 'proof', 'optional_prompt']),
    text: Text,
    origin: z.enum(['textbook', 'extension']),
    sourceRefs: z.array(CourseSourceSpanSchema),
    uncertaintyCodes: z.array(Id),
  })
  .strict();
export const TeachingCoverageSchema = z
  .object({ knowledgeId: Id, objectiveIds: z.array(Id).min(1), segmentId: Id, teachingQuote: Text })
  .strict();
export const LessonAuthorSchema = z
  .object({
    title: Text,
    segments: z.array(CourseSegmentSchema).min(1),
    teachingCoverage: z.array(TeachingCoverageSchema).min(1),
  })
  .strict();
export const LessonDeliveryCheckSchema = z
  .object({
    policyVersion: z.literal(COURSE_POLICY),
    requiredKnowledgeHash: Id,
    anchors: z
      .array(
        z
          .object({
            knowledgeId: Id,
            objectiveIds: z.array(Id),
            segmentId: Id,
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
            segmentHash: Id,
          })
          .strict(),
      )
      .min(1),
    localChecksHash: Id,
    targetedReceipts: z.array(
      z
        .object({ scopeHash: Id, callId: Id, segmentIds: z.array(Id), knowledgeIds: z.array(Id) })
        .strict(),
    ),
  })
  .strict();
export const CourseLessonContentSchema = LessonAuthorSchema.extend({
  id: Id,
  workspaceId: Id,
  curriculumId: Id,
  lessonId: Id,
  semanticKey: Id,
  version: z.number().int().positive(),
  sourceScopeHash: Id,
  policyVersion: z.literal(COURSE_POLICY),
  deliveryCheck: LessonDeliveryCheckSchema,
}).strict();

export const CourseRubricCriterionSchema = z
  .object({
    id: Id,
    description: Text,
    knowledgeIds: z.array(Id).min(1),
    required: z.boolean(),
    weight: z.number().finite().positive(),
    acceptableAlternatives: z.array(Text),
  })
  .strict();
export const QuestionCoverageSchema = z
  .object({
    cellId: Id,
    criterionIds: z.array(Id).min(1),
    assessedKnowledgeIds: z.array(Id).min(1),
    representativeSetIds: z.array(Id),
    demand: DemandSchema,
    objectiveIds: z.array(Id).optional(),
  })
  .strict();
export const CourseQuestionSchema = z
  .object({
    id: Id,
    slotId: Id,
    type: z.enum(['single_choice', 'multiple_choice', 'short_answer']),
    prompt: Text,
    options: z.array(z.object({ id: Id, text: Text }).strict()),
    answer: z.array(Text).min(1),
    explanation: Text,
    rubric: z.array(CourseRubricCriterionSchema),
    knowledgeIds: z.array(Id).min(1),
    sourceRefs: z.array(CourseSourceSpanSchema),
    origin: z.enum(['textbook', 'extension']),
    difficultyBand: z.enum(['basic', 'standard', 'advanced']),
    demand: DemandSchema,
    coverage: z.array(QuestionCoverageSchema),
  })
  .strict();
export const CourseQuestionAdmissionSchema = z
  .object({
    policyVersion: z.literal(COURSE_POLICY),
    questionHash: Id,
    publicSurfaceHash: Id,
    privateAnswerHash: Id,
    rubricHash: Id,
    sourceScopeHash: Id,
    demandHash: Id,
    callIds: z.array(Id),
    verification: z.enum(['blind_solution', 'local_proof']),
    coverage: z.array(QuestionCoverageSchema),
    verifiedExplanation: Text,
  })
  .strict();
export const AdmittedCourseQuestionSchema = CourseQuestionSchema.extend({
  admission: CourseQuestionAdmissionSchema,
}).strict();
export const CoursePublicQuestionSchema = CourseQuestionSchema.omit({
  answer: true,
  explanation: true,
  rubric: true,
  coverage: true,
  sourceRefs: true,
});
export const CourseQuizSchema = z
  .object({
    id: Id,
    workspaceId: Id,
    curriculumId: Id,
    purpose: z.enum(['practice', 'retest', 'explicit_review', 'formal']),
    requestId: Id,
    lessonVersionId: Id.nullable(),
    assessmentScope: z
      .object({
        kind: z.enum(['module', 'course']),
        moduleId: Id.optional(),
        title: Text,
        lessonIds: z.array(Id).min(1),
        knowledgeIds: z.array(Id).min(1),
      })
      .strict()
      .optional(),
    version: z.number().int().positive(),
    status: z.enum(['draft', 'ready']),
    items: z.array(AdmittedCourseQuestionSchema),
    discarded: z.array(z.object({ slotId: Id, reasons: z.array(Text) }).strict()),
    candidateStates: z
      .array(
        z
          .object({
            slotId: Id,
            candidates: z.array(z.unknown()),
            rejectedCount: z.number().int().min(0).max(2),
            findings: z.array(Text),
          })
          .strict(),
      )
      .default([]),
    blueprint: CourseAssessmentBlueprintSchema.nullable(),
    paperCoverageSelection: z.array(
      z
        .object({
          cellId: Id,
          knowledgeIds: z.array(Id),
          representatives: z.array(z.object({ setId: Id, knowledgeId: Id }).strict()),
          replacements: z.array(z.object({ from: Id, to: Id, reason: Text }).strict()),
          slotId: Id.optional(),
        })
        .strict(),
    ),
    supplementActions: z
      .array(
        z
          .object({
            requestId: Id,
            slots: z
              .array(z.object({ cellId: Id, previousSlotId: Id, slotId: Id }).strict())
              .min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const CourseAnswerSchema = z
  .object({
    questionId: Id,
    response: z.union([z.string(), z.array(Id)]),
    assistance: z.enum(['none', 'hint']).default('none'),
  })
  .strict();
export const CourseItemGradeSchema = z
  .object({
    id: Id,
    questionId: Id,
    score: z.number().finite().min(0).max(1),
    criteria: z.array(z.object({ criterionId: Id, met: z.boolean(), reason: Text }).strict()),
    feedback: Text,
    confidence: z.number().finite().min(0).max(1),
    uncertain: z.boolean(),
    callIds: z.array(Id),
    assessedKnowledgeIds: z.array(Id),
    answerHash: Id,
    questionHash: Id,
    rubricHash: Id,
    policyVersion: z.literal(COURSE_POLICY),
  })
  .strict();
export const CourseSubmissionSchema = z
  .object({
    id: Id,
    workspaceId: Id,
    quizId: Id,
    responses: z.array(CourseAnswerSchema),
    submittedAt: z.string().datetime(),
    status: z.enum(['submitted', 'graded', 'pending']),
    version: z.number().int().positive(),
    itemGrades: z.array(CourseItemGradeSchema),
    score: z.number().nullable(),
    passed: z.boolean().nullable(),
    operationId: Id.nullable(),
  })
  .strict();
export const CourseSessionSchema = z
  .object({
    id: Id,
    workspaceId: Id,
    curriculumId: Id,
    lessonVersionId: Id,
    purpose: z.enum(['learning', 'revisit']),
    originSessionId: Id.nullable(),
    status: z.enum(['active', 'completed', 'paused']),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();
export const CourseRepairRoundSchema = z
  .object({
    id: Id,
    workspaceId: Id,
    originKind: z.enum(['submission', 'grade']),
    originId: Id,
    targetItemIds: z.array(Id).min(1),
    ordinal: z.number().int().positive(),
    status: z.enum(['preparing', 'ready', 'submitted', 'completed', 'failed', 'cancelled']),
    learnerOutcome: z.enum(['passed', 'not_yet']).nullable(),
    explanation: z.string(),
    retestQuizId: Id.nullable(),
    retestSubmissionId: Id.nullable(),
    operationId: Id,
    version: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const CourseCommandSchema = z.object({ commandId: Id, idempotencyKey: Id }).strict();
export const CourseOperationSchema = z
  .object({
    id: Id,
    workspaceId: Id,
    kind: z.enum([
      'preparePlan',
      'prepareLesson',
      'preparePractice',
      'prepareRepair',
      'prepareFormal',
      'gradeAssessment',
    ]),
    progress: CoursePreparationProgressSchema.optional(),
    modelRequest: z
      .object({
        provider: Text,
        model: Text,
        method: Text,
        startedAt: z.string().datetime(),
        timeoutMs: z.number().int().positive(),
        responseReceived: z.boolean(),
      })
      .strict()
      .optional(),
    preferences: CoursePreferencesSchema.optional(),
    resourceKind: Id,
    resourceId: Id.nullable(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
    version: z.number().int().positive(),
    fence: z.number().int().positive(),
    result: z.unknown().nullable(),
    error: z.object({ code: Id, message: Text, retryable: z.boolean() }).strict().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type CourseSourceSpan = z.infer<typeof CourseSourceSpanSchema>;
export type CourseKnowledge = z.infer<typeof CourseKnowledgeSchema>;
export type CourseKnowledgeInventory = z.infer<typeof CourseKnowledgeInventorySchema>;
export type CoursePlan = z.infer<typeof CoursePlanSchema>;
export type CourseLesson = z.infer<typeof CourseLessonSchema>;
export type CourseAssessmentBlueprint = z.infer<typeof CourseAssessmentBlueprintSchema>;
export type LessonAuthor = z.infer<typeof LessonAuthorSchema>;
export type CourseLessonContent = z.infer<typeof CourseLessonContentSchema>;
export type CourseQuestion = z.infer<typeof CourseQuestionSchema>;
export type AdmittedCourseQuestion = z.infer<typeof AdmittedCourseQuestionSchema>;
export type CoursePublicQuestion = z.infer<typeof CoursePublicQuestionSchema>;
export type CourseQuiz = z.infer<typeof CourseQuizSchema>;
export type CourseAnswer = z.infer<typeof CourseAnswerSchema>;
export type CourseItemGrade = z.infer<typeof CourseItemGradeSchema>;
export type CourseSubmission = z.infer<typeof CourseSubmissionSchema>;
export type CourseSession = z.infer<typeof CourseSessionSchema>;
export type CourseRepairRound = z.infer<typeof CourseRepairRoundSchema>;
export type CourseCommand = z.infer<typeof CourseCommandSchema>;
export type CourseOperation = z.infer<typeof CourseOperationSchema>;
export type LessonDepth = z.infer<typeof LessonDepthSchema>;
export type CourseDemand = z.infer<typeof DemandSchema>;
