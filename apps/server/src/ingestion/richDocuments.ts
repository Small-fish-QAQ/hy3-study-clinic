import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import {
  ApiErrorCode,
  fnv1a32,
  NormalizedDocumentSchema,
  type EmbeddedAsset,
  type NormalizedDocument,
  type NormalizedDocumentUnit,
  type NormalizedLocation,
} from '@hy3-clinic/shared';
import { IngestionError, normalizeText, sanitizeParsedText } from './ingest.js';
import { openSafeOoxmlPackage, resolveOoxmlTarget, type SafeOoxmlPackage } from './ooxmlPackage.js';

export interface ExtractedEmbeddedAsset extends EmbeddedAsset {
  bytes: Buffer;
}

export interface RichDocumentResult {
  document: NormalizedDocument;
  assets: ExtractedEmbeddedAsset[];
  warnings: string[];
  pageCount: number | null;
  parserVersion: string;
}

const DOCX_PARSER_VERSION = 'docx-ooxml-rich-v1';
const PPTX_PARSER_VERSION = 'pptx-ooxml-rich-v1';
const MAX_EMBEDDED_ASSETS = 2_000;
const MAX_STRUCTURAL_UNITS = 20_000;
const MAX_XML_NODES = 200_000;
const MAX_XML_BYTES = 40 * 1024 * 1024;
const OFFICE_RELATIONSHIP_NAMESPACE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface RichParseContext {
  signal?: AbortSignal;
  xmlNodes: number;
  xmlBytes: number;
}

interface OoxmlContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new IngestionError(ApiErrorCode.RequestCancelled, '文档解析已取消。');
  }
}

function parseXml(bytes: Buffer, label: string, context: RichParseContext): Document {
  throwIfCancelled(context.signal);
  context.xmlBytes += bytes.length;
  if (context.xmlBytes > MAX_XML_BYTES) {
    throw new IngestionError(ApiErrorCode.SourceTooLarge, 'OOXML XML 内容超过总安全上限。');
  }
  const source = bytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) {
    throw new IngestionError(ApiErrorCode.ParseFailed, `${label} 包含不允许的实体或文档类型声明。`);
  }
  const errors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message: string) => errors.push(`warning:${message}`),
      error: (message: string) => errors.push(`error:${message}`),
      fatalError: (message: string) => errors.push(`fatal:${message}`),
    },
  }).parseFromString(source, 'application/xml');
  if (!document.documentElement || errors.length > 0) {
    throw new IngestionError(ApiErrorCode.ParseFailed, `${label} XML 结构损坏。`);
  }
  const stack: Array<{ node: Node; depth: number }> = [
    { node: document.documentElement, depth: 1 },
  ];
  while (stack.length) {
    throwIfCancelled(context.signal);
    const current = stack.pop()!;
    context.xmlNodes += 1;
    if (current.depth > 100 || context.xmlNodes > MAX_XML_NODES) {
      throw new IngestionError(ApiErrorCode.SourceTooLarge, `${label} XML 结构超过安全上限。`);
    }
    for (let child = current.node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  return document;
}

function localName(node: Node): string {
  return ((node as Element).localName || node.nodeName.split(':').pop() || '').toLowerCase();
}

function elements(node: Node, name?: string): Element[] {
  const result: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (!name || localName(child) === name)) result.push(child as Element);
  }
  return result;
}

function descendants(node: Node, name: string): Element[] {
  const result: Element[] = [];
  const visit = (current: Node) => {
    for (let child = current.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (localName(child) === name) result.push(child as Element);
      visit(child);
    }
  };
  visit(node);
  return result;
}

function attr(element: Element, name: string): string | null {
  return (
    element.getAttributeNS(OFFICE_RELATIONSHIP_NAMESPACE, name) ??
    element.getAttribute(`r:${name}`) ??
    element.getAttribute(name) ??
    element.getAttribute(`a:${name}`)
  );
}

function textContent(node: Node): string {
  return descendants(node, 't')
    .map((element) => element.textContent ?? '')
    .join('')
    .replaceAll('\u00a0', ' ')
    .trim();
}

function paragraphSeparatedText(node: Node): string {
  const paragraphs = descendants(node, 'p');
  if (!paragraphs.length) return textContent(node);
  return paragraphs.map(textContent).filter(Boolean).join('\n');
}

/** Reversible table text: cell tabs/newlines/backslashes are escaped. */
function serializeTable(table: Element): string {
  const escapeCell = (value: string) =>
    value.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n');
  return elements(table, 'tr')
    .map((row) => elements(row, 'tc').map(paragraphSeparatedText).map(escapeCell).join('\t'))
    .filter((row) => row.length > 0)
    .join('\n');
}

