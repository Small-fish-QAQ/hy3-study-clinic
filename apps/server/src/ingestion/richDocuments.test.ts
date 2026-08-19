import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { normalizedDocumentToSourceBlocks } from './normalized.js';
import { parseRichOoxml } from './richDocuments.js';

interface ZipEntryInput {
  path: string;
  content: string | Buffer;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Build a tiny deterministic stored ZIP without filesystem or Office tooling. */
function storedZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const content = Buffer.isBuffer(entry.content)
      ? Buffer.from(entry.content)
      : Buffer.from(entry.content, 'utf8');
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, content);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function pngHeader(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    typeBytes.copy(header, 4);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([header, data, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`;

const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function pptxFixture(image: Buffer): Buffer {
  return storedZip([
    { path: '[Content_Types].xml', content: CONTENT_TYPES },
    {
      path: 'ppt/presentation.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_REL_NS}">
  <p:sldIdLst><p:sldId id="257" r:id="rIdSecond"/><p:sldId id="256" r:id="rIdFirst"/></p:sldIdLst>
</p:presentation>`,
    },
    {
      path: 'ppt/_rels/presentation.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${RELATIONSHIPS_NS}">
  <Relationship Id="rIdFirst" Type="${OFFICE_REL_NS}/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rIdSecond" Type="${OFFICE_REL_NS}/slide" Target="slides/slide2.xml"/>
</Relationships>`,
    },
    {
      path: 'ppt/slides/slide2.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL_NS}">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>Relationship-order first</a:t></a:r></a:p>
      <a:p><a:pPr><a:buChar char="-"/></a:pPr><a:r><a:t>Bullet one</a:t></a:r></a:p>
      <a:p><a:pPr><a:buChar char="-"/></a:pPr><a:r><a:t>Bullet two</a:t></a:r></a:p>
    </p:txBody></p:sp>
    <p:grpSp><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:txBody>
      <a:p><a:r><a:t>Grouped shape text</a:t></a:r></a:p>
    </p:txBody></p:sp></p:grpSp>
    <p:grpSp><p:nvGrpSpPr><p:cNvPr hidden="1"/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:txBody>
      <a:p><a:r><a:t>Hidden group text</a:t></a:r></a:p>
    </p:txBody></p:sp></p:grpSp>
    <p:sp><p:nvSpPr><p:cNvPr hidden="1"/></p:nvSpPr><p:txBody>
      <a:p><a:r><a:t>Hidden shape text</a:t></a:r></a:p>
    </p:txBody></p:sp>
    <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
      <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Term | label</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Meaning</a:t></a:r></a:p><a:p><a:r><a:t>continued</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
      <a:tr><a:tc><a:txBody><a:p><a:r><a:t>ATP</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Energy</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
    </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
    <p:pic><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic>
    <p:pic><p:blipFill><a:blip r:embed="rIdMissing"/></p:blipFill></p:pic>
  </p:spTree></p:cSld>
</p:sld>`,
    },
    {
      path: 'ppt/slides/_rels/slide2.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${RELATIONSHIPS_NS}">
  <Relationship Id="rIdImage" Type="${OFFICE_REL_NS}/image" Target="../media/image1.png"/>
  <Relationship Id="rIdNotes" Type="${OFFICE_REL_NS}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`,
    },
    {
      path: 'ppt/notesSlides/notesSlide1.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Instructor note</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`,
    },
    {
      path: 'ppt/slides/slide1.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Filename-order first</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
    },
    { path: 'ppt/media/image1.png', content: image },
  ]);
}

