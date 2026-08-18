import { z } from 'zod';
import { DifficultySchema, ImportanceSchema, QuestionTypeSchema } from '../domain/material.js';
import { GraphRelationSchema } from '../domain/graph.js';
import { PlanStrategySchema } from '../domain/plan.js';
import { AlignmentLanguageSchema, AlignmentRelationSchema } from '../domain/alignment.js';
import { AssessmentModeSchema } from '../domain/blueprint.js';
import { LessonSectionKindSchema } from '../domain/lesson.js';
import { MisconceptionCategorySchema } from '../domain/misconception.js';
import { TutorToolNameSchema } from '../domain/tutor.js';
import { DesiredDepthSchema } from '../domain/learningContract.js';

/**
 * Structured payloads that LLM providers must return.
 *
 * These schemas are the ONLY accepted shapes for model output. Providers get
 * one bounded repair attempt on validation failure, then fail with a
 * structured error. Most model workflows cite sources as (blockId, exact
 * quote) and the server independently verifies every quote. Curriculum is
 * stricter: the model selects a server-offered evidence identity and the
 * server resolves its exact revision-owned text locally.
 */

export const ProposedConceptSchema = z.object({
  name: z.string().min(1).max(80),
  summary: z.string().min(1).max(500),
  importance: ImportanceSchema,
  blockId: z.string().min(1),
  quote: z.string().min(1).max(500),
});
export type ProposedConcept = z.infer<typeof ProposedConceptSchema>;

/**
 * Concept-extraction output. An EMPTY list is legal: a thin section may
 * genuinely contain nothing worth extracting (the caller decides whether a
 * fully-empty document-level result is an error).
 */
export const ConceptAnalysisPayloadSchema = z.object({
  concepts: z.array(ProposedConceptSchema).max(12),
});
export type ConceptAnalysisPayload = z.infer<typeof ConceptAnalysisPayloadSchema>;

export const ProposedOptionSchema = z.object({
  id: z.string().regex(/^[A-H]$/),
  text: z.string().min(1).max(300),
});

/**
 * One proposed rubric point. Providers must classify each point:
 * `required: true` — explicitly requested by the question wording and
 * score-relevant; `required: false` — enrichment whose absence can never
 * reduce the score. Plain strings (the pre-split provider format) are
 * accepted and default to required, matching the old semantics.
 */
export const ProposedRubricPointSchema = z.preprocess(
  (point) => (typeof point === 'string' ? { text: point, required: true } : point),
  z.object({
    text: z.string().min(1).max(200),
    required: z.boolean(),
  }),
);
export type ProposedRubricPoint = z.infer<typeof ProposedRubricPointSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLooseOptionId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = value
    .trim()
    .toUpperCase()
    .match(/^(?:OPTION|选项)?\s*([A-H])(?:[\s.)、:：-]*)$/u);
  return match?.[1] ?? value;
}

/**
 * Normalize harmless model-format variations before strict validation.
 *
 * Hy3 may occasionally emit choice labels such as "1"/"2" or "A."/"B.",
 * and may include empty placeholder fields for the other question kind. We
 * canonicalize unique option labels by their stable array order and remove
 * only EMPTY inapplicable fields. Non-empty conflicting fields still fail the
 * strict schema below.
 */
