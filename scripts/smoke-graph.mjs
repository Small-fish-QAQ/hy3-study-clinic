/**
 * End-to-end smoke test of the evidence-grounded learning-workspace flow
 * against a running dev server (fake provider, no API key).
 *
 *   node scripts/smoke-graph.mjs            # full workflow
 *   node scripts/smoke-graph.mjs verify <workspaceId> <conceptId>
 *                                           # post-restart persistence check
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787';
const filesDir = join(dirname(fileURLToPath(import.meta.url)), '../apps/server/src/testing/files');

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

const [, , mode, verifyWorkspaceId, verifyConceptId] = process.argv;

if (mode === 'verify') {
  // ---- Post-restart persistence verification ----
  const ws = await get(`/api/workspaces/${verifyWorkspaceId}`);
  const graph = await get(`/api/workspaces/${verifyWorkspaceId}/graph`);
  const overlay = await get(`/api/workspaces/${verifyWorkspaceId}/overlay`);
  const plan = await get(`/api/workspaces/${verifyWorkspaceId}/concepts/${verifyConceptId}/plan`);
  const resolved = overlay.states.reduce((n, s) => n + s.resolvedMistakes, 0);
  console.log('16. after restart:');
  console.log('    workspace persisted:', ws.workspace.name, '| documents:', ws.documents.length);
  console.log(
    '    graph persisted:',
    graph.version?.status,
    '| edges:',
    graph.edges.length,
    '| concepts:',
    graph.concepts.length,
  );
  console.log(
    '    learner state persisted: resolvedMistakes total =',
    resolved,
    '| assessed concepts =',
    overlay.states.filter((s) => s.attempts > 0).length,
  );
  console.log('    accepted plan persisted:', plan.plan ? plan.plan.id.slice(0, 12) : 'MISSING');
} else {
  await runFullWorkflow();
}

async function runFullWorkflow() {
  // ---- 1. Create a course workspace ----
  const { workspace } = await send('POST', '/api/workspaces', {
    name: '认知科学冒烟测试',
    description: 'fake-provider smoke test',
  });
  console.log('1. workspace:', workspace.id.slice(0, 12), workspace.name);

  // ---- 2. Import three document types: Markdown text, PDF, DOCX ----
  const mdDoc = await send('POST', `/api/workspaces/${workspace.id}/documents`, {
    kind: 'text',
    title: '记忆基础(Markdown)',
    content: [
      '# 工作记忆',
      '',
      '工作记忆的容量十分有限。它一次只能保持大约四个组块。',
      '',
      '# 长时记忆',
      '',
      '长时记忆通过巩固过程形成,睡眠对巩固十分重要。',
      '',
      '# 检索练习',
      '',
      '检索练习要求主动回忆而非重读,长期效果更好。',
    ].join('\n'),
  });
  const pdfDoc = await send('POST', `/api/workspaces/${workspace.id}/documents`, {
    kind: 'file',
    filename: 'memory.pdf',
    dataBase64: readFileSync(join(filesDir, 'sample.pdf')).toString('base64'),
  });
  const docxDoc = await send('POST', `/api/workspaces/${workspace.id}/documents`, {
    kind: 'file',
    filename: '讲义.docx',
    dataBase64: readFileSync(join(filesDir, 'sample.docx')).toString('base64'),
  });
  console.log(
    '2. documents:',
    [mdDoc, pdfDoc, docxDoc]
      .map((d) => `${d.material.sourceType}(${d.blocks.length} blocks)`)
      .join(' + '),
  );

  // ---- 3. Verify extracted source locations ----
  let locOk = true;
  for (const doc of [mdDoc, pdfDoc, docxDoc]) {
    for (const b of doc.blocks) {
      if (doc.material.content.slice(b.startOffset, b.endOffset) !== b.content) locOk = false;
    }
  }
  const pdfPages = [...new Set(pdfDoc.blocks.map((b) => b.pageNumber))];
  const docxHeadings = docxDoc.blocks.map((b) => b.heading).filter(Boolean);
  console.log(
    '3. provenance: offset invariant =',
    locOk,
    '| pdf pages =',
    pdfPages.join(','),
    '| docx headings =',
    docxHeadings.join('、'),
  );

  // ---- 4. Generate concepts for every document ----
  let conceptCount = 0;
  for (const doc of [mdDoc, pdfDoc, docxDoc]) {
    const { concepts } = await send('POST', `/api/materials/${doc.material.id}/analyze`);
    conceptCount += concepts.length;
  }
  console.log('4. concepts extracted:', conceptCount);

  // ---- 5. Generate the evidence-grounded concept graph ----
  const generated = await send('POST', `/api/workspaces/${workspace.id}/graph`);
  console.log(
    '5. graph:',
    generated.version.status,
    '| edges:',
    generated.edges.length,
    '| summary:',
    JSON.stringify({
      candidates: generated.version.validationSummary.candidateCount,
      accepted: generated.version.validationSummary.acceptedCount,
      rejected: generated.version.validationSummary.rejectedCount,
    }),
  );

  // ---- 6-8. Inspect a node, an edge, and its verified evidence ----
  const graph = await get(`/api/workspaces/${workspace.id}/graph`);
  const node = graph.concepts[0];
  const edge = graph.edges[0];
  const allBlocks = [];
  for (const doc of graph.concepts
    .map((c) => c.materialId)
    .filter((v, i, a) => a.indexOf(v) === i)) {
    const m = await get(`/api/materials/${doc}`);
    allBlocks.push(...m.blocks);
  }
  const evidenceBlock = allBlocks.find((b) => b.id === edge.evidence[0].blockId);
  const sliceOk =
    evidenceBlock.content.slice(edge.evidence[0].startOffset, edge.evidence[0].endOffset) ===
    edge.evidence[0].quote;
  console.log('6. node:', node.name, '| grounding quote:', node.grounding.quote.slice(0, 18) + '…');
  console.log(
    '7. edge:',
    `${edge.relation}`,
    '| explanation:',
    edge.explanation.slice(0, 30) + '…',
  );
  console.log('8. edge evidence verified server-side, slice invariant =', sliceOk);

  // ---- 9. Learner overlay before any activity ----
  let overlay = await get(`/api/workspaces/${workspace.id}/overlay`);
  console.log(
    '9. overlay: states =',
    overlay.states.length,
    '| unassessed =',
    overlay.states.filter((s) => s.state === 'unassessed').length,
  );

  // ---- Create open mistakes: fail a quiz on the markdown document ----
  const failQuiz = (
    await send('POST', '/api/quizzes', {
      materialId: mdDoc.material.id,
      config: { difficulty: 'medium', types: ['single_choice', 'short_answer'], countPerType: 2 },
    })
  ).quiz;
  const failSubmission = await send('POST', `/api/quizzes/${failQuiz.id}/submissions`, {
    answers: failQuiz.questions.map((q) =>
      q.type === 'short_answer'
        ? { questionId: q.id, type: q.type, text: '完全不相关的错误回答' }
        : { questionId: q.id, type: q.type, selectedOptionIds: [] },
    ),
  });
  overlay = await get(`/api/workspaces/${workspace.id}/overlay`);
  const weakState = overlay.states.find((s) => s.openMistakes > 0);
  console.log(
    '   seeded mistakes: score =',
    failSubmission.grading.overallScore,
    '| weak concept =',
    weakState.conceptName,
    `(open=${weakState.openMistakes}, state=${weakState.state})`,
  );

  // ---- 10. Generate a bounded remediation plan for the weak concept ----
  const planConceptId = weakState.conceptId;
  const { plan } = await send(
    'POST',
    `/api/workspaces/${workspace.id}/concepts/${planConceptId}/plan`,
  );
  console.log(
    '10. plan:',
    plan.id.slice(0, 12),
    '| strategy:',
    plan.strategy,
    '| targets:',
    plan.targets.map((t) => t.conceptName).join('、'),
    '| steps:',
    plan.steps.length,
  );

  // ---- 11. Launch remediation from the accepted plan ----
  const launch = await send('POST', `/api/workspaces/${workspace.id}/plans/${plan.id}/launch`);
  console.log(
    '11. launch mode:',
    launch.mode,
    '| quiz kind:',
    launch.quiz.kind,
    '| questions:',
    launch.quiz.questions.length,
  );

  // ---- 12-13. Complete the assessment with verbatim-grounded answers ----
  const blockText = (id) => allBlocks.find((b) => b.id === id)?.content ?? '';
  const answers = launch.quiz.questions.map((q) => {
    if (q.type === 'short_answer') {
      return { questionId: q.id, type: q.type, text: blockText(q.grounding.blockId) };
    }
    // The verbatim source sentence is the correct option (fake provider).
    const correct = q.options.find((o) => blockText(q.grounding.blockId).includes(o.text));
    return { questionId: q.id, type: q.type, selectedOptionIds: [correct.id] };
  });
  const graded = await send('POST', `/api/quizzes/${launch.quiz.id}/submissions`, { answers });
  // Amendment C (2026-08): the same quiz can no longer be graded twice — the
  // grading transaction applies learner state at most once and a duplicate
  // submission is rejected with 409 DUPLICATE_SUBMISSION.
  const rerunResponse = await fetch(base + `/api/quizzes/${launch.quiz.id}/submissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
  const rerunBody = await rerunResponse.json();
  console.log(
    '12. remediation graded: overall =',
    graded.grading.overallScore,
    '| gradedBy =',
    [...new Set(graded.grading.grades.map((g) => g.gradedBy))].join('+'),
  );
  console.log(
    '13. duplicate-submission guard: status =',
    rerunResponse.status,
    '| code =',
    rerunBody.error?.code,
    '| once-only =',
    rerunResponse.status === 409 && rerunBody.error?.code === 'DUPLICATE_SUBMISSION',
  );
  if (rerunResponse.status !== 409) {
    throw new Error('duplicate submission was not rejected with 409');
  }

  // ---- 14-15. Mistake resolution + mastery movement ----
  overlay = await get(`/api/workspaces/${workspace.id}/overlay`);
  const after = overlay.states.find((s) => s.conceptId === planConceptId);
  console.log(
    '14. mistake lifecycle: open =',
    after.openMistakes,
    '| resolved =',
    after.resolvedMistakes,
  );
  console.log(
    '15. mastery: value =',
    after.mastery,
    '| state =',
    after.state,
    '| attempts =',
    after.attempts,
  );

  console.log('\nSMOKE_WORKSPACE_ID=' + workspace.id);
  console.log('SMOKE_CONCEPT_ID=' + planConceptId);
  console.log('Now restart the server and run:');
  console.log(`  node scripts/smoke-graph.mjs verify ${workspace.id} ${planConceptId}`);
}
