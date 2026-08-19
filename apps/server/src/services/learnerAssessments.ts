import {
  LearnerAssessmentExecutionSchema,
  LearnerRepairProjectionSchema,
  GradeRecordSchema,
  type AssessmentAttempt,
  type AssessmentVersion,
  type GradeRecord,
  type LearnerAssessmentExecution,
  type LearnerRepairProjection,
  type FormalAssessmentItem,
  type RubricGrade,
} from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { FormalAssessmentsService } from './formalAssessments.js';
import type { RepairService } from './repair.js';

const DIAGNOSIS_LABELS: Record<string, string> = {
  INCOMPLETE_EXPRESSION: '主要思路对了，但还缺少一个关键部分。',
  LOCAL_MISCONCEPTION: '这里对一个关键概念的理解有偏差。',
  RELATION_REVERSAL: '两个要素的方向或关系似乎反了。',
  PROCEDURAL_GAP: '概念基本对了，但步骤还没有走完整。',
  PREREQUISITE_GAP: '这道题依赖一小块前置知识，先补上会更快。',
  IRRELEVANT_OR_GUESSING: '这次回答还没有回应题目要求的关键内容。',
  UNCERTAIN: '这次回答还不足以判断具体卡在哪里，我们先做一个小检查。',
};

const INTERVENTION_LABELS: Record<string, string> = {
  TARGETED_PROMPT: '补全关键部分',
  CONTRAST: '对比辨析',
  SCAFFOLD: '分步练习',
  PREREQUISITE_REVIEW: '补一小块前置知识',
  RETEACH_RETRIEVAL: '重新回忆核心概念',
  CLARIFY: '澄清这次回答',
  NOTICE: '小提醒',
};

function normalizedScore(rubric: FormalAssessmentItem['rubric'], grade: RubricGrade): number {
  const points = rubric ?? [];
  const requiredIndexes = points.flatMap((point, index) => (point.required ? [index] : []));
  if (requiredIndexes.length === 0) return 0;
  const matched = new Set(grade.matchedKeyPointIndexes);
  const partial = new Set(grade.partialKeyPointIndexes ?? []);
  return Math.max(
    0,
    Math.min(
      1,
      requiredIndexes.reduce(
        (sum, index) => sum + (matched.has(index) ? 1 : partial.has(index) ? 0.5 : 0),
        0,
      ) / requiredIndexes.length,
    ),
  );
}

function locationLabel(
  block: NonNullable<ReturnType<Repositories['materials']['getBlock']>>,
): string {
  if (block.pageNumber !== null) return `第 ${block.pageNumber} 页`;
  if (block.slideNumber) return `第 ${block.slideNumber} 张幻灯片`;
  if (block.headingPath.length > 0) return block.headingPath.join(' › ');
  return `第 ${block.index + 1} 段`;
}