interface OoxmlRelationship {
  target: string | null;
  type: string;
  external: boolean;
}

function relationshipMap(xml: Document, sourcePath: string): Map<string, OoxmlRelationship> {
  const map = new Map<string, OoxmlRelationship>();
  for (const relationship of descendants(xml, 'relationship')) {
    const id = relationship.getAttribute('Id');
    const target = relationship.getAttribute('Target');
    const mode = relationship.getAttribute('TargetMode');
    const type = relationship.getAttribute('Type') ?? '';
    if (!id || !target) continue;
    if (map.has(id)) {
      throw new IngestionError(ApiErrorCode.ParseFailed, 'OOXML 包含重复的内部关系标识。');
    }
    const external = mode?.trim().toLowerCase() === 'external';
    map.set(id, {
      target: external ? null : resolveOoxmlTarget(sourcePath, target),
      type,
      external,
    });
  }
  return map;
}

async function readContentTypes(
  packageFile: SafeOoxmlPackage,
  context: RichParseContext,
): Promise<OoxmlContentTypes> {
  const xml = parseXml(
    await packageFile.read('[Content_Types].xml'),
    'OOXML content types',
    context,
  );
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const node of descendants(xml, 'default')) {
    const extension = node.getAttribute('Extension')?.trim().toLowerCase();
    const contentType = node.getAttribute('ContentType')?.trim().toLowerCase();
    if (extension && contentType && contentType.length <= 200) defaults.set(extension, contentType);
  }
  for (const node of descendants(xml, 'override')) {
    const partName = node.getAttribute('PartName')?.trim().replace(/^\/+/, '');
    const contentType = node.getAttribute('ContentType')?.trim().toLowerCase();
    if (partName && contentType && contentType.length <= 200) overrides.set(partName, contentType);
  }
  return { defaults, overrides };
}

function declaredMediaType(path: string, contentTypes: OoxmlContentTypes): string | null {
  const override = contentTypes.overrides.get(path);
  if (override) return override;
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return contentTypes.defaults.get(extension) ?? null;
}

function sniffMediaType(bytes: Buffer, declared: string | null): string | null {
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (bytes.length >= 6 && /^(?:GIF87a|GIF89a)$/u.test(bytes.toString('ascii', 0, 6)))
    return 'image/gif';
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (
    bytes.length >= 4 &&
    (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
      bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  )
    return 'image/tiff';
  if (bytes.length >= 44 && bytes.readUInt32LE(0) === 1 && bytes.readUInt32LE(40) === 0x464d4520)
    return 'image/emf';
  if (
    bytes.length >= 4 &&
    (bytes.readUInt32LE(0) === 0x9ac6cdd7 ||
      (bytes.readUInt16LE(0) <= 2 && bytes.readUInt16LE(2) === 9))
  )
    return 'image/wmf';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WAVE'
  )
    return 'audio/wav';
  if (
    bytes.length >= 3 &&
    (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))
  )
    return 'audio/mpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (declared === 'image/svg+xml') {
    const prefix = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('utf8');
    if (!/<!DOCTYPE|<!ENTITY/iu.test(prefix) && /<(?:[A-Za-z0-9_-]+:)?svg(?:\s|>)/iu.test(prefix)) {
      return 'image/svg+xml';
    }
  }
  return null;
}

function mediaTypeForAsset(
  path: string,
  bytes: Buffer,
  contentTypes: OoxmlContentTypes,
  warnings: string[],
): string {
  const declared = declaredMediaType(path, contentTypes);
  const sniffed = sniffMediaType(bytes, declared);
  if (!sniffed) {
    warnings.push(`嵌入媒体类型无法由内容验证:${path}`);
    return 'application/octet-stream';
  }
  if (declared && declared !== sniffed && !(declared === 'image/jpg' && sniffed === 'image/jpeg')) {
    warnings.push(`嵌入媒体声明类型与内容不一致:${path}`);
  }
  return sniffed;
}

function dimensions(
  bytes: Buffer,
  mediaType: string,
): { width: number | null; height: number | null } {
  try {
    if (mediaType === 'image/png' && bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      return width > 0 && height > 0 ? { width, height } : { width: null, height: null };
    }
    if (
      mediaType === 'image/gif' &&
      bytes.length >= 10 &&
      bytes.toString('ascii', 0, 3) === 'GIF'
    ) {
      const width = bytes.readUInt16LE(6);
      const height = bytes.readUInt16LE(8);
      return width > 0 && height > 0 ? { width, height } : { width: null, height: null };
    }
    if (mediaType === 'image/jpeg' && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1]!;
        const length = bytes.readUInt16BE(offset + 2);
        if (length < 2 || offset + length + 2 > bytes.length) break;
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const width = bytes.readUInt16BE(offset + 7);
          const height = bytes.readUInt16BE(offset + 5);
          return width > 0 && height > 0 ? { width, height } : { width: null, height: null };
        }
        offset += length + 2;
      }
    }
  } catch {
    /* malformed media keeps honest null dimensions */
  }
  return { width: null, height: null };
}

