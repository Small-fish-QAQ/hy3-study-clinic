import { createHash } from 'node:crypto';
import {
  AcceptedLessonCheckpointSchema,
  LESSON_GROUNDING_POLICY_VERSION,
  LessonGroundingReviewSchema,
  LessonGroundingResultSchema,
  LessonSlotContentProposalPayloadSchema,
  projectAcceptedLessonSegments,
  type AcceptedLessonCheckpoint,
  type LessonGroundingReview,
  type LessonSlotContentProposalPayload,
  type TeachingBrief,
  type TeachingContentReview,
} from '@hy3-clinic/shared';
import type {
  LessonGroundingReviewInput,
  LessonSlotContentGenerationInput,
} from '../llm/provider.js';
import { ProviderError } from '../llm/errors.js';

// Schema hydration can reorder object properties. Array order and every claim
// remain significant; JSON key order must not invalidate an otherwise exact proof.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]),
  );
}

export const lessonGroundingHash = (value: unknown) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;

export function lessonGroundingClaimsHash(candidate: LessonSlotContentProposalPayload): string {
  const claims = LessonSlotContentProposalPayloadSchema.parse(candidate);
  return lessonGroundingHash(claims);
}

export function checkpointLessonCandidate(
  checkpoint: Pick<AcceptedLessonCheckpoint, 'lessonContent'>,
): LessonSlotContentProposalPayload {
  return {
    narrative: checkpoint.lessonContent[0]?.lessonNarrative,
    slots: checkpoint.lessonContent.map((content, index) => {
      if (index !== 0) return content;
      const { lessonNarrative: _narrative, ...slot } = content;
      return slot;
    }),
  };
}

/** Rich factual/source verification must never supply public solving evidence. */
export function prepareLessonGroundingReview(
  context: LessonSlotContentGenerationInput,
  candidate: LessonSlotContentProposalPayload,
) {
  const input: LessonGroundingReviewInput = {
    purpose: 'lesson_grounding',
    stage: 'lesson',
    computedOutcomes: context.computedCases,
    lessonPlan: structuredClone({
      learningUnitTitle: context.skeleton.learningUnitTitle,
      lessonSlots: context.skeleton.lessonSlots,
    }),
    courseDesign: structuredClone(context.courseDesign),
    objectives: structuredClone(context.skeleton.objectives),
    sources: structuredClone(context.sourceContext.offers),
    visualContext: structuredClone(context.visualContext),
    learningContext: structuredClone(context.learningContext),
    candidate: structuredClone(candidate),
    actionIds: [],
  };
  const fingerprint = () =>
    lessonGroundingHash({
      policyVersion: LESSON_GROUNDING_POLICY_VERSION,
      input,
      candidate,
      context: {
        workspaceName: context.workspaceName,
        learnerLocale: context.learnerLocale,
        courseDesign: context.courseDesign,
        skeleton: context.skeleton,
        sourceContext: context.sourceContext,
        visualContext: context.visualContext,
        learningContext: context.learningContext,
        computedCases: context.computedCases,
        workedInteractionSlotId: context.workedInteractionSlotId,
        preparedTogether: context.preparedTogether,
      },
    });
  const inputHash = fingerprint();
  const ids = new Set(candidate.slots.map((slot) => slot.slotId));
  const narrativeId = candidate.slots[0]!.slotId;
  const validate = (raw: unknown) => {
    const parsed = LessonGroundingResultSchema.safeParse(raw);
    const valid =
      fingerprint() === inputHash &&
      parsed.success &&
      parsed.data.decisions.length === 0 &&
      [...parsed.data.findings, ...(parsed.data.advisories ?? [])].every(
        ({ itemId }) => itemId === 'lesson.narrative' || ids.has(itemId.split('.')[0]!),
      );
    return {
      valid,
      diagnostics: valid
        ? []
        : [
            'lesson_grounding_inventory: return current Lesson correctness findings; quality opinions belong only in advisories.',
          ],
      diagnosticCodes: valid ? [] : ['lesson_grounding_inventory'],
    };
  };
  return {
    input,
    inputHash,
    candidateHash: lessonGroundingHash(candidate),
    claimsHash: lessonGroundingClaimsHash(candidate),
    validate,
    findings: (result: TeachingContentReview) =>
      LessonGroundingResultSchema.parse(result).findings.map((finding) => ({
        ...finding,
        // The existing bounded editor repairs slots; the first capsule owns
        // the narrative. Preserve its location in the diagnostic for that editor.
        itemId: finding.itemId === 'lesson.narrative' ? narrativeId : finding.itemId.split('.')[0]!,
        problem: `${finding.itemId}: ${finding.problem}`.slice(0, 800),
      })),
  };
}

