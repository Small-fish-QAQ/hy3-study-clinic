import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  ApiErrorCode,
  fnv1a32,
  NormalizedDocumentSchema,
  VisualTransportSchema,
  type MediaType,
  type NormalizedDocument,
  type VisualMediaType,
  type VisualTransport,
} from '@hy3-clinic/shared';
import { IngestionError } from './ingest.js';
import type { ExtractedEmbeddedAsset } from './richDocuments.js';

export const STANDALONE_IMAGE_PARSER_VERSION = 'standalone-image-sharp-v1';
export const VISUAL_TRANSPORT_PREPARATION_VERSION = `sharp-${sharp.versions.sharp}-vips-${sharp.versions.vips}-visual-transport-v1`;
export const IMAGE_MAX_PIXELS = 25_000_000;
export const IMAGE_MAX_DIMENSION = 16_384;
export const PROVIDER_IMAGE_MAX_DIMENSION = 2_048;
export const PROVIDER_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_DECODE_TIMEOUT_SECONDS = 10;

const mediaTypeByFormat: Record<string, VisualMediaType | undefined> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export interface ValidatedImage {
  mediaType: VisualMediaType;
  width: number;
  height: number;
  channels: number;
  orientation: number | null;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new IngestionError(ApiErrorCode.RequestCancelled, '图像处理已取消。');
  }
}

function imagePipeline(bytes: Buffer) {
  return sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: IMAGE_MAX_PIXELS,
    limitInputChannels: 4,
    unlimited: false,
    sequentialRead: true,
    animated: false,
  });
}

function imageMetadataPipeline(bytes: Buffer) {
  return sharp(bytes, {
    // Header inspection does not decode pixels. Local geometry checks run
    // before every bounded decode so oversized inputs get a stable error.
    limitInputPixels: false,
    limitInputChannels: 4,
    unlimited: false,
    sequentialRead: true,
    animated: false,
  });
}

