import { z } from 'zod';

export const CourseExecutionStatusSchema = z.enum(['active', 'paused', 'stopped']);
export type CourseExecutionStatus = z.infer<typeof CourseExecutionStatusSchema>;

export const SessionAgendaStatusSchema = z.enum([
  'draft',
  'active',
  'completed',
  'paused',
  'abandoned',
]);
export type SessionAgendaStatus = z.infer<typeof SessionAgendaStatusSchema>;

export const SessionAgendaItemKindSchema = z.enum([
  'due_review',
  'targeted_repair',
  'learning_unit_teaching',
  'informal_check',
  'formal_checkpoint',
  'synthesis',
  'learner_detour',
  'prerequisite_repair',
  'stretch_challenge',
  'adversarial_readiness',
]);
export type SessionAgendaItemKind = z.infer<typeof SessionAgendaItemKindSchema>;

export const SessionAgendaItemOriginSchema = z.enum([
  'accepted_plan',
  'due_review',
  'open_repair',
  'learner_insert',
  'learner_detour',
  'completion_policy',
  'local_recomposition',
]);
export type SessionAgendaItemOrigin = z.infer<typeof SessionAgendaItemOriginSchema>;

export const SessionAgendaItemStateSchema = z.enum([
  'queued',
  'active',
  'completed',
  'deferred',
  'cancelled',
  'blocked',
]);
export type SessionAgendaItemState = z.infer<typeof SessionAgendaItemStateSchema>;

export const AgendaLaunchCapabilitySchema = z
  .object({
    status: z.enum(['launchable', 'revalidation_required', 'blocked']),
    capability: z.string().min(1).max(100),
    resourceId: z.string().min(1).nullable(),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type AgendaLaunchCapability = z.infer<typeof AgendaLaunchCapabilitySchema>;

export const SessionAgendaItemSchema = z
  .object({
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    kind: SessionAgendaItemKindSchema,
    origin: SessionAgendaItemOriginSchema,
    reason: z.string().min(1).max(1000),
    estimatedMinutes: z.number().int().positive(),
    linkedPlanItemId: z.string().min(1).nullable(),
    learningUnitId: z.string().min(1).nullable(),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
    state: SessionAgendaItemStateSchema,
    launch: AgendaLaunchCapabilitySchema,
    displacedAgendaItemIds: z.array(z.string().min(1)).max(100),
    timeImpactMinutes: z.number().int(),
  })
  .strict();
export type SessionAgendaItem = z.infer<typeof SessionAgendaItemSchema>;

export const SessionAgendaSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    contractVersionId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    version: z.number().int().positive(),
    status: SessionAgendaStatusSchema,
    availableMinutes: z.number().int().positive().nullable(),
    items: z.array(SessionAgendaItemSchema).max(200),
    currentItemId: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type SessionAgenda = z.infer<typeof SessionAgendaSchema>;

/** Pause/resume audit without changing the accepted StudyPlan lifecycle. */
export const CourseExecutionEventSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    kind: z.enum(['paused', 'resumed', 'stopped']),
    reason: z.string().min(1).max(500).nullable(),
    actor: z.literal('learner'),
    expectedStudyPlanVersionId: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CourseExecutionEvent = z.infer<typeof CourseExecutionEventSchema>;
