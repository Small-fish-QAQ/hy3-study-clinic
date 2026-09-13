import { describe, expect, it, vi } from 'vitest';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import { analyzeCourseMapProposal } from '../services/courseMap.js';
import { planCurriculumDetailBatches } from '../services/curriculumMaterialization.js';
import { FakeProvider } from './fakeProvider.js';
import { Hy3Provider } from './hy3Provider.js';
import {
  curriculumCoverageGaps,
  partitionCurriculumCoverageInput,
  validateCurriculumCoverageRepair,
  validateCurriculumCoverageReview,
  reanchorCoverageQuotes,
  materializeCurriculumCoverageMapping,
  validateCurriculumCoverageMapping,
  type CurriculumCoverageReviewInput,
  type CurriculumCoverageReview,
} from './curriculumCoverage.js';

async function fixture() {
  const source = createCourseMapFixture();
  const detail = planCurriculumDetailBatches({
    workspaceName: 'Coverage',
    contract: source.providerInput.contract,
    courseMap: analyzeCourseMapProposal(source.good, source).courseMap,
    sourceAllocation: source.sourceAllocation,
    evidenceCatalog: source.evidenceCatalog,
    concepts: source.concepts,
    canonicalConcepts: source.canonicalConcepts,
  })[0]!.input;
  const candidate = await new FakeProvider().proposeCurriculumDetails(detail);
  const input: CurriculumCoverageReviewInput = { detail, candidate };
  const review: CurriculumCoverageReview = {
    regions: detail.regions.map((r) => ({
      regionId: r.regionId,
      obligations: [
        {
          capability: 'Retain the governing condition',
          construct: candidate.units.find((unit) => unit.regionId === r.regionId)!.objectives[0]!
            .construct,
          evidence: [{ evidenceId: r.evidence[0]!.evidenceId, quote: r.evidence[0]!.text }],
          objectiveIndexes: [0],
        },
      ],
    })),
  };
  return { input, review };
}

