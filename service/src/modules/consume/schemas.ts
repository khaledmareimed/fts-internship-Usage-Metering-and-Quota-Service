import { z } from 'zod';
import type { FailedRule, LimitsSnapshot, PlanSnapshot } from '../../domain/rules.js';
import { externalIdSchema } from '../../lib/externalId.js';

// requests.units is int4
export const consumeBody = z.strictObject({
  requestId: externalIdSchema,
  userId: externalIdSchema,
  units: z.int().min(1).max(2_147_483_647),
});

const scope = z.enum(['user', 'account']);
export const failedRuleSchema = z.union([
  z.object({ scope: z.literal('user'), rule: z.literal('inactive') }),
  z.object({ scope, rule: z.literal('per_request_limit'), limit: z.number().int(), requested: z.number().int() }),
  z.object({ scope, rule: z.literal('monthly_limit'), limit: z.number().int(), remaining: z.number().int() }),
  z.object({ scope, rule: z.literal('rate_limit'), limit: z.number().int(), remaining: z.number().int() }),
]);

const totals = {
  used: z.number().int(),
  remaining: z.number().int(),
  monthlyLimit: z.number().int(),
  perRequestLimit: z.number().int(),
};

export const consumeResponse = z.object({
  requestId: z.string(),
  accepted: z.boolean(),
  units: z.number().int(),
  failedRules: z.array(failedRuleSchema),
  month: z.string(),
  account: z.object(totals),
  user: z.object({ userId: z.string(), ...totals }),
  replayed: z.boolean(),
  decidedAt: z.iso.datetime(),
});

export type ConsumeBody = z.infer<typeof consumeBody>;
export type ConsumeResponse = z.infer<typeof consumeResponse>;

/** The user and both plans, as one consume decision needs them. */
export interface ConsumeContext {
  userId: string; // internal users.id
  userIsActive: boolean;
  userPlan: PlanSnapshot;
  accountPlan: PlanSnapshot;
}

/** A requests row: the decision, exactly as answered. */
export interface StoredRequest {
  requestId: string;
  userId: string; // internal users.id
  externalUserId: string;
  units: number;
  accepted: boolean;
  failedRules: FailedRule[];
  limitsSnapshot: LimitsSnapshot;
  accountUsed: number;
  userUsed: number;
  accountRemaining: number;
  userRemaining: number;
  month: string; // YYYY-MM of created_at (UTC)
  createdAt: Date;
}

/** Fresh answers and replays are both built from the stored row, so a retry gets the same body. */
export function toConsumeResponse(stored: StoredRequest, replayed: boolean): ConsumeResponse {
  const { account, user } = stored.limitsSnapshot;
  return {
    requestId: stored.requestId,
    accepted: stored.accepted,
    units: stored.units,
    failedRules: stored.failedRules,
    month: stored.month,
    account: {
      used: stored.accountUsed,
      remaining: stored.accountRemaining,
      monthlyLimit: account.monthlyLimit,
      perRequestLimit: account.perRequestLimit,
    },
    user: {
      userId: stored.externalUserId,
      used: stored.userUsed,
      remaining: stored.userRemaining,
      monthlyLimit: user.monthlyLimit,
      perRequestLimit: user.perRequestLimit,
    },
    replayed,
    decidedAt: stored.createdAt.toISOString(),
  };
}
