import type {
  Answer,
  GradingResult,
  MasteryState,
  MistakeRecord,
  Question,
  QuestionGrade,
  Quiz,
  Submission,
  SubmissionRequest,
} from '@hy3-clinic/shared';
import { INITIAL_MASTERY, updateMastery } from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import {
  computeTotals,
  gradeObjective,
  REVIEW_CONFIDENCE,
  SHORT_ANSWER_PASS,
  shortAnswerPoints,
} from '../grading/score.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export interface GradingServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
}

/** A mistake is recorded when the normalized score is below this threshold. */
const MISTAKE_THRESHOLD = SHORT_ANSWER_PASS;

export function createGradingService({ repos, provider, clock }: GradingServiceDeps) {
  /** Grade one question, choosing deterministic vs. model path by type. */
  async function gradeQuestion(
    question: Question,
    answer: Answer,
    opts?: ProviderCallOptions,
  ): Promise<QuestionGrade> {
    if (question.type === 'short_answer') {
      const rubric = question.rubric!;
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
          missedKeyPoints: rubric.keyPoints,
          feedback: '未作答。',
          needsReview: false,
        };
      }

      const grade = await provider.gradeShortAnswer(
        {
          stem: question.stem,
          expectedAnswer: question.expectedAnswer!,
          rubricKeyPoints: rubric.keyPoints,
          quote: question.grounding.quote,
          answerText,
        },
        opts,
      );
      const awardedPoints = shortAnswerPoints(question, grade.score);
      const correct = grade.score >= SHORT_ANSWER_PASS;
      const matchedKeyPoints = grade.matchedKeyPointIndexes
        .map((i) => rubric.keyPoints[i])
        .filter((v): v is string => v !== undefined);
      const missedKeyPoints = rubric.keyPoints.filter(
        (_, i) => !grade.matchedKeyPointIndexes.includes(i),
      );
      return {
        questionId: question.id,
        type: question.type,
        gradedBy: 'model',
        correct,
        awardedPoints,
        maxPoints: question.points,
        normalizedScore: grade.score,
        matchedKeyPoints,
        missedKeyPoints,
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
   * Persist mistakes and mastery updates for a graded quiz. For remediation
   * quizzes, a correct answer resolves the mistakes the question re-tested.
   */
  function persistOutcomes(
    quiz: Quiz,
    grades: QuestionGrade[],
    answersById: Map<string, Answer>,
    createdAt: string,
  ): void {
    const questionById = new Map(quiz.questions.map((q) => [q.id, q]));
    const conceptScores = new Map<string, { name: string; scores: number[] }>();

    for (const grade of grades) {
      const question = questionById.get(grade.questionId)!;
      const bucket = conceptScores.get(question.conceptId) ?? {
        name: question.conceptName,
        scores: [],
      };
      bucket.scores.push(grade.normalizedScore);
      conceptScores.set(question.conceptId, bucket);

      if (grade.normalizedScore < MISTAKE_THRESHOLD) {
        const mistake: MistakeRecord = {
          id: newId('mis'),
          materialId: quiz.materialId,
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
      } else if (quiz.kind === 'remediation' && grade.correct) {
        // Documented rule: a correct remediation answer resolves exactly the
        // mistakes this question was generated from.
        for (const mistakeId of question.sourceMistakeIds ?? []) {
          repos.mistakes.resolve(mistakeId, createdAt);
        }
      }
    }

    for (const [conceptId, { name, scores }] of conceptScores) {
      const existing = repos.mastery.get(quiz.materialId, conceptId);
      const prevMastery = existing?.mastery ?? INITIAL_MASTERY;
      const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
      const nextMastery = updateMastery(prevMastery, avgScore);
      const correctCount = scores.filter((s) => s >= SHORT_ANSWER_PASS).length;
      const next: MasteryState = {
        materialId: quiz.materialId,
        conceptId,
        conceptName: name,
        mastery: nextMastery,
        attempts: (existing?.attempts ?? 0) + scores.length,
        correctCount: (existing?.correctCount ?? 0) + correctCount,
        lastScore: Math.round(avgScore * 10_000) / 10_000,
        updatedAt: createdAt,
      };
      repos.mastery.upsert(next);
    }
  }

  return {
    /**
     * Grade a submission end-to-end. Objective questions are graded
     * deterministically; short answers via the provider rubric path. Nothing
     * is persisted until every question has been graded, so a provider
     * failure leaves no partial state behind.
     */
    async grade(request: SubmissionRequest, opts?: ProviderCallOptions): Promise<GradingResult> {
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
      persistOutcomes(quiz, grades, answersById, createdAt);

      return result;
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
  if (question.type === 'short_answer') {
    return { questionId: question.id, type: question.type, text: '' };
  }
  return { questionId: question.id, type: question.type, selectedOptionIds: [] };
}

export type GradingService = ReturnType<typeof createGradingService>;
