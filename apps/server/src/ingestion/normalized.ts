import {
  fnv1a32,
  NormalizedDocumentSchema,
  type EmbeddedAsset,
  type MediaType,
  type NormalizedDocument,
  type NormalizedDocumentUnit,
  type NormalizedLocation,
  type ParserCapability,
  type SourceBlock,
  type SourceType,
} from '@hy3-clinic/shared';
import { IngestionError, normalizeText } from './ingest.js';
import { HTML_PARSER_VERSION, parseHtml } from './html.js';

export const STRUCTURE_AWARE_CHUNKER_VERSION = 'structure-aware-v1';
export const STRUCTURE_AWARE_CHUNKER_FINGERPRINT = `chunk_${fnv1a32(
  JSON.stringify({ version: STRUCTURE_AWARE_CHUNKER_VERSION, target: 1800, hardMax: 3000 }),
)
  .toString(16)
  .padStart(8, '0')}`;

export const NORMALIZED_DOCUMENT_LIMITS = {
  maxContentChars: 100_000,
  maxUnits: 20_000,
  targetChunkChars: 1_800,
  hardChunkChars: 3_000,
  maxChunks: 2_000,
} as const;

export interface NormalizeInput {
  revisionId: string;
  materialId?: string;
  sourceType: SourceType;
  mediaType: NormalizedDocument['mediaType'];
  content: string;
  filename?: string | null;
  pageSpans?: Array<{ pageNumber: number; startOffset: number; endOffset: number }>;
  parserId?: string;
  parserVersion?: string;
  warnings?: string[];
  assets?: EmbeddedAsset[];
}

export interface ChunkProjection {
  content: string;
  startOffset: number;
  endOffset: number;
  headingPath: string[];
  unitIds: string[];
  pageNumber: number | null;
  pageEnd: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  slideNumber: number | null;
}

export interface ParserAdapter {
  readonly id: string;
  readonly version: string;
  readonly sourceTypes: readonly SourceType[];
  readonly extensions: readonly string[];
  readonly capabilities: readonly ParserCapability[];
  readonly limits: typeof NORMALIZED_DOCUMENT_LIMITS;
  readonly mediaTypes?: readonly MediaType[];
  readonly signatures?: readonly string[];
  parse(input: NormalizeInput): NormalizedDocument;
}

const CAP_TEXT: readonly ParserCapability[] = [
  'text_extraction',
  'structural_hierarchy',
  'deterministic_text',
  'source_location_precision',
];

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineLocation(
  starts: number[],
  startOffset: number,
  endOffset: number,
): NormalizedLocation {
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle]! <= offset) low = middle + 1;
      else high = middle - 1;
    }
    return Math.max(1, high + 1);
  };
  return { lineStart: lineAt(startOffset), lineEnd: lineAt(Math.max(startOffset, endOffset - 1)) };
}

function unitId(revisionId: string, index: number, kind: string, startOffset: number): string {
  return `unit_${fnv1a32(`${revisionId}:${index}:${kind}:${startOffset}`).toString(16).padStart(8, '0')}`;
}

function parserFingerprint(adapterId: string, version: string): string {
  return `parser_${fnv1a32(`${adapterId}:${version}`).toString(16).padStart(8, '0')}`;
}

function pageLocation(
  spans: NormalizeInput['pageSpans'],
  startOffset: number,
  endOffset: number,
): NormalizedLocation {
  if (!spans?.length) return {};
  const containing = spans.filter(
    (span) => endOffset > span.startOffset && startOffset < span.endOffset,
  );
  if (!containing.length) return {};
  return {
    pageNumber: containing[0]!.pageNumber,
    pageEnd: containing[containing.length - 1]!.pageNumber,
  };
}

function buildUnit(
  input: NormalizeInput,
  starts: number[],
  index: number,
  kind: NormalizedDocumentUnit['kind'],
  startOffset: number,
  endOffset: number,
  headingPath: string[],
  title: string | null,
  parentUnitId: string | null = null,
): NormalizedDocumentUnit {
  const content = input.content.slice(startOffset, endOffset);
  const location = {
    ...lineLocation(starts, startOffset, endOffset),
    ...pageLocation(input.pageSpans, startOffset, endOffset),
  };
  return {
    id: unitId(input.revisionId, index, kind, startOffset),
    materialRevisionId: input.revisionId,
    parentUnitId,
    kind,
    index,
    title,
    content,
    startOffset,
    endOffset,
    headingPath,
    location,
    contentOrigin: 'extracted_original',
    derivation: 'parser_derived',
  };
}

