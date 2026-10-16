import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client.js';
import { plans } from '../../db/schema.js';
import type { PlanRecord, PlanType } from './schemas.js';

export const PLAN_NAME_UNIQUE = 'plans_account_id_name_key';

interface PlanRow extends Record<string, unknown> {
  id: string;
  account_id: string | null;
  name: string;
  type: PlanType;
  monthly_limit: string; // pg returns bigint as text
  per_request_limit: number;
  rate_limit_per_minute: number | null;
  is_active: boolean;
  // raw execute() returns timestamptz as text (Drizzle's pg type parsers)
  created_at: string;
  updated_at: string;
}

const PLAN_COLUMNS = sql`id, account_id, name, type, monthly_limit, per_request_limit, rate_limit_per_minute, is_active, created_at, updated_at`;

function toPlanRecord(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    type: row.type,
    monthlyLimit: Number(row.monthly_limit),
    perRequestLimit: row.per_request_limit,
    rateLimitPerMinute: row.rate_limit_per_minute,
    isActive: row.is_active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** Plans this account can see: predefined ones and its own. */
function visibleTo(accountId: string): SQL | undefined {
  return or(isNull(plans.accountId), eq(plans.accountId, accountId));
}

export async function listPlans(
  db: Db,
  accountId: string,
  filter: { type?: PlanType; includeInactive: boolean },
): Promise<PlanRecord[]> {
  return db
    .select()
    .from(plans)
    .where(
      and(
        visibleTo(accountId),
        filter.type && eq(plans.type, filter.type),
        filter.includeInactive ? undefined : eq(plans.isActive, true),
      ),
    )
    // predefined first, then custom; each by name
    .orderBy(asc(sql`${plans.accountId} IS NOT NULL`), asc(plans.name));
}

export async function findPlan(db: Db, accountId: string, planId: string): Promise<PlanRecord | undefined> {
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), visibleTo(accountId)));
  return plan;
}

export async function isPredefinedName(db: Db | Tx, name: string): Promise<boolean> {
  const [plan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(isNull(plans.accountId), eq(plans.name, name)))
    .limit(1);
  return plan !== undefined;
}

export async function insertPlan(
  db: Db,
  accountId: string,
  values: { name: string; type: PlanType; monthlyLimit: number; perRequestLimit: number; rateLimitPerMinute: number | null },
): Promise<PlanRecord> {
  const [plan] = await db
    .insert(plans)
    .values({ accountId, ...values })
    .returning();
  if (!plan) throw new Error('insert into plans returned no row');
  return plan;
}

export async function updatePlan(
  tx: Tx,
  accountId: string,
  planId: string,
  changes: {
    name?: string;
    monthlyLimit?: number;
    perRequestLimit?: number;
    rateLimitPerMinute?: number | null;
    isActive?: boolean;
  },
): Promise<PlanRecord> {
  const [plan] = await tx
    .update(plans)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(and(eq(plans.id, planId), eq(plans.accountId, accountId)))
    .returning();
  if (!plan) throw new Error(`plan ${planId} vanished while locked`);
  return plan;
}

/**
 * Reads a plan the account may use (predefined, or its own custom plan) and holds a
 * FOR SHARE lock until the transaction ends, so the plan can't be deactivated meanwhile.
 * Pass accountId null when the account doesn't exist yet (only predefined plans match).
 */
export async function lockAssignablePlan(
  tx: Tx,
  accountId: string | null,
  planId: string,
): Promise<PlanRecord | undefined> {
  const { rows } = await tx.execute<PlanRow>(sql`
    SELECT ${PLAN_COLUMNS} FROM plans
    WHERE id = ${planId} AND (account_id IS NULL OR account_id = ${accountId})
    FOR SHARE
  `);
  return rows[0] && toPlanRecord(rows[0]);
}

/** Locks a visible plan FOR UPDATE: waits for any assignment holding FOR SHARE, and blocks new ones. */
export async function lockPlanForUpdate(
  tx: Tx,
  accountId: string,
  planId: string,
): Promise<PlanRecord | undefined> {
  const { rows } = await tx.execute<PlanRow>(sql`
    SELECT ${PLAN_COLUMNS} FROM plans
    WHERE id = ${planId} AND (account_id IS NULL OR account_id = ${accountId})
    FOR UPDATE
  `);
  return rows[0] && toPlanRecord(rows[0]);
}

/** Is the plan the company's own plan, or held by any of its users (active or not)? */
export async function isPlanAssigned(tx: Tx, accountId: string, planId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ assigned: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM accounts WHERE id = ${accountId} AND plan_id = ${planId})
        OR EXISTS (SELECT 1 FROM users WHERE account_id = ${accountId} AND plan_id = ${planId})
        AS assigned
  `);
  return rows[0]?.assigned === true;
}
