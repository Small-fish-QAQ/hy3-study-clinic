import { describe, expect, it } from 'vitest';
import { isRepairTransitionAllowed, repairInterventionFor } from './repair.js';

describe('Repair domain policy', () => {
  it('maps bounded diagnoses to minimum sufficient interventions', () => {
    expect(repairInterventionFor('INCOMPLETE_EXPRESSION')).toBe('TARGETED_PROMPT');
    expect(repairInterventionFor('RELATION_REVERSAL')).toBe('CONTRAST');
    expect(repairInterventionFor('PREREQUISITE_GAP')).toBe('PREREQUISITE_REVIEW');
    expect(repairInterventionFor('UNCERTAIN')).toBe('CLARIFY');
  });

  it('keeps terminal states terminal and allows learner deferral', () => {
    expect(isRepairTransitionAllowed('ACTIVE', 'DEFERRED')).toBe(true);
    expect(isRepairTransitionAllowed('DEFERRED', 'ACTIVE')).toBe(true);
    expect(isRepairTransitionAllowed('RESOLVED', 'ACTIVE')).toBe(false);
    expect(isRepairTransitionAllowed('CANCELLED', 'RESOLVED')).toBe(false);
  });
});
