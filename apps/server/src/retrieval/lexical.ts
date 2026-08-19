import { roundTo, type SourceBlock } from '@hy3-clinic/shared';

/**
 * Bounded deterministic local source retrieval.
 *
 * A small BM25-style lexical scorer over the workspace's source blocks —
 * deliberately NOT SQLite FTS5: the default FTS5 tokenizers (unicode61) do
 * not segment CJK text, which would make Chinese queries useless, while this
 * scorer tokenizes CJK as character bigrams and Latin as lower-cased words.
 * At the product's scale (dozens of blocks per workspace) scoring on the fly
 * is faster than maintaining an index table and has zero consistency risk.
 *
 * Security properties (tested):
 * - pure function of (blocks, query): no SQL, no filesystem, no network;
 * - callers pass only the blocks of ONE workspace → isolation by scope;
 * - all inputs and outputs are bounded (query length, result count,
 *   excerpt length);
 * - retrieved text is returned as data only — instructions inside documents
 *   are never interpreted (prompt wrapping happens at the provider layer).
 */

export const MAX_QUERY_CHARS = 200;
export const MAX_RESULTS = 8;
export const MAX_EXCERPT_CHARS = 240;

export type RetrievalSource = 'lexical' | 'graph_expansion';

export interface RetrievalResult {
  blockId: string;
  materialId: string;
  pageNumber: number | null;
  slideNumber: number | null;
  headingPath: string[];
  /** BM25-style relevance score (rounded, deterministic). */
  matchScore: number;
  /** Bounded excerpt centred on the densest match region. */
  excerpt: string;
  startOffset: number;
  endOffset: number;
  source: RetrievalSource;
}

/** CJK chars as bigrams + Latin/digit runs as words, all case-folded. */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  const latinRuns = normalized.match(/[a-z0-9]+/g) ?? [];
  for (const run of latinRuns) if (run.length >= 2) tokens.push(run);
  const cjk = normalized.match(/[一-鿿]/gu) ?? [];
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk[i]! + cjk[i + 1]!);
  if (cjk.length === 1) tokens.push(cjk[0]!);
  return tokens;
}

interface ScoredBlock {
  block: SourceBlock;
  score: number;
  firstMatchOffset: number;
}

const BM25_K1 = 1.4;
const BM25_B = 0.75;

function scoreBlocks(blocks: SourceBlock[], queryTokens: string[]): ScoredBlock[] {
  if (queryTokens.length === 0 || blocks.length === 0) return [];

  const docTokens = blocks.map((b) => tokenize(b.content));
  const avgLength =
    docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, docTokens.length);

  // Document frequency per distinct query token.
  const distinctQuery = [...new Set(queryTokens)];
  const docFreq = new Map<string, number>();
  for (const token of distinctQuery) {
    let df = 0;
    for (const tokens of docTokens) if (tokens.includes(token)) df++;
    docFreq.set(token, df);
  }

  const scored: ScoredBlock[] = [];
  blocks.forEach((block, i) => {
    const tokens = docTokens[i]!;
    if (tokens.length === 0) return;
    const termFreq = new Map<string, number>();
    for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);

    let score = 0;
    for (const token of distinctQuery) {
      const tf = termFreq.get(token) ?? 0;
      if (tf === 0) continue;
      const df = docFreq.get(token) ?? 0;
      const idf = Math.log(1 + (blocks.length - df + 0.5) / (df + 0.5));
      score +=
        (idf * tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / Math.max(1, avgLength)));
    }
    if (score <= 0) return;

    const lowered = block.content.normalize('NFKC').toLowerCase();
    let firstMatchOffset = 0;
    for (const token of distinctQuery) {
      const pos = lowered.indexOf(token);
      if (pos >= 0) {
        firstMatchOffset = pos;
        break;
      }
    }
    scored.push({ block, score, firstMatchOffset });
  });

  scored.sort((a, b) => b.score - a.score || a.block.id.localeCompare(b.block.id));
  return scored;
}

function excerptOf(
  block: SourceBlock,
  around: number,
): { text: string; start: number; end: number } {
  const start = Math.max(0, Math.min(around - 40, block.content.length - MAX_EXCERPT_CHARS));
  const end = Math.min(block.content.length, start + MAX_EXCERPT_CHARS);
  return { text: block.content.slice(start, end), start, end };
}

export interface SearchOptions {
  limit?: number;
  /** Block ids reachable via the concept-graph neighborhood (expansion set). */
  graphNeighborBlockIds?: ReadonlySet<string>;
}

/**
 * Search one workspace's blocks. Lexical matches come first; blocks from the
 * graph-neighborhood expansion set that did not match lexically are appended
 * (marked 'graph_expansion') while result slots remain.
 */
export function searchSourceBlocks(
  blocks: SourceBlock[],
  rawQuery: string,
  options: SearchOptions = {},
): RetrievalResult[] {
  const query = rawQuery.trim().slice(0, MAX_QUERY_CHARS);
  const limit = Math.max(1, Math.min(options.limit ?? MAX_RESULTS, MAX_RESULTS));
  if (query.length === 0) return [];

  const results: RetrievalResult[] = [];
  const used = new Set<string>();

  for (const { block, score, firstMatchOffset } of scoreBlocks(blocks, tokenize(query))) {
    if (results.length >= limit) break;
    const excerpt = excerptOf(block, firstMatchOffset);
    used.add(block.id);
    results.push({
      blockId: block.id,
      materialId: block.materialId,
      pageNumber: block.pageNumber,
      slideNumber: block.slideNumber ?? null,
      headingPath: block.headingPath,
      matchScore: roundTo(score, 4),
      excerpt: excerpt.text,
      startOffset: excerpt.start,
      endOffset: excerpt.end,
      source: 'lexical',
    });
  }

  if (options.graphNeighborBlockIds) {
    for (const block of blocks) {
      if (results.length >= limit) break;
      if (used.has(block.id) || !options.graphNeighborBlockIds.has(block.id)) continue;
      const excerpt = excerptOf(block, 0);
      used.add(block.id);
      results.push({
        blockId: block.id,
        materialId: block.materialId,
        pageNumber: block.pageNumber,
        slideNumber: block.slideNumber ?? null,
        headingPath: block.headingPath,
        matchScore: 0,
        excerpt: excerpt.text,
        startOffset: excerpt.start,
        endOffset: excerpt.end,
        source: 'graph_expansion',
      });
    }
  }

  return results;
}
