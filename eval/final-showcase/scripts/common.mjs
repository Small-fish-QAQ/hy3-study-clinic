import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export function write(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
export function filesUnder(directory) {
  return fs.readdirSync(directory, { recursive: true }).filter(p => fs.statSync(path.join(directory, p)).isFile()).sort();
}
export function verifyFiles(base, files) {
  for (const [relative, hash] of Object.entries(files)) {
    if (sha(fs.readFileSync(path.join(base, relative))) !== hash) throw Error('Frozen file changed: ' + relative);
  }
}
