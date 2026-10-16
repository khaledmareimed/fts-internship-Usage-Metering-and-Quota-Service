import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp } from '../helpers/app.js';
import { createAccount, createPlan, createUser, planIdByName, setPlanActive } from '../helpers/fixtures.js';

const ROUNDS = 20;

describe('plan deactivation vs assignment', () => {
  let app: App;
  let db: Db;

  beforeAll(async () => {
    ({ app, dbHandle: { db } } = await buildTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a plan is never left both inactive and assigned', async () => {
    const { accountId, apiKey } = await createAccount(app, db);
    const starter = await planIdByName(db, 'Starter');
    const planId = await createPlan(app, apiKey, { name: 'Team', type: 'account', monthlyLimit: 100, perRequestLimit: 10 });

    for (let round = 0; round < ROUNDS; round++) {
      // Reset: account back on Starter, custom plan active.
      await app.inject({ method: 'PATCH', url: '/v1/account', headers: { 'x-api-key': apiKey }, payload: { planId: starter } });
      await setPlanActive(app, apiKey, planId, true);

      const [assign, deactivate] = await Promise.all([
        app.inject({ method: 'PATCH', url: '/v1/account', headers: { 'x-api-key': apiKey }, payload: { planId } }),
        setPlanActive(app, apiKey, planId, false),
      ]);

      // Exactly one side wins: assigned (deactivate → 409) or deactivated (assign → 409).
      expect([assign.statusCode, deactivate.statusCode].sort()).toEqual([200, 409]);
      const { rows } = await db.execute<{ is_active: boolean; assigned: boolean }>(sql`
        SELECT p.is_active, a.plan_id = p.id AS assigned
        FROM plans p JOIN accounts a ON a.id = ${accountId} WHERE p.id = ${planId}
      `);
      expect(rows[0]?.is_active === false && rows[0]?.assigned === true).toBe(false);
    }
  });

  it('the same holds for assigning the plan to a user', async () => {
    const { accountId, apiKey } = await createAccount(app, db);
    const basic = await planIdByName(db, 'Basic');
    const planId = await createPlan(app, apiKey, { name: 'Team User', type: 'user', monthlyLimit: 100, perRequestLimit: 10 });
    await createUser(app, apiKey, 'ali-123', basic);
    const patchUser = (payload: object) =>
      app.inject({ method: 'PATCH', url: '/v1/users/ali-123', headers: { 'x-api-key': apiKey }, payload });

    for (let round = 0; round < ROUNDS; round++) {
      await patchUser({ planId: basic });
      await setPlanActive(app, apiKey, planId, true);

      const [assign, deactivate] = await Promise.all([patchUser({ planId }), setPlanActive(app, apiKey, planId, false)]);

      expect([assign.statusCode, deactivate.statusCode].sort()).toEqual([200, 409]);
      const { rows } = await db.execute<{ is_active: boolean; assigned: boolean }>(sql`
        SELECT p.is_active, u.plan_id = p.id AS assigned
        FROM plans p JOIN users u ON u.account_id = ${accountId} AND u.external_id = 'ali-123'
        WHERE p.id = ${planId}
      `);
      expect(rows[0]?.is_active === false && rows[0]?.assigned === true).toBe(false);
    }
  });
});
