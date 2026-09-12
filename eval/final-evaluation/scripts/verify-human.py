"""Python 3 standard library only. Re-extract human scores and verify all comparisons offline."""
import csv
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
DIMENSIONS = {'事实与来源': 'Q1', '目标与范围': 'Q2', '解释是否可理解': 'Q3',
              '题目与独立作答': 'Q4', '评分是否合理': 'Q5', '诊断与补救': 'Q6'}

def read(name):
    return json.loads((ROOT / name).read_text(encoding='utf-8-sig'))

def sha(name):
    return hashlib.sha256((ROOT / name).read_bytes()).hexdigest()

def csv_rows(name):
    with (ROOT / name).open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))

def severity(pairs):
    categories, transitions, numeric = Counter(), Counter(), []
    for left, right in pairs:
        transitions[f'{left} -> {right}'] += 1
        if 'ABSTAIN' in (left, right):
            categories['abstention'] += 1
        elif 'MISSING' in (left, right):
            categories['missing'] += 1
        elif 'U' in (left, right):
            categories['uncertain'] += 1
        elif 'INVALID' in (left, right):
            categories['invalid'] += 1
        else:
            assert left in ('0', '1', '2') and right in ('0', '1', '2')
            a, b = int(left), int(right)
            numeric.append((a, b))
            categories[('exact', 'adjacent', 'polarity')[abs(a - b)]] += 1
    return dict(n=len(pairs), **{k: categories[k] for k in
                ('exact', 'adjacent', 'polarity', 'uncertain', 'abstention', 'missing', 'invalid')},
                bothNumeric=len(numeric), leftHigher=sum(a > b for a, b in numeric),
                leftLower=sum(a < b for a, b in numeric), transitions=dict(sorted(transitions.items())))

