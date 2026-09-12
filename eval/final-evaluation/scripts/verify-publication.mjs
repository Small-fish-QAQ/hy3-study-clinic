// Read-only verification of saved evidence. No evaluator execution or API calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const jsonSha = (data) => sha(JSON.stringify(data));
const levels = ['0', '1', '2', 'U', 'INVALID', 'MISSING'];
const count = (rows) =>
  Object.fromEntries(levels.map((k) => [k, rows.filter((r) => String(r.level) === k).length]));
const numeric = (value) => typeof value === 'number';
const group = (rows, key) =>
  Object.fromEntries(
    [...new Set(rows.map((r) => r[key]))].sort().map((k) => {
      const selected = rows.filter((r) => r[key] === k);
      return [k, { scheduled: selected.length, counts: count(selected) }];
    }),
  );
const checkFields = (actual, expected) => {
  for (const [k, value] of Object.entries(actual)) assert.deepEqual(value, expected[k], k);
};

const manifest = read('MANIFEST.json');
for (const entry of manifest.files) {
  const resolved = path.resolve(root, entry.path);
  assert(resolved.startsWith(root + path.sep), 'Manifest path escapes release');
  const bytes = fs.readFileSync(resolved);
  assert.equal(bytes.length, entry.bytes, entry.path);
  assert.equal(sha(bytes), entry.sha256, entry.path);
}
const freeze = read('method/original-freeze.json');
for (const [name, hash] of Object.entries(freeze.runtime)) {
  assert.equal(sha(fs.readFileSync(path.join(root, 'method', name))), hash, name);
}
assert.equal(jsonSha(freeze.runtime), freeze.runtimeTreeHash);
const { candidateHash, ...freezeBody } = freeze;
assert.equal(jsonSha(freezeBody), candidateHash);
const receipts = read('results/frozen-receipts.json');
assert.equal(candidateHash, receipts.identities.evaluator.candidateHash);
assert.equal(freeze.runtimeTreeHash, receipts.identities.evaluator.runtimeTreeHash);
assert.equal(receipts.replay.identity.scheduleHash, receipts.identities.scheduleHash);
assert.equal(receipts.replay.identity.productCommit, receipts.identities.productCommit);

const rows = read('results/machine-rows.json');
const expected = read('results/machine-summary.json');
const originalRows = read('results/complete-rows.json');
const originalSummary = read('results/complete-results.json');
const schedule = read('dataset/final-schedule.json');
assert.equal(jsonSha(schedule), receipts.identities.scheduleHash);
assert.equal(schedule.length, 279);
assert.equal(
  sha(fs.readFileSync(path.join(root, 'results/complete-rows.json'))),
  receipts.originalRowsSha256,
);
assert.equal(
  sha(fs.readFileSync(path.join(root, 'results/machine-export-v6-manifest.json'))),
  receipts.originalExport.manifestSha256,
);
assert.equal(
  sha(fs.readFileSync(path.join(root, 'results/release-mapping.json'))),
  receipts.privateReleaseMappingSha256,
);
const mapping = read('results/release-mapping.json');
const references = new Map(
  read('dataset/constructor-reference.json').references.map((r) => [r.caseId, r]),
);
for (const original of originalRows) {
  const published = rows.find(
    (r) =>
      r.caseId === mapping.cases[original.caseId] &&
      r.replicate === original.replicate &&
      r.dimension === original.dimension,
  );
  assert(published);
  for (const key of [
    'replicate',
    'collection',
    'dimension',
    'level',
    'status',
    'referenceLevel',
    'attackFamily',
  ]) {
    assert.deepEqual(published[key], original[key], key);
  }
  assert.equal(published.tripletId, mapping.triplets[original.tripletId] ?? null);
  assert.equal(
    original.referenceLevel,
    references.get(original.caseId)?.expected?.[original.dimension] ?? null,
  );
  const observation = read(`results/observations/${original.runId}.json`);
  assert.equal(jsonSha(observation.evaluation), original.resultHash);
}
assert.equal(originalRows.length, rows.length);
const finalCustody = read('results/final-publication-custody.json');
for (const binding of finalCustody.originalMachineFiles) {
  assert.equal(sha(fs.readFileSync(path.join(root, binding.file))), binding.sha256, binding.file);
}
const primary = rows.filter((r) => r.replicate === 1);
assert.equal(new Set(rows.map((r) => `${r.runId}/${r.dimension}`)).size, rows.length);
assert.equal(new Set(rows.map((r) => r.runId)).size, expected.completedObservations);
assert.equal(expected.completedObservations, expected.scheduledObservations);
assert.equal(expected.scheduleHash, receipts.identities.scheduleHash);
assert.equal(rows.length, expected.totalSlots);
assert.equal(primary.length, expected.primarySlots);
assert.deepEqual(count(primary), expected.primaryCounts);
assert.deepEqual(count(rows), expected.allCounts);
assert.deepEqual(group(primary, 'dimension'), expected.byDimension);
assert.deepEqual(group(primary, 'collection'), expected.byCollection);

