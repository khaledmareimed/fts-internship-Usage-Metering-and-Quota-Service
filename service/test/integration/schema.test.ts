import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/client.js';
import { migrateAndSeed } from '../../src/db/migrate.js';
import { PREDEFINED_PLANS } from '../../src/db/seed.js';
import { connectionUrlFor, createEmptyDatabase } from '../helpers/db.js';

const SCHEMA_SQL = new URL('../../../docs/schema.sql', import.meta.url);

// Everything that defines the public schema, normalized by Postgres itself.
async function describeSchema(db: Db) {
  const q = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows;
  return {
    tables: await q(sql`
      SELECT relname, reloptions FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname`),
    columns: await q(sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default,
             is_identity, identity_generation
      FROM information_schema.columns WHERE table_schema = 'public'
      ORDER BY table_name, column_name`),
    constraints: await q(sql`
      SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      ORDER BY table_name, conname`),
    indexes: await q(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`),
    functions: await q(sql`
      SELECT proname, pg_get_functiondef(oid) AS def
      FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY proname`),
    sequences: await q(sql`
      SELECT sequencename, data_type::text, start_value, increment_by, min_value, max_value, cache_size
      FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`),
  };
}

describe('database schema', () => {
  it('migrations produce exactly docs/schema.sql', async () => {
    const { handle: reference } = await createEmptyDatabase();
    await reference.pool.query(await readFile(SCHEMA_SQL, 'utf8'));
    const { handle: app } = await createEmptyDatabase();
    await migrateAndSeed(app);

    const expected = await describeSchema(reference.db);
    expect(expected.tables).toHaveLength(6);
    expect(expected.functions.map((f) => f.proname)).toEqual(['consume_decide', 'evaluate_rules']);
    expect(await describeSchema(app.db)).toEqual(expected);
  });

  it('fresh start creates 6 tables and the 4 predefined plans', async () => {
    const { handle } = await createEmptyDatabase();
    await migrateAndSeed(handle);
    const { rows: tables } = await handle.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
    expect(tables[0]).toEqual({ n: 6 });

    const { rows: plans } = await handle.db.execute(sql`
      SELECT id, account_id, name, type, monthly_limit::int, per_request_limit, is_active
      FROM plans ORDER BY name`);
    const expected = [...PREDEFINED_PLANS]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        id: p.id,
        account_id: null,
        name: p.name,
        type: p.type,
        monthly_limit: p.monthlyLimit,
        per_request_limit: p.perRequestLimit,
        is_active: true,
      }));
    expect(plans).toEqual(expected);
  });

  it('restart changes nothing', async () => {
    const { handle } = await createEmptyDatabase();
    const snapshot = async () => ({
      plans: (await handle.db.execute(sql`SELECT id, updated_at FROM plans ORDER BY id`)).rows,
      migrations: (await handle.db.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations`)).rows,
    });

    await migrateAndSeed(handle);
    const before = await snapshot();
    await migrateAndSeed(handle);

    expect(before.plans).toHaveLength(4);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to start on a database whose predefined plans have other ids', async () => {
    const { handle } = await createEmptyDatabase();
    await migrateAndSeed(handle);
    await handle.db.execute(sql`UPDATE plans SET id = gen_random_uuid() WHERE name = 'Pro' AND account_id IS NULL`);
    await expect(migrateAndSeed(handle)).rejects.toThrow(/Pro have unexpected ids/);
  });

  it('two instances starting at once both succeed', async () => {
    const { name, handle: first } = await createEmptyDatabase();
    // A second pool on the same database stands in for a second service instance.
    const second = createDb(connectionUrlFor(name), { poolMax: 4 });
    try {
      await Promise.all([migrateAndSeed(first), migrateAndSeed(second)]);
    } finally {
      await second.pool.end();
    }

    const { rows } = await first.db.execute(sql`SELECT count(*)::int AS n FROM plans`);
    expect(rows[0]).toEqual({ n: 4 });
  });
});
