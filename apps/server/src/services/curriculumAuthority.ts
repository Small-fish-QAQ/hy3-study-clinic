import {
  CurriculumAuthorityEnvelopeSchema,
  isFormalSupportedConstruct,
  type CurriculumAuthorityEnvelope,
  type FormalAssessmentConstruct,
  type FormalSupportedConstruct,
  type VerifiedGrounding,
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

function normalizedExactClaim(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/**
 * Recognize only an explicitly framed ordered procedure. Arrow-shaped entity
 * relationships alone (for example User -> Role -> Permission) are not enough:
 * the source must label the sequence as a flow, process, required order, or
 * concrete operation and expose at least three ordered steps.
 */
export function isExplicitSourceProcedure(claim: string): boolean {
  const normalized = normalizedExactClaim(claim);
  const steps = normalized
    .split(/(?:→|⇒|->|=>)/u)
    .map((step) => step.trim())
    .filter(Boolean);
  if (steps.length < 3 || steps.some((step) => step.length > 240)) return false;
  const frame = steps[0]!;
  return /(?:流程|步骤|链路|过程|用法|操作|必须|须|应|先|入库|查询|检索|重建|pipeline|workflow|procedure|steps?|process|must|should)/iu.test(
    frame,
  );
}

export function curriculumTargetRequestsApplication(targetOutcome: string): boolean {
  return /(?:\bapply\b|应用)/iu.test(targetOutcome);
}

type ExactAuthorityClaim = {
  bundle: SourceAuthorityBundle;
  claim: SourceAuthorityBundle['claims'][number];
};

function pairedProcedureClaims(formalClaims: ExactAuthorityClaim[]): ExactAuthorityClaim[] {
  const procedureClaimsByQuote = new Map<
    string,
    {
      claim: ExactAuthorityClaim;
      premiseKinds: Set<'expected_answer' | 'rubric_point'>;
    }
  >();
  for (const item of formalClaims) {
    const premiseKind = item.bundle.record.policyBasis.premiseKind;
    if (
      item.bundle.record.actor !== 'local_validator' ||
      !['local-verbatim-source-v1', 'local-verbatim-source-v2'].includes(
        item.bundle.record.policyBasis.policyVersion,
      ) ||
      (premiseKind !== 'expected_answer' && premiseKind !== 'rubric_point') ||
      normalizedExactClaim(item.claim.claim) !== normalizedExactClaim(item.claim.quote) ||
      !isExplicitSourceProcedure(item.claim.claim)
    ) {
      continue;
    }
    const key = `${item.claim.sourceBlockId}\u0000${normalizedExactClaim(item.claim.quote)}`;
    const existing = procedureClaimsByQuote.get(key) ?? {
      claim: item,
      premiseKinds: new Set<'expected_answer' | 'rubric_point'>(),
    };
    existing.premiseKinds.add(premiseKind);
    procedureClaimsByQuote.set(key, existing);
  }
  return [...procedureClaimsByQuote.values()]
    .filter(
      (item) => item.premiseKinds.has('expected_answer') && item.premiseKinds.has('rubric_point'),
    )
    .map((item) => item.claim);
}

/**
 * Return only exact, current, conflict-free local procedure pairs that can
 * support the bounded apply contract. This is also the provider-offer reserve
 * boundary, so selection cannot promote a lexical lookalike or one-sided
 * authority claim merely because it contains arrows.
 */
export function selectApplyCapableProcedureGroundings(input: {
  authorityBundles: SourceAuthorityBundle[];
  isBlockingEligible: (authorityRecordId: string) => boolean;
}): VerifiedGrounding[] {
  const formalClaims = input.authorityBundles.flatMap((bundle) =>
    bundle.record.validationState === 'validated' &&
    bundle.record.conflictState === 'none' &&
    input.isBlockingEligible(bundle.record.id)
      ? bundle.claims.map((claim) => ({ bundle, claim }))
      : [],
  );
  return pairedProcedureClaims(formalClaims).map(({ claim }) => ({
    blockId: claim.sourceBlockId,
    quote: claim.quote,
    startOffset: claim.startOffset,
    endOffset: claim.endOffset,
    occurrenceCount: claim.occurrenceCount,
    reanchored: false,
  }));
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
      .map(
        (offer) =>
          [
            `${offer.blockId}\u0000${offer.startOffset}\u0000${offer.endOffset}\u0000${offer.quote}`,
            offer,
          ] as const,
      ),
  );
  const exactClaims = input.authorityBundles.flatMap((bundle) =>
    bundle.claims
      .filter((claim) => blockIds.has(claim.sourceBlockId))
      .map((claim) => ({
        bundle,
        claim,
        offer: evidenceByKey.get(
          `${claim.sourceBlockId}\u0000${claim.startOffset}\u0000${claim.endOffset}\u0000${claim.quote}`,
        ),
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
  const supportedConstructs = new Set<FormalSupportedConstruct>();
  const procedureClaim = pairedProcedureClaims(formalClaims)[0];
  if (formalClaims.length > 0) {
    supportedConstructs.add('identify');
    if (procedureClaim || formalClaims.some(({ claim }) => supportsExplain(claim.claim))) {
      supportedConstructs.add('explain');
    }
    if (procedureClaim) supportedConstructs.add('apply');
  }
  // Ordered weakest-to-strongest over the FORMAL-SUPPORTED vocabulary only.
  // `design`/`evaluate` are deliberately absent: no local predicate can decide
  // them, so listing them here would imply an authority rung that cannot be
  // reached. They remain available as teaching constructs elsewhere.
  const orderedConstructs: FormalSupportedConstruct[] = ['identify', 'explain', 'apply'];
  const constructs = orderedConstructs.filter((construct) => supportedConstructs.has(construct));
  const tier =
    formalClaims.length === 0
      ? exactClaims.length > 0
        ? 'teaching_only'
        : 'unavailable'
      : constructs.includes('explain')
        ? 'formal_sufficient'
        : 'narrower_formal';
  const narrowerClaim =
    (procedureClaim?.claim.claim ?? claims[0]?.claim.claim)?.trim().slice(0, 500) ?? null;
  const rationale =
    tier === 'formal_sufficient'
      ? procedureClaim
        ? '当前来源同时提供已验证的精确预期答案与评分点，并明确给出有序操作流程；正式应用仅限按原流程及原语境执行。'
        : '当前来源存在已验证的精确权威，可支持识别并在来源明确说明时解释。'
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
  const explicit = claim
    .trimStart()
    .match(/^(identify|explain|apply|design|evaluate|识别|解释|应用|设计|评估)\s*[:：]/iu)?.[1]
    ?.toLocaleLowerCase();
  if (explicit === 'evaluate' || explicit === '评估') return 'evaluate';
  if (explicit === 'design' || explicit === '设计') return 'design';
  if (explicit === 'apply' || explicit === '应用') return 'apply';
  if (explicit === 'explain' || explicit === '解释') return 'explain';
  if (explicit === 'identify' || explicit === '识别') return 'identify';
  if (/(?:evaluate|assess|audit|评估|评价|审计)/iu.test(claim)) return 'evaluate';
  if (/(?:design|deploy|secure|production|architect|设计|部署|生产|架构|安全)/iu.test(claim))
    return 'design';
  if (/(?:apply|configure|implement|应用|配置|实现|操作)/iu.test(claim)) return 'apply';
  if (/(?:explain|describe|role|purpose|because|解释|说明|作用|职责|原理|关系)/iu.test(claim)) {
    return 'explain';
  }
  return 'identify';
}

/**
 * Preserve the exact narrowed topic while marking the locally controlled
 * assessed action explicitly. The marker prevents topical words inside the
 * source claim from being mistaken for a higher-order assessment demand.
 */
export function formatNarrowedFormalObjective(
  construct: FormalSupportedConstruct,
  narrowerClaim: string,
): { title: string; description: string } {
  const verb = construct === 'apply' ? 'Apply' : construct === 'explain' ? 'Explain' : 'Identify';
  const claim = narrowerClaim.slice(0, 500);
  if (construct === 'apply') {
    return {
      title: `${verb}: ${claim}`.slice(0, 300),
      description:
        `Apply only the source-stated procedure in its stated context. Source-supported procedure: ${claim}`.slice(
          0,
          1_000,
        ),
    };
  }
  return {
    title: `${verb}: ${claim}`.slice(0, 300),
    description:
      `${verb} only what the current source explicitly states. Narrowed source-supported scope: ${claim}`.slice(
        0,
        1_000,
      ),
  };
}

export function strongestNarrowableConstruct(
  envelope: Pick<CurriculumAuthorityEnvelope, 'supportedConstructs'>,
): FormalSupportedConstruct | null {
  if (envelope.supportedConstructs.includes('apply')) return 'apply';
  if (envelope.supportedConstructs.includes('explain')) return 'explain';
  if (envelope.supportedConstructs.includes('identify')) return 'identify';
  return null;
}

export function isConstructSupported(
  requested: FormalAssessmentConstruct,
  envelope: CurriculumAuthorityEnvelope,
): boolean {
  // Stated, not merely emergent. `supportedConstructs` cannot contain a
  // teaching-only construct, but the refusal is written here too so that
  // widening the envelope alone can never grant Formal authority.
  if (!isFormalSupportedConstruct(requested)) return false;
  return envelope.supportedConstructs.includes(requested);
}

/**
 * Apply-level authority is narrower than a construct enum: only the local
 * controlled wording may claim it, and that wording must retain the exact
 * source-stated procedure. Provider-authored transfer/design scope therefore
 * remains unsupported even when the selected evidence contains a procedure.
 */
export function isFormalObjectiveSupported(
  claim: string,
  envelope: CurriculumAuthorityEnvelope,
  requestedConstruct: FormalAssessmentConstruct = detectFormalConstruct(claim),
): boolean {
  const construct = requestedConstruct;
  if (!isConstructSupported(construct, envelope)) return false;
  if (construct !== 'apply') return true;
  const procedure = envelope.narrowerClaim;
  return Boolean(
    procedure &&
    claim.trimStart().startsWith('Apply:') &&
    claim.includes(`Source-supported procedure: ${procedure}`),
  );
}
