import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^\uFEFF/, ''));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const origin = read('ORIGIN.json');
for (const [p, entry] of Object.entries(origin.files)) assert.equal(hash(fs.readFileSync(path.join(root, p))), entry.sha256, p);
const freeze = read('FREEZE.json');
assert.equal(hash(fs.readFileSync(path.join(root, 'FREEZE.json'))), read('FREEZE-RECEIPT.json').sha256);
for (const [p, expected] of Object.entries(freeze.files)) assert.equal(hash(fs.readFileSync(path.join(root, p))), expected, p);
assert.equal(freeze.denominator, 20);
const schedule = read('dataset/schedule.json');
const result = read('analysis/scored-01/results.json');
const audit = read('analysis/scored-01/runtime-audit.json');
const content = read('analysis/scored-01/content-audit.json');
assert.equal(result.n, 20); assert.equal(result.completed, 20); assert.equal(result.partial, false);
assert.deepEqual(schedule.map(s => s.sourceId), freeze.scheduledSources);
const logical = fs.readFileSync(path.join(root, 'runs/scored-01/logical.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const supported = snapshot => snapshot.rows.assessment_evidence_records.filter(e => e.conclusion === 'supported' && snapshot.rows.assessment_progression_reconciliations.some(r => r.evidence_record_id === e.id && r.status === 'applied'));
const observed = [], controls = [];
let replayCount = 0, ordinaryCount = 0;
for (const row of schedule) {
  const id = row.sourceId, prefix = 'runs/scored-01/cases/' + id + '/';
  const source = read(row.path), state = read(prefix + 'state.json'), snap = read(prefix + 'final.snapshot.json');
  assert.equal(hash(source.text), source.textHash);
  assert.deepEqual(read(prefix + 'source.json'), source);
  const files = fs.readdirSync(path.join(root, prefix));
  const flags = { id, imported: snap.rows.material_revisions.length > 0, prepared: !!snap.overview.acceptedStudyPlan,
    lessonReady: state.teaching.some(t => t.preparationAttempts?.some(a => a.status === 'ready')),
    teachingComplete: state.teaching.some(t => t.status === 'completed'),
    allTeachingComplete: state.teaching.length > 0 && state.teaching.every(t => t.status === 'completed'),
    formalAttempted: state.formal.length > 0,
    candidateReturned: logical.some(x => x.caseId === id && x.operation === 'proposeAssessment' && x.event === 'completed'),
    admitted: files.some(p => /^formal-\d+-before\.json$/.test(p)), submitted: state.formal.some(f => !!f.result),
    supportedEvidence: snap.rows.assessment_evidence_records.some(e => e.conclusion === 'supported'), durableCredit: supported(snap).length > 0,
    demonstrated: state.formal.some(f => f.result?.result?.demonstrated), responsiveEvidence: false };
  flags.completeJourney = flags.prepared && flags.allTeachingComplete && flags.demonstrated && flags.durableCredit;
  const saved = result.rows.find(r => r.id === id);
  for (const [key, value] of Object.entries(flags)) assert.equal(saved[key], value, id + ':' + key);
  for (const p of files.filter(p => /^after-teaching-\d+\.snapshot\.json$/.test(p))) { assert.equal(read(prefix + p).rows.assessment_evidence_records.length, 0); ordinaryCount++; }
  for (const record of state.formal) {
    if (record.result) {
      assert.equal(record.replay.identicalResult, true); assert.equal(record.replay.newPhysicalCalls, 0); assert.equal(record.replay.changedTables.length, 0);
      replayCount++;
    }
    for (const branch of record.controls || []) {
      const snap = read('runs/scored-01/cases/' + branch.caseId + '/after-control.snapshot.json');
      const control = { id, kind: branch.name, caseId: branch.caseId, submitted: !!branch.result, credited: supported(snap).length };
      controls.push(control);
    }
  }
  for (const e of supported(snap)) {
    const grade = JSON.parse(snap.rows.assessment_grade_records.find(g => g.id === e.grade_record_id).payload);
    const version = JSON.parse(snap.rows.assessment_versions.find(v => v.id === e.assessment_version_id).payload);
    const criteria = version.items.find(q => q.id === e.item_id).rubric.filter(c => c.required);
    assert(criteria.length > 0 && criteria.every(c => grade.judgment.criterionResults.some(r => r.criterionId === c.id && r.result === 'met')));
  }
  observed.push(flags);
}
for (const key of Object.keys(result.funnel)) assert.equal(observed.filter(r => r[key]).length, result.funnel[key], key);
assert.deepEqual(controls, result.controls);
assert.equal(audit.ordinary.length, ordinaryCount); assert.equal(audit.replays.length, replayCount);
assert.equal(content.rows.length, 20);
const summary = { passed: true, preservedFiles: Object.keys(origin.files).length, courses: observed.length, funnel: result.funnel,
  contentAudit: { creditedAnswerReviews: content.rows.filter(r => r.credited).length, noMaterialDefectCompleteJourneys: content.rows.filter(r => r.completeJourney && r.credited && r.taskSound === true && r.answerSound === true).length },
  controls: { reached: controls.length, submitted: controls.filter(c => c.submitted).length, credited: controls.filter(c => c.credited > 0).length },
  replayReceipts: replayCount, informalSnapshotsWithZeroEvidence: ordinaryCount,
  recordedRuntimeAuditPassed: audit.passed,
  limits: 'Offline verification checks saved bytes, state transitions and aggregate counts. Cold SQLite and source-review binding checks were performed on the original runtime; use the release archive and frozen analyzer to repeat them. Semantic review is the task assistant assessment, not independent human certification.' };
console.log(JSON.stringify(summary, null, 2));