function currentProof(proof: unknown): LessonGroundingReview | null {
  const parsed = LessonGroundingReviewSchema.safeParse(proof);
  if (!parsed.success || parsed.data.policyVersion !== LESSON_GROUNDING_POLICY_VERSION) return null;
  const latest = parsed.data.rounds.at(-1)!;
  if (latest.result.findings.length) return null;
  return parsed.data;
}

export function assertPreparedLessonGrounding(
  candidate: LessonSlotContentProposalPayload,
  context: LessonSlotContentGenerationInput,
  proof: LessonGroundingReview | undefined,
): void {
  const prepared = prepareLessonGroundingReview(context, candidate);
  const latest = currentProof(proof)?.rounds.at(-1);
  if (
    !latest ||
    latest.candidateHash !== prepared.candidateHash ||
    latest.claimsHash !== prepared.claimsHash ||
    latest.inputHash !== prepared.inputHash ||
    !prepared.validate(latest.result).valid
  )
    throw ProviderError.invalidOutput(
      'Lesson requires complete grounding of the exact current candidate and authorized context.',
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
      false,
    );
}

function checkpointContextHash(raw: AcceptedLessonCheckpoint): string {
  const checkpoint = AcceptedLessonCheckpointSchema.parse(raw);
  const {
    checkpointContextHash: _checkpointHash,
    exposureContextHash: _exposureHash,
    ...proof
  } = checkpoint.lessonEvaluation.groundingReview!;
  return lessonGroundingHash({
    ...checkpoint,
    lessonEvaluation: { ...checkpoint.lessonEvaluation, groundingReview: proof },
  });
}

type LessonProjection = Pick<
  TeachingBrief,
  | 'objective'
  | 'prerequisites'
  | 'segments'
  | 'summary'
  | 'nextConnection'
  | 'sourceReferences'
  | 'visualReferences'
  | 'sourceManifest'
>;

function exposureContextHash(
  binding: Pick<
    AcceptedLessonCheckpoint,
    | 'id'
    | 'workspaceId'
    | 'curriculumVersionId'
    | 'studyPlanVersionId'
    | 'learningUnitId'
    | 'executionSourceManifestFingerprint'
    | 'sourceContextFingerprint'
    | 'operationId'
    | 'lessonLogicalCallId'
    | 'promptVersion'
  > & { skeletonFingerprint: string },
  projection: LessonProjection,
  proof: LessonGroundingReview,
): string {
  return lessonGroundingHash({
    binding,
    projection: {
      objective: projection.objective,
      prerequisites: projection.prerequisites,
      segments: projection.segments,
      summary: projection.summary,
      nextConnection: projection.nextConnection,
      sourceReferences: projection.sourceReferences,
      visualReferences: projection.visualReferences,
      sourceManifest: projection.sourceManifest,
    },
    proof: {
      policyVersion: proof.policyVersion,
      receipt: proof.rounds.at(-1),
      checkpointContextHash: proof.checkpointContextHash,
    },
  });
}

function checkpointBinding(checkpoint: AcceptedLessonCheckpoint) {
  return {
    id: checkpoint.id,
    workspaceId: checkpoint.workspaceId,
    curriculumVersionId: checkpoint.curriculumVersionId,
    studyPlanVersionId: checkpoint.studyPlanVersionId,
    learningUnitId: checkpoint.learningUnitId,
    executionSourceManifestFingerprint: checkpoint.executionSourceManifestFingerprint,
    sourceContextFingerprint: checkpoint.sourceContextFingerprint,
    operationId: checkpoint.operationId,
    lessonLogicalCallId: checkpoint.lessonLogicalCallId,
    promptVersion: checkpoint.promptVersion,
    skeletonFingerprint: checkpoint.skeleton.fingerprint,
  };
}

