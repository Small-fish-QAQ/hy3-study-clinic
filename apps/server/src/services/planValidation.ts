import {
  ApiErrorCode,
  MAX_PLAN_TARGETS,
  MAX_PLAN_TARGET_EVIDENCE,
  type Concept,
  type PlanStep,
  type PlanTarget,
  type RemediationPlanProposalPayload,
  type SourceBlock,
  type VerifiedGrounding,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';

export interface PlanValidationContext {
  /** Every concept of the workspace (the only legal target/step ids). */
  conceptById: Map<string, Concept>;
  /** Evidence search space (blocks of the involved documents). */
  blocks: SourceBlock[];
  /** The selected concept the plan is for. */
  selectedId: string;
  /** Direct prerequisite ids of the selected concept. */
  prerequisiteIds: ReadonlySet<string>;
  /** Override of the target cap (Tutor uses 3; planner default 4). */
  maxTargets?: number;
}

export interface ValidatedPlanParts {
  targets: PlanTarget[];
  steps: PlanStep[];
  rejectedTargets: Array<{ conceptId: string; reason: string }>;
  /** Evidence records dropped from otherwise-accepted targets. */
  droppedEvidenceCount: number;
}

/**
 * Deterministic local validation of a model-proposed learning plan — shared
 * by the remediation planner and the Tutor's finalize step so both flows
 * enforce IDENTICAL rules: every target must be a workspace concept with at
 * least one verified evidence quote, the selected concept (or one of its
 * direct prerequisites) must stay central, and step concept references are
 * nulled when unknown. Throws (fail closed) when nothing valid remains.
 */
export function validatePlanProposal(
  proposal: RemediationPlanProposalPayload,
  ctx: PlanValidationContext,
): ValidatedPlanParts {
  const maxTargets = ctx.maxTargets ?? MAX_PLAN_TARGETS;
  const rejectedTargets: Array<{ conceptId: string; reason: string }> = [];
  const targets: PlanTarget[] = [];
  const seenTargets = new Set<string>();
  let droppedEvidenceCount = 0;

  for (const target of proposal.targets.slice(0, maxTargets)) {
    if (seenTargets.has(target.conceptId)) continue;
    const concept = ctx.conceptById.get(target.conceptId);
    if (!concept) {
      rejectedTargets.push({
        conceptId: target.conceptId,
        reason: '未知概念或不属于该课程空间',
      });
      continue;
    }
    const evidence: VerifiedGrounding[] = [];
    for (const proposed of target.evidence.slice(0, MAX_PLAN_TARGET_EVIDENCE)) {
      const verification = verifyGrounding(ctx.blocks, {
        blockId: proposed.blockId,
        quote: proposed.quote,
      });
      if (verification.ok) evidence.push(verification.grounding);
      else droppedEvidenceCount++;
    }
    if (evidence.length === 0) {
      rejectedTargets.push({ conceptId: target.conceptId, reason: '理由缺少可验证的原文依据' });
      continue;
    }
    seenTargets.add(target.conceptId);
    targets.push({
      conceptId: concept.id,
      conceptName: concept.name,
      reason: target.reason,
      evidence,
    });
  }

  const central = targets.some(
    (t) => t.conceptId === ctx.selectedId || ctx.prerequisiteIds.has(t.conceptId),
  );
  if (targets.length === 0 || !central) {
    throw new AppError(
      ApiErrorCode.GroundingFailed,
      '康复计划未通过本地校验(目标概念或原文依据不合法),已保留原有计划。请重试。',
      { rejectedTargets },
    );
  }

  const steps: PlanStep[] = proposal.steps.map((step, index) => ({
    index,
    description: step.description,
    conceptId: step.conceptId && ctx.conceptById.has(step.conceptId) ? step.conceptId : null,
  }));

  return { targets, steps, rejectedTargets, droppedEvidenceCount };
}
