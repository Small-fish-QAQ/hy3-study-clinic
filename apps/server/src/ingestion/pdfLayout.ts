import { sanitizeParsedText } from './ingest.js';

/**
 * Layout-aware PDF text reconstruction.
 *
 * PDF text extraction that flattens a page into a plain string destroys the
 * evidence needed for faithful study text: repeated footers arrive glued to
 * body text, headings lose their font-size identity, visual line wraps become
 * semantic breaks, list bullets vanish, and tables collapse. This module
 * keeps that evidence: it receives positioned text items (from PDF.js via
 * unpdf) and rebuilds document structure in deterministic, document-agnostic
 * stages:
 *
 *   raw positioned items
 *     → reconstructed visual lines (baseline grouping, stable reading order)
 *     → document statistics (body font size, wrap pitch, body right edge)
 *     → repeated page-margin removal (headers / footers / page numbers)
 *     → structural classification (headings by font-size tier, list items by
 *       marker glyph evidence, conservative table regions by aligned gaps)
 *     → paragraph assembly with visual-wrap repair
 *     → Markdown-style text + exact per-page character spans.
 *
 * The emitted text uses ATX headings and `- ` list markers so the EXISTING
 * deterministic segmenter (segment.ts) builds source blocks with heading
 * paths — the PDF pipeline deliberately reuses the same downstream
 * segmentation as Markdown and DOCX sources.
 *
 * Every heuristic here relies on general layout signals (repetition across
 * pages, geometry, font-size ratios, punctuation classes) — never on any
 * specific document's title, footer text, heading wording, or page count.
 */

/** One positioned text item from the PDF text layer (device space, y-up). */
export interface PdfTextItem {
  str: string;
  /** Baseline origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export interface PdfPageInput {
  /** 1-based page number. */
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

/** Span of one source page inside the emitted text (UTF-16 offsets). */
export interface PageSpan {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
}

export interface PdfLayoutResult {
  /** Normalized Markdown-style text (LF endings, no trailing whitespace). */
  text: string;
  pageSpans: PageSpan[];
  warnings: string[];
}

const NUL = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// Extraction-artifact glyph normalization
// ---------------------------------------------------------------------------

/**
 * Chrome/Skia-printed PDFs frequently carry ToUnicode maps that resolve
 * common CJK ideographs to visually identical RADICAL code points (一 → ⼀,
 * 文 → ⽂), which breaks search, quoting, and grading downstream. Kangxi
 * Radicals (U+2F00–U+2FD5) all have canonical NFKC mappings back to the
 * unified ideograph. The CJK Radicals Supplement block mostly does NOT, so a
 * conservative explicit table covers the unambiguous, visually identical
 * pairs (simplified-form radicals). Unmapped radicals are left unchanged.
 */
const RADICAL_SUPPLEMENT_MAP: Record<string, string> = {
  '⻅': '见',
  '⻆': '角',
  '⻉': '贝',
  '⻋': '车',
  '⻓': '长',
  '⻑': '長',
  '⻔': '门',
  '⻘': '青',
  '⻙': '韦',
  '⻚': '页',
  '⻛': '风',
  '⻜': '飞',
  '⻝': '食',
  '⻢': '马',
  '⻣': '骨',
  '⻤': '鬼',
  '⻥': '鱼',
  '⻦': '鸟',
  '⻧': '卤',
  '⻨': '麦',
  '⻩': '黄',
  '⻪': '黾',
  '⻬': '齐',
  '⻭': '齿',
  '⻰': '龙',
  '⻳': '龟',
  '⺟': '母',
  '⻏': '阝',
  '⻖': '阝',
};

/** Map radical-substituted glyphs back to their unified CJK ideographs. */
export function normalizeExtractedGlyphs(text: string): string {
  let changed = false;
  const out: string[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0x2f00 && code <= 0x2fd5) {
      // Kangxi Radicals: canonical NFKC equivalent is the unified ideograph.
      out.push(char.normalize('NFKC'));
      changed = true;
    } else if (code >= 0x2e80 && code <= 0x2eff) {
      const mapped = RADICAL_SUPPLEMENT_MAP[char];
      if (mapped) {
        out.push(mapped);
        changed = true;
      } else {
        out.push(char);
      }
    } else {
      out.push(char);
    }
  }
  return changed ? out.join('') : text;
}

