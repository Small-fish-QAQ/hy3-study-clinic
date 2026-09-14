import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, write, sha } from './common.mjs';
import { studyView, learnerTask } from '../product/learner.mjs';

const recorded = process.argv[2];
if (!recorded) throw Error('Recorded development run required for public-surface checks');
const checked = [];
const cases = path.join(recorded, 'cases');
for (const id of fs.readdirSync(cases)) {
  const file = path.join(cases, id, 'learner-actions.jsonl');
  if (!fs.existsSync(file)) continue;
  const actions = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  for (const action of actions) {
    if (action.action.kind !== 'respond_to_worked_interaction' || action.action.phase !== 'transfer') continue;
    const current = action.preAnswerSurface;
    const question = current.lesson.segments[current.progress.currentSegmentIndex].workedProcess.interaction.transfer;
    const task = learnerTask(question);
    const study = studyView(current);
    assert(task.prompt.includes(question.prompt));
    assert(task.prompt.includes(question.changedCondition));
    assert(JSON.stringify(study).includes(question.changedCondition));
    assert.deepEqual(task.options, question.options.map(({ id, text }) => ({ id, text })));
    const text = JSON.stringify({ task, study });
    for (const forbidden of ['correctOptionId', 'expectedAnswer', 'formalScoringReview', 'criterionResults']) assert(!text.includes('"' + forbidden + '":'));
    checked.push({ id, segment: action.action.segmentIndex, condition: question.changedCondition,
      taskSha256: sha(JSON.stringify(task)), sourceArtifactSha256: sha(fs.readFileSync(file)) });
  }
}
assert(checked.length >= 2, 'Need actual recorded changed-condition interactions');
const task = learnerTask({ prompt: 'VISIBLE_TASK', changedCondition: 'VISIBLE_CONDITION', guidance: 'VISIBLE_GUIDANCE',
  options: [{ id: 'A', text: 'CHOICE', correct: true }], correctOptionId: 'PRIVATE_KEY' });
for (const label of ['VISIBLE_TASK', 'VISIBLE_CONDITION', 'VISIBLE_GUIDANCE']) assert(task.prompt.includes(label));
assert(!JSON.stringify(task).includes('PRIVATE_KEY'));
assert.deepEqual(task.options, [{ id: 'A', text: 'CHOICE' }]);
const study = studyView({ progress: { currentSegmentIndex: 0 }, lesson: { segments: [{ explanation: 'VISIBLE_EXPLANATION',
  workedProcess: { steps: [], interaction: { hint: 'VISIBLE_HINT', activity: { prompt: 'PREVIOUS', options: [],
    feedback: 'VISIBLE_FEEDBACK', debrief: 'VISIBLE_DEBRIEF', expectedAnswer: 'PRIVATE_KEY' },
    transfer: { changedCondition: 'VISIBLE_CHANGE', prompt: 'CURRENT', options: [] } } } }, { explanation: 'FUTURE_SEGMENT' }] },
  practice: { recovery: { feedback: 'REPAIR_FEEDBACK', teaching: { explanation: 'REPAIR_EXPLANATION' } } } });
const text = JSON.stringify(study);
for (const visible of ['VISIBLE_HINT', 'VISIBLE_FEEDBACK', 'VISIBLE_DEBRIEF', 'VISIBLE_CHANGE', 'REPAIR_EXPLANATION']) assert(text.includes(visible));
for (const hidden of ['PRIVATE_KEY', 'FUTURE_SEGMENT']) assert(!text.includes(hidden));
write(path.join(ROOT, 'checks/projection.json'), { checkedAt: new Date().toISOString(), passed: true,
  recordedDevelopmentRun: path.resolve(recorded), restoredTransfers: checked.length, checked,
  privateAndFutureFieldsExcluded: true, visibleGuidanceFeedbackAndChangedConditionsIncluded: true });
console.log(JSON.stringify({ passed: true, recordedTransfers: checked.length }));
