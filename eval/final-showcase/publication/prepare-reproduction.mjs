import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const campaign = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const product = process.env.STUDY_CLINIC_ROOT || path.resolve(campaign, '../..');
const archive = path.resolve(process.argv[2] || '');
assert(process.argv[2], 'Pass the extracted final-showcase-audit archive directory');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const freeze = read(path.join(campaign, 'FREEZE.json'));
const manifest = read(path.join(archive, 'MANIFEST.json'));
assert.equal(manifest.freezeSha256, hash(fs.readFileSync(path.join(campaign, 'FREEZE.json'))));
for (const [relative, record] of Object.entries(manifest.files)) assert.equal(hash(fs.readFileSync(path.join(archive, relative))), record.sha256, relative);
for (const [relative, expected] of Object.entries(freeze.productFiles)) {
  if (!relative.includes('/dist/')) assert.equal(hash(fs.readFileSync(path.join(product, relative))), expected, 'Candidate 23 source mismatch: ' + relative);
  assert.equal(hash(fs.readFileSync(path.join(archive, 'runtime', relative))), expected, relative);
}
let copied = 0;
for (const relative of Object.keys(freeze.productFiles).filter(p => p.includes('/dist/'))) {
  const target = path.join(product, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(archive, 'runtime', relative), target); copied++;
}
console.log(JSON.stringify({ verifiedArchiveFiles: Object.keys(manifest.files).length, restoredCompiledFiles: copied, sourceFilesUnchanged: true,
  note: 'No model calls. Run the frozen campaign with a fresh run name, or analyze the archived scored-01 with STUDY_CLINIC_ROOT pointing to this product checkout.' }));
