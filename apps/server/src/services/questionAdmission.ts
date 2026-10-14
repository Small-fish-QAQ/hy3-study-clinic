import {
  COURSE_POLICY,
  AdmittedCourseQuestionSchema,
  CourseQuestionSchema,
  type AdmittedCourseQuestion,
  type CourseQuestion,
  type CourseKnowledge,
  type CourseAssessmentBlueprint,
} from '@hy3-clinic/shared';
import {
  SolutionSchema,
  solutionSchemaFor,
  RubricReviewSchema,
  type SolveInput,
  type RubricReviewInput,
} from '../llm/courseContract.js';
import type { CourseOperationContext } from './courseOperationRunner.js';
import type { CourseSources } from './courseSources.js';
import type { CourseGeneration } from './courseGeneration.js';
import { requireValid, unique, demandRank, difficultyRank } from './courseValidation.js';
import { sha256 } from '../util/canonical.js';
import { AppError } from '../errors.js';

export const publicQuestion = (q: CourseQuestion) => ({
  id: q.id,
  slotId: q.slotId,
  type: q.type,
  prompt: q.prompt,
  options: q.options,
  knowledgeIds: q.knowledgeIds,
  origin: q.origin,
  difficultyBand: q.difficultyBand,
  demand: q.demand,
});
export const questionHash = (q: CourseQuestion) =>
  sha256({ ...q, explanation: undefined, admission: undefined });
