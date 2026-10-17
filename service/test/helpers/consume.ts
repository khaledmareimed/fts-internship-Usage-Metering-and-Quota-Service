import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import type { ErrorBody } from '../../src/errors.js';
import type { ConsumeResponse } from '../../src/modules/consume/schemas.js';

export interface ConsumeRequest {
  requestId: string;
  userId: string;
  units: number;
}

export type ConsumeResult =
  | { status: 200; body: ConsumeResponse; raw: string }
  | { status: number; body: ErrorBody; raw: string };

export async function consume(app: App, apiKey: string, payload: ConsumeRequest): Promise<ConsumeResult> {
  const res = await app.inject({ method: 'POST', url: '/v1/consume', headers: { 'x-api-key': apiKey }, payload });
  return { status: res.statusCode, body: res.json(), raw: res.body };
}

/** Consume that must succeed with 200 (accepted or rejected); returns the decision. */
export async function consumeOk(app: App, apiKey: string, payload: ConsumeRequest): Promise<ConsumeResponse> {
  const result = await consume(app, apiKey, payload);
  if (result.status !== 200) throw new Error(`consume failed: ${result.status} ${result.raw}`);
  return result.body as ConsumeResponse;
}

interface TotalsRow extends Record<string, unknown> {
  scope: string;
  used: number;
  sum_accepted: number;
  accepted_count: number;
  n_accepted: number;
  rejected_count: number;
  n_rejected: number;
}

/**
 * The totals check (TESTING.md §3): for every month, the account's and each user's counters equal
 * what the requests history says. Speed without exact totals does not count.
 */
export async function expectExactTotals(db: Db, accountId: string): Promise<void> {
  const { rows } = await db.execute<TotalsRow>(sql`
    WITH history AS (
      SELECT user_id, date_trunc('month', created_at AT TIME ZONE 'UTC')::date AS month, units, accepted
      FROM requests WHERE account_id = ${accountId}
    )
    SELECT 'account' AS scope, au.used::int AS used,
           COALESCE(SUM(h.units) FILTER (WHERE h.accepted), 0)::int AS sum_accepted,
           au.accepted_count, COUNT(h.*) FILTER (WHERE h.accepted)::int AS n_accepted,
           au.rejected_count, COUNT(h.*) FILTER (WHERE NOT h.accepted)::int AS n_rejected
    FROM account_usage au LEFT JOIN history h ON h.month = au.month
    WHERE au.account_id = ${accountId}
    GROUP BY au.month, au.used, au.accepted_count, au.rejected_count
    UNION ALL
    SELECT 'user ' || u.external_id, uu.used::int,
           COALESCE(SUM(h.units) FILTER (WHERE h.accepted), 0)::int,
           uu.accepted_count, COUNT(h.*) FILTER (WHERE h.accepted)::int,
           uu.rejected_count, COUNT(h.*) FILTER (WHERE NOT h.accepted)::int
    FROM user_usage uu JOIN users u ON u.id = uu.user_id
    LEFT JOIN history h ON h.user_id = uu.user_id AND h.month = uu.month
    WHERE u.account_id = ${accountId}
    GROUP BY u.external_id, uu.month, uu.used, uu.accepted_count, uu.rejected_count
  `);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect({ scope: row.scope, used: row.used, accepted: row.accepted_count, rejected: row.rejected_count }).toEqual({
      scope: row.scope,
      used: row.sum_accepted,
      accepted: row.n_accepted,
      rejected: row.n_rejected,
    });
  }
}