function finishDocument(
  input: NormalizeInput,
  adapterId: string,
  version: string,
  units: NormalizedDocumentUnit[],
  capabilities: readonly ParserCapability[],
  warnings: string[] = [],
): NormalizedDocument {
  if (units.length === 0 || input.content.trim().length === 0) {
    throw new IngestionError('EMPTY_SOURCE', '未在源材料中找到可用的结构化正文。');
  }
  if (input.content.length > NORMALIZED_DOCUMENT_LIMITS.maxContentChars) {
    throw new IngestionError(
      'SOURCE_TOO_LARGE',
      `源材料超过 ${NORMALIZED_DOCUMENT_LIMITS.maxContentChars} 个字符。`,
    );
  }
  if (units.length > NORMALIZED_DOCUMENT_LIMITS.maxUnits) {
    throw new IngestionError(
      'SOURCE_TOO_LARGE',
      `源材料结构单元超过 ${NORMALIZED_DOCUMENT_LIMITS.maxUnits} 个。`,
    );
  }
  return NormalizedDocumentSchema.parse({
    materialRevisionId: input.revisionId,
    sourceType: input.sourceType,
    mediaType: input.mediaType,
    content: input.content,
    units,
    capabilities: [...capabilities],
    warnings: warnings.slice(0, 50),
    complete: warnings.length === 0,
    parserVersion: version,
    parserFingerprint: parserFingerprint(adapterId, version),
    assets: input.assets ?? [],
  });
}

function isHeading(line: string): RegExpExecArray | null {
  return /^\s{0,3}(#{1,6})(?:\s+|$)(.*?)\s*#*\s*$/.exec(line);
}

function isListLine(line: string): boolean {
  return !isThematicBreak(line) && /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
}

function isQuoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line) || /^\s*[^|\n]+\|[^|\n]+\s*$/.test(line);
}

function isThematicBreak(line: string): boolean {
  return (
    /^\s*(?:\*\s*){3,}$/.test(line) ||
    /^\s*(?:-\s*){3,}$/.test(line) ||
    /^\s*(?:_\s*){3,}$/.test(line)
  );
}

function isFenceStart(line: string): RegExpExecArray | null {
  return /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
}

