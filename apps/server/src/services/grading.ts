import type {
  Answer,
  GradingResult,
  MasteryChange,
  MasteryState,
  MistakeRecord,
  Question,
  QuestionGrade,
  Quiz,
  Submission,
  SubmissionRequest,
  SubmissionStateChanges,
} from '@hy3-clinic/shared';
import { INITIAL_MASTERY, isTextAnswerType, updateMastery } from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import {
  computeTotals,
  gradeObjective,
  requiredCoverageScore,
  REVIEW_CONFIDENCE,
  SHORT_ANSWER_PASS,
  shortAnswerPoints,
} from '../grading/score.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { MisconceptionsService } from './misconceptions.js';
import type { ReviewService } from './review.js';

export interface GradingServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  /** Deterministic misconception lifecycle (transitions + proposals). */
  misconceptions: MisconceptionsService;
  /** Deterministic review scheduler (long-term memory state). */
  review: ReviewService;
}

/** A mistake is recorded when the normalized score is below this threshold. */
const MISTAKE_THRESHOLD = SHORT_ANSWER_PASS;

export interface GradeOutcome {
  result: GradingResult;
  stateChanges: SubmissionStateChanges;
}

export function createGradingService({
  repos,
  provider,
  clock,
  misconceptions,
  review,
}: GradingServiceDeps) {
  /** Grade one question, choosing deterministic vs. model path by type. */
  async function gradeQuestion(
    question: Question,
    answer: Answer,
    opts?: ProviderCallOptions,
  ): Promise<QuestionGrade> {
    if (isTextAnswerType(question.type)) {
      const rubric = question.rubric!;
      const points = rubric.keyPoints;
      const answerText = (answer.text ?? '').trim();

      // Blank answers never reach the model: deterministic zero.
      if (answerText.length === 0) {
        return {
          questionId: question.id,
          type: question.type,
          gradedBy: 'deterministic',
          correct: false,
          awardedPoints: 0,
          maxPoints: question.points,
          normalizedScore: 0,
          missedKeyPoints: points.filter((p) => p.required).map((p) => p.text),
          enrichmentKeyPoints: points.filter((p) => !p.required).map((p) => p.text),
          feedback: '未作答。',
          needsReview: false,
        };
      }

      const grade = await provider.gradeShortAnswer(
        {
          stem: question.stem,
          expectedAnswer: question.expectedAnswer!,
          rubricKeyPoints: points,
          quote: question.grounding.quote,
          answerText,
        },
        opts,
      );
      // Deterministic scoring: only REQUIRED points enter the score. The
      // model judges semantic coverage per point; missing optional
      // enrichment can never reduce the score, and the model's holistic
      // score/confidence never set the awarded points directly.
      const matchedSet = new Set(
        grade.matchedKeyPointIndexes.filter((i) => i >= 0 && i < points.length),
      );
      const partialSet = new Set(
        (grade.partialKeyPointIndexes ?? []).filter(
          (i) => i >= 0 && i < points.length && !matchedSet.has(i),
        ),
      );
      const coverage = requiredCoverageScore(points, [...matchedSet], [...partialSet]);
      const awardedPoints = shortAnswerPoints(question, coverage.score);
      const correct = coverage.score >= SHORT_ANSWER_PASS;
      const matchedKeyPoints = points.filter((_, i) => matchedSet.has(i)).map((p) => p.text);
      const partialKeyPoints = points.filter((_, i) => partialSet.has(i)).map((p) => p.text);
      const missedKeyPoints = points
        .filter((p, i) => p.required && !matchedSet.has(i) && !partialSet.has(i))
        .map((p) => p.text);
      const enrichmentKeyPoints = points
        .filter((p, i) => !p.required && !matchedSet.has(i) && !partialSet.has(i))
        .map((p) => p.text);
      return {
        questionId: question.id,
        type: question.type,
        gradedBy: 'model',
        correct,
        awardedPoints,
        maxPoints: question.points,
        normalizedScore: coverage.score,
        matchedKeyPoints,
        missedKeyPoints,
        partialKeyPoints,
        enrichmentKeyPoints,
        confidence: grade.confidence,
        feedback: grade.feedback,
        needsReview: grade.confidence < REVIEW_CONFIDENCE,
      };
    }

    const outcome = gradeObjective(question, answer);
    return {
      questionId: question.id,
      type: question.type,
      gradedBy: 'deterministic',
      correct: outcome.correct,
      awardedPoints: outcome.awardedPoints,
      maxPoints: question.points,
      normalizedScore: outcome.normalizedScore,
      needsReview: false,
    };
  }

  /**
   * Persist mistakes and mastery updates for a graded quiz, attributing every
   * question to ITS OWN concept's document — never to an arbitrary quiz-level
   * document. For single-document quizzes this matches the previous behavior
   * exactly (every concept lives in the quiz's material); for workspace
   * (adaptive) quizzes it is what makes cross-document attribution correct.
   *
   * For remediation quizzes, a correct answer resolves the mistakes the
   * question re-tested. Questions whose concept no longer exists (deleted
   * mid-flight together with its document) are skipped: there is no material
   * left to attribute learning state to.
   */
  function persistOutcomes(
    quiz: Quiz,
    grades: QuestionGrade[],
    answersById: Map<string, Answer>,
    createdAt: string,
  ): {
    mistakesCreated: number;
    mistakesResolved: number;
    masteryChanges: MasteryChange[];
    conceptScores: Map<string, { name: string; materialId: string; scores: number[] }>;
  } {
    const questionById = new Map(quiz.questions.map((q) => [q.id, q]));
    const conceptScores = new Map<string, { name: string; materialId: string; scores: number[] }>();
    let mistakesCreated = 0;
    let mistakesResolved = 0;

    const materialByConcept = new Map<string, string | null>();
    const materialFor = (conceptId: string): string | null => {
      if (!materialByConcept.has(conceptId)) {
        materialByConcept.set(conceptId, repos.materials.getConcept(conceptId)?.materialId ?? null);
      }
      return materialByConcept.get(conceptId)!;
    };

    for (const grade of grades) {
      const question = questionById.get(grade.questionId)!;
      const materialId = materialFor(question.conceptId) ?? quiz.materialId;
      if (!materialId) continue;

      const bucket = conceptScores.get(question.conceptId) ?? {
        name: question.conceptName,
        materialId,
        scores: [],
      };
      bucket.scores.push(grade.normalizedScore);
      conceptScores.set(question.conceptId, bucket);

      if (grade.normalizedScore < MISTAKE_THRESHOLD) {
        const mistake: MistakeRecord = {
          id: newId('mis'),
          materialId,
          quizId: quiz.id,
          questionId: question.id,
          conceptId: question.conceptId,
          conceptName: question.conceptName,
          question,
          userAnswer: answersById.get(question.id)!,
          score: grade.normalizedScore,
          ...(grade.feedback ? { feedback: grade.feedback } : {}),
          status: 'open',
          remediationCount: 0,
          createdAt,
          resolvedAt: null,
        };
        repos.mistakes.insert(mistake);
        mistakesCreated++;
      } else if ((quiz.kind === 'remediation' || quiz.kind === 'adaptive') && grade.correct) {
        // Documented rule: a correct answer on a remediation question — or on
        // an adaptive practice question generated over the same open
        // mistakes — resolves exactly the mistakes it re-tested.
        for (const mistakeId of question.sourceMistakeIds ?? []) {
          const existing = repos.mistakes.get(mistakeId);
          if (existing && existing.status === 'open') {
            repos.mistakes.resolve(mistakeId, createdAt);
            mistakesResolved++;
          }
        }
      }
    }

    const masteryChanges: MasteryChange[] = [];
    for (const [conceptId, { name, materialId, scores }] of conceptScores) {
      const existing = repos.mastery.get(materialId, conceptId);
      const prevMastery = existing?.mastery ?? INITIAL_MASTERY;
      const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
      const nextMastery = updateMastery(prevMastery, avgScore);
      const correctCount = scores.filter((s) => s >= SHORT_ANSWER_PASS).length;
      const next: MasteryState = {
        materialId,
        conceptId,
        conceptName: name,
        mastery: nextMastery,
        attempts: (existing?.attempts ?? 0) + scores.length,
        correctCount: (existing?.correctCount ?? 0) + correctCount,
        lastScore: Math.round(avgScore * 10_000) / 10_000,
        updatedAt: createdAt,
      };
      repos.mastery.upsert(next);
      masteryChanges.push({
        conceptId,
        conceptName: name,
        before: existing?.mastery ?? null,
        after: nextMastery,
      });
    }

    return { mistakesCreated, mistakesResolved, masteryChanges, conceptScores };
  }

  /** Deterministic recommended next step derived only from recorded outcomes. */
  function nextStepText(changes: Omit<SubmissionStateChanges, 'recommendedNextStep'>): string {
    if (changes.misconceptionsConfirmed > 0) {
      return '本次作答确认了一个误区假设,建议优先完成针对该误区的巩固练习。';
    }
    if (changes.mistakesCreated > 0) {
      return `本次产生了 ${changes.mistakesCreated} 道错题,建议在图谱中查看薄弱概念并生成康复计划。`;
    }
    if (changes.misconceptionsProposed > 0) {
      return '出现了待确认的误区假设,建议通过一道判别练习确认或排除它。';
    }
    if (changes.reviewScheduled.length > 0) {
      return '全部作答达标,相关概念的复习时间已按遗忘风险重新安排,请按「今日学习」提示回来复习。';
    }
    return '全部作答达标,可以继续学习图谱中的下一个概念。';
  }

  return {
    /**
     * Grade a submission end-to-end. Objective questions are graded
     * deterministically; text answers via the provider rubric path. Nothing
     * is persisted until every question has been graded, so a provider
     * failure leaves no partial state behind. After persisting outcomes the
     * deterministic misconception transitions and review scheduling run, and
     * everything that changed is reported in `stateChanges`.
     */
    async grade(request: SubmissionRequest, opts?: ProviderCallOptions): Promise<GradeOutcome> {
      const quiz = repos.quizzes.get(request.quizId);
      if (!quiz) throw notFound(`测验不存在:${request.quizId}`);

      const answersById = new Map<string, Answer>();
      for (const answer of request.answers) {
        const question = quiz.questions.find((q) => q.id === answer.questionId);
        if (!question) throw notFound(`题目不属于该测验:${answer.questionId}`);
        answersById.set(answer.questionId, answer);
      }
      for (const question of quiz.questions) {
        if (!answersById.has(question.id)) {
          answersById.set(question.id, blankAnswer(question));
        }
      }

      const createdAt = clock.now().toISOString();
      const grades: QuestionGrade[] = [];
      for (const question of quiz.questions) {
        grades.push(await gradeQuestion(question, answersById.get(question.id)!, opts));
      }

      const totals = computeTotals(
        grades.map((g) => ({ awardedPoints: g.awardedPoints, maxPoints: g.maxPoints })),
      );

      const submission: Submission = {
        id: newId('sub'),
        quizId: quiz.id,
        answers: [...answersById.values()],
        createdAt,
      };
      const result: GradingResult = {
        id: newId('grd'),
        submissionId: submission.id,
        quizId: quiz.id,
        grades,
        totalAwarded: totals.totalAwarded,
        totalPossible: totals.totalPossible,
        overallScore: totals.overallScore,
        createdAt,
      };

      repos.submissions.insertSubmission(submission);
      repos.submissions.insertGradingResult(result);
      const outcomes = persistOutcomes(quiz, grades, answersById, createdAt);

      // Deterministic misconception transitions (discriminating questions
      // decide; the model cannot), then bounded model-side proposals for
      // wrong answers of workspace assessments.
      const transitions = misconceptions.applyGradedTransitions(quiz, grades, createdAt);
      const proposed = await misconceptions.proposeFromWrongAnswers(
        quiz,
        grades,
        answersById,
        createdAt,
        opts,
      );

      // Review scheduling: only completed graded events reach the scheduler.
      const reviewScheduled = review.recordGradedOutcomes(quiz, outcomes.conceptScores, createdAt);

      const documentIds = [
        ...new Set([...outcomes.conceptScores.values()].map((c) => c.materialId)),
      ];
      const withoutNextStep: Omit<SubmissionStateChanges, 'recommendedNextStep'> = {
        assessedConceptIds: [...outcomes.conceptScores.keys()].slice(0, 20),
        documentIds: documentIds.slice(0, 10),
        mistakesCreated: outcomes.mistakesCreated,
        mistakesResolved: outcomes.mistakesResolved,
        misconceptionsProposed: proposed,
        misconceptionsConfirmed: transitions.confirmed,
        misconceptionsRejected: transitions.rejected,
        misconceptionsResolved: transitions.resolved,
        masteryChanges: outcomes.masteryChanges.slice(0, 20),
        reviewScheduled: reviewScheduled.slice(0, 20),
      };
      const stateChanges: SubmissionStateChanges = {
        ...withoutNextStep,
        recommendedNextStep: nextStepText(withoutNextStep),
      };

      return { result, stateChanges };
    },

    getResult(id: string): GradingResult {
      const result = repos.submissions.getGradingResult(id);
      if (!result) throw notFound(`判分结果不存在:${id}`);
      return result;
    },
  };
}

/** A blank/unanswered answer for a question (counts as incorrect). */
function blankAnswer(question: Question): Answer {
  if (isTextAnswerType(question.type)) {
    return { questionId: question.id, type: question.type, text: '' };
  }
  return { questionId: question.id, type: question.type, selectedOptionIds: [] };
}

export type GradingService = ReturnType<typeof createGradingService>;
