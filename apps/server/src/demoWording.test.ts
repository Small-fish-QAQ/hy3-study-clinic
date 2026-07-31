import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Offline-demo wording regression (crossing-minimization task, Part 11).
 *
 * The offline demo guarantees that the complete WORKFLOW can be repeated
 * without a network or API key; it must NOT claim bit-for-bit reproducible
 * result output (concept order, selected weak concepts, generated questions,
 * and mastery outcomes may legitimately vary between runs — observed in real
 * back-to-back runs). Genuinely deterministic local logic (segmentation,
 * objective grading, the EMA mastery formula) keeps its deterministic
 * description.
 */

const repoRoot = resolve(process.cwd(), '..', '..');
const read = (relativePath: string): string =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8');

describe('offline demo wording', () => {
  it('demo-offline no longer claims reproducible result output', () => {
    const script = read('scripts/demo-offline.mjs');
    expect(script).not.toContain('结果可复现');
    // States offline repeatability of the workflow…
    expect(script).toContain('无网络、无 API Key 的环境下重复运行');
    // …and that generated content/order may vary.
    expect(script).toContain('具体生成内容与排序可能变化');
  });

  it('keeps deterministic descriptions for genuinely deterministic local logic', () => {
    const script = read('scripts/demo-offline.mjs');
    expect(script).toContain('确定性切分');
    expect(script).toContain('确定性 EMA 公式');
  });

  it('README and architecture docs distinguish workflow repeatability from output identity', () => {
    const readme = read('README.md');
    expect(readme).not.toContain('结果可复现');
    expect(readme).toContain('may vary between runs');
    const architecture = read('docs/ARCHITECTURE.md');
    expect(architecture).toContain('workflow can be repeated offline');
    expect(architecture).toContain('does not promise byte-identical output');
  });
});
