import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, sha } from './util.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OLD = path.resolve(ROOT, '../phase-b-2026-09-10');
export const PUBLIC = path.resolve(ROOT, '../../../../hy3-study-clinic');
export const now = () => new Date().toISOString();

export function guarded(relative) {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative), 'RELATIVE_PRIVATE_PATH_REQUIRED');
  const candidate = path.resolve(ROOT, relative), rel = path.relative(ROOT, candidate);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'WRITE_OUTSIDE_REMEDIATION');
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const physical = path.resolve(fs.realpathSync.native(ancestor)), physicalRoot = fs.realpathSync.native(ROOT);
  const physicalRel = path.relative(physicalRoot, physical);
  assert(!physicalRel.startsWith('..') && !path.isAbsolute(physicalRel), 'PRIVATE_SYMLINK_ESCAPE');
  return candidate;
}

export const exists = relative => fs.existsSync(guarded(relative));
export const read = relative => JSON.parse(fs.readFileSync(guarded(relative), 'utf8'));
export const oldRead = relative => {
  const p = path.resolve(OLD, relative), rel = path.relative(OLD, p);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'OLD_READ_OUTSIDE_CAMPAIGN');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};
export function write(relative, value) {
  const p = guarded(relative); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return relative;
}
export function append(relative, value) {
  const p = guarded(relative); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ at: now(), ...value }) + '\n');
}
export function jsonl(relative) {
  return exists(relative) ? fs.readFileSync(guarded(relative), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

export function runtimeFiles() {
  return fs.readdirSync(path.join(ROOT, 'src')).filter(p => p.endsWith('.mjs')).sort().map(p => 'src/' + p);
}
export function runtimeHashes() { return Object.fromEntries(runtimeFiles().map(p => [p, sha(fs.readFileSync(guarded(p)))])); }
export function assertFreeze() {
  assert(exists('freeze/candidate.json'), 'CANDIDATE_NOT_FROZEN');
  const frozen = read('freeze/candidate.json');
  assert(sha(runtimeHashes()) === frozen.runtimeTreeHash, 'FROZEN_RUNTIME_CHANGED');
  for (const [p, hash] of Object.entries(frozen.protocolFiles)) assert(sha(fs.readFileSync(guarded(p))) === hash, 'FROZEN_PROTOCOL_CHANGED');
  return frozen;
}
