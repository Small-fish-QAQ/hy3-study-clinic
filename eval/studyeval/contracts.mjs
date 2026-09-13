import crypto from 'node:crypto';
export const sha = (x) =>
  crypto
    .createHash('sha256')
    .update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x))
    .digest('hex');
export class OutputContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutputContractError';
  }
}
const requireOutput = (c, m) => {
  if (!c) throw new OutputContractError(m);
};
export function atPointer(view, pointer) {
  requireOutput(
    typeof pointer === 'string' && (pointer === '' || pointer.startsWith('/')),
    'Evidence reference must be an absolute JSON Pointer.',
  );
  if (pointer === '') {
    requireOutput(view !== undefined, 'Evidence root is not provided.');
    return view;
  }
  let value = view;
  for (const k of pointer
    .slice(1)
    .split('/')
    .map((x) => x.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    requireOutput(
      !['__proto__', 'prototype', 'constructor'].includes(k) &&
        value !== null &&
        typeof value === 'object' &&
        Object.hasOwn(value, k),
      'Evidence path does not exist: ' + pointer,
    );
    value = value[k];
  }
  requireOutput(value !== undefined, 'Evidence field is not provided: ' + pointer);
  return value;
}
export function parseJson(text) {
  requireOutput(typeof text === 'string' && text.trim(), 'Missing text output.');
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  return JSON.parse(clean);
}
const missingText = (entry) => {
  if (!entry || Array.isArray(entry) || typeof entry !== 'object') return entry;
  const keys = Object.keys(entry).sort();
  if (
    !keys.length ||
    keys.length > 4 ||
    keys.some((k) => typeof entry[k] !== 'string' || !entry[k].trim())
  )
    return entry;
  // Preserve every key and every character; do not summarize or infer missing evidence.
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, entry[k]])));
};
// Bounded representation repair: preserve substantive content, stringify structured
// missing-evidence entries without loss, and retain paths into original evidence.
export function normalizeReferences(view, raw) {
  const output = structuredClone(raw),
    repairs = [];
  function visit(value, location) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, location + '/' + i));
      return;
    }
    if (
      value.decision === 'unavailable' &&
      value.evidence?.quote === null &&
      typeof value.evidence.ref === 'string' &&
      !Object.hasOwn(value.evidence, 'missingKey')
    ) {
      const proposed = value.evidence.ref;
      const pointer =
        proposed === '/view' ? '' : proposed.startsWith('/view/') ? proposed.slice(5) : proposed;
      const slash = pointer.lastIndexOf('/');
      if (slash >= 0 && slash < pointer.length - 1) {
        const parent = pointer.slice(0, slash);
        const missingKey = pointer
          .slice(slash + 1)
          .replaceAll('~1', '/')
          .replaceAll('~0', '~');
        try {
          const container = atPointer(view, parent);
          if (
            container !== null &&
            typeof container === 'object' &&
            !['__proto__', 'prototype', 'constructor'].includes(missingKey) &&
            !Object.hasOwn(container, missingKey)
          ) {
            value.evidence = { ...value.evidence, ref: parent, missingKey };
            repairs.push({
              location: location + '/evidence',
              proposed,
              pointer: parent,
              missingKey,
              kind: 'verified_absent_property',
            });
          }
        } catch {
          // An absent parent cannot establish which field a supplied object lacks.
        }
      }
    }
    if (
      typeof value.ref === 'string' &&
      (typeof value.quote === 'string' || value.quote === null)
    ) {
      const proposed = value.ref;
      let pointer =
        proposed === '/view' ? '' : proposed.startsWith('/view/') ? proposed.slice(5) : proposed;
      try {
        const original = atPointer(view, pointer);
        if (
          original &&
          typeof original === 'object' &&
          typeof original.text === 'string' &&
          typeof value.quote === 'string' &&
          value.quote.trim() &&
          original.text.includes(value.quote)
        )
          pointer += '/text';
        if (pointer !== proposed) {
          value.ref = pointer;
          repairs.push({ location: location + '/ref', changes: [{ proposed, pointer }] });
        }
      } catch {
        // Keep an unbound quotation invalid; never invent a supporting span.
      }
    }
    for (const [key, v] of Object.entries(value)) {
      if (key === 'missing' && Array.isArray(v)) {
        value[key] = v.map((entry, i) => {
          const represented = missingText(entry);
          if (represented !== entry)
            repairs.push({
              location: location + '/missing/' + i,
              original: entry,
              represented,
              kind: 'lossless_structured_missing',
            });
          return represented;
        });
      } else if (key === 'refs' && Array.isArray(v)) {
        const kept = [],
          changes = [];
        for (const proposed of v) {
          let pointer = proposed;
          if (typeof pointer === 'string' && pointer.startsWith('/view/'))
            pointer = pointer.slice(5);
          try {
            atPointer(view, pointer);
            if (!kept.includes(pointer)) kept.push(pointer);
            if (pointer !== proposed) changes.push({ proposed, pointer });
          } catch {
            changes.push({ proposed, rejected: 'Not an original evidence path.' });
          }
        }
        if (changes.length) {
          value[key] = kept;
          repairs.push({ location: location + '/refs', changes });
        }
      } else visit(v, location + '/' + key);
    }
  }
  visit(output, '');
  return { output, repairs };
}
export function semanticFingerprint(raw) {
  const representation = new Set([
    'refs',
    'ref',
    'quote',
    'witnesses',
    'certification',
    'referenceRepairs',
    'missingKey',
  ]);
  const visit = (x) =>
    Array.isArray(x)
      ? x.map(visit)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.entries(x)
              .filter(([k]) => !representation.has(k))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [
                k,
                visit(k === 'missing' && Array.isArray(v) ? v.map(missingText) : v),
              ]),
          )
        : x;
  return sha(visit(raw ?? null));
}

