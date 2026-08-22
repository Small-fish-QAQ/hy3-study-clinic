import {
  ApiErrorCode,
  CurriculumProposalPayloadSchema,
  CurriculumProposalFailureDetailsSchema,
  CurriculumValidationSchema,
  type CurriculumAuthorityCritique,
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
  type CurriculumAuthorityEnvelopeTier,
  type FormalAssessmentConstruct,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
export { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import type { SourceAuthorityBundle } from '../repositories/sourceAuthority.js';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import { newId } from '../util/ids.js';
import {
  buildCurriculumAuthorityEnvelope,
  detectFormalConstruct,
  isConstructSupported,
} from './curriculumAuthority.js';

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
  /** Authoritative alignment membership offered for this operation snapshot. */
  canonicalConceptMembers: Map<string, string[]>;
  canonicalConceptIdsBySourceConcept: Map<string, string[]>;
  /** Immutable exact excerpts offered for this operation snapshot. */
  evidenceCatalog: CurriculumEvidenceOffer[];
  limits: {
    maxNodes: number;
    maxObjectives: number;
    maxSynthesisGroups: number;
  };
  authorityBundles: SourceAuthorityBundle[];
  /** Source authority decisions are local, never provider output. */
  isAuthorityBlockingEligible: (authorityRecordId: string) => boolean;
}

export interface MaterializedCurriculum {
  nodes: Curriculum['nodes'];
  synthesisGroups: Curriculum['synthesisGroups'];
  validation: Curriculum['validation'];
  authorityCritiques: CurriculumAuthorityCritique[];
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

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function normalizeLearnerTitle(value: string): string {
  return normalize(value).replace(/[\p{P}\p{S}]/gu, '');
}

/**
 * Duplicate headings are common in extracted long documents. They are not a
 * reason to expose several indistinguishable learner units. When the units
 * carry different concept/objective meaning, retain both and make that
 * meaning visible; when their source/objective meaning is identical, reject
 * the candidate so the previous accepted version remains authoritative.
 */
export function normalizeDuplicateLearningUnitTitles(
  nodes: Curriculum['nodes'],
  concepts: Concept[],
  blocks: SourceBlock[],
  errors: string[],
): void {
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const siblings = new Map<string, Curriculum['nodes']>();
  const reportedTitleKeys = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'learning_unit') continue;
    // A repeated section wrapper can hide duplicate units from a parent-only
    // check, so compare learner-visible LearningUnits across the whole course.
    const key = normalizeLearnerTitle(node.title);
    const group = siblings.get(key) ?? [];
    group.push(node);
    siblings.set(key, group);
  }
  for (const [key, group] of siblings) {
    if (group.length < 2) continue;
    const labels = group.map((node) => {
      const conceptsForUnit = (node.learningUnit?.conceptIds ?? [])
        .map((id) => conceptById.get(id)?.name)
        .filter((name): name is string => Boolean(name))
        .map((name) => name.trim())
        .filter(Boolean);
      const objective = node.learningUnit?.objectives[0]?.title
        ?.replace(/^understand\s+/iu, '')
        .trim();
      const sourceHint = (node.sourceReferences ?? [])
        .map((ref) => (ref.sourceBlockId ? blockById.get(ref.sourceBlockId)?.content : null))
        .find((content): content is string => Boolean(content))
        ?.split(/(?<=[.!?。！？；;])\s*/u)[0]
        ?.trim()
        .replace(/\s+/gu, ' ')
        .slice(0, 80);
      const semanticParts = [
        ...conceptsForUnit,
        objective && normalizeLearnerTitle(objective) !== normalizeLearnerTitle(node.title)
          ? objective
          : '',
      ];
      if (semanticParts.filter(Boolean).length === 0) semanticParts.push(sourceHint ?? '');
      return [...new Set(semanticParts)].filter(Boolean).join(' / ');
    });
    const normalizedLabels = labels.map(normalizeLearnerTitle);
    const canDisambiguate =
      labels.every(Boolean) && new Set(normalizedLabels).size === normalizedLabels.length;
    if (canDisambiguate) {
      group.forEach((node, index) => {
        const label = labels[index]!;
        const suffix = ` - ${label}`;
        node.title = `${node.title.trim().slice(0, Math.max(1, 300 - suffix.length))}${suffix}`;
      });
      continue;
    }
    const semanticKeys = group.map((node) => {
      const source = (node.sourceReferences ?? [])
        .map(
          (ref) =>
            `${ref.materialRevisionId}\u0000${ref.structuralUnitId ?? ''}\u0000${ref.sourceBlockId ?? ''}`,
        )
        .sort()
        .join('\u0001');
      const objectives = (node.learningUnit?.objectives ?? [])
        .map(
          (objective) => `${normalize(objective.title)}\u0000${normalize(objective.description)}`,
        )
        .sort()
        .join('\u0001');
      return `${source}\u0002${objectives}`;
    });
    if (
      new Set(semanticKeys).size !== semanticKeys.length ||
      new Set(normalizedLabels).size === 1
    ) {
      reportedTitleKeys.add(key);
      errors.push(
        `Duplicate learner-visible LearningUnit title has no distinct source/objective meaning: ${key.split('\u0000')[1] ?? key}.`,
      );
    } else {
      reportedTitleKeys.add(key);
      errors.push(
        `Duplicate learner-visible LearningUnit title could not be deterministically disambiguated: ${key.split('\u0000')[1] ?? key}.`,
      );
    }
  }
  const finalTitles = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== 'learning_unit') continue;
    const titleKey = normalizeLearnerTitle(node.title);
    const previous = finalTitles.get(titleKey);
    if (previous && previous !== node.id && !reportedTitleKeys.has(titleKey)) {
      errors.push(`LearningUnit title normalization still collides for ${node.title}.`);
    }
    finalTitles.set(titleKey, node.id);
  }
}

