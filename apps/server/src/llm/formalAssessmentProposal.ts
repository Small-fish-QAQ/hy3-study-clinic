import { AssessmentProposalPayloadSchema } from '@hy3-clinic/shared';
import type {
  AssessmentProposalInput,
  ProviderCandidateValidation,
  ProviderCandidateNormalization,
} from './provider.js';

/** Resolve only the observed first UUID segment when exactly one offered
 * concept has that prefix. Text, evidence, goals and answer keys stay intact. */
export function normalizeFormalConceptRefs(
  raw: unknown,
  input: AssessmentProposalInput,
): ProviderCandidateNormalization {
  const parsed = AssessmentProposalPayloadSchema.safeParse(raw);
  if (!parsed.success) return { candidate: raw, actions: [] };
  const ids = input.targets.map((t) => t.concept.id);
  const paths: string[] = [];
  const resolve = (value: string, path: string): string => {
    if (ids.includes(value) || !/^con_[0-9a-f]{8}$/u.test(value)) return value;
    const matches = ids.filter((id) => id.startsWith(value + '-'));
    if (matches.length !== 1) return value;
    paths.push(path);
    return matches[0]!;
  };
  const candidate = structuredClone(parsed.data);
  candidate.items.forEach((item, i) => {
    item.question.conceptId = resolve(item.question.conceptId, `items.${i}.question.conceptId`);
    item.blueprint.conceptIds = item.blueprint.conceptIds.map((id, j) =>
      resolve(id, `items.${i}.blueprint.conceptIds.${j}`),
    );
  });
  return {
    candidate: paths.length ? candidate : raw,
    actions: paths.length ? [{ code: 'opaque_identity_expanded', paths }] : [],
  };
}

export const FORMAL_PROPOSAL_DECLARATIONS =
  '每道正式题必须完整声明 objectiveRef、非空 premises、requiresExternalKnowledge、ambiguity、undefinedTerms 和 extraEvidence。没有额外证据时写 extraEvidence: []，不要为填字段加入无关资料。每个 premise 必须包含 text、sourceRefs、teachingSurfaceRefs、learnerVisible、scenarioLocal、visibilityBasis；不要因前一轮只报告部分字段而省略其他必需字段。learnerVisible 指学习者能通过题干、实际引用的来源或已呈现教学获得该前提，不只指题干逐字写出。正式题不能依赖 learnerVisible=false 的隐藏前提；确实缺失时须补进题干或重建任务，不能仅改成true。visibilityBasis只用stem、cited_source、taught_exposure、scenario_local、assumed_prerequisite。stem/scenario_local/assumed_prerequisite的text必须逐字摘取题干中的完整连续前提，cited_source的text须逐字摘取每个所引原文块；这些text是可定位的可见性记录，不是让你概括整题或拼接条件。多个分散前提分别记录，不加“题干设定的事实”等不存在的前缀。新假设用scenario_local=true且sourceRefs=[]；已有原文事实若也写入题干则用stem，不得冒充新情境。taught_exposure只能用本目标真实提供的T别名。独立审核另外检查前提充分性和真实推导，逐字可定位不等于评分权威。';

