import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const product = process.env.STUDY_CLINIC_ROOT || path.resolve(root, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const bytesHash = value => crypto.createHash('sha256').update(value).digest('hex');
const objectHash = value => bytesHash(JSON.stringify(value));
const origin = read('ORIGIN.json');
for (const [relative, expected] of Object.entries(origin.files)) {
  assert.equal(bytesHash(fs.readFileSync(path.join(root, relative))), expected.sha256, relative);
}
const methodRoot = path.join(product, 'eval/studyeval');
const methodFreeze = JSON.parse(fs.readFileSync(path.join(methodRoot, 'FREEZE.json'), 'utf8'));
for (const [relative, expected] of Object.entries(methodFreeze.runtime)) {
  assert.equal(bytesHash(fs.readFileSync(path.join(methodRoot, relative))), expected, relative);
}
const { project } = await import(pathToFileURL(path.join(methodRoot, 'evaluator.mjs')));
const populations = {};
let observations = 0;
for (const run of ['fresh', 'human']) {
  const schedule = read(run + '/schedule.json');
  const rows = read(run + '/rows.json');
  assert.equal(new Set(schedule.map(t => t.runId)).size, schedule.length);
  for (const task of schedule) {
    const input = read(run + '/inputs/' + task.caseId + '.json');
    const observation = read(run + '/observations/' + task.runId + '.json');
    assert.equal(objectHash(input), task.inputHash, task.runId + ' input');
    assert.equal(observation.inputHash, task.inputHash);
    assert.equal(objectHash(project(input)), observation.evaluation.inputViewHash);
    assert.equal(objectHash(observation.evaluation.result), observation.evaluation.resultHash);
    const actual = rows.filter(r => r.runId === task.runId);
    assert.equal(actual.length, input.dimensions.length);
    for (const dimension of input.dimensions) {
      const row = actual.find(r => r.dimension === dimension);
      const result = observation.evaluation.result.dimensions.find(r => r.dimension === dimension);
      assert(row && result, task.runId + ' missing dimension');
      assert.equal(row.level, result.level);
      assert.equal(row.inputHash, task.inputHash);
    }
    observations++;
  }
  assert.equal(rows.length, schedule.reduce((n, t) => n + read(run + '/inputs/' + t.caseId + '.json').dimensions.length, 0));
  populations[run] = { schedule, rows };
}
const registry = read('dataset/registry.json');
const first = populations.fresh.rows.filter(r => r.replicate === 1);
assert.equal(first.length, registry.length);
const cases = registry.map(entry => {
  const row = first.find(r => r.caseId === entry.caseId && r.dimension === entry.dimension);
  assert(row && row.inputHash === entry.inputHash);
  assert.equal(objectHash(read('dataset/cases/' + entry.caseId + '.json')), entry.inputHash);
  return { ...entry, level: row.level };
});
const match = list => ({ matched: list.filter(x => x.expected === x.level).length, total: list.length });
const controlled = cases.filter(x => x.collection === 'controlled');
const families = [...new Set(controlled.map(x => x.family))].map(family => controlled.filter(x => x.family === family).sort((a, b) => b.expected - a.expected));
assert(families.every(group => group.length === 3));
const pairs = families.flatMap(group => [[0, 1], [0, 2], [1, 2]].map(([a, b]) => [group[a].level, group[b].level]));
const repeatGroups = [...new Set(populations.fresh.rows.filter(r => r.replicate > 1).map(r => r.caseId))].map(id => populations.fresh.rows.filter(r => r.caseId === id));
const humanMap = new Map(read('human-reference/packet-map.json').items.map(item => [item.itemId, item.frozenCaseId]));
const human = read('human-reference/normalized.json').answers.map(row => ({ ...row, caseId: humanMap.get(row.itemId), level: Number(row.answer) }));
assert(human.every(row => row.caseId && [0, 1, 2].includes(row.level)));
const humanFirst = populations.human.rows.filter(r => r.replicate === 1);
const slots = humanFirst.map(row => ({ ...row, ratings: human.filter(h => h.caseId === row.caseId && h.dimension === row.dimension) }));
assert(slots.every(slot => slot.ratings.length === 2));
assert.equal(slots.reduce((n, slot) => n + slot.ratings.length, 0), human.length);
const consensus = slots.filter(slot => slot.ratings[0].level === slot.ratings[1].level);
const numeric = consensus.filter(slot => [0, 1, 2].includes(slot.level));
const marginalHuman = [0, 1, 2].map(level => numeric.filter(x => x.ratings[0].level === level).length);
const marginalModel = [0, 1, 2].map(level => numeric.filter(x => x.level === level).length);
const observedDisagreement = numeric.reduce((sum, row) => sum + (row.level - row.ratings[0].level) ** 2, 0) / numeric.length;
const expectedDisagreement = marginalHuman.reduce((sum, count, a) => sum + marginalModel.reduce((inner, modelCount, b) => inner + (a - b) ** 2 * count * modelCount, 0), 0) / numeric.length ** 2;
const summary = { passed: true, preservedFiles: Object.keys(origin.files).length, verifiedObservations: observations,
  fresh: { uniqueCases: cases.length, controlled: match(controlled), strictTriplets: { matched: families.filter(g => g[0].level > g[1].level && g[1].level > g[2].level).length, total: families.length },
    orderedPairs: { matched: pairs.filter(([a, b]) => typeof a === 'number' && typeof b === 'number' && a > b).length, total: pairs.length },
    adversarial: match(cases.filter(x => x.collection === 'adversarial')), boundaries: match(cases.filter(x => x.collection === 'boundary')),
    repeatExact: { matched: repeatGroups.filter(g => g.length === 3 && new Set(g.map(x => x.level)).size === 1).length, total: repeatGroups.length } },
  human: { cases: new Set(slots.map(x => x.caseId)).size, dimensionPairs: slots.length, individualRatings: human.length,
    consensus: { matched: consensus.filter(x => x.level === x.ratings[0].level).length, total: consensus.length },
    individual: { matched: slots.reduce((n, row) => n + row.ratings.filter(h => h.level === row.level).length, 0), total: human.length },
    quadraticWeightedKappa: 1 - observedDisagreement / expectedDisagreement } };
console.log(JSON.stringify(summary, null, 2));