/** Parse Markdown without stripping syntax or allowing fences to affect headings. */
export function normalizeMarkdown(input: NormalizeInput): NormalizedDocument {
  const content = normalizeText(input.content);
  const normalizedInput = { ...input, content };
  const starts = lineStarts(content);
  const lines = content.split('\n');
  const units: NormalizedDocumentUnit[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  let cursor = 0;
  let index = 0;
  let paragraphStart: number | null = null;
  let paragraphEnd = 0;

  const currentPath = (): string[] => headingStack.map((heading) => heading.text);
  const flushParagraph = () => {
    if (paragraphStart === null) return;
    const start = paragraphStart;
    const end = paragraphEnd;
    if (content.slice(start, end).trim()) {
      units.push(
        buildUnit(normalizedInput, starts, index++, 'paragraph', start, end, currentPath(), null),
      );
    }
    paragraphStart = null;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const lineStart = cursor;
    const lineEnd = lineStart + line.length;
    cursor = lineEnd + 1;

    const fence = isFenceStart(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1]![0]!;
      const markerLength = fence[1]!.length;
      let endLine = lineIndex;
      for (let candidate = lineIndex + 1; candidate < lines.length; candidate += 1) {
        const close = new RegExp(`^\\s{0,3}${marker}{${markerLength},}\\s*$`).test(
          lines[candidate]!,
        );
        if (close) {
          endLine = candidate;
          break;
        }
        endLine = candidate;
      }
      const endOffset = starts[endLine]! + lines[endLine]!.length;
      const language = fence[2]!.trim().split(/\s+/u)[0] || null;
      units.push(
        buildUnit(
          normalizedInput,
          starts,
          index++,
          'code_block',
          lineStart,
          endOffset,
          currentPath(),
          language,
        ),
      );
      cursor = endOffset + 1;
      lineIndex = endLine;
      continue;
    }

    const heading = isHeading(line);
    if (heading && heading[2]!.trim()) {
      flushParagraph();
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level)
        headingStack.pop();
      headingStack.push({ level, text });
      units.push(
        buildUnit(
          normalizedInput,
          starts,
          index++,
          'heading',
          lineStart,
          lineEnd,
          currentPath().slice(0, -1),
          text,
        ),
      );
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const structural =
      isListLine(line) || isQuoteLine(line) || isTableLine(line) || isThematicBreak(line);
    if (structural) {
      flushParagraph();
      const kind = isListLine(line)
        ? 'list'
        : isQuoteLine(line)
          ? 'quote'
          : isTableLine(line)
            ? 'table'
            : 'other';
      let endLine = lineIndex;
      while (
        endLine + 1 < lines.length &&
        lines[endLine + 1]!.trim() &&
        (kind === 'list'
          ? isListLine(lines[endLine + 1]!)
          : kind === 'quote'
            ? isQuoteLine(lines[endLine + 1]!)
            : kind === 'table'
              ? isTableLine(lines[endLine + 1]!)
              : isThematicBreak(lines[endLine + 1]!))
      ) {
        endLine += 1;
      }
      const endOffset = starts[endLine]! + lines[endLine]!.length;
      const parent = buildUnit(
        normalizedInput,
        starts,
        index++,
        kind,
        lineStart,
        endOffset,
        currentPath(),
        null,
      );
      units.push(parent);
      if (kind === 'list') {
        for (let childLine = lineIndex; childLine <= endLine; childLine += 1) {
          if (!isListLine(lines[childLine]!)) continue;
          const childStart = starts[childLine]!;
          const childEnd = childStart + lines[childLine]!.length;
          units.push(
            buildUnit(
              normalizedInput,
              starts,
              index++,
              'list_item',
              childStart,
              childEnd,
              currentPath(),
              null,
              parent.id,
            ),
          );
        }
      }
      cursor = endOffset + 1;
      lineIndex = endLine;
      continue;
    }

    if (paragraphStart === null) paragraphStart = lineStart;
    paragraphEnd = lineEnd;
  }
  flushParagraph();
  return finishDocument(
    normalizedInput,
    input.parserId ?? 'markdown-structure',
    input.parserVersion ?? 'markdown-structure-v1',
    units,
    CAP_TEXT,
    input.warnings,
  );
}

/** Plain text parser: blank lines are the only structural cue. */
export function normalizeTxt(input: NormalizeInput): NormalizedDocument {
  const content = normalizeText(input.content);
  const normalizedInput = { ...input, content };
  const starts = lineStarts(content);
  const lines = content.split('\n');
  const units: NormalizedDocumentUnit[] = [];
  let cursor = 0;
  let start: number | null = null;
  let end = 0;
  let index = 0;
  const flush = () => {
    if (start !== null && content.slice(start, end).trim()) {
      units.push(buildUnit(normalizedInput, starts, index++, 'paragraph', start, end, [], null));
    }
    start = null;
  };
  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = lineStart + line.length;
    cursor = lineEnd + 1;
    if (!line.trim()) flush();
    else {
      if (start === null) start = lineStart;
      end = lineEnd;
    }
  }
  flush();
  return finishDocument(
    normalizedInput,
    input.parserId ?? 'text-structure',
    input.parserVersion ?? 'text-structure-v1',
    units,
    ['text_extraction', 'deterministic_text', 'source_location_precision'],
    input.warnings,
  );
}

