import { ApiErrorCode, ProposedGroundingSchema } from '@hy3-clinic/shared';
import { z } from 'zod';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import type {
  AuthorityConflictState,
  SourceAuthorityBundle,
  SourceAuthorityClaim,
  SourceAuthorityRepo,
} from '../repositories/sourceAuthority.js';
import { newId, type Clock } from '../util/ids.js';

const ValidationActorSchema = z.enum(['local_validator', 'operator']);
export type SourceAuthorityValidationActor = z.infer<typeof ValidationActorSchema>;

const PolicyBasisSchema = z
  .object({
    policyVersion: z.string().min(1).max(100),
    premiseKind: z.enum([
      'claim',
      'definition',
      'expected_answer',
      'rubric_point',
      'notation',
      'representation_equivalence',
      'source_stated_boundary',
    ]),
    basis: z.string().min(1).max(1000),
  })
  .strict();

const CreateCandidateSchema = z
  .object({
    workspaceId: z.string().min(1),
    logicalSourceId: z.string().min(1),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    premiseScope: z.string().min(1).max(500),
    policyBasis: PolicyBasisSchema,
    predecessorId: z.string().min(1).nullable().default(null),
    expectedVersion: z.number().int().positive().optional(),
    conflictState: z.enum(['none', 'unresolved']).default('none'),
    actor: ValidationActorSchema,
    claims: z
      .array(
        z
          .object({
            claim: z.string().min(1).max(1000),
            grounding: ProposedGroundingSchema,
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.predecessorId === null) !== (value.expectedVersion === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['predecessorId'],
        message: 'predecessorId and expectedVersion must be supplied together',
      });
    }
  });

export type CreateSourceAuthorityCandidateInput = z.input<typeof CreateCandidateSchema>;

export interface BlockingAuthorityDecision {
  eligible: boolean;
  reason:
    | 'validated_authority'
    | 'candidate_not_validated'
    | 'authority_rejected'
    | 'authority_stale'
    | 'unresolved_conflict'
    | 'missing_verified_claims';
}

export interface SourceAuthorityServiceDeps {
  sourceAuthority: SourceAuthorityRepo;
  clock: Clock;
}

/**
 * Independent truth/premise admission. There is deliberately no Contract,
 * Curriculum, Plan, or material-role acceptance dependency here: learner
 * scope decisions cannot invoke this write path or validate their own claims.
 */
