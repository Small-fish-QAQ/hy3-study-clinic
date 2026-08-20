import { createHash } from 'node:crypto';
import {
  MASTERY_RED_TEAM_FAMILY_POLICY,
  MASTERY_RED_TEAM_MAX_OBJECTIVES,
  MASTERY_RED_TEAM_MAX_OVERLAP,
  MASTERY_RED_TEAM_NOVELTY_POLICY,
  MASTERY_RED_TEAM_VALIDATION_POLICY,
  MasteryCandidateValidationSchema,
  MasteryFragilityHypothesisSchema,
  type MasteryCandidateRejectionCode,
  type MasteryCandidateValidation,
  type MasteryChallengeCandidate,
  type MasteryChallengeFamily,
  type MasteryChallengeProposalPayload,
  type MasteryFragilityBasis,
  type MasteryFragilityHypothesis,
  type MasteryRedTeamShadowOutcome,
  type MasterySnapshot,
} from '@hy3-clinic/shared';

const FAMILY_PRIORITY: MasteryChallengeFamily[] = [
  'historical_misconception',
  'near_neighbor_confusion',
  'transfer',
  'boundary_conditions',
  'hidden_premise_change',
  'counterexample',
  'error_diagnosis',
  'plausible_alternative_refutation',
  'cross_learning_unit_synthesis',
  'adversarial_distractor',
  'representation_shift',
  'discriminative_follow_up',
];

const SUMMARY: Record<MasteryChallengeFamily, string> = {
  transfer: 'Prior evidence may not establish transfer to a changed source-grounded situation.',
  boundary_conditions: 'Prior evidence may not establish the limits or boundary conditions.',
  near_neighbor_confusion: 'Related concepts may remain distinguishable only in familiar wording.',
  hidden_premise_change: 'A prerequisite or premise change may expose fragile understanding.',
  counterexample: 'Prior evidence did not require testing a source-grounded counterexample.',
  error_diagnosis: 'A plausible faulty explanation may expose a relation or application gap.',
  plausible_alternative_refutation:
    'Prior evidence did not require explaining why a plausible alternative is wrong.',
  cross_learning_unit_synthesis:
    'Completed related LearningUnits may not yet be integrated under one bounded challenge.',
  historical_misconception:
    'A historical misconception is resolved but remains a locally defensible fragility hypothesis.',
  adversarial_distractor: 'Related concepts support a fair source-grounded plausible distractor.',
  discriminative_follow_up:
    'A prior shadow result permits one explicit increasingly discriminative follow-up.',
  representation_shift: 'Prior evidence may rely on one phrasing or representation.',
};

export interface FragilityInput {
  reviewTargetId: string;
  evidencePrompts: Array<{ id: string; prompt: string }>;
  conceptIds: string[];
  relatedObjectiveIds: string[];
  prerequisiteUnitIds: string[];
  synthesisGroupIds: string[];
  misconceptions: Array<{ id: string; status: string; category: string }>;
  repairs: Array<{ id: string; diagnosticCategory: string }>;
  parentOutcome: MasteryRedTeamShadowOutcome | null;
}