/** Preserve PDF page ownership without replacing the existing structural pass. */
export function normalizePdf(input: NormalizeInput): NormalizedDocument {
  const document = normalizeMarkdown({
    ...input,
    parserId: input.parserId ?? 'pdf-layout',
    parserVersion: input.parserVersion ?? 'pdf-layout-v2',
  });
  const spans = [...(input.pageSpans ?? [])]
    .filter(
      (span) =>
        span.pageNumber > 0 &&
        span.startOffset >= 0 &&
        span.endOffset >= span.startOffset &&
        span.endOffset <= document.content.length,
    )
    .sort(
      (left, right) => left.startOffset - right.startOffset || left.pageNumber - right.pageNumber,
    );
  if (spans.length === 0) {
    return NormalizedDocumentSchema.parse({
      ...document,
      capabilities: [...CAP_TEXT, 'page_awareness', 'table_structure'],
    });
  }

  const pageUnits = spans.map((span, pageIndex): NormalizedDocumentUnit => ({
    id: unitId(input.revisionId, document.units.length + pageIndex, 'page', span.startOffset),
    materialRevisionId: input.revisionId,
    parentUnitId: null,
    kind: 'page',
    index: 0,
    title: `Page ${span.pageNumber}`,
    content: document.content.slice(span.startOffset, span.endOffset),
    startOffset: span.startOffset,
    endOffset: span.endOffset,
    headingPath: [],
    location: { pageNumber: span.pageNumber, pageEnd: span.pageNumber },
    contentOrigin: 'extracted_original',
    derivation: 'parser_derived',
  }));
  const units = document.units.map((unit) => {
    if (unit.parentUnitId) return unit;
    const pageIndex = spans.findIndex(
      (span) => unit.startOffset >= span.startOffset && unit.endOffset <= span.endOffset,
    );
    return pageIndex < 0 ? unit : { ...unit, parentUnitId: pageUnits[pageIndex]!.id };
  });
  const ordered = [...pageUnits, ...units]
    .sort((left, right) => {
      const offsetOrder = left.startOffset - right.startOffset;
      if (offsetOrder !== 0) return offsetOrder;
      if (left.kind === 'page' && right.kind === 'page') {
        return (left.location.pageNumber ?? 0) - (right.location.pageNumber ?? 0);
      }
      if (left.kind === 'page') return -1;
      if (right.kind === 'page') return 1;
      return left.index - right.index;
    })
    .map((unit, index) => ({ ...unit, index }));
  if (ordered.length > NORMALIZED_DOCUMENT_LIMITS.maxUnits) {
    throw new IngestionError(
      'SOURCE_TOO_LARGE',
      `源材料结构单元超过 ${NORMALIZED_DOCUMENT_LIMITS.maxUnits} 个。`,
    );
  }
  return NormalizedDocumentSchema.parse({
    ...document,
    units: ordered,
    capabilities: [...CAP_TEXT, 'page_awareness', 'table_structure'],
  });
}

function codeLineKind(line: string): 'class' | 'function' | null {
  if (
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|struct|enum)\s+[A-Za-z_$][\w$]*/.test(
      line,
    )
  )
    return 'class';
  if (/^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(line))
    return 'function';
  if (/^\s*def\s+[A-Za-z_][\w]*\s*\(/.test(line) || /^\s*fn\s+[A-Za-z_][\w]*\s*\(/.test(line))
    return 'function';
  if (
    /^\s*(?:public|private|protected|static|async|inline|const|virtual|override\s+)*[\w<>()[\], ?*&]+\s+[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?:\{|:)/.test(
      line,
    )
  )
    return 'function';
  return null;
}

function braceDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];
    if (!quote && char === '/' && next === '/') break;
    if (!quote && char === '#') break;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') delta += 1;
    if (char === '}') delta -= 1;
  }
  return delta;
}

const SOURCE_EXTENSIONS = [
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'java',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'scala',
  'sh',
  'bash',
  'zsh',
  'sql',
  'json',
  'yaml',
  'yml',
];

export function sourceLanguageForFilename(filename: string | null | undefined): string | null {
  const extension = filename
    ?.trim()
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/u)?.[1];
  return extension && SOURCE_EXTENSIONS.includes(extension) ? extension : null;
}

