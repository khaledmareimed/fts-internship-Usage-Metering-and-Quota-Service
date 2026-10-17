import { describe, expect, it } from 'vitest';
import { evaluateRules, evaluateStaticRules, remaining, type RuleInput } from '../../src/domain/rules.js';

// The brief's example: account 10,000/month, 100/request; user 1,000/month, 20/request.
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

const evaluate = (override: Partial<RuleInput>) => evaluateRules({ ...base, ...override });

describe('evaluateRules', () => {
  it('accepts when all rules pass', () => {
    expect(evaluate({})).toEqual({ accepted: true, failedRules: [] });
  });

  it('rejects on the user per-request limit (25 units vs 20)', () => {
    expect(evaluate({ units: 25 })).toEqual({
      accepted: false,
      failedRules: [{ scope: 'user', rule: 'per_request_limit', limit: 20, requested: 25 }],
    });
  });

  it('rejects on the account per-request limit', () => {
    const decision = evaluate({ units: 15, accountPlan: { monthlyLimit: 10_000, perRequestLimit: 10, rateLimitPerMinute: null } });
    expect(decision.failedRules).toEqual([{ scope: 'account', rule: 'per_request_limit', limit: 10, requested: 15 }]);
  });

  it('rejects on the user monthly limit', () => {
    expect(evaluate({ userUsed: 995 }).failedRules).toEqual([
      { scope: 'user', rule: 'monthly_limit', limit: 1_000, remaining: 5 },
    ]);
  });

  it('rejects on the account monthly limit (5 left, ask 10)', () => {
    expect(evaluate({ accountUsed: 9_995 })).toEqual({
      accepted: false,
      failedRules: [{ scope: 'account', rule: 'monthly_limit', limit: 10_000, remaining: 5 }],
    });
  });

  it('lists several failures in the fixed order (API.md example)', () => {
    expect(evaluate({ units: 25, accountUsed: 9_995 }).failedRules).toEqual([
      { scope: 'user', rule: 'per_request_limit', limit: 20, requested: 25 },
      { scope: 'account', rule: 'monthly_limit', limit: 10_000, remaining: 5 },
    ]);
  });

  it('lists all seven failures, in order, when everything fails', () => {
    const decision = evaluate({
      units: 200,
      userIsActive: false,
      userUsed: 900,
      accountUsed: 9_900,
      userPlan: { ...base.userPlan, rateLimitPerMinute: 5 },
      accountPlan: { ...base.accountPlan, rateLimitPerMinute: 50 },
      userCountThisMinute: 5,
      accountCountThisMinute: 50,
    });
    expect(decision.failedRules.map((f) => `${f.scope}:${f.rule}`)).toEqual([
      'user:inactive',
      'user:per_request_limit',
      'account:per_request_limit',
      'user:monthly_limit',
      'account:monthly_limit',
      'user:rate_limit',
      'account:rate_limit',
    ]);
  });

  it('lists all five non-rate failures, in order, when no rate limit is set', () => {
    const decision = evaluate({
      units: 200,
      userIsActive: false,
      userUsed: 900,
      accountUsed: 9_900,
    });
    expect(decision.failedRules.map((f) => `${f.scope}:${f.rule}`)).toEqual([
      'user:inactive',
      'user:per_request_limit',
      'account:per_request_limit',
      'user:monthly_limit',
      'account:monthly_limit',
    ]);
  });

  it('an inactive user → rule `inactive`, and the other checks still run', () => {
    expect(evaluate({ userIsActive: false }).failedRules).toEqual([{ scope: 'user', rule: 'inactive' }]);
    expect(evaluate({ userIsActive: false, units: 25 }).failedRules).toHaveLength(2);
  });

  it('exactly at the limit is accepted (used + units == limit)', () => {
    expect(evaluate({ userUsed: 990 }).accepted).toBe(true);
    expect(evaluate({ accountUsed: 9_990 }).accepted).toBe(true);
    expect(evaluate({ units: 20 }).accepted).toBe(true); // per-request limit itself
    expect(evaluate({ userUsed: 991 }).accepted).toBe(false);
  });

  it('remaining is never negative when the limit was lowered below usage', () => {
    const decision = evaluate({ units: 1, userUsed: 1_200, accountUsed: 12_000 });
    expect(decision.failedRules).toEqual([
      { scope: 'user', rule: 'monthly_limit', limit: 1_000, remaining: 0 },
      { scope: 'account', rule: 'monthly_limit', limit: 10_000, remaining: 0 },
    ]);
  });

  it('is exact at the largest allowed limit (2^53 − 1)', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const huge = { monthlyLimit: max, perRequestLimit: 2_147_483_647, rateLimitPerMinute: null };
    const input = { units: 2_147_483_647, userPlan: huge, accountPlan: huge };
    expect(evaluate({ ...input, userUsed: max - 2_147_483_647, accountUsed: 0 }).accepted).toBe(true);
    expect(evaluate({ ...input, userUsed: max - 2_147_483_646, accountUsed: 0 }).failedRules).toEqual([
      { scope: 'user', rule: 'monthly_limit', limit: max, remaining: 2_147_483_646 },
    ]);
  });
});