interface AuthorityAssessment {
  status: TruthPremiseStatus;
  authorityIds: string[];
  construct: FormalAssessmentConstruct;
  envelopeTier: CurriculumAuthorityEnvelopeTier;
  formalEvidenceSourceBlockIds: string[];
  readinessRationale: string;
  critique: CurriculumAuthorityCritique | undefined;
}

function authorityStatus(
  objective: {
    key: string;
    title: string;
    description: string;
    priority?: 'required' | 'high' | 'normal' | 'optional';
  },
  evidence: VerifiedGrounding[],
  ctx: CurriculumValidationContext,
  nodeId: string,
): AuthorityAssessment {
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
  const evidenceOffers = ctx.evidenceCatalog.filter((offer) =>
    evidenceKeys.has(`${offer.blockId}\u0000${offer.quote}`),
  );
  const envelope = buildCurriculumAuthorityEnvelope({
    sourceRegionId: nodeId,
    sourceBlockIds: evidence.map((item) => item.blockId),
    evidence: evidenceOffers,
    authorityBundles: matched,
    isBlockingEligible: ctx.isAuthorityBlockingEligible,
  });
  const construct = detectFormalConstruct(`${objective.title} ${objective.description}`);
  const conflicted = matched.filter((bundle) => bundle.record.conflictState === 'unresolved');
  if (conflicted.length > 0) {
    return {
      status: 'conflicted',
      authorityIds: conflicted.map((bundle) => bundle.record.id).slice(0, 20),
      construct,
      envelopeTier: envelope.tier,
      formalEvidenceSourceBlockIds: [],
      readinessRationale: '当前来源存在未解决的权威冲突，不能用于正式评估。',
      critique:
        objective.priority === 'required'
          ? {
              objectiveId: null,
              objectiveKey: objective.key,
              currentClaim: `${objective.title}: ${objective.description}`,
              affectedSourceRegionIds: [nodeId],
              affectedSourceBlockIds: evidence.map((item) => item.blockId).slice(0, 100),
              authorityTier: envelope.tier,
              supportedConstructs: envelope.supportedConstructs,
              narrowerClaim: envelope.narrowerClaim,
              reason: '当前来源权威存在未解决冲突，不能授予正式评估权威。',
              protectedPriority: 'required',
            }
          : undefined,
    };
  }
  const eligible = envelope.formalEvidenceIds.length > 0;
  const supported = isConstructSupported(construct, envelope);
  const ready = eligible && supported;
  const authorityIds = matched
    .filter(
      (bundle) =>
        bundle.record.validationState === 'validated' &&
        ctx.isAuthorityBlockingEligible(bundle.record.id),
    )
    .map((bundle) => bundle.record.id)
    .slice(0, 20);
  const reason = !eligible
    ? envelope.tier === 'teaching_only'
      ? '当前来源可用于教学解释，但没有独立验证的正式证据。'
      : '当前来源没有足以支持正式评估的精确权威。'
    : !supported
      ? `当前来源的正式权威仅支持 ${envelope.supportedConstructs.join('、') || '更窄'} 构念，不能支持 ${construct}。`
      : '当前版本存在已验证且无冲突的精确来源权威。';
  return {
    status: ready ? 'independently_verified' : 'unverified',
    authorityIds:
      authorityIds.length > 0
        ? authorityIds
        : matched.map((bundle) => bundle.record.id).slice(0, 20),
    construct,
    envelopeTier: envelope.tier,
    formalEvidenceSourceBlockIds: evidenceOffers
      .filter((offer) => envelope.formalEvidenceIds.includes(offer.id))
      .map((offer) => offer.blockId)
      .slice(0, 100),
    readinessRationale: reason,
    critique:
      objective.priority === 'required' && !ready
        ? {
            objectiveId: null,
            objectiveKey: objective.key,
            currentClaim: `${objective.title}: ${objective.description}`,
            affectedSourceRegionIds: [nodeId],
            affectedSourceBlockIds: evidence.map((item) => item.blockId).slice(0, 100),
            authorityTier: envelope.tier,
            supportedConstructs: envelope.supportedConstructs,
            narrowerClaim: envelope.narrowerClaim,
            reason,
            protectedPriority: 'required',
          }
        : undefined,
  };
}

