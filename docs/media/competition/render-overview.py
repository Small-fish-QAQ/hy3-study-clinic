"""Render the competition presentation from saved evidence; never invokes a model."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--dependency-dir', type=Path, help='Optional existing Matplotlib installation')
args = parser.parse_args()
if args.dependency_dir:
    sys.path.insert(0, str(args.dependency_dir))

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

directory = Path(__file__).resolve().parent
repo = directory.parents[2]
sources = {
    'fresh': 'eval/studyeval-validation/analysis/fresh-metrics.json',
    'human': 'eval/studyeval-validation/analysis/human-alignment.json',
    'product': 'eval/final-showcase/analysis/scored-01/results.json',
    'content': 'eval/final-showcase/analysis/scored-01/content-audit.json',
}
data = {key: json.loads((repo / name).read_text(encoding='utf-8')) for key, name in sources.items()}
fresh, human, product, content = (data[key] for key in ['fresh', 'human', 'product', 'content'])
selected = [row['id'] for row in content['rows'] if row['completeJourney'] and row['credited']
            and row['taskSound'] is True and row['answerSound'] is True]
assert len(selected) == 12
assert fresh['discrimination']['exact']['n'] == 70
assert fresh['discrimination']['exact']['d'] == 72
assert human['primaryFirstPassConsensus']['exact']['n'] == 22
assert human['primaryFirstPassConsensus']['exact']['d'] == 24
assert fresh['discrimination']['pairOutcomes'].get('inversion', 0) == 0
assert fresh['adversarial']['zero']['n'] == fresh['adversarial']['zero']['d'] == 18
assert fresh['boundaries']['exact']['n'] == fresh['boundaries']['exact']['d'] == 12
assert fresh['repeat']['exact']['n'] == fresh['repeat']['exact']['d'] == 12
assert product['funnel']['teachingComplete'] == 17 and product['funnel']['completeJourney'] == 15
assert len(product['controls']) == 30 and not any(row['credited'] for row in product['controls'])

IVORY, PINE, SAGE, INK, MUTED, RULE = '#F7F5EE', '#173F35', '#6F8874', '#23382F', '#56665B', '#D9DFD3'
plt.rcParams.update({'font.family': 'DejaVu Sans', 'svg.fonttype': 'none', 'pdf.fonttype': 42})
fig = plt.figure(figsize=(12, 8.5), dpi=160, facecolor=IVORY)
ax = fig.add_axes((0, 0, 1, 1))
ax.set(xlim=(0, 1), ylim=(0, 1))
ax.axis('off')
artists = []


def text(x, y, value, size=12, color=INK, weight='normal'):
    artist = ax.text(x, y, value, fontsize=size, color=color, weight=weight,
                     va='top', linespacing=1.15, transform=ax.transAxes)
    artists.append(artist)


def rule(y):
    ax.plot([.05, .95], [y, y], color=RULE, linewidth=.8)


text(.05, .963, 'STUDY CLINIC / TASK 1', 10, PINE, 'bold')
text(.735, .963, 'FROZEN EVIDENCE · 14 SEP 2026', 9, MUTED)
text(.05, .915, 'From your materials to learning evidence', 27, PINE, 'bold')
text(.05, .846, 'Materials → Teaching → Practice → Repair → Formal → Evidence → Review', 12, MUTED)
rule(.802)
text(.05, .777, 'FORMAL TASK 1 EVALUATION', 11, PINE, 'bold')
text(.655, .777, 'StudyEval v2.0 · Six operational dimensions', 10, MUTED)

text(.05, .724, f"{100 * fresh['discrimination']['exact']['rate']:.2f}%", 40, PINE, 'bold')
text(.385, .724, f"{100 * human['primaryFirstPassConsensus']['exact']['rate']:.2f}%", 40, PINE, 'bold')
text(.725, .710, f"κ {human['primaryFirstPassConsensus']['quadraticWeightedKappa']:.3f}", 31, PINE, 'bold')
text(.05, .637, 'Fresh controlled agreement', 12, INK, 'bold')
text(.385, .637, 'Human consensus agreement', 12, INK, 'bold')
text(.725, .637, 'Quadratic-weighted kappa', 11, INK, 'bold')
text(.05, .606, '70/72 first-pass reference grades', 10, MUTED)
text(.385, .606, '22/24 consensus dimension pairs', 10, MUTED)
text(.725, .606, 'Same 24 consensus pairs', 10, MUTED)

for x, number, label, detail in [
    (.05, '0 inversions', 'Discrimination', '70/72 ordered · 2 ties'),
    (.29, '18/18', 'Adversarial variants', 'Material defects retained at 0'),
    (.53, '12/12', 'Boundary expectations', 'Includes 2 warranted U'),
    (.77, '12/12', 'Repeat stability', 'Three runs per designated input'),
]:
    text(x, .545, number, 24, PINE, 'bold')
    text(x, .493, label, 11, INK, 'bold')
    text(x, .463, detail, 9.2, MUTED)
text(.05, .426, '22/24 strict good > mid > bad triplets · 0 INVALID across 126 fresh and 81 human observations', 10, MUTED)

ax.add_patch(FancyBboxPatch((.05, .249), .9, .133, boxstyle='round,pad=0.012,rounding_size=0.012',
                           facecolor=PINE, edgecolor='none'))
text(.07, .365, str(len(selected)), 45, IVORY, 'bold')
text(.198, .362, 'PRODUCT SHOWCASE', 10, '#BDCEBC', 'bold')
text(.198, .331, 'Content-audited end-to-end learning journeys', 17, IVORY, 'bold')
text(.198, .290, 'Inspectable tasks, answers and evidence across multiple domains', 10, '#D5E0D0')

text(.05, .216, 'SUPPLEMENTARY RELIABILITY AUDIT · CANDIDATE 23', 9.5, MUTED, 'bold')
text(.05, .183, 'Full frozen 20-course audit retained · All outcomes and failures', 12, INK)
text(.05, .150, 'Control, replay and persistence evidence · See the complete reliability audit →', 10, MUTED)
artists[-1].set_url('https://github.com/Small-fish-QAQ/hy3-study-clinic/tree/main/eval/final-showcase')
rule(.119)
text(.05, .095, 'Human validation uses held-out cases on known source texts.\n'
     'Complete samples, selection methods, disagreements and scope are documented with the evidence.', 9.2, MUTED)

fig.canvas.draw()
renderer = fig.canvas.get_renderer()
boxes = [(artist, artist.get_window_extent(renderer)) for artist in artists]
for artist, box in boxes:
    assert fig.bbox.contains(box.x0, box.y0) and fig.bbox.contains(box.x1, box.y1), artist.get_text()
for i, (artist, box) in enumerate(boxes):
    for other, second in boxes[i + 1:]:
        assert not box.overlaps(second), f'Text overlap: {artist.get_text()} / {other.get_text()}'
for extension in ['png', 'svg']:
    fig.savefig(directory / f'competition-overview.{extension}', facecolor=IVORY, dpi=160)
svg = directory / 'competition-overview.svg'
svg.write_text('\n'.join(line.rstrip() for line in svg.read_text(encoding='utf-8').splitlines()) + '\n', encoding='utf-8', newline='\n')
manifest = {
    'purpose': 'Post-score competition presentation; all measurements remain in their original sealed files.',
    'formalEvaluation': 'StudyEval v2.0',
    'productCommit': '84b3c2fbce7e6523e43a8fa66df42bb6e37fa149',
    'selectedJourneyIds': selected,
    'selectionRule': 'completeJourney && credited && taskSound === true && answerSound === true; post-score task-assistant review',
    'sources': {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in sources.values()},
    'assets': {f'competition-overview.{ext}': hashlib.sha256((directory / f'competition-overview.{ext}').read_bytes()).hexdigest()
               for ext in ['png', 'svg']},
    'textBoundsAndOverlaps': 'passed',
}
(directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'rendered': list(manifest['assets']), 'selectedJourneyIds': selected, 'textChecks': 'passed'}))