// ---------------------------------------------------------------------------
// Line reconstruction
// ---------------------------------------------------------------------------

interface CellFragment {
  text: string;
  x0: number;
  x1: number;
}

interface Line {
  pageNumber: number;
  /** Baseline y of the line (device space, y-up). */
  y: number;
  x0: number;
  x1: number;
  /** Char-count-weighted dominant font size of the line. */
  dominantSize: number;
  /** Cleaned text (glyph-normalized, sanitized, trimmed). */
  text: string;
  /** Cell fragments split at large horizontal gaps (table evidence). */
  cells: CellFragment[];
  /** True when the line started with unmapped marker glyphs (list bullet). */
  hasListMarker: boolean;
  /** True when the extracted line text ended with whitespace before trimming
   * (evidence that a wrap join at a CJK/Latin boundary carried a space). */
  trailingSpace: boolean;
  pageHeight: number;
  pageWidth: number;
  removed: boolean;
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function isMarkerOnly(str: string): boolean {
  if (str.length === 0) return false;
  for (const char of str) {
    if (char !== NUL && char.trim() !== '') return false;
  }
  return str.includes(NUL);
}

function cleanLineText(raw: string): string {
  return sanitizeParsedText(normalizeExtractedGlyphs(raw)).replace(/\s+/g, ' ').trim();
}

/** Group a page's items into visual lines in stable reading order. */
export function reconstructLines(page: PdfPageInput): Line[] {
  interface Bucket {
    y: number;
    items: PdfTextItem[];
  }
  const buckets: Bucket[] = [];

  for (const item of page.items) {
    if (item.str.length === 0) continue;
    const tolerance = Math.max(2, item.fontSize * 0.35);
    let bucket: Bucket | undefined;
    for (const candidate of buckets) {
      if (Math.abs(candidate.y - item.y) <= tolerance) {
        bucket = candidate;
        break;
      }
    }
    if (!bucket) {
      bucket = { y: item.y, items: [] };
      buckets.push(bucket);
    }
    bucket.items.push(item);
  }

  buckets.sort((a, b) => b.y - a.y);

  const lines: Line[] = [];
  for (const bucket of buckets) {
    const line = buildLine(bucket.items, bucket.y, page);
    if (line) lines.push(line);
  }
  return lines;
}

function buildLine(items: PdfTextItem[], y: number, page: PdfPageInput): Line | null {
  // Content-stream order is the best reading-order evidence for same-line
  // items (kerned punctuation can carry misleading x). Re-sort by x only when
  // the stream order is clearly non-monotonic (e.g. object-reordered PDFs).
  let ordered = items;
  let monotonic = true;
  let lastX = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.str.trim() === '') continue;
    if (item.x < lastX - Math.max(item.fontSize, 4)) {
      monotonic = false;
      break;
    }
    lastX = Math.max(lastX, item.x + item.width);
  }
  if (!monotonic) {
    ordered = [...items].sort((a, b) => a.x - b.x);
  }

  // Consume leading unmapped marker glyphs (Chrome/Skia list bullets whose
  // ToUnicode is <0000>) as list-item evidence instead of letting sanitation
  // silently delete them later.
  let start = 0;
  let hasListMarker = false;
  while (start < ordered.length && isMarkerOnly(ordered[start]!.str)) {
    hasListMarker = true;
    start++;
  }

  const visible: PdfTextItem[] = [];
  const cells: CellFragment[] = [];
  let cellText = '';
  let cellX0 = 0;
  let cellX1 = 0;
  let trailingSpace = false;
  const sizeWeights = new Map<number, number>();

  const flushCell = () => {
    trailingSpace = /\s$/.test(cellText);
    const text = cleanLineText(cellText);
    if (text.length > 0) cells.push({ text, x0: cellX0, x1: cellX1 });
    cellText = '';
  };

  for (let i = start; i < ordered.length; i++) {
    const item = ordered[i]!;
    const isSpaceItem = item.str.trim() === '';
    if (!isSpaceItem) {
      const sizeKey = Math.round(item.fontSize * 10) / 10;
      const weight = item.str.replace(/\s/g, '').length;
      sizeWeights.set(sizeKey, (sizeWeights.get(sizeKey) ?? 0) + weight);
    }

    if (isSpaceItem) {
      if (cellText.length > 0) cellText += ' ';
      continue;
    }

    const prev = visible[visible.length - 1];
    if (prev && cellText.length > 0) {
      const gap = item.x - (prev.x + prev.width);
      const refSize = Math.max(Math.min(prev.fontSize, item.fontSize), 1);
      if (gap > Math.max(refSize * 2, 14)) {
        // Large horizontal gap: candidate table-cell boundary.
        flushCell();
      } else if (gap > refSize * 0.28) {
        const prevChar = cellText.slice(-1);
        const nextChar = [...item.str][0] ?? '';
        // CJK typesetting has no inter-word spaces; only script boundaries
        // and Latin word gaps need one.
        if (!(isCjk(prevChar) && isCjk(nextChar)) || gap > refSize * 1.2) {
          cellText += ' ';
        }
      }
    }
    if (cellText.length === 0) {
      cellX0 = item.x;
    }
    cellText += item.str;
    cellX1 = item.x + item.width;
    visible.push(item);
  }
  flushCell();

  if (cells.length === 0) return null;

  let dominantSize = 0;
  let bestWeight = -1;
  for (const [size, weight] of sizeWeights) {
    if (weight > bestWeight || (weight === bestWeight && size < dominantSize)) {
      bestWeight = weight;
      dominantSize = size;
    }
  }

  return {
    pageNumber: page.pageNumber,
    y,
    x0: cells[0]!.x0,
    x1: cells[cells.length - 1]!.x1,
    dominantSize,
    text: cells.map((c) => c.text).join(' '),
    cells,
    hasListMarker,
    trailingSpace,
    pageHeight: page.height,
    pageWidth: page.width,
    removed: false,
  };
}

