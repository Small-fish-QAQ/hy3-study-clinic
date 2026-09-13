import {
  CONFIG,
  AUDIT,
  REVIEW,
  RESOLVE,
  SOLVE,
  CONTEXT,
  STUDENT,
  COVERAGE,
  EVIDENCE_RESOLUTION,
  scoringPrompt,
} from './prompts.mjs';
import { RUBRIC } from './rubric.mjs';
import {
  validateAudit,
  validateSolve,
  validateContext,
  validateStudent,
  validateResolution,
  validateCoverage,
  sha,
} from './contracts.mjs';
const units = (xs) => (xs || []).map((x) => ({ id: x.id, text: x.text }));
export function project(record) {
  const e = record.evidence;
  if (!e || !Array.isArray(e.sources)) throw new Error('Input evidence.sources required.');
  return {
    sources: units(e.sources),
    goals: e.goals || [],
    prerequisites: e.prerequisites || [],
    desiredDepth: e.desiredDepth || 'not_specified',
    authorityBoundaries: e.authorityBoundaries || [],
    artifacts: units(e.artifacts),
    priorExposure: units(e.exposure),
    ...(e.question
      ? { question: { prompt: e.question.prompt, options: units(e.question.options) } }
      : {}),
    ...(e.rubric
      ? { rubric: e.rubric.map((x) => ({ id: x.id, text: x.text, required: x.required === true })) }
      : {}),
    ...(e.answer !== undefined ? { answer: e.answer } : {}),
    ...(e.productJudgment
      ? {
          productJudgment: {
            criteria: e.productJudgment.criteria.map((x) => ({ id: x.id, result: x.result })),
            feedback: e.productJudgment.feedback || '',
            consequence: e.productJudgment.consequence,
          },
        }
      : {}),
    ...(e.proposition ? { proposition: e.proposition, candidates: units(e.candidates) } : {}),
  };
}
const compact = (x) =>
  Array.isArray(x)
    ? x.map(compact)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.entries(x)
            .filter(
              ([k]) =>
                !['witnesses', 'actualCreditWitness', 'certification', 'referenceRepairs'].includes(
                  k,
                ),
            )
            .map(([k, v]) => [k, compact(v)]),
        )
      : x;