function normalizeProposedQuestion(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const question: Record<string, unknown> = { ...value };

  if (Array.isArray(question.options)) {
    const options = question.options;
    const rawIds = options.map((option) =>
      isRecord(option) && typeof option.id === 'string' ? option.id.trim() : null,
    );
    const canCanonicalize =
      options.length <= 8 &&
      rawIds.every((id): id is string => Boolean(id)) &&
      new Set(rawIds).size === rawIds.length;

    if (canCanonicalize) {
      const aliases = new Map<string, string>();
      question.options = options.map((option, index) => {
        if (!isRecord(option)) return option;
        const rawId = rawIds[index]!;
        const canonicalId = String.fromCharCode('A'.charCodeAt(0) + index);
        aliases.set(rawId, canonicalId);
        aliases.set(rawId.toUpperCase(), canonicalId);
        const loose = normalizeLooseOptionId(rawId);
        if (typeof loose === 'string') aliases.set(loose, canonicalId);
        return { ...option, id: canonicalId };
      });

      if (Array.isArray(question.correctOptionIds)) {
        question.correctOptionIds = question.correctOptionIds.map((id) => {
          if (typeof id !== 'string') return id;
          const rawId = id.trim();
          const loose = normalizeLooseOptionId(rawId);
          return (
            aliases.get(rawId) ??
            aliases.get(rawId.toUpperCase()) ??
            (typeof loose === 'string' ? (aliases.get(loose) ?? loose) : loose)
          );
        });
      }
    } else {
      question.options = options.map((option) =>
        isRecord(option) ? { ...option, id: normalizeLooseOptionId(option.id) } : option,
      );
      if (Array.isArray(question.correctOptionIds)) {
        question.correctOptionIds = question.correctOptionIds.map(normalizeLooseOptionId);
      }
    }
  }

  if (question.type === 'short_answer' || question.type === 'concept_comparison') {
    if (
      question.options === null ||
      (Array.isArray(question.options) && question.options.length === 0)
    ) {
      delete question.options;
    }
    if (
      question.correctOptionIds === null ||
      (Array.isArray(question.correctOptionIds) && question.correctOptionIds.length === 0)
    ) {
      delete question.correctOptionIds;
    }
  } else if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    if (
      question.expectedAnswer === null ||
      (typeof question.expectedAnswer === 'string' && question.expectedAnswer.trim() === '')
    ) {
      delete question.expectedAnswer;
    }
    if (
      question.rubricKeyPoints === null ||
      (Array.isArray(question.rubricKeyPoints) && question.rubricKeyPoints.length === 0)
    ) {
      delete question.rubricKeyPoints;
    }
  }

  return question;
}

const StrictProposedQuestionSchema = z
  .object({
    type: QuestionTypeSchema,
    stem: z.string().min(1).max(500),
    options: z.array(ProposedOptionSchema).min(2).max(8).optional(),
    correctOptionIds: z
      .array(z.string().regex(/^[A-H]$/))
      .min(1)
      .optional(),
    expectedAnswer: z.string().min(1).max(1000).optional(),
    rubricKeyPoints: z.array(ProposedRubricPointSchema).min(1).max(6).optional(),
    conceptId: z.string().min(1),
    blockId: z.string().min(1),
    quote: z.string().min(1).max(500),
    explanation: z.string().min(1).max(1000),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'short_answer' || q.type === 'concept_comparison') {
      if (!q.expectedAnswer || !q.rubricKeyPoints) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${q.type} requires expectedAnswer and rubricKeyPoints`,
        });
      }
      if (q.options !== undefined || q.correctOptionIds !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${q.type} must not define choice fields`,
        });
      }
      return;
    }
    if (q.expectedAnswer !== undefined || q.rubricKeyPoints !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'choice questions must not define short-answer fields',
      });
    }
    if (!q.options || !q.correctOptionIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'choice questions require options and correctOptionIds',
      });
      return;
    }
    const ids = new Set(q.options.map((o) => o.id));
    if (ids.size !== q.options.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'option ids must be unique' });
    }
    if (new Set(q.correctOptionIds).size !== q.correctOptionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'correctOptionIds must be unique',
      });
    }
    for (const id of q.correctOptionIds) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `correctOptionId ${id} not present in options`,
        });
      }
    }
    if (q.type === 'single_choice' && q.correctOptionIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'single_choice must have exactly one correct option',
      });
    }
  });

export const ProposedQuestionSchema = z.preprocess(
  normalizeProposedQuestion,
  StrictProposedQuestionSchema,
);
export type ProposedQuestion = z.infer<typeof ProposedQuestionSchema>;

export const QuizGenerationPayloadSchema = z.object({
  questions: z.array(ProposedQuestionSchema).min(1).max(30),
});
export type QuizGenerationPayload = z.infer<typeof QuizGenerationPayloadSchema>;

/**
 * Evidence as PROPOSED by a model: block reference plus exact quote.
 * The server verifies every quote and computes offsets itself.
 */
export const ProposedEvidenceSchema = z.object({
  blockId: z.string().min(1),
  quote: z.string().min(1).max(500),
});
export type ProposedEvidence = z.infer<typeof ProposedEvidenceSchema>;

/** Server-offered exact evidence selected by identity in Curriculum output. */
export const CurriculumEvidenceSelectionSchema = z
  .object({
    evidenceId: z.string().min(1).max(100),
  })
  .strict();
export type CurriculumEvidenceSelection = z.infer<typeof CurriculumEvidenceSelectionSchema>;

