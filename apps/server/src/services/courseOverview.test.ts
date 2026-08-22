import { describe, expect, it } from 'vitest';
import type { CoverageRiskEntry, StudyPlan } from '@hy3-clinic/shared';
import { summarizeRisks } from './courseOverview.js';

const AT = '2026-08-22T08:00:00.000Z';

function risk(id: string, overrides: Partial<CoverageRiskEntry> = {}): CoverageRiskEntry {
  return {
    id,
    workspaceId: 'ws_1',
    contractVersionId: 'contract_current',
    stableScopeFingerprint: 'scope_current',
    materialId: 'material_1',
    topicId: null,
    objectiveId: null,
    facets: ['present_in_course_material', 'unresolved_unverified_risk'],
    scopeAuthorityStatus: 'in_scope',
    truthPremiseStatus: 'not_applicable',
    truthAuthorityRecordIds: [],
    referencedCurriculumNodeIds: [],
    referencedConceptIds: [],
    referencedEvidenceIds: [],
    origin: 'deterministic',
    status: 'open',
    severity: 'medium',
    priority: 60,
    contractSensitive: true,
    claim: 'One source segment is not structurally referenced.',
    uncertainty: 'Structural arithmetic does not prove a meaningful semantic gap.',
    observations: [
      {
        id: `observation_${id}`,
        materialRevisionId: 'revision_current',
        sourceBlockId: `block_${id}`,
        sourceBlockRevisionFingerprint: `fingerprint_${id}`,
        executionSourceManifestFingerprint: 'manifest_current',
        reconciliationStatus: 'current',
        observedAt: AT,
        lastVerifiedAt: AT,
      },
    ],
    resolutionEvidenceIds: [],
    learnerDecisionId: null,
    provider: null,
    providerModel: null,
    promptVersion: null,
    firstObservedAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function plan(overrides: Partial<StudyPlan> = {}): StudyPlan {
  return {
    id: 'plan_current',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_current',
    curriculumVersionId: 'curriculum_current',
    executionSourceManifestFingerprint: 'manifest_current',
    version: 1,
    predecessorId: null,
    proposalTrigger: 'Initial route',
    status: 'proposed',
    rationale: 'Keep complete scope.',
    items: [
      {
        id: 'item_1',
        index: 0,
        phase: 'Learn',
        kind: 'teach_unit',
        curriculumLearningUnitId: 'unit_1',
        rationale: 'Required work',
        estimatedMinutes: 120,
        targetDepth: 'working_fluency',
        objectiveIds: ['objective_1'],
        prerequisitePlanItemIds: [],
        completionPolicy: null,
        completionRequirements: [],
      },
    ],
    deferrals: [],
    feasibility: {
      projectedMinutes: 120,
      availableMinutes: 60,
      slackMinutes: -60,
      state: 'at_risk',
      assumptions: ['Availability is an estimate.'],
    },
    recommendations: [
      {
        kind: 'keep_full_scope',
        rationale: 'Keep the complete accepted Curriculum.',
        affectedCurriculumLearningUnitIds: [],
        projectedMinutes: 120,
        learnerDecision: 'pending',
      },
    ],
    paceBaseline: null,
    diff: [],
    provider: 'fake',
    providerModel: null,
    learnerAcceptedAt: null,
    createdAt: AT,
    ...overrides,
  };
}

describe('current Coverage/Risk projection', () => {
  it('groups many current source rows without claiming a meaningful Curriculum gap', () => {
    const rows = Array.from({ length: 208 }, (_, index) => risk(`risk_${index}`));
    const summary = summarizeRisks(rows, AT, 'contract_current', 'manifest_current', null);
    expect(summary).toMatchObject({
      openCount: 1,
      currentIssueCount: 1,
      historicalOnlyCount: 0,
      sourceCoverageObservationCount: 1,
      meaningfulCurriculumGapCount: 0,
    });
    expect(summary.highlights[0]).toMatchObject({
      category: 'source_coverage_observation',
      observationCount: 208,
    });
    expect(summary.highlights[0]?.supportingRecordIds).toHaveLength(200);
  });

  it('fences superseded Contract and source-manifest rows from current counts', () => {
    const summary = summarizeRisks(
      [
        risk('current'),
        risk('old-contract', { contractVersionId: 'contract_old' }),
        risk('old-source', {
          observations: [
            { ...risk('x').observations[0]!, executionSourceManifestFingerprint: 'manifest_old' },
          ],
        }),
      ],
      AT,
      'contract_current',
      'manifest_current',
      null,
    );
    expect(summary.currentIssueCount).toBe(1);
    expect(summary.historicalOnlyCount).toBe(2);
  });

  it('projects soft feasibility as a warning and pending choices as recommendations, not deferrals', () => {
    const summary = summarizeRisks([], AT, 'contract_current', 'manifest_current', plan());
    expect(summary).toMatchObject({
      planningWarningCount: 1,
      recommendationCount: 1,
      intentionalDeferralCount: 0,
    });
    expect(summary.highlights.map((item) => item.category)).toEqual([
      'planning_risk',
      'recommendation',
    ]);
  });

  it('counts only learner-accepted deferrals as intentional', () => {
    const proposed = risk('proposal', { facets: ['planning_recommendation'], status: 'planned' });
    const accepted = risk('accepted', {
      stableScopeFingerprint: 'accepted-scope',
      facets: ['intentionally_deferred'],
      status: 'deferred',
      learnerDecisionId: 'decision_1',
      referencedCurriculumNodeIds: ['unit_1'],
    });
    const summary = summarizeRisks(
      [proposed, accepted],
      AT,
      'contract_current',
      'manifest_current',
      null,
    );
    expect(summary.recommendationCount).toBe(1);
    expect(summary.intentionalDeferralCount).toBe(1);
  });

  it('is deterministic and does not mutate inputs', () => {
    const rows = [risk('b'), risk('a')];
    const before = JSON.stringify(rows);
    expect(summarizeRisks(rows, AT, 'contract_current', 'manifest_current', plan())).toEqual(
      summarizeRisks([...rows].reverse(), AT, 'contract_current', 'manifest_current', plan()),
    );
    expect(JSON.stringify(rows)).toBe(before);
  });
});
