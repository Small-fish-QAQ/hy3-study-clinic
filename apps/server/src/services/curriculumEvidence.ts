import { createHash } from 'node:crypto';
import type { ExecutionSourceManifest, SourceBlock, VerifiedGrounding } from '@hy3-clinic/shared';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import { verifyGrounding } from '../grounding/verify.js';

export const CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS = 500;

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
