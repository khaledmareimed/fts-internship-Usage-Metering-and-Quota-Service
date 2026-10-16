import { z } from 'zod';
import { PLAN_TYPES, type plans } from '../../db/schema.js';

export type PlanRecord = typeof plans.$inferSelect;
export type PlanType = (typeof PLAN_TYPES)[number];

/** The Plan object from docs/API.md. */
export const planSchema = z.object({
  planId: z.uuid(),
  name: z.string(),
  type: z.enum(PLAN_TYPES),
  monthlyLimit: z.number().int(),
  perRequestLimit: z.number().int(),
  rateLimitPerMinute: z.number().int().nullable(),
  predefined: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Plan = z.infer<typeof planSchema>;

export function toPlan(plan: PlanRecord): Plan {
  return {
    planId: plan.id,
    name: plan.name,
    type: plan.type,
    monthlyLimit: plan.monthlyLimit,
    perRequestLimit: plan.perRequestLimit,
    rateLimitPerMinute: plan.rateLimitPerMinute,
    predefined: plan.accountId === null,
    isActive: plan.isActive,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

const planName = z.string().trim().min(1).max(100);
// monthly_limit is bigint (kept as a JS number, exact up to 2^53); per_request_limit is int4.
const monthlyLimit = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const perRequestLimit = z.int().min(1).max(2_147_483_647);
// accepted requests per UTC minute; null = no rate limit
const rateLimitPerMinute = z.int().min(1).max(2_147_483_647).nullable();

export const planIdParams = z.object({ planId: z.uuid() });

export const listPlansQuery = z.object({
  type: z.enum(PLAN_TYPES).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const listPlansResponse = z.object({ items: z.array(planSchema) });

export const createPlanBody = z.strictObject({
  name: planName,
  type: z.enum(PLAN_TYPES),
  monthlyLimit,
  perRequestLimit,
  rateLimitPerMinute: rateLimitPerMinute.default(null),
});

// `type` is not here on purpose: a plan's type can't change (strict → 400).
export const updatePlanBody = z
  .strictObject({
    name: planName.optional(),
    monthlyLimit: monthlyLimit.optional(),
    perRequestLimit: perRequestLimit.optional(),
    rateLimitPerMinute: rateLimitPerMinute.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });

export type ListPlansQuery = z.infer<typeof listPlansQuery>;
export type CreatePlanBody = z.infer<typeof createPlanBody>;
export type UpdatePlanBody = z.infer<typeof updatePlanBody>;
