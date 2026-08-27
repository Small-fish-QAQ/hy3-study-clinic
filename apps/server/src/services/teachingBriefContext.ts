import { createHash } from 'node:crypto';
import type {
  Concept,
  Curriculum,
  EmbeddedAsset,
  Material,
  SourceAuthorityBundle,
  SourceBlockRevision,
  TeachingBriefSourceReference,
  TeachingBriefVisualReference,
  VisualAdvisoryContext,
  VisualDerivation,
} from '@hy3-clinic/shared';
import { VisualAdvisoryContextSchema, VisualMediaTypeSchema } from '@hy3-clinic/shared';
import {
  objectiveAuthoritySemanticallySupportedClaimIds,
  objectiveAuthoritySemanticProvenanceMappings,
} from './objectiveAuthoritySemanticSupport.js';

export const TEACHING_BRIEF_MAX_BLOCKS = 24;
export const TEACHING_BRIEF_MAX_OFFERS = 24;
export const TEACHING_BRIEF_MAX_EXCERPT_CHARS = 1200;
export const TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES = 32_768;
export const TEACHING_BRIEF_MAX_VISUAL_OFFERS = 8;
export const TEACHING_BRIEF_MAX_SERIALIZED_VISUAL_BYTES = 16_384;

export interface TeachingBriefSourceOffer {
  sourceRef: string;
  materialTitle: string;
  headingPath: string[];
  pageNumber: number | null;
  slideNumber: number | null;
  text: string;
}

export interface TeachingBriefProviderSourceOffer extends TeachingBriefSourceOffer {
  authorizedObjectiveRefs: string[];
}

export interface TeachingBriefProviderSourceEnvelope {
  offers: TeachingBriefProviderSourceOffer[];
  objectiveEvidenceAliases: Array<{
    objectiveRef: string;
    evidenceAliases: Array<{ sourceRef: string; text: string }>;
  }>;
}

/** One canonical UTF-8 measurement for every Teaching source budget check. */
export function serializedTeachingSourceBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Measure the exact provider-visible text source envelope. This intentionally
 * includes both annotated S* offers and the full claim text repeated in each
 * objective-scoped evidence alias.
 */
export function serializedTeachingProviderSourceEnvelopeBytes(
  envelope: TeachingBriefProviderSourceEnvelope,
): number {
  return serializedTeachingSourceBytes(envelope);
}

export interface TeachingBriefSourceContext {
  fingerprint: string;
  blockCount: number;
  offerCount: number;
  serializedBytes: number;
  materialCount: number;
  sectionCount: number;
  offers: TeachingBriefSourceOffer[];
  references: TeachingBriefSourceReference[];
  visualOfferCount: number;
  visualSerializedBytes: number;
  visualOffers: VisualAdvisoryContext[];
  visualReferences: TeachingBriefVisualReference[];
}

export interface TeachingBriefVisualCandidate {
  asset: EmbeddedAsset;
  derivation: VisualDerivation;
}

interface BuildTeachingBriefSourceContextInput {
  workspaceId: string;
  curriculum: Curriculum;
  learningUnitId: string;
  materials: Material[];
  blocks: SourceBlockRevision[];
  concepts: Concept[];
  /** Route-scoped objectives whose supported exact claims may authorize provider aliases. */
  authorizedObjectiveIds?: string[];
  /** Private local authority identity; never copied into provider-visible offers. */
  sourceAuthorityBundles?: SourceAuthorityBundle[];
  visuals?: TeachingBriefVisualCandidate[];
}

interface Candidate {
  block: SourceBlockRevision;
  priority: number;
  quote: string;
  startOffset: number;
  authorityClaimIds: string[];
}

function fingerprint(value: unknown): string {
  return `lesson_context_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40)}`;
}

/**
 * Build one fixed-budget lesson context. Curriculum evidence wins, then
 * Concept grounding, then one-block local neighborhoods. Corpus size does not
 * affect the hard block/byte ceilings.
 */
