import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Db = NodePgDatabase;
/** A transaction handle; repo functions that must run inside one take this. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either; for reads that run both inside and outside a transaction. */
export type Executor = Db | Tx;

export interface DbHandle {
  pool: pg.Pool;
  db: Db;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface DbOptions {
  poolMax: number;
  connectTimeoutMs?: number;
}

export function createDb(
  connectionString: string,
  { poolMax, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS }: DbOptions,
): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: poolMax,
    // Bounds both opening a connection to an unreachable DB and waiting for a free pool slot under load,
    // so callers never hang forever. A refused connection (DB down) still fails immediately.
    connectionTimeoutMillis: connectTimeoutMs,
  });
  // Without a listener, an idle client dropped by the server crashes the process.
  pool.on('error', (err) => console.error('postgres pool error:', err.message));
  return { pool, db: drizzle(pool) };
}
