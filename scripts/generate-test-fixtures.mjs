/**
 * Deterministic generator for the tiny, self-authored binary test fixtures
 * committed under `apps/server/src/testing/files/` (`sample.pdf`,
 * `sample.docx`, plus their malformed variants). All content is original
 * English/Chinese text written for this repository (Apache-2.0) — legally
 * safe to commit.
 *
 * Run from the repository root:  node scripts/generate-test-fixtures.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '../apps/server/src/testing/files');

// ---------------------------------------------------------------------------
// Minimal 2-page PDF with real text streams (WinAnsi / ASCII only).
// ---------------------------------------------------------------------------
function serializePdf(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function buildPdf() {
  const page1Text = 'Working memory has a very limited capacity.';
  const page2Text = 'Spaced repetition improves long-term retention.';

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>';
  const stream1 = `BT /F1 12 Tf 72 720 Td (${page1Text}) Tj ET`;
  objects[4] = `<< /Length ${stream1.length} >>\nstream\n${stream1}\nendstream`;
  objects[5] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>';
  const stream2 = `BT /F1 12 Tf 72 720 Td (${page2Text}) Tj ET`;
  objects[6] = `<< /Length ${stream2.length} >>\nstream\n${stream2}\nendstream`;
  objects[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  return serializePdf(objects);
}

// Structurally valid single-page PDF whose page has NO text operators —
// what a scanned/image-only PDF looks like to a text extractor.
function buildEmptyPdf() {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>';
  objects[4] = '<< /Length 0 >>\nstream\n\nendstream';
  return serializePdf(objects);
}

// ---------------------------------------------------------------------------
// 2-page PDF replicating the Chrome/Skia structure behind a real-world
// import failure: a Type0 / Identity-H composite font whose ToUnicode CMap
// explicitly maps unmapped glyph CIDs (list bullets) to <0000>, which makes
// PDF.js emit U+0000 inside valid Chinese text. Also maps CJK, an emoji
// (surrogate pair) and a soft hyphen so sanitation is exercised through the
// real parser. Latin text uses plain Helvetica alongside, as Skia does.
// ---------------------------------------------------------------------------
function buildArtifactsPdf() {
  // CID 0001 -> U+0000 (bullet artifact), 0002..0005 -> 知识过时,
  // 0006 -> U+1F600 (emoji), 0007 -> U+00AD (soft hyphen), 0008 -> space.
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
8 beginbfchar
<0001> <0000>
<0002> <77E5>
<0003> <8BC6>
<0004> <8FC7>
<0005> <65F6>
<0006> <D83DDE00>
<0007> <00AD>
<0008> <0020>
endbfchar
endcmap
CMap defined
end
end
`;

  // Page 1: three bullet CIDs + space + 知识, latin line, emoji line.
  const page1 = [
    'BT /F2 12 Tf 72 720 Td <000100010001000800020003> Tj ET',
    'BT /F1 12 Tf 72 700 Td (memory retrieval) Tj ET',
    'BT /F2 12 Tf 72 680 Td <0006> Tj ET',
  ].join('\n');
  // Page 2: 过时, then a soft-hyphen artifact inside "example".
  const page2 = [
    'BT /F2 12 Tf 72 720 Td <00040005> Tj ET',
    'BT 72 700 Td /F1 12 Tf (spaced repetition exam) Tj /F2 12 Tf <0007> Tj /F1 12 Tf (ple) Tj ET',
  ].join('\n');

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> >>';
  objects[4] = `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`;
  objects[5] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> >>';
  objects[6] = `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`;
  objects[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[8] =
    '<< /Type /Font /Subtype /Type0 /BaseFont /Hy3Artifact /Encoding /Identity-H /DescendantFonts [9 0 R] /ToUnicode 10 0 R >>';
  objects[9] =
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Hy3Artifact /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 11 0 R /CIDToGIDMap /Identity /DW 1000 >>';
  objects[10] = `<< /Length ${cmap.length} >>\nstream\n${cmap}endstream`;
  objects[11] =
    '<< /Type /FontDescriptor /FontName /Hy3Artifact /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>';

  return serializePdf(objects);
}

// ---------------------------------------------------------------------------
// Minimal DOCX (zip with the three required parts) built with jszip
// (transitive dependency of mammoth; used here at generation time only).
// ---------------------------------------------------------------------------
async function buildDocx() {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  // Fixed date keeps the generated bytes deterministic across runs.
  // (jszip stamps DOS timestamps per entry.)
  const date = new Date(Date.UTC(2024, 0, 1));

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    { date },
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    { date },
  );
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${w}">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>记忆的科学</w:t></w:r></w:p>
    <w:p><w:r><w:t>工作记忆的容量十分有限,一般只能同时保持四个组块。</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>间隔重复</w:t></w:r></w:p>
    <w:p><w:r><w:t>间隔重复通过在遗忘边缘复习来提升长期记忆保持率。</w:t></w:r></w:p>
  </w:body>
</w:document>`,
    { date },
  );

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
}

const pdf = buildPdf();
writeFileSync(join(here, 'sample.pdf'), pdf);

const emptyPdf = buildEmptyPdf();
writeFileSync(join(here, 'empty.pdf'), emptyPdf);

const artifactsPdf = buildArtifactsPdf();
writeFileSync(join(here, 'artifacts.pdf'), artifactsPdf);

// Malformed variants: right extensions, wrong bytes / truncated container.
writeFileSync(join(here, 'malformed.pdf'), Buffer.from('%PDF-1.4\nthis is not a real pdf body'));
writeFileSync(join(here, 'malformed.docx'), Buffer.from('PKbroken-zip-payload', 'latin1'));

const docx = await buildDocx();
writeFileSync(join(here, 'sample.docx'), docx);

console.log('fixtures written:', {
  pdf: pdf.length,
  emptyPdf: emptyPdf.length,
  artifactsPdf: artifactsPdf.length,
  docx: docx.length,
});
