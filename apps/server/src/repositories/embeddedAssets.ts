import { createHash } from 'node:crypto';
import type { EmbeddedAsset } from '@hy3-clinic/shared';

export interface EmbeddedAssetBytes extends EmbeddedAsset {
  bytes: Buffer;
}

export function assertEmbeddedAssetBytes(asset: EmbeddedAssetBytes): void {
  if (asset.bytes.length !== asset.byteLength) {
    throw new Error(`Embedded asset byte length mismatch: ${asset.id}`);
  }
  const actualHash = `sha256:${createHash('sha256').update(asset.bytes).digest('hex')}`;
  if (actualHash !== asset.byteHash) {
    throw new Error(`Embedded asset byte hash mismatch: ${asset.id}`);
  }
}