// ---------------------------------------------------------------------------
// Document statistics
// ---------------------------------------------------------------------------

interface DocStats {
  bodySize: number;
  /** Modal baseline distance of wrapped body lines; null if undetectable. */
  pitch: number | null;
  /** Right edge body text typically reaches (wrap evidence). */
  rightEdge: number;
  /**
   * Whether rightEdge is trustworthy wrap evidence: body text must actually
   * span a substantial part of the page. In tiny or narrow documents the
   * "right edge" is just the longest short line, and treating it as a wrap
   * margin would glue authored lines together.
   */
  rightEdgeReliable: boolean;
  /** Max baseline gap treated as "same paragraph". */
  paragraphGapMax: number;
}

function computeDocStats(pages: Line[][]): DocStats {
  const sizeWeights = new Map<number, number>();
  for (const lines of pages) {
    for (const line of lines) {
      const key = Math.round(line.dominantSize * 10) / 10;
      sizeWeights.set(key, (sizeWeights.get(key) ?? 0) + line.text.length);
    }
  }
  let bodySize = 12;
  let bestWeight = -1;
  for (const [size, weight] of sizeWeights) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bodySize = size;
    }
  }

  const isBodyLine = (line: Line) =>
    line.dominantSize >= bodySize * 0.9 && line.dominantSize <= bodySize * 1.1;

  // Wrap pitch: the smallest recurring baseline distance between consecutive
  // body lines. Paragraph spacing is larger, so picking the smallest
  // sufficiently-frequent distance isolates intra-paragraph wraps. Deltas
  // below ~0.8em cannot be a text-line pitch (they come from staggered table
  // cells or superscripts) and are ignored.
  const deltaCounts = new Map<number, number>();
  let pairCount = 0;
  for (const lines of pages) {
    for (let i = 0; i + 1 < lines.length; i++) {
      const a = lines[i]!;
      const b = lines[i + 1]!;
      if (!isBodyLine(a) || !isBodyLine(b)) continue;
      const delta = Math.round(a.y - b.y);
      if (delta < bodySize * 0.8 || delta > bodySize * 2.6) continue;
      deltaCounts.set(delta, (deltaCounts.get(delta) ?? 0) + 1);
      pairCount++;
    }
  }
  let pitch: number | null = null;
  const minCount = Math.max(3, Math.ceil(pairCount * 0.05));
  for (const delta of [...deltaCounts.keys()].sort((a, b) => a - b)) {
    const count =
      (deltaCounts.get(delta - 1) ?? 0) +
      deltaCounts.get(delta)! +
      (deltaCounts.get(delta + 1) ?? 0);
    if (count >= minCount) {
      pitch = delta;
      break;
    }
  }

  const edges = pages
    .flat()
    .filter((l) => isBodyLine(l) && l.text.length >= 8)
    .map((l) => l.x1)
    .sort((a, b) => a - b);
  const rightEdge =
    edges.length > 0 ? edges[Math.min(edges.length - 1, Math.floor(edges.length * 0.95))]! : 0;
  const pageWidth = Math.max(0, ...pages.flat().map((l) => l.pageWidth));

  return {
    bodySize,
    pitch,
    rightEdge,
    rightEdgeReliable: pageWidth > 0 && rightEdge >= pageWidth * 0.6,
    // Wrap pitch and paragraph spacing are distinct in flowed layouts; a
    // tight multiplier keeps paragraph-spaced lines from being glued.
    paragraphGapMax: pitch !== null ? pitch * 1.25 : bodySize * 1.9,
  };
}

