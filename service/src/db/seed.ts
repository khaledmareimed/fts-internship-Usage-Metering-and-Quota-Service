import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import type { PLAN_TYPES } from './schema.js';

export interface PredefinedPlan {
  id: string;
  name: string;
  type: (typeof PLAN_TYPES)[number];
  monthlyLimit: number;
  perRequestLimit: number;
}

// From docs/DECISIONS.md → Plans. Fixed, well-known ids (docs/API.md) so a company can be created
// without looking a plan up first.
export const PREDEFINED_PLANS: readonly PredefinedPlan[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Starter', type: 'account', monthlyLimit: 10_000, perRequestLimit: 100 },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Pro', type: 'account', monthlyLimit: 100_000, perRequestLimit: 1_000 },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Basic', type: 'user', monthlyLimit: 1_000, perRequestLimit: 20 },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Premium', type: 'user', monthlyLimit: 10_000, perRequestLimit: 200 },
];

/**
 * Inserts missing predefined plans; existing ones are left untouched, so restarts change nothing.
 * Fails loudly if a database seeded before the ids were fixed has different ones.
 */
export async function seedPredefinedPlans(db: Db): Promise<void> {
  const rows = PREDEFINED_PLANS.map(
    (p) => sql`(${p.id}::uuid, NULL, ${p.name}, ${p.type}, ${p.monthlyLimit}, ${p.perRequestLimit})`,
  );
  // NULLS NOT DISTINCT on (account_id, name) makes the conflict fire for NULL account_id.
  await db.execute(sql`
    INSERT INTO plans (id, account_id, name, type, monthly_limit, per_request_limit)
    VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (account_id, name) DO NOTHING
  `);

  const { rows: stored } = await db.execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM plans WHERE account_id IS NULL`,
  );
  const wrong = PREDEFINED_PLANS.filter((p) => !stored.some((s) => s.id === p.id && s.name === p.name));
  if (wrong.length > 0) {
    throw new Error(
      `Predefined plans ${wrong.map((p) => p.name).join(', ')} have unexpected ids. ` +
        'This database was seeded before the ids were fixed; recreate it (docker compose down -v).',
    );
  }
}
