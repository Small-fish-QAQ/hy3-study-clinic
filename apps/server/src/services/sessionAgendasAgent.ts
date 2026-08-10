import {
  SessionAgendaSchema,
  type Curriculum,
  type LearningContract,
  type SessionAgenda,
  type SessionAgendaItem,
  type SessionAgendaItemKind,
  type StudyPlan,
  type StudyPlanItemKind,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { resolveLaunchForPlanItem } from './studyPlanValidation.js';

interface SessionAgendaAgentDeps {
  repos: Repositories;
  clock: Clock;
}

const AGENDA_KIND_BY_PLAN_KIND: Record<StudyPlanItemKind, SessionAgendaItemKind> = {
  teach_unit: 'learning_unit_teaching',
  informal_check: 'informal_check',
  formal_checkpoint: 'formal_checkpoint',
  synthesis: 'synthesis',
  targeted_repair: 'targeted_repair',
  due_review: 'due_review',
  adversarial_readiness: 'adversarial_readiness',
};

function selectSessionItems(plan: StudyPlan, availableMinutes: number | null) {
  const ordered = [...plan.items].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  if (availableMinutes === null) return ordered.slice(0, 3);
  const selected: StudyPlan['items'] = [];
  let used = 0;
  for (const item of ordered) {
    if (selected.length > 0 && used + item.estimatedMinutes > availableMinutes) break;
    selected.push(item);
    used += item.estimatedMinutes;
  }
  return selected.length > 0 ? selected : ordered.slice(0, 1);
}

export function createSessionAgendaAgentService({ repos, clock }: SessionAgendaAgentDeps) {
  function composeDraft(
    contract: LearningContract,
    curriculum: Curriculum,
    plan: StudyPlan,
    availableMinutes = contract.studyBudget.preferredSessionMinutes,
  ): SessionAgenda {
    if (
      plan.contractVersionId !== contract.id ||
      plan.curriculumVersionId !== curriculum.id ||
      plan.executionSourceManifestFingerprint !== curriculum.executionSourceManifest.fingerprint
    ) {
      throw new Error('Cannot compose an Agenda from an incompatible Course route.');
    }
    const now = clock.now().toISOString();
    const existing = repos.sessionAgendas.list(contract.workspaceId);
    const selected = selectSessionItems(plan, availableMinutes);
    const items: SessionAgendaItem[] = selected.map((planItem, index) => {
      const launch = resolveLaunchForPlanItem(
        repos,
        clock,
        contract.workspaceId,
        curriculum,
        planItem,
      );
      return {
        id: newId('agenda_item'),
        index,
        kind: AGENDA_KIND_BY_PLAN_KIND[planItem.kind],
        origin: 'accepted_plan',
        reason: planItem.rationale,
        estimatedMinutes: planItem.estimatedMinutes,
        linkedPlanItemId: planItem.id,
        learningUnitId: planItem.curriculumLearningUnitId,
        priority:
          planItem.kind === 'formal_checkpoint' || planItem.kind === 'targeted_repair'
            ? 'high'
            : 'medium',
        state: launch.status === 'blocked' ? 'blocked' : 'queued',
        launch,
        displacedAgendaItemIds: [],
        timeImpactMinutes: 0,
      };
    });
    return SessionAgendaSchema.parse({
      id: newId('agenda'),
      workspaceId: contract.workspaceId,
      contractVersionId: contract.id,
      curriculumVersionId: curriculum.id,
      studyPlanVersionId: plan.id,
      executionSourceManifestFingerprint: plan.executionSourceManifestFingerprint,
      version: (existing.at(-1)?.version ?? 0) + 1,
      status: 'draft',
      availableMinutes,
      items,
      currentItemId: items.find((item) => item.state === 'queued')?.id ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { composeDraft };
}

export type SessionAgendaAgentService = ReturnType<typeof createSessionAgendaAgentService>;
