import { describe, expect, it } from 'vitest';
import {
  RepairDiagnosticCategorySchema,
  isRepairTransitionAllowed,
  repairCheckIntentLadderFor,
  repairInterventionFor,
  repairInterventionLadderFor,
  selectRepairDifferentiation,
} from './repair.js';
import { MasteryChallengeFamilySchema } from './assessmentIntent.js';

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

describe('Repair differentiation policy', () => {
  const categories = RepairDiagnosticCategorySchema.options;

  it('reuses existing vocabulary only, with no parallel taxonomy', () => {
    const families = new Set<string>(MasteryChallengeFamilySchema.options);
    for (const category of categories) {
      for (const intent of repairCheckIntentLadderFor(category)) {
        expect(families.has(intent)).toBe(true);
      }
    }
  });

  it('leaves a first Repair identical to the pre-differentiation choice', () => {
    for (const category of categories) {
      expect(repairInterventionLadderFor(category)[0]).toBe(repairInterventionFor(category));
      const first = selectRepairDifferentiation({
        category,
        priorInterventionModes: [],
        priorCheckIntents: [],
      });
      expect(first.requiredInterventionMode).toBe(repairInterventionFor(category));
      expect(first.interventionLadderExhausted).toBe(false);
      expect(first.structuralDifferentiationOnly).toBe(false);
    }
  });

  it('never offers the same ladder position twice', () => {
    for (const category of categories) {
      const modes = repairInterventionLadderFor(category);
      const intents = repairCheckIntentLadderFor(category);
      expect(new Set(modes).size).toBe(modes.length);
      expect(new Set(intents).size).toBe(intents.length);
    }
  });

  it('moves to a different strategy and intent once one has been used', () => {
    const second = selectRepairDifferentiation({
      category: 'LOCAL_MISCONCEPTION',
      priorInterventionModes: ['CONTRAST'],
      priorCheckIntents: ['historical_misconception'],
    });
    expect(second.requiredInterventionMode).not.toBe('CONTRAST');
    expect(second.requiredCheckIntent).not.toBe('historical_misconception');
    expect(second.structuralDifferentiationOnly).toBe(false);
  });

  it('walks the whole ladder without repeating across successive rounds', () => {
    const modes = repairInterventionLadderFor('INCOMPLETE_EXPRESSION');
    const seen: (typeof modes)[number][] = [];
    for (let round = 0; round < modes.length; round++) {
      const step = selectRepairDifferentiation({
        category: 'INCOMPLETE_EXPRESSION',
        priorInterventionModes: seen,
        priorCheckIntents: [],
      });
      expect(seen).not.toContain(step.requiredInterventionMode);
      seen.push(step.requiredInterventionMode);
    }
    expect(seen).toEqual([...modes]);
  });

  it('reports exhaustion instead of inventing an intent outside the vocabulary', () => {
    // SURFACE_SLIP has exactly one legitimate intent, so there is no alternative.
    const intents = repairCheckIntentLadderFor('SURFACE_SLIP');
    expect(intents).toHaveLength(1);
    const exhausted = selectRepairDifferentiation({
      category: 'SURFACE_SLIP',
      priorInterventionModes: [],
      priorCheckIntents: [...intents],
    });
    expect(exhausted.checkIntentLadderExhausted).toBe(true);
    expect(exhausted.requiredCheckIntent).toBe(intents[0]);
    // The strategy axis can still change, so structure is not the only recourse.
    expect(exhausted.interventionLadderExhausted).toBe(false);
    expect(exhausted.structuralDifferentiationOnly).toBe(false);
  });

  it('falls back to structural difference only when both axes are spent', () => {
    const spent = selectRepairDifferentiation({
      category: 'SURFACE_SLIP',
      priorInterventionModes: [...repairInterventionLadderFor('SURFACE_SLIP')],
      priorCheckIntents: [...repairCheckIntentLadderFor('SURFACE_SLIP')],
    });
    expect(spent.structuralDifferentiationOnly).toBe(true);
    // Still a permitted mode and intent, never an invented one.
    expect(repairInterventionLadderFor('SURFACE_SLIP')).toContain(spent.requiredInterventionMode);
    expect(repairCheckIntentLadderFor('SURFACE_SLIP')).toContain(spent.requiredCheckIntent);
  });

  it('ignores history that belongs to another diagnosis', () => {
    const unrelated = selectRepairDifferentiation({
      category: 'PROCEDURAL_GAP',
      // Modes/intents that are not on PROCEDURAL_GAP's ladders at all.
      priorInterventionModes: ['PREREQUISITE_REVIEW', 'NOTICE', 'CLARIFY'],
      priorCheckIntents: ['transfer', 'historical_misconception'],
    });
    expect(unrelated.requiredInterventionMode).toBe(repairInterventionFor('PROCEDURAL_GAP'));
    expect(unrelated.requiredCheckIntent).toBe(repairCheckIntentLadderFor('PROCEDURAL_GAP')[0]);
    expect(unrelated.structuralDifferentiationOnly).toBe(false);
  });

  it('is a pure function of its inputs', () => {
    const args = {
      category: 'RELATION_REVERSAL' as const,
      priorInterventionModes: ['CONTRAST' as const],
      priorCheckIntents: ['near_neighbor_confusion' as const],
    };
    expect(selectRepairDifferentiation(args)).toEqual(selectRepairDifferentiation(args));
  });
});
