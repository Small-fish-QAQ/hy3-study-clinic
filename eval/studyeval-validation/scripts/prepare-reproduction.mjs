import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] && path.resolve(process.argv[2]);
if (!target || fs.existsSync(target)) throw Error('An unused reproduction-plan directory is required');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const original = read('fresh/schedule.json');
const human = read('human/schedule.json');
const schedule = original.map(task => ({ ...task, path: task.caseId + '.json' }));
for (const task of schedule) {
  const input = read('fresh/inputs/' + task.path);
  const hash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  if (hash !== task.inputHash) throw Error('Published input hash differs');
}
fs.mkdirSync(target, { recursive: true });
const write = (file, value) => fs.writeFileSync(path.join(target, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
write('schedule.json', schedule);
write('human-exclusion.json', { excludedCaseIds: [...new Set(human.map(t => t.caseId))],
  excludedInputHashes: [...new Set(human.map(t => t.inputHash))], excludedCasePatterns: [] });
write('ADAPTATION.json', { preparedAt: new Date().toISOString(), source: 'fresh/schedule.json',
  changes: 'Path-only adaptation to the published fresh/inputs directory. No input, result, case or replicate change.', observations: schedule.length });
console.log(JSON.stringify({ target, observations: schedule.length, modelCalls: 0 }));