function assetFor(
  materialId: string,
  revisionId: string,
  index: number,
  sourcePath: string,
  bytes: Buffer,
  parentStructuralUnitId: string | null,
  location: NormalizedLocation,
  parserVersion: string,
  mediaType: string,
  relationshipKind: EmbeddedAsset['relationshipKind'] = 'image',
): ExtractedEmbeddedAsset {
  const byteHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const size = dimensions(bytes, mediaType);
  return {
    id: `asset_${fnv1a32(`${revisionId}:${index}:${sourcePath}:${byteHash}`).toString(16).padStart(8, '0')}`,
    materialId,
    materialRevisionId: revisionId,
    index,
    parentStructuralUnitId,
    sourcePath,
    mediaType,
    byteHash,
    byteLength: bytes.length,
    width: size.width,
    height: size.height,
    location: {
      ...(location.pageNumber ? { pageNumber: location.pageNumber } : {}),
      ...(location.slideNumber ? { slideNumber: location.slideNumber } : {}),
      domPath: location.domPath ?? sourcePath,
    },
    relationshipKind,
    contentOrigin: 'extracted_original',
    parserVersion,
    bytes,
  };
}

function makeDocument(
  revisionId: string,
  sourceType: 'docx' | 'pptx',
  mediaType: string,
  content: string,
  units: NormalizedDocumentUnit[],
  assets: ExtractedEmbeddedAsset[],
  warnings: string[],
  parserVersion: string,
  capabilities: string[],
): NormalizedDocument {
  const parsedAssets = assets.map(({ bytes: _bytes, ...asset }) => asset);
  return NormalizedDocumentSchema.parse({
    materialRevisionId: revisionId,
    sourceType,
    mediaType,
    content,
    units,
    assets: parsedAssets,
    capabilities,
    warnings: warnings.slice(0, 50),
    complete: warnings.length === 0,
    parserVersion,
    parserFingerprint: `parser_${fnv1a32(`${sourceType}:${parserVersion}`).toString(16).padStart(8, '0')}`,
  });
}

class UnitBuilder {
  readonly units: NormalizedDocumentUnit[] = [];
  private readonly pieces: string[] = [];
  private offset = 0;

  constructor(private readonly revisionId: string) {}

  begin(
    kind: NormalizedDocumentUnit['kind'],
    title: string | null,
    parentUnitId: string | null,
    location: NormalizedLocation,
    headingPath: string[] = [],
  ): NormalizedDocumentUnit {
    if (this.units.length >= MAX_STRUCTURAL_UNITS) {
      throw new IngestionError(ApiErrorCode.SourceTooLarge, '文档结构单元超过安全上限。');
    }
    const startOffset = this.offset + (this.pieces.length ? 2 : 0);
    const unit: NormalizedDocumentUnit = {
      id: `unit_${fnv1a32(`${this.revisionId}:${this.units.length}:${kind}:${startOffset}`).toString(16).padStart(8, '0')}`,
      materialRevisionId: this.revisionId,
      parentUnitId,
      kind,
      index: this.units.length,
      title,
      content: '',
      startOffset,
      endOffset: startOffset,
      headingPath,
      location,
      contentOrigin: 'extracted_original',
      derivation: 'parser_derived',
    };
    this.units.push(unit);
    return unit;
  }

  finish(unit: NormalizedDocumentUnit, preserveEmpty = false): boolean {
    unit.endOffset = this.offset;
    unit.content = this.content.slice(unit.startOffset, unit.endOffset);
    if (!unit.content && !preserveEmpty) {
      if (this.units[this.units.length - 1] === unit) this.units.pop();
      return false;
    }
    return true;
  }

