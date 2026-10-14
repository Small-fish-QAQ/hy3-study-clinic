import { describe, expect, it } from 'vitest';
import { apiEndpoint, endpointIdentity, normalizeApiBaseUrl } from './compatibleEndpoint.js';

describe('compatible API endpoint normalization', () => {
  it.each([
    'https://upstream.test/v1',
    'https://upstream.test/v1/',
    'https://upstream.test/v1///',
    'https://upstream.test/v1/chat/completions/',
    'https://upstream.test/v1/models',
  ])('normalizes %s without doubling a path', (base) => {
    expect(normalizeApiBaseUrl(base)).toBe('https://upstream.test/v1');
    expect(apiEndpoint(base, 'chat/completions')).toBe('https://upstream.test/v1/chat/completions');
    expect(apiEndpoint(base, 'models')).toBe('https://upstream.test/v1/models');
    expect(endpointIdentity(base)).toBe(endpointIdentity('https://upstream.test/v1'));
  });
  it('retains custom version prefixes and isolates hosts and paths', () => {
    expect(apiEndpoint('https://upstream.test/api/coding/v2', 'models')).toBe(
      'https://upstream.test/api/coding/v2/models',
    );
    expect(endpointIdentity('https://a.test/v1')).not.toBe(endpointIdentity('https://b.test/v1'));
    expect(endpointIdentity('https://a.test/v1')).not.toBe(endpointIdentity('https://a.test/v2'));
  });
  it.each([
    'invalid',
    'ftp://upstream.test',
    'http://upstream.test/v1',
    'https://key:secret@upstream.test',
    'https://upstream.test?key=secret',
    'https://upstream.test#secret',
    'https://upstream.test/v1/chat/completions/chat/completions',
  ])('rejects unsafe or duplicated addresses: %s', (url) => {
    expect(() => normalizeApiBaseUrl(url)).toThrow();
  });
  it.each(['http://127.0.0.1:7777/v1', 'http://localhost:7777/v1', 'http://[::1]:7777/v1'])(
    'accepts loopback development HTTP: %s',
    (url) => {
      expect(normalizeApiBaseUrl(url)).toBe(url);
    },
  );
});
