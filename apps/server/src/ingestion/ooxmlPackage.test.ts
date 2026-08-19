import { ApiErrorCode } from '@hy3-clinic/shared';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { OOXML_PACKAGE_LIMITS, openSafeOoxmlPackage, resolveOoxmlTarget } from './ooxmlPackage.js';

interface SyntheticZipMember {
  path: string;
  content?: string | Buffer;
  compressionMethod?: 0 | 8;
  compressedContent?: Buffer;
  uncompressedSize?: number;
  checksum?: number;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal, valid, stored ZIP. Mutations below alter only attacker-controlled metadata. */
function syntheticZip(members: SyntheticZipMember[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const member of members) {
    const name = Buffer.from(member.path, 'utf8');
    const content = Buffer.isBuffer(member.content)
      ? member.content
      : Buffer.from(member.content ?? '', 'utf8');
    const compressedContent = member.compressedContent ?? content;
    const uncompressedSize = member.uncompressedSize ?? content.length;
    const checksum = member.checksum ?? crc32(content);
    const compressionMethod = member.compressionMethod ?? 0;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedContent.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localRecords.push(localHeader, name, compressedContent);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedContent.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressedContent.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

function findEocd(archive: Buffer): number {
  const offset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (offset < 0) throw new Error('synthetic ZIP has no EOCD');
  return offset;
}

function centralOffsets(archive: Buffer): number[] {
  const eocd = findEocd(archive);
  const count = archive.readUInt16LE(eocd + 10);
  const offsets: number[] = [];
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('synthetic ZIP central directory is corrupt');
    }
    offsets.push(cursor);
    cursor +=
      46 +
      archive.readUInt16LE(cursor + 28) +
      archive.readUInt16LE(cursor + 30) +
      archive.readUInt16LE(cursor + 32);
  }
  return offsets;
}

function mutateCentral(
  archive: Buffer,
  index: number,
  mutate: (copy: Buffer, offset: number) => void,
): Buffer {
  const copy = Buffer.from(archive);
  const offset = centralOffsets(copy)[index];
  if (offset === undefined) throw new Error(`missing central entry ${index}`);
  mutate(copy, offset);
  return copy;
}

function replaceCentralName(archive: Buffer, index: number, path: string): Buffer {
  return mutateCentral(archive, index, (copy, offset) => {
    const currentLength = copy.readUInt16LE(offset + 28);
    const replacement = Buffer.from(path, 'utf8');
    if (replacement.length !== currentLength) throw new Error('replacement path length changed');
    replacement.copy(copy, offset + 46);
  });
}

describe('openSafeOoxmlPackage', () => {
  it('reads valid members into bounded memory and returns defensive copies', async () => {
    const archive = syntheticZip([
      { path: '[Content_Types].xml', content: '<Types />' },
      { path: 'ppt/slides/slide1.xml', content: '<slide>one</slide>' },
    ]);
    const packageFile = await openSafeOoxmlPackage(archive);

    expect(packageFile.members.map((member) => member.path)).toEqual([
      '[Content_Types].xml',
      'ppt/slides/slide1.xml',
    ]);
    expect(packageFile.has('ppt/slides/slide1.xml')).toBe(true);
    expect(packageFile.has('ppt/slides/missing.xml')).toBe(false);
    const first = await packageFile.read('ppt/slides/slide1.xml');
    first.fill(0);
    expect((await packageFile.read('ppt/slides/slide1.xml')).toString('utf8')).toBe(
      '<slide>one</slide>',
    );
    await expect(packageFile.read('ppt/slides/missing.xml')).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });

  it('rejects traversal and duplicate normalized member paths', async () => {
    const traversal = replaceCentralName(
      syntheticZip([{ path: 'safe/file.xml', content: 'x' }]),
      0,
      '../escape.xml',
    );
    await expect(openSafeOoxmlPackage(traversal)).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });

    const duplicate = replaceCentralName(
      syntheticZip([
        { path: 'safe/one.xml', content: 'one' },
        { path: 'safe/two.xml', content: 'two' },
      ]),
      1,
      'safe\\one.xml',
    );
    await expect(openSafeOoxmlPackage(duplicate)).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });

  it('rejects excessive member counts before reading entries', async () => {
    const archive = syntheticZip([{ path: 'word/document.xml', content: '<document />' }]);
    const copy = Buffer.from(archive);
    const eocd = findEocd(copy);
    copy.writeUInt16LE(OOXML_PACKAGE_LIMITS.maxMembers + 1, eocd + 8);
    copy.writeUInt16LE(OOXML_PACKAGE_LIMITS.maxMembers + 1, eocd + 10);

    await expect(openSafeOoxmlPackage(copy)).rejects.toMatchObject({
      code: ApiErrorCode.SourceTooLarge,
    });
  });

