import type { GraphRelation } from '@hy3-clinic/shared';

/** Chinese display labels for the six controlled relation types. */
export const RELATION_LABELS: Record<GraphRelation, string> = {
  prerequisite: '先修',
  part_of: '组成',
  contrasts_with: '对比',
  causes: '因果',
  applies_to: '应用',
  example_of: '示例',
};

/**
 * Restrained semantic relation colors (slate blue / moss / amber / muted red /
 * teal / slate). Full strength is reserved for selected or hovered
 * neighborhoods; the default edge state renders these through a low group
 * opacity so nodes stay the visual focus.
 */
export const RELATION_COLORS: Record<GraphRelation, string> = {
  prerequisite: '#587990',
  part_of: '#68856a',
  contrasts_with: '#b58a46',
  causes: '#af6657',
  applies_to: '#417f79',
  example_of: '#7c8193',
};

/** Dash patterns keep relation types distinguishable without color alone. */
export const RELATION_DASH: Partial<Record<GraphRelation, string>> = {
  contrasts_with: '7 5',
  example_of: '2 4',
};

/** contrasts_with is semantically symmetric — it never gets an arrowhead. */
export function relationHasDirection(relation: GraphRelation): boolean {
  return relation !== 'contrasts_with';
}

/** Stable marker element IDs (no per-hover-state marker churn). */
export function markerId(relation: GraphRelation, strong: boolean): string {
  return `hy3-arrow-${relation}${strong ? '-strong' : ''}`;
}
