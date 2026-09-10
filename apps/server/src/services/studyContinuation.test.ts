import { describe, expect, it } from 'vitest';
import type { CourseFormalReadiness, SessionAgenda, StudyPlan } from '@hy3-clinic/shared';
import {
  blockUnreadySynthesisItems,
  isSelectedStudyItemExecutable,
  resolveStudyContinuationItem,
  type StudyContinuationProgress,
} from './studyContinuation.js';

const AT = '2026-09-04T09:05:03.790Z';
const synthesisObjectives = Array.from({ length: 6 }, (_, index) => `objective_${index + 1}`);

const plan: StudyPlan = {
  id: 'plan_1',
  workspaceId: 'ws_1',
  contractVersionId: 'contract_1',
  curriculumVersionId: 'curriculum_1',
  executionSourceManifestFingerprint: 'manifest_1',
  version: 1,
  predecessorId: null,
  proposalTrigger: 'Accepted route',
  status: 'accepted',
  rationale: 'Teach, synthesize, then continue teaching.',
  items: [
    {
      id: 'plan_teaching_done',
      index: 0,
      phase: 'Core',
      kind: 'teach_unit',
      curriculumLearningUnitId: 'unit_done',
      rationale: 'Completed prerequisite teaching.',
      estimatedMinutes: 20,
      targetDepth: 'working_fluency',
      objectiveIds: synthesisObjectives.slice(0, 2),
      prerequisitePlanItemIds: [],
      completionPolicy: null,
      completionRequirements: [],
    },
    {
      id: 'plan_synthesis',
      index: 1,
      phase: 'Synthesis checkpoint',
      kind: 'synthesis',
      curriculumLearningUnitId: 'unit_done',
      rationale: 'Integrate objectives from a chapter-level synthesis group.',
      estimatedMinutes: 20,
      targetDepth: 'working_fluency',
      objectiveIds: synthesisObjectives,
      prerequisitePlanItemIds: ['plan_teaching_done'],
      completionPolicy: null,
      completionRequirements: [],
    },
    {
      id: 'plan_teaching_next',
      index: 2,
      phase: 'Core',
      kind: 'teach_unit',
      curriculumLearningUnitId: 'unit_next',
      rationale: 'Continue prerequisite-safe teaching.',
      estimatedMinutes: 17,
      targetDepth: 'working_fluency',
      objectiveIds: ['objective_7', 'objective_8'],
      prerequisitePlanItemIds: ['plan_teaching_done'],
      completionPolicy: null,
      completionRequirements: [],
    },
  ],
  deferrals: [],
  feasibility: {
    projectedMinutes: 57,
    availableMinutes: null,
    slackMinutes: null,
    state: 'unknown',
    assumptions: [],
  },
  paceBaseline: {
    id: 'pace_1',
    policyVersion: 'pace-v1',
    contractVersionId: 'contract_1',
    studyPlanVersionId: 'plan_1',
    timeZone: 'UTC',
    expectedSessionCadencePerWeek: null,
    explicitSlackMinutes: 0,
    estimateConfidence: 'low',
    estimateSource: 'local',
    milestones: [],
  },
  diff: [],
  provider: 'fake',
  providerModel: null,
  learnerAcceptedAt: AT,
  createdAt: AT,
};

const agenda: SessionAgenda = {
  id: 'agenda_1',
  workspaceId: 'ws_1',
  contractVersionId: 'contract_1',
  curriculumVersionId: 'curriculum_1',
  studyPlanVersionId: 'plan_1',
  executionSourceManifestFingerprint: 'manifest_1',
  version: 5,
  status: 'active',
  availableMinutes: null,
  items: [
    {
      id: 'agenda_synthesis',
      index: 0,
      kind: 'synthesis',
      origin: 'accepted_plan',
      reason: 'Integrate objectives from a chapter-level synthesis group.',
      estimatedMinutes: 20,
      linkedPlanItemId: 'plan_synthesis',
      learningUnitId: 'unit_done',
      priority: 'medium',
      state: 'queued',
      launch: {
        status: 'launchable',
        capability: 'assessment',
        resourceId: '{"mode":"concept_practice"}',
        reason: null,
      },
      displacedAgendaItemIds: [],
      timeImpactMinutes: 0,
    },
    {
      id: 'agenda_teaching_next',
      index: 1,
      kind: 'learning_unit_teaching',
      origin: 'accepted_plan',
      reason: 'Continue prerequisite-safe teaching.',
      estimatedMinutes: 17,
      linkedPlanItemId: 'plan_teaching_next',
      learningUnitId: 'unit_next',
      priority: 'medium',
      state: 'queued',
      launch: {
        status: 'launchable',
        capability: 'lesson',
        resourceId: '{"learningUnitId":"unit_next","conceptId":"concept_1"}',
        reason: null,
      },
      displacedAgendaItemIds: [],
      timeImpactMinutes: 0,
    },
  ],
  currentItemId: 'agenda_synthesis',
  createdAt: AT,
  updatedAt: AT,
};

