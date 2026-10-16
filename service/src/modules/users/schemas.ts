import { z } from 'zod';
import { externalIdSchema } from '../../lib/externalId.js';
import { monthParam } from '../../lib/month.js';
import { cursorTimestampSchema, limitParam } from '../../lib/pagination.js';
import { usageSchema } from '../../lib/usage.js';
import { planSchema } from '../plans/schemas.js';

export const userParams = z.object({ userId: externalIdSchema });
export const userQuery = z.object({ month: monthParam.optional() });
export const listUsersQuery = z.object({ limit: limitParam, cursor: z.string().optional() });

export const createUserBody = z.strictObject({ userId: externalIdSchema, planId: z.uuid() });

export const updateUserBody = z
  .strictObject({ planId: z.uuid().optional(), isActive: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });

export const createUserResponse = z.object({
  userId: z.string(),
  isActive: z.boolean(),
  plan: planSchema,
  createdAt: z.iso.datetime(),
});

export const userResponse = z.object({
  userId: z.string(),
  isActive: z.boolean(),
  plan: planSchema,
  usage: usageSchema,
});

export const listUsersResponse = z.object({
  items: z.array(
    z.object({ userId: z.string(), isActive: z.boolean(), planId: z.uuid(), planName: z.string() }),
  ),
  nextCursor: z.string().nullable(),
});

/** Position after the last user of a page (newest first). createdAt keeps microseconds. */
export const userCursor = z.object({ createdAt: cursorTimestampSchema, id: z.uuid() });

export type CreateUserBody = z.infer<typeof createUserBody>;
export type UpdateUserBody = z.infer<typeof updateUserBody>;
export type CreateUserResponse = z.infer<typeof createUserResponse>;
export type UserResponse = z.infer<typeof userResponse>;
export type ListUsersResponse = z.infer<typeof listUsersResponse>;
export type UserCursor = z.infer<typeof userCursor>;
