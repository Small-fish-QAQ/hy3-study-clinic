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
    // Admission and question authoring happen at launch, after the Lesson.
    // One target per checkpoint keeps evidence and repair scoped to that goal.
    if (launch.allowedItemKinds.includes('formal_checkpoint')) {
      for (const objectiveId of unit.blockingEligibleObjectiveIds ?? []) {
        if (!unit.objectiveIds.includes(objectiveId)) continue;
        const title =
          unit.objectiveSummaries?.find((objective) => objective.id === objectiveId)?.title ??
          unit.title;
        items.push({
          key: `check-${unit.id}-${objectiveId}`,
          phase: '正式检查',
          kind: 'formal_checkpoint',
          curriculumLearningUnitId: unit.id,
          rationale: `独立检查：${title}。开始时核对当前原文与评分依据，通过后才计入正式进展。`,
          estimatedMinutes: 5,
          targetDepth: input.contract.desiredDepth,
          objectiveIds: [objectiveId],
          prerequisiteItemKeys: [lastItemByUnit.get(unit.id)!],
        });
        if (input.contract.desiredDepth === 'deep_transfer') {
          if (!launch.allowedItemKinds.includes('synthesis'))
            throw new AppError(
              ApiErrorCode.ValidationError,
              '当前目标没有可执行的综合迁移检查，请重新准备课程。',
            );
          items.push({
            key: `transfer-${unit.id}-${objectiveId}`,
            phase: '综合迁移',
            kind: 'synthesis',
            synthesisMode: 'unit_transfer',
            curriculumLearningUnitId: unit.id,
            rationale: `综合迁移：${title}。构造新情境，用原文解释判断，并比较关键条件变化后的结果；独立评分通过后才计入深度迁移完成。`,
            estimatedMinutes: 10,
            targetDepth: input.contract.desiredDepth,
            objectiveIds: [objectiveId],
            prerequisiteItemKeys: [`check-${unit.id}-${objectiveId}`],
          });
        }
      }
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