describe('rate limit', () => {
  const limited = (user: number | null, account: number | null) => ({
    userPlan: { ...base.userPlan, rateLimitPerMinute: user },
    accountPlan: { ...base.accountPlan, rateLimitPerMinute: account },
  });

  it('accepts below and exactly at the limit (count + 1 == limit)', () => {
    expect(evaluate({ ...limited(3, 3), userCountThisMinute: 1, accountCountThisMinute: 1 }).accepted).toBe(true);
    expect(evaluate({ ...limited(3, 3), userCountThisMinute: 2, accountCountThisMinute: 2 }).accepted).toBe(true);
  });

  it('rejects over the limit, per scope, with what is left this minute', () => {
    expect(evaluate({ ...limited(3, null), userCountThisMinute: 3 }).failedRules).toEqual([
      { scope: 'user', rule: 'rate_limit', limit: 3, remaining: 0 },
    ]);
    expect(evaluate({ ...limited(null, 10), accountCountThisMinute: 10 }).failedRules).toEqual([
      { scope: 'account', rule: 'rate_limit', limit: 10, remaining: 0 },
    ]);
  });

  it('a null limit never fails, whatever the count', () => {
    expect(evaluate({ ...limited(null, null), userCountThisMinute: 1e6, accountCountThisMinute: 1e6 }).accepted).toBe(true);
  });

  it('remaining is never negative after a limit was lowered', () => {
    expect(evaluate({ ...limited(2, null), userCountThisMinute: 7 }).failedRules).toEqual([
      { scope: 'user', rule: 'rate_limit', limit: 2, remaining: 0 },
    ]);
  });

  it('is not a static rule (depends on the window count)', () => {
    const input: RuleInput = { ...base, ...limited(1, 1), userCountThisMinute: 99, accountCountThisMinute: 99 };
    expect(evaluateStaticRules(input)).toEqual([]);
    expect(evaluateRules(input).accepted).toBe(false);
  });
});

describe('evaluateStaticRules', () => {
  it('is the usage-independent part of evaluateRules, in the same order', () => {
    const inputs: RuleInput[] = [
      base,
      { ...base, units: 25 },
      { ...base, userIsActive: false, units: 200, userUsed: 999, accountUsed: 9_999 },
      { ...base, accountUsed: 9_995 },
    ];
    for (const input of inputs) {
      const full = evaluateRules(input).failedRules;
      const staticRules = evaluateStaticRules(input);
      expect(staticRules).toEqual(full.slice(0, staticRules.length));
      expect(staticRules.some((f) => f.rule === 'monthly_limit')).toBe(false);
    }
  });

  it('ignores usage entirely', () => {
    const exhausted = { ...base, userUsed: 1_000, accountUsed: 10_000 };
    expect(evaluateStaticRules(exhausted)).toEqual([]);
    expect(evaluateRules(exhausted).accepted).toBe(false);
  });
});

describe('remaining', () => {
  it('is limit − used, clamped at 0', () => {
    expect(remaining(1_000, 800)).toBe(200);
    expect(remaining(1_000, 1_000)).toBe(0);
    expect(remaining(1_000, 1_200)).toBe(0);
  });
});
