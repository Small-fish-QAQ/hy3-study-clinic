import { SourceBlockSchema, type SourceBlock } from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

export type AuthorityValidationState = 'candidate' | 'validated' | 'rejected' | 'stale';
export type AuthorityConflictState = 'none' | 'unresolved' | 'resolved';

export interface SourceAuthorityRecord {
  id: string;
  workspaceId: string;
  logicalSourceId: string;
  materialId: string | null;
  materialRevisionId: string | null;
  version: number;
  predecessorId: string | null;
  premiseScope: string;
  /** Structured JSON owned by the service (policy version, kind, and basis). */
  policyBasis: string;
  validationState: AuthorityValidationState;
  conflictState: AuthorityConflictState;
  actor: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceAuthorityClaim {
  id: string;
  authorityRecordId: string;
  sourceBlockId: string;
  claim: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  occurrenceCount: number;
  createdAt: string;
}

export interface SourceAuthorityEvent {
  id: string;
  authorityRecordId: string;
  seq: number;
  eventType: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

export interface SourceAuthorityBundle {
  record: SourceAuthorityRecord;
  claims: SourceAuthorityClaim[];
  events: SourceAuthorityEvent[];
}

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
  content: string;
  start_offset: number;
  end_offset: number;
}

export interface CreateAuthorityVersionInput {
  id: string;
  workspaceId: string;
  logicalSourceId: string;
  materialId: string;
  materialRevisionId: string;
  predecessorId: string | null;
  premiseScope: string;
  policyBasis: string;
  validationState: AuthorityValidationState;
  conflictState: AuthorityConflictState;
  actor: string;
  createdAt: string;
  updatedAt: string;
  claims: Array<Omit<SourceAuthorityClaim, 'authorityRecordId'>>;
  event: Omit<SourceAuthorityEvent, 'authorityRecordId' | 'seq'>;
}

function toRecord(row: RecordRow): SourceAuthorityRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    logicalSourceId: row.logical_source_id,
    materialId: row.material_id,
    materialRevisionId: row.material_revision_id,
    version: row.version,
    predecessorId: row.predecessor_id,
    premiseScope: row.premise_scope,
    policyBasis: row.policy_basis,
    validationState: row.validation_state,
    conflictState: row.conflict_state,
    actor: row.actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toClaim(row: ClaimRow): SourceAuthorityClaim {
  return {
    id: row.id,
    authorityRecordId: row.authority_record_id,
    sourceBlockId: row.source_block_id,
    claim: row.claim,
    quote: row.quote,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    occurrenceCount: row.occurrence_count,
    createdAt: row.created_at,
  };
}

function toEvent(row: EventRow): SourceAuthorityEvent {
  return {
    id: row.id,
    authorityRecordId: row.authority_record_id,
    seq: row.seq,
    eventType: row.event_type,
    actor: row.actor,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
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
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
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
      insertRecord.run({ ...input, version });
      for (const claim of input.claims) {
        insertClaim.run({ ...claim, authorityRecordId: input.id });
      }
      insertEvent.run({
        ...input.event,
        authorityRecordId: input.id,
        seq: 1,
        payload: JSON.stringify(input.event.payload ?? {}),
      });
      return {
        record: getRecord(input.id)!,
        claims: getClaims(input.id),
        events: getEvents(input.id),
      };
    },
  );

  return {
    get(id: string): SourceAuthorityRecord | undefined {
      return getRecord(id);
    },

    getBundle(id: string): SourceAuthorityBundle | undefined {
      const record = getRecord(id);
      return record ? { record, claims: getClaims(id), events: getEvents(id) } : undefined;
    },

    listHistory(logicalSourceId: string): SourceAuthorityBundle[] {
      const rows = db
        .prepare(
          'SELECT * FROM truth_authority_records WHERE logical_source_id = ? ORDER BY version',
        )
        .all(logicalSourceId) as RecordRow[];
      return rows.map((row) => ({
        record: toRecord(row),
        claims: getClaims(row.id),
        events: getEvents(row.id),
      }));
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
                    page_end, content, start_offset, end_offset
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
                 SELECT 1 FROM truth_authority_claims c WHERE c.authority_record_id = r.id
               )
           ) AS eligible`,
        )
        .get(authorityRecordId) as { eligible: number };
      return row.eligible === 1;
    },
  };
}

export type SourceAuthorityRepo = ReturnType<typeof createSourceAuthorityRepo>;
