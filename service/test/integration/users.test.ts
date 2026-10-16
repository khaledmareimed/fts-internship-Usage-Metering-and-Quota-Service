import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp } from '../helpers/app.js';
import {
  createAccount,
  createPlan,
  createUser,
  currentMonth,
  insertUserUsage,
  planIdByName,
  setPlanActive,
} from '../helpers/fixtures.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PAST = '2020-01';
const userUrl = (userId: string, query = '') => `/users/${encodeURIComponent(userId)}${query}`;

describe('users', () => {
  let app: App;
  let db: Db;
  let basic: string;
  let premium: string;

  beforeAll(async () => {
    ({ app, dbHandle: { db } } = await buildTestApp());
    basic = await planIdByName(db, 'Basic');
    premium = await planIdByName(db, 'Premium');
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (apiKey: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url: `/v1${url}`, headers: { 'x-api-key': apiKey }, ...(payload && { payload }) });

  describe('POST /v1/users', () => {
    it('registers a user', async () => {
      const { apiKey } = await createAccount(app, db);
      const res = await call(apiKey, 'POST', '/users', { userId: 'ali-123', planId: basic });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        userId: 'ali-123',
        isActive: true,
        plan: expect.objectContaining({ planId: basic, name: 'Basic', type: 'user', predefined: true }),
        createdAt: expect.stringMatching(ISO),
      });
    });

    it.each([
      ['spaces kept as sent', ' ali 123 '],
      ['slashes and symbols', 'team/ali?x=1#frag%20'],
      ['unicode', 'عَلي-😀'],
      ['128 characters', '😀'.repeat(128)],
    ])('accepts any id (%s) and reads it back exactly', async (_label, userId) => {
      const { apiKey } = await createAccount(app, db);
      expect((await call(apiKey, 'POST', '/users', { userId, planId: basic })).statusCode).toBe(201);
      const res = await call(apiKey, 'GET', userUrl(userId));
      expect(res.statusCode).toBe(200);
      expect(res.json().userId).toBe(userId);
    });

    it.each([
      ['empty id', { userId: '' }],
      ['129 characters', { userId: 'x'.repeat(129) }],
      ['NUL character', { userId: 'ali\u0000' }],
      ['bad planId', { planId: 'nope' }],
      ['unknown field', { isActive: false }],
    ])('%s → 400 VALIDATION_ERROR', async (_label, override) => {
      const { apiKey } = await createAccount(app, db);
      const res = await call(apiKey, 'POST', '/users', { userId: 'ali-123', planId: basic, ...override });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('a duplicate userId → 409 USER_ALREADY_EXISTS (also when racing)', async () => {
      const { apiKey } = await createAccount(app, db);
      await createUser(app, apiKey, 'ali-123', basic);
      const dup = await call(apiKey, 'POST', '/users', { userId: 'ali-123', planId: premium });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('USER_ALREADY_EXISTS');

      const race = await Promise.all([1, 2].map(() => call(apiKey, 'POST', '/users', { userId: 'sara', planId: basic })));
      expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    });

    it('plan rules: account plan → 400, unknown → 404, inactive → 409', async () => {
      const { apiKey } = await createAccount(app, db);
      const post = (planId: string) => call(apiKey, 'POST', '/users', { userId: 'ali-123', planId });

      expect((await post(await planIdByName(db, 'Starter'))).json().error.code).toBe('PLAN_TYPE_MISMATCH');
      expect((await post(randomUUID())).statusCode).toBe(404);

      const old = await createPlan(app, apiKey, { name: 'Old', type: 'user', monthlyLimit: 10, perRequestLimit: 5 });
      await setPlanActive(app, apiKey, old, false);
      const inactive = await post(old);
      expect(inactive.statusCode).toBe(409);
      expect(inactive.json().error.code).toBe('PLAN_INACTIVE');
    });
  });

  describe('GET /v1/users/:userId', () => {
    it('returns the plan and zero usage for a new user', async () => {
      const { apiKey } = await createAccount(app, db);
      await createUser(app, apiKey, 'ali-123', basic);
      expect((await call(apiKey, 'GET', userUrl('ali-123'))).json()).toEqual({
        userId: 'ali-123',
        isActive: true,
        plan: expect.objectContaining({ name: 'Basic' }),
        usage: { month: await currentMonth(db), used: 0, remaining: 1_000, acceptedCount: 0, rejectedCount: 0 },
      });
    });

    it('current month uses the live limit; a past month its stored limit', async () => {
      const { accountId, apiKey } = await createAccount(app, db);
      await createUser(app, apiKey, 'ali-123', basic);
      await insertUserUsage(db, accountId, 'ali-123', await currentMonth(db), { used: 810, monthlyLimit: 5, acceptedCount: 40 });
      await insertUserUsage(db, accountId, 'ali-123', PAST, { used: 90, monthlyLimit: 100, rejectedCount: 2 });

      expect((await call(apiKey, 'GET', userUrl('ali-123'))).json().usage).toMatchObject({ used: 810, remaining: 190, acceptedCount: 40 });
      expect((await call(apiKey, 'GET', userUrl('ali-123', `?month=${PAST}`))).json().usage).toEqual({
        month: PAST, used: 90, remaining: 10, acceptedCount: 0, rejectedCount: 2,
      });
    });

    it('a future month → 400; an unknown user → 404 USER_NOT_FOUND', async () => {
      const { apiKey } = await createAccount(app, db);
      await createUser(app, apiKey, 'ali-123', basic);
      expect((await call(apiKey, 'GET', userUrl('ali-123', '?month=2999-01'))).statusCode).toBe(400);
      const missing = await call(apiKey, 'GET', userUrl('nobody'));
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toEqual({
        code: 'USER_NOT_FOUND', message: "User 'nobody' not found in this account", details: { userId: 'nobody' },
      });
    });
  });

  describe('PATCH /v1/users/:userId', () => {
    it('switches plan and keeps usage (no fresh allowance)', async () => {
      const { accountId, apiKey } = await createAccount(app, db);
      await createUser(app, apiKey, 'ali-123', basic);
      await insertUserUsage(db, accountId, 'ali-123', await currentMonth(db), { used: 10, monthlyLimit: 1_000 });
      const res = await call(apiKey, 'PATCH', userUrl('ali-123'), { planId: premium });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ plan: { name: 'Premium' }, usage: { used: 10, remaining: 9_990 } });
    });

    it('deactivates and reactivates', async () => {
      const { apiKey } = await createAccount(app, db);
      await createUser(app, apiKey, 'ali-123', basic);
      expect((await call(apiKey, 'PATCH', userUrl('ali-123'), { isActive: false })).json().isActive).toBe(false);
      expect((await call(apiKey, 'PATCH', userUrl('ali-123'), { isActive: true })).json().isActive).toBe(true);
    });

    it('rejects bad changes', async () => {
      const { apiKey } = await createAccount(app, db);
      await createUser(app, apiKey, 'ali-123', basic);
      const patch = (payload: object, userId = 'ali-123') => call(apiKey, 'PATCH', userUrl(userId), payload);

      expect((await patch({})).statusCode).toBe(400);
      expect((await patch({ userId: 'new-id' })).statusCode).toBe(400);
      expect((await patch({ planId: await planIdByName(db, 'Pro') })).json().error.code).toBe('PLAN_TYPE_MISMATCH');
      expect((await patch({ planId: randomUUID() })).json().error.code).toBe('PLAN_NOT_FOUND');
      expect((await patch({ isActive: false }, 'nobody')).json().error.code).toBe('USER_NOT_FOUND');
      expect((await call(apiKey, 'GET', userUrl('ali-123'))).json()).toMatchObject({ isActive: true, plan: { name: 'Basic' } });
    });
  });

  describe('isolation', () => {
    it("company A can't read, change or assign company B's users and plans", async () => {
      const a = await createAccount(app, db, 'Starter', 'Company A');
      const b = await createAccount(app, db, 'Starter', 'Company B');
      await createUser(app, b.apiKey, 'b-only', basic);
      const bPlan = await createPlan(app, b.apiKey, { name: 'B Plan', type: 'user', monthlyLimit: 10, perRequestLimit: 5 });

      expect((await call(a.apiKey, 'GET', userUrl('b-only'))).statusCode).toBe(404);
      expect((await call(a.apiKey, 'PATCH', userUrl('b-only'), { isActive: false })).statusCode).toBe(404);
      expect((await call(a.apiKey, 'GET', '/users')).json().items).toEqual([]);
      expect((await call(a.apiKey, 'POST', '/users', { userId: 'a-user', planId: bPlan })).statusCode).toBe(404);
      expect((await call(b.apiKey, 'GET', userUrl('b-only'))).json().isActive).toBe(true);
    });

    it('the same userId in two companies is independent', async () => {
      const a = await createAccount(app, db, 'Starter', 'Company A');
      const b = await createAccount(app, db, 'Starter', 'Company B');
      await createUser(app, a.apiKey, 'ali-123', basic);
      await createUser(app, b.apiKey, 'ali-123', premium);
      await call(a.apiKey, 'PATCH', userUrl('ali-123'), { isActive: false });

      expect((await call(a.apiKey, 'GET', userUrl('ali-123'))).json()).toMatchObject({ isActive: false, plan: { name: 'Basic' } });
      expect((await call(b.apiKey, 'GET', userUrl('ali-123'))).json()).toMatchObject({ isActive: true, plan: { name: 'Premium' } });
    });
  });
});
