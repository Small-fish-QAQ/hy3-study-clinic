import {
  COURSE_POLICY,
  LessonAuthorSchema,
  CourseLessonContentSchema,
  type CourseLessonContent,
  type CoursePlan,
  type CourseSession,
  type CourseKnowledge,
  type LessonAuthor,
  type CourseCommand,
  type CourseSourceSpan,
  type CourseTutorAnchor,
  type LessonReflection,
  normalizeLessonSelection,
} from '@hy3-clinic/shared';
import {
  LessonVerificationSchema,
  CourseTutorOutputSchema,
  type LessonInput,
} from '../llm/courseContract.js';
import type { ClinicRepository } from '../repositories/clinic.js';
import { newClinicId } from '../repositories/clinic.js';
import type { CoursePlanningService } from './coursePlanning.js';
import type { CourseSources } from './courseSources.js';
import type { CourseGeneration } from './courseGeneration.js';
import type { CourseOperationRunner } from './courseOperationRunner.js';
import { type CourseOperationContext } from './courseOperationRunner.js';
import { canonical, sha256, stableId } from '../util/canonical.js';
import { AppError, notFound } from '../errors.js';
import { validateLessonDelivery, selectLessonVerificationScopes } from './lessonDelivery.js';
import { CourseValidationError, requireValid } from './courseValidation.js';
import { mergeLessonRevision } from './lessonRevision.js';

