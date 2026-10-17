// Consume SQL (docs/CONSUME.md). Raw `sql` only: row locks, ON CONFLICT, exact control.
// Raw results come back as text for bigint and timestamptz, so every reader maps them.
import { sql } from 'drizzle-orm';
import type { Executor, Tx } from '../../db/client.js';
import type { FailedRule, LimitsSnapshot } from '../../domain/rules.js';
import { CURRENT_MINUTE, CURRENT_MONTH } from '../../lib/month.js';
import type { ConsumeContext, StoredRequest } from './schemas.js';

export const REQUEST_ID_UNIQUE = 'requests_account_id_request_id_key';

interface ContextRow extends Record<string, unknown> {
  user_id: string;
  user_is_active: boolean;
  user_plan_name: string;
  user_monthly_limit: string;
  user_per_request_limit: number;
  user_rate_limit: number | null;
  account_plan_name: string;
  account_monthly_limit: string;
  account_per_request_limit: number;
  account_rate_limit: number | null;
}

interface RequestRow extends Record<string, unknown> {
  request_id: string;
  user_id: string;
  external_user_id: string;
  units: number;
  accepted: boolean;
  failed_rules: FailedRule[];
  limits_snapshot: LimitsSnapshot;
  account_used: string;
  user_used: string;
  account_remaining: string;
  user_remaining: string;
  month: string;
  created_at: string;
}

function toStoredRequest(row: RequestRow): StoredRequest {
  return {
    requestId: row.request_id,
    userId: row.user_id,
    externalUserId: row.external_user_id,
    units: row.units,
    accepted: row.accepted,
    failedRules: row.failed_rules,
    limitsSnapshot: row.limits_snapshot,
    accountUsed: Number(row.account_used),
    userUsed: Number(row.user_used),
    accountRemaining: Number(row.account_remaining),
    userRemaining: Number(row.user_remaining),
    month: row.month,
    createdAt: new Date(row.created_at),
  };
}

interface LoadRow extends ContextRow {
  // ex_* = the request already stored under this requestId (all null when there is none)
  ex_request_id: string | null;
}

function toContext(row: ContextRow): ConsumeContext {
  return {
    userId: row.user_id,
    userIsActive: row.user_is_active,
    userPlan: {
      planName: row.user_plan_name,
      monthlyLimit: Number(row.user_monthly_limit),
      perRequestLimit: row.user_per_request_limit,
      rateLimitPerMinute: row.user_rate_limit,
    },
    accountPlan: {
      planName: row.account_plan_name,
      monthlyLimit: Number(row.account_monthly_limit),
      perRequestLimit: row.account_per_request_limit,
      rateLimitPerMinute: row.account_rate_limit,
    },
  };
}

function existingRequest(row: LoadRow): StoredRequest | undefined {
  if (row.ex_request_id === null) return undefined;
  // Every requests column is NOT NULL, so once ex_request_id is set all ex_* columns are a full RequestRow.
  const columns = Object.entries(row).filter(([key]) => key.startsWith('ex_'));
  return toStoredRequest(Object.fromEntries(columns.map(([key, value]) => [key.slice(3), value])) as RequestRow);
}

/**
 * Fast path 1–2 in one lock-free read: the user, its plan and the account's plan (current rows),
 * plus any request already stored under this requestId. undefined = unknown user.
 */
export async function loadContext(
  db: Executor,
  accountId: string,
  externalUserId: string,
  requestId: string,
): Promise<{ ctx: ConsumeContext; existing: StoredRequest | undefined } | undefined> {
  const { rows } = await db.execute<LoadRow>(sql`
    SELECT u.id AS user_id, u.is_active AS user_is_active,
           up.name AS user_plan_name, up.monthly_limit AS user_monthly_limit,
           up.per_request_limit AS user_per_request_limit, up.rate_limit_per_minute AS user_rate_limit,
           ap.name AS account_plan_name, ap.monthly_limit AS account_monthly_limit,
           ap.per_request_limit AS account_per_request_limit, ap.rate_limit_per_minute AS account_rate_limit,
           ex.request_id AS ex_request_id, ex.user_id AS ex_user_id, ex.external_user_id AS ex_external_user_id,
           ex.units AS ex_units, ex.accepted AS ex_accepted, ex.failed_rules AS ex_failed_rules,
           ex.limits_snapshot AS ex_limits_snapshot, ex.account_used AS ex_account_used,
           ex.user_used AS ex_user_used, ex.account_remaining AS ex_account_remaining,
           ex.user_remaining AS ex_user_remaining, ex.month AS ex_month, ex.created_at AS ex_created_at
    FROM users u
    JOIN plans up ON up.id = u.plan_id
    JOIN accounts a ON a.id = u.account_id
    JOIN plans ap ON ap.id = a.plan_id
    LEFT JOIN LATERAL (
      SELECT r.request_id, r.user_id, ru.external_id AS external_user_id, r.units, r.accepted, r.failed_rules,
             r.limits_snapshot, r.account_used, r.user_used, r.account_remaining, r.user_remaining,
             to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, r.created_at
      FROM requests r JOIN users ru ON ru.id = r.user_id
      WHERE r.account_id = ${accountId} AND r.request_id = ${requestId}
    ) ex ON true
    WHERE u.account_id = ${accountId} AND u.external_id = ${externalUserId}
  `);
  const row = rows[0];
  return row && { ctx: toContext(row), existing: existingRequest(row) };
}

