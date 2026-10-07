import { describe, expect, it } from 'vitest';
import {
  canonicalizeLearnerPracticeTask,
  canonicalizePracticeTaskText,
  compareLearnerPracticeTasks,
} from './practiceTaskCanonicalization.js';

const surface = (prompt: string) => ({
  prompt,
  options: [
    { id: 'A', text: 'Use the café report.' },
    { id: 'B', text: 'Do not use the old report.' },
    { id: 'C', text: 'Compare both available reports.' },
  ],
});
const reflows = [
  (text: string) => text,
  (text: string) => ` \t${text.replace(/(?<=\p{L}) (?=\p{L})/gu, '\n\t')}\r\n`,
  (text: string) => text.replace(/(?<=\p{L}) (?=\p{L})/gu, '  \r\n '),
];
const presentations = [
  (text: string) => text,
  ...['*', '**', '***', '_', '__', '___'].map(
    (marker) => (text: string) => `${marker}${text.trim()}${marker}`,
  ),
  (text: string) => `**_${text.trim()}_**`,
  (text: string) => `***__${text.trim()}__***`,
  (text: string) => `__**${text.trim()}**__`,
  (text: string) => `_**${text.trim()}**_`,
];
const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
const quotationForms = [
  (text: string) => text,
  (text: string) => `"${text}"`,
  (text: string) => `'${text}'`,
  (text: string) => `“${text}”`,
  (text: string) => `「${text}」`,
  (text: string) => `『${text}』`,
];
const unicodeProse = [
  'café report',
  'résumé review',
  'Ångström measure',
  'naïve façade',
  'Ελληνική λέξη',
  '보고서 검토',
  '结果排序',
];

