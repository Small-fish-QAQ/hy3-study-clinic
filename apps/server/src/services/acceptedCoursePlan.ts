import {
  ApiErrorCode,
  StudyPlanProposalPayloadSchema,
  type StudyPlanProposalPayload,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { StudyPlanProposalInput } from '../llm/provider.js';

const OBJECTIVES_PER_LESSON = 2;

/** Compile the learner's accepted course into its ordinary teaching route.
 * Curriculum owns scope/order; Depth is fixed; duration is derived downstream.
 * Formal admission, credit and later adaptive planning remain separate authorities.
 */
export function deriveAcceptedCoursePlan(input: StudyPlanProposalInput): StudyPlanProposalPayload {
  const required = new Set(input.requiredLearningUnitIds);
  const pending = input.units.filter((unit) => required.has(unit.id));
  const keys = new Map(pending.map((unit, index) => [unit.id, `teach-${index + 1}`]));
  const lastItemByUnit = new Map<string, string>();
  const seen = new Set<string>();
  const items: StudyPlanProposalPayload['items'] = [];
  while (pending.length) {
    const index = pending.findIndex((unit) => unit.prerequisiteUnitIds.every((id) => seen.has(id)));
    if (index < 0)
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Accepted course prerequisites do not form an executable teaching order.',
      );
    const unit = pending.splice(index, 1)[0]!;
    const launch = input.launchCapabilities.find(
      (capability) => capability.curriculumLearningUnitId === unit.id,
    );
    if (!launch?.allowedItemKinds.includes('teach_unit'))
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Accepted course unit has no current teaching capability.',
      );
    const parts: string[][] = [];
    for (let start = 0; start < unit.objectiveIds.length; start += OBJECTIVES_PER_LESSON)
      parts.push(unit.objectiveIds.slice(start, start + OBJECTIVES_PER_LESSON));
    for (const [index, objectiveIds] of parts.entries()) {
      const key = parts.length === 1 ? keys.get(unit.id)! : `${keys.get(unit.id)!}-${index + 1}`;
      items.push({
        key,
        phase: '课程学习',
        kind: 'teach_unit',
        curriculumLearningUnitId: unit.id,
        rationale: `学习${unit.title}${parts.length > 1 ? `（第${index + 1}/${parts.length}节）` : ''}，完成已确认的学习目标。`,
        estimatedMinutes: 1,
        targetDepth: input.contract.desiredDepth,
        objectiveIds,
        prerequisiteItemKeys:
          index > 0
            ? [lastItemByUnit.get(unit.id)!]
            : unit.prerequisiteUnitIds.map((id) => lastItemByUnit.get(id)!),
      });
      lastItemByUnit.set(unit.id, key);
    }
    seen.add(unit.id);
  }
  if (seen.size !== required.size)
    throw new AppError(ApiErrorCode.ValidationError, 'Accepted course scope is incomplete.');
  return StudyPlanProposalPayloadSchema.parse({
    rationale: '按已接受的课程结构和全局学习深度安排学习；正式检验仍由独立的准入与证据规则决定。',
    items,
    deferrals: [],
  });
}
