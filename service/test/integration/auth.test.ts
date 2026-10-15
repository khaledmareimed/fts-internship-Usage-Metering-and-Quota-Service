import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp, TEST_ADMIN_KEY } from '../helpers/app.js';
import { createAccount, planIdByName } from '../helpers/fixtures.js';

describe('authentication', () => {
  let app: App;
  let db: Db;
  let apiKey: string;
  let accountId: string;
  const logs: string[] = [];

  beforeAll(async () => {
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    const built = await buildTestApp({ logLevel: 'info', logStream });
    app = built.app;
    db = built.dbHandle.db;
    ({ apiKey, accountId } = await createAccount(app, db));
  });

  afterAll(async () => {
    await app?.close();
  });

  const getAccount = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/account', headers });

  it('missing API key → 401 MISSING_API_KEY', async () => {
    const res = await getAccount({});
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_API_KEY');
  });

  it('wrong API key → 401 INVALID_API_KEY', async () => {
    const res = await getAccount({ 'x-api-key': `${apiKey.slice(0, -1)}x` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_API_KEY');
  });

  it('the admin key is not an API key', async () => {
    const res = await getAccount({ 'x-api-key': TEST_ADMIN_KEY });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_API_KEY');
  });

  it('auth is checked before body validation (401 wins over 400)', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/account', payload: { planId: 'not-a-uuid' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_API_KEY');
  });

  it('valid key works, and the key never appears in the logs', async () => {
    const res = await getAccount({ 'x-api-key': apiKey });
    expect(res.statusCode).toBe(200);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('')).not.toContain(apiKey);
    expect(logs.join('')).not.toContain(TEST_ADMIN_KEY);
  });

  it('inactive account → 403 ACCOUNT_INACTIVE', async () => {
    await db.execute(sql`UPDATE accounts SET is_active = false WHERE id = ${accountId}`);
    try {
      const res = await getAccount({ 'x-api-key': apiKey });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ACCOUNT_INACTIVE');
    } finally {
      await db.execute(sql`UPDATE accounts SET is_active = true WHERE id = ${accountId}`);
    }
  });

  describe('admin key on POST /v1/accounts', () => {
    const create = async (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers,
        payload: { name: 'Other Co', planId: await planIdByName(db, 'Starter') },
      });

    it('missing → 401 MISSING_ADMIN_KEY', async () => {
      const res = await create({});
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('MISSING_ADMIN_KEY');
    });

    it('wrong → 401 INVALID_ADMIN_KEY', async () => {
      const res = await create({ 'x-admin-key': `${TEST_ADMIN_KEY}x` });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_ADMIN_KEY');
    });

    it('a company API key is not the admin key', async () => {
      const res = await create({ 'x-api-key': apiKey });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('MISSING_ADMIN_KEY');
    });

    it('checked before body validation', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: {} });
      expect(res.statusCode).toBe(401);
    });
  });
});