const controls = primary.filter((r) => r.collection === 'controlled');
const triplets = [...new Set(controls.map((r) => r.tripletId))].map((id) =>
  controls.filter((r) => r.tripletId === id).sort((a, b) => b.referenceLevel - a.referenceLevel),
);
const pairs = triplets.flatMap((g) => {
  assert.equal(g.length, 3);
  assert.deepEqual(
    g.map((r) => r.referenceLevel),
    [2, 1, 0],
  );
  return [
    [g[0], g[1]],
    [g[0], g[2]],
    [g[1], g[2]],
  ];
});
const numericPairs = pairs.filter(([a, b]) => numeric(a.level) && numeric(b.level));
const discrimination = {
  triplets: triplets.length,
  fullyNumericTriplets: triplets.filter((g) => g.every((r) => numeric(r.level))).length,
  strictlyOrdered: triplets.filter(
    (g) => g.every((r) => numeric(r.level)) && g[0].level > g[1].level && g[1].level > g[2].level,
  ).length,
  pairs: pairs.length,
  numericPairs: numericPairs.length,
  correctlyOrderedPairs: numericPairs.filter(([a, b]) => a.level > b.level).length,
  controlledSlots: controls.length,
  numericControls: controls.filter((r) => numeric(r.level)).length,
  exactConstructorAgreement: controls.filter((r) => r.level === r.referenceLevel).length,
};
checkFields(discrimination, expected.discrimination);

const repeatedIds = new Set(rows.filter((r) => r.replicate > 1).map((r) => r.caseId));
const repeatKeys = [
  ...new Set(
    rows.filter((r) => repeatedIds.has(r.caseId)).map((r) => `${r.caseId}/${r.dimension}`),
  ),
];
const repeats = repeatKeys.map((key) => {
  const g = rows
    .filter((r) => `${r.caseId}/${r.dimension}` === key)
    .sort((a, b) => a.replicate - b.replicate);
  assert.deepEqual(
    g.map((r) => r.replicate),
    [1, 2, 3],
  );
  return g.map((r) => r.level);
});
const transitions = {};
for (const g of repeats)
  for (const level of g.slice(1)) {
    const key = `${g[0]} -> ${level}`;
    transitions[key] = (transitions[key] || 0) + 1;
  }
const consistency = {
  repeatedCaseIds: repeatedIds.size,
  dimensionGroups: repeats.length,
  exactGroups: repeats.filter((g) => new Set(g).size === 1).length,
  numericGroups: repeats.filter((g) => g.every(numeric)).length,
  transitions,
};
checkFields(consistency, expected.consistency);
const attacks = primary.filter((r) => r.collection === 'adversarial');
const adversarial = {
  scheduled: attacks.length,
  detectedAsZero: attacks.filter((r) => r.level === 0).length,
  positive: attacks.filter((r) => r.level === 1 || r.level === 2).length,
  byFamily: group(attacks, 'attackFamily'),
};
assert.deepEqual(adversarial, expected.adversarial);

