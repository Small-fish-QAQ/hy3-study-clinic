import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CourseCommandSchema,
  CourseAnswerSchema,
  LessonDepthSchema,
  CoursePreferencesSchema,
  CourseTutorAnchorSchema,
  LessonReflectionSchema,
  SAMPLE_MATERIAL_CONTENT,
  SAMPLE_MATERIAL_TITLE,
  ProviderConfigUpdateSchema,
  type CourseSubmission,
} from '@hy3-clinic/shared';
import type { Clinic } from '../services/clinic.js';
import type { ProviderRuntime } from '../services/providerRuntime.js';
import { deleteWorkspaces } from '../services/workspaceManagement.js';
import type { CourseProvider } from '../llm/courseContract.js';
import { AppError } from '../errors.js';
import { stableId } from '../util/canonical.js';
const id = z.string().min(1).max(256);
const command = CourseCommandSchema;
const expectedVersion = z.number().int().positive();
export function registerClinicRoutes(
  app: FastifyInstance,
  clinic: Clinic,
  provider: () => CourseProvider,
  runtime?: ProviderRuntime,
) {
  const workspace = (params: unknown) =>
    z.object({ workspaceId: id }).passthrough().parse(params).workspaceId;
  const operationReply = (reply: { code: (status: number) => unknown }, op: unknown) => {
    reply.code((op as { status: string }).status === 'completed' ? 200 : 202);
    return op;
  };
  app.get('/api/health', () => ({ ok: true, formatVersion: 2, provider: provider().name }));
  app.get(
    '/api/config',
    () =>
      runtime?.safeConfig() ?? {
        provider: provider().name,
        model: provider().model ?? null,
        apiKeyConfigured: false,
        complete: provider().name === 'fake',
        runtimeGeneration: 1,
      },
  );
  if (runtime) {
    app.put('/api/config', (request) =>
      runtime.update(ProviderConfigUpdateSchema.parse(request.body)),
    );
    app.post('/api/config/test', async (request) => {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      return runtime.testConnection();
    });
    app.post('/api/config/models', (request) =>
      runtime.listModels(ProviderConfigUpdateSchema.parse(request.body)),
    );
    app.post('/api/config/draft-test', async (request) => {
      await runtime.draftProvider(ProviderConfigUpdateSchema.parse(request.body)).testConnection();
      return { status: 'verified', message: '连接正常。' };
    });
  }
  app.get('/api/sample-material', () => ({
    title: SAMPLE_MATERIAL_TITLE,
    content: SAMPLE_MATERIAL_CONTENT,
    filename: 'sample.md',
  }));
  app.get('/api/workspaces', () => ({ workspaces: clinic.sources.workspaces() }));
  app.post('/api/workspaces', (request, reply) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(120) })
      .strict()
      .parse(request.body);
    reply.code(201);
    return clinic.sources.createWorkspace(body.title);
  });
  app.get('/api/workspaces/:workspaceId/materials', (request) => ({
    materials: clinic.sources.summaries(workspace(request.params)),
  }));
  app.patch('/api/workspaces/:workspaceId/materials/:materialId', (request) => {
    const p = z.object({ workspaceId: id, materialId: id }).parse(request.params);
    const body = z
      .object({ command, title: z.string().trim().min(1) })
      .strict()
      .parse(request.body);
    return clinic.repo.command(
      p.workspaceId,
      body.command,
      { action: 'renameMaterial', materialId: p.materialId, title: body.title },
      () => clinic.sources.rename(p.workspaceId, p.materialId, body.title),
    );
  });
  app.delete('/api/workspaces/:workspaceId/materials/:materialId', (request) => {
    const p = z.object({ workspaceId: id, materialId: id }).parse(request.params);
    const b = z.object({ command }).strict().parse(request.body);
    return clinic.repo.command(
      p.workspaceId,
      b.command,
      { action: 'archiveMaterial', materialId: p.materialId },
      () => {
        clinic.repo.owned('materials', p.materialId, p.workspaceId);
        clinic.repo.run(
          'UPDATE materials SET archived=1 WHERE id=? AND workspace_id=?',
          p.materialId,
          p.workspaceId,
        );
        return { removed: true, historyPreserved: true };
      },
    );
  });
  app.post('/api/workspaces/delete', (request) => {
    const body = z
      .object({
        command,
        confirmed: z.literal(true),
        workspaceIds: z
          .array(id)
          .min(1)
          .max(1000)
          .refine((ids) => new Set(ids).size === ids.length),
      })
      .strict()
      .parse(request.body);
    return deleteWorkspaces(clinic.repo, clinic.operations, body.workspaceIds);
  });
  app.delete('/api/workspaces/:workspaceId', (request) => {
    const workspaceId = workspace(request.params);
    z.object({ command }).strict().parse(request.body);
    return deleteWorkspaces(clinic.repo, clinic.operations, [workspaceId]);
  });
  const importBody = z
    .object({
      title: z.string().trim().min(1).optional(),
      content: z.string().optional(),
      filename: z.string().optional(),
      dataBase64: z.string().optional(),
      mediaType: z.string().optional(),
    })
    .strict()
    .refine(
      (b) => (b.content !== undefined) !== (b.dataBase64 !== undefined),
      '提供一种正文或文件输入',
    );
  app.post('/api/workspaces/:workspaceId/materials', async (request, reply) => {
    const result = await clinic.sources.import(
      workspace(request.params),
      importBody.parse(request.body),
    );
    reply.code(201);
    return result;
  });
  app.post('/api/workspaces/:workspaceId/materials/:materialId/revisions', (request) => {
    const p = z.object({ workspaceId: id, materialId: id }).parse(request.params);
    return clinic.sources.import(p.workspaceId, importBody.parse(request.body), p.materialId);
  });
  app.get('/api/workspaces/:workspaceId/course-plan', (request) => {
    const workspaceId = workspace(request.params);
    const plan = clinic.planning.get(workspaceId);
    return { plan, inventory: plan ? clinic.planning.inventory(plan) : null };
  });
  app.post('/api/workspaces/:workspaceId/course-plan/prepare', (request, reply) => {
    const workspaceId = workspace(request.params);
    const body = z
      .object({
        command,
        sourceScopeHash: id.optional(),
        preferences: CoursePreferencesSchema.optional(),
      })
      .strict()
      .parse(request.body);
    const scope = body.sourceScopeHash ?? clinic.sources.scopeHash(workspaceId);
    return operationReply(
      reply,
      clinic.operations.start(workspaceId, body.command, 'preparePlan', 'plan', 'curriculum', {
        sourceScopeHash: scope,
        ...(body.preferences ? { preferences: body.preferences } : {}),
      }),
    );
  });
  app.patch('/api/workspaces/:workspaceId/course-plan/:planId/lesson-depths', (request) => {
    const p = z.object({ workspaceId: id, planId: id }).parse(request.params);
    const body = z
      .object({
        command,
        expectedVersion,
        changes: z.array(z.object({ lessonId: id, depth: LessonDepthSchema }).strict()).min(1),
      })
      .strict()
      .parse(request.body);
    return clinic.repo.command(
      p.workspaceId,
      body.command,
      { ...body, action: 'depth', planId: p.planId },
      () => clinic.planning.patchDepth(p.workspaceId, p.planId, body.expectedVersion, body.changes),
    );
  });
  app.post('/api/workspaces/:workspaceId/course-plan/:planId/confirm', (request) => {
    const p = z.object({ workspaceId: id, planId: id }).parse(request.params);
    const body = z.object({ command, expectedVersion }).strict().parse(request.body);
    return clinic.repo.command(
      p.workspaceId,
      body.command,
      { action: 'confirm', planId: p.planId, expectedVersion: body.expectedVersion },
      () => clinic.planning.confirm(p.workspaceId, p.planId, body.expectedVersion),
    );
  });
  app.get('/api/workspaces/:workspaceId/lessons', (request) => ({
    lessons: clinic.lessons.list(workspace(request.params)),
  }));
  app.post('/api/workspaces/:workspaceId/lessons/:lessonId/open', (request, reply) => {
    const p = z.object({ workspaceId: id, lessonId: id }).parse(request.params);
    const body = z.object({ command, curriculumId: id }).strict().parse(request.body);
    const plan = clinic.planning.get(p.workspaceId, body.curriculumId)!;
    const content = clinic.lessons.content(plan, p.lessonId);
    if (content)
      return {
        session: clinic.lessons.visit(p.workspaceId, body.command, content.id, plan.id),
        content,
      };
    return operationReply(
      reply,
      clinic.operations.start(
        p.workspaceId,
        body.command,
        'prepareLesson',
        `lesson:${p.lessonId}`,
        'lesson',
        { curriculumId: plan.id, lessonId: p.lessonId },
      ),
    );
  });
  app.post('/api/workspaces/:workspaceId/lessons/:lessonId/complete', (request) => {
    const p = z.object({ workspaceId: id, lessonId: id }).parse(request.params);
    const b = z.object({ command, visitId: id, lessonVersionId: id }).strict().parse(request.body);
    return clinic.lessons.complete(
      p.workspaceId,
      b.command,
      p.lessonId,
      b.visitId,
      b.lessonVersionId,
    );
  });
  app.post('/api/workspaces/:workspaceId/lessons/:lessonId/revisits', (request) => {
    const p = z.object({ workspaceId: id, lessonId: id }).parse(request.params);
    const b = z
      .object({ command, curriculumId: id, lessonVersionId: id, originSessionId: id.optional() })
      .strict()
      .parse(request.body);
    const content = clinic.repo.owned<{ lessonId: string }>(
      'course_lesson_versions',
      b.lessonVersionId,
      p.workspaceId,
    );
    if (content.lessonId !== p.lessonId) throw new AppError('VERSION_CONFLICT', '回看课文不匹配。');
    return clinic.lessons.visit(
      p.workspaceId,
      b.command,
      b.lessonVersionId,
      b.curriculumId,
      'revisit',
      b.originSessionId ?? null,
    );
  });
  app.get('/api/workspaces/:workspaceId/study-sessions/:sessionId', (request) => {
    const p = z.object({ workspaceId: id, sessionId: id }).parse(request.params);
    return clinic.lessons.classroom(p.workspaceId, p.sessionId);
  });
  app.post('/api/workspaces/:workspaceId/study-sessions/:sessionId/turns', (request) => {
    const p = z.object({ workspaceId: id, sessionId: id }).parse(request.params);
    const b = z
      .object({
        question: z.string().trim().min(1).max(20_000),
        anchor: CourseTutorAnchorSchema.optional(),
      })
      .strict()
      .parse(request.body);
    return clinic.lessons.tutor(p.workspaceId, p.sessionId, b.question, provider(), b.anchor);
  });
  app.put(
    '/api/workspaces/:workspaceId/lesson-versions/:lessonVersionId/reflections/:segmentId',
    (request) => {
      const p = z
        .object({ workspaceId: id, lessonVersionId: id, segmentId: id })
        .parse(request.params);
      const b = z
        .object({
          command,
          expectedVersion: z.number().int().nonnegative(),
          status: LessonReflectionSchema.shape.status,
          response: LessonReflectionSchema.shape.response,
        })
        .strict()
        .parse(request.body);
      return clinic.reflections.save(p.workspaceId, b.command, {
        lessonVersionId: p.lessonVersionId,
        segmentId: p.segmentId,
        status: b.status,
        response: b.response,
        expectedVersion: b.expectedVersion,
      });
    },
  );
  app.post('/api/workspaces/:workspaceId/lessons/:lessonId/practice', (request, reply) => {
    const p = z.object({ workspaceId: id, lessonId: id }).parse(request.params);
    const b = z
      .object({ command, curriculumId: id, lessonVersionId: id, practiceRequestId: id })
      .strict()
      .parse(request.body);
    const content = clinic.repo.owned<{ lessonId: string }>(
      'course_lesson_versions',
      b.lessonVersionId,
      p.workspaceId,
    );
    if (content.lessonId !== p.lessonId) throw new AppError('VERSION_CONFLICT', '练习课文不匹配。');
    return operationReply(
      reply,
      clinic.operations.start(
        p.workspaceId,
        b.command,
        'preparePractice',
        `practice:${b.practiceRequestId}`,
        'quiz',
        {
          curriculumId: b.curriculumId,
          lessonVersionId: b.lessonVersionId,
          requestId: b.practiceRequestId,
        },
      ),
    );
  });
  app.get('/api/quizzes/:quizId', (request) => {
    const { quizId } = z.object({ quizId: id }).parse(request.params);
    const quiz = clinic.repo.owned<{ workspaceId: string }>('quizzes', quizId);
    return clinic.questions.public(clinic.questions.get(quiz.workspaceId, quizId));
  });
  app.get('/api/workspaces/:workspaceId/quizzes/:quizId/draft', (request) => {
    const p = z.object({ workspaceId: id, quizId: id }).parse(request.params);
    clinic.questions.get(p.workspaceId, p.quizId);
    return {
      answers:
        clinic.repo.payload(
          'SELECT payload FROM quiz_answer_drafts WHERE quiz_id=? AND workspace_id=?',
          p.quizId,
          p.workspaceId,
        ) ?? [],
    };
  });
  app.put('/api/workspaces/:workspaceId/quizzes/:quizId/draft', (request) => {
    const p = z.object({ workspaceId: id, quizId: id }).parse(request.params);
    const b = z
      .object({ answers: z.array(CourseAnswerSchema), expectedVersion })
      .strict()
      .parse(request.body);
    const quiz = clinic.questions.get(p.workspaceId, p.quizId);
    if (
      quiz.status !== 'ready' ||
      quiz.version !== b.expectedVersion ||
      clinic.repo.row('SELECT id FROM submissions WHERE quiz_id=?', quiz.id)
    )
      throw new AppError('VERSION_CONFLICT', '试卷尚未就绪或答案已冻结。');
    if (b.answers.some((a) => !quiz.items.some((q) => q.id === a.questionId)))
      throw new AppError('VALIDATION_ERROR', '草稿题目不属于试卷。');
    clinic.repo.run(
      'INSERT INTO quiz_answer_drafts VALUES(?,?,?,?) ON CONFLICT(quiz_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',
      quiz.id,
      p.workspaceId,
      JSON.stringify(b.answers),
      clinic.repo.now(),
    );
    return { saved: true };
  });
  app.post('/api/workspaces/:workspaceId/quizzes/:quizId/hints', (request) => {
    const p = z.object({ workspaceId: id, quizId: id }).parse(request.params);
    const b = z.object({ questionId: id }).strict().parse(request.body);
    const quiz = clinic.questions.get(p.workspaceId, p.quizId);
    const question = quiz.items.find((q) => q.id === b.questionId);
    if (
      quiz.purpose === 'formal' ||
      quiz.status !== 'ready' ||
      !question ||
      clinic.repo.row('SELECT id FROM submissions WHERE quiz_id=?', quiz.id)
    )
      throw new AppError('VERSION_CONFLICT', '当前题目不能查看提示。');
    clinic.repo.run(
      'INSERT OR IGNORE INTO quiz_exposures VALUES(?,?,?,?)',
      quiz.id,
      question.id,
      'hint',
      clinic.repo.now(),
    );
    return { hint: question.admission.verifiedExplanation };
  });
  app.get('/api/workspaces/:workspaceId/submissions/:submissionId/detail', (request) => {
    const p = z.object({ workspaceId: id, submissionId: id }).parse(request.params);
    const submission = clinic.repo.owned<CourseSubmission>(
      'submissions',
      p.submissionId,
      p.workspaceId,
    );
    const quiz = clinic.questions.get(p.workspaceId, submission.quizId);
    return {
      submission,
      quiz: clinic.questions.public(quiz),
      solutions:
        submission.status === 'graded'
          ? quiz.items.map((q) => ({
              questionId: q.id,
              answer: q.answer,
              explanation: q.admission.verifiedExplanation,
              rubric: q.rubric,
              sourceRefs: q.sourceRefs,
            }))
          : [],
    };
  });
  app.post('/api/quizzes/:quizId/submissions', (request, reply) => {
    const { quizId } = z.object({ quizId: id }).parse(request.params);
    const b = z
      .object({
        command,
        workspaceId: id,
        answers: z.array(CourseAnswerSchema).min(1),
        expectedQuizVersion: expectedVersion,
      })
      .strict()
      .parse(request.body);
    const quiz = clinic.questions.get(b.workspaceId, quizId);
    if (quiz.purpose === 'formal' || quiz.purpose === 'retest')
      throw new AppError('VALIDATION_ERROR', '请通过正式考试或补救轮入口提交。');
    const result = clinic.grading.submit(
      b.workspaceId,
      quizId,
      b.command,
      b.answers,
      b.expectedQuizVersion,
    );
    if (result.operation) reply.code(202);
    return result;
  });
  app.get('/api/workspaces/:workspaceId/submissions/:submissionId', (request) => {
    const p = z.object({ workspaceId: id, submissionId: id }).parse(request.params);
    return clinic.repo.owned('submissions', p.submissionId, p.workspaceId);
  });
  app.post('/api/workspaces/:workspaceId/formal-exams', (request, reply) => {
    const workspaceId = workspace(request.params);
    const b = z
      .object({
        command,
        curriculumId: id,
        blueprintId: id,
        paperRequestId: id,
        moduleId: id.optional(),
      })
      .strict()
      .parse(request.body);
    return operationReply(
      reply,
      clinic.operations.start(
        workspaceId,
        b.command,
        'prepareFormal',
        `formal:${b.paperRequestId}`,
        'formal',
        {
          curriculumId: b.curriculumId,
          blueprintId: b.blueprintId,
          paperRequestId: b.paperRequestId,
          ...(b.moduleId ? { moduleId: b.moduleId } : {}),
        },
      ),
    );
  });
  app.get('/api/formal-assessment-versions/:versionId', (request) => {
    const { versionId } = z.object({ versionId: id }).parse(request.params);
    const q = clinic.repo.owned<{ workspaceId: string }>('quizzes', versionId);
    return clinic.questions.public(clinic.questions.get(q.workspaceId, versionId));
  });
  app.post(
    '/api/workspaces/:workspaceId/operations/:operationId/supplement-formal',
    (request, reply) => {
      const { workspaceId, operationId } = z
        .object({ workspaceId: id, operationId: id })
        .parse(request.params);
      const b = z.object({ command, expectedVersion }).strict().parse(request.body);
      const result = clinic.repo.command(
        workspaceId,
        b.command,
        { action: 'supplementFormal', operationId, expectedVersion: b.expectedVersion },
        () => {
          const old = clinic.operations.get(workspaceId, operationId);
          if (
            old.kind !== 'prepareFormal' ||
            old.status !== 'failed' ||
            old.version !== b.expectedVersion
          )
            throw new AppError('VERSION_CONFLICT', '请从最新的失败正式卷发起补题。');
          const frozen = clinic.repo.row<{ request_payload: string }>(
            'SELECT request_payload FROM agent_operations WHERE id=?',
            old.id,
          )!;
          const scope = z
            .object({ curriculumId: id, blueprintId: id, paperRequestId: id })
            .passthrough()
            .parse(JSON.parse(frozen.request_payload));
          const latest = clinic.repo.row<{ id: string }>(
            'SELECT id FROM agent_operations WHERE workspace_id=? AND scope_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
            workspaceId,
            `formal:${scope.paperRequestId}`,
          );
          if (latest?.id !== old.id)
            throw new AppError('VERSION_CONFLICT', '这份试卷已有较新的操作，请刷新学习记录。');
          const quiz = clinic.questions.get(
            workspaceId,
            stableId('quiz', {
              workspace: workspaceId,
              purpose: 'formal',
              requestId: scope.paperRequestId,
            }),
          );
          if (quiz.status !== 'draft')
            throw new AppError('VERSION_CONFLICT', '这份试卷已就绪，不能继续补题。');
          return clinic.operations.start(
            workspaceId,
            {
              commandId: `${b.command.commandId}:dispatch`,
              idempotencyKey: `${b.command.idempotencyKey}:dispatch`,
            },
            'prepareFormal',
            `formal:${scope.paperRequestId}`,
            'formal',
            {
              ...scope,
              supplement: { requestId: b.command.idempotencyKey, expectedVersion: quiz.version },
            },
          );
        },
      );
      return operationReply(reply, clinic.operations.get(workspaceId, result.id));
    },
  );
  app.post('/api/formal-assessment-versions/:versionId/execution', (request) => {
    const { versionId } = z.object({ versionId: id }).parse(request.params);
    const b = z.object({ command, workspaceId: id }).strict().parse(request.body);
    return clinic.grading.startFormal(b.workspaceId, versionId, b.command);
  });
  app.post('/api/formal-assessment-attempts/:attemptId/learner-submit', (request, reply) => {
    const { attemptId } = z.object({ attemptId: id }).parse(request.params);
    const b = z
      .object({
        command,
        workspaceId: id,
        responses: z.array(CourseAnswerSchema).min(1),
        expectedVersion,
      })
      .strict()
      .parse(request.body);
    const attempt = clinic.repo.owned<{ quizId: string }>(
      'assessment_attempts',
      attemptId,
      b.workspaceId,
    );
    const result = clinic.grading.submit(
      b.workspaceId,
      attempt.quizId,
      b.command,
      b.responses,
      b.expectedVersion,
    );
    if (result.operation) reply.code(202);
    return result;
  });
  app.post('/api/workspaces/:workspaceId/repairs', (request, reply) => {
    const workspaceId = workspace(request.params);
    const b = z
      .object({
        command,
        originKind: z.enum(['submission', 'grade']),
        originId: id,
        targetItemIds: z.array(id).min(1),
        replacePendingRoundId: id.optional(),
        expectedRoundVersion: expectedVersion.optional(),
      })
      .strict()
      .parse(request.body);
    const { command: cmd, ...input } = b;
    const round = clinic.repairs.start(workspaceId, cmd, input);
    reply.code(round.status === 'preparing' ? 202 : 200);
    return round;
  });
  app.get('/api/repair-rounds/:roundId', (request) => {
    const { roundId } = z.object({ roundId: id }).parse(request.params);
    const r = clinic.repo.owned<{ workspaceId: string }>('repair_rounds', roundId);
    const round = clinic.repairs.get(r.workspaceId, roundId);
    return {
      round,
      quiz: round.retestQuizId
        ? clinic.questions.public(clinic.questions.get(r.workspaceId, round.retestQuizId))
        : null,
    };
  });
  app.post('/api/repair-rounds/:roundId/submit', (request, reply) => {
    const { roundId } = z.object({ roundId: id }).parse(request.params);
    const b = z
      .object({
        command,
        workspaceId: id,
        answers: z.array(CourseAnswerSchema).min(1),
        version: expectedVersion,
      })
      .strict()
      .parse(request.body);
    const result = clinic.repairs.submit(b.workspaceId, roundId, b.command, b.answers, b.version);
    if (result.operation) reply.code(202);
    return result;
  });
  app.get('/api/workspaces/:workspaceId/learning-records', (request) =>
    clinic.records(workspace(request.params)),
  );
  app.get('/api/workspaces/:workspaceId/learning-progress', (request) =>
    clinic.progress(workspace(request.params)),
  );
  app.get('/api/workspaces/:workspaceId/knowledge-map', (request) =>
    clinic.knowledgeMap(workspace(request.params)),
  );
  app.get('/api/workspaces/:workspaceId/review/queue', (request) => ({
    targets: clinic.outcomes.list(workspace(request.params)),
  }));
  app.post('/api/workspaces/:workspaceId/review/:targetId/launch', (request, reply) => {
    const p = z.object({ workspaceId: id, targetId: id }).parse(request.params);
    const b = z
      .object({ command, expectedBindingVersion: expectedVersion, practiceRequestId: id })
      .strict()
      .parse(request.body);
    const target = clinic.repo.owned<{ knowledgeId: string }>(
      'review_targets',
      p.targetId,
      p.workspaceId,
    );
    const binding = clinic.repo.row<{ version: number }>(
      'SELECT version FROM review_target_bindings WHERE target_id=?',
      p.targetId,
    );
    if (binding?.version !== b.expectedBindingVersion)
      throw new AppError('VERSION_CONFLICT', '复习绑定已改变。');
    const plan = clinic.planning.current(p.workspaceId);
    return operationReply(
      reply,
      clinic.operations.start(
        p.workspaceId,
        b.command,
        'preparePractice',
        `review:${b.practiceRequestId}`,
        'quiz',
        {
          curriculumId: plan.id,
          requestId: b.practiceRequestId,
          knowledgeIds: [target.knowledgeId],
          purpose: 'explicit_review',
        },
      ),
    );
  });
  app.post('/api/workspaces/:workspaceId/learning-progress/reconcile', (request) => {
    const workspaceId = workspace(request.params);
    z.object({ command }).strict().parse(request.body);
    clinic.repo.workspace(workspaceId);
    clinic.outcomes.reconcile();
    clinic.repairs.reconcile();
    return clinic.progress(workspaceId);
  });
  app.get('/api/workspaces/:workspaceId/operations/:operationId', (request) => {
    const p = z.object({ workspaceId: id, operationId: id }).parse(request.params);
    return clinic.operations.get(p.workspaceId, p.operationId);
  });
  app.get('/api/workspaces/:workspaceId/operations', (request) => {
    const workspaceId = workspace(request.params);
    clinic.repo.workspace(workspaceId);
    return {
      operations: clinic.repo.payloads(
        'SELECT payload FROM agent_operations WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC',
        workspaceId,
      ),
    };
  });
  for (const action of ['retry', 'cancel'] as const)
    app.post(`/api/workspaces/:workspaceId/operations/:operationId/${action}`, (request, reply) => {
      const p = z.object({ workspaceId: id, operationId: id }).parse(request.params);
      const b = z.object({ command, expectedVersion }).strict().parse(request.body);
      const op = clinic.operations[action](
        p.workspaceId,
        p.operationId,
        b.command,
        b.expectedVersion,
      );
      return action === 'retry' ? operationReply(reply, op) : op;
    });
}