function docxFixture(image: Buffer): Buffer {
  return storedZip([
    { path: '[Content_Types].xml', content: CONTENT_TYPES },
    {
      path: 'word/document.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL_NS}">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Cell Biology</w:t></w:r></w:p>
    <w:p><w:r><w:t>Cells preserve hereditary information.</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nucleus</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Mitochondrion</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Organelle</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Ribosome</w:t></w:r><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Translation</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>Cell diagram</w:t></w:r><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>External image reference</w:t></w:r><w:r><w:drawing><a:blip r:embed="rIdExternal"/></w:drawing></w:r></w:p>
    <w:sectPr><w:headerReference r:id="rIdHeader"/></w:sectPr>
  </w:body>
</w:document>`,
    },
    {
      path: 'word/_rels/document.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${RELATIONSHIPS_NS}">
  <Relationship Id="rIdImage" Type="${OFFICE_REL_NS}/image" Target="media/image1.png"/>
  <Relationship Id="rIdExternal" Type="${OFFICE_REL_NS}/image" Target="https://example.invalid/image.png" TargetMode="External"/>
  <Relationship Id="rIdHeader" Type="${OFFICE_REL_NS}/header" Target="header1.xml"/>
</Relationships>`,
    },
    {
      path: 'word/header1.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Referenced header</w:t></w:r></w:p></w:hdr>`,
    },
    {
      path: 'word/header99.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Orphan header</w:t></w:r></w:p></w:hdr>`,
    },
    { path: 'word/media/image1.png', content: image },
  ]);
}

function imageOnlyPptxFixture(image: Buffer): Buffer {
  return storedZip([
    { path: '[Content_Types].xml', content: CONTENT_TYPES },
    {
      path: 'ppt/presentation.xml',
      content: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_REL_NS}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    },
    {
      path: 'ppt/_rels/presentation.xml.rels',
      content: `<Relationships xmlns="${RELATIONSHIPS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL_NS}/slide" Target="slides/slide1.xml"/></Relationships>`,
    },
    {
      path: 'ppt/slides/slide1.xml',
      content: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL_NS}"><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
    },
    {
      path: 'ppt/slides/_rels/slide1.xml.rels',
      content: `<Relationships xmlns="${RELATIONSHIPS_NS}"><Relationship Id="rIdImage" Type="${OFFICE_REL_NS}/image" Target="../media/image1.png"/></Relationships>`,
    },
    { path: 'ppt/media/image1.png', content: image },
  ]);
}

function imageOnlyDocxFixture(image: Buffer): Buffer {
  return storedZip([
    { path: '[Content_Types].xml', content: CONTENT_TYPES },
    {
      path: 'word/document.xml',
      content: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL_NS}"><w:body><w:p><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p><w:sectPr/></w:body></w:document>`,
    },
    {
      path: 'word/_rels/document.xml.rels',
      content: `<Relationships xmlns="${RELATIONSHIPS_NS}"><Relationship Id="rIdImage" Type="${OFFICE_REL_NS}/image" Target="media/image1.png"/></Relationships>`,
    },
    { path: 'word/media/image1.png', content: image },
  ]);
}

