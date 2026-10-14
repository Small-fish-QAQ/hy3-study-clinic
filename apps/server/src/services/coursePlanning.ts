import { generateCoursePlanningBatches } from './coursePlanningBatches.js';
import { planningReviewLessons } from './courseCorrectnessScopes.js';
import {
  COURSE_POLICY,
  CoursePlanSchema,
  CourseAssessmentBlueprintSchema,
  CoursePreferencesSchema,
  type CoursePreferences,
  type CourseKnowledgeInventory,
  type CoursePlan,
  type LessonDepth,
  type CourseDemand,
} from '@hy3-clinic/shared';
import {
  PlanOutputSchema,
  ScopeReviewSchema,
  PlanRevisionOutputSchema,
  type PlanOutput,
  type PlanInput,
} from '../llm/courseContract.js';
import type { ClinicRepository } from '../repositories/clinic.js';
import type { CourseSources } from './courseSources.js';
import type { CourseKnowledgeService } from './courseKnowledge.js';
import type { CourseGeneration } from './courseGeneration.js';
import type { CourseOperationContext } from './courseOperationRunner.js';
import { CourseValidationError, requireValid, unique, demandRank } from './courseValidation.js';
import { canonical, sha256, stableId } from '../util/canonical.js';
import { AppError } from '../errors.js';
import { validateCoursePlan, coursePlanIssues, assertPlanIssues } from './coursePlanValidation.js';
import {
  normalizePlanReferences,
  planRevisionInput,
  mergePlanRevision,
} from './coursePlanRevision.js';
import {
  latestPlanningCandidate,
  legacyPlanningCandidate,
  savePlanningCandidate,
  planningRequestKey,
  planningProviderSnapshot,
  type PlanningCandidate,
} from './coursePlanCandidates.js';
export { validateCoursePlan } from './coursePlanValidation.js';