const registry = read('dataset/public-cases.json');
let checkedObservations = 0;
for (const entry of registry) {
  const bytes = fs.readFileSync(path.join(root, entry.file));
  assert.equal(sha(bytes), entry.sha256);
  const record = JSON.parse(bytes.toString('utf8'));
  assert.equal(jsonSha(record), entry.inputHash);
  assert.deepEqual(record.dimensions, entry.dimensions);
  assert.equal(path.basename(entry.file, '.json'), entry.frozenCaseId);
  // Natural inputs keep their identity in the registry/task, outside the packet.
  if (record.id !== undefined) assert.equal(record.id, entry.frozenCaseId);
  for (const name of entry.observations) {
    const o = read(name);
    assert.equal(o.inputHash, entry.inputHash);
    assert.equal(o.task.caseId, entry.frozenCaseId);
    assert.deepEqual(
      o.task,
      schedule.find((task) => task.runId === o.task.runId),
    );
    for (const dimension of entry.dimensions) {
      const row = rows.find(
        (r) =>
          r.caseId === entry.caseId &&
          r.replicate === o.task.replicate &&
          r.dimension === dimension,
      );
      assert(row?.evidenceAvailable, 'Public input has no corresponding result row');
      const result = o.evaluation.result.dimensions?.find((d) => d.dimension === dimension);
      assert.equal(row.level, result?.level ?? 'INVALID');
      assert.equal(row.status, o.evaluation.result.status);
    }
    checkedObservations++;
  }
}
const coverage = read('dataset/coverage.json');
assert.equal(registry.length, coverage.publicCases);
assert.equal(checkedObservations, coverage.publicObservations);
assert.equal(rows.filter((r) => r.evidenceAvailable).length, coverage.publicDimensionRows);
assert.equal(new Set(primary.map((r) => r.caseId)).size, coverage.frozenCases);
const lengthResults = originalSummary.baselines.details.map((group) => {
  const triplet = originalSummary.discrimination.details.find(
    (t) => t.tripletId === group.tripletId,
  );
  const lengths = triplet.caseIds.map((id) => {
    const entry = registry.find((r) => r.frozenCaseId === id);
    return read(entry.file).evidence.artifacts.reduce((n, a) => n + a.text.length, 0);
  });
  assert.deepEqual(lengths, group.lengths);
  assert.equal(lengths[0] > lengths[1] && lengths[1] > lengths[2], group.lengthStrictOrder);
  return group.lengthStrictOrder;
});
assert.equal(lengthResults.filter(Boolean).length, expected.baselines.lengthStrictOrder);
assert.equal(lengthResults.length, expected.baselines.lengthTriplets);
assert.equal(
  registry.filter(
    (r) =>
      r.collection === 'controlled' &&
      read(r.file).evidence.sources.length > 0 &&
      read(r.file).evidence.artifacts.length > 0,
  ).length,
  expected.baselines.structuralPresent,
);
assert.equal(read('results/natural-missing.json').length, coverage.unavailableNaturalOpportunities);
assert.equal(
  coverage.availableNaturalRecords + coverage.unavailableNaturalOpportunities,
  coverage.naturalOpportunities,
);

const accounting = read('results/call-accounting.json');
function usageSummary(records) {
  const known = records.filter((r) => r.usage);
  const sum = (f) => known.reduce((n, r) => n + f(r.usage), 0);
  const promptTokens = sum((u) => u.prompt_tokens);
  const cachedInputTokens = sum((u) => u.prompt_tokens_details?.cached_tokens || 0);
  const completionTokens = sum((u) => u.completion_tokens);
  return {
    promptTokens,
    cachedInputTokens,
    completionTokens,
    reasoningTokensComponent: sum((u) => u.completion_tokens_details?.reasoning_tokens || 0),
    estimatedCNY:
      (promptTokens - cachedInputTokens + cachedInputTokens * 0.25 + completionTokens * 4) / 1e6,
  };
}
const evaluatorCalls = accounting.filter((r) => r.phase === 'evaluator');
const productCalls = accounting.filter((r) => r.phase === 'product');
const times = evaluatorCalls.map((r) => r.elapsedMs).sort((a, b) => a - b);
const cost = {
  ...usageSummary(evaluatorCalls),
  physicalRequests: evaluatorCalls.length,
  terminal: evaluatorCalls.length,
  knownUsage: evaluatorCalls.filter((r) => r.usage).length,
  unknownUsage: evaluatorCalls.filter((r) => !r.usage).length,
  retries: evaluatorCalls.filter((r) => r.transportAttempt > 1).length,
  httpFailures: evaluatorCalls.filter(
    (r) => r.event === 'completed' && (r.status < 200 || r.status >= 300),
  ).length,
  transportFailures: evaluatorCalls.filter((r) => r.event === 'failed').length,
  latencyMs: {
    sum: times.reduce((a, b) => a + b, 0),
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    max: times.at(-1),
  },
};
checkFields(cost, expected.cost);
const product = read('results/product-summary.json');
checkFields(usageSummary(productCalls), product.usage);
assert.equal(productCalls.length, product.physicalRequests);
assert.equal(productCalls.filter((r) => r.usage).length, product.usage.known);
assert.equal(productCalls.filter((r) => !r.usage).length, product.usage.unknown);
const courses = read('results/course-availability.json');
assert.equal(courses.length, product.courses);
for (const [flag, field] of Object.entries({
  deliveredLesson: 'withDeliveredLesson',
  tutor: 'withTutor',
  repair: 'withRepair',
  twoRetests: 'withTwoRetests',
  admittedFormal: 'withAdmittedFormal',
  supportedEvidence: 'withSupportedEvidence',
})) {
  assert.equal(courses.filter((r) => r[flag]).length, product[field]);
}

