import {
  VisualMediaTypeSchema,
  fnv1a32,
  type ExecutionSourceManifest,
  type EmbeddedAsset,
  type VisualDerivation,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';

export interface AcceptedAdvisoryVisual {
  asset: EmbeddedAsset;
  derivation: VisualDerivation;
}

export function isEligibleOriginalVisual(asset: EmbeddedAsset): boolean {
  return (
    asset.relationshipKind === 'image' &&
    asset.contentOrigin === 'extracted_original' &&
    asset.width !== null &&
    asset.height !== null &&
    VisualMediaTypeSchema.safeParse(asset.mediaType).success
  );
}

export function acceptedAdvisoryDerivation(
  repos: Repositories,
  asset: EmbeddedAsset,
): VisualDerivation | null {
  return (
    repos.visualDerivations
      .listForAsset(asset.id)
      .filter(
        (candidate) =>
          candidate.materialId === asset.materialId &&
          candidate.materialRevisionId === asset.materialRevisionId &&
          candidate.assetByteHash === asset.byteHash &&
          candidate.contentOrigin === 'derived_visual_description' &&
          candidate.authority === 'derived' &&
          candidate.evidenceAdmissibility === 'advisory_nonblocking' &&
          candidate.validationStatus === 'accepted',
      )
      .at(-1) ?? null
  );
}

export function listAcceptedAdvisoryVisuals(
  repos: Repositories,
  materialId: string,
  materialRevisionId: string,
): AcceptedAdvisoryVisual[] {
  return repos.materialRevisions
    .getAssets(materialRevisionId)
    .filter(
      (asset) =>
        asset.materialId === materialId &&
        asset.materialRevisionId === materialRevisionId &&
        isEligibleOriginalVisual(asset),
    )
    .flatMap((asset) => {
      const derivation = acceptedAdvisoryDerivation(repos, asset);
      return derivation ? [{ asset, derivation }] : [];
    });
}

/** Keep accepted visual derivation identities bound to the execution route. */
export function visualAwareManifestFingerprint(
  repos: Repositories,
  revisions: ExecutionSourceManifest['revisions'],
): string {
  const acceptedVisuals = revisions.flatMap((revision) =>
    listAcceptedAdvisoryVisuals(repos, revision.materialId, revision.materialRevisionId),
  );
  return visualAwareManifestFingerprintFromAcceptedVisuals(revisions, acceptedVisuals);
}

/** Pure fingerprint projection for callers that already loaded the accepted visuals. */
export function visualAwareManifestFingerprintFromAcceptedVisuals(
  revisions: ExecutionSourceManifest['revisions'],
  acceptedVisuals: readonly AcceptedAdvisoryVisual[],
): string {
  const visualDerivationIdentityFingerprints = acceptedVisuals
    .map(({ derivation }) => derivation.identityFingerprint)
    .sort();
  const identity =
    visualDerivationIdentityFingerprints.length === 0
      ? revisions
      : { revisions, visualDerivationIdentityFingerprints };
  return `manifest_${fnv1a32(JSON.stringify(identity)).toString(16).padStart(8, '0')}`;
}

export function visualManifestMatchesCurrentDerivations(
  repos: Repositories,
  manifest: ExecutionSourceManifest,
): boolean {
  return visualAwareManifestFingerprint(repos, manifest.revisions) === manifest.fingerprint;
}
