import {
  TUTOR_LIMITS,
  type Concept,
  type RemediationPlan,
  type TutorEvent,
  type TutorEventKind,
  type TutorRun,
  type VerifiedGrounding,
} from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import type {
  LlmProvider,
  ProviderCallOptions,
  TutorObservation,
  TutorStepInput,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import {
  boundObservation,
  executeTutorTool,
  toolCatalog,
  ToolValidationError,
  type TutorToolContext,
} from '../tutor/tools.js';
import { validatePlanProposal } from './planValidation.js';

export interface TutorServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  providerModel?: string | undefined;
}

export interface TutorSessionOptions extends ProviderCallOptions {
  /** Live event sink (timeline streaming); every event is also persisted. */
  onEvent?: (event: TutorEvent) => void;
}

export interface TutorSessionResult {
  run: TutorRun;
  events: TutorEvent[];
}

/**
 * The bounded Hy3 Tutor loop.
 *
 * Explicit budgets (TUTOR_LIMITS, all tested): max 6 planning iterations,
 * max 12 executed tool calls, max 3 final target concepts, max 8 blocks per
 * search, max 20 retained evidence records, bounded observation size. No
 * recursion, no sub-agents, no retries beyond the provider's own single
 * bounded repair. The model only ever selects whitelisted read-only tools
 * or finalizes; deterministic local code validates every request, executes
 * every tool, composes every timeline event, and persists the final plan
 * through the SAME validator as the remediation planner. A run that fails,
 * is cancelled, or is interrupted changes no learning state whatsoever.
 */
