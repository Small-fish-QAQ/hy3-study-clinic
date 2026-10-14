import {
  CourseQuizSchema,
  CourseQuestionSchema,
  type CourseQuiz,
  type CourseQuestion,
  type CourseLessonContent,
  type CourseKnowledge,
  type CoursePlan,
} from '@hy3-clinic/shared';
import { QuestionsOutputSchema, type QuestionsInput } from '../llm/courseContract.js';
import type { ClinicRepository } from '../repositories/clinic.js';
import type { CoursePlanningService } from './coursePlanning.js';
import type { CourseSources } from './courseSources.js';
import type { CourseGeneration } from './courseGeneration.js';
import type { QuestionAdmission } from './questionAdmission.js';
import { publicQuestion, INVALID_FORMAL_COVERAGE } from './questionAdmission.js';
import type { CourseOperationContext } from './courseOperationRunner.js';
import { canonical, sha256, stableId } from '../util/canonical.js';
import { AppError } from '../errors.js';
import { CourseValidationError, requireValid, demandRank } from './courseValidation.js';
import { assessmentScope } from './unitAssessment.js';

export function checkPaperCoverage(quiz: CourseQuiz): string[] {
  if (!quiz.blueprint) return [];
  const gaps: string[] = [];
  for (const id of quiz.blueprint.requiredCellIds) {
    const cell = quiz.blueprint.cells.find((c) => c.id === id)!;
    const actual = quiz.items.flatMap((q) => q.admission.coverage.filter((c) => c.cellId === id));
    if (!actual.length) gaps.push(`缺少必考能力:${id}`);
    for (const k of cell.mandatoryKnowledgeIds)
      if (!actual.some((c) => c.assessedKnowledgeIds.includes(k))) gaps.push(`缺少核心命题:${k}`);
    for (const set of cell.representativeSets)
      if (
        !actual.some(
          (c) =>
            c.representativeSetIds.includes(set.id) &&
            c.assessedKnowledgeIds.some((k) => set.candidateKnowledgeIds.includes(k)),
        )
      )
        gaps.push(`缺少代表集合:${set.id}`);
  }
  const requiredCells = quiz.blueprint.cells.filter((c) =>
    quiz.blueprint!.requiredCellIds.includes(c.id),
  );
  for (const objective of quiz.blueprint.objectiveRequirements ?? []) {
    const targetCells = requiredCells.filter((c) => c.objectiveIds.includes(objective.id));
    if (!quiz.blueprint.cells.some((c) => c.objectiveIds.includes(objective.id)))
      gaps.push(`蓝图遗漏教学目标:${objective.id}`);
    if (!targetCells.length) continue; // A local slot check only checks that slot's targets.
    if (
      !quiz.items.some((q) =>
        q.admission.coverage.some(
          (c) =>
            targetCells.some((cell) => cell.id === c.cellId) &&
            c.objectiveIds?.includes(objective.id) &&
            demandRank[c.demand] >= demandRank[objective.demand] &&
            c.assessedKnowledgeIds.some((id) => objective.knowledgeIds.includes(id)),
        ),
      )
    )
      gaps.push(`缺少实测教学目标:${objective.id}`);
  }
  if (quiz.blueprint.objectiveRequirements)
    for (const selection of quiz.paperCoverageSelection.filter((s) =>
      quiz.blueprint!.requiredCellIds.includes(s.cellId),
    ))
      for (const knowledgeId of selection.knowledgeIds)
        if (
          !quiz.items.some((q) =>
            q.admission.coverage.some(
              (c) => c.cellId === selection.cellId && c.assessedKnowledgeIds.includes(knowledgeId),
            ),
          )
        )
          gaps.push(`缺少本卷选定代表:${selection.cellId}:${knowledgeId}`);
  return gaps;
}
export class CourseQuestions {
  constructor(
    readonly repo: ClinicRepository,
    readonly planning: CoursePlanningService,
    readonly sources: CourseSources,
    readonly generation: CourseGeneration,
    readonly admission: QuestionAdmission,
  ) {}
  get(workspaceId: string, id: string) {
    return CourseQuizSchema.parse(this.repo.owned('quizzes', id, workspaceId));
  }
  public(quiz: CourseQuiz) {
    if (quiz.status !== 'ready')
      return {
        id: quiz.id,
        workspaceId: quiz.workspaceId,
        purpose: quiz.purpose,
        status: quiz.status,
        version: quiz.version,
        assessmentScope: quiz.assessmentScope,
        items: [],
        discardedCount: quiz.discarded.length,
      };
    return {
      id: quiz.id,
      workspaceId: quiz.workspaceId,
      purpose: quiz.purpose,
      status: quiz.status,
      version: quiz.version,
      assessmentScope: quiz.assessmentScope,
      items: quiz.items.map(publicQuestion),
      discardedCount: quiz.discarded.length,
    };
  }
  async practice(
    ctx: CourseOperationContext,
    request: {
      curriculumId: string;
      lessonVersionId?: string;
      requestId: string;
      knowledgeIds?: string[];
      purpose?: 'practice' | 'explicit_review';
    },
  ) {
    const plan = this.planning.get(ctx.workspaceId, request.curriculumId)!;
    if (plan.status !== 'accepted') throw new AppError('VERSION_CONFLICT', '课程未确认。');
    const inventory = this.planning.inventory(plan);
    const purpose = request.purpose ?? 'practice';
    this.sources.assertCurrent(ctx.workspaceId, inventory.sourceScopeHash);
    let keys: string[];
    let context: string[] = [];
    if (request.lessonVersionId) {
      const content = this.repo.owned<CourseLessonContent>(
        'course_lesson_versions',
        request.lessonVersionId,
        ctx.workspaceId,
      );
      if (
        !plan.lessons.some(
          (l) =>
            l.id === content.lessonId &&
            l.knowledgeIds.every((id) =>
              content.deliveryCheck.anchors.some((a) => a.knowledgeId === id),
            ),
        )
      )
        throw new AppError('VERSION_CONFLICT', '课文不属于当前课程。');
      if (
        !this.repo.row(
          'SELECT id FROM lesson_execution_events WHERE curriculum_id=? AND lesson_id=?',
          plan.id,
          content.lessonId,
        )
      )
        throw new AppError('VERSION_CONFLICT', '请先主动完成本课，再按需练习。');
      keys = content.deliveryCheck.anchors.map((a) => a.knowledgeId);
      context = content.segments.map((s) => s.text);
    } else {
      keys = request.knowledgeIds ?? [];
      if (purpose !== 'explicit_review' || !keys.length)
        throw new AppError('VALIDATION_ERROR', '复习知识范围为空。');
    }
    const k = inventory.knowledge.filter((k) => keys.includes(k.id));
    requireValid(keys.some((id) => !k.some((k) => k.id === id)) ? ['练习引用外来知识'] : []);
    return this.prepare(
      ctx,
      plan,
      purpose,
      request.requestId,
      k,
      context,
      request.lessonVersionId ?? null,
      null,
    );
  }
  async formal(
    ctx: CourseOperationContext,
    request: {
      curriculumId: string;
      blueprintId: string;
      paperRequestId: string;
      moduleId?: string;
      supplement?: { requestId: string; expectedVersion: number };
    },
  ) {
    const plan = this.planning.get(ctx.workspaceId, request.curriculumId)!;
    const inventory = this.planning.inventory(plan);
    if (plan.status !== 'accepted' || plan.assessmentBlueprint.id !== request.blueprintId)
      throw new AppError('VERSION_CONFLICT', '确认课程或蓝图不匹配。');
    this.sources.assertCurrent(ctx.workspaceId, inventory.sourceScopeHash);
    const existing = this.repo.payload<CourseQuiz>(
      'SELECT payload FROM quizzes WHERE id=?',
      stableId('quiz', {
        workspace: ctx.workspaceId,
        purpose: 'formal',
        requestId: request.paperRequestId,
      }),
    );
    if (
      existing &&
      (existing.curriculumId !== plan.id ||
        (existing.assessmentScope?.kind ?? 'course') !== (request.moduleId ? 'module' : 'course') ||
        existing.assessmentScope?.moduleId !== request.moduleId ||
        !existing.blueprint ||
        existing.blueprint.sourceScopeHash !== inventory.sourceScopeHash)
    )
      throw new AppError('VERSION_CONFLICT', '请求ID已绑定另一份考核范围或蓝图。');
    // A retry/read of a frozen paper must never recompile its requirements.
    // The new policy applies only to a new paperRequestId, including on old maps.
    const scoped = existing
      ? { blueprint: existing.blueprint!, scope: existing.assessmentScope }
      : assessmentScope(plan, request.moduleId);
    return this.prepare(
      ctx,
      plan,
      'formal',
      request.paperRequestId,
      inventory.knowledge.filter((k) => !scoped.scope || scoped.scope.knowledgeIds.includes(k.id)),
      [],
      null,
      scoped.blueprint,
      undefined,
      request.supplement,
      scoped.scope,
    );
  }
  async retest(
    ctx: CourseOperationContext,
    plan: CoursePlan,
    requestId: string,
    knowledge: CourseKnowledge[],
    explanation: string,
    initialQuestions: CourseQuestion[],
  ) {
    return this.prepare(
      ctx,
      plan,
      'retest',
      requestId,
      knowledge,
      [explanation],
      null,
      null,
      initialQuestions,
    );
  }
  private async prepare(
    ctx: CourseOperationContext,
    plan: CoursePlan,
    purpose: CourseQuiz['purpose'],
    requestId: string,
    knowledge: CourseKnowledge[],
    learnerContext: string[],
    lessonVersionId: string | null,
    blueprint: CourseQuiz['blueprint'],
    initialQuestions?: CourseQuestion[],
    supplement?: { requestId: string; expectedVersion: number },
    examScope?: CourseQuiz['assessmentScope'],
  ) {
    const id = stableId('quiz', { workspace: ctx.workspaceId, purpose, requestId });
    let quiz = this.repo.payload<CourseQuiz>('SELECT payload FROM quizzes WHERE id=?', id);
    if (supplement && (!quiz || !blueprint))
      throw new AppError('VERSION_CONFLICT', '补题必须对应现有未就绪的正式卷。');
    if (
      quiz &&
      (quiz.curriculumId !== plan.id ||
        quiz.lessonVersionId !== lessonVersionId ||
        sha256(quiz.blueprint) !== sha256(blueprint))
    )
      throw new AppError('VERSION_CONFLICT', '请求ID已绑定另一份练习范围或蓝图。');
    if (quiz?.status === 'ready') {
      return { resourceId: quiz.id };
    }
    const prior = this.repo
      .payloads<CourseQuiz>(
        "SELECT payload FROM quizzes WHERE workspace_id=? AND status='ready'",
        ctx.workspaceId,
      )
      .flatMap((q) => q.items);
    const sources = this.sources.references(
      ctx.workspaceId,
      knowledge.flatMap((k) => k.sourceSpans),
    );
    const scope = sha256(sources);
    if (!quiz) {
      const selection: CourseQuiz['paperCoverageSelection'] = blueprint
        ? blueprint.requiredCellIds.map((cellId) => {
            const cell = blueprint.cells.find((c) => c.id === cellId)!;
            const selected = new Set(cell.mandatoryKnowledgeIds);
            const representatives = cell.representativeSets.map((set) => {
              const sorted = [...set.candidateKnowledgeIds].sort(
                (a, b) =>
                  Number(selected.has(b)) - Number(selected.has(a)) ||
                  prior.filter((q) => q.knowledgeIds.includes(a)).length -
                    prior.filter((q) => q.knowledgeIds.includes(b)).length ||
                  sha256({ requestId, set: set.id, k: a }).localeCompare(
                    sha256({ requestId, set: set.id, k: b }),
                  ),
              );
              selected.add(sorted[0]!);
              return { setId: set.id, knowledgeId: sorted[0]! };
            });
            return {
              cellId,
              knowledgeIds: [
                ...new Set([
                  ...cell.mandatoryKnowledgeIds,
                  ...representatives.map((r) => r.knowledgeId),
                ]),
              ],
              representatives,
              replacements: [],
            };
          })
        : [];
      quiz = CourseQuizSchema.parse({
        id,
        workspaceId: ctx.workspaceId,
        curriculumId: plan.id,
        purpose,
        requestId,
        lessonVersionId,
        ...(examScope ? { assessmentScope: examScope } : {}),
        version: 1,
        status: 'draft',
        items: [],
        discarded: [],
        blueprint,
        paperCoverageSelection: selection,
      });
      this.repo.run(
        'INSERT INTO quizzes VALUES(?,?,?,?,?,?,?,?)',
        id,
        ctx.workspaceId,
        plan.id,
        purpose,
        requestId,
        'draft',
        canonical(quiz),
        this.repo.now(),
      );
    }
    if (supplement && !quiz.supplementActions?.some((s) => s.requestId === supplement.requestId)) {
      if (quiz.version !== supplement.expectedVersion)
        throw new AppError('VERSION_CONFLICT', '试卷草稿已改变，请刷新后再补题。');
      const replaced: CourseQuiz['supplementActions'][number]['slots'] = [];
      const selection = quiz.paperCoverageSelection.map((s) => {
        const previousSlotId = s.slotId ?? stableId('slot', { quiz: id, cell: s.cellId });
        const exhausted =
          quiz!.candidateStates.some(
            (state) => state.slotId === previousSlotId && state.rejectedCount === 2,
          ) && quiz!.discarded.some((d) => d.slotId === previousSlotId);
        if (
          !exhausted ||
          !checkPaperCoverage({
            ...quiz!,
            blueprint: { ...blueprint!, requiredCellIds: [s.cellId] },
          }).length
        )
          return s;
        const slotId = stableId('slot', {
          quiz: id,
          cell: s.cellId,
          supplement: supplement.requestId,
        });
        replaced.push({ cellId: s.cellId, previousSlotId, slotId });
        return { ...s, slotId };
      });
      if (!replaced.length)
        throw new AppError('VERSION_CONFLICT', '没有耗尽内容额度的缺失能力；请恢复已有核查。');
      quiz = {
        ...quiz,
        version: quiz.version + 1,
        paperCoverageSelection: selection,
        supplementActions: [
          ...(quiz.supplementActions ?? []),
          { requestId: supplement.requestId, slots: replaced },
        ],
      };
      this.save(quiz);
    }
    const slots = blueprint
      ? quiz.paperCoverageSelection.map((s) => ({
          id: s.slotId ?? stableId('slot', { quiz: id, cell: s.cellId }),
          knowledgeIds: s.knowledgeIds,
          cellIds: [s.cellId],
        }))
      : [{ id: stableId('slot', id), knowledgeIds: knowledge.map((k) => k.id), cellIds: [] }];
    const initial: QuestionsInput = {
      teachingIntent: {
        lessons: plan.lessons
          .filter(
            (l) =>
              (!examScope || examScope.lessonIds.includes(l.id)) &&
              l.knowledgeIds.some((id) => knowledge.some((k) => k.id === id)),
          )
          .map((l) => ({
            id: l.id,
            title: l.title,
            selectedDepth: l.selectedDepth,
            objectives: l.objectives.filter((o) =>
              o.knowledgeIds.some((id) => knowledge.some((k) => k.id === id)),
            ),
          })),
        diagnostics: this.repo
          .payloads<{
            itemGrades: { assessedKnowledgeIds: string[]; score: number; feedback: string }[];
          }>(
            "SELECT payload FROM submissions WHERE workspace_id=? AND status='graded' ORDER BY submitted_at DESC LIMIT 3",
            ctx.workspaceId,
          )
          .flatMap((s) =>
            s.itemGrades.flatMap((g) =>
              g.assessedKnowledgeIds
                .filter((id) => knowledge.some((k) => k.id === id))
                .map((id) => ({
                  knowledgeId: id,
                  result: g.score === 1 ? 'success' : 'needs_practice',
                  feedback: g.feedback,
                })),
            ),
          ),
      },
      purpose,
      slots,
      knowledge,
      sources,
      learnerVisibleContext: learnerContext,
      blueprint,
      previousQuestions: prior.map((q) => ({ prompt: q.prompt, options: q.options })),
    };
    const make = (batch: typeof slots): QuestionsInput => {
      const previousRejections = batch.flatMap((slot) => {
        const replaced = (quiz!.supplementActions ?? [])
          .flatMap((a) => a.slots)
          .find((s) => s.slotId === slot.id);
        const previousState =
          replaced && quiz!.candidateStates.find((s) => s.slotId === replaced.previousSlotId);
        return previousState
          ? [
              {
                slotId: slot.id,
                previous: previousState.candidates.at(-1) ?? null,
                findings: previousState.findings,
              },
            ]
          : [];
      });
      const ids = new Set(batch.flatMap((s) => s.knowledgeIds));
      const cells =
        blueprint?.cells.filter((c) => batch.some((s) => s.cellIds.includes(c.id))) ?? [];
      const objectiveIds = new Set(cells.flatMap((c) => c.objectiveIds));
      const objectives = blueprint?.objectiveRequirements?.filter((o) => objectiveIds.has(o.id));
      // Supporting knowledge makes the complete target intelligible to the
      // author; it is not another compulsory exam item or evidence claim.
      const supportingIds = new Set(objectives?.flatMap((o) => o.knowledgeIds));
      const selectedKnowledge = knowledge.filter((k) => ids.has(k.id) || supportingIds.has(k.id));
      return {
        ...initial,
        slots: batch,
        ...(previousRejections.length ? { previousRejections } : {}),
        knowledge: selectedKnowledge,
        sources: this.sources.references(
          ctx.workspaceId,
          selectedKnowledge.flatMap((k) => k.sourceSpans),
        ),
        blueprint: blueprint
          ? {
              ...blueprint,
              ...(objectives ? { objectiveRequirements: objectives } : {}),
              cells,
              requiredCellIds: cells.map((c) => c.id),
              domains: blueprint.domains
                .filter((d) => cells.some((c) => c.domainId === d.id))
                .map((d) => ({
                  ...d,
                  knowledgeIds: d.knowledgeIds.filter((id) => ids.has(id)),
                  coreObjectiveIds: d.coreObjectiveIds.filter((id) => objectiveIds.has(id)),
                })),
            }
          : null,
      };
    };
    let authored: unknown[] | undefined = initialQuestions;
    // Older attempts may have exhausted their allowance solely because a
    // reviewer omitted redundant representative-set labels. Recheck their last
    // retained candidate locally; never buy another candidate or reset counts.
    const retainedMembershipChecks = new Set(
      quiz.discarded
        .filter(
          (d) =>
            d.reasons.length &&
            d.reasons.every((reason) => reason.startsWith('缺少代表集合:')) &&
            quiz!.candidateStates.some(
              (s) => s.slotId === d.slotId && s.rejectedCount === 2 && s.candidates[1],
            ),
        )
        .map((d) => d.slotId),
    );
    // Old formative candidates could exhaust authoring solely on an unused
    // Formal annotation. Reuse the complete last candidate, while still buying
    // any necessary answer checks that never ran. Author allowance is unchanged.
    const retainedFormativeChecks = new Set(
      quiz.discarded
        .filter((d) => {
          if (
            blueprint ||
            !d.reasons.length ||
            !d.reasons.every((r) => r === INVALID_FORMAL_COVERAGE)
          )
            return false;
          const state = quiz!.candidateStates.find((s) => s.slotId === d.slotId);
          const parsed = CourseQuestionSchema.safeParse(state?.candidates[1]);
          return state?.rejectedCount === 2 && parsed.success && parsed.data.coverage.length > 0;
        })
        .map((d) => d.slotId),
    );
    const retainedReviewChecks = new Set<string>();
    for (const slot of slots) {
      if (
        quiz.items.some((q) => q.slotId === slot.id) ||
        !quiz.discarded.some((d) => d.slotId === slot.id)
      )
        continue;
      const state = quiz.candidateStates.find((s) => s.slotId === slot.id);
      if (state?.rejectedCount !== 2) continue;
      const parsed = CourseQuestionSchema.safeParse({
        ...((state.candidates[1] as object) ?? {}),
        id: stableId('question', { quiz: id, slot: slot.id, candidate: 1 }),
      });
      if (
        parsed.success &&
        this.admission.retainedRubricContractFailure(
          ctx,
          parsed.data,
          knowledge,
          learnerContext,
          blueprint,
          prior,
        )
      )
        retainedReviewChecks.add(slot.id);
    }
    const unresolved = slots.filter(
      (s) =>
        !quiz!.items.some((q) => q.slotId === s.id) &&
        (!quiz!.discarded.some((d) => d.slotId === s.id) ||
          retainedMembershipChecks.has(s.id) ||
          retainedFormativeChecks.has(s.id) ||
          retainedReviewChecks.has(s.id)),
    );
    const unauthored = unresolved.filter(
      (s) => !quiz!.candidateStates.some((state) => state.slotId === s.id),
    );
    if (unauthored.length && !authored) {
      authored = [];
      const groups: (typeof unauthored)[] = [];
      let group: typeof unauthored = [];
      const capacity = Math.max(
        1,
        Math.min(
          (ctx.provider.outputCap ?? 64000) * 2,
          ctx.provider.contextCap
            ? ctx.provider.contextCap * 1.5
            : (ctx.provider.outputCap ?? 64000) * 2,
        ),
      );
      for (const slot of unauthored) {
        if (group.length && Buffer.byteLength(JSON.stringify(make([...group, slot]))) > capacity) {
          groups.push(group);
          group = [];
        }
        group.push(slot);
      }
      if (group.length) groups.push(group);
      for (const batch of groups) {
        const input = make(batch);
        const generated = await this.generation.stage(
          ctx,
          'generateQuestions',
          input,
          sha256(input.sources),
          QuestionsOutputSchema,
          (opts) => ctx.provider.generateQuestions(input, opts),
        );
        authored.push(...generated.value.questions);
        for (const slot of batch) {
          const candidate = generated.value.questions.find(
            (q) => !!q && typeof q === 'object' && 'slotId' in q && q.slotId === slot.id,
          );
          quiz = {
            ...quiz,
            candidateStates: [
              ...quiz.candidateStates,
              { slotId: slot.id, candidates: [candidate ?? null], rejectedCount: 0, findings: [] },
            ],
          };
          this.save(quiz);
        }
      }
    }
    if (initialQuestions?.length === 1 && !blueprint)
      authored = initialQuestions.map((q) => ({ ...q, slotId: slots[0]!.id }));
    for (const slot of unauthored) {
      if (quiz.candidateStates.some((s) => s.slotId === slot.id)) continue;
      const candidate = authored?.find(
        (q) => !!q && typeof q === 'object' && 'slotId' in q && q.slotId === slot.id,
      );
      quiz = {
        ...quiz,
        candidateStates: [
          ...quiz.candidateStates,
          { slotId: slot.id, candidates: [candidate ?? null], rejectedCount: 0, findings: [] },
        ],
      };
      this.save(quiz);
    }
    for (const slot of unresolved) {
      // Persist each slot's content candidates independently, so technical retries cannot reset its allowance.
      const state = quiz.candidateStates.find((s) => s.slotId === slot.id)!;
      const retainedOnly = retainedMembershipChecks.has(slot.id);
      let accepted = false;
      for (
        let contentAttempt =
          retainedOnly || retainedFormativeChecks.has(slot.id) || retainedReviewChecks.has(slot.id)
            ? 1
            : state.rejectedCount;
        contentAttempt < 2;
        contentAttempt++
      ) {
        let candidate = state.candidates[contentAttempt];
        if (candidate === undefined) {
          const input: QuestionsInput = {
            ...make([slot]),
            slots: [slot],
            ...(contentAttempt > 0
              ? {
                  revision: {
                    slotId: slot.id,
                    previous: state.candidates[0] ?? null,
                    findings: state.findings,
                  },
                }
              : {}),
          };
          const revised = await this.generation.stage(
            ctx,
            'generateQuestions',
            input,
            scope,
            QuestionsOutputSchema,
            (opts) => ctx.provider.generateQuestions(input, opts),
          );
          candidate =
            revised.value.questions.find(
              (q) => !!q && typeof q === 'object' && 'slotId' in q && q.slotId === slot.id,
            ) ?? null;
          state.candidates[contentAttempt] = candidate;
          this.save(quiz);
        }
        try {
          if (!candidate) throw new CourseValidationError(['作者没有返回该slot']);
          const parsed = CourseQuestionSchema.safeParse(
            candidate && typeof candidate === 'object'
              ? {
                  ...candidate,
                  id: stableId('question', { quiz: id, slot: slot.id, candidate: contentAttempt }),
                }
              : candidate,
          );
          if (!parsed.success)
            throw new CourseValidationError(
              parsed.error.issues.map(
                (issue) => `题目结构无效:${issue.path.join('.')}:${issue.code}`,
              ),
            );
          const admitted = await this.admission.admit(
            ctx,
            parsed.data,
            knowledge,
            learnerContext,
            blueprint,
            prior,
            retainedOnly,
          );
          if (blueprint)
            requireValid(
              checkPaperCoverage({
                ...quiz,
                items: [...quiz.items, admitted],
                blueprint: { ...blueprint, requiredCellIds: slot.cellIds },
              }),
            );
          ctx.check();
          this.sources.assertCurrent(
            ctx.workspaceId,
            this.planning.inventory(plan).sourceScopeHash,
          );
          quiz = {
            ...quiz,
            items: [...quiz.items, admitted],
            version: quiz.version + 1,
          };
          this.save(quiz);
          accepted = true;
          break;
        } catch (error) {
          if (!(error instanceof CourseValidationError)) throw error;
          state.rejectedCount = contentAttempt + 1;
          state.findings = error.findings;
          // Rotate only for a content rejection. A timeout while authoring its revision
          // must keep the already selected representative on explicit recovery.
          if (contentAttempt === 0 && blueprint) {
            const selection = quiz.paperCoverageSelection.find((s) =>
              slot.cellIds.includes(s.cellId),
            )!;
            const cell = blueprint.cells.find((c) => c.id === selection.cellId)!;
            const rotated = new Set(cell.mandatoryKnowledgeIds);
            // Rotate narrow target pools first, then let a broader pool reuse a
            // selected member. A rejection must not inflate the paper with
            // redundant representatives of the same target.
            const representatives = [...selection.representatives].sort(
              (a, b) =>
                cell.representativeSets.find((s) => s.id === a.setId)!.candidateKnowledgeIds
                  .length -
                cell.representativeSets.find((s) => s.id === b.setId)!.candidateKnowledgeIds.length,
            );
            for (const representative of representatives) {
              const set = cell.representativeSets.find((s) => s.id === representative.setId)!;
              const alternatives = set.candidateKnowledgeIds.filter(
                (k) => k !== representative.knowledgeId,
              );
              const next = alternatives.find((k) => rotated.has(k)) ?? alternatives[0];
              if (next) {
                selection.replacements.push({
                  from: representative.knowledgeId,
                  to: next,
                  reason: state.findings.join(';'),
                });
                representative.knowledgeId = next;
              }
              rotated.add(representative.knowledgeId);
            }
            selection.knowledgeIds = [
              ...new Set([
                ...cell.mandatoryKnowledgeIds,
                ...selection.representatives.map((r) => r.knowledgeId),
              ]),
            ];
            slot.knowledgeIds = selection.knowledgeIds;
          }
          this.save(quiz);
          if (contentAttempt === 1) {
            quiz = {
              ...quiz,
              discarded: [
                ...quiz.discarded.filter((d) => d.slotId !== slot.id),
                {
                  slotId: slot.id,
                  reasons: [
                    ...new Set([
                      ...(quiz.discarded.find((d) => d.slotId === slot.id)?.reasons ?? []),
                      ...error.findings,
                    ]),
                  ],
                },
              ],
              version: quiz.version + 1,
            };
            this.save(quiz);
            break;
          }
        }
      }
      if (!accepted && !quiz.discarded.some((d) => d.slotId === slot.id))
        throw new AppError('GROUNDING_FAILED', '题目准入尚未完成。');
    }
    if (!quiz.items.length) throw new AppError('GROUNDING_FAILED', '没有有效题目，练习未就绪。');
    requireValid(checkPaperCoverage(quiz));
    ctx.check();
    this.sources.assertCurrent(ctx.workspaceId, this.planning.inventory(plan).sourceScopeHash);
    quiz = { ...quiz, status: 'ready', version: quiz.version + 1 };
    this.save(quiz);
    if (purpose === 'formal')
      this.repo.run(
        'INSERT OR IGNORE INTO assessment_versions VALUES(?,?,?,?,?)',
        quiz.id,
        ctx.workspaceId,
        sha256(blueprint),
        canonical({ quizId: quiz.id, blueprint, selection: quiz.paperCoverageSelection }),
        this.repo.now(),
      );
    return { resourceId: quiz.id };
  }
  private save(quiz: CourseQuiz) {
    this.repo.run(
      'UPDATE quizzes SET payload=?,status=? WHERE id=? AND status=?',
      canonical(quiz),
      quiz.status,
      quiz.id,
      'draft',
    );
  }
}
