import type { FormalAssessmentConstruct } from '@hy3-clinic/shared';

/**
 * The minimum an objective must expose to derive its teaching construct. Kept as a
 * structural type so both an accepted `CurriculumObjective` and a Brief objective
 * satisfy it without either module importing the other.
 */
export interface TeachingConstructObjective {
  title: string;
  description: string;
  formalAssessmentConstruct?: FormalAssessmentConstruct;
}

/**
 * Pure teaching-construct derivation, shared by Lesson preparation and StudyPlan
 * plannability resolution so the two can never disagree. A declared construct wins;
 * otherwise a bilingual cue decides between `explain` and `identify`.
 *
 * Undeclared objectives resolve to `identify`, the cheapest shape in slots. Both
 * callers inherit that optimism identically, which is the property that matters:
 * the gate must match the planner, not be more conservative than it.
 */
export function deriveTeachingConstruct(
  objective: TeachingConstructObjective,
): FormalAssessmentConstruct {
  if (objective.formalAssessmentConstruct) return objective.formalAssessmentConstruct;
  return /(?:\b(?:explain|why|how|reason|mechanism)\b|解释|为什么|如何|原因|机制)/iu.test(
    `${objective.title} ${objective.description}`,
  )
    ? 'explain'
    : 'identify';
}
