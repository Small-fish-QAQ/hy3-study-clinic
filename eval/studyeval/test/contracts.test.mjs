import test from 'node:test';
import assert from 'node:assert/strict';
import { project, evaluate } from '../evaluator.mjs';
import {
  validateAudit,
  validateContext,
  validateResolution,
  normalizeReferences,
  atPointer,
  semanticFingerprint,
} from '../contracts.mjs';
const view = {
  sources: [{ text: 'A rule applies under its stated assumptions.' }],
  artifacts: [{ text: 'The rule is explained correctly; its source title is misstated.' }],
  question: { prompt: 'Explain whether the rule applies.' },
  priorExposure: [],
};
const local = {
  dimension: 'Q1',
  level: 1,
  evidence: 'sufficient',
  reason: 'Peripheral attribution does not change the rule.',
  refs: ['/artifacts/0/text', '/sources/0/text'],
  defects: [
    {
      severity: 'local',
      description: 'Incorrect source title.',
      impact: 'The explanation and its application are unchanged.',
      refs: ['/artifacts/0/text'],
    },
  ],
  missing: [],
};
test('local defects remain numeric even when support and defect cite the same field', () => {
  const result = validateAudit(view, ['Q1'], { dimensions: [local] });
  assert.equal(result.dimensions[0].level, 1);
  assert.equal(result.dimensions[0].certification.semanticTruthCertified, false);
});
test('score and explicit key validity cannot contradict each other', () => {
  const bad = {
    ...local,
    dimension: 'Q4',
    level: 2,
    defects: [],
    assessment: {
      key: 'incorrect',
      validity: 'valid',
      exposure: 'none',
      discrimination: 'adequate',
      reason: 'The author key contradicts the source.',
      refs: ['/question/prompt', '/artifacts'],
    },
  };
  assert.throws(() => validateAudit(view, ['Q4'], { dimensions: [bad] }), /Ordinal\/assessment/);
});
test('unavailable evidence and a visible local defect are different states', () => {
  assert.throws(
    () => validateAudit(view, ['Q1'], { dimensions: [{ ...local, level: 'U' }] }),
    /Ordinal/,
  );
  const missing = {
    ...local,
    level: 'U',
    evidence: 'missing',
    defects: [],
    missing: ['The claim depends on an omitted experiment result.'],
  };
  assert.equal(validateAudit(view, ['Q1'], { dimensions: [missing] }).dimensions[0].level, 'U');
});
test('structured missing-evidence explanations normalize without losing information or forcing a score', () => {
  const entry = {
    evidence: 'The withheld original observation.',
    why: 'It could confirm or refute the claim.',
  };
  const raw = {
    dimensions: [{ ...local, level: 'U', evidence: 'missing', defects: [], missing: [entry] }],
  };
  const normalized = normalizeReferences(view, raw);
  assert.deepEqual(JSON.parse(normalized.output.dimensions[0].missing[0]), entry);
  assert.equal(semanticFingerprint(raw), semanticFingerprint(normalized.output));
  assert.equal(validateAudit(view, ['Q1'], normalized.output).dimensions[0].level, 'U');
  const changed = structuredClone(raw);
  changed.dimensions[0].missing[0].why = 'A different reason.';
  assert.notEqual(semanticFingerprint(raw), semanticFingerprint(changed));
  assert.equal(normalized.repairs[0].kind, 'lossless_structured_missing');
});
test('paths cannot access prototypes or invent supporting fields', () => {
  assert.equal(atPointer(view, ''), view);
  for (const p of ['/sources/9/text', '/__proto__/x', '/constructor', '/missing'])
    assert.throws(() => atPointer(view, p));
});
test('a missing-field witness binds to a real parent and cannot claim that a visible empty field is absent', () => {
  const raw = {
    dimensions: [
      {
        ...local,
        level: 'U',
        evidence: 'missing',
        defects: [],
        missing: ['Original observations are not provided.'],
      },
    ],
    evidenceChecks: [
      {
        id: 'observation-gap',
        decision: 'unavailable',
        evidence: { ref: '/observations', quote: null },
        reason: 'The requested factual comparison requires the missing original observations.',
      },
    ],
  };
  const uncertainties = [
    { id: 'observation-gap', dimension: 'Q1', missing: ['Original observations.'] },
  ];
  const normalized = normalizeReferences(view, raw);
  assert.deepEqual(normalized.output.evidenceChecks[0].evidence, {
    ref: '',
    quote: null,
    missingKey: 'observations',
  });
  assert.equal(semanticFingerprint(raw), semanticFingerprint(normalized.output));
  assert.equal(
    validateResolution(view, ['Q1'], normalized.output, [], uncertainties).dimensions[0].level,
    'U',
  );
  assert.throws(
    () =>
      validateResolution(
        { ...view, observations: '' },
        ['Q1'],
        normalized.output,
        [],
        uncertainties,
      ),
    /actually absent/,
  );
  const nonexistentParent = structuredClone(raw);
  nonexistentParent.evidenceChecks[0].evidence.ref = '/unprovided/observations';
  const unchanged = normalizeReferences(view, nonexistentParent);
  assert.equal(unchanged.output.evidenceChecks[0].evidence.ref, '/unprovided/observations');
  assert.throws(
    () => validateResolution(view, ['Q1'], unchanged.output, [], uncertainties),
    /Evidence path does not exist/,
  );
});
test('scenario preparation must retain verbatim original prior facts', () => {
  const context = { priorExposure: [{ text: 'The object is wooden. The answer is choice C.' }] };
  assert.doesNotThrow(() =>
    validateContext(context, {
      premises: [{ ref: '/priorExposure/0/text', quote: 'The object is wooden.' }],
      missing: [],
      reason: 'Explicit scenario fact.',
    }),
  );
  assert.throws(
    () =>
      validateContext(context, {
        premises: [{ ref: '/priorExposure/0/text', quote: 'The object is metal.' }],
        missing: [],
        reason: 'Invented.',
      }),
    /quote not found/,
  );
});
test('model projection excludes benchmark identity, labels and prior predictions', () => {
  const r = {
    id: 'test-private-identity',
    dimensions: ['Q1'],
    expected: { Q1: 2 },
    humanLabel: 0,
    previousScore: 1,
    evidence: {
      sources: [{ id: 's', text: 'source' }],
      artifacts: [{ id: 'a', text: 'artifact' }],
    },
  };
  const p = JSON.stringify(project(r));
  for (const forbidden of ['test-private-identity', 'expected', 'humanLabel', 'previousScore'])
    assert.equal(p.includes(forbidden), false);
});
test('format repair fingerprint binds semantic decisions but permits reference repairs', () => {
  const raw = { dimensions: [local] },
    refs = { dimensions: [{ ...local, refs: ['/artifacts'] }] },
    changed = { dimensions: [{ ...local, level: 0 }] };
  assert.equal(semanticFingerprint(raw), semanticFingerprint(refs));
  assert.notEqual(semanticFingerprint(raw), semanticFingerprint(changed));
});
test('a claimed correct grade cannot contradict its own required-criterion analysis', () => {
  const v = {
    ...view,
    answer: 'The condition does not hold.',
    rubric: [{ id: 'required', text: 'Establish the necessary condition.', required: true }],
    productJudgment: { criteria: [{ id: 'required', result: 'met' }], consequence: 'granted' },
  };
  const row = {
    ...local,
    dimension: 'Q5',
    level: 2,
    defects: [],
    refs: ['/answer', '/productJudgment'],
    grading: {
      criteria: [
        {
          id: 'required',
          result: 'not_met',
          reason: 'Necessary condition not established.',
          refs: ['/answer', '/rubric/0'],
        },
      ],
      actualCredit: 'granted',
      warrantedCredit: 'withheld',
    },
  };
  assert.throws(() => validateAudit(v, ['Q5'], { dimensions: [row] }), /Ordinal\/grading/);
  // A false echo of the observed credit must not hide an actual credit error.
  v.productJudgment.criteria[0].result = 'not_met';
  row.grading.actualCredit = 'withheld';
  assert.throws(() => validateAudit(v, ['Q5'], { dimensions: [row] }), /Ordinal\/grading/);
  row.level = 0;
  row.defects = [
    {
      ...local.defects[0],
      severity: 'material',
      description: 'Unwarranted credit.',
      impact: 'Credit was actually granted for an insufficient response.',
    },
  ];
  const certified = validateAudit(v, ['Q5'], { dimensions: [row] }).dimensions[0];
  assert.equal(certified.grading.actualCredit, 'granted');
  assert.equal(certified.grading.actualCreditWitness.pointer, '/productJudgment/consequence');
});
test('defect adjudication cannot fabricate a quotation that supports a penalty', () => {
  const raw = {
    dimensions: [local],
    challenges: [
      {
        id: 'review1:Q1:1',
        decision: 'upheld',
        severity: 'local',
        evidence: { ref: '/artifacts/0/text', quote: 'An invented sentence.' },
        reason: 'Claimed support.',
      },
    ],
  };
  assert.throws(
    () => validateResolution(view, ['Q1'], raw, [{ id: 'review1:Q1:1' }]),
    /quote must match/,
  );
});
test('an absent empty verification list is a no-op, but actual defect obligations remain mandatory', () => {
  const raw = { dimensions: [{ ...local, level: 2, defects: [] }] };
  assert.equal(validateResolution(view, ['Q1'], raw, []).dimensions[0].level, 2);
  assert.throws(
    () => validateResolution(view, ['Q1'], raw, [{ id: 'required-check' }]),
    /Every proposed defect/,
  );
});
test('rejecting a defect cannot certify a positive score while decisive evidence remains unavailable', () => {
  const v = { ...view, authorityBoundaries: ['The original observations are unavailable.'] };
  const uncertainties = [{ id: 'gap', dimension: 'Q1', missing: ['Original observations.'] }];
  const raw = {
    dimensions: [{ ...local, level: 2, defects: [] }],
    evidenceChecks: [
      {
        id: 'gap',
        decision: 'unavailable',
        evidence: { ref: '/authorityBoundaries/0', quote: 'original observations are unavailable' },
        reason: 'The requested factual comparison requires these observations.',
      },
    ],
  };
  assert.throws(
    () => validateResolution(v, ['Q1'], raw, [], uncertainties),
    /Ordinal\/evidence gap/,
  );
  raw.dimensions[0] = {
    ...raw.dimensions[0],
    level: 'U',
    evidence: 'missing',
    missing: ['Original observations.'],
  };
  assert.equal(validateResolution(v, ['Q1'], raw, [], uncertainties).dimensions[0].level, 'U');
  assert.throws(
    () => validateResolution(v, ['Q1'], { dimensions: raw.dimensions }, [], uncertainties),
    /Every proposed evidence gap/,
  );
  raw.evidenceChecks[0].evidence.quote = 'The observations are included.';
  assert.throws(() => validateResolution(v, ['Q1'], raw, [], uncertainties), /quote must match/);
});
test('a blank submission is quotable evidence, but an empty quote cannot support nonempty text', () => {
  const raw = {
    dimensions: [local],
    challenges: [
      {
        id: 'blank-check',
        decision: 'upheld',
        severity: 'local',
        evidence: { ref: '/answer', quote: '' },
        reason: 'The visible submission contains no text.',
      },
    ],
  };
  const proposals = [{ id: 'blank-check', dimension: 'Q1' }];
  assert.doesNotThrow(() => validateResolution({ ...view, answer: '' }, ['Q1'], raw, proposals));
  assert.throws(
    () => validateResolution({ ...view, answer: 'A claim.' }, ['Q1'], raw, proposals),
    /quote must match/,
  );
  assert.throws(
    () => validateResolution({ ...view, answer: ' ' }, ['Q1'], raw, proposals),
    /quote must match/,
  );
  raw.challenges[0].evidence.quote = ' ';
  assert.doesNotThrow(() => validateResolution({ ...view, answer: ' ' }, ['Q1'], raw, proposals));
});
test('blind student analysis receives the student answer but never product grading or feedback', async () => {
  const record = {
    dimensions: ['Q5'],
    evidence: {
      sources: [{ id: 's', text: 'Under the rule, equality is required.' }],
      question: { prompt: 'State the requirement.', options: [] },
      answer: 'Equality is required.',
      rubric: [{ id: 'r', text: 'State equality.', required: true }],
      artifacts: [{ id: 'feedback', text: 'You met the requirement.' }],
      productJudgment: {
        criteria: [{ id: 'r', result: 'met' }],
        feedback: 'You met the requirement.',
        consequence: 'granted',
      },
    },
  };
  let checked = false;
  const criterion = {
    id: 'r',
    result: 'met',
    reason: 'States equality.',
    refs: ['/answer', '/rubric/0'],
  };
  await evaluate(record, {
    stage: async (name, input, prompt, validate) => {
      if (name === 'blind-solution') {
        assert.equal(Object.hasOwn(input.view, 'answer'), false);
        return validate({
          status: 'resolved',
          solution: 'Equality is required.',
          refs: ['/question/prompt'],
        });
      }
      if (name === 'blind-student') {
        checked = true;
        assert.equal(input.view.answer, record.evidence.answer);
        assert.equal(Object.hasOwn(input.view, 'productJudgment'), false);
        assert.equal(Object.hasOwn(input.view, 'artifacts'), false);
        return validate({ criteria: [criterion], warrantedCredit: 'granted' });
      }
      return validate({
        dimensions: [
          {
            dimension: 'Q5',
            level: 2,
            evidence: 'sufficient',
            reason: 'The grade agrees with the answer.',
            refs: ['/answer', '/productJudgment'],
            defects: [],
            missing: [],
            grading: { criteria: [criterion], actualCredit: 'granted', warrantedCredit: 'granted' },
          },
        ],
      });
    },
  });
  assert.equal(checked, true);
});
test('reference normalization preserves semantics, records rejected external pointers and cannot invent evidence', () => {
  const raw = {
    dimensions: [
      { ...local, refs: ['/view/artifacts/0/text', '/blindSolution/solution', '/rubric/Q1'] },
    ],
  };
  const normalized = normalizeReferences(view, raw);
  assert.equal(semanticFingerprint(raw), semanticFingerprint(normalized.output));
  assert.deepEqual(normalized.output.dimensions[0].refs, ['/artifacts/0/text']);
  assert.equal(normalized.repairs.length, 1);
  assert.equal(validateAudit(view, ['Q1'], normalized.output).dimensions[0].level, 1);
  const empty = normalizeReferences(view, { dimensions: [{ ...local, refs: ['/imagined'] }] });
  assert.throws(() => validateAudit(view, ['Q1'], empty.output), /evidence paths/);
});
test('a unit-container quotation binds to its exact original text without changing the claim', () => {
  const v = { priorExposure: [{ id: 'prior', text: 'The condition is absent.' }] };
  const raw = { evidence: { ref: '/priorExposure/0', quote: 'condition is absent' } };
  const normalized = normalizeReferences(v, raw);
  assert.equal(normalized.output.evidence.ref, '/priorExposure/0/text');
  assert.equal(semanticFingerprint(raw), semanticFingerprint(normalized.output));
  const invented = normalizeReferences(v, {
    evidence: { ref: '/priorExposure/0', quote: 'condition is present' },
  });
  assert.equal(invented.output.evidence.ref, '/priorExposure/0');
});
test('independent factual and explanatory uses can retain different dimension scores', async () => {
  const record = {
    dimensions: ['Q1', 'Q3'],
    evidence: {
      sources: [{ id: 'observation', text: 'The recorded measurement is 10.' }],
      artifacts: [
        { id: 'report', text: 'The recorded measurement is 12.' },
        {
          id: 'example',
          text: 'For four objects at three units each, multiply 4 by 3 to obtain 12 units.',
        },
      ],
      goals: [
        'Check the recorded measurement and explain the independent hypothetical calculation.',
      ],
    },
  };
  const rows = [
    {
      ...local,
      level: 0,
      reason: 'The reported measurement contradicts the observation.',
      refs: ['/artifacts/0/text', '/sources/0/text'],
      defects: [
        {
          ...local.defects[0],
          severity: 'material',
          description: 'Wrong reported measurement.',
          impact: 'The central reported value changes.',
          refs: ['/artifacts/0/text'],
        },
      ],
    },
    {
      ...local,
      dimension: 'Q3',
      level: 2,
      reason: 'The separate hypothetical calculation explains multiplication correctly.',
      refs: ['/artifacts/1/text'],
      defects: [],
    },
  ];
  const result = await evaluate(record, {
    stage: async (name, input, prompt, validate) => {
      return validate({
        dimensions: rows,
        ...(input.defectProposals
          ? {
              challenges: input.defectProposals.map((p) => ({
                id: p.id,
                decision: 'upheld',
                severity: 'material',
                evidence: { ref: '/artifacts/0/text', quote: 'The recorded measurement is 12.' },
                reason:
                  'The recorded fact is wrong; the separate hypothetical calculation uses its own stated premises.',
              })),
            }
          : {}),
      });
    },
  });
  assert.deepEqual(
    result.result.dimensions.map((d) => d.level),
    [0, 2],
  );
});
