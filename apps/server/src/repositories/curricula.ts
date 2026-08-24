import {
  CurriculumSchema,
  CurriculumSemanticEvaluationSchema,
  ExecutionSourceManifestSchema,
  ObjectiveAuthoritySemanticSupportSchema,
  type Curriculum,
  type CurriculumObjective,
  type ExecutionSourceManifest,
  type ObjectiveAuthoritySemanticSupport,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { fingerprintCurriculumCapabilitySourceEnvelope } from '../services/curriculumCapabilityRecovery.js';
import {
  assertCurriculumObjectiveAuthoritySemanticSupport,
  curriculumObjectiveProposition,
  fingerprintObjectiveAuthorityProposition,
} from '../services/objectiveAuthoritySemanticSupport.js';

interface CurriculumRow {
  id: string;
  workspace_id: string;
  contract_id: string;
  manifest_id: string;
  manifest_fingerprint: string;
  version: number;
  predecessor_id: string | null;
  status: Curriculum['status'];
  payload: string;
  created_at: string;
  accepted_at: string | null;
}

interface ManifestRow {
  id: string;
  workspace_id: string;
  fingerprint: string;
  payload: string;
  created_at: string;
}

export interface StoredExecutionSourceManifest {
  id: string;
  workspaceId: string;
  manifest: ExecutionSourceManifest;
  createdAt: string;
}

export interface CurriculumEventInput {
  id: string;
  eventType: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

export interface CurriculumVersionPersistenceContext {
  /**
   * Locally computed by CurriculumService before provider work. A non-null
   * value makes the complete accepted-predecessor capability frontier
   * mandatory at the atomic persistence boundary.
   */
  capabilityRecoveryPredecessorId: string | null;
}

export interface StoredCurriculumEvent extends CurriculumEventInput {
  curriculumId: string;
  seq: number;
}

interface CurriculumEventRow {
  curriculum_id: string;
  seq: number;
  event_type: string;
  actor: string;
  payload: string;
  created_at: string;
}

export class CurriculumExactAuthorityClaimHydrationError extends Error {
  constructor() {
    super('Curriculum references a missing or inexact authority claim ownership.');
    this.name = 'CurriculumExactAuthorityClaimHydrationError';
  }
}

export class CurriculumCapabilityRecoveryLineageError extends Error {
  constructor() {
    super('Curriculum capability-recovery lineage does not match its accepted predecessor.');
    this.name = 'CurriculumCapabilityRecoveryLineageError';
  }
}

function withoutSemanticSupport(curriculum: Curriculum): Curriculum {
  return {
    ...curriculum,
    nodes: curriculum.nodes.map((node) =>
      node.learningUnit
        ? {
            ...node,
            learningUnit: {
              ...node.learningUnit,
              objectives: node.learningUnit.objectives.map(
                ({ semanticSupport: _, ...objective }) => objective,
              ),
            },
          }
        : node,
    ),
  };
}

function hydrate(
  row: CurriculumRow,
  semanticSupportByObjectiveId: ReadonlyMap<string, ObjectiveAuthoritySemanticSupport>,
): Curriculum {
  const aggregate = CurriculumSchema.parse({
    ...(JSON.parse(row.payload) as object),
    id: row.id,
    workspaceId: row.workspace_id,
    contractVersionId: row.contract_id,
    version: row.version,
    predecessorId: row.predecessor_id,
    status: row.status,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
  });
  const aggregateObjectiveIds = new Set(
    aggregate.nodes.flatMap(
      (node) => node.learningUnit?.objectives.map((objective) => objective.id) ?? [],
    ),
  );
  for (const objectiveId of semanticSupportByObjectiveId.keys()) {
    if (!aggregateObjectiveIds.has(objectiveId)) {
      throw new Error('Persisted semantic support references an unknown Curriculum objective.');
    }
  }
  return CurriculumSchema.parse({
    ...aggregate,
    nodes: aggregate.nodes.map((node) =>
      node.learningUnit
        ? {
            ...node,
            learningUnit: {
              ...node.learningUnit,
              objectives: node.learningUnit.objectives.map(
                ({ semanticSupport: _, ...objective }) => {
                  const semanticSupport = semanticSupportByObjectiveId.get(objective.id);
                  return semanticSupport ? { ...objective, semanticSupport } : objective;
                },
              ),
            },
          }
        : node,
    ),
  });
}

function hydrateManifest(row: ManifestRow): StoredExecutionSourceManifest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    manifest: ExecutionSourceManifestSchema.parse(JSON.parse(row.payload) as unknown),
    createdAt: row.created_at,
  };
}

interface CurriculumQualityEvaluationRow {
  curriculum_id: string;
  payload: string;
}

interface ObjectiveSemanticSupportRow {
  curriculum_id: string;
  objective_id: string;
  policy_version: string;
  evaluator: string;
  provider: string;
  provider_model: string | null;
  status: ObjectiveAuthoritySemanticSupport['verdict'];
  proposition_fingerprint: string;
  binding_fingerprint: string;
  payload: string;
  evaluated_at: string;
}

