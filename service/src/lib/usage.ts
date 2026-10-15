import { z } from 'zod';
import { remaining } from '../domain/rules.js';

/** The Usage object from docs/API.md. */
export const usageSchema = z.object({
  month: z.string(),
  used: z.number().int(),
  remaining: z.number().int(),
  acceptedCount: z.number().int(),
  rejectedCount: z.number().int(),
});

export type Usage = z.infer<typeof usageSchema>;

export interface UsagePeriod {
  month: string; // YYYY-MM
  isCurrent: boolean;
}

export interface UsageCounters {
  used: number;
  storedLimit: number;
  acceptedCount: number;
  rejectedCount: number;
}

/**
 * Current month, or a month with no row: the plan's live limit.
 * Past month with a row: the limit saved on that row at its last update.
 */
export function toUsage(period: UsagePeriod, counters: UsageCounters | null, liveLimit: number): Usage {
  const used = counters?.used ?? 0;
  const limit = period.isCurrent || !counters ? liveLimit : counters.storedLimit;
  return {
    month: period.month,
    used,
    remaining: remaining(limit, used),
    acceptedCount: counters?.acceptedCount ?? 0,
    rejectedCount: counters?.rejectedCount ?? 0,
  };
}