export const INVALID_FORMAL_COVERAGE = '正式题目标或难度不匹配';
/** Broken response references are a review contract failure, not evidence of a bad question. */
export function rubricReviewReferencesValid(
  value: ReturnType<typeof RubricReviewSchema.parse>,
  input: RubricReviewInput,
) {
  const known = new Set(input.requestedKnowledge.map((k) => k.id));
  const objectives = new Set(input.expectedObjectives?.map((o) => o.id) ?? []);
  const criteria = new Set(input.rubric.map((c) => c.id));
  return (
    unique(value.criteria.map((c) => c.criterionId)) &&
    value.criteria.length === criteria.size &&
    value.criteria.every(
      (c) =>
        criteria.has(c.criterionId) &&
        unique(c.assessedKnowledgeIds) &&
        c.assessedKnowledgeIds.every((id) => known.has(id)),
    ) &&
    unique(value.coverage.map((c) => c.cellId)) &&
    value.coverage.every(
      (c) =>
        input.expectedCells.some((cell) => cell.id === c.cellId) &&
        c.criterionIds.every((id) => criteria.has(id)) &&
        c.assessedKnowledgeIds.every((id) => known.has(id)) &&
        (c.objectiveIds ?? []).every((id) => objectives.has(id)) &&
        c.representativeSetIds.every((id) =>
          input.expectedCells.some(
            (cell) => cell.id === c.cellId && cell.representativeSets.some((set) => set.id === id),
          ),
        ),
    )
  );
}
export class QuestionAdmission {
  constructor(
    readonly sources: CourseSources,
    readonly generation: CourseGeneration,
  ) {}
  private blindInput(
    ctx: CourseOperationContext,
    q: CourseQuestion,
    knowledge: CourseKnowledge[],
    learnerVisibleContext: string[],
    blueprint: CourseAssessmentBlueprint | null,
    previousQuestions: Pick<CourseQuestion, 'prompt' | 'options'>[],
  ): SolveInput {
    const relevant = knowledge.filter((k) => q.knowledgeIds.includes(k.id));
    const cells = blueprint?.cells.filter((c) => q.coverage.some((v) => v.cellId === c.id)) ?? [];
    const objectives = blueprint?.objectiveRequirements?.filter((o) =>
      cells.some((c) => c.objectiveIds.includes(o.id)),
    );
    return {
      question: { id: q.id, type: q.type, prompt: q.prompt, options: q.options },
      learnerVisibleContext,
      referenceSourcesForFactCheck: this.sources.references(
        ctx.workspaceId,
        relevant.flatMap((k) => k.sourceSpans),
      ),
      requestedKnowledge: relevant,
      expectedCells: cells,
      ...(objectives ? { expectedObjectives: objectives } : {}),
      previousQuestions,
    };
  }
  /** Reopen an exhausted historical slot only with a complete, matching bad review as proof. */
  retainedRubricContractFailure(
    ctx: CourseOperationContext,
    q: CourseQuestion,
    knowledge: CourseKnowledge[],
    learnerVisibleContext: string[],
    blueprint: CourseAssessmentBlueprint | null,
    previousQuestions: Pick<CourseQuestion, 'prompt' | 'options'>[],
  ): boolean {
    if (q.type !== 'short_answer') return false;
    const blind = this.blindInput(
      ctx,
      q,
      knowledge,
      learnerVisibleContext,
      blueprint,
      previousQuestions,
    );
    const sourceHash = sha256(blind.referenceSourcesForFactCheck);
    const solved = this.generation.retainedStage(
      ctx,
      'solveQuestion',
      blind,
      sourceHash,
      SolutionSchema,
    );
    if (!solved) return false;
    const input = {
      ...blind,
      authorAnswer: solved.value.answer,
      rubric: q.rubric,
      independentSolution: solved.value,
    };
    const reviewed = this.generation.retainedStage(
      ctx,
      'reviewQuestionRubric',
      input,
      sourceHash,
      RubricReviewSchema,
    );
    if (!reviewed || !reviewed.value.accepted || rubricReviewReferencesValid(reviewed.value, input))
      return false;
    this.generation.reject(reviewed.callId, ['rubric_review_invalid_references']);
    return true;
  }
  async admit(
    ctx: CourseOperationContext,
    raw: CourseQuestion,
    knowledge: CourseKnowledge[],
    learnerVisibleContext: string[],
    blueprint: CourseAssessmentBlueprint | null,
    previousQuestions: Pick<CourseQuestion, 'prompt' | 'options'>[] = [],
    retainedOnly = false,
  ): Promise<AdmittedCourseQuestion> {
    // Formative work cannot earn Formal coverage. This unused author annotation
    // is server-owned; dropping it does not change the question, key or rubric.
    const q = CourseQuestionSchema.parse(blueprint ? raw : { ...raw, coverage: [] });
    const errors: string[] = [];
    const ids = new Set(knowledge.map((k) => k.id));
    const revisions = new Set(knowledge.flatMap((k) => k.sourceSpans.map((s) => s.revisionId)));
    if (!unique(q.knowledgeIds) || q.knowledgeIds.some((id) => !ids.has(id)))
      errors.push('题目知识引用越界或重复');
    if (q.origin === 'textbook' && !q.sourceRefs.length) errors.push('题目缺少教材来源');
    if (q.origin === 'extension' && q.sourceRefs.length) errors.push('拓展题伪造教材引文');
    for (const ref of q.sourceRefs) {
      try {
        this.sources.validateSpan(ctx.workspaceId, ref, revisions);
      } catch (error) {
        if (!(error instanceof AppError) || !['NOT_FOUND', 'GROUNDING_FAILED'].includes(error.code))
          throw error;
        errors.push(`题目引文不存在、越界或不属于当前来源:${ref.blockId}`);
      }
    }
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      if (
        q.options.length < 2 ||
        !unique(q.options.map((o) => o.id)) ||
        !unique(q.options.map((o) => o.text.trim()))
      )
        errors.push('客观题选项不唯一或不足');
      if (
        q.answer.some((id) => !q.options.some((o) => o.id === id)) ||
        !unique(q.answer) ||
        (q.type === 'single_choice' && q.answer.length !== 1)
      )
        errors.push('客观题答案集合无效');
      if (q.rubric.length) errors.push('客观题不接受主观rubric');
    } else {
      if (
        q.options.length ||
        !q.rubric.some((c) => c.required) ||
        !unique(q.rubric.map((c) => c.id))
      )
        errors.push('主观题rubric缺少必需项或结构错误');
      if (q.rubric.some((c) => c.knowledgeIds.some((id) => !q.knowledgeIds.includes(id))))
        errors.push('rubric绑定隐藏知识');
    }
    if (
      previousQuestions.some(
        (old) =>
          old.prompt.replace(/\s/gu, '') === q.prompt.replace(/\s/gu, '') &&
          sha256(old.options) === sha256(q.options),
      )
    )
      errors.push('重复已曝光题面');
    for (const claim of q.coverage) {
      const cell = blueprint?.cells.find((c) => c.id === claim.cellId);
      if (
        !cell ||
        demandRank[q.demand] < demandRank[cell.demand] ||
        difficultyRank[q.difficultyBand] < difficultyRank[cell.difficultyBand]
      )
        errors.push(INVALID_FORMAL_COVERAGE);
    }
    requireValid([...new Set(errors)]);
    const blindInput = this.blindInput(
      ctx,
      q,
      knowledge,
      learnerVisibleContext,
      blueprint,
      previousQuestions,
    );
    const sources = blindInput.referenceSourcesForFactCheck;
    const objectives = blindInput.expectedObjectives;
    const solutionSchema = solutionSchemaFor(blindInput);
    const solved = retainedOnly
      ? this.generation.retainedStage(
          ctx,
          'solveQuestion',
          blindInput,
          sha256(sources),
          solutionSchema,
        )
      : await this.generation.stage(
          ctx,
          'solveQuestion',
          blindInput,
          sha256(sources),
          solutionSchema,
          (opts) => ctx.provider.solveQuestion(blindInput, opts),
        );
    if (!solved)
      throw new AppError('VERSION_CONFLICT', '已保存盲解无法安全复用；未发送新的模型请求。');
    const answer = solved.value;
    requireValid(answer.answer.length ? [] : ['独立解题没有可信答案']);
    if (answer.uncertain) {
      this.generation.reject(solved.callId, ['question_review_uncertain'], ctx.operationId);
      throw new AppError(
        'PROVIDER_INVALID_OUTPUT',
        '题目核验仍不能确定，候选已保存；请恢复核验，不会消耗内容替换额度。',
      );
    }
    if (previousQuestions.length)
      requireValid(answer.exposureCheck.novel ? [] : ['题目与已曝光题实质重复']);
    requireValid(
      !answer.solvable ||
        answer.missingConditions.length ||
        answer.ambiguities.length ||
        !answer.sourceSupported
        ? [
            '题目不可独立解答、条件不完整或来源不支持',
            ...answer.missingConditions,
            ...answer.ambiguities,
          ]
        : [],
    );
    requireValid(
      answer.assessedKnowledgeIds.some((id) => !q.knowledgeIds.includes(id)) ||
        !answer.assessedKnowledgeIds.length
        ? ['独立解题没有实际知识覆盖或超范围']
        : [],
    );
    if (objectives)
      requireValid(
        !unique(answer.assessedObjectiveIds ?? []) ||
          answer.assessedObjectiveIds?.some((id) => !objectives.some((o) => o.id === id))
          ? ['盲解教学目标越界或重复']
          : [],
      );
    const callIds = [solved.callId];
    let coverage = answer.coverage;
    if (q.type !== 'short_answer')
      requireValid(
        sha256([...q.answer].sort()) !== sha256([...answer.answer].sort())
          ? ['作者答案与独立解题不一致']
          : [],
      );
    else {
      const input = {
        ...blindInput,
        authorAnswer: answer.answer,
        rubric: q.rubric,
        independentSolution: answer,
      };
      const reviewed = retainedOnly
        ? this.generation.retainedStage(
            ctx,
            'reviewQuestionRubric',
            input,
            sha256(sources),
            RubricReviewSchema,
          )
        : await this.generation.stage(
            ctx,
            'reviewQuestionRubric',
            input,
            sha256(sources),
            RubricReviewSchema,
            (opts) => ctx.provider.reviewQuestionRubric(input, opts),
          );
      if (!reviewed)
        throw new AppError(
          'VERSION_CONFLICT',
          '已保存评分标准核查无法安全复用；未发送新的模型请求。',
        );
      callIds.push(reviewed.callId);
      if (reviewed.value.uncertain) {
        this.generation.reject(reviewed.callId, ['rubric_review_uncertain'], ctx.operationId);
        throw new AppError('PROVIDER_INVALID_OUTPUT', '答案与评分标准核验尚不能确定，请恢复核验。');
      }
      if (reviewed.value.accepted && reviewed.value.findings.length) {
        this.generation.reject(
          reviewed.callId,
          ['rubric_review_contract_conflict'],
          ctx.operationId,
        );
        throw new AppError(
          'PROVIDER_INVALID_OUTPUT',
          '评分标准核查同时返回通过与问题列表，候选已保存；请恢复核查，不会消耗题目替换额度。',
        );
      }
      if (reviewed.value.accepted && !rubricReviewReferencesValid(reviewed.value, input)) {
        this.generation.reject(
          reviewed.callId,
          ['rubric_review_invalid_references'],
          ctx.operationId,
        );
        throw new AppError(
          'PROVIDER_INVALID_OUTPUT',
          '评分标准核查的证据引用不完整或越界，题目与盲解已保存；请恢复核查。',
        );
      }
      requireValid(
        !reviewed.value.accepted || reviewed.value.findings.length
          ? reviewed.value.findings.length
            ? reviewed.value.findings
            : ['答案与rubric核查未通过']
          : [],
      );
      if (
        q.rubric.some((c) => {
          const checks = reviewed.value.criteria.find(
            (r) => r.criterionId === c.id,
          )?.alternativeChecks;
          return (
            !checks ||
            !unique(checks.map((a) => a.text)) ||
            c.acceptableAlternatives.some((text) => !checks.some((a) => a.text === text))
          );
        })
      ) {
        this.generation.reject(
          reviewed.callId,
          ['alternative_equivalence_check_incomplete'],
          ctx.operationId,
        );
        throw new AppError(
          'PROVIDER_INVALID_OUTPUT',
          '替代答案的等价核查不完整，候选已保存；请恢复本次核查。',
        );
      }
      requireValid(
        q.rubric.some(
          (c) =>
            !reviewed.value.criteria.some(
              (r) =>
                r.criterionId === c.id &&
                r.supported &&
                // Every weighted criterion contributes to the score. An optional
                // mastery condition must not introduce an unasked deduction.
                r.requiredByQuestion &&
                c.knowledgeIds.every((id) => r.assessedKnowledgeIds.includes(id)),
            ),
        ) || reviewed.value.criteria.some((r) => !q.rubric.some((c) => c.id === r.criterionId))
          ? ['rubric准入遗漏、隐藏要求或知识覆盖错误']
          : [],
      );
      coverage = reviewed.value.coverage;
      requireValid(
        answer.assessedKnowledgeIds.some(
          (id) => !q.rubric.some((c) => c.required && c.knowledgeIds.includes(id)),
        )
          ? ['主观实测知识缺少必需评分criterion']
          : [],
      );
      q.rubric = q.rubric.map((c) => ({
        ...c,
        acceptableAlternatives: reviewed.value.criteria
          .find((r) => r.criterionId === c.id)!
          .alternativeChecks.filter((a) => a.equivalent)
          .map((a) => a.text),
      }));
    }
    const criterionIds = q.type === 'short_answer' ? q.rubric.map((c) => c.id) : ['answer'];
    for (const c of coverage) {
      const cell = blueprint?.cells.find((cell) => cell.id === c.cellId);
      const issues: string[] = [];
      if (!cell) issues.push(`实测覆盖引用了未知能力:${c.cellId}`);
      if (c.criterionIds.some((id) => !criterionIds.includes(id)))
        issues.push(`实测覆盖评分点不匹配:${c.cellId}:允许${criterionIds.join(',')}`);
      const unsupportedKnowledge = c.assessedKnowledgeIds.filter(
        (id) => !answer.assessedKnowledgeIds.includes(id),
      );
      if (unsupportedKnowledge.length)
        issues.push(
          `实测覆盖声明了盲解未实际检验的知识:${c.cellId}:${unsupportedKnowledge.join(',')}`,
        );
      if (cell && demandRank[c.demand] < demandRank[cell.demand])
        issues.push(`实测能力降格:${cell.id}:需要${cell.demand},实际${c.demand}`);
      if (objectives)
        for (const objectiveId of c.objectiveIds ?? []) {
          const objective = objectives.find((o) => o.id === objectiveId);
          if (
            !objective ||
            !cell?.objectiveIds.includes(objectiveId) ||
            !answer.assessedObjectiveIds?.includes(objectiveId) ||
            demandRank[c.demand] < demandRank[objective.demand] ||
            !c.assessedKnowledgeIds.some((id) => objective.knowledgeIds.includes(id))
          )
            issues.push(`实测教学目标缺少独立支持:${objectiveId}`);
          if (
            objective &&
            q.type === 'short_answer' &&
            !q.rubric.some(
              (criterion) =>
                criterion.required &&
                c.criterionIds.includes(criterion.id) &&
                criterion.knowledgeIds.some(
                  (id) =>
                    objective.knowledgeIds.includes(id) && c.assessedKnowledgeIds.includes(id),
                ),
            )
          )
            issues.push(`实测教学目标缺少必需评分点:${objectiveId}`);
        }
      for (const setId of c.representativeSetIds) {
        const set = cell?.representativeSets.find((s) => s.id === setId);
        if (!set || !c.assessedKnowledgeIds.some((k) => set.candidateKnowledgeIds.includes(k)))
          issues.push(`代表集合没有实际考查成员:${c.cellId}:${setId}`);
      }
      requireValid(issues);
    }
    if (blueprint)
      requireValid(
        q.coverage.some(
          (c) =>
            !coverage.some(
              (a) =>
                a.cellId === c.cellId &&
                c.assessedKnowledgeIds.every((k) => a.assessedKnowledgeIds.includes(k)),
            ),
        )
          ? ['题目自报覆盖未被独立核查支持']
          : [],
      );
    // Membership is a local fact about the independently assessed knowledge,
    // not another model judgment. Keep rejecting false/unknown claims above,
    // but do not treat omission of redundant set IDs as missing performance.
    coverage = coverage.map((c) => ({
      ...c,
      representativeSetIds: blueprint!.cells
        .find((cell) => cell.id === c.cellId)!
        .representativeSets.filter((s) =>
          c.assessedKnowledgeIds.some((id) => s.candidateKnowledgeIds.includes(id)),
        )
        .map((s) => s.id),
    }));
    q.coverage = coverage;
    q.knowledgeIds = answer.assessedKnowledgeIds;
    // Author prose is a candidate. The existing independent solution and rubric
    // check establish the accepted key used by both the learner and the grader.
    q.answer = answer.answer;
    q.explanation = answer.explanation;
    return AdmittedCourseQuestionSchema.parse({
      ...q,
      admission: {
        policyVersion: COURSE_POLICY,
        questionHash: questionHash(q),
        publicSurfaceHash: sha256(publicQuestion(q)),
        privateAnswerHash: sha256(q.answer),
        rubricHash: sha256(q.rubric),
        sourceScopeHash: sha256(sources),
        demandHash: sha256({ demand: q.demand, difficulty: q.difficultyBand, coverage }),
        callIds,
        verification: 'blind_solution',
        coverage,
        verifiedExplanation: answer.explanation,
      },
    });
  }
  validateAccepted(q: AdmittedCourseQuestion) {
    const a = q.admission;
    requireValid(
      a.policyVersion !== COURSE_POLICY ||
        a.questionHash !== questionHash(q) ||
        a.publicSurfaceHash !== sha256(publicQuestion(q)) ||
        a.privateAnswerHash !== sha256(q.answer) ||
        a.rubricHash !== sha256(q.rubric) ||
        a.demandHash !==
          sha256({ demand: q.demand, difficulty: q.difficultyBand, coverage: q.coverage }) ||
        sha256(a.coverage) !== sha256(q.coverage)
        ? ['已准入题目hash或policy已失效']
        : [],
    );
  }
}
