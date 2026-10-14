import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { createDb } from '../../src/db/client.js';
import { buildTestApp, TEST_ADMIN_KEY } from '../helpers/app.js';

describe('GET /health', () => {
  const apps: App[] = [];

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('reports ok when the database is reachable', async () => {
    const { app } = await buildTestApp();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('reports 503 when the database is down', async () => {
    // Port 1 has nothing listening, so every connection is refused.
    const unreachable = createDb('postgres://nobody:nothing@127.0.0.1:1/none', { poolMax: 1 });
    const app = buildApp({ dbHandle: unreachable, logLevel: 'silent', adminKey: TEST_ADMIN_KEY });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', database: 'down' });
  });
});