describe('source-grounded Curriculum teaching coverage', () => {
  it('retains frozen wording locally while rejecting missing, duplicate or foreign mapping identities', async () => {
    const { input, review } = await fixture();
    review.regions[0]!.obligations[0]!.capability += ' (retain this exact qualification)';
    input.requiredCoverage = structuredClone(review);
    for (const region of input.requiredCoverage.regions)
      for (const obligation of region.obligations) obligation.objectiveIndexes = [];
    const mapping = {
      regions: review.regions.map((region) => ({
        regionId: region.regionId,
        obligations: region.obligations.map((obligation, obligationIndex) => ({
          obligationIndex,
          objectiveIndexes: [...obligation.objectiveIndexes],
        })),
      })),
    };
    expect(validateCurriculumCoverageMapping(mapping, input).valid).toBe(true);
    expect(materializeCurriculumCoverageMapping(mapping, input)).toEqual(review);
    for (const mutate of [
      (m: typeof mapping) => {
        m.regions.pop();
      },
      (m: typeof mapping) => {
        m.regions[0]!.obligations.push(structuredClone(m.regions[0]!.obligations[0]!));
      },
      (m: typeof mapping) => {
        m.regions[0]!.obligations[0]!.obligationIndex = 99;
      },
      (m: typeof mapping) => {
        m.regions[0]!.obligations[0]!.objectiveIndexes = [99];
      },
      (m: typeof mapping) => {
        Object.assign(m.regions[0]!.obligations[0]!, { capability: 'Narrowed claim' });
      },
    ]) {
      const changed = structuredClone(mapping);
      mutate(changed);
      expect(validateCurriculumCoverageMapping(changed, input).valid).toBe(false);
    }
    mapping.regions[0]!.obligations[0]!.objectiveIndexes = [];
    expect(validateCurriculumCoverageMapping(mapping, input).valid).toBe(true);
    expect(
      curriculumCoverageGaps(materializeCurriculumCoverageMapping(mapping, input)),
    ).toHaveLength(1);
    expect(
      input.requiredCoverage.regions.every((region) =>
        region.obligations.every((obligation) => !obligation.objectiveIndexes.length),
      ),
    ).toBe(true);
  });
  it('accepts a compact provider mapping and validates the reconstructed immutable inventory', async () => {
    const { input, review } = await fixture();
    input.requiredCoverage = structuredClone(review);
    const mapping = {
      regions: review.regions.map((region) => ({
        regionId: region.regionId,
        obligations: region.obligations.map((obligation, obligationIndex) => ({
          obligationIndex,
          objectiveIndexes: obligation.objectiveIndexes,
        })),
      })),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(mapping) }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      ),
    );
    const provider = new Hy3Provider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test',
      model: 'test-model',
      timeoutMs: 30000,
      fetchImpl,
    });
    const validate = vi.fn((raw: unknown) => validateCurriculumCoverageReview(raw, input));
    await expect(
      provider.reviewCurriculumCoverage(input, { validateCandidate: validate }),
    ).resolves.toEqual(review);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith(review);
  });
  it('reanchors a real quote only to a unique offered excerpt in the same region', async () => {
    const { input, review } = await fixture();
    delete input.requiredCoverage;
    const citation = review.regions[0]!.obligations[0]!.evidence[0]!;
    const correct = citation.evidenceId;
    const exactOffer = input.detail.regions[0]!.evidence.find((e) => e.evidenceId === correct)!;
    input.detail.regions[0]!.evidence.push({
      ...exactOffer,
      evidenceId: 'parent-paragraph',
      text: `Context before. ${citation.quote} Context after.`,
    });
    citation.evidenceId = 'wrong-neighbour';
    const repaired = reanchorCoverageQuotes(review, input) as CurriculumCoverageReview;
    expect(repaired.regions[0]!.obligations[0]!.evidence[0]!.evidenceId).toBe(correct);
    expect(citation.evidenceId).toBe('wrong-neighbour');
    expect(repaired.regions[0]!.obligations[0]!.capability).toBe(
      review.regions[0]!.obligations[0]!.capability,
    );
    input.detail.regions[0]!.evidence.push({ ...exactOffer, evidenceId: 'ambiguous-second-exact' });
    expect(
      (reanchorCoverageQuotes(review, input) as CurriculumCoverageReview).regions[0]!
        .obligations[0]!.evidence[0]!.evidenceId,
    ).toBe('wrong-neighbour');
    citation.quote = 'This invented source quotation is absent.';
    expect(
      (reanchorCoverageQuotes(review, input) as CurriculumCoverageReview).regions[0]!
        .obligations[0]!.evidence[0],
    ).toEqual(citation);
  });
  it('partitions large reviews without omitting or sharing candidate regions', async () => {
    const { input } = await fixture();
    input.detail.regions = Array.from({ length: 9 }, (_, index) => ({
      ...input.detail.regions[0]!,
      regionId: `region-${index}`,
    }));
    input.candidate.units = input.detail.regions.map((region) => ({
      ...input.candidate.units[0]!,
      regionId: region.regionId,
    }));
    const batches = partitionCurriculumCoverageInput(input);
    expect(batches.map((batch) => batch.detail.regions.length)).toEqual([4, 4, 1]);
    expect(batches.flatMap((batch) => batch.candidate.units)).toEqual(input.candidate.units);
    for (const batch of batches)
      expect(batch.candidate.units.map((unit) => unit.regionId)).toEqual(
        batch.detail.regions.map((region) => region.regionId),
      );
  });
  it('separates missing teaching scope from valid evidence bindings', async () => {
    const { input, review } = await fixture();
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(true);
    expect(curriculumCoverageGaps(review)).toEqual([]);
    review.regions[0]!.obligations[0]!.objectiveIndexes = [];
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(true);
    expect(curriculumCoverageGaps(review)).toHaveLength(1);
  });
  it('rejects missing regions, foreign objective indexes and invented quotations', async () => {
    const { input, review } = await fixture();
    for (const alter of [
      (r: CurriculumCoverageReview) => {
        r.regions.pop();
      },
      (r: CurriculumCoverageReview) => {
        r.regions[0]!.obligations[0]!.objectiveIndexes = [99];
      },
      (r: CurriculumCoverageReview) => {
        r.regions[0]!.obligations[0]!.evidence[0]!.quote =
          'This claim never occurred in the material.';
      },
    ]) {
      const changed = structuredClone(review);
      alter(changed);
      expect(validateCurriculumCoverageReview(changed, input).valid).toBe(false);
    }
  });
  it('does not let a mapping review narrow the independently frozen capabilities', async () => {
    const { input, review } = await fixture();
    input.requiredCoverage = structuredClone(review);
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(true);
    review.regions[0]!.obligations[0]!.capability = 'Name the rule instead of using it.';
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(false);
  });
  it('cannot count explanatory labels as coverage of a frozen application capability', async () => {
    const { input, review } = await fixture();
    const obligation = review.regions[0]!.obligations[0]!;
    obligation.capability = 'Calculate and interpret spread for a new sample.';
    obligation.construct = 'apply';
    input.requiredCoverage = structuredClone(review);
    input.candidate.units[0]!.objectives[0]!.construct = 'explain';
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(false);
    obligation.construct = 'explain';
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(false);
    obligation.construct = 'apply';
    obligation.objectiveIndexes = [];
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(true);
    expect(curriculumCoverageGaps(review)).toHaveLength(1);
    input.candidate.units[0]!.objectives[0]!.construct = 'apply';
    obligation.objectiveIndexes = [0];
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(true);
  });
  it('can retain explicit recognition and explanation in one explanatory objective', async () => {
    const { input, review } = await fixture();
    const first = review.regions[0]!.obligations[0]!;
    first.construct = 'identify';
    first.capability = 'Identify the governing condition';
    review.regions[0]!.obligations.push({
      ...structuredClone(first),
      construct: 'explain',
      capability: 'Explain why that condition is necessary',
    });
    input.requiredCoverage = structuredClone(review);
    input.candidate.units[0]!.objectives[0]!.construct = 'explain';
    input.candidate.units[0]!.objectives[0]!.description =
      'Identify the governing condition and explain why it is necessary.';
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(true);
    expect(review).toEqual(input.requiredCoverage);
    input.candidate.units[0]!.objectives[0]!.construct = 'identify';
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(false);
    first.construct = 'design';
    input.requiredCoverage = structuredClone(review);
    input.candidate.units[0]!.objectives[0]!.construct = 'evaluate';
    expect(validateCurriculumCoverageReview(review, input).valid).toBe(false);
  });
  it('allows additive coverage repair while refusing scope, construct or priority loss', async () => {
    const { input } = await fixture();
    const original = input.candidate;
    const fixed = structuredClone(original);
    fixed.units[0]!.objectives[0]!.description += ' Retain the maintenance exception as well.';
    expect(validateCurriculumCoverageRepair(fixed, original).valid).toBe(true);
    for (const alter of [
      () => {
        fixed.units[0]!.objectives[0]!.description = 'A narrower fragment.';
      },
      () => {
        fixed.units[0]!.objectives[0]!.construct = 'evaluate';
      },
      () => {
        fixed.units[0]!.objectives[0]!.priority = 'optional';
      },
    ]) {
      alter();
      expect(validateCurriculumCoverageRepair(fixed, original).valid).toBe(false);
      Object.assign(
        fixed.units[0]!.objectives[0]!,
        structuredClone(original.units[0]!.objectives[0]!),
      );
    }
  });
  it('rejects an unchanged repair of a region with a known coverage gap', async () => {
    const { input, review } = await fixture();
    review.regions[0]!.obligations[0]!.objectiveIndexes = [];
    const unchanged = structuredClone(input.candidate);
    expect(validateCurriculumCoverageRepair(unchanged, input.candidate, review).valid).toBe(false);
    unchanged.units[0]!.objectives[0]!.description +=
      ' Also carry out the calculation when the stated input changes.';
    expect(validateCurriculumCoverageRepair(unchanged, input.candidate, review).valid).toBe(true);
    // Acceptance here only permits independent coverage review; it does not mark the gap covered.
    expect(curriculumCoverageGaps(review)).toHaveLength(1);
  });
});
