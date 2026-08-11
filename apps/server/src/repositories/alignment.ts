import {
  AlignmentProposalSchema,
  CanonicalConceptSchema,
  CanonicalMemberSchema,
  guessConceptLanguage,
  normalizeConceptKey,
  type AlignmentProposal,
  type AlignmentProposalStatus,
  type CanonicalConcept,
  type CanonicalConceptView,
  type CanonicalMember,
  type Concept,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { newId } from '../util/ids.js';

interface CanonicalRow {
  id: string;
  workspace_id: string;
  display_name: string;
  normalized_key: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  source_concept_id: string;
  canonical_concept_id: string;
  original_name: string;
  material_id: string;
  language: string;
  via_proposal_id: string | null;
  created_at: string;
}

interface ProposalRow {
  id: string;
  workspace_id: string;
  source_concept_id: string;
  target_concept_id: string;
  relation: string;
  proposed_canonical_name: string;
  rationale: string;
  evidence: string;
  origin: string;
  status: string;
  source_language: string;
  target_language: string;
  provider: string;
  created_at: string;
  decided_at: string | null;
}

function rowToCanonical(row: CanonicalRow): CanonicalConcept {
  return CanonicalConceptSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    normalizedKey: row.normalized_key,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToMember(row: MemberRow): CanonicalMember {
  return CanonicalMemberSchema.parse({
    sourceConceptId: row.source_concept_id,
    canonicalConceptId: row.canonical_concept_id,
    originalName: row.original_name,
    materialId: row.material_id,
    language: row.language,
    viaProposalId: row.via_proposal_id,
    createdAt: row.created_at,
  });
}

function rowToProposal(row: ProposalRow): AlignmentProposal {
  return AlignmentProposalSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    sourceConceptId: row.source_concept_id,
    targetConceptId: row.target_concept_id,
    relation: row.relation,
    proposedCanonicalName: row.proposed_canonical_name,
    rationale: row.rationale,
    evidence: JSON.parse(row.evidence),
    origin: row.origin,
    status: row.status,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    provider: row.provider,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  });
}

