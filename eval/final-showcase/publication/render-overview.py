import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument('showcase')
parser.add_argument('output')
parser.add_argument('validation')
args = parser.parse_args()
root = Path(args.showcase)
data = json.loads((root / 'analysis/scored-01/results.json').read_text(encoding='utf-8'))
runtime = json.loads((root / 'analysis/scored-01/runtime-audit.json').read_text(encoding='utf-8'))
content = json.loads((root / 'analysis/scored-01/content-audit.json').read_text(encoding='utf-8'))
validation_root = Path(args.validation)
fresh = json.loads((validation_root / 'analysis/fresh-metrics.json').read_text(encoding='utf-8'))
human = json.loads((validation_root / 'analysis/human-alignment.json').read_text(encoding='utf-8'))
funnel = data['funnel']
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 11, 'svg.fonttype': 'none'})
fig = plt.figure(figsize=(15, 8.4), facecolor='white')
fig.text(.045, .94, 'Study Clinic', fontsize=27, weight='bold', color='#172523')
fig.text(.045, .887, 'Final product showcase and frozen StudyEval v2 validation', fontsize=15, color='#435351')
fig.text(.955, .942, '14 SEP 2026', ha='right', fontsize=11, color='#52615f')
fig.text(.045, .838, 'Candidate 23 / 84b3c2f', weight='bold', fontsize=12, color='#127664')
fig.text(.55, .838, 'StudyEval v2 / 64fdbc4', weight='bold', fontsize=12, color='#9b3256')
left = fig.add_axes([.24, .32, .245, .445])
labels = ['Material imported', 'Route prepared', 'Teaching completed*', 'Formal admitted', 'Durable evidence', 'Complete journey**']
keys = ['imported', 'prepared', 'allTeachingComplete', 'admitted', 'durableCredit', 'completeJourney']
values = [funnel[k] for k in keys]
left.barh(range(len(keys)), [20] * len(keys), color='#edf2ef', height=.58)
left.barh(range(len(keys)), values, color=['#73b4a4'] * 5 + ['#127664'], height=.58)
left.set_yticks(range(len(keys)), labels)
left.invert_yaxis()
left.set_xlim(0, 23)
left.set_xticks([])
left.tick_params(axis='y', length=0, pad=12)
for i, value in enumerate(values): left.text(20.4, i, f'{value}/20', va='center', weight='bold', fontsize=12)
for spine in left.spines.values(): spine.set_visible(False)
right = fig.add_axes([.765, .32, .185, .445])
metrics = [('Reference levels', fresh['discrimination']['exact']), ('Strict triplets', fresh['discrimination']['strictTriplets']),
           ('Ordered pairs', fresh['discrimination']['orderedPairs']), ('Adversarial checks', fresh['adversarial']['zero']),
           ('Exact repeat groups', fresh['repeat']['exact']), ('Human consensus', human['primaryFirstPassConsensus']['exact'])]
validation = [(label, metric['n'], metric['d']) for label, metric in metrics]
right.barh(range(len(validation)), [1] * len(validation), color='#f4eef0', height=.58)
right.barh(range(len(validation)), [a / b for _, a, b in validation], color=['#b65f7d'] * 5 + ['#9b3256'], height=.58)
right.set_yticks(range(len(validation)), [x[0] for x in validation])
right.invert_yaxis()
right.set_xlim(0, 1.23)
right.set_xticks([])
right.tick_params(axis='y', length=0, pad=12)
for i, (_, a, b) in enumerate(validation): right.text(1.025, i, f'{a}/{b}', va='center', weight='bold', fontsize=12)
for spine in right.spines.values(): spine.set_visible(False)
controls = data['controls']
count = sum(c['submitted'] for c in controls)
credited = sum(c['credited'] > 0 for c in controls)
reviewed = sum(r['completeJourney'] and r['credited'] and r['taskSound'] is True and r['answerSound'] is True for r in content['rows'])
fig.text(.045, .252, f'Answer controls: {credited}/{count} credited   |   Replay: {sum(r["passed"] for r in runtime["replays"])}/{len(runtime["replays"])} passed', fontsize=12, weight='bold', color='#172523')
fig.text(.045, .215, f'Assistant content audit: {reviewed}/20 complete journeys', fontsize=11, color='#435351')
fig.text(.045, .184, 'without an identified material task/answer defect.', fontsize=11, color='#435351')
individual = human['allOriginalRatingsVsFirst']['exact']
fig.text(.55, .252, f'All human ratings: {individual["n"]}/{individual["d"]} exact', fontsize=12, weight='bold', color='#172523')
fig.text(.55, .215, 'Case-level holdout on known sources. Same Hy3 model family.', fontsize=11, color='#435351')
fig.text(.55, .184, f'Consensus quadratic weighted kappa: {human["primaryFirstPassConsensus"]["quadraticWeightedKappa"]:.3f}', fontsize=11, color='#435351')
fig.text(.045, .144, '* All attempted teaching before the first checkpoint. ** Prepared + teaching complete + demonstrated + applied credit.', fontsize=10, color='#52615f')
fig.text(.045, .108, '20 fresh, complete teaching notes; whole set frozen before scoring. Synthetic learner; favorable intended-use distribution.', fontsize=10, color='#52615f')
fig.text(.045, .072, 'No case substitution or product tuning. Evaluator validation predates Candidate 23. Neither campaign measures human learning gains.', fontsize=10, color='#52615f')
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(output.with_suffix('.png'), dpi=180, facecolor='white')
fig.savefig(output.with_suffix('.svg'), facecolor='white')
plt.close(fig)
print(output.with_suffix('.png'))
