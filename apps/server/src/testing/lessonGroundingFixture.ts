import {
  LESSON_GROUNDING_POLICY_VERSION,
  projectAcceptedLessonSegments,
  type AcceptedLessonCheckpoint,
} from '@hy3-clinic/shared';
import type { LessonSlotContentGenerationInput } from '../llm/provider.js';
import {
  bindLessonGroundingToCheckpoint,
  checkpointLessonCandidate,
  prepareLessonGroundingReview,
} from '../services/lessonGrounding.js';

/** Simulated offline review evidence for repository fixtures, never a production adapter. */
export function seedLessonGroundingProof(
  checkpoint: AcceptedLessonCheckpoint,
  projection?: Parameters<typeof bindLessonGroundingToCheckpoint>[3],
) {
  projection ??= {
    objective: {
      title: 'Grounding fixture',
      whyNow: 'Use the current source rule.',
      objectives: checkpoint.skeleton.objectives.map((objective, index) => ({
        id: `objective_${index + 1}`,
        title: objective.title,
        description: objective.description,
        priority: objective.priority,
        construct: objective.construct,
      })),
    },
    prerequisites: [],
    segments: projectAcceptedLessonSegments(
      checkpoint,
      checkpoint.skeleton.objectives.map((_, index) => `objective_${index + 1}`),
    ),
    summary: 'Apply the current source rule.',
    nextConnection: null,
    sourceReferences: [],
    visualReferences: [],
    sourceManifest: { fingerprint: checkpoint.executionSourceManifestFingerprint, revisions: [] },
  };
  checkpoint.lessonContent[0]!.lessonNarrative = {
    whyNow: projection.objective.whyNow,
    summary: projection.summary,
    forwardBridge: projection.nextConnection,
  };
  const context: LessonSlotContentGenerationInput = {
    workspaceName: 'Grounding fixture',
    learnerLocale: 'zh-CN',
    skeleton: checkpoint.skeleton,
    sourceContext: {
      blockCount: projection.sourceReferences.length,
      offerCount: projection.sourceReferences.length,
      serializedBytes: 0,
      materialCount: 1,
      sectionCount: 1,
      offers: projection.sourceReferences.map((ref) => ({
        sourceRef: ref.refId,
        text: ref.quote,
        materialTitle: 'Fixture source',
        headingPath: ref.headingPath,
        pageNumber: ref.pageNumber,
        slideNumber: ref.slideNumber,
        authorizedObjectiveRefs: checkpoint.skeleton.objectives.map(
          ({ objectiveRef }) => objectiveRef,
        ),
      })),
    },
    visualContext: { offerCount: 0, serializedBytes: 0, offers: [] },
    learningContext: {
      concepts: [],
      canonicalConcepts: [],
      prerequisites: [],
      nextConnection: null,
    },
  };
  const candidate = checkpointLessonCandidate(checkpoint);
  const prepared = prepareLessonGroundingReview(context, candidate);
  checkpoint.lessonEvaluation.groundingReview = {
    policyVersion: LESSON_GROUNDING_POLICY_VERSION,
    rounds: [
      {
        logicalCallId: `${checkpoint.lessonLogicalCallId}-grounding`,
        candidateHash: prepared.candidateHash,
        claimsHash: prepared.claimsHash,
        inputHash: prepared.inputHash,
        result: { decisions: [], findings: [] },
      },
    ],
  };
  bindLessonGroundingToCheckpoint(checkpoint, candidate, context, projection);
  return checkpoint;
}
