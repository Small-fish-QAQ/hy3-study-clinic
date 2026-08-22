import {
  CurriculumAuthorityEnvelopeSchema,
  type CurriculumAuthorityEnvelope,
  type FormalAssessmentConstruct,
} from '@hy3-clinic/shared';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import type { SourceAuthorityBundle } from '../repositories/sourceAuthority.js';

export interface CurriculumAuthorityEnvelopeInput {
  sourceRegionId: string;
  sourceBlockIds: string[];
  evidence: CurriculumEvidenceOffer[];
  authorityBundles: SourceAuthorityBundle[];
  isBlockingEligible: (authorityRecordId: string) => boolean;
}

function supportsExplain(claim: string): boolean {
  return /(?:\b(?:role|purpose|means|consists?|includes?|relationship|because|explain|describe|is|are|has|have|can|supports?|uses?|provides?|requires?|depends?)\b|作用|职责|关系|包括|包含|表示|说明|解释|原理|依赖|是|有|支持|使用|提供|需要)/iu.test(
    claim,
  );
}

/**
 * Construct the smallest useful authority envelope from exact local records.
 * This is intentionally qualitative: it never invents a confidence score or
 * treats a provider proposal as authority.
 */
export function buildCurriculumAuthorityEnvelope(
  input: CurriculumAuthorityEnvelopeInput,
): CurriculumAuthorityEnvelope {
  const blockIds = new Set(input.sourceBlockIds);
  const evidenceByKey = new Map(
    input.evidence
      .filter((offer) => blockIds.has(offer.blockId))
      .map((offer) => [`${offer.blockId}\u0000${offer.quote}`, offer] as const),
  );
  const exactClaims = input.authorityBundles.flatMap((bundle) =>
    bundle.claims
      .filter((claim) => blockIds.has(claim.sourceBlockId))
      .map((claim) => ({
        bundle,
        claim,
        offer: evidenceByKey.get(`${claim.sourceBlockId}\u0000${claim.quote}`),
      }))
      .filter((item) => item.offer),
  );
  const formalClaims = exactClaims.filter(
    ({ bundle }) =>
      bundle.record.validationState === 'validated' &&
      bundle.record.conflictState === 'none' &&
      input.isBlockingEligible(bundle.record.id),
  );
  const claims = formalClaims.length > 0 ? formalClaims : exactClaims;
  const supportedConstructs = new Set<FormalAssessmentConstruct>();
  if (formalClaims.length > 0) {
    supportedConstructs.add('identify');
    if (formalClaims.some(({ claim }) => supportsExplain(claim.claim))) {
      supportedConstructs.add('explain');
    }
  }
  const orderedConstructs: FormalAssessmentConstruct[] = [
    'identify',
    'explain',
    'apply',
    'design',
    'evaluate',
  ];
  const constructs = orderedConstructs.filter((construct) => supportedConstructs.has(construct));
  const tier =
    formalClaims.length === 0
      ? exactClaims.length > 0
        ? 'teaching_only'
        : 'unavailable'
      : constructs.includes('explain')
        ? 'formal_sufficient'
        : 'narrower_formal';
  const narrowerClaim = claims[0]?.claim.claim.trim().slice(0, 500) ?? null;
  const rationale =
    tier === 'formal_sufficient'
      ? '当前来源存在已验证的精确权威，可支持识别并在来源明确说明时解释。'
      : tier === 'narrower_formal'
        ? '当前来源存在精确权威，但正式构念应收窄到来源明确陈述的内容。'
        : tier === 'teaching_only'
          ? '来源可用于教学上下文，但当前没有独立验证的正式证据权威。'
          : '当前来源没有足以支持正式评估的精确权威。';
  return CurriculumAuthorityEnvelopeSchema.parse({
    sourceRegionId: input.sourceRegionId,
    sourceBlockIds: [...new Set(input.sourceBlockIds)].slice(0, 10_000),
    formalEvidenceIds: formalClaims.map(({ offer }) => offer!.id).slice(0, 100),
    supportedConstructs: constructs,
    strongestSupportedConstruct: constructs.at(-1) ?? null,
    narrowerClaim,
    tier,
    rationale,
  });
}

export function detectFormalConstruct(claim: string): FormalAssessmentConstruct {
  if (/(?:evaluate|assess|audit|评估|评价|审计)/iu.test(claim)) return 'evaluate';
  if (/(?:design|deploy|secure|production|architect|设计|部署|生产|架构|安全)/iu.test(claim))
    return 'design';
  if (/(?:apply|configure|implement|应用|配置|实现|操作)/iu.test(claim)) return 'apply';
  if (/(?:explain|describe|role|purpose|because|解释|说明|作用|职责|原理|关系)/iu.test(claim)) {
    return 'explain';
  }
  return 'identify';
}

export function isConstructSupported(
  requested: FormalAssessmentConstruct,
  envelope: CurriculumAuthorityEnvelope,
): boolean {
  return envelope.supportedConstructs.includes(requested);
}
