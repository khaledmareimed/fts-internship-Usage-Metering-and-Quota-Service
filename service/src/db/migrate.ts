import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import type { DbHandle } from './client.js';
import { seedPredefinedPlans } from './seed.js';

// service/drizzle, from both src/db (tests, tsx) and dist/db (Docker).
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
// Arbitrary constant shared by every service instance.
const MIGRATION_LOCK_ID = 7_301_001;

/** Applies pending migrations and seeds predefined plans; safe when several instances start at once. */
export async function migrateAndSeed({ pool }: DbHandle): Promise<void> {
  const client = await pool.connect();
  try {
    // Session-level lock held on this one connection, so all work below must use it.
    const db = drizzle(client);
    await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`);
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await seedPredefinedPlans(db);
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
    }
  } finally {
    client.release();
  }
}
