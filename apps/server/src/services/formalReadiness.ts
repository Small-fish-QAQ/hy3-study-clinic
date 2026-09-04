import type {
  CourseFormalReadiness,
  Curriculum,
  SessionAgenda,
  StudyPlan,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import { validateObjectiveAuthoritySemanticSupport } from './objectiveAuthoritySemanticSupport.js';

/**
 * Formal readiness is deliberately narrower than teaching readiness. It only
 * accepts objectives whose exact current SourceBlock claims are independently
 * validated and still eligible for blocking use. Curriculum prose or Lesson
 * output never participates in this decision.
 */
export function assessCourseFormalReadiness(
  repos: Repositories,
  curriculum: Curriculum | null,
  route?: { studyPlan: StudyPlan | null; agenda: SessionAgenda | null },
): CourseFormalReadiness {
  if (!curriculum) {
    return {
      status: 'pending',
      requiredObjectiveCount: 0,
      readyObjectiveCount: 0,
      unresolvedObjectiveIds: [],
      teachingOnlyObjectiveIds: [],
    };
  }
  const objectives = curriculum.nodes.flatMap(
    (node) => node.learningUnit?.objectives.map((objective) => ({ node, objective })) ?? [],
  );
  const required = objectives.filter(({ objective }) => objective.priority !== 'optional');
  const pendingObjectiveIds: string[] = [];
  const blockedObjectiveIds: string[] = [];
  const readyObjectiveIds: string[] = [];
  for (const { node, objective } of required) {
    if (!objective.semanticSupport) {
      pendingObjectiveIds.push(objective.id);
      continue;
    }
    const semanticAuthority = validateObjectiveAuthoritySemanticSupport(
      curriculum,
      [objective],
      {
        isBlockingEligible: (authorityRecordId) =>
          repos.sourceAuthority.isBlockingEligible(authorityRecordId),
      },
      'formal_provider',
    );
    if (!semanticAuthority.valid || objective.truthPremiseStatus !== 'independently_verified') {
      blockedObjectiveIds.push(objective.id);
      continue;
    }
    const sourceBlockIds = new Set(
      node.sourceReferences
        .map((reference) => reference.sourceBlockId)
        .filter((id): id is string => id !== null),
    );
    const authorityReady = objective.truthAuthorityRecordIds.some((authorityId) => {
      if (!repos.sourceAuthority.isBlockingEligible(authorityId)) return false;
      const bundle = repos.sourceAuthority.getBundle(authorityId);
      return Boolean(
        bundle?.claims.some(
          (claim) =>
            sourceBlockIds.has(claim.sourceBlockId) &&
            repos.materials.getBlock(claim.sourceBlockId)?.materialRevisionId ===
              bundle.record.materialRevisionId,
        ),
      );
    });
    if (!authorityReady) {
      blockedObjectiveIds.push(objective.id);
      continue;
    }

    // Once an accepted route exists, authority alone is insufficient: the
    // objective must have an accepted formal-checkpoint route item and that
    // item must remain launchable on the current Agenda. Question generation
    // itself remains launch-time work, but the path cannot be absent.
    if (!route?.studyPlan || !route.agenda) {
      readyObjectiveIds.push(objective.id);
      continue;
    }
    const planItem = route.studyPlan.items.find(
      (item) => item.kind === 'formal_checkpoint' && item.objectiveIds.includes(objective.id),
    );
    if (!planItem) {
      blockedObjectiveIds.push(objective.id);
      continue;
    }
    const planLaunch = repos.studyPlans
      .listLaunchValidations(route.studyPlan.id)
      .find((entry) => entry.planItemId === planItem.id);
    if (
      !planLaunch ||
      planLaunch.launch.status !== 'launchable' ||
      planLaunch.launch.capability !== 'assessment'
    ) {
      blockedObjectiveIds.push(objective.id);
      continue;
    }
    const agendaItem = route.agenda.items.find(
      (item) => item.linkedPlanItemId === planItem.id && item.kind === 'formal_checkpoint',
    );
    if (!agendaItem || agendaItem.launch.status !== 'launchable') {
      blockedObjectiveIds.push(objective.id);
      continue;
    }
    readyObjectiveIds.push(objective.id);
  }
  const unresolvedIds = [...pendingObjectiveIds, ...blockedObjectiveIds].sort();
  return {
    status:
      blockedObjectiveIds.length > 0
        ? 'blocked'
        : pendingObjectiveIds.length > 0
          ? 'pending'
          : 'ready',
    requiredObjectiveCount: required.length,
    readyObjectiveCount: readyObjectiveIds.length,
    unresolvedObjectiveIds: unresolvedIds,
    teachingOnlyObjectiveIds: unresolvedIds,
  };
}
