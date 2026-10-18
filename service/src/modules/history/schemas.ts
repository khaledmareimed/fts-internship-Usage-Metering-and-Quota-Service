import { z } from 'zod';
import { externalIdSchema } from '../../lib/externalId.js';
import { monthParam } from '../../lib/month.js';
import { cursorTimestampSchema, limitParam } from '../../lib/pagination.js';
import { failedRuleSchema } from '../consume/schemas.js';

export const historyQuery = z.object({
  userId: externalIdSchema.optional(),
  month: monthParam.optional(),
  limit: limitParam,
  cursor: z.string().optional(),
});

export const requestParams = z.object({ requestId: externalIdSchema });

const planLimits = z.object({
  planName: z.string(),
  monthlyLimit: z.number().int(),
  perRequestLimit: z.number().int(),
  rateLimitPerMinute: z.number().int().nullable(),
});

/** One past decision (docs/API.md → History). */
export const historyItemSchema = z.object({
  requestId: z.string(),
  userId: z.string(),
  units: z.number().int(),
  accepted: z.boolean(),
  failedRules: z.array(failedRuleSchema),
  limits: z.object({ account: planLimits, user: planLimits }),
  accountRemaining: z.number().int(),
  userRemaining: z.number().int(),
  createdAt: z.iso.datetime(),
});

export const historyListResponse = z.object({
  items: z.array(historyItemSchema),
  nextCursor: z.string().nullable(),
});

/** Position after the last item of a page (newest first by decision time). */
export const historyCursor = z.object({ createdAt: cursorTimestampSchema, id: z.int().positive() });

export type HistoryQuery = z.infer<typeof historyQuery>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type HistoryListResponse = z.infer<typeof historyListResponse>;
export type HistoryCursor = z.infer<typeof historyCursor>;
