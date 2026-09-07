import type { TeachingCapsulePayload } from '@hy3-clinic/shared';
import type { TeachingCapsuleGenerationInput } from './provider.js';

/** A generated paraphrase or hypothetical case cannot self-certify citation
 * authority. Keep only offered references whose text contains the complete
 * component verbatim; all other authored content remains useful supplementary
 * teaching. Unknown refs are retained so ordinary validation still refuses them.
 * This affects teaching display only, never Curriculum/Formal source authority. */
export function confineTeachingCitations(
  payload: TeachingCapsulePayload,
  input: { lesson: Pick<TeachingCapsuleGenerationInput['lesson'], 'sourceContext'> },
): TeachingCapsulePayload {
  const result = structuredClone(payload);
  const sources = new Map(
    input.lesson.sourceContext.offers.map((offer) => [offer.sourceRef, offer.text]),
  );
  const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
  const confine = (refs: string[], texts: string[]) =>
    refs.filter((ref) => {
      const source = sources.get(ref);
      if (source === undefined) return true;
      return (
        texts.length > 0 &&
        texts.every(
          (text) => normalize(text).length >= 8 && normalize(source).includes(normalize(text)),
        )
      );
    });
  for (const slot of result.lesson.slots) {
    slot.sourceRefs = confine(slot.sourceRefs, [slot.explanation]);
    for (const component of [slot.example, slot.contrast])
      if (component) component.sourceRefs = confine(component.sourceRefs, [component.text]);
    if (slot.misconception)
      slot.misconception.sourceRefs = confine(slot.misconception.sourceRefs, [
        slot.misconception.hypothesis,
        slot.misconception.correction,
      ]);
    for (const relation of slot.semanticRelations)
      relation.sourceRefs = confine(relation.sourceRefs, [
        relation.fromProposition,
        relation.toProposition,
      ]);
    if (slot.workedProcess) {
      slot.workedProcess.sourceRefs = confine(slot.workedProcess.sourceRefs, []);
      if (slot.workedProcess.interaction)
        slot.workedProcess.interaction.sourceRefs = confine(
          slot.workedProcess.interaction.sourceRefs,
          [],
        );
    }
  }
  for (const item of result.practice.items) item.sourceRefs = confine(item.sourceRefs, []);
  return result;
}
