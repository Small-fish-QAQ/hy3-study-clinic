import {
  AssessmentAttemptSchema,
  AssessmentDefinitionSchema,
  AssessmentVersionSchema,
  ApiErrorCode,
  EvidenceRecordSchema,
  GradeRecordSchema,
  ProgressionReconciliationRecordSchema,
  classifyFormalAssessmentItem,
  type AssessmentAttempt,
  type AssessmentDefinition,
  type AssessmentVersion,
  type EvidenceRecord,
  type FormalAssessmentItem,
  type GradeRecord,
  type ProgressionReconciliationRecord,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { verifyGrounding } from '../grounding/verify.js';

const POLICY_VERSION = 'formal-assessment-evidence-v1';

export function createFormalAssessmentsService({
  repos,
  clock,
}: {
  repos: Repositories;
  clock: Clock;
}) {
  function getVersion(id: string) {
    const version = repos.formalAssessments.getVersion(id);
    if (!version) throw notFound(`正式评估版本不存在:${id}`);
    return version;
  }
  function validateItem(workspaceId: string, item: FormalAssessmentItem): FormalAssessmentItem {
    const materialIds = new Set<string>();
    for (const binding of item.sourceBindings) {
      const block = repos.materials.getBlock(binding.sourceBlockId);
      if (
        !block ||
        block.materialId !== binding.materialId ||
        block.materialRevisionId !== binding.materialRevisionId
      ) {
        throw new AppError(ApiErrorCode.ValidationError, '正式评估的来源绑定不存在或版本不匹配。');
      }
      const material = repos.materials.get(binding.materialId);
      if (!material || material.workspaceId !== workspaceId)
        throw notFound('正式评估来源不属于当前课程空间。');
      materialIds.add(binding.materialId);
      const verification = verifyGrounding([block], {
        blockId: binding.sourceBlockId,
        quote: binding.quote,
      });
      if (!verification.ok)
        throw new AppError(ApiErrorCode.ValidationError, '正式评估引文未通过本地原文校验。');
      const active = repos.materialRevisions.getActive(binding.materialId);
      if (!active || active.id !== binding.materialRevisionId) {
        return { ...item, formalEligible: false, policyReason: 'STALE_SOURCE_BINDING' };
      }
    }
    const policy = classifyFormalAssessmentItem({ ...item, sourceBindings: item.sourceBindings });
    return { ...item, formalEligible: policy.formalEligible, policyReason: policy.policyReason };
  }

  return {
    createDefinition(
      input: Omit<AssessmentDefinition, 'id' | 'createdAt' | 'updatedAt'>,
    ): AssessmentDefinition {
      if (!repos.workspaces.get(input.workspaceId))
        throw notFound(`课程空间不存在:${input.workspaceId}`);
      const now = clock.now().toISOString();
      return repos.formalAssessments.insertDefinition(
        AssessmentDefinitionSchema.parse({
          ...input,
          id: newId('assessment'),
          createdAt: now,
          updatedAt: now,
        }),
      );
    },
    createVersion(input: {
      definitionId: string;
      items: FormalAssessmentItem[];
      sourceRevisionIds: string[];
      predecessorId?: string | null;
    }): AssessmentVersion {
      const definition = repos.formalAssessments.getDefinition(input.definitionId);
      if (!definition) throw notFound(`正式评估定义不存在:${input.definitionId}`);
      const items = input.items.map((item) => validateItem(definition.workspaceId, item));
      const boundRevisionIds = new Set(
        items.flatMap((item) => item.sourceBindings.map((binding) => binding.materialRevisionId)),
      );
      const declaredRevisionIds = new Set(input.sourceRevisionIds);
      if (
        declaredRevisionIds.size !== boundRevisionIds.size ||
        [...declaredRevisionIds].some((revisionId) => !boundRevisionIds.has(revisionId))
      ) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          '正式评估版本声明了未被题目绑定的来源修订。',
        );
      }
      const previous = repos.formalAssessments.listVersions(input.definitionId).at(-1);
      const now = clock.now().toISOString();
      return repos.formalAssessments.insertVersion(
        AssessmentVersionSchema.parse({
          id: newId('assessment_version'),
          definitionId: input.definitionId,
          version: (previous?.version ?? 0) + 1,
          predecessorId: input.predecessorId ?? previous?.id ?? null,
          status: 'draft',
          items,
          sourceRevisionIds: [...new Set(input.sourceRevisionIds)],
          createdAt: now,
          acceptedAt: null,
        }),
      );
    },
    acceptVersion(id: string) {
      return repos.formalAssessments.acceptVersion(id, clock.now().toISOString());
    },
    getVersion,
    startAttempt(assessmentVersionId: string, workspaceId: string): AssessmentAttempt {
      const version = getVersion(assessmentVersionId);
      const definition = repos.formalAssessments.getDefinition(version.definitionId);
      if (version.status !== 'accepted' || !definition || definition.workspaceId !== workspaceId)
        throw new AppError(
          ApiErrorCode.ValidationError,
          '只能执行当前课程空间已接受的正式评估版本。',
        );
      const now = clock.now().toISOString();
      const row = repos.formalAssessments.insertAttempt(
        AssessmentAttemptSchema.parse({
          id: newId('assessment_attempt'),
          assessmentVersionId,
          workspaceId,
          ordinal: repos.formalAssessments.nextAttemptOrdinal(assessmentVersionId),
          status: 'started',
          responses: {},
          startedAt: now,
          submittedAt: null,
          cancelledAt: null,
        }),
      );
      return row;
    },
    submitAttempt(id: string, responses: Record<string, string>) {
      return repos.formalAssessments.submitAttempt(id, responses, clock.now().toISOString());
    },
    cancelAttempt(id: string) {
      return repos.formalAssessments.cancelAttempt(id, clock.now().toISOString());
    },
    recordGrade(input: GradeRecord) {
      const attempt = repos.formalAssessments.getAttempt(input.attemptId);
      if (
        !attempt ||
        attempt.status !== 'submitted' ||
        attempt.assessmentVersionId !== input.assessmentVersionId
      )
        throw new AppError(
          ApiErrorCode.ValidationError,
          '只能为已提交且版本一致的正式评估尝试判分。',
        );
      if (input.supersedesId) {
        const prior = repos.formalAssessments.getGrade(input.supersedesId);
        if (
          !prior ||
          prior.attemptId !== input.attemptId ||
          prior.assessmentVersionId !== input.assessmentVersionId ||
          prior.status !== 'current'
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            '重判只能替换同一正式尝试的当前判分记录。',
          );
        }
      }
      return repos.formalAssessments.insertGrade(GradeRecordSchema.parse(input));
    },
    deriveEvidence(gradeRecordId: string): EvidenceRecord[] {
      const grade = repos.formalAssessments.getGrade(gradeRecordId);
      if (!grade || grade.status !== 'current') return [];
      const attempt = repos.formalAssessments.getAttempt(grade.attemptId);
      const version = getVersion(grade.assessmentVersionId);
      if (!attempt || attempt.status !== 'submitted') return [];
      const existing = repos.formalAssessments.listEvidenceForGrade(gradeRecordId);
      if (existing.length > 0) return existing;
      return version.items.flatMap((item) => {
        const result = grade.judgment.criterionResults.filter((r) =>
          item.rubric?.some((c) => c.id === r.criterionId),
        );
        const conclusion =
          !item.formalEligible || result.length === 0
            ? 'unsupported'
            : grade.judgment.score >= 0.6
              ? 'supported'
              : grade.judgment.score > 0
                ? 'partial'
                : 'unsupported';
        if (conclusion === 'unsupported') return [];
        return [
          repos.formalAssessments.insertEvidence(
            EvidenceRecordSchema.parse({
              id: newId('evidence'),
              attemptId: attempt.id,
              gradeRecordId,
              assessmentVersionId: version.id,
              itemId: item.id,
              targetLearningUnitId: item.targetLearningUnitId,
              conclusion,
              policyVersion: POLICY_VERSION,
              sourceBindingIds: item.sourceBindings.map((b) => b.sourceBlockId),
              createdAt: clock.now().toISOString(),
            }),
          ),
        ];
      });
    },
    reconcileEvidence(evidenceRecordId: string): ProgressionReconciliationRecord {
      const evidence = repos.formalAssessments.getEvidence(evidenceRecordId);
      if (!evidence) throw notFound(`正式证据不存在:${evidenceRecordId}`);
      const current = repos.formalAssessments.insertReconciliation(
        ProgressionReconciliationRecordSchema.parse({
          id: newId('reconciliation'),
          evidenceRecordId,
          status: 'pending',
          appliedAt: null,
          createdAt: clock.now().toISOString(),
        }),
      );
      return current.status === 'pending'
        ? repos.formalAssessments.markReconciled(current.id, clock.now().toISOString())
        : current;
    },
  };
}

export type FormalAssessmentsService = ReturnType<typeof createFormalAssessmentsService>;
