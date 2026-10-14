import {
  COURSE_POLICY,
  CourseSubmissionSchema,
  CourseItemGradeSchema,
  type CourseQuiz,
  type CourseSubmission,
  type CourseAnswer,
  type CourseItemGrade,
  type CourseCommand,
} from '@hy3-clinic/shared';
import { CourseShortGradeSchema, type ShortAnswerInput } from '../llm/courseContract.js';
import type { ClinicRepository } from '../repositories/clinic.js';
import { newClinicId } from '../repositories/clinic.js';
import type { CourseQuestions } from './courseQuestions.js';
import { checkPaperCoverage } from './courseQuestions.js';
import type { CourseSources } from './courseSources.js';
import type { CourseGeneration } from './courseGeneration.js';
import type { QuestionAdmission } from './questionAdmission.js';
import { questionHash } from './questionAdmission.js';
import type { GradedStudyOutcomes } from './gradedStudyOutcomes.js';
import type { CourseOperationRunner } from './courseOperationRunner.js';
import { type CourseOperationContext } from './courseOperationRunner.js';
import { requireValid, unique } from './courseValidation.js';
import { canonical, sha256, stableId } from '../util/canonical.js';
import { AppError } from '../errors.js';

export class CourseGrading {
  constructor(
    readonly repo: ClinicRepository,
    readonly questions: CourseQuestions,
    readonly sources: CourseSources,
    readonly generation: CourseGeneration,
    readonly admission: QuestionAdmission,
    readonly outcomes: GradedStudyOutcomes,
    readonly operations: CourseOperationRunner,
  ) {}
  startFormal(workspaceId: string, versionId: string, command: CourseCommand) {
    return this.repo.command(workspaceId, command, { action: 'startFormal', versionId }, () => {
      const quiz = this.questions.get(workspaceId, versionId);
      if (quiz.purpose !== 'formal' || quiz.status !== 'ready')
        throw new AppError('VERSION_CONFLICT', '正式试卷未就绪。');
      requireValid(checkPaperCoverage(quiz));
      quiz.items.forEach((q) => this.admission.validateAccepted(q));
      const plan = this.questions.planning.get(workspaceId, quiz.curriculumId)!;
      this.sources.assertCurrent(
        workspaceId,
        this.questions.planning.inventory(plan).sourceScopeHash,
      );
      const existing = this.repo.payload<{ id: string; workspaceId: string; quizId: string }>(
        'SELECT payload FROM assessment_attempts WHERE assessment_version_id=?',
        versionId,
      );
      if (existing) return { ...existing, quiz: this.questions.public(quiz) };
      const attempt = {
        id: newClinicId('attempt'),
        workspaceId,
        quizId: versionId,
        createdAt: this.repo.now(),
      };
      this.repo.run(
        'INSERT INTO assessment_attempts VALUES(?,?,?,?,?,?)',
        attempt.id,
        workspaceId,
        versionId,
        null,
        canonical(attempt),
        attempt.createdAt,
      );
      return { ...attempt, quiz: this.questions.public(quiz) };
    });
  }
  submit(
    workspaceId: string,
    quizId: string,
    command: CourseCommand,
    responses: CourseAnswer[],
    expectedVersion: number,
  ) {
    const frozen = this.repo.command(
      workspaceId,
      command,
      { action: 'submit', quizId, responses, expectedVersion },
      () => {
        const quiz = this.questions.get(workspaceId, quizId);
        if (quiz.status !== 'ready' || quiz.version !== expectedVersion)
          throw new AppError('VERSION_CONFLICT', '试卷版本改变或尚未就绪。');
        if (
          !unique(responses.map((a) => a.questionId)) ||
          responses.length !== quiz.items.length ||
          quiz.items.some((q) => !responses.some((a) => a.questionId === q.id))
        )
          throw new AppError('VALIDATION_ERROR', '交卷必须包含完整且唯一的题目作答。');
        for (const response of responses) {
          const q = quiz.items.find((q) => q.id === response.questionId)!;
          if (
            q.type === 'short_answer'
              ? typeof response.response !== 'string'
              : !Array.isArray(response.response) ||
                response.response.some((id) => !q.options.some((o) => o.id === id)) ||
                !unique(response.response) ||
                (q.type === 'single_choice' && response.response.length !== 1)
          )
            throw new AppError('VALIDATION_ERROR', '答案类型或选项不符合题目。');
        }
        const existing = this.repo.row<{ payload: string; answers_hash: string }>(
          'SELECT payload,answers_hash FROM submissions WHERE quiz_id=?',
          quizId,
        );
        const sorted = responses
          .map((a) => ({
            ...a,
            assistance: this.repo.row(
              'SELECT item_id FROM quiz_exposures WHERE quiz_id=? AND item_id=?',
              quiz.id,
              a.questionId,
            )
              ? ('hint' as const)
              : a.assistance,
          }))
          .sort((a, b) => a.questionId.localeCompare(b.questionId));
        const hash = sha256(sorted);
        if (existing) {
          if (existing.answers_hash !== hash)
            throw new AppError('VERSION_CONFLICT', '已交卷的答案不可修改。');
          return CourseSubmissionSchema.parse(JSON.parse(existing.payload));
        }
        if (
          quiz.purpose === 'formal' &&
          !this.repo.row('SELECT id FROM assessment_attempts WHERE assessment_version_id=?', quizId)
        )
          throw new AppError('VERSION_CONFLICT', '请先开始正式考试。');
        const submission: CourseSubmission = {
          id: newClinicId('submission'),
          workspaceId,
          quizId,
          responses: sorted,
          submittedAt: this.repo.now(),
          status: 'submitted',
          version: 1,
          itemGrades: [],
          score: null,
          passed: null,
          operationId: null,
        };
        this.repo.run(
          'INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?)',
          submission.id,
          workspaceId,
          quizId,
          submission.status,
          hash,
          canonical(sorted),
          submission.submittedAt,
          canonical(submission),
        );
        if (quiz.purpose === 'formal')
          this.repo.run(
            'UPDATE assessment_attempts SET submission_id=? WHERE assessment_version_id=?',
            submission.id,
            quizId,
          );
        return submission;
      },
    );
    if (frozen.status === 'graded') return { submission: frozen, operation: null };
    const operation = this.operations.start(
      workspaceId,
      {
        commandId: `${command.commandId}:grade`,
        idempotencyKey: `${command.idempotencyKey}:grade`,
      },
      'gradeAssessment',
      `grade:${frozen.id}`,
      'submission',
      { submissionId: frozen.id },
    );
    return { submission: frozen, operation };
  }
  async grade(ctx: CourseOperationContext, request: { submissionId: string }) {
    let submission = CourseSubmissionSchema.parse(
      this.repo.owned('submissions', request.submissionId, ctx.workspaceId),
    );
    if (submission.status === 'graded') {
      this.project(submission);
      return { resourceId: submission.id };
    }
    const quiz = this.questions.get(ctx.workspaceId, submission.quizId);
    if (
      quiz.purpose === 'retest' &&
      this.repo.row<{ status: string }>(
        'SELECT status FROM repair_rounds WHERE retest_quiz_id=?',
        quiz.id,
      )?.status === 'cancelled'
    )
      throw new AppError('VERSION_CONFLICT', '本补救轮已取消，旧评分操作不能继续写学习结果。');
    quiz.items.forEach((q) => this.admission.validateAccepted(q));
    const attempt =
      quiz.purpose === 'formal'
        ? this.repo.row<{ id: string }>(
            'SELECT id FROM assessment_attempts WHERE submission_id=?',
            submission.id,
          )
        : null;
    for (const q of quiz.items) {
      const response = submission.responses.find((a) => a.questionId === q.id)!;
      const answerHash = sha256(response);
      const rubricHash = sha256(q.rubric);
      const qHash = questionHash(q);
      const prior = attempt
        ? this.repo.payload<CourseItemGrade>(
            'SELECT payload FROM assessment_item_grades WHERE attempt_id=? AND item_id=? AND answer_hash=? AND grading_policy=?',
            attempt.id,
            q.id,
            answerHash,
            COURSE_POLICY,
          )
        : submission.itemGrades.find((g) => g.questionId === q.id);
      if (prior) {
        requireValid(
          prior.answerHash !== answerHash ||
            prior.questionHash !== qHash ||
            prior.rubricHash !== rubricHash
            ? ['评分恢复hash不一致']
            : [],
        );
        if (!submission.itemGrades.some((g) => g.id === prior.id))
          submission = { ...submission, itemGrades: [...submission.itemGrades, prior] };
        continue;
      }
      let score: number;
      let criteria: CourseItemGrade['criteria'];
      let feedback: string;
      let confidence = 1;
      const callIds: string[] = [];
      if (q.type !== 'short_answer') {
        const actual = response.response as string[];
        score = sha256([...actual].sort()) === sha256([...q.answer].sort()) ? 1 : 0;
        criteria = [];
        feedback =
          score === 1
            ? `回答正确。${q.admission.verifiedExplanation}`
            : `本次回答尚未达到要求。${q.admission.verifiedExplanation}`;
      } else {
        const sources = this.sources.references(ctx.workspaceId, q.sourceRefs);
        let input: ShortAnswerInput = {
          question: { id: q.id, type: q.type, prompt: q.prompt, options: q.options },
          response: response.response as string,
          answer: q.answer,
          rubric: q.rubric,
          sources,
        };
        let graded = await this.generation.stage(
          ctx,
          'gradeShortAnswer',
          input,
          sha256({
            sources,
            submission: submission.id,
            answerHash,
            qHash,
            rubricHash,
            policy: COURSE_POLICY,
          }),
          CourseShortGradeSchema,
          (opts) => ctx.provider.gradeShortAnswer(input, opts),
        );
        callIds.push(graded.callId);
        const anomalies = () => {
          const value = graded.value;
          return (
            value.uncertain ||
            value.confidence < 0.6 ||
            value.evidenceFlags.length > 0 ||
            !unique(value.criteria.map((c) => c.criterionId)) ||
            q.rubric.some((c) => !value.criteria.some((r) => r.criterionId === c.id)) ||
            value.criteria.some((c) => !q.rubric.some((r) => r.id === c.criterionId))
          );
        };
        if (anomalies()) {
          this.generation.reject(graded.callId, ['grading_anomaly']);
          input = {
            ...input,
            revision: {
              previous: graded.value,
              findings: ['评分不确定、低置信度或criterion集合不完整'],
            },
          };
          graded = await this.generation.stage(
            ctx,
            'gradeShortAnswer',
            input,
            sha256({
              sources,
              submission: submission.id,
              answerHash,
              qHash,
              rubricHash,
              policy: COURSE_POLICY,
            }),
            CourseShortGradeSchema,
            (opts) => ctx.provider.gradeShortAnswer(input, opts),
          );
          callIds.push(graded.callId);
        }
        if (anomalies()) {
          this.generation.reject(graded.callId, ['grading_still_uncertain'], ctx.operationId);
          submission = {
            ...submission,
            status: 'pending',
            operationId: ctx.operationId,
            version: submission.version + 1,
          };
          this.save(submission);
          throw new AppError(
            'GROUNDING_FAILED',
            '评分仍不确定，答案已保存；没有记为学生答错或签发成绩。',
          );
        }
        criteria = graded.value.criteria;
        const total = q.rubric.reduce((sum, c) => sum + c.weight, 0);
        score =
          q.rubric.reduce(
            (sum, c) =>
              sum + (criteria.some((r) => r.criterionId === c.id && r.met) ? c.weight : 0),
            0,
          ) / total;
        // The validated criterion decisions/reasons are also the learner's
        // feedback. A second free-form summary can contradict those same facts.
        feedback = q.rubric
          .map((c, index) => {
            const result = criteria.find((r) => r.criterionId === c.id)!;
            return `${index + 1}. ${result.met ? '达成' : '未达成'}：${result.reason}`;
          })
          .join('\n\n');
        confidence = graded.value.confidence;
      }
      ctx.check();
      const grade = CourseItemGradeSchema.parse({
        id: stableId('item_grade', {
          submission: submission.id,
          q: q.id,
          answerHash,
          policy: COURSE_POLICY,
        }),
        questionId: q.id,
        score,
        criteria,
        feedback,
        confidence,
        uncertain: false,
        callIds,
        assessedKnowledgeIds: q.knowledgeIds,
        answerHash,
        questionHash: qHash,
        rubricHash,
        policyVersion: COURSE_POLICY,
      });
      if (attempt)
        this.repo.run(
          'INSERT OR IGNORE INTO assessment_item_grades VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          grade.id,
          attempt.id,
          q.id,
          answerHash,
          qHash,
          rubricHash,
          COURSE_POLICY,
          'server',
          canonical(callIds),
          ctx.operationId,
          canonical(grade),
          this.repo.now(),
        );
      submission = {
        ...submission,
        itemGrades: [...submission.itemGrades, grade],
        version: submission.version + 1,
        operationId: ctx.operationId,
      };
      this.save(submission);
    }
    ctx.check();
    const result = this.aggregate(quiz, submission);
    submission = {
      ...submission,
      ...result,
      status: 'graded',
      version: submission.version + 1,
      operationId: ctx.operationId,
    };
    this.repo.transaction(() => {
      this.save(submission);
      if (attempt) this.recordServerGrade(ctx, attempt.id, submission, quiz);
    });
    this.project(submission);
    return { resourceId: submission.id };
  }
  aggregate(quiz: CourseQuiz, submission: CourseSubmission) {
    requireValid(
      submission.itemGrades.length !== quiz.items.length ||
        !unique(submission.itemGrades.map((g) => g.questionId)) ||
        quiz.items.some(
          (q) => !submission.itemGrades.some((g) => g.questionId === q.id && !g.uncertain),
        )
        ? ['评分item集合尚未完整']
        : [],
    );
    if (!quiz.blueprint) {
      const score = submission.itemGrades.reduce((sum, g) => sum + g.score, 0) / quiz.items.length;
      return { score, passed: score >= 0.6 };
    }
    const cells = quiz.blueprint.requiredCellIds.map((id) =>
      quiz.blueprint!.cells.find((c) => c.id === id)!,
    );
    const total = cells.reduce((sum, c) => sum + c.weight, 0);
    const score =
      cells.reduce((sum, c) => {
        const measures = quiz.items.flatMap((q) =>
          q.coverage
            .filter((v) => v.cellId === c.id)
            .map((v) => {
              const g = submission.itemGrades.find((g) => g.questionId === q.id)!;
              return q.type === 'short_answer'
                ? v.criterionIds.reduce(
                    (n, id) => n + (g.criteria.some((r) => r.criterionId === id && r.met) ? 1 : 0),
                    0,
                  ) / v.criterionIds.length
                : g.score;
            }),
        );
        return sum + c.weight * (measures.length ? Math.min(...measures) : 0);
      }, 0) / total;
    return { score, passed: score >= quiz.blueprint.passThreshold };
  }
  private recordServerGrade(
    ctx: CourseOperationContext,
    attemptId: string,
    submission: CourseSubmission,
    quiz: CourseQuiz,
  ) {
    const databaseItems = this.repo.payloads<CourseItemGrade>(
      'SELECT payload FROM assessment_item_grades WHERE attempt_id=?',
      attemptId,
    );
    requireValid(
      databaseItems.length !== quiz.items.length ||
        sha256([...databaseItems].sort((a, b) => a.id.localeCompare(b.id))) !==
          sha256([...submission.itemGrades].sort((a, b) => a.id.localeCompare(b.id)))
        ? ['正式评分数据库集合不完整']
        : [],
    );
    const frozen = this.repo.owned<CourseSubmission>('submissions', submission.id, ctx.workspaceId);
    requireValid(
      frozen.status !== 'graded' || sha256(frozen.responses) !== sha256(submission.responses)
        ? ['服务端冻结答案不一致']
        : [],
    );
    const result = this.aggregate(quiz, { ...submission, itemGrades: databaseItems });
    const gradeId = stableId('formal_grade', attemptId);
    const plan = this.questions.planning.get(ctx.workspaceId, quiz.curriculumId)!;
    const current =
      this.sources.scopeHash(ctx.workspaceId) ===
      this.questions.planning.inventory(plan).sourceScopeHash;
    const payload = {
      id: gradeId,
      workspaceId: ctx.workspaceId,
      attemptId,
      submissionId: submission.id,
      quizId: quiz.id,
      ...result,
      ...(quiz.assessmentScope ? { assessmentScope: quiz.assessmentScope } : {}),
      itemGradeIds: databaseItems.map((g) => g.id),
      blueprintHash: sha256(quiz.blueprint),
      issuerPolicy: COURSE_POLICY,
      operationId: ctx.operationId,
      currentSource: current,
      createdAt: this.repo.now(),
    };
    this.repo.run(
      'INSERT OR IGNORE INTO assessment_grade_records VALUES(?,?,?,?,?,?,?)',
      gradeId,
      ctx.workspaceId,
      attemptId,
      COURSE_POLICY,
      ctx.operationId,
      canonical(payload),
      payload.createdAt,
    );
    if (current)
      for (const k of [...new Set(databaseItems.flatMap((g) => g.assessedKnowledgeIds))]) {
        const supporting = databaseItems.filter((g) => g.assessedKnowledgeIds.includes(k));
        const supported = supporting.every((g) => {
          const q = quiz.items.find((q) => q.id === g.questionId)!;
          return q.type === 'short_answer'
            ? q.rubric
                .filter((c) => c.required && c.knowledgeIds.includes(k))
                .every((c) => g.criteria.some((r) => r.criterionId === c.id && r.met))
            : g.score === 1;
        });
        const evidence = {
          gradeId,
          knowledgeId: k,
          supported,
          questionIds: supporting.map((g) => g.questionId),
          policyVersion: COURSE_POLICY,
        };
        this.repo.run(
          'INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?)',
          stableId('evidence', { gradeId, k }),
          ctx.workspaceId,
          gradeId,
          k,
          canonical(evidence),
          this.repo.now(),
        );
      }
  }
  private project(submission: CourseSubmission) {
    try {
      this.outcomes.record(submission.id);
    } catch {
      /* Reliable score persists; startup/explicit reconcile resumes this local projection. */
    }
  }
  private save(s: CourseSubmission) {
    this.repo.run(
      "UPDATE submissions SET payload=?,status=? WHERE id=? AND status<>'graded'",
      canonical(s),
      s.status,
      s.id,
    );
  }
}