// ---------------------------------------------------------------------------
// Repeated page-margin removal (headers / footers / page numbers)
// ---------------------------------------------------------------------------

const MARGIN_BAND_RATIO = 0.1;
const MARGIN_LINES_PER_BAND = 2;

/** Bare page-counter line: "3", "- 3 -", "第 3 页", "3 / 17", "Page 3"… */
const PAGE_NUMBER_LINE_RE =
  /^[\s\-–—·.。•()()[\]]*(?:第|page|p\.?)?\s*\d{1,4}\s*(?:页|頁)?\s*(?:\/\s*\d{1,4})?[\s\-–—·.。•()()[\]]*$/i;

function marginKey(text: string): string {
  return text.replace(/\d+/g, '#').replace(/\s+/g, '');
}

function collectMarginCandidates(lines: Line[]): { top: Line[]; bottom: Line[] } {
  const top: Line[] = [];
  const bottom: Line[] = [];
  if (lines.length === 0) return { top, bottom };
  const height = lines[0]!.pageHeight;
  for (let i = 0; i < Math.min(MARGIN_LINES_PER_BAND, lines.length); i++) {
    const line = lines[i]!;
    if (line.y >= height * (1 - MARGIN_BAND_RATIO)) top.push(line);
  }
  for (let i = 0; i < Math.min(MARGIN_LINES_PER_BAND, lines.length); i++) {
    const line = lines[lines.length - 1 - i]!;
    if (line.y <= height * MARGIN_BAND_RATIO) bottom.push(line);
  }
  return { top, bottom };
}

/**
 * Mark repeated header/footer lines and isolated page-number lines as
 * removed. Signals are general: margin band position, normalized repetition
 * across pages (digits collapsed), consistent vertical position, and bare
 * page-counter patterns. Heading-sized lines are never removed, so a large
 * repeated section title cannot be mistaken for a running head.
 */