function stableHypothesisId(targetId: string, family: MasteryChallengeFamily): string {
  return `red_team_hypothesis_${createHash('sha256')
    .update(`${targetId}:${family}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function containsAny(text: string, terms: string[]): boolean {
  const normalized = normalizeChallengeText(text);
  return terms.some((term) => normalized.includes(normalizeChallengeText(term)));
}

export function deriveFragilityHypotheses(input: FragilityInput): MasteryFragilityHypothesis[] {
  const byFamily = new Map<
    MasteryChallengeFamily,
    { basis: Set<MasteryFragilityBasis>; records: Set<string> }
  >();
  const add = (
    family: MasteryChallengeFamily,
    basis: MasteryFragilityBasis,
    records: string[] = [],
  ) => {
    const entry = byFamily.get(family) ?? { basis: new Set(), records: new Set() };
    entry.basis.add(basis);
    records.forEach((id) => entry.records.add(id));
    byFamily.set(family, entry);
  };
  const prompts = input.evidencePrompts.map((item) => item.prompt);
  const evidenceIds = input.evidencePrompts.map((item) => item.id);
  if (
    prompts.length <= 1 ||
    new Set(prompts.map((prompt) => normalizeChallengeText(prompt))).size <= 1
  ) {
    add('representation_shift', 'single_representation', evidenceIds);
  }
  if (
    !prompts.some((prompt) =>
      containsAny(prompt, ['apply', 'scenario', 'transfer', '应用', '情境']),
    )
  ) {
    add('transfer', 'direct_recall_only', evidenceIds);
  }
  if (
    !prompts.some((prompt) => containsAny(prompt, ['boundary', 'limit', 'except', '边界', '例外']))
  ) {
    add('boundary_conditions', 'direct_recall_only', evidenceIds);
  }
  if (input.prerequisiteUnitIds.length > 0) {
    add('hidden_premise_change', 'prerequisite_structure', input.prerequisiteUnitIds);
  }
  if (input.conceptIds.length > 1 || input.relatedObjectiveIds.length > 0) {
    add('near_neighbor_confusion', 'related_concepts', input.conceptIds);
    add('adversarial_distractor', 'related_concepts', input.conceptIds);
  }
  add('counterexample', 'counterexample_not_observed', evidenceIds);
  add('plausible_alternative_refutation', 'alternative_refutation_not_observed', evidenceIds);
  const historical = input.misconceptions.filter((item) => item.status === 'resolved');
  if (historical.length > 0) {
    add(
      'historical_misconception',
      'historical_misconception',
      historical.map((item) => item.id),
    );
  }
  const relationRecords = [
    ...input.misconceptions
      .filter((item) =>
        ['reversed_causality', 'application_error', 'sequence_error'].includes(item.category),
      )
      .map((item) => item.id),
    ...input.repairs
      .filter((item) => ['RELATION_REVERSAL', 'PROCEDURAL_GAP'].includes(item.diagnosticCategory))
      .map((item) => item.id),
  ];
  if (relationRecords.length > 0) {
    add('error_diagnosis', 'historical_relation_error', relationRecords);
  }
  if (input.synthesisGroupIds.length > 0) {
    add('cross_learning_unit_synthesis', 'synthesis_group', input.synthesisGroupIds);
  }
  if (input.parentOutcome === 'possible_gap') {
    add('discriminative_follow_up', 'prior_shadow_possible_gap');
  }
  if (input.parentOutcome === 'inconclusive') {
    add('discriminative_follow_up', 'prior_shadow_inconclusive');
  }
  return FAMILY_PRIORITY.flatMap((family) => {
    const entry = byFamily.get(family);
    if (!entry) return [];
    return [
      MasteryFragilityHypothesisSchema.parse({
        id: stableHypothesisId(input.reviewTargetId, family),
        family,
        basisCodes: [...entry.basis],
        relatedRecordIds: [...entry.records].slice(0, 20),
        summary: SUMMARY[family],
      }),
    ];
  });
}

export function selectChallengeFamily(
  hypotheses: MasteryFragilityHypothesis[],
  exposure: Partial<Record<MasteryChallengeFamily, number>>,
) {
  if (hypotheses.length === 0)
    throw new Error('No locally defensible fragility hypothesis exists.');
  const priority = new Map(FAMILY_PRIORITY.map((family, index) => [family, index]));
  const ranked = [...hypotheses].sort(
    (a, b) =>
      (exposure[a.family] ?? 0) - (exposure[b.family] ?? 0) ||
      (priority.get(a.family) ?? Number.MAX_SAFE_INTEGER) -
        (priority.get(b.family) ?? Number.MAX_SAFE_INTEGER) ||
      a.family.localeCompare(b.family),
  );
  const selected = ranked[0]!;
  return {
    hypothesis: selected,
    selection: {
      policyVersion: MASTERY_RED_TEAM_FAMILY_POLICY,
      consideredFamilies: ranked.map((item) => item.family),
      priorExposure: Object.fromEntries(
        ranked.map((item) => [item.family, exposure[item.family] ?? 0]),
      ),
      reason: `Selected the least-used locally supported family (${selected.family}); stable priority and literal order break ties.`,
    },
  };
}

export function normalizeChallengeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ngrams(value: string, size: number): Set<string> {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < size) return compact ? new Set([compact]) : new Set();
  return new Set(
    Array.from({ length: compact.length - size + 1 }, (_, index) =>
      compact.slice(index, index + size),
    ),
  );
}

