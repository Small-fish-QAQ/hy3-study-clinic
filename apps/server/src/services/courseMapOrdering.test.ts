import { describe, expect, it } from 'vitest';
import { CourseMapSourceRegionRefSchema, type CourseMapProposalPayload } from '@hy3-clinic/shared';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import { analyzeCourseMapProposal } from './courseMap.js';
import { canonicalizeCourseMapProposalOrder } from './courseMapOrdering.js';

/**
 * Canonical Curriculum ordering. Provider emission order is a presentation
 * choice; canonical order is a function of the prerequisite graph plus the
 * server-owned source-allocation index.
 */

type Prerequisites = CourseMapProposalPayload['prerequisites'];

interface Observation {
  valid: boolean;
  errorCodes: string[];
  /** Canonical learner order, as source refs in emitted traversal order. */
  order: string[];
  regionIds: string[];
  moduleIds: string[];
  courseMapId: string;
}

function observe(
  fixture: ReturnType<typeof createCourseMapFixture>,
  payload: CourseMapProposalPayload,
): Observation {
  const analysis = analyzeCourseMapProposal(payload, fixture);
  const regions = analysis.courseMap.modules.flatMap((module) => module.regions);
  return {
    valid: analysis.validation.valid,
    errorCodes: [
      ...new Set(
        analysis.validation.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'error')
          .map((diagnostic) => diagnostic.code),
      ),
    ].sort(),
    // Fixture titles are `Instructional region N`, so `RN` reads back exactly.
    order: regions.map((region) => `R${region.title.replace(/\D+/gu, '')}`),
    regionIds: regions.map((region) => region.id),
    moduleIds: analysis.courseMap.modules.map((module) => module.id),
    courseMapId: analysis.courseMap.id,
  };
}

/**
 * Every permutation keeps all six fixture regions present, so any diagnostic is
 * attributable to the order under test rather than to coverage. `emission` is
 * given as source-region indexes; `split` is how many land in the first module.
 */
function payloadFor(
  fixture: ReturnType<typeof createCourseMapFixture>,
  emission: readonly number[],
  prerequisites: Prerequisites,
  split = 3,
): CourseMapProposalPayload {
  const region = (index: number) => ({
    sourceRegionRef: `R${index + 1}`,
    title: `Instructional region ${index + 1}`,
    learningIntent: `Understand and apply the distinct ideas in source region ${index + 1}.`,
    approximateScope: 'standard' as const,
    anchorOptionRefs: fixture.providerInput.sourceRegions[index]!.anchorOptions.map(
      (option) => option.anchorOptionId,
    ),
  });
  return {
    modules: [
      {
        title: 'Foundations',
        learningIntent: 'Build the first material into a connected foundation.',
        regions: emission.slice(0, split).map(region),
      },
      {
        title: 'Applications',
        learningIntent: 'Use the second material to extend and apply the foundation.',
        regions: emission.slice(split).map(region),
      },
    ],
    prerequisites,
    synthesisGroups: [],
  };
}

/**
 * Build modules from explicit membership, so a module's own allocation range can
 * interleave with another's. Needed to tell a module key taken from the minimum
 * source-allocation index apart from one taken from the first emitted member.
 */
function interleavedPayloadFor(
  fixture: ReturnType<typeof createCourseMapFixture>,
  moduleMembership: ReadonlyArray<readonly number[]>,
  prerequisites: Prerequisites,
): CourseMapProposalPayload {
  const base = payloadFor(fixture, [0, 1, 2, 3, 4, 5], prerequisites);
  const regionByIndex = new Map(
    base.modules
      .flatMap((module) => module.regions)
      .map((region) => [Number(region.sourceRegionRef.slice(1)) - 1, region] as const),
  );
  return {
    ...base,
    modules: moduleMembership.map((members, moduleIndex) => ({
      title: `Module ${moduleIndex + 1}`,
      learningIntent: `Teach the ideas grouped into module ${moduleIndex + 1}.`,
      regions: members.map((index) => regionByIndex.get(index)!),
    })),
  };
}

/**
 * Emit the same modules in a different array order. Each module keeps its own
 * title and its own regions, so this permutes presentation only. Re-grouping
 * regions under a different module title would be a different proposal, not a
 * permutation, and is deliberately not claimed to be identity-invariant.
 */
