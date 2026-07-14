import { describe, expect, it } from 'vitest';
import { buildTestApp } from './testing/testApp.js';

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'hy3-study-clinic-server' });
    await app.close();
  });
});

describe('GET /api/config', () => {
  it('exposes only the provider name, never credentials', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'fake' });
    // Guard against leaking any credential-shaped fields.
    expect(res.body).not.toMatch(/api[_-]?key|baseurl|http/i);
    await app.close();
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
});
