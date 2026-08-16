import {
  CurriculumRecoveryReadinessSchema,
  type CurriculumRecoveryReadiness,
  type LearningContract,
} from '@hy3-clinic/shared';
import { verifyGrounding } from '../grounding/verify.js';
import type { Repositories } from '../repositories/index.js';

interface RecoveryOptions {
  remediationRequired: boolean;
  candidateLaunchable: boolean;
}

/**
 * Resolve the earliest authoritative prerequisite for Curriculum execution repair.
 * This is read-only: it never creates canonical authority or calls a provider.
 */
export function assessCurriculumRecovery(
  repos: Repositories,
  contract: LearningContract,
  options: RecoveryOptions,
): CurriculumRecoveryReadiness {
  const includedMaterialIds = contract.courseScope.materials
    .filter((scope) => scope.disposition === 'included')
    .map((scope) => scope.materialId);
  const currentConcepts = includedMaterialIds.flatMap((materialId) =>
    repos.materials.getConcepts(materialId),
  );
  const currentConceptIds = new Set(currentConcepts.map((concept) => concept.id));
  const historicalConcepts = includedMaterialIds.flatMap((materialId) =>
    repos.materials.getConceptHistory(materialId),
  );
  const blocksByMaterial = new Map(
    includedMaterialIds.map((materialId) => [materialId, repos.materials.getBlocks(materialId)]),
  );
  const validConcepts = currentConcepts.filter(
    (concept) =>
      verifyGrounding(blocksByMaterial.get(concept.materialId) ?? [], concept.grounding).ok,
  );
  const validConceptIds = new Set(validConcepts.map((concept) => concept.id));
  const invalidGroundingCount = currentConcepts.length - validConcepts.length;
  const staleConceptCount =
    historicalConcepts.filter((concept) => !currentConceptIds.has(concept.id)).length +
    invalidGroundingCount;
  const currentCanonicals = repos.alignment
    .listCanonical(contract.workspaceId)
    .map((canonical) => ({
      canonical,
      currentMemberIds: canonical.members
        .map((member) => member.sourceConceptId)
        .filter((conceptId) => validConceptIds.has(conceptId)),
    }))
    .filter(({ currentMemberIds }) => currentMemberIds.length > 0);

  const counts = {
    includedMaterialCount: includedMaterialIds.length,
    currentConceptCount: currentConcepts.length,
    validGroundedConceptCount: validConcepts.length,
    staleConceptCount,
    invalidGroundingCount,
    canonicalConceptCount: currentCanonicals.length,
    canonicalMembershipCount: currentCanonicals.reduce(
      (total, item) => total + item.currentMemberIds.length,
      0,
    ),
  };

  if (!options.remediationRequired) {
    return CurriculumRecoveryReadinessSchema.parse({
      state: 'not_required',
      nextAction: 'none',
      remediationRequired: false,
      ...counts,
    });
  }
  if (options.candidateLaunchable) {
    return CurriculumRecoveryReadinessSchema.parse({
      state: 'curriculum_candidate_ready',
      nextAction: 'review_curriculum_successor',
      remediationRequired: true,
      ...counts,
    });
  }
  if (validConcepts.length === 0) {
    const stale = historicalConcepts.length > 0;
    return CurriculumRecoveryReadinessSchema.parse({
      state: stale ? 'concept_grounding_stale' : 'concept_grounding_missing',
      nextAction: stale ? 'rebuild_concept_grounding' : 'build_concept_grounding',
      remediationRequired: true,
      ...counts,
    });
  }
  return CurriculumRecoveryReadinessSchema.parse({
    state: 'curriculum_remediation_ready',
    nextAction: 'propose_curriculum_successor',
    remediationRequired: true,
    ...counts,
  });
}