function wordTrigrams(value: string): Set<string> {
  const words = value.split(' ').filter(Boolean);
  if (words.length < 3) return words.length > 0 ? new Set([words.join(' ')]) : new Set();
  return new Set(
    Array.from({ length: words.length - 2 }, (_, index) => words.slice(index, index + 3).join(' ')),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection || 1);
}

export function lexicalChallengeOverlap(left: string, right: string): number {
  const a = normalizeChallengeText(left);
  const b = normalizeChallengeText(right);
  if (a === b) return 1;
  return Math.max(jaccard(wordTrigrams(a), wordTrigrams(b)), jaccard(ngrams(a, 4), ngrams(b, 4)));
}

function fingerprintPrompt(prompt: string): string {
  return `${MASTERY_RED_TEAM_NOVELTY_POLICY}_${createHash('sha256')
    .update(normalizeChallengeText(prompt))
    .digest('hex')
    .slice(0, 32)}`;
}

function validateOne(
  candidate: MasteryChallengeCandidate,
  snapshot: MasterySnapshot,
  family: MasteryChallengeFamily,
  priorCandidates: MasteryChallengeCandidate[],
): MasteryCandidateValidation {
  const rejection = new Set<MasteryCandidateRejectionCode>();
  const sourceRefs = new Set(snapshot.sources.map((source) => source.ref));
  const objectiveRefs = new Set(
    [
      snapshot.target.objectiveId,
      ...snapshot.target.relatedObjectives
        .slice(0, MASTERY_RED_TEAM_MAX_OBJECTIVES - 1)
        .map((item) => item.id),
    ].map((_objectiveId, index) => `O${index + 1}`),
  );
  const candidateSourceRefs = new Set(candidate.sourceRefs);
  if (candidate.family !== family) rejection.add('FAMILY_MISMATCH');
  if (candidate.targetObjectiveRefs.some((ref) => !objectiveRefs.has(ref))) {
    rejection.add('UNKNOWN_OBJECTIVE_REF');
  }
  if (!candidate.targetObjectiveRefs.includes('O1')) rejection.add('TARGET_OBJECTIVE_MISSING');
  const everyClaimRef = [
    ...candidate.sourceRefs,
    ...candidate.expectedAnswerSourceRefs,
    ...candidate.premises.flatMap((premise) => premise.sourceRefs),
    ...candidate.rubric.flatMap((criterion) => criterion.sourceRefs),
  ];
  if (everyClaimRef.some((ref) => !sourceRefs.has(ref))) rejection.add('UNKNOWN_SOURCE_REF');
  if (
    candidate.expectedAnswerSourceRefs.some((ref) => !candidateSourceRefs.has(ref)) ||
    candidate.premises.some((premise) =>
      premise.sourceRefs.some((ref) => !candidateSourceRefs.has(ref)),
    ) ||
    candidate.rubric.some((criterion) =>
      criterion.sourceRefs.some((ref) => !candidateSourceRefs.has(ref)),
    )
  ) {
    rejection.add('SOURCE_SCOPE_MISMATCH');
  }
  const required = candidate.rubric.filter((criterion) => criterion.required);
  if (required.length === 0) rejection.add('MISSING_REQUIRED_RUBRIC');
  if (required.some((criterion) => criterion.sourceRefs.length === 0)) {
    rejection.add('UNBOUND_REQUIRED_RUBRIC');
  }
  if (candidate.expectedAnswerSourceRefs.length === 0) rejection.add('UNBOUND_EXPECTED_ANSWER');
  if (candidate.requiresExternalKnowledge) rejection.add('EXTERNAL_KNOWLEDGE_REQUIRED');
  if (candidate.premises.some((premise) => !premise.learnerVisible))
    rejection.add('HIDDEN_PREMISE');
  if (candidate.ambiguity === 'unresolved') rejection.add('UNRESOLVED_AMBIGUITY');
  if (candidate.undefinedTerms.length > 0) rejection.add('UNDEFINED_TERM');
  const normalizedPrompt = normalizeChallengeText(candidate.prompt);
  if (normalizedPrompt.replace(/\s+/g, '').length < 18) rejection.add('TRIVIAL_CANDIDATE');
  const normalizedAnswer = normalizeChallengeText(candidate.expectedAnswer);
  if (normalizedAnswer.length >= 12 && normalizedPrompt.includes(normalizedAnswer)) {
    rejection.add('ANSWER_LEAKAGE');
  }
  if (
    priorCandidates.some(
      (prior) =>
        prior.candidateKey === candidate.candidateKey ||
        lexicalChallengeOverlap(prior.prompt, candidate.prompt) >= MASTERY_RED_TEAM_MAX_OVERLAP,
    )
  ) {
    rejection.add('DUPLICATE_CANDIDATE');
  }
  let maxPriorOverlap = 0;
  let maxPriorOverlapId: string | null = null;
  for (const prior of snapshot.priorQuestions) {
    const overlap = lexicalChallengeOverlap(candidate.prompt, prior.prompt);
    if (overlap > maxPriorOverlap) {
      maxPriorOverlap = overlap;
      maxPriorOverlapId = prior.id;
    }
  }
  if (maxPriorOverlap >= MASTERY_RED_TEAM_MAX_OVERLAP) {
    rejection.add('PRIOR_QUESTION_OVERLAP');
  }
  return MasteryCandidateValidationSchema.parse({
    policyVersion: MASTERY_RED_TEAM_VALIDATION_POLICY,
    valid: rejection.size === 0,
    rejectionCodes: [...rejection],
    maxPriorOverlap,
    maxPriorOverlapId,
    normalizedPromptFingerprint: fingerprintPrompt(candidate.prompt),
    exactQuoteValidated: snapshot.sources.every(
      (source) => source.authoritative && source.contentOrigin === 'extracted_original',
    ),
    semanticEntailmentClaimed: false,
  });
}