/** Bind before checkpoint persistence, after citation processing and materialization. */
export function bindLessonGroundingToCheckpoint(
  checkpoint: AcceptedLessonCheckpoint,
  candidate: LessonSlotContentProposalPayload,
  context: LessonSlotContentGenerationInput,
  projection: LessonProjection,
): void {
  const proof = checkpoint.lessonEvaluation.groundingReview;
  assertPreparedLessonGrounding(candidate, context, proof);
  if (
    lessonGroundingClaimsHash(checkpointLessonCandidate(checkpoint)) !==
    lessonGroundingClaimsHash(candidate)
  )
    throw ProviderError.invalidOutput('Lesson checkpoint changed the reviewed claims.');
  const narrative = candidate.narrative;
  if (
    !narrative ||
    projection.objective.whyNow !== narrative.whyNow ||
    projection.summary !== narrative.summary ||
    projection.nextConnection !== narrative.forwardBridge ||
    lessonGroundingHash(projection.segments) !==
      lessonGroundingHash(
        projectAcceptedLessonSegments(
          checkpoint,
          projection.objective.objectives.map(({ id }) => id),
        ),
      )
  )
    throw ProviderError.invalidOutput('Lesson materialization changed the reviewed teaching.');
  proof!.checkpointContextHash = checkpointContextHash(checkpoint);
  proof!.exposureContextHash = exposureContextHash(
    checkpointBinding(checkpoint),
    projection,
    proof!,
  );
}

export function hasCurrentCheckpointLessonGrounding(checkpoint: AcceptedLessonCheckpoint): boolean {
  const proof = currentProof(checkpoint.lessonEvaluation.groundingReview);
  return (
    !!proof &&
    proof.rounds.at(-1)!.candidateHash ===
      lessonGroundingHash(checkpointLessonCandidate(checkpoint)) &&
    proof.rounds.at(-1)!.claimsHash ===
      lessonGroundingClaimsHash(checkpointLessonCandidate(checkpoint)) &&
    proof.checkpointContextHash === checkpointContextHash(checkpoint) &&
    !!proof.exposureContextHash
  );
}

export function hasCurrentLessonGroundingProjection(
  checkpoint: AcceptedLessonCheckpoint,
  projection: LessonProjection,
): boolean {
  const proof = checkpoint.lessonEvaluation.groundingReview;
  return (
    hasCurrentCheckpointLessonGrounding(checkpoint) &&
    proof!.exposureContextHash ===
      exposureContextHash(checkpointBinding(checkpoint), projection, proof!)
  );
}

/** Saved/exposed Lesson bytes cannot inherit a proof from another projection. */
export function hasCurrentLessonGrounding(brief: TeachingBrief): boolean {
  const proof = currentProof(brief.pedagogyEvaluation?.groundingReview);
  const composition = brief.composition;
  if (!proof?.checkpointContextHash || !composition) return false;
  return (
    proof.exposureContextHash ===
    exposureContextHash(
      {
        id: composition.acceptedLessonCheckpointId,
        workspaceId: brief.workspaceId,
        curriculumVersionId: brief.curriculumVersionId,
        studyPlanVersionId: brief.studyPlanVersionId,
        learningUnitId: brief.learningUnitId,
        executionSourceManifestFingerprint: brief.executionSourceManifestFingerprint,
        sourceContextFingerprint: brief.sourceContextFingerprint,
        operationId: composition.lessonOperationId,
        lessonLogicalCallId: composition.lessonLogicalCallId ?? null,
        promptVersion: composition.lessonPromptVersion,
        skeletonFingerprint: composition.skeletonFingerprint,
      },
      {
        objective: brief.objective,
        prerequisites: brief.prerequisites,
        segments: brief.segments,
        summary: brief.summary,
        nextConnection: brief.nextConnection,
        sourceReferences: brief.sourceReferences,
        visualReferences: brief.visualReferences,
        sourceManifest: brief.sourceManifest,
      },
      proof,
    )
  );
}
