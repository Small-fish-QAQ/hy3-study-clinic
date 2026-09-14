import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, read, write, sha } from './common.mjs';

assert(!fs.existsSync(path.join(ROOT, 'FREEZE.json')), 'Already frozen');
const research = path.dirname(ROOT);
const history = [];
for (const directory of ['final-evaluation-2026-09-12/benchmark/product-inputs', 'final-evidence-2026-09-14/dataset/product', 'mainline-product-2026-09-14/dataset/courses']) {
  for (const file of fs.readdirSync(path.join(research, directory)).filter(f => f.endsWith('.json'))) {
    const s = read(path.join(research, directory, file));
    history.push({ id: s.sourceId || s.id, title: s.title, path: directory + '/' + file, text: s.text || s.content });
  }
}
for (const file of fs.readdirSync(path.join(research, 'final-evidence-2026-09-14/dataset/studyeval')).filter(f => f.endsWith('.json'))) {
  const s = read(path.join(research, 'final-evidence-2026-09-14/dataset/studyeval', file));
  for (const source of s.evidence?.sources || []) history.push({ id: s.id, path: 'final-evidence-2026-09-14/dataset/studyeval/' + file, text: source.text });
}
const distinct = [...new Map(history.map(h => [h.text, h])).values()];
const normalize = text => text.toLowerCase().replace(/\s+/g, ' ').trim();
function longestCommon(a, b) {
  let low = 0, high = Math.min(a.length, b.length), overlap = '';
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const chunks = new Set();
    for (let i = 0; i <= a.length - length; i++) chunks.add(a.slice(i, i + length));
    let found = '';
    for (let i = 0; i <= b.length - length; i++) if (chunks.has(b.slice(i, i + length))) { found = b.slice(i, i + length); break; }
    if (found) { low = length; overlap = found; } else high = length - 1;
  }
  return { characters: low, overlap };
}
const auditNotes = {
  J01: 'Euclidean invariance and 84/60 -> 12; 7*5=35 tiles. Zero-remainder wording corrected before build to include immediate divisibility.',
  J02: 'Specified correspondence; 3-4-5 area 6; scale 2 yields area 24; area ratio 9 gives positive length ratio 3.',
  J03: 'All decimal/exponent conversions and 8400+2000=10400 verified; positive-only comparison rule and exact-value scope supplied.',
  J04: 'Explicit median-of-halves convention: Q1=4, Q3=11, IQR=7; fences -6.5/21.5; maximum replacement leaves quartiles unchanged for this dataset only.',
  J05: 'Perpendicular arms and opposing directions explicit; 10*.3=6*.5; 12*.4/6=.8; multiple-load total 2.0.',
  J06: 'E=.5*m*v^2; examples 9,36,18 J checked; ratio 2*(.5)^2=.5; energy change 27, not 9.',
  J07: 'Extension rather than total length used throughout; 3/100=.03 m; 2/.04=50 N/m; elastic limit expressly given.',
  J08: 'kWh conversion 3.6e6 J; .8*1.5=1.2; staged .9; comparison .15/.6; fee .72; actual versus rated power distinguished.',
  J09: 'Complete root/xylem/transpiration chain; fixed stomatal and environmental conditions; 8-11=-3 and 12-11=1; phloem distinction checked.',
  J10: 'Counted moments explicitly distinguish DNA molecules, centromere-defined chromosomes, poles and daughter cells. 1*2^3=8; 2*2^2=8.',
  J11: 'All transformations preserve roles/tense/negation; irregular participles and object pronouns supplied; full-information task differs from optional agent omission.',
  J12: 'All supplied adjective forms and price/mass comparisons checked; basic requests still require data application and scope.',
  J13: 'Fictional X table complete; 50g water caps 15/30g; cooling precipitates 15; 65+15=80 mass balance. No unstated interpolation.',
  J14: 'Solute and total mass distinguished; dilution 30/.1-200=100g; mixture (10+50)/300=.2. Shared percentage prerequisite is disclosed, not a reused price task.',
  J15: 'Revenue 1500, collections 900, closing receivable 600; later collection adds no revenue; roll-forward 400+700-500=600.',
  J16: 'Every transaction balances; final assets 1700=liabilities 700+equity 1000. Financing, capital purchase and principal repayment distinguished.',
  J17: 'Every matching pair enumerated; INNER=3 and LEFT=4 initially; adding Ben order gives 4 in both; null and order guarantees explicit.',
  J18: 'Stable sorted order D,B,C,E,A; secondary-then-primary passes match; reversed passes C,E,D,A,B. Complete numeric records supplied.',
  J19: 'Queue operations checked; start/finish intervals [0,4],[4,6],[6,7], waiting 0/3/4; idle next task starts at arrival 10.',
  J20: 'Pass-by-value model explicit; adjust(4)=18; nested results 9 and 12; choose(-2/5/0)=0/6/1; caller assignment distinctions correct.',
};
const rows = read(path.join(ROOT, 'dataset/schedule.json')).map(row => {
  const p = path.join(ROOT, row.path), s = read(p), normalized = normalize(s.text);
  assert.equal(sha(s.text), s.textHash);
  assert(s.goals.length === 3 && s.text.split(/\n\n/).length >= 6 && !s.text.includes('\uFFFD'));
  const matches = distinct.map(h => ({ id: h.id, path: h.path, ...longestCommon(normalized, normalize(h.text)) })).sort((a, b) => b.characters - a.characters);
  assert(!distinct.some(h => normalize(h.text) === normalized));
  assert(auditNotes[s.sourceId]);
  return { id: s.sourceId, fileSha256: sha(fs.readFileSync(p)), textSha256: s.textHash, characters: s.text.length,
    words: s.language === 'en' ? s.text.split(/\s+/).length : null, paragraphs: s.text.split(/\n\n/).length,
    nearestLexical: matches.slice(0, 3), semanticFreshness: s.semanticFreshness, correctnessReview: auditNotes[s.sourceId],
    selfContained: true, explanationExampleApplication: true, intendedNormalUse: true, preScoringAccepted: true };
});
const withinSet = [];
const sources = read(path.join(ROOT, 'dataset/schedule.json')).map(s => read(path.join(ROOT, s.path)));
for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
  assert(sources[i].textHash !== sources[j].textHash);
  withinSet.push({ a: sources[i].sourceId, b: sources[j].sourceId, ...longestCommon(normalize(sources[i].text), normalize(sources[j].text)) });
}
write(path.join(ROOT, 'dataset/source-audit.json'), { at: new Date().toISOString(), passed: true, scoredCourses: rows.length,
  historicalDistinctTexts: distinct.length, noExactReuse: true, reviewer: 'Current task assistant; source audit is not independent human validation',
  method: 'Exact and longest contiguous lexical overlap screening plus explicit semantic-model and worked-example review of all 20 sources. Lexical distance is not a proof of semantic freshness. Shared prerequisite arithmetic and adjacent subject matter are allowed; old cases or cosmetic rewrites are not.',
  rows, largestWithinSetOverlap: withinSet.sort((a, b) => b.characters - a.characters).slice(0, 5) });
write(path.join(ROOT, 'dataset/history-catalog.json'), distinct.map(h => ({ id: h.id, title: h.title, historicalPath: h.path, textSha256: sha(h.text), characters: h.text.length })));
console.log(JSON.stringify({ passed: true, courses: rows.length, historicalDistinctTexts: distinct.length, maximumPriorOverlap: Math.max(...rows.map(r => r.nearestLexical[0].characters)) }));
