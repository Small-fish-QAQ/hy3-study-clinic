import { z } from 'zod';
import { SessionAgendaSchema } from './sessionAgenda.js';
import { TutorTurnMetadataSchema } from './tutor.js';

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
    /** Persisted pedagogical decision; absent on interrupted/legacy turns. */
    tutorMetadata: TutorTurnMetadataSchema.nullable().optional(),
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

/** Start only against the exact currently accepted execution route. */
export const StartStudySessionRequestSchema = z
  .object({
    contractVersionId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    sessionAgendaId: z.string().min(1),
    expectedCourseExecutionVersion: z.number().int().nonnegative(),
  })
  .strict();
export type StartStudySessionRequest = z.infer<typeof StartStudySessionRequestSchema>;

export const StartStudySessionResponseSchema = z.object({ session: StudySessionSchema }).strict();
export type StartStudySessionResponse = z.infer<typeof StartStudySessionResponseSchema>;

export const StudySessionDetailResponseSchema = z
  .object({
    session: StudySessionSchema,
    agenda: SessionAgendaSchema,
    turns: z.array(StudyTurnSchema),
    exchanges: z.array(StudyExchangeSchema),
    /** Durable ordered event replay for reconnecting clients. */
    turnEvents: z.array(StudyTurnEventSchema),
    latestSummary: StudySessionSummarySchema.nullable(),
  })
  .strict();
export type StudySessionDetailResponse = z.infer<typeof StudySessionDetailResponseSchema>;

export const SubmitTutorTurnRequestSchema = z
  .object({
    commandId: z.string().min(1),
    expectedSessionVersion: z.number().int().positive(),
    content: z.string().min(1).max(20000),
    /** Explicit acknowledgements for configured confirm-style monetary policies. */
    confirmedCostPolicyIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();
export type SubmitTutorTurnRequest = z.infer<typeof SubmitTutorTurnRequestSchema>;

export const SubmitTutorTurnResponseSchema = z
  .object({
    session: StudySessionSchema,
    turn: StudyTurnSchema,
    exchanges: z.array(StudyExchangeSchema),
    events: z.array(StudyTurnEventSchema),
  })
  .strict();
export type SubmitTutorTurnResponse = z.infer<typeof SubmitTutorTurnResponseSchema>;

export const MixedInitiativeCommandRequestSchema = z
  .object({
    commandId: z.string().min(1),
    expectedSessionVersion: z.number().int().positive(),
    kind: z.enum([
      'detour',
      'return',
      'agenda_insert',
      'deep_dive',
      'direct_checkpoint',
      'defer',
      'promote_to_plan',
    ]),
    targetAgendaItemId: z.string().min(1).nullable(),
    /** Optional learner-selected Curriculum target for a bounded detour/insert. */
    targetLearningUnitId: z.string().min(1).nullable().optional(),
    requestedMinutes: z.number().int().min(1).max(240).optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type MixedInitiativeCommandRequest = z.infer<typeof MixedInitiativeCommandRequestSchema>;

export const StudySessionCommandEffectSchema = z
  .object({
    kind: MixedInitiativeCommandRequestSchema.shape.kind,
    affectedAgendaItemId: z.string().min(1).nullable(),
    /** A durable successor proposal; it never changes the accepted Plan by itself. */
    planChangeRequest: z
      .object({
        predecessorStudyPlanId: z.string().min(1),
        targetLearningUnitId: z.string().min(1).nullable(),
        reason: z.string().min(1).max(500),
        replanTriggerId: z.string().min(1),
        proposedStudyPlanId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type StudySessionCommandEffect = z.infer<typeof StudySessionCommandEffectSchema>;

export const MixedInitiativeCommandResponseSchema = z
  .object({
    session: StudySessionSchema,
    agenda: SessionAgendaSchema,
    effect: StudySessionCommandEffectSchema,
  })
  .strict();
export type MixedInitiativeCommandResponse = z.infer<typeof MixedInitiativeCommandResponseSchema>;

export const SessionExecutionCommandRequestSchema = z
  .object({
    commandId: z.string().min(1),
    expectedSessionVersion: z.number().int().positive(),
  })
  .strict();
export type SessionExecutionCommandRequest = z.infer<typeof SessionExecutionCommandRequestSchema>;

export const SessionExecutionCommandResponseSchema = z
  .object({
    session: StudySessionSchema,
    agenda: SessionAgendaSchema,
    courseExecutionVersion: z.number().int().nonnegative(),
  })
  .strict();
export type SessionExecutionCommandResponse = z.infer<typeof SessionExecutionCommandResponseSchema>;