function modulePayloadFor(
  fixture: ReturnType<typeof createCourseMapFixture>,
  moduleOrder: readonly number[],
  prerequisites: Prerequisites,
): CourseMapProposalPayload {
  const base = payloadFor(fixture, [0, 1, 2, 3, 4, 5], prerequisites);
  return { ...base, modules: moduleOrder.map((slot) => base.modules[slot]!) };
}

/**
 * Assert that every emission in a semantic equivalence class produces one
 * canonical order and one identity. Guards against the empty-vs-empty false
 * green: both runs must actually have produced a complete, non-empty result.
 */
function expectEquivalent(
  fixture: ReturnType<typeof createCourseMapFixture>,
  emissions: ReadonlyArray<readonly number[]>,
  prerequisites: Prerequisites,
  split = 3,
): Observation {
  const observations = emissions.map((emission) =>
    observe(fixture, payloadFor(fixture, emission, prerequisites, split)),
  );
  for (const observation of observations) {
    expect(observation.valid).toBe(true);
    expect(observation.errorCodes).toEqual([]);
    expect(observation.order).toHaveLength(6);
    expect(observation.regionIds).toHaveLength(6);
    expect(observation.regionIds.every((id) => id.length > 0)).toBe(true);
    expect(observation.moduleIds).toHaveLength(2);
    expect(observation.moduleIds.every((id) => id.length > 0)).toBe(true);
    expect(observation.courseMapId.length).toBeGreaterThan(0);
  }
  const [first] = observations;
  for (const observation of observations.slice(1)) {
    expect(observation.order).toEqual(first!.order);
    expect(observation.regionIds).toEqual(first!.regionIds);
    expect(observation.moduleIds).toEqual(first!.moduleIds);
    expect(observation.courseMapId).toEqual(first!.courseMapId);
  }
  return first!;
}

const CHAIN: Prerequisites = Array.from({ length: 5 }, (_unused, index) => ({
  prerequisiteRegionRef: `R${index + 1}`,
  dependentRegionRef: `R${index + 2}`,
}));

