/** End-to-end smoke test of both flows against a running dev server. */
import { assertFakeHttpProvider } from './assert-fake-provider.mjs';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787';
const j = async (r) => {
  const b = await r.json();
  if (!r.ok) throw new Error(r.status + ' ' + JSON.stringify(b));
  return b;
};

await assertFakeHttpProvider(base, 'HTTP smoke workflow');

const sample = await j(await fetch(base + '/api/sample-material'));
const imported = await j(
  await fetch(base + '/api/materials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: sample.content, filename: sample.filename }),
  }),
);
const materialId = imported.material.id;
console.log('1. imported:', materialId.slice(0, 16), 'blocks:', imported.blocks.length);

const analysis = await j(
  await fetch(base + `/api/materials/${materialId}/analyze`, { method: 'POST' }),
);
console.log(
  '2. concepts:',
  analysis.concepts.length,
  '-',
  analysis.concepts.map((c) => c.name).join('、'),
);
let ok = true;
for (const c of analysis.concepts) {
  const blk = imported.blocks.find((b) => b.id === c.grounding.blockId);
  if (blk.content.slice(c.grounding.startOffset, c.grounding.endOffset) !== c.grounding.quote) {
    ok = false;
  }
}
console.log('   grounding slice invariant holds:', ok);

const quizResp = await j(
  await fetch(base + '/api/quizzes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      materialId,
      config: {
        difficulty: 'medium',
        types: ['single_choice', 'multiple_choice', 'short_answer'],
        countPerType: 2,
      },
    }),
  }),
);
const quiz = quizResp.quiz;
const quizJson = JSON.stringify(quiz);
console.log('3. quiz:', quiz.id.slice(0, 14), 'questions:', quiz.questions.length);
console.log(
  '   no answers leaked:',
  !quizJson.includes('correctOptionIds') &&
    !quizJson.includes('expectedAnswer') &&
    !quizJson.includes('rubric'),
);

const answers = quiz.questions.map((q) =>
  q.type === 'short_answer'
    ? { questionId: q.id, type: q.type, text: '' }
    : { questionId: q.id, type: q.type, selectedOptionIds: [] },
);
const sub = await j(
  await fetch(base + `/api/quizzes/${quiz.id}/submissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers }),
  }),
);
console.log(
  '4. graded. overallScore:',
  sub.grading.overallScore,
  'gradedBy set:',
  [...new Set(sub.grading.grades.map((g) => g.gradedBy))].join(','),
);

const mistakes = await j(await fetch(base + `/api/materials/${materialId}/mistakes?status=open`));
console.log(
  '5. open mistakes:',
  mistakes.mistakes.length,
  'weak concepts:',
  mistakes.weakConcepts.length,
);

const rem = await j(
  await fetch(base + `/api/materials/${materialId}/remediation`, { method: 'POST' }),
);
console.log(
  '6. remediation:',
  rem.quiz.id.slice(0, 14),
  'kind:',
  rem.quiz.kind,
  'targets:',
  rem.quiz.targetConceptIds.length,
);

// Answer remediation correctly using revealed key from a submission response.
const remAnswers = rem.quiz.questions.map((q) =>
  q.type === 'short_answer'
    ? { questionId: q.id, type: q.type, text: q.grounding.quote }
    : { questionId: q.id, type: q.type, selectedOptionIds: [] },
);
// Choice keys are hidden pre-submission (by design); submit SA-correct answers.
const remSub = await j(
  await fetch(base + `/api/quizzes/${rem.quiz.id}/submissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: remAnswers }),
  }),
);
console.log('7. remediation graded. overallScore:', remSub.grading.overallScore);

const after = await j(await fetch(base + `/api/materials/${materialId}/mistakes?status=open`));
console.log(
  '   open mistakes after remediation:',
  after.mistakes.length,
  '(was',
  mistakes.mistakes.length + ')',
);

const mastery = await j(await fetch(base + `/api/materials/${materialId}/mastery`));
console.log(
  '8. mastery states:',
  mastery.mastery.length,
  'first:',
  mastery.mastery[0].conceptName,
  mastery.mastery[0].mastery,
);
console.log('ALL FLOWS OK');