export async function evaluate(record, { stage, tasks = [] } = {}) {
  if (tasks.length)
    throw new Error('Attached multi-task records require explicit independent records.');
  const dimensions = record.dimensions;
  if (
    !Array.isArray(dimensions) ||
    !dimensions.length ||
    new Set(dimensions).size !== dimensions.length ||
    dimensions.some((d) => !RUBRIC[d])
  )
    throw new Error('Invalid requested dimensions.');
  const view = project(record),
    stages = {},
    rubric = Object.fromEntries(dimensions.map((d) => [d, RUBRIC[d]]));
  const run = async (name, input, prompt, validate) => {
    const r = await stage(name, input, prompt, validate);
    stages[name] = r;
    return r;
  };
  const finish = (result) => ({
    version: CONFIG.version,
    inputViewHash: sha(view),
    stages,
    result,
    resultHash: sha(result),
  });
  let blindSolution = null;
  if (CONFIG.blindSolve && view.question && dimensions.some((d) => ['Q4', 'Q5'].includes(d))) {
    let context = null;
    if (view.priorExposure.length) {
      const cv = {
        sources: view.sources,
        question: view.question,
        priorExposure: view.priorExposure,
      };
      context = await run('scenario-context', { view: cv }, CONTEXT, (raw) =>
        validateContext(cv, raw),
      );
      if (context.status === 'JUDGE_INVALID') return finish(context);
    }
    const sv = {
      sources: view.sources,
      question: view.question,
      authorityBoundaries: view.authorityBoundaries,
      ...(context
        ? {
            scenarioContext: context.premises.map((p) => ({ text: p.quote })),
            scenarioMissing: context.missing,
          }
        : {}),
    };
    blindSolution = await run('blind-solution', { view: sv }, SOLVE, (raw) =>
      validateSolve(sv, raw),
    );
    if (blindSolution.status === 'JUDGE_INVALID') return finish(blindSolution);
  }
  let independentStudent = null;
  if (
    CONFIG.blindStudent &&
    dimensions.includes('Q5') &&
    Object.hasOwn(view, 'answer') &&
    view.rubric?.length
  ) {
    const sv = {
      sources: view.sources,
      question: view.question,
      rubric: view.rubric,
      answer: view.answer,
      authorityBoundaries: view.authorityBoundaries,
    };
    independentStudent = await run(
      'blind-student',
      { view: sv, blindSolution: compact(blindSolution) },
      STUDENT,
      (raw) => validateStudent(sv, raw),
    );
    if (independentStudent.status === 'JUDGE_INVALID') return finish(independentStudent);
  }
  let coverage = null;
  if (CONFIG.goalMapping && dimensions.includes('Q2') && view.goals.length) {
    const cv = {
      sources: view.sources,
      goals: view.goals,
      artifacts: view.artifacts,
      prerequisites: view.prerequisites,
      desiredDepth: view.desiredDepth,
      authorityBoundaries: view.authorityBoundaries,
    };
    coverage = await run('goal-mapping', { view: cv }, COVERAGE, (raw) =>
      validateCoverage(cv, raw),
    );
    if (coverage.status === 'JUDGE_INVALID') return finish(coverage);
  }
  const input = {
    view,
    rubric,
    ...(blindSolution ? { blindSolution: compact(blindSolution) } : {}),
    ...(independentStudent ? { independentStudent: compact(independentStudent) } : {}),
    ...(coverage && !CONFIG.mappingAdvisoryOnly ? { coverage: compact(coverage) } : {}),
  };
  const first = await run('audit', input, scoringPrompt(AUDIT, dimensions), (raw) =>
    validateAudit(view, dimensions, raw),
  );
  if (first.status === 'JUDGE_INVALID') return finish(first);
  let final = first;
  if (CONFIG.reviews > 1) {
    const second = await run(
      'independent-review',
      input,
      scoringPrompt(REVIEW, dimensions),
      (raw) => validateAudit(view, dimensions, raw),
    );
    if (second.status === 'JUDGE_INVALID') return finish(second);
    const disagreesWithStudent = (row) =>
      independentStudent &&
      row?.grading?.criteria?.some(
        (c) => independentStudent.criteria.find((x) => x.id === c.id)?.result !== c.result,
      );
    let disputed = dimensions.filter((d) => {
      const a = first.dimensions.find((x) => x.dimension === d),
        b = second.dimensions.find((x) => x.dimension === d);
      return (
        a.level !== b.level ||
        a.level === 'U' ||
        b.level === 'U' ||
        (CONFIG.adjudicateNonperfect && (a.level !== 2 || b.level !== 2)) ||
        (d === 'Q5' && (disagreesWithStudent(a) || disagreesWithStudent(b))) ||
        (d === 'Q2' && coverage?.goals.some((g) => g.status !== 'usable'))
      );
    });
    if (
      CONFIG.reviewRelatedDimensionsOnMaterial &&
      [first, second].some((review) =>
        review.dimensions.some((d) => d.defects.some((defect) => defect.severity === 'material')),
      )
    )
      disputed = [...dimensions];
    if (disputed.length) {
      const defectProposals = [first, second].flatMap((review, i) =>
        review.dimensions
          .filter((d) => disputed.includes(d.dimension))
          .flatMap((d) =>
            d.defects.map((x, j) => ({
              id: `review${i + 1}:${d.dimension}:${j + 1}`,
              dimension: d.dimension,
              ...compact(x),
            })),
          ),
      );
      const uncertaintyProposals = [first, second].flatMap((review, i) =>
        review.dimensions
          .filter((d) => disputed.includes(d.dimension) && d.level === 'U')
          .map((d) => ({
            id: `review${i + 1}:${d.dimension}:missing`,
            dimension: d.dimension,
            missing: d.missing,
            reason: d.reason,
          })),
      );
      const resolved = await run(
        'resolve',
        {
          view,
          rubric: Object.fromEntries(disputed.map((d) => [d, RUBRIC[d]])),
          blindSolution: compact(blindSolution),
          independentStudent: compact(independentStudent),
          coverage: compact(coverage),
          reviews: [compact(first), compact(second)],
          disputes: disputed,
          ...(CONFIG.verifyDefectQuotes ? { defectProposals } : {}),
          ...(uncertaintyProposals.length ? { uncertaintyProposals } : {}),
        },
        scoringPrompt(RESOLVE, disputed) + (uncertaintyProposals.length ? EVIDENCE_RESOLUTION : ''),
        (raw) =>
          CONFIG.verifyDefectQuotes
            ? validateResolution(view, disputed, raw, defectProposals, uncertaintyProposals)
            : validateAudit(view, disputed, raw),
      );
      if (resolved.status === 'JUDGE_INVALID') return finish(resolved);
      final = {
        dimensions: dimensions.map(
          (d) =>
            resolved.dimensions.find((x) => x.dimension === d) ||
            first.dimensions.find((x) => x.dimension === d),
        ),
      };
    }
  }
  return finish({
    status: 'VALID',
    dimensions: final.dimensions,
    reviewRequired: final.dimensions
      .filter((d) => d.level === 'U')
      .map((d) => ({ dimension: d.dimension, reason: d.missing.join('; ') })),
  });
}
