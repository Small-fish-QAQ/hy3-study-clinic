import {
  COURSE_POLICY,
  CourseKnowledgeInventorySchema,
  type CourseKnowledgeInventory,
  type CourseKnowledge,
} from '@hy3-clinic/shared';
import {
  KnowledgeOutputSchema,
  ScopeReviewSchema,
  type KnowledgeOutput,
  type KnowledgeInput,
  type SourcePacketBlock,
} from '../llm/courseContract.js';
import type { ClinicRepository } from '../repositories/clinic.js';
import type { CourseSources } from './courseSources.js';
import type { CourseGeneration } from './courseGeneration.js';
import type { CourseOperationContext } from './courseOperationRunner.js';
import { CourseValidationError, requireValid, unique, type PlanIssue } from './courseValidation.js';
import { sha256, stableId, canonical } from '../util/canonical.js';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import { attachTableSourceContext } from './knowledgeSourceStructure.js';
import { constraintNeedsReview } from './courseCorrectnessScopes.js';
import { accountKnowledgeBlocks } from '../llm/knowledgeAccounting.js';
import { mergeKnowledgeRevision } from '../llm/knowledgeRevision.js';

export function knowledgePackets(
  blocks: SourcePacketBlock[],
  outputCap: number,
  contextCap?: number,
  fitsRequest?: (blocks: SourcePacketBlock[], singleUnit?: boolean) => boolean,
): SourcePacketBlock[][] {
  const capacity = Math.max(
    1,
    Math.floor(Math.min(outputCap * 1.5, contextCap ? contextCap : outputCap * 3)),
  );
  const groups: SourcePacketBlock[][] = [];
  let group: SourcePacketBlock[] = [];
  let bytes = 0;
  // Tables, proofs and their conditions must travel together. Raw PDF paragraphs/rows
  // are citation units, not independent teaching units. Never split solely by row count.
  const units: SourcePacketBlock[][] = [];
  for (const block of blocks) {
    const last = units.at(-1);
    const previous = last?.at(-1);
    const continuation = previous && /(?:[，：,:]|当且仅当)\s*$/u.test(previous.text);
    const table = (text: string) => /^\s*\|/mu.test(text);
    const formula = (text: string) => /^[\s()\w¬∧∨→↔⇒…、，+*=-]+$/u.test(text);
    if (
      last &&
      previous &&
      previous.revisionId === block.revisionId &&
      (continuation ||
        (JSON.stringify(previous.headingPath) === JSON.stringify(block.headingPath) &&
          (table(previous.text) ||
            table(block.text) ||
            formula(previous.text) ||
            formula(block.text))))
    )
      last.push(block);
    else units.push([block]);
  }
  for (const unit of units) {
    const size = Buffer.byteLength(JSON.stringify(unit), 'utf8');
    if (
      fitsRequest
        ? !fitsRequest(unit, true)
        : unit.some((block) => Buffer.byteLength(JSON.stringify(block)) > capacity)
    )
      throw new AppError(
        'SOURCE_TOO_LARGE',
        'source_unit_too_large：一个完整来源单元超过当前模型请求能力；请按完整条件与定义拆分该单元。',
      );
    if (
      group.length &&
      (fitsRequest ? !fitsRequest([...group, ...unit]) : bytes + size > capacity)
    ) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(...unit);
    bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}
export class CourseKnowledgeService {
  constructor(
    readonly repo: ClinicRepository,
    readonly sources: CourseSources,
    readonly generation: CourseGeneration,
  ) {}
  async extract(
    ctx: CourseOperationContext,
    expectedScope: string,
  ): Promise<CourseKnowledgeInventory> {
    this.sources.assertCurrent(ctx.workspaceId, expectedScope);
    const blocks = this.sources.blocks(ctx.workspaceId);
    const prior = this.repo.payload<CourseKnowledgeInventory>(
      'SELECT payload FROM course_knowledge_inventories WHERE workspace_id=? AND source_scope_hash=? AND policy_version=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      ctx.workspaceId,
      expectedScope,
      COURSE_POLICY,
    );
    if (prior) {
      ctx.report?.({
        phase: 'knowledge',
        label: '已读取保存的完整知识清单',
        completedSourceBlocks: blocks.length,
        totalSourceBlocks: blocks.length,
        knowledgeCount: prior.knowledge.length,
      });
      return CourseKnowledgeInventorySchema.parse(prior);
    }
    if (!blocks.length) throw new AppError('EMPTY_SOURCE', '请先导入完整的学习资料。');
    const knowledge: CourseKnowledge[] = [];
    const dispositions: CourseKnowledgeInventory['dispositions'] = [];
    const completedBlocks = new Set<string>();
    const retained = this.repo.payloads<{
      acceptedPacket?: {
        packetHash: string;
        blocks: SourcePacketBlock[];
        knowledge: CourseKnowledge[];
        dispositions: CourseKnowledgeInventory['dispositions'];
      };
    }>(
      "SELECT payload FROM semantic_cache WHERE workspace_id=? AND json_extract(payload,'$.acceptedPacket') IS NOT NULL ORDER BY created_at",
      ctx.workspaceId,
    );
    for (const entry of retained) {
      const packet = entry.acceptedPacket;
      if (
        !packet ||
        packet.packetHash !== sha256(packet.blocks) ||
        packet.blocks.some(
          (b) =>
            !blocks.some((current) => current.id === b.id && sha256(current) === sha256(b)) ||
            completedBlocks.has(b.id),
        )
      )
        continue;
      this.validatePacket(ctx.workspaceId, packet.blocks, packet);
      knowledge.push(...packet.knowledge);
      dispositions.push(...packet.dispositions);
      packet.blocks.forEach((b) => completedBlocks.add(b.id));
    }
    const report = (label: string) =>
      ctx.report?.({
        phase: 'knowledge',
        label,
        completedSourceBlocks: completedBlocks.size,
        totalSourceBlocks: blocks.length,
        knowledgeCount: knowledge.length,
      });
    report(
      completedBlocks.size ? '已恢复保存的资料提取结果' : '正在阅读资料，提取命题、条件与步骤',
    );
    while (completedBlocks.size < blocks.length) {
      const remaining = blocks.filter((b) => !completedBlocks.has(b.id));
      const rejected = this.rejectedPacket(ctx, remaining);
      // Re-plan only the remaining source units after observing a completed response.
      const packet =
        rejected?.blocks ??
        knowledgePackets(
          remaining,
          ctx.provider.outputCap ?? 64_000,
          ctx.provider.contextCap,
          ctx.provider.knowledgePacketFits?.bind(ctx.provider),
        )[0]!;
      ctx.check();
      report(packet[0]?.headingPath.join(' · ') || '正在阅读当前资料片段');
      const packetHash = sha256(packet);
      let input: KnowledgeInput = { blocks: packet };
      const failed = this.generation.failedCandidate(
        ctx,
        'extractCourseKnowledge',
        input,
        packetHash,
      );
      if (rejected)
        input = {
          blocks: packet,
          revision: {
            draft: rejected.value,
            findings: rejected.findings,
            ...(rejected.localRefs ? { localRefs: rejected.localRefs } : {}),
          },
        };
      else if (failed)
        input = {
          blocks: packet,
          revision: { draft: failed.candidate, findings: failed.findings },
        };
      for (let contentAttempt = 0; contentAttempt < 2; contentAttempt++) {
        let generated;
        try {
          generated =
            (contentAttempt === 0 && rejected?.locallyRecoverable
              ? { value: rejected.value, callId: rejected.callId }
              : null) ??
            (contentAttempt === 0 && !input.revision
              ? this.generation.retainedStage(
                  ctx,
                  'extractCourseKnowledge',
                  input,
                  packetHash,
                  KnowledgeOutputSchema,
                )
              : null) ??
            (await this.generation.stage(
              ctx,
              'extractCourseKnowledge',
              input,
              packetHash,
              KnowledgeOutputSchema,
              (opts) => ctx.provider.extractCourseKnowledge(input, opts),
            ));
        } catch (error) {
          if (
            error instanceof ProviderError &&
            error.technicalFailureCode === 'COMPLETE_CANDIDATE_INVALID' &&
            contentAttempt === 0 &&
            !input.revision
          ) {
            const details = error.details as { candidate: unknown; findings: string[] };
            input = {
              blocks: packet,
              revision: { draft: details.candidate, findings: details.findings },
            };
            continue;
          }
          throw error;
        }
        const mapped = attachTableSourceContext(
          this.materialize(
            ctx.workspaceId,
            packetHash,
            accountKnowledgeBlocks(mergeKnowledgeRevision(input, generated.value), packet),
          ),
          packet,
        );
        try {
          this.validatePacket(ctx.workspaceId, packet, mapped);
          const anomalies = this.anomalies(packet, mapped.knowledge, mapped.dispositions);
          if (anomalies.length) {
            const uncertain = new Set(
              mapped.knowledge.filter((k) => k.uncertaintyCodes.length).map((k) => k.id),
            );
            const relevantBlocks = packet.filter(
              (block) =>
                anomalies.some((finding) => finding.includes(block.id)) ||
                mapped.knowledge.some(
                  (k) => uncertain.has(k.id) && k.sourceSpans.some((s) => s.blockId === block.id),
                ),
            );
            const relevantIds = new Set(relevantBlocks.map((b) => b.id));
            const relevantKnowledge = mapped.knowledge.filter(
              (k) => uncertain.has(k.id) || k.sourceSpans.some((s) => relevantIds.has(s.blockId)),
            );
            const reviewInput = {
              blocks: packet.filter(
                (b) =>
                  relevantIds.has(b.id) ||
                  relevantKnowledge.some((k) => k.sourceSpans.some((s) => s.blockId === b.id)),
              ),
              knowledge: relevantKnowledge,
              findings: anomalies,
            };
            const reviewed = await this.generation.stage(
              ctx,
              'reviewKnowledgeScope',
              reviewInput,
              packetHash,
              ScopeReviewSchema,
              (opts) => ctx.provider.reviewKnowledgeScope(reviewInput, opts),
            );
            if (!reviewed.value.accepted && reviewed.value.issues?.length)
              throw new CourseValidationError(
                reviewed.value.findings,
                reviewed.value.issues.map((issue) => ({
                  code: 'knowledge_requires_revision',
                  path: 'knowledge',
                  message: issue.message,
                  knowledgeIds: issue.knowledgeIds,
                })),
              );
            requireValid(
              !reviewed.value.accepted
                ? reviewed.value.findings.length
                  ? reviewed.value.findings
                  : ['异常来源未获确认']
                : relevantKnowledge.some((k) => !reviewed.value.checkedKnowledgeIds.includes(k.id))
                  ? ['语义核查遗漏知识scope']
                  : [],
            );
          }
          this.repo.run(
            "UPDATE semantic_cache SET payload=json_set(payload,'$.acceptedPacket',json(?)) WHERE json_extract(payload,'$.callId')=?",
            canonical({ packetHash, blocks: packet, ...mapped }),
            generated.callId,
          );
          knowledge.push(...mapped.knowledge);
          dispositions.push(...mapped.dispositions);
          packet.forEach((block) => completedBlocks.add(block.id));
          report('本部分提取结果已校验并保存');
          break;
        } catch (error) {
          if (error instanceof CourseValidationError) {
            this.generation.reject(generated.callId, error.findings);
            const refs = this.locatedRefs(
              ctx.workspaceId,
              packetHash,
              generated.value,
              error.issues,
            );
            if (refs.length)
              this.repo.run(
                "UPDATE semantic_cache SET payload=json_set(payload,'$.knowledgeRevisionRefs',json(?)) WHERE json_extract(payload,'$.callId')=?",
                canonical(refs),
                generated.callId,
              );
          }
          if (!(error instanceof CourseValidationError) || contentAttempt === 1) throw error;
          const refs = this.locatedRefs(ctx.workspaceId, packetHash, generated.value, error.issues);
          input = {
            blocks: packet,
            revision: {
              draft: generated.value,
              findings: error.findings,
              ...(refs.length ? { localRefs: refs } : {}),
            },
          };
        }
      }
    }
    const ids = new Set(knowledge.map((k) => k.id));
    requireValid(
      !unique([...knowledge.map((k) => k.id)])
        ? ['合并后知识ID重复']
        : knowledge
              .flatMap((k) => [...k.prerequisiteKnowledgeIds, ...k.relatedKnowledgeIds])
              .some((id) => !ids.has(id))
          ? ['跨包知识关系引用不存在']
          : [],
    );
    const duplicateTitles = knowledge.filter((k) =>
      knowledge.some(
        (other) => other.id !== k.id && other.title === k.title && other.statement !== k.statement,
      ),
    );
    if (duplicateTitles.length) {
      const spans = duplicateTitles.flatMap((k) => k.sourceSpans);
      const relevant = this.sources.references(ctx.workspaceId, spans);
      const input = {
        blocks: relevant,
        knowledge: duplicateTitles,
        findings: ['同名不同命题，须保持条件与含义独立且核查跨包依赖'],
      };
      const checked = await this.generation.stage(
        ctx,
        'reviewKnowledgeScope',
        input,
        sha256(relevant),
        ScopeReviewSchema,
        (opts) => ctx.provider.reviewKnowledgeScope(input, opts),
      );
      requireValid(
        checked.value.accepted &&
          duplicateTitles.every((k) => checked.value.checkedKnowledgeIds.includes(k.id))
          ? []
          : ['同名异义/跨包知识核查未完成'],
      );
    }
    const inventory = CourseKnowledgeInventorySchema.parse({
      id: stableId('inventory', {
        workspace: ctx.workspaceId,
        source: expectedScope,
        policy: COURSE_POLICY,
      }),
      workspaceId: ctx.workspaceId,
      sourceScopeHash: expectedScope,
      policyVersion: COURSE_POLICY,
      knowledge,
      dispositions,
    });
    ctx.check();
    this.sources.assertCurrent(ctx.workspaceId, expectedScope);
    this.repo.run(
      'INSERT OR IGNORE INTO course_knowledge_inventories VALUES(?,?,?,?,?,?)',
      inventory.id,
      ctx.workspaceId,
      expectedScope,
      COURSE_POLICY,
      canonical(inventory),
      this.repo.now(),
    );
    return inventory;
  }
  private locatedRefs(
    workspaceId: string,
    packetHash: string,
    draft: KnowledgeOutput,
    issues?: PlanIssue[],
  ) {
    const ids = new Set(issues?.flatMap((i) => i.knowledgeIds ?? []) ?? []);
    return draft.knowledge
      .filter((k) =>
        ids.has(stableId('knowledge', { workspaceId, packetHash, localRef: k.localRef })),
      )
      .map((k) => k.localRef);
  }
  /** Correct located knowledge in its retained packet; preserve every healthy item and old version. */
  async correct(
    ctx: CourseOperationContext,
    prior: CourseKnowledgeInventory,
    issues: PlanIssue[],
  ): Promise<CourseKnowledgeInventory> {
    this.sources.assertCurrent(ctx.workspaceId, prior.sourceScopeHash);
    const targets = new Set(issues.flatMap((i) => i.knowledgeIds ?? []));
    requireValid(
      targets.size && [...targets].every((id) => prior.knowledge.some((k) => k.id === id))
        ? []
        : ['知识更正缺少精确对象范围'],
    );
    const retained = this.repo.rows<{
      payload: string;
      candidate_hash: string;
      physical_status: string;
      call_status: string;
    }>(
      `SELECT s.payload,s.candidate_hash,p.status AS physical_status,c.status AS call_status
       FROM semantic_cache s JOIN llm_calls c ON c.id=json_extract(s.payload,'$.callId')
       JOIN llm_physical_attempts p ON p.id=s.physical_attempt_id AND p.logical_call_id=c.id
       WHERE s.workspace_id=? AND json_extract(s.payload,'$.acceptedPacket') IS NOT NULL
       ORDER BY c.created_at DESC,c.rowid DESC`,
      ctx.workspaceId,
    );
    let knowledge = structuredClone(prior.knowledge);
    let dispositions = structuredClone(prior.dispositions);
    const completed = new Set<string>();
    const calls: string[] = [];
    const currentBlocks = this.sources.blocks(ctx.workspaceId);
    for (const row of retained) {
      const envelope = JSON.parse(row.payload) as {
        value: KnowledgeOutput;
        acceptedPacket: {
          packetHash: string;
          blocks: SourcePacketBlock[];
          knowledge: CourseKnowledge[];
          dispositions: CourseKnowledgeInventory['dispositions'];
        };
      };
      const packet = envelope.acceptedPacket;
      const affected = packet.knowledge.filter((k) => targets.has(k.id) && !completed.has(k.id));
      if (!affected.length) continue;
      if (
        row.call_status !== 'completed' ||
        row.physical_status !== 'completed' ||
        sha256(envelope.value) !== row.candidate_hash ||
        sha256(packet.blocks) !== packet.packetHash ||
        packet.blocks.some(
          (b) => !currentBlocks.some((v) => v.id === b.id && sha256(v) === sha256(b)),
        )
      )
        throw new AppError('GROUNDING_FAILED', '知识更正的原候选完整性或来源不符。');
      this.validatePacket(ctx.workspaceId, packet.blocks, packet);
      const localRefs = envelope.value.knowledge
        .filter((k) =>
          affected.some(
            (v) =>
              v.id ===
              stableId('knowledge', {
                workspaceId: ctx.workspaceId,
                packetHash: packet.packetHash,
                localRef: k.localRef,
              }),
          ),
        )
        .map((k) => k.localRef);
      requireValid(localRefs.length === affected.length ? [] : ['知识更正无法定位原提取身份']);
      const identities = new Map(
        envelope.value.knowledge.map((k) => [
          k.localRef,
          stableId('knowledge', {
            workspaceId: ctx.workspaceId,
            packetHash: packet.packetHash,
            localRef: k.localRef,
          }),
        ]),
      );
      const refs = new Map([...identities].map(([ref, id]) => [id, ref]));
      const draft: KnowledgeOutput = {
        knowledge: envelope.value.knowledge.map((k) => {
          const { id: retainedId, ...current } = prior.knowledge.find(
            (v) => v.id === identities.get(k.localRef),
          )!;
          return {
            ...current,
            localRef: refs.get(retainedId)!,
            prerequisiteKnowledgeIds: current.prerequisiteKnowledgeIds.map(
              (id) => refs.get(id) ?? id,
            ),
            relatedKnowledgeIds: current.relatedKnowledgeIds.map((id) => refs.get(id) ?? id),
          };
        }),
        dispositions: prior.dispositions
          .filter((d) => packet.blocks.some((b) => b.id === d.span.blockId))
          .map((d) => ({ ...d, knowledgeIds: d.knowledgeIds.map((id) => refs.get(id) ?? id) })),
      };
      const input: KnowledgeInput = {
        blocks: packet.blocks,
        referenceText: currentBlocks.map((b) => b.text).join(''),
        revision: {
          draft,
          localRefs,
          findings: issues
            .filter((i) => i.knowledgeIds?.some((id) => affected.some((k) => k.id === id)))
            .map((i) => i.message),
        },
      };
      ctx.report?.({
        phase: 'knowledge',
        label: '正在更正具体知识，保留已完成的其他提取与规划',
        totalSourceBlocks: currentBlocks.length,
        completedSourceBlocks: currentBlocks.length,
        knowledgeCount: prior.knowledge.length,
      });
      const generated = await this.generation.stage(
        ctx,
        'extractCourseKnowledge',
        input,
        packet.packetHash,
        KnowledgeOutputSchema,
        (opts) => ctx.provider.extractCourseKnowledge(input, opts),
      );
      try {
        requireValid(
          unique(generated.value.knowledge.map((k) => k.localRef)) &&
            localRefs.every((ref) => generated.value.knowledge.some((k) => k.localRef === ref))
            ? []
            : ['知识局部更正遗漏或改变原localRef'],
        );
        const merged = {
          knowledge: draft.knowledge.map((k) =>
            localRefs.includes(k.localRef)
              ? generated.value.knowledge.find((v) => v.localRef === k.localRef)!
              : k,
          ),
          dispositions: draft.dispositions.map((d) => ({
            ...d,
            knowledgeIds: [
              ...d.knowledgeIds.filter((ref) => !localRefs.includes(ref)),
              ...generated.value.knowledge
                .filter(
                  (k) =>
                    localRefs.includes(k.localRef) &&
                    k.sourceSpans.some(
                      (s) =>
                        s.blockId === d.span.blockId &&
                        s.start <= d.span.start &&
                        s.end >= d.span.end,
                    ),
                )
                .map((k) => k.localRef),
            ],
          })),
        };
        const mapped = attachTableSourceContext(
          this.materialize(
            ctx.workspaceId,
            packet.packetHash,
            accountKnowledgeBlocks(merged, packet.blocks),
          ),
          packet.blocks,
        );
        this.validatePacket(ctx.workspaceId, packet.blocks, mapped);
        const changed = mapped.knowledge.filter((k) => affected.some((v) => v.id === k.id));
        requireValid(
          changed.every((k) => {
            const original = prior.knowledge.find((v) => v.id === k.id)!;
            return (
              k.statement !== original.statement ||
              sha256(k.sourceSpans) !== sha256(original.sourceSpans) ||
              sha256(k.uncertaintyCodes) !== sha256(original.uncertaintyCodes)
            );
          })
            ? []
            : ['知识更正未改变被拒绝的实质陈述、来源或不确定性；原错误仍保留。'],
        );
        const sourceContext = this.sources.references(
          ctx.workspaceId,
          changed.flatMap((k) => k.sourceSpans),
        );
        const reviewInput = {
          blocks: sourceContext,
          knowledge: changed,
          findings: input.revision!.findings,
        };
        const checked = await this.generation.stage(
          ctx,
          'reviewKnowledgeScope',
          reviewInput,
          sha256(sourceContext),
          ScopeReviewSchema,
          (opts) => ctx.provider.reviewKnowledgeScope(reviewInput, opts),
        );
        requireValid(
          checked.value.accepted &&
            changed.every((k) => checked.value.checkedKnowledgeIds.includes(k.id))
            ? []
            : checked.value.findings.length
              ? checked.value.findings
              : ['知识局部更正未通过来源核查'],
        );
        knowledge = knowledge.map((k) => changed.find((v) => v.id === k.id) ?? k);
        dispositions = dispositions.map(
          (d) => mapped.dispositions.find((v) => sha256(v.span) === sha256(d.span)) ?? d,
        );
        changed.forEach((k) => completed.add(k.id));
        calls.push(generated.callId, checked.callId);
      } catch (error) {
        if (error instanceof CourseValidationError)
          this.generation.reject(generated.callId, error.findings, ctx.operationId);
        throw error;
      }
    }
    requireValid(
      [...targets].every((id) => completed.has(id))
        ? []
        : ['原知识提取的完整候选不可恢复，请核对来源。'],
    );
    const result = CourseKnowledgeInventorySchema.parse({
      ...prior,
      id: stableId('inventory', { parent: prior.id, knowledge, dispositions }),
      knowledge,
      dispositions,
    });
    ctx.check();
    this.sources.assertCurrent(ctx.workspaceId, prior.sourceScopeHash);
    this.repo.transaction(() => {
      this.repo.run(
        'INSERT OR IGNORE INTO course_knowledge_inventories VALUES(?,?,?,?,?,?)',
        result.id,
        ctx.workspaceId,
        result.sourceScopeHash,
        COURSE_POLICY,
        canonical(result),
        this.repo.now(),
      );
      for (const callId of calls)
        this.repo.run(
          "UPDATE semantic_cache SET payload=json_set(payload,'$.inventoryCorrection',json(?)) WHERE json_extract(payload,'$.callId')=?",
          canonical({ from: prior.id, to: result.id, knowledgeIds: [...targets] }),
          callId,
        );
    });
    return result;
  }
  /** Resume the latest complete rejected revision in its original source packet.
   * Adaptive sizing must not hide that revision or repeat an older structural repair.
   */
  private rejectedPacket(ctx: CourseOperationContext, remaining: SourcePacketBlock[]) {
    const snapshot = {
      provider: ctx.provider.name,
      model: ctx.provider.model ?? null,
      endpoint: ctx.provider.endpointIdentity ?? null,
      reasoning:
        ctx.provider.runtimeIdentityFor?.('extractCourseKnowledge') ??
        ctx.provider.runtimeIdentity ??
        null,
    };
    const rows = this.repo.rows<{
      payload: string;
      candidate_hash: string;
      source_scope_hash: string;
      call_payload: string;
      provider_snapshot: string;
      call_id: string;
    }>(
      `SELECT s.payload,s.candidate_hash,s.source_scope_hash,c.payload AS call_payload,c.provider_snapshot,c.id AS call_id
       FROM semantic_cache s JOIN llm_calls c ON c.id=json_extract(s.payload,'$.callId')
       JOIN llm_physical_attempts p ON p.id=s.physical_attempt_id AND p.logical_call_id=c.id
       WHERE s.workspace_id=? AND c.method='extractCourseKnowledge' AND c.status='completed'
         AND p.status='completed' AND json_extract(c.payload,'$.contentRejected')=1
         AND c.generation_key=s.generation_key ORDER BY c.created_at DESC,c.rowid DESC`,
      ctx.workspaceId,
    );
    for (const row of rows) {
      if (sha256(JSON.parse(row.provider_snapshot)) !== sha256(snapshot)) continue;
      const envelope = JSON.parse(row.payload) as {
        value: unknown;
        originalProviderSnapshot: unknown;
        knowledgeRevisionRefs?: string[];
      };
      if (
        sha256(envelope.value) !== row.candidate_hash ||
        sha256(envelope.originalProviderSnapshot) !== sha256(snapshot)
      )
        throw new AppError('GROUNDING_FAILED', '提取修订候选的完整性或来源身份不符。');
      const parsed = KnowledgeOutputSchema.safeParse(envelope.value);
      if (!parsed.success) continue;
      const ids = new Set([
        ...parsed.data.dispositions.map((d) => d.span.blockId),
        ...parsed.data.knowledge.flatMap((k) => k.sourceSpans.map((s) => s.blockId)),
      ]);
      const packet = remaining.filter((b) => ids.has(b.id));
      if (packet.length !== ids.size || sha256(packet) !== row.source_scope_hash) continue;
      const findings = (JSON.parse(row.call_payload) as { rejectionFindings?: string[] })
        .rejectionFindings;
      if (!findings?.length) continue;
      let localRefs = envelope.knowledgeRevisionRefs;
      if (!localRefs) {
        // Locate older complete semantic rejections using the exact stored
        // review and knowledge IDs; no inference from a free-text message.
        const reviews = this.repo.payloads<{ value: ReturnType<typeof ScopeReviewSchema.parse> }>(
          `SELECT s.payload FROM semantic_cache s JOIN llm_calls c ON c.id=json_extract(s.payload,'$.callId')
           JOIN llm_physical_attempts p ON p.id=s.physical_attempt_id AND p.logical_call_id=c.id
           WHERE s.workspace_id=? AND s.source_scope_hash=? AND c.method='reviewKnowledgeScope'
             AND c.status='completed' AND p.status='completed' ORDER BY c.created_at DESC`,
          ctx.workspaceId,
          row.source_scope_hash,
        );
        const match = reviews.find(
          (r) => !r.value.accepted && sha256(r.value.findings) === sha256(findings),
        );
        const refs = this.locatedRefs(
          ctx.workspaceId,
          row.source_scope_hash,
          parsed.data,
          match?.value.issues?.map((i) => ({
            code: 'knowledge_requires_revision',
            path: 'knowledge',
            message: i.message,
            knowledgeIds: i.knowledgeIds,
          })),
        );
        if (refs.length) localRefs = refs;
      }
      let locallyRecoverable = false;
      const accounted = accountKnowledgeBlocks(parsed.data, packet);
      if (sha256(accounted) !== sha256(parsed.data)) {
        try {
          // Only mechanically prove the same persisted failure. A semantic
          // rejection must still receive a real content correction.
          this.validatePacket(
            ctx.workspaceId,
            packet,
            this.materialize(ctx.workspaceId, row.source_scope_hash, parsed.data),
          );
        } catch (error) {
          if (
            error instanceof CourseValidationError &&
            sha256([...new Set(error.findings)].sort()) === sha256([...new Set(findings)].sort())
          ) {
            this.validatePacket(
              ctx.workspaceId,
              packet,
              this.materialize(ctx.workspaceId, row.source_scope_hash, accounted),
            );
            locallyRecoverable = true;
          }
        }
      }
      return {
        blocks: packet,
        value: parsed.data,
        findings,
        callId: row.call_id,
        locallyRecoverable,
        localRefs,
      };
    }
    return null;
  }
  private materialize(workspaceId: string, packetHash: string, raw: KnowledgeOutput) {
    const mapping = new Map(
      raw.knowledge.map((k) => [
        k.localRef,
        stableId('knowledge', { workspaceId, packetHash, localRef: k.localRef }),
      ]),
    );
    requireValid(unique(raw.knowledge.map((k) => k.localRef)) ? [] : ['包内localRef重复']);
    const mapId = (id: string) => mapping.get(id) ?? id;
    return {
      knowledge: raw.knowledge.map(({ localRef, ...k }) => ({
        ...k,
        id: mapping.get(localRef)!,
        prerequisiteKnowledgeIds: k.prerequisiteKnowledgeIds.map(mapId),
        relatedKnowledgeIds: k.relatedKnowledgeIds.map(mapId),
      })),
      dispositions: raw.dispositions.map((d) => ({
        ...d,
        knowledgeIds: d.knowledgeIds.map(mapId),
      })),
    };
  }
  private validatePacket(
    workspaceId: string,
    blocks: SourcePacketBlock[],
    packet: {
      knowledge: CourseKnowledge[];
      dispositions: CourseKnowledgeInventory['dispositions'];
    },
  ) {
    const findings: string[] = [];
    const ids = new Set(packet.knowledge.map((k) => k.id));
    const revisions = new Set(blocks.map((b) => b.revisionId));
    const blockIds = new Set(blocks.map((b) => b.id));
    for (const k of packet.knowledge) {
      if (k.origin === 'textbook' && !k.sourceSpans.length) findings.push('教材知识没有来源跨度');
      if (k.origin === 'extension' && k.sourceSpans.length) findings.push('拓展知识伪引用教材');
      for (const span of k.sourceSpans) {
        if (!blockIds.has(span.blockId)) findings.push('知识引用包外原文');
        else this.sources.validateSpan(workspaceId, span, revisions);
      }
      if (k.prerequisiteKnowledgeIds.includes(k.id)) findings.push('知识自先修');
    }
    for (const block of blocks) {
      const entries = packet.dispositions
        .filter((d) => d.span.blockId === block.id)
        .sort((a, b) => a.span.start - b.span.start);
      let cursor = block.start;
      for (const d of entries) {
        this.sources.validateSpan(workspaceId, d.span, revisions);
        if (d.span.start !== cursor) findings.push('原文处理跨度有空洞或重复');
        cursor = d.span.end;
        if (d.exclusion === null && !d.knowledgeIds.length)
          findings.push(`正文处理结果为空:${block.id}`);
        if (d.exclusion !== null && d.knowledgeIds.length) findings.push('排除与教学归属冲突');
        if (d.knowledgeIds.some((id) => !ids.has(id))) findings.push('处置引用不存在知识');
        if (d.exclusion?.kind === 'duplicate') {
          if (
            !d.exclusion.duplicateOf ||
            this.sources.validateSpan(workspaceId, d.exclusion.duplicateOf) !==
              this.sources.validateSpan(workspaceId, d.span)
          )
            findings.push('重复排除缺少相同原文证据');
        }
      }
      if (cursor !== block.end) findings.push('未处理全部正文跨度');
    }
    if (packet.dispositions.some((d) => !blockIds.has(d.span.blockId)))
      findings.push('处置引用外来块');
    requireValid([...new Set(findings)]);
  }
  private anomalies(
    blocks: SourcePacketBlock[],
    knowledge: CourseKnowledge[],
    dispositions: CourseKnowledgeInventory['dispositions'],
  ) {
    const findings: string[] = [];
    for (const k of knowledge) {
      const cited = blocks.filter((b) => k.sourceSpans.some((s) => s.blockId === b.id));
      if (constraintNeedsReview(k, cited.map((b) => b.text).join('\n')))
        for (const block of cited) findings.push(`条件/例外的改述需要来源核查:${block.id}`);
    }
    for (const block of blocks) {
      if (
        dispositions.some((d) => d.span.blockId === block.id && d.exclusion !== null) &&
        !block.text
          .split('\n')
          .filter((line) => line.trim())
          .every((line) =>
            /^\s*(?:#+\s*(?:目录|contents)\s*$|copyright\b|©|版权|目\s*录\s*$|.{1,120}(?:\.{2,}|…{2,})\s*\d+\s*$)/iu.test(
              line,
            ),
          )
      )
        findings.push(`教学正文被排除:${block.id}`);
      if (
        /如果|仅当|除非|例外|步骤|[=∑∫]|otherwise|unless|provided/iu.test(block.text) &&
        !knowledge.some(
          (k) =>
            k.sourceSpans.some((s) => s.blockId === block.id) &&
            (/如果|仅当|除非|例外|步骤|[=∑∫→⇒↔]|otherwise|unless|provided/iu.test(k.statement) ||
              (k.kind === 'procedure' && /[∧∨¬]/u.test(k.statement))),
        )
      )
        findings.push(`条件/公式/步骤可能遗漏:${block.id}`);
    }
    if (knowledge.some((k) => k.uncertaintyCodes.length)) findings.push('提取明确不确定');
    return findings;
  }
}
