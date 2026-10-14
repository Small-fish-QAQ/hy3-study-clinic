import type { LessonAuthor } from '@hy3-clinic/shared';
import { sha256, stableId } from '../util/canonical.js';
import { requireValid, unique } from './courseValidation.js';

/** Patch IDs belong to the supplied local draft; added IDs never replace healthy siblings. */
export function mergeLessonRevision(
  candidate: LessonAuthor,
  fixed: LessonAuthor,
  segmentIds: string[],
  affectedCoverage: LessonAuthor['teachingCoverage'],
): LessonAuthor {
  requireValid(!unique(fixed.segments.map((s) => s.id)) ? ['局部修订段落ID重复'] : []);
  const affected = new Set(segmentIds);
  const healthy = new Set(candidate.segments.filter((s) => !affected.has(s.id)).map((s) => s.id));
  const allowedKnowledge = new Set(affectedCoverage.map((c) => c.knowledgeId));
  const allowedObjectives = new Set(affectedCoverage.flatMap((c) => c.objectiveIds));
  requireValid(
    fixed.teachingCoverage.some(
      (c) =>
        !allowedKnowledge.has(c.knowledgeId) ||
        c.objectiveIds.some((id) => !allowedObjectives.has(id)),
    )
      ? ['局部修订覆盖超出指定知识或目标范围']
      : [],
  );
  const ids = new Map(
    fixed.segments.map((s) => [
      s.id,
      healthy.has(s.id)
        ? stableId(
            'local_segment',
            sha256({ draft: sha256(candidate), scope: segmentIds, id: s.id }),
          )
        : s.id,
    ]),
  );
  const local = fixed.segments.map((s) => ({ ...s, id: ids.get(s.id)! }));
  const coverage = fixed.teachingCoverage.map((c) => ({
    ...c,
    segmentId: ids.get(c.segmentId) ?? c.segmentId,
  }));
  requireValid(
    coverage.some((c) => !local.some((s) => s.id === c.segmentId))
      ? ['局部修订引用未返回的段落']
      : [],
  );
  const replacements = new Map(local.map((s) => [s.id, s]));
  const additions = local.filter(
    (s) => !candidate.segments.some((original) => original.id === s.id),
  );
  const lastAffected = candidate.segments.findLastIndex((s) => affected.has(s.id));
  const segments = candidate.segments.flatMap((original, index) => {
    const retained = affected.has(original.id) ? replacements.get(original.id) : original;
    return [...(retained ? [retained] : []), ...(index === lastAffected ? additions : [])];
  });
  if (lastAffected < 0) segments.push(...additions);
  return {
    ...candidate,
    segments,
    teachingCoverage: [
      ...candidate.teachingCoverage.filter((c) => !affectedCoverage.includes(c)),
      ...coverage,
    ],
  };
}
