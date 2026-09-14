import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, read, write, sha, filesUnder } from './common.mjs';
import { PRODUCT, configFromEnvironment } from '../product/runtime.mjs';

const candidate = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(candidate || '')) throw Error('Full frozen Candidate 23 commit required');
if (candidate !== '84b3c2fbce7e6523e43a8fa66df42bb6e37fa149') throw Error('Only frozen Candidate 23 may run this showcase');
if (fs.existsSync(path.join(ROOT, 'FREEZE.json'))) throw Error('Already frozen');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PRODUCT, encoding: 'utf8' }).trim();
if (head !== candidate) throw Error('Product checkout must be at the Candidate 23 freeze commit');
if (execFileSync('git', ['diff', 'HEAD', '--', 'apps', 'packages'], { cwd: PRODUCT, encoding: 'utf8' }).trim()) throw Error('Product checkout is modified');
const schedule = read(path.join(ROOT, 'dataset/schedule.json'));
const audit = read(path.join(ROOT, 'dataset/source-audit.json'));
if (schedule.length !== 20 || new Set(schedule.map(c => c.sourceId)).size !== 20) throw Error('Invalid denominator');
if (fs.existsSync(path.join(ROOT, 'runs'))) throw Error('Scored outputs exist before freeze');
if (!audit.passed || audit.rows.length !== schedule.length) throw Error('Source/freshness audit incomplete');
for (const row of schedule) {
  const source = read(path.join(ROOT, row.path));
  const check = audit.rows.find(r => r.id === row.sourceId);
  if (!check || check.fileSha256 !== sha(fs.readFileSync(path.join(ROOT, row.path)))) throw Error('Source changed after audit');
  if ((source.id || source.sourceId) !== row.sourceId) throw Error('Wrong course identity');
}
const files = {};
for (const directory of ['dataset', 'product', 'scripts']) {
  for (const p of filesUnder(path.join(ROOT, directory))) {
    const relative = path.join(directory, p).replaceAll('\\', '/');
    files[relative] = sha(fs.readFileSync(path.join(ROOT, relative)));
  }
}
for (const file of ['PROTOCOL.md', 'DESIGN.md', 'checks/projection.json']) files[file] = sha(fs.readFileSync(path.join(ROOT, file)));
if (!read(path.join(ROOT, 'checks/projection.json')).passed) throw Error('Learner projection preflight failed');
const productFiles = {};
for (const directory of ['apps/server/src', 'apps/server/dist', 'apps/web/src', 'packages/shared/src', 'packages/shared/dist']) {
  for (const p of filesUnder(path.join(PRODUCT, directory))) {
    const relative = path.join(directory, p).replaceAll('\\', '/');
    productFiles[relative] = sha(fs.readFileSync(path.join(PRODUCT, relative)));
  }
}
const config = configFromEnvironment();
const freeze = { frozenAt: new Date().toISOString(), kind: 'FRESH_NORMAL_USE_PRODUCT_SHOWCASE', productCommit: candidate,
  designObjective: 'Reviewer-facing product demonstration quality with complete, self-contained, well-supported normal-use materials',
  evaluatorCommit: '64fdbc4d5fdcfffc3e10132f5881dec334803b8f', denominator: schedule.length,
  files, productFiles, filesTreeHash: sha(JSON.stringify(files)), productTreeHash: sha(JSON.stringify(productFiles)),
  provider: { model: config.model, endpointHost: new URL(config.baseUrl).hostname, endpointIdentityHash: sha(config.baseUrl), immutableWeightsVerified: false },
  nodeVersion: process.version, concurrency: 6, selectiveReruns: false, scheduledSources: schedule.map(c => c.sourceId) };
write(path.join(ROOT, 'FREEZE.json'), freeze);
write(path.join(ROOT, 'FREEZE-RECEIPT.json'), { frozenAt: freeze.frozenAt, sha256: sha(fs.readFileSync(path.join(ROOT, 'FREEZE.json'))) });
console.log(JSON.stringify({ denominator: freeze.denominator, productCommit: candidate, freezeSha256: sha(fs.readFileSync(path.join(ROOT, 'FREEZE.json'))) }));
