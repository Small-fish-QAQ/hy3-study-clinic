import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { ApiErrorCode, type WebSnapshotMetadata } from '@hy3-clinic/shared';
import { IngestionError } from './ingest.js';
import { HTML_MAX_BYTES, HTML_EXTRACTION_STRATEGY_VERSION } from './html.js';

export const WEB_SNAPSHOT_FETCH_POLICY_VERSION = 'public-http-snapshot-v1';
export const MAX_REDIRECTS = 4;
export const FETCH_TIMEOUT_MS = 15_000;

export interface WebSnapshotFetchOptions {
  signal?: AbortSignal;
  maxRedirects?: number;
  timeoutMs?: number;
}

export interface WebSnapshotFetchResult {
  bytes: Buffer;
  metadata: WebSnapshotMetadata;
}

function forbiddenIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      a >= 224 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && b === 18) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0)
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('ff')
    );
  }
  return true;
}

export async function validatePublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IngestionError(ApiErrorCode.ValidationError, 'Web Snapshot URL 无效。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new IngestionError(ApiErrorCode.ValidationError, '仅支持不带凭据的公开 HTTP(S) URL。');
  if (
    url.hostname.toLowerCase() === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local')
  )
    throw new IngestionError(ApiErrorCode.ValidationError, 'Web Snapshot 不允许访问本地主机。');
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : await lookup(url.hostname, { all: true, verbatim: true })
        .then((rows) => rows.map((row) => row.address))
        .catch(() => []);
  if (!addresses.length || addresses.some(forbiddenIp))
    throw new IngestionError(
      ApiErrorCode.ValidationError,
      'Web Snapshot URL 解析到受限或不可验证的网络地址。',
    );
  url.hash = '';
  return url;
}

export async function fetchWebSnapshot(
  rawUrl: string,
  options: WebSnapshotFetchOptions = {},
): Promise<WebSnapshotFetchResult> {
  let current = await validatePublicUrl(rawUrl);
  const requestedUrl = current.href;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9' },
      });
    } catch (error) {
      if (options.signal?.aborted)
        throw new IngestionError(ApiErrorCode.RequestCancelled, 'Web Snapshot 获取已取消。');
      throw new IngestionError(
        ApiErrorCode.ParseFailed,
        error instanceof Error && error.name === 'AbortError'
          ? 'Web Snapshot 获取超时。'
          : 'Web Snapshot 网络获取失败。',
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirect === maxRedirects)
        throw new IngestionError(ApiErrorCode.ParseFailed, 'Web Snapshot 重定向次数超过上限。');
      const location = response.headers.get('location');
      if (!location)
        throw new IngestionError(ApiErrorCode.ParseFailed, 'Web Snapshot 重定向缺少目标。');
      current = await validatePublicUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok)
      throw new IngestionError(
        ApiErrorCode.ParseFailed,
        `Web Snapshot 返回 HTTP ${response.status}。`,
      );
    const contentType =
      response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!['text/html', 'application/xhtml+xml'].includes(contentType))
      throw new IngestionError(ApiErrorCode.TypeMismatch, 'Web Snapshot 响应不是 HTML。');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > HTML_MAX_BYTES)
      throw new IngestionError(ApiErrorCode.SourceTooLarge, 'Web Snapshot 响应超过字节上限。');
    if (
      !/<(?:!doctype\s+html|html\b|body\b|main\b|article\b)/iu.test(
        bytes.subarray(0, 8192).toString('latin1'),
      )
    )
      throw new IngestionError(
        ApiErrorCode.TypeMismatch,
        '响应 Content-Type 为 HTML，但内容不像 HTML。',
      );
    return {
      bytes,
      metadata: {
        requestedUrl,
        normalizedUrl: requestedUrl,
        finalUrl: current.href,
        fetchedAt: new Date().toISOString(),
        responseContentType: contentType,
        responseByteHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        fetchPolicyVersion: WEB_SNAPSHOT_FETCH_POLICY_VERSION,
        extractionStrategyVersion: HTML_EXTRACTION_STRATEGY_VERSION,
      },
    };
  }
  throw new IngestionError(ApiErrorCode.ParseFailed, 'Web Snapshot 获取失败。');
}