describe('rich OOXML extraction', () => {
  it('uses presentation relationship order and preserves PPTX structure, notes, assets, and chunks', async () => {
    const image = pngHeader(2, 3);
    const bytes = pptxFixture(image);

    const first = await parseRichOoxml('pptx', bytes, 'material-pptx', 'revision-pptx');
    const second = await parseRichOoxml('pptx', bytes, 'material-pptx', 'revision-pptx');

    expect(second).toEqual(first);
    expect(first.pageCount).toBeNull();
    expect(first.parserVersion).toBe('pptx-ooxml-rich-v1');
    expect(first.document.content.indexOf('Relationship-order first')).toBeLessThan(
      first.document.content.indexOf('Filename-order first'),
    );
    expect(first.document.units.map((unit) => unit.kind)).toEqual([
      'slide',
      'text_box',
      'paragraph',
      'list',
      'list_item',
      'list_item',
      'text_box',
      'paragraph',
      'table',
      'speaker_notes',
      'slide',
      'text_box',
      'paragraph',
    ]);
    const notes = first.document.units.find((unit) => unit.kind === 'speaker_notes');
    const table = first.document.units.find((unit) => unit.kind === 'table');
    expect(notes).toMatchObject({ content: 'Instructor note', location: { slideNumber: 1 } });
    expect(table).toMatchObject({
      content: 'Term | label\tMeaning\\ncontinued\nATP\tEnergy',
      location: { slideNumber: 1 },
    });
    expect(first.document.units.filter((unit) => unit.kind === 'slide')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Slide 1', location: { slideNumber: 1 } }),
        expect.objectContaining({ title: 'Slide 2', location: { slideNumber: 2 } }),
      ]),
    );
    expect(first.document.content).toContain('Grouped shape text');
    expect(first.document.content).not.toContain('Hidden group text');
    expect(first.document.content).not.toContain('Hidden shape text');
    expect(first.warnings.some((warning) => warning.includes('缺失的媒体关系'))).toBe(true);
    expect(first.warnings.join('\n')).not.toMatch(/\brId\w*/u);

    const hash = `sha256:${createHash('sha256').update(image).digest('hex')}`;
    expect(first.assets).toHaveLength(1);
    expect(first.assets[0]).toMatchObject({
      materialId: 'material-pptx',
      materialRevisionId: 'revision-pptx',
      sourcePath: 'ppt/media/image1.png',
      mediaType: 'image/png',
      byteHash: hash,
      byteLength: image.length,
      width: 2,
      height: 3,
      location: { slideNumber: 1, domPath: 'ppt/media/image1.png' },
      contentOrigin: 'extracted_original',
      relationshipKind: 'image',
    });
    expect(first.assets[0]!.bytes).toEqual(image);
    expect(first.document.assets[0]).not.toHaveProperty('bytes');
    expect(first.document.assets[0]!.byteHash).toBe(hash);

    const blocks = normalizedDocumentToSourceBlocks('material-pptx', first.document, {
      materialRevisionId: 'revision-pptx',
    });
    expect(blocks.find((block) => block.content === 'Instructor note')).toMatchObject({
      materialRevisionId: 'revision-pptx',
      slideNumber: 1,
      contentOrigin: 'extracted_original',
      chunkerVersion: 'structure-aware-v1',
    });
    expect(
      blocks.find((block) => block.content.includes('Term | label\tMeaning'))?.slideNumber,
    ).toBe(1);
    expect(blocks.find((block) => block.content === 'Filename-order first')?.slideNumber).toBe(2);
    expect(blocks.every((block) => block.structuralUnitId)).toBe(true);
  });

  it('preserves DOCX heading, paragraph, list, table, image provenance, and chunks', async () => {
    const image = pngHeader(5, 7);
    const bytes = docxFixture(image);

    const first = await parseRichOoxml('docx', bytes, 'material-docx', 'revision-docx');
    const second = await parseRichOoxml('docx', bytes, 'material-docx', 'revision-docx');

    expect(second).toEqual(first);
    expect(first.pageCount).toBeNull();
    expect(first.parserVersion).toBe('docx-ooxml-rich-v1');
    expect(first.document.content).toContain(
      'Cell Biology\n\nCells preserve hereditary information.\n\nNucleus\n\nMitochondrion',
    );
    expect(first.document.units.map((unit) => unit.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list_item',
      'list_item',
      'table',
      'paragraph',
      'paragraph',
      'section',
    ]);
    expect(first.document.units[0]).toMatchObject({
      kind: 'heading',
      title: 'Cell Biology',
      content: 'Cell Biology',
      headingPath: [],
      location: {},
    });
    expect(first.document.units[1]).toMatchObject({
      kind: 'paragraph',
      headingPath: ['Cell Biology'],
      content: 'Cells preserve hereditary information.',
    });
    expect(first.document.units.find((unit) => unit.kind === 'table')?.content).toBe(
      'Organelle\tRole\nRibosome\tTranslation',
    );
    expect(first.document.content).toContain('Referenced header');
    expect(first.document.content).not.toContain('Orphan header');
    expect(first.warnings.some((warning) => warning.includes('媒体关系'))).toBe(true);
    expect(first.warnings.join('\n')).not.toMatch(/\brId\w*/u);
    expect(first.warnings.some((warning) => warning.includes('sectpr'))).toBe(false);

    const hash = `sha256:${createHash('sha256').update(image).digest('hex')}`;
    const imageParagraph = first.document.units.find((unit) => unit.content === 'Cell diagram');
    expect(first.assets).toHaveLength(2);
    expect(first.assets[1]).toMatchObject({
      materialId: 'material-docx',
      materialRevisionId: 'revision-docx',
      parentStructuralUnitId: imageParagraph?.id,
      sourcePath: 'word/media/image1.png',
      byteHash: hash,
      width: 5,
      height: 7,
      location: { domPath: 'word/media/image1.png' },
      contentOrigin: 'extracted_original',
    });
    const tableUnit = first.document.units.find((unit) => unit.kind === 'table');
    expect(first.assets[0]!.parentStructuralUnitId).toBe(tableUnit?.id);
    expect(first.assets[0]!.byteHash).toBe(first.assets[1]!.byteHash);
    expect(first.assets[0]!.id).not.toBe(first.assets[1]!.id);
    expect(first.assets[1]!.location).not.toHaveProperty('pageNumber');
    expect(first.assets[1]!.location).not.toHaveProperty('slideNumber');

    const blocks = normalizedDocumentToSourceBlocks('material-docx', first.document, {
      materialRevisionId: 'revision-docx',
    });
    expect(blocks[0]).toMatchObject({
      materialRevisionId: 'revision-docx',
      heading: 'Cell Biology',
      headingPath: ['Cell Biology'],
      pageNumber: null,
      slideNumber: null,
      contentOrigin: 'extracted_original',
      chunkerVersion: 'structure-aware-v1',
    });
    expect(blocks[0]!.content).toContain('Cell Biology\n\nCells preserve hereditary information.');
    expect(blocks.find((block) => block.content.includes('Nucleus'))?.headingPath).toEqual([
      'Cell Biology',
    ]);
    expect(blocks.find((block) => block.content.includes('Organelle\tRole'))?.headingPath).toEqual([
      'Cell Biology',
    ]);
    expect(blocks.every((block) => block.pageNumber === null && block.slideNumber === null)).toBe(
      true,
    );
  });

  it('rejects exact OOXML roots under the wrong rich-document type', async () => {
    const image = pngHeader(1, 1);
    await expect(
      parseRichOoxml('docx', pptxFixture(image), 'material-wrong', 'revision-wrong'),
    ).rejects.toMatchObject({ code: 'TYPE_MISMATCH' });
    await expect(
      parseRichOoxml('pptx', docxFixture(image), 'material-wrong', 'revision-wrong'),
    ).rejects.toMatchObject({ code: 'TYPE_MISMATCH' });
  });

  it('preserves original assets for text-free PPTX and DOCX without fabricating SourceBlocks', async () => {
    const image = pngHeader(4, 6);
    for (const [sourceType, bytes] of [
      ['pptx', imageOnlyPptxFixture(image)],
      ['docx', imageOnlyDocxFixture(image)],
    ] as const) {
      const parsed = await parseRichOoxml(
        sourceType,
        bytes,
        `material-${sourceType}`,
        `revision-${sourceType}`,
      );
      expect(parsed.document.content).toBe('');
      expect(parsed.document.assets).toHaveLength(1);
      expect(parsed.assets[0]).toMatchObject({
        mediaType: 'image/png',
        byteLength: image.length,
        contentOrigin: 'extracted_original',
      });
      expect(normalizedDocumentToSourceBlocks(`material-${sourceType}`, parsed.document)).toEqual(
        [],
      );
    }
  });

  it('uses byte signatures for media identity and reports declaration mismatches', async () => {
    const mp3 = Buffer.from('49443304000000000000', 'hex');
    const parsed = await parseRichOoxml(
      'pptx',
      imageOnlyPptxFixture(mp3),
      'material-media',
      'revision-media',
    );
    expect(parsed.assets[0]).toMatchObject({ mediaType: 'audio/mpeg', relationshipKind: 'image' });
    expect(parsed.warnings.some((warning) => warning.includes('声明类型与内容不一致'))).toBe(true);
  });

  it('honors cancellation before XML traversal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parseRichOoxml(
        'pptx',
        imageOnlyPptxFixture(pngHeader(1, 1)),
        'material-cancel',
        'revision-cancel',
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
});
