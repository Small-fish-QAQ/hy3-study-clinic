import { createHash } from 'node:crypto';
import type {
  Concept,
  Curriculum,
  ExecutionSourceManifest,
  LearningContract,
  SourceBlock,
  VerifiedGrounding,
} from '@hy3-clinic/shared';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import { verifyGrounding } from '../grounding/verify.js';
import { searchSourceBlocks } from '../retrieval/lexical.js';

export const CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS = 320;
export const CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET = 160;
export const CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET = 240;
export const CURRICULUM_PROVIDER_OFFERS_PER_BLOCK = 2;
export const CURRICULUM_PREDECESSOR_REFS_PER_UNIT = 6;
const CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS = 64;
const CURRICULUM_PROVIDER_NEIGHBOR_RADIUS = 1;

interface CurriculumEvidenceCatalogInput {
  workspaceId: string;
  manifest: ExecutionSourceManifest;
  blocks: SourceBlock[];
  preferredGroundings: VerifiedGrounding[];
}

function safeChunkEnd(content: string, start: number): number {
  let end = Math.min(content.length, start + CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS);
  if (end < content.length) {
    const preferredStart = start + Math.floor(CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS * 0.6);
    const boundary = content.slice(preferredStart, end).search(/[。！？!?；;\n](?=\s|$)|\s(?=\S)/u);
    if (boundary >= 0) end = preferredStart + boundary + 1;
    const before = content.charCodeAt(end - 1);
    const after = content.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      end -= 1;
    }
  }
  return Math.max(start + 1, end);
}

function exactChunks(
  block: SourceBlock,
): Array<{ startOffset: number; endOffset: number; quote: string }> {
  const chunks: Array<{ startOffset: number; endOffset: number; quote: string }> = [];
  let start = 0;
  while (start < block.content.length) {
    const end = safeChunkEnd(block.content, start);
    chunks.push({ startOffset: start, endOffset: end, quote: block.content.slice(start, end) });
    start = end;
  }
  return chunks;
}

function offerId(input: {
  workspaceId: string;
  materialRevisionId: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
}): string {
  return `cev_${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 40)}`;
}

/**
 * Build the immutable evidence universe for one Curriculum logical operation.
 * Every offer is exact local text; preferred existing groundings are retained
 * in addition to deterministic bounded block excerpts.
 */
export function buildCurriculumEvidenceCatalog({
  workspaceId,
  manifest,
  blocks,
  preferredGroundings,
}: CurriculumEvidenceCatalogInput): CurriculumEvidenceOffer[] {
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const revisionByBlockId = new Map<string, (typeof manifest.revisions)[number]>();
  for (const revision of manifest.revisions) {
    for (const blockId of revision.sourceBlockRevisionIds) {
      const block = blockById.get(blockId);
      if (
        block?.materialId === revision.materialId &&
        block.materialRevisionId === revision.materialRevisionId
      ) {
        revisionByBlockId.set(blockId, revision);
      }
    }
  }
  const exactByKey = new Map<string, { block: SourceBlock; grounding: VerifiedGrounding }>();

  const add = (block: SourceBlock, grounding: VerifiedGrounding): void => {
    if (!revisionByBlockId.has(block.id)) return;
    if (grounding.quote.length > CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS) return;
    const verified = verifyGrounding(blocks, { blockId: block.id, quote: grounding.quote });
    if (!verified.ok || verified.grounding.blockId !== block.id) return;
    exactByKey.set(`${block.id}\u0000${verified.grounding.quote}`, {
      block,
      grounding: verified.grounding,
    });
  };

  for (const grounding of preferredGroundings) {
    const block = blockById.get(grounding.blockId);
    if (block) add(block, grounding);
  }
  for (const block of blocks) {
    if (!revisionByBlockId.has(block.id)) continue;
    for (const chunk of exactChunks(block)) {
      add(block, {
        blockId: block.id,
        quote: chunk.quote,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        occurrenceCount: 1,
        reanchored: false,
      });
    }
  }

  const ids = new Set<string>();
  return [...exactByKey.values()].map(({ block, grounding }) => {
    const revision = revisionByBlockId.get(block.id)!;
    const id = offerId({
      workspaceId,
      materialRevisionId: revision.materialRevisionId,
      blockId: block.id,
      startOffset: grounding.startOffset,
      endOffset: grounding.endOffset,
      quote: grounding.quote,
    });
    if (ids.has(id)) throw new Error('Curriculum evidence identity collision.');
    ids.add(id);
    return {
      id,
      bindingId: id,
      materialId: block.materialId,
      materialRevisionId: revision.materialRevisionId,
      blockId: block.id,
      startOffset: grounding.startOffset,
      endOffset: grounding.endOffset,
      quote: grounding.quote,
      headingPath: block.headingPath,
      pageNumber: block.pageNumber,
    };
  });
}

export interface CurriculumEvidenceSelectionInput {
  catalog: CurriculumEvidenceOffer[];
  blocks: SourceBlock[];
  predecessor: Curriculum | null;
  concepts: Concept[];
  contract: LearningContract;
  priorityGroundings: VerifiedGrounding[];
}

