import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/client.js';
import { evaluateRules, type FailedRule, type RuleInput } from '../../src/domain/rules.js';
import { createTestDatabase } from '../helpers/db.js';

const INT4_MAX = 2_147_483_647;
const MAX = Number.MAX_SAFE_INTEGER;

/** Small deterministic PRNG (mulberry32) so a failure is reproducible. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomCases(count: number): RuleInput[] {
  const rnd = prng(20261014);
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  return Array.from({ length: count }, () => {
    const userMonthly = int(1, 2_000);
    const accountMonthly = int(1, 20_000);
    // null (no rate limit) about a third of the time
    const rate = () => (rnd() < 0.33 ? null : int(1, 20));
    return {
      units: int(1, 300),
      userIsActive: rnd() > 0.1,
      userPlan: { monthlyLimit: userMonthly, perRequestLimit: int(1, 250), rateLimitPerMinute: rate() },
      accountPlan: { monthlyLimit: accountMonthly, perRequestLimit: int(1, 250), rateLimitPerMinute: rate() },
      // includes usage above a lowered limit
      userUsed: int(0, userMonthly + 200),
      accountUsed: int(0, accountMonthly + 200),
      userCountThisMinute: int(0, 25),
      accountCountThisMinute: int(0, 25),
    };
  });
}

const base: RuleInput = {
  units: 10,
  userIsActive: true,
  userPlan: { monthlyLimit: 1_000, perRequestLimit: 20, rateLimitPerMinute: null },
  accountPlan: { monthlyLimit: 10_000, perRequestLimit: 100, rateLimitPerMinute: null },
  userUsed: 0,
  accountUsed: 0,
  userCountThisMinute: 0,
  accountCountThisMinute: 0,
};

const rated = (user: number | null, account: number | null, userCount: number, accountCount: number): RuleInput => ({
  ...base,
  userPlan: { ...base.userPlan, rateLimitPerMinute: user },
  accountPlan: { ...base.accountPlan, rateLimitPerMinute: account },
  userCountThisMinute: userCount,
  accountCountThisMinute: accountCount,
});

const edgeCases: RuleInput[] = [
  base,
  { ...base, units: 25 },
  { ...base, userUsed: 990 }, // exactly at the user limit
  { ...base, accountUsed: 9_990 }, // exactly at the account limit
  { ...base, userUsed: 991, accountUsed: 9_991 },
  { ...base, units: 20, accountPlan: { monthlyLimit: 10_000, perRequestLimit: 20, rateLimitPerMinute: null } }, // per-request exactly
  { ...base, userIsActive: false },
  { ...base, userIsActive: false, units: 200, userUsed: 999, accountUsed: 9_999 }, // all five
  { ...base, units: 1, userUsed: 5_000, accountUsed: 50_000 }, // lowered below usage
  rated(3, 3, 2, 2), // both rates exactly at the limit (accepted)
  rated(3, 3, 3, 3), // both over
  rated(2, null, 9, 9), // lowered user rate, no account rate
  { ...rated(5, 50, 5, 50), units: 200, userIsActive: false, userUsed: 900, accountUsed: 9_900 }, // all seven
  {
    units: INT4_MAX,
    userIsActive: true,
    userPlan: { monthlyLimit: MAX, perRequestLimit: INT4_MAX, rateLimitPerMinute: INT4_MAX },
    accountPlan: { monthlyLimit: MAX, perRequestLimit: INT4_MAX, rateLimitPerMinute: INT4_MAX },
    userUsed: MAX - INT4_MAX,
    accountUsed: MAX - INT4_MAX + 1,
    userCountThisMinute: INT4_MAX - 1,
    accountCountThisMinute: INT4_MAX,
  },
];

describe('evaluate_rules() (SQL) is identical to evaluateRules() (TS)', () => {
  let dbHandle: DbHandle;

  beforeAll(async () => {
    dbHandle = await createTestDatabase();
  });

  afterAll(async () => {
    await dbHandle?.pool.end();
  });

  it.each([
    ['hand-picked edge cases', edgeCases],
    ['2,000 seeded random cases', randomCases(2_000)],
  ])('%s', async (_label, cases) => {
    const columns = (pick: (c: RuleInput) => number | boolean | null) => JSON.stringify(cases.map(pick));
    const { rows } = await dbHandle.db.execute<{ i: number; rules: FailedRule[] }>(sql`
      SELECT c.i::int AS i,
             evaluate_rules(c.units, c.active, c.um, c.ur, c.am, c.ar, c.uu, c.au, c.urate, c.arate, c.ucount, c.acount) AS rules
      FROM ROWS FROM (
        jsonb_array_elements_text(${columns((c) => c.units)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.userIsActive)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.userPlan.monthlyLimit)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.userPlan.perRequestLimit)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.accountPlan.monthlyLimit)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.accountPlan.perRequestLimit)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.userUsed)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.accountUsed)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.userPlan.rateLimitPerMinute)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.accountPlan.rateLimitPerMinute)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.userCountThisMinute)}::jsonb),
        jsonb_array_elements_text(${columns((c) => c.accountCountThisMinute)}::jsonb)
      ) WITH ORDINALITY AS t(units, active, um, ur, am, ar, uu, au, urate, arate, ucount, acount, i),
      LATERAL (SELECT t.i - 1 AS i, t.units::int AS units, t.active::boolean AS active, t.um::bigint AS um,
                      t.ur::int AS ur, t.am::bigint AS am, t.ar::int AS ar, t.uu::bigint AS uu, t.au::bigint AS au,
                      t.urate::int AS urate, t.arate::int AS arate, t.ucount::int AS ucount, t.acount::int AS acount) c
      ORDER BY c.i
    `);
    expect(rows).toHaveLength(cases.length);
    rows.forEach(({ i, rules }) => {
      expect({ i, rules }).toEqual({ i, rules: evaluateRules(cases[i]!).failedRules });
    });
    // Both outcomes are really exercised.
    expect(rows.some((r) => r.rules.length === 0)).toBe(true);
    expect(rows.some((r) => r.rules.length > 1)).toBe(true);
    expect(rows.some((r) => r.rules.some((f) => f.rule === 'rate_limit'))).toBe(true);
  });
});