export function buildTeachingBriefSourceContext({
  workspaceId,
  curriculum,
  learningUnitId,
  materials,
  blocks,
  concepts,
  authorizedObjectiveIds = [],
  sourceAuthorityBundles = [],
  visuals = [],
}: BuildTeachingBriefSourceContextInput): TeachingBriefSourceContext {
  if (curriculum.workspaceId !== workspaceId || curriculum.status !== 'accepted') {
    throw new Error('Teaching Brief requires an accepted Curriculum owned by this Course.');
  }
  const node = curriculum.nodes.find((candidate) => candidate.id === learningUnitId);
  if (!node?.learningUnit) throw new Error('Teaching Brief requires an existing LearningUnit.');

  const materialById = new Map(materials.map((material) => [material.id, material]));
  const manifestRevisionByMaterialId = new Map(
    curriculum.executionSourceManifest.revisions.map((revision) => [revision.materialId, revision]),
  );
  const manifestBlockIds = new Set(
    curriculum.executionSourceManifest.revisions.flatMap(
      (revision) => revision.sourceBlockRevisionIds,
    ),
  );
  for (const revision of curriculum.executionSourceManifest.revisions) {
    const material = materialById.get(revision.materialId);
    if (!material || material.workspaceId !== workspaceId) {
      throw new Error('Teaching Brief source Material is outside this Course.');
    }
    if (
      material.availability === 'retired' ||
      material.activeRevisionId !== revision.materialRevisionId
    ) {
      throw new Error('Teaching Brief source MaterialRevision is stale.');
    }
  }

  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const assertCurrentBlock = (block: SourceBlockRevision): void => {
    const revision = manifestRevisionByMaterialId.get(block.materialId);
    if (
      !revision ||
      !manifestBlockIds.has(block.id) ||
      block.materialRevisionId !== revision.materialRevisionId ||
      !revision.sourceBlockRevisionIds.includes(block.id)
    ) {
      throw new Error('Teaching Brief source block is stale or outside the Curriculum manifest.');
    }
  };

  const contextualCandidates = new Map<string, Candidate>();
  const addContext = (
    block: SourceBlockRevision,
    priority: number,
    quote?: string,
    startOffset = 0,
  ) => {
    assertCurrentBlock(block);
    const exactQuote = (quote ?? block.content.slice(0, TEACHING_BRIEF_MAX_EXCERPT_CHARS)).slice(
      0,
      TEACHING_BRIEF_MAX_EXCERPT_CHARS,
    );
    if (
      !exactQuote ||
      block.content.slice(startOffset, startOffset + exactQuote.length) !== exactQuote
    ) {
      throw new Error('Teaching Brief source excerpt is not exact current block text.');
    }
    const prior = contextualCandidates.get(block.id);
    if (!prior || priority < prior.priority) {
      contextualCandidates.set(block.id, {
        block,
        priority,
        quote: exactQuote,
        startOffset,
        authorityClaimIds: [],
      });
    }
  };

  const authorityById = new Map<string, SourceAuthorityBundle>();
  const claimById = new Map<
    string,
    { bundle: SourceAuthorityBundle; claim: SourceAuthorityBundle['claims'][number] }
  >();
  for (const bundle of sourceAuthorityBundles) {
    if (authorityById.has(bundle.record.id)) {
      throw new Error('Teaching Brief source authority bundles must be record-unique.');
    }
    authorityById.set(bundle.record.id, bundle);
    for (const claim of bundle.claims) {
      if (claim.authorityRecordId !== bundle.record.id || claimById.has(claim.id)) {
        throw new Error('Teaching Brief source authority claim identity is corrupt or ambiguous.');
      }
      claimById.set(claim.id, { bundle, claim });
    }
  }

  const exactCandidatesBySpan = new Map<string, Candidate>();
  const exactCandidateKeysByObjective = new Map<string, string[]>();
  const requestedObjectiveIds = new Set(authorizedObjectiveIds);
  if (requestedObjectiveIds.size !== authorizedObjectiveIds.length) {
    throw new Error('Teaching Brief authorized objective identities must be unique.');
  }
  for (const objectiveId of authorizedObjectiveIds) {
    const objective = node.learningUnit.objectives.find(
      (candidate) => candidate.id === objectiveId,
    );
    if (!objective?.semanticSupport || objective.semanticSupport.verdict !== 'pass') {
      throw new Error('Teaching Brief objective lacks passing semantic source support.');
    }
    const selectedClaimIds = new Set(objective.authorityClaimIds ?? []);
    const boundClaimIds = new Set(objective.semanticSupport.boundAuthorityClaimIds);
    const supportedClaimIds = objectiveAuthoritySemanticallySupportedClaimIds(
      objective.semanticSupport,
    );
    const semanticMappings = objectiveAuthoritySemanticProvenanceMappings(
      objective.semanticSupport,
    );
    if (supportedClaimIds.length === 0) {
      throw new Error('Teaching Brief objective has no exact semantically supported source claim.');
    }
    const objectiveCandidateKeys: string[] = [];
    for (const claimId of supportedClaimIds) {
      if (!selectedClaimIds.has(claimId) || !boundClaimIds.has(claimId)) {
        throw new Error(
          'Teaching Brief semantic support maps a claim outside the objective claim binding.',
        );
      }
      const resolved = claimById.get(claimId);
      if (!resolved) {
        throw new Error('Teaching Brief semantically supported source claim is unavailable.');
      }
      const { bundle, claim } = resolved;
      const mapping = semanticMappings.find((candidate) =>
        candidate.authorityClaimIds.includes(claimId),
      )!;
      if (
        !objective.truthAuthorityRecordIds.includes(bundle.record.id) ||
        !mapping.authorityRecordIds.includes(bundle.record.id) ||
        !mapping.sourceBlockIds.includes(claim.sourceBlockId) ||
        bundle.record.workspaceId !== workspaceId ||
        bundle.record.materialId === null ||
        bundle.record.materialRevisionId === null
      ) {
        throw new Error('Teaching Brief semantically supported claim has invalid record binding.');
      }
      const block = blockById.get(claim.sourceBlockId);
      if (!block) {
        throw new Error('Teaching Brief semantically supported source claim block is unavailable.');
      }
      assertCurrentBlock(block);
      if (
        block.materialId !== bundle.record.materialId ||
        block.materialRevisionId !== bundle.record.materialRevisionId ||
        claim.endOffset - claim.startOffset !== claim.quote.length ||
        block.content.slice(claim.startOffset, claim.endOffset) !== claim.quote
      ) {
        throw new Error(
          'Teaching Brief semantically supported source claim is stale or not exact current text.',
        );
      }
      const spanKey = `${block.id}\u0000${claim.startOffset}\u0000${claim.endOffset}\u0000${claim.quote}`;
      const candidate = exactCandidatesBySpan.get(spanKey) ?? {
        block,
        priority: 0,
        quote: claim.quote,
        startOffset: claim.startOffset,
        authorityClaimIds: [],
      };
      if (!candidate.authorityClaimIds.includes(claim.id)) {
        if (candidate.authorityClaimIds.length >= 200) {
          throw new Error(
            'Teaching Brief exact semantic claim envelope exceeds reference identity limits.',
          );
        }
        candidate.authorityClaimIds.push(claim.id);
      }
      exactCandidatesBySpan.set(spanKey, candidate);
      if (!objectiveCandidateKeys.includes(spanKey)) objectiveCandidateKeys.push(spanKey);
    }
    exactCandidateKeysByObjective.set(objectiveId, objectiveCandidateKeys);
  }

  for (const reference of node.sourceReferences) {
    if (!reference.sourceBlockId) continue;
    const block = blockById.get(reference.sourceBlockId);
    if (!block) throw new Error('Curriculum-mapped Teaching Brief evidence is unavailable.');
    if (
      block.materialId !== reference.materialId ||
      block.materialRevisionId !== reference.materialRevisionId ||
      (reference.sourceBlockRevisionFingerprint !== null &&
        block.revisionFingerprint !== reference.sourceBlockRevisionFingerprint)
    ) {
      throw new Error('Curriculum-mapped Teaching Brief evidence is stale.');
    }
    addContext(block, 1);
  }

  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
  for (const conceptId of node.learningUnit.conceptIds) {
    const concept = conceptById.get(conceptId);
    if (!concept) throw new Error('Teaching Brief Concept grounding is unavailable.');
    const block = blockById.get(concept.grounding.blockId);
    if (!block || concept.materialRevisionId !== block.materialRevisionId) {
      throw new Error('Teaching Brief Concept grounding is stale.');
    }
    addContext(block, 2, concept.grounding.quote, concept.grounding.startOffset);
  }

  const primary = [...exactCandidatesBySpan.values(), ...contextualCandidates.values()];
  const blocksByRevision = new Map<string, SourceBlockRevision[]>();
  for (const block of blocks) {
    if (!manifestBlockIds.has(block.id)) continue;
    const rows = blocksByRevision.get(block.materialRevisionId) ?? [];
    rows.push(block);
    blocksByRevision.set(block.materialRevisionId, rows);
  }
  for (const rows of blocksByRevision.values())
    rows.sort((left, right) => left.index - right.index);
  for (const candidate of primary) {
    const rows = blocksByRevision.get(candidate.block.materialRevisionId) ?? [];
    const position = rows.findIndex((block) => block.id === candidate.block.id);
    for (const neighbor of [rows[position - 1], rows[position + 1]]) {
      if (neighbor) addContext(neighbor, 3);
    }
  }

  const manifestOrder = new Map(
    curriculum.executionSourceManifest.revisions.flatMap((revision, revisionIndex) =>
      revision.sourceBlockRevisionIds.map(
        (blockId, blockIndex) => [blockId, revisionIndex * 1_000_000 + blockIndex] as const,
      ),
    ),
  );
  const compareCandidates = (left: Candidate, right: Candidate) =>
    left.priority - right.priority ||
    (manifestOrder.get(left.block.id) ?? Number.MAX_SAFE_INTEGER) -
      (manifestOrder.get(right.block.id) ?? Number.MAX_SAFE_INTEGER) ||
    left.startOffset - right.startOffset ||
    left.quote.localeCompare(right.quote) ||
    left.block.id.localeCompare(right.block.id);
  const exactCandidates = [...exactCandidatesBySpan.values()].sort(compareCandidates);
  const fairExactCandidates: Candidate[] = [];
  const selectedExactCandidates = new Set<Candidate>();
  for (const objectiveId of authorizedObjectiveIds) {
    const first = exactCandidateKeysByObjective
      .get(objectiveId)
      ?.map((key) => exactCandidatesBySpan.get(key)!)
      .sort(compareCandidates)
      .find((candidate) => !selectedExactCandidates.has(candidate));
    if (first) {
      selectedExactCandidates.add(first);
      fairExactCandidates.push(first);
    }
  }
  for (const candidate of exactCandidates) {
    if (!selectedExactCandidates.has(candidate)) fairExactCandidates.push(candidate);
  }
  const orderedContext = [...contextualCandidates.values()].sort(compareCandidates);
  const ordered = [...fairExactCandidates, ...orderedContext];

  const offers: TeachingBriefSourceOffer[] = [];
  const references: TeachingBriefSourceReference[] = [];
  for (const candidate of ordered) {
    const exactAuthority = candidate.authorityClaimIds.length > 0;
    if (
      offers.length >= TEACHING_BRIEF_MAX_OFFERS ||
      references.length >= TEACHING_BRIEF_MAX_BLOCKS
    ) {
      if (exactAuthority) {
        throw new Error('Teaching Brief exact semantic claim envelope exceeds offer limits.');
      }
      break;
    }
    const material = materialById.get(candidate.block.materialId)!;
    const refId = `S${offers.length + 1}`;
    const offer: TeachingBriefSourceOffer = {
      sourceRef: refId,
      materialTitle: material.title,
      headingPath: candidate.block.headingPath,
      pageNumber: candidate.block.pageNumber,
      slideNumber: candidate.block.slideNumber ?? null,
      text: candidate.quote,
    };
    const nextOffers = [...offers, offer];
    if (serializedTeachingSourceBytes(nextOffers) > TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES) {
      if (exactAuthority) {
        throw new Error('Teaching Brief exact semantic claim envelope exceeds the byte budget.');
      }
      continue;
    }
    offers.push(offer);
    references.push({
      refId,
      materialId: candidate.block.materialId,
      materialRevisionId: candidate.block.materialRevisionId,
      sourceBlockId: candidate.block.id,
      sourceBlockRevisionFingerprint: candidate.block.revisionFingerprint,
      startOffset: candidate.startOffset,
      endOffset: candidate.startOffset + candidate.quote.length,
      quote: candidate.quote,
      ...(exactAuthority ? { authorityClaimIds: [...candidate.authorityClaimIds] } : {}),
      headingPath: candidate.block.headingPath,
      pageNumber: candidate.block.pageNumber,
      slideNumber: candidate.block.slideNumber ?? null,
    });
  }
  const revisionOrder = new Map(
    curriculum.executionSourceManifest.revisions.map((revision, index) => [
      revision.materialRevisionId,
      index,
    ]),
  );
  const seenVisualAssets = new Set<string>();
  const orderedVisuals = [...visuals].sort(
    (left, right) =>
      (revisionOrder.get(left.asset.materialRevisionId) ?? Number.MAX_SAFE_INTEGER) -
        (revisionOrder.get(right.asset.materialRevisionId) ?? Number.MAX_SAFE_INTEGER) ||
      left.asset.index - right.asset.index ||
      left.asset.id.localeCompare(right.asset.id),
  );
  const visualOffers: VisualAdvisoryContext[] = [];
  const visualReferences: TeachingBriefVisualReference[] = [];
  for (const candidate of orderedVisuals) {
    if (seenVisualAssets.has(candidate.asset.id)) {
      throw new Error('Teaching Brief visual candidates must be occurrence-unique.');
    }
    seenVisualAssets.add(candidate.asset.id);
    const material = materialById.get(candidate.asset.materialId);
    const manifestRevision = manifestRevisionByMaterialId.get(candidate.asset.materialId);
    const { asset, derivation } = candidate;
    if (
      !material ||
      !manifestRevision ||
      material.activeRevisionId !== asset.materialRevisionId ||
      manifestRevision.materialRevisionId !== asset.materialRevisionId ||
      asset.relationshipKind !== 'image' ||
      asset.contentOrigin !== 'extracted_original' ||
      asset.width === null ||
      asset.height === null ||
      !VisualMediaTypeSchema.safeParse(asset.mediaType).success ||
      derivation.assetId !== asset.id ||
      derivation.materialId !== asset.materialId ||
      derivation.materialRevisionId !== asset.materialRevisionId ||
      derivation.assetByteHash !== asset.byteHash ||
      derivation.contentOrigin !== 'derived_visual_description' ||
      derivation.authority !== 'derived' ||
      derivation.evidenceAdmissibility !== 'advisory_nonblocking' ||
      derivation.validationStatus !== 'accepted'
    ) {
      throw new Error('Teaching Brief visual derivation is stale, foreign, or not advisory.');
    }
    if (visualOffers.length >= TEACHING_BRIEF_MAX_VISUAL_OFFERS) break;
    const refId = `V${visualOffers.length + 1}`;
    const context = VisualAdvisoryContextSchema.parse({
      referenceKey: refId,
      materialTitle: material.title,
      source: {
        sourceKind: material.sourceType === 'image' ? 'standalone' : 'embedded',
        mediaType: asset.mediaType,
        width: asset.width,
        height: asset.height,
        location: {
          pageNumber: asset.location.pageNumber ?? null,
          slideNumber: asset.location.slideNumber ?? null,
          contextLabel: asset.location.slideNumber
            ? `Slide ${asset.location.slideNumber}`
            : asset.location.pageNumber
              ? `Page ${asset.location.pageNumber}`
              : material.sourceType === 'image'
                ? 'Standalone image'
                : `Embedded visual ${asset.index + 1}`,
        },
        authority: 'original_visual',
      },
      explanation: {
        text: derivation.payload.description,
        visualType: derivation.payload.visualType,
        importantConcepts: derivation.payload.importantConcepts,
        pedagogicalNotes: derivation.payload.pedagogicalNotes,
        uncertainty: derivation.payload.uncertainty,
        contentOrigin: 'derived_visual_description',
        provenanceCategory: 'generated_visual_explanation',
        authority: 'advisory',
        evidenceAdmissibility: 'advisory_nonblocking',
        formalEvidenceEligible: false,
      },
    });
    const nextOffers = [...visualOffers, context];
    if (serializedTeachingSourceBytes(nextOffers) > TEACHING_BRIEF_MAX_SERIALIZED_VISUAL_BYTES) {
      continue;
    }
    visualOffers.push(context);
    visualReferences.push({
      refId,
      materialId: asset.materialId,
      materialRevisionId: asset.materialRevisionId,
      assetId: asset.id,
      assetByteHash: asset.byteHash,
      derivationId: derivation.id,
      derivationIdentityFingerprint: derivation.identityFingerprint,
      context,
    });
  }

  if (offers.length === 0 && visualOffers.length === 0) {
    throw new Error('Teaching Brief has no eligible source or advisory visual context.');
  }

  const serializedBytes = serializedTeachingSourceBytes(offers);
  const identity = {
    workspaceId,
    curriculumVersionId: curriculum.id,
    learningUnitId,
    executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    references,
    visualReferences,
  };
  return {
    fingerprint: fingerprint(identity),
    blockCount: references.length,
    offerCount: offers.length,
    serializedBytes,
    materialCount: new Set(references.map((reference) => reference.materialId)).size,
    sectionCount: new Set(references.map((reference) => JSON.stringify(reference.headingPath)))
      .size,
    offers,
    references,
    visualOfferCount: visualOffers.length,
    visualSerializedBytes: serializedTeachingSourceBytes(visualOffers),
    visualOffers,
    visualReferences,
  };
}