describe('canonical Curriculum order is independent of provider emission order', () => {
  it('ORDER-1/ORDER-2: accepts an already-canonical chain and canonicalizes its reverse', () => {
    const fixture = createCourseMapFixture();
    const canonical = expectEquivalent(fixture, [[0, 1, 2, 3, 4, 5]], CHAIN);
    expect(canonical.order).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);

    // The same chain emitted backwards inside each module. Previously refused
    // with `prerequisite_wrong_order`; now a canonicalization input.
    const reversed = observe(fixture, payloadFor(fixture, [2, 1, 0, 5, 4, 3], CHAIN));
    expect(reversed.valid).toBe(true);
    expect(reversed.errorCodes).toEqual([]);
    expect(reversed.order).toEqual(canonical.order);
    expect(reversed.regionIds).toEqual(canonical.regionIds);
    expect(reversed.courseMapId).toEqual(canonical.courseMapId);
  });

  it('ORDER-3: orders a diamond identically under every valid emission', () => {
    const fixture = createCourseMapFixture();
    const diamond: Prerequisites = [
      { prerequisiteRegionRef: 'R1', dependentRegionRef: 'R2' },
      { prerequisiteRegionRef: 'R1', dependentRegionRef: 'R3' },
      { prerequisiteRegionRef: 'R2', dependentRegionRef: 'R4' },
      { prerequisiteRegionRef: 'R3', dependentRegionRef: 'R4' },
      { prerequisiteRegionRef: 'R4', dependentRegionRef: 'R5' },
      { prerequisiteRegionRef: 'R5', dependentRegionRef: 'R6' },
    ];
    // R2 and R3 are interchangeable in the graph; the tie-break must decide.
    const canonical = expectEquivalent(
      fixture,
      [
        [0, 1, 2, 3, 4, 5],
        [0, 2, 1, 3, 4, 5],
      ],
      diamond,
    );
    expect(canonical.order).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });

  it('ORDER-4: orders multiple roots identically under permutation', () => {
    const fixture = createCourseMapFixture();
    // R1 and R2 are both roots and mutually unordered by the graph.
    const multiRoot: Prerequisites = [
      { prerequisiteRegionRef: 'R1', dependentRegionRef: 'R3' },
      { prerequisiteRegionRef: 'R2', dependentRegionRef: 'R3' },
      { prerequisiteRegionRef: 'R3', dependentRegionRef: 'R4' },
      { prerequisiteRegionRef: 'R4', dependentRegionRef: 'R5' },
      { prerequisiteRegionRef: 'R5', dependentRegionRef: 'R6' },
    ];
    const canonical = expectEquivalent(
      fixture,
      [
        [0, 1, 2, 3, 4, 5],
        [1, 0, 2, 3, 4, 5],
      ],
      multiRoot,
    );
    expect(canonical.order).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });

  it('ORDER-5: orders disconnected components from source allocation, not emission', () => {
    const fixture = createCourseMapFixture();
    // Two components: {R1->R2->R3} in module 1 and {R4->R5->R6} in module 2.
    const components: Prerequisites = [
      { prerequisiteRegionRef: 'R1', dependentRegionRef: 'R2' },
      { prerequisiteRegionRef: 'R2', dependentRegionRef: 'R3' },
      { prerequisiteRegionRef: 'R4', dependentRegionRef: 'R5' },
      { prerequisiteRegionRef: 'R5', dependentRegionRef: 'R6' },
    ];
    // Emit the two modules in both array orders. Titles travel with contents,
    // so only the presentation order differs.
    const forward = observe(fixture, modulePayloadFor(fixture, [0, 1], components));
    const swapped = observe(fixture, modulePayloadFor(fixture, [1, 0], components));
    for (const observation of [forward, swapped]) {
      expect(observation.valid).toBe(true);
      expect(observation.errorCodes).toEqual([]);
      expect(observation.order).toHaveLength(6);
      expect(observation.regionIds.every((id) => id.length > 0)).toBe(true);
    }
    expect(forward.order).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(swapped.order).toEqual(forward.order);
    expect(swapped.regionIds).toEqual(forward.regionIds);
    expect(swapped.moduleIds).toEqual(forward.moduleIds);
    expect(swapped.courseMapId).toEqual(forward.courseMapId);
  });

  it('ORDER-6: orders a graph-free proposal from source allocation', () => {
    const fixture = createCourseMapFixture();
    const canonical = expectEquivalent(
      fixture,
      [
        [0, 1, 2, 3, 4, 5],
        [2, 0, 1, 5, 3, 4],
        [1, 2, 0, 4, 5, 3],
      ],
      [],
    );
    expect(canonical.order).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });

  it('ORDER-7: keeps the tie-break total when every region title is identical', () => {
    const fixture = createCourseMapFixture();
    const identicalTitles = (payload: CourseMapProposalPayload): CourseMapProposalPayload => ({
      ...payload,
      modules: payload.modules.map((module) => ({
        ...module,
        regions: module.regions.map((region) => ({ ...region, title: 'Same title' })),
      })),
    });
    const forward = observe(fixture, identicalTitles(payloadFor(fixture, [0, 1, 2, 3, 4, 5], [])));
    const permuted = observe(fixture, identicalTitles(payloadFor(fixture, [2, 0, 1, 5, 4, 3], [])));
    expect(forward.valid).toBe(true);
    expect(permuted.valid).toBe(true);
    expect(forward.regionIds).toHaveLength(6);
    expect(forward.regionIds.every((id) => id.length > 0)).toBe(true);
    // Titles are not an ordering input, so allocation index still totally orders.
    expect(permuted.regionIds).toEqual(forward.regionIds);
    expect(permuted.courseMapId).toEqual(forward.courseMapId);
  });

  it('ORDER-8: canonicalizes a cross-module prerequisite the provider emitted backwards', () => {
    const fixture = createCourseMapFixture();
    // R4 lives in module 2 and R2 in module 1, so satisfying R4 -> R2 needs the
    // modules reordered. That is representable: module 2 simply comes first.
    const crossModule: Prerequisites = [{ prerequisiteRegionRef: 'R4', dependentRegionRef: 'R2' }];
    const observation = observe(fixture, payloadFor(fixture, [0, 1, 2, 3, 4, 5], crossModule));
    expect(observation.valid).toBe(true);
    expect(observation.errorCodes).toEqual([]);
    expect(observation.order).toEqual(['R4', 'R5', 'R6', 'R1', 'R2', 'R3']);
    expect(observation.order.indexOf('R4')).toBeLessThan(observation.order.indexOf('R2'));
  });

  it('ORDER-9: refuses prerequisites that no contiguous module order can satisfy', () => {
    const fixture = createCourseMapFixture();
    // Acyclic over regions, cyclic once contracted onto modules.
    const condensationCycle: Prerequisites = [
      { prerequisiteRegionRef: 'R1', dependentRegionRef: 'R4' },
      { prerequisiteRegionRef: 'R5', dependentRegionRef: 'R2' },
    ];
    for (const emission of [
      [0, 1, 2, 3, 4, 5],
      [3, 4, 5, 0, 1, 2],
    ]) {
      const observation = observe(fixture, payloadFor(fixture, emission, condensationCycle));
      expect(observation.valid).toBe(false);
      expect(observation.errorCodes).toContain('invalid_module_order');
      // Fails closed without dropping a region.
      expect(observation.order).toHaveLength(6);
      expect(observation.errorCodes).not.toContain('prerequisite_cycle');
    }
  });

  it('ORDER-10: takes a module order key from source allocation, not its first emitted region', () => {
    const fixture = createCourseMapFixture();
    // Module 1 holds allocation {3,1,5} and module 2 holds {4,0,2}, so the two
    // ranges interleave and each module's first emitted region is not its
    // lowest-allocated one. Ordering by first emission would put module 1 first.
    const observation = observe(
      fixture,
      interleavedPayloadFor(
        fixture,
        [
          [3, 1, 5],
          [4, 0, 2],
        ],
        [],
      ),
    );
    expect(observation.valid).toBe(true);
    expect(observation.errorCodes).toEqual([]);
    expect(observation.order).toEqual(['R1', 'R3', 'R5', 'R2', 'R4', 'R6']);
    // Emitting the same two modules in the other array order must not move them.
    const swapped = observe(
      fixture,
      interleavedPayloadFor(
        fixture,
        [
          [4, 0, 2],
          [3, 1, 5],
        ],
        [],
      ),
    );
    expect(swapped.order).toEqual(observation.order);
  });

  it('FAIL-5: still refuses one source region allocated to two Course Map regions', () => {
    const fixture = createCourseMapFixture();
    const duplicated = observe(fixture, payloadFor(fixture, [0, 1, 2, 3, 4, 0], []));
    expect(duplicated.valid).toBe(false);
    expect(duplicated.errorCodes).toContain('duplicate_source_allocation');
  });
});