/** Early authoring feedback only. Persisted authority is checked again at admission. */
export function validateFormalScoringProposal(
  raw: unknown,
  input: AssessmentProposalInput,
): ProviderCandidateValidation {
  const diagnostics: string[] = [];
  const parsed = AssessmentProposalPayloadSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, diagnostics: ['Invalid assessment proposal shape.'] };
  if (!input.scoringAuthorityCatalogue) return { valid: true, diagnostics };
  const conceptIds = new Set(input.targets.map((t) => t.concept.id));
  if (conceptIds.size)
    for (const [index, item] of parsed.data.items.entries()) {
      if (
        !conceptIds.has(item.question.conceptId) ||
        item.blueprint.conceptIds.some((id) => !conceptIds.has(id))
      )
        diagnostics.push(
          `items.${index} must use full conceptIds from the offered target inventory: ${[...conceptIds].join(', ')}. Never shorten an identity.`,
        );
    }
  if (input.semanticScoringReview) {
    // Actual entailment, hidden-key correctness and required-criterion scope
    // are checked by the separate blind solution/review before persistence.
    for (const [index, item] of parsed.data.items.entries()) {
      const normalize = (text: string) =>
        text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      const contains = (haystack: string, needle: string) =>
        normalize(haystack).includes(normalize(needle));
      const attached = new Set([
        item.question.blockId,
        ...item.extraEvidence.map((e) => e.blockId),
      ]);
      for (const [premiseIndex, premise] of (item.premises ?? []).entries()) {
        if (!premise.learnerVisible)
          diagnostics.push(
            `items.${index}.premises.${premiseIndex}.learnerVisible is false, so this draft cannot enter Formal admission. learnerVisible means available through the actual stem, cited source, or previously presented teaching, not only repeated in the stem. Check the stated visibilityBasis and offered evidence. If the premise is genuinely hidden, supply it explicitly or rebuild the task; do not merely change the flag or invent exposure. Admission independently checks the actual visibility route.`,
          );
        const path = `items.${index}.premises.${premiseIndex}`;
        if (
          ['stem', 'scenario_local', 'assumed_prerequisite'].includes(premise.visibilityBasis) &&
          !contains(item.question.stem, premise.text)
        ) {
          diagnostics.push(
            `${path}.text is not a complete contiguous passage in question.stem. Admission verifies exact visible location, so copy the actual premise without a summary/prefix, or split separate premises. Do not silently remove required conditions or change the problem merely to match a declaration.`,
          );
        }
        if (
          premise.visibilityBasis === 'scenario_local' &&
          (!premise.scenarioLocal ||
            premise.sourceRefs.length > 0 ||
            input.blocks.some((b) => contains(b.content, premise.text)))
        ) {
          diagnostics.push(
            `${path} cannot claim scenario_local: this route requires an explicitly stated new scenario fact with scenarioLocal=true and sourceRefs=[]. For an existing source fact repeated in the stem, use stem; never disguise source content as a new hypothetical assumption.`,
          );
        }
        if (
          premise.visibilityBasis === 'cited_source' &&
          (!premise.sourceRefs.length ||
            premise.sourceRefs.some((ref) => {
              const block = input.blocks.find((b) => b.id === ref);
              return !attached.has(ref) || !block || !contains(block.content, premise.text);
            }))
        ) {
          diagnostics.push(
            `${path} needs a complete exact passage in every cited attached source block. Split noncontiguous source premises and cite their actual blocks; a paraphrase or a list of unrelated sourceRefs cannot locate this premise.`,
          );
        }
        if (
          premise.teachingSurfaceRefs.some(
            (ref) =>
              !input.teachingSurfaceCatalogue?.some(
                (surface) =>
                  surface.teachingSurfaceRef === ref &&
                  surface.objectiveRefs.includes(item.objectiveRef!),
              ),
          )
        ) {
          diagnostics.push(
            `${path}.teachingSurfaceRefs must identify actual offered surfaces for this objective. Use the existing source/stem route when that is the real visibility basis; never invent or borrow a T alias.`,
          );
        }
      }
      const claims =
        input.scoringAuthorityCatalogue.find((c) => c.objectiveRef === item.objectiveRef)?.claims ??
        [];
      const blocks = new Set(claims.map((c) => c.sourceBlockId));
      const attachedBlocks = new Set([
        item.question.blockId,
        ...item.extraEvidence.map((e) => e.blockId),
      ]);
      const sourceScope = `Allowed sourceRefs for ${item.objectiveRef}: ${[...blocks].join(', ') || '(none)'}. Other source blocks are background, not additional scoring authority for this objective. Rebuild an unsupported criterion or task around the offered claims; do not relabel a foreign fact with an allowed sourceRef. A hypothetical scenario may explicitly give new local facts, but the scored rule must follow from the offered claims.`;
      if (
        !item.question.expectedAnswer ||
        !item.question.rubricKeyPoints?.some((p) => typeof p !== 'string' && p.required)
      )
        diagnostics.push(`items.${index} needs a complete key and explicit required criteria.`);
      if (!blocks.has(item.question.blockId))
        diagnostics.push(`items.${index} must cite this objective's source scope. ${sourceScope}`);
      for (const [pointIndex, p] of (item.question.rubricKeyPoints ?? []).entries()) {
        if (
          typeof p === 'string' ||
          (p.required && (!p.sourceRefs?.length || p.sourceRefs.some((r) => !blocks.has(r))))
        )
          diagnostics.push(
            `items.${index}.question.rubricKeyPoints.${pointIndex} needs actual objective-scoped sourceRefs. ${sourceScope}`,
          );
        else if (p.required && p.sourceRefs?.some((ref) => !attachedBlocks.has(ref)))
          diagnostics.push(
            `items.${index}.question.rubricKeyPoints.${pointIndex} cites unattached sourceRefs: ${p.sourceRefs.filter((ref) => !attachedBlocks.has(ref)).join(', ')}. Attach an exact original quotation for every needed block in extraEvidence, or rebuild the criterion using the evidence actually attached. Merely listing a sourceRef does not attach its evidence. Keep the complete scoring requirement; do not replace it with an unrelated claim.`,
          );
      }
    }
    return { valid: diagnostics.length === 0, diagnostics };
  }
  const normalize = (text: string) =>
    text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  for (const [index, item] of parsed.data.items.entries()) {
    const claims =
      input.scoringAuthorityCatalogue.find((entry) => entry.objectiveRef === item.objectiveRef)
        ?.claims ?? [];
    const evidenceBlocks = new Set([
      item.question.blockId,
      ...item.extraEvidence.map((e) => e.blockId),
    ]);
    const matches = (text: string, kind: 'expected_answer' | 'rubric_point', refs?: string[]) =>
      claims.some(
        (claim) =>
          claim.premiseKinds.includes(kind) &&
          normalize(claim.text) === normalize(text) &&
          evidenceBlocks.has(claim.sourceBlockId) &&
          (!refs || refs.includes(claim.sourceBlockId)),
      );
    if (!item.question.expectedAnswer || !matches(item.question.expectedAnswer, 'expected_answer'))
      diagnostics.push(
        `items.${index}.question.expectedAnswer must copy a complete offered expected_answer claim for its objective and cite that block. Do not paraphrase, concatenate or invent a scoring premise.`,
      );
    for (const [pointIndex, point] of (item.question.rubricKeyPoints ?? []).entries()) {
      if (
        typeof point === 'string' ||
        (point.required && !matches(point.text, 'rubric_point', point.sourceRefs))
      )
        diagnostics.push(
          `items.${index}.question.rubricKeyPoints.${pointIndex} must copy an offered rubric_point claim for this objective with its sourceRefs.`,
        );
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    diagnosticCodes: diagnostics.map(() => 'formal_scoring_premise_not_offered'),
  };
}