/** Lightweight deterministic code structure recognition; no execution or repository analysis. */
export function normalizeSourceCode(input: NormalizeInput): NormalizedDocument {
  const content = normalizeText(input.content);
  const normalizedInput = { ...input, content };
  const starts = lineStarts(content);
  const lines = content.split('\n');
  const units: NormalizedDocumentUnit[] = [];
  let index = 0;
  const root = buildUnit(
    normalizedInput,
    starts,
    index++,
    'source_file',
    0,
    content.length,
    [],
    input.filename ?? null,
  );
  units.push(root);
  const structuralRanges: Array<{
    start: number;
    end: number;
    kind: 'class' | 'function';
    title: string | null;
  }> = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!;
    const kind = codeLineKind(line);
    if (!kind) {
      lineIndex += 1;
      continue;
    }
    let startLine = lineIndex;
    while (startLine > 0 && /^\s*(?:\/\/|#|\*|\/\*|"""|''')/.test(lines[startLine - 1]!))
      startLine -= 1;
    let endLine = lineIndex;
    let depth = 0;
    let sawBrace = false;
    const baseIndent = line.length - line.trimStart().length;
    for (let candidate = lineIndex; candidate < lines.length; candidate += 1) {
      const delta = braceDelta(lines[candidate]!);
      if (delta !== 0) sawBrace = true;
      depth += delta;
      endLine = candidate;
      if (sawBrace && depth <= 0) break;
      if (!sawBrace && candidate > lineIndex) {
        const next = lines[candidate]!;
        const nextIndent = next.length - next.trimStart().length;
        if (next.trim() && nextIndent <= baseIndent && !/^\s*(?:#|\/\/|\/\*|\*|"""|''')/.test(next))
          break;
      }
    }
    const start = starts[startLine]!;
    const end = starts[endLine]! + lines[endLine]!.length;
    const title =
      /\b(?:class|interface|struct|enum|function|def|fn)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1] ??
      null;
    structuralRanges.push({ start, end, kind, title });
    lineIndex = endLine + 1;
  }
  structuralRanges.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  const addGap = (start: number, end: number) => {
    if (end <= start || !content.slice(start, end).trim()) return;
    units.push(
      buildUnit(
        normalizedInput,
        starts,
        index++,
        'source_code_block',
        start,
        end,
        [],
        null,
        root.id,
      ),
    );
  };
  for (const range of structuralRanges) {
    if (range.start < cursor) continue;
    addGap(cursor, range.start);
    units.push(
      buildUnit(
        normalizedInput,
        starts,
        index++,
        range.kind,
        range.start,
        range.end,
        [],
        range.title,
        root.id,
      ),
    );
    cursor = range.end;
  }
  addGap(cursor, content.length);
  units.splice(
    1,
    units.length - 1,
    ...units
      .slice(1)
      .sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset)
      .map((unit, position) => ({ ...unit, index: position + 1 })),
  );
  return finishDocument(
    normalizedInput,
    input.parserId ?? 'source-code-structure',
    input.parserVersion ?? 'source-code-structure-v1',
    units,
    [...CAP_TEXT, 'exact_line_ranges'],
    input.warnings,
  );
}

export function parserForSourceType(sourceType: SourceType): ParserAdapter {
  if (sourceType === 'md') return MARKDOWN_ADAPTER;
  if (sourceType === 'source_code') return SOURCE_CODE_ADAPTER;
  if (sourceType === 'txt') return TXT_ADAPTER;
  if (sourceType === 'paste') return MARKDOWN_ADAPTER;
  if (sourceType === 'pdf') return PDF_ADAPTER;
  if (sourceType === 'docx') return DOCX_ADAPTER;
  if (sourceType === 'pptx') return PPTX_ADAPTER;
  if (sourceType === 'html') return HTML_ADAPTER;
  // Existing PDF/DOCX extraction already supplies normalized text and page
  // spans. The Markdown structural pass preserves its headings/lists without
  // claiming to be a richer PDF/DOCX parser.
  return MARKDOWN_ADAPTER;
}

export const MARKDOWN_ADAPTER: ParserAdapter = {
  id: 'markdown-structure',
  version: 'markdown-structure-v1',
  sourceTypes: ['md', 'paste'],
  extensions: ['md', 'markdown'],
  mediaTypes: ['text/markdown'],
  capabilities: CAP_TEXT,
  limits: NORMALIZED_DOCUMENT_LIMITS,
  parse: normalizeMarkdown,
};
export const TXT_ADAPTER: ParserAdapter = {
  id: 'text-structure',
  version: 'text-structure-v1',
  sourceTypes: ['txt'],
  extensions: ['txt', 'text'],
  mediaTypes: ['text/plain'],
  capabilities: ['text_extraction', 'deterministic_text', 'source_location_precision'],
  limits: NORMALIZED_DOCUMENT_LIMITS,
  parse: normalizeTxt,
};
export const SOURCE_CODE_ADAPTER: ParserAdapter = {
  id: 'source-code-structure',
  version: 'source-code-structure-v1',
  sourceTypes: ['source_code'],
  extensions: SOURCE_EXTENSIONS,
  mediaTypes: ['text/x-source-code'],
  capabilities: [...CAP_TEXT, 'exact_line_ranges'],
  limits: NORMALIZED_DOCUMENT_LIMITS,
  parse: normalizeSourceCode,
};

export const PDF_ADAPTER: ParserAdapter = {
  id: 'pdf-layout',
  version: 'pdf-layout-v2',
  sourceTypes: ['pdf'],
  extensions: ['pdf'],
  mediaTypes: ['application/pdf'],
  signatures: ['%PDF-'],
  capabilities: [...CAP_TEXT, 'page_awareness', 'table_structure'],
  limits: NORMALIZED_DOCUMENT_LIMITS,
  parse: normalizePdf,
};
export const DOCX_ADAPTER: ParserAdapter = {
  id: 'docx-mammoth',
  version: 'docx-mammoth-v1',
  sourceTypes: ['docx'],
  extensions: ['docx'],
  mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  signatures: ['PK'],
  capabilities: CAP_TEXT,
  limits: NORMALIZED_DOCUMENT_LIMITS,
  parse: (input) =>
    normalizeMarkdown({ ...input, parserId: 'docx-mammoth', parserVersion: 'docx-mammoth-v1' }),
};
export const PPTX_ADAPTER: ParserAdapter = {
  id: 'pptx-ooxml-rich',
  version: 'pptx-ooxml-rich-v1',
  sourceTypes: ['pptx'],
  extensions: ['pptx'],
  mediaTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  signatures: ['PK'],
  capabilities: [...CAP_TEXT, 'slide_awareness', 'embedded_assets', 'table_structure'],
  limits: NORMALIZED_DOCUMENT_LIMITS,
  parse: (input) =>
    normalizeMarkdown({
      ...input,
      parserId: 'pptx-ooxml-rich',
      parserVersion: 'pptx-ooxml-rich-v1',
    }),
};

export const HTML_ADAPTER: ParserAdapter = {
  id: 'html-readability-jsdom',
  version: HTML_PARSER_VERSION,
  sourceTypes: ['html'],
  extensions: ['html', 'htm'],
  mediaTypes: ['text/html'],
  capabilities: [
    'text_extraction',
    'structural_hierarchy',
    'table_structure',
    'deterministic_text',
    'source_location_precision',
  ],
  limits: NORMALIZED_DOCUMENT_LIMITS,
  parse: (input) =>
    parseHtml(input.content, {
      revisionId: input.revisionId,
      materialId: input.materialId,
      sourceType: 'html',
      baseUrl: input.filename?.match(/^https?:\/\//iu) ? input.filename : undefined,
      warnings: input.warnings,
    }).normalizedDocument,
};

export const PARSER_REGISTRY: readonly ParserAdapter[] = [
  MARKDOWN_ADAPTER,
  TXT_ADAPTER,
  SOURCE_CODE_ADAPTER,
  PDF_ADAPTER,
  DOCX_ADAPTER,
  PPTX_ADAPTER,
  HTML_ADAPTER,
];

export function chunkNormalizedDocument(document: NormalizedDocument): ChunkProjection[] {
  const candidates = document.units.filter(
    (unit) =>
      !['document', 'source_file', 'page', 'slide', 'text_box', 'list_item'].includes(unit.kind) &&
      unit.endOffset > unit.startOffset &&
      unit.content.length > 0,
  );
  const chunks: ChunkProjection[] = [];
  const emit = (
    unit: NormalizedDocumentUnit,
    startOffset = unit.startOffset,
    endOffset = unit.endOffset,
    unitIds = [unit.id],
  ) => {
    chunks.push({
      content: document.content.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      headingPath: [...unit.headingPath],
      unitIds,
      pageNumber: unit.location.pageNumber ?? null,
      pageEnd: unit.location.pageEnd ?? unit.location.pageNumber ?? null,
      lineStart: unit.location.lineStart ?? null,
      lineEnd: unit.location.lineEnd ?? null,
      slideNumber: unit.location.slideNumber ?? null,
    });
  };
  const sharesPageOrSlide = (
    heading: NormalizedDocumentUnit,
    unit: NormalizedDocumentUnit,
  ): boolean => {
    for (const field of ['pageNumber', 'slideNumber'] as const) {
      const headingValue = heading.location[field] ?? null;
      const unitValue = unit.location[field] ?? null;
      if ((headingValue !== null || unitValue !== null) && headingValue !== unitValue) return false;
    }
    return true;
  };
  let pendingHeading: NormalizedDocumentUnit | null = null;
  for (const unit of candidates) {
    if (unit.kind === 'heading') {
      if (pendingHeading) emit(pendingHeading);
      pendingHeading = unit;
      continue;
    }
    if (pendingHeading && !sharesPageOrSlide(pendingHeading, unit)) {
      emit(pendingHeading);
      pendingHeading = null;
    }
    const startWithHeading = pendingHeading?.startOffset ?? unit.startOffset;
    const unitIds = pendingHeading ? [pendingHeading.id, unit.id] : [unit.id];
    const effectiveUnit = pendingHeading
      ? {
          ...unit,
          startOffset: startWithHeading,
          content: document.content.slice(startWithHeading, unit.endOffset),
        }
      : unit;
    pendingHeading = null;
    const oversized =
      effectiveUnit.endOffset - effectiveUnit.startOffset >
      NORMALIZED_DOCUMENT_LIMITS.hardChunkChars;
    if (oversized) {
      let start = unit.startOffset;
      const firstStart = startWithHeading;
      while (start < unit.endOffset) {
        const budgetStart = start === unit.startOffset ? firstStart : start;
        const hardEnd = Math.min(
          start +
            NORMALIZED_DOCUMENT_LIMITS.hardChunkChars -
            (budgetStart < unit.startOffset ? unit.startOffset - budgetStart : 0),
          unit.endOffset,
        );
        let end = hardEnd;
        const newline = document.content.lastIndexOf('\n', hardEnd - 1);
        if (newline > start + 80) end = newline;
        emit(effectiveUnit, start === unit.startOffset ? firstStart : start, end, unitIds);
        start = end;
        while (start < unit.endOffset && /\s/u.test(document.content[start]!)) start += 1;
      }
      continue;
    }
    // Structural units are the primary learning/retrieval boundary. We do
    // not merge adjacent paragraphs by default: preserving blank-line,
    // list, quote, table, and page boundaries keeps legacy evidence coverage
    // stable while still allowing oversized units to use the hard-limit path.
    emit(effectiveUnit, effectiveUnit.startOffset, effectiveUnit.endOffset, unitIds);
  }
  if (pendingHeading) emit(pendingHeading);
  if (!chunks.length) {
    if (document.content.length === 0 && document.assets.length > 0) return [];
    throw new IngestionError('EMPTY_SOURCE', '未生成可用的源代码或正文块。');
  }
  if (chunks.length > NORMALIZED_DOCUMENT_LIMITS.maxChunks)
    throw new IngestionError(
      'SOURCE_TOO_LARGE',
      `源材料块数超过 ${NORMALIZED_DOCUMENT_LIMITS.maxChunks}。`,
    );
  return chunks;
}

export function normalizedDocumentToSourceBlocks(
  materialId: string,
  document: NormalizedDocument,
  options: { idSeed?: string; materialRevisionId?: string } = {},
): SourceBlock[] {
  return chunkNormalizedDocument(document).map((chunk, index) => {
    const idSeed = options.idSeed ?? materialId;
    const id = `blk_${index}_${fnv1a32(`${idSeed}:${STRUCTURE_AWARE_CHUNKER_VERSION}:${chunk.startOffset}:${chunk.endOffset}:${chunk.content}`).toString(16).padStart(8, '0')}`;
    const heading = chunk.headingPath.length
      ? chunk.headingPath[chunk.headingPath.length - 1]!
      : null;
    return {
      id,
      materialId,
      materialRevisionId: options.materialRevisionId ?? document.materialRevisionId,
      index,
      heading,
      headingPath: chunk.headingPath,
      pageNumber: chunk.pageNumber,
      pageEnd: chunk.pageEnd,
      slideNumber: chunk.slideNumber,
      content: chunk.content,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      structuralUnitId: chunk.unitIds[chunk.unitIds.length - 1] ?? null,
      chunkerVersion: STRUCTURE_AWARE_CHUNKER_VERSION,
      contentOrigin: 'extracted_original' as const,
    };
  });
}