/** Validate actual bytes, bounded decoded geometry, frames, and full decodability. */
export async function validateImageBytes(
  bytes: Buffer,
  expectedMediaType?: MediaType | null,
  signal?: AbortSignal,
): Promise<ValidatedImage> {
  throwIfCancelled(signal);
  try {
    const metadata = await imageMetadataPipeline(bytes).metadata();
    const mediaType = metadata.format ? mediaTypeByFormat[metadata.format] : undefined;
    if (!mediaType) {
      throw new IngestionError(
        ApiErrorCode.TypeMismatch,
        '图像内容不是受支持的 PNG、JPEG 或 WebP。',
      );
    }
    if (expectedMediaType && expectedMediaType !== mediaType) {
      throw new IngestionError(
        ApiErrorCode.TypeMismatch,
        `图像扩展名/MIME 与实际内容不匹配:${expectedMediaType} != ${mediaType}。`,
      );
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const channels = metadata.channels ?? 0;
    const pages = metadata.pages ?? 1;
    if (
      width <= 0 ||
      height <= 0 ||
      width > IMAGE_MAX_DIMENSION ||
      height > IMAGE_MAX_DIMENSION ||
      width * height > IMAGE_MAX_PIXELS ||
      channels <= 0 ||
      channels > 4
    ) {
      throw new IngestionError(ApiErrorCode.SourceTooLarge, '图像像素、尺寸或通道数超过安全上限。');
    }
    if (pages !== 1 || metadata.pageHeight) {
      throw new IngestionError(
        ApiErrorCode.UnsupportedFile,
        '暂不支持动画或多页图像,请上传单帧 PNG、JPEG 或 WebP。',
      );
    }

    // metadata() is header-oriented. Force one strict bounded decode so a
    // truncated/corrupt body cannot become an accepted original asset.
    await imagePipeline(bytes)
      .timeout({ seconds: IMAGE_DECODE_TIMEOUT_SECONDS })
      .autoOrient()
      .resize({ width: 1, height: 1, fit: 'fill' })
      .raw()
      .toBuffer();
    throwIfCancelled(signal);
    return {
      mediaType,
      width,
      height,
      channels,
      orientation: metadata.orientation ?? null,
    };
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError(
      ApiErrorCode.ParseFailed,
      '图像解码失败:文件可能已损坏、截断或超过安全资源上限。',
    );
  }
}

export async function parseStandaloneImage(
  bytes: Buffer,
  materialId: string,
  revisionId: string,
  expectedMediaType: MediaType | null,
  signal?: AbortSignal,
): Promise<{
  document: NormalizedDocument;
  assets: ExtractedEmbeddedAsset[];
  image: ValidatedImage;
}> {
  const image = await validateImageBytes(bytes, expectedMediaType, signal);
  const unitId = `unit_${fnv1a32(`${revisionId}:standalone-image`).toString(16).padStart(8, '0')}`;
  const byteHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const asset: ExtractedEmbeddedAsset = {
    id: `asset_${fnv1a32(`${revisionId}:standalone:${byteHash}`).toString(16).padStart(8, '0')}`,
    materialId,
    materialRevisionId: revisionId,
    index: 0,
    parentStructuralUnitId: unitId,
    sourcePath: 'original-image',
    mediaType: image.mediaType,
    byteHash,
    byteLength: bytes.length,
    width: image.width,
    height: image.height,
    location: { domPath: 'standalone:image' },
    relationshipKind: 'image',
    contentOrigin: 'extracted_original',
    parserVersion: STANDALONE_IMAGE_PARSER_VERSION,
    bytes: Buffer.from(bytes),
  };
  const { bytes: _assetBytes, ...assetWithoutBytes } = asset;
  const document = NormalizedDocumentSchema.parse({
    materialRevisionId: revisionId,
    sourceType: 'image',
    mediaType: image.mediaType,
    content: '',
    units: [
      {
        id: unitId,
        materialRevisionId: revisionId,
        parentUnitId: null,
        kind: 'image',
        index: 0,
        title: null,
        content: '',
        startOffset: 0,
        endOffset: 0,
        headingPath: [],
        location: { domPath: 'standalone:image' },
        contentOrigin: 'extracted_original',
        derivation: 'extracted_original',
      },
    ],
    capabilities: ['visual_asset', 'source_location_precision'],
    warnings: [],
    complete: true,
    parserVersion: STANDALONE_IMAGE_PARSER_VERSION,
    parserFingerprint: `parser_${fnv1a32(`${STANDALONE_IMAGE_PARSER_VERSION}:sharp-${sharp.versions.sharp}:vips-${sharp.versions.vips}`).toString(16).padStart(8, '0')}`,
    assets: [assetWithoutBytes],
  });
  return { document, assets: [asset], image };
}

function hash(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Prepare a bounded derivative for a visual provider without replacing source bytes. */
export async function prepareVisualTransport(
  bytes: Buffer,
  expectedMediaType: MediaType,
  signal?: AbortSignal,
): Promise<{ transport: VisualTransport; bytes: Buffer; source: ValidatedImage }> {
  const source = await validateImageBytes(bytes, expectedMediaType, signal);
  if (
    bytes.length <= PROVIDER_IMAGE_MAX_BYTES &&
    source.width <= PROVIDER_IMAGE_MAX_DIMENSION &&
    source.height <= PROVIDER_IMAGE_MAX_DIMENSION &&
    (source.orientation === null || source.orientation === 1)
  ) {
    return {
      source,
      bytes: Buffer.from(bytes),
      transport: VisualTransportSchema.parse({
        mediaType: source.mediaType,
        width: source.width,
        height: source.height,
        byteLength: bytes.length,
        transformation: 'validated_original',
        preparationVersion: VISUAL_TRANSPORT_PREPARATION_VERSION,
        fingerprint: hash(bytes),
      }),
    };
  }

  throwIfCancelled(signal);
  try {
    let pipeline = imagePipeline(bytes)
      .timeout({ seconds: IMAGE_DECODE_TIMEOUT_SECONDS })
      .autoOrient()
      .resize({
        width: PROVIDER_IMAGE_MAX_DIMENSION,
        height: PROVIDER_IMAGE_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColourspace('srgb');
    if (source.mediaType === 'image/png') {
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false });
    } else if (source.mediaType === 'image/webp') {
      pipeline = pipeline.webp({ quality: 85, lossless: false, smartSubsample: false });
    } else {
      pipeline = pipeline.jpeg({ quality: 85, chromaSubsampling: '4:4:4', progressive: false });
    }
    let result = await pipeline.toBuffer({ resolveWithObject: true });
    let mediaType = source.mediaType;
    if (result.data.length > PROVIDER_IMAGE_MAX_BYTES) {
      result = await imagePipeline(bytes)
        .timeout({ seconds: IMAGE_DECODE_TIMEOUT_SECONDS })
        .autoOrient()
        .resize({
          width: PROVIDER_IMAGE_MAX_DIMENSION,
          height: PROVIDER_IMAGE_MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' })
        .toColourspace('srgb')
        .jpeg({ quality: 78, chromaSubsampling: '4:4:4', progressive: false })
        .toBuffer({ resolveWithObject: true });
      mediaType = 'image/jpeg';
    }
    if (result.data.length > PROVIDER_IMAGE_MAX_BYTES) {
      throw new IngestionError(ApiErrorCode.SourceTooLarge, '规范化图像仍超过提供程序载荷上限。');
    }
    throwIfCancelled(signal);
    return {
      source,
      bytes: result.data,
      transport: VisualTransportSchema.parse({
        mediaType,
        width: result.info.width,
        height: result.info.height,
        byteLength: result.data.length,
        transformation: 'auto_orient_resize_transcode',
        preparationVersion: VISUAL_TRANSPORT_PREPARATION_VERSION,
        fingerprint: hash(result.data),
      }),
    };
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError(
      ApiErrorCode.ParseFailed,
      '图像规范化失败:文件无法在安全资源上限内处理。',
    );
  }
}
