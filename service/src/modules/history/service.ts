import type { Db } from '../../db/client.js';
import { AppError } from '../../errors.js';
import { isFutureMonth } from '../../lib/month.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { findUserId } from '../users/repo.js';
import { findHistoryItem, historyQuery, type HistoryRow } from './repo.js';
import { historyCursor, type HistoryItem, type HistoryListResponse, type HistoryQuery } from './schemas.js';

function toHistoryItem(row: HistoryRow): HistoryItem {
  return {
    requestId: row.requestId,
    userId: row.userId,
    units: row.units,
    accepted: row.accepted,
    failedRules: row.failedRules,
    // Rows decided before the rate-limit rule have no rateLimitPerMinute in their snapshot: it was none.
    limits: {
      account: { ...row.limits.account, rateLimitPerMinute: row.limits.account.rateLimitPerMinute ?? null },
      user: { ...row.limits.user, rateLimitPerMinute: row.limits.user.rateLimitPerMinute ?? null },
    },
    accountRemaining: row.accountRemaining,
    userRemaining: row.userRemaining,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listHistory(db: Db, accountId: string, query: HistoryQuery): Promise<HistoryListResponse> {
  let userId: string | undefined;
  if (query.userId !== undefined) {
    userId = await findUserId(db, accountId, query.userId);
    if (!userId) {
      throw new AppError('USER_NOT_FOUND', `User '${query.userId}' not found in this account`, { userId: query.userId });
    }
  }
  if (query.month !== undefined && (await isFutureMonth(db, query.month))) {
    throw new AppError('VALIDATION_ERROR', 'month must not be in the future', { month: query.month.slice(0, 7) });
  }
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, historyCursor);

  const rows = await historyQuery(db, accountId, { userId, month: query.month, after, limit: query.limit });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toHistoryItem),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ createdAt: last.cursorAt, id: last.id }) : null,
  };
}

export async function getHistoryItem(db: Db, accountId: string, requestId: string): Promise<HistoryItem> {
  const row = await findHistoryItem(db, accountId, requestId);
  if (!row) throw new AppError('REQUEST_NOT_FOUND', `Request '${requestId}' not found`, { requestId });
  return toHistoryItem(row);
}
