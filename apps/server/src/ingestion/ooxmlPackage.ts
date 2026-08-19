import { Buffer } from 'node:buffer';
import { ApiErrorCode } from '@hy3-clinic/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { IngestionError } from './ingest.js';

/** Office packages are source documents, so their archive surface stays deliberately small. */
export const OOXML_PACKAGE_LIMITS = {
  maxMembers: 1_000,
  maxMemberBytes: 20 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 1_000,
} as const;

export interface SafeOoxmlMember {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
}

export interface SafeOoxmlPackage {
  readonly members: readonly SafeOoxmlMember[];
  read(path: string): Promise<Buffer>;
  has(path: string): boolean;
}

function normalizedMemberPath(raw: string): string {
  const path = raw.replaceAll('\\', '/');
  const directory = path.endsWith('/');
  if (path.length === 0 || path.startsWith('/') || /^[A-Za-z]:\//u.test(path)) {
    throw new IngestionError(ApiErrorCode.ParseFailed, 'OOXML 包含绝对路径成员。');
  }
  const parts = (directory ? path.slice(0, -1) : path).split('/');
  if (parts.some((part) => part === '..' || part.length === 0 || part === '.')) {
    throw new IngestionError(ApiErrorCode.ParseFailed, 'OOXML 包含不安全的成员路径。');
  }
  return `${parts.join('/')}${directory ? '/' : ''}`;
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(new IngestionError(ApiErrorCode.ParseFailed, 'OOXML ZIP 中央目录无法读取。'));
        } else resolve(zipFile);
      },
    );
  });
}

function readEntry(zipFile: ZipFile, entry: Entry, totalBefore: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new IngestionError(ApiErrorCode.ParseFailed, `OOXML 成员无法解压:${entry.fileName}`),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let actual = 0;
      stream.on('data', (chunk: Buffer) => {
        actual += chunk.length;
        if (
          actual > OOXML_PACKAGE_LIMITS.maxMemberBytes ||
          totalBefore + actual > OOXML_PACKAGE_LIMITS.maxExpandedBytes
        ) {
          stream.destroy(
            new IngestionError(
              ApiErrorCode.SourceTooLarge,
              `OOXML 解压内容超过安全上限:${entry.fileName}`,
            ),
          );
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.once('error', (streamError) => reject(streamError));
      stream.once('end', () => {
        if (actual !== entry.uncompressedSize) {
          reject(
            new IngestionError(
              ApiErrorCode.ParseFailed,
              `OOXML 成员实际大小不匹配:${entry.fileName}`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(chunks, actual));
      });
    });
  });
}

/**
 * Load a package into bounded memory using lazy entry streams. No member is
 * written to disk, no relationship is fetched, and actual emitted bytes are
 * counted independently of attacker-controlled central-directory sizes.
 */
export async function openSafeOoxmlPackage(buffer: Buffer): Promise<SafeOoxmlPackage> {
  const zipFile = await openZip(buffer);
  if (zipFile.entryCount === 0) {
    zipFile.close();
    throw new IngestionError(ApiErrorCode.ParseFailed, 'OOXML ZIP 包不包含任何成员。');
  }
  if (zipFile.entryCount > OOXML_PACKAGE_LIMITS.maxMembers) {
    zipFile.close();
    throw new IngestionError(ApiErrorCode.SourceTooLarge, 'OOXML 包成员数量超过安全上限。');
  }
  const members: SafeOoxmlMember[] = [];
  const content = new Map<string, Buffer>();
  const seen = new Set<string>();
  let actualExpandedBytes = 0;
  let declaredExpandedBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(
          error instanceof IngestionError
            ? error
            : new IngestionError(ApiErrorCode.ParseFailed, 'OOXML ZIP 包读取失败。'),
        );
      };
      zipFile.on('error', fail);
      zipFile.on('entry', (entry: Entry) => {
        void (async () => {
          const path = normalizedMemberPath(entry.fileName);
          if (seen.has(path)) {
            throw new IngestionError(ApiErrorCode.ParseFailed, `OOXML 包含重复成员:${path}`);
          }
          seen.add(path);
          const encrypted = Boolean(entry.generalPurposeBitFlag & (0x1 | 0x40));
          if (encrypted)
            throw new IngestionError(ApiErrorCode.ParseFailed, '加密 OOXML 包不受支持。');
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
            throw new IngestionError(
              ApiErrorCode.ParseFailed,
              `OOXML 成员压缩方式不受支持:${path}`,
            );
          }
          if (entry.uncompressedSize > OOXML_PACKAGE_LIMITS.maxMemberBytes) {
            throw new IngestionError(ApiErrorCode.SourceTooLarge, `OOXML 成员超过大小上限:${path}`);
          }
          if (entry.uncompressedSize > 0 && entry.compressedSize === 0) {
            throw new IngestionError(ApiErrorCode.ParseFailed, `OOXML 成员压缩大小无效:${path}`);
          }
          if (
            entry.compressedSize > 0 &&
            entry.uncompressedSize / entry.compressedSize > OOXML_PACKAGE_LIMITS.maxCompressionRatio
          ) {
            throw new IngestionError(ApiErrorCode.SourceTooLarge, `OOXML 成员压缩比异常:${path}`);
          }
          if (
            declaredExpandedBytes + entry.uncompressedSize >
            OOXML_PACKAGE_LIMITS.maxExpandedBytes
          ) {
            throw new IngestionError(ApiErrorCode.SourceTooLarge, 'OOXML 解压总大小超过安全上限。');
          }
          if (path.endsWith('/') && entry.uncompressedSize !== 0) {
            throw new IngestionError(
              ApiErrorCode.ParseFailed,
              `OOXML 目录成员包含无效内容大小:${path}`,
            );
          }
          declaredExpandedBytes += entry.uncompressedSize;
          members.push({
            path,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
            encrypted: false,
          });
          if (!path.endsWith('/')) {
            const bytes = await readEntry(zipFile, entry, actualExpandedBytes);
            actualExpandedBytes += bytes.length;
            content.set(path, bytes);
          }
          zipFile.readEntry();
        })().catch(fail);
      });
      zipFile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }

  return {
    members,
    has(path: string): boolean {
      return content.has(path);
    },
    async read(path: string): Promise<Buffer> {
      const bytes = content.get(path);
      if (!bytes) {
        throw new IngestionError(ApiErrorCode.ParseFailed, `OOXML 成员不存在:${path}`);
      }
      return Buffer.from(bytes);
    },
  };
}

export function resolveOoxmlTarget(sourcePath: string, target: string): string | null {
  if (
    !target ||
    target.startsWith('#') ||
    target.includes('?') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target)
  ) {
    return null;
  }
  const absolute = target.startsWith('/');
  const base = absolute ? '' : sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
  const combined = `${base}${absolute ? target.slice(1) : target}`.replaceAll('\\', '/');
  const parts: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}