/** Learner-visible objective proposed for one Curriculum LearningUnit. */
export const ProposedCurriculumObjectiveSchema = z
  .object({
    /** Proposal-local identity; the server assigns the persisted objective id. */
    key: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(1000),
    /** Optional server-offered evidence selections; local authority decides their meaning. */
    evidence: z.array(CurriculumEvidenceSelectionSchema).max(5),
  })
  .strict();
export type ProposedCurriculumObjective = z.infer<typeof ProposedCurriculumObjectiveSchema>;

/**
 * One provider-proposed Curriculum node below the server-owned Course root.
 * Keys are proposal-local and carry no lifecycle, truth, or acceptance authority.
 */
export const ProposedCurriculumNodeSchema = z
  .object({
    key: z.string().min(1).max(100),
    parentKey: z.string().min(1).max(100).nullable(),
    kind: z.enum(['chapter', 'section', 'learning_unit']),
    index: z.number().int().nonnegative(),
    title: z.string().min(1).max(300),
    structuralUnitIds: z.array(z.string().min(1)).max(500),
    sourceEvidence: z.array(CurriculumEvidenceSelectionSchema).max(100),
    conceptIds: z.array(z.string().min(1)).max(30),
    canonicalConceptIds: z.array(z.string().min(1)).max(20),
    objectives: z.array(ProposedCurriculumObjectiveSchema).max(30),
    prerequisiteUnitKeys: z.array(z.string().min(1).max(100)).max(30),
    graphRelationIds: z.array(z.string().min(1)).max(50),
  })
  .strict()
  .superRefine((node, ctx) => {
    const unitOnlyCount =
      node.conceptIds.length +
      node.canonicalConceptIds.length +
      node.objectives.length +
      node.prerequisiteUnitKeys.length +
      node.graphRelationIds.length;
    if (node.kind === 'learning_unit' && node.objectives.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectives'],
        message: 'learning_unit nodes require at least one objective',
      });
    }
    if (node.kind !== 'learning_unit' && unitOnlyCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only learning_unit nodes may carry unit details',
      });
    }
  });
export type ProposedCurriculumNode = z.infer<typeof ProposedCurriculumNodeSchema>;

export const ProposedCurriculumSynthesisGroupSchema = z
  .object({
    key: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    level: z.enum(['section', 'chapter', 'course', 'transfer']),
    learningUnitKeys: z.array(z.string().min(1).max(100)).min(2).max(50),
    objectiveKeys: z.array(z.string().min(1).max(100)).min(1).max(100),
  })
  .strict();
export type ProposedCurriculumSynthesisGroup = z.infer<
  typeof ProposedCurriculumSynthesisGroupSchema
>;

/** Compact operation-local reference to one server-offered source region. */
export const CourseMapSourceRegionRefSchema = z
  .string()
  .max(100)
  .regex(/^R[1-9][0-9]*$/u);
export type CourseMapSourceRegionRef = z.infer<typeof CourseMapSourceRegionRefSchema>;

/** Region-scoped selection of one server-offered Concept/canonical anchor binding. */
export const CourseMapAnchorOptionRefSchema = z
  .string()
  .max(100)
  .regex(/^R[1-9][0-9]*:A[1-9][0-9]*$/u);
export type CourseMapAnchorOptionRef = z.infer<typeof CourseMapAnchorOptionRefSchema>;

/** One ordered instructional region in the internal Course Map proposal. */
export const ProposedCourseMapRegionSchema = z
  .object({
    sourceRegionRef: CourseMapSourceRegionRefSchema,
    title: z.string().min(1).max(300),
    learningIntent: z.string().min(1).max(700),
    approximateScope: z.enum(['focused', 'standard', 'extended']),
    anchorOptionRefs: z.array(CourseMapAnchorOptionRefSchema).max(30),
  })
  .strict()
  .superRefine((region, ctx) => {
    if (new Set(region.anchorOptionRefs).size !== region.anchorOptionRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['anchorOptionRefs'],
        message: 'Course Map region anchor-option references must be unique.',
      });
    }
  });
export type ProposedCourseMapRegion = z.infer<typeof ProposedCourseMapRegionSchema>;

export const ProposedCourseMapModuleSchema = z
  .object({
    title: z.string().min(1).max(300),
    learningIntent: z.string().min(1).max(700),
    regions: z.array(ProposedCourseMapRegionSchema).min(1).max(120),
  })
  .strict();
export type ProposedCourseMapModule = z.infer<typeof ProposedCourseMapModuleSchema>;