  it('rejects a member whose declared expanded size exceeds the ceiling', async () => {
    const oversizedMember = mutateCentral(
      syntheticZip([{ path: 'word/document.xml', content: 'x' }]),
      0,
      (copy, offset) => {
        // Deflate entries may legitimately have different compressed and expanded sizes.
        copy.writeUInt16LE(8, offset + 10);
        copy.writeUInt32LE(OOXML_PACKAGE_LIMITS.maxMemberBytes + 1, offset + 24);
      },
    );
    await expect(openSafeOoxmlPackage(oversizedMember)).rejects.toMatchObject({
      code: ApiErrorCode.SourceTooLarge,
    });
  });

  it('rejects an aggregate declared expanded size above the package ceiling', async () => {
    const uncompressedSize = Math.floor(OOXML_PACKAGE_LIMITS.maxExpandedBytes / 6) + 1;
    const expanded = Buffer.alloc(uncompressedSize);
    const deflated = deflateRawSync(expanded);
    const minimumCompressedSize = Math.ceil(
      uncompressedSize / OOXML_PACKAGE_LIMITS.maxCompressionRatio,
    );
    const compressed = Buffer.concat([
      deflated,
      Buffer.alloc(Math.max(0, minimumCompressedSize - deflated.length)),
    ]);
    const checksum = crc32(expanded);
    const aggregate = syntheticZip(
      Array.from({ length: 6 }, (_, index) => ({
        path: `part-${index}.xml`,
        compressionMethod: 8 as const,
        compressedContent: compressed,
        uncompressedSize,
        checksum,
      })),
    );
    await expect(openSafeOoxmlPackage(aggregate)).rejects.toMatchObject({
      code: ApiErrorCode.SourceTooLarge,
    });
  });

  it('rejects an excessive declared compression ratio', async () => {
    const highRatio = mutateCentral(
      syntheticZip([{ path: 'word/document.xml', content: 'x' }]),
      0,
      (copy, offset) => {
        copy.writeUInt16LE(8, offset + 10);
        copy.writeUInt32LE(1, offset + 20);
        copy.writeUInt32LE(OOXML_PACKAGE_LIMITS.maxCompressionRatio + 1, offset + 24);
      },
    );
    await expect(openSafeOoxmlPackage(highRatio)).rejects.toMatchObject({
      code: ApiErrorCode.SourceTooLarge,
    });
  });

  it('rejects impossible sizes, encryption flags, and unsupported compression', async () => {
    const base = syntheticZip([{ path: 'word/document.xml', content: 'x' }]);
    const zeroCompressed = mutateCentral(base, 0, (copy, offset) => {
      copy.writeUInt32LE(0, offset + 20);
    });
    await expect(openSafeOoxmlPackage(zeroCompressed)).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });

    for (const flag of [0x1, 0x40]) {
      const encrypted = mutateCentral(base, 0, (copy, offset) => {
        copy.writeUInt16LE(flag, offset + 8);
      });
      await expect(openSafeOoxmlPackage(encrypted)).rejects.toMatchObject({
        code: ApiErrorCode.ParseFailed,
      });
    }

    const unsupported = mutateCentral(base, 0, (copy, offset) => {
      copy.writeUInt16LE(99, offset + 10);
    });
    await expect(openSafeOoxmlPackage(unsupported)).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });

  it('rejects malformed archives and does not trust a trailing false EOCD', async () => {
    await expect(openSafeOoxmlPackage(Buffer.from('not a ZIP'))).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
    const valid = syntheticZip([{ path: 'word/document.xml', content: '<document />' }]);
    await expect(openSafeOoxmlPackage(valid.subarray(0, valid.length - 10))).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });

    const falseEocd = Buffer.alloc(22);
    falseEocd.writeUInt32LE(0x06054b50, 0);
    await expect(openSafeOoxmlPackage(Buffer.concat([valid, falseEocd]))).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });

  it('rejects a member whose streamed bytes disagree with its declared size', async () => {
    const mismatched = mutateCentral(
      syntheticZip([{ path: 'word/document.xml', content: 'payload' }]),
      0,
      (copy, offset) => copy.writeUInt32LE(1, offset + 24),
    );
    await expect(openSafeOoxmlPackage(mismatched)).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });
});

describe('resolveOoxmlTarget', () => {
  it('resolves internal relationships without allowing escape or remote fetch targets', () => {
    expect(resolveOoxmlTarget('ppt/slides/slide1.xml', '../media/image1.png')).toBe(
      'ppt/media/image1.png',
    );
    expect(resolveOoxmlTarget('ppt/slides/slide1.xml', '/ppt/media/image1.png')).toBe(
      'ppt/media/image1.png',
    );
    expect(resolveOoxmlTarget('ppt/slides/slide1.xml', '../../../escape.xml')).toBeNull();
    expect(
      resolveOoxmlTarget('ppt/slides/slide1.xml', 'https://example.test/image.png'),
    ).toBeNull();
    expect(resolveOoxmlTarget('ppt/slides/slide1.xml', 'file:///tmp/image.png')).toBeNull();
    expect(resolveOoxmlTarget('ppt/slides/slide1.xml', '#bookmark')).toBeNull();
    expect(resolveOoxmlTarget('ppt/slides/slide1.xml', '../media/image.png?remote=1')).toBeNull();
  });
});
