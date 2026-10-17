import { and, eq, isNull, sql } from 'drizzle-orm';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { plans } from '../../src/db/schema.js';
import { TEST_ADMIN_KEY } from './app.js';

export async function planIdByName(db: Db, name: string): Promise<string> {
  const [plan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.name, name), isNull(plans.accountId)));
  if (!plan) throw new Error(`predefined plan '${name}' not found`);
  return plan.id;
}

/** Creates a company through the real admin endpoint. */
export async function createAccount(app: App, db: Db, planName = 'Starter', name = 'Acme Docs') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: { 'x-admin-key': TEST_ADMIN_KEY },
    payload: { name, planId: await planIdByName(db, planName) },
  });
  if (res.statusCode !== 201) throw new Error(`createAccount failed: ${res.statusCode} ${res.body}`);
  const body: { accountId: string; apiKey: string } = res.json();
  return { accountId: body.accountId, apiKey: body.apiKey };
}

export interface NewPlan {
  name: string;
  type: 'account' | 'user';
  monthlyLimit: number;
  perRequestLimit: number;
  rateLimitPerMinute?: number | null;
}

/** Creates a custom plan through the real endpoint; returns its id. */
export async function createPlan(app: App, apiKey: string, plan: NewPlan): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/plans', headers: { 'x-api-key': apiKey }, payload: plan });
  if (res.statusCode !== 201) throw new Error(`createPlan failed: ${res.statusCode} ${res.body}`);
  const body: { planId: string } = res.json();
  return body.planId;
}

export async function setPlanActive(app: App, apiKey: string, planId: string, isActive: boolean) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/plans/${planId}`,
    headers: { 'x-api-key': apiKey },
    payload: { isActive },
  });
}

/** Registers a user through the real endpoint. */
export async function createUser(app: App, apiKey: string, userId: string, planId: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/users',
    headers: { 'x-api-key': apiKey },
    payload: { userId, planId },
  });
  if (res.statusCode !== 201) throw new Error(`createUser failed: ${res.statusCode} ${res.body}`);
}

// Raw usage rows: only for past months or values consume can't produce (the DB clock decides the month).
/** Writes an account usage row directly. `month` is YYYY-MM. */
export async function insertAccountUsage(
  db: Db,
  accountId: string,
  month: string,
  values: { used: number; monthlyLimit: number; acceptedCount?: number; rejectedCount?: number },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO account_usage (account_id, month, used, monthly_limit, accepted_count, rejected_count)
    VALUES (${accountId}, ${`${month}-01`}::date, ${values.used}, ${values.monthlyLimit},
            ${values.acceptedCount ?? 0}, ${values.rejectedCount ?? 0})
  `);
}

/** Writes a user usage row directly (see shortcut above). `month` is YYYY-MM. */
export async function insertUserUsage(
  db: Db,
  accountId: string,
  externalId: string,
  month: string,
  values: { used: number; monthlyLimit: number; acceptedCount?: number; rejectedCount?: number },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_usage (user_id, month, used, monthly_limit, accepted_count, rejected_count)
    SELECT id, ${`${month}-01`}::date, ${values.used}, ${values.monthlyLimit},
           ${values.acceptedCount ?? 0}, ${values.rejectedCount ?? 0}
    FROM users WHERE account_id = ${accountId} AND external_id = ${externalId}
  `);
}

/** The current UTC month by the database clock, as YYYY-MM. */
export async function currentMonth(db: Db): Promise<string> {
  const { rows } = await db.execute<{ month: string }>(
    sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS month`,
  );
  return rows[0]!.month;
}