export const ProposedCourseMapPrerequisiteSchema = z
  .object({
    prerequisiteRegionRef: CourseMapSourceRegionRefSchema,
    dependentRegionRef: CourseMapSourceRegionRefSchema,
  })
  .strict();
export type ProposedCourseMapPrerequisite = z.infer<typeof ProposedCourseMapPrerequisiteSchema>;

export const ProposedCourseMapSynthesisGroupSchema = z
  .object({
    title: z.string().min(1).max(300),
    level: z.enum(['module', 'course', 'transfer']),
    regionRefs: z.array(CourseMapSourceRegionRefSchema).min(2).max(50),
  })
  .strict();
export type ProposedCourseMapSynthesisGroup = z.infer<typeof ProposedCourseMapSynthesisGroupSchema>;

/**
 * Model-authored internal skeleton only. Local code owns exact source
 * allocation, ids, prerequisite topology, validation, and every lifecycle
 * decision.
 */
export const CourseMapProposalPayloadSchema = z
  .object({
    modules: z.array(ProposedCourseMapModuleSchema).min(1).max(24),
    prerequisites: z.array(ProposedCourseMapPrerequisiteSchema).max(384),
    synthesisGroups: z.array(ProposedCourseMapSynthesisGroupSchema).max(100),
  })
  .strict();
export type CourseMapProposalPayload = z.infer<typeof CourseMapProposalPayloadSchema>;

/** One bounded LearningUnit detail proposal for a server-owned Course Map region. */
export const ProposedCurriculumDetailUnitSchema = z
  .object({
    regionId: z.string().regex(/^course_map_region_[0-9a-f]{24}$/u),
    title: z.string().min(1).max(300),
    sourceEvidence: z.array(CurriculumEvidenceSelectionSchema).min(1).max(32),
    conceptIds: z.array(z.string().min(1)).max(20),
    canonicalConceptIds: z.array(z.string().min(1)).max(10),
    objectives: z.array(ProposedCurriculumObjectiveSchema).min(1).max(4),
  })
  .strict()
  .superRefine((unit, ctx) => {
    if (
      new Set(unit.sourceEvidence.map((item) => item.evidenceId)).size !==
      unit.sourceEvidence.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceEvidence'],
        message: 'Curriculum detail evidence selections must be unique.',
      });
    }
    if (new Set(unit.conceptIds).size !== unit.conceptIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conceptIds'],
        message: 'Curriculum detail Concept selections must be unique.',
      });
    }
    if (new Set(unit.canonicalConceptIds).size !== unit.canonicalConceptIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canonicalConceptIds'],
        message: 'Curriculum detail canonical Concept selections must be unique.',
      });
    }
  });
export type ProposedCurriculumDetailUnit = z.infer<typeof ProposedCurriculumDetailUnitSchema>;

/** Fixed-batch semantic detail output. It has no persistence or partial-Curriculum authority. */
export const CurriculumDetailProposalPayloadSchema = z
  .object({
    courseMapId: z.string().regex(/^course_map_[0-9a-f]{24}$/u),
    sourceAllocationFingerprint: z.string().regex(/^course_map_source_allocation_[0-9a-f]{40}$/u),
    units: z.array(ProposedCurriculumDetailUnitSchema).min(1).max(60),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const regionIds = new Set<string>();
    const objectiveKeys = new Set<string>();
    for (const [unitIndex, unit] of payload.units.entries()) {
      if (regionIds.has(unit.regionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units', unitIndex, 'regionId'],
          message: `duplicate Curriculum detail region id: ${unit.regionId}`,
        });
      }
      regionIds.add(unit.regionId);
      for (const [objectiveIndex, objective] of unit.objectives.entries()) {
        if (objectiveKeys.has(objective.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['units', unitIndex, 'objectives', objectiveIndex, 'key'],
            message: `duplicate Curriculum detail objective key: ${objective.key}`,
          });
        }
        objectiveKeys.add(objective.key);
      }
    }
  });
export type CurriculumDetailProposalPayload = z.infer<typeof CurriculumDetailProposalPayloadSchema>;

