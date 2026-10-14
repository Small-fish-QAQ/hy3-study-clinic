import { IngestionError } from './ingest.js';

export interface IngestionResources {
  fileBytes: number;
  textBytes: number;
}
const positive = (value: string | undefined, fallback: number) => {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('导入资源配置必须是正整数。');
  return parsed;
};
export function ingestionResources(env: NodeJS.ProcessEnv = process.env): IngestionResources {
  return {
    fileBytes: positive(env.IMPORT_FILE_BYTES, 10 * 1024 * 1024),
    textBytes: positive(env.IMPORT_TEXT_BYTES, 10 * 1024 * 1024),
  };
}
export function checkTextResources(content: string) {
  const cap = ingestionResources().textBytes;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > cap)
    throw new IngestionError(
      'SOURCE_TOO_LARGE',
      `正文为 ${bytes} 字节，超过 IMPORT_TEXT_BYTES=${cap} 的资源配置。请调整配置或拆分材料。`,
    );
}
