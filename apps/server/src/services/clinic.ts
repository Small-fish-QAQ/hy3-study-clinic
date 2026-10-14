import type { CourseProvider } from '../llm/courseContract.js';
import type { ClinicRepository } from '../repositories/clinic.js';
import { CourseSources } from './courseSources.js';
import { CourseOperationRunner } from './courseOperationRunner.js';
import { CourseGeneration } from './courseGeneration.js';
import { CourseKnowledgeService } from './courseKnowledge.js';
import { CoursePlanningService } from './coursePlanning.js';
import { CourseLessons } from './courseLessons.js';
import { QuestionAdmission } from './questionAdmission.js';
import { CourseQuestions } from './courseQuestions.js';
import { CourseGrading } from './courseGrading.js';
import { GradedStudyOutcomes } from './gradedStudyOutcomes.js';
import { RepairRounds } from './repairRounds.js';
import { LessonReflections } from './lessonReflections.js';
import {
  lessonReflectionPrompt,
  type CoursePlan,
  type CourseSubmission,
  type CourseLessonContent,
} from '@hy3-clinic/shared';

export function createClinic(
  repo: ClinicRepository,
  provider: () => CourseProvider,
  options: { leaseMs?: number; heartbeatMs?: number; concurrency?: number } = {},
) {
  const sources = new CourseSources(repo);
  const operations = new CourseOperationRunner(
    repo,
    provider,
    options.leaseMs,
    options.heartbeatMs,
  );
  const generation = new CourseGeneration(repo, options.concurrency);
  const knowledge = new CourseKnowledgeService(repo, sources, generation);
  const planning = new CoursePlanningService(repo, sources, knowledge, generation);
  const lessons = new CourseLessons(repo, planning, sources, generation, operations);
  const reflections = new LessonReflections(repo);
  const admission = new QuestionAdmission(sources, generation);
  const questions = new CourseQuestions(repo, planning, sources, generation, admission);
  const outcomes = new GradedStudyOutcomes(repo, planning);
  const grading = new CourseGrading(
    repo,
    questions,
    sources,
    generation,
    admission,
    outcomes,
    operations,
  );
  const repairs = new RepairRounds(repo, questions, grading, generation, sources, operations);
  operations.register('preparePlan', (ctx, r) =>
    planning.prepare(ctx, r as unknown as Parameters<typeof planning.prepare>[1]),
  );
  operations.register('prepareLesson', (ctx, r) =>
    lessons.prepare(ctx, r as unknown as Parameters<typeof lessons.prepare>[1]),
  );
  operations.register('preparePractice', (ctx, r) =>
    questions.practice(ctx, r as unknown as Parameters<typeof questions.practice>[1]),
  );
  operations.register('prepareFormal', (ctx, r) =>
    questions.formal(ctx, r as unknown as Parameters<typeof questions.formal>[1]),
  );
  operations.register('prepareRepair', (ctx, r) =>
    repairs.prepare(ctx, r as unknown as Parameters<typeof repairs.prepare>[1]),
  );
  operations.register('gradeAssessment', async (ctx, r) => {
    const result = await grading.grade(ctx, r as unknown as Parameters<typeof grading.grade>[1]);
    repairs.finishForSubmission(result.resourceId);
    return result;
  });
  // Projection failure must never prevent reading already reliable grades or classroom history.
  try {
    outcomes.reconcile();
  } catch {
    /* pending IDs are exposed by progress; explicit reconcile retries locally. */
  }
  repairs.reconcile();
  const progress = (workspaceId: string) => {
    const plan = planning.get(workspaceId);
    const accepted =
      plan?.status === 'accepted'
        ? plan
        : repo.payload<CoursePlan>(
            "SELECT payload FROM curriculum_versions WHERE workspace_id=? AND status='accepted' ORDER BY created_at DESC LIMIT 1",
            workspaceId,
          );
    const completion = accepted
      ? repo.rows<{ lesson_id: string }>(
          'SELECT lesson_id FROM lesson_execution_events WHERE curriculum_id=?',
          accepted.id,
        )
      : [];
    const inventory = accepted ? planning.inventory(accepted) : null;
    const delivered = accepted
      ? accepted.lessons
          .map((l) => lessons.content(accepted, l.id))
          .filter((v): v is CourseLessonContent => !!v)
      : [];
    const reflectionsSaved = reflections.list(workspaceId);
    const classroomTasks = delivered.flatMap((v) =>
      v.segments.flatMap((segment) => {
        const task = lessonReflectionPrompt(segment);
        if (!task) return [];
        const saved = reflectionsSaved.find(
          (s) => s.lessonVersionId === v.id && s.segmentId === segment.id,
        );
        return [
          {
            lessonId: v.lessonId,
            lessonVersionId: v.id,
            lessonTitle: v.title,
            segmentId: segment.id,
            prompt: task.prompt,
            status: saved?.status ?? 'open',
            response: saved?.response ?? '',
            version: saved?.version ?? 0,
          },
        ];
      }),
    );
    const evidence = repo.payloads<{ knowledgeId: string; supported: boolean; gradeId: string }>(
      'SELECT payload FROM evidence WHERE workspace_id=?',
      workspaceId,
    );
    const graded = repo.payloads<CourseSubmission>(
      "SELECT payload FROM submissions WHERE workspace_id=? AND status='graded'",
      workspaceId,
    );
    const pendingStudyOutcomes = graded
      .filter((s) =>
        [...new Set(s.itemGrades.flatMap((g) => g.assessedKnowledgeIds))].some(
          (knowledgeId) =>
            !repo.row(
              'SELECT e.id FROM successor_review_events e JOIN review_targets t ON t.id=e.target_id WHERE e.source_record_id=? AND t.knowledge_id=?',
              s.id,
              knowledgeId,
            ),
        ),
      )
      .map((s) => s.id);
    return {
      pendingStudyOutcomes,
      classroomTasks,
      sourceWarnings: sources
        .materials(workspaceId)
        .flatMap((m) => m.warnings.map((message) => ({ title: m.title, message }))),
      lessonCount: accepted?.lessons.length ?? 0,
      completedLessons: completion.length,
      completedLessonIds: completion.map((entry) => entry.lesson_id),
      learningRouteCompleted: !!accepted && completion.length === accepted.lessons.length,
      knowledge:
        inventory?.knowledge.map((k) => ({
          ...k,
          planned: true,
          delivered: delivered.some((v) =>
            accepted!.lessons.some((l) => l.id === v.lessonId && l.knowledgeIds.includes(k.id)),
          ),
          learned: accepted!.lessons.some(
            (l) => l.knowledgeIds.includes(k.id) && completion.some((c) => c.lesson_id === l.id),
          ),
          formalEvidence: evidence.filter((e) => e.knowledgeId === k.id),
          formalStatus: evidence.some((e) => e.knowledgeId === k.id && e.supported)
            ? 'supported'
            : evidence.some((e) => e.knowledgeId === k.id)
              ? 'partial'
              : 'untested',
        })) ?? [],
      daily: outcomes.list(workspaceId),
    };
  };
  const records = (workspaceId: string) => {
    repo.workspace(workspaceId);
    const currentScope = sources.scopeHash(workspaceId);
    return {
      curricula: repo.payloads(
        'SELECT payload FROM curriculum_versions WHERE workspace_id=? ORDER BY created_at DESC',
        workspaceId,
      ),
      sessions: repo.payloads(
        'SELECT payload FROM study_sessions WHERE workspace_id=? ORDER BY created_at DESC',
        workspaceId,
      ),
      submissions: repo.payloads(
        'SELECT payload FROM submissions WHERE workspace_id=? ORDER BY submitted_at DESC',
        workspaceId,
      ),
      formalGrades: repo
        .rows<{ payload: string; source_scope_hash: string }>(
          'SELECT g.payload,k.source_scope_hash FROM assessment_grade_records g JOIN assessment_attempts a ON a.id=g.attempt_id JOIN quizzes q ON q.id=a.assessment_version_id JOIN curriculum_versions p ON p.id=q.curriculum_id JOIN course_knowledge_inventories k ON k.id=p.knowledge_inventory_id WHERE g.workspace_id=? ORDER BY g.created_at DESC',
          workspaceId,
        )
        .map((row) => {
          const saved = JSON.parse(row.payload) as {
            id: string;
            quizId: string;
            submissionId: string;
            score: number;
            passed: boolean;
            createdAt: string;
            currentSource: boolean;
          };
          return {
            ...saved,
            currentSource: saved.currentSource && row.source_scope_hash === currentScope,
          };
        }),
      repairs: repo.payloads(
        'SELECT payload FROM repair_rounds WHERE workspace_id=? ORDER BY created_at DESC',
        workspaceId,
      ),
    };
  };
  const knowledgeMap = (workspaceId: string) => {
    const plan = planning.get(workspaceId);
    if (!plan) return { nodes: [], edges: [] };
    const inventory = planning.inventory(plan);
    return {
      nodes: inventory.knowledge.map((k) => ({
        id: k.id,
        title: k.title,
        statement: k.statement,
        lessonIds: plan.lessons.filter((l) => l.knowledgeIds.includes(k.id)).map((l) => l.id),
      })),
      edges: inventory.knowledge.flatMap((k) => [
        ...k.prerequisiteKnowledgeIds.map((id) => ({ from: id, to: k.id, kind: 'prerequisite' })),
        ...k.relatedKnowledgeIds.map((id) => ({ from: k.id, to: id, kind: 'related' })),
      ]),
      lessons: plan.lessons.map((l) => ({
        id: l.id,
        title: l.title,
        prerequisiteLessonIds: l.prerequisiteLessonIds,
      })),
    };
  };
  return {
    repo,
    sources,
    operations,
    generation,
    knowledge,
    planning,
    lessons,
    reflections,
    admission,
    questions,
    outcomes,
    grading,
    repairs,
    progress,
    records,
    knowledgeMap,
  };
}
export type Clinic = ReturnType<typeof createClinic>;
