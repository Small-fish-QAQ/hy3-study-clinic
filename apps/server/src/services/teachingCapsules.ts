import type {
  TeachingSkeleton,
  TeachingLessonSlotContent,
  LessonSlotContentProposalPayload,
  PracticeContentProposalPayload,
} from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  TeachingCapsuleGenerationInput,
} from '../llm/provider.js';

export function capsuleInputs(
  lesson: LessonSlotContentGenerationInput,
  skeleton: TeachingSkeleton,
): TeachingCapsuleGenerationInput[] {
  const interactionSlotId =
    skeleton.lessonSlots.find((s) => s.qualityContract === 'worked_process')?.slotId ??
    (lesson.courseDesign && lesson.courseDesign.desiredDepth !== 'pass_oriented'
      ? skeleton.lessonSlots.find((s) => s.learnerActionRequired)?.slotId
      : undefined) ??
    null;
  const groups = new Map<string, typeof skeleton.lessonSlots>();
  for (const slot of skeleton.lessonSlots) {
    const key = slot.objectiveRefs[0]!;
    groups.set(key, [...(groups.get(key) ?? []), slot]);
  }
  const inputs: TeachingCapsuleGenerationInput[] = [];
  for (const [objectiveRef, slots] of groups) {
    for (let start = 0; start < slots.length; start += 4) {
      const lessonSlots = slots.slice(start, start + 4);
      const practiceSlots =
        start + 4 >= slots.length
          ? skeleton.practicePlan.slots.filter((p) => p.objectiveRef === objectiveRef)
          : [];
      const refs = new Set([
        ...lessonSlots.flatMap((s) => s.allowedSourceRefs),
        ...practiceSlots.flatMap((s) => s.allowedSourceRefs),
      ]);
      // The orientation slot mentions the whole Unit; it must not merge unrelated
      // mechanisms into the concrete model for this objective's capsule.
      const objectives = new Set([objectiveRef]);
      inputs.push({
        lesson: {
          ...lesson,
          preparedTogether: true,
          workedInteractionSlotId: interactionSlotId,
          skeleton: {
            ...lesson.skeleton,
            lessonSlots,
            objectives: skeleton.objectives.filter((o) => objectives.has(o.objectiveRef)),
          },
          sourceContext: {
            ...lesson.sourceContext,
            offers: lesson.sourceContext.offers.filter((s) => refs.has(s.sourceRef)),
          },
        },
        practiceSlots,
        practiceLessonSlots: skeleton.lessonSlots,
        priorLesson: [],
        includeNarrative: inputs.length === 0,
      });
    }
  }
  return inputs;
}

export function assembleCapsules(
  skeleton: TeachingSkeleton,
  slots: TeachingLessonSlotContent[],
  narrative: LessonSlotContentProposalPayload['narrative'],
  items: PracticeContentProposalPayload['items'],
) {
  const bySlot = new Map(slots.map((s) => [s.slotId, s]));
  const byItem = new Map(items.map((s) => [s.practiceSlotId, s]));
  return {
    lesson: { narrative, slots: skeleton.lessonSlots.map((s) => bySlot.get(s.slotId)!) },
    practice: { items: skeleton.practicePlan.slots.map((s) => byItem.get(s.practiceSlotId)!) },
  };
}