export function createCurriculaRepo(db: SqliteDb) {
  const isAuthorityBlockingEligible = (authorityRecordId: string): boolean => {
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
  };

  function getObjectiveSemanticSupport(curriculumId: string): ObjectiveAuthoritySemanticSupport[] {
    return (
      db
        .prepare(
          `SELECT curriculum_id, objective_id, policy_version, evaluator, provider,
                  provider_model, status, proposition_fingerprint, binding_fingerprint,
                  payload, evaluated_at
           FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? ORDER BY objective_id`,
        )
        .all(curriculumId) as ObjectiveSemanticSupportRow[]
    ).map((row) => {
      const semanticSupport = ObjectiveAuthoritySemanticSupportSchema.parse(
        JSON.parse(row.payload) as unknown,
      );
      if (
        semanticSupport.objectiveId !== row.objective_id ||
        semanticSupport.policyVersion !== row.policy_version ||
        semanticSupport.evaluator !== row.evaluator ||
        semanticSupport.provider !== row.provider ||
        semanticSupport.providerModel !== row.provider_model ||
        semanticSupport.verdict !== row.status ||
        semanticSupport.propositionFingerprint !== row.proposition_fingerprint ||
        semanticSupport.bindingFingerprint !== row.binding_fingerprint ||
        semanticSupport.evaluatedAt !== row.evaluated_at
      ) {
        throw new Error('Persisted objective semantic-support metadata is inconsistent.');
      }
      return semanticSupport;
    });
  }

  function curriculumRow(id: string): CurriculumRow | undefined {
    return db.prepare('SELECT * FROM curriculum_versions WHERE id = ?').get(id) as
      CurriculumRow | undefined;
  }

  function ancestorRows(predecessorId: string | null): ReadonlyMap<string, CurriculumRow> {
    const visited = new Set<string>();
    const rows = new Map<string, CurriculumRow>();
    let currentId = predecessorId;
    while (currentId) {
      if (visited.has(currentId)) throw new CurriculumCapabilityRecoveryLineageError();
      visited.add(currentId);
      const row = curriculumRow(currentId);
      if (!row) throw new CurriculumCapabilityRecoveryLineageError();
      rows.set(row.id, row);
      currentId = row.predecessor_id;
    }
    return rows;
  }

  function normalizedObjectivePriority(
    objective: CurriculumObjective,
  ): 'required' | 'high' | 'normal' | 'optional' {
    return objective.priority ?? 'normal';
  }

  function nearestHistoricallyAcceptedAncestor(predecessorId: string | null): CurriculumRow | null {
    for (const row of ancestorRows(predecessorId).values()) {
      if (row.accepted_at) return row;
    }
    return null;
  }

  function compatibleRecoveryAncestor(
    curriculum: Curriculum,
    row: CurriculumRow | null,
  ): Curriculum | null {
    if (!row) return null;
    const support = getObjectiveSemanticSupport(row.id);
    const predecessor = hydrate(row, new Map(support.map((entry) => [entry.objectiveId, entry])));
    return predecessor.workspaceId === curriculum.workspaceId &&
      predecessor.contractVersionId === curriculum.contractVersionId &&
      predecessor.executionSourceManifest.fingerprint ===
        curriculum.executionSourceManifest.fingerprint &&
      JSON.stringify(predecessor.executionSourceManifest) ===
        JSON.stringify(curriculum.executionSourceManifest)
      ? predecessor
      : null;
  }

  function requiresOriginatedCapabilityRecovery(
    curriculum: Curriculum,
    predecessor: Curriculum,
  ): boolean {
    try {
      assertCurriculumObjectiveAuthoritySemanticSupport(curriculum, {
        isBlockingEligible: isAuthorityBlockingEligible,
      });
    } catch {
      // Legacy or partially supported successors remain readable so the
      // ordinary structured-recovery path can diagnose them.
      return false;
    }
    const hasNonOptionalPredecessorCapability = predecessor.nodes.some((node) =>
      (node.learningUnit?.objectives ?? []).some(
        (objective) => normalizedObjectivePriority(objective) !== 'optional',
      ),
    );
    if (!hasNonOptionalPredecessorCapability) return false;
    try {
      assertCurriculumObjectiveAuthoritySemanticSupport(predecessor, {
        isBlockingEligible: isAuthorityBlockingEligible,
      });
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Recovery lineage is locally owned. A shape-valid support payload is not
   * sufficient: every origin must reconcile exactly with the nearest accepted
   * ancestor's complete non-optional objective frontier.
   */
  function assertCapabilityRecoveryLineage(
    curriculum: Curriculum,
    expectedRecoveryPredecessorId?: string | null,
  ): void {
    const successorObjectives = curriculum.nodes.flatMap(
      (node) => node.learningUnit?.objectives ?? [],
    );
    const recoveredObjectives = successorObjectives.filter(
      (objective) => objective.semanticSupport?.capabilityPreservation?.recoveryOrigin,
    );
    const preservingObjectives = successorObjectives.filter(
      (objective) => objective.semanticSupport?.capabilityPreservation,
    );

    try {
      const nearestAcceptedRow = nearestHistoricallyAcceptedAncestor(curriculum.predecessorId);
      const predecessor = compatibleRecoveryAncestor(curriculum, nearestAcceptedRow);
      if (
        expectedRecoveryPredecessorId !== undefined &&
        ((expectedRecoveryPredecessorId === null && recoveredObjectives.length > 0) ||
          (expectedRecoveryPredecessorId !== null &&
            (!predecessor || nearestAcceptedRow?.id !== expectedRecoveryPredecessorId)))
      ) {
        throw new CurriculumCapabilityRecoveryLineageError();
      }
      const requiresRecovery =
        expectedRecoveryPredecessorId !== undefined && expectedRecoveryPredecessorId !== null
          ? true
          : predecessor
            ? requiresOriginatedCapabilityRecovery(curriculum, predecessor)
            : false;
      if (preservingObjectives.length === 0) {
        if (requiresRecovery) throw new CurriculumCapabilityRecoveryLineageError();
        return;
      }
      if (recoveredObjectives.length === 0) {
        if (requiresRecovery) {
          throw new CurriculumCapabilityRecoveryLineageError();
        }
        return;
      }
      assertCurriculumObjectiveAuthoritySemanticSupport(curriculum);
      const originPredecessorIds = new Set(
        recoveredObjectives.map(
          (objective) =>
            objective.semanticSupport!.capabilityPreservation!.recoveryOrigin!
              .predecessorCurriculumId,
        ),
      );
      if (originPredecessorIds.size !== 1) {
        throw new CurriculumCapabilityRecoveryLineageError();
      }
      const predecessorId = [...originPredecessorIds][0]!;
      if (!predecessor || nearestAcceptedRow?.id !== predecessorId) {
        throw new CurriculumCapabilityRecoveryLineageError();
      }

      const expectedByObjectiveId = new Map<
        string,
        {
          node: Curriculum['nodes'][number];
          objective: CurriculumObjective;
          priority: 'required' | 'high' | 'normal';
        }
      >();
      for (const node of predecessor.nodes) {
        for (const objective of node.learningUnit?.objectives ?? []) {
          const priority = normalizedObjectivePriority(objective);
          if (priority === 'optional') continue;
          if (
            expectedByObjectiveId.has(objective.id) ||
            !objective.formalAssessmentConstruct ||
            objective.formalAssessmentConstruct === 'design' ||
            objective.formalAssessmentConstruct === 'evaluate'
          ) {
            throw new CurriculumCapabilityRecoveryLineageError();
          }
          expectedByObjectiveId.set(objective.id, { node, objective, priority });
        }
      }
      if (recoveredObjectives.length !== expectedByObjectiveId.size) {
        throw new CurriculumCapabilityRecoveryLineageError();
      }

      const seenPredecessorObjectiveIds = new Set<string>();
      for (const successorObjective of recoveredObjectives) {
        const support = successorObjective.semanticSupport!;
        const preservation = support.capabilityPreservation!;
        const origin = preservation.recoveryOrigin!;
        const expected = expectedByObjectiveId.get(origin.predecessorObjectiveId);
        if (!expected || seenPredecessorObjectiveIds.has(origin.predecessorObjectiveId)) {
          throw new CurriculumCapabilityRecoveryLineageError();
        }
        seenPredecessorObjectiveIds.add(origin.predecessorObjectiveId);
        const proposition = curriculumObjectiveProposition(expected.objective);
        const allowedSourceBlockIds = new Set(
          expected.node.sourceReferences.flatMap((reference) =>
            reference.sourceBlockId ? [reference.sourceBlockId] : [],
          ),
        );
        if (
          origin.predecessorCurriculumId !== predecessor.id ||
          origin.predecessorCurriculumVersion !== predecessor.version ||
          origin.predecessorLearningUnitId !== expected.node.id ||
          origin.predecessorPriority !== expected.priority ||
          origin.contractVersionId !== predecessor.contractVersionId ||
          origin.executionSourceManifestFingerprint !==
            predecessor.executionSourceManifest.fingerprint ||
          origin.sourceEnvelopeFingerprint !==
            fingerprintCurriculumCapabilitySourceEnvelope(expected.node) ||
          successorObjective.title !== expected.objective.title ||
          successorObjective.description !== expected.objective.description ||
          normalizedObjectivePriority(successorObjective) !== expected.priority ||
          successorObjective.formalAssessmentConstruct !==
            expected.objective.formalAssessmentConstruct ||
          support.construct !== expected.objective.formalAssessmentConstruct ||
          support.verdict !== 'pass' ||
          support.boundSourceBlockIds.some(
            (sourceBlockId) => !allowedSourceBlockIds.has(sourceBlockId),
          ) ||
          preservation.verdict !== 'pass' ||
          preservation.originalProposition !== proposition ||
          preservation.originalPropositionFingerprint !==
            fingerprintObjectiveAuthorityProposition(proposition) ||
          preservation.mappings.map((mapping) => mapping.originalText).join('') !== proposition
        ) {
          throw new CurriculumCapabilityRecoveryLineageError();
        }
      }
      if (seenPredecessorObjectiveIds.size !== expectedByObjectiveId.size) {
        throw new CurriculumCapabilityRecoveryLineageError();
      }
    } catch (error) {
      if (error instanceof CurriculumCapabilityRecoveryLineageError) throw error;
      throw new CurriculumCapabilityRecoveryLineageError();
    }
  }

  function get(id: string): Curriculum | undefined {
    const row = curriculumRow(id);
    if (!row) return undefined;
    return hydrateStoredCurriculum(row);
  }

  function getManifest(workspaceId: string, fingerprint: string) {
    const row = db
      .prepare(
        `SELECT * FROM execution_source_manifests
         WHERE workspace_id = ? AND fingerprint = ?`,
      )
      .get(workspaceId, fingerprint) as ManifestRow | undefined;
    return row ? hydrateManifest(row) : undefined;
  }

  function getQualityEvaluation(curriculumId: string) {
    const row = db
      .prepare(
        'SELECT curriculum_id, payload FROM curriculum_quality_evaluations WHERE curriculum_id = ?',
      )
      .get(curriculumId) as CurriculumQualityEvaluationRow | undefined;
    return row
      ? CurriculumSemanticEvaluationSchema.parse(JSON.parse(row.payload) as unknown)
      : undefined;
  }

  function appendEvent(curriculumId: string, event: CurriculumEventInput): void {
    const seq = (
      db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS n
           FROM curriculum_events WHERE curriculum_id = ?`,
        )
        .get(curriculumId) as { n: number }
    ).n;
    db.prepare(
      `INSERT INTO curriculum_events
         (id, curriculum_id, seq, event_type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      curriculumId,
      seq,
      event.eventType,
      event.actor,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  const createManifestTx = db.transaction(
    (id: string, workspaceId: string, input: ExecutionSourceManifest, createdAt: string) => {
      const manifest = ExecutionSourceManifestSchema.parse(input);
      const existing = getManifest(workspaceId, manifest.fingerprint);
      if (existing) {
        if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) {
          throw new Error('Execution-source fingerprint collision.');
        }
        return existing;
      }
      const materialIds = new Set<string>();
      for (const revision of manifest.revisions) {
        if (materialIds.has(revision.materialId)) {
          throw new Error('Execution-source manifest repeats a Material.');
        }
        materialIds.add(revision.materialId);
        const owner = db
          .prepare(
            `SELECT m.workspace_id, mr.material_id
             FROM material_revisions mr JOIN materials m ON m.id = mr.material_id
             WHERE mr.id = ? AND mr.material_id = ?`,
          )
          .get(revision.materialRevisionId, revision.materialId) as
          { workspace_id: string; material_id: string } | undefined;
        if (!owner || owner.workspace_id !== workspaceId) {
          throw new Error('Execution-source revision is outside this Course.');
        }
        if (
          new Set(revision.sourceBlockRevisionIds).size !== revision.sourceBlockRevisionIds.length
        ) {
          throw new Error('Execution-source manifest repeats a SourceBlock.');
        }
        for (const blockId of revision.sourceBlockRevisionIds) {
          const block = db
            .prepare(
              `SELECT 1 FROM source_blocks
               WHERE id = ? AND material_id = ? AND material_revision_id = ?`,
            )
            .get(blockId, revision.materialId, revision.materialRevisionId);
          if (!block) throw new Error('Execution-source block does not belong to its revision.');
        }
      }

      db.prepare(
        `INSERT INTO execution_source_manifests
           (id, workspace_id, fingerprint, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, workspaceId, manifest.fingerprint, JSON.stringify(manifest), createdAt);
      const insertRevision = db.prepare(
        `INSERT INTO execution_source_manifest_revisions
           (manifest_id, material_id, material_revision_id, parser_version, parser_fingerprint)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const insertBlock = db.prepare(
        `INSERT INTO execution_source_manifest_blocks
           (manifest_id, material_revision_id, source_block_id) VALUES (?, ?, ?)`,
      );
      for (const revision of manifest.revisions) {
        insertRevision.run(
          id,
          revision.materialId,
          revision.materialRevisionId,
          revision.parserVersion,
          revision.parserFingerprint,
        );
        for (const blockId of revision.sourceBlockRevisionIds) {
          insertBlock.run(id, revision.materialRevisionId, blockId);
        }
      }
      return getManifest(workspaceId, manifest.fingerprint)!;
    },
  );

  function validateCurriculum(
    curriculum: Curriculum,
    manifestId: string,
    options: { exactAuthorityOnly?: boolean } = {},
  ): void {
    if (!options.exactAuthorityOnly) {
      if (!curriculum.validation.valid && curriculum.status === 'accepted') {
        throw new Error('Invalid Curriculum cannot be accepted.');
      }
      const contract = db
        .prepare('SELECT workspace_id FROM learning_contract_versions WHERE id = ?')
        .get(curriculum.contractVersionId) as { workspace_id: string } | undefined;
      if (!contract || contract.workspace_id !== curriculum.workspaceId) {
        throw new Error('Curriculum Contract does not belong to this Course.');
      }
    }
    const manifest = db
      .prepare('SELECT fingerprint FROM execution_source_manifests WHERE id = ?')
      .get(manifestId) as { fingerprint: string } | undefined;
    if (!manifest || manifest.fingerprint !== curriculum.executionSourceManifest.fingerprint) {
      throw new Error('Curriculum execution-source manifest is inconsistent.');
    }

    const exactClaimCache = new Map<string, boolean>();
    interface ExactManifestClaim {
      id: string;
      authority_record_id: string;
      source_block_id: string;
      quote: string;
      start_offset: number;
      end_offset: number;
      content: string;
    }
    const exactClaimByIdCache = new Map<string, ExactManifestClaim | null>();
    const exactManifestClaimById = (claimId: string): ExactManifestClaim | null => {
      if (exactClaimByIdCache.has(claimId)) return exactClaimByIdCache.get(claimId) ?? null;
      const row = db
        .prepare(
          `SELECT c.id, c.authority_record_id, c.source_block_id,
                  c.quote, c.start_offset, c.end_offset, b.content
           FROM truth_authority_claims c
           JOIN truth_authority_records r ON r.id = c.authority_record_id
           JOIN source_blocks b ON b.id = c.source_block_id
           JOIN execution_source_manifest_blocks mb
             ON mb.source_block_id = c.source_block_id AND mb.manifest_id = ?
           WHERE c.id = ?
             AND r.workspace_id = ?
             AND b.material_id = r.material_id
             AND b.material_revision_id = r.material_revision_id
             AND mb.material_revision_id = b.material_revision_id
             AND (b.content_origin IS NULL OR b.content_origin = 'extracted_original')`,
        )
        .get(manifestId, claimId, curriculum.workspaceId) as ExactManifestClaim | undefined;
      const exact =
        row &&
        row.start_offset >= 0 &&
        row.end_offset <= row.content.length &&
        row.content.slice(row.start_offset, row.end_offset) === row.quote
          ? row
          : null;
      exactClaimByIdCache.set(claimId, exact);
      return exact;
    };
    const hasExactManifestClaim = (authorityRecordId: string, sourceBlockId: string): boolean => {
      const key = `${authorityRecordId}\u0000${sourceBlockId}`;
      const cached = exactClaimCache.get(key);
      if (cached !== undefined) return cached;
      const rows = db
        .prepare(
          `SELECT c.quote, c.start_offset, c.end_offset, b.content
           FROM truth_authority_claims c
           JOIN truth_authority_records r ON r.id = c.authority_record_id
           JOIN source_blocks b ON b.id = c.source_block_id
           JOIN execution_source_manifest_blocks mb
             ON mb.source_block_id = c.source_block_id AND mb.manifest_id = ?
           WHERE c.authority_record_id = ? AND c.source_block_id = ?
             AND r.workspace_id = ?
             AND b.material_id = r.material_id
             AND b.material_revision_id = r.material_revision_id
             AND mb.material_revision_id = b.material_revision_id
             AND (b.content_origin IS NULL OR b.content_origin = 'extracted_original')`,
        )
        .all(manifestId, authorityRecordId, sourceBlockId, curriculum.workspaceId) as Array<{
        quote: string;
        start_offset: number;
        end_offset: number;
        content: string;
      }>;
      const exact = rows.some(
        (row) =>
          row.start_offset >= 0 &&
          row.end_offset <= row.content.length &&
          row.content.slice(row.start_offset, row.end_offset) === row.quote,
      );
      exactClaimCache.set(key, exact);
      return exact;
    };
    const assertExactAuthorityMapping = (
      sourceBlockIds: readonly string[],
      authorityRecordIds: readonly string[],
      label: string,
      authorityClaimIds?: readonly string[],
    ): void => {
      for (const sourceBlockId of sourceBlockIds) {
        const inManifest = db
          .prepare(
            `SELECT 1 FROM execution_source_manifest_blocks
             WHERE manifest_id = ? AND source_block_id = ?`,
          )
          .get(manifestId, sourceBlockId);
        if (!inManifest) {
          throw new Error(`${label} references a source block outside its manifest.`);
        }
      }
      if (authorityClaimIds) {
        const sourceBlockSet = new Set(sourceBlockIds);
        const authorityRecordSet = new Set(authorityRecordIds);
        const exactClaims = authorityClaimIds.map((claimId) => {
          const claim = exactManifestClaimById(claimId);
          if (!claim) throw new Error(`${label} references a missing or inexact authority claim.`);
          if (
            !sourceBlockSet.has(claim.source_block_id) ||
            !authorityRecordSet.has(claim.authority_record_id)
          ) {
            throw new Error(`${label} authority claim falls outside its mapped record or block.`);
          }
          return claim;
        });
        for (const sourceBlockId of sourceBlockIds) {
          if (!exactClaims.some((claim) => claim.source_block_id === sourceBlockId)) {
            throw new Error(`${label} source block has no exact mapped authority claim identity.`);
          }
        }
        for (const authorityRecordId of authorityRecordIds) {
          if (!exactClaims.some((claim) => claim.authority_record_id === authorityRecordId)) {
            throw new Error(`${label} authority has no exact mapped claim identity.`);
          }
        }
        return;
      }
      for (const sourceBlockId of sourceBlockIds) {
        if (
          !authorityRecordIds.some((authorityRecordId) =>
            hasExactManifestClaim(authorityRecordId, sourceBlockId),
          )
        ) {
          throw new Error(`${label} source block has no exact claim from its mapped authority.`);
        }
      }
      for (const authorityRecordId of authorityRecordIds) {
        if (
          !sourceBlockIds.some((sourceBlockId) =>
            hasExactManifestClaim(authorityRecordId, sourceBlockId),
          )
        ) {
          throw new Error(`${label} authority has no exact claim in its mapped source blocks.`);
        }
      }
    };

    const validateExactAuthorityMappings = (): void => {
      for (const objective of curriculum.nodes.flatMap(
        (node) => node.learningUnit?.objectives ?? [],
      )) {
        // Legacy and partially migrated Curricula intentionally remain
        // readable so consequential service boundaries can diagnose missing
        // semantic support and offer immutable successor recovery. Any
        // objective that does carry canonical support is a current artifact
        // and must still pass the complete exact-claim ownership audit below.
        if (options.exactAuthorityOnly && !objective.semanticSupport) continue;
        // On ordinary create/accept boundaries, validate the aggregate
        // objective binding too. During hydration, aggregate/support drift is
        // deliberately left to the canonical semantic-support assertion so a
        // stale accepted route remains readable for immutable recovery. The
        // support artifact's own exact selected claims are still audited here.
        if (!options.exactAuthorityOnly) {
          assertExactAuthorityMapping(
            objective.authoritySourceBlockIds ?? [],
            objective.truthAuthorityRecordIds,
            `Curriculum objective ${objective.id}`,
            objective.authorityClaimIds,
          );
        }
        if (!objective.semanticSupport) continue;
        assertExactAuthorityMapping(
          objective.semanticSupport.boundSourceBlockIds,
          objective.semanticSupport.boundAuthorityRecordIds,
          `Curriculum objective ${objective.id} semantic-support binding`,
          objective.semanticSupport.boundAuthorityClaimIds,
        );
        const mappings = [
          ...objective.semanticSupport.fragments,
          ...objective.semanticSupport.conflicts,
          ...objective.semanticSupport.overreach,
        ];
        for (const mapping of mappings) {
          assertExactAuthorityMapping(
            mapping.sourceBlockIds,
            mapping.authorityRecordIds,
            `Curriculum objective ${objective.id} semantic-support mapping`,
            mapping.authorityClaimIds,
          );
        }
      }
    };
    if (options.exactAuthorityOnly) {
      try {
        validateExactAuthorityMappings();
      } catch (error) {
        if (error instanceof CurriculumExactAuthorityClaimHydrationError) throw error;
        throw new CurriculumExactAuthorityClaimHydrationError();
      }
      return;
    }

    const nodeIds = new Set(curriculum.nodes.map((node) => node.id));
    if (nodeIds.size !== curriculum.nodes.length)
      throw new Error('Curriculum node IDs must be unique.');
    const roots = curriculum.nodes.filter((node) => node.parentId === null);
    if (roots.length !== 1 || roots[0]?.kind !== 'course') {
      throw new Error('Curriculum must have one Course root.');
    }
    for (const node of curriculum.nodes) {
      if (node.parentId !== null && !nodeIds.has(node.parentId)) {
        throw new Error(`Unknown Curriculum parent: ${node.parentId}`);
      }
      const seen = new Set<string>([node.id]);
      let parentId = node.parentId;
      while (parentId) {
        if (seen.has(parentId)) throw new Error('Curriculum hierarchy contains a cycle.');
        seen.add(parentId);
        parentId =
          curriculum.nodes.find((candidate) => candidate.id === parentId)?.parentId ?? null;
      }
      for (const ref of node.sourceReferences) {
        const source = db
          .prepare(
            `SELECT 1 FROM execution_source_manifest_revisions
             WHERE manifest_id = ? AND material_id = ? AND material_revision_id = ?`,
          )
          .get(manifestId, ref.materialId, ref.materialRevisionId);
        if (!source) throw new Error('Curriculum source reference is outside its manifest.');
        if (ref.sourceBlockId) {
          const block = db
            .prepare(
              `SELECT 1 FROM execution_source_manifest_blocks mb
               JOIN source_blocks b ON b.id = mb.source_block_id
               WHERE mb.manifest_id = ? AND mb.source_block_id = ?
                 AND b.material_id = ? AND b.material_revision_id = ?`,
            )
            .get(manifestId, ref.sourceBlockId, ref.materialId, ref.materialRevisionId);
          if (!block) throw new Error('Curriculum SourceBlock is outside its manifest.');
        }
        if (ref.structuralUnitId) {
          const structuralUnit = db
            .prepare(
              `SELECT 1 FROM normalized_structural_units
               WHERE id = ? AND material_revision_id = ?`,
            )
            .get(ref.structuralUnitId, ref.materialRevisionId);
          if (!structuralUnit) {
            throw new Error('Curriculum structural unit has the wrong revision owner.');
          }
        }
      }
      if (!node.learningUnit) continue;
      for (const conceptId of node.learningUnit.conceptIds) {
        const concept = db
          .prepare(
            `SELECT 1 FROM concepts c JOIN execution_source_manifest_revisions r
               ON r.material_revision_id = c.material_revision_id
             WHERE r.manifest_id = ? AND c.id = ?`,
          )
          .get(manifestId, conceptId);
        if (!concept) throw new Error(`Unknown or out-of-manifest Concept: ${conceptId}`);
      }
      for (const canonicalConceptId of node.learningUnit.canonicalConceptIds) {
        const canonical = db
          .prepare(
            `SELECT 1
             FROM canonical_concepts cc
             JOIN canonical_members cm ON cm.canonical_concept_id = cc.id
             JOIN concepts c ON c.id = cm.source_concept_id
             JOIN execution_source_manifest_revisions r
               ON r.material_revision_id = c.material_revision_id
             WHERE r.manifest_id = ? AND cc.workspace_id = ? AND cc.id = ?
             LIMIT 1`,
          )
          .get(manifestId, curriculum.workspaceId, canonicalConceptId);
        if (!canonical) {
          throw new Error(`Unknown or out-of-manifest canonical Concept: ${canonicalConceptId}`);
        }
      }
      for (const relationId of node.learningUnit.graphRelationIds) {
        if (!db.prepare('SELECT 1 FROM graph_edges WHERE id = ?').get(relationId)) {
          throw new Error(`Unknown graph relation: ${relationId}`);
        }
      }
      for (const objective of node.learningUnit.objectives) {
        for (const authorityId of objective.truthAuthorityRecordIds) {
          const authority = db
            .prepare(
              `SELECT a.validation_state, a.conflict_state, a.workspace_id,
                      EXISTS(
                        SELECT 1 FROM execution_source_manifest_revisions mr
                        WHERE mr.manifest_id = ?
                          AND mr.material_revision_id = a.material_revision_id
                      ) AS in_manifest
               FROM truth_authority_records a WHERE a.id = ?`,
            )
            .get(manifestId, authorityId) as
            | {
                validation_state: string;
                conflict_state: string;
                workspace_id: string;
                in_manifest: number;
              }
            | undefined;
          if (!authority) throw new Error(`Unknown truth-authority record: ${authorityId}`);
          if (authority.workspace_id !== curriculum.workspaceId || authority.in_manifest !== 1) {
            throw new Error('Curriculum truth authority is outside its Course source manifest.');
          }
          if (
            objective.truthPremiseStatus === 'independently_verified' &&
            (authority.validation_state !== 'validated' ||
              authority.conflict_state === 'unresolved')
          ) {
            throw new Error(
              'Verified Curriculum objective requires valid, unconflicted authority.',
            );
          }
        }
      }
    }
    validateExactAuthorityMappings();
  }

  function hydrateStoredCurriculum(row: CurriculumRow): Curriculum {
    const support = getObjectiveSemanticSupport(row.id);
    const curriculum = hydrate(row, new Map(support.map((entry) => [entry.objectiveId, entry])));
    // Migration-40 Curricula intentionally remain readable without fabricated
    // semantic support. Once migration-41 support exists, however, hydration is
    // a current-artifact boundary and must revalidate every exact claim against
    // its persisted manifest and present source ownership.
    if (support.length > 0) {
      validateCurriculum(curriculum, row.manifest_id, { exactAuthorityOnly: true });
    }
    assertCapabilityRecoveryLineage(curriculum);
    return curriculum;
  }

  const createVersionTx = db.transaction(
    (
      curriculumInput: Curriculum,
      event: CurriculumEventInput,
      persistenceContext: CurriculumVersionPersistenceContext,
    ): Curriculum => {
      const curriculum = CurriculumSchema.parse(curriculumInput);
      if (curriculum.status === 'accepted') {
        throw new Error('Persist a Curriculum proposal before accepting it.');
      }
      const manifest = getManifest(
        curriculum.workspaceId,
        curriculum.executionSourceManifest.fingerprint,
      );
      if (
        !manifest ||
        JSON.stringify(manifest.manifest) !== JSON.stringify(curriculum.executionSourceManifest)
      ) {
        throw new Error('Curriculum requires its exact persisted execution-source manifest.');
      }
      const objectives = curriculum.nodes.flatMap((node) => node.learningUnit?.objectives ?? []);
      assertCurriculumObjectiveAuthoritySemanticSupport(curriculum, {
        isBlockingEligible: isAuthorityBlockingEligible,
      });
      assertCapabilityRecoveryLineage(
        curriculum,
        persistenceContext.capabilityRecoveryPredecessorId,
      );
      validateCurriculum(curriculum, manifest.id);
      const latest = db
        .prepare(
          `SELECT id, version FROM curriculum_versions
           WHERE workspace_id = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(curriculum.workspaceId) as { id: string; version: number } | undefined;
      if (
        curriculum.predecessorId !== (latest?.id ?? null) ||
        curriculum.version !== (latest?.version ?? 0) + 1
      ) {
        throw new Error('Curriculum predecessor or version is stale.');
      }
      db.prepare(
        `INSERT INTO curriculum_versions
           (id, workspace_id, contract_id, manifest_id, manifest_fingerprint,
            version, predecessor_id, status, validation_valid, payload, created_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        curriculum.id,
        curriculum.workspaceId,
        curriculum.contractVersionId,
        manifest.id,
        manifest.manifest.fingerprint,
        curriculum.version,
        curriculum.predecessorId,
        curriculum.status,
        curriculum.validation.valid ? 1 : 0,
        JSON.stringify(withoutSemanticSupport(curriculum)),
        curriculum.createdAt,
        curriculum.acceptedAt,
      );
      if (curriculum.qualityEvaluation) {
        db.prepare(
          `INSERT INTO curriculum_quality_evaluations
             (curriculum_id, policy_version, evaluator, status,
              bounded_repair_attempted, payload, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          curriculum.id,
          curriculum.qualityEvaluation.policyVersion,
          curriculum.qualityEvaluation.evaluator,
          curriculum.qualityEvaluation.status,
          curriculum.qualityEvaluation.boundedRepairAttempted ? 1 : 0,
          JSON.stringify(curriculum.qualityEvaluation),
          curriculum.qualityEvaluation.evaluatedAt,
        );
      }

      const insertNode = db.prepare(
        `INSERT INTO curriculum_node_index
           (curriculum_id, node_id, parent_node_id, kind, idx, title)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertRef = db.prepare(
        `INSERT INTO curriculum_node_source_refs
           (curriculum_id, node_id, ordinal, material_id, material_revision_id,
            structural_unit_id, source_block_id, source_block_revision_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertObjective = db.prepare(
        `INSERT INTO curriculum_objective_index
           (curriculum_id, learning_unit_id, objective_id, truth_premise_status)
         VALUES (?, ?, ?, ?)`,
      );
      const insertAuthority = db.prepare(
        `INSERT INTO curriculum_objective_authority
           (curriculum_id, objective_id, authority_record_id) VALUES (?, ?, ?)`,
      );
      for (const node of curriculum.nodes) {
        insertNode.run(curriculum.id, node.id, node.parentId, node.kind, node.index, node.title);
      }
      for (const node of curriculum.nodes) {
        node.sourceReferences.forEach((ref, index) => {
          insertRef.run(
            curriculum.id,
            node.id,
            index,
            ref.materialId,
            ref.materialRevisionId,
            ref.structuralUnitId,
            ref.sourceBlockId,
            ref.sourceBlockRevisionFingerprint,
          );
        });
        for (const objective of node.learningUnit?.objectives ?? []) {
          insertObjective.run(curriculum.id, node.id, objective.id, objective.truthPremiseStatus);
          for (const authorityId of objective.truthAuthorityRecordIds) {
            insertAuthority.run(curriculum.id, objective.id, authorityId);
          }
        }
      }
      const insertSemanticSupport = db.prepare(
        `INSERT INTO curriculum_objective_semantic_support
           (curriculum_id, objective_id, policy_version, evaluator, provider,
            provider_model, status, proposition_fingerprint, binding_fingerprint,
            payload, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const objective of objectives) {
        const support = objective.semanticSupport!;
        insertSemanticSupport.run(
          curriculum.id,
          objective.id,
          support.policyVersion,
          support.evaluator,
          support.provider,
          support.providerModel,
          support.verdict,
          support.propositionFingerprint,
          support.bindingFingerprint,
          JSON.stringify(support),
          support.evaluatedAt,
        );
      }
      appendEvent(curriculum.id, event);
      return get(curriculum.id)!;
    },
  );

  const acceptTx = db.transaction((id: string, acceptedAt: string, event: CurriculumEventInput) => {
    const current = get(id);
    if (!current || current.status !== 'proposed' || !current.validation.valid) {
      throw new Error('Only a valid proposed Curriculum may be accepted.');
    }
    const latest = db
      .prepare(
        `SELECT id FROM curriculum_versions
         WHERE workspace_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(current.workspaceId) as { id: string } | undefined;
    if (latest?.id !== current.id) {
      throw new Error('Only the latest Curriculum version may be accepted.');
    }
    assertCurriculumObjectiveAuthoritySemanticSupport(current, {
      isBlockingEligible: isAuthorityBlockingEligible,
    });
    const manifest = getManifest(current.workspaceId, current.executionSourceManifest.fingerprint);
    if (!manifest) throw new Error('Curriculum execution-source manifest is missing.');
    validateCurriculum(current, manifest.id);
    const accepted = CurriculumSchema.parse({ ...current, status: 'accepted', acceptedAt });
    const changed = db
      .prepare(
        `UPDATE curriculum_versions
         SET status = 'accepted', accepted_at = ?, payload = ?
         WHERE id = ? AND status = 'proposed' AND validation_valid = 1`,
      )
      .run(acceptedAt, JSON.stringify(withoutSemanticSupport(accepted)), id).changes;
    if (changed !== 1) throw new Error('Curriculum proposal changed concurrently.');
    appendEvent(id, event);
    return get(id)!;
  });

  const rejectTx = db.transaction(
    (id: string, reason: string, event: CurriculumEventInput): Curriculum => {
      const current = get(id);
      if (
        !current ||
        (current.status !== 'candidate' &&
          current.status !== 'proposed' &&
          current.status !== 'accepted')
      ) {
        throw new Error('Only a pending Curriculum version may be rejected.');
      }
      const active = db
        .prepare('SELECT 1 FROM course_execution_state WHERE active_curriculum_id = ?')
        .get(id);
      if (active) throw new Error('The active Curriculum cannot be rejected in place.');
      const rejected = CurriculumSchema.parse({ ...current, status: 'rejected' });
      const changed = db
        .prepare(
          `UPDATE curriculum_versions SET status = 'rejected', payload = ?
           WHERE id = ? AND status = ?`,
        )
        .run(JSON.stringify(withoutSemanticSupport(rejected)), id, current.status).changes;
      if (changed !== 1) throw new Error('Curriculum changed concurrently.');
      appendEvent(id, { ...event, payload: { reason, detail: event.payload } });
      return get(id)!;
    },
  );

  return {
    get,
    getManifest,
    getQualityEvaluation,
    getObjectiveSemanticSupport,
    createManifest: createManifestTx,
    createVersion: createVersionTx,
    accept: acceptTx,
    reject: rejectTx,

    listEvents(curriculumId: string): StoredCurriculumEvent[] {
      const rows = db
        .prepare(
          `SELECT curriculum_id, seq, event_type, actor, payload, created_at
           FROM curriculum_events WHERE curriculum_id = ? ORDER BY seq ASC`,
        )
        .all(curriculumId) as CurriculumEventRow[];
      return rows.map((row) => ({
        id: `${row.curriculum_id}:${row.seq}`,
        curriculumId: row.curriculum_id,
        seq: row.seq,
        eventType: row.event_type,
        actor: row.actor,
        payload: JSON.parse(row.payload) as unknown,
        createdAt: row.created_at,
      }));
    },

    list(workspaceId: string): Curriculum[] {
      return (
        db
          .prepare(`SELECT * FROM curriculum_versions WHERE workspace_id = ? ORDER BY version ASC`)
          .all(workspaceId) as CurriculumRow[]
      ).map(hydrateStoredCurriculum);
    },
  };
}

export type CurriculaRepo = ReturnType<typeof createCurriculaRepo>;
