import {
  COURSE_POLICY,
  GradedStudyOutcomeSchema,
  type CourseSubmission,
  type CourseQuiz,
  type ScheduledMemoryScheduleState,
  type SchedulerConfiguration,
  type GradedStudyOutcome,
} from '@hy3-clinic/shared';
import type { ClinicRepository } from '../repositories/clinic.js';
import type { CoursePlanningService } from './coursePlanning.js';
import { DEFAULT_CONFIGURATION, replayFsrs } from '../review/fsrsAdapter.js';
import { canonical, sha256, stableId } from '../util/canonical.js';
import { AppError } from '../errors.js';

function orderStudyEvents<
  T extends Pick<GradedStudyOutcome, 'occurredAt' | 'sourceRecordId' | 'predecessorSourceRecordId'>,
>(events: T[]): T[] {
  const sorted = [...events].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.sourceRecordId.localeCompare(b.sourceRecordId),
  );
  const ordered: T[] = [];
  const group: T[] = [];
  const flush = () => {
    while (group.length) {
      const index = group.findIndex(
        (event) =>
          !event.predecessorSourceRecordId ||
          !group.some((parent) => parent.sourceRecordId === event.predecessorSourceRecordId),
      );
      if (index < 0)
        throw new AppError('GROUNDING_FAILED', '复习前件存在循环，调度投影保持待恢复。');
      ordered.push(group.splice(index, 1)[0]!);
    }
  };
  for (const event of sorted) {
    if (group.length && group[0]!.occurredAt !== event.occurredAt) flush();
    group.push(event);
  }
  flush();
  return ordered;
}