describe('Practice solving-task canonicalization', () => {
  it.each([
    'Read the café report. Do not use the outdated result.',
    '先比较候选甲和候选乙，再选择满足条件的方案。',
    'Compare x + y with 2.5e-3 kg; keep Item_count unchanged.',
  ])('preserves cosmetic transformation families and their compositions: %s', (prompt) => {
    const before = surface(prompt);
    const canonical = canonicalizeLearnerPracticeTask(before);
    expect(canonical.status).toBe('comparable');
    for (const unicode of ['NFC', 'NFD'] as const)
      for (const reflow of reflows)
        for (const presentation of presentations)
          for (const order of permutations) {
            const transform = (text: string) =>
              reflow(presentation(reflow(text.normalize(unicode))));
            const after = {
              prompt: transform(before.prompt),
              options: order.map((index) => ({
                ...before.options[index]!,
                text: transform(before.options[index]!.text),
              })),
            };
            expect(canonicalizeLearnerPracticeTask(after)).toEqual(canonical);
            expect(compareLearnerPracticeTasks(before, after)).toBe('equal');
          }
  });

  it.each(unicodeProse)(
    'unifies canonical Unicode across every supported prose class and presentation composition: %s',
    (phrase) => {
      for (const quote of quotationForms) {
        const before = {
          prompt: `Read ${quote(phrase)} and select the current report.`,
          options: [
            { id: 'A', text: `Use ${phrase} for the current report.` },
            { id: 'B', text: `Do not use ${quote(phrase)} for the old report.` },
            { id: 'C', text: `Compare ${quote(phrase)} with the other report.` },
          ],
        };
        const canonical = canonicalizeLearnerPracticeTask(before);
        expect(canonical.status).toBe('comparable');
        for (const unicode of ['NFC', 'NFD'] as const)
          for (const reflow of reflows)
            for (const presentation of presentations)
              for (const order of permutations) {
                const transform = (text: string) =>
                  reflow(presentation(reflow(text.normalize(unicode))));
                const after = {
                  prompt: transform(before.prompt),
                  options: order.map((index) => ({
                    ...before.options[index]!,
                    text: transform(before.options[index]!.text),
                  })),
                };
                const actual = canonicalizeLearnerPracticeTask(after);
                expect(actual).toEqual(canonical);
                expect(canonicalizeLearnerPracticeTask(after)).toEqual(actual);
                expect(compareLearnerPracticeTasks(before, after)).toBe('equal');
                expect(compareLearnerPracticeTasks(after, before)).toBe('equal');
                if (actual.status === 'comparable')
                  for (const token of [actual.value.prompt, ...actual.value.options].flat())
                    expect(token.text).toBe(token.text.normalize('NFC'));
              }
        for (const unicode of ['NFC', 'NFD'] as const) {
          const text = before.prompt.normalize(unicode);
          const canonicalText = canonicalizePracticeTaskText(text);
          expect(canonicalText.status).toBe('comparable');
          if (canonicalText.status === 'comparable')
            expect(canonicalizePracticeTaskText(canonicalText.value)).toEqual(canonicalText);
        }
      }
    },
  );

  it('is deterministic and idempotent for comparable content', () => {
    for (const text of [
      '  **Read the café report.**\r\n',
      '***__先比较候选甲和候选乙。__***',
      'Compute (x+y)-z; compare 1.25e-3 kg and Item_count.',
      'Read “结果排序” and "café report" without changing the report.',
      'Compare x*y with x/y. Do not combine now here into nowhere.',
    ]) {
      const canonical = canonicalizePracticeTaskText(text);
      expect(canonical.status).toBe('comparable');
      expect(canonicalizePracticeTaskText(text)).toEqual(canonical);
      if (canonical.status === 'comparable')
        expect(canonicalizePracticeTaskText(canonical.value)).toEqual(canonical);
    }
  });

  it('preserves meaning-bearing mutation families', () => {
    const pairs = [
      ...[0, 1, 2.5, 60, 80].map((value) => [`Use ${value} kg.`, `Use ${value + 1} kg.`]),
      ['Select this candidate.', 'Do not select this candidate.'],
      ["Don't select this candidate.", 'Do select this candidate.'],
      ...['-', '*', '/', '<', '>', '≤', '≥', '=', '!=', '<=', '>='].map((operator) => [
        'Compare x+y.',
        `Compare x${operator}y.`,
      ]),
      ['Compute (x+y)-z.', 'Compute x-(y-z).'],
      ['Use Item_count = 1.', 'Use item_count = 1.'],
      ['Use item_count = 1.', 'Use itemcount = 1.'],
      ['Use 2 kg.', 'Use 2 g.'],
      ['Keep at least 2 candidates.', 'Keep at most 2 candidates.'],
      ['Compare (−4, 2) and (4, −2).', 'Compare (4, 2) and (4, −2).'],
      ['Use [0, 1).', 'Use (0, 1].'],
      ['Use 1.25e-3.', 'Use 1.25e+3.'],
      ['Read "café report".', 'Read "café review".'],
      ['Read "Café report".', 'Read "café report".'],
      ['Choose now here.', 'Choose nowhere.'],
    ];
    for (const [before, after] of pairs) {
      expect(compareLearnerPracticeTasks(surface(before!), surface(after!))).toBe('different');
    }
    const before = surface('Compare both reports.');
    const after = structuredClone(before);
    after.options[0]!.text = 'Use a different report.';
    expect(compareLearnerPracticeTasks(before, after)).toBe('different');
  });

  it('retains field boundaries, content order and option multiplicity while excluding private data', () => {
    const before = surface('Compare both reports.');
    expect(
      canonicalizeLearnerPracticeTask({
        ...before,
        ...{
          reasoningOperation: 'diagnose_cause',
          key: 'B',
          feedback: 'private',
          hint: 'private',
          explanation: 'private',
          application: 'private',
          retry: 'future',
        },
      }),
    ).toEqual(canonicalizeLearnerPracticeTask(before));
    expect(
      compareLearnerPracticeTasks(before, { ...before, options: before.options.slice(1) }),
    ).toBe('different');
    expect(
      compareLearnerPracticeTasks(before, {
        ...before,
        options: [...before.options, before.options[0]!],
      }),
    ).toBe('different');
    expect(
      compareLearnerPracticeTasks(before, {
        ...before,
        prompt: before.options[0]!.text,
        options: [{ id: 'A', text: before.prompt }, ...before.options.slice(1)],
      }),
    ).toBe('different');
    expect(
      compareLearnerPracticeTasks(
        surface('Choose Alpha before Beta.'),
        surface('Choose Beta before Alpha.'),
      ),
    ).toBe('different');
  });

  it('normalizes supported prose quotations while declining ambiguous exact literals', () => {
    expect(
      compareLearnerPracticeTasks(surface('Read “结果排序”.'), surface('Read 「结果排序」.')),
    ).toBe('equal');
    expect(compareLearnerPracticeTasks(surface('Read "a  b".'), surface('Read "a b".'))).toBe(
      'uncertain',
    );
    expect(compareLearnerPracticeTasks(surface('Read "result".'), surface('Read result.'))).toBe(
      'uncertain',
    );
    expect(
      compareLearnerPracticeTasks(
        surface('Read "café report".'),
        surface('Read " \tcafé\r\nreport  ".'),
      ),
    ).toBe('equal');
  });

  it.each([
    'Read "x + y".',
    'Read "Item".',
    'Read "café_count".',
    'Read "return(café)".',
    'Read "1.25e-3".',
    'Read exact string "café report".',
    'Compare Unicode characters "résumé review".',
    'Read the code "return café".',
    '使用精确字面量“结果排序”。',
    'Use Café_count = 1.',
    'Use café2 = 1.',
    'Use exact identifier résumé.',
    ...['≠', '≮', '≯', '∉', '∤'].map((operator) => `Compare x ${operator} y.`),
  ])(
    'declines normalization-sensitive or ambiguous exact atoms in either Unicode form: %s',
    (text) => {
      for (const unicode of ['NFC', 'NFD'] as const) {
        const before = surface(text.normalize(unicode));
        expect(canonicalizeLearnerPracticeTask(before)).toEqual({ status: 'uncertain' });
        expect(
          compareLearnerPracticeTasks(
            before,
            surface(text.normalize(unicode === 'NFC' ? 'NFD' : 'NFC')),
          ),
        ).toBe('uncertain');
        expect(compareLearnerPracticeTasks(before, surface('Read a different report.'))).toBe(
          'uncertain',
        );
      }
    },
  );

  it('retains ambiguous prose punctuation and declines punctuation-only change families', () => {
    const before = surface('Read the report.');
    for (const punctuation of ['!', '?', '。', '！', '？', ';', ':', ',']) {
      const after = surface(`Read the report${punctuation}`);
      expect(canonicalizeLearnerPracticeTask(after).status).toBe('comparable');
      expect(canonicalizeLearnerPracticeTask(after)).not.toEqual(
        canonicalizeLearnerPracticeTask(before),
      );
      expect(compareLearnerPracticeTasks(before, after)).toBe('uncertain');
    }
    for (const separator of ['-', '/', '+', '=', '×', '==', ':', ';']) {
      expect(
        compareLearnerPracticeTasks(
          surface(`Read Alpha${separator}Beta reports.`),
          surface('Read Alpha Beta reports.'),
        ),
      ).toBe('uncertain');
    }
  });

  it.each([
    '# Read the report.',
    '> Read the report.',
    '- Read the report.',
    '1. Read the report.',
    '[Read the report](https://example.test)',
    '<strong>Read the report.</strong>',
    'Read &quot;the report&quot;.',
    '| Report | Value |\n|---|---|',
    '`return x + y`',
    '```python\nreturn x\n```',
    '~~Read the report.~~',
    '**Read the report.',
    '*Read the report.__',
    'recog*nize*',
    'a*b*c',
    '1*2*3',
    '**x+y**',
    '_Item_count_',
    '【Read the report.】',
    '(Read the report.)',
    'Read the report?!',
    'Read "**result**".',
    'Read "unterminated.',
    'Read Alpha标签 reports.',
    'Read 标签Alpha reports.',
    '*__***_**Read the report.**_***__*',
  ])('declines ambiguous/unsupported formatting instead of proving a change: %s', (prompt) => {
    expect(canonicalizeLearnerPracticeTask(surface(prompt))).toEqual({ status: 'uncertain' });
    expect(compareLearnerPracticeTasks(surface('Read the report.'), surface(prompt))).toBe(
      'uncertain',
    );
    expect(compareLearnerPracticeTasks(surface(prompt), surface('Read a different report.'))).toBe(
      'uncertain',
    );
  });
});
