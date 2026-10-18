import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { requests, users } from '../../db/schema.js';
import { inMonth } from '../../lib/month.js';
import { cursorTimestamp } from '../../lib/pagination.js';
import type { HistoryCursor } from './schemas.js';

export interface HistoryFilters {
  userId?: string | undefined; // internal users.id
  month?: string | undefined; // YYYY-MM-01
  after?: HistoryCursor | undefined;
  limit: number;
}

function selectHistory(db: Db) {
  return db
    .select({
      id: requests.id,
      requestId: requests.requestId,
      userId: users.externalId,
      units: requests.units,
      accepted: requests.accepted,
      failedRules: requests.failedRules,
      limits: requests.limitsSnapshot,
      accountRemaining: requests.accountRemaining,
      userRemaining: requests.userRemaining,
      createdAt: requests.createdAt,
      cursorAt: cursorTimestamp(requests.createdAt),
    })
    .from(requests)
    .innerJoin(users, eq(users.id, requests.userId));
}

export type HistoryRow = NonNullable<Awaited<ReturnType<typeof findHistoryItem>>>;

/**
 * One page of history, newest first, plus one extra row to tell whether another page exists.
 * Served by requests_history_idx, or requests_user_hist_idx with a user filter (each a single range scan).
 * Returned unexecuted so tests can EXPLAIN the exact SQL.
 */
export function historyQuery(db: Db, accountId: string, filters: HistoryFilters) {
  return selectHistory(db)
    .where(
      and(
        eq(requests.accountId, accountId),
        filters.userId === undefined ? undefined : eq(requests.userId, filters.userId),
        filters.month === undefined ? undefined : inMonth(requests.createdAt, filters.month),
        filters.after &&
          sql`(${requests.createdAt}, ${requests.id}) < (${filters.after.createdAt}::timestamptz, ${filters.after.id})`,
      ),
    )
    .orderBy(desc(requests.createdAt), desc(requests.id))
    .limit(filters.limit + 1);
}

export async function findHistoryItem(db: Db, accountId: string, requestId: string) {
  const [row] = await selectHistory(db).where(
    and(eq(requests.accountId, accountId), eq(requests.requestId, requestId)),
  );
  return row;
}
