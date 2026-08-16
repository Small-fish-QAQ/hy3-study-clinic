import {
  ApiErrorCode,
  CurriculumProposalPayloadSchema,
  CurriculumProposalFailureDetailsSchema,
  CurriculumValidationSchema,
  fnv1a32,
  type Curriculum,
  type CurriculumObjective,
  type CurriculumProposalPayload,
  type CurriculumSourceReference,
  type ExecutionSourceManifest,
  type GraphEdge,
  type SourceBlock,
  type TruthPremiseStatus,
  type VerifiedGrounding,
  type Concept,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import type { SourceAuthorityBundle } from '../repositories/sourceAuthority.js';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import { newId } from '../util/ids.js';

export interface CurriculumStructuralUnitOwner {
  materialId: string;
  materialRevisionId: string;
}

export interface CurriculumValidationContext {
  workspaceId: string;
  courseTitle: string;
  executionSourceManifest: ExecutionSourceManifest;
  blocks: SourceBlock[];
  concepts: Concept[];
  graphEdges: GraphEdge[];
  /** Empty until normalized structural-unit persistence is available. */
  structuralUnitOwners: Map<string, CurriculumStructuralUnitOwner>;
  canonicalConceptIds: Set<string>;
  /** Immutable exact excerpts offered for this operation snapshot. */
  evidenceCatalog: CurriculumEvidenceOffer[];
  authorityBundles: SourceAuthorityBundle[];
  /** Source authority decisions are local, never provider output. */
  isAuthorityBlockingEligible: (authorityRecordId: string) => boolean;
}

export interface MaterializedCurriculum {
  nodes: Curriculum['nodes'];
  synthesisGroups: Curriculum['synthesisGroups'];
  validation: Curriculum['validation'];
}

function revisionForBlock(
  block: SourceBlock,
  manifest: ExecutionSourceManifest,
): ExecutionSourceManifest['revisions'][number] | undefined {
  return manifest.revisions.find(
    (revision) =>
      revision.materialId === block.materialId &&
      revision.sourceBlockRevisionIds.includes(block.id),
  );
}

function sourceBlockFingerprint(block: SourceBlock, revisionId: string): string {
  return `block_${fnv1a32(
    JSON.stringify({
      materialRevisionId: revisionId,
      blockId: block.id,
      index: block.index,
      content: block.content,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
    }),
  )
    .toString(16)
    .padStart(8, '0')}`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function authorityStatus(
  _objective: { title: string; description: string },
  evidence: VerifiedGrounding[],
  ctx: CurriculumValidationContext,
): { status: TruthPremiseStatus; authorityIds: string[] } {
  const evidenceKeys = new Set(evidence.map((item) => `${item.blockId}\u0000${item.quote}`));
  const matched = ctx.authorityBundles.filter((bundle) => {
    const record = bundle.record;
    if (record.workspaceId !== ctx.workspaceId || record.validationState === 'rejected') {
      return false;
    }
    const revision = ctx.executionSourceManifest.revisions.find(
      (candidate) => candidate.materialRevisionId === record.materialRevisionId,
    );
    if (!revision) return false;
    // `truthPremiseStatus` describes the exact cited source premises, never
    // the model-authored objective title or description. A locally admitted
    // verbatim claim may support formal premise binding while the learner-
    // visible instructional wording remains ordinary AI-authored structure.
    return bundle.claims.some(
      (claim) =>
        revision.sourceBlockRevisionIds.includes(claim.sourceBlockId) &&
        evidenceKeys.has(`${claim.sourceBlockId}\u0000${claim.quote}`) &&
        normalize(claim.claim) === normalize(claim.quote),
    );
  });
  const conflicted = matched.filter((bundle) => bundle.record.conflictState === 'unresolved');
  if (conflicted.length > 0) {
    return {
      status: 'conflicted',
      authorityIds: conflicted.map((bundle) => bundle.record.id).slice(0, 20),
    };
  }
  const eligible = matched.filter(
    (bundle) =>
      bundle.record.validationState === 'validated' &&
      ctx.isAuthorityBlockingEligible(bundle.record.id),
  );
  if (eligible.length > 0) {
    return {
      status: 'independently_verified',
      authorityIds: eligible.map((bundle) => bundle.record.id).slice(0, 20),
    };
  }
  return {
    status: 'unverified',
    authorityIds: matched.map((bundle) => bundle.record.id).slice(0, 20),
  };
}

function throwValidation(
  errors: string[],
  warnings: string[] = [],
  repairAttempted = false,
): never {
  const details = CurriculumProposalFailureDetailsSchema.parse({
    kind: 'curriculum_candidate_validation',
    repairAttempted,
    errors: errors.slice(0, 20),
    warnings: warnings.slice(0, 20),
  });
  throw new AppError(
    ApiErrorCode.GroundingFailed,
    repairAttempted
      ? '新课程结构没有通过资料一致性检查，原版本未改变。系统已尝试一次修复。'
      : '新课程结构没有通过资料一致性检查，原版本未改变。',
    details,
  );
}

/**
 * Convert provider-local Curriculum keys into immutable local IDs and derive
 * all provenance/truth fields locally. This function never trusts provider
 * lifecycle, completion, admissibility, or truth claims.
 */
export function materializeCurriculumProposal(
  payload: CurriculumProposalPayload,
  ctx: CurriculumValidationContext,
): MaterializedCurriculum {
  const parsed = CurriculumProposalPayloadSchema.parse(payload);
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeIdByKey = new Map<string, string>();
  const objectiveIdByKey = new Map<string, string>();
  const conceptById = new Map(ctx.concepts.map((concept) => [concept.id, concept]));
  const graphById = new Map(ctx.graphEdges.map((edge) => [edge.id, edge]));
  const blockById = new Map(ctx.blocks.map((block) => [block.id, block]));
  const manifestBlockIds = new Set(
    ctx.executionSourceManifest.revisions.flatMap((revision) => revision.sourceBlockRevisionIds),
  );

  for (const node of parsed.nodes) nodeIdByKey.set(node.key, newId('cun'));
  const rootId = newId('cun');
  const sourceRefsByNode = new Map<string, CurriculumSourceReference[]>();
  const sourceRefKeysByNode = new Map<string, Set<string>>();
  const mappedBlockIds = new Set<string>();

  function addSourceReference(nodeId: string, grounding: VerifiedGrounding): void {
    const block = blockById.get(grounding.blockId);
    const revision = block ? revisionForBlock(block, ctx.executionSourceManifest) : undefined;
    if (!block || !revision) {
      errors.push(
        `Source evidence is outside the exact execution-source manifest: ${grounding.blockId}`,
      );
      return;
    }
    mappedBlockIds.add(block.id);
    const refs = sourceRefsByNode.get(nodeId) ?? [];
    const keys = sourceRefKeysByNode.get(nodeId) ?? new Set<string>();
    const key = `${revision.materialRevisionId}\u0000${grounding.blockId}`;
    if (keys.has(key)) return;
    keys.add(key);
    refs.push({
      materialId: block.materialId,
      materialRevisionId: revision.materialRevisionId,
      structuralUnitId: null,
      sourceBlockId: block.id,
      sourceBlockRevisionFingerprint: sourceBlockFingerprint(block, revision.materialRevisionId),
    });
    sourceRefsByNode.set(nodeId, refs.slice(0, 100));
    sourceRefKeysByNode.set(nodeId, keys);
  }

  function addStructuralReference(
    nodeId: string,
    structuralUnitId: string,
    owner: CurriculumStructuralUnitOwner,
  ): void {
    const refs = sourceRefsByNode.get(nodeId) ?? [];
    const keys = sourceRefKeysByNode.get(nodeId) ?? new Set<string>();
    const key = `${owner.materialRevisionId}\u0000structural:${structuralUnitId}`;
    if (keys.has(key)) return;
    keys.add(key);
    refs.push({
      materialId: owner.materialId,
      materialRevisionId: owner.materialRevisionId,
      structuralUnitId,
      sourceBlockId: null,
      sourceBlockRevisionFingerprint: null,
    });
    sourceRefsByNode.set(nodeId, refs.slice(0, 100));
    sourceRefKeysByNode.set(nodeId, keys);
  }

  const evidenceById = new Map(ctx.evidenceCatalog.map((offer) => [offer.id, offer]));

  function verifyEvidence(
    nodeId: string,
    proposed: { evidenceId: string },
  ): VerifiedGrounding | null {
    const offer = evidenceById.get(proposed.evidenceId);
    if (!offer) {
      errors.push(`Unknown or unavailable offered Curriculum evidence ID: ${proposed.evidenceId}`);
      return null;
    }
    if (!manifestBlockIds.has(offer.blockId)) {
      errors.push(`Offered Curriculum evidence is outside the exact execution-source manifest.`);
      return null;
    }
    const offeredBlock = blockById.get(offer.blockId);
    const offeredRevision = offeredBlock
      ? revisionForBlock(offeredBlock, ctx.executionSourceManifest)
      : undefined;
    if (
      !offeredBlock ||
      !offeredRevision ||
      offer.materialId !== offeredBlock.materialId ||
      offer.materialRevisionId !== offeredRevision.materialRevisionId
    ) {
      errors.push(`Offered Curriculum evidence has inconsistent revision ownership.`);
      return null;
    }
    const result = verifyGrounding(ctx.blocks, { blockId: offer.blockId, quote: offer.quote });
    if (!result.ok) {
      errors.push(`Offered Curriculum evidence no longer resolves to exact authoritative text.`);
      return null;
    }
    if (
      result.grounding.blockId !== offer.blockId ||
      result.grounding.startOffset !== offer.startOffset ||
      result.grounding.endOffset !== offer.endOffset
    ) {
      errors.push(`Offered Curriculum evidence span no longer matches its authoritative identity.`);
      return null;
    }
    addSourceReference(nodeId, result.grounding);
    return result.grounding;
  }

  const rootNode: Curriculum['nodes'][number] = {
    id: rootId,
    parentId: null,
    kind: 'course',
    index: 0,
    title: ctx.courseTitle.slice(0, 300),
    sourceReferences: [],
    learningUnit: null,
  };
  const nodes: Curriculum['nodes'] = [rootNode];

  for (const proposed of parsed.nodes) {
    const id = nodeIdByKey.get(proposed.key)!;
    const parentId = proposed.parentKey === null ? rootId : nodeIdByKey.get(proposed.parentKey);
    if (!parentId) {
      errors.push(`Unknown Curriculum parent key: ${proposed.parentKey}`);
      continue;
    }

    const sourceEvidence: VerifiedGrounding[] = [];
    for (const evidence of proposed.sourceEvidence) {
      const verified = verifyEvidence(id, evidence);
      if (verified) sourceEvidence.push(verified);
    }

    const sourceConceptIds: string[] = [];
    const canonicalConceptIds: string[] = [];
    const graphRelationIds: string[] = [];
    const prerequisiteUnitIds: string[] = [];
    const objectives: CurriculumObjective[] = [];

    for (const structuralUnitId of proposed.structuralUnitIds) {
      const owner = ctx.structuralUnitOwners.get(structuralUnitId);
      if (!owner) {
        errors.push(`Unknown or out-of-manifest structural unit: ${structuralUnitId}`);
        continue;
      }
      const revision = ctx.executionSourceManifest.revisions.find(
        (candidate) =>
          candidate.materialId === owner.materialId &&
          candidate.materialRevisionId === owner.materialRevisionId,
      );
      if (!revision) {
        errors.push(
          `Structural unit is outside the exact execution-source manifest: ${structuralUnitId}`,
        );
      } else {
        addStructuralReference(id, structuralUnitId, owner);
      }
    }

    if (proposed.kind === 'learning_unit') {
      for (const conceptId of proposed.conceptIds) {
        const concept = conceptById.get(conceptId);
        if (!concept) {
          errors.push(`Unknown or out-of-scope Concept: ${conceptId}`);
          continue;
        }
        sourceConceptIds.push(concept.id);
        const grounded = verifyGrounding(ctx.blocks, concept.grounding);
        if (grounded.ok) {
          sourceEvidence.push(grounded.grounding);
          addSourceReference(id, grounded.grounding);
        } else {
          errors.push(`Existing Concept grounding is no longer valid: ${concept.id}`);
        }
      }
      for (const canonicalId of proposed.canonicalConceptIds) {
        if (!ctx.canonicalConceptIds.has(canonicalId)) {
          errors.push(`Unknown canonical Concept: ${canonicalId}`);
          continue;
        }
        canonicalConceptIds.push(canonicalId);
      }
      for (const relationId of proposed.graphRelationIds) {
        const edge = graphById.get(relationId);
        if (!edge) {
          errors.push(`Unknown graph relation: ${relationId}`);
          continue;
        }
        graphRelationIds.push(edge.id);
      }
      for (const prerequisiteKey of proposed.prerequisiteUnitKeys) {
        const prerequisiteId = nodeIdByKey.get(prerequisiteKey);
        if (!prerequisiteId) errors.push(`Unknown prerequisite LearningUnit: ${prerequisiteKey}`);
        else prerequisiteUnitIds.push(prerequisiteId);
      }
      for (const objective of proposed.objectives) {
        const objectiveId = newId('obj');
        objectiveIdByKey.set(objective.key, objectiveId);
        const evidence: VerifiedGrounding[] = [];
        for (const proposedEvidence of objective.evidence) {
          const verified = verifyEvidence(id, proposedEvidence);
          if (verified) evidence.push(verified);
        }
        const authority = authorityStatus(objective, evidence, ctx);
        objectives.push({
          id: objectiveId,
          title: objective.title,
          description: objective.description,
          truthPremiseStatus: authority.status,
          truthAuthorityRecordIds: authority.authorityIds,
        });
      }
    } else if (
      proposed.conceptIds.length ||
      proposed.canonicalConceptIds.length ||
      proposed.objectives.length ||
      proposed.prerequisiteUnitKeys.length ||
      proposed.graphRelationIds.length
    ) {
      errors.push(`Non-learning Curriculum node carries LearningUnit-only fields: ${proposed.key}`);
    }

    nodes.push({
      id,
      parentId,
      kind: proposed.kind,
      index: proposed.index,
      title: proposed.title,
      sourceReferences: (sourceRefsByNode.get(id) ?? []).slice(0, 100),
      learningUnit:
        proposed.kind === 'learning_unit'
          ? {
              conceptIds: sourceConceptIds,
              canonicalConceptIds,
              objectives,
              prerequisiteUnitIds,
              graphRelationIds,
              riskIds: [],
            }
          : null,
    });
    if (proposed.kind === 'learning_unit' && objectives.length === 0) {
      errors.push(`LearningUnit has no materialized objective: ${proposed.key}`);
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const siblingIndexes = new Set<string>();
  for (const node of nodes) {
    const key = `${node.parentId ?? 'root'}\u0000${node.index}`;
    if (siblingIndexes.has(key)) errors.push(`Duplicate Curriculum sibling index: ${key}`);
    siblingIndexes.add(key);
    if (node.parentId && !nodeIds.has(node.parentId))
      errors.push(`Unknown parent id: ${node.parentId}`);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      errors.push('Curriculum hierarchy contains a cycle.');
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const node = nodes.find((candidate) => candidate.id === id);
    if (node?.parentId) visit(node.parentId);
    visiting.delete(id);
    visited.add(id);
  };
  nodes.forEach((node) => visit(node.id));

  const unitById = new Map(
    nodes.filter((node) => node.learningUnit).map((node) => [node.id, node] as const),
  );
  const unitVisiting = new Set<string>();
  const unitVisited = new Set<string>();
  const visitUnit = (id: string): void => {
    if (unitVisiting.has(id)) {
      errors.push('Curriculum prerequisite graph contains a cycle.');
      return;
    }
    if (unitVisited.has(id)) return;
    unitVisiting.add(id);
    for (const prerequisiteId of unitById.get(id)?.learningUnit?.prerequisiteUnitIds ?? []) {
      if (unitById.has(prerequisiteId)) visitUnit(prerequisiteId);
      else errors.push(`Unknown prerequisite LearningUnit id: ${prerequisiteId}`);
    }
    unitVisiting.delete(id);
    unitVisited.add(id);
  };
  unitById.forEach((_node, id) => visitUnit(id));

  const synthesisGroups: Curriculum['synthesisGroups'] = [];
  for (const group of parsed.synthesisGroups) {
    const learningUnitIds = group.learningUnitKeys
      .map((key) => nodeIdByKey.get(key))
      .filter((id): id is string => Boolean(id));
    const objectiveIds = group.objectiveKeys
      .map((key) => objectiveIdByKey.get(key))
      .filter((id): id is string => Boolean(id));
    if (learningUnitIds.length < 2 || objectiveIds.length === 0) {
      errors.push(`Synthesis group did not map to known Curriculum entities: ${group.key}`);
      continue;
    }
    synthesisGroups.push({
      id: newId('syn'),
      title: group.title,
      level: group.level,
      learningUnitIds,
      objectiveIds,
    });
  }

  const unmappedStructuralUnitIds = [...ctx.structuralUnitOwners.keys()].filter(
    (id) => !nodes.some((node) => node.sourceReferences.some((ref) => ref.structuralUnitId === id)),
  );
  if (unmappedStructuralUnitIds.length > 0) {
    warnings.push(`Unmapped structural units remain visible: ${unmappedStructuralUnitIds.length}.`);
  }
  const unmappedBlocks = [...manifestBlockIds].filter((id) => !mappedBlockIds.has(id));
  if (unmappedBlocks.length > 0) {
    warnings.push(
      `Unmapped source blocks remain visible for risk reconciliation: ${unmappedBlocks.length}.`,
    );
  }

  const validation = {
    valid: errors.length === 0,
    errors: errors.slice(0, 100).map((error) => error.slice(0, 500)),
    warnings: warnings.slice(0, 100).map((warning) => warning.slice(0, 500)),
    unmappedStructuralUnitIds: unmappedStructuralUnitIds.slice(0, 1000),
  };
  // Keep this helper useful to callers that want to inspect a failed candidate,
  // while the service fails closed before persisting invalid active state.
  CurriculumValidationSchema.parse(validation);
  return { nodes, synthesisGroups, validation };
}

export function assertValidMaterializedCurriculum(
  result: MaterializedCurriculum,
  repairAttempted = false,
): void {
  if (!result.validation.valid)
    throwValidation(result.validation.errors, result.validation.warnings, repairAttempted);
}