export function createLearnerAssessmentsService({
  repos,
  provider,
  clock,
  formalAssessments,
  repair,
}: {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  formalAssessments: FormalAssessmentsService;
  repair: RepairService;
}) {
  function sourceReferences(item: FormalAssessmentItem) {
    return item.sourceBindings.flatMap((binding) => {
      const block = repos.materials.getBlock(binding.sourceBlockId);
      const material = repos.materials.get(binding.materialId);
      if (!block || !material) return [];
      return [
        {
          materialTitle: material.title,
          locationLabel: locationLabel(block),
          excerpt: binding.quote,
          advisory: binding.contentOrigin !== 'extracted_original' || !binding.authoritative,
        },
      ];
    });
  }

  function itemProjection(item: FormalAssessmentItem) {
    return {
      itemId: item.id,
      prompt: item.prompt,
      purpose: '检验你是否能在自己的表述中说明这个关键能力。',
      sourceReferences: sourceReferences(item),
    };
  }

  function resultProjection(
    version: AssessmentVersion,
    grade: GradeRecord,
  ): LearnerAssessmentExecution['result'] {
    const criterionById = new Map(
      version.items.flatMap((item) =>
        (item.rubric ?? []).map((criterion) => [criterion.id, criterion] as const),
      ),
    );
    const criteria = grade.judgment.criterionResults.map((criterion) => ({
      criterionId: criterion.criterionId,
      label: criterionById.get(criterion.criterionId)?.text ?? '关键标准',
      result: criterion.result,
      message:
        criterion.result === 'met'
          ? '这一点已经在回答中体现。'
          : criterion.result === 'partial'
            ? '主要方向出现了，但还需要更完整地表达。'
            : '这一点还没有在回答中体现。',
    }));
    const item = version.items[0]!;
    const evidence = repos.formalAssessments.listEvidenceForGrade(grade.id);
    const diagnostic = grade.judgment.diagnostic;
    const demonstrated = grade.judgment.score >= 0.6;
    return {
      gradeRecordId: grade.id,
      demonstrated,
      summary: demonstrated
        ? grade.judgment.score >= 1
          ? '你已经展示了这项关键能力。'
          : '你已经抓住主要思路，但还有一部分需要补完整。'
        : (diagnostic && DIAGNOSIS_LABELS[diagnostic.category]) ||
          '这次回答还没有展示出所需的关键能力。',
      minorNotice:
        grade.judgment.score >= 1 && diagnostic?.category === 'SURFACE_SLIP'
          ? '理解正确。顺带注意一个小笔误即可。'
          : null,
      criteria,
      sourceReferences: sourceReferences(item),
      evidenceStatus: evidence.some((record) => record.conclusion === 'supported')
        ? 'supported'
        : evidence.some((record) => record.conclusion === 'partial')
          ? 'partial'
          : 'unavailable',
      repairEpisodeId: repos.repair.findByTriggerGrade(grade.id)?.id ?? null,
    };
  }

  function projection(
    version: AssessmentVersion,
    attempt: AssessmentAttempt,
  ): LearnerAssessmentExecution {
    const grade = repos.formalAssessments
      .listGrades(attempt.id)
      .find((candidate) => candidate.status === 'current');
    const definition = repos.formalAssessments.getDefinition(version.definitionId);
    return LearnerAssessmentExecutionSchema.parse({
      assessmentVersionId: version.id,
      title: definition?.title ?? '理解检查',
      attempt,
      items: version.items.filter((item) => item.formalEligible).map(itemProjection),
      result: grade ? resultProjection(version, grade) : null,
    });
  }

  function version(id: string): AssessmentVersion {
    const found = repos.formalAssessments.getVersion(id);
    if (!found || found.status !== 'accepted') throw notFound('正式检查不存在或已失效。');
    return found;
  }

  async function gradeAttempt(
    attempt: AssessmentAttempt,
    opts?: ProviderCallOptions,
  ): Promise<GradeRecord> {
    const assessmentVersion = version(attempt.assessmentVersionId);
    const criterionResults: GradeRecord['judgment']['criterionResults'] = [];
    let totalScore = 0;
    for (const item of assessmentVersion.items.filter((candidate) => candidate.formalEligible)) {
      const rubric = item.rubric ?? [];
      const providerGrade = await provider.gradeShortAnswer(
        {
          stem: item.prompt,
          expectedAnswer: rubric.map((criterion) => criterion.text).join('；'),
          rubricKeyPoints: rubric.map((criterion) => ({
            text: criterion.text,
            required: criterion.required,
          })),
          quote: item.sourceBindings[0]?.quote ?? '',
          answerText: attempt.responses[item.id] ?? '',
        },
        {
          ...opts,
          telemetry: {
            ...opts?.telemetry,
            workspaceId: attempt.workspaceId,
            operationType: 'grade_formal_short_answer',
            operationId: attempt.id,
            assessmentId: assessmentVersion.id,
            schemaFingerprint: 'formal-grade-v1',
          },
        },
      );
      const score = normalizedScore(rubric, providerGrade);
      totalScore += score;
      const matched = new Set(providerGrade.matchedKeyPointIndexes);
      const partial = new Set(providerGrade.partialKeyPointIndexes ?? []);
      rubric.forEach((criterion, index) => {
        criterionResults.push({
          criterionId: criterion.id,
          result: matched.has(index) ? 'met' : partial.has(index) ? 'partial' : 'not_met',
        });
      });
    }
    const count = assessmentVersion.items.filter((item) => item.formalEligible).length || 1;
    const score = Math.max(0, Math.min(1, totalScore / count));
    const diagnosticCategory =
      score === 0 ? 'IRRELEVANT_OR_GUESSING' : score < 1 ? 'INCOMPLETE_EXPRESSION' : undefined;
    const diagnostic = diagnosticCategory
      ? {
          category: diagnosticCategory as NonNullable<
            GradeRecord['judgment']['diagnostic']
          >['category'],
          affectedCriterionIds: criterionResults
            .filter((item) => item.result !== 'met')
            .map((item) => item.criterionId),
          summary: DIAGNOSIS_LABELS[diagnosticCategory]!,
          uncertainty: score === 0 ? 0.5 : 0.25,
        }
      : undefined;
    return GradeRecordSchema.parse({
      id: newId('grade'),
      attemptId: attempt.id,
      assessmentVersionId: assessmentVersion.id,
      grader: provider.name,
      rubricVersion: 'formal-short-answer-v1',
      status: 'current',
      judgment: {
        score,
        criterionResults,
        feedback: score >= 0.6 ? '回答已覆盖主要评分标准。' : '回答还需要补充关键评分标准。',
        ...(diagnostic ? { diagnostic } : {}),
      },
      supersedesId: null,
      createdAt: clock.now().toISOString(),
    });
  }

  return {
    start(versionId: string, workspaceId: string) {
      const assessmentVersion = version(versionId);
      const attempt = formalAssessments.startAttempt(assessmentVersion.id, workspaceId);
      return projection(assessmentVersion, attempt);
    },
    get(versionId: string, workspaceId: string) {
      const assessmentVersion = version(versionId);
      const attempt = repos.formalAssessments
        .listAttemptsForWorkspace(workspaceId)
        .find(
          (candidate) =>
            candidate.assessmentVersionId === versionId && candidate.status !== 'cancelled',
        );
      if (!attempt) return null;
      return projection(assessmentVersion, attempt);
    },
    async submit(attemptId: string, responses: Record<string, string>, opts?: ProviderCallOptions) {
      const attempt = repos.formalAssessments.getAttempt(attemptId);
      if (!attempt) throw notFound('正式检查尝试不存在。');
      const submitted = formalAssessments.submitAttempt(attempt.id, responses);
      const current = repos.formalAssessments
        .listGrades(submitted.id)
        .find((grade) => grade.status === 'current');
      if (current) return projection(version(submitted.assessmentVersionId), submitted);
      const grade = await gradeAttempt(submitted, opts);
      formalAssessments.recordGrade(grade);
      const evidence = formalAssessments.deriveEvidence(grade.id);
      if (grade.judgment.score < 0.6) repair.createForGrade(grade.id);
      const linkedEpisode = repos.repair
        .listByWorkspace(submitted.workspaceId)
        .find((candidate) => candidate.verificationAttemptId === submitted.id);
      if (linkedEpisode) {
        if (grade.judgment.score >= 0.6 && evidence.length > 0) {
          repair.resolveFromEvidence(linkedEpisode.id, evidence[0]!.id);
        } else {
          repair.recordVerificationFailure(linkedEpisode.id);
        }
      }
      return projection(version(submitted.assessmentVersionId), submitted);
    },
    cancel(attemptId: string) {
      const attempt = formalAssessments.cancelAttempt(attemptId);
      if (!attempt) throw notFound('正式检查尝试不存在。');
      return projection(version(attempt.assessmentVersionId), attempt);
    },
    async startRepair(gradeRecordId: string, opts?: ProviderCallOptions) {
      const episode = repair.createForGrade(gradeRecordId);
      if (!episode) return null;
      await repair.generatePacket(episode.id, opts);
      return this.getRepair(episode.id);
    },
    getRepair(episodeId: string): LearnerRepairProjection {
      const detail = repair.inspect(episodeId);
      const packet = detail.packets.at(-1) ?? null;
      const versionValue = repos.formalAssessments.getVersion(detail.episode.assessmentVersionId);
      const item = versionValue?.items.find((candidate) => candidate.id === detail.episode.itemId);
      const sourceReferences = item
        ? sourceReferencesForIds(item.sourceBindings.map((binding) => binding.sourceBlockId))
        : [];
      return LearnerRepairProjectionSchema.parse({
        episodeId: detail.episode.id,
        status: detail.episode.status,
        diagnosis:
          DIAGNOSIS_LABELS[detail.episode.diagnosticCategory] ?? '这次回答还需要进一步澄清。',
        target: '当前这项学习能力',
        attemptCount: detail.episode.attemptCount,
        packet: packet
          ? {
              interventionLabel: INTERVENTION_LABELS[packet.interventionMode] ?? '针对性练习',
              explanation: packet.explanation,
              practicePrompt: packet.practicePrompt,
              hints: packet.hints,
            }
          : null,
        practice: detail.practice.map((event) => ({
          ordinal: event.ordinal,
          response: event.responseSummary,
          outcome: event.outcome,
          createdAt: event.createdAt,
        })),
        sourceReferences,
        verificationAssessmentVersionId:
          versionValue && detail.episode.verificationAttemptId
            ? (repos.formalAssessments.getAttempt(detail.episode.verificationAttemptId)
                ?.assessmentVersionId ?? null)
            : null,
        resolved: detail.episode.status === 'RESOLVED',
        deeperSupportRecommended:
          detail.episode.status === 'DEFERRED' && detail.episode.attemptCount >= 3,
      });
    },
    practice(
      episodeId: string,
      response: string,
      outcome: 'CONTINUE' | 'READY_FOR_VERIFICATION' | 'NEEDS_MORE_SUPPORT',
    ) {
      repair.recordPractice(episodeId, response, outcome);
      return this.getRepair(episodeId);
    },
    defer(episodeId: string) {
      repair.defer(episodeId);
      return this.getRepair(episodeId);
    },
    cancelRepair(episodeId: string) {
      repair.cancel(episodeId);
      return this.getRepair(episodeId);
    },
    resumeRepair(episodeId: string) {
      repair.resume(episodeId);
      return this.getRepair(episodeId);
    },
    createVerification(episodeId: string) {
      const detail = repair.inspect(episodeId);
      const sourceVersion = version(detail.episode.assessmentVersionId);
      const item = sourceVersion.items.find((candidate) => candidate.id === detail.episode.itemId);
      if (!item) throw notFound('Repair 目标题目不存在。');
      if (detail.episode.status === 'DEFERRED') repair.resume(episodeId);
      if (repair.get(episodeId).status === 'ACTIVE') repair.markAwaitingVerification(episodeId);
      const successorItem: FormalAssessmentItem = {
        ...item,
        id: newId('verification_item'),
        index: 0,
        prompt: `换个情境再确认一下：${item.prompt}`,
      };
      const successor = formalAssessments.createVersion({
        definitionId: sourceVersion.definitionId,
        predecessorId: sourceVersion.id,
        items: [successorItem],
        sourceRevisionIds: successorItem.sourceBindings.map(
          (binding) => binding.materialRevisionId,
        ),
      });
      const accepted = repos.formalAssessments.acceptVersion(
        successor.id,
        clock.now().toISOString(),
      );
      const attempt = formalAssessments.startAttempt(accepted.id, detail.episode.workspaceId);
      repair.linkVerificationAttempt(episodeId, attempt.id);
      return projection(accepted, attempt);
    },
    async submitVerification(
      attemptId: string,
      responses: Record<string, string>,
      opts?: ProviderCallOptions,
    ) {
      const attempt = repos.formalAssessments.getAttempt(attemptId);
      if (!attempt) throw notFound('验证尝试不存在。');
      const output = await this.submit(attemptId, responses, opts);
      const grade = repos.formalAssessments
        .listGrades(attemptId)
        .find((candidate) => candidate.status === 'current');
      if (!grade) return output;
      const episode = repos.repair
        .listByWorkspace(attempt.workspaceId)
        .find((candidate) => candidate.verificationAttemptId === attemptId);
      if (!episode) return output;
      const evidence = formalAssessments.deriveEvidence(grade.id);
      if (grade.judgment.score >= 0.6 && evidence.length > 0)
        repair.resolveFromEvidence(episode.id, evidence[0]!.id);
      else repair.recordVerificationFailure(episode.id);
      return output;
    },
  };

  function sourceReferencesForIds(ids: string[]) {
    return ids.flatMap((id) => {
      const block = repos.materials.getBlock(id);
      const material = block ? repos.materials.get(block.materialId) : undefined;
      if (!block || !material) return [];
      return [
        {
          materialTitle: material.title,
          locationLabel: locationLabel(block),
          excerpt: block.content,
          advisory: block.contentOrigin !== 'extracted_original',
        },
      ];
    });
  }
}

export type LearnerAssessmentsService = ReturnType<typeof createLearnerAssessmentsService>;