describe('canonical order drives identity, and only real semantics change it', () => {
  it('changes canonical order and identity when a prerequisite edge changes', () => {
    const fixture = createCourseMapFixture();
    const base = observe(fixture, payloadFor(fixture, [0, 1, 2, 3, 4, 5], []));
    // A real semantic change: R4 must now precede R2, which moves module 2 first.
    const reordered = observe(
      fixture,
      payloadFor(
        fixture,
        [0, 1, 2, 3, 4, 5],
        [{ prerequisiteRegionRef: 'R4', dependentRegionRef: 'R2' }],
      ),
    );
    expect(base.valid).toBe(true);
    expect(reordered.valid).toBe(true);
    expect(base.order).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(reordered.order).toEqual(['R4', 'R5', 'R6', 'R1', 'R2', 'R3']);
    expect(reordered.order).not.toEqual(base.order);
    expect(reordered.courseMapId).not.toEqual(base.courseMapId);
    expect(reordered.regionIds).not.toEqual(base.regionIds);
  });

  it('changes identity when the source allocation order changes', () => {
    const fixture = createCourseMapFixture();
    const base = observe(fixture, payloadFor(fixture, [0, 1, 2, 3, 4, 5], []));
    // Re-titling a region is a real content change, so identity must follow it.
    const retitled = payloadFor(fixture, [0, 1, 2, 3, 4, 5], []);
    retitled.modules[0]!.regions[0] = {
      ...retitled.modules[0]!.regions[0]!,
      title: 'A materially different region title',
    };
    const changed = observe(fixture, retitled);
    expect(base.valid).toBe(true);
    expect(changed.valid).toBe(true);
    expect(changed.courseMapId).not.toEqual(base.courseMapId);
  });

  it('records the one canonical decision in both array position and index', () => {
    const fixture = createCourseMapFixture();
    // Emit deliberately out of canonical order, then check that the array
    // position and the sibling `index` agree. Curriculum assembly copies
    // `module.index` to the chapter and `region.index` to the section, and emits
    // nodes in this traversal order, so both carriers stay derived from one
    // decision instead of drifting apart.
    const analysis = analyzeCourseMapProposal(
      payloadFor(fixture, [2, 0, 1, 5, 3, 4], CHAIN),
      fixture,
    );
    expect(analysis.validation.valid).toBe(true);
    expect(analysis.courseMap.modules.length).toBeGreaterThan(0);
    analysis.courseMap.modules.forEach((module, moduleIndex) => {
      expect(module.index).toBe(moduleIndex);
      expect(module.regions.length).toBeGreaterThan(0);
      module.regions.forEach((region, regionIndex) => {
        expect(region.index).toBe(regionIndex);
        expect(region.moduleId).toBe(module.id);
      });
    });
  });

  it('is stable across repeated analysis of one unchanged proposal', () => {
    const fixture = createCourseMapFixture();
    const payload = payloadFor(fixture, [2, 0, 1, 5, 3, 4], CHAIN);
    const first = observe(fixture, payload);
    const second = observe(fixture, payload);
    expect(first.regionIds).toHaveLength(6);
    expect(first.regionIds.every((id) => id.length > 0)).toBe(true);
    expect(second.regionIds).toEqual(first.regionIds);
    expect(second.courseMapId).toEqual(first.courseMapId);
  });
});