export function createTutorService({ repos, provider, clock, providerModel }: TutorServiceDeps) {
  function requireWorkspaceConcept(workspaceId: string, conceptId: string): Concept {
    if (!repos.workspaces.get(workspaceId)) throw notFound(`课程空间不存在:${workspaceId}`);
    const concept = repos.materials.getConcept(conceptId);
    if (!concept) throw notFound(`概念不存在:${conceptId}`);
    const material = repos.materials.get(concept.materialId);
    if (!material || material.workspaceId !== workspaceId) {
      throw notFound(`该课程空间下不存在此概念:${conceptId}`);
    }
    return concept;
  }

  return {
    /** Pre-flight validation so routes can 404 before hijacking the reply. */
    ensureSessionInput(workspaceId: string, conceptId: string): void {
      requireWorkspaceConcept(workspaceId, conceptId);
    },

    async runSession(
      workspaceId: string,
      conceptId: string,
      opts: TutorSessionOptions = {},
    ): Promise<TutorSessionResult> {
      const selected = requireWorkspaceConcept(workspaceId, conceptId);
      const workspace = repos.workspaces.get(workspaceId)!;
      const startedAt = clock.now().toISOString();

      let run: TutorRun = {
        id: newId('tut'),
        workspaceId,
        conceptId: selected.id,
        conceptName: selected.name,
        status: 'running',
        iterations: 0,
        toolCallCount: 0,
        acceptedEvidence: [],
        planId: null,
        activity: null,
        errorMessage: null,
        provider: provider.name,
        providerModel: provider.name === 'hy3' ? (providerModel ?? null) : null,
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      repos.tutor.insertRun(run);

      const events: TutorEvent[] = [];
      let seq = 0;
      const emit = (kind: TutorEventKind, summary: string, detail?: TutorEvent['detail']): void => {
        const event: TutorEvent = {
          id: newId('tev'),
          runId: run.id,
          seq: seq++,
          kind,
          summary,
          ...(detail ? { detail } : {}),
          createdAt: clock.now().toISOString(),
        };
        repos.tutor.insertEvent(event);
        events.push(event);
        opts.onEvent?.(event);
      };

      const save = (patch: Partial<TutorRun>): void => {
        run = { ...run, ...patch, updatedAt: clock.now().toISOString() };
        repos.tutor.updateRun(run);
      };

      emit('session_started', `Hy3 辅导会话开始:围绕「${selected.name}」制定学习计划。`, {
        conceptIds: [selected.id],
      });

      const toolCtx: TutorToolContext = { workspaceId, repos, clock, selected };
      const observations: TutorObservation[] = [];
      const allowedConceptIds = repos.materials
        .getConceptsByWorkspace(workspaceId)
        .map((c) => c.id);
      let gapEmitted = false;

      const buildStepInput = (): TutorStepInput => {
        const mastery = repos.mastery.get(selected.materialId, selected.id);
        const mistakes = repos.mistakes
          .countsByConceptForWorkspace(workspaceId)
          .get(selected.id) ?? { open: 0, resolved: 0 };
        const misconceptions = repos.misconceptions
          .countsByConceptForWorkspace(workspaceId)
          .get(selected.id) ?? { conceptId: selected.id, proposed: 0, confirmed: 0 };
        const review = repos.review.get(workspaceId, selected.id);
        return {
          workspaceName: workspace.name,
          selected,
          stateSummary: {
            mastery: mastery?.mastery ?? null,
            attempts: mastery?.attempts ?? 0,
            openMistakes: mistakes.open,
            proposedMisconceptions: misconceptions.proposed,
            confirmedMisconceptions: misconceptions.confirmed,
            reviewDue: review ? new Date(review.dueAt).getTime() <= clock.now().getTime() : false,
          },
          tools: toolCatalog(),
          observations,
          remainingIterations: TUTOR_LIMITS.maxIterations - run.iterations,
          remainingToolCalls: TUTOR_LIMITS.maxToolCalls - run.toolCallCount,
          allowedConceptIds,
          reviewItems: repos.review
            .listByWorkspace(workspaceId)
            .slice(0, 10)
            .map((i) => ({ conceptId: i.conceptId, dueAt: i.dueAt, lastRating: i.lastRating })),
        };
      };

      try {
        while (run.iterations < TUTOR_LIMITS.maxIterations) {
          if (opts.signal?.aborted) throw ProviderError.cancelled();

          const step = await provider.proposeTutorStep(buildStepInput(), { signal: opts.signal });
          save({ iterations: run.iterations + 1 });

          if (step.action === 'call_tool') {
            if (run.toolCallCount >= TUTOR_LIMITS.maxToolCalls) {
              emit(
                'tool_rejected',
                `工具调用预算已用完(上限 ${TUTOR_LIMITS.maxToolCalls} 次),要求直接生成计划。`,
                {
                  toolName: step.tool,
                  valid: false,
                },
              );
              observations.push({
                iteration: run.iterations,
                tool: step.tool,
                purpose: step.purpose,
                resultSummary: '工具调用预算已用完,必须立即 finalize。',
              });
              continue;
            }

            emit('tool_requested', `请求工具 ${step.tool}:${step.purpose}`, {
              toolName: step.tool,
              iteration: run.iterations,
            });

            let result;
            try {
              result = executeTutorTool(toolCtx, step.tool, step.arguments);
            } catch (error) {
              if (error instanceof ToolValidationError) {
                emit('tool_rejected', `工具请求被拒绝:${error.message}`, {
                  toolName: step.tool,
                  valid: false,
                });
                observations.push({
                  iteration: run.iterations,
                  tool: step.tool,
                  purpose: step.purpose,
                  resultSummary: `请求被本地校验拒绝:${error.message}`,
                });
                continue;
              }
              throw error;
            }

            save({ toolCallCount: run.toolCallCount + 1 });
            observations.push({
              iteration: run.iterations,
              tool: step.tool,
              purpose: step.purpose,
              resultSummary: boundObservation(result.data),
            });

            emit(result.semanticEvent ?? 'tool_validated', result.summary, {
              toolName: step.tool,
              valid: true,
              ...(result.resultCount !== undefined ? { resultCount: result.resultCount } : {}),
            });
            if (result.weakPrerequisites && result.weakPrerequisites.length > 0 && !gapEmitted) {
              gapEmitted = true;
              emit(
                'gap_identified',
                `发现薄弱前置概念:${result.weakPrerequisites.slice(0, 3).join('、')},计划将优先考虑前置修复。`,
              );
            }
            continue;
          }

          // ---- finalize ----
          const prerequisiteIds = new Set<string>();
          if (workspace.activeGraphVersionId) {
            for (const edge of repos.graph.getEdges(workspace.activeGraphVersionId)) {
              if (edge.relation === 'prerequisite' && edge.targetConceptId === selected.id) {
                prerequisiteIds.add(edge.sourceConceptId);
              }
            }
          }
          const conceptById = new Map(
            repos.materials.getConceptsByWorkspace(workspaceId).map((c) => [c.id, c]),
          );
          const blocks = repos.materials.getBlocksByWorkspace(workspaceId);

          const { targets, steps, droppedEvidenceCount } = validatePlanProposal(step.plan, {
            conceptById,
            blocks,
            selectedId: selected.id,
            prerequisiteIds,
            maxTargets: TUTOR_LIMITS.maxTargetConcepts,
          });

          const acceptedEvidence: VerifiedGrounding[] = targets
            .flatMap((t) => t.evidence)
            .slice(0, TUTOR_LIMITS.maxRetainedEvidence);
          emit('evidence_accepted', `${acceptedEvidence.length} 条计划依据通过本地原文校验。`, {
            evidenceCount: acceptedEvidence.length,
            valid: true,
          });
          if (droppedEvidenceCount > 0) {
            emit('evidence_rejected', `${droppedEvidenceCount} 条依据未通过原文校验,已剔除。`, {
              evidenceCount: droppedEvidenceCount,
              valid: false,
            });
          }

          const activityConceptIds = step.activity.conceptIds
            .filter((id) => conceptById.has(id))
            .slice(0, TUTOR_LIMITS.maxTargetConcepts);
          const activity =
            activityConceptIds.length > 0
              ? { mode: step.activity.mode, conceptIds: activityConceptIds }
              : { mode: step.activity.mode, conceptIds: [selected.id] };

          emit(
            'strategy_selected',
            `选定学习策略:${step.plan.strategy}(难度 ${step.plan.difficulty})。`,
          );

          const plan: RemediationPlan = {
            id: newId('plan'),
            workspaceId,
            conceptId: selected.id,
            summary: step.plan.summary,
            weaknessHypothesis: step.plan.weaknessHypothesis,
            strategy: step.plan.strategy,
            difficulty: step.plan.difficulty,
            questionTypes: [...new Set(step.plan.questionTypes)],
            steps,
            targets,
            provider: provider.name,
            createdAt: clock.now().toISOString(),
          };
          repos.graph.upsertPlan(plan);
          const stored = repos.graph.getPlan(workspaceId, selected.id)!;

          emit('plan_accepted', `学习计划通过本地校验:${plan.summary}`, {
            conceptIds: targets.map((t) => t.conceptId),
            evidenceCount: acceptedEvidence.length,
          });

          save({
            status: 'completed',
            planId: stored.id,
            activity,
            acceptedEvidence,
          });
          emit('session_completed', '辅导会话完成,可以开始推荐的学习活动。');
          return { run, events };
        }

        // Iteration budget exhausted without a finalize.
        save({
          status: 'failed',
          errorMessage: `已达最大规划轮次(${TUTOR_LIMITS.maxIterations}),模型未给出最终计划。`,
        });
        emit('session_failed', '辅导会话失败:规划轮次预算耗尽,未产生最终计划。学习状态未受影响。');
        return { run, events };
      } catch (error) {
        if (
          (error instanceof ProviderError && error.code === 'REQUEST_CANCELLED') ||
          opts.signal?.aborted
        ) {
          save({ status: 'cancelled', errorMessage: null });
          emit('session_cancelled', '辅导会话已取消。学习状态未受影响。');
          return { run, events };
        }
        const message = error instanceof Error ? error.message.slice(0, 500) : '辅导会话失败。';
        save({ status: 'failed', errorMessage: message });
        emit('session_failed', `辅导会话失败:${message} 学习状态未受影响。`);
        return { run, events };
      }
    },

    getRun(workspaceId: string, runId: string): TutorSessionResult {
      if (!repos.workspaces.get(workspaceId)) throw notFound(`课程空间不存在:${workspaceId}`);
      const run = repos.tutor.getRun(runId);
      if (!run || run.workspaceId !== workspaceId) throw notFound(`辅导会话不存在:${runId}`);
      return { run, events: repos.tutor.listEvents(runId) };
    },

    listRuns(workspaceId: string): TutorRun[] {
      if (!repos.workspaces.get(workspaceId)) throw notFound(`课程空间不存在:${workspaceId}`);
      return repos.tutor.listRuns(workspaceId);
    },
  };
}

export type TutorService = ReturnType<typeof createTutorService>;
