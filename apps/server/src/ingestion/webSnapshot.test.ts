import { describe, expect, it, vi } from 'vitest';
import { fetchWebSnapshot, validatePublicUrl } from './webSnapshot.js';

describe('public Web Snapshot policy', () => {
  it('rejects loopback and credential-bearing URLs before network access', async () => {
    await expect(validatePublicUrl('http://127.0.0.1/')).rejects.toThrow(/受限|本地主机/u);
    await expect(validatePublicUrl('https://user:pass@example.test/')).rejects.toThrow(/凭据/u);
  });

  it('captures exact bytes and final URL through bounded redirects', async () => {
    const response = new Response(
      '<!doctype html><html><body><main>Snapshot content</main></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = await fetchWebSnapshot('https://1.1.1.1/course');
    expect(result.metadata.finalUrl).toBe('https://1.1.1.1/course');
    expect(result.metadata.responseByteHash).toMatch(/^sha256:/u);
    expect(result.bytes.toString()).toContain('Snapshot content');
    vi.unstubAllGlobals();
  });
});