export function analyzeMasteryChallengeProposal(
  payload: MasteryChallengeProposalPayload,
  snapshot: MasterySnapshot,
  family: MasteryChallengeFamily,
) {
  const validations: MasteryCandidateValidation[] = [];
  payload.candidates.forEach((candidate, index) => {
    validations.push(validateOne(candidate, snapshot, family, payload.candidates.slice(0, index)));
  });
  const admissibleIndexes = validations.flatMap((validation, index) =>
    validation.valid ? [index] : [],
  );
  const selectedIndex = [...admissibleIndexes].sort((leftIndex, rightIndex) => {
    const left = payload.candidates[leftIndex]!;
    const right = payload.candidates[rightIndex]!;
    const leftCoverage = new Set([...left.targetObjectiveRefs, ...left.sourceRefs]).size;
    const rightCoverage = new Set([...right.targetObjectiveRefs, ...right.sourceRefs]).size;
    return (
      rightCoverage - leftCoverage ||
      validations[leftIndex]!.maxPriorOverlap - validations[rightIndex]!.maxPriorOverlap ||
      left.candidateKey.localeCompare(right.candidateKey)
    );
  })[0];
  const diagnostics = validations.flatMap((validation, index) =>
    validation.valid ? [] : [`candidate ${index + 1}: ${validation.rejectionCodes.join(', ')}`],
  );
  return {
    validations,
    selectedIndex: selectedIndex ?? null,
    providerValidation: {
      valid: selectedIndex !== undefined,
      diagnostics: diagnostics.slice(0, 12),
      diagnosticCodes: [...new Set(validations.flatMap((item) => item.rejectionCodes))],
    },
  };
}

export function classifyShadowOutcome(input: {
  requiredCriterionIds: string[];
  criterionResults: Array<{ criterionId: string; result: 'met' | 'partial' | 'not_met' }>;
}): MasteryRedTeamShadowOutcome {
  const results = new Map(input.criterionResults.map((item) => [item.criterionId, item.result]));
  if (
    input.requiredCriterionIds.length > 0 &&
    input.requiredCriterionIds.every((id) => results.get(id) === 'met')
  ) {
    return 'robust_signal';
  }
  if (input.requiredCriterionIds.some((id) => results.get(id) === 'not_met')) {
    return 'possible_gap';
  }
  return 'inconclusive';
}
