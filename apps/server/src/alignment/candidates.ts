import {
  guessConceptLanguage,
  normalizeConceptKey,
  MAX_ALIGNMENT_CANDIDATES,
  type Concept,
} from '@hy3-clinic/shared';

/**
 * Deterministic local candidate generation for concept alignment.
 *
 * Every candidate pair is produced by explicit local signals BEFORE any
 * model call — the provider only ever judges this bounded, pruned list
 * (never all pairs). Signals, in priority order:
 *
 * 1. exact_normalized  — normalized keys are identical (safe alias; the ONLY
 *                        signal eligible for automatic acceptance);
 * 2. containment       — one normalized key contains the other with a small
 *                        remainder (malformed concatenations like
 *                        "workingmemoryhas" ⊃ "workingmemory");
 * 3. shared_block      — both concepts are grounded in the same source block;
 * 4. shared_heading    — grounded under an identical heading in different
 *                        documents;
 * 5. token_overlap     — ≥ half of the shorter name's tokens appear in the
 *                        other name (Latin/camel-case tokenization);
 * 6. summary_overlap   — cross-language pairs whose extracted summaries
 *                        share enough character bigrams (bilingual pairs);
 * 7. known_alias_pair  — the two normalized keys were previously accepted as
 *                        aliases elsewhere in this workspace.
 *
 * String similarity alone NEVER merges anything: except exact_normalized
 * (explicit tested rule), all candidates go to review via Hy3 proposals.
 */

export type CandidateSignal =
  | 'exact_normalized'
  | 'containment'
  | 'shared_block'
  | 'shared_heading'
  | 'token_overlap'
  | 'summary_overlap'
  | 'known_alias_pair';

export interface LocalCandidate {
  source: Concept;
  target: Concept;
  signals: CandidateSignal[];
  /** True when the pair may be auto-accepted by the documented local rule. */
  autoAcceptable: boolean;
}

export interface CandidateContext {
  /** Heading path (joined) of each concept's grounding block, when known. */
  headingByConcept: Map<string, string>;
  /** Canonical group id of each concept (pairs in one group are skipped). */
  canonicalByConcept: Map<string, string>;
  /** Pair keys (sorted concept ids) that already have any proposal. */
  existingPairKeys: Set<string>;
  /** Normalized-key pairs (sorted, joined with '|') accepted as aliases. */
  knownAliasKeyPairs: Set<string>;
}

const SIGNAL_PRIORITY: Record<CandidateSignal, number> = {
  exact_normalized: 0,
  containment: 1,
  shared_block: 2,
  shared_heading: 3,
  known_alias_pair: 4,
  token_overlap: 5,
  summary_overlap: 6,
};

export function pairKey(aConceptId: string, bConceptId: string): string {
  return [aConceptId, bConceptId].sort().join('|');
}

export function keyPair(aKey: string, bKey: string): string {
  return [aKey, bKey].sort().join('|');
}

/** Latin/camel-case token split, lower-cased ("WorkingMemory" → working, memory). */
function latinTokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function charBigrams(text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const grams = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i++) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
}

function bigramOverlap(a: string, b: string): number {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared++;
  return shared / Math.min(ga.size, gb.size);
}

function detectSignals(a: Concept, b: Concept, ctx: CandidateContext): CandidateSignal[] {
  const signals: CandidateSignal[] = [];
  const keyA = normalizeConceptKey(a.name);
  const keyB = normalizeConceptKey(b.name);
  if (keyA.length === 0 || keyB.length === 0) return signals;

  if (keyA === keyB) {
    signals.push('exact_normalized');
  } else {
    const [short, long] = keyA.length <= keyB.length ? [keyA, keyB] : [keyB, keyA];
    if (short.length >= 4 && long.includes(short) && long.length - short.length <= 6) {
      signals.push('containment');
    }
  }

  if (a.grounding.blockId === b.grounding.blockId) signals.push('shared_block');

  const headingA = ctx.headingByConcept.get(a.id);
  const headingB = ctx.headingByConcept.get(b.id);
  if (headingA && headingB && headingA === headingB && a.materialId !== b.materialId) {
    signals.push('shared_heading');
  }

  if (ctx.knownAliasKeyPairs.has(keyPair(keyA, keyB))) signals.push('known_alias_pair');

  const tokensA = latinTokens(a.name);
  const tokensB = latinTokens(b.name);
  if (tokensA.length > 0 && tokensB.length > 0 && !signals.includes('exact_normalized')) {
    const setB = new Set(tokensB);
    const shared = tokensA.filter((t) => setB.has(t)).length;
    if (shared >= 1 && shared * 2 >= Math.min(tokensA.length, tokensB.length) + 1) {
      signals.push('token_overlap');
    }
  }

  const langA = guessConceptLanguage(a.name);
  const langB = guessConceptLanguage(b.name);
  if (
    langA !== langB &&
    langA !== 'unknown' &&
    langB !== 'unknown' &&
    bigramOverlap(a.summary, b.summary) >= 0.35
  ) {
    signals.push('summary_overlap');
  }

  return signals;
}

/**
 * Generate the bounded candidate list for a workspace. Pairs already in one
 * canonical group and pairs with any existing proposal are skipped; output
 * is sorted by strongest signal then by stable concept order, and truncated
 * to MAX_ALIGNMENT_CANDIDATES.
 */
export function generateAlignmentCandidates(
  concepts: Concept[],
  ctx: CandidateContext,
): LocalCandidate[] {
  const candidates: LocalCandidate[] = [];

  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i]!;
      const b = concepts[j]!;
      const groupA = ctx.canonicalByConcept.get(a.id);
      const groupB = ctx.canonicalByConcept.get(b.id);
      if (groupA !== undefined && groupA === groupB) continue;
      if (ctx.existingPairKeys.has(pairKey(a.id, b.id))) continue;

      const signals = detectSignals(a, b, ctx);
      if (signals.length === 0) continue;
      candidates.push({
        source: a,
        target: b,
        signals,
        autoAcceptable: signals.includes('exact_normalized'),
      });
    }
  }

  candidates.sort((x, y) => {
    const px = Math.min(...x.signals.map((s) => SIGNAL_PRIORITY[s]));
    const py = Math.min(...y.signals.map((s) => SIGNAL_PRIORITY[s]));
    if (px !== py) return px - py;
    return (x.source.id + x.target.id).localeCompare(y.source.id + y.target.id);
  });
  return candidates.slice(0, MAX_ALIGNMENT_CANDIDATES);
}