function normalizedGroundingKey(grounding: Pick<VerifiedGrounding, 'blockId' | 'quote'>): string {
  return `${grounding.blockId}\u0000${grounding.quote}`;
}

function predecessorSearchText(node: Curriculum['nodes'][number]): string {
  return [
    node.title,
    ...(node.learningUnit?.objectives.flatMap((objective) => [
      objective.title,
      objective.description,
    ]) ?? []),
  ].join(' ');
}

/**
 * Select provider candidates without granting them authority. Exact bindings
 * remain in the full local catalog; this function only limits what Hy3 sees.
 */
export function selectCurriculumEvidenceOffers({
  catalog,
  blocks,
  predecessor,
  concepts,
  contract,
  priorityGroundings,
}: CurriculumEvidenceSelectionInput): CurriculumEvidenceOffer[] {
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const orderedByMaterial = new Map<string, SourceBlock[]>();
  for (const block of blocks) {
    const materialBlocks = orderedByMaterial.get(block.materialId) ?? [];
    materialBlocks.push(block);
    orderedByMaterial.set(block.materialId, materialBlocks);
  }
  orderedByMaterial.forEach((materialBlocks) =>
    materialBlocks.sort(
      (left, right) => left.index - right.index || left.id.localeCompare(right.id),
    ),
  );

  const selectedBlockIds = new Set<string>();
  const addBlock = (blockId: string): void => {
    if (
      selectedBlockIds.size < CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET &&
      blockById.has(blockId)
    ) {
      selectedBlockIds.add(blockId);
    }
  };

  for (const node of predecessor?.nodes.filter((candidate) => candidate.kind === 'learning_unit') ??
    []) {
    for (const ref of node.sourceReferences.slice(0, CURRICULUM_PREDECESSOR_REFS_PER_UNIT)) {
      if (ref.sourceBlockId) addBlock(ref.sourceBlockId);
    }
  }
  for (const concept of concepts) addBlock(concept.grounding.blockId);

  for (const blockId of [...selectedBlockIds]) {
    const block = blockById.get(blockId);
    if (!block) continue;
    const siblings = orderedByMaterial.get(block.materialId) ?? [];
    const position = siblings.findIndex((candidate) => candidate.id === blockId);
    for (
      let offset = -CURRICULUM_PROVIDER_NEIGHBOR_RADIUS;
      offset <= CURRICULUM_PROVIDER_NEIGHBOR_RADIUS;
      offset += 1
    ) {
      const neighbor = siblings[position + offset];
      if (neighbor) addBlock(neighbor.id);
    }
  }

  for (const node of predecessor?.nodes.filter((candidate) => candidate.kind === 'learning_unit') ??
    []) {
    for (const result of searchSourceBlocks(blocks, predecessorSearchText(node), { limit: 2 })) {
      addBlock(result.blockId);
    }
  }
  const contractQuery = [
    contract.intent,
    contract.targetOutcome.description,
    ...contract.courseScope.includedTopics,
  ].join(' ');
  for (const result of searchSourceBlocks(blocks, contractQuery)) addBlock(result.blockId);

  const sectionGroups = new Map<string, SourceBlock[]>();
  for (const block of blocks) {
    const key = `${block.materialId}\u0000${block.headingPath.join('\u0001')}`;
    const group = sectionGroups.get(key) ?? [];
    group.push(block);
    sectionGroups.set(key, group);
  }
  for (const group of sectionGroups.values()) {
    addBlock(group[0]!.id);
    addBlock(group[Math.floor(group.length / 2)]!.id);
  }
  if (selectedBlockIds.size < CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS && blocks.length > 0) {
    const stride = blocks.length / CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS;
    for (let index = 0; index < CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS; index += 1) {
      addBlock(blocks[Math.min(blocks.length - 1, Math.floor(index * stride))]!.id);
    }
  }

  const priorityKeys = new Set(priorityGroundings.map(normalizedGroundingKey));
  const offersByBlock = new Map<string, CurriculumEvidenceOffer[]>();
  for (const offer of catalog) {
    if (!selectedBlockIds.has(offer.blockId)) continue;
    const offers = offersByBlock.get(offer.blockId) ?? [];
    offers.push(offer);
    offersByBlock.set(offer.blockId, offers);
  }
  offersByBlock.forEach((offers) =>
    offers.sort((left, right) => {
      const leftPriority = priorityKeys.has(normalizedGroundingKey(left)) ? 0 : 1;
      const rightPriority = priorityKeys.has(normalizedGroundingKey(right)) ? 0 : 1;
      return (
        leftPriority - rightPriority ||
        left.startOffset - right.startOffset ||
        right.quote.length - left.quote.length ||
        left.bindingId.localeCompare(right.bindingId)
      );
    }),
  );

  const selected: CurriculumEvidenceOffer[] = [];
  for (let pass = 0; pass < CURRICULUM_PROVIDER_OFFERS_PER_BLOCK; pass += 1) {
    for (const blockId of selectedBlockIds) {
      const offer = offersByBlock.get(blockId)?.[pass];
      if (!offer) continue;
      selected.push({ ...offer, id: `E${selected.length + 1}` });
      if (selected.length >= CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET) return selected;
    }
  }
  return selected;
}
