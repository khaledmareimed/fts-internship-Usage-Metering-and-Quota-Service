const UNIQUE_VIOLATION = '23505';

interface PgError {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/** True if Postgres rejected the write on this unique constraint (Drizzle wraps the pg error in `cause`). */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e instanceof Error; e = (e as PgError).cause) {
    const pg = e as PgError;
    if (pg.code === UNIQUE_VIOLATION && pg.constraint === constraint) return true;
  }
  return false;
}
