import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Executor } from '../db/client.js';
import { z } from 'zod';

/** `?month=YYYY-MM` (UTC month). Parses to the first day, `YYYY-MM-01`, as stored in usage rows. */
export const monthParam = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month as YYYY-MM')
  .transform((month) => `${month}-01`);

// The month comes from the database clock, never the app server.
export const CURRENT_MONTH = sql`date_trunc('month', now() AT TIME ZONE 'UTC')::date`;

/** The current UTC minute (the rate-limit window), same database clock. */
export const CURRENT_MINUTE = sql`(date_trunc('minute', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/** The requested month (YYYY-MM-01) as SQL, or the current month when omitted. */
export function targetMonth(month: string | undefined): SQL {
  return month === undefined ? CURRENT_MONTH : sql`${month}::date`;
}

/** Select fields describing `target` relative to the current month. */
export function periodFields(target: SQL) {
  return {
    month: sql<string>`to_char(${target}, 'YYYY-MM')`,
    isCurrent: sql<boolean>`${target} = ${CURRENT_MONTH}`,
    isFuture: sql<boolean>`${target} > ${CURRENT_MONTH}`,
  };
}

/** Is `month` (YYYY-MM-01) after the current month by the database clock? */
export async function isFutureMonth(db: Executor, month: string): Promise<boolean> {
  const { rows } = await db.execute<{ future: boolean }>(sql`SELECT ${month}::date > ${CURRENT_MONTH} AS future`);
  return rows[0]?.future === true;
}

/** `column` falls inside the UTC month that starts on `month` (YYYY-MM-01): a plain range, index-friendly. */
export function inMonth(column: SQL | AnyColumn, month: string): SQL {
  return sql`${column} >= (${month}::date::timestamp AT TIME ZONE 'UTC')
    AND ${column} < ((${month}::date + interval '1 month')::timestamp AT TIME ZONE 'UTC')`;
}
