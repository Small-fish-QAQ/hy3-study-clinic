import {
  ApiErrorCode,
  CreateAssessmentRequestSchema,
  gradingMethodForType,
  MAX_ASSESSMENT_QUESTIONS,
  type AssessmentMode,
  type Concept,
  type EvidenceRepresentation,
  type MasteryChallengeFamily,
  type PublicBlueprint,
  type QuestionBlueprint,
  type Question,
  type QuestionType,
  type Quiz,
  type Rubric,
  type VerifiedGrounding,
  FormalScoringReviewSchema,
  FormalScoringChallengesSchema,
  type FormalScoringReviewInput,
  type TransferTask,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import { endOfToday } from './activityLaunch.js';
import { POINTS_BY_TYPE } from '../grading/score.js';
import { alignRubricToQuestion } from '../grading/rubricAlignment.js';
import type {
  AssessmentProposalInput,
  AssessmentTargetSummary,
  FormalAssessmentReviewFeedback,
  LlmProvider,
  ProviderCallOptions,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { MisconceptionsService } from './misconceptions.js';
import { createTelemetryProvider } from './providerTelemetry.js';
import { resolveReviewTargetContext } from './reviewSuccessor.js';
import {
  scoringFingerprint,
  scoringQuestionFingerprint,
  scoringReviewPassed,
  validateScoringReviewProposal,
} from './formalScoringReview.js';

export interface AssessmentServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  misconceptions: MisconceptionsService;
}

export interface AssessmentCreation {
  quiz: Quiz;
  blueprints: QuestionBlueprint[];
  rejected: Array<{ stem: string; reason: string }>;
}

interface AssessmentGenerationPolicy {
  priorExposure?: string[];
  formalReviewFeedback?: FormalAssessmentReviewFeedback[];
  learnerGeneratedTransfer?: boolean;
  learnerTransfer?: { prompt: string; task: TransferTask };
  previousPrompts?: string[];
  requiredRepresentation: EvidenceRepresentation | null;
  requestedChallengeFamily: MasteryChallengeFamily | null;
  objectiveCatalogue?: AssessmentProposalInput['objectiveCatalogue'];
  scoringAuthorityCatalogue?: AssessmentProposalInput['scoringAuthorityCatalogue'];
  teachingSurfaceCatalogue?: AssessmentProposalInput['teachingSurfaceCatalogue'];
}

/** Question types each assessment mode may draw on. */
const TYPES_BY_MODE: Record<AssessmentMode, QuestionType[]> = {
  diagnostic: ['single_choice', 'short_answer', 'concept_comparison'],
  concept_practice: ['single_choice', 'short_answer'],
  prerequisite_repair: ['single_choice', 'short_answer'],
  cross_document: ['single_choice', 'concept_comparison'],
  review: ['single_choice', 'short_answer', 'concept_comparison'],
  misconception_check: ['single_choice'],
};

const MAX_TARGETS = 6;

/**
 * Workspace-scoped (possibly cross-document) assessment generation.
 *
 * Deterministic local code selects the target concepts per mode, offers a
 * bounded summary to Hy3, then validates every returned blueprint+question
 * pair: workspace membership, allowed types, verified evidence, honest
 * cross-document scope (computed from VERIFIED evidence, never trusted from
 * the model), reasoning-step/evidence consistency, and answer-secrecy (the
 * public projection strips answers exactly like single-document quizzes).
 */
export function createAssessmentService({
  repos,
  provider,
  clock,
  misconceptions,
}: AssessmentServiceDeps) {
  const inferenceProvider = createTelemetryProvider({
    repos,
    clock,
    provider,
    providerGeneration: () => 1,
  });
  function requireWorkspace(workspaceId: string) {
    const workspace = repos.workspaces.get(workspaceId);
    if (!workspace) throw notFound(`课程空间不存在:${workspaceId}`);
    return workspace;
  }

  function requireWorkspaceConcept(workspaceId: string, conceptId: string): Concept {
    const concept = repos.materials.getConcept(conceptId);
    if (!concept) throw notFound(`概念不存在:${conceptId}`);
    const material = repos.materials.get(concept.materialId);
    if (!material || material.workspaceId !== workspaceId) {
      throw notFound(`该课程空间下不存在此概念:${conceptId}`);
    }
    return concept;
  }

  /** Deterministic target selection per assessment mode. */
  function selectTargets(
    workspaceId: string,
    mode: AssessmentMode,
    conceptIds: string[] | undefined,
    misconceptionId: string | undefined,
  ): { targets: Concept[]; misconceptionTarget: string | null } {
    if (mode === 'misconception_check') {
      if (!misconceptionId) {
        throw new AppError(ApiErrorCode.ValidationError, '误区判别评估必须指定 misconceptionId。');
      }
      const record = misconceptions.get(misconceptionId);
      if (record.workspaceId !== workspaceId) {
        throw notFound(`误区假设不存在:${misconceptionId}`);
      }
      if (record.status !== 'proposed' && record.status !== 'confirmed') {
        throw new AppError(
          ApiErrorCode.ValidationError,
          `该误区假设已处于终态(${record.status}),无需再判别。`,
        );
      }
      return {
        targets: [requireWorkspaceConcept(workspaceId, record.conceptId)],
        misconceptionTarget: record.id,
      };
    }

    if (
      mode === 'concept_practice' ||
      mode === 'cross_document' ||
      mode === 'prerequisite_repair'
    ) {
      if (!conceptIds || conceptIds.length === 0) {
        throw new AppError(ApiErrorCode.ValidationError, '该评估模式必须指定目标概念。');
      }
      const targets = conceptIds.map((id) => requireWorkspaceConcept(workspaceId, id));
      if (mode === 'prerequisite_repair') {
        const workspace = repos.workspaces.get(workspaceId)!;
        if (workspace.activeGraphVersionId) {
          const edges = repos.graph.getEdges(workspace.activeGraphVersionId);
          const targetIds = new Set(targets.map((t) => t.id));
          for (const edge of edges) {
            if (targets.length >= MAX_TARGETS) break;
            if (edge.relation !== 'prerequisite' || !targetIds.has(edge.targetConceptId)) continue;
            if (targetIds.has(edge.sourceConceptId)) continue;
            const prereq = repos.materials.getConcept(edge.sourceConceptId);
            if (prereq) {
              targets.push(prereq);
              targetIds.add(prereq.id);
            }
          }
        }
      }
      return { targets: targets.slice(0, MAX_TARGETS), misconceptionTarget: null };
    }

    if (mode === 'review') {
      const now = clock.now().getTime();
      const current = repos.reviewSuccessor.listCurrent(workspaceId);
      const candidateTargetIds =
        conceptIds && conceptIds.length > 0
          ? conceptIds
          : current
              .filter(({ state }) => new Date(state.dueAt).getTime() <= now)
              .map(({ target }) => target.id);
      const dueLimit =
        conceptIds && conceptIds.length > 0 ? endOfToday(clock.now()).getTime() : now;
      const targets: Concept[] = [];
      const seenConceptIds = new Set<string>();
      for (const targetId of candidateTargetIds) {
        if (targets.length >= 4) break;
        const context = resolveReviewTargetContext(repos, targetId);
        if (
          !context ||
          context.target.workspaceId !== workspaceId ||
          new Date(context.state.dueAt).getTime() > dueLimit
        ) {
          continue;
        }
        for (const conceptId of context.conceptIds) {
          if (targets.length >= 4 || seenConceptIds.has(conceptId)) continue;
          targets.push(requireWorkspaceConcept(workspaceId, conceptId));
          seenConceptIds.add(conceptId);
        }
      }
      if (targets.length === 0) {
        // Named review targets (queue items / Tutor recommendations) follow
        // the queue's advertised semantics: anything due by the END of today
        // may be reviewed slightly early. Unnamed review keeps strict due-now.
        if (conceptIds && conceptIds.length > 0) {
          throw new AppError(ApiErrorCode.ValidationError, '目标概念今天没有到期的复习安排。');
        }
        throw new AppError(ApiErrorCode.ValidationError, '当前没有到期的复习概念。');
      }
      return { targets, misconceptionTarget: null };
    }

    // diagnostic: one representative source concept per canonical group,
    // preferring UNASSESSED and important groups so a diagnostic keeps
    // advancing into new course content instead of always re-testing the
    // first six groups. Deterministic: unassessed first, then importance,
    // then canonical id.
    repos.alignment.ensureBaseline(
      workspaceId,
      repos.materials.getConceptsByWorkspace(workspaceId),
      clock.now().toISOString(),
    );
    const masteryConceptIds = new Set(
      repos.mastery.listByWorkspace(workspaceId).map((m) => m.conceptId),
    );
    const importanceRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const groups = repos.alignment.listCanonical(workspaceId);
    const ranked = groups
      .map((group) => {
        const member = group.members[0];
        const concept = member ? repos.materials.getConcept(member.sourceConceptId) : undefined;
        if (!concept) return null;
        const unassessed = group.members.every((m) => !masteryConceptIds.has(m.sourceConceptId));
        return { concept, unassessed, canonicalId: group.id };
      })
      .filter(
        (v): v is { concept: Concept; unassessed: boolean; canonicalId: string } => v !== null,
      )
      .sort(
        (a, b) =>
          Number(b.unassessed) - Number(a.unassessed) ||
          importanceRank[a.concept.importance]! - importanceRank[b.concept.importance]! ||
          a.canonicalId.localeCompare(b.canonicalId),
      );
    const targets: Concept[] = ranked.slice(0, MAX_TARGETS).map((entry) => entry.concept);
    if (targets.length === 0) {
      throw new AppError(ApiErrorCode.ValidationError, '请先为课程空间中的文档提取概念。');
    }
    return { targets, misconceptionTarget: null };
  }

  /** Generate and validate an assessment without mutating persistent state. */
  async function prepare(
    workspaceId: string,
    input: unknown,
    opts?: ProviderCallOptions,
    generationPolicy: AssessmentGenerationPolicy = {
      requiredRepresentation: null,
      requestedChallengeFamily: null,
      objectiveCatalogue: undefined,
      teachingSurfaceCatalogue: undefined,
    },
  ): Promise<AssessmentCreation> {
    const workspace = requireWorkspace(workspaceId);
    const request = CreateAssessmentRequestSchema.parse(input);
    const { targets, misconceptionTarget } = selectTargets(
      workspaceId,
      request.mode,
      request.conceptIds ? [...request.conceptIds] : undefined,
      request.misconceptionId,
    );

    // Canonical membership → aligned siblings in other documents.
    repos.alignment.ensureBaseline(
      workspaceId,
      repos.materials.getConceptsByWorkspace(workspaceId),
      clock.now().toISOString(),
    );
    const titles = new Map(
      repos.materials.listByWorkspace(workspaceId).map((m) => [m.id, m.title]),
    );
    const masteryByConcept = new Map(
      repos.mastery.listByWorkspace(workspaceId).map((m) => [m.conceptId, m]),
    );
    const mistakeCounts = repos.mistakes.countsByConceptForWorkspace(workspaceId);

    const targetSummaries: AssessmentTargetSummary[] = targets.map((concept) => {
      const member = repos.alignment.getMemberBySource(concept.id);
      const siblings = member
        ? repos.alignment
            .getMembers(member.canonicalConceptId)
            .filter((m) => m.sourceConceptId !== concept.id)
            .map((m) => repos.materials.getConcept(m.sourceConceptId))
            .filter((c): c is Concept => c !== undefined)
            .map((c) => ({ concept: c, documentTitle: titles.get(c.materialId) ?? c.materialId }))
        : [];
      return {
        concept,
        documentTitle: titles.get(concept.materialId) ?? concept.materialId,
        alignedSiblings: siblings.slice(0, 3),
        mastery: masteryByConcept.get(concept.id)?.mastery ?? null,
        openMistakes: mistakeCounts.get(concept.id)?.open ?? 0,
      };
    });

    const involvedMaterialIds = new Set<string>();
    for (const summary of targetSummaries) {
      involvedMaterialIds.add(summary.concept.materialId);
      for (const sibling of summary.alignedSiblings) {
        involvedMaterialIds.add(sibling.concept.materialId);
      }
    }
    const blocks = [...involvedMaterialIds].flatMap((id) => repos.materials.getBlocks(id));
    const allowedTypes = request.formalOnly
      ? (['short_answer'] as QuestionType[])
      : TYPES_BY_MODE[request.mode];
    const questionCount =
      generationPolicy.learnerGeneratedTransfer || request.mode === 'misconception_check'
        ? 1
        : generationPolicy.objectiveCatalogue?.length
          ? Math.min(MAX_ASSESSMENT_QUESTIONS, generationPolicy.objectiveCatalogue.length)
          : Math.min(MAX_ASSESSMENT_QUESTIONS, Math.max(3, targetSummaries.length));

    const semanticScoringReview = Boolean(
      request.formalOnly &&
      generationPolicy.scoringAuthorityCatalogue?.length &&
      inferenceProvider.solveFormalAssessment &&
      inferenceProvider.reviewFormalScoring,
    );

    const providerInput: AssessmentProposalInput = {
      workspaceName: workspace.name,
      learnerGeneratedTransfer: generationPolicy.learnerGeneratedTransfer,
      mode: request.mode,
      targets: targetSummaries,
      blocks,
      allowedTypes,
      questionCount,
      requiredRepresentation: generationPolicy.requiredRepresentation,
      requestedChallengeFamily: generationPolicy.requestedChallengeFamily,
      misconception: misconceptionTarget ? misconceptions.get(misconceptionTarget) : null,
      objectiveCatalogue: generationPolicy.objectiveCatalogue,
      scoringAuthorityCatalogue: generationPolicy.scoringAuthorityCatalogue,
      teachingSurfaceCatalogue: generationPolicy.teachingSurfaceCatalogue,
      priorExposure: generationPolicy.priorExposure,
      previousPrompts: generationPolicy.previousPrompts,
      semanticScoringReview,
      formalReviewFeedback: generationPolicy.formalReviewFeedback,
    };
    const payload = await inferenceProvider.proposeAssessment(providerInput, {
      ...opts,
      telemetry: {
        ...opts?.telemetry,
        workspaceId,
        operationType: opts?.telemetry?.operationType ?? `propose_${request.mode}_assessment`,
      },
    });

    // ---- Local deterministic validation of every item ----
    const allowedConceptIds = new Set<string>();
    for (const summary of targetSummaries) {
      allowedConceptIds.add(summary.concept.id);
      for (const sibling of summary.alignedSiblings) allowedConceptIds.add(sibling.concept.id);
    }
    const conceptById = new Map(
      repos.materials.getConceptsByWorkspace(workspaceId).map((c) => [c.id, c]),
    );

    const quizId = newId('qz');
    const createdAt = clock.now().toISOString();
    const questions: Question[] = [];
    const blueprints: QuestionBlueprint[] = [];
    const rejected: Array<{ stem: string; reason: string }> = [];
    const revisionFeedback: FormalAssessmentReviewFeedback[] = [];

    // Documented rule (mirrors remediation quizzes): practice-oriented
    // assessment questions re-test the open mistakes of their concept, so
    // a correct answer later resolves exactly those mistakes. Discriminating
    // questions (misconception_check) stay focused on the hypothesis.
    const openMistakesByConcept = new Map<string, string[]>();
    if (request.mode !== 'misconception_check') {
      for (const mistake of repos.mistakes.listOpenByWorkspace(workspaceId)) {
        const list = openMistakesByConcept.get(mistake.conceptId) ?? [];
        if (list.length < 10) list.push(mistake.id);
        openMistakesByConcept.set(mistake.conceptId, list);
      }
    }

    for (const item of payload.items.slice(0, questionCount)) {
      const q = item.question;
      const rejectItem = (
        reason: string,
        independentReview?: FormalAssessmentReviewFeedback['independentReview'],
      ) => {
        rejected.push({ stem: q.stem, reason });
        revisionFeedback.push({
          stem: q.stem,
          reason,
          draft: structuredClone(item),
          ...(independentReview ? { independentReview: structuredClone(independentReview) } : {}),
        });
      };

      if (!allowedTypes.includes(q.type) || q.type !== item.blueprint.questionType) {
        rejectItem(`题型不允许或与蓝图不一致:${q.type}`);
        continue;
      }
      const invalidConcept = item.blueprint.conceptIds.find((id) => !allowedConceptIds.has(id));
      if (invalidConcept !== undefined) {
        rejectItem(`蓝图目标概念不在本次评估范围内:${invalidConcept}`);
        continue;
      }
      if (!item.blueprint.conceptIds.includes(q.conceptId)) {
        rejectItem('题目概念不在蓝图目标概念中。');
        continue;
      }
      const concept = conceptById.get(q.conceptId);
      if (!concept) {
        rejectItem(`未知概念:${q.conceptId}`);
        continue;
      }

      // Evidence chain: question quote is index 0, extraEvidence follows.
      const primary = verifyGrounding(blocks, { blockId: q.blockId, quote: q.quote });
      if (!primary.ok) {
        rejectItem(primary.message);
        continue;
      }
      const evidence: VerifiedGrounding[] = [primary.grounding];
      const evidenceIndexMap = new Map([[0, 0]]);
      const evidenceFailures = new Map<number, string>();
      for (const [index, extra] of item.extraEvidence.slice(0, 3).entries()) {
        const verification = verifyGrounding(blocks, extra);
        if (verification.ok) {
          evidenceIndexMap.set(index + 1, evidence.length);
          evidence.push(verification.grounding);
        } else evidenceFailures.set(index + 1, `${extra.blockId}: ${verification.message}`);
      }

      const blockMaterial = (blockId: string) =>
        blocks.find((b) => b.id === blockId)?.materialId ?? null;
      const documentIds = [
        ...new Set(
          evidence.map((e) => blockMaterial(e.blockId)).filter((v): v is string => v !== null),
        ),
      ];
      const scope = documentIds.length >= 2 ? 'cross_document' : 'single_document';
      if (q.type === 'concept_comparison' && scope !== 'cross_document') {
        rejectItem('概念对比题必须使用来自至少两份文档的有效证据。');
        continue;
      }

      const invalidStepIndex = item.blueprint.reasoningSteps.flatMap((step) =>
        step.evidenceIndexes.filter((index) => !evidenceIndexMap.has(index)),
      );
      if (invalidStepIndex.length) {
        rejectItem(
          `推理步骤引用的证据无效：${[...new Set(invalidStepIndex)]
            .map((index) => `${index} (${evidenceFailures.get(index) ?? '不存在的证据序号'})`)
            .join('；')}`,
        );
        continue;
      }

      const canonicalIds = [
        ...new Set(
          item.blueprint.conceptIds
            .map((id) => repos.alignment.getMemberBySource(id)?.canonicalConceptId)
            .filter((v): v is string => v !== undefined),
        ),
      ];
      const blueprint: QuestionBlueprint = {
        id: newId('bp'),
        workspaceId,
        targetCanonicalConceptIds:
          canonicalIds.length > 0 ? canonicalIds.slice(0, 3) : ['unaligned'],
        sourceConceptIds: [...item.blueprint.conceptIds],
        sourceDocumentIds: documentIds,
        questionType: q.type,
        difficulty: item.blueprint.difficulty,
        learningObjective: item.blueprint.learningObjective,
        expectedReasoningSteps: item.blueprint.reasoningSteps.map((step) => ({
          description: step.description,
          evidenceIndexes: step.evidenceIndexes.map((index) => evidenceIndexMap.get(index)!),
        })),
        misconceptionId: misconceptionTarget,
        evidence,
        scope,
        gradingMethod: gradingMethodForType(q.type),
        validationState: 'accepted',
        createdAt,
      };

      // Question-rubric alignment (same contract as single-document
      // quizzes): required points must be requested by the stem and
      // grounded in the verified evidence blocks of THIS question.
      let rubric: Rubric | undefined;
      if (q.rubricKeyPoints) {
        const evidenceTexts = evidence.map(
          (e) => blocks.find((b) => b.id === e.blockId)?.content ?? e.quote,
        );
        const aligned = semanticScoringReview
          ? {
              ok: true as const,
              keyPoints: q.rubricKeyPoints.map((p) => ({ text: p.text, required: p.required })),
            }
          : alignRubricToQuestion(q.stem, q.rubricKeyPoints, evidenceTexts);
        if (!aligned.ok) {
          rejectItem(aligned.message);
          continue;
        }
        rubric = { keyPoints: aligned.keyPoints };
      }

      const question: Question = {
        id: newId('que'),
        quizId,
        index: questions.length,
        type: q.type,
        stem: generationPolicy.learnerTransfer?.prompt ?? q.stem,
        ...(generationPolicy.learnerTransfer
          ? { transferTask: generationPolicy.learnerTransfer.task }
          : {}),
        conceptId: concept.id,
        conceptName: concept.name,
        grounding: primary.grounding,
        ...(evidence.length > 1 ? { supplementaryEvidence: evidence.slice(1) } : {}),
        blueprintId: blueprint.id,
        ...(misconceptionTarget ? { misconceptionId: misconceptionTarget } : {}),
        ...((openMistakesByConcept.get(concept.id)?.length ?? 0) > 0
          ? { sourceMistakeIds: openMistakesByConcept.get(concept.id) }
          : {}),
        explanation: q.explanation,
        points: POINTS_BY_TYPE[q.type],
        ...(q.options ? { options: q.options } : {}),
        ...(q.correctOptionIds ? { correctOptionIds: q.correctOptionIds } : {}),
        ...(q.expectedAnswer ? { expectedAnswer: q.expectedAnswer } : {}),
        ...(rubric ? { rubric } : {}),
        ...(item.objectiveRef ||
        item.premises ||
        item.requiresExternalKnowledge !== undefined ||
        item.ambiguity ||
        item.undefinedTerms
          ? {
              formalProposal: {
                ...(item.objectiveRef ? { objectiveRef: item.objectiveRef } : {}),
                premises: (item.premises ?? []).map((premise, premiseIndex) => ({
                  premiseKey: premise.premiseKey ?? `premise:${premiseIndex + 1}`,
                  text: premise.text,
                  sourceRefs: premise.sourceRefs,
                  teachingSurfaceRefs: premise.teachingSurfaceRefs,
                  learnerVisible: premise.learnerVisible,
                  scenarioLocal: premise.scenarioLocal,
                  visibilityBasis: premise.visibilityBasis,
                })),
                requiresExternalKnowledge: item.requiresExternalKnowledge ?? false,
                ambiguity: item.ambiguity ?? 'none',
                undefinedTerms: item.undefinedTerms ?? [],
                rubricSourceRefs: (q.rubricKeyPoints ?? []).map((point) => ({
                  text: typeof point === 'string' ? point : point.text,
                  sourceRefs: typeof point === 'string' ? [] : (point.sourceRefs ?? []),
                })),
              },
            }
          : {}),
      };

      if (semanticScoringReview) {
        const objective = generationPolicy.objectiveCatalogue?.find(
          (o) => o.objectiveRef === item.objectiveRef,
        );
        if (!objective) {
          rejectItem('独立评分审核缺少当前目标。');
          continue;
        }
        const evidenceBlockIds = new Set(evidence.map((e) => e.blockId));
        // Review with the same original source context available to the
        // author, including qualifications outside its chosen quotation.
        // Supporting claim references remain restricted to the cited scope.
        const sourceBlocks = blocks.filter(
          (b) => !b.contentOrigin || b.contentOrigin === 'extracted_original',
        );
        const claims = (
          generationPolicy.scoringAuthorityCatalogue?.find(
            (c) => c.objectiveRef === item.objectiveRef,
          )?.claims ?? []
        )
          .filter((c) => evidenceBlockIds.has(c.sourceBlockId))
          .map((c, i) => ({ ref: `P${i + 1}`, sourceBlockId: c.sourceBlockId, text: c.text }));
        if (!claims.length) {
          rejectItem('独立评分审核缺少实际来源命题。');
          continue;
        }
        const reviewInput: FormalScoringReviewInput = {
          semanticWitnesses: true,
          question: {
            type: question.type,
            stem: question.stem,
            expectedAnswer: question.expectedAnswer,
            rubric: question.rubric,
            transferTask: question.transferTask,
          },
          objective: { title: objective.title, description: objective.description },
          sources: sourceBlocks.map((b) => ({
            sourceBlockId: b.id,
            materialRevisionId: b.materialRevisionId!,
            content: b.content,
          })),
          claims,
          priorExposure: [
            ...(generationPolicy.priorExposure ?? []),
            ...(generationPolicy.teachingSurfaceCatalogue ?? []).map((s) => s.text),
            ...(generationPolicy.previousPrompts ?? []),
          ],
        };
        // These checks have isolated inputs and do not consume each other's
        // output. Settle both before returning or failing so no in-flight
        // telemetry can outlive this assessment operation.
        const [blindResult, challengeResult] = await Promise.allSettled([
          inferenceProvider.solveFormalAssessment!(reviewInput, {
            ...opts,
            telemetry: { ...opts?.telemetry, workspaceId, operationType: 'formal_blind_solution' },
          }),
          inferenceProvider.challengeFormalScoring
            ? inferenceProvider.challengeFormalScoring(reviewInput, {
                ...opts,
                telemetry: {
                  ...opts?.telemetry,
                  workspaceId,
                  operationType: 'formal_scoring_challenges',
                },
              })
            : Promise.resolve(undefined),
        ]);
        if (blindResult.status === 'rejected') throw blindResult.reason;
        if (challengeResult.status === 'rejected') throw challengeResult.reason;
        const blindSolution = blindResult.value;
        const challenges = challengeResult.value
          ? FormalScoringChallengesSchema.parse(challengeResult.value)
          : undefined;
        if (challenges) reviewInput.challenges = challenges;
        const review = await inferenceProvider.reviewFormalScoring!(
          { ...reviewInput, blindSolution },
          {
            ...opts,
            telemetry: { ...opts?.telemetry, workspaceId, operationType: 'formal_scoring_review' },
          },
        );
        const reviewDiagnostics = validateScoringReviewProposal(review, reviewInput);
        if (!blindSolution.answerable || !scoringReviewPassed(review) || reviewDiagnostics.length) {
          rejectItem(
            `独立评分审核未通过：${
              [
                ...blindSolution.limitations,
                ...review.issues,
                ...reviewDiagnostics,
                ...(review.challengeResolutions ?? [])
                  .filter((r) => r.valid)
                  .map((r) => r.rationale),
                ...review.premises.filter((p) => !p.supported).map((p) => p.rationale),
              ].join('；') || '题目、目标或评分依据不充分'
            }`,
            { question: reviewInput.question, blindSolution, challenges, review },
          );
          continue;
        }
        question.formalScoringReview = FormalScoringReviewSchema.parse({
          policyVersion: challenges
            ? 'formal-scoring-independent-review-v3'
            : 'formal-scoring-independent-review-v1',
          provider: provider.name,
          questionFingerprint: scoringQuestionFingerprint(question),
          objectiveFingerprint: scoringFingerprint(reviewInput.objective),
          sources: sourceBlocks.map((b) => ({
            sourceBlockId: b.id,
            materialRevisionId: b.materialRevisionId,
            contentFingerprint: scoringFingerprint(b.content),
          })),
          blindSolution,
          ...(challenges
            ? { challenges, challengeFingerprint: scoringFingerprint(challenges) }
            : {}),
          review,
          claims,
          reviewedAt: clock.now().toISOString(),
        });
      }
      questions.push(question);
      blueprints.push(blueprint);
    }

    if (questions.length === 0) {
      if (semanticScoringReview && rejected.length && !generationPolicy.formalReviewFeedback) {
        return prepare(workspaceId, input, opts, {
          ...generationPolicy,
          formalReviewFeedback: revisionFeedback,
        });
      }
      throw new AppError(
        ApiErrorCode.GroundingFailed,
        '生成的评估题均未通过本地校验(概念、题型或证据不合法),请重试。',
        { rejected },
      );
    }
    if (
      request.mode === 'cross_document' &&
      !blueprints.some((b) => b.scope === 'cross_document')
    ) {
      throw new AppError(
        ApiErrorCode.GroundingFailed,
        '跨文档评估未能生成任何真正使用多文档证据的题目,请重试。',
        { rejected },
      );
    }

    const quiz: Quiz = {
      id: quizId,
      materialId: null,
      workspaceId,
      kind: 'adaptive',
      assessmentMode: request.mode,
      config: {
        difficulty: 'medium',
        types: [...new Set(questions.map((q) => q.type))].slice(0, 3),
        countPerType: Math.max(1, Math.min(5, questions.length)),
      },
      questions,
      targetConceptIds: [...new Set(questions.map((q) => q.conceptId))],
      createdAt,
    };
    return { quiz, blueprints, rejected };
  }

  /** Persist one already validated assessment. Callers own the outer transaction. */
  function persist(creation: AssessmentCreation): AssessmentCreation {
    repos.quizzes.insert(creation.quiz);
    for (const blueprint of creation.blueprints) {
      repos.blueprints.insert(blueprint, creation.quiz.id);
    }
    return creation;
  }

  return {
    /** Generate, validate, and persist one workspace assessment. */
    async create(
      workspaceId: string,
      input: unknown,
      opts?: ProviderCallOptions,
    ): Promise<AssessmentCreation> {
      return persist(await prepare(workspaceId, input, opts));
    },

    prepare,
    persist,

    /** Public blueprint projections of one quiz (no reasoning steps). */
    publicBlueprints(quizId: string): PublicBlueprint[] {
      return repos.blueprints.listByQuiz(quizId).map((blueprint) => {
        const { expectedReasoningSteps: _hidden, ...publicPart } = blueprint;
        return publicPart;
      });
    },
  };
}

export type AssessmentService = ReturnType<typeof createAssessmentService>;
