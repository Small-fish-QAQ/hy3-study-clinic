import type { KnowledgeInput, KnowledgeOutput } from './courseContract.js';
import { ProviderError } from './errors.js';
import { accountKnowledgeBlocks } from './knowledgeAccounting.js';

/** A located patch changes only the requested identities; healthy source facts are retained. */
export function mergeKnowledgeRevision(
  input: KnowledgeInput,
  patch: KnowledgeOutput,
): KnowledgeOutput {
  const refs = input.revision?.localRefs;
  if (!refs) return patch;
  const draft = input.revision!.draft as KnowledgeOutput;
  if (
    refs.some(
      (ref) =>
        !draft.knowledge.some((k) => k.localRef === ref) ||
        !patch.knowledge.some((k) => k.localRef === ref),
    ) ||
    new Set(patch.knowledge.map((k) => k.localRef)).size !== patch.knowledge.length
  )
    throw ProviderError.completeCandidate(patch, [
      '知识局部修订必须保留每个指定localRef，不得遗漏或改名。',
    ]);
  return accountKnowledgeBlocks(
    {
      knowledge: draft.knowledge.map((k) =>
        refs.includes(k.localRef) ? patch.knowledge.find((v) => v.localRef === k.localRef)! : k,
      ),
      dispositions: draft.dispositions,
    },
    input.blocks,
  );
}