export class CourseLessons {
  constructor(
    readonly repo: ClinicRepository,
    readonly planning: CoursePlanningService,
    readonly sources: CourseSources,
    readonly generation: CourseGeneration,
    readonly operations: CourseOperationRunner,
  ) {}
  list(workspaceId: string) {
    const plan = this.planning.current(workspaceId);
    const completed = new Set(
      this.repo
        .rows<{ lesson_id: string }>(
          'SELECT lesson_id FROM lesson_execution_events WHERE curriculum_id=?',
          plan.id,
        )
        .map((r) => r.lesson_id),
    );
    return plan.lessons.map((lesson) => ({
      ...lesson,
      completed: completed.has(lesson.id),
      content: this.content(plan, lesson.id),
      prerequisiteWarnings: lesson.prerequisiteLessonIds
        .filter((id) => !completed.has(id))
        .map((id) => plan.lessons.find((l) => l.id === id)?.title ?? id),
    }));
  }
  content(plan: CoursePlan, lessonId: string): CourseLessonContent | null {
    const lesson = plan.lessons.find((l) => l.id === lessonId);
    if (!lesson) throw notFound('Lesson不存在。');
    const inventory = this.planning.inventory(plan);
    const k = inventory.knowledge.filter((k) => lesson.knowledgeIds.includes(k.id));
    const key = this.semanticKey(
      plan.workspaceId,
      lessonId,
      lesson.selectedDepth,
      lesson.objectives,
      k,
      plan.preferences?.focusRequest,
    );
    const value = this.repo.payload<CourseLessonContent>(
      'SELECT payload FROM course_lesson_versions WHERE workspace_id=? AND semantic_key=? ORDER BY version DESC LIMIT 1',
      plan.workspaceId,
      key,
    );
    if (!value) return null;
    const accepted = CourseLessonContentSchema.parse(value);
    const check = validateLessonDelivery(lesson, k, accepted);
    if (
      sha256(check.anchors) !== sha256(accepted.deliveryCheck.anchors) ||
      check.requiredKnowledgeHash !== accepted.deliveryCheck.requiredKnowledgeHash ||
      check.localChecksHash !== accepted.deliveryCheck.localChecksHash
    )
      throw new AppError('GROUNDING_FAILED', '课文正文定位校验失败。');
    const sources = this.sources.references(
      plan.workspaceId,
      k.flatMap((k) => k.sourceSpans),
    );
    const scopes = selectLessonVerificationScopes(k, accepted, sources, check);
    requireValid(
      scopes.some(
        (scope) =>
          !accepted.deliveryCheck.targetedReceipts.some(
            (r) =>
              r.scopeHash === scope.hash &&
              scope.knowledgeIds.every((id) => r.knowledgeIds.includes(id)),
          ),
      )
        ? ['课文缺少当前必要scope的验证凭据']
        : [],
    );
    return accepted;
  }
  async prepare(ctx: CourseOperationContext, request: { curriculumId: string; lessonId: string }) {
    const plan = this.planning.get(ctx.workspaceId, request.curriculumId)!;
    if (plan.status !== 'accepted') throw new AppError('VERSION_CONFLICT', '请先确认课程。');
    const already = this.content(plan, request.lessonId);
    if (already) return { resourceId: already.id, lessonId: request.lessonId };
    const lesson = plan.lessons.find((l) => l.id === request.lessonId);
    if (!lesson) throw notFound('Lesson不存在。');
    const inventory = this.planning.inventory(plan);
    const k = inventory.knowledge.filter((k) => lesson.knowledgeIds.includes(k.id));
    const sources = this.sources.references(
      ctx.workspaceId,
      k.flatMap((k) => k.sourceSpans),
    );
    const sourceScope = sha256(sources);
    this.sources.assertRelevantCurrent(ctx.workspaceId, sources);
    let input: LessonInput = {
      lesson,
      knowledge: k,
      sources,
      preferences: plan.preferences,
      interactionPolicy: 'optional-reflection-v1',
    };
    let authored = await this.author(ctx, input, sourceScope);
    let candidate = authored.value;
    const receipts = new Map<
      string,
      CourseLessonContent['deliveryCheck']['targetedReceipts'][number]
    >();
    let check: CourseLessonContent['deliveryCheck'] | undefined;
    for (let patch = 0; patch < 2; patch++) {
      try {
        this.validateReferences(
          ctx.workspaceId,
          candidate,
          new Set(sources.map((s) => s.revisionId)),
        );
        check = validateLessonDelivery(lesson, k, candidate);
        const scopes = selectLessonVerificationScopes(k, candidate, sources, check).filter(
          (scope) => !receipts.has(scope.hash),
        );
        if (scopes.length) {
          const segmentIds = new Set(scopes.flatMap((s) => s.segmentIds));
          const relevantK = new Set(scopes.flatMap((s) => s.knowledgeIds));
          // A worked example may state a general rule whose conditions live in
          // an already accepted prerequisite. Include that read-only fact in
          // this same necessary check; it does not add another review or teach it anew.
          for (const item of k.filter((item) => relevantK.has(item.id)))
            item.prerequisiteKnowledgeIds.forEach((id) => relevantK.add(id));
          const verificationKnowledge = inventory.knowledge.filter((item) =>
            relevantK.has(item.id),
          );
          const verifyInput = {
            scopes,
            segments: candidate.segments.filter((s) => segmentIds.has(s.id)),
            knowledge: verificationKnowledge,
            sources: this.sources.references(
              ctx.workspaceId,
              verificationKnowledge.flatMap((k) => k.sourceSpans),
            ),
          };
          const reviewed = await this.generation.stage(
            ctx,
            'verifyLessonParts',
            verifyInput,
            sourceScope,
            LessonVerificationSchema,
            (opts) => ctx.provider.verifyLessonParts(verifyInput, opts),
          );
          const errors: string[] = [];
          for (const scope of scopes) {
            const result = reviewed.value.results.find(
              (r) => r.scopeId === scope.id && r.scopeHash === scope.hash,
            );
            if (
              !result ||
              !result.accepted ||
              scope.knowledgeIds.some((id) => !result.checkedKnowledgeIds.includes(id))
            )
              errors.push(
                ...(result?.findings.length
                  ? result.findings
                  : [`必要scope未通过:${scope.segmentIds.join(',')}`]),
              );
            else
              receipts.set(scope.hash, {
                scopeHash: scope.hash,
                callId: reviewed.callId,
                segmentIds: scope.segmentIds,
                knowledgeIds: scope.knowledgeIds,
              });
          }
          requireValid(errors);
        }
        check.targetedReceipts = [...receipts.values()].filter((r) =>
          candidate.segments.some((s) => r.segmentIds.includes(s.id)),
        );
        break;
      } catch (error) {
        if (!(error instanceof CourseValidationError)) throw error;
        if (patch === 1) {
          for (const callId of new Set(Object.values(authored.knowledgeCalls)))
            this.generation.reject(callId, error.findings);
          throw error;
        }
        const referencesOnly = error.issues?.every(
          (issue) => issue.code === 'lesson_source_reference',
        );
        const unsafe = (() => {
          if (referencesOnly)
            return candidate.segments
              .filter((s) => error.findings.some((f) => f.includes(s.id)))
              .map((s) => s.id);
          try {
            return selectLessonVerificationScopes(
              k,
              candidate,
              sources,
              validateLessonDelivery(lesson, k, candidate),
            )
              .filter((s) => !receipts.has(s.hash))
              .flatMap((s) => s.segmentIds);
          } catch {
            return candidate.segments
              .filter((s) => error.findings.some((f) => f.includes(s.id)))
              .map((s) => s.id);
          }
        })();
        const affectedKnowledge = new Set([
          ...candidate.teachingCoverage
            .filter(
              (c) =>
                unsafe.includes(c.segmentId) ||
                error.findings.some((f) => f.includes(c.knowledgeId)),
            )
            .map((c) => c.knowledgeId),
          ...k.filter((k) => error.findings.some((f) => f.includes(k.id))).map((k) => k.id),
        ]);
        if (!affectedKnowledge.size) k.forEach((k) => affectedKnowledge.add(k.id));
        for (const callId of new Set(
          [...affectedKnowledge]
            .map((id) => authored.knowledgeCalls[id])
            .filter((id): id is string => !!id),
        ))
          this.generation.reject(callId, error.findings);
        const segmentIds = [
          ...new Set([
            ...unsafe,
            ...(referencesOnly
              ? []
              : candidate.teachingCoverage
                  .filter((c) => affectedKnowledge.has(c.knowledgeId))
                  .map((c) => c.segmentId)),
          ]),
        ];
        const affectedCoverage = candidate.teachingCoverage.filter((c) =>
          referencesOnly ? segmentIds.includes(c.segmentId) : affectedKnowledge.has(c.knowledgeId),
        );
        const affectedObjectives = new Set(affectedCoverage.flatMap((c) => c.objectiveIds));
        const selectedKnowledge = k.filter((k) => affectedKnowledge.has(k.id));
        const patchLesson = {
          ...lesson,
          knowledgeIds: selectedKnowledge.map((k) => k.id),
          objectives: lesson.objectives
            .map((o) => ({
              ...o,
              knowledgeIds: o.knowledgeIds.filter((id) => affectedKnowledge.has(id)),
            }))
            .filter(
              (o) => o.knowledgeIds.length && (!referencesOnly || affectedObjectives.has(o.id)),
            ),
        };
        input = {
          interactionPolicy: 'optional-reflection-v1',
          preferences: plan.preferences,
          lesson: patchLesson,
          knowledge: selectedKnowledge,
          sources: this.sources.references(
            ctx.workspaceId,
            selectedKnowledge.flatMap((k) => k.sourceSpans),
          ),
          revision: {
            segmentIds,
            draft: {
              ...candidate,
              segments: candidate.segments.filter((s) => segmentIds.includes(s.id)),
              teachingCoverage: affectedCoverage,
            },
            findings: error.findings,
          },
        };
        const fixed = await this.author(ctx, input, sha256(input.sources));
        try {
          candidate = mergeLessonRevision(candidate, fixed.value, segmentIds, affectedCoverage);
        } catch (error) {
          if (error instanceof CourseValidationError)
            this.generation.reject(fixed.callId, error.findings);
          throw error;
        }
        authored = fixed;
        check = undefined;
      }
    }
    if (!check) throw new AppError('GROUNDING_FAILED', '必要讲解未通过验证。');
    ctx.check();
    this.sources.assertRelevantCurrent(ctx.workspaceId, sources);
    const semanticKey = this.semanticKey(
      ctx.workspaceId,
      lesson.id,
      lesson.selectedDepth,
      lesson.objectives,
      k,
      plan.preferences?.focusRequest,
    );
    const content = CourseLessonContentSchema.parse({
      ...candidate,
      id: stableId('lesson_version', semanticKey),
      workspaceId: ctx.workspaceId,
      curriculumId: plan.id,
      lessonId: lesson.id,
      semanticKey,
      version: 1,
      sourceScopeHash: sourceScope,
      policyVersion: COURSE_POLICY,
      deliveryCheck: check,
    });
    this.repo.run(
      'INSERT OR IGNORE INTO course_lesson_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      content.id,
      ctx.workspaceId,
      plan.id,
      lesson.id,
      semanticKey,
      1,
      sourceScope,
      COURSE_POLICY,
      null,
      canonical(content),
      this.repo.now(),
    );
    return { resourceId: content.id, lessonId: lesson.id };
  }
  visit(
    workspaceId: string,
    command: CourseCommand,
    lessonVersionId: string,
    curriculumId: string,
    purpose: CourseSession['purpose'] = 'learning',
    originSessionId: string | null = null,
  ): CourseSession {
    return this.repo.command(
      workspaceId,
      command,
      { action: 'visit', lessonVersionId, curriculumId, purpose, originSessionId },
      () => {
        const content = this.repo.owned<CourseLessonContent>(
          'course_lesson_versions',
          lessonVersionId,
          workspaceId,
        );
        const plan = this.planning.get(workspaceId, curriculumId)!;
        if (
          (plan.status !== 'accepted' &&
            !(purpose === 'revisit' && plan.status === 'superseded')) ||
          !plan.lessons.some((l) => l.id === content.lessonId) ||
          this.content(plan, content.lessonId)?.id !== content.id
        )
          throw new AppError('VERSION_CONFLICT', '课文与当前确认课程不匹配。');
        if (originSessionId) {
          const origin = this.repo.owned<CourseSession>(
            'study_sessions',
            originSessionId,
            workspaceId,
          );
          if (origin.lessonVersionId !== content.id)
            throw new AppError('VERSION_CONFLICT', '回看来源课堂不匹配。');
        }
        const active =
          purpose === 'learning'
            ? this.repo.payload<CourseSession>(
                "SELECT payload FROM study_sessions WHERE workspace_id=? AND curriculum_id=? AND lesson_version_id=? AND purpose='learning' ORDER BY created_at DESC LIMIT 1",
                workspaceId,
                curriculumId,
                lessonVersionId,
              )
            : null;
        if (active) return active;
        const session: CourseSession = {
          id: newClinicId('visit'),
          workspaceId,
          curriculumId,
          lessonVersionId,
          purpose,
          originSessionId,
          status: 'active',
          createdAt: this.repo.now(),
          completedAt: null,
        };
        this.repo.run(
          'INSERT INTO study_sessions VALUES(?,?,?,?,?,?,?,?,?)',
          session.id,
          workspaceId,
          curriculumId,
          lessonVersionId,
          purpose,
          originSessionId,
          session.status,
          canonical(session),
          session.createdAt,
        );
        return session;
      },
    );
  }
  complete(
    workspaceId: string,
    command: CourseCommand,
    lessonId: string,
    visitId: string,
    lessonVersionId: string,
  ) {
    return this.repo.command(
      workspaceId,
      command,
      { action: 'complete', lessonId, visitId, lessonVersionId },
      () => {
        const session = this.repo.owned<CourseSession>('study_sessions', visitId, workspaceId);
        const content = this.repo.owned<CourseLessonContent>(
          'course_lesson_versions',
          lessonVersionId,
          workspaceId,
        );
        if (
          session.lessonVersionId !== content.id ||
          content.lessonId !== lessonId ||
          session.purpose !== 'learning'
        )
          throw new AppError('VERSION_CONFLICT', '完成命令与已打开课堂不匹配。');
        if (session.status === 'completed') return session;
        const next: CourseSession = {
          ...session,
          status: 'completed',
          completedAt: this.repo.now(),
        };
        this.repo.run(
          'UPDATE study_sessions SET status=?,payload=? WHERE id=?',
          next.status,
          canonical(next),
          next.id,
        );
        this.repo.run(
          'INSERT OR IGNORE INTO lesson_execution_events VALUES(?,?,?,?,?,?,?,?)',
          newClinicId('completion'),
          workspaceId,
          session.curriculumId,
          lessonId,
          session.id,
          'complete_lesson',
          canonical({ lessonVersionId, completedAt: next.completedAt }),
          next.completedAt,
        );
        return next;
      },
    );
  }
  classroom(workspaceId: string, sessionId: string) {
    const session = this.repo.owned<CourseSession>('study_sessions', sessionId, workspaceId);
    const content = this.repo.owned<CourseLessonContent>(
      'course_lesson_versions',
      session.lessonVersionId,
      workspaceId,
    );
    const turns = this.repo.payloads<{
      id: string;
      question: string;
      text: string;
      createdAt: string;
      includesExtension: boolean;
      sourceRefs?: CourseSourceSpan[];
      anchor?: CourseTutorAnchor;
    }>('SELECT payload FROM study_turns WHERE session_id=? ORDER BY sequence', sessionId);
    const sessions = this.repo.payloads<CourseSession>(
      'SELECT payload FROM study_sessions WHERE workspace_id=? AND lesson_version_id=? ORDER BY created_at',
      workspaceId,
      session.lessonVersionId,
    );
    const citedSpans = [
      ...content.segments.flatMap((segment) => segment.sourceRefs),
      ...turns.flatMap((turn) => turn.sourceRefs ?? []),
    ];
    const sourceQuotes = [
      ...new Map(citedSpans.map((span) => [canonical(span), span])).values(),
    ].map((span) => ({
      span,
      title: this.repo.owned<{ title: string }>('material_revisions', span.revisionId, workspaceId)
        .title,
      quote: this.sources.validateSpan(workspaceId, span),
    }));
    const reflections = this.repo.payloads<LessonReflection>(
      'SELECT payload FROM lesson_reflections WHERE workspace_id=? AND lesson_version_id=? ORDER BY updated_at',
      workspaceId,
      content.id,
    );
    return { session, content, turns, sessions, sourceQuotes, reflections };
  }
  async tutor(
    workspaceId: string,
    sessionId: string,
    question: string,
    provider: CourseOperationContext['provider'],
    anchor?: CourseTutorAnchor,
  ) {
    const transcriptBefore = this.classroom(workspaceId, sessionId);
    const { session, content, turns } = transcriptBefore;
    if (session.status !== 'active')
      throw new AppError('VERSION_CONFLICT', '历史课堂已只读，请创建新的回看对话。');
    let anchorContext: { segmentId: string; text: string }[] | undefined;
    if (anchor) {
      const indices = anchor.segmentIds.map((id) => content.segments.findIndex((s) => s.id === id));
      if (
        anchor.lessonVersionId !== content.id ||
        indices.some((v, i) => v < 0 || (i > 0 && v !== indices[i - 1]! + 1))
      )
        throw new AppError('VALIDATION_ERROR', '引用不属于当前课文的连续段落。');
      anchorContext = indices.map((i) => ({
        segmentId: content.segments[i]!.id,
        text: content.segments[i]!.text,
      }));
      if (
        !normalizeLessonSelection(anchorContext.map((s) => s.text).join(' ')).includes(
          normalizeLessonSelection(anchor.selectedText),
        )
      )
        throw new AppError('VALIDATION_ERROR', '选中文字与保存的讲解不一致，请重新选择。');
    }
    const spans = content.segments.flatMap((s) => s.sourceRefs);
    const allSources = this.sources.references(workspaceId, spans);
    const terms = question.split(/\s+/u).filter((t) => t.length > 1);
    const selectedSources = allSources.filter((s) => terms.some((t) => s.text.includes(t)));
    const input = {
      lesson: {
        title: content.title,
        segments: content.segments,
        teachingCoverage: content.teachingCoverage,
      },
      question,
      ...(anchor ? { anchor, anchorContext } : {}),
      recentTurns: turns.slice(-6).map((t) => ({
        question: t.question,
        text: t.text,
        ...(t.anchor ? { anchor: t.anchor } : {}),
      })),
      sources: selectedSources.length ? selectedSources : allSources,
    };
    const turnContext = {
      operationId: null,
      workspaceId,
      fence: 1,
      provider,
      signal: new AbortController().signal,
      check: () => {
        const current = this.repo.owned<CourseSession>('study_sessions', sessionId, workspaceId);
        if (
          current.status !== 'active' ||
          this.repo.row<{ n: number }>(
            'SELECT COUNT(*) AS n FROM study_turns WHERE session_id=?',
            sessionId,
          )!.n !== transcriptBefore.turns.length
        )
          throw new AppError('VERSION_CONFLICT', '本课堂已有新回复或已结束。');
      },
    } as const;
    const generated = await this.generation.stage(
      turnContext,
      'respondToTutorTurn',
      { ...input, turnScope: { sessionId, nextTurn: turns.length + 1 } },
      sha256(input.sources),
      CourseTutorOutputSchema,
      (opts) => provider.respondToTutorTurn(input, opts),
    );
    const result = generated.value;
    const refs = result.sourceRefs.filter((ref) => {
      try {
        this.sources.validateSpan(workspaceId, ref, new Set(allSources.map((s) => s.revisionId)));
        return allSources.some((s) => s.id === ref.blockId);
      } catch {
        return false;
      }
    });
    return this.repo.transaction(() => {
      const latest = this.repo.owned<CourseSession>('study_sessions', sessionId, workspaceId);
      if (latest.status !== 'active')
        throw new AppError('VERSION_CONFLICT', '课堂已完成，回复未写入旧历史。');
      if (
        this.repo.row<{ n: number }>(
          'SELECT COUNT(*) AS n FROM study_turns WHERE session_id=?',
          sessionId,
        )!.n !== transcriptBefore.turns.length
      )
        throw new AppError('VERSION_CONFLICT', '本课堂已有新回复，请根据最新对话继续提问。');
      const sequence =
        (this.repo.row<{ n: number }>(
          'SELECT MAX(sequence) AS n FROM study_turns WHERE session_id=?',
          sessionId,
        )?.n ?? 0) + 1;
      const turn = {
        id: newClinicId('turn'),
        question,
        ...(anchor ? { anchor } : {}),
        text: result.text,
        sourceRefs: refs,
        includesExtension: result.includesExtension,
        createdAt: this.repo.now(),
      };
      this.repo.run(
        'INSERT INTO study_turns VALUES(?,?,?,?,?,?,?)',
        turn.id,
        workspaceId,
        sessionId,
        sequence,
        question,
        canonical(turn),
        turn.createdAt,
      );
      return turn;
    });
  }
  private semanticKey(
    workspaceId: string,
    lessonId: string,
    depth: string,
    objectives: unknown,
    knowledge: CourseKnowledge[],
    focusRequest?: string,
  ) {
    return sha256({
      workspaceId,
      lessonId,
      depth,
      objectives,
      knowledge,
      focusRequest,
      policy: COURSE_POLICY,
      locale: 'zh-CN',
    });
  }
  private async author(
    ctx: CourseOperationContext,
    input: LessonInput,
    scope: string,
  ): Promise<{ value: LessonAuthor; callId: string; knowledgeCalls: Record<string, string> }> {
    const contextCap = ctx.provider.contextCap;
    if (!contextCap || Buffer.byteLength(JSON.stringify(input)) / 2 < contextCap * 0.6) {
      // Resume known local revisions as drafts, never replay a rejected patch forever.
      // Two rejected local candidates is a bounded stop, not permission to regenerate the Lesson.
      if (input.revision) {
        let current = input;
        for (let rejected = 0; rejected < 2; rejected++) {
          const retained = this.generation.retainedStage(
            ctx,
            'generateLesson',
            current,
            scope,
            LessonAuthorSchema,
          );
          let prior =
            retained &&
            this.repo.payload<{ contentRejected?: boolean; rejectionFindings?: string[] }>(
              'SELECT payload FROM llm_calls WHERE id=?',
              retained.callId,
            );
          const locatorOnly = prior?.rejectionFindings?.every((f) =>
            /^(?:正文quote不存在或定位不唯一|正文漏讲|正文漏教学目标):/u.test(f),
          );
          if (retained && (!prior?.contentRejected || locatorOnly)) {
            try {
              this.validateReferences(
                ctx.workspaceId,
                retained.value,
                new Set(current.sources.map((s) => s.revisionId)),
              );
              validateLessonDelivery(current.lesson, current.knowledge, retained.value);
              // Revalidate a known mechanical locator failure under the current contract.
              // Keep its rejection history; publication still requires merged source/math checks.
              if (locatorOnly) prior = undefined;
            } catch (error) {
              if (!(error instanceof CourseValidationError)) throw error;
              this.generation.reject(retained.callId, error.findings);
              prior = { contentRejected: true, rejectionFindings: error.findings };
            }
          }
          if (retained && prior?.contentRejected) {
            current = {
              ...input,
              revision: {
                ...input.revision,
                draft: retained.value,
                findings: prior.rejectionFindings ?? input.revision.findings,
              },
            };
            continue;
          }
          const authored =
            retained ??
            (await this.generation.stage(
              ctx,
              'generateLesson',
              current,
              scope,
              LessonAuthorSchema,
              (opts) => ctx.provider.generateLesson(current, opts),
            ));
          return {
            ...authored,
            knowledgeCalls: Object.fromEntries(input.knowledge.map((k) => [k.id, authored.callId])),
          };
        }
        throw new AppError(
          'PROVIDER_INVALID_OUTPUT',
          '局部修订已连续两次未通过。原课文候选和其他段落已保存，本次不能继续重复相同恢复；请展开失败详情检查被定位的内容，修正相关资料或联系维护者后再打开本课。',
          { retryable: false },
        );
      }
      const authored =
        this.generation.retainedStage(ctx, 'generateLesson', input, scope, LessonAuthorSchema) ??
        (await this.generation.stage(
          ctx,
          'generateLesson',
          input,
          scope,
          LessonAuthorSchema,
          (opts) => ctx.provider.generateLesson(input, opts),
        ));
      return {
        ...authored,
        knowledgeCalls: Object.fromEntries(input.knowledge.map((k) => [k.id, authored.callId])),
      };
    }
    if (input.knowledge.length === 1)
      throw new AppError(
        'SOURCE_TOO_LARGE',
        '一个必需讲解单元连同条件超过模型上下文，请配置实际容量或补充可分离来源。',
      );
    const groups: CourseKnowledge[][] = [];
    let current: CourseKnowledge[] = [];
    const make = (group: CourseKnowledge[]): LessonInput => {
      const ids = new Set(group.map((k) => k.id));
      return {
        ...input,
        lesson: {
          ...input.lesson,
          knowledgeIds: [...ids],
          objectives: input.lesson.objectives
            .map((o) => ({ ...o, knowledgeIds: o.knowledgeIds.filter((id) => ids.has(id)) }))
            .filter((o) => o.knowledgeIds.length),
        },
        knowledge: group,
        sources: this.sources.references(
          ctx.workspaceId,
          group.flatMap((k) => k.sourceSpans),
        ),
      };
    };
    for (const knowledge of input.knowledge) {
      if (
        current.length &&
        Buffer.byteLength(JSON.stringify(make([...current, knowledge]))) / 2 > contextCap * 0.6
      ) {
        groups.push(current);
        current = [];
      }
      current.push(knowledge);
    }
    if (current.length) groups.push(current);
    if (groups.length === 1)
      throw new AppError('SOURCE_TOO_LARGE', '讲解分包未能缩小必要上下文，已停止无进展拆分。');
    const segments: LessonAuthor['segments'] = [];
    const coverage: LessonAuthor['teachingCoverage'] = [];
    const calls: string[] = [];
    const knowledgeCalls: Record<string, string> = {};
    for (const group of groups) {
      const packet = make(group);
      const authored = await this.author(ctx, packet, sha256(packet.sources));
      const prefix = sha256(group).slice(0, 12);
      segments.push(...authored.value.segments.map((s) => ({ ...s, id: `${prefix}:${s.id}` })));
      coverage.push(
        ...authored.value.teachingCoverage.map((c) => ({
          ...c,
          segmentId: `${prefix}:${c.segmentId}`,
        })),
      );
      calls.push(authored.callId);
      Object.assign(knowledgeCalls, authored.knowledgeCalls);
    }
    return {
      value: { title: input.lesson.title, segments, teachingCoverage: coverage },
      callId: calls[0]!,
      knowledgeCalls,
    };
  }
  private validateReferences(workspaceId: string, candidate: LessonAuthor, revisions: Set<string>) {
    const findings: string[] = [];
    const issues: NonNullable<CourseValidationError['issues']> = [];
    for (const s of candidate.segments) {
      const errors: string[] = [];
      if (s.origin === 'extension' && s.sourceRefs.length) errors.push('拓展段落借用教材权威');
      if (s.origin === 'textbook' && !s.sourceRefs.length) errors.push('教材讲解缺来源');
      for (const ref of s.sourceRefs) {
        try {
          this.sources.validateSpan(workspaceId, ref, revisions);
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            !['NOT_FOUND', 'GROUNDING_FAILED'].includes(error.code)
          )
            throw error;
          errors.push(`引文不存在、越界或不属于当前来源:${ref.blockId}`);
        }
      }
      for (const message of errors) {
        findings.push(`${s.id}:${message}`);
        issues.push({
          code: 'lesson_source_reference',
          path: `segments.${s.id}.sourceRefs`,
          message,
        });
      }
    }
    if (findings.length) throw new CourseValidationError(findings, issues);
  }
}
