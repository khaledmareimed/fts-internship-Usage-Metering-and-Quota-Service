import { describe, expect, it } from 'vitest';
import type { ConsumeResult } from '../../types/api';
import { decisionSummary, formatUnits, ruleLabel, ruleOwner, usagePercent } from './format';

const result = (over: Partial<ConsumeResult>): ConsumeResult => ({
  requestId: 'r1',
  accepted: true,
  units: 10,
  failedRules: [],
  month: '2026-10',
  account: { used: 10, remaining: 90, monthlyLimit: 100, perRequestLimit: 60 },
  user: { userId: 'ali', used: 10, remaining: 990, monthlyLimit: 1_000, perRequestLimit: 20 },
  replayed: false,
  decidedAt: '2026-10-14T08:00:00.000Z',
  ...over,
});

describe('ruleLabel / ruleOwner', () => {
  it.each([
    [{ scope: 'user', rule: 'inactive' } as const, 'User is inactive', 'User'],
    [{ scope: 'user', rule: 'per_request_limit', limit: 20, requested: 25 } as const, 'User per-request limit (20): asked for 25', 'User'],
    [{ scope: 'account', rule: 'per_request_limit', limit: 60, requested: 61 } as const, 'Company per-request limit (60): asked for 61', 'Company'],
    [{ scope: 'user', rule: 'monthly_limit', limit: 1000, remaining: 5 } as const, 'User monthly limit (1,000): 5 left', 'User'],
    [{ scope: 'account', rule: 'monthly_limit', limit: 100, remaining: 30 } as const, 'Company monthly limit (100): 30 left', 'Company'],
    [{ scope: 'user', rule: 'rate_limit', limit: 5, remaining: 0 } as const, 'User rate limit (5/min): 0 left this minute', 'User'],
    [{ scope: 'account', rule: 'rate_limit', limit: 120, remaining: 3 } as const, 'Company rate limit (120/min): 3 left this minute', 'Company'],
  ])('%o', (rule, label, owner) => {
    expect(ruleLabel(rule)).toBe(label);
    expect(ruleOwner(rule)).toBe(owner);
  });
});

describe('decisionSummary', () => {
  it('accepted', () => {
    expect(decisionSummary(result({}))).toBe('Accepted: 10 units for ali');
  });

  it('rejected with one and several rules', () => {
    const one = result({ accepted: false, failedRules: [{ scope: 'user', rule: 'inactive' }] });
    expect(decisionSummary(one)).toBe('Rejected: 1 rule failed, nothing was used');
    const two = result({
      accepted: false,
      failedRules: [
        { scope: 'user', rule: 'per_request_limit', limit: 20, requested: 25 },
        { scope: 'account', rule: 'monthly_limit', limit: 100, remaining: 5 },
      ],
    });
    expect(decisionSummary(two)).toBe('Rejected: 2 rules failed, nothing was used');
  });
});

describe('usagePercent', () => {
  it('rounds and clamps to 0–100', () => {
    expect(usagePercent(70, 100)).toBe(70);
    expect(usagePercent(1, 3)).toBe(33);
    expect(usagePercent(0, 100)).toBe(0);
    expect(usagePercent(110, 100)).toBe(100); // usage above a lowered limit
    expect(usagePercent(5, 0)).toBe(100);
  });
});

describe('formatUnits', () => {
  it('groups thousands', () => {
    expect(formatUnits(10_000)).toBe('10,000');
    expect(formatUnits(5)).toBe('5');
  });
});
