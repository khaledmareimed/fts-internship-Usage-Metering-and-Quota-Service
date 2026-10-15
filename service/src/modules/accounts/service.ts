import { generateApiKey, hashApiKey } from '../../auth/apiKey.js';
import type { Db } from '../../db/client.js';
import { AppError } from '../../errors.js';
import { toUsage } from '../../lib/usage.js';
import { lockAssignablePlan } from '../plans/repo.js';
import { toPlan } from '../plans/schemas.js';
import { assertAssignable } from '../plans/service.js';
import { getAccountWithUsage, insertAccount, updateAccountPlan } from './repo.js';
import type { AccountResponse, CreateAccountBody, CreateAccountResponse } from './schemas.js';

export async function createAccount(db: Db, input: CreateAccountBody): Promise<CreateAccountResponse> {
  return db.transaction(async (tx) => {
    // No account yet, so only predefined plans can match.
    const plan = assertAssignable(await lockAssignablePlan(tx, null, input.planId), input.planId, 'account');
    const apiKey = generateApiKey();
    const account = await insertAccount(tx, { name: input.name, apiKeyHash: hashApiKey(apiKey), planId: plan.id });
    return {
      accountId: account.id,
      name: account.name,
      apiKey,
      plan: toPlan(plan),
      createdAt: account.createdAt.toISOString(),
    };
  });
}

/** `month` is YYYY-MM-01; omitted means the current month (database clock). */
export async function getAccount(db: Db, accountId: string, month?: string): Promise<AccountResponse> {
  const row = await getAccountWithUsage(db, accountId, month);
  // Auth already proved the account exists.
  if (!row) throw new Error(`account ${accountId} vanished after auth`);
  if (row.period.isFuture) {
    throw new AppError('VALIDATION_ERROR', 'month must not be in the future', { month: row.period.month });
  }
  return {
    accountId: row.account.id,
    name: row.account.name,
    isActive: row.account.isActive,
    plan: toPlan(row.plan),
    usage: toUsage(row.period, row.usage, row.plan.monthlyLimit),
  };
}

/** Switches the account plan; usage is kept (no fresh allowance). */
export async function changeAccountPlan(db: Db, accountId: string, planId: string): Promise<AccountResponse> {
  await db.transaction(async (tx) => {
    const plan = assertAssignable(await lockAssignablePlan(tx, accountId, planId), planId, 'account');
    await updateAccountPlan(tx, accountId, plan.id);
  });
  return getAccount(db, accountId);
}
