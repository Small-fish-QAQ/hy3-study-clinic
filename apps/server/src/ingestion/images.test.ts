import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { IngestionError } from './ingest.js';
import { parseStandaloneImage, prepareVisualTransport, validateImageBytes } from './images.js';

async function makeImage(format: 'png' | 'jpeg' | 'webp', width = 8, height = 6) {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: '#4f86c6' },
  });
  return pipeline[format]().toBuffer();
}

describe('bounded visual ingestion', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'validates %s and preserves exact standalone bytes',
    async (format) => {
      const bytes = await makeImage(format);
      const validated = await validateImageBytes(
        bytes,
        `image/${format === 'jpeg' ? 'jpeg' : format}`,
      );
      expect(validated.width).toBe(8);
      expect(validated.height).toBe(6);
      const parsed = await parseStandaloneImage(
        bytes,
        'mat_image',
        'mat_image:candidate',
        validated.mediaType,
      );
      expect(parsed.document.content).toBe('');
      expect(parsed.assets[0]!.byteLength).toBe(bytes.length);
      expect(parsed.assets[0]!.contentOrigin).toBe('extracted_original');
      expect(parsed.assets[0]!.bytes).toEqual(bytes);
    },
  );

  it('rejects MIME/signature mismatch and malformed bytes', async () => {
    await expect(validateImageBytes(await makeImage('png'), 'image/jpeg')).rejects.toMatchObject({
      code: ApiErrorCode.TypeMismatch,
    });
    await expect(
      validateImageBytes(Buffer.from('not-an-image'), 'image/png'),
    ).rejects.toBeInstanceOf(IngestionError);
  });

  it('rejects animated accepted-format images and oversized decoded geometry', async () => {
    const animatedWebp = Buffer.from(
      'UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAAJWUDhMDwAAAC8BQAAABxDtj/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAABWUDhMDwAAAC8BQAAABxBR//4HIqL/AQA=',
      'base64',
    );
    await expect(validateImageBytes(animatedWebp, 'image/webp')).rejects.toMatchObject({
      code: ApiErrorCode.UnsupportedFile,
    });

    await expect(
      validateImageBytes(await makeImage('png', 16_385, 1), 'image/png'),
    ).rejects.toMatchObject({ code: ApiErrorCode.SourceTooLarge });
    await expect(
      validateImageBytes(await makeImage('png', 5_001, 5_000), 'image/png'),
    ).rejects.toMatchObject({ code: ApiErrorCode.SourceTooLarge });
  });

  it('normalizes oversized transport while leaving source bytes untouched', async () => {
    const bytes = await makeImage('png', 3000, 1000);
    const prepared = await prepareVisualTransport(bytes, 'image/png');
    expect(prepared.transport.transformation).toBe('auto_orient_resize_transcode');
    expect(prepared.transport.width).toBeLessThanOrEqual(2048);
    expect(prepared.transport.height).toBeLessThanOrEqual(2048);
    expect(prepared.source.width).toBe(3000);
    expect(prepared.bytes).not.toEqual(bytes);
  });
});
