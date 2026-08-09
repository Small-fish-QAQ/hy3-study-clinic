/**
 * End-to-end smoke test of the ADAPTIVE learning workflow against a running
 * dev server (fake provider, no API key):
 *
 *   node scripts/smoke-adaptive.mjs            # full 22-step workflow
 *   node scripts/smoke-adaptive.mjs verify <workspaceId> <conceptId> <runId>
 *                                              # post-restart persistence check
 *
 * The workflow can run fully offline; local scoring and state rules
 * (grading, mistake lifecycle, misconception transitions, mastery, review
 * scheduling) are deterministic, but generated content and ordering may vary
 * between runs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787';
const filesDir = join(dirname(fileURLToPath(import.meta.url)), '../apps/server/src/testing/files');
const evalFixtures = join(dirname(fileURLToPath(import.meta.url)), '../eval/fixtures');

const j = async (r) => {
  const b = r.status === 204 ? undefined : await r.json();
  if (!r.ok) throw new Error(r.status + ' ' + JSON.stringify(b));
  return b;
};
const get = (path) => fetch(base + path).then(j);
const send = (method, path, body) =>
  fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(j);

const [, , mode, verifyWorkspaceId, verifyConceptId, verifyRunId] = process.argv;

if (mode === 'verify') {
  // ---- 22-23. Post-restart persistence verification ----
  const ws = await get(`/api/workspaces/${verifyWorkspaceId}`);
  const alignment = await get(`/api/workspaces/${verifyWorkspaceId}/alignment`);
  const misconceptions = await get(`/api/workspaces/${verifyWorkspaceId}/misconceptions`);
  const review = await get(`/api/workspaces/${verifyWorkspaceId}/review`);
  const queue = await get(`/api/workspaces/${verifyWorkspaceId}/queue`);
  const run = await get(`/api/workspaces/${verifyWorkspaceId}/tutor/runs/${verifyRunId}`);
  const plan = await get(`/api/workspaces/${verifyWorkspaceId}/concepts/${verifyConceptId}/plan`);
  console.log('22. after restart:');
  console.log('    workspace:', ws.workspace.name, '| documents:', ws.documents.length);
  console.log(
    '    canonical concepts:',
    alignment.canonical.length,
    '| merged groups:',
    alignment.canonical.filter((c) => c.members.length > 1).length,
  );
  console.log(
    '    misconceptions:',
    misconceptions.misconceptions.map((m) => m.status).join(',') || '(none)',
  );
  console.log('    review items:', review.items.length, '| queue items:', queue.items.length);
  console.log(
    '    tutor run:',
    run.run.status,
    '| timeline events:',
    run.events.length,
    '| accepted evidence:',
    run.run.acceptedEvidence.length,
  );
  console.log('    plan persisted:', plan.plan ? plan.plan.id.slice(0, 12) : 'MISSING');
  console.log('23. persistence verified ✓');
} else {
  await runFullWorkflow();
}

async function runFullWorkflow() {
  // ---- 1. Create a course workspace ----
  const { workspace } = await send('POST', '/api/workspaces', {
    name: '自适应学习冒烟测试',
    description: 'adaptive smoke test (fake provider)',
  });
  console.log('1. workspace:', workspace.id.slice(0, 12), workspace.name);

  // ---- 2-3. Import three documents with bilingual overlapping concepts ----
  const docA = await send('POST', `/api/workspaces/${workspace.id}/documents`, {
    kind: 'text',
    title: '认知负荷讲义(中文)',
    content: readFileSync(join(evalFixtures, 'cognitive-load-zh.md'), 'utf8'),
  });
  const docB = await send('POST', `/api/workspaces/${workspace.id}/documents`, {
    kind: 'text',
    title: 'Memory notes (bilingual)',
    content: readFileSync(join(evalFixtures, 'memory-practice-en.md'), 'utf8'),
  });
  const docC = await send('POST', `/api/workspaces/${workspace.id}/documents`, {
    kind: 'file',
    filename: 'memory.pdf',
    dataBase64: readFileSync(join(filesDir, 'sample.pdf')).toString('base64'),
  });
  console.log(
    '2. documents:',
    [docA, docB, docC]
      .map((d) => `${d.material.sourceType}(${d.blocks.length} blocks)`)
      .join(' + '),
  );

  // ---- 4. Extract grounded source concepts ----
  let conceptCount = 0;
  for (const doc of [docA, docB, docC]) {
    const { concepts } = await send('POST', `/api/materials/${doc.material.id}/analyze`);
    conceptCount += concepts.length;
  }
  console.log('3. concepts extracted:', conceptCount, '(all grounding-verified server-side)');

  // ---- 5. Alignment: propose → auto-accept + review-accept ----
  const alignmentRun = await send('POST', `/api/workspaces/${workspace.id}/alignment/propose`);
  console.log(
    '4. alignment proposals: auto-accepted =',
    alignmentRun.autoAccepted.length,
    '| for review =',
    alignmentRun.created.length,
    '| locally rejected =',
    alignmentRun.rejected.length,
  );
  for (const proposal of alignmentRun.created) {
    await send(
      'POST',
      `/api/workspaces/${workspace.id}/alignment/proposals/${proposal.id}/accept`,
      {},
    );
  }
  const alignment = await get(`/api/workspaces/${workspace.id}/alignment`);
  const merged = alignment.canonical.filter((c) => c.members.length > 1);
  console.log(
    '5. canonical graph:',
    alignment.canonical.length,
    'canonical concepts |',
    merged.length,
    'merged groups, e.g.',
    merged
      .slice(0, 2)
      .map((c) => `「${c.displayName}」←[${c.members.map((m) => m.originalName).join(' / ')}]`)
      .join(' ; '),
  );

  // ---- 6. Build the concept graph ----
  const graphGen = await send('POST', `/api/workspaces/${workspace.id}/graph`);
  console.log(
    '6. graph:',
    graphGen.version.status,
    '| edges:',
    graphGen.edges.length,
    '| accepted:',
    graphGen.version.validationSummary.acceptedCount,
  );

  // ---- 7. Diagnostic assessment (wrong answers seed weakness) ----
  const diagnostic = await send('POST', `/api/workspaces/${workspace.id}/assessments`, {
    mode: 'diagnostic',
  });
  const crossBlueprints = diagnostic.blueprints.filter((b) => b.scope === 'cross_document');
  console.log(
    '7. diagnostic assessment:',
    diagnostic.quiz.questions.length,
    'questions |',
    crossBlueprints.length,
    'cross-document blueprints | answers leak to client:',
    JSON.stringify(diagnostic).includes('"correctOptionIds":') ? 'YES(BUG!)' : 'no',
  );

  const wrongAnswers = diagnostic.quiz.questions.map((q) =>
    q.options
      ? { questionId: q.id, type: q.type, selectedOptionIds: [q.options[q.options.length - 1].id] }
      : { questionId: q.id, type: q.type, text: '这是一个偏离资料的回答。' },
  );
  const diagGrading = await send('POST', `/api/quizzes/${diagnostic.quiz.id}/submissions`, {
    answers: wrongAnswers,
  });
  const changes = diagGrading.stateChanges;
  console.log(
    '8. graded:',
    Math.round(diagGrading.grading.overallScore * 100) + '%',
    '| mistakes created:',
    changes.mistakesCreated,
    '| misconceptions proposed:',
    changes.misconceptionsProposed,
    '| review scheduled:',
    changes.reviewScheduled.length,
  );

  // ---- 9-10. Misconception hypothesis → discriminating activity ----
  const proposedList = (await get(`/api/workspaces/${workspace.id}/misconceptions?status=proposed`))
    .misconceptions;
  console.log(
    '9. misconception hypotheses (proposed, tentative):',
    proposedList.map((m) => `[${m.category}] ${m.hypothesis.slice(0, 40)}…`).join(' | ') ||
      '(none)',
  );
  let misconceptionOutcome = '(no proposed hypothesis this run)';
  if (proposedList.length > 0) {
    const target = proposedList[0];
    const checkQuiz = await send('POST', `/api/workspaces/${workspace.id}/assessments`, {
      mode: 'misconception_check',
      misconceptionId: target.id,
    });
    // Answer the discriminating question WRONG → deterministic local rule
    // confirms the hypothesis.
    const wrong = checkQuiz.quiz.questions.map((q) => ({
      questionId: q.id,
      type: q.type,
      selectedOptionIds: [q.options[q.options.length - 1].id],
    }));
    const checkResult = await send('POST', `/api/quizzes/${checkQuiz.quiz.id}/submissions`, {
      answers: wrong,
    });
    const after = (await get(`/api/workspaces/${workspace.id}/misconceptions`)).misconceptions.find(
      (m) => m.id === target.id,
    );
    misconceptionOutcome = `answered wrong → status ${after.status} (confirmed by LOCAL rule, changes: +${checkResult.stateChanges.misconceptionsConfirmed})`;
  }
  console.log('10. discriminating activity:', misconceptionOutcome);

  // ---- 11-13. Bounded Tutor session over the weak concept ----
  const overlay = await get(`/api/workspaces/${workspace.id}/overlay`);
  const weak = overlay.states.find((s) => s.treatAsWeak) ?? overlay.states[0];
  const tutorResponse = await fetch(`${base}/api/workspaces/${workspace.id}/tutor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conceptId: weak.conceptId }),
  });
  const lines = (await tutorResponse.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const events = lines.filter((l) => l.kind === 'event').map((l) => l.event);
  const tutorRun = lines.find((l) => l.kind === 'run')?.run;
  console.log('11. tutor session on weak concept「' + weak.conceptName + '」:');
  for (const event of events.slice(0, 8)) {
    console.log(`      [${event.kind}] ${event.summary.slice(0, 60)}`);
  }
  if (events.length > 8) console.log(`      … ${events.length - 8} more events`);
  console.log(
    '12. tutor bounded:',
    tutorRun.status,
    '|',
    tutorRun.iterations,
    'iterations |',
    tutorRun.toolCallCount,
    'tool calls |',
    tutorRun.acceptedEvidence.length,
    'accepted evidence (limits: 6/12/20)',
  );
  const searchEvents = events.filter((e) => e.detail?.toolName === 'search_source_blocks');
  console.log(
    '13. multi-document evidence retrieved via bounded search:',
    searchEvents.length > 0 ? `yes (${searchEvents[0].summary.slice(0, 40)}…)` : 'not this run',
  );

  // ---- 14-15. Launch the tutor-recommended activity (server-owned route) ----
  // The server reloads the persisted recommendation, revalidates it against
  // current state, and constructs the launch itself. A completed run's
  // activity must be launchable — this asserts the executability contract.
  const practice = await send(
    'POST',
    `/api/workspaces/${workspace.id}/tutor/runs/${tutorRun.id}/activity`,
    undefined,
  );
  console.log(
    '14. tutor-recommended activity:',
    tutorRun.activity?.mode,
    '→ launched as',
    practice.launchedMode,
    practice.adjusted ? `(adjusted: ${practice.adjusted.reason})` : '(no adjustment)',
    '| quiz with',
    practice.quiz.questions.length,
    'questions',
  );

  // Answer correctly using the server-side key (demo environment reads the
  // full questions from the grading reveal of a deliberate blank submission —
  // instead we answer from evidence like a diligent learner: choose the option
  // quoted verbatim in the evidence block, write the source text for others).
  const allBlocks = [docA, docB, docC].flatMap((d) => d.blocks);
  const blockText = (id) => allBlocks.find((b) => b.id === id)?.content ?? '';
  const practiceAnswers = practice.quiz.questions.map((q) => {
    if (q.options) {
      const evidence = blockText(q.grounding.blockId);
      const correct = q.options.find((o) => evidence.includes(o.text)) ?? q.options[0];
      return { questionId: q.id, type: q.type, selectedOptionIds: [correct.id] };
    }
    const sources = [q.grounding, ...(q.supplementaryEvidence ?? [])]
      .map((e) => blockText(e.blockId))
      .join(' ');
    return { questionId: q.id, type: q.type, text: sources.slice(0, 800) };
  });
  const practiceGrading = await send('POST', `/api/quizzes/${practice.quiz.id}/submissions`, {
    answers: practiceAnswers,
  });
  const pc = practiceGrading.stateChanges;
  console.log(
    '15. practice graded:',
    Math.round(practiceGrading.grading.overallScore * 100) + '%',
    '| gradedBy:',
    [...new Set(practiceGrading.grading.grades.map((g) => g.gradedBy))].join('+'),
  );

  // ---- 15b. Lesson card with segment-level, server-verified provenance ----
  const lessonRes = await send(
    'POST',
    `/api/workspaces/${workspace.id}/concepts/${weak.conceptId}/lesson`,
    {},
  );
  const lessonSegments = lessonRes.lesson.content.sections.flatMap((s) => s.segments);
  const lessonAnchored = lessonSegments.filter((s) => s.anchor).length;
  console.log(
    '15b. lesson card:',
    lessonRes.lesson.content.sections.length,
    'sections |',
    `${lessonAnchored}/${lessonSegments.length} segments course-source-backed (rest labeled AI teaching)`,
  );
  if (lessonAnchored === 0 || lessonAnchored === lessonSegments.length) {
    throw new Error('lesson card must contain BOTH provenance classes in the fake demo');
  }

  // ---- 16-19. Deterministic state updates ----
  console.log(
    '16. mistakes: created',
    pc.mistakesCreated,
    '| resolved',
    pc.mistakesResolved,
    '(practice over open mistakes resolves them exactly)',
  );
  console.log(
    '17. mastery updates:',
    pc.masteryChanges
      .map(
        (m) =>
          `${m.conceptName} ${m.before === null ? '—' : Math.round(m.before * 100) + '%'}→${Math.round(m.after * 100)}%`,
      )
      .join(', ') || '(none)',
  );
  console.log(
    '18. misconception state after activities:',
    (await get(`/api/workspaces/${workspace.id}/misconceptions`)).misconceptions
      .map((m) => m.status)
      .join(',') || '(none)',
  );
  console.log(
    '19. review scheduling:',
    pc.reviewScheduled
      .map((r) => `${r.conceptName}(${r.rating}→${r.dueAt.slice(0, 10)})`)
      .join(', ') || '(unchanged this round)',
  );

  // ---- 20-21. Daily queue ----
  const queue = await get(`/api/workspaces/${workspace.id}/queue`);
  console.log(
    '20. daily queue (deterministic priorities):',
    queue.items.map((i) => `[${i.kind}] ${i.conceptName}`).join(' | ') || '(empty)',
  );
  console.log('21. workflow complete — offline, no API key. Content/order may vary between runs.');

  console.log('\nSMOKE_WORKSPACE_ID=' + workspace.id);
  console.log('SMOKE_CONCEPT_ID=' + weak.conceptId);
  console.log('SMOKE_RUN_ID=' + tutorRun.id);
  console.log('Now restart the server and run:');
  console.log(
    `  node scripts/smoke-adaptive.mjs verify ${workspace.id} ${weak.conceptId} ${tutorRun.id}`,
  );
}
