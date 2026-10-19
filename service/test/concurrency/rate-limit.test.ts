import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp } from '../helpers/app.js';
import { consumeOk, expectExactTotals } from '../helpers/consume.js';
import { createAccount, createPlan, createUser, planIdByName } from '../helpers/fixtures.js';

describe('rate limit under concurrency', () => {
  let app: App;
  let db: Db;

  beforeAll(async () => {
    ({ app, dbHandle: { db } } = await buildTestApp({}, 20));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('60 parallel requests, 10/min account limit → never more than 10 accepted in any UTC minute', async () => {
    const { accountId, apiKey } = await createAccount(app, db);
    const planId = await createPlan(app, apiKey, {
      name: 'Paced team', type: 'account', monthlyLimit: 1_000_000, perRequestLimit: 100, rateLimitPerMinute: 10,
    });
    await app.inject({ method: 'PATCH', url: '/v1/account', headers: { 'x-api-key': apiKey }, payload: { planId } });
    const premium = await planIdByName(db, 'Premium');
    for (let u = 0; u < 5; u++) await createUser(app, apiKey, `u${u}`, premium);

    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => consumeOk(app, apiKey, { requestId: `p-${i}`, userId: `u${i % 5}`, units: 1 })),
    );
    const accepted = results.filter((r) => r.accepted).length;
    // 10 in one minute; up to 20 only if the burst straddles a minute boundary.
    expect(accepted).toBeGreaterThanOrEqual(10);
    expect(accepted).toBeLessThanOrEqual(20);

    const { rows } = await db.execute<{ minute: string; n: number }>(sql`
      SELECT date_trunc('minute', created_at)::text AS minute, count(*)::int AS n
      FROM requests WHERE account_id = ${accountId} AND accepted GROUP BY 1
    `);
    for (const row of rows) expect(row.n).toBeLessThanOrEqual(10);
    expect(results.filter((r) => !r.accepted).every((r) => r.failedRules.every((f) => f.rule === 'rate_limit'))).toBe(true);
    await expectExactTotals(db, accountId);
  });
});