  add(
    kind: NormalizedDocumentUnit['kind'],
    title: string | null,
    value: string,
    parentUnitId: string | null,
    location: NormalizedLocation,
    headingPath: string[] = [],
  ): NormalizedDocumentUnit | null {
    const content = sanitizeParsedText(normalizeText(value));
    if (!content.trim()) return null;
    if (this.units.length >= MAX_STRUCTURAL_UNITS) {
      throw new IngestionError(ApiErrorCode.SourceTooLarge, '文档结构单元超过安全上限。');
    }
    const separator = this.pieces.length ? '\n\n' : '';
    this.pieces.push(`${separator}${content}`);
    const startOffset = this.offset + separator.length;
    this.offset += separator.length + content.length;
    const unit: NormalizedDocumentUnit = {
      id: `unit_${fnv1a32(`${this.revisionId}:${this.units.length}:${kind}:${startOffset}`).toString(16).padStart(8, '0')}`,
      materialRevisionId: this.revisionId,
      parentUnitId,
      kind,
      index: this.units.length,
      title,
      content,
      startOffset,
      endOffset: this.offset,
      headingPath,
      location,
      contentOrigin: 'extracted_original',
      derivation: 'parser_derived',
    };
    this.units.push(unit);
    return unit;
  }

  get content(): string {
    return this.pieces.join('');
  }
}

function imageRelationshipIds(node: Node): string[] {
  const ids: string[] = [];
  for (const element of descendants(node, 'blip')) {
    const id = element.getAttribute('r:embed') ?? element.getAttribute('embed');
    if (id) ids.push(id);
  }
  for (const element of descendants(node, 'imagedata')) {
    const id = element.getAttribute('r:id');
    if (id) ids.push(id);
  }
  return ids;
}

function appendUniqueAssets(
  target: ExtractedEmbeddedAsset[],
  incoming: ExtractedEmbeddedAsset[],
): void {
  const known = new Set(target.map((asset) => asset.id));
  for (const asset of incoming) {
    if (!known.has(asset.id)) {
      target.push(asset);
      known.add(asset.id);
    }
  }
}

async function extractAssets(
  packageFile: SafeOoxmlPackage,
  contentTypes: OoxmlContentTypes,
  relationshipIds: string[],
  relationships: Map<string, OoxmlRelationship>,
  materialId: string,
  revisionId: string,
  parentStructuralUnitId: string | null,
  location: NormalizedLocation,
  parserVersion: string,
  index: number,
  warnings: string[],
  signal?: AbortSignal,
): Promise<{ assets: ExtractedEmbeddedAsset[]; nextIndex: number }> {
  const assets: ExtractedEmbeddedAsset[] = [];
  let nextIndex = index;
  for (const relationshipId of relationshipIds) {
    throwIfCancelled(signal);
    if (nextIndex >= MAX_EMBEDDED_ASSETS) {
      if (!warnings.includes('嵌入媒体数量超过安全上限,其余媒体已忽略。')) {
        warnings.push('嵌入媒体数量超过安全上限,其余媒体已忽略。');
      }
      break;
    }
    const relationship = relationships.get(relationshipId);
    const target = relationship?.target;
    if (!relationship || !target) {
      warnings.push(
        location.slideNumber
          ? `第 ${location.slideNumber} 张幻灯片忽略了外部或缺失的媒体关系。`
          : 'DOCX 忽略了外部或缺失的媒体关系。',
      );
      continue;
    }
    if (!/(?:\/image|\/audio|\/video|\/media)$/u.test(relationship.type)) {
      warnings.push('忽略了类型无效的内部媒体关系。');
      continue;
    }
    if (!target.startsWith('word/media/') && !target.startsWith('ppt/media/')) {
      warnings.push(`未支持的嵌入对象:${target}`);
      continue;
    }
    try {
      const bytes = await packageFile.read(target);
      if (bytes.length === 0) {
        warnings.push(`嵌入媒体为空:${target}`);
        continue;
      }
      const mediaType = mediaTypeForAsset(target, bytes, contentTypes, warnings);
      assets.push(
        assetFor(
          materialId,
          revisionId,
          nextIndex++,
          target,
          bytes,
          parentStructuralUnitId,
          location,
          parserVersion,
          mediaType,
          relationship.type.endsWith('/image') ? 'image' : 'media',
        ),
      );
    } catch {
      warnings.push(`嵌入媒体读取失败:${target}`);
    }
  }
  return { assets, nextIndex };
}

function pptParagraphs(shape: Element): Array<{ text: string; list: boolean }> {
  return descendants(shape, 'p')
    .map((paragraph) => ({
      text: textContent(paragraph),
      list: descendants(paragraph, 'ppr').some(
        (ppr) =>
          descendants(ppr, 'buchar').length > 0 ||
          descendants(ppr, 'buautonum').length > 0 ||
          Boolean(ppr.getAttribute('lvl')),
      ),
    }))
    .filter((paragraph) => paragraph.text.length > 0);
}

function orderedSlideShapes(shapeTree: Element): Element[] {
  const ordered: Element[] = [];
  const visit = (parent: Element) => {
    for (const child of elements(parent)) {
      const kind = localName(child);
      if (kind === 'grpsp') {
        if (!shapeIsHidden(child)) visit(child);
      } else if (kind !== 'nvgrpsppr' && kind !== 'grpsppr') ordered.push(child);
    }
  };
  visit(shapeTree);
  return ordered;
}