export async function findRequest(
  db: Executor,
  accountId: string,
  requestId: string,
): Promise<StoredRequest | undefined> {
  const { rows } = await db.execute<RequestRow>(sql`
    SELECT r.request_id, r.user_id, u.external_id AS external_user_id, r.units, r.accepted,
           r.failed_rules, r.limits_snapshot, r.account_used, r.user_used,
           r.account_remaining, r.user_remaining,
           to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, r.created_at
    FROM requests r JOIN users u ON u.id = r.user_id
    WHERE r.account_id = ${accountId} AND r.request_id = ${requestId}
  `);
  return rows[0] && toStoredRequest(rows[0]);
}

interface DecideRow extends RequestRow {
  outcome: 'decided' | 'existing';
}

/**
 * The locked decision (CONSUME.md steps 1–9) as ONE autocommit statement: the consume_decide() SQL
 * function locks the account row, then the user row, and releases both when this statement commits.
 * undefined = unknown user; 'existing' = this requestId was already decided.
 */
export async function consumeDecide(
  db: Executor,
  accountId: string,
  body: { requestId: string; userId: string; units: number },
): Promise<{ outcome: DecideRow['outcome']; stored: StoredRequest } | undefined> {
  const { rows } = await db.execute<DecideRow>(sql`
    SELECT * FROM consume_decide(${accountId}::uuid, ${body.requestId}, ${body.userId}, ${body.units})
  `);
  const row = rows[0];
  return row && { outcome: row.outcome, stored: toStoredRequest(row) };
}

export interface UsageNow {
  accountUsed: number;
  userUsed: number;
  accountCountThisMinute: number;
  userCountThisMinute: number;
}

/** Fast path: this month's usage and this minute's counts, without locks (only to report failures). */
export async function readUsage(tx: Tx, accountId: string, userId: string): Promise<UsageNow> {
  const { rows } = await tx.execute<{ account_used: string; user_used: string; account_count: number; user_count: number }>(sql`
    SELECT COALESCE(au.used, 0) AS account_used, COALESCE(uu.used, 0) AS user_used,
           CASE WHEN au.window_start = ${CURRENT_MINUTE} THEN au.window_count ELSE 0 END AS account_count,
           CASE WHEN uu.window_start = ${CURRENT_MINUTE} THEN uu.window_count ELSE 0 END AS user_count
    FROM (SELECT 1) one
    LEFT JOIN account_usage au ON au.account_id = ${accountId} AND au.month = ${CURRENT_MONTH}
    LEFT JOIN user_usage uu ON uu.user_id = ${userId} AND uu.month = ${CURRENT_MONTH}
  `);
  const row = rows[0];
  return {
    accountUsed: Number(row?.account_used ?? 0),
    userUsed: Number(row?.user_used ?? 0),
    accountCountThisMinute: row?.account_count ?? 0,
    userCountThisMinute: row?.user_count ?? 0,
  };
}

/** Fast path: count one rejection. Rows are locked only for this one statement each (account, then user). */
export async function upsertRejectedCounters(
  tx: Tx,
  accountId: string,
  userId: string,
  limits: { accountLimit: number; userLimit: number },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO account_usage (account_id, month, monthly_limit, rejected_count)
    VALUES (${accountId}, ${CURRENT_MONTH}, ${limits.accountLimit}, 1)
    ON CONFLICT (account_id, month) DO UPDATE
    SET rejected_count = account_usage.rejected_count + 1, monthly_limit = EXCLUDED.monthly_limit, updated_at = now()
  `);
  await tx.execute(sql`
    INSERT INTO user_usage (user_id, month, monthly_limit, rejected_count)
    VALUES (${userId}, ${CURRENT_MONTH}, ${limits.userLimit}, 1)
    ON CONFLICT (user_id, month) DO UPDATE
    SET rejected_count = user_usage.rejected_count + 1, monthly_limit = EXCLUDED.monthly_limit, updated_at = now()
  `);
}

export interface NewRequest {
  accountId: string;
  requestId: string;
  userId: string;
  externalUserId: string;
  units: number;
  accepted: boolean;
  failedRules: FailedRule[];
  limitsSnapshot: LimitsSnapshot;
  accountUsed: number;
  userUsed: number;
  accountRemaining: number;
  userRemaining: number;
}

/** Saves the decision. A duplicate (account_id, request_id) raises 23505 (REQUEST_ID_UNIQUE). */
export async function insertRequest(tx: Tx, r: NewRequest): Promise<StoredRequest> {
  const { rows } = await tx.execute<RequestRow>(sql`
    INSERT INTO requests (account_id, request_id, user_id, units, accepted, failed_rules, limits_snapshot,
                          account_remaining, user_remaining, account_used, user_used)
    VALUES (${r.accountId}, ${r.requestId}, ${r.userId}, ${r.units}, ${r.accepted},
            ${JSON.stringify(r.failedRules)}::jsonb, ${JSON.stringify(r.limitsSnapshot)}::jsonb,
            ${r.accountRemaining}, ${r.userRemaining}, ${r.accountUsed}, ${r.userUsed})
    RETURNING request_id, user_id, ${r.externalUserId}::text AS external_user_id, units, accepted,
              failed_rules, limits_snapshot, account_used, user_used, account_remaining, user_remaining,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, created_at
  `);
  const row = rows[0];
  if (!row) throw new Error('insert into requests returned no row');
  return toStoredRequest(row);
}
