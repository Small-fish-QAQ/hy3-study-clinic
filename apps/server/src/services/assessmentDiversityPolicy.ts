import {
  ASSESSMENT_INTENT_POLICY_VERSION,
  AssessmentIntentSelectionSchema,
  supportsFormalApplicationDemand,
  type AssessmentIntentSelection,
  type EvidenceRepresentation,
  type FormalAssessmentConstruct,
  type FormalAssessmentKind,
  type MasteryChallengeFamily,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';

export interface QualifyingAssessmentIntentEvidence {
  evidenceId: string;
  representation: EvidenceRepresentation;
  requestedChallengeFamily: MasteryChallengeFamily | null;
  createdAt: string;
}

export interface AssessmentDiversityDecision {
  selection: AssessmentIntentSelection;
  evidenceRepresentation: EvidenceRepresentation;
}

function selection(
  input: Omit<AssessmentIntentSelection, 'policyVersion'>,
): AssessmentIntentSelection {
  return AssessmentIntentSelectionSchema.parse({
    policyVersion: ASSESSMENT_INTENT_POLICY_VERSION,
    ...input,
  });
}

/**
 * Choose information-gaining question design from local evidence needs.
 * The result is a generation request, never proof that the question realized
 * the requested semantic challenge.
 */
export function selectAssessmentDiversityIntent(input: {
  assessmentKind: FormalAssessmentKind;
  objectiveConstruct: FormalAssessmentConstruct | null;
  priorEvidence: QualifyingAssessmentIntentEvidence[];
}): AssessmentDiversityDecision {
  if (input.assessmentKind !== 'due_review') {
    return {
      selection: selection({
        requestedChallengeFamily: null,
        requestedRepresentation: null,
        selectionReason: 'ordinary_formal_check',
      }),
      evidenceRepresentation: input.assessmentKind === 'synthesis' ? 'synthesis' : 'recall',
    };
  }

  const applicationCapable = supportsFormalApplicationDemand(input.objectiveConstruct);
  if (!applicationCapable) {
    return {
      selection: selection({
        requestedChallengeFamily: null,
        requestedRepresentation: null,
        selectionReason: 'no_supported_alternative',
      }),
      evidenceRepresentation: 'recall',
    };
  }

  const priorRepresentations = new Set(input.priorEvidence.map((item) => item.representation));
  if (input.priorEvidence.length > 0 && !priorRepresentations.has('application')) {
    return {
      selection: selection({
        requestedChallengeFamily: 'representation_shift',
        requestedRepresentation: 'application',
        selectionReason: 'representation_diversity_missing',
      }),
      evidenceRepresentation: 'application',
    };
  }

  const transferAlreadyRequested = input.priorEvidence.some(
    (item) => item.requestedChallengeFamily === 'transfer',
  );
  if (priorRepresentations.has('application') && !transferAlreadyRequested) {
    return {
      selection: selection({
        requestedChallengeFamily: 'transfer',
        requestedRepresentation: 'application',
        selectionReason: 'transfer_context_missing',
      }),
      evidenceRepresentation: 'application',
    };
  }

  return {
    selection: selection({
      requestedChallengeFamily: null,
      requestedRepresentation: 'application',
      selectionReason: 'ordinary_due_review',
    }),
    evidenceRepresentation: 'application',
  };
}

/** Current supported Assessment Evidence used only to choose future item design. */
export function qualifyingAssessmentIntentEvidence(input: {
  repos: Repositories;
  workspaceId: string;
  objectiveId: string;
  contractVersionId: string;
  curriculumVersionId: string;
  studyPlanVersionId: string;
  executionSourceManifestFingerprint: string;
}): QualifyingAssessmentIntentEvidence[] {
  const records = input.repos.formalAssessments.listProjectionRecords(input.workspaceId);
  const versionById = new Map(records.versions.map((version) => [version.id, version]));
  const submittedAttemptIds = new Set(
    records.attempts
      .filter((attempt) => attempt.status === 'submitted')
      .map((attempt) => attempt.id),
  );
  const currentGradeIds = new Set(
    records.grades.filter((grade) => grade.status === 'current').map((grade) => grade.id),
  );
  const reconciliationByEvidenceId = new Map(
    records.reconciliations.map((record) => [record.evidenceRecordId, record]),
  );
  const intentByItem = new Map(
    input.repos.formalAssessments
      .listItemIntentsForWorkspace(input.workspaceId)
      .map((intent) => [`${intent.assessmentVersionId}:${intent.itemId}`, intent]),
  );

  return records.evidence
    .flatMap((evidence): QualifyingAssessmentIntentEvidence[] => {
      const version = versionById.get(evidence.assessmentVersionId);
      const context = version?.progressionContext;
      const item = version?.items.find((candidate) => candidate.id === evidence.itemId);
      if (
        evidence.conclusion !== 'supported' ||
        reconciliationByEvidenceId.get(evidence.id)?.status !== 'applied' ||
        !submittedAttemptIds.has(evidence.attemptId) ||
        !currentGradeIds.has(evidence.gradeRecordId) ||
        !version ||
        version.status !== 'accepted' ||
        version.authorityMode !== 'formal' ||
        !context ||
        context.contractVersionId !== input.contractVersionId ||
        context.curriculumVersionId !== input.curriculumVersionId ||
        context.studyPlanVersionId !== input.studyPlanVersionId ||
        context.executionSourceManifestFingerprint !== input.executionSourceManifestFingerprint ||
        !item ||
        item.targetObjectiveId !== input.objectiveId
      ) {
        return [];
      }
      const intent = intentByItem.get(`${version.id}:${item.id}`);
      return [
        {
          evidenceId: evidence.id,
          representation: item.representation,
          requestedChallengeFamily: intent?.requestedChallengeFamily ?? null,
          createdAt: evidence.createdAt,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.evidenceId.localeCompare(right.evidenceId),
    );
}
