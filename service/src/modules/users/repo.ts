import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Db, Executor, Tx } from '../../db/client.js';
import { plans, users, userUsage } from '../../db/schema.js';
import { periodFields, targetMonth } from '../../lib/month.js';
import { cursorTimestamp } from '../../lib/pagination.js';
import type { UserCursor } from './schemas.js';

export const USER_ID_UNIQUE = 'users_account_id_external_id_key';

export type UserRecord = typeof users.$inferSelect;

export async function insertUser(
  tx: Tx,
  accountId: string,
  values: { externalId: string; planId: string },
): Promise<UserRecord> {
  const [user] = await tx
    .insert(users)
    .values({ accountId, ...values })
    .returning();
  if (!user) throw new Error('insert into users returned no row');
  return user;
}

export async function findUserId(tx: Executor, accountId: string, externalId: string): Promise<string | undefined> {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId)));
  return user?.id;
}

export async function updateUser(
  tx: Tx,
  accountId: string,
  userId: string,
  changes: { planId?: string; isActive?: boolean },
): Promise<void> {
  await tx
    .update(users)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(and(eq(users.accountId, accountId), eq(users.id, userId)));
}

/** One page, newest first, plus one extra row to tell whether another page exists. Uses users_list_idx. */
export async function listUsers(db: Db, accountId: string, limit: number, after: UserCursor | undefined) {
  return db
    .select({
      id: users.id,
      userId: users.externalId,
      isActive: users.isActive,
      planId: users.planId,
      planName: plans.name,
      createdAt: cursorTimestamp(users.createdAt),
    })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.planId))
    .where(
      and(
        eq(users.accountId, accountId),
        after && sql`(${users.createdAt}, ${users.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
      ),
    )
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit + 1);
}

/** User + plan + its usage row for `month` (YYYY-MM-01, default: current month), in one query. */
export async function getUserWithUsage(db: Db, accountId: string, externalId: string, month: string | undefined) {
  const target = targetMonth(month);
  const [row] = await db
    .select({
      user: { externalId: users.externalId, isActive: users.isActive },
      plan: getTableColumns(plans),
      period: periodFields(target),
      // null when the user has no usage row for that month
      usage: {
        used: userUsage.used,
        storedLimit: userUsage.monthlyLimit,
        acceptedCount: userUsage.acceptedCount,
        rejectedCount: userUsage.rejectedCount,
      },
    })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.planId))
    .leftJoin(userUsage, and(eq(userUsage.userId, users.id), eq(userUsage.month, target)))
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId)));
  return row;
}
