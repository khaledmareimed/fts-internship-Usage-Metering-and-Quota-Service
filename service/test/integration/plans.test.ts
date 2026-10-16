import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp } from '../helpers/app.js';
import { createAccount, createPlan, createUser, planIdByName, setPlanActive, type NewPlan } from '../helpers/fixtures.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const POWER: NewPlan = { name: 'Power User', type: 'user', monthlyLimit: 5_000, perRequestLimit: 50 };

describe('plans', () => {
  let app: App;
  let db: Db;

  beforeAll(async () => {
    ({ app, dbHandle: { db } } = await buildTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (apiKey: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url: `/v1${url}`, headers: { 'x-api-key': apiKey }, ...(payload && { payload }) });
  const names = (body: { items: { name: string }[] }) => body.items.map((p) => p.name);

  describe('GET /v1/plans', () => {
    it('lists predefined plans first, then own custom plans, each by name', async () => {
      const { apiKey } = await createAccount(app, db);
      expect(names((await call(apiKey, 'GET', '/plans')).json())).toEqual(['Basic', 'Premium', 'Pro', 'Starter']);

      await createPlan(app, apiKey, { ...POWER, name: 'Zeta' });
      await createPlan(app, apiKey, { ...POWER, name: 'Alpha' });
      expect(names((await call(apiKey, 'GET', '/plans')).json())).toEqual([
        'Basic', 'Premium', 'Pro', 'Starter', 'Alpha', 'Zeta',
      ]);
    });

    it('filters by type', async () => {
      const { apiKey } = await createAccount(app, db);
      expect(names((await call(apiKey, 'GET', '/plans?type=user')).json())).toEqual(['Basic', 'Premium']);
      expect(names((await call(apiKey, 'GET', '/plans?type=account')).json())).toEqual(['Pro', 'Starter']);
    });

    it('hides inactive plans unless includeInactive=true', async () => {
      const { apiKey } = await createAccount(app, db);
      const planId = await createPlan(app, apiKey, POWER);
      await setPlanActive(app, apiKey, planId, false);
      expect(names((await call(apiKey, 'GET', '/plans')).json())).not.toContain('Power User');
      expect(names((await call(apiKey, 'GET', '/plans?includeInactive=true')).json())).toContain('Power User');
      expect((await call(apiKey, 'GET', '/plans?includeInactive=yes')).statusCode).toBe(400);
    });
  });

  describe('POST /v1/plans', () => {
    it('creates a custom plan (name trimmed)', async () => {
      const { apiKey } = await createAccount(app, db);
      const res = await call(apiKey, 'POST', '/plans', { ...POWER, name: '  Power User  ' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        planId: expect.any(String),
        name: 'Power User',
        type: 'user',
        monthlyLimit: 5_000,
        perRequestLimit: 50,
        rateLimitPerMinute: null,
        predefined: false,
        isActive: true,
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });
    });

    it.each([
      ['monthlyLimit 0', { monthlyLimit: 0 }],
      ['perRequestLimit 0', { perRequestLimit: 0 }],
      ['fractional limit', { monthlyLimit: 1.5 }],
      ['perRequestLimit over int4', { perRequestLimit: 2_147_483_648 }],
      ['monthlyLimit over 2^53', { monthlyLimit: 2 ** 53 }],
      ['empty name', { name: '' }],
      ['blank name', { name: '   ' }],
      ['name over 100 chars', { name: 'x'.repeat(101) }],
      ['bad type', { type: 'team' }],
      ['unknown field', { isActive: false }],
    ])('%s → 400 VALIDATION_ERROR', async (_label, override) => {
      const { apiKey } = await createAccount(app, db);
      const res = await call(apiKey, 'POST', '/plans', { ...POWER, ...override });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('a duplicate name or a predefined name → 409 PLAN_NAME_TAKEN', async () => {
      const { apiKey } = await createAccount(app, db);
      await createPlan(app, apiKey, POWER);
      for (const name of ['Power User', 'Basic']) {
        const res = await call(apiKey, 'POST', '/plans', { ...POWER, name });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('PLAN_NAME_TAKEN');
      }
    });

    it('two parallel creates with one name → one 201, one 409', async () => {
      const { apiKey } = await createAccount(app, db);
      const results = await Promise.all([1, 2].map(() => call(apiKey, 'POST', '/plans', POWER)));
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    });
  });

  describe('GET /v1/plans/:planId', () => {
    it('returns own and predefined plans; 404 for unknown, 400 for a bad id', async () => {
      const { apiKey } = await createAccount(app, db);
      const own = await createPlan(app, apiKey, POWER);
      expect((await call(apiKey, 'GET', `/plans/${own}`)).json().name).toBe('Power User');
      expect((await call(apiKey, 'GET', `/plans/${await planIdByName(db, 'Basic')}`)).json().predefined).toBe(true);

      const unknown = await call(apiKey, 'GET', `/plans/${randomUUID()}`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('PLAN_NOT_FOUND');
      expect((await call(apiKey, 'GET', '/plans/not-a-uuid')).statusCode).toBe(400);
    });
  });

  describe('PATCH /v1/plans/:planId', () => {
    it('edits name and limits', async () => {
      const { apiKey } = await createAccount(app, db);
      const planId = await createPlan(app, apiKey, POWER);
      const before = (await call(apiKey, 'GET', `/plans/${planId}`)).json();
      const res = await call(apiKey, 'PATCH', `/plans/${planId}`, {
        name: 'Power User v2', monthlyLimit: 3_000, perRequestLimit: 40,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Power User v2', monthlyLimit: 3_000, perRequestLimit: 40, type: 'user' });
      expect(res.json().updatedAt > before.updatedAt).toBe(true);
    });

    it('an empty body or a type change → 400, plan unchanged', async () => {
      const { apiKey } = await createAccount(app, db);
      const planId = await createPlan(app, apiKey, POWER);
      expect((await call(apiKey, 'PATCH', `/plans/${planId}`, {})).statusCode).toBe(400);
      const typeChange = await call(apiKey, 'PATCH', `/plans/${planId}`, { type: 'account' });
      expect(typeChange.statusCode).toBe(400);
      expect(typeChange.json().error.code).toBe('VALIDATION_ERROR');
      expect((await call(apiKey, 'GET', `/plans/${planId}`)).json().type).toBe('user');
    });

    it('a predefined plan → 403 PREDEFINED_PLAN_READ_ONLY', async () => {
      const { apiKey } = await createAccount(app, db);
      for (const payload of [{ monthlyLimit: 1 }, { isActive: false }]) {
        const res = await call(apiKey, 'PATCH', `/plans/${await planIdByName(db, 'Starter')}`, payload);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('PREDEFINED_PLAN_READ_ONLY');
      }
    });

    it('renaming to a taken name → 409 PLAN_NAME_TAKEN', async () => {
      const { apiKey } = await createAccount(app, db);
      await createPlan(app, apiKey, POWER);
      const planId = await createPlan(app, apiKey, { ...POWER, name: 'Other' });
      for (const name of ['Power User', 'Premium']) {
        expect((await call(apiKey, 'PATCH', `/plans/${planId}`, { name })).statusCode).toBe(409);
      }
    });

    it('new limits apply right away (account usage uses the live limit)', async () => {
      const { apiKey } = await createAccount(app, db);
      const planId = await createPlan(app, apiKey, { name: 'Demo Team', type: 'account', monthlyLimit: 100, perRequestLimit: 60 });
      await call(apiKey, 'PATCH', '/account', { planId });
      await call(apiKey, 'PATCH', `/plans/${planId}`, { monthlyLimit: 500 });
      expect((await call(apiKey, 'GET', '/account')).json().usage.remaining).toBe(500);
    });
  });

  describe('deactivation', () => {
    it('an unused plan can be deactivated and reactivated', async () => {
      const { apiKey } = await createAccount(app, db);
      const planId = await createPlan(app, apiKey, POWER);
      expect((await setPlanActive(app, apiKey, planId, false)).json().isActive).toBe(false);
      expect((await setPlanActive(app, apiKey, planId, true)).json().isActive).toBe(true);
    });

    it("the company's own plan → 409 PLAN_IN_USE", async () => {
      const { apiKey } = await createAccount(app, db);
      const planId = await createPlan(app, apiKey, { ...POWER, type: 'account' });
      await call(apiKey, 'PATCH', '/account', { planId });
      const res = await setPlanActive(app, apiKey, planId, false);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PLAN_IN_USE');
    });

    it("a user's plan → 409 PLAN_IN_USE", async () => {
      const { apiKey } = await createAccount(app, db);
      const planId = await createPlan(app, apiKey, POWER);
      await createUser(app, apiKey, 'ali-123', planId);
      expect((await setPlanActive(app, apiKey, planId, false)).statusCode).toBe(409);
    });
  });

  describe('isolation', () => {
    it("company A can't see or edit company B's plans", async () => {
      const a = await createAccount(app, db, 'Starter', 'Company A');
      const b = await createAccount(app, db, 'Starter', 'Company B');
      const bPlan = await createPlan(app, b.apiKey, POWER);

      expect((await call(a.apiKey, 'GET', `/plans/${bPlan}`)).statusCode).toBe(404);
      expect((await call(a.apiKey, 'PATCH', `/plans/${bPlan}`, { monthlyLimit: 1 })).statusCode).toBe(404);
      expect(names((await call(a.apiKey, 'GET', '/plans?includeInactive=true')).json())).not.toContain('Power User');
      expect((await call(b.apiKey, 'GET', `/plans/${bPlan}`)).json().monthlyLimit).toBe(5_000);
    });

    it('the same custom name works in two companies', async () => {
      const a = await createAccount(app, db, 'Starter', 'Company A');
      const b = await createAccount(app, db, 'Starter', 'Company B');
      await createPlan(app, a.apiKey, POWER);
      expect((await call(b.apiKey, 'POST', '/plans', POWER)).statusCode).toBe(201);
    });
  });
});
