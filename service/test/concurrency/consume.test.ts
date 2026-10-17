import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp } from '../helpers/app.js';
import { consume, consumeOk, expectExactTotals, type ConsumeRequest } from '../helpers/consume.js';
import { createAccount, createPlan, createUser, planIdByName } from '../helpers/fixtures.js';

const POOL = 20;

describe('consume under concurrency', () => {
  let app: App;
  let db: Db;

  beforeAll(async () => {
    ({ app, dbHandle: { db } } = await buildTestApp({}, POOL));
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A company on its own account plan, with `users` Premium users (u0, u1, …). */
  async function setup(accountLimit: { monthlyLimit: number; perRequestLimit: number }, users: number) {
    const account = await createAccount(app, db);
    const planId = await createPlan(app, account.apiKey, { name: 'Load', type: 'account', ...accountLimit });
    await app.inject({ method: 'PATCH', url: '/v1/account', headers: { 'x-api-key': account.apiKey }, payload: { planId } });
    const premium = await planIdByName(db, 'Premium');
    for (let i = 0; i < users; i++) await createUser(app, account.apiKey, `u${i}`, premium);
    return { ...account, planId };
  }

  it('overspend: 1,000 left, 200 parallel × 10 units → exactly 100 accepted, used = 1,000', async () => {
    const { accountId, apiKey } = await setup({ monthlyLimit: 1_000, perRequestLimit: 100 }, 10);
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => consumeOk(app, apiKey, { requestId: `o-${i}`, userId: `u${i % 10}`, units: 10 })),
    );
    expect(results.filter((r) => r.accepted)).toHaveLength(100);
    expect(results.filter((r) => !r.accepted)).toHaveLength(100);
    const account = await app.inject({ method: 'GET', url: '/v1/account', headers: { 'x-api-key': apiKey } });
    expect(account.json().usage).toMatchObject({ used: 1_000, remaining: 0, acceptedCount: 100, rejectedCount: 100 });
    await expectExactTotals(db, accountId);
  });

  it.each([
    ['locked path (accepted)', 10, true],
    ['fast path (rejected, exercises the 23505 safety net)', 250, false],
  ])('duplicate storm on the %s: 50 parallel, one requestId → counted once, identical answers', async (_label, units, accepted) => {
    const { accountId, apiKey } = await setup({ monthlyLimit: 100_000, perRequestLimit: 1_000 }, 1);
    const body: ConsumeRequest = { requestId: 'storm', userId: 'u0', units };
    const results = await Promise.all(Array.from({ length: 50 }, () => consume(app, apiKey, body)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    const bodies = results.map((r) => JSON.parse(r.raw) as { replayed: boolean; accepted: boolean });
    expect(bodies.filter((b) => !b.replayed)).toHaveLength(1);
    expect(new Set(bodies.map((b) => JSON.stringify({ ...b, replayed: null }))).size).toBe(1);
    expect(bodies[0]?.accepted).toBe(accepted);

    const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM requests WHERE account_id = ${accountId}`);
    expect(rows[0]?.n).toBe(1);
    await expectExactTotals(db, accountId);
  });

  it("bad requests don't block good ones (median latency within 3× + 20 ms)", async () => {
    const { accountId, apiKey } = await setup({ monthlyLimit: 1_000_000, perRequestLimit: 100 }, 2);
    let seq = 0;
    const timeGood = async (count: number) => {
      const times: number[] = [];
      for (let i = 0; i < count; i++) {
        const start = performance.now();
        await consumeOk(app, apiKey, { requestId: `g-${seq++}`, userId: 'u0', units: 1 });
        times.push(performance.now() - start);
      }
      return median(times);
    };

    const baseline = await timeGood(30);

    // 8 workers keep the account flooded with over-limit requests (300 in total) while we measure.
    let sent = 0;
    let measuring = true;
    const flood = Array.from({ length: 8 }, async () => {
      while (measuring || sent < 300) {
        sent++;
        await consumeOk(app, apiKey, { requestId: `bad-${sent}-${Math.random()}`, userId: 'u1', units: 500 });
      }
    });
    const underFlood = await timeGood(30);
    measuring = false;
    await Promise.all(flood);

    expect(sent).toBeGreaterThanOrEqual(300);
    expect(underFlood).toBeLessThanOrEqual(baseline * 3 + 20);
    await expectExactTotals(db, accountId);
  });

  it('plan change under load: no request is accepted beyond the limit it saw under the lock', async () => {
    const { accountId, apiKey, planId } = await setup({ monthlyLimit: 10_000, perRequestLimit: 100 }, 5);
    const requests = Array.from({ length: 300 }, (_, i) =>
      consumeOk(app, apiKey, { requestId: `p-${i}`, userId: `u${i % 5}`, units: 10 }),
    );
    // Lower the plan while the requests run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const patch = await app.inject({
      method: 'PATCH', url: `/v1/plans/${planId}`, headers: { 'x-api-key': apiKey }, payload: { monthlyLimit: 500 },
    });
    expect(patch.statusCode).toBe(200);
    await Promise.all(requests);

    const { rows } = await db.execute<{ over: number; accepted: number }>(sql`
      SELECT count(*) FILTER (WHERE account_used > (limits_snapshot->'account'->>'monthlyLimit')::bigint)::int AS over,
             count(*) FILTER (WHERE accepted)::int AS accepted
      FROM requests WHERE account_id = ${accountId} AND accepted
    `);
    expect(rows[0]?.over).toBe(0);
    expect(rows[0]?.accepted).toBeGreaterThan(0);
    await expectExactTotals(db, accountId);
  });

  it('same requestId on the fast path and the locked path at once → one decision, the other 409, never a 500', async () => {
    const { accountId, apiKey } = await setup({ monthlyLimit: 100_000, perRequestLimit: 1_000 }, 1);
    const rounds = 50;
    const failures: string[] = [];
    for (let round = 0; round < rounds; round++) {
      const requestId = `race-${round}`;
      // 250 units > Premium's 200 per request → fast path; 10 units → locked path (consume_decide).
      const [fast, locked] = await Promise.all([
        consume(app, apiKey, { requestId, userId: 'u0', units: 250 }),
        consume(app, apiKey, { requestId, userId: 'u0', units: 10 }),
      ]);
      const statuses = [fast.status, locked.status].sort();
      const winnerReplayedLoser = statuses.join() === '200,200' && [fast, locked].some((r) => r.raw.includes('"replayed":true'));
      if (statuses.join() !== '200,409' && !winnerReplayedLoser) {
        failures.push(`round ${round}: ${fast.status} ${fast.raw.slice(0, 80)} | ${locked.status} ${locked.raw.slice(0, 80)}`);
      }
    }
    expect(failures).toEqual([]);

    const { rows } = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM requests WHERE account_id = ${accountId} AND request_id LIKE 'race-%'
    `);
    expect(rows[0]?.n).toBe(rounds); // exactly one stored decision per requestId
    await expectExactTotals(db, accountId);
  });
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