def main():
    # Manifest is an integrity receipt, not an independent truth standard.
    for entry in read('MANIFEST.json')['files']:
        f = ROOT / entry['path']
        assert ROOT in f.resolve().parents
        assert f.stat().st_size == entry['bytes'] and sha(entry['path']) == entry['sha256'], entry['path']
    normalized = read('human/normalized.json')
    summary = read('human/comparisons.json')
    assert sha('human/normalized.json') == summary['normalizedSha256']
    packet_map = read('human/packet-map.json')
    for packet in packet_map['packets']:
        assert sha(packet['file']) == packet['sha256']
    mapping = {item['itemId']: item for item in packet_map['items']}
    expected = {p: [(r['itemId'], d) for r in packet_map['items'] if r['packet'] == p
                    for d in r['dimensions']] for p in (1, 2, 3)}
    reconstructed = []
    observed_sheets = []
    for entry in read('human/original-hashes.json')['sheets']:
        assert sha(entry['reviewCopy']) == entry['reviewCopySha256']
        match = re.fullmatch(r'Human-([ABC])-Packet-([123])-答题表.docx', entry['originalFile'])
        assert match
        annotator, packet = match.group(1), int(match.group(2))
        observed_sheets.append((annotator, packet))
        with ZipFile(ROOT / entry['reviewCopy']) as package:
            xml = package.read('word/document.xml')
            assert hashlib.sha256(xml).hexdigest() == entry['documentXmlSha256']
            body = ET.fromstring(xml).find('w:body', NS)
            paragraphs = [''.join(t.text or '' for t in p.findall('.//w:t', NS))
                          for p in body.findall('w:p', NS)]
            tables = body.findall('w:tbl', NS)
            assert len(tables) == 1
            table_rows = tables[0].findall('w:tr', NS)
            assert len(table_rows) == len(expected[packet]) + 1
            sheet = next(s for s in normalized['sheets'] if s['sourceFile'] == entry['originalFile'])
            assert f'标注者代号：{annotator}' in paragraphs[1]
            timing = re.search(r'开始时间：(.*?)\s+结束时间：(.*)', paragraphs[1])
            assert timing
            def optional(value):
                return None if not value.strip().strip('_').strip() else value.strip()
            assert sheet['startTime'] == optional(timing.group(1))
            assert sheet['endTime'] == optional(timing.group(2))
            assert sheet['procedureOrExternalHelpNote'] == optional('\n'.join(paragraphs[4:]))
            keys = []
            for index, row in enumerate(table_rows[1:], start=1):
                cells = ['\n'.join(''.join(t.text or '' for t in p.findall('.//w:t', NS))
                                   for p in cell.findall('w:p', NS)) for cell in row.findall('w:tc', NS)]
                assert len(cells) == 4
                item, dimension, raw_score, reason = cells
                key = (item.strip(), DIMENSIONS[dimension.strip()])
                keys.append(key)
                answer = {'跳过': 'ABSTAIN', '': 'MISSING'}.get(raw_score.strip(), raw_score.strip())
                reconstructed.append(dict(annotator=annotator, packet=packet, itemId=key[0], dimension=key[1],
                    answer=answer, rawAnswer=raw_score, reason=reason, sourceFile=entry['originalFile'],
                    sourceSha256=entry['originalSha256'], tableIndex=0, rowIndex=index,
                    answerCellIndex=2, reasonCellIndex=3))
            assert keys == expected[packet]
    assert observed_sheets == [('A', 1), ('A', 2), ('B', 2), ('B', 3), ('C', 1), ('C', 3)]
    assert reconstructed == normalized['answers'], 'Score/reason changed during normalization'
    exported_csv = csv_rows('human/answers.csv')
    assert exported_csv == [{k: str(v) for k, v in r.items()} for r in reconstructed]
    assert len(reconstructed) == 68
    assert len({(r['annotator'], r['itemId'], r['dimension']) for r in reconstructed}) == 68
    source_scores = csv_rows('human/model-reviews/studyeval-frozen.csv')
    assert len(source_scores) == 74
    for row in source_scores:
        obs_name = f"results/observations/{row['final_run_id']}.json"
        observation = read(obs_name)
        assert sha(obs_name) == row['observation_sha256']
        result = next(d for d in observation['evaluation']['result']['dimensions']
                      if d['dimension'] == row['dimension'])
        assert str(result['level']) == row['studyeval_answer'] and result['reason'] == row['short_reason']
        assert observation['inputHash'] == row['input_hash'] == mapping[row['packet_item_id']]['inputHash']
        assert observation['task']['caseId'] == row['source_case_id'] == mapping[row['packet_item_id']]['frozenCaseId']
    models = {'StudyEval': {(r['packet_item_id'], r['dimension']): r['studyeval_answer']
                           for r in source_scores if r['comparison_role'] == 'PRIMARY'}}
    originals = {}
    for name in ('Max', 'Fable'):
        records = csv_rows(f'human/model-reviews/{name.lower()}.csv')
        originals[name] = {(r['item_id'], DIMENSIONS[r['dimension/question']] if name == 'Max' else r['dimension']): r
                           for r in records}
        models[name] = {k: r['answer'] for k, r in originals[name].items()}
        assert len(models[name]) == len(records) == 34
    for p in read('human/model-reviews/provenance.json'):
        assert sha(p['masterCsv']) == p['masterCsvSha256']
        for name, value in p['inputPacketHashes'].items():
            assert sha('human/packets/' + name) == value
    keys = sorted(models['StudyEval'])
    assert len(keys) == 34 and all(set(m) == set(keys) for m in models.values())
    humans = {key: sorted([r for r in reconstructed if (r['itemId'], r['dimension']) == key],
                          key=lambda r: r['annotator']) for key in keys}
    assert all(len(group) == 2 for group in humans.values())
    consensus = {key: group[0]['answer'] for key, group in humans.items()
                 if group[0]['answer'] == group[1]['answer'] and group[0]['answer'] in ('0', '1', '2')}
    assert len(consensus) == summary['consensusCount']
    assert 34 - len(consensus) == summary['nonConsensusCount']
    comparisons = {'HumanHuman': severity([(g[0]['answer'], g[1]['answer']) for g in humans.values()])}
    for name in models:
        comparisons[f'HumanConsensusVs{name}'] = severity([(value, models[name][key]) for key, value in consensus.items()])
        comparisons[f'AllHumanRatingsVs{name}'] = severity([(r['answer'], models[name][key]) for key, g in humans.items() for r in g])
    for left, right in [('StudyEval', 'Max'), ('StudyEval', 'Fable'), ('Max', 'Fable')]:
        comparisons[f'{left}Vs{right}'] = severity([(models[left][key], models[right][key]) for key in keys])
    assert comparisons == summary['comparisons']
    assert dict(Counter(r['answer'] for r in reconstructed)) == summary['humanScoreCounts']
    details = read('human/item-comparisons.json')
    for row in details:
        key = (row['itemId'], row['dimension'])
        assert row['consensus'] == consensus.get(key)
        assert row['humans'] == [{k: r[k] for k in ('annotator', 'answer', 'reason')} for r in humans[key]]
        assert row['models'] == {name: model[key] for name, model in models.items()}
        assert row['humanPairSeverity'] == severity([(humans[key][0]['answer'], humans[key][1]['answer'])])
        assert row['modelAmbiguity'] == {name: originals[name][key]['ambiguous'].lower() == 'yes' for name in originals}
        assert row['modelReasons'] == {name: {k: originals[name][key][k] for k in ('short_reason', 'alternative_if_any')} for name in originals}
    assert len(details) == 34
    for dimension, reported in summary['byDimension'].items():
        pairs = [(g[0]['answer'], g[1]['answer']) for k, g in humans.items() if k[1] == dimension]
        assert reported['n'] == len(pairs) and reported['humanHuman'] == severity(pairs)
        assert reported['consensusCount'] == sum(k[1] == dimension for k in consensus)
        for name in models:
            assert reported[f'consensusVs{name}'] == severity([(v, models[name][k]) for k, v in consensus.items() if k[1] == dimension])
    for packet in ('1', '2', '3'):
        assert summary['byPacket'][packet] == severity([(g[0]['answer'], g[1]['answer']) for k, g in humans.items() if k[0].startswith('P' + packet + '-')])
    disagreements = {key for key, g in humans.items() if g[0]['answer'] != g[1]['answer']}
    flagged = {key for key in keys if any(originals[n][key]['ambiguous'].lower() == 'yes' for n in originals)}
    a = summary['ambiguityOverlap']
    assert a['humanDisagreementDimensions'] == len(disagreements)
    assert a['modelFlaggedDimensions'] == len(flagged)
    assert a['sameDimensionKeys'] == [list(k) for k in sorted(disagreements & flagged)]
    assert a['sameDimensionOverlap'] == len(disagreements & flagged)
    assert a['sameItemIds'] == sorted({k[0] for k in disagreements} & {k[0] for k in flagged})
    assert a['sameItemOverlap'] == len(a['sameItemIds'])
    print(json.dumps(dict(status='PASS_HUMAN_SOURCE_REPRODUCTION', originalSheets=6, ratings=68,
        pairedDimensions=34, consensusDimensions=len(consensus), normalizedSha256=sha('human/normalized.json'),
        comparisons=comparisons, ambiguityOverlap=a, evaluatorExecuted=False, modelCalls=0), ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