export class GradedStudyOutcomes {
  constructor(
    readonly repo: ClinicRepository,
    readonly planning: CoursePlanningService,
    readonly configuration: SchedulerConfiguration = DEFAULT_CONFIGURATION,
  ) {
    this.configuration = {
      ...configuration,
      weights: configuration.weights ?? DEFAULT_CONFIGURATION.weights,
    };
    repo.run(
      'INSERT OR IGNORE INTO review_scheduler_configurations VALUES(?,?)',
      configuration.configHash,
      canonical(this.configuration),
    );
  }
  record(submissionId: string): void {
    const submission = this.repo.payload<CourseSubmission>(
      'SELECT payload FROM submissions WHERE id=?',
      submissionId,
    );
    if (!submission || submission.status !== 'graded')
      throw new AppError('VERSION_CONFLICT', '只有可靠服务端评分可以更新日常画像。');
    if (
      submission.itemGrades.some((g) => g.uncertain || g.confidence < 0.6) ||
      new Set(submission.itemGrades.map((g) => g.questionId)).size !== submission.itemGrades.length
    )
      throw new AppError('GROUNDING_FAILED', '不确定或重复评分不能更新日常画像。');
    const quiz = this.repo.owned<CourseQuiz>('quizzes', submission.quizId, submission.workspaceId);
    let predecessorSourceRecordId: string | null = null;
    if (quiz.purpose === 'retest') {
      const origin = this.repo.row<{
        origin_submission_id: string | null;
        origin_grade_id: string | null;
      }>(
        'SELECT origin_submission_id,origin_grade_id FROM repair_rounds WHERE retest_quiz_id=?',
        quiz.id,
      );
      const originId =
        origin?.origin_submission_id ??
        (origin?.origin_grade_id
          ? this.repo.owned<{ submissionId: string }>(
              'assessment_grade_records',
              origin.origin_grade_id,
              submission.workspaceId,
            ).submissionId
          : null);
      predecessorSourceRecordId = originId ?? null;
      if (originId && originId !== submissionId) this.record(originId);
    }
    const plan = this.planning.get(submission.workspaceId, quiz.curriculumId)!;
    const inventory = this.planning.inventory(plan);
    const actual = [...new Set(submission.itemGrades.flatMap((g) => g.assessedKnowledgeIds))];
    this.repo.transaction(() => {
      for (const knowledgeId of actual) {
        const knowledge = inventory.knowledge.find((k) => k.id === knowledgeId);
        if (!knowledge) throw new AppError('GROUNDING_FAILED', '评分知识不属于冻结课程。');
        const scope = sha256(knowledge.sourceSpans);
        const targetId = stableId('review', {
          workspace: submission.workspaceId,
          knowledgeId,
          scope,
        });
        const grades = submission.itemGrades.filter((g) =>
          g.assessedKnowledgeIds.includes(knowledgeId),
        );
        const assistance = submission.responses.some(
          (a) => grades.some((g) => g.questionId === a.questionId) && a.assistance === 'hint',
        );
        const correct = grades.every((g) => {
          const q = quiz.items.find((q) => q.id === g.questionId)!;
          if (q.type !== 'short_answer') return g.score === 1;
          return q.rubric
            .filter((c) => c.required && c.knowledgeIds.includes(knowledgeId))
            .every((c) => g.criteria.some((r) => r.criterionId === c.id && r.met));
        });
        const eventId = stableId('review_event', {
          targetId,
          source: submission.id,
          policy: COURSE_POLICY,
        });
        if (this.repo.row('SELECT id FROM successor_review_events WHERE id=?', eventId)) continue;
        this.repo.run(
          'INSERT OR IGNORE INTO review_targets VALUES(?,?,?,?,?,?)',
          targetId,
          submission.workspaceId,
          'course_knowledge',
          knowledgeId,
          scope,
          canonical({
            id: targetId,
            workspaceId: submission.workspaceId,
            knowledgeId,
            title: knowledge.title,
            sourceScopeHash: scope,
          }),
        );
        this.repo.run(
          'INSERT OR IGNORE INTO review_target_bindings VALUES(?,?,?,?,?)',
          targetId,
          knowledgeId,
          scope,
          1,
          canonical({ curriculumId: plan.id, knowledgeId }),
        );
        const seq =
          (this.repo.row<{ n: number }>(
            'SELECT MAX(seq) AS n FROM successor_review_events WHERE target_id=?',
            targetId,
          )?.n ?? 0) + 1;
        const outcome = GradedStudyOutcomeSchema.parse({
          id: eventId,
          knowledgeId,
          sourceKind: quiz.purpose,
          sourceRecordId: submission.id,
          questionIds: grades.map((g) => g.questionId),
          result: correct ? 'independent_success' : 'weak',
          assistance: assistance ? 'hint' : 'none',
          occurredAt: submission.submittedAt,
          policyVersion: COURSE_POLICY,
          predecessorSourceRecordId,
          stateSnapshot:
            this.repo.payload(
              'SELECT payload FROM memory_schedule_states WHERE target_id=?',
              targetId,
            ) ?? null,
        });
        this.repo.run(
          'INSERT INTO successor_review_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          eventId,
          targetId,
          seq,
          assistance ? 'diagnostic_observation' : 'graded_retrieval',
          quiz.purpose,
          submission.id,
          `${quiz.purpose}:${submission.id}`,
          assistance ? null : correct ? 'Good' : 'Again',
          submission.submittedAt,
          COURSE_POLICY,
          this.configuration.configHash,
          canonical(outcome),
        );
        if (!assistance) this.replay(targetId);
      }
    });
  }
  reconcile(): void {
    const ids = this.repo.rows<{ id: string }>(
      "SELECT id FROM submissions WHERE status='graded' ORDER BY submitted_at,id",
    );
    for (const { id } of ids) this.record(id);
  }
  list(workspaceId: string) {
    this.repo.workspace(workspaceId);
    return this.repo
      .rows<{ id: string; payload: string }>(
        'SELECT id,payload FROM review_targets WHERE workspace_id=?',
        workspaceId,
      )
      .map((row) => {
        const target = JSON.parse(row.payload) as {
          id: string;
          knowledgeId: string;
          title: string;
        };
        const events = orderStudyEvents(
          this.repo
            .rows<{ payload: string; rating: string | null }>(
              'SELECT payload,rating FROM successor_review_events WHERE target_id=? ORDER BY occurred_at,seq',
              row.id,
            )
            .map((e) => ({
              ...(JSON.parse(e.payload) as GradedStudyOutcome),
              rating: e.rating,
            })),
        );
        const schedule =
          this.repo.payload<ScheduledMemoryScheduleState>(
            'SELECT payload FROM memory_schedule_states WHERE target_id=?',
            row.id,
          ) ?? null;
        return {
          ...target,
          events,
          diagnostic: events.at(-1) ?? null,
          schedule,
          due: !!schedule && Date.parse(schedule.dueAt) <= Date.parse(this.repo.now()),
        };
      });
  }
  private replay(targetId: string) {
    const events = this.repo.rows<{
      rating: 'Again' | 'Good';
      occurred_at: string;
      configuration_id: string;
      source_record_id: string;
      payload: string;
    }>(
      'SELECT rating,occurred_at,configuration_id,source_record_id,payload FROM successor_review_events WHERE target_id=? AND kind=? ORDER BY occurred_at,source_record_id,seq',
      targetId,
      'graded_retrieval',
    );
    const ordered = orderStudyEvents(
      events.map((event) => ({
        ...event,
        occurredAt: event.occurred_at,
        sourceRecordId: event.source_record_id,
        predecessorSourceRecordId: (JSON.parse(event.payload) as GradedStudyOutcome)
          .predecessorSourceRecordId,
      })),
    );
    const state = replayFsrs(
      ordered.map((e) => ({
        outcome: e.rating,
        occurredAt: e.occurred_at,
        configuration: this.repo.payload<SchedulerConfiguration>(
          'SELECT payload FROM review_scheduler_configurations WHERE id=?',
          e.configuration_id,
        )!,
      })),
      targetId,
      this.configuration,
    );
    const previous = this.repo.row<{ row_version: number }>(
      'SELECT row_version FROM memory_schedule_states WHERE target_id=?',
      targetId,
    );
    const next = { ...state, rowVersion: (previous?.row_version ?? 0) + 1 };
    if (previous) {
      const changed = this.repo.run(
        'UPDATE memory_schedule_states SET row_version=?,payload=? WHERE target_id=? AND row_version=?',
        next.rowVersion,
        canonical(next),
        targetId,
        previous.row_version,
      );
      if (!changed.changes)
        throw new AppError('VERSION_CONFLICT', '复习投影有并发更新，请重试本地投影。');
    } else
      this.repo.run(
        'INSERT INTO memory_schedule_states VALUES(?,?,?)',
        targetId,
        next.rowVersion,
        canonical(next),
      );
  }
}
