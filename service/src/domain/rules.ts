// Pure rule evaluation for consume (docs/CONSUME.md → "Rule evaluation"). No I/O.

export type RuleScope = 'user' | 'account';

export type FailedRule =
  | { scope: 'user'; rule: 'inactive' }
  | { scope: RuleScope; rule: 'per_request_limit'; limit: number; requested: number }
  // remaining = what was left before this request
  | { scope: RuleScope; rule: 'monthly_limit'; limit: number; remaining: number }
  // remaining = accepted requests still allowed in this UTC minute
  | { scope: RuleScope; rule: 'rate_limit'; limit: number; remaining: number };

export interface PlanLimits {
  monthlyLimit: number;
  perRequestLimit: number;
  // accepted requests per UTC minute; null = no rate limit
  rateLimitPerMinute: number | null;
}

/** A plan's limits as seen at decision time (stored in requests.limits_snapshot). */
export interface PlanSnapshot extends PlanLimits {
  planName: string;
}

export interface LimitsSnapshot {
  account: PlanSnapshot;
  user: PlanSnapshot;
}

export interface StaticRuleInput {
  units: number;
  userIsActive: boolean;
  userPlan: PlanLimits;
  accountPlan: PlanLimits;
}

export interface RuleInput extends StaticRuleInput {
  userUsed: number;
  accountUsed: number;
  // accepted requests already counted in the current UTC minute (0 if the window is from an earlier minute)
  userCountThisMinute: number;
  accountCountThisMinute: number;
}

export interface Decision {
  accepted: boolean;
  failedRules: FailedRule[];
}

/** max(0, limit − used): never negative, even after a plan was lowered below current usage. */
export function remaining(monthlyLimit: number, used: number): number {
  return Math.max(0, monthlyLimit - used);
}

function perRequest(scope: RuleScope, plan: PlanLimits, units: number): FailedRule[] {
  return units > plan.perRequestLimit
    ? [{ scope, rule: 'per_request_limit', limit: plan.perRequestLimit, requested: units }]
    : [];
}

function monthly(scope: RuleScope, plan: PlanLimits, used: number, units: number): FailedRule[] {
  // Same as used + units > limit, written so every intermediate value stays an exact integer.
  return units > plan.monthlyLimit - used
    ? [{ scope, rule: 'monthly_limit', limit: plan.monthlyLimit, remaining: remaining(plan.monthlyLimit, used) }]
    : [];
}

function rateLimit(scope: RuleScope, plan: PlanLimits, countThisMinute: number): FailedRule[] {
  const limit = plan.rateLimitPerMinute;
  // count + 1 > limit, written so the SQL twin can't overflow int4
  return limit !== null && countThisMinute >= limit
    ? [{ scope, rule: 'rate_limit', limit, remaining: Math.max(0, limit - countThisMinute) }]
    : [];
}

/**
 * The checks that don't depend on usage: user inactive, user per-request, account per-request.
 * If any fails, the request is rejected whatever the usage is (consume's fast path).
 */
export function evaluateStaticRules(input: StaticRuleInput): FailedRule[] {
  return [
    ...(input.userIsActive ? [] : [{ scope: 'user', rule: 'inactive' } as const]),
    ...perRequest('user', input.userPlan, input.units),
    ...perRequest('account', input.accountPlan, input.units),
  ];
}

/**
 * Runs all seven checks and lists every failure, always in the same order.
 * The SQL twin evaluate_rules() (consume v2) must stay identical: test/integration/rules-parity.test.ts.
 */
export function evaluateRules(input: RuleInput): Decision {
  const failedRules = [
    ...evaluateStaticRules(input),
    ...monthly('user', input.userPlan, input.userUsed, input.units),
    ...monthly('account', input.accountPlan, input.accountUsed, input.units),
    ...rateLimit('user', input.userPlan, input.userCountThisMinute),
    ...rateLimit('account', input.accountPlan, input.accountCountThisMinute),
  ];
  return { accepted: failedRules.length === 0, failedRules };
}