const progress: StudyContinuationProgress[] = [
  { planItemId: 'plan_teaching_done', state: 'completed' },
  { planItemId: 'plan_synthesis', state: 'not_started' },
  { planItemId: 'plan_teaching_next', state: 'not_started' },
];

const pendingReadiness: CourseFormalReadiness = {
  status: 'pending',
  requiredObjectiveCount: 14,
  readyObjectiveCount: 0,
  unresolvedObjectiveIds: Array.from({ length: 14 }, (_, index) => `objective_${index + 1}`),
  teachingOnlyObjectiveIds: Array.from({ length: 14 }, (_, index) => `objective_${index + 1}`),
};

describe('Study continuation routing', () => {
  it('keeps a scoped transfer reachable while unrelated objectives are pending, but respects its checkpoint prerequisite', () => {
    const scoped = structuredClone(plan);
    const item = scoped.items.find((item) => item.id === 'plan_synthesis')!;
    item.synthesisMode = 'unit_transfer';
    item.objectiveIds = ['objective_1'];
    item.prerequisitePlanItemIds = [];
    const synthesis = agenda.items.find((item) => item.id === 'agenda_synthesis')!;
    expect(isSelectedStudyItemExecutable(synthesis, scoped, progress, pendingReadiness)).toBe(true);
    expect(blockUnreadySynthesisItems(agenda, pendingReadiness, scoped).items[0]?.state).toBe(
      'queued',
    );
    item.prerequisitePlanItemIds = ['unfinished-checkpoint'];
    expect(isSelectedStudyItemExecutable(synthesis, scoped, progress, pendingReadiness)).toBe(
      false,
    );
  });
  it('routes a queued pending synthesis gate to prerequisite-safe teaching without losing objectives', () => {
    const before = JSON.stringify({ agenda, plan, progress });

    const selected = resolveStudyContinuationItem({
      agenda,
      plan,
      progress,
      formalReadiness: pendingReadiness,
    });

    expect(selected?.id).toBe('agenda_teaching_next');
    const routedAgenda = blockUnreadySynthesisItems(agenda, pendingReadiness);
    expect(routedAgenda.items.find((item) => item.id === 'agenda_synthesis')).toMatchObject({
      state: 'blocked',
      launch: { status: 'blocked', resourceId: null },
    });
    expect(plan.items.find((item) => item.id === 'plan_synthesis')?.objectiveIds).toEqual(
      synthesisObjectives,
    );
    expect(agenda.items.find((item) => item.id === 'agenda_synthesis')?.state).toBe('queued');
    expect(JSON.stringify({ agenda, plan, progress })).toBe(before);
  });

  it('does not call a queued synthesis executable while Formal readiness is pending', () => {
    const synthesis = agenda.items[0]!;
    expect(isSelectedStudyItemExecutable(synthesis, plan, progress, pendingReadiness)).toBe(false);
    expect(
      resolveStudyContinuationItem({
        agenda: { ...agenda, items: [synthesis] },
        plan,
        progress,
        formalReadiness: pendingReadiness,
      }),
    ).toBeNull();
  });

  it('keeps ordinary executable teaching selected', () => {
    const teachingAgenda = { ...agenda, currentItemId: 'agenda_teaching_next' };
    expect(
      resolveStudyContinuationItem({
        agenda: teachingAgenda,
        plan,
        progress,
        formalReadiness: pendingReadiness,
      })?.id,
    ).toBe('agenda_teaching_next');
  });

  it('keeps a queued synthesis selected once the exact Formal projection is ready', () => {
    expect(
      resolveStudyContinuationItem({
        agenda,
        plan,
        progress,
        formalReadiness: {
          status: 'ready',
          requiredObjectiveCount: 14,
          readyObjectiveCount: 14,
          unresolvedObjectiveIds: [],
          teachingOnlyObjectiveIds: [],
        },
      })?.id,
    ).toBe('agenda_synthesis');
  });
});