/** Semantic Curriculum proposal. All consequential fields are assigned locally. */
export const CurriculumProposalPayloadSchema = z
  .object({
    nodes: z.array(ProposedCurriculumNodeSchema).min(1).max(1999),
    synthesisGroups: z.array(ProposedCurriculumSynthesisGroupSchema).max(200),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const nodesByKey = new Map<string, (typeof payload.nodes)[number]>();
    const objectiveKeys = new Set<string>();
    let learningUnitCount = 0;

    for (const [index, node] of payload.nodes.entries()) {
      if (nodesByKey.has(node.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'key'],
          message: `duplicate Curriculum node key: ${node.key}`,
        });
      } else {
        nodesByKey.set(node.key, node);
      }
      if (node.kind === 'learning_unit') learningUnitCount += 1;
      for (const [objectiveIndex, objective] of node.objectives.entries()) {
        if (objectiveKeys.has(objective.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'objectives', objectiveIndex, 'key'],
            message: `duplicate Curriculum objective key: ${objective.key}`,
          });
        }
        objectiveKeys.add(objective.key);
      }
    }

    if (learningUnitCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes'],
        message: 'a Curriculum proposal requires at least one learning unit',
      });
    }

    for (const [index, node] of payload.nodes.entries()) {
      const parent = node.parentKey ? nodesByKey.get(node.parentKey) : null;
      if (node.kind === 'chapter' && node.parentKey !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'parentKey'],
          message: 'chapter nodes must attach directly to the server-owned Course root',
        });
      }
      if (node.kind === 'section' && parent?.kind !== 'chapter') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'parentKey'],
          message: 'section nodes require a known chapter parent',
        });
      }
      if (node.kind === 'learning_unit' && parent?.kind !== 'section') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'parentKey'],
          message: 'learning_unit nodes require a known section parent',
        });
      }
      for (const prerequisiteKey of node.prerequisiteUnitKeys) {
        const prerequisite = nodesByKey.get(prerequisiteKey);
        if (prerequisite?.kind !== 'learning_unit' || prerequisiteKey === node.key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'prerequisiteUnitKeys'],
            message: `invalid prerequisite LearningUnit key: ${prerequisiteKey}`,
          });
        }
      }
    }

    const synthesisKeys = new Set<string>();
    for (const [index, group] of payload.synthesisGroups.entries()) {
      if (synthesisKeys.has(group.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['synthesisGroups', index, 'key'],
          message: `duplicate synthesis group key: ${group.key}`,
        });
      }
      synthesisKeys.add(group.key);
      for (const unitKey of group.learningUnitKeys) {
        if (nodesByKey.get(unitKey)?.kind !== 'learning_unit') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['synthesisGroups', index, 'learningUnitKeys'],
            message: `unknown synthesis LearningUnit key: ${unitKey}`,
          });
        }
      }
      for (const objectiveKey of group.objectiveKeys) {
        if (!objectiveKeys.has(objectiveKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['synthesisGroups', index, 'objectiveKeys'],
            message: `unknown synthesis objective key: ${objectiveKey}`,
          });
        }
      }
    }
  });
export type CurriculumProposalPayload = z.infer<typeof CurriculumProposalPayloadSchema>;

/** One executable-route item proposed from an already accepted Curriculum. */
export const ProposedStudyPlanItemSchema = z
  .object({
    /** Proposal-local identity; the server assigns the persisted plan-item id. */
    key: z.string().min(1).max(100),
    phase: z.string().min(1).max(200),
    kind: z.enum([
      'teach_unit',
      'informal_check',
      'formal_checkpoint',
      'synthesis',
      'targeted_repair',
      'due_review',
    ]),
    curriculumLearningUnitId: z.string().min(1).nullable(),
    rationale: z.string().min(1).max(1000),
    estimatedMinutes: z.number().int().positive().max(10_000),
    targetDepth: DesiredDepthSchema,
    objectiveIds: z.array(z.string().min(1)).min(1).max(30),
    prerequisiteItemKeys: z.array(z.string().min(1).max(100)).max(30),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (
      (item.kind === 'teach_unit' ||
        item.kind === 'informal_check' ||
        item.kind === 'formal_checkpoint') &&
      item.curriculumLearningUnitId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['curriculumLearningUnitId'],
        message: `${item.kind} requires a Curriculum LearningUnit`,
      });
    }
  });
export type ProposedStudyPlanItem = z.infer<typeof ProposedStudyPlanItemSchema>;

