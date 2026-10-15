import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { hashApiKey } from '../../src/auth/apiKey.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp, TEST_ADMIN_KEY } from '../helpers/app.js';
import {
  createAccount,
  currentMonth,
  insertAccountUsage,
  createPlan,
  planIdByName,
  setPlanActive,
} from '../helpers/fixtures.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PAST = '2020-01';

describe('accounts', () => {
  let app: App;
  let db: Db;

  beforeAll(async () => {
    const built = await buildTestApp();
    app = built.app;
    db = built.dbHandle.db;
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = (payload: object) =>
    app.inject({ method: 'POST', url: '/v1/accounts', headers: { 'x-admin-key': TEST_ADMIN_KEY }, payload });
  const get = (apiKey: string, query = '') =>
    app.inject({ method: 'GET', url: `/v1/account${query}`, headers: { 'x-api-key': apiKey } });
  const patch = (apiKey: string, planId: string) =>
    app.inject({ method: 'PATCH', url: '/v1/account', headers: { 'x-api-key': apiKey }, payload: { planId } });

  describe('POST /v1/accounts', () => {
    it('creates the account and returns the key once; only its hash is stored', async () => {
      const starterId = await planIdByName(db, 'Starter');
      const res = await post({ name: 'Acme Docs', planId: starterId });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toEqual({
        accountId: expect.any(String),
        name: 'Acme Docs',
        apiKey: expect.stringMatching(/^mk_[A-Za-z0-9_-]{43}$/),
        plan: {
          planId: starterId,
          name: 'Starter',
          type: 'account',
          monthlyLimit: 10_000,
          perRequestLimit: 100,
          rateLimitPerMinute: null,
          predefined: true,
          isActive: true,
          createdAt: expect.stringMatching(ISO),
          updatedAt: expect.stringMatching(ISO),
        },
        createdAt: expect.stringMatching(ISO),
      });

      const { rows } = await db.execute(sql`SELECT * FROM accounts WHERE id = ${body.accountId}`);
      expect(rows[0]).toMatchObject({ api_key_hash: hashApiKey(body.apiKey) });
      expect(JSON.stringify(rows)).not.toContain(body.apiKey);

      // Shown only at creation: reading the account never returns it.
      expect((await get(body.apiKey)).body).not.toContain(body.apiKey);
    });

    it.each([
      ['empty name', { name: '' }],
      ['name over 100 chars', { name: 'x'.repeat(101) }],
      ['bad planId', { planId: 'nope' }],
    ])('%s → 400 VALIDATION_ERROR', async (_label, override) => {
      const res = await post({ name: 'Acme', planId: await planIdByName(db, 'Starter'), ...override });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('a user-type plan → 400 PLAN_TYPE_MISMATCH', async () => {
      const res = await post({ name: 'Acme', planId: await planIdByName(db, 'Basic') });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('PLAN_TYPE_MISMATCH');
    });

    it('an unknown body field → 400 VALIDATION_ERROR', async () => {
      const res = await post({ name: 'Acme', planId: await planIdByName(db, 'Starter'), isActive: false });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('an unknown plan → 404 PLAN_NOT_FOUND', async () => {
      const res = await post({ name: 'Acme', planId: randomUUID() });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('PLAN_NOT_FOUND');
    });

    it("another company's custom plan → 404 PLAN_NOT_FOUND", async () => {
      const other = await createAccount(app, db, 'Starter', 'Other Co');
      const planId = await createPlan(app, other.apiKey, {
        name: 'Big', type: 'account', monthlyLimit: 500, perRequestLimit: 50,
      });
      const res = await post({ name: 'Acme', planId });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /v1/account', () => {
    it('returns the plan and zero usage for the current month', async () => {
      const { accountId, apiKey } = await createAccount(app, db);
      const res = await get(apiKey);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        accountId,
        name: 'Acme Docs',
        isActive: true,
        plan: { name: 'Starter', monthlyLimit: 10_000 },
        usage: { month: await currentMonth(db), used: 0, remaining: 10_000, acceptedCount: 0, rejectedCount: 0 },
      });
    });

    it('current month uses the live plan limit', async () => {
      const { accountId, apiKey } = await createAccount(app, db);
      await insertAccountUsage(db, accountId, await currentMonth(db), {
        used: 800, monthlyLimit: 999, acceptedCount: 40, rejectedCount: 3,
      });
      const res = await get(apiKey);
      expect(res.json().usage).toEqual({
        month: await currentMonth(db), used: 800, remaining: 9_200, acceptedCount: 40, rejectedCount: 3,
      });
    });

    it('a past month uses the limit stored on its usage row', async () => {
      const { accountId, apiKey } = await createAccount(app, db);
      await insertAccountUsage(db, accountId, PAST, { used: 800, monthlyLimit: 1_000, acceptedCount: 5 });
      const res = await get(apiKey, `?month=${PAST}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().usage).toEqual({ month: PAST, used: 800, remaining: 200, acceptedCount: 5, rejectedCount: 0 });
    });

    it('remaining is never negative', async () => {
      const { accountId, apiKey } = await createAccount(app, db);
      await insertAccountUsage(db, accountId, PAST, { used: 1_200, monthlyLimit: 1_000 });
      expect((await get(apiKey, `?month=${PAST}`)).json().usage.remaining).toBe(0);
    });

    it('a past month with no usage row reports zero usage and the live limit', async () => {
      const { apiKey } = await createAccount(app, db);
      const res = await get(apiKey, `?month=${PAST}`);
      expect(res.json().usage).toEqual({ month: PAST, used: 0, remaining: 10_000, acceptedCount: 0, rejectedCount: 0 });
    });

    it.each(['2999-01', '2026-13', '2026-1'])('month=%s → 400 VALIDATION_ERROR', async (month) => {
      const { apiKey } = await createAccount(app, db);
      const res = await get(apiKey, `?month=${month}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it("never returns another company's data", async () => {
      const a = await createAccount(app, db, 'Starter', 'Company A');
      const b = await createAccount(app, db, 'Pro', 'Company B');
      await insertAccountUsage(db, b.accountId, PAST, { used: 77, monthlyLimit: 100_000 });
      const res = (await get(a.apiKey, `?month=${PAST}`)).json();
      expect(res).toMatchObject({ accountId: a.accountId, name: 'Company A', plan: { name: 'Starter' } });
      expect(res.usage.used).toBe(0);
    });
  });

  describe('PATCH /v1/account', () => {
    it('switches plan and keeps usage (no fresh allowance)', async () => {
      const { accountId, apiKey } = await createAccount(app, db);
      await insertAccountUsage(db, accountId, await currentMonth(db), { used: 9_000, monthlyLimit: 10_000 });
      const res = await patch(apiKey, await planIdByName(db, 'Pro'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ plan: { name: 'Pro' }, usage: { used: 9_000, remaining: 91_000 } });
      expect((await get(apiKey)).json().plan.name).toBe('Pro');
    });

    it('a user-type plan → 400 PLAN_TYPE_MISMATCH', async () => {
      const { apiKey } = await createAccount(app, db);
      const res = await patch(apiKey, await planIdByName(db, 'Premium'));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('PLAN_TYPE_MISMATCH');
    });

    it('an unknown plan → 404 PLAN_NOT_FOUND', async () => {
      const { apiKey } = await createAccount(app, db);
      const res = await patch(apiKey, randomUUID());
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('PLAN_NOT_FOUND');
    });

    it("another company's custom plan → 404 PLAN_NOT_FOUND", async () => {
      const { apiKey } = await createAccount(app, db);
      const other = await createAccount(app, db, 'Starter', 'Other Co');
      const planId = await createPlan(app, other.apiKey, {
        name: 'Theirs', type: 'account', monthlyLimit: 500, perRequestLimit: 50,
      });
      const res = await patch(apiKey, planId);
      expect(res.statusCode).toBe(404);
    });

    it('its own inactive custom plan → 409 PLAN_INACTIVE; active one → 200', async () => {
      const { apiKey } = await createAccount(app, db);
      const inactive = await createPlan(app, apiKey, {
        name: 'Old', type: 'account', monthlyLimit: 500, perRequestLimit: 50,
      });
      expect((await setPlanActive(app, apiKey, inactive, false)).statusCode).toBe(200);
      const active = await createPlan(app, apiKey, {
        name: 'Demo Team', type: 'account', monthlyLimit: 100, perRequestLimit: 60,
      });

      const rejected = await patch(apiKey, inactive);
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().error.code).toBe('PLAN_INACTIVE');

      const ok = await patch(apiKey, active);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().plan).toMatchObject({ name: 'Demo Team', predefined: false, monthlyLimit: 100 });
    });
  });
});
