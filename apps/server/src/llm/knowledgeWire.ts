import { z } from 'zod';
import { CourseKnowledgeSchema } from '@hy3-clinic/shared';
import {
  KnowledgeOutputSchema,
  type KnowledgeInput,
  type KnowledgeOutput,
} from './courseContract.js';
import { ProviderError } from './errors.js';
import { accountKnowledgeBlocks } from './knowledgeAccounting.js';
import { mergeKnowledgeRevision } from './knowledgeRevision.js';

export const KnowledgeWireSchema = z
  .object({
    knowledge: z.array(
      CourseKnowledgeSchema.omit({
        id: true,
        sourceSpans: true,
        prerequisiteKnowledgeIds: true,
        relatedKnowledgeIds: true,
      }).extend({
        localRef: z.string().min(1),
        sourceBlockIds: z.array(z.string().min(1)),
        prerequisiteRefs: z.array(z.string().min(1)),
        relatedRefs: z.array(z.string().min(1)),
      }),
    ),
    dispositions: z
      .array(
        z
          .object({
            blockId: z.string().min(1),
            exclusion: z
              .object({
                kind: z.enum(['navigation', 'frontmatter', 'duplicate']),
                reason: z.string().min(1),
                duplicateOfBlockId: z.string().optional(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** Short wire references avoid asking the model to count characters or recopy opaque IDs. */
export function knowledgeWire(input: KnowledgeInput) {
  const aliases = new Map(input.blocks.map((block, index) => [`s${index}`, block]));
  const referenceFindings = (wire: z.infer<typeof KnowledgeWireSchema>) => {
    const retainedRefs = input.revision?.localRefs
      ? (input.revision.draft as KnowledgeOutput).knowledge.map((k) => k.localRef)
      : [];
    const refs = new Set([...wire.knowledge.map((k) => k.localRef), ...retainedRefs]);
    const findings: string[] = [];
    const seen = new Set<string>();
    wire.knowledge.forEach((k, index) => {
      if (seen.has(k.localRef))
        findings.push(`knowledge[${index}].localRef: 重复短ID ${k.localRef}`);
      seen.add(k.localRef);
      for (const field of ['prerequisiteRefs', 'relatedRefs'] as const)
        k[field].forEach((ref, offset) => {
          if (!refs.has(ref))
            findings.push(
              `knowledge[${index}](${k.localRef}).${field}[${offset}]: 知识引用 ${ref} 不存在；必须引用本候选已有localRef，不能引用未单列的规则名。`,
            );
        });
      k.sourceBlockIds.forEach((id, offset) => {
        if (!aliases.has(id))
          findings.push(`knowledge[${index}].sourceBlockIds[${offset}]: 来源 ${id} 不在当前工作包`);
      });
    });
    (wire.dispositions ?? []).forEach((d, index) => {
      if (!aliases.has(d.blockId))
        findings.push(`dispositions[${index}].blockId: 来源 ${d.blockId} 不在当前工作包`);
      if (d.exclusion?.duplicateOfBlockId && !aliases.has(d.exclusion.duplicateOfBlockId))
        findings.push(`dispositions[${index}].exclusion.duplicateOfBlockId: 来源不在当前工作包`);
    });
    return findings;
  };
  const alias = (id: string) => [...aliases].find(([, block]) => block.id === id)?.[0];
  const span = (id: string) => {
    const block = aliases.get(id);
    if (!block) throw ProviderError.invalidOutput('提取结果引用了工作包外的来源块。');
    return { revisionId: block.revisionId, blockId: block.id, start: block.start, end: block.end };
  };
  const draft = input.revision?.draft as KnowledgeOutput | undefined;
  // Old persisted failures can predate precise feedback. Recompute mechanical locations
  // from the complete retained wire candidate without changing its content or acceptance.
  const retainedWire = KnowledgeWireSchema.safeParse(input.revision?.draft);
  const locatedFindings = retainedWire.success ? referenceFindings(retainedWire.data) : [];
  return {
    input: {
      blocks: [...aliases].map(([id, block]) => ({
        id,
        text: block.text,
        headingPath: block.headingPath,
      })),
      ...(input.referenceText ? { referenceText: input.referenceText } : {}),
      ...(input.revision
        ? {
            revision: {
              ...(input.revision.localRefs ? { localRefs: input.revision.localRefs } : {}),
              findings: [...new Set([...input.revision.findings, ...locatedFindings])].map((f) =>
                [...aliases].reduce((text, [short, block]) => text.replaceAll(block.id, short), f),
              ),
              draft:
                draft?.knowledge &&
                draft.dispositions &&
                draft.knowledge.every((k) => Array.isArray(k.sourceSpans))
                  ? {
                      knowledge: draft.knowledge.map(
                        ({ sourceSpans, prerequisiteKnowledgeIds, relatedKnowledgeIds, ...k }) => ({
                          ...k,
                          sourceBlockIds: [...new Set(sourceSpans.map((s) => alias(s.blockId)))],
                          prerequisiteRefs: prerequisiteKnowledgeIds,
                          relatedRefs: relatedKnowledgeIds,
                        }),
                      ),
                      dispositions: draft.dispositions.map(({ span: source, exclusion }) => ({
                        blockId: alias(source.blockId),
                        exclusion: exclusion
                          ? {
                              kind: exclusion.kind,
                              reason: exclusion.reason,
                              ...(exclusion.duplicateOf
                                ? { duplicateOfBlockId: alias(exclusion.duplicateOf.blockId) }
                                : {}),
                            }
                          : null,
                      })),
                    }
                  : input.revision.draft,
            },
          }
        : {}),
    },
    materialize: (wire: z.infer<typeof KnowledgeWireSchema>): KnowledgeOutput => {
      const findings = referenceFindings(wire);
      if (findings.length) throw ProviderError.completeCandidate(wire, findings);
      const refs = new Set([
        ...wire.knowledge.map((k) => k.localRef),
        ...(input.revision?.localRefs
          ? (input.revision.draft as KnowledgeOutput).knowledge.map((k) => k.localRef)
          : []),
      ]);
      if (new Set(wire.knowledge.map((k) => k.localRef)).size !== wire.knowledge.length)
        throw ProviderError.invalidOutput('知识短ID重复。');
      const reference = (ref: string) => {
        if (!refs.has(ref)) throw ProviderError.invalidOutput(`知识引用不存在: ${ref}`);
        return ref;
      };
      return KnowledgeOutputSchema.parse(
        mergeKnowledgeRevision(
          input,
          accountKnowledgeBlocks(
            {
              knowledge: wire.knowledge.map(
                ({ sourceBlockIds, prerequisiteRefs, relatedRefs, ...k }) => ({
                  ...k,
                  prerequisiteKnowledgeIds: prerequisiteRefs.map(reference),
                  relatedKnowledgeIds: relatedRefs.map(reference),
                  sourceSpans: sourceBlockIds.map(span),
                }),
              ),
              dispositions: (wire.dispositions ?? []).map(({ blockId, exclusion }) => ({
                knowledgeIds: wire.knowledge
                  .filter((k) => k.sourceBlockIds.includes(blockId))
                  .map((k) => k.localRef),
                span: span(blockId),
                exclusion: exclusion
                  ? {
                      kind: exclusion.kind,
                      reason: exclusion.reason,
                      ...(exclusion.duplicateOfBlockId
                        ? { duplicateOf: span(exclusion.duplicateOfBlockId) }
                        : {}),
                    }
                  : null,
              })),
            },
            input.blocks,
          ),
        ),
      );
    },
  };
}
