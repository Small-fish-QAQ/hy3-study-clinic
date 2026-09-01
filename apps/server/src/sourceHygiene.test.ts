import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Tracked-source control-byte regression.
 *
 * A single raw NUL makes Git classify a blob as binary, and from then on
 * `git diff`, `--stat` and `--numstat` print only "Binary files differ" for it.
 * That silently removes the file from ordinary review even though it compiles
 * and its tests pass. One such byte reached an accepted commit in this
 * repository via a literal \u0000 escape that an editing tool decoded, so the
 * guard is a scan rather than a convention.
 *
 * Scope is every path Git tracks. Deliberate binary fixtures (real .docx bytes
 * are the point of those files) are separated by extension rather than skipped
 * silently, so a new binary type has to be declared here to pass.
 */

/**
 * Ask Git for the repository root rather than deriving it from `process.cwd()`.
 * Vitest's cwd differs between a per-workspace `npm test` run and an explicit
 * `--root apps/server` run, and a wrong root here would resolve outside the
 * repository and fail for a reason that has nothing to do with source hygiene.
 */
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: dirname(fileURLToPath(import.meta.url)),
})
  .toString('utf8')
  .trim();

const DECLARED_BINARY = /\.(docx|pdf|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|zip|db|sqlite3?|wasm)$/iu;

/** TAB and LF are ordinary text; CR is legal too and does not trigger binary. */
const isForbiddenControlByte = (byte: number): boolean =>
  (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127;

function trackedFiles(): string[] {
  return execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

interface Violation {
  path: string;
  offset: number;
  byte: string;
}

function scanTrackedSource(): { violations: Violation[]; textFiles: number } {
  const violations: Violation[] = [];
  let textFiles = 0;
  for (const relativePath of trackedFiles()) {
    if (DECLARED_BINARY.test(relativePath)) continue;
    const absolutePath = resolve(repoRoot, relativePath);
    let stats;
    try {
      stats = statSync(absolutePath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    textFiles += 1;
    const contents = readFileSync(absolutePath);
    for (let offset = 0; offset < contents.length; offset += 1) {
      const byte = contents[offset]!;
      if (!isForbiddenControlByte(byte)) continue;
      violations.push({
        path: relativePath,
        offset,
        byte: `0x${byte.toString(16).padStart(2, '0')}`,
      });
      break;
    }
  }
  return { violations, textFiles };
}

describe('tracked source hygiene', () => {
  it('contains no control bytes that would make Git treat source as binary', () => {
    const { violations, textFiles } = scanTrackedSource();
    expect(textFiles).toBeGreaterThan(100);
    expect(violations).toEqual([]);
  });

  it('keeps the canonical-ordering source reviewable as text', () => {
    const orderingSource = readFileSync(
      resolve(repoRoot, 'apps/server/src/services/courseMapOrdering.ts'),
      'utf8',
    );
    for (const character of orderingSource) {
      const code = character.codePointAt(0)!;
      expect(isForbiddenControlByte(code)).toBe(false);
    }
    expect(orderingSource).not.toContain(String.fromCharCode(0));
  });

  it('detects a control byte when one is present', () => {
    expect(isForbiddenControlByte(0x00)).toBe(true);
    expect(isForbiddenControlByte(0x1f)).toBe(true);
    expect(isForbiddenControlByte(0x7f)).toBe(true);
    expect(isForbiddenControlByte(0x09)).toBe(false);
    expect(isForbiddenControlByte(0x0a)).toBe(false);
    expect(isForbiddenControlByte(0x0d)).toBe(false);
    expect(isForbiddenControlByte(0x41)).toBe(false);
  });
});
