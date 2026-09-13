import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CONFIG } from './prompts.mjs';
import { evaluate } from './evaluator.mjs';
import { createStageRunner } from './provider.mjs';
import { sha } from './contracts.mjs';

const methodRoot = path.dirname(fileURLToPath(import.meta.url)),
  repo = path.resolve(methodRoot, '../..');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((xs, v, i, a) => (i % 2 === 0 ? [...xs, [v.replace(/^--/, ''), a[i + 1]]] : xs), []),
);
for (const name of ['dataset', 'schedule', 'holdout', 'out'])
  if (!args[name])
    throw new Error(
      'Required: --dataset DIRECTORY --schedule FILE --holdout PRIVATE_MANIFEST --out NEW_DIRECTORY',
    );
const dataset = fs.realpathSync(path.resolve(args.dataset)),
  schedule = read(path.resolve(args.schedule)),
  manifestPath = path.resolve(args.holdout),
  manifest = read(manifestPath),
  directory = path.resolve(args.out);
if (
  !Array.isArray(manifest.excludedCaseIds) ||
  !Array.isArray(manifest.excludedInputHashes) ||
  !Array.isArray(schedule)
)
  throw new Error('Invalid schedule or holdout manifest.');
const reservedIds = new Set(manifest.excludedCaseIds),
  reservedHashes = new Set(manifest.excludedInputHashes),
  patterns = (manifest.excludedCasePatterns || []).map((x) => new RegExp(x));
function guard(task) {
  if (
    typeof task.caseId !== 'string' ||
    !task.caseId ||
    typeof task.runId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(task.runId)
  )
    throw new Error('Missing or unsafe task identity.');
  if (
    ['caseId', 'id', 'frozenCaseId', 'baselineCaseId'].some(
      (k) =>
        reservedIds.has(task[k]) ||
        patterns.some((p) => typeof task[k] === 'string' && p.test(task[k])),
    ) ||
    reservedHashes.has(task.inputHash)
  )
    throw new Error('RESERVED_HOLDOUT_REJECTED');
}
schedule.forEach(guard);
if (new Set(schedule.map((x) => x.runId)).size !== schedule.length)
  throw new Error('Duplicate run identity.');
// Read inputs only after their scheduled identities pass the holdout check.
const records = new Map(
  schedule.map((task) => {
    const file = fs.realpathSync(path.resolve(dataset, task.path));
    const relative = path.relative(dataset, file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Input path is outside dataset.');
    const record = read(file),
      inputHash = sha(record);
    guard({ ...task, ...record, inputHash });
    if (task.inputHash !== inputHash) throw new Error('Input differs from frozen schedule.');
    return [task.runId, record];
  }),
);
const req = createRequire(path.join(repo, 'package.json'));
function credentials() {
  const envPath = path.join(repo, '.env'),
    env = {
      ...(fs.existsSync(envPath) ? req('dotenv').parse(fs.readFileSync(envPath)) : {}),
      ...process.env,
    };
  const savedPath = path.resolve(repo, env.PROVIDER_CONFIG_PATH || 'data/provider-config.json');
  const c =
    env.HY3_BASE_URL && env.HY3_MODEL && env.HY3_API_KEY
      ? { baseUrl: env.HY3_BASE_URL, model: env.HY3_MODEL, apiKey: env.HY3_API_KEY }
      : fs.existsSync(savedPath)
        ? read(savedPath)
        : {};
  if (!c.baseUrl || !c.model || !c.apiKey) throw new Error('HY3_CONFIG_INCOMPLETE');
  const u = new URL(c.baseUrl);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error('UNSAFE_ENDPOINT');
  return c;
}
const c = credentials(),
  files = Object.fromEntries(
    fs
      .readdirSync(methodRoot)
      .filter((n) => n.endsWith('.mjs'))
      .sort()
      .map((n) => [n, sha(fs.readFileSync(path.join(methodRoot, n)))]),
  );
const identity = {
  version: CONFIG.version,
  config: CONFIG,
  runtime: files,
  runtimeTreeHash: sha(files),
  model: c.model,
  endpointHost: new URL(c.baseUrl).hostname,
  endpointIdentityHash: sha(c.baseUrl),
  nodeVersion: process.version,
  nodeExecutableHash: sha(fs.readFileSync(process.execPath)),
  scheduleHash: sha(schedule),
  holdoutManifestHash: sha(fs.readFileSync(manifestPath)),
  immutableModelWeightsVerified: false,
};
if (fs.existsSync(directory))
  throw new Error('Output directory must be new; preserve prior campaigns.');
fs.mkdirSync(path.join(directory, 'observations'), { recursive: true });
fs.writeFileSync(path.join(directory, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
fs.writeFileSync(path.join(directory, 'schedule.json'), JSON.stringify(schedule, null, 2) + '\n');
let cursor = 0;
async function worker() {
  while (cursor < schedule.length) {
    const task = schedule[cursor++],
      record = records.get(task.runId);
    guard(task);
    const stage = createStageRunner({
      directory,
      task,
      config: CONFIG,
      credentials,
      identityHash: sha(identity),
      beforeRequest: () => {
        guard(task);
        if (sha(fs.readFileSync(manifestPath)) !== identity.holdoutManifestHash)
          throw new Error('HOLDOUT_MANIFEST_CHANGED');
        const current = credentials();
        if (
          current.model !== identity.model ||
          sha(current.baseUrl) !== identity.endpointIdentityHash
        )
          throw new Error('PROVIDER_CHANGED');
      },
    });
    const evaluation = await evaluate(record, { stage });
    fs.writeFileSync(
      path.join(directory, 'observations', task.runId + '.json'),
      JSON.stringify(
        { task, inputHash: task.inputHash, identityHash: sha(identity), evaluation },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        runId: task.runId,
        status: evaluation.result.status,
        levels: evaluation.result.dimensions?.map((d) => [d.dimension, d.level]),
      }),
    );
  }
}
await Promise.all(Array.from({ length: CONFIG.concurrency }, worker));
const rows = schedule.flatMap((task) => {
  const o = read(path.join(directory, 'observations', task.runId + '.json'));
  return records
    .get(task.runId)
    .dimensions.map((d) => ({
      runId: task.runId,
      caseId: task.caseId,
      replicate: task.replicate || 1,
      dimension: d,
      level: o.evaluation.result.dimensions?.find((x) => x.dimension === d)?.level ?? 'INVALID',
      reason:
        o.evaluation.result.dimensions?.find((x) => x.dimension === d)?.reason ??
        o.evaluation.result.reason,
    }));
});
fs.writeFileSync(path.join(directory, 'rows.json'), JSON.stringify(rows, null, 2) + '\n');
const columns = ['runId', 'caseId', 'replicate', 'dimension', 'level', 'reason'],
  quote = (x) => '"' + String(x ?? '').replaceAll('"', '""') + '"';
fs.writeFileSync(
  path.join(directory, 'results.csv'),
  columns.join(',') +
    '\n' +
    rows.map((r) => columns.map((k) => quote(r[k])).join(',')).join('\n') +
    '\n',
);
