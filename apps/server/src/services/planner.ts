import {
  ApiErrorCode,
  type Concept,
  type Quiz,
  type QuizConfig,
  type QuestionType,
  type RemediationPlan,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { validatePlanProposal } from './planValidation.js';
import type {
  LlmProvider,
  PlanNeighbor,
  PlanOpenMistake,
  ProviderCallOptions,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { QuizService } from './quizzes.js';
import type { RemediationService } from './remediation.js';

export interface PlannerServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  quizzes: QuizService;
  remediation: RemediationService;
}

export interface PlanLaunchResult {
  quiz: Quiz;
  /** 'remediation' re-tests open mistakes; 'practice' is a focused quiz. */
  mode: 'remediation' | 'practice';
}

const MAX_PLAN_PREREQS = 5;
const MAX_PLAN_NEIGHBORS = 8;
const MAX_PLAN_MISTAKES = 10;

export function createPlannerService({
  repos,
  provider,
  clock,
  quizzes,
  remediation,
}: PlannerServiceDeps) {
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

  /** Direct prerequisite/neighbor concepts of `conceptId` in the active graph. */
  function graphContext(workspaceId: string, conceptId: string) {
    const workspace = repos.workspaces.get(workspaceId)!;
    const prerequisites: Concept[] = [];
    const neighbors: PlanNeighbor[] = [];
    if (!workspace.activeGraphVersionId) return { prerequisites, neighbors };

    const edges = repos.graph.getEdges(workspace.activeGraphVersionId);
    const seen = new Set<string>([conceptId]);
    for (const edge of edges) {
      const isIncoming = edge.targetConceptId === conceptId;
      const isOutgoing = edge.sourceConceptId === conceptId;
      if (!isIncoming && !isOutgoing) continue;
      const otherId = isIncoming ? edge.sourceConceptId : edge.targetConceptId;
      if (seen.has(otherId)) continue;
      const other = repos.materials.getConcept(otherId);
      if (!other) continue;
      seen.add(otherId);
      if (edge.relation === 'prerequisite' && isIncoming) {
        if (prerequisites.length < MAX_PLAN_PREREQS) prerequisites.push(other);
      } else if (neighbors.length < MAX_PLAN_NEIGHBORS) {
        neighbors.push({
          concept: other,
          relation: edge.relation,
          direction: isIncoming ? 'in' : 'out',
        });
      }
    }
    return { prerequisites, neighbors };
  }

  return {
    /**
     * Generate a remediation plan for one selected concept.
     *
     * The planner input is bounded locally (direct prerequisites, direct
     * neighbors, capped mistake list); the proposal is schema-validated by
     * the provider layer and then locally validated here: every target must
     * be a workspace concept, the selected concept (or one of its direct
     * prerequisites) must stay central, every target reason must retain at
     * least one verified evidence quote, and question types must be ones the
     * existing assessment engine supports. An invalid proposal throws and
     * NEVER replaces a previously accepted plan. Accepting a plan writes no
     * learning state — mastery/mistakes only change via real graded activity.
     */
    async generatePlan(
      workspaceId: string,
      conceptId: string,
      opts?: ProviderCallOptions,
    ): Promise<RemediationPlan> {
      const selected = requireWorkspaceConcept(workspaceId, conceptId);
      const workspace = repos.workspaces.get(workspaceId)!;
      const { prerequisites, neighbors } = graphContext(workspaceId, conceptId);

      const involved = [selected, ...prerequisites, ...neighbors.map((n) => n.concept)];
      const involvedIds = new Set(involved.map((c) => c.id));
      const materialIds = [...new Set(involved.map((c) => c.materialId))];
      const blocks = materialIds.flatMap((id) => repos.materials.getBlocks(id));

      const masteryStates = repos.mastery
        .listByWorkspace(workspaceId)
        .filter((m) => involvedIds.has(m.conceptId));
      const openMistakes: PlanOpenMistake[] = repos.mistakes
        .listOpenByWorkspace(workspaceId)
        .filter((m) => involvedIds.has(m.conceptId))
        .slice(0, MAX_PLAN_MISTAKES)
        .map((m) => ({ conceptId: m.conceptId, stem: m.question.stem, score: m.score }));
      const usedQuestionTypes = [
        ...new Set(
          repos.mistakes
            .listOpenByWorkspace(workspaceId)
            .filter((m) => involvedIds.has(m.conceptId))
            .map((m) => m.question.type),
        ),
      ];

      const proposal = await provider.proposeRemediationPlan(
        {
          workspaceName: workspace.name,
          selected,
          prerequisites,
          neighbors,
          blocks,
          masteryStates,
          openMistakes,
          usedQuestionTypes,
        },
        {
          ...opts,
          telemetry: { workspaceId, operationType: 'propose_remediation_plan' },
        },
      );

      // ---- Local deterministic validation (fail closed, keep old plan) ----
      // Shared with the Tutor finalize path so both flows enforce identical
      // rules (see services/planValidation.ts).
      const conceptById = new Map(
        repos.materials.getConceptsByWorkspace(workspaceId).map((c) => [c.id, c]),
      );
      const { targets, steps } = validatePlanProposal(proposal, {
        conceptById,
        blocks,
        selectedId: selected.id,
        prerequisiteIds: new Set(prerequisites.map((p) => p.id)),
      });

      const plan: RemediationPlan = {
        id: newId('plan'),
        workspaceId,
        conceptId: selected.id,
        summary: proposal.summary,
        weaknessHypothesis: proposal.weaknessHypothesis,
        strategy: proposal.strategy,
        difficulty: proposal.difficulty,
        questionTypes: [...new Set(proposal.questionTypes)],
        steps,
        targets,
        provider: provider.name,
        createdAt: clock.now().toISOString(),
      };
      repos.graph.upsertPlan(plan);
      return repos.graph.getPlan(workspaceId, selected.id)!;
    },

    getPlan(workspaceId: string, conceptId: string): RemediationPlan | null {
      requireWorkspaceConcept(workspaceId, conceptId);
      return repos.graph.getPlan(workspaceId, conceptId) ?? null;
    },

    /**
     * Launch the existing assessment workflow from an accepted plan.
     *
     * When plan targets still have open mistakes, this generates a true
     * remediation quiz (existing service, filtered to the plan's targets) on
     * the document with the most open targeted mistakes. Otherwise it
     * preconfigures a focused practice quiz on the selected concept's
     * document using the plan's difficulty/question types. Grading, mistake
     * resolution and mastery updates then flow through the existing
     * deterministic pipeline unchanged.
     */
    async launch(
      workspaceId: string,
      planId: string,
      opts?: ProviderCallOptions,
    ): Promise<PlanLaunchResult> {
      if (!repos.workspaces.get(workspaceId)) throw notFound(`课程空间不存在:${workspaceId}`);
      const plan = repos.graph.getPlanById(planId);
      if (!plan || plan.workspaceId !== workspaceId) {
        throw notFound(`康复计划不存在:${planId}`);
      }

      const targetIds = new Set(plan.targets.map((t) => t.conceptId));
      const openByMaterial = new Map<string, number>();
      for (const mistake of repos.mistakes.listOpenByWorkspace(workspaceId)) {
        if (!targetIds.has(mistake.conceptId)) continue;
        openByMaterial.set(mistake.materialId, (openByMaterial.get(mistake.materialId) ?? 0) + 1);
      }

      if (openByMaterial.size > 0) {
        // Deterministic: most open targeted mistakes, id as tie-breaker.
        const materialId = [...openByMaterial.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0]![0];
        const quiz = await remediation.generate(materialId, opts, [...targetIds]);
        return { quiz, mode: 'remediation' };
      }

      const selected = repos.materials.getConcept(plan.conceptId);
      if (!selected) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          '计划中的选中概念已不存在,请重新生成计划。',
        );
      }
      const materialConcepts = repos.materials.getConcepts(selected.materialId);
      const localTargets = materialConcepts.filter((c) => targetIds.has(c.id)).map((c) => c.id);
      const types: QuestionType[] = plan.questionTypes;
      const config: QuizConfig = {
        difficulty: plan.difficulty,
        types,
        countPerType: 1,
      };
      const quiz = await quizzes.generate(selected.materialId, config, opts, {
        targetConceptIds: localTargets.length > 0 ? localTargets : [selected.id],
      });
      return { quiz, mode: 'practice' };
    },
  };
}

export type PlannerService = ReturnType<typeof createPlannerService>;