function shapeIsHidden(shape: Element): boolean {
  const properties = descendants(shape, 'cnvpr')[0];
  const value = properties?.getAttribute('hidden')?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

async function parsePptxXml(
  packageFile: SafeOoxmlPackage,
  materialId: string,
  revisionId: string,
  contentTypes: OoxmlContentTypes,
  context: RichParseContext,
): Promise<RichDocumentResult> {
  const warnings: string[] = [];
  if (!packageFile.has('ppt/presentation.xml'))
    throw new IngestionError(ApiErrorCode.ParseFailed, 'PPTX 缺少 presentation.xml。');
  const presentation = parseXml(
    await packageFile.read('ppt/presentation.xml'),
    'PPTX presentation',
    context,
  );
  const presentationRels = packageFile.has('ppt/_rels/presentation.xml.rels')
    ? relationshipMap(
        parseXml(
          await packageFile.read('ppt/_rels/presentation.xml.rels'),
          'PPTX presentation relationships',
          context,
        ),
        'ppt/presentation.xml',
      )
    : new Map<string, OoxmlRelationship>();
  const slideIds = descendants(presentation, 'sldid');
  const builder = new UnitBuilder(revisionId);
  const assets: ExtractedEmbeddedAsset[] = [];
  let assetIndex = 0;
  for (let slideNumber = 1; slideNumber <= slideIds.length; slideNumber += 1) {
    const relationId = attr(slideIds[slideNumber - 1]!, 'id');
    const slideRelationship = relationId ? presentationRels.get(relationId) : null;
    const slidePath = slideRelationship?.target;
    if (
      !slidePath ||
      !slideRelationship.type.endsWith('/slide') ||
      !slidePath.startsWith('ppt/slides/') ||
      !packageFile.has(slidePath)
    ) {
      warnings.push(`第 ${slideNumber} 张幻灯片关系缺失或无效。`);
      continue;
    }
    throwIfCancelled(context.signal);
    const slide = parseXml(await packageFile.read(slidePath), `PPTX slide ${slideNumber}`, context);
    const slideRelsPath = `ppt/slides/_rels/${slidePath.split('/').pop()}.rels`;
    const relationships = packageFile.has(slideRelsPath)
      ? relationshipMap(
          parseXml(
            await packageFile.read(slideRelsPath),
            `PPTX slide ${slideNumber} relationships`,
            context,
          ),
          slidePath,
        )
      : new Map<string, OoxmlRelationship>();
    const slideText = descendants(slide, 't')
      .map((node) => node.textContent ?? '')
      .join(' ')
      .trim();
    const slideUnit = slideText
      ? builder.begin('slide', `Slide ${slideNumber}`, null, { slideNumber })
      : null;
    const slideId = slideUnit?.id ?? null;
    if (!slideText) warnings.push(`第 ${slideNumber} 张幻灯片没有可提取的文本。`);
    const shapeTree = descendants(slide, 'sptree')[0];
    for (const shape of shapeTree ? orderedSlideShapes(shapeTree) : []) {
      if (shapeIsHidden(shape)) continue;
      const kind = localName(shape);
      if (kind === 'sp') {
        const paragraphs = pptParagraphs(shape);
        const shapeUnit = paragraphs.length
          ? builder.begin('text_box', null, slideId, { slideNumber })
          : null;
        for (let paragraphIndex = 0; paragraphIndex < paragraphs.length;) {
          const paragraph = paragraphs[paragraphIndex]!;
          if (!paragraph.list) {
            builder.add('paragraph', null, paragraph.text, shapeUnit?.id ?? slideId, {
              slideNumber,
            });
            paragraphIndex += 1;
            continue;
          }
          const listUnit = builder.begin('list', null, shapeUnit?.id ?? slideId, { slideNumber });
          while (paragraphIndex < paragraphs.length && paragraphs[paragraphIndex]!.list) {
            builder.add('list_item', null, paragraphs[paragraphIndex]!.text, listUnit.id, {
              slideNumber,
            });
            paragraphIndex += 1;
          }
          builder.finish(listUnit);
        }
        if (shapeUnit) builder.finish(shapeUnit);
        const relationshipsResult = await extractAssets(
          packageFile,
          contentTypes,
          imageRelationshipIds(shape),
          relationships,
          materialId,
          revisionId,
          shapeUnit?.id ?? slideId,
          { slideNumber },
          PPTX_PARSER_VERSION,
          assetIndex,
          warnings,
          context.signal,
        );
        appendUniqueAssets(assets, relationshipsResult.assets);
        assetIndex = relationshipsResult.nextIndex;
      } else if (kind === 'graphicframe') {
        const table = descendants(shape, 'tbl')[0];
        if (table) {
          const value = serializeTable(table);
          if (value) builder.add('table', null, value, slideId, { slideNumber });
        } else if (descendants(shape, 'chart').length || descendants(shape, 'dgm').length) {
          warnings.push(`第 ${slideNumber} 张幻灯片包含未解释的图表或 SmartArt。`);
        } else {
          warnings.push(`第 ${slideNumber} 张幻灯片包含未支持的图形框对象。`);
        }
      } else if (kind === 'pic') {
        const relationshipsResult = await extractAssets(
          packageFile,
          contentTypes,
          imageRelationshipIds(shape),
          relationships,
          materialId,
          revisionId,
          slideId,
          { slideNumber },
          PPTX_PARSER_VERSION,
          assetIndex,
          warnings,
          context.signal,
        );
        appendUniqueAssets(assets, relationshipsResult.assets);
        assetIndex = relationshipsResult.nextIndex;
      } else {
        warnings.push(`第 ${slideNumber} 张幻灯片包含未支持的对象:${kind}`);
      }
    }
    const slideUnitKept = slideUnit ? builder.finish(slideUnit) : false;
    if (slideUnit && !slideUnitKept) {
      for (const asset of assets) {
        if (asset.parentStructuralUnitId === slideUnit.id) asset.parentStructuralUnitId = null;
      }
      warnings.push(`第 ${slideNumber} 张幻灯片仅包含未支持的文本对象。`);
    }
    const notesRelationship = [...relationships.values()].find(
      (relationship) =>
        relationship.type.endsWith('/notesSlide') && relationship.target?.includes('/notesSlides/'),
    );
    if (notesRelationship?.target && packageFile.has(notesRelationship.target)) {
      const notes = parseXml(
        await packageFile.read(notesRelationship.target),
        `PPTX notes ${slideNumber}`,
        context,
      );
      const noteText = descendants(notes, 'sp')
        .filter((shape) => {
          const placeholder = descendants(shape, 'ph')[0];
          const type = placeholder?.getAttribute('type') ?? placeholder?.getAttribute('p:type');
          return !type || type === 'body';
        })
        .flatMap((shape) => pptParagraphs(shape).map((paragraph) => paragraph.text))
        .join('\n')
        .trim();
      if (noteText)
        builder.add('speaker_notes', 'Speaker notes', noteText, slideUnitKept ? slideId : null, {
          slideNumber,
        });
    } else if (notesRelationship) {
      warnings.push(`第 ${slideNumber} 张幻灯片的演讲者备注关系缺失或无效。`);
    }
  }
  warnings.unshift('幻灯片文本按稳定的 OOXML 绘制层级顺序提取;空间语义阅读顺序可能不完整。');
  if (!builder.content.trim() && assets.length === 0)
    throw new IngestionError(ApiErrorCode.ParseFailed, 'PPTX 中没有可提取的文本或原始媒体。');
  const document = makeDocument(
    revisionId,
    'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    builder.content,
    builder.units,
    assets,
    warnings,
    PPTX_PARSER_VERSION,
    [
      'text_extraction',
      'structural_hierarchy',
      'slide_awareness',
      'embedded_assets',
      'table_structure',
      'visual_asset',
      'deterministic_text',
      'source_location_precision',
    ],
  );
  return {
    document,
    assets,
    warnings: document.warnings,
    pageCount: null,
    parserVersion: PPTX_PARSER_VERSION,
  };
}

function docxParagraphText(paragraph: Element): string {
  return descendants(paragraph, 't')
    .map((text) => text.textContent ?? '')
    .join('')
    .replaceAll('\u00a0', ' ')
    .trim();
}

function docxStyle(paragraph: Element): string | null {
  const style = descendants(paragraph, 'pstyle')[0];
  return style?.getAttribute('w:val') ?? style?.getAttribute('val') ?? null;
}

function docxList(paragraph: Element): boolean {
  return descendants(paragraph, 'numpr').length > 0;
}

async function parseDocxXml(
  packageFile: SafeOoxmlPackage,
  materialId: string,
  revisionId: string,
  contentTypes: OoxmlContentTypes,
  context: RichParseContext,
): Promise<RichDocumentResult> {
  const warnings: string[] = [];
  if (!packageFile.has('word/document.xml'))
    throw new IngestionError(ApiErrorCode.ParseFailed, 'DOCX 缺少 word/document.xml。');
  const documentXml = parseXml(
    await packageFile.read('word/document.xml'),
    'DOCX document',
    context,
  );
  const relsPath = 'word/_rels/document.xml.rels';
  const relationships = packageFile.has(relsPath)
    ? relationshipMap(
        parseXml(await packageFile.read(relsPath), 'DOCX relationships', context),
        'word/document.xml',
      )
    : new Map<string, OoxmlRelationship>();
  const builder = new UnitBuilder(revisionId);
  const assets: ExtractedEmbeddedAsset[] = [];
  let assetIndex = 0;
  const body = descendants(documentXml, 'body')[0];
  if (!body) throw new IngestionError(ApiErrorCode.ParseFailed, 'DOCX 缺少文档正文。');
  const blocks = elements(body);
  const headingStack: Array<{ level: number; text: string; unitId: string }> = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!;
    const kind = localName(block);
    if (kind === 'p') {
      const text = docxParagraphText(block);
      if (descendants(block, 'omath').length > 0 || descendants(block, 'omathpara').length > 0) {
        warnings.push('DOCX 包含未解释的公式对象。');
      }
      if (descendants(block, 'drawing').length > 0 && imageRelationshipIds(block).length === 0) {
        warnings.push('DOCX 包含未支持的绘图对象。');
      }
      if (descendants(block, 'object').length > 0 || descendants(block, 'oleobject').length > 0) {
        warnings.push('DOCX 包含未支持的嵌入对象。');
      }
      if (!text) {
        const relationshipIds = imageRelationshipIds(block);
        if (relationshipIds.length) {
          const relationshipsResult = await extractAssets(
            packageFile,
            contentTypes,
            relationshipIds,
            relationships,
            materialId,
            revisionId,
            null,
            {},
            DOCX_PARSER_VERSION,
            assetIndex,
            warnings,
            context.signal,
          );
          appendUniqueAssets(assets, relationshipsResult.assets);
          assetIndex = relationshipsResult.nextIndex;
          warnings.push('DOCX 包含无文本图像段落;原始图像已保留。');
        }
        continue;
      }
      const style = docxStyle(block);
      const headingMatch = style?.match(/heading\s*([1-6])/iu);
      if (headingMatch) {
        const level = Number(headingMatch[1]);
        while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level)
          headingStack.pop();
        const unit = builder.add(
          'heading',
          text,
          text,
          headingStack[headingStack.length - 1]?.unitId ?? null,
          {},
          headingStack.map((heading) => heading.text),
        );
        if (!unit) continue;
        headingStack.push({ level, text, unitId: unit.id });
        const relationshipsResult = await extractAssets(
          packageFile,
          contentTypes,
          imageRelationshipIds(block),
          relationships,
          materialId,
          revisionId,
          unit?.id ?? null,
          {},
          DOCX_PARSER_VERSION,
          assetIndex,
          warnings,
          context.signal,
        );
        appendUniqueAssets(assets, relationshipsResult.assets);
        assetIndex = relationshipsResult.nextIndex;
        continue;
      }
      const headingPath = headingStack.map((heading) => heading.text);
      if (docxList(block)) {
        const listUnit = builder.begin(
          'list',
          null,
          headingStack[headingStack.length - 1]?.unitId ?? null,
          {},
          headingPath,
        );
        while (
          blockIndex < blocks.length &&
          localName(blocks[blockIndex]!) === 'p' &&
          docxList(blocks[blockIndex]!)
        ) {
          const itemBlock = blocks[blockIndex]!;
          const itemText = docxParagraphText(itemBlock);
          const item = itemText
            ? builder.add('list_item', null, itemText, listUnit.id, {}, headingPath)
            : null;
          const relationshipsResult = await extractAssets(
            packageFile,
            contentTypes,
            imageRelationshipIds(itemBlock),
            relationships,
            materialId,
            revisionId,
            item?.id ?? listUnit.id,
            {},
            DOCX_PARSER_VERSION,
            assetIndex,
            warnings,
            context.signal,
          );
          appendUniqueAssets(assets, relationshipsResult.assets);
          assetIndex = relationshipsResult.nextIndex;
          blockIndex += 1;
        }
        blockIndex -= 1;
        builder.finish(listUnit);
        continue;
      }
      const unit = builder.add(
        'paragraph',
        null,
        text,
        headingStack[headingStack.length - 1]?.unitId ?? null,
        {},
        headingPath,
      );
      const relationshipsResult = await extractAssets(
        packageFile,
        contentTypes,
        imageRelationshipIds(block),
        relationships,
        materialId,
        revisionId,
        unit?.id ?? null,
        {},
        DOCX_PARSER_VERSION,
        assetIndex,
        warnings,
        context.signal,
      );
      appendUniqueAssets(assets, relationshipsResult.assets);
      assetIndex = relationshipsResult.nextIndex;
    } else if (kind === 'tbl') {
      const headingPath = headingStack.map((heading) => heading.text);
      const tableValue = serializeTable(block);
      const tableUnit = tableValue
        ? builder.add(
            'table',
            null,
            tableValue,
            headingStack[headingStack.length - 1]?.unitId ?? null,
            {},
            headingPath,
          )
        : null;
      const relationshipsResult = await extractAssets(
        packageFile,
        contentTypes,
        imageRelationshipIds(block),
        relationships,
        materialId,
        revisionId,
        tableUnit?.id ?? null,
        {},
        DOCX_PARSER_VERSION,
        assetIndex,
        warnings,
        context.signal,
      );
      appendUniqueAssets(assets, relationshipsResult.assets);
      assetIndex = relationshipsResult.nextIndex;
    } else if (kind === 'sectpr') {
      continue;
    } else {
      warnings.push(`DOCX 包含未支持的正文对象:${kind}`);
    }
  }
  // Only relationship-backed headers and footers are source content; orphan
  // package parts must never become learner authority.
  const headerFooterPaths: string[] = [];
  for (const reference of [
    ...descendants(body, 'headerreference'),
    ...descendants(body, 'footerreference'),
  ]) {
    const relationshipId = attr(reference, 'id');
    const relationship = relationshipId ? relationships.get(relationshipId) : null;
    const path = relationship?.target;
    const expectedKind = localName(reference) === 'headerreference' ? 'header' : 'footer';
    if (
      !relationship ||
      !path ||
      !relationship.type.endsWith(`/${expectedKind}`) ||
      !new RegExp(`^word/${expectedKind}[^/]*\\.xml$`, 'u').test(path) ||
      !packageFile.has(path)
    ) {
      warnings.push(`DOCX ${expectedKind} 关系缺失或无效。`);
      continue;
    }
    if (!headerFooterPaths.includes(path)) headerFooterPaths.push(path);
  }
  for (const path of headerFooterPaths) {
    const header = parseXml(await packageFile.read(path), `DOCX ${path}`, context);
    const value = descendants(header, 't')
      .map((node) => node.textContent ?? '')
      .join(' ')
      .trim();
    if (value) builder.add('section', path, value, null, { domPath: path });
  }
  if (
    descendants(body, 'footnotereference').length > 0 ||
    descendants(body, 'endnotereference').length > 0
  ) {
    warnings.push('DOCX 脚注或尾注尚未提取,正文仍可使用。');
  }
  if (!builder.content.trim() && assets.length === 0)
    throw new IngestionError(ApiErrorCode.ParseFailed, 'DOCX 中没有可提取的文本或原始媒体。');
  const document = makeDocument(
    revisionId,
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    builder.content,
    builder.units,
    assets,
    warnings,
    DOCX_PARSER_VERSION,
    [
      'text_extraction',
      'structural_hierarchy',
      'embedded_assets',
      'table_structure',
      'visual_asset',
      'deterministic_text',
      'source_location_precision',
    ],
  );
  return {
    document,
    assets,
    warnings: document.warnings,
    pageCount: null,
    parserVersion: DOCX_PARSER_VERSION,
  };
}

