import fs from 'node:fs';
import path from 'node:path';
import { ROOT, read, write, sha, verifyFiles } from './common.mjs';
import { PRODUCT, configFromEnvironment } from '../product/runtime.mjs';
import { runCourse } from '../product/run-course.mjs';

const name = process.argv[2] || 'scored-01';
if (!/^[a-z0-9-]+$/.test(name)) throw Error('Invalid run identity');
const runRoot = path.join(ROOT, 'runs', name);
if (fs.existsSync(runRoot)) throw Error('Run outputs are append-only');
const freeze = read(path.join(ROOT, 'FREEZE.json'));
if (sha(fs.readFileSync(path.join(ROOT, 'FREEZE.json'))) !== read(path.join(ROOT, 'FREEZE-RECEIPT.json')).sha256) throw Error('Freeze receipt differs');
verifyFiles(ROOT, freeze.files);
verifyFiles(PRODUCT, freeze.productFiles);
configFromEnvironment();
const schedule = read(path.join(ROOT, 'dataset/schedule.json'));
if (JSON.stringify(schedule.map(c => c.sourceId)) !== JSON.stringify(freeze.scheduledSources)) throw Error('Denominator differs');
write(path.join(runRoot, 'identity.json'), { startedAt: new Date().toISOString(), suite: 'fresh-showcase', completeSuite: true,
  schedule, productCommit: freeze.productCommit, freezeSha256: sha(fs.readFileSync(path.join(ROOT, 'FREEZE.json'))), provider: freeze.provider,
  concurrency: freeze.concurrency, actualProductRoot: PRODUCT, nodeVersion: process.version });
write(path.join(runRoot, 'schedule.json'), schedule);
let cursor = 0;
const results = [];
async function worker() {
  while (cursor < schedule.length) {
    const row = schedule[cursor++];
    console.log(JSON.stringify({ event: 'started', id: row.sourceId }));
    try {
      const state = await runCourse(read(path.join(ROOT, row.path)), { runRoot, providerName: 'hy3', ...row });
      const result = { id: row.sourceId, status: state.status, teaching: state.teaching.map(x => x.status),
        formal: state.formal.map(x => ({ status: x.status, demonstrated: x.result?.result?.demonstrated, error: x.error, reason: x.reason })), counts: state.counts };
      results.push(result);
      console.log(JSON.stringify({ event: 'completed', ...result }));
    } catch (e) {
      const result = { id: row.sourceId, status: 'driver_failed', error: e.message };
      results.push(result);
      console.log(JSON.stringify({ event: 'completed', ...result }));
    }
  }
}
await Promise.all(Array.from({ length: freeze.concurrency }, worker));
verifyFiles(ROOT, freeze.files);
verifyFiles(PRODUCT, freeze.productFiles);
write(path.join(runRoot, 'complete.json'), { completedAt: new Date().toISOString(), results,
  inputsUnchanged: true, runtimeUnchanged: true, productUnchanged: true });
