import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { App } from '../../src/app.js';
import { AppError } from '../../src/errors.js';
import { buildTestApp } from '../helpers/app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('app core', () => {
  let app: App;

  beforeAll(async () => {
    ({ app } = await buildTestApp());
    // Test-only routes that trigger each error path.
    app.post('/test/validate', { schema: { body: z.object({ units: z.int().min(1) }) } }, async () => ({ ok: true }));
    app.get('/test/app-error', async () => {
      throw new AppError('USER_NOT_FOUND', "User 'ali-123' not found in this account", { userId: 'ali-123' });
    });
    app.get('/test/crash', async () => {
      throw new Error('secret connection string');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('unknown route → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /nope not found', details: {} },
    });
  });

  it('schema validation failure → 400 VALIDATION_ERROR with issues', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/validate', payload: { units: 0 } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.issues).toEqual([{ path: 'body.units', message: expect.any(String) }]);
  });

  it('malformed JSON → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"units":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('AppError → its status, code, message and details', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/app-error' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 'USER_NOT_FOUND',
        message: "User 'ali-123' not found in this account",
        details: { userId: 'ali-123' },
      },
    });
  });

  it('unexpected error → 500 INTERNAL_ERROR without leaking the message or stack', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} },
    });
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain('at ');
  });

  it('every response carries an x-request-id', async () => {
    const ok = await app.inject({ method: 'GET', url: '/health' });
    const notFound = await app.inject({ method: 'GET', url: '/nope' });
    expect(ok.headers['x-request-id']).toMatch(UUID);
    expect(notFound.headers['x-request-id']).toMatch(UUID);
    expect(ok.headers['x-request-id']).not.toBe(notFound.headers['x-request-id']);
  });

  it('serves the OpenAPI document and Swagger UI at /docs', async () => {
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().paths).toHaveProperty('/health');
    expect(spec.json().components.securitySchemes).toHaveProperty('apiKey');

    const ui = await app.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
  });
});
