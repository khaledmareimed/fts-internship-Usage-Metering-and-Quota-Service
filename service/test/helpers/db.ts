import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, inject } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { migrateAndSeed } from '../../src/db/migrate.js';

/** Connection URL for a database inside the shared test container. */
export function connectionUrlFor(database: string): string {
  const url = new URL(inject('databaseUrl'));
  url.pathname = `/${database}`;
  return url.toString();
}

/** Creates an empty, uniquely named database; its pool is closed after the test file. */
export async function createEmptyDatabase(poolMax = 4): Promise<{ name: string; handle: DbHandle }> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = createDb(inject('databaseUrl'), { poolMax: 1 });
  try {
    // Identifiers can't be parameters; the name is generated above, never user input.
    await admin.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  } finally {
    await admin.pool.end();
  }
  const handle = createDb(connectionUrlFor(name), { poolMax });
  afterAll(async () => {
    if (!handle.pool.ended) await handle.pool.end();
  });
  return { name, handle };
}

/** A fresh database with all migrations applied and predefined plans seeded. */
export async function createTestDatabase(poolMax = 4): Promise<DbHandle> {
  const { handle } = await createEmptyDatabase(poolMax);
  await migrateAndSeed(handle);
  return handle;
}
