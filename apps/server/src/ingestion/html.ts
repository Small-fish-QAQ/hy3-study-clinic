import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import type {
  NormalizedDocument,
  NormalizedDocumentUnit,
  NormalizedLocation,
  SourceType,
} from '@hy3-clinic/shared';
import { IngestionError, normalizeText } from './ingest.js';

export const HTML_PARSER_VERSION = 'html-readability-jsdom-v1';
export const HTML_EXTRACTION_STRATEGY_VERSION = 'readability-structured-fallback-v1';
export const HTML_MAX_BYTES = 10 * 1024 * 1024;

export interface HtmlParseOptions {
  revisionId: string;
  materialId?: string;
  sourceType?: SourceType;
  mediaType?: 'text/html';
  baseUrl?: string;
  warnings?: string[];
}

export interface ParsedHtmlDocument {
  content: string;
  title: string | null;
  warnings: string[];
  parserVersion: string;
  normalizedDocument: NormalizedDocument;
}

function unitId(revisionId: string, index: number, kind: string, start: number): string {
  return `unit_html_${createHash('sha256').update(`${revisionId}:${index}:${kind}:${start}`).digest('hex').slice(0, 16)}`;
}

function decodeHtml(bytes: Buffer): { html: string; warning?: string } {
  if (bytes.length > HTML_MAX_BYTES) {
    throw new IngestionError('SOURCE_TOO_LARGE', `HTML 快照超过 ${HTML_MAX_BYTES} 字节。`);
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bom) return { html: bytes.subarray(3).toString('utf8') };
  const head = bytes.subarray(0, 4096).toString('latin1');
  const declared = /charset\s*=\s*["']?([a-z0-9._-]+)/iu.exec(head)?.[1]?.toLowerCase();
  const encoding =
    declared && ['utf-8', 'utf8', 'iso-8859-1', 'latin1', 'windows-1252'].includes(declared)
      ? declared === 'utf8'
        ? 'utf-8'
        : declared
      : 'utf-8';
  try {
    return {
      html: new TextDecoder(encoding as BufferEncoding).decode(bytes),
      ...(declared ? {} : { warning: 'HTML 未声明字符编码，按 UTF-8 解码。' }),
    };
  } catch {
    return {
      html: bytes.toString('utf8'),
      warning: `HTML 字符编码 ${declared ?? 'unknown'} 不受支持，已回退到 UTF-8。`,
    };
  }
}

function textOf(node: Element): string {
  return (node.textContent ?? '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s*\n\s*/gu, ' ')
    .trim();
}

function safeUrl(value: string | null, baseUrl: string): string | null {
  if (!value || value.startsWith('#') || /^javascript:/iu.test(value) || /^data:/iu.test(value))
    return null;
  try {
    const url = new URL(value, baseUrl);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function domPath(node: Element): string {
  const parts: string[] = [];
  let current: Element | null = node;
  while (current && current.parentElement && parts.length < 24) {
    let position = 1;
    for (
      let sibling = current.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    ) {
      if (sibling.tagName === current.tagName) position += 1;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${position}]`);
    current = current.parentElement;
  }
  return `/${parts.join('/')}`.slice(0, 500);
}

function unitContent(element: Element, baseUrl: string): string {
  const clone = element.cloneNode(true) as Element;
  for (const link of Array.from(clone.querySelectorAll('a'))) {
    const href = safeUrl(link.getAttribute('href'), baseUrl);
    const text = textOf(link);
    if (href && text) link.replaceWith(`[${text}](${href})`);
    else if (!text) link.remove();
  }
  for (const image of Array.from(clone.querySelectorAll('img'))) {
    const alt = image.getAttribute('alt')?.trim() ?? '';
    const src = safeUrl(image.getAttribute('src'), baseUrl);
    const marker = src ? `![${alt}](${src})` : alt ? `[image: ${alt}]` : '';
    image.replaceWith(marker);
  }
  if (element.tagName === 'PRE') return clone.textContent ?? '';
  if (element.tagName === 'TABLE') {
    return Array.from(clone.querySelectorAll('tr'))
      .map((row) =>
        Array.from(row.querySelectorAll('th,td'))
          .map((cell) => textOf(cell))
          .join(' | '),
      )
      .filter(Boolean)
      .join('\n');
  }
  return (clone.textContent ?? '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s*\n\s*/gu, ' ')
    .trim();
}

function makeDocument(
  input: HtmlParseOptions,
  content: string,
  units: NormalizedDocumentUnit[],
  warnings: string[],
): NormalizedDocument {
  if (!content.trim() || units.length === 0)
    throw new IngestionError('EMPTY_SOURCE', 'HTML 中没有可用的正文。');
  return {
    materialRevisionId: input.revisionId,
    sourceType: input.sourceType ?? 'html',
    mediaType: 'text/html',
    content,
    units,
    capabilities: [
      'text_extraction',
      'structural_hierarchy',
      'table_structure',
      'deterministic_text',
      'source_location_precision',
    ],
    warnings: warnings.slice(0, 50),
    complete: warnings.length === 0,
    parserVersion: HTML_PARSER_VERSION,
    parserFingerprint: `parser_${createHash('sha256').update(HTML_PARSER_VERSION).digest('hex').slice(0, 16)}`,
    assets: [],
  };
}

/** Parse static HTML without evaluating scripts or fetching subresources. */
export function parseHtmlBytes(bytes: Buffer, options: HtmlParseOptions): ParsedHtmlDocument {
  const decoded = decodeHtml(bytes);
  return parseHtml(decoded.html, {
    ...options,
    warnings: [...(options.warnings ?? []), ...(decoded.warning ? [decoded.warning] : [])],
  });
}

export function parseHtml(html: string, options: HtmlParseOptions): ParsedHtmlDocument {
  const warnings = [...(options.warnings ?? [])];
  const baseUrl = options.baseUrl ?? 'https://study-clinic.invalid/';
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, {
      url: baseUrl,
      runScripts: 'outside-only',
      resources: undefined,
      pretendToBeVisual: false,
    });
  } catch {
    throw new IngestionError('PARSE_FAILED', 'HTML 解析失败。');
  }
  for (const node of Array.from(
    dom.window.document.querySelectorAll<Element>(
      'script,style,noscript,template,iframe,object,embed',
    ),
  ))
    node.remove();
  const originalBody = dom.window.document.body ?? dom.window.document.documentElement;
  const readable = new Readability(dom.window.document, {
    charThreshold: 0,
    keepClasses: true,
  }).parse();
  let root: Element;
  if (readable?.content?.trim()) {
    const articleDom = new JSDOM(`<body>${readable.content}</body>`, {
      url: baseUrl,
      runScripts: 'outside-only',
    });
    root = articleDom.window.document.body;
  } else {
    warnings.push('主内容提取未返回正文，已使用结构化 body 回退。');
    root = originalBody;
  }
  const units: NormalizedDocumentUnit[] = [];
  const output: string[] = [];
  const headingStack: string[] = [];
  const blockTags = new Set([
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'P',
    'LI',
    'BLOCKQUOTE',
    'PRE',
    'TABLE',
    'FIGURE',
    'HR',
    'DT',
    'DD',
  ]);
  const visit = (element: Element) => {
    const tag = element.tagName;
    if (tag === 'UL' || tag === 'OL') {
      const items = Array.from(element.children).filter((child) => child.tagName === 'LI');
      for (const item of items) visit(item);
      return;
    }
    if (!blockTags.has(tag)) {
      for (const child of Array.from(element.children)) visit(child);
      return;
    }
    const raw = unitContent(element, baseUrl);
    if (!raw.trim() && tag !== 'HR') return;
    const startOffset = output.length ? output.join('\n').length + 1 : 0;
    const kind: NormalizedDocumentUnit['kind'] = tag.match(/^H[1-6]$/)
      ? 'heading'
      : tag === 'LI'
        ? 'list_item'
        : tag === 'BLOCKQUOTE'
          ? 'quote'
          : tag === 'PRE'
            ? 'code_block'
            : tag === 'TABLE'
              ? 'table'
              : tag === 'FIGURE'
                ? 'figure'
                : 'paragraph';
    if (tag.match(/^H[1-6]$/)) {
      const level = Number(tag.slice(1));
      headingStack.splice(level - 1);
      headingStack[level - 1] = raw;
      headingStack.length = level;
    }
    const line = tag === 'LI' ? `- ${raw}` : raw;
    output.push(line);
    const endOffset = output.join('\n').length;
    const location: NormalizedLocation = { domPath: domPath(element) };
    units.push({
      id: unitId(options.revisionId, units.length, kind, startOffset),
      materialRevisionId: options.revisionId,
      parentUnitId: null,
      kind,
      index: units.length,
      title: kind === 'heading' ? raw : null,
      content: line,
      startOffset,
      endOffset,
      // HTML permits skipped heading levels; never persist sparse arrays with
      // fabricated/undefined ancestors in the shared normalized contract.
      headingPath: headingStack
        .slice(0, kind === 'heading' ? -1 : undefined)
        .filter((heading): heading is string => Boolean(heading)),
      location,
      contentOrigin: 'extracted_original',
      derivation: 'parser_derived',
    });
  };
  visit(root);
  const content = normalizeText(output.join('\n'));
  const document = makeDocument(
    options,
    content,
    units.map((unit) => ({ ...unit, endOffset: Math.min(unit.endOffset, content.length) })),
    warnings,
  );
  return {
    content,
    title: (readable?.title ?? dom.window.document.title) || null,
    warnings,
    parserVersion: HTML_PARSER_VERSION,
    normalizedDocument: document,
  };
}