export function createSourceAuthorityService({
  sourceAuthority,
  clock,
}: SourceAuthorityServiceDeps) {
  function requireBundle(recordId: string): SourceAuthorityBundle {
    const bundle = sourceAuthority.getBundle(recordId);
    if (!bundle) throw notFound(`Truth-authority record does not exist: ${recordId}`);
    return bundle;
  }

  function requireActor(actor: unknown): SourceAuthorityValidationActor {
    const parsed = ValidationActorSchema.safeParse(actor);
    if (!parsed.success) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Learner scope authority cannot create or validate truth authority.',
      );
    }
    return parsed.data;
  }

  function requireExpectedVersion(bundle: SourceAuthorityBundle, expectedVersion: number): void {
    if (bundle.record.version !== expectedVersion) {
      throw new AppError(ApiErrorCode.ValidationError, 'Truth-authority version is stale.', {
        expectedVersion,
        currentVersion: bundle.record.version,
      });
    }
  }

  function copyClaims(
    claims: SourceAuthorityClaim[],
    createdAt: string,
  ): Array<Omit<SourceAuthorityClaim, 'authorityRecordId'>> {
    return claims.map((claim) => ({
      id: newId('tac'),
      sourceBlockId: claim.sourceBlockId,
      claim: claim.claim,
      quote: claim.quote,
      startOffset: claim.startOffset,
      endOffset: claim.endOffset,
      occurrenceCount: claim.occurrenceCount,
      createdAt,
    }));
  }

  function requireCurrentRevision(bundle: SourceAuthorityBundle): void {
    const { record, claims } = bundle;
    if (!record.materialId || !record.materialRevisionId) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Truth authority lacks exact MaterialRevision provenance.',
      );
    }
    const revision = sourceAuthority.getRevisionContext(
      record.workspaceId,
      record.materialId,
      record.materialRevisionId,
    );
    if (
      !revision ||
      revision.materialAvailability !== 'active' ||
      revision.revisionStatus !== 'active'
    ) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Truth authority is stale because its exact MaterialRevision is no longer active.',
      );
    }
    for (const claim of claims) {
      const verification = verifyGrounding(revision.blocks, {
        blockId: claim.sourceBlockId,
        quote: claim.quote,
      });
      if (
        !verification.ok ||
        verification.grounding.blockId !== claim.sourceBlockId ||
        verification.grounding.startOffset !== claim.startOffset ||
        verification.grounding.endOffset !== claim.endOffset
      ) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          'Persisted truth claim no longer resolves to its exact revision-owned SourceBlock.',
        );
      }
    }
  }

  function successor(
    current: SourceAuthorityBundle,
    input: {
      actor: SourceAuthorityValidationActor;
      validationState: 'candidate' | 'validated' | 'rejected' | 'stale';
      conflictState: AuthorityConflictState;
      eventType: string;
      payload: unknown;
    },
  ): SourceAuthorityBundle {
    const { record } = current;
    if (!record.materialId || !record.materialRevisionId) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Truth authority without exact material revision provenance cannot be versioned.',
      );
    }
    const now = clock.now().toISOString();
    return sourceAuthority.createVersion({
      id: newId('ta'),
      workspaceId: record.workspaceId,
      logicalSourceId: record.logicalSourceId,
      materialId: record.materialId,
      materialRevisionId: record.materialRevisionId,
      predecessorId: record.id,
      premiseScope: record.premiseScope,
      policyBasis: record.policyBasis,
      validationState: input.validationState,
      conflictState: input.conflictState,
      actor: input.actor,
      createdAt: now,
      updatedAt: now,
      claims: copyClaims(current.claims, now),
      event: {
        id: newId('tae'),
        eventType: input.eventType,
        actor: input.actor,
        payload: input.payload,
        createdAt: now,
      },
    });
  }

  return {
    createCandidate(input: unknown): SourceAuthorityBundle {
      let parsed: z.output<typeof CreateCandidateSchema>;
      try {
        parsed = CreateCandidateSchema.parse(input);
      } catch (error) {
        if (
          typeof input === 'object' &&
          input !== null &&
          'actor' in input &&
          !ValidationActorSchema.safeParse((input as { actor: unknown }).actor).success
        ) {
          requireActor((input as { actor: unknown }).actor);
        }
        throw error;
      }

      const revision = sourceAuthority.getRevisionContext(
        parsed.workspaceId,
        parsed.materialId,
        parsed.materialRevisionId,
      );
      if (!revision) {
        throw notFound('The exact MaterialRevision does not belong to this Course and Material.');
      }
      if (revision.materialAvailability !== 'active' || revision.revisionStatus !== 'active') {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Only the accepted active MaterialRevision can admit blocking source truth.',
        );
      }
      if (revision.blocks.length === 0) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          'The MaterialRevision has no revision-owned SourceBlocks.',
        );
      }

      const now = clock.now().toISOString();
      const claims: Array<Omit<SourceAuthorityClaim, 'authorityRecordId'>> = [];
      const dedupe = new Set<string>();
      for (const proposed of parsed.claims) {
        const verification = verifyGrounding(revision.blocks, proposed.grounding);
        if (!verification.ok) {
          throw new AppError(ApiErrorCode.GroundingFailed, verification.message, {
            reason: verification.reason,
          });
        }
        const grounding = verification.grounding;
        const key = `${proposed.claim.trim()}\u0000${grounding.blockId}\u0000${grounding.startOffset}\u0000${grounding.endOffset}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        claims.push({
          id: newId('tac'),
          sourceBlockId: grounding.blockId,
          claim: proposed.claim.trim(),
          quote: grounding.quote,
          startOffset: grounding.startOffset,
          endOffset: grounding.endOffset,
          occurrenceCount: grounding.occurrenceCount,
          createdAt: now,
        });
      }
      if (claims.length === 0) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          'No unique verified claims were supplied.',
        );
      }

      if (parsed.predecessorId !== null) {
        const predecessor = requireBundle(parsed.predecessorId);
        requireExpectedVersion(predecessor, parsed.expectedVersion!);
        if (
          predecessor.record.logicalSourceId !== parsed.logicalSourceId ||
          predecessor.record.workspaceId !== parsed.workspaceId
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Authority predecessor belongs to a different logical source or Course.',
          );
        }
      }

      return sourceAuthority.createVersion({
        id: newId('ta'),
        workspaceId: parsed.workspaceId,
        logicalSourceId: parsed.logicalSourceId,
        materialId: parsed.materialId,
        materialRevisionId: parsed.materialRevisionId,
        predecessorId: parsed.predecessorId,
        premiseScope: parsed.premiseScope,
        policyBasis: JSON.stringify(parsed.policyBasis),
        validationState: 'candidate',
        conflictState: parsed.conflictState,
        actor: parsed.actor,
        createdAt: now,
        updatedAt: now,
        claims,
        event: {
          id: newId('tae'),
          eventType: 'candidate_created',
          actor: parsed.actor,
          payload: {
            materialId: parsed.materialId,
            materialRevisionId: parsed.materialRevisionId,
            verifiedClaimCount: claims.length,
            predecessorId: parsed.predecessorId,
          },
          createdAt: now,
        },
      });
    },

    validate(
      recordId: string,
      expectedVersion: number,
      actorInput: unknown,
    ): SourceAuthorityBundle {
      const actor = requireActor(actorInput);
      const current = requireBundle(recordId);
      requireExpectedVersion(current, expectedVersion);
      requireCurrentRevision(current);
      if (current.record.conflictState === 'unresolved') {
        sourceAuthority.appendEvent(recordId, {
          id: newId('tae'),
          eventType: 'validation_blocked',
          actor,
          payload: { reason: 'unresolved_conflict' },
          createdAt: clock.now().toISOString(),
        });
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Unresolved source conflict blocks truth/premise validation.',
        );
      }
      if (current.claims.length === 0) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          'Truth authority requires at least one exact verified SourceBlock claim.',
        );
      }
      return successor(current, {
        actor,
        validationState: 'validated',
        conflictState: current.record.conflictState,
        eventType: 'validated',
        payload: { predecessorId: current.record.id },
      });
    },

    markConflict(
      recordId: string,
      expectedVersion: number,
      reason: string,
      actorInput: unknown,
    ): SourceAuthorityBundle {
      const actor = requireActor(actorInput);
      const current = requireBundle(recordId);
      requireExpectedVersion(current, expectedVersion);
      if (reason.trim().length === 0) {
        throw new AppError(ApiErrorCode.ValidationError, 'Conflict reason is required.');
      }
      return successor(current, {
        actor,
        validationState: 'candidate',
        conflictState: 'unresolved',
        eventType: 'conflict_marked',
        payload: { reason: reason.trim() },
      });
    },

    resolveConflict(
      recordId: string,
      expectedVersion: number,
      resolution: string,
      actorInput: unknown,
    ): SourceAuthorityBundle {
      const actor = requireActor(actorInput);
      const current = requireBundle(recordId);
      requireExpectedVersion(current, expectedVersion);
      if (current.record.conflictState !== 'unresolved') {
        throw new AppError(ApiErrorCode.ValidationError, 'There is no unresolved conflict.');
      }
      if (resolution.trim().length === 0) {
        throw new AppError(ApiErrorCode.ValidationError, 'Conflict resolution is required.');
      }
      return successor(current, {
        actor,
        validationState: 'candidate',
        conflictState: 'resolved',
        eventType: 'conflict_resolved',
        payload: { resolution: resolution.trim() },
      });
    },

    blockingDecision(recordId: string): BlockingAuthorityDecision {
      const bundle = requireBundle(recordId);
      if (bundle.record.conflictState === 'unresolved') {
        return { eligible: false, reason: 'unresolved_conflict' };
      }
      if (bundle.claims.length === 0) {
        return { eligible: false, reason: 'missing_verified_claims' };
      }
      if (bundle.record.validationState === 'candidate') {
        return { eligible: false, reason: 'candidate_not_validated' };
      }
      if (bundle.record.validationState === 'rejected') {
        return { eligible: false, reason: 'authority_rejected' };
      }
      if (bundle.record.validationState === 'stale') {
        return { eligible: false, reason: 'authority_stale' };
      }
      try {
        requireCurrentRevision(bundle);
      } catch {
        return { eligible: false, reason: 'authority_stale' };
      }
      return sourceAuthority.isBlockingEligible(recordId)
        ? { eligible: true, reason: 'validated_authority' }
        : { eligible: false, reason: 'missing_verified_claims' };
    },

    get(recordId: string): SourceAuthorityBundle {
      return requireBundle(recordId);
    },

    history(logicalSourceId: string): SourceAuthorityBundle[] {
      return sourceAuthority.listHistory(logicalSourceId);
    },
  };
}

export type SourceAuthorityService = ReturnType<typeof createSourceAuthorityService>;