export class CoursePlanningService {
  constructor(
    readonly repo: ClinicRepository,
    readonly sources: CourseSources,
    readonly knowledge: CourseKnowledgeService,
    readonly generation: CourseGeneration,
  ) {}
  get(workspaceId: string, id?: string): CoursePlan | null {
    this.repo.workspace(workspaceId);
    if (id) {
      const plan = this.repo.owned<CoursePlan>('curriculum_versions', id, workspaceId);
      const row = this.repo.row<{ status: CoursePlan['status'] }>(
        'SELECT status FROM curriculum_versions WHERE id=?',
        id,
      )!;
      return { ...CoursePlanSchema.parse(plan), status: row.status };
    }
    const row = this.repo.row<{ status: CoursePlan['status']; payload: string }>(
      "SELECT status,payload FROM curriculum_versions WHERE workspace_id=? AND status<>'superseded' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      workspaceId,
    );
    return row ? { ...CoursePlanSchema.parse(JSON.parse(row.payload)), status: row.status } : null;
  }
  current(workspaceId: string): CoursePlan {
    const row = this.repo.row<{ payload: string }>(
      "SELECT payload FROM curriculum_versions WHERE workspace_id=? AND status='accepted' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      workspaceId,
    );
    if (!row) throw new AppError('VERSION_CONFLICT', '请先确认完整课程规划。');
    return CoursePlanSchema.parse(JSON.parse(row.payload));
  }
  inventory(plan: CoursePlan) {
    return this.repo.owned<CourseKnowledgeInventory>(
      'course_knowledge_inventories',
      plan.inventoryId,
      plan.workspaceId,
    );
  }
  async prepare(
    ctx: CourseOperationContext,
    request: { sourceScopeHash: string; preferences?: CoursePreferences },
  ) {
    const preferences = request.preferences
      ? CoursePreferencesSchema.parse(request.preferences)
      : undefined;
    let inventory = await this.knowledge.extract(ctx, request.sourceScopeHash);
    const totalSourceBlocks = this.sources.blocks(ctx.workspaceId).length;
    const report = (
      phase: 'planning' | 'validation' | 'ready',
      label: string,
      lessonCount?: number,
    ) =>
      ctx.report?.({
        phase,
        label,
        totalSourceBlocks,
        completedSourceBlocks: totalSourceBlocks,
        knowledgeCount: inventory.knowledge.length,
        ...(lessonCount === undefined ? {} : { lessonCount }),
      });
    report('planning', '正在组织模块、Lesson、学习目标与考核要求');
    const existing = this.repo
      .payloads<CoursePlan>(
        "SELECT payload FROM curriculum_versions WHERE workspace_id=? AND knowledge_inventory_id=? AND status IN ('draft','accepted') ORDER BY created_at DESC,rowid DESC",
        ctx.workspaceId,
        inventory.id,
      )
      .at(0);
    let id = stableId('curriculum', {
      workspace: ctx.workspaceId,
      inventory: inventory.id,
      policy: COURSE_POLICY,
      preferences,
      operation: ctx.operationId,
    });
    let key = planningRequestKey(
      ctx,
      inventory,
      this.repo.workspace(ctx.workspaceId).title,
      preferences,
    );
    let saved = latestPlanningCandidate(this.repo, ctx, inventory, key);
    if (
      existing &&
      sha256(existing.preferences ?? null) === sha256(preferences ?? null) &&
      (existing.status === 'accepted' || !!saved) &&
      !saved?.findings.length
    ) {
      report('ready', '完整规划已保存，等待你的审阅', existing.lessons.length);
      return { resourceId: existing.id };
    }
    if (!saved) {
      const generated = await this.generate(ctx, inventory, preferences);
      const value = this.normalizeOutput(generated.value, preferences);
      saved = savePlanningCandidate(
        this.repo,
        ctx,
        inventory,
        key,
        { ...generated, value },
        coursePlanIssues(value, inventory),
      );
    }
    let output = this.normalizeOutput(saved.value, preferences);
    // Locate legacy responsibility from the original complete negative review.
    // A later positive review of unchanged content cannot erase the known defect.
    const contexts = coursePlanIssues(output, inventory).length
      ? []
      : this.reviewInputs(ctx, this.compile(id, ctx.workspaceId, inventory, output), inventory);
    for (const { input, reviewContextHash } of contexts) {
      if (!saved.findings.some((i) => i.reviewContextHash === reviewContextHash)) continue;
      const baseKey = sha256({
        workspaceId: ctx.workspaceId,
        method: 'reviewKnowledgeScope',
        input,
        sourceScopeHash: sha256(input.blocks),
        policy: COURSE_POLICY,
        provider: planningProviderSnapshot(ctx, 'reviewKnowledgeScope'),
      });
      const retained = this.repo.rows<{ payload: string; candidate_hash: string }>(
        `SELECT s.payload,s.candidate_hash FROM semantic_cache s
         JOIN llm_calls c ON c.id=json_extract(s.payload,'$.callId')
         JOIN llm_physical_attempts p ON p.id=s.physical_attempt_id AND p.logical_call_id=c.id
         WHERE c.workspace_id=? AND c.method='reviewKnowledgeScope' AND c.status='completed'
           AND p.status='completed' AND c.generation_key=s.generation_key
           AND json_extract(c.payload,'$.baseKey')=?`,
        ctx.workspaceId,
        baseKey,
      );
      for (const row of retained) {
        const envelope = JSON.parse(row.payload) as { value: unknown };
        if (sha256(envelope.value) !== row.candidate_hash)
          throw new AppError('GROUNDING_FAILED', '保存的语义错误依据完整性不符。');
        const value = ScopeReviewSchema.parse(envelope.value);
        for (const issue of value.issues ?? []) {
          if (issue.target === 'lesson' || (!issue.target && issue.code === 'objective_mismatch'))
            continue;
          saved = {
            ...saved,
            findings: saved.findings.map((finding) =>
              finding.reviewContextHash === reviewContextHash && finding.message === issue.message
                ? {
                    ...finding,
                    code: 'knowledge_requires_revision',
                    path: `inventory.knowledge(${issue.knowledgeIds.join(',')})`,
                  }
                : finding,
            ),
          };
        }
      }
    }
    const knowledgeIssues = saved.findings.filter((i) => i.code === 'knowledge_requires_revision');
    if (knowledgeIssues.length) {
      const previous = saved;
      inventory = await this.knowledge.correct(ctx, inventory, knowledgeIssues);
      key = planningRequestKey(
        ctx,
        inventory,
        this.repo.workspace(ctx.workspaceId).title,
        preferences,
      );
      id = stableId('curriculum', {
        workspace: ctx.workspaceId,
        inventory: inventory.id,
        policy: COURSE_POLICY,
        preferences,
        operation: ctx.operationId,
      });
      saved = savePlanningCandidate(
        this.repo,
        ctx,
        inventory,
        key,
        { value: output, callIds: previous.callIds },
        previous.findings.filter((i) => i.code !== 'knowledge_requires_revision'),
      );
    }
    let plan: CoursePlan | undefined;
    for (let patch = 0; patch < 2; patch++) {
      report('validation', '正在本地检查必学知识、先修与考核范围', output.lessons.length);
      const structuralIssues = coursePlanIssues(output, inventory);
      const currentReviewContexts = new Set(
        (structuralIssues.length
          ? []
          : this.reviewInputs(ctx, this.compile(id, ctx.workspaceId, inventory, output), inventory)
        ).map(({ reviewContextHash }) => reviewContextHash),
      );
      const pending = saved.findings.filter(
        (i) =>
          i.code === 'knowledge_requires_revision' ||
          (i.code === 'semantic_plan' &&
            !!i.reviewContextHash &&
            currentReviewContexts.has(i.reviewContextHash)),
      );
      const issues = [...structuralIssues, ...pending];
      if (!issues.length) {
        plan = validateCoursePlan(this.compile(id, ctx.workspaceId, inventory, output), inventory);
        if (preferences) plan = { ...plan, preferences };
        break;
      }
      if (patch === 1) {
        this.generation.reject(
          saved.callIds.at(-1)!,
          issues.map((i) => `${i.path}: ${i.message}`),
        );
        assertPlanIssues(issues);
      }
      report('planning', '正在修订具体目标或考核引用，已保存的其他规划保留', output.lessons.length);
      const input = planRevisionInput(output, inventory, issues, preferences);
      let revised = this.generation.retainedStage(
        ctx,
        'reviseCoursePlan',
        input,
        inventory.sourceScopeHash,
        PlanRevisionOutputSchema,
      );
      // Rejected repair output can be inspected, but cannot repeatedly win cache selection.
      if (
        revised &&
        this.repo.payload<{ contentRejected?: boolean }>(
          'SELECT payload FROM llm_calls WHERE id=?',
          revised.callId,
        )?.contentRejected
      )
        revised = null;
      revised ??= await this.generation.stage(
        ctx,
        'reviseCoursePlan',
        input,
        inventory.sourceScopeHash,
        PlanRevisionOutputSchema,
        (opts) => ctx.provider.reviseCoursePlan(input, opts),
      );
      try {
        const merged = mergePlanRevision(output, input, revised.value);
        output = this.normalizeOutput(merged, preferences);
        saved = savePlanningCandidate(
          this.repo,
          ctx,
          inventory,
          key,
          { value: output, callIds: [...saved.callIds, revised.callId] },
          coursePlanIssues(output, inventory),
          saved.id,
        );
      } catch (error) {
        if (error instanceof CourseValidationError)
          this.generation.reject(revised.callId, error.findings);
        throw error;
      }
    }
    if (!plan) throw new AppError('GROUNDING_FAILED', '课程规划尚未完成。');
    const reviewInputs = this.reviewInputs(ctx, plan, inventory);
    const semanticIssues: ReturnType<typeof coursePlanIssues> = [];
    const semanticFindings: string[] = [];
    if (reviewInputs.length) {
      for (const { input, reviewContextHash } of reviewInputs) {
        const { blocks, knowledge: k } = input;
        const review = await this.generation.stage(
          ctx,
          'reviewKnowledgeScope',
          input,
          sha256(blocks),
          ScopeReviewSchema,
          (opts) => ctx.provider.reviewKnowledgeScope(input, opts),
        );
        if (
          !review.value.accepted ||
          !k.every((k) => review.value.checkedKnowledgeIds.includes(k.id))
        ) {
          const findings = review.value.findings.length
            ? review.value.findings
            : ['目标语义核查未通过'];
          this.generation.reject(review.callId, findings);
          if (review.value.issues?.length) {
            const semantic = review.value.issues.map((issue) => {
              const lessonIds = output.lessons
                .filter((l) =>
                  issue.lessonIds.includes(
                    stableId('lesson', {
                      workspaceId: ctx.workspaceId,
                      authorId: l.id,
                      knowledgeIds: [...l.knowledgeIds].sort(),
                    }),
                  ),
                )
                .map((l) => l.id);
              const knowledgeFault = issue.target === 'knowledge' || !lessonIds.length;
              return {
                code: knowledgeFault ? 'knowledge_requires_revision' : 'semantic_plan',
                path: !knowledgeFault
                  ? `lessons(${lessonIds.join(',')})`
                  : `inventory.knowledge(${issue.knowledgeIds.join(',')})`,
                message: issue.message,
                lessonIds,
                knowledgeIds: issue.knowledgeIds,
                reviewContextHash,
              };
            });
            semanticIssues.push(...semantic);
            semanticFindings.push(...findings);
            // Finish the already necessary local checks so an explicit retry can
            // repair all located lesson defects together. Unknown or unrepairable
            // knowledge failures still stop immediately.
            if (semantic.every((i) => i.code === 'semantic_plan')) continue;
          }
          if (semanticIssues.length)
            savePlanningCandidate(
              this.repo,
              ctx,
              inventory,
              key,
              { value: output, callIds: saved.callIds },
              semanticIssues,
              saved.id,
            );
          throw new CourseValidationError(findings);
        }
      }
    }
    if (semanticIssues.length) {
      savePlanningCandidate(
        this.repo,
        ctx,
        inventory,
        key,
        { value: output, callIds: saved.callIds },
        semanticIssues,
        saved.id,
      );
      throw new CourseValidationError(semanticFindings);
    }
    ctx.check();
    this.sources.assertCurrent(ctx.workspaceId, inventory.sourceScopeHash);
    this.repo.run(
      'INSERT OR IGNORE INTO curriculum_versions VALUES(?,?,?,?,?,?,?)',
      plan.id,
      ctx.workspaceId,
      inventory.id,
      plan.version,
      plan.status,
      canonical(plan),
      this.repo.now(),
    );
    report('ready', '完整课程规划已准备好', plan.lessons.length);
    return { resourceId: plan.id };
  }
  private reviewInputs(
    ctx: CourseOperationContext,
    plan: CoursePlan,
    inventory: CourseKnowledgeInventory,
  ) {
    return planningReviewLessons(plan, inventory.knowledge).map((lesson) => {
      const keys = new Set(lesson.knowledgeIds);
      const knowledge = inventory.knowledge.filter((k) => keys.has(k.id));
      const supporting = new Set(keys);
      for (;;) {
        const before = supporting.size;
        inventory.knowledge
          .filter((k) => supporting.has(k.id))
          .flatMap((k) => k.prerequisiteKnowledgeIds)
          .forEach((id) => supporting.add(id));
        if (supporting.size === before) break;
      }
      const blocks = this.sources.references(
        ctx.workspaceId,
        inventory.knowledge.filter((k) => supporting.has(k.id)).flatMap((k) => k.sourceSpans),
      );
      const input = {
        blocks,
        knowledge,
        lessons: [lesson],
        findings: ['核查目标与绑定知识及关联条件/例外是否一致，限制条件不能被替换或遗漏'],
      };
      return {
        input,
        reviewContextHash: sha256({
          input,
          provider: planningProviderSnapshot(ctx, 'reviewKnowledgeScope'),
        }),
      };
    });
  }
  patchDepth(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    changes: { lessonId: string; depth: LessonDepth }[],
  ): CoursePlan {
    const plan = this.get(workspaceId, id)!;
    if (plan.status !== 'draft' || plan.version !== expectedVersion)
      throw new AppError('VERSION_CONFLICT', '规划已确认或版本已改变，修改需要明确新版本。');
    const inventory = this.inventory(plan);
    requireValid(
      !unique(changes.map((c) => c.lessonId)) ||
        changes.some((c) => !plan.lessons.some((l) => l.id === c.lessonId))
        ? ['深度修改含重复或外来Lesson']
        : [],
    );
    const next = this.withDepths({ ...plan, version: plan.version + 1 }, inventory, changes);
    this.repo.run(
      "UPDATE curriculum_versions SET version=?,payload=? WHERE id=? AND version=? AND status='draft'",
      next.version,
      canonical(next),
      id,
      expectedVersion,
    );
    return next;
  }
  private withDepths(
    plan: CoursePlan,
    inventory: CourseKnowledgeInventory,
    changes: { lessonId: string; depth: LessonDepth }[],
  ): CoursePlan {
    const lessons = plan.lessons.map((lesson) => {
      const change = changes.find((c) => c.lessonId === lesson.id);
      if (!change) return lesson;
      return {
        ...lesson,
        selectedDepth: change.depth,
        objectives: lesson.objectives.map((o) => ({
          ...o,
          demand: this.depthDemand(
            change.depth,
            inventory.knowledge.filter((k) => o.knowledgeIds.includes(k.id)),
          ),
        })),
      };
    });
    const objectives = new Map(lessons.flatMap((l) => l.objectives.map((o) => [o.id, o] as const)));
    const blueprint = {
      ...plan.assessmentBlueprint,
      cells: plan.assessmentBlueprint.cells.map((c) => {
        const ranks = c.objectiveIds.map((id) => objectives.get(id)?.demand ?? c.demand);
        const demand = ranks.sort((a, b) => demandRank[b] - demandRank[a])[0]!;
        return {
          ...c,
          demand,
          difficultyBand: (demandRank[demand] >= 3
            ? 'advanced'
            : demandRank[demand] <= 1
              ? 'basic'
              : 'standard') as typeof c.difficultyBand,
        };
      }),
    };
    return validateCoursePlan({ ...plan, lessons, assessmentBlueprint: blueprint }, inventory);
  }
  confirm(workspaceId: string, id: string, expectedVersion: number): CoursePlan {
    return this.repo.transaction(() => {
      const plan = this.get(workspaceId, id)!;
      if (plan.status === 'accepted' && plan.version === expectedVersion) return plan;
      if (plan.status !== 'draft' || plan.version !== expectedVersion)
        throw new AppError('VERSION_CONFLICT', '规划版本已改变，请刷新。');
      const inventory = this.inventory(plan);
      this.sources.assertCurrent(workspaceId, inventory.sourceScopeHash);
      validateCoursePlan(plan, inventory);
      const saved = this.repo.payload<{ value: PlanOutput; findings: { code: string }[] }>(
        'SELECT payload FROM course_plan_candidates WHERE workspace_id=? AND inventory_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
        workspaceId,
        inventory.id,
      );
      if (
        saved?.findings.some((i) =>
          ['semantic_plan', 'knowledge_requires_revision'].includes(i.code),
        ) &&
        sha256(this.compile(plan.id, workspaceId, inventory, saved.value).lessons) ===
          sha256(plan.lessons)
      )
        throw new AppError(
          'GROUNDING_FAILED',
          '该规划仍关联未更正的知识或目标错误，请继续准备后再确认。',
        );
      this.repo.run(
        "UPDATE curriculum_versions SET status='superseded' WHERE workspace_id=? AND status='accepted'",
        workspaceId,
      );
      const next: CoursePlan = { ...plan, status: 'accepted', version: plan.version + 1 };
      this.repo.run(
        "UPDATE curriculum_versions SET payload=?,status='accepted',version=? WHERE id=? AND status='draft'",
        canonical(next),
        next.version,
        id,
      );
      return next;
    });
  }
  private compile(
    id: string,
    workspaceId: string,
    inventory: CourseKnowledgeInventory,
    output: PlanOutput,
  ): CoursePlan {
    const lessonIds = new Map(
      output.lessons.map((l) => [
        l.id,
        stableId('lesson', {
          workspaceId,
          authorId: l.id,
          knowledgeIds: [...l.knowledgeIds].sort(),
        }),
      ]),
    );
    const objectiveIds = new Map(
      output.lessons.flatMap((l) =>
        l.objectives.map(
          (o) =>
            [
              o.id,
              stableId('objective', {
                lessonId: lessonIds.get(l.id),
                authorId: o.id,
                knowledgeIds: [...o.knowledgeIds].sort(),
                title: o.title,
              }),
            ] as const,
        ),
      ),
    );
    output = {
      ...output,
      lessons: output.lessons.map((l) => ({
        ...l,
        id: lessonIds.get(l.id)!,
        objectives: l.objectives.map((o) => ({ ...o, id: objectiveIds.get(o.id)! })),
        prerequisiteLessonIds: l.prerequisiteLessonIds.map((id) => lessonIds.get(id) ?? id),
      })),
      assessmentDesign: {
        ...output.assessmentDesign,
        domains: output.assessmentDesign.domains.map((d) => ({
          ...d,
          coreObjectiveIds: d.coreObjectiveIds.map((id) => objectiveIds.get(id) ?? id),
        })),
        cells: output.assessmentDesign.cells.map((c) => ({
          ...c,
          objectiveIds: c.objectiveIds.map((id) => objectiveIds.get(id) ?? id),
        })),
      },
    };
    const requiredCells = output.assessmentDesign.cells.filter((c) =>
      output.assessmentDesign.requiredCellIds.includes(c.id),
    );
    const total = requiredCells.reduce((sum, c) => sum + c.weight, 0);
    const blueprint = CourseAssessmentBlueprintSchema.parse({
      ...output.assessmentDesign,
      id: stableId('blueprint', { curriculum: id, policy: COURSE_POLICY }),
      curriculumId: id,
      sourceScopeHash: inventory.sourceScopeHash,
      policyVersion: COURSE_POLICY,
      passThreshold: 0.6,
      cells: output.assessmentDesign.cells.map((c) => ({
        ...c,
        weight: requiredCells.includes(c) ? c.weight / total : c.weight,
      })),
    });
    return CoursePlanSchema.parse({
      formatVersion: 2,
      id,
      workspaceId,
      inventoryId: inventory.id,
      planningPolicyVersion: COURSE_POLICY,
      title: output.title,
      modules: output.modules,
      lessons: output.lessons,
      teachingRequiredKnowledgeIds: inventory.knowledge
        .filter((k) => k.origin === 'textbook')
        .map((k) => k.id),
      assessmentBlueprint: blueprint,
      status: 'draft',
      version: 1,
      warnings: [],
    });
  }
  private normalizeOutput(output: PlanOutput, preferences?: CoursePreferences): PlanOutput {
    const value = structuredClone(output);
    if (preferences) {
      value.lessons = value.lessons.map((l) => ({
        ...l,
        selectedDepth: preferences.desiredDepth,
        // The author saw the selected depth and authored the actual action.
        // Knowledge kind describes the source item, not the learner's demand.
        // An exercise/concept can still require application or diagnosis.
        objectives: l.objectives,
      }));
      const objectives = new Map(
        value.lessons.flatMap((l) => l.objectives.map((o) => [o.id, o] as const)),
      );
      value.assessmentDesign.cells = value.assessmentDesign.cells.map((c) => {
        const demands = c.objectiveIds.map((id) => objectives.get(id)?.demand ?? c.demand);
        const demand = demands.sort((a, b) => demandRank[b] - demandRank[a])[0]!;
        return {
          ...c,
          demand,
          difficultyBand:
            demandRank[demand] >= 3 ? 'advanced' : demandRank[demand] <= 1 ? 'basic' : 'standard',
        };
      });
    }
    return normalizePlanReferences(value);
  }
  private async generate(
    ctx: CourseOperationContext,
    inventory: CourseKnowledgeInventory,
    preferences?: CoursePreferences,
  ): Promise<PlanningCandidate> {
    const title = this.repo.workspace(ctx.workspaceId).title;
    // Legacy full and revised outputs must be revalidated, never discarded merely for a local error.
    const legacy = legacyPlanningCandidate(this.repo, ctx, inventory, preferences);
    if (legacy) return legacy;
    const full: PlanInput = {
      title,
      knowledge: inventory.knowledge,
      mode: 'complete',
      preferences,
    };
    const retained = this.generation.retainedStage(
      ctx,
      'generateCoursePlan',
      full,
      inventory.sourceScopeHash,
      PlanOutputSchema,
    );
    if (retained) return { value: retained.value, callIds: [retained.callId] };
    return generateCoursePlanningBatches(ctx, inventory, this.generation, title, preferences);
  }
  private depthDemand(
    depth: LessonDepth,
    knowledge: CourseKnowledgeInventory['knowledge'],
  ): CourseDemand {
    if (depth === 'introductory') return 'understand';
    const operational = knowledge.some((k) => k.kind === 'procedure' || k.kind === 'principle');
    const conditional = knowledge.some((k) => k.kind === 'condition' || k.kind === 'exception');
    if (depth === 'standard') return operational || conditional ? 'apply' : 'understand';
    if (depth === 'proficient') return operational ? 'evaluate' : 'analyze';
    // Design belongs to actionable mechanisms; raising a bare definition never invents
    // textbook design authority. Lesson extensions must still identify their own boundary.
    return operational ? 'design' : conditional ? 'evaluate' : 'analyze';
  }
}
