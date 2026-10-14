import type {
  CourseKnowledgeInventory,
  CourseKnowledge,
  CoursePreferences,
} from '@hy3-clinic/shared';
import {
  PlanOutputSchema,
  PlanBoundarySchema,
  PlanJoinSchema,
  type PlanOutput,
  type PlanInput,
  type PlanBoundary,
} from '../llm/courseContract.js';
import type { CourseOperationContext } from './courseOperationRunner.js';
import type { CourseGeneration } from './courseGeneration.js';
import { requireValid, unique } from './courseValidation.js';
import { AppError } from '../errors.js';
import { sha256, stableId, canonical } from '../util/canonical.js';
import { planningKnowledge } from './coursePlanRevision.js';
import { assertPlanningOrigin, type PlanningCandidate } from './coursePlanCandidates.js';

function packets<T>(
  items: T[],
  capacity: number,
  fits?: (items: T[], single?: boolean) => boolean,
): T[][] {
  const result: T[][] = [];
  let packet: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (size > capacity || (fits && !fits([item], true)))
      throw new AppError('SOURCE_TOO_LARGE', '单个完整规划单元超过模型输入资源。');
    if (packet.length && (bytes + size > capacity || (fits && !fits([...packet, item])))) {
      result.push(packet);
      packet = [];
      bytes = 0;
    }
    packet.push(item);
    bytes += size;
  }
  if (packet.length) result.push(packet);
  return result;
}
function qualify(plan: PlanOutput, scope: string): PlanOutput {
  const local = (id: string) => stableId('plan_ref', { scope, id });
  const lessonIds = new Set(plan.lessons.map((l) => l.id));
  return {
    ...plan,
    modules: plan.modules.map((m) => ({ ...m, id: local(m.id) })),
    lessons: plan.lessons.map((l) => ({
      ...l,
      id: local(l.id),
      moduleId: local(l.moduleId),
      objectives: l.objectives.map((o) => ({ ...o, id: local(o.id) })),
      prerequisiteLessonIds: l.prerequisiteLessonIds.map((id) =>
        lessonIds.has(id) ? local(id) : id,
      ),
    })),
    assessmentDesign: {
      domains: plan.assessmentDesign.domains.map((d) => ({
        ...d,
        id: local(d.id),
        coreObjectiveIds: d.coreObjectiveIds.map(local),
      })),
      cells: plan.assessmentDesign.cells.map((c) => ({
        ...c,
        id: local(c.id),
        domainId: local(c.domainId),
        objectiveIds: c.objectiveIds.map(local),
        representativeSets: c.representativeSets.map((s) => ({ ...s, id: local(s.id) })),
      })),
      requiredCellIds: plan.assessmentDesign.requiredCellIds.map(local),
    },
  };
}
export async function generateCoursePlanningBatches(
  ctx: CourseOperationContext,
  inventory: CourseKnowledgeInventory,
  generation: CourseGeneration,
  title: string,
  preferences?: CoursePreferences,
): Promise<PlanningCandidate> {
  const capacity = Math.max(
    1,
    Math.floor(
      Math.min(
        (ctx.provider.outputCap ?? 64000) * 2,
        ctx.provider.contextCap
          ? ctx.provider.contextCap * 1.5
          : (ctx.provider.outputCap ?? 64000) * 2,
      ),
    ),
  );
  const full: PlanInput = {
    title,
    knowledge: planningKnowledge(inventory.knowledge),
    mode: 'complete',
    preferences,
  };
  if (
    Buffer.byteLength(JSON.stringify(full)) <= capacity &&
    (ctx.provider.planningPacketFits?.(full) ?? true)
  ) {
    const result = await generation.stage(
      ctx,
      'generateCoursePlan',
      full,
      inventory.sourceScopeHash,
      PlanOutputSchema,
      async (opts) => PlanOutputSchema.parse(await ctx.provider.generateCoursePlan(full, opts)),
    );
    return { value: result.value, callIds: [result.callId] };
  }
  const callIds: string[] = [];
  const compact = (k: CourseKnowledge): CourseKnowledge => ({
    ...k,
    statement: k.title,
    sourceSpans: [],
    uncertaintyCodes: [],
  });
  let index = inventory.knowledge.map(compact);
  let represented = new Map(index.map((k) => [k.id, [k.id]]));
  let outline: PlanBoundary['modules'] = [];
  // A finite hierarchy of compact indices. Parent entry counts strictly decrease.
  for (;;) {
    const groups = packets(
      index,
      capacity,
      ctx.provider.planningPacketFits
        ? (knowledge, single) =>
            ctx.provider.planningPacketFits!(
              { title, knowledge, mode: 'outline', preferences },
              single,
            )
        : undefined,
    );
    const modules: PlanBoundary['modules'] = [];
    for (const group of groups) {
      const input: PlanInput = { title, knowledge: group, mode: 'outline', preferences };
      const result = await generation.stage(
        ctx,
        'generateCoursePlan',
        input,
        sha256(group),
        PlanBoundarySchema,
        async (opts) =>
          PlanBoundarySchema.parse(await ctx.provider.generateCoursePlan(input, opts)),
      );
      const assigned = result.value.modules.flatMap((m) => m.knowledgeIds);
      callIds.push(result.callId);
      requireValid(
        !assigned.length ||
          !unique(assigned) ||
          sha256([...assigned].sort()) !== sha256(group.map((k) => k.id).sort())
          ? ['全局outline删除、重复或引入知识索引']
          : [],
      );
      modules.push(
        ...result.value.modules.map((m) => ({
          ...m,
          id: stableId('outline_module', { scope: sha256(group), local: m.id }),
          knowledgeIds: m.knowledgeIds.flatMap((id) => represented.get(id)!),
        })),
      );
    }
    if (groups.length === 1) {
      outline = modules;
      break;
    }
    if (modules.length >= index.length)
      throw new AppError('SOURCE_TOO_LARGE', '全局规划索引没有缩小，已停止无进展的分组。');
    represented = new Map(modules.map((m) => [m.id, m.knowledgeIds]));
    index = modules.map((m) => ({
      id: m.id,
      title: m.title,
      statement: m.title,
      kind: 'concept',
      origin: 'textbook',
      sourceSpans: [],
      prerequisiteKnowledgeIds: [],
      relatedKnowledgeIds: [],
      uncertaintyCodes: [],
    }));
  }
  const results: PlanOutput[] = [];
  const done = new Set<string>();
  const retained = generation.repo.payloads<{
    callId: string;
    acceptedSubplan?: {
      inventoryId: string;
      preferencesHash?: string;
      knowledgeHash: string;
      knowledgeIds: string[];
      plan: PlanOutput;
    };
  }>(
    "SELECT payload FROM semantic_cache WHERE workspace_id=? AND json_extract(payload,'$.acceptedSubplan') IS NOT NULL",
    ctx.workspaceId,
  );
  for (const envelope of retained) {
    const saved = envelope.acceptedSubplan;
    if (
      !saved ||
      saved.inventoryId !== inventory.id ||
      saved.preferencesHash !== sha256(preferences ?? null) ||
      saved.knowledgeIds.some((id) => done.has(id)) ||
      saved.knowledgeHash !==
        sha256(inventory.knowledge.filter((k) => saved.knowledgeIds.includes(k.id)))
    )
      continue;
    assertPlanningOrigin(generation.repo, ctx, [envelope.callId]);
    callIds.push(envelope.callId);
    results.push(PlanOutputSchema.parse(saved.plan));
    saved.knowledgeIds.forEach((id) => done.add(id));
  }
  for (const module of outline) {
    const missing = inventory.knowledge.filter(
      (k) => module.knowledgeIds.includes(k.id) && !done.has(k.id),
    );
    for (const group of packets(
      missing,
      capacity,
      ctx.provider.planningPacketFits
        ? (knowledge, single) =>
            ctx.provider.planningPacketFits!(
              {
                title,
                knowledge: planningKnowledge(knowledge),
                mode: 'subplan',
                moduleBoundary: module.title,
                preferences,
              },
              single,
            )
        : undefined,
    )) {
      const input: PlanInput = {
        preferences,
        title,
        knowledge: planningKnowledge(group),
        mode: 'subplan',
        moduleBoundary: module.title,
      };
      const authored = await generation.stage(
        ctx,
        'generateCoursePlan',
        input,
        sha256(group),
        PlanOutputSchema,
        async (opts) => PlanOutputSchema.parse(await ctx.provider.generateCoursePlan(input, opts)),
      );
      const output = qualify(authored.value, sha256(group));
      callIds.push(authored.callId);
      const allocated = new Set(output.lessons.flatMap((l) => l.knowledgeIds));
      requireValid(
        group.some((k) => k.origin === 'textbook' && !allocated.has(k.id)) ||
          [...allocated].some((id) => !group.some((k) => k.id === id))
          ? ['子规划遗漏或引入知识']
          : [],
      );
      results.push(output);
      group.forEach((k) => done.add(k.id));
      generation.repo.run(
        "UPDATE semantic_cache SET payload=json_set(payload,'$.acceptedSubplan',json(?)) WHERE json_extract(payload,'$.callId')=?",
        canonical({
          inventoryId: inventory.id,
          preferencesHash: sha256(preferences ?? null),
          knowledgeHash: sha256(group),
          knowledgeIds: group.map((k) => k.id),
          plan: output,
        }),
        authored.callId,
      );
    }
  }
  const merged: PlanOutput = {
    title,
    modules: results.flatMap((r) => r.modules),
    lessons: results.flatMap((r) => r.lessons),
    assessmentDesign: {
      domains: results.flatMap((r) => r.assessmentDesign.domains),
      cells: results.flatMap((r) => r.assessmentDesign.cells),
      requiredCellIds: results.flatMap((r) => r.assessmentDesign.requiredCellIds),
    },
  };
  const compactPlans = results.map((r) => ({
    ...r,
    lessons: r.lessons.map((l) => ({
      ...l,
      summary: l.title,
      objectives: [],
      estimatedMinutes: 1,
    })),
    assessmentDesign: { domains: [], cells: [], requiredCellIds: [] },
  }));
  let previous: PlanOutput | undefined;
  for (const group of packets(compactPlans, capacity)) {
    const priorPlans = previous ? [previous, ...group] : group;
    const needed = new Set(priorPlans.flatMap((p) => p.lessons.flatMap((l) => l.knowledgeIds)));
    const input: PlanInput = { title, knowledge: [], mode: 'join', priorPlans, preferences };
    const checked = await generation.stage(
      ctx,
      'generateCoursePlan',
      input,
      sha256([...needed].sort()),
      PlanJoinSchema,
      async (opts) => PlanJoinSchema.parse(await ctx.provider.generateCoursePlan(input, opts)),
    );
    callIds.push(checked.callId);
    for (const link of checked.value.links) {
      const lesson = merged.lessons.find((l) => l.id === link.lessonId);
      requireValid(
        !lesson ||
          link.prerequisiteLessonIds.some(
            (id) => !merged.lessons.some((l) => l.id === id) || id === link.lessonId,
          )
          ? ['compact join引入无效先修']
          : [],
      );
      lesson!.prerequisiteLessonIds = [
        ...new Set([...lesson!.prerequisiteLessonIds, ...link.prerequisiteLessonIds]),
      ];
    }
    const last = group.at(-1)!;
    previous = { ...last, lessons: last.lessons.slice(-1) };
  }
  for (const k of inventory.knowledge) {
    const owner = merged.lessons.find((l) => l.knowledgeIds.includes(k.id));
    if (!owner) continue;
    for (const prerequisite of k.prerequisiteKnowledgeIds) {
      const prior = merged.lessons.find((l) => l.knowledgeIds.includes(prerequisite));
      if (prior && prior.id !== owner.id && !owner.prerequisiteLessonIds.includes(prior.id))
        owner.prerequisiteLessonIds.push(prior.id);
    }
  }
  return { value: merged, callIds: [...new Set(callIds)] };
}