export function createAlignmentRepo(db: SqliteDb) {
  const insertCanonicalStmt = db.prepare(
    `INSERT INTO canonical_concepts (id, workspace_id, display_name, normalized_key, description, created_at, updated_at)
     VALUES (@id, @workspaceId, @displayName, @normalizedKey, @description, @createdAt, @updatedAt)`,
  );
  const insertMemberStmt = db.prepare(
    `INSERT INTO canonical_members (source_concept_id, canonical_concept_id, original_name, material_id, language, via_proposal_id, created_at)
     VALUES (@sourceConceptId, @canonicalConceptId, @originalName, @materialId, @language, @viaProposalId, @createdAt)`,
  );

  function membersOfCanonical(canonicalId: string): CanonicalMember[] {
    const rows = db
      .prepare(
        `SELECT cm.* FROM canonical_members cm
         JOIN materials m ON m.id = cm.material_id
         WHERE cm.canonical_concept_id = ? AND m.availability = 'active'
         ORDER BY cm.created_at ASC, cm.source_concept_id ASC`,
      )
      .all(canonicalId) as MemberRow[];
    return rows.map(rowToMember);
  }

  /**
   * Ensure every workspace concept has a canonical membership. New concepts
   * get a fresh singleton canonical (display name = concept name). Existing
   * memberships and merged canonicals are never touched — this is purely
   * additive and idempotent.
   */
  const ensureBaselineTx = db.transaction(
    (workspaceId: string, concepts: Concept[], at: string) => {
      const existing = new Set(
        (
          db
            .prepare(
              `SELECT cm.source_concept_id FROM canonical_members cm
               JOIN canonical_concepts cc ON cc.id = cm.canonical_concept_id
               WHERE cc.workspace_id = ?`,
            )
            .all(workspaceId) as Array<{ source_concept_id: string }>
        ).map((r) => r.source_concept_id),
      );
      for (const concept of concepts) {
        if (existing.has(concept.id)) continue;
        const canonicalId = newId('can');
        insertCanonicalStmt.run({
          id: canonicalId,
          workspaceId,
          displayName: concept.name,
          normalizedKey: normalizeConceptKey(concept.name),
          description: null,
          createdAt: at,
          updatedAt: at,
        });
        insertMemberStmt.run({
          sourceConceptId: concept.id,
          canonicalConceptId: canonicalId,
          originalName: concept.name,
          materialId: concept.materialId,
          language: guessConceptLanguage(concept.name),
          viaProposalId: null,
          createdAt: at,
        });
      }
    },
  );

  /**
   * Merge the canonical group of `sourceConceptId` INTO the canonical group
   * of `targetConceptId` (one transaction): move every member row, retarget
   * dangling proposals is NOT needed (proposals reference concepts), delete
   * the emptied canonical, and stamp the surviving canonical. Merging is a
   * union operation on disjoint sets — cycles are impossible by construction,
   * and merging a concept into its own group is a no-op.
   */
  const mergeTx = db.transaction(
    (
      sourceConceptId: string,
      targetConceptId: string,
      displayName: string,
      viaProposalId: string,
      at: string,
    ) => {
      const sourceMember = db
        .prepare('SELECT * FROM canonical_members WHERE source_concept_id = ?')
        .get(sourceConceptId) as MemberRow | undefined;
      const targetMember = db
        .prepare('SELECT * FROM canonical_members WHERE source_concept_id = ?')
        .get(targetConceptId) as MemberRow | undefined;
      if (!sourceMember || !targetMember) {
        throw new Error('合并前必须先建立两个概念的规范映射基线。');
      }
      const loserId = sourceMember.canonical_concept_id;
      const winnerId = targetMember.canonical_concept_id;
      if (loserId !== winnerId) {
        db.prepare(
          `UPDATE canonical_members SET canonical_concept_id = ?, via_proposal_id = ?
           WHERE canonical_concept_id = ?`,
        ).run(winnerId, viaProposalId, loserId);
        db.prepare('DELETE FROM canonical_concepts WHERE id = ?').run(loserId);
      }
      db.prepare(
        `UPDATE canonical_concepts SET display_name = ?, normalized_key = ?, updated_at = ?
         WHERE id = ?`,
      ).run(displayName, normalizeConceptKey(displayName), at, winnerId);
      return winnerId as string;
    },
  );

  return {
    ensureBaseline(workspaceId: string, concepts: Concept[], at: string): void {
      ensureBaselineTx(workspaceId, concepts, at);
    },

    listCanonical(workspaceId: string): CanonicalConceptView[] {
      const rows = db
        .prepare(
          `SELECT * FROM canonical_concepts WHERE workspace_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceId) as CanonicalRow[];
      return rows.flatMap((row) => {
        const canonical = rowToCanonical(row);
        const members = membersOfCanonical(row.id);
        if (members.length === 0) return [];
        const aliases = [
          ...new Set(members.map((m) => m.originalName).filter((n) => n !== canonical.displayName)),
        ].slice(0, 20);
        const materialIds = [...new Set(members.map((m) => m.materialId))];
        return [{ ...canonical, members, aliases, materialIds }];
      });
    },

    getCanonical(canonicalId: string): CanonicalConcept | undefined {
      const row = db.prepare('SELECT * FROM canonical_concepts WHERE id = ?').get(canonicalId) as
        CanonicalRow | undefined;
      return row ? rowToCanonical(row) : undefined;
    },

    /** Membership row of one source concept (undefined before baseline). */
    getMemberBySource(sourceConceptId: string): CanonicalMember | undefined {
      const row = db
        .prepare('SELECT * FROM canonical_members WHERE source_concept_id = ?')
        .get(sourceConceptId) as MemberRow | undefined;
      return row ? rowToMember(row) : undefined;
    },

    getMembers(canonicalId: string): CanonicalMember[] {
      return membersOfCanonical(canonicalId);
    },

    renameCanonical(
      canonicalId: string,
      displayName: string,
      at: string,
    ): CanonicalConcept | undefined {
      const changes = db
        .prepare(
          `UPDATE canonical_concepts SET display_name = ?, normalized_key = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(displayName, normalizeConceptKey(displayName), at, canonicalId).changes;
      if (changes === 0) return undefined;
      return this.getCanonical(canonicalId);
    },

    merge(
      sourceConceptId: string,
      targetConceptId: string,
      displayName: string,
      viaProposalId: string,
      at: string,
    ): string {
      return mergeTx(sourceConceptId, targetConceptId, displayName, viaProposalId, at) as string;
    },

    /**
     * Remove canonical concepts that lost their last member (their backing
     * source concepts were cascade-deleted with a document). Documented
     * policy: a canonical concept survives while at least one member exists;
     * deleting the final backing document removes it and its proposals go
     * with the deleted concepts via FK cascade.
     */
    pruneEmptyCanonicals(workspaceId: string): number {
      return db
        .prepare(
          `DELETE FROM canonical_concepts
           WHERE workspace_id = ?
             AND id NOT IN (SELECT canonical_concept_id FROM canonical_members)`,
        )
        .run(workspaceId).changes;
    },

    insertProposal(proposal: AlignmentProposal): void {
      AlignmentProposalSchema.parse(proposal);
      db.prepare(
        `INSERT INTO alignment_proposals
           (id, workspace_id, source_concept_id, target_concept_id, relation,
            proposed_canonical_name, rationale, evidence, origin, status,
            source_language, target_language, provider, created_at, decided_at)
         VALUES
           (@id, @workspaceId, @sourceConceptId, @targetConceptId, @relation,
            @proposedCanonicalName, @rationale, @evidence, @origin, @status,
            @sourceLanguage, @targetLanguage, @provider, @createdAt, @decidedAt)`,
      ).run({
        id: proposal.id,
        workspaceId: proposal.workspaceId,
        sourceConceptId: proposal.sourceConceptId,
        targetConceptId: proposal.targetConceptId,
        relation: proposal.relation,
        proposedCanonicalName: proposal.proposedCanonicalName,
        rationale: proposal.rationale,
        evidence: JSON.stringify(proposal.evidence),
        origin: proposal.origin,
        status: proposal.status,
        sourceLanguage: proposal.sourceLanguage,
        targetLanguage: proposal.targetLanguage,
        provider: proposal.provider,
        createdAt: proposal.createdAt,
        decidedAt: proposal.decidedAt,
      });
    },

    getProposal(id: string): AlignmentProposal | undefined {
      const row = db.prepare('SELECT * FROM alignment_proposals WHERE id = ?').get(id) as
        ProposalRow | undefined;
      return row ? rowToProposal(row) : undefined;
    },

    listProposals(workspaceId: string, status?: AlignmentProposalStatus): AlignmentProposal[] {
      const rows = (
        status
          ? db
              .prepare(
                `SELECT * FROM alignment_proposals WHERE workspace_id = ? AND status = ?
                 ORDER BY created_at ASC, id ASC`,
              )
              .all(workspaceId, status)
          : db
              .prepare(
                `SELECT * FROM alignment_proposals WHERE workspace_id = ?
                 ORDER BY created_at ASC, id ASC`,
              )
              .all(workspaceId)
      ) as ProposalRow[];
      return rows.map(rowToProposal);
    },

    /** Existing (workspace, source, target, relation) keys — for dedupe. */
    proposalPairKeys(workspaceId: string): Set<string> {
      const rows = db
        .prepare(
          'SELECT source_concept_id, target_concept_id, relation FROM alignment_proposals WHERE workspace_id = ?',
        )
        .all(workspaceId) as Array<{
        source_concept_id: string;
        target_concept_id: string;
        relation: string;
      }>;
      return new Set(
        rows.map((r) => `${r.source_concept_id}|${r.target_concept_id}|${r.relation}`),
      );
    },

    setProposalStatus(id: string, status: AlignmentProposalStatus, decidedAt: string): void {
      db.prepare('UPDATE alignment_proposals SET status = ?, decided_at = ? WHERE id = ?').run(
        status,
        decidedAt,
        id,
      );
    },
  };
}

export type AlignmentRepo = ReturnType<typeof createAlignmentRepo>;
