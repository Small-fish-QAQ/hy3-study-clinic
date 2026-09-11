import { describe, expect, it } from 'vitest';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import { analyzeCourseMapProposal } from '../services/courseMap.js';
import { planCurriculumDetailBatches } from '../services/curriculumMaterialization.js';
import { FakeProvider } from './fakeProvider.js';
import {
  curriculumCoverageGaps,
  partitionCurriculumCoverageInput,
  validateCurriculumCoverageRepair,
  validateCurriculumCoverageReview,
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
});
