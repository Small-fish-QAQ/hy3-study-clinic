import { z } from 'zod';

export const StudySessionStatusSchema = z.enum([
  'active',
  'paused',
  'completed',
  'abandoned',
  'interrupted',
]);
export type StudySessionStatus = z.infer<typeof StudySessionStatusSchema>;

export const StudyTurnStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
]);
export type StudyTurnStatus = z.infer<typeof StudyTurnStatusSchema>;

export const StudySessionRouteStateSchema = z.enum([
  'on_route',
  'detour_active',
  'return_pending',
  'execution_paused',
]);
export type StudySessionRouteState = z.infer<typeof StudySessionRouteStateSchema>;

/** Exact versions used to assemble bounded Tutor context. */
export const TutorContextManifestSchema = z
  .object({
    fingerprint: z.string().min(1).max(200),
    contractScopeFingerprint: z.string().min(1).max(200),
    contractVersionId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    sessionAgendaVersionId: z.string().min(1),
    studySessionVersion: z.number().int().positive(),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    transcriptWatermark: z.number().int().nonnegative(),
    sourceBlockRevisionIds: z.array(z.string().min(1)).max(500),
    formalEvidenceIds: z.array(z.string().min(1)).max(200),
    riskIds: z.array(z.string().min(1)).max(100),
  })
  .strict();
export type TutorContextManifest = z.infer<typeof TutorContextManifestSchema>;

export const StudyExchangeSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    role: z.enum(['learner', 'tutor', 'local_system']),
    content: z.string().min(1).max(20000),
    /** Transcript content is conversational; formal evidence is linked separately. */
    channel: z.enum(['conversation', 'informal_check', 'operation_notice']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type StudyExchange = z.infer<typeof StudyExchangeSchema>;

export const StudyTurnSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    commandId: z.string().min(1),
    status: StudyTurnStatusSchema,
    contextManifest: TutorContextManifestSchema,
    logicalCallId: z.string().min(1).nullable(),
    errorMessage: z.string().min(1).max(1000).nullable(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();
export type StudyTurn = z.infer<typeof StudyTurnSchema>;

export const StudyTurnEventSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    kind: z.enum([
      'queued',
      'started',
      'content_delta',
      'action_proposed',
      'action_rejected',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
    ]),
    /** Provisional stream chunks never carry state authority. */
    provisional: z.boolean(),
    content: z.string().max(20000).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type StudyTurnEvent = z.infer<typeof StudyTurnEventSchema>;

export const StudySessionSummarySchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    version: z.number().int().positive(),
    throughExchangeSeq: z.number().int().nonnegative(),
    contextFingerprint: z.string().min(1).max(200),
    learnerQuestions: z.array(z.string().min(1).max(500)).max(100),
    unresolvedConfusions: z.array(z.string().min(1).max(500)).max(100),
    explanationsTried: z.array(z.string().min(1).max(500)).max(100),
    provisionalUnderstanding: z.array(z.string().min(1).max(500)).max(100),
    openActions: z.array(z.string().min(1).max(500)).max(100),
    safetyFlags: z.array(z.string().min(1).max(300)).max(50),
    createdAt: z.string().datetime(),
  })
  .strict();
export type StudySessionSummary = z.infer<typeof StudySessionSummarySchema>;

export const SessionRouteFrameSchema = z
  .object({
    id: z.string().min(1),
    parentFrameId: z.string().min(1).nullable(),
    originAgendaItemId: z.string().min(1).nullable(),
    originPlanItemId: z.string().min(1).nullable(),
    contractVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    sessionAgendaVersionId: z.string().min(1),
    reason: z.string().min(1).max(500),
    resumePolicy: z.enum(['return_to_origin', 'return_to_next_valid', 'recompose_if_stale']),
    state: z.enum(['active', 'resolved', 'stale', 'abandoned']),
  })
  .strict();
export type SessionRouteFrame = z.infer<typeof SessionRouteFrameSchema>;

export const StudySessionSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    contractVersionId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    sessionAgendaId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    version: z.number().int().positive(),
    status: StudySessionStatusSchema,
    routeState: StudySessionRouteStateSchema,
    currentAgendaItemId: z.string().min(1).nullable(),
    routeStack: z.array(SessionRouteFrameSchema).max(8),
    transcriptWatermark: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type StudySession = z.infer<typeof StudySessionSchema>;