export async function parseRichOoxml(
  sourceType: 'docx' | 'pptx',
  buffer: Buffer,
  materialId: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<RichDocumentResult> {
  throwIfCancelled(signal);
  const packageFile = await openSafeOoxmlPackage(buffer);
  throwIfCancelled(signal);
  const context: RichParseContext = { signal, xmlNodes: 0, xmlBytes: 0 };
  if (!packageFile.has('[Content_Types].xml')) {
    throw new IngestionError(ApiErrorCode.ParseFailed, 'OOXML 缺少 [Content_Types].xml。');
  }
  const hasDocxRoot = packageFile.has('word/document.xml');
  const hasPptxRoot = packageFile.has('ppt/presentation.xml');
  if (hasDocxRoot && hasPptxRoot) {
    throw new IngestionError(ApiErrorCode.ParseFailed, 'OOXML 包同时包含 DOCX 与 PPTX 根文档。');
  }
  if ((sourceType === 'docx' && hasPptxRoot) || (sourceType === 'pptx' && hasDocxRoot)) {
    throw new IngestionError(ApiErrorCode.TypeMismatch, 'OOXML 文件类型与扩展名不匹配。');
  }
  const contentTypes = await readContentTypes(packageFile, context);
  return sourceType === 'pptx'
    ? parsePptxXml(packageFile, materialId, revisionId, contentTypes, context)
    : parseDocxXml(packageFile, materialId, revisionId, contentTypes, context);
}
