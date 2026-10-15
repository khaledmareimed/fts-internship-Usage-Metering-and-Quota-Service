import { z } from 'zod';
import { monthParam } from '../../lib/month.js';
import { usageSchema } from '../../lib/usage.js';
import { planSchema } from '../plans/schemas.js';

export const createAccountBody = z.strictObject({
  name: z.string().min(1).max(100),
  planId: z.uuid(),
});

export const createAccountResponse = z.object({
  accountId: z.uuid(),
  name: z.string(),
  apiKey: z.string(),
  plan: planSchema,
  createdAt: z.iso.datetime(),
});

export const accountQuery = z.object({ month: monthParam.optional() });

export const changePlanBody = z.strictObject({ planId: z.uuid() });

export const accountResponse = z.object({
  accountId: z.uuid(),
  name: z.string(),
  isActive: z.boolean(),
  plan: planSchema,
  usage: usageSchema,
});

export type CreateAccountBody = z.infer<typeof createAccountBody>;
export type CreateAccountResponse = z.infer<typeof createAccountResponse>;
export type AccountResponse = z.infer<typeof accountResponse>;
