import type {
  Curriculum,
  LearningContract,
  StudyPlanFeasibility,
  StudyPlanRecommendation,
} from '@hy3-clinic/shared';

/**
 * Recommendations are deterministic and inspectable. They describe choices
 * for the learner; they never remove Curriculum objectives themselves.
 */
export function buildPlanningRecommendations(
  contract: LearningContract,
  curriculum: Curriculum,
  feasibility: StudyPlanFeasibility,
): StudyPlanRecommendation[] {
  // Without a learner-owned time budget/deadline there is no schedule shortfall to
  // remediate. The projected duration remains advisory output, not a prompt to reduce
  // depth, scope, or move a completion date.
  if (
    feasibility.projectedMinutes <= 0 ||
    feasibility.availableMinutes === null ||
    feasibility.state === 'feasible'
  )
    return [];
  const units = curriculum.nodes
    .filter((node) => node.kind === 'learning_unit' && node.learningUnit)
    .sort((left, right) => left.index - right.index);
  const optionalUnitIds = units
    .filter((node) =>
      node.learningUnit!.objectives.every((objective) => objective.priority === 'optional'),
    )
    .map((node) => node.id);
  const recommendations: StudyPlanRecommendation[] = [
    {
      kind: 'keep_full_scope',
      rationale:
        'Keep the complete accepted Curriculum and accept that the target date may be missed; no content is removed.',
      affectedCurriculumLearningUnitIds: [],
      projectedMinutes: feasibility.projectedMinutes,
      learnerDecision: 'pending',
    },
    {
      kind: 'increase_study_effort',
      rationale:
        'Increase expected study effort or session frequency to reduce the projected deadline risk.',
      affectedCurriculumLearningUnitIds: [],
      projectedMinutes: feasibility.availableMinutes,
      learnerDecision: 'pending',
    },
    {
      kind: 'reduce_teaching_depth',
      rationale: `Reduce explanation, examples, and routine practice while preserving required objectives at the selected depth (${contract.desiredDepth}).`,
      affectedCurriculumLearningUnitIds: units.map((unit) => unit.id),
      projectedMinutes: feasibility.availableMinutes,
      learnerDecision: 'pending',
    },
  ];
  if (optionalUnitIds.length > 0) {
    recommendations.push({
      kind: 'defer_optional_content',
      rationale:
        'Only optional/enrichment objectives are candidates for deferral; required and high-priority work stays in scope.',
      affectedCurriculumLearningUnitIds: optionalUnitIds,
      projectedMinutes: feasibility.availableMinutes,
      learnerDecision: 'pending',
    });
  }
  recommendations.push(
    {
      kind: 'narrow_learner_scope',
      rationale:
        'Choose a smaller learner-owned scope explicitly; the accepted Curriculum remains complete and auditable.',
      affectedCurriculumLearningUnitIds: [],
      projectedMinutes: feasibility.availableMinutes,
      learnerDecision: 'pending',
    },
    {
      kind: 'change_deadline',
      rationale: 'Move the target date and create a successor Contract/StudyPlan proposal.',
      affectedCurriculumLearningUnitIds: [],
      projectedMinutes: feasibility.projectedMinutes,
      learnerDecision: 'pending',
    },
  );
  return recommendations;
}