export const ProposedStudyPlanDeferralSchema = z
  .object({
    curriculumLearningUnitId: z.string().min(1),
    objectiveIds: z.array(z.string().min(1)).max(30),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type ProposedStudyPlanDeferral = z.infer<typeof ProposedStudyPlanDeferralSchema>;

/**
 * Compact provider output for large Curricula. The server expands unit groups
 * into ordinary StudyPlan items and derives objective/prerequisite identity
 * from the accepted Curriculum before any proposal can be persisted.
 */
export const GroupedStudyPlanProposalPayloadSchema = z
  .object({
    format: z.literal('grouped_units'),
    rationale: z.string().min(1).max(1000),
    groups: z
      .array(
        z
          .object({
            key: z.string().min(1).max(100),
            phase: z.string().min(1).max(200),
            kind: z.enum([
              'teach_unit',
              'informal_check',
              'formal_checkpoint',
              'targeted_repair',
              'due_review',
            ]),
            curriculumLearningUnitIds: z.array(z.string().min(1)).min(1).max(500),
            rationale: z.string().min(1).max(1000),
            estimatedMinutesPerUnit: z.number().int().positive().max(10_000),
            targetDepth: DesiredDepthSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    deferrals: z
      .array(
        z
          .object({
            curriculumLearningUnitIds: z.array(z.string().min(1)).min(1).max(500),
            reason: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const groupKeys = new Set<string>();
    const unitIds = new Set<string>();
    for (const [groupIndex, group] of payload.groups.entries()) {
      if (groupKeys.has(group.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', groupIndex, 'key'],
          message: `duplicate grouped StudyPlan key: ${group.key}`,
        });
      }
      groupKeys.add(group.key);
      for (const [unitIndex, unitId] of group.curriculumLearningUnitIds.entries()) {
        if (unitIds.has(unitId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['groups', groupIndex, 'curriculumLearningUnitIds', unitIndex],
            message: `duplicate grouped StudyPlan LearningUnit: ${unitId}`,
          });
        }
        unitIds.add(unitId);
      }
    }
    for (const [deferralIndex, deferral] of payload.deferrals.entries()) {
      for (const [unitIndex, unitId] of deferral.curriculumLearningUnitIds.entries()) {
        if (unitIds.has(unitId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['deferrals', deferralIndex, 'curriculumLearningUnitIds', unitIndex],
            message: `duplicate grouped StudyPlan LearningUnit: ${unitId}`,
          });
        }
        unitIds.add(unitId);
      }
    }
  });
export type GroupedStudyPlanProposalPayload = z.infer<typeof GroupedStudyPlanProposalPayloadSchema>;

/** Semantic StudyPlan proposal. Feasibility, diff, policy, and acceptance stay local. */
export const StudyPlanProposalPayloadSchema = z
  .object({
    rationale: z.string().min(1).max(1000),
    items: z.array(ProposedStudyPlanItemSchema).min(1).max(1000),
    deferrals: z.array(ProposedStudyPlanDeferralSchema).max(500),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const itemKeys = new Set<string>();
    for (const [index, item] of payload.items.entries()) {
      if (itemKeys.has(item.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'key'],
          message: `duplicate StudyPlan item key: ${item.key}`,
        });
      }
      itemKeys.add(item.key);
    }
    for (const [index, item] of payload.items.entries()) {
      for (const prerequisiteKey of item.prerequisiteItemKeys) {
        if (!itemKeys.has(prerequisiteKey) || prerequisiteKey === item.key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'prerequisiteItemKeys'],
            message: `invalid prerequisite StudyPlan item key: ${prerequisiteKey}`,
          });
        }
      }
    }
  });
export type StudyPlanProposalPayload = z.infer<typeof StudyPlanProposalPayloadSchema>;

/** One candidate concept-graph edge proposed by a provider. */
export const ProposedGraphEdgeSchema = z.object({
  sourceConceptId: z.string().min(1),
  targetConceptId: z.string().min(1),
  relation: GraphRelationSchema,
  explanation: z.string().min(1).max(500),
  evidence: z.array(ProposedEvidenceSchema).min(1).max(3),
});
export type ProposedGraphEdge = z.infer<typeof ProposedGraphEdgeSchema>;

/** Structured provider output for graph-edge proposal. */
export const GraphProposalPayloadSchema = z.object({
  edges: z.array(ProposedGraphEdgeSchema).min(1).max(60),
});
export type GraphProposalPayload = z.infer<typeof GraphProposalPayloadSchema>;

/** One target concept of a proposed remediation plan. */
export const ProposedPlanTargetSchema = z.object({
  conceptId: z.string().min(1),
  reason: z.string().min(1).max(500),
  evidence: z.array(ProposedEvidenceSchema).min(1).max(3),
});
export type ProposedPlanTarget = z.infer<typeof ProposedPlanTargetSchema>;

