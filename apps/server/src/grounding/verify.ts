import type { ProposedGrounding, SourceBlock, VerifiedGrounding } from '@hy3-clinic/shared';

/**
 * Deterministic grounding verification — the trust boundary between model
 * output and persisted data.
 *
 * The model only ever supplies (blockId, quote). This module:
 *  1. trims the quote (the ONLY normalization applied — no fuzzy matching);
 *  2. locates the quote inside the referenced block with exact string search;
 *  3. computes character offsets itself (UTF-16 code units);
 *  4. resolves repeats safely:
 *     - repeated inside the referenced block → anchor to the FIRST occurrence
 *       and record `occurrenceCount` so the ambiguity stays visible;
 *     - absent from the referenced block → re-anchor only if the quote occurs
 *       in EXACTLY ONE other block EXACTLY ONCE (marked `reanchored: true`);
 *       anything else is rejected.
 *
 * Offsets, page numbers, or line numbers coming from a model are never
 * trusted and never fabricated here: every offset is recomputed from the
 * actual source text, and verification fails closed.
 */

export type GroundingFailureReason =
  | 'empty_quote'
  | 'quote_too_long'
  | 'unknown_block'
  | 'quote_not_found'
  | 'ambiguous_across_blocks'
  | 'ambiguous_in_candidate_block';

export type GroundingVerification =
  | { ok: true; grounding: VerifiedGrounding }
  | { ok: false; reason: GroundingFailureReason; message: string };

const MAX_QUOTE_CHARS = 500;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(needle, pos + 1);
  }
  return count;
}

export function verifyGrounding(
  blocks: SourceBlock[],
  proposed: ProposedGrounding,
): GroundingVerification {
  const quote = proposed.quote.trim();
  if (quote.length === 0) {
    return { ok: false, reason: 'empty_quote', message: '引文为空。' };
  }
  if (quote.length > MAX_QUOTE_CHARS) {
    return {
      ok: false,
      reason: 'quote_too_long',
      message: `引文过长(${quote.length} 字,上限 ${MAX_QUOTE_CHARS})。`,
    };
  }

  const referenced = blocks.find((b) => b.id === proposed.blockId);
  if (!referenced) {
    return {
      ok: false,
      reason: 'unknown_block',
      message: `引用的源块不存在:${proposed.blockId}`,
    };
  }

  const inReferenced = countOccurrences(referenced.content, quote);
  if (inReferenced >= 1) {
    const startOffset = referenced.content.indexOf(quote);
    return {
      ok: true,
      grounding: {
        blockId: referenced.id,
        quote,
        startOffset,
        endOffset: startOffset + quote.length,
        occurrenceCount: inReferenced,
        reanchored: false,
      },
    };
  }

  // Quote not in the referenced block: attempt safe re-anchoring.
  const candidates = blocks
    .filter((b) => b.id !== referenced.id)
    .map((b) => ({ block: b, occurrences: countOccurrences(b.content, quote) }))
    .filter((c) => c.occurrences > 0);

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'quote_not_found',
      message: '引文未能在源材料中找到,已拒绝该条依据。',
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_across_blocks',
      message: `引文出现在 ${candidates.length} 个不同源块中,无法唯一定位。`,
    };
  }

  const candidate = candidates[0]!;
  if (candidate.occurrences > 1) {
    return {
      ok: false,
      reason: 'ambiguous_in_candidate_block',
      message: '引文在候选源块中出现多次,且模型未指对源块,无法安全定位。',
    };
  }

  const startOffset = candidate.block.content.indexOf(quote);
  return {
    ok: true,
    grounding: {
      blockId: candidate.block.id,
      quote,
      startOffset,
      endOffset: startOffset + quote.length,
      occurrenceCount: 1,
      reanchored: true,
    },
  };
}