function throwValidation(
  errors: string[],
  warnings: string[] = [],
  repairAttempted = false,
  authorityCritiques: CurriculumAuthorityCritique[] = [],
): never {
  const executionRepairFailed = errors.some((error) =>
    error.startsWith('StudyPlan execution repair:'),
  );
  const details = CurriculumProposalFailureDetailsSchema.parse({
    kind: 'curriculum_candidate_validation',
    repairAttempted,
    errors: errors.slice(0, 20),
    warnings: warnings.slice(0, 20),
    ...(authorityCritiques.length > 0
      ? { authorityCritiques: authorityCritiques.slice(0, 20) }
      : {}),
  });
  throw new AppError(
    ApiErrorCode.GroundingFailed,
    executionRepairFailed
      ? repairAttempted
        ? '新课程结构仍不能支持下一步学习，因此没有生成新版本。当前已接受版本未改变，系统已尝试一次修复。'
        : '新课程结构仍不能支持下一步学习，因此没有生成新版本。当前已接受版本未改变。'
      : repairAttempted
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
  const authorityCritiques: CurriculumAuthorityCritique[] = [];
  const nodeIdByKey = new Map<string, string>();
  const objectiveIdByKey = new Map<string, string>();
  const conceptById = new Map(ctx.concepts.map((concept) => [concept.id, concept]));
  const graphById = new Map(ctx.graphEdges.map((edge) => [edge.id, edge]));
  const blockById = new Map(ctx.blocks.map((block) => [block.id, block]));
  const manifestBlockIds = new Set(
    ctx.executionSourceManifest.revisions.flatMap((revision) => revision.sourceBlockRevisionIds),
  );
  const objectiveCount = parsed.nodes.reduce((sum, node) => sum + node.objectives.length, 0);
  if (parsed.nodes.length > ctx.limits.maxNodes) {
    errors.push(`Curriculum exceeds the offered node limit of ${ctx.limits.maxNodes}.`);
  }
  if (objectiveCount > ctx.limits.maxObjectives) {
    errors.push(`Curriculum exceeds the offered objective limit of ${ctx.limits.maxObjectives}.`);
  }
  if (parsed.synthesisGroups.length > ctx.limits.maxSynthesisGroups) {
    errors.push(
      `Curriculum exceeds the offered synthesis-group limit of ${ctx.limits.maxSynthesisGroups}.`,
    );
  }

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
      sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(
        block,
        revision.materialRevisionId,
      ),
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
    if (offeredBlock?.contentOrigin && offeredBlock.contentOrigin !== 'extracted_original') {
      errors.push(`Derived text is advisory and cannot satisfy Curriculum evidence.`);
      return null;
    }
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

    const selectedEvidence: VerifiedGrounding[] = [];
    for (const evidence of proposed.sourceEvidence) {
      const verified = verifyEvidence(id, evidence);
      if (verified) {
        selectedEvidence.push(verified);
      }
    }

    const sourceConceptIds: string[] = [];
    const canonicalConceptIds: string[] = [];
    const requestedCanonicalConceptIds: string[] = [];
    const graphRelationIds: string[] = [];
    const prerequisiteUnitIds: string[] = [];
    const objectives: CurriculumObjective[] = [];

    const addConcept = (conceptId: string): void => {
      if (sourceConceptIds.includes(conceptId)) return;
      const concept = conceptById.get(conceptId);
      if (!concept) {
        errors.push(`Unknown or out-of-scope Concept: ${conceptId}`);
        return;
      }
      if (sourceConceptIds.length >= 30) {
        if (
          !warnings.includes('Additional exact Concept bindings were omitted at the local limit.')
        ) {
          warnings.push('Additional exact Concept bindings were omitted at the local limit.');
        }
        return;
      }
      const grounded = verifyGrounding(ctx.blocks, concept.grounding);
      if (
        concept.grounding &&
        blockById.get(concept.grounding.blockId)?.contentOrigin &&
        blockById.get(concept.grounding.blockId)?.contentOrigin !== 'extracted_original'
      ) {
        errors.push(`Derived text cannot ground a formal Curriculum Concept: ${concept.id}`);
        return;
      }
      if (!grounded.ok) {
        errors.push(`Existing Concept grounding is no longer valid: ${concept.id}`);
        return;
      }
      sourceConceptIds.push(concept.id);
      addSourceReference(id, grounded.grounding);
    };

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
        addConcept(conceptId);
      }
      for (const canonicalId of proposed.canonicalConceptIds) {
        if (!ctx.canonicalConceptIds.has(canonicalId)) {
          errors.push(`Unknown canonical Concept: ${canonicalId}`);
          continue;
        }
        requestedCanonicalConceptIds.push(canonicalId);
        for (const conceptId of ctx.canonicalConceptMembers.get(canonicalId) ?? []) {
          addConcept(conceptId);
        }
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
          if (verified) {
            evidence.push(verified);
            selectedEvidence.push(verified);
          }
        }
        const authority = authorityStatus(objective, evidence, ctx, id);
        if (authority.critique) {
          authority.critique.objectiveId = objectiveId;
          authorityCritiques.push(authority.critique);
        }
        objectives.push({
          id: objectiveId,
          title: objective.title,
          description: objective.description,
          truthPremiseStatus: authority.status,
          truthAuthorityRecordIds: authority.authorityIds,
          ...(objective.priority ? { priority: objective.priority } : {}),
          ...(objective.priorityRationale
            ? { priorityRationale: objective.priorityRationale }
            : {}),
          ...(objective.priority === 'required'
            ? {
                formalAssessmentReady:
                  authority.status === 'independently_verified' &&
                  authority.authorityIds.length > 0,
                formalAssessmentReadinessRationale: authority.readinessRationale,
              }
            : {}),
          formalAssessmentConstruct: authority.construct,
          authorityEnvelopeTier: authority.envelopeTier,
          formalEvidenceSourceBlockIds: authority.formalEvidenceSourceBlockIds,
        });
      }

      // Exact provider evidence and accepted alignment membership are enough
      // to derive identity bindings locally. The model never grants Concept
      // authority merely by emitting a persistent id.
      const selectedEvidenceKeys = new Set(
        selectedEvidence.map(
          (evidence) =>
            `${evidence.blockId}\u0000${evidence.quote}\u0000${evidence.startOffset}\u0000${evidence.endOffset}`,
        ),
      );
      for (const concept of [...ctx.concepts].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        const key = `${concept.grounding.blockId}\u0000${concept.grounding.quote}\u0000${concept.grounding.startOffset}\u0000${concept.grounding.endOffset}`;
        if (selectedEvidenceKeys.has(key)) addConcept(concept.id);
      }

      const derivedCanonicalIds = sourceConceptIds
        .flatMap((conceptId) => ctx.canonicalConceptIdsBySourceConcept.get(conceptId) ?? [])
        .sort((left, right) => left.localeCompare(right));
      for (const canonicalId of [...requestedCanonicalConceptIds, ...derivedCanonicalIds]) {
        if (canonicalConceptIds.includes(canonicalId)) continue;
        if (!ctx.canonicalConceptIds.has(canonicalId)) {
          errors.push(`Unknown canonical Concept: ${canonicalId}`);
          continue;
        }
        const members = ctx.canonicalConceptMembers.get(canonicalId) ?? [];
        if (!members.some((conceptId) => sourceConceptIds.includes(conceptId))) {
          errors.push(
            `Canonical Concept has no authoritative member in this LearningUnit: ${canonicalId}`,
          );
          continue;
        }
        if (canonicalConceptIds.length >= 20) {
          if (
            !warnings.includes(
              'Additional canonical Concept bindings were omitted at the local limit.',
            )
          ) {
            warnings.push('Additional canonical Concept bindings were omitted at the local limit.');
          }
          break;
        }
        canonicalConceptIds.push(canonicalId);
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

  normalizeDuplicateLearningUnitTitles(nodes, ctx.concepts, ctx.blocks, errors);

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
  return { nodes, synthesisGroups, validation, authorityCritiques };
}

