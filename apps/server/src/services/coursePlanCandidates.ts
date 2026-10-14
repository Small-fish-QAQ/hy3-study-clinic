import {
  COURSE_POLICY,
  type CourseKnowledgeInventory,
  type CoursePreferences,
} from '@hy3-clinic/shared';
import { PlanOutputSchema, type PlanOutput } from '../llm/courseContract.js';
import type { ClinicRepository } from '../repositories/clinic.js';
import type { CourseOperationContext } from './courseOperationRunner.js';
import type { PlanIssue } from './courseValidation.js';
import { AppError } from '../errors.js';
import { canonical, sha256, stableId } from '../util/canonical.js';

export interface PlanningCandidate {
  value: PlanOutput;
  callIds: string[];
}
export interface SavedPlanningCandidate extends PlanningCandidate {
  id: string;
  parentId: string | null;
  findings: PlanIssue[];
}
export const planningProviderSnapshot = (ctx: CourseOperationContext, method: string) => ({
  provider: ctx.provider.name,
  model: ctx.provider.model ?? null,
  endpoint: ctx.provider.endpointIdentity ?? null,
  reasoning: ctx.provider.runtimeIdentityFor?.(method) ?? ctx.provider.runtimeIdentity ?? null,
});
export function planningRequestKey(
  ctx: CourseOperationContext,
  inventory: CourseKnowledgeInventory,
  title: string,
  preferences?: CoursePreferences,
) {
  return sha256({
    normalization: 'authored-objective-demand-v1',
    inventory: sha256(inventory),
    title,
    preferences: preferences ?? null,
    provider: planningProviderSnapshot(ctx, 'generateCoursePlan'),
    policy: COURSE_POLICY,
  });
}
export function assertPlanningOrigin(
  repo: ClinicRepository,
  ctx: CourseOperationContext,
  callIds: string[],
): void {
  if (!callIds.length) throw new AppError('GROUNDING_FAILED', '规划候选缺少物理生成出处。');
  for (const id of callIds) {
    const row = repo.row<{
      workspace_id: string;
      method: string;
      status: string;
      provider_snapshot: string;
      candidate_hash: string;
      payload: string;
      generation_key: string;
      call_key: string;
    }>(
      `SELECT c.workspace_id,c.method,c.status,c.provider_snapshot,s.candidate_hash,s.payload,s.generation_key,c.generation_key AS call_key FROM llm_calls c JOIN semantic_cache s ON json_extract(s.payload,'$.callId')=c.id JOIN llm_physical_attempts p ON p.id=s.physical_attempt_id AND p.logical_call_id=c.id AND p.status='completed' WHERE c.id=?`,
      id,
    );
    if (
      !row ||
      row.workspace_id !== ctx.workspaceId ||
      row.status !== 'completed' ||
      !['generateCoursePlan', 'reviseCoursePlan'].includes(row.method) ||
      row.call_key !== row.generation_key ||
      sha256(JSON.parse(row.provider_snapshot)) !==
        sha256(planningProviderSnapshot(ctx, row.method))
    )
      throw new AppError('GROUNDING_FAILED', '规划候选物理出处或模型身份校验失败。');
    const envelope = JSON.parse(row.payload) as {
      value: unknown;
      originalProviderSnapshot: unknown;
    };
    if (
      sha256(envelope.value) !== row.candidate_hash ||
      sha256(envelope.originalProviderSnapshot) !== sha256(JSON.parse(row.provider_snapshot))
    )
      throw new AppError('GROUNDING_FAILED', '规划候选内容完整性校验失败。');
  }
}
export function savePlanningCandidate(
  repo: ClinicRepository,
  ctx: CourseOperationContext,
  inventory: CourseKnowledgeInventory,
  key: string,
  candidate: PlanningCandidate,
  findings: PlanIssue[],
  parentId: string | null = null,
): SavedPlanningCandidate {
  // A cancelled operation may retain physical output in semantic_cache, but never publish a plan.
  ctx.check();
  assertPlanningOrigin(repo, ctx, candidate.callIds);
  const value = PlanOutputSchema.parse(candidate.value);
  const hash = sha256(value);
  const id = stableId('plan_candidate', {
    workspace: ctx.workspaceId,
    inventory: inventory.id,
    key,
    hash,
    parentId,
    callIds: candidate.callIds,
    findings,
  });
  const saved = { id, value, callIds: candidate.callIds, parentId, findings };
  repo.run(
    'INSERT OR IGNORE INTO course_plan_candidates VALUES(?,?,?,?,?,?,?,?)',
    id,
    ctx.workspaceId,
    inventory.id,
    key,
    parentId,
    hash,
    canonical(saved),
    repo.now(),
  );
  return saved;
}
export function latestPlanningCandidate(
  repo: ClinicRepository,
  ctx: CourseOperationContext,
  inventory: CourseKnowledgeInventory,
  key: string,
): SavedPlanningCandidate | null {
  const rows = repo.rows<{
    id: string;
    parent_id: string | null;
    candidate_hash: string;
    payload: string;
  }>(
    'SELECT id,parent_id,candidate_hash,payload FROM course_plan_candidates WHERE workspace_id=? AND inventory_id=? AND request_key=? ORDER BY created_at DESC,rowid DESC',
    ctx.workspaceId,
    inventory.id,
    key,
  );
  for (const row of rows) {
    const saved = JSON.parse(row.payload) as SavedPlanningCandidate;
    if (
      saved.id !== row.id ||
      saved.parentId !== row.parent_id ||
      sha256(saved.value) !== row.candidate_hash
    )
      throw new AppError('GROUNDING_FAILED', '保存的规划候选身份或完整性校验失败。');
    if (
      saved.parentId &&
      !repo.row(
        'SELECT id FROM course_plan_candidates WHERE id=? AND workspace_id=? AND inventory_id=? AND request_key=?',
        saved.parentId,
        ctx.workspaceId,
        inventory.id,
        key,
      )
    )
      throw new AppError('GROUNDING_FAILED', '规划修订候选缺少同范围父候选。');
    assertPlanningOrigin(repo, ctx, saved.callIds);
    return { ...saved, value: PlanOutputSchema.parse(saved.value) };
  }
  return null;
}
/** Upgrade legacy complete candidates from their real operation context, including revised ones. */
export function legacyPlanningCandidate(
  repo: ClinicRepository,
  ctx: CourseOperationContext,
  inventory: CourseKnowledgeInventory,
  preferences?: CoursePreferences,
): PlanningCandidate | null {
  const rows = repo.rows<{ payload: string; request_payload: string }>(
    `SELECT s.payload,o.request_payload FROM semantic_cache s JOIN llm_calls c ON c.id=json_extract(s.payload,'$.callId') JOIN agent_operations o ON o.id=c.operation_id WHERE s.workspace_id=? AND s.source_scope_hash=? AND c.method='generateCoursePlan' AND c.status='completed' AND o.kind='preparePlan' ORDER BY c.created_at DESC,c.rowid DESC`,
    ctx.workspaceId,
    inventory.sourceScopeHash,
  );
  for (const row of rows) {
    const request = JSON.parse(row.request_payload) as {
      sourceScopeHash: string;
      preferences?: CoursePreferences;
    };
    if (
      request.sourceScopeHash !== inventory.sourceScopeHash ||
      sha256(request.preferences ?? null) !== sha256(preferences ?? null)
    )
      continue;
    const envelope = JSON.parse(row.payload) as {
      value: unknown;
      callId: string;
      originalProviderSnapshot: unknown;
    };
    if (
      sha256(envelope.originalProviderSnapshot) !==
      sha256(planningProviderSnapshot(ctx, 'generateCoursePlan'))
    )
      continue;
    const parsed = PlanOutputSchema.safeParse(envelope.value);
    if (!parsed.success) continue;
    const known = new Set(inventory.knowledge.map((k) => k.id));
    const assigned = new Set(parsed.data.lessons.flatMap((l) => l.knowledgeIds));
    // A legacy partial patch cannot stand in for its missing parent.
    if (
      [...assigned].some((id) => !known.has(id)) ||
      inventory.knowledge.some((k) => k.origin === 'textbook' && !assigned.has(k.id))
    )
      continue;
    assertPlanningOrigin(repo, ctx, [envelope.callId]);
    return { value: parsed.data, callIds: [envelope.callId] };
  }
  return null;
}
