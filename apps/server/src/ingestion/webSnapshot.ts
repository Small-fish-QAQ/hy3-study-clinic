import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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

interface PinnedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
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

/**
 * Connect to the address already validated for this request. Passing the
 * numeric address to Node's core client avoids a second hostname resolution;
 * the original hostname remains the HTTP Host header and TLS SNI for virtual
 * hosting and certificate validation.
 */
function requestPinned(
  url: URL,
  address: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        host: address,
        port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          host: url.host,
          accept: 'text/html,application/xhtml+xml;q=0.9',
        },
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(', '));
        }
        resolve({
          status: response.statusCode ?? 0,
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          headers,
          body: response,
        });
      },
    );
    const onAbort = () => request.destroy(new Error('Web Snapshot request aborted.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error('Web Snapshot request timed out.')),
    );
    request.once('error', reject);
    request.once('close', () => signal?.removeEventListener('abort', onAbort));
    request.end();
  });
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
    let response: Response | PinnedResponse;
    try {
      if (isIP(current.hostname)) {
        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'text/html,application/xhtml+xml;q=0.9' },
        });
      } else {
        const addresses = await lookup(current.hostname, { all: true, verbatim: true })
          .then((rows) => rows.map((row) => row.address))
          .catch(() => []);
        if (!addresses.length || addresses.some(forbiddenIp)) {
          throw new IngestionError(
            ApiErrorCode.ValidationError,
            'Web Snapshot URL 解析到受限或不可验证的网络地址。',
          );
        }
        response = await requestPinned(current, addresses[0]!, options.signal, timeoutMs);
      }
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted)
        throw new IngestionError(ApiErrorCode.RequestCancelled, 'Web Snapshot 获取已取消。');
      throw new IngestionError(
        ApiErrorCode.ParseFailed,
        error instanceof Error && error.name === 'AbortError'
          ? 'Web Snapshot 获取超时。'
          : 'Web Snapshot 网络获取失败。',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirect === maxRedirects) {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        throw new IngestionError(ApiErrorCode.ParseFailed, 'Web Snapshot 重定向次数超过上限。');
      }
      const location = response.headers.get('location');
      if (!location) {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        throw new IngestionError(ApiErrorCode.ParseFailed, 'Web Snapshot 重定向缺少目标。');
      }
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      current = await validatePublicUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      throw new IngestionError(
        ApiErrorCode.ParseFailed,
        `Web Snapshot 返回 HTTP ${response.status}。`,
      );
    }
    const contentType =
      response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!['text/html', 'application/xhtml+xml'].includes(contentType)) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      throw new IngestionError(ApiErrorCode.TypeMismatch, 'Web Snapshot 响应不是 HTML。');
    }
    let bytes: Buffer;
    try {
      const body = response.body;
      if (!body && 'arrayBuffer' in response) {
        bytes = Buffer.from(await response.arrayBuffer());
      } else if (body && 'getReader' in body) {
        const reader = body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          const chunk = Buffer.from(part.value);
          total += chunk.length;
          if (total > HTML_MAX_BYTES) {
            await reader.cancel();
            throw new IngestionError(
              ApiErrorCode.SourceTooLarge,
              'Web Snapshot 响应超过字节上限。',
            );
          }
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks, total);
      } else {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const part of body ?? []) {
          const chunk = Buffer.from(part);
          total += chunk.length;
          if (total > HTML_MAX_BYTES) {
            throw new IngestionError(
              ApiErrorCode.SourceTooLarge,
              'Web Snapshot 响应超过字节上限。',
            );
          }
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks, total);
      }
    } catch (error) {
      if (options.signal?.aborted)
        throw new IngestionError(ApiErrorCode.RequestCancelled, 'Web Snapshot 获取已取消。');
      if (error instanceof IngestionError) throw error;
      throw new IngestionError(
        ApiErrorCode.ParseFailed,
        error instanceof Error && error.name === 'AbortError'
          ? 'Web Snapshot 获取超时。'
          : 'Web Snapshot 响应读取失败。',
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
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
