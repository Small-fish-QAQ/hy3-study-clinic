import {
  SourceAuthorityBundleSchema,
  SourceAuthorityClaimSchema,
  SourceAuthorityEventSchema,
  SourceAuthorityRecordSchema,
  SourceBlockSchema,
  type SourceAuthorityBundle,
  type SourceAuthorityClaim,
  type SourceAuthorityEvent,
  type SourceAuthorityPolicyBasis,
  type SourceAuthorityRecord,
  type SourceAuthorityValidationActor,
  type SourceBlock,
  type TruthAuthorityConflictState,
  type TruthAuthorityValidationState,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

export type AuthorityValidationState = TruthAuthorityValidationState;
export type AuthorityConflictState = TruthAuthorityConflictState;
export type {
  SourceAuthorityBundle,
  SourceAuthorityClaim,
  SourceAuthorityEvent,
  SourceAuthorityRecord,
};

export interface AuthorityRevisionContext {
  workspaceId: string;
  materialId: string;
  materialRevisionId: string;
  revisionStatus: 'candidate' | 'ready' | 'active' | 'failed' | 'retired';
  materialAvailability: 'active' | 'retired';
  blocks: SourceBlock[];
}

interface RecordRow {
  id: string;
  workspace_id: string;
  logical_source_id: string;
  material_id: string | null;
  material_revision_id: string | null;
  version: number;
  predecessor_id: string | null;
  premise_scope: string;
  policy_basis: string;
  validation_state: AuthorityValidationState;
  conflict_state: AuthorityConflictState;
  actor: string;
  created_at: string;
  updated_at: string;
}

interface ClaimRow {
  id: string;
  authority_record_id: string;
  source_block_id: string;
  claim: string;
  quote: string;
  start_offset: number;
  end_offset: number;
  occurrence_count: number;
  created_at: string;
}

interface EventRow {
  id: string;
  authority_record_id: string;
  seq: number;
  event_type: string;
  actor: string;
  payload: string;
  created_at: string;
}

interface BlockRow {
  id: string;
  material_id: string;
  idx: number;
  heading: string | null;
  heading_path: string;
  page_number: number | null;
  page_end: number | null;
  slide_number: number | null;
  content: string;
  start_offset: number;
  end_offset: number;
  content_origin:
    | 'extracted_original'
    | 'derived_ocr'
    | 'derived_visual_description'
    | 'derived_layout_label'
    | 'derived_summary'
    | null;
}

export interface CreateAuthorityVersionInput {
  id: string;
  workspaceId: string;
  logicalSourceId: string;
  materialId: string;
  materialRevisionId: string;
  predecessorId: string | null;
  premiseScope: string;
  policyBasis: SourceAuthorityPolicyBasis;
  validationState: AuthorityValidationState;
  conflictState: AuthorityConflictState;
  actor: SourceAuthorityValidationActor;
  createdAt: string;
  updatedAt: string;
  claims: Array<Omit<SourceAuthorityClaim, 'authorityRecordId'>>;
  event: Omit<SourceAuthorityEvent, 'authorityRecordId' | 'seq'>;
}

function toRecord(row: RecordRow): SourceAuthorityRecord {
  return SourceAuthorityRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    logicalSourceId: row.logical_source_id,
    materialId: row.material_id,
    materialRevisionId: row.material_revision_id,
    version: row.version,
    predecessorId: row.predecessor_id,
    premiseScope: row.premise_scope,
    policyBasis: JSON.parse(row.policy_basis) as unknown,
    validationState: row.validation_state,
    conflictState: row.conflict_state,
    actor: row.actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toClaim(row: ClaimRow): SourceAuthorityClaim {
  return SourceAuthorityClaimSchema.parse({
    id: row.id,
    authorityRecordId: row.authority_record_id,
    sourceBlockId: row.source_block_id,
    claim: row.claim,
    quote: row.quote,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    occurrenceCount: row.occurrence_count,
    createdAt: row.created_at,
  });
}

function toEvent(row: EventRow): SourceAuthorityEvent {
  return SourceAuthorityEventSchema.parse({
    id: row.id,
    authorityRecordId: row.authority_record_id,
    seq: row.seq,
    eventType: row.event_type,
    actor: row.actor,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  });
}

function toBlock(row: BlockRow): SourceBlock {
  return SourceBlockSchema.parse({
    id: row.id,
    materialId: row.material_id,
    index: row.idx,
    heading: row.heading,
    headingPath: JSON.parse(row.heading_path) as string[],
    pageNumber: row.page_number,
    pageEnd: row.page_end,
    slideNumber: row.slide_number,
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    ...(row.content_origin ? { contentOrigin: row.content_origin } : {}),
  });
}

export function createSourceAuthorityRepo(db: SqliteDb) {
  const insertRecord = db.prepare(`
    INSERT INTO truth_authority_records (
      id, workspace_id, logical_source_id, material_id, material_revision_id,
      version, predecessor_id, premise_scope, policy_basis, validation_state,
      conflict_state, actor, created_at, updated_at
    ) VALUES (
      @id, @workspaceId, @logicalSourceId, @materialId, @materialRevisionId,
      @version, @predecessorId, @premiseScope, @policyBasis, @validationState,
      @conflictState, @actor, @createdAt, @updatedAt
    )
  `);
  const insertClaim = db.prepare(`
    INSERT INTO truth_authority_claims (
      id, authority_record_id, source_block_id, claim, quote, start_offset,
      end_offset, occurrence_count, created_at
    ) VALUES (
      @id, @authorityRecordId, @sourceBlockId, @claim, @quote, @startOffset,
      @endOffset, @occurrenceCount, @createdAt
    )
  `);
  const insertEvent = db.prepare(`
    INSERT INTO truth_authority_events (
      id, authority_record_id, seq, event_type, actor, payload, created_at
    ) VALUES (@id, @authorityRecordId, @seq, @eventType, @actor, @payload, @createdAt)
  `);

  function getRecord(id: string): SourceAuthorityRecord | undefined {
    const row = db.prepare('SELECT * FROM truth_authority_records WHERE id = ?').get(id) as
      RecordRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  function getClaims(authorityRecordId: string): SourceAuthorityClaim[] {
    return (
      db
        .prepare(
          'SELECT * FROM truth_authority_claims WHERE authority_record_id = ? ORDER BY created_at, id',
        )
        .all(authorityRecordId) as ClaimRow[]
    ).map(toClaim);
  }

  function getEvents(authorityRecordId: string): SourceAuthorityEvent[] {
    return (
      db
        .prepare('SELECT * FROM truth_authority_events WHERE authority_record_id = ? ORDER BY seq')
        .all(authorityRecordId) as EventRow[]
    ).map(toEvent);
  }

  function chunks<T>(items: readonly T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size));
    }
    return result;
  }

  function hydrateBundlesInBatches(rows: readonly RecordRow[]): SourceAuthorityBundle[] {
    if (rows.length === 0) return [];
    const claimsByRecord = new Map<string, SourceAuthorityClaim[]>();
    const eventsByRecord = new Map<string, SourceAuthorityEvent[]>();
    for (const batch of chunks(
      rows.map((row) => row.id),
      500,
    )) {
      const placeholders = batch.map(() => '?').join(', ');
      const claims = (
        db
          .prepare(
            `SELECT * FROM truth_authority_claims
             WHERE authority_record_id IN (${placeholders})
             ORDER BY authority_record_id, created_at, id`,
          )
          .all(...batch) as ClaimRow[]
      ).map(toClaim);
      for (const claim of claims) {
        const current = claimsByRecord.get(claim.authorityRecordId) ?? [];
        current.push(claim);
        claimsByRecord.set(claim.authorityRecordId, current);
      }
      const events = (
        db
          .prepare(
            `SELECT * FROM truth_authority_events
             WHERE authority_record_id IN (${placeholders})
             ORDER BY authority_record_id, seq`,
          )
          .all(...batch) as EventRow[]
      ).map(toEvent);
      for (const event of events) {
        const current = eventsByRecord.get(event.authorityRecordId) ?? [];
        current.push(event);
        eventsByRecord.set(event.authorityRecordId, current);
      }
    }
    return rows.map((row) =>
      SourceAuthorityBundleSchema.parse({
        record: toRecord(row),
        claims: claimsByRecord.get(row.id) ?? [],
        events: eventsByRecord.get(row.id) ?? [],
      }),
    );
  }

  const createVersionTransaction = db.transaction(
    (input: CreateAuthorityVersionInput): SourceAuthorityBundle => {
      const latest = db
        .prepare(
          `SELECT id, version FROM truth_authority_records
           WHERE logical_source_id = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(input.logicalSourceId) as { id: string; version: number } | undefined;

      if (input.predecessorId === null && latest) {
        throw new Error('Authority source already has version history; a predecessor is required.');
      }
      if (input.predecessorId !== null && latest?.id !== input.predecessorId) {
        throw new Error('Authority predecessor is stale.');
      }

      const version = (latest?.version ?? 0) + 1;
      insertRecord.run({ ...input, version, policyBasis: JSON.stringify(input.policyBasis) });
      for (const claim of input.claims) {
        insertClaim.run({ ...claim, authorityRecordId: input.id });
      }
      insertEvent.run({
        ...input.event,
        authorityRecordId: input.id,
        seq: 1,
        payload: JSON.stringify(input.event.payload ?? {}),
      });
      return SourceAuthorityBundleSchema.parse({
        record: getRecord(input.id)!,
        claims: getClaims(input.id),
        events: getEvents(input.id),
      });
    },
  );

  return {
    get(id: string): SourceAuthorityRecord | undefined {
      return getRecord(id);
    },

    getBundle(id: string): SourceAuthorityBundle | undefined {
      const record = getRecord(id);
      return record
        ? SourceAuthorityBundleSchema.parse({
            record,
            claims: getClaims(id),
            events: getEvents(id),
          })
        : undefined;
    },

    listHistory(logicalSourceId: string): SourceAuthorityBundle[] {
      const rows = db
        .prepare(
          'SELECT * FROM truth_authority_records WHERE logical_source_id = ? ORDER BY version',
        )
        .all(logicalSourceId) as RecordRow[];
      return rows.map((row) =>
        SourceAuthorityBundleSchema.parse({
          record: toRecord(row),
          claims: getClaims(row.id),
          events: getEvents(row.id),
        }),
      );
    },

    createVersion(input: CreateAuthorityVersionInput): SourceAuthorityBundle {
      return createVersionTransaction(input);
    },

    appendEvent(
      authorityRecordId: string,
      event: Omit<SourceAuthorityEvent, 'authorityRecordId' | 'seq'>,
    ): SourceAuthorityEvent {
      const append = db.transaction(() => {
        const record = getRecord(authorityRecordId);
        if (!record) throw new Error('Authority record does not exist.');
        const row = db
          .prepare(
            'SELECT COALESCE(MAX(seq), 0) AS seq FROM truth_authority_events WHERE authority_record_id = ?',
          )
          .get(authorityRecordId) as { seq: number };
        insertEvent.run({
          ...event,
          authorityRecordId,
          seq: row.seq + 1,
          payload: JSON.stringify(event.payload ?? {}),
        });
        return getEvents(authorityRecordId).at(-1)!;
      });
      return append();
    },

    getRevisionContext(
      workspaceId: string,
      materialId: string,
      materialRevisionId: string,
    ): AuthorityRevisionContext | undefined {
      const revision = db
        .prepare(
          `SELECT m.workspace_id, m.availability, mr.id, mr.status
           FROM material_revisions mr
           JOIN materials m ON m.id = mr.material_id
           WHERE mr.id = ? AND mr.material_id = ? AND m.workspace_id = ?`,
        )
        .get(materialRevisionId, materialId, workspaceId) as
        | {
            workspace_id: string;
            availability: AuthorityRevisionContext['materialAvailability'];
            id: string;
            status: AuthorityRevisionContext['revisionStatus'];
          }
        | undefined;
      if (!revision) return undefined;

      const blocks = (
        db
          .prepare(
            `SELECT id, material_id, idx, heading, heading_path, page_number,
                    page_end, content, start_offset, end_offset, content_origin
             FROM source_blocks
             WHERE material_id = ? AND material_revision_id = ?
             ORDER BY idx`,
          )
          .all(materialId, materialRevisionId) as BlockRow[]
      ).map(toBlock);
      return {
        workspaceId: revision.workspace_id,
        materialId,
        materialRevisionId: revision.id,
        revisionStatus: revision.status,
        materialAvailability: revision.availability,
        blocks,
      };
    },

    isBlockingEligible(authorityRecordId: string): boolean {
      const row = db
        .prepare(
          `SELECT EXISTS(
             SELECT 1 FROM truth_authority_records r
             JOIN material_revisions mr ON mr.id = r.material_revision_id
             JOIN materials m ON m.id = r.material_id
             WHERE r.id = ?
               AND r.validation_state = 'validated'
               AND r.conflict_state IN ('none', 'resolved')
               AND mr.status = 'active'
               AND m.availability = 'active'
               AND m.active_revision_id = mr.id
               AND EXISTS(
                 SELECT 1
                 FROM truth_authority_claims c
                 JOIN source_blocks b ON b.id = c.source_block_id
                 WHERE c.authority_record_id = r.id
                   AND (b.content_origin IS NULL OR b.content_origin = 'extracted_original')
               )
           ) AS eligible`,
        )
        .get(authorityRecordId) as { eligible: number };
      return row.eligible === 1;
    },

    findEligibleByBlock(
      workspaceId: string,
      materialRevisionId: string,
      sourceBlockId: string,
    ): SourceAuthorityBundle[] {
      const rows = db
        .prepare(
          `SELECT DISTINCT r.*
           FROM truth_authority_records r
           JOIN truth_authority_claims c ON c.authority_record_id = r.id
           JOIN material_revisions mr ON mr.id = r.material_revision_id
           JOIN materials m ON m.id = r.material_id
           JOIN source_blocks b ON b.id = c.source_block_id
           WHERE r.workspace_id = ?
             AND r.material_revision_id = ?
             AND c.source_block_id = ?
             AND b.material_revision_id = r.material_revision_id
             AND (b.content_origin IS NULL OR b.content_origin = 'extracted_original')
             AND r.validation_state = 'validated'
             AND r.conflict_state IN ('none', 'resolved')
             AND mr.status = 'active'
             AND m.availability = 'active'
             AND m.active_revision_id = mr.id
           ORDER BY r.logical_source_id, r.version DESC, r.id`,
        )
        .all(workspaceId, materialRevisionId, sourceBlockId) as RecordRow[];
      return rows.map((row) =>
        SourceAuthorityBundleSchema.parse({
          record: toRecord(row),
          claims: getClaims(row.id),
          events: getEvents(row.id),
        }),
      );
    },

    /**
     * Batch equivalent of taking the union of `findEligibleByBlock` across
     * every original SourceBlock in the supplied active revisions.
     */
    findEligibleByRevisions(
      workspaceId: string,
      materialRevisionIds: readonly string[],
    ): SourceAuthorityBundle[] {
      const revisionIds = [...new Set(materialRevisionIds)];
      if (revisionIds.length === 0) return [];
      const placeholders = revisionIds.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT DISTINCT r.*
           FROM truth_authority_records r
           JOIN truth_authority_claims c ON c.authority_record_id = r.id
           JOIN material_revisions mr ON mr.id = r.material_revision_id
           JOIN materials m ON m.id = r.material_id
           JOIN source_blocks b ON b.id = c.source_block_id
           WHERE r.workspace_id = ?
             AND r.material_revision_id IN (${placeholders})
             AND b.material_revision_id = r.material_revision_id
             AND (b.content_origin IS NULL OR b.content_origin = 'extracted_original')
             AND r.validation_state = 'validated'
             AND r.conflict_state IN ('none', 'resolved')
             AND mr.status = 'active'
             AND m.availability = 'active'
             AND m.active_revision_id = mr.id
           ORDER BY r.logical_source_id, r.version DESC, r.id`,
        )
        .all(workspaceId, ...revisionIds) as RecordRow[];
      return hydrateBundlesInBatches(rows);
    },
  };
}

export type SourceAuthorityRepo = ReturnType<typeof createSourceAuthorityRepo>;
