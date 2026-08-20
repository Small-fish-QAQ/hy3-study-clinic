import {
  FORMAL_EVIDENCE_POLICY_VERSION,
  ReviewBackfillAuditSchema,
  type EvidenceRecord,
  type ReviewBackfillAudit,
  type ReviewBackfillReason,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import { DEFAULT_CONFIGURATION } from '../review/fsrsAdapter.js';
import type { ReviewSuccessorService } from './reviewSuccessor.js';

const ELIGIBLE_KINDS = new Set([
  'formal_checkpoint',
  'targeted_repair',
  'synthesis',
  'direct_checkpoint',
]);

interface EligibleBinding {
  workspaceId: string;
  courseId: string;
  learningUnitId: string;
  objectiveId: string;
  contractVersionId: string;
  curriculumVersionId: string;
  manifestFingerprint: string;
}

type Eligibility =
  { ok: true; binding: EligibleBinding } | { ok: false; reason: ReviewBackfillReason };

export function createReviewBackfillService({
  repos,
  reviewSuccessor,
}: {
  repos: Repositories;
  reviewSuccessor: ReviewSuccessorService;
}) {
  const cutoverAt = DEFAULT_CONFIGURATION.effectiveAt;

  function eligibility(evidence: EvidenceRecord): Eligibility {
    if (evidence.conclusion !== 'supported') return { ok: false, reason: 'not_supported' };
    if (evidence.policyVersion !== FORMAL_EVIDENCE_POLICY_VERSION) {
      return { ok: false, reason: 'unsupported_policy' };
    }
    const reconciliation = repos.formalAssessments.getReconciliationForGrade(
      evidence.gradeRecordId,
    );
    if (
      !reconciliation ||
      reconciliation.evidenceRecordId !== evidence.id ||
      reconciliation.status !== 'applied' ||
      !reconciliation.gradingResultId
    ) {
      return { ok: false, reason: 'reconciliation_not_applied' };
    }
    const attempt = repos.formalAssessments.getAttempt(evidence.attemptId);
    const grade = repos.formalAssessments.getGrade(evidence.gradeRecordId);
    const version = repos.formalAssessments.getVersion(evidence.assessmentVersionId);
    if (
      !attempt ||
      attempt.status !== 'submitted' ||
      attempt.assessmentVersionId !== evidence.assessmentVersionId ||
      !grade ||
      grade.status !== 'current' ||
      grade.attemptId !== attempt.id ||
      grade.assessmentVersionId !== version?.id ||
      !version ||
      !['accepted', 'superseded'].includes(version.status) ||
      !version.progressionContext
    ) {
      return { ok: false, reason: 'invalid_formal_context' };
    }
    const context = version.progressionContext;
    if (context.assessmentKind === 'due_review') {
      return { ok: false, reason: 'due_review_not_backfillable' };
    }
    if (!ELIGIBLE_KINDS.has(context.assessmentKind)) {
      return { ok: false, reason: 'ineligible_assessment_kind' };
    }
    const progressionApplied = repos.formalProgression
      .listReconciliationsForGrading(reconciliation.gradingResultId)
      .some(
        (record) =>
          record.status === 'applied' &&
          record.workspaceId === attempt.workspaceId &&
          record.curriculumVersionId === context.curriculumVersionId &&
          record.studyPlanVersionId === context.studyPlanVersionId &&
          record.curriculumLearningUnitId === evidence.targetLearningUnitId,
      );
    if (!progressionApplied) return { ok: false, reason: 'reconciliation_not_applied' };

    const item = version.items.find((candidate) => candidate.id === evidence.itemId);
    if (
      !item ||
      item.targetLearningUnitId !== evidence.targetLearningUnitId ||
      !item.formalEligible ||
      item.policyReason !== 'FORMAL_ELIGIBLE' ||
      item.questionType !== 'short_answer' ||
      !item.sourceQuestionId
    ) {
      return { ok: false, reason: 'invalid_formal_context' };
    }
    const contract = repos.learningContracts.get(context.contractVersionId);
    const curriculum = repos.curricula.get(context.curriculumVersionId);
    const manifest = repos.curricula.getManifest(
      attempt.workspaceId,
      context.executionSourceManifestFingerprint,
    );
    const objectiveMatches =
      curriculum?.nodes.flatMap((node) =>
        (node.learningUnit?.objectives ?? []).flatMap((objective) =>
          node.id === item.targetLearningUnitId && objective.id === item.targetObjectiveId
            ? [{ learningUnitId: node.id, objectiveId: objective.id }]
            : [],
        ),
      ) ?? [];
    if (
      !repos.workspaces.get(attempt.workspaceId) ||
      !contract ||
      contract.workspaceId !== attempt.workspaceId ||
      !curriculum ||
      curriculum.workspaceId !== attempt.workspaceId ||
      curriculum.contractVersionId !== context.contractVersionId ||
      curriculum.executionSourceManifest.fingerprint !==
        context.executionSourceManifestFingerprint ||
      !manifest ||
      objectiveMatches.length !== 1
    ) {
      return { ok: false, reason: 'missing_exact_binding' };
    }

    const questionContracts = repos.formalProgression
      .listQuestionContractsForQuiz(context.quizId)
      .filter(
        (candidate) =>
          candidate.questionId === item.sourceQuestionId &&
          candidate.workspaceId === attempt.workspaceId &&
          candidate.assessmentKind === context.assessmentKind &&
          candidate.primaryObjectiveId === item.targetObjectiveId &&
          candidate.curriculumLearningUnitId === item.targetLearningUnitId &&
          candidate.contractVersionId === context.contractVersionId &&
          candidate.curriculumVersionId === context.curriculumVersionId &&
          candidate.studyPlanVersionId === context.studyPlanVersionId &&
          candidate.executionSourceManifestFingerprint ===
            context.executionSourceManifestFingerprint,
      );
    if (questionContracts.length !== 1) return { ok: false, reason: 'missing_exact_binding' };

    const evidenceBindingIds = [...evidence.sourceBindingIds].sort();
    const itemBindingIds = item.sourceBindings.map((binding) => binding.sourceBlockId).sort();
    const exactSourceIds =
      evidenceBindingIds.length === itemBindingIds.length &&
      evidenceBindingIds.every((id, index) => id === itemBindingIds[index]);
    const validSources =
      exactSourceIds &&
      item.sourceBindings.length > 0 &&
      item.sourceBindings.every((binding) => {
        const block = repos.materials.getBlock(binding.sourceBlockId);
        const inManifest = manifest.manifest.revisions.some(
          (revision) =>
            revision.materialId === binding.materialId &&
            revision.materialRevisionId === binding.materialRevisionId &&
            revision.sourceBlockRevisionIds.includes(binding.sourceBlockId),
        );
        return Boolean(
          binding.authoritative &&
          binding.contentOrigin === 'extracted_original' &&
          block &&
          block.materialId === binding.materialId &&
          block.materialRevisionId === binding.materialRevisionId &&
          inManifest,
        );
      });
    if (!validSources) return { ok: false, reason: 'invalid_source_binding' };

    return {
      ok: true,
      binding: {
        workspaceId: attempt.workspaceId,
        courseId: attempt.workspaceId,
        learningUnitId: item.targetLearningUnitId,
        objectiveId: item.targetObjectiveId,
        contractVersionId: context.contractVersionId,
        curriculumVersionId: context.curriculumVersionId,
        manifestFingerprint: context.executionSourceManifestFingerprint,
      },
    };
  }

  function record(
    evidenceId: string,
    outcome: ReviewBackfillAudit['outcome'],
    reason: ReviewBackfillReason,
    reviewTargetId: string | null,
  ) {
    return repos.reviewSuccessor.insertBackfillAudit(
      ReviewBackfillAuditSchema.parse({
        evidenceId,
        cutoverAt,
        outcome,
        reason,
        reviewTargetId,
        createdAt: cutoverAt,
      }),
    );
  }

  return {
    cutoverAt,
    run() {
      const results: ReviewBackfillAudit[] = [];
      for (const evidence of repos.formalAssessments.listEvidenceCreatedBefore(cutoverAt)) {
        const existingAudit = repos.reviewSuccessor.getBackfillAudit(evidence.id);
        if (existingAudit) {
          results.push(existingAudit);
          continue;
        }
        const decision = eligibility(evidence);
        if (!decision.ok) {
          results.push(record(evidence.id, 'skipped', decision.reason, null));
          continue;
        }
        const targetId = `review-target:${decision.binding.workspaceId}:${decision.binding.objectiveId}`;
        const existingTarget = repos.reviewSuccessor.getTarget(targetId);
        if (existingTarget) {
          const existingBinding = existingTarget.currentBindingVersion
            ? repos.reviewSuccessor.getBinding(targetId, existingTarget.currentBindingVersion)
            : undefined;
          const existingState = repos.reviewSuccessor.getState(targetId);
          const exact =
            existingTarget.workspaceId === decision.binding.workspaceId &&
            existingTarget.courseId === decision.binding.courseId &&
            existingBinding?.contractVersionId === decision.binding.contractVersionId &&
            existingBinding.curriculumVersionId === decision.binding.curriculumVersionId &&
            existingBinding.learningUnitId === decision.binding.learningUnitId &&
            existingBinding.objectiveId === decision.binding.objectiveId &&
            existingBinding.executionSourceManifestFingerprint ===
              decision.binding.manifestFingerprint &&
            existingState !== undefined &&
            (existingTarget.status === 'active' ||
              (existingTarget.status === 'pending_initial_review' &&
                existingState.lifecycleState === 'pending_initial_review' &&
                existingState.dueAt === cutoverAt));
          results.push(
            record(
              evidence.id,
              exact ? 'already_present' : 'skipped',
              exact ? 'eligible_pending_present' : 'ambiguous_existing_target',
              exact ? targetId : null,
            ),
          );
          continue;
        }
        results.push(
          repos.transaction(() => {
            reviewSuccessor.ensureTarget({
              ...decision.binding,
              evidenceId: evidence.id,
              at: cutoverAt,
              pendingDueAt: cutoverAt,
            });
            return record(evidence.id, 'created', 'eligible_pending_created', targetId);
          }),
        );
      }
      return results;
    },
  };
}

export type ReviewBackfillService = ReturnType<typeof createReviewBackfillService>;