function evidenceRefs(view, refs) {
  requireOutput(
    Array.isArray(refs) && refs.length > 0 && refs.length <= 16,
    'Each judgment needs 1-16 original evidence paths.',
  );
  return [...new Set(refs)].map((pointer) => ({
    pointer,
    valueHash: sha(atPointer(view, pointer)),
  }));
}
function verifyAbsentProperty(container, evidence) {
  if (!Object.hasOwn(evidence, 'missingKey')) return;
  requireOutput(
    typeof evidence.missingKey === 'string' &&
      evidence.missingKey.length > 0 &&
      !['__proto__', 'prototype', 'constructor'].includes(evidence.missingKey) &&
      container !== null &&
      typeof container === 'object' &&
      !Object.hasOwn(container, evidence.missingKey),
    'An absence witness must name a property actually absent from its supplied container.',
  );
}
export function validateAudit(view, dimensions, raw) {
  requireOutput(raw && Array.isArray(raw.dimensions), 'dimensions array required');
  requireOutput(
    raw.dimensions.length === dimensions.length,
    'Return each requested dimension exactly once.',
  );
  return {
    dimensions: dimensions.map((d) => {
      const matches = raw.dimensions.filter((x) => x.dimension === d);
      requireOutput(matches.length === 1, 'Missing or repeated dimension ' + d);
      const row = matches[0];
      requireOutput([0, 1, 2, 'U'].includes(row.level), 'Invalid ordinal level for ' + d);
      requireOutput(
        ['sufficient', 'missing'].includes(row.evidence),
        'Invalid evidence status for ' + d,
      );
      requireOutput(
        typeof row.reason === 'string' && row.reason.trim(),
        'Reason required for ' + d,
      );
      requireOutput(
        Array.isArray(row.defects) && row.defects.length <= 3,
        'At most three decisive defects per dimension.',
      );
      requireOutput(
        Array.isArray(row.missing) &&
          row.missing.length <= 3 &&
          row.missing.every((x) => typeof x === 'string' && x.trim()),
        'missing must be a short string array.',
      );
      const witnesses = evidenceRefs(view, row.refs);
      requireOutput(
        witnesses.some((x) =>
          /^\/(artifacts|question|productJudgment|answer|tasks)(\/|$)/.test(x.pointer),
        ),
        'Judgment must cite the evaluated artifact or its visible structure.',
      );
      const defects = row.defects.map((x) => {
        requireOutput(
          ['local', 'material'].includes(x.severity) &&
            typeof x.description === 'string' &&
            x.description.trim() &&
            typeof x.impact === 'string' &&
            x.impact.trim(),
          'Defect requires severity, description and impact.',
        );
        return { ...x, witnesses: evidenceRefs(view, x.refs) };
      });
      const computed = defects.some((x) => x.severity === 'material')
        ? 0
        : row.evidence === 'missing'
          ? 'U'
          : defects.length
            ? 1
            : 2;
      requireOutput(
        row.level === computed,
        'Ordinal/severity/evidence contradiction for ' +
          d +
          '; do not change meaning during format repair.',
      );
      requireOutput(
        row.evidence === 'missing' ? row.missing.length > 0 : row.missing.length === 0,
        'Missing evidence status must match explicit missing facts.',
      );
      let assessment;
      if (d === 'Q4') {
        const a = row.assessment;
        requireOutput(
          a &&
            ['correct', 'incorrect', 'absent', 'uncertain'].includes(a.key) &&
            ['valid', 'invalid', 'uncertain'].includes(a.validity) &&
            ['none', 'general', 'decisive', 'uncertain'].includes(a.exposure) &&
            ['adequate', 'weak'].includes(a.discrimination) &&
            typeof a.reason === 'string',
          'Q4 requires full assessment check.',
        );
        const aw = evidenceRefs(view, a.refs);
        requireOutput(
          aw.some((x) => x.pointer === '/artifacts' || x.pointer.startsWith('/artifacts/')),
          'Q4 assessment must inspect author artifacts/key.',
        );
        const material =
          a.key === 'incorrect' || a.validity === 'invalid' || a.exposure === 'decisive';
        requireOutput(
          !material || row.level === 0,
          'Ordinal/assessment contradiction: invalid test or incorrect/disclosed key requires material defect.',
        );
        requireOutput(
          a.discrimination !== 'weak' || row.level !== 2,
          'Ordinal/assessment contradiction: weak discrimination is not level 2.',
        );
        requireOutput(
          ['retrieval', 'application', 'reasoning'].includes(a.demand) &&
            typeof a.demandReason === 'string' &&
            a.demandReason.trim(),
          'Q4 requires the actual cognitive operation.',
        );
        requireOutput(
          !(
            a.demand === 'retrieval' &&
            ['working_fluency', 'deep_transfer'].includes(view.desiredDepth)
          ) || row.level !== 2,
          'Ordinal/assessment contradiction: retrieval alone does not meet application/transfer depth.',
        );
        requireOutput(
          ![a.key, a.validity, a.exposure].includes('uncertain') || [0, 'U'].includes(row.level),
          'Ordinal/assessment contradiction: unresolved necessary assessment issue.',
        );
        assessment = { ...a, witnesses: aw };
      }
      let grading;
      if (d === 'Q5' && Object.hasOwn(view, 'answer') && view.rubric?.length) {
        const g = validateStudent(view, row.grading);
        const hasObservedCredit = ['granted', 'withheld'].includes(
          view.productJudgment?.consequence,
        );
        const actualCredit = hasObservedCredit
          ? view.productJudgment.consequence
          : row.grading.actualCredit;
        requireOutput(
          ['granted', 'withheld', 'uncertain'].includes(actualCredit),
          'Actual credit status required.',
        );
        requireOutput(
          witnesses.some((x) => x.pointer === '/answer'),
          'Q5 must cite the actual student answer, not feedback.',
        );
        let material = false,
          local = false,
          unresolved = false;
        for (const c of g.criteria) {
          const spec = view.rubric.find((x) => x.id === c.id),
            product = view.productJudgment?.criteria?.filter((x) => x.id === c.id);
          if (c.result === 'uncertain' || product?.length !== 1) {
            if (spec.required) unresolved = true;
            continue;
          }
          const actual = product[0].result;
          if (!['met', 'partial', 'not_met'].includes(actual)) {
            if (spec.required) unresolved = true;
            continue;
          }
          if (c.result !== actual) {
            if (spec.required && (c.result === 'met') !== (actual === 'met')) material = true;
            else local = true;
          }
        }
        if (g.warrantedCredit === 'uncertain' || actualCredit === 'uncertain') unresolved = true;
        else if (g.warrantedCredit !== actualCredit) material = true;
        requireOutput(
          !material || row.level === 0,
          'Ordinal/grading contradiction: required decision or credit mismatch is material.',
        );
        requireOutput(
          !local || row.level !== 2,
          'Ordinal/grading contradiction: optional/partial mismatch is local.',
        );
        requireOutput(
          !unresolved || [0, 'U'].includes(row.level),
          'Ordinal/grading contradiction: unresolved required student evidence.',
        );
        grading = {
          ...g,
          actualCredit,
          ...(hasObservedCredit
            ? {
                actualCreditWitness: {
                  pointer: '/productJudgment/consequence',
                  valueHash: sha(actualCredit),
                },
              }
            : {}),
        };
      }
      return {
        ...row,
        defects,
        witnesses,
        ...(assessment ? { assessment } : {}),
        ...(grading ? { grading } : {}),
        certification: {
          kind: 'structural_and_ordinal',
          valid: true,
          semanticTruthCertified: false,
        },
      };
    }),
  };
}
export function validateSolve(view, raw) {
  requireOutput(
    ['resolved', 'underdetermined', 'contradictory'].includes(raw?.status) &&
      typeof raw.solution === 'string' &&
      raw.solution.trim(),
    'Blind solution schema invalid.',
  );
  const witnesses = evidenceRefs(view, raw.refs);
  requireOutput(
    witnesses.some((x) => x.pointer.startsWith('/question')),
    'Blind solution must cite question.',
  );
  return { ...raw, witnesses };
}
export function validateContext(view, raw) {
  requireOutput(
    Array.isArray(raw?.premises) && Array.isArray(raw.missing) && typeof raw.reason === 'string',
    'Scenario context schema invalid.',
  );
  for (const p of raw.premises) {
    requireOutput(
      typeof p.ref === 'string' &&
        p.ref.startsWith('/priorExposure/') &&
        typeof p.quote === 'string' &&
        p.quote.trim(),
      'Context must quote prior exposure.',
    );
    const source = atPointer(view, p.ref);
    requireOutput(
      typeof source === 'string' && source.includes(p.quote),
      'Context quote not found in original prior exposure.',
    );
  }
  return raw;
}
export function validateStudent(view, raw) {
  requireOutput(
    raw && Array.isArray(raw.criteria) && raw.criteria.length === view.rubric.length,
    'Each student criterion must be analyzed once.',
  );
  const criteria = view.rubric.map((c, i) => {
    const matches = raw.criteria.filter((x) => x.id === c.id);
    requireOutput(matches.length === 1, 'Missing/repeated criterion ' + c.id);
    const p = matches[0];
    requireOutput(
      ['met', 'partial', 'not_met', 'uncertain'].includes(p.result) &&
        typeof p.reason === 'string' &&
        p.reason.trim(),
      'Invalid criterion analysis.',
    );
    const witnesses = evidenceRefs(view, p.refs);
    requireOutput(
      witnesses.some((x) => x.pointer === '/answer') &&
        witnesses.some((x) => x.pointer === `/rubric/${i}` || x.pointer === `/rubric/${i}/text`),
      'Criterion must cite actual /answer and matching rubric text/object.',
    );
    return { ...p, required: c.required, witnesses };
  });
  const required = criteria.filter((x) => x.required);
  const warranted = !required.length
    ? 'uncertain'
    : required.some((x) => ['not_met', 'partial'].includes(x.result))
      ? 'withheld'
      : required.some((x) => x.result === 'uncertain')
        ? 'uncertain'
        : 'granted';
  requireOutput(
    raw.warrantedCredit === warranted,
    'Ordinal/student credit must follow required meanings.',
  );
  return { criteria, warrantedCredit: warranted };
}
export function validateResolution(view, dimensions, raw, proposals, uncertainties = []) {
  const result = validateAudit(view, dimensions, raw);
  const submittedChallenges = raw.challenges ?? (proposals.length === 0 ? [] : undefined);
  requireOutput(
    Array.isArray(submittedChallenges) && submittedChallenges.length === proposals.length,
    'Every proposed defect requires a quotation check.',
  );
  const challenges = proposals.map((p) => {
    const xs = submittedChallenges.filter((x) => x.id === p.id);
    requireOutput(xs.length === 1, 'Missing/repeated defect verification.');
    const c = xs[0];
    requireOutput(
      ['upheld', 'rejected'].includes(c.decision) &&
        typeof c.reason === 'string' &&
        c.reason.trim() &&
        c.evidence,
      'Defect verification needs decision, reason and evidence.',
    );
    requireOutput(
      c.decision === 'rejected'
        ? c.severity === 'none'
        : ['local', 'material'].includes(c.severity),
      'Defect verification severity must match its disposition.',
    );
    const value = atPointer(view, c.evidence.ref);
    verifyAbsentProperty(value, c.evidence);
    requireOutput(
      typeof value === 'string'
        ? typeof c.evidence.quote === 'string' &&
            (c.evidence.quote.trim() || (value.trim() === '' && c.evidence.quote === value)) &&
            value.includes(c.evidence.quote)
        : c.evidence.quote === null,
      'Defect verification quote must match original evidence.',
    );
    const row = result.dimensions.find((x) => x.dimension === p.dimension);
    if (c.decision === 'upheld' && row)
      requireOutput(
        c.severity === 'material' ? row.level === 0 : row.level !== 2,
        'Ordinal/verified defect contradicts final level.',
      );
    return { ...c, evidence: { ...c.evidence, valueHash: sha(value) } };
  });
  const submittedEvidenceChecks =
    raw.evidenceChecks ?? (uncertainties.length === 0 ? [] : undefined);
  requireOutput(
    Array.isArray(submittedEvidenceChecks) &&
      submittedEvidenceChecks.length === uncertainties.length,
    'Every proposed evidence gap requires a separate availability check.',
  );
  const evidenceChecks = uncertainties.map((p) => {
    const matches = submittedEvidenceChecks.filter((c) => c.id === p.id);
    requireOutput(matches.length === 1, 'Missing/repeated evidence-gap verification.');
    const c = matches[0];
    requireOutput(
      ['available', 'not_needed', 'unavailable'].includes(c.decision) &&
        typeof c.reason === 'string' &&
        c.reason.trim() &&
        c.evidence,
      'Evidence gap needs availability decision and original evidence.',
    );
    const value = atPointer(view, c.evidence.ref);
    verifyAbsentProperty(value, c.evidence);
    requireOutput(
      typeof value === 'string'
        ? typeof c.evidence.quote === 'string' &&
            (c.evidence.quote.trim() || (value.trim() === '' && c.evidence.quote === value)) &&
            value.includes(c.evidence.quote)
        : c.evidence.quote === null,
      'Evidence-gap quote must match original evidence.',
    );
    const row = result.dimensions.find((d) => d.dimension === p.dimension);
    requireOutput(
      c.decision !== 'unavailable' || [0, 'U'].includes(row?.level),
      'Ordinal/evidence gap: unavailable decisive evidence cannot certify a positive level.',
    );
    return { ...c, evidence: { ...c.evidence, valueHash: sha(value) } };
  });
  return { ...result, challenges, ...(uncertainties.length ? { evidenceChecks } : {}) };
}
export function validateCoverage(view, raw) {
  requireOutput(
    Array.isArray(raw?.goals) && raw.goals.length === view.goals.length,
    'Every declared goal needs one mapping.',
  );
  return {
    goals: view.goals.map((_, i) => {
      const xs = raw.goals.filter((x) => x.index === i);
      requireOutput(xs.length === 1, 'Goal mapping index missing/repeated.');
      const g = xs[0];
      requireOutput(
        ['essential', 'secondary'].includes(g.importance) &&
          ['usable', 'partial', 'mentioned', 'missing', 'contradicted'].includes(g.status) &&
          typeof g.reason === 'string' &&
          g.reason.trim() &&
          typeof g.quote === 'string',
        'Invalid goal mapping.',
      );
      const witnesses = evidenceRefs(view, g.refs);
      requireOutput(
        witnesses.some((x) => x.pointer === `/goals/${i}` || x.pointer === '/goals') &&
          witnesses.some((x) => x.pointer.startsWith('/artifacts')),
        'Mapping must bind the goal and actual artifact.',
      );
      if (g.status === 'usable')
        requireOutput(
          g.quote.trim() &&
            g.refs.some(
              (ref) =>
                ref.startsWith('/artifacts') &&
                typeof atPointer(view, ref) === 'string' &&
                atPointer(view, ref).includes(g.quote),
            ),
          'Usable coverage requires a verbatim artifact quotation.',
        );
      return { ...g, witnesses };
    }),
  };
}