/**
 * Side arrays carry no pedagogical order: the schema gives them no ordering
 * field and the prompt names only module and region arrays as learner order.
 * Provider permutation of them must not move Curriculum identity, while a real
 * change of what they mean still must.
 */
describe('semantically unordered side arrays do not carry identity', () => {
  // Refs stay inside R1..R4 so these groups are valid both for the full-coverage
  // emission and for the reduced one the disposition cases use.
  const SYNTHESIS_GROUPS = [
    { level: 'module' as const, title: 'Consolidate the foundation', regionRefs: ['R1', 'R2'] },
    { level: 'course' as const, title: 'Integrate across materials', regionRefs: ['R3', 'R4'] },
    { level: 'transfer' as const, title: 'Apply the extensions', regionRefs: ['R2', 'R4'] },
  ];

  // A disposition explains a source region the modules did NOT allocate, so the
  // emission below drops R5/R6 (indexes 4 and 5) and accounts for them here.
  const EMISSION_WITHOUT_LAST_TWO = [0, 1, 2, 3];

  const DISPOSITIONS = [
    {
      sourceRegionRef: 'R5',
      disposition: 'represented_by_parent_or_synthesis' as const,
      rationale: 'Covered by the module 2 synthesis rather than its own unit.',
      representedRegionRefs: ['R3', 'R4'],
    },
    {
      sourceRegionRef: 'R6',
      disposition: 'boilerplate/navigation/non-learning-content' as const,
      rationale: 'Front matter and navigation with no learning content.',
      representedRegionRefs: [],
    },
  ];

  function withSideArrays(
    fixture: ReturnType<typeof createCourseMapFixture>,
    synthesisGroups: CourseMapProposalPayload['synthesisGroups'],
    sourceDispositions?: CourseMapProposalPayload['sourceDispositions'],
  ): CourseMapProposalPayload {
    const emission = sourceDispositions ? EMISSION_WITHOUT_LAST_TWO : [0, 1, 2, 3, 4, 5];
    const prerequisites = CHAIN.filter(
      (edge) =>
        emission.length === 6 ||
        (!edge.prerequisiteRegionRef.match(/^R[56]$/u) &&
          !edge.dependentRegionRef.match(/^R[56]$/u)),
    );
    return {
      ...payloadFor(fixture, emission, prerequisites),
      synthesisGroups,
      ...(sourceDispositions ? { sourceDispositions } : {}),
    };
  }

  function identityOf(observation: Observation): string[] {
    return [observation.courseMapId, ...observation.moduleIds, ...observation.regionIds];
  }

  it('SIDE-1: keeps identity when the provider permutes synthesisGroups', () => {
    const fixture = createCourseMapFixture();
    const base = observe(fixture, withSideArrays(fixture, SYNTHESIS_GROUPS));
    const permuted = observe(fixture, withSideArrays(fixture, [...SYNTHESIS_GROUPS].reverse()));
    expect(base.valid).toBe(true);
    expect(permuted.valid).toBe(true);
    expect(identityOf(permuted)).toEqual(identityOf(base));
  });

  it('SIDE-2: keeps identity when the provider permutes sourceDispositions', () => {
    const fixture = createCourseMapFixture();
    const base = observe(fixture, withSideArrays(fixture, SYNTHESIS_GROUPS, DISPOSITIONS));
    const permuted = observe(
      fixture,
      withSideArrays(fixture, SYNTHESIS_GROUPS, [...DISPOSITIONS].reverse()),
    );
    expect(base.valid).toBe(true);
    expect(identityOf(permuted)).toEqual(identityOf(base));
  });

  it('SIDE-3: keeps identity when refs inside a synthesis group are permuted', () => {
    const fixture = createCourseMapFixture();
    const base = observe(fixture, withSideArrays(fixture, SYNTHESIS_GROUPS, DISPOSITIONS));
    const innerPermuted = SYNTHESIS_GROUPS.map((group) => ({
      ...group,
      regionRefs: [...group.regionRefs].reverse(),
    }));
    const permuted = observe(fixture, withSideArrays(fixture, innerPermuted, DISPOSITIONS));
    expect(identityOf(permuted)).toEqual(identityOf(base));
  });

  it('SIDE-4: changes identity when synthesis membership actually changes', () => {
    const fixture = createCourseMapFixture();
    const base = observe(fixture, withSideArrays(fixture, SYNTHESIS_GROUPS, DISPOSITIONS));
    const changed = SYNTHESIS_GROUPS.map((group, index) =>
      index === 0 ? { ...group, regionRefs: ['R1', 'R3'] } : group,
    );
    const observed = observe(fixture, withSideArrays(fixture, changed, DISPOSITIONS));
    expect(observed.courseMapId).not.toEqual(base.courseMapId);
  });

  it('SIDE-5: changes identity when a disposition meaning actually changes', () => {
    const fixture = createCourseMapFixture();
    const base = observe(fixture, withSideArrays(fixture, SYNTHESIS_GROUPS, DISPOSITIONS));
    const changed = DISPOSITIONS.map((disposition) =>
      disposition.sourceRegionRef === 'R6'
        ? { ...disposition, disposition: 'explicitly_out_of_scope' as const }
        : disposition,
    );
    const observed = observe(fixture, withSideArrays(fixture, SYNTHESIS_GROUPS, changed));
    expect(observed.courseMapId).not.toEqual(base.courseMapId);
  });

  it('SIDE-6: keeps an absent sourceDispositions array absent', () => {
    const fixture = createCourseMapFixture();
    const canonical = canonicalizeCourseMapProposalOrder(
      withSideArrays(fixture, SYNTHESIS_GROUPS),
      new Map(
        fixture.providerInput.sourceRegions.map(
          (region, index) => [region.sourceRegionRef, index] as const,
        ),
      ),
    );
    expect('sourceDispositions' in canonical.payload).toBe(false);
  });

  /**
   * The composite keys join refs with '|'. That is only injective while every
   * participating field excludes the separator, so assert the grammar rather
   * than trusting it: a schema loosened to admit '|' must fail here.
   */
  it('SIDE-7: keeps every ref-list key participant free of the key separator', () => {
    const fixture = createCourseMapFixture();
    const refs = fixture.providerInput.sourceRegions.map((region) => region.sourceRegionRef);
    for (const ref of refs) {
      expect(CourseMapSourceRegionRefSchema.safeParse(ref).success).toBe(true);
      expect(ref).not.toContain('|');
    }
    for (const candidate of ['R1|R2', 'R1 R2', 'R|1', '|R1']) {
      expect(CourseMapSourceRegionRefSchema.safeParse(candidate).success).toBe(false);
    }
  });

  /**
   * Two synthesis groups whose ref sets differ only in grouping must not tie on
   * the joined key. Under a separator a ref could contain, ['R1|R2'] and
   * ['R1','R2'] would collide and a stable sort would silently keep provider
   * order, which is exactly the identity leak SIDE-1 exists to prevent.
   */
  it('SIDE-8: distinguishes synthesis groups whose joined refs would collide', () => {
    const fixture = createCourseMapFixture();
    const distinctGrouping = [
      { level: 'module' as const, title: 'Same title', regionRefs: ['R1', 'R2'] },
      { level: 'module' as const, title: 'Same title', regionRefs: ['R1', 'R2', 'R3'] },
    ];
    const base = observe(fixture, withSideArrays(fixture, distinctGrouping));
    const permuted = observe(fixture, withSideArrays(fixture, [...distinctGrouping].reverse()));
    expect(base.valid).toBe(true);
    expect(identityOf(permuted)).toEqual(identityOf(base));

    const realChange = [
      { level: 'module' as const, title: 'Same title', regionRefs: ['R1', 'R2'] },
      { level: 'module' as const, title: 'Same title', regionRefs: ['R1', 'R2', 'R4'] },
    ];
    const regrouped = observe(fixture, withSideArrays(fixture, realChange));
    expect(identityOf(regrouped)).not.toEqual(identityOf(base));
  });
});
