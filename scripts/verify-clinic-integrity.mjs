import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output/architecture-implementation');
mkdirSync(output, { recursive: true });
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const baseline = JSON.parse(readFileSync(path.join(output, 'baseline.json'), 'utf8'));
const preservation = baseline.entries.map((entry) => ({
  file: entry.file,
  preserved:
    existsSync(path.join(output, 'source-snapshot', entry.file)) &&
    digest(path.join(output, 'source-snapshot', entry.file)) === entry.sha256,
}));
if (preservation.some((row) => !row.preserved))
  throw new Error('Protected source snapshot failed hash verification.');
const modifications = baseline.entries
  .filter((entry) => entry.file.startsWith('apps/') || entry.file.startsWith('packages/'))
  .map((entry) => ({
    file: entry.file,
    change: !existsSync(path.join(root, entry.file))
      ? 'retired'
      : digest(path.join(root, entry.file)) === entry.sha256
        ? 'unchanged'
        : 'modified',
  }));
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(path.join(directory, entry.name))
      : [path.join(directory, entry.name)],
  );
const productionFiles = ['apps/server/src', 'apps/web/src', 'packages/shared/src']
  .flatMap((dir) => walk(path.join(root, dir)))
  .filter(
    (file) =>
      /\.(ts|tsx)$/u.test(file) &&
      !file.includes('.test.') &&
      !file.includes(`${path.sep}testing${path.sep}`),
  );
const forbidden =
  /reviewTeachingContent|proposeCurriculumDetails|reviewCurriculumCoverage|proposeTutorStep|MAX_MACHINE_TRANSITIONS|legacy_unverified|repairEpisode|mastery_states|hasAcceptedLesson|hasAcceptedPractice|MAX_DETAIL_BATCHES/u;
const violations = productionFiles
  .filter((file) => forbidden.test(readFileSync(file, 'utf8')))
  .map((file) => path.relative(root, file));
if (violations.length)
  throw new Error(`Retired runtime dependencies remain: ${violations.join(', ')}`);
const status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
const result = {
  passed: true,
  verifiedAt: new Date().toISOString(),
  protectedFiles: preservation.length,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  baselineHead: baseline.head,
  productionFiles: productionFiles.length,
  retiredDependencyViolations: violations,
  modifications,
  gitStatus: status,
};
if (result.head !== baseline.head) throw new Error('HEAD changed unexpectedly.');
writeFileSync(path.join(output, 'source-integrity-final.json'), JSON.stringify(result, null, 2));
const changeScope = [
  '.github/',
  'apps/',
  'packages/',
  'scripts/',
  'docs/',
  'README.md',
  'package.json',
  'package-lock.json',
  '.env.example',
  '.gitignore',
  '.prettierignore',
];
const inScope = (file) =>
  changeScope.some((prefix) => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix));
const baselineFiles = new Set(baseline.entries.map((entry) => entry.file));
const currentFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...changeScope],
  { cwd: root, encoding: 'utf8' },
)
  .split(/\r?\n/u)
  .filter(Boolean)
  .filter((file) => existsSync(path.join(root, file)));
const changes = [
  ...baseline.entries
    .filter((entry) => inScope(entry.file))
    .map((entry) => ({
      file: entry.file,
      change: !existsSync(path.join(root, entry.file))
        ? 'retired'
        : digest(path.join(root, entry.file)) === entry.sha256
          ? 'unchanged'
          : 'modified',
    }))
    .filter((entry) => entry.change !== 'unchanged'),
  ...currentFiles
    .filter((file) => !baselineFiles.has(file))
    .map((file) => ({ file, change: 'added' })),
].sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(
  path.join(output, 'implementation-changes.json'),
  JSON.stringify(
    {
      verifiedAt: result.verifiedAt,
      baselineHead: baseline.head,
      comparedWith: 'protected dirty working tree baseline, including untracked Phase 4 files',
      counts: changes.reduce(
        (counts, row) => ({ ...counts, [row.change]: (counts[row.change] ?? 0) + 1 }),
        {},
      ),
      changes,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      passed: result.passed,
      protectedFiles: result.protectedFiles,
      productionFiles: result.productionFiles,
      modificationCounts: modifications.reduce(
        (counts, row) => ({ ...counts, [row.change]: (counts[row.change] ?? 0) + 1 }),
        {},
      ),
      headUnchanged: true,
    },
    null,
    2,
  ),
);
