import {
  CourseRepairRoundSchema,
  type CourseRepairRound,
  type CourseSubmission,
  type CourseCommand,
  type CourseAnswer,
} from '@hy3-clinic/shared';
import { RepairRoundOutputSchema, LessonVerificationSchema } from '../llm/courseContract.js';
import { validateLessonDelivery, selectLessonVerificationScopes } from './lessonDelivery.js';
import { CourseValidationError, requireValid } from './courseValidation.js';
import type { ClinicRepository } from '../repositories/clinic.js';
import { newClinicId } from '../repositories/clinic.js';
import type { CourseQuestions } from './courseQuestions.js';
import type { CourseGrading } from './courseGrading.js';
import type { CourseGeneration } from './courseGeneration.js';
import type { CourseSources } from './courseSources.js';
import type { CourseOperationRunner } from './courseOperationRunner.js';
import { type CourseOperationContext } from './courseOperationRunner.js';
import { canonical, sha256, stableId } from '../util/canonical.js';
import { AppError } from '../errors.js';

export class RepairRounds {
  constructor(
    readonly repo: ClinicRepository,
    readonly questions: CourseQuestions,
    readonly grading: CourseGrading,
    readonly generation: CourseGeneration,
    readonly sources: CourseSources,
    readonly operations: CourseOperationRunner,
  ) {}
  get(workspaceId: string, id: string) {
    return CourseRepairRoundSchema.parse(this.repo.owned('repair_rounds', id, workspaceId));
  }
  start(
    workspaceId: string,
    command: CourseCommand,
    input: {
      originKind: 'submission' | 'grade';
      originId: string;
      targetItemIds: string[];
      replacePendingRoundId?: string;
      expectedRoundVersion?: number;
    },
  ) {
    return this.repo.command(workspaceId, command, { action: 'repair', ...input }, () => {
      const origin = this.origin(workspaceId, input.originKind, input.originId);
      if (
        !input.targetItemIds.length ||
        input.targetItemIds.some(
          (id) => !origin.itemGrades.some((g) => g.questionId === id && g.score < 1),
        )
      )
        throw new AppError('VALIDATION_ERROR', '补救必须绑定一次可靠评分的薄弱题目。');
      const column = input.originKind === 'submission' ? 'origin_submission_id' : 'origin_grade_id';
      const active = this.repo.payload<CourseRepairRound>(
        `SELECT payload FROM repair_rounds WHERE ${column}=? AND status IN ('preparing','ready','submitted')`,
        input.originId,
      );
      if (active) {
        if (!input.replacePendingRoundId) return active;
        if (
          active.id !== input.replacePendingRoundId ||
          active.version !== input.expectedRoundVersion
        )
          throw new AppError('VERSION_CONFLICT', '当前补救轮已改变。');
        const cancelled = {
          ...active,
          status: 'cancelled' as const,
          version: active.version + 1,
          updatedAt: this.repo.now(),
        };
        this.save(cancelled);
        this.operations.fenceResource(active.operationId);
      } else if (input.replacePendingRoundId)
        throw new AppError('VERSION_CONFLICT', '没有可替换的活动补救轮。');
      const ordinal =
        (this.repo.row<{ n: number }>(
          `SELECT MAX(ordinal) AS n FROM repair_rounds WHERE ${column}=?`,
          input.originId,
        )?.n ?? 0) + 1;
      const id = newClinicId('repair');
      const op = this.operations.start(
        workspaceId,
        {
          commandId: `${command.commandId}:prepare`,
          idempotencyKey: `${command.idempotencyKey}:prepare`,
        },
        'prepareRepair',
        `repair:${input.originKind}:${input.originId}`,
        'repair',
        { roundId: id },
      );
      const round: CourseRepairRound = {
        id,
        workspaceId,
        originKind: input.originKind,
        originId: input.originId,
        targetItemIds: input.targetItemIds,
        ordinal,
        status: 'preparing',
        learnerOutcome: null,
        explanation: '',
        retestQuizId: null,
        retestSubmissionId: null,
        operationId: op.id,
        version: 1,
        createdAt: this.repo.now(),
        updatedAt: this.repo.now(),
      };
      this.repo.run(
        'INSERT INTO repair_rounds VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        workspaceId,
        input.originKind,
        input.originKind === 'submission' ? input.originId : null,
        input.originKind === 'grade' ? input.originId : null,
        canonical(input.targetItemIds),
        ordinal,
        round.status,
        null,
        null,
        null,
        op.id,
        1,
        canonical(round),
        round.createdAt,
        round.updatedAt,
      );
      return round;
    });
  }
  async prepare(ctx: CourseOperationContext, request: { roundId: string }) {
    let round = this.get(ctx.workspaceId, request.roundId);
    const column = round.originKind === 'submission' ? 'origin_submission_id' : 'origin_grade_id';
    const newer = this.repo.row<{ ordinal: number }>(
      `SELECT MAX(ordinal) AS ordinal FROM repair_rounds WHERE ${column}=?`,
      round.originId,
    );
    const other = this.repo.row<{ id: string }>(
      `SELECT id FROM repair_rounds WHERE ${column}=? AND status IN ('preparing','ready','submitted') AND id<>?`,
      round.originId,
      round.id,
    );
    if (
      newer?.ordinal !== round.ordinal ||
      other ||
      ['cancelled', 'completed'].includes(round.status)
    )
      throw new AppError('VERSION_CONFLICT', '此轮已结束或存在较新补救轮，不能恢复旧轮。');
    if (round.status === 'ready' && round.retestQuizId) return { resourceId: round.id };
    if (round.status === 'submitted')
      throw new AppError('VERSION_CONFLICT', '作答已冻结，请恢复评分。');
    round = {
      ...round,
      status: 'preparing',
      operationId: ctx.operationId,
      version: round.version + 1,
      updatedAt: this.repo.now(),
    };
    this.save(round);
    let authorCallId: string | undefined;
    let teachingAccepted = false;
    try {
      const origin = this.origin(ctx.workspaceId, round.originKind, round.originId);
      const oldQuiz = this.questions.get(ctx.workspaceId, origin.quizId);
      const originalQuestions = oldQuiz.items.filter((q) => round.targetItemIds.includes(q.id));
      const plan = this.questions.planning.get(ctx.workspaceId, oldQuiz.curriculumId)!;
      const inventory = this.questions.planning.inventory(plan);
      const knowledge = inventory.knowledge.filter((k) =>
        originalQuestions.some((q) => q.knowledgeIds.includes(k.id)),
      );
      const sources = this.sources.references(
        ctx.workspaceId,
        knowledge.flatMap((k) => k.sourceSpans),
      );
      const input = {
        knowledge,
        sources,
        originalQuestions,
        responses: origin.responses.filter((a) => round.targetItemIds.includes(a.questionId)),
        feedback: origin.itemGrades
          .filter((g) => round.targetItemIds.includes(g.questionId))
          .map((g) => g.feedback),
        slotId: stableId(
          'slot',
          stableId('quiz', { workspace: ctx.workspaceId, purpose: 'retest', requestId: round.id }),
        ),
      };
      const generated = await this.generation.stage(
        ctx,
        'generateRepairRound',
        input,
        sha256(sources),
        RepairRoundOutputSchema,
        (opts) => ctx.provider.generateRepairRound(input, opts),
      );
      authorCallId = generated.callId;
      for (const ref of generated.value.sourceRefs)
        this.sources.validateSpan(ctx.workspaceId, ref, new Set(sources.map((s) => s.revisionId)));
      const teaching = generated.value.teaching;
      const lesson = {
        ...plan.lessons[0]!,
        id: `repair_lesson_${round.id}`,
        knowledgeIds: knowledge.map((k) => k.id),
        objectives: knowledge.map((k, i) => ({
          id: `repair_objective_${i}`,
          title: k.title,
          knowledgeIds: [k.id],
          demand: 'understand' as const,
        })),
        prerequisiteLessonIds: [],
      };
      for (const segment of teaching.segments) {
        requireValid(
          segment.origin === 'extension' && segment.sourceRefs.length
            ? ['补救拓展伪引用']
            : segment.origin === 'textbook' && !segment.sourceRefs.length
              ? ['补救教材讲解缺来源']
              : [],
        );
        for (const ref of segment.sourceRefs)
          this.sources.validateSpan(
            ctx.workspaceId,
            ref,
            new Set(sources.map((s) => s.revisionId)),
          );
      }
      const delivery = validateLessonDelivery(lesson, knowledge, teaching);
      const scopes = selectLessonVerificationScopes(knowledge, teaching, sources, delivery);
      if (scopes.length) {
        const verification = {
          scopes,
          segments: teaching.segments.filter((s) =>
            scopes.some((scope) => scope.segmentIds.includes(s.id)),
          ),
          knowledge,
          sources,
        };
        const checked = await this.generation.stage(
          ctx,
          'verifyLessonParts',
          verification,
          sha256(sources),
          LessonVerificationSchema,
          (opts) => ctx.provider.verifyLessonParts(verification, opts),
        );
        requireValid(
          scopes.some(
            (scope) =>
              !checked.value.results.some(
                (r) =>
                  r.scopeId === scope.id &&
                  r.scopeHash === scope.hash &&
                  r.accepted &&
                  scope.knowledgeIds.every((id) => r.checkedKnowledgeIds.includes(id)),
              ),
          )
            ? ['补救讲解必要scope未通过']
            : [],
        );
      }
      teachingAccepted = true;
      const explanation = teaching.segments.map((s) => s.text).join('\n\n');
      // Retest has one question per round, regardless of prior repair count.
      const prepared = await this.questions.retest(
        ctx,
        plan,
        round.id,
        knowledge,
        explanation,
        generated.value.questions.slice(0, 1),
      );
      ctx.check();
      round = {
        ...round,
        status: 'ready',
        explanation,
        retestQuizId: prepared.resourceId,
        version: round.version + 1,
        updatedAt: this.repo.now(),
      };
      this.save(round);
      return { resourceId: round.id };
    } catch (error) {
      if (authorCallId && !teachingAccepted && error instanceof CourseValidationError)
        this.generation.reject(authorCallId, error.findings);
      const latest = this.get(ctx.workspaceId, round.id);
      if (latest.status === 'preparing')
        this.save({
          ...latest,
          status: 'failed',
          version: latest.version + 1,
          updatedAt: this.repo.now(),
        });
      throw error;
    }
  }
  submit(
    workspaceId: string,
    id: string,
    command: CourseCommand,
    answers: CourseAnswer[],
    version: number,
  ) {
    const round = this.get(workspaceId, id);
    if (
      round.version !== version ||
      !['ready', 'submitted'].includes(round.status) ||
      !round.retestQuizId
    )
      throw new AppError('VERSION_CONFLICT', '本轮不能提交或版本已改变。');
    const quiz = this.questions.get(workspaceId, round.retestQuizId);
    const result = this.grading.submit(workspaceId, quiz.id, command, answers, quiz.version);
    if (round.status === 'ready')
      this.save({
        ...round,
        status: 'submitted',
        retestSubmissionId: result.submission.id,
        operationId: result.operation?.id ?? round.operationId,
        version: round.version + 1,
        updatedAt: this.repo.now(),
      });
    return result;
  }
  finishForSubmission(submissionId: string) {
    const round = this.repo.payload<CourseRepairRound>(
      "SELECT payload FROM repair_rounds WHERE retest_submission_id=? AND status='submitted'",
      submissionId,
    );
    const submission = this.repo.payload<CourseSubmission>(
      'SELECT payload FROM submissions WHERE id=?',
      submissionId,
    );
    if (round && submission?.status === 'graded')
      this.save({
        ...round,
        status: 'completed',
        learnerOutcome: submission.passed ? 'passed' : 'not_yet',
        version: round.version + 1,
        updatedAt: this.repo.now(),
      });
  }
  reconcile() {
    for (const s of this.repo.rows<{ retest_submission_id: string }>(
      "SELECT retest_submission_id FROM repair_rounds WHERE status='submitted'",
    ))
      this.finishForSubmission(s.retest_submission_id);
  }
  private origin(workspaceId: string, kind: 'submission' | 'grade', id: string): CourseSubmission {
    const submissionId =
      kind === 'grade'
        ? this.repo.owned<{ submissionId: string }>('assessment_grade_records', id, workspaceId)
            .submissionId
        : id;
    const submission = this.repo.owned<CourseSubmission>('submissions', submissionId, workspaceId);
    if (submission.status !== 'graded')
      throw new AppError('VERSION_CONFLICT', '评分尚未可靠完成，不能记为学习失败或补救。');
    return submission;
  }
  private save(round: CourseRepairRound) {
    this.repo.run(
      'UPDATE repair_rounds SET status=?,learner_outcome=?,retest_quiz_id=?,retest_submission_id=?,operation_id=?,version=?,payload=?,updated_at=? WHERE id=?',
      round.status,
      round.learnerOutcome,
      round.retestQuizId,
      round.retestSubmissionId,
      round.operationId,
      round.version,
      canonical(round),
      round.updatedAt,
      round.id,
    );
  }
}
