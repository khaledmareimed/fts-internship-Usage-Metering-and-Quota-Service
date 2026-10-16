import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors.js';

/** `?limit=` for list endpoints: 1–100, default 20. */
export const limitParam = z.coerce.number().int().min(1).max(100).default(20);

/**
 * A timestamptz as UTC text with microseconds, for cursors: a JS Date rounds to milliseconds,
 * which would skip or repeat rows that differ only in microseconds.
 */
export function cursorTimestamp(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Validates a cursorTimestamp value coming back from a client. */
export const cursorTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((ts) => !Number.isNaN(Date.parse(ts)));

/** Opaque cursor: base64url of the JSON position after the last item of a page. */
export function encodeCursor(position: object): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

/** Decodes a cursor from the client; anything malformed is a 400, never a 500. */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    // not base64url JSON: fall through to the 400 below
  }
  throw new AppError('VALIDATION_ERROR', 'Invalid cursor', { cursor });
}