function compare(pairs) {
  const numericPairs = pairs
    .filter(([a, b]) => ['0', '1', '2'].includes(a) && ['0', '1', '2'].includes(b))
    .map(([a, b]) => [Number(a), Number(b)]);
  return {
    n: pairs.length,
    exact: pairs.filter(([a, b]) => a === b).length,
    bothNumeric: numericPairs.length,
    numericExact: numericPairs.filter(([a, b]) => a === b).length,
    adjacent: numericPairs.filter(([a, b]) => Math.abs(a - b) === 1).length,
    leftHigher: numericPairs.filter(([a, b]) => a > b).length,
    leftLower: numericPairs.filter(([a, b]) => a < b).length,
    polarityReversals: numericPairs.filter(([a, b]) => Math.abs(a - b) === 2).length,
    leftUOnly: pairs.filter(([a, b]) => a === 'U' && b !== 'U').length,
    rightUOnly: pairs.filter(([a, b]) => a !== 'U' && b === 'U').length,
    bothU: pairs.filter(([a, b]) => a === 'U' && b === 'U').length,
  };
}
const models = read('results/model-review.json');
const joint = models.jointCounts.flatMap((r) => Array.from({ length: r.count }, () => r));
assert.equal(joint.length, models.judgments);
for (const [a, b] of [
  ['Max', 'Fable'],
  ['StudyEval', 'Max'],
  ['StudyEval', 'Fable'],
]) {
  assert.deepEqual(compare(joint.map((r) => [r[a], r[b]])), models.comparisons[`${a}Vs${b}`]);
}
assert.deepEqual(
  compare(joint.filter((r) => r.Max === r.Fable).map((r) => [r.StudyEval, r.Max])),
  models.comparisons.StudyEvalVsModelConsensus,
);
for (const name of ['StudyEval', 'Max', 'Fable']) {
  const distribution = {};
  for (const r of joint) distribution[r[name]] = (distribution[r[name]] || 0) + 1;
  assert.deepEqual(distribution, models.distributions[name]);
}

console.log(
  JSON.stringify(
    {
      status: 'PASS_OFFLINE_SAVED_EVIDENCE',
      filesVerified: manifest.files.length,
      observationRuns: expected.completedObservations,
      dimensionRows: rows.length,
      primaryCounts: count(primary),
      discrimination,
      consistency,
      adversarial,
      publicCases: registry.length,
      publicObservations: checkedObservations,
      evaluatorCostCNY: cost.estimatedCNY,
      productKnownUsageCostCNY: product.usage.estimatedCNY,
      modelComparisons: models.comparisons,
      scope:
        'Recomputed saved-row statistics, full-corpus length baseline and published model joint counts; checked all 209 inputs/279 observations, schedule and original method hashes. Run verify-human.py to re-extract the six human sheets and compare individual human/model labels. Raw wire replay remains a historical private audit. No evaluator or model executed.',
    },
    null,
    2,
  ),
);
