import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';

/** Treat the configured address as an API base, never guess or append another /v1. */
export function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError('VALIDATION_ERROR', 'API 地址必须是有效的 URL。');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError(
      'VALIDATION_ERROR',
      'API 地址须使用 HTTPS（本机可用 HTTP），且不能包含凭据、查询参数或片段。',
    );
  url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/(?:chat\/completions|models)$/u, '');
  if (/\/chat\/completions(?:\/|$)/u.test(url.pathname))
    throw new AppError('VALIDATION_ERROR', 'API 地址中包含重复的 Chat Completions 路径。');
  return url.toString().replace(/\/+$/u, '');
}

export function apiEndpoint(baseUrl: string, operation: 'models' | 'chat/completions'): string {
  return `${normalizeApiBaseUrl(baseUrl)}/${operation}`;
}

/** Stable non-secret identity. Credentials never enter the hash or recorded cache key. */
export function endpointIdentity(baseUrl: string): string {
  return `endpoint:${createHash('sha256').update(normalizeApiBaseUrl(baseUrl)).digest('hex')}`;
}
