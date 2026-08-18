import { describe, expect, it } from 'vitest';
import {
  evaluateTutorPedagogyProfile,
  TUTOR_PEDAGOGY_PROFILE,
  TUTOR_PEDAGOGY_SCENARIOS,
} from './tutorPedagogy.js';

describe('Tutor pedagogy offline profile', () => {
  it('covers the Phase 5A scenario suite with deterministic policy checks', () => {
    const result = evaluateTutorPedagogyProfile();
    expect(result.profile.name).toBe('lesson-aware-tutor-v1');
    expect(TUTOR_PEDAGOGY_SCENARIOS).toHaveLength(23);
    expect(result.scenarios).toHaveLength(23);
    expect(result.deterministicPass).toBe(true);
    expect(result.nonAuthorityMutation).toBe(true);
    expect(result.scenarios.every((scenario) => scenario.passed)).toBe(true);
  });

  it('keeps deterministic and human/model-judged dimensions separate', () => {
    expect(TUTOR_PEDAGOGY_PROFILE.deterministic).toContain('authority_safe');
    expect(TUTOR_PEDAGOGY_PROFILE.heuristic).toContain('move_diversity');
    expect(TUTOR_PEDAGOGY_PROFILE.modelHumanJudged).toContain('helpfulness');
    expect(TUTOR_PEDAGOGY_PROFILE.modelHumanJudged).not.toContain('mastery');
  });
});
