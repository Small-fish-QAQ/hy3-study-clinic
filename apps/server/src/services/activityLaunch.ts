import type {
  AssessmentMode,
  Concept,
  CreateAssessmentRequest,
  MisconceptionRecord,
  TutorActivity,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';

/**
 * Deterministic activity-launch capability resolver.
 *
 * An AssessmentMode being a legal enum value does NOT make it executable in
 * the current workspace/learner state. This module is the single place that
 * decides executability. It is consumed three times:
 *
 * 1. Tutor finalize — only launchable modes are offered to the model, the
 *    model's chosen activity is validated, and invalid recommendations are
 *    deterministically downgraded (with an auditable activity_adjusted event);
 * 2. queue composition — every returned queue item carries a launch request
 *    that this resolver produced, so listed items are launchable when listed;
 * 3. the Tutor run-activity launch route — the persisted recommendation is
 *    re-resolved against CURRENT state at click time.
 *
 * The assessment service's own selectTargets stays as the final gate; this
 * resolver never weakens it, it only prevents predictable failures earlier.
 */

export interface ActivityCapabilityOk {
  ok: true;
  /** Mode-specific launch request accepted by POST /assessments. */
  launch: CreateAssessmentRequest;
}

export interface ActivityCapabilityRejected {
  ok: false;
  /** Concise Chinese reason, safe to show to the learner. */
  reason: string;
}

export type ActivityCapability = ActivityCapabilityOk | ActivityCapabilityRejected;

export interface ResolvedActivityLaunch {
  launch: CreateAssessmentRequest;
  /** Set when the requested mode was substituted by the fallback chain. */
  adjusted: { originalMode: AssessmentMode; reason: string } | null;
}

/** Local end of the current day (queue and named-review share this bound). */
export function endOfToday(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

function workspaceConcept(
  repos: Repositories,
  workspaceId: string,
  conceptId: string,
): Concept | null {
  const concept = repos.materials.getConcept(conceptId);
  if (!concept) return null;
  const material = repos.materials.get(concept.materialId);
  if (!material || material.workspaceId !== workspaceId) return null;
  return concept;
}

function validWorkspaceConceptIds(
  repos: Repositories,
  workspaceId: string,
  conceptIds: readonly string[],
): string[] {
  return conceptIds.filter((id) => workspaceConcept(repos, workspaceId, id) !== null).slice(0, 3);
}

function isActionable(record: MisconceptionRecord): boolean {
  return record.status === 'proposed' || record.status === 'confirmed';
}

/** Oldest actionable misconception among the given concepts (deterministic). */
export function findActionableMisconception(
  repos: Repositories,
  workspaceId: string,
  conceptIds: readonly string[],
): MisconceptionRecord | undefined {
  const wanted = new Set(conceptIds);
  return repos.misconceptions
    .listByWorkspace(workspaceId)
    .filter((r) => isActionable(r) && wanted.has(r.conceptId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
}

/** Whether one of the concepts has an accepted cross-document alignment sibling. */
function hasCrossDocumentCapability(
  repos: Repositories,
  workspaceId: string,
  conceptIds: readonly string[],
): boolean {
  for (const conceptId of conceptIds) {
    const concept = workspaceConcept(repos, workspaceId, conceptId);
    if (!concept) continue;
    const member = repos.alignment.getMemberBySource(concept.id);
    if (!member) continue;
    for (const sibling of repos.alignment.getMembers(member.canonicalConceptId)) {
      if (sibling.sourceConceptId === concept.id) continue;
      const siblingConcept = repos.materials.getConcept(sibling.sourceConceptId);
      if (siblingConcept && siblingConcept.materialId !== concept.materialId) return true;
    }
  }
  return false;
}

/** Whether one of the concepts has a real prerequisite in the active graph. */
function hasPrerequisiteCapability(
  repos: Repositories,
  workspaceId: string,
  conceptIds: readonly string[],
): boolean {
  const workspace = repos.workspaces.get(workspaceId);
  if (!workspace?.activeGraphVersionId) return false;
  const targets = new Set(conceptIds);
  for (const edge of repos.graph.getEdges(workspace.activeGraphVersionId)) {
    if (edge.relation !== 'prerequisite' || !targets.has(edge.targetConceptId)) continue;
    if (targets.has(edge.sourceConceptId)) continue;
    if (repos.materials.getConcept(edge.sourceConceptId)) return true;
  }
  return false;
}

/**
 * Evaluate whether one activity intent is executable RIGHT NOW, and if so,
 * produce the concrete launch request. Never mutates anything.
 */
export function checkActivityCapability(
  repos: Repositories,
  clock: Clock,
  workspaceId: string,
  activity: { mode: AssessmentMode; conceptIds: readonly string[]; misconceptionId?: string },
): ActivityCapability {
  const conceptIds = validWorkspaceConceptIds(repos, workspaceId, activity.conceptIds);

  switch (activity.mode) {
    case 'diagnostic': {
      if (repos.materials.getConceptsByWorkspace(workspaceId).length === 0) {
        return { ok: false, reason: '课程空间还没有提取任何概念。' };
      }
      return { ok: true, launch: { mode: 'diagnostic' } };
    }

    case 'concept_practice': {
      if (conceptIds.length === 0) {
        return { ok: false, reason: '目标概念不存在或已被删除。' };
      }
      return { ok: true, launch: { mode: 'concept_practice', conceptIds } };
    }

    case 'prerequisite_repair': {
      if (conceptIds.length === 0) {
        return { ok: false, reason: '目标概念不存在或已被删除。' };
      }
      if (!hasPrerequisiteCapability(repos, workspaceId, conceptIds)) {
        return { ok: false, reason: '当前图谱中目标概念没有可用的前置概念。' };
      }
      return { ok: true, launch: { mode: 'prerequisite_repair', conceptIds } };
    }

    case 'review': {
      const now = clock.now();
      const successor = repos.reviewSuccessor.listCurrent(workspaceId);
      // Compatibility projection for pre-migration workspaces with no
      // successor targets; once successor state exists it is authoritative.
      const legacyFallback = successor.length === 0 ? repos.review.listByWorkspace(workspaceId) : [];
      if (conceptIds.length > 0) {
        // Named targets follow the queue's advertised semantics: anything due
        // by the end of today may be reviewed (slightly early is fine).
        const endOfDay = endOfToday(now).getTime();
        const eligible = conceptIds.filter((conceptId) => {
          const item = successor.find(({ target }) => target.id === conceptId);
          const legacy = legacyFallback.find((candidate) => candidate.conceptId === conceptId);
          return (item !== undefined && new Date(item.state.dueAt).getTime() <= endOfDay) ||
            (legacy !== undefined && new Date(legacy.dueAt).getTime() <= endOfDay);
        });
        if (eligible.length === 0) {
          return { ok: false, reason: '目标概念今天没有到期的复习安排。' };
        }
        return { ok: true, launch: { mode: 'review', conceptIds: eligible } };
      }
      const dueNow = successor.some(({ state }) => new Date(state.dueAt).getTime() <= now.getTime()) ||
        legacyFallback.some((item) => new Date(item.dueAt).getTime() <= now.getTime());
      if (!dueNow) {
        return { ok: false, reason: '当前没有到期的复习概念。' };
      }
      return { ok: true, launch: { mode: 'review' } };
    }

    case 'misconception_check': {
      if (activity.misconceptionId) {
        const record = repos.misconceptions.get(activity.misconceptionId);
        if (!record || record.workspaceId !== workspaceId) {
          return { ok: false, reason: '误区假设不存在或不属于当前课程空间。' };
        }
        if (record.status !== 'proposed' && record.status !== 'confirmed') {
          return { ok: false, reason: `该误区假设已处于终态(${record.status}),无需再判别。` };
        }
        return { ok: true, launch: { mode: 'misconception_check', misconceptionId: record.id } };
      }
      const bound = findActionableMisconception(repos, workspaceId, conceptIds);
      if (!bound) {
        return { ok: false, reason: '目标概念当前没有待判别的误区假设。' };
      }
      return { ok: true, launch: { mode: 'misconception_check', misconceptionId: bound.id } };
    }

    case 'cross_document': {
      if (conceptIds.length === 0) {
        return { ok: false, reason: '目标概念不存在或已被删除。' };
      }
      if (!hasCrossDocumentCapability(repos, workspaceId, conceptIds)) {
        return {
          ok: false,
          reason: '目标概念还没有已确认的跨文档对齐,无法构造真正的多文档证据。',
        };
      }
      return { ok: true, launch: { mode: 'cross_document', conceptIds } };
    }
  }
}

/**
 * Resolve an activity intent into a guaranteed launch request, downgrading
 * deterministically along the smallest safe fallback chain:
 * requested mode → concept_practice(valid concept) → diagnostic.
 * Returns null only when the workspace has no concepts at all.
 */
export function resolveActivityLaunch(
  repos: Repositories,
  clock: Clock,
  workspaceId: string,
  activity: TutorActivity,
): ResolvedActivityLaunch | null {
  const attempt = checkActivityCapability(repos, clock, workspaceId, activity);
  if (attempt.ok) return { launch: attempt.launch, adjusted: null };

  const adjusted = { originalMode: activity.mode, reason: attempt.reason };

  if (activity.mode !== 'concept_practice') {
    const conceptIds = validWorkspaceConceptIds(repos, workspaceId, activity.conceptIds);
    if (conceptIds.length > 0) {
      return { launch: { mode: 'concept_practice', conceptIds }, adjusted };
    }
  }
  const anyConcept = repos.materials.getConceptsByWorkspace(workspaceId)[0];
  if (!anyConcept) return null;
  if (activity.mode !== 'concept_practice') {
    return { launch: { mode: 'concept_practice', conceptIds: [anyConcept.id] }, adjusted };
  }
  return { launch: { mode: 'diagnostic' }, adjusted };
}

export interface LaunchableTutorMode {
  mode: AssessmentMode;
  /** One-line precondition note shown to the model (never to the learner). */
  note: string;
}

const MODE_NOTES: Record<AssessmentMode, string> = {
  diagnostic: '对课程空间做一次诊断评估。',
  concept_practice: '围绕目标概念的针对练习。',
  prerequisite_repair: '目标概念存在可练习的前置概念。',
  cross_document: '目标概念已有确认的跨文档对齐,可出多文档综合题。',
  review: '目标概念有今天到期的复习安排。',
  misconception_check: '存在待判别的误区假设,必须同时给出 misconceptionId。',
};

/**
 * The modes a Tutor session may legally recommend for the selected concept,
 * computed against current state. Offered to the model each iteration so it
 * cannot recommend a predictably unlaunchable activity.
 */
export function launchableTutorModes(
  repos: Repositories,
  clock: Clock,
  workspaceId: string,
  selectedConceptId: string,
): LaunchableTutorMode[] {
  const modes: AssessmentMode[] = [
    'concept_practice',
    'prerequisite_repair',
    'cross_document',
    'review',
    'misconception_check',
    'diagnostic',
  ];
  return modes
    .filter(
      (mode) =>
        checkActivityCapability(repos, clock, workspaceId, {
          mode,
          conceptIds: [selectedConceptId],
        }).ok,
    )
    .map((mode) => ({ mode, note: MODE_NOTES[mode] }));
}