/**
 * Apply one deterministic authority repair to a provider candidate. The repair
 * only narrows wording to an exact local claim and never changes protected
 * priority, source selections, ids, or learner scope.
 */
export function repairCurriculumAuthorityCandidate(
  payload: CurriculumProposalPayload,
  ctx: CurriculumValidationContext,
): { payload: CurriculumProposalPayload; repaired: boolean } {
  const candidate = CurriculumProposalPayloadSchema.parse(payload);
  const materialized = materializeCurriculumProposal(candidate, ctx);
  if (materialized.authorityCritiques.length === 0) return { payload: candidate, repaired: false };
  const critiqueByKey = new Map(
    materialized.authorityCritiques
      .filter((critique) => critique.objectiveKey)
      .map((critique) => [critique.objectiveKey!, critique]),
  );
  let repaired = false;
  for (const node of candidate.nodes) {
    if (node.kind !== 'learning_unit') continue;
    for (const objective of node.objectives) {
      const critique = critiqueByKey.get(objective.key);
      if (
        !critique?.narrowerClaim ||
        (critique.authorityTier !== 'formal_sufficient' &&
          critique.authorityTier !== 'narrower_formal') ||
        critique.supportedConstructs.length === 0
      )
        continue;
      const construct = critique.supportedConstructs.includes('explain') ? 'Explain' : 'Identify';
      const claim = critique.narrowerClaim.slice(0, 500);
      objective.title = `${construct} the source-supported claim: ${claim}`.slice(0, 300);
      objective.description =
        `${construct} only what the current source explicitly states: ${claim}`.slice(0, 1_000);
      // Required priority is intentionally preserved. The provider cannot
      // satisfy an authority critique by downgrading learner scope.
      repaired = true;
    }
  }
  return { payload: candidate, repaired };
}

export function assertValidMaterializedCurriculum(
  result: MaterializedCurriculum,
  repairAttempted = false,
  rejectAuthorityCritiques = false,
): void {
  if (
    !result.validation.valid ||
    (rejectAuthorityCritiques && result.authorityCritiques.length > 0)
  )
    throwValidation(
      [
        ...result.validation.errors,
        ...(result.authorityCritiques.length > 0
          ? ['required_objective_formal_authority_missing']
          : []),
      ],
      result.validation.warnings,
      repairAttempted,
      result.authorityCritiques,
    );
}
