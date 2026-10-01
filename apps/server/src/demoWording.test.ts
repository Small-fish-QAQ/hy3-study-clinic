import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
    expect(readme).toMatch(/离线[^。\n]*重复运行/u);
    expect(readme).toMatch(/(?:内容|排序)[^。\n]*可能(?:变化|不同)/u);
    const architecture = read('docs/ARCHITECTURE.md');
    expect(architecture).toMatch(/离线[^。\n]*重复运行/u);
    expect(architecture).toMatch(/(?:标识|排序)[^。\n]*可能(?:变化|不同)/u);
    expect(architecture).toMatch(/不能承诺[^。\n]*相同的输出/u);
  });
});
