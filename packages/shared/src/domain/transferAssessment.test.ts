import { describe, expect, it } from 'vitest';
import { transferPerformancePassed, TransferPerformanceSchema } from './transferAssessment.js';

describe('transfer performance authority', () => {
  const passed = {
    novelScenario: true,
    sourcePrincipleApplied: true,
    changedConditionExplained: true,
    sourceBounded: true,
    rationale: 'Concrete transfer demonstrated.',
  };
  it('fails closed without all independently graded requirements', () => {
    expect(transferPerformancePassed(undefined)).toBe(false);
    for (const key of [
      'novelScenario',
      'sourcePrincipleApplied',
      'changedConditionExplained',
      'sourceBounded',
    ]) {
      expect(transferPerformancePassed({ ...passed, [key]: false })).toBe(false);
      const missing = { ...passed } as Record<string, unknown>;
      delete missing[key];
      expect(TransferPerformanceSchema.safeParse(missing).success).toBe(false);
    }
    expect(transferPerformancePassed(passed)).toBe(true);
  });
});
