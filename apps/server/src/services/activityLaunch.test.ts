import { beforeEach, describe, expect, it } from 'vitest';
import type { MisconceptionRecord, ReviewItem } from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import { makeBlock, makeConcept, makeGrounding, makeMaterial, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import {
  checkActivityCapability,
  launchableTutorModes,
  resolveActivityLaunch,
} from './activityLaunch.js';

/**
 * Deterministic activity-launch capability matrix. The resolver is the single
 * authority deciding whether an AssessmentMode is executable RIGHT NOW; these
 * tests pin every mode's preconditions and the deterministic fallback chain.
 */

const clock = fixedClock(T0);

function reviewItem(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    workspaceId: 'ws_1',
    conceptId: 'con_1',
    conceptName: '工作记忆',
    stability: 1,
    difficulty: 5,
    dueAt: T0,
    lastReviewedAt: T0,
    intervalDays: 1,
    reviewCount: 1,
    lapseCount: 0,
    lastRating: 'good',
    schedulerVersion: 'local-fsrs-v1',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function misconception(overrides: Partial<MisconceptionRecord>): MisconceptionRecord {
  return {
    id: 'mc_1',
    workspaceId: 'ws_1',
    conceptId: 'con_1',
    conceptName: '工作记忆',
    originBlueprintId: null,
    originQuestionId: 'que_1',
    originQuizId: 'qz_1',
    learnerAnswer: { questionId: 'que_1', type: 'single_choice', selectedOptionIds: ['B'] },
    evidence: [],
    category: 'definition_confusion',
    hypothesis: '可能把工作记忆当成了长时记忆。',
    provider: 'fake',
    status: 'proposed',
    decidedByQuizId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('checkActivityCapability', () => {
  let ctx: TestApp;

  beforeEach(() => {
    ctx = buildTestApp();
    // Default fixture workspace ws_1 with one document and two concepts.
    ctx.repos.materials.insertWithBlocks(makeMaterial(), [
      makeBlock(),
      makeBlock({
        id: 'blk_2',
        index: 1,
        content: '长时记忆负责长期存储。',
        startOffset: 22,
        endOffset: 33,
      }),
    ]);
    ctx.repos.materials.replaceConcepts('mat_1', [
      makeConcept(),
      makeConcept({
        id: 'con_2',
        name: '长时记忆',
        grounding: makeGrounding({ blockId: 'blk_2', quote: '长时记忆负责长期存储。' }),
      }),
    ]);
  });

  const check = (activity: Parameters<typeof checkActivityCapability>[3]) =>
    checkActivityCapability(ctx.repos, clock, 'ws_1', activity);

  it('concept_practice needs an existing workspace concept', () => {
    expect(check({ mode: 'concept_practice', conceptIds: ['con_1'] })).toEqual({
      ok: true,
      launch: { mode: 'concept_practice', conceptIds: ['con_1'] },
    });
    expect(check({ mode: 'concept_practice', conceptIds: ['con_gone'] }).ok).toBe(false);
  });

  it('diagnostic needs at least one concept in the workspace', () => {
    expect(check({ mode: 'diagnostic', conceptIds: [] })).toEqual({
      ok: true,
      launch: { mode: 'diagnostic' },
    });
  });

  it('cross_document requires an accepted cross-document alignment sibling, not merely two documents', () => {
    // Second document exists but no alignment: not launchable.
    ctx.repos.materials.insertWithBlocks(makeMaterial({ id: 'mat_2', title: '英文讲义' }), [
      makeBlock({ id: 'blk_b1', materialId: 'mat_2', content: 'Working memory is limited.' }),
    ]);
    ctx.repos.materials.replaceConcepts('mat_2', [
      makeConcept({
        id: 'con_en',
        materialId: 'mat_2',
        name: 'Working Memory',
        grounding: makeGrounding({ blockId: 'blk_b1', quote: 'Working memory is limited.' }),
      }),
    ]);
    const concepts = ctx.repos.materials.getConceptsByWorkspace('ws_1');
    ctx.repos.alignment.ensureBaseline('ws_1', concepts, T0);
    const before = check({ mode: 'cross_document', conceptIds: ['con_1'] });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.reason).toContain('跨文档对齐');

    // Accepted merge across documents unlocks the capability.
    ctx.repos.alignment.merge('con_en', 'con_1', '工作记忆', 'alp_test', T0);
    expect(check({ mode: 'cross_document', conceptIds: ['con_1'] })).toEqual({
      ok: true,
      launch: { mode: 'cross_document', conceptIds: ['con_1'] },
    });
  });

  it('review with named concepts accepts due-by-end-of-today, rejects later dues', () => {
    const now = clock.now().getTime();
    ctx.repos.review.upsert(
      reviewItem({ conceptId: 'con_1', dueAt: new Date(now + 6 * 3600 * 1000).toISOString() }),
    );
    // Due six hours from now — later today, launchable when named.
    expect(check({ mode: 'review', conceptIds: ['con_1'] })).toEqual({
      ok: true,
      launch: { mode: 'review', conceptIds: ['con_1'] },
    });
    // Unnamed review keeps strict due-now semantics.
    expect(check({ mode: 'review', conceptIds: [] }).ok).toBe(false);

    // Due in three days: not launchable even when named.
    ctx.repos.review.upsert(
      reviewItem({
        conceptId: 'con_1',
        dueAt: new Date(now + 3 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const later = check({ mode: 'review', conceptIds: ['con_1'] });
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.reason).toContain('复习安排');
  });

  it('misconception_check binds an actionable hypothesis and rejects terminal ones', () => {
    // No hypothesis at all: rejected.
    expect(check({ mode: 'misconception_check', conceptIds: ['con_1'] }).ok).toBe(false);

    ctx.repos.misconceptions.insert(misconception({ id: 'mc_a', status: 'proposed' }));
    // Unbound intent: the resolver binds the oldest actionable record itself.
    expect(check({ mode: 'misconception_check', conceptIds: ['con_1'] })).toEqual({
      ok: true,
      launch: { mode: 'misconception_check', misconceptionId: 'mc_a' },
    });
    // Explicitly bound to an actionable record.
    expect(
      check({ mode: 'misconception_check', conceptIds: ['con_1'], misconceptionId: 'mc_a' }).ok,
    ).toBe(true);

    // Terminal record: rejected with the terminal reason.
    ctx.repos.misconceptions.updateStatus('mc_a', 'rejected', null, T0);
    const terminal = check({
      mode: 'misconception_check',
      conceptIds: ['con_1'],
      misconceptionId: 'mc_a',
    });
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.reason).toContain('终态');
  });

  it('prerequisite_repair requires a real prerequisite edge in the active graph', () => {
    expect(check({ mode: 'prerequisite_repair', conceptIds: ['con_2'] }).ok).toBe(false);

    const now = T0;
    ctx.repos.graph.insertVersion({
      id: 'gv_1',
      workspaceId: 'ws_1',
      status: 'generating',
      provider: 'fake',
      providerModel: null,
      validationSummary: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
    ctx.repos.graph.finalizeReady(
      'gv_1',
      'ws_1',
      [
        {
          id: 'ge_1',
          graphVersionId: 'gv_1',
          sourceConceptId: 'con_1',
          targetConceptId: 'con_2',
          relation: 'prerequisite',
          explanation: '先理解工作记忆才能理解长时记忆。',
          evidence: [makeGrounding()],
          createdAt: now,
        },
      ],
      {
        candidateCount: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        duplicateCount: 0,
        droppedEvidenceCount: 0,
        rejected: [],
      },
      now,
    );
    expect(check({ mode: 'prerequisite_repair', conceptIds: ['con_2'] })).toEqual({
      ok: true,
      launch: { mode: 'prerequisite_repair', conceptIds: ['con_2'] },
    });
    // The prerequisite itself (con_1) has no prerequisite of its own.
    expect(check({ mode: 'prerequisite_repair', conceptIds: ['con_1'] }).ok).toBe(false);
  });
});

describe('resolveActivityLaunch fallback chain', () => {
  let ctx: TestApp;

  beforeEach(() => {
    ctx = buildTestApp();
    ctx.repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    ctx.repos.materials.replaceConcepts('mat_1', [makeConcept()]);
  });

  it('keeps a launchable recommendation unchanged', () => {
    const resolved = resolveActivityLaunch(ctx.repos, clock, 'ws_1', {
      mode: 'concept_practice',
      conceptIds: ['con_1'],
    });
    expect(resolved).toEqual({
      launch: { mode: 'concept_practice', conceptIds: ['con_1'] },
      adjusted: null,
    });
  });

  it('downgrades an unlaunchable mode to concept_practice with the honest reason', () => {
    const resolved = resolveActivityLaunch(ctx.repos, clock, 'ws_1', {
      mode: 'cross_document',
      conceptIds: ['con_1'],
    });
    expect(resolved).toEqual({
      launch: { mode: 'concept_practice', conceptIds: ['con_1'] },
      adjusted: {
        originalMode: 'cross_document',
        reason: expect.stringContaining('跨文档对齐') as unknown as string,
      },
    });
  });

  it('falls back to any workspace concept when the recommended ids vanished', () => {
    const resolved = resolveActivityLaunch(ctx.repos, clock, 'ws_1', {
      mode: 'review',
      conceptIds: ['con_gone'],
    });
    expect(resolved?.launch).toEqual({ mode: 'concept_practice', conceptIds: ['con_1'] });
    expect(resolved?.adjusted?.originalMode).toBe('review');
  });

  it('returns null only when the workspace has no concepts at all', () => {
    const empty = buildTestApp();
    expect(
      resolveActivityLaunch(empty.repos, clock, 'ws_1', {
        mode: 'concept_practice',
        conceptIds: ['con_1'],
      }),
    ).toBeNull();
  });
});

describe('launchableTutorModes', () => {
  it('offers only modes whose preconditions currently hold', () => {
    const ctx = buildTestApp();
    ctx.repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    ctx.repos.materials.replaceConcepts('mat_1', [makeConcept()]);

    const modes = launchableTutorModes(ctx.repos, clock, 'ws_1', 'con_1').map((m) => m.mode);
    expect(modes).toContain('concept_practice');
    expect(modes).toContain('diagnostic');
    expect(modes).not.toContain('cross_document');
    expect(modes).not.toContain('review');
    expect(modes).not.toContain('misconception_check');
    expect(modes).not.toContain('prerequisite_repair');
  });
});
