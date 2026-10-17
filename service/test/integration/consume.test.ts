import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp } from '../helpers/app.js';
import { consume, consumeOk, expectExactTotals } from '../helpers/consume.js';
import { createAccount, createPlan, createUser, currentMonth, planIdByName } from '../helpers/fixtures.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
let seq = 0;
const rid = () => `req-${++seq}`;

describe('POST /v1/consume', () => {
  let app: App;
  let db: Db;

  beforeAll(async () => {
    ({ app, dbHandle: { db } } = await buildTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  /** The brief's setup: account on Starter (10,000/100), user ali-123 on Basic (1,000/20). */
  async function briefSetup() {
    const account = await createAccount(app, db, 'Starter');
    await createUser(app, account.apiKey, 'ali-123', await planIdByName(db, 'Basic'));
    return account;
  }

  const usage = async (apiKey: string) => {
    const account = await app.inject({ method: 'GET', url: '/v1/account', headers: { 'x-api-key': apiKey } });
    const user = await app.inject({ method: 'GET', url: '/v1/users/ali-123', headers: { 'x-api-key': apiKey } });
    return { account: account.json().usage, user: user.json().usage };
  };

  describe("the brief's examples", () => {
    it('25 units → rejected on the user per-request limit; nothing consumed, but recorded', async () => {
      const { accountId, apiKey } = await briefSetup();
      const res = await consumeOk(app, apiKey, { requestId: 'doc-7782', userId: 'ali-123', units: 25 });

      expect(res).toEqual({
        requestId: 'doc-7782',
        accepted: false,
        units: 25,
        failedRules: [{ scope: 'user', rule: 'per_request_limit', limit: 20, requested: 25 }],
        month: await currentMonth(db),
        account: { used: 0, remaining: 10_000, monthlyLimit: 10_000, perRequestLimit: 100 },
        user: { userId: 'ali-123', used: 0, remaining: 1_000, monthlyLimit: 1_000, perRequestLimit: 20 },
        replayed: false,
        decidedAt: expect.stringMatching(ISO),
      });
      expect(await usage(apiKey)).toMatchObject({
        account: { used: 0, rejectedCount: 1 },
        user: { used: 0, rejectedCount: 1 },
      });
      const { rows } = await db.execute(sql`SELECT accepted FROM requests WHERE request_id = 'doc-7782'`);
      expect(rows).toEqual([{ accepted: false }]);
      await expectExactTotals(db, accountId);
    });

    it('10 units → accepted; user +10 and account +10', async () => {
      const { accountId, apiKey } = await briefSetup();
      const res = await consumeOk(app, apiKey, { requestId: 'doc-7781', userId: 'ali-123', units: 10 });

      expect(res).toMatchObject({
        accepted: true,
        failedRules: [],
        account: { used: 10, remaining: 9_990, monthlyLimit: 10_000, perRequestLimit: 100 },
        user: { userId: 'ali-123', used: 10, remaining: 990, monthlyLimit: 1_000, perRequestLimit: 20 },
      });
      expect(await usage(apiKey)).toMatchObject({
        account: { used: 10, acceptedCount: 1 },
        user: { used: 10, acceptedCount: 1 },
      });
      await expectExactTotals(db, accountId);
    });

    it('an account with 5 left, 10 units → rejected on the account monthly limit', async () => {
      const { accountId, apiKey } = await createAccount(app, db);
      const small = await createPlan(app, apiKey, { name: 'Small', type: 'account', monthlyLimit: 15, perRequestLimit: 100 });
      await app.inject({ method: 'PATCH', url: '/v1/account', headers: { 'x-api-key': apiKey }, payload: { planId: small } });
      await createUser(app, apiKey, 'ali-123', await planIdByName(db, 'Basic'));
      await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali-123', units: 10 });

      const res = await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali-123', units: 10 });
      expect(res.accepted).toBe(false);
      expect(res.failedRules).toEqual([{ scope: 'account', rule: 'monthly_limit', limit: 15, remaining: 5 }]);
      expect(res.account).toMatchObject({ used: 10, remaining: 5 });
      await expectExactTotals(db, accountId);
    });

    it('a fast-path rejection lists monthly failures too', async () => {
      const { apiKey } = await briefSetup();
      for (let i = 0; i < 50; i++) await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali-123', units: 20 });
      const res = await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali-123', units: 25 });
      expect(res.failedRules).toEqual([
        { scope: 'user', rule: 'per_request_limit', limit: 20, requested: 25 },
        { scope: 'user', rule: 'monthly_limit', limit: 1_000, remaining: 0 },
      ]);
    });
  });

  describe('retries', () => {
    it('same requestId + same data → the original answer, replayed, counted once', async () => {
      const { accountId, apiKey } = await briefSetup();
      const body = { requestId: 'doc-1', userId: 'ali-123', units: 10 };
      const first = await consumeOk(app, apiKey, body);
      const retry = await consumeOk(app, apiKey, body);
      expect(retry).toEqual({ ...first, replayed: true });
      expect((await usage(apiKey)).account).toMatchObject({ used: 10, acceptedCount: 1 });
      await expectExactTotals(db, accountId);
    });

    it('a fast-path rejection replays too, counted once', async () => {
      const { accountId, apiKey } = await briefSetup();
      const body = { requestId: 'doc-2', userId: 'ali-123', units: 25 };
      const first = await consumeOk(app, apiKey, body);
      expect(await consumeOk(app, apiKey, body)).toEqual({ ...first, replayed: true });
      expect((await usage(apiKey)).account).toMatchObject({ rejectedCount: 1 });
      await expectExactTotals(db, accountId);
    });

    it('same requestId + different units or user → 409 REQUEST_ID_CONFLICT', async () => {
      const { apiKey } = await briefSetup();
      await createUser(app, apiKey, 'sara', await planIdByName(db, 'Premium'));
      await consumeOk(app, apiKey, { requestId: 'doc-3', userId: 'ali-123', units: 10 });
      for (const body of [
        { requestId: 'doc-3', userId: 'ali-123', units: 11 },
        { requestId: 'doc-3', userId: 'sara', units: 10 },
        { requestId: 'doc-3', userId: 'ali-123', units: 25 },
      ]) {
        const res = await consume(app, apiKey, body);
        expect(res.status).toBe(409);
        expect(res.raw).toContain('REQUEST_ID_CONFLICT');
      }
    });
  });

  describe('plan changes', () => {
    it('an edited plan applies to the next request; history keeps the old limits', async () => {
      const { apiKey } = await createAccount(app, db);
      const planId = await createPlan(app, apiKey, { name: 'Tight', type: 'user', monthlyLimit: 100, perRequestLimit: 5 });
      await createUser(app, apiKey, 'ali-123', planId);

      expect((await consumeOk(app, apiKey, { requestId: 'before', userId: 'ali-123', units: 10 })).accepted).toBe(false);
      await app.inject({ method: 'PATCH', url: `/v1/plans/${planId}`, headers: { 'x-api-key': apiKey }, payload: { perRequestLimit: 50 } });
      expect((await consumeOk(app, apiKey, { requestId: 'after', userId: 'ali-123', units: 10 })).accepted).toBe(true);

      const { rows } = await db.execute<{ request_id: string; limits_snapshot: { user: { perRequestLimit: number } } }>(sql`
        SELECT request_id, limits_snapshot FROM requests WHERE request_id IN ('before', 'after') ORDER BY id
      `);
      expect(rows.map((r) => [r.request_id, r.limits_snapshot.user.perRequestLimit])).toEqual([['before', 5], ['after', 50]]);
    });

    it('switching plans mid-month keeps usage; lowering below usage → remaining 0, rejected', async () => {
      const { apiKey } = await briefSetup();
      await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali-123', units: 20 });
      const tiny = await createPlan(app, apiKey, { name: 'Tiny', type: 'user', monthlyLimit: 15, perRequestLimit: 20 });
      await app.inject({ method: 'PATCH', url: '/v1/users/ali-123', headers: { 'x-api-key': apiKey }, payload: { planId: tiny } });

      const res = await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali-123', units: 1 });
      expect(res.accepted).toBe(false);
      expect(res.user).toMatchObject({ used: 20, remaining: 0, monthlyLimit: 15 });
      expect(res.failedRules).toEqual([{ scope: 'user', rule: 'monthly_limit', limit: 15, remaining: 0 }]);
    });

    it('an inactive user is rejected with rule `inactive` and recorded', async () => {
      const { accountId, apiKey } = await briefSetup();
      await app.inject({ method: 'PATCH', url: '/v1/users/ali-123', headers: { 'x-api-key': apiKey }, payload: { isActive: false } });
      const res = await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali-123', units: 1 });
      expect(res.failedRules).toEqual([{ scope: 'user', rule: 'inactive' }]);
      await expectExactTotals(db, accountId);
    });
  });

  describe('months', () => {
    it("usage lands in the database's current UTC month", async () => {
      const { accountId, apiKey } = await briefSetup();
      await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali-123', units: 1 });
      const { rows } = await db.execute<{ ok: boolean }>(sql`
        SELECT month = date_trunc('month', now() AT TIME ZONE 'UTC')::date AS ok FROM account_usage WHERE account_id = ${accountId}
      `);
      expect(rows).toEqual([{ ok: true }]);
    });
  });

  describe('errors and isolation', () => {
    it('an unknown user → 404 USER_NOT_FOUND, not recorded', async () => {
      const { accountId, apiKey } = await briefSetup();
      const res = await consume(app, apiKey, { requestId: 'ghost', userId: 'nobody', units: 1 });
      expect(res.status).toBe(404);
      expect(res.raw).toContain('USER_NOT_FOUND');
      const { rows } = await db.execute(sql`SELECT 1 FROM requests WHERE account_id = ${accountId}`);
      expect(rows).toHaveLength(0);
    });

    it.each([
      ['units 0', { units: 0 }],
      ['fractional units', { units: 1.5 }],
      ['units over int4', { units: 2_147_483_648 }],
      ['empty requestId', { requestId: '' }],
      ['requestId over 128 chars', { requestId: 'x'.repeat(129) }],
      ['NUL in userId', { userId: 'ali\u0000' }],
      ['unknown field', { extra: true }],
    ])('%s → 400 VALIDATION_ERROR', async (_label, override) => {
      const { apiKey } = await briefSetup();
      const res = await app.inject({
        method: 'POST', url: '/v1/consume', headers: { 'x-api-key': apiKey },
        payload: { requestId: 'r', userId: 'ali-123', units: 1, ...override },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('no API key → 401', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/consume', payload: { requestId: 'r', userId: 'u', units: 1 } });
      expect(res.statusCode).toBe(401);
    });

    it("company A can't consume for B's user; same userId and requestId in two companies are independent", async () => {
      const a = await briefSetup();
      const b = await createAccount(app, db, 'Starter', 'Company B');
      await createUser(app, b.apiKey, 'b-only', await planIdByName(db, 'Basic'));
      expect((await consume(app, a.apiKey, { requestId: 'x', userId: 'b-only', units: 1 })).status).toBe(404);

      await createUser(app, b.apiKey, 'ali-123', await planIdByName(db, 'Premium'));
      const inA = await consumeOk(app, a.apiKey, { requestId: 'same', userId: 'ali-123', units: 10 });
      const inB = await consumeOk(app, b.apiKey, { requestId: 'same', userId: 'ali-123', units: 30 });
      expect([inA.accepted, inA.replayed, inB.accepted, inB.replayed]).toEqual([true, false, true, false]);
      expect([inA.user.used, inB.user.used]).toEqual([10, 30]);
      await expectExactTotals(db, a.accountId);
      await expectExactTotals(db, b.accountId);
    });
  });
});
