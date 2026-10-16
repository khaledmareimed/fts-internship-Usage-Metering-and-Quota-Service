import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { AppError } from '../../errors.js';
import {
  findPlan,
  insertPlan,
  isPlanAssigned,
  isPredefinedName,
  listPlans as listPlanRecords,
  lockPlanForUpdate,
  PLAN_NAME_UNIQUE,
  updatePlan as updatePlanRecord,
} from './repo.js';
import {
  type CreatePlanBody,
  type ListPlansQuery,
  type Plan,
  type PlanRecord,
  type PlanType,
  toPlan,
  type UpdatePlanBody,
} from './schemas.js';

const nameTaken = (name: string) =>
  new AppError('PLAN_NAME_TAKEN', `A plan named '${name}' already exists`, { name });

const notFound = (planId: string) => new AppError('PLAN_NOT_FOUND', `Plan '${planId}' not found`, { planId });

/** Turns a lost race on the (account_id, name) unique key into 409, like the pre-check does. */
async function mapNameClash<T>(name: string | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (name !== undefined && isUniqueViolation(err, PLAN_NAME_UNIQUE)) throw nameTaken(name);
    throw err;
  }
}

/** A plan can be assigned only if it exists for this account, has the right type and is active. */
export function assertAssignable(
  plan: PlanRecord | undefined,
  planId: string,
  type: PlanType,
): PlanRecord {
  if (!plan) throw notFound(planId);
  if (plan.type !== type) {
    throw new AppError('PLAN_TYPE_MISMATCH', `Plan '${plan.name}' is a ${plan.type} plan, expected a ${type} plan`, {
      planId,
      expectedType: type,
      actualType: plan.type,
    });
  }
  if (!plan.isActive) throw new AppError('PLAN_INACTIVE', `Plan '${plan.name}' is inactive`, { planId });
  return plan;
}

export async function listPlans(db: Db, accountId: string, query: ListPlansQuery): Promise<Plan[]> {
  return (await listPlanRecords(db, accountId, query)).map(toPlan);
}

export async function getPlan(db: Db, accountId: string, planId: string): Promise<Plan> {
  const plan = await findPlan(db, accountId, planId);
  if (!plan) throw notFound(planId);
  return toPlan(plan);
}

export async function createPlan(db: Db, accountId: string, input: CreatePlanBody): Promise<Plan> {
  // Predefined names are taken for every company, so the combined plan list stays unambiguous.
  if (await isPredefinedName(db, input.name)) throw nameTaken(input.name);
  return toPlan(await mapNameClash(input.name, () => insertPlan(db, accountId, input)));
}

/** Edits a custom plan. The row is locked FOR UPDATE, so the "still assigned" check can't race an assignment. */
export async function updatePlan(
  db: Db,
  accountId: string,
  planId: string,
  changes: UpdatePlanBody,
): Promise<Plan> {
  const updated = await mapNameClash(changes.name, () =>
    db.transaction(async (tx) => {
      const plan = await lockPlanForUpdate(tx, accountId, planId);
      if (!plan) throw notFound(planId);
      if (plan.accountId === null) {
        throw new AppError('PREDEFINED_PLAN_READ_ONLY', `Predefined plan '${plan.name}' can't be changed`, { planId });
      }
      if (changes.name !== undefined && changes.name !== plan.name && (await isPredefinedName(tx, changes.name))) {
        throw nameTaken(changes.name);
      }
      if (changes.isActive === false && plan.isActive && (await isPlanAssigned(tx, accountId, planId))) {
        throw new AppError('PLAN_IN_USE', `Plan '${plan.name}' is still assigned and can't be deactivated`, { planId });
      }
      return updatePlanRecord(tx, accountId, planId, changes);
    }),
  );
  return toPlan(updated);
}
