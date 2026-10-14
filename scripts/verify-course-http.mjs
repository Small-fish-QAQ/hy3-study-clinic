import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/server/src/app.js';
import { openDatabase } from '../apps/server/src/db/database.js';
import { loadConfig } from '../apps/server/src/config.js';
import { ProviderRuntime } from '../apps/server/src/services/providerRuntime.js';
import { CourseFakeProvider } from '../apps/server/src/llm/courseFakeProvider.js';
import { randomUUID } from 'node:crypto';
const cmd = () => {
  const id = randomUUID();
  return { commandId: id, idempotencyKey: id };
};
const GOLDEN_TEXT =
  '# 定义\n\n速度包含大小与方向。\n\n# 步骤\n\n先固定坐标方向，再测量位移与时间。';

const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

async function verify() {
  const requests = [];
  const outputFixture = new CourseFakeProvider();
  let stall = false;
  let release;
  let received;
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  const errors = [];
  const upstream = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const method = /Study Clinic的(\w+)服务/u.exec(body.messages[0].content)[1];
      const input = JSON.parse(body.messages[1].content);
      requests.push({ url: req.url, model: body.model, method, maxTokens: body.max_tokens });
      if (method === 'extractCourseKnowledge') {
        if (stall) return; // Simulate an upstream that accepts the body but sends no headers.
        received();
        await pause;
      }
      const value =
        method === 'testConnection'
          ? { ok: true }
          : method === 'extractCourseKnowledge'
            ? {
                knowledge: input.blocks.map((block, i) => ({
                  localRef: `k${i}`,
                  title: block.headingPath.at(-1) ?? `知识${i}`,
                  statement: block.text.trim().replace(/^#+[^\n]*\n+/u, ''),
                  kind: /步骤/u.test(block.text) ? 'procedure' : 'concept',
                  origin: 'textbook',
                  sourceBlockIds: [block.id],
                  prerequisiteRefs: [],
                  relatedRefs: [],
                  uncertaintyCodes: [],
                })),
                dispositions: input.blocks.map((block) => ({
                  blockId: block.id,
                  exclusion: null,
                })),
              }
            : method === 'generateCoursePlan'
              ? await outputFixture.generateCoursePlan(input)
              : method === 'reviewKnowledgeScope'
                ? { issues: [], checkedKnowledgeIds: input.knowledge.map((k) => k.id) }
                : method === 'generateLesson'
                  ? await outputFixture.generateLesson(input).then((value) => ({
                      ...value,
                      segments: [
                        ...value.segments,
                        {
                          id: 'http-reflection',
                          kind: 'optional_prompt',
                          text: '方向改变后，结论怎样变化？说明条件。',
                          origin: 'extension',
                          sourceRefs: [],
                          uncertaintyCodes: [],
                        },
                      ],
                    }))
                  : [
                        'verifyLessonParts',
                        'respondToTutorTurn',
                        'generateQuestions',
                        'solveQuestion',
                        'reviewQuestionRubric',
                        'gradeShortAnswer',
                      ].includes(method)
                    ? await outputFixture[method](input)
                    : (() => {
                        throw new Error(`Unexpected paid capability: ${method}`);
                      })();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 200 },
        }),
      );
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end('offline fixture failed');
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = upstream.address().port;
  const nativeFetch = globalThis.fetch;
  const localEndpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
  globalThis.fetch = (url, options) => {
    assert.equal(String(url), localEndpoint, 'HTTP validation prohibits every external URL');
    return nativeFetch(url, options);
  };
  const runtime = new ProviderRuntime({
    startup: loadConfig({ LLM_PROVIDER: 'fake' }),
    store: {
      read: () => ({
        version: 1,
        provider: 'moma',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'local-only-secret',
        model: 'glm-5.3',
        timeoutMs: 2000,
        longTaskTimeoutMs: 5000,
        maxOutputTokens: 64000,
      }),
      write: () => {},
    },
  });
  const db = openDatabase(':memory:');
  const app = buildApp({ db, provider: runtime.provider, providerRuntime: runtime });
  try {
    const connection = await app.inject({ method: 'POST', url: '/api/config/test', payload: {} });
    assert.equal(connection.statusCode, 200, connection.body + JSON.stringify(errors));
    assert.equal(connection.json().externalConnection.status, 'verified');
    const workspace = app.clinic.sources.createWorkspace('HTTP 验收课程');
    await app.clinic.sources.import(workspace.id, { content: GOLDEN_TEXT });
    const url = `/api/workspaces/${workspace.id}`;
    const response = await app.inject({
      method: 'POST',
      url: `${url}/course-plan/prepare`,
      payload: {
        command: cmd(),
        preferences: { desiredDepth: 'proficient', focusRequest: '辨析失败原因' },
      },
    });
    assert.equal(response.statusCode, 202);
    const op = response.json();
    await arrived;
    const waiting = (await app.inject(`${url}/operations/${op.id}`)).json();
    assert.equal(waiting.status, 'running');
    assert.equal(waiting.modelRequest.provider, 'moma');
    assert.equal(waiting.modelRequest.model, 'glm-5.3');
    assert.equal(waiting.modelRequest.timeoutMs, 5000);
    assert.equal(waiting.modelRequest.responseReceived, false);
    assert.equal(waiting.progress?.completedSourceBlocks, 0);
    // Changes in a later request cannot replace the running operation's captured provider.
    await app.inject({ method: 'PUT', url: '/api/config', payload: { provider: 'fake' } });
    release();
    await app.clinic.operations.idle(op.id);
    const final = (await app.inject(`${url}/operations/${op.id}`)).json();
    assert.equal(final.status, 'completed', JSON.stringify(final.error));
    assert.equal(final.modelRequest?.responseReceived, true);
    const plan = app.clinic.planning.get(workspace.id);
    assert.equal(plan.status, 'draft');
    assert.ok(plan.lessons.every((lesson) => lesson.selectedDepth === 'proficient'));
    assert.equal(final.progress?.completedSourceBlocks, final.progress?.totalSourceBlocks);
    assert.deepEqual(
      requests.map((request) => request.method),
      ['testConnection', 'extractCourseKnowledge', 'extractCourseKnowledge', 'generateCoursePlan'],
    );
    assert.ok(
      requests.every(
        (request) => request.model === 'glm-5.3' && request.url === '/v1/chat/completions',
      ),
    );
    assert.deepEqual(
      db.prepare('SELECT COUNT(*) AS n FROM llm_physical_attempts WHERE status=?').get('completed'),
      { n: 3 },
    );
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM course_lesson_versions').get(), {
      n: 0,
    });
    const snapshots = db.prepare('SELECT provider_snapshot FROM llm_calls').all();
    assert.ok(snapshots.every((row) => JSON.parse(row.provider_snapshot).provider === 'moma'));
    assert.ok(!JSON.stringify(final).includes('local-only-secret'));
    const confirmed = app.clinic.planning.confirm(workspace.id, plan.id, plan.version);
    assert.equal(confirmed.status, 'accepted');
    runtime.update({
      provider: 'moma',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'glm-5.3',
      secret: { action: 'replace', value: 'local-only-secret' },
      maxOutputTokens: 64000,
      longTaskTimeoutMs: 5000,
    });
    const api = async (method, path, body) => {
      const response = await app.inject({ method, url: path, ...(body ? { payload: body } : {}) });
      assert.ok(response.statusCode < 300, response.body);
      return response.json();
    };
    const settle = async (op) => {
      await app.clinic.operations.idle(op.id);
      const final = await api('GET', `${url}/operations/${op.id}`);
      assert.equal(final.status, 'completed', JSON.stringify(final));
      return final;
    };
    const lesson = confirmed.lessons[0];
    await settle(
      await api('POST', `${url}/lessons/${lesson.id}/open`, {
        command: cmd(),
        curriculumId: confirmed.id,
      }),
    );
    const visit = await api('POST', `${url}/lessons/${lesson.id}/open`, {
      command: cmd(),
      curriculumId: confirmed.id,
    });
    const room = await api('GET', `${url}/study-sessions/${visit.session.id}`);
    const anchor = {
      lessonVersionId: room.content.id,
      segmentIds: [room.content.segments[0].id],
      selectedText: room.content.segments[0].text.slice(0, 20).trim(),
    };
    const turn = await api('POST', `${url}/study-sessions/${room.session.id}/turns`, {
      question: '条件改变后呢？这是我的自由提问。',
      anchor,
    });
    assert.deepEqual(turn.anchor, anchor);
    const reflectionUrl = `${url}/lesson-versions/${room.content.id}/reflections/http-reflection`;
    await api('PUT', reflectionUrl, {
      command: cmd(),
      status: 'deferred',
      response: '先确认方向。',
      expectedVersion: 0,
    });
    await api('POST', `${url}/lessons/${lesson.id}/complete`, {
      command: cmd(),
      visitId: room.session.id,
      lessonVersionId: room.content.id,
    });
    await api('PUT', reflectionUrl, {
      command: cmd(),
      status: 'answered',
      response: '先确认坐标约定和位移。',
      expectedVersion: 1,
    });
    assert.equal(
      (await api('GET', `${url}/learning-progress`)).classroomTasks[0].status,
      'answered',
    );
    const formal = await settle(
      await api('POST', `${url}/formal-exams`, {
        command: cmd(),
        curriculumId: confirmed.id,
        blueprintId: confirmed.assessmentBlueprint.id,
        paperRequestId: 'http-unit',
        moduleId: lesson.moduleId,
      }),
    );
    const quiz = await api('GET', `/api/quizzes/${formal.resourceId}`);
    assert.equal(quiz.assessmentScope.kind, 'module');
    assert.equal(quiz.assessmentScope.moduleId, lesson.moduleId);
    assert.ok(!JSON.stringify(quiz).includes('"rubric"'));
    const attempt = await api('POST', `/api/formal-assessment-versions/${quiz.id}/execution`, {
      command: cmd(),
      workspaceId: workspace.id,
    });
    const submit = await api(
      'POST',
      `/api/formal-assessment-attempts/${attempt.id}/learner-submit`,
      {
        command: cmd(),
        workspaceId: workspace.id,
        expectedVersion: quiz.version,
        responses: quiz.items.map((q) => ({
          questionId: q.id,
          response: ['A'],
          assistance: 'none',
        })),
      },
    );
    await settle(submit.operation);
    assert.equal(
      (await api('GET', `${url}/learning-records`)).formalGrades[0].assessmentScope.kind,
      'module',
    );
    const beforeTimeout = requests.length;
    stall = true;
    runtime.update({
      provider: 'moma',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'glm-5.3',
      secret: { action: 'replace', value: 'local-only-secret' },
      longTaskTimeoutMs: 200,
    });
    const failedWorkspace = app.clinic.sources.createWorkspace('离线超时复现');
    await app.clinic.sources.import(failedWorkspace.id, { content: GOLDEN_TEXT });
    const timeoutOp = (
      await app.inject({
        method: 'POST',
        url: `/api/workspaces/${failedWorkspace.id}/course-plan/prepare`,
        payload: { command: cmd() },
      })
    ).json();
    await app.clinic.operations.idle(timeoutOp.id);
    const failure = (
      await app.inject(`/api/workspaces/${failedWorkspace.id}/operations/${timeoutOp.id}`)
    ).json();
    assert.equal(failure.status, 'failed');
    assert.equal(failure.error.code, 'PROVIDER_TIMEOUT');
    assert.equal(failure.modelRequest.responseReceived, false);
    assert.equal(
      requests.length - beforeTimeout,
      1,
      'Unknown upstream outcomes are never automatically retried',
    );
    assert.deepEqual(
      db
        .prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE workspace_id=? AND status=?')
        .get(failedWorkspace.id, 'outcome_unknown'),
      { n: 1 },
    );
    assert.equal(app.clinic.planning.get(failedWorkspace.id), null);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        requests,
        checks: [
          'saved-provider-priority',
          'same-connection-and-prepare-model',
          'runner-dispatch',
          'waiting-state-persistence',
          'immutable-operation-provider',
          'HTTP-to-localhost',
          'validated-plan-persistence',
          'explicit-confirmation',
          'no-eager-lessons',
          'timeout-persisted-with-unknown-upstream-outcome',
          'no-automatic-paid-retry',
          'free-question-and-validated-tutor-anchor-over-HTTP',
          'optional-reflection-durable-without-completion-gate',
          'module-formal-frozen-scope-grading-and-evidence-over-HTTP',
        ],
      }),
    );
  } finally {
    release();
    await app.close();
    db.close();
    await closeServer(upstream);
    globalThis.fetch = nativeFetch;
  }
}
await verify();
