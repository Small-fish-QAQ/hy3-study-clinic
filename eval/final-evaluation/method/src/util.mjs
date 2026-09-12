import crypto from 'node:crypto';

export const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const assert = (condition, code) => { if (!condition) throw Error(code); };
export const isResolved = value => [0, 1, 2].includes(value);
export const clone = value => structuredClone(value);
export const escapePointer = part => String(part).replaceAll('~', '~0').replaceAll('/', '~1');

export function atPointer(root, pointer) {
  assert(typeof pointer === 'string' && (pointer === '' || pointer.startsWith('/')), 'BAD_POINTER');
  let value = root;
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    assert(!['__proto__', 'constructor', 'prototype'].includes(part) && value != null && Object.hasOwn(value, part), 'DANGLING_POINTER');
    value = value[part];
  }
  return value;
}

export function parseJson(text) {
  assert(typeof text === 'string', 'MISSING_CONTENT');
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
}

// Only representation fields may change in a format-repair call.
export function semanticFingerprint(value) {
  if (!value || typeof value !== 'object') return sha(value ?? null);
  const visit = v => Array.isArray(v) ? v.map(visit) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).filter(k => !['refs', 'basisRefs', 'answerRefs', 'validityRefs', 'witnesses'].includes(k)).sort().map(k => [k, visit(v[k])])) : v;
  return sha(visit(value));
}
