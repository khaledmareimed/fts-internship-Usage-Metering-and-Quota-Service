import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { AppError } from '../../errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { toUsage } from '../../lib/usage.js';
import { lockAssignablePlan } from '../plans/repo.js';
import { toPlan } from '../plans/schemas.js';
import { assertAssignable } from '../plans/service.js';
import { findUserId, getUserWithUsage, insertUser, listUsers as listUserRows, updateUser as updateUserRow, USER_ID_UNIQUE } from './repo.js';
import {
  type CreateUserBody,
  type CreateUserResponse,
  type ListUsersResponse,
  type UpdateUserBody,
  userCursor,
  type UserResponse,
} from './schemas.js';

const userNotFound = (userId: string) =>
  new AppError('USER_NOT_FOUND', `User '${userId}' not found in this account`, { userId });

export async function createUser(db: Db, accountId: string, input: CreateUserBody): Promise<CreateUserResponse> {
  try {
    return await db.transaction(async (tx) => {
      // FOR SHARE: the plan can't be deactivated until this assignment commits.
      const plan = assertAssignable(await lockAssignablePlan(tx, accountId, input.planId), input.planId, 'user');
      const user = await insertUser(tx, accountId, { externalId: input.userId, planId: plan.id });
      return {
        userId: user.externalId,
        isActive: user.isActive,
        plan: toPlan(plan),
        createdAt: user.createdAt.toISOString(),
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, USER_ID_UNIQUE)) {
      throw new AppError('USER_ALREADY_EXISTS', `User '${input.userId}' already exists`, { userId: input.userId });
    }
    throw err;
  }
}

export async function listUsers(
  db: Db,
  accountId: string,
  query: { limit: number; cursor?: string | undefined },
): Promise<ListUsersResponse> {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, userCursor);
  const rows = await listUserRows(db, accountId, query.limit, after);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ userId, isActive, planId, planName }) => ({ userId, isActive, planId, planName })),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/** `month` is YYYY-MM-01; omitted means the current month (database clock). */
export async function getUser(db: Db, accountId: string, userId: string, month?: string): Promise<UserResponse> {
  const row = await getUserWithUsage(db, accountId, userId, month);
  if (!row) throw userNotFound(userId);
  if (row.period.isFuture) {
    throw new AppError('VALIDATION_ERROR', 'month must not be in the future', { month: row.period.month });
  }
  return {
    userId: row.user.externalId,
    isActive: row.user.isActive,
    plan: toPlan(row.plan),
    usage: toUsage(row.period, row.usage, row.plan.monthlyLimit),
  };
}

/** Changes plan and/or active flag; usage is kept (no fresh allowance). */
export async function updateUser(
  db: Db,
  accountId: string,
  userId: string,
  changes: UpdateUserBody,
): Promise<UserResponse> {
  await db.transaction(async (tx) => {
    const id = await findUserId(tx, accountId, userId);
    if (!id) throw userNotFound(userId);
    if (changes.planId !== undefined) {
      assertAssignable(await lockAssignablePlan(tx, accountId, changes.planId), changes.planId, 'user');
    }
    await updateUserRow(tx, accountId, id, changes);
  });
  return getUser(db, accountId, userId);
}
