import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client.js';
import { accounts, accountUsage, plans } from '../../db/schema.js';
import { periodFields, targetMonth } from '../../lib/month.js';

export type AccountRecord = typeof accounts.$inferSelect;

export async function findAuthByKeyHash(db: Db, apiKeyHash: string) {
  const [account] = await db
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.apiKeyHash, apiKeyHash));
  return account;
}

export async function insertAccount(
  tx: Tx,
  values: { name: string; apiKeyHash: string; planId: string },
): Promise<AccountRecord> {
  const [account] = await tx.insert(accounts).values(values).returning();
  if (!account) throw new Error('insert into accounts returned no row');
  return account;
}

export async function updateAccountPlan(tx: Tx, accountId: string, planId: string): Promise<void> {
  await tx
    .update(accounts)
    .set({ planId, updatedAt: sql`now()` })
    .where(eq(accounts.id, accountId));
}

/** Account + its plan + its usage row for `month` (YYYY-MM-01, default: current month), in one query. */
export async function getAccountWithUsage(db: Db, accountId: string, month: string | undefined) {
  const target = targetMonth(month);
  const [row] = await db
    .select({
      account: { id: accounts.id, name: accounts.name, isActive: accounts.isActive },
      plan: getTableColumns(plans),
      period: periodFields(target),
      // null when the account has no usage row for that month
      usage: {
        used: accountUsage.used,
        storedLimit: accountUsage.monthlyLimit,
        acceptedCount: accountUsage.acceptedCount,
        rejectedCount: accountUsage.rejectedCount,
      },
    })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .leftJoin(accountUsage, and(eq(accountUsage.accountId, accounts.id), eq(accountUsage.month, target)))
    .where(eq(accounts.id, accountId));
  return row;
}
