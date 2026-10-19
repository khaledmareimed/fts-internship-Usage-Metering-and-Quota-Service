import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp } from '../helpers/app.js';
import { consumeOk, expectExactTotals } from '../helpers/consume.js';
import { createAccount, createPlan, createUser, planIdByName } from '../helpers/fixtures.js';

let seq = 0;
const rid = () => `rl-${++seq}`;

describe('rate-limit rule', () => {
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

  /** A company on Starter with ali on a custom user plan limited to `perMinute`. */
  async function userLimited(perMinute: number) {
    const account = await createAccount(app, db);
    const planId = await createPlan(app, account.apiKey, {
      name: 'Paced', type: 'user', monthlyLimit: 1_000, perRequestLimit: 20, rateLimitPerMinute: perMinute,
    });
    await createUser(app, account.apiKey, 'ali', planId);
    return { ...account, planId };
  }

  describe('plans', () => {
    it('creates, edits and removes rateLimitPerMinute; predefined plans have none', async () => {
      const { apiKey, planId } = await userLimited(3);
      expect((await call(apiKey, 'GET', `/plans/${planId}`)).json().rateLimitPerMinute).toBe(3);
      expect((await call(apiKey, 'PATCH', `/plans/${planId}`, { rateLimitPerMinute: 10 })).json().rateLimitPerMinute).toBe(10);
      expect((await call(apiKey, 'PATCH', `/plans/${planId}`, { rateLimitPerMinute: null })).json().rateLimitPerMinute).toBeNull();
      const basic = await call(apiKey, 'GET', `/plans/${await planIdByName(db, 'Basic')}`);
      expect(basic.json().rateLimitPerMinute).toBeNull();
    });

    it.each([0, 1.5, 'ten', 2_147_483_648])('rateLimitPerMinute %j → 400', async (value) => {
      const { apiKey, planId } = await userLimited(3);
      expect((await call(apiKey, 'PATCH', `/plans/${planId}`, { rateLimitPerMinute: value })).statusCode).toBe(400);
      const create = await call(apiKey, 'POST', '/plans', {
        name: `Bad ${String(value)}`, type: 'user', monthlyLimit: 10, perRequestLimit: 5, rateLimitPerMinute: value,
      });
      expect(create.statusCode).toBe(400);
    });
  });

  describe('consume', () => {
    it('3/min: three accepted, the fourth rejected with rate_limit; recorded in history', async () => {
      const { accountId, apiKey } = await userLimited(3);
      for (let i = 0; i < 3; i++) {
        expect((await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 })).accepted).toBe(true);
      }
      const fourth = await consumeOk(app, apiKey, { requestId: 'fourth', userId: 'ali', units: 1 });
      expect(fourth.accepted).toBe(false);
      expect(fourth.failedRules).toEqual([{ scope: 'user', rule: 'rate_limit', limit: 3, remaining: 0 }]);

      const history = (await call(apiKey, 'GET', '/requests/fourth')).json();
      expect(history.limits.user.rateLimitPerMinute).toBe(3);
      expect(history.limits.account.rateLimitPerMinute).toBeNull();
      await expectExactTotals(db, accountId);
    });

    it('replays and rejections do not use window capacity', async () => {
      const { apiKey } = await userLimited(2);
      const first = { requestId: 'once', userId: 'ali', units: 1 };
      await consumeOk(app, apiKey, first);
      expect((await consumeOk(app, apiKey, first)).replayed).toBe(true); // replay: not counted
      expect((await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 25 })).accepted).toBe(false); // per-request
      expect((await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 })).accepted).toBe(true); // 2nd counted
      const third = await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 });
      expect(third.failedRules).toEqual([{ scope: 'user', rule: 'rate_limit', limit: 2, remaining: 0 }]);
    });

    it('limits the whole company on an account plan; both scopes are listed in order', async () => {
      const { apiKey } = await userLimited(1);
      await createUser(app, apiKey, 'sara', await planIdByName(db, 'Premium'));
      const team = await createPlan(app, apiKey, {
        name: 'Team', type: 'account', monthlyLimit: 10_000, perRequestLimit: 100, rateLimitPerMinute: 2,
      });
      await call(apiKey, 'PATCH', '/account', { planId: team });

      expect((await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 })).accepted).toBe(true);
      expect((await consumeOk(app, apiKey, { requestId: rid(), userId: 'sara', units: 1 })).accepted).toBe(true);
      const sara = await consumeOk(app, apiKey, { requestId: rid(), userId: 'sara', units: 1 });
      expect(sara.failedRules).toEqual([{ scope: 'account', rule: 'rate_limit', limit: 2, remaining: 0 }]);
      const ali = await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 });
      expect(ali.failedRules).toEqual([
        { scope: 'user', rule: 'rate_limit', limit: 1, remaining: 0 },
        { scope: 'account', rule: 'rate_limit', limit: 2, remaining: 0 },
      ]);
    });

    it('a fast-path rejection also reports a full rate window', async () => {
      const { apiKey } = await userLimited(1);
      await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 });
      const res = await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 25 });
      expect(res.failedRules).toEqual([
        { scope: 'user', rule: 'per_request_limit', limit: 20, requested: 25 },
        { scope: 'user', rule: 'rate_limit', limit: 1, remaining: 0 },
      ]);
    });

    it('the window resets in the next minute', async () => {
      const { accountId, apiKey } = await userLimited(1);
      await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 });
      expect((await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 })).accepted).toBe(false);
      // Simulate the clock moving on: the stored window is now a minute old.
      await db.execute(sql`
        UPDATE user_usage SET window_start = window_start - interval '1 minute'
        WHERE user_id = (SELECT id FROM users WHERE account_id = ${accountId} AND external_id = 'ali')
      `);
      expect((await consumeOk(app, apiKey, { requestId: rid(), userId: 'ali', units: 1 })).accepted).toBe(true);
      await expectExactTotals(db, accountId);
    });
  });
});