/** One ordered step of a proposed remediation plan. */
export const ProposedPlanStepSchema = z.object({
  description: z.string().min(1).max(500),
  conceptId: z.string().min(1).nullable().optional(),
});
export type ProposedPlanStep = z.infer<typeof ProposedPlanStepSchema>;

/** Structured provider output for remediation-plan proposal. */
export const RemediationPlanProposalPayloadSchema = z.object({
  summary: z.string().min(1).max(600),
  weaknessHypothesis: z.string().min(1).max(600),
  strategy: PlanStrategySchema,
  difficulty: DifficultySchema,
  questionTypes: z.array(QuestionTypeSchema).min(1).max(3),
  steps: z.array(ProposedPlanStepSchema).min(1).max(6),
  targets: z.array(ProposedPlanTargetSchema).min(1).max(4),
});
export type RemediationPlanProposalPayload = z.infer<typeof RemediationPlanProposalPayloadSchema>;

// ---------------------------------------------------------------------------
// Concept alignment
// ---------------------------------------------------------------------------

/** One provider-proposed alignment between two EXISTING source concepts. */
export const ProposedAlignmentSchema = z.object({
  sourceConceptId: z.string().min(1),
  targetConceptId: z.string().min(1),
  relation: AlignmentRelationSchema,
  /** Proposed canonical display name for merging relations. */
  canonicalName: z.string().min(1).max(80),
  rationale: z.string().min(1).max(400),
  /** Evidence quotes copied verbatim from source blocks (verified locally). */
  evidence: z.array(ProposedEvidenceSchema).max(2),
  sourceLanguage: AlignmentLanguageSchema.optional(),
  targetLanguage: AlignmentLanguageSchema.optional(),
});
export type ProposedAlignment = z.infer<typeof ProposedAlignmentSchema>;

/** Structured provider output for concept-alignment proposal. */
export const AlignmentProposalPayloadSchema = z.object({
  proposals: z.array(ProposedAlignmentSchema).max(30),
});
export type AlignmentProposalPayload = z.infer<typeof AlignmentProposalPayloadSchema>;

// ---------------------------------------------------------------------------
// Workspace assessment (blueprint + question pairs)
// ---------------------------------------------------------------------------

/** Blueprint part of one proposed assessment item. */
export const ProposedBlueprintSchema = z.object({
  /** Source concepts this item targets (validated against the workspace). */
  conceptIds: z.array(z.string().min(1)).min(1).max(3),
  questionType: QuestionTypeSchema,
  difficulty: DifficultySchema,
  learningObjective: z.string().min(1).max(300),
  /** Expected reasoning steps; indexes reference the item's evidence order. */
  reasoningSteps: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        evidenceIndexes: z.array(z.number().int().nonnegative()).max(4),
      }),
    )
    .min(1)
    .max(4),
});
export type ProposedBlueprint = z.infer<typeof ProposedBlueprintSchema>;

/**
 * One proposed assessment item: a blueprint plus its concrete question.
 * The question's own (blockId, quote) is evidence index 0; `extraEvidence`
 * continues the index order (1, 2, …). Cross-document items must draw
 * verified evidence from at least two distinct documents.
 */
export const ProposedAssessmentItemSchema = z.object({
  blueprint: ProposedBlueprintSchema,
  question: ProposedQuestionSchema,
  extraEvidence: z.array(ProposedEvidenceSchema).max(3),
});
export type ProposedAssessmentItem = z.infer<typeof ProposedAssessmentItemSchema>;

/** Structured provider output for workspace assessment generation. */
export const AssessmentProposalPayloadSchema = z.object({
  items: z.array(ProposedAssessmentItemSchema).min(1).max(8),
});
export type AssessmentProposalPayload = z.infer<typeof AssessmentProposalPayloadSchema>;

// ---------------------------------------------------------------------------
// Misconception hypothesis
// ---------------------------------------------------------------------------

/**
 * Structured provider output when asked whether a wrong answer suggests a
 * misconception. `applicable: false` means "no clear hypothesis" — the
 * model is never forced to invent a category for every mistake.
 */
export const MisconceptionProposalPayloadSchema = z.object({
  applicable: z.boolean(),
  category: MisconceptionCategorySchema,
  hypothesis: z.string().min(1).max(400),
  evidence: z.array(ProposedEvidenceSchema).max(2),
});
export type MisconceptionProposalPayload = z.infer<typeof MisconceptionProposalPayloadSchema>;

// ---------------------------------------------------------------------------
// Concept lesson (teaching enrichment)
// ---------------------------------------------------------------------------

