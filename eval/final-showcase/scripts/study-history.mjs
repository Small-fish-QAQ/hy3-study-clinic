import fs from 'node:fs';
import path from 'node:path';
import { ROOT, read, write, sha } from './common.mjs';
if (fs.existsSync(path.join(ROOT, 'FREEZE.json'))) throw Error('Historical design review must precede scoring');
const research = path.dirname(ROOT), runs = [], tallies = {}, inputs = {};
for (let i = 1; i <= 10; i++) {
  const name = 'championship-development-' + String(i).padStart(2, '0');
  const p = path.join(research, 'product-championship-2026-09-13/analysis', name, 'results.json');
  if (!fs.existsSync(p)) { runs.push({ name, completeAnalysisAvailable: false }); continue; }
  const r = read(p);
  inputs[path.relative(research, p).replaceAll('\\', '/')] = sha(fs.readFileSync(p));
  runs.push({ name, completeAnalysisAvailable: true, totals: r.totals });
  for (const row of r.matrix) {
    const t = tallies[row.id] ||= { id: row.id, title: row.title, runs: 0, teaching: 0, admission: 0, responsiveEvidence: 0 };
    t.runs++; t.teaching += +row.teachingComplete; t.admission += +row.admitted; t.responsiveEvidence += +row.responsiveEvidence;
  }
}
const reviewed = ['F02', 'F04', 'F06', 'F08', 'F09', 'F11', 'E03'];
const content = read(path.join(research, 'product-championship-2026-09-13/analysis/championship-development-10/manual-audit.json'));
const materialReview = reviewed.map(id => {
  const p = path.join(research, 'final-evaluation-2026-09-12/benchmark/product-inputs', id + '.json'), s = read(p);
  return { id, title: s.title, characters: s.text.length, goals: s.goals, fileSha256: sha(fs.readFileSync(p)), lastRunContentAudit: content[id] };
});
write(path.join(ROOT, 'dataset/historical-design-review.json'), { reviewedAt: new Date().toISOString(),
  purpose: 'Reviewer-facing product demonstration quality under intended normal-use conditions; identify a source distribution before authoring/freeze, not select showcase successes after scoring.',
  scope: 'Seven available complete aggregate analyses from ten historical development attempts; missing analyses are disclosed and no outcomes are reconstructed or pooled into a product score.',
  runs, courseStability: Object.values(tallies), materialReview, inputHashes: inputs,
  conclusions: [
    'F02/F06/F08/F09 and basic F09 reached teaching/admission/responsive evidence in all seven complete historical analyses. F04 did so in six; all seven had teaching.',
    'F02/F04/F06/F08 successful actual Formal responses in run 10 were reviewed as substantively sound. F09 had an incorrect added assertion despite delivery success; it informs material structure, not semantic certification.',
    'E03 has useful complete explanations but only 3/7 admissions; it is not a stability leader. Its last successful task illustrates elementary explanation/application, not strong transfer.',
    'The strongest original Chinese notes are roughly 768-816 characters, with three goals, explicit assumptions, definitions, worked calculations and interpretation. Showcase notes use comparable density with room for complete examples.',
    'Candidate 23 improves representation-safe comparisons, actual visibility context, semantic-equivalence review and bounded support classification while retaining deterministic evidence authority. No course-specific code or special learner treatment is used.',
  ] });
console.log(JSON.stringify({ completeHistoricalAnalyses: runs.filter(r => r.completeAnalysisAvailable).length, materialReviews: materialReview.length }));