function removeMarginLines(pages: Line[][], stats: DocStats): void {
  const textPages = pages.filter((p) => p.length > 0).length;
  if (textPages === 0) return;
  const repeatThreshold = Math.max(3, Math.ceil(textPages * 0.6));

  interface Group {
    lines: Line[];
    pageNumbers: Set<number>;
    ys: number[];
  }
  const groups = new Map<string, Group>();
  const numberLines: { line: Line; band: 'top' | 'bottom' }[] = [];

  for (const lines of pages) {
    const { top, bottom } = collectMarginCandidates(lines);
    for (const [band, candidates] of [
      ['top', top],
      ['bottom', bottom],
    ] as const) {
      for (const line of candidates) {
        if (line.dominantSize > stats.bodySize * 1.14) continue;
        const key = `${band}:${marginKey(line.text)}`;
        let group = groups.get(key);
        if (!group) {
          group = { lines: [], pageNumbers: new Set(), ys: [] };
          groups.set(key, group);
        }
        group.lines.push(line);
        group.pageNumbers.add(line.pageNumber);
        group.ys.push(line.y);
        if (PAGE_NUMBER_LINE_RE.test(line.text)) {
          numberLines.push({ line, band });
        }
      }
    }
  }

  for (const group of groups.values()) {
    if (group.pageNumbers.size < repeatThreshold) continue;
    const ys = [...group.ys].sort((a, b) => a - b);
    const medianY = ys[Math.floor(ys.length / 2)]!;
    for (const line of group.lines) {
      if (Math.abs(line.y - medianY) <= stats.bodySize * 2.5) {
        line.removed = true;
      }
    }
  }

  // Bare page-counter lines: remove when at least 3 pages show one in the
  // same band, even if the counter format defeats digit-normalization.
  for (const band of ['top', 'bottom'] as const) {
    const inBand = numberLines.filter((n) => n.band === band);
    const bandPages = new Set(inBand.map((n) => n.line.pageNumber));
    if (bandPages.size >= 3) {
      for (const { line } of inBand) line.removed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Heading classification
// ---------------------------------------------------------------------------

const MAX_HEADING_CHARS = 120;

function computeHeadingLevels(pages: Line[][], stats: DocStats): Map<number, number> {
  const sizes = new Set<number>();
  for (const lines of pages) {
    for (const line of lines) {
      if (line.removed) continue;
      if (line.dominantSize >= stats.bodySize * 1.14 && line.text.length <= MAX_HEADING_CHARS) {
        sizes.add(line.dominantSize);
      }
    }
  }
  const ranked = [...sizes].sort((a, b) => b - a);
  const levels = new Map<number, number>();
  ranked.forEach((size, index) => {
    levels.set(size, Math.min(index + 1, 6));
  });
  return levels;
}

function isHeadingLine(
  line: Line,
  levels: Map<number, number>,
  gapAbove: number | null,
  prevWasHeading: boolean,
  stats: DocStats,
): boolean {
  if (line.hasListMarker) return false;
  if (!levels.has(line.dominantSize)) return false;
  if (line.text.length > MAX_HEADING_CHARS) return false;
  // A heading never ends in enumeration/continuation punctuation.
  if (/[，、,;;]$/.test(line.text)) return false;
  // Isolation: page top, extra space above, or a heading directly above.
  return gapAbove === null || gapAbove > stats.paragraphGapMax * 0.8 || prevWasHeading;
}

// ---------------------------------------------------------------------------
// Conservative table regions
// ---------------------------------------------------------------------------

interface TableRegion {
  start: number;
  end: number; // inclusive
  boundaries: number[];
}

/**
 * Detect conservative table regions in one page's classified body lines:
 * consecutive multi-cell lines whose cell boundaries ALIGN across at least
 * two lines. Only aligned boundaries become ` | ` separators; anything less
 * consistent falls back to plain readable lines — no cell relationships are
 * invented.
 */
function detectTableRegions(
  lines: Line[],
  eligibleFlags: boolean[],
  stats: DocStats,
): TableRegion[] {
  const regions: TableRegion[] = [];
  let runStart = -1;

  const flush = (endIndex: number) => {
    if (runStart < 0) return;
    const run = lines.slice(runStart, endIndex + 1);
    const multi = run.filter((l) => l.cells.length >= 2);
    if (multi.length >= 2) {
      const boundaries = alignedBoundaries(multi, stats);
      if (boundaries.length >= 1) {
        regions.push({ start: runStart, end: endIndex, boundaries });
      }
    }
    runStart = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const partOfRun =
      eligibleFlags[i] === true &&
      (line.cells.length >= 2 ||
        // Single-cell lines inside a run are tolerated (wrapped cell text)
        // when directly between multi-cell neighbours.
        (runStart >= 0 &&
          i + 1 < lines.length &&
          eligibleFlags[i + 1] === true &&
          lines[i + 1]!.cells.length >= 2));
    if (partOfRun) {
      if (runStart < 0) runStart = i;
    } else {
      flush(i - 1);
    }
  }
  flush(lines.length - 1);
  return regions;
}

function alignedBoundaries(lines: Line[], stats: DocStats): number[] {
  const tolerance = stats.bodySize * 1.8;
  const candidates: number[] = [];
  for (const line of lines) {
    for (let i = 1; i < line.cells.length; i++) {
      candidates.push(line.cells[i]!.x0);
    }
  }
  candidates.sort((a, b) => a - b);
  const clusters: { x: number; count: number }[] = [];
  for (const x of candidates) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(last.x - x) <= tolerance) {
      last.x = (last.x * last.count + x) / (last.count + 1);
      last.count++;
    } else {
      clusters.push({ x, count: 1 });
    }
  }
  return clusters.filter((c) => c.count >= 2).map((c) => c.x);
}

function renderTableRow(line: Line, boundaries: number[], stats: DocStats): string {
  if (line.cells.length === 1) return line.text;
  const tolerance = stats.bodySize * 1.8;
  const parts: string[] = [line.cells[0]!.text];
  for (let i = 1; i < line.cells.length; i++) {
    const cell = line.cells[i]!;
    const aligned = boundaries.some((b) => Math.abs(b - cell.x0) <= tolerance);
    parts.push(aligned ? ' | ' : ' ');
    parts.push(cell.text);
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const TERMINAL_PUNCT_RE = /[。!?…”』」::!?;;.]$/;

/** Characters that CJK line-breaking forbids at line start (kinsoku). */
const KINSOKU_CLOSER_RE = /^[)）\]】」』》〉”’、,,。.;;::!!??…·]/u;

/**
 * Width (in device units) of the longest prefix of `text` that typography
 * would refuse to break: a Latin/number/identifier run, or one CJK character
 * together with any kinsoku-forbidden closers behind it. Used as wrap
 * evidence — a line whose successor's first unit could NOT have fit was
 * broken by the renderer, not by the author.
 */
function estimateFirstUnitWidth(text: string, size: number): number {
  const latin = /^[A-Za-z0-9._/%+#&=~-]+/.exec(text);
  if (latin) return latin[0].length * size * 0.6;
  const chars = [...text];
  if (chars.length === 0) return 0;
  let width = size;
  let i = 1;
  while (i < chars.length && KINSOKU_CLOSER_RE.test(chars[i]!)) {
    width += size;
    i++;
  }
  return width;
}

type UnitKind = 'heading' | 'paragraph' | 'list' | 'table';

interface Part {
  pageNumber: number;
  text: string;
}

interface Unit {
  kind: UnitKind;
  parts: Part[];
}

function lastChar(unit: Unit): string {
  const text = unit.parts[unit.parts.length - 1]?.text ?? '';
  return text.slice(-1);
}

/** Decide the join separator for a repaired visual wrap. */
function joinSeparator(
  prev: string,
  next: string,
  prevTrailingSpace: boolean,
): 'none' | 'space' | 'dehyphenate' {
  if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(next)) return 'dehyphenate';
  const prevChar = prev.slice(-1);
  const nextChar = next.charAt(0);
  if (isCjk(prevChar) && isCjk(nextChar)) return 'none';
  if (!isCjk(prevChar) && !isCjk(nextChar)) return 'space';
  // Mixed CJK/Latin boundary: only the extracted trailing space proves the
  // original text carried one (many CJK styles space Latin runs, many don't).
  return prevTrailingSpace ? 'space' : 'none';
}

/**
 * Reconstruct a whole document from positioned page items.
 * Pure and deterministic: identical input always yields identical output.
 */
export function analyzePdfLayout(pages: PdfPageInput[]): PdfLayoutResult {
  const warnings: string[] = [];
  const pageLines = pages.map((page) => reconstructLines(page));
  const stats = computeDocStats(pageLines);
  removeMarginLines(pageLines, stats);
  const headingLevels = computeHeadingLevels(pageLines, stats);

  const units: Unit[] = [];
  /** Kind of the line that produced the last unit (for separator choice). */
  let openParagraph: Unit | null = null;
  let openParagraphLine: Line | null = null;

  for (const [pageIndex, lines] of pageLines.entries()) {
    const page = pages[pageIndex]!;
    const active = lines.filter((l) => !l.removed);
    if (active.length === 0) {
      warnings.push(
        lines.length > 0
          ? `第 ${page.pageNumber} 页仅含重复的页眉/页脚内容,未提取到正文。`
          : `第 ${page.pageNumber} 页未提取到文本(可能是扫描图片页;未启用 OCR)。`,
      );
      openParagraph = null;
      openParagraphLine = null;
      continue;
    }

    // Classify headings first (needs gap-above context).
    const headingFlags: boolean[] = [];
    for (const [i, line] of active.entries()) {
      const gapAbove = i > 0 ? active[i - 1]!.y - line.y : null;
      headingFlags.push(
        isHeadingLine(line, headingLevels, gapAbove, i > 0 && headingFlags[i - 1]!, stats),
      );
    }

    const tableEligible = active.map((line, i) => !headingFlags[i] && !line.hasListMarker);
    const inTable: (TableRegion | null)[] = active.map(() => null);
    const regions = detectTableRegions(active, tableEligible, stats);
    for (const region of regions) {
      for (let i = region.start; i <= region.end; i++) inTable[i] = region;
    }

    for (const [i, line] of active.entries()) {
      const gapAbove = i > 0 ? active[i - 1]!.y - line.y : null;

      if (headingFlags[i]) {
        const level = headingLevels.get(line.dominantSize) ?? 6;
        units.push({
          kind: 'heading',
          parts: [{ pageNumber: page.pageNumber, text: `${'#'.repeat(level)} ${line.text}` }],
        });
        openParagraph = null;
        openParagraphLine = null;
        continue;
      }

      const region = inTable[i];
      if (region) {
        units.push({
          kind: 'table',
          parts: [
            { pageNumber: page.pageNumber, text: renderTableRow(line, region.boundaries, stats) },
          ],
        });
        openParagraph = null;
        openParagraphLine = null;
        continue;
      }

      if (line.hasListMarker) {
        const unit: Unit = {
          kind: 'list',
          parts: [{ pageNumber: page.pageNumber, text: `- ${line.text}` }],
        };
        units.push(unit);
        openParagraph = unit;
        openParagraphLine = line;
        continue;
      }

      // Plain body line: either continues the open paragraph (repaired
      // visual wrap) or starts a new one. A break is treated as VISUAL only
      // when the previous line ran to the body right edge (it wrapped because
      // it ran out of room); short lines keep their break — it was authored.
      // Pitch-based joining applies only to body-class lines, so code/table
      // sized text keeps its line structure. Cross-page continuation joins
      // only with strong evidence: previous page's final body line was
      // full-width AND did not end a sentence.
      let joined = false;
      if (openParagraph && openParagraphLine) {
        const bodyClass = (l: Line) =>
          l.dominantSize >= stats.bodySize * 0.9 && l.dominantSize <= stats.bodySize * 1.1;
        const bothBody = bodyClass(line) && bodyClass(openParagraphLine);
        const samePage = openParagraphLine.pageNumber === line.pageNumber;
        const gapOk =
          samePage &&
          bothBody &&
          gapAbove !== null &&
          gapAbove > 0 &&
          gapAbove <= stats.paragraphGapMax;
        const prevFullWidth =
          stats.rightEdgeReliable &&
          (openParagraphLine.x1 >= stats.rightEdge - stats.bodySize * 1.6 ||
            // The successor's first unbreakable unit would not have fit on
            // the previous line — the renderer forced this break.
            openParagraphLine.x1 + estimateFirstUnitWidth(line.text, stats.bodySize) >
              stats.rightEdge);
        const prevPartText = openParagraph.parts[openParagraph.parts.length - 1]!.text;
        // A Latin word split by a trailing hyphen before a lowercase
        // continuation is wrap evidence on its own: hyphenation only occurs
        // at forced line breaks.
        const hyphenWrap = /[A-Za-z]-$/.test(prevPartText) && /^[a-z]/.test(line.text);
        const prevUnterminated = !TERMINAL_PUNCT_RE.test(lastChar(openParagraph));
        const crossPageOk = !samePage && i === 0 && bothBody && prevFullWidth && prevUnterminated;

        if ((gapOk && (prevFullWidth || hyphenWrap)) || crossPageOk) {
          const prevPart = openParagraph.parts[openParagraph.parts.length - 1]!;
          const sep = joinSeparator(prevPart.text, line.text, openParagraphLine.trailingSpace);
          if (sep === 'dehyphenate') {
            prevPart.text = prevPart.text.slice(0, -1);
          }
          if (prevPart.pageNumber === line.pageNumber) {
            prevPart.text += (sep === 'space' ? ' ' : '') + line.text;
          } else {
            openParagraph.parts.push({
              pageNumber: line.pageNumber,
              text: (sep === 'space' ? ' ' : '') + line.text,
            });
          }
          openParagraphLine = line;
          joined = true;
        }
      }

      if (!joined) {
        const unit: Unit = {
          kind: 'paragraph',
          parts: [{ pageNumber: page.pageNumber, text: line.text }],
        };
        units.push(unit);
        openParagraph = unit;
        openParagraphLine = line;
      }
    }
  }

  // ---- Emit text + exact per-page character runs ----
  let text = '';
  const runs: { pageNumber: number; start: number; end: number }[] = [];
  const appendPart = (part: Part) => {
    const start = text.length;
    text += part.text;
    const last = runs[runs.length - 1];
    if (last && last.pageNumber === part.pageNumber && last.end === start) {
      last.end = text.length;
    } else {
      runs.push({ pageNumber: part.pageNumber, start, end: text.length });
    }
  };

  for (const [index, unit] of units.entries()) {
    if (index > 0) {
      const prev = units[index - 1]!;
      // Contiguous list items and table rows stay in one block: single LF.
      const tight =
        (prev.kind === 'list' && unit.kind === 'list') ||
        (prev.kind === 'table' && unit.kind === 'table');
      text += tight ? '\n' : '\n\n';
    }
    for (const part of unit.parts) appendPart(part);
  }

  const pageSpans: PageSpan[] = [];
  for (const page of pages) {
    const pageRuns = runs.filter((r) => r.pageNumber === page.pageNumber);
    if (pageRuns.length === 0) continue;
    pageSpans.push({
      pageNumber: page.pageNumber,
      startOffset: pageRuns[0]!.start,
      endOffset: pageRuns[pageRuns.length - 1]!.end,
    });
  }

  return { text, pageSpans, warnings };
}