/**
 * One PROPOSED lesson segment. `anchor` is optional: the model includes it
 * ONLY where the course text directly supports the sentence, quoting
 * verbatim. The server verifies every anchor; a failed anchor is dropped and
 * the segment becomes (labeled) AI teaching — provenance is never
 * model-certified.
 */
export const ProposedLessonSegmentSchema = z.object({
  text: z.string().min(1).max(600),
  anchor: ProposedEvidenceSchema.optional(),
});
export type ProposedLessonSegment = z.infer<typeof ProposedLessonSegmentSchema>;

export const ProposedLessonSectionSchema = z.object({
  kind: LessonSectionKindSchema,
  segments: z.array(ProposedLessonSegmentSchema).min(1).max(10),
});
export type ProposedLessonSection = z.infer<typeof ProposedLessonSectionSchema>;

/** Structured provider output for concept-lesson generation. */
export const ConceptLessonPayloadSchema = z.object({
  sections: z.array(ProposedLessonSectionSchema).min(1).max(6),
  /** Where the course text differs from common presentation (quote required). */
  conflicts: z
    .array(
      z.object({
        claim: z.string().min(1).max(300),
        blockId: z.string().min(1),
        quote: z.string().min(1).max(500),
      }),
    )
    .max(3)
    .default([]),
});
export type ConceptLessonPayload = z.infer<typeof ConceptLessonPayloadSchema>;

// ---------------------------------------------------------------------------
// Tutor step
// ---------------------------------------------------------------------------

/** Tutor decision: call one whitelisted read-only tool… */
export const TutorToolCallStepSchema = z.object({
  action: z.literal('call_tool'),
  tool: TutorToolNameSchema,
  /** Tool arguments; validated against the tool's own schema locally. */
  arguments: z.record(z.unknown()),
  /** Concise, display-safe purpose (shown on the timeline after review). */
  purpose: z.string().min(1).max(200),
});
export type TutorToolCallStep = z.infer<typeof TutorToolCallStepSchema>;

/** …or finalize with a plan plus a recommended activity. */
export const TutorFinalizeStepSchema = z.object({
  action: z.literal('finalize'),
  plan: RemediationPlanProposalPayloadSchema,
  activity: z.object({
    mode: AssessmentModeSchema,
    conceptIds: z.array(z.string().min(1)).min(1).max(3),
    /** Required when mode is misconception_check (from the offered list). */
    misconceptionId: z.string().min(1).optional(),
  }),
});
export type TutorFinalizeStep = z.infer<typeof TutorFinalizeStepSchema>;

/** Structured provider output for one bounded Tutor iteration. */
export const TutorStepPayloadSchema = z.discriminatedUnion('action', [
  TutorToolCallStepSchema,
  TutorFinalizeStepSchema,
]);
export type TutorStepPayload = z.infer<typeof TutorStepPayloadSchema>;

// ---------------------------------------------------------------------------
// StudySession conversational Tutor turn
// ---------------------------------------------------------------------------

/** Advisory only: local command handlers decide whether any suggestion is executable. */
export const TutorTurnSuggestedActionSchema = z.enum([
  'detour',
  'agenda_insert',
  'deep_dive',
  'direct_checkpoint',
  'defer',
  'promote_to_plan',
]);
export type TutorTurnSuggestedAction = z.infer<typeof TutorTurnSuggestedActionSchema>;

const TutorTurnSummaryDeltaSchema = z
  .object({
    learnerQuestions: z.array(z.string().min(1).max(500)).max(10),
    unresolvedConfusion: z.array(z.string().min(1).max(500)).max(10),
    explanationsTried: z.array(z.string().min(1).max(500)).max(10),
    learnerReactions: z.array(z.string().min(1).max(500)).max(10),
    openActions: z.array(z.string().min(1).max(500)).max(10),
    safetyFlags: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();
export type TutorTurnSummaryDelta = z.infer<typeof TutorTurnSummaryDeltaSchema>;

/**
 * Conversational output is deliberately non-authoritative. It cannot create
 * evidence, grade work, alter learner state, or issue a durable command.
 */
export const TutorTurnPayloadSchema = z
  .object({
    text: z.string().min(1).max(8000),
    summaryDelta: TutorTurnSummaryDeltaSchema,
    suggestedActions: z.array(TutorTurnSuggestedActionSchema).max(6),
  })
  .strict();
export type TutorTurnPayload = z.infer<typeof TutorTurnPayloadSchema>;
