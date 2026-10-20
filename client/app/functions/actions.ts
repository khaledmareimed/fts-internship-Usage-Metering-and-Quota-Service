'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  consume,
  createPlan,
  createUser,
  updateAccount,
  updatePlan,
  updateUser,
} from '../../lib/api/endpoints';
import { ApiError } from '../../lib/api/http';
import { ensureDemo, resetDemo } from '../../lib/api/demo';
import type { FormState, ProcessState } from '../types/state';

function positiveInt(value: FormDataEntryValue | null): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function optionalPositiveInt(value: FormDataEntryValue | null): number | null | undefined {
  if (!value || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  console.error(err);
  return 'Something went wrong. Please try again.';
}

/** "Process document": consume call with optional caller-supplied requestId to test retries/replays. */
export async function processDocument(_prev: ProcessState, form: FormData): Promise<ProcessState> {
  const userId = String(form.get('userId') ?? '');
  const units = positiveInt(form.get('units'));
  const customRequestId = String(form.get('requestId') ?? '').trim();
  const requestId = customRequestId || randomUUID();

  if (!userId || units === null) {
    return { status: 'error', message: 'Pick a user and enter a whole number of units (1 or more).' };
  }

  try {
    const { apiKey } = await ensureDemo();
    const result = await consume(apiKey, { requestId, userId, units });
    revalidatePath('/');
    return { status: 'decided', result };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function registerUser(_prev: FormState, form: FormData): Promise<FormState> {
  const userId = String(form.get('userId') ?? '').trim();
  const planId = String(form.get('planId') ?? '').trim();

  if (!userId || !planId) return { status: 'error', message: 'Enter a user ID and pick a plan.' };

  try {
    const { apiKey } = await ensureDemo();
    const user = await createUser(apiKey, { userId, planId });
    revalidatePath('/');
    return { status: 'ok', message: `User '${user.userId}' registered with plan '${user.plan.name}'.` };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function toggleUserStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const userId = String(form.get('userId') ?? '');
  const activeStr = String(form.get('isActive') ?? '');
  const isActive = activeStr === 'true';

  if (!userId) return { status: 'error', message: 'User ID is required.' };

  try {
    const { apiKey } = await ensureDemo();
    const user = await updateUser(apiKey, userId, { isActive });
    revalidatePath('/');
    return { status: 'ok', message: `User '${user.userId}' is now ${user.isActive ? 'Active' : 'Inactive'}.` };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function switchUserPlan(_prev: FormState, form: FormData): Promise<FormState> {
  const userId = String(form.get('userId') ?? '');
  const planId = String(form.get('planId') ?? '');

  if (!userId || !planId) return { status: 'error', message: 'Pick a user and a plan.' };

  try {
    const { apiKey } = await ensureDemo();
    const user = await updateUser(apiKey, userId, { planId });
    revalidatePath('/');
    return { status: 'ok', message: `'${user.userId}' switched to plan '${user.plan.name}'.` };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function switchAccountPlan(_prev: FormState, form: FormData): Promise<FormState> {
  const planId = String(form.get('planId') ?? '');
  if (!planId) return { status: 'error', message: 'Pick an account plan.' };

  try {
    const { apiKey } = await ensureDemo();
    const account = await updateAccount(apiKey, { planId });
    revalidatePath('/');
    return { status: 'ok', message: `Company plan switched to '${account.plan.name}'.` };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function createCustomPlanAction(_prev: FormState, form: FormData): Promise<FormState> {
  const name = String(form.get('name') ?? '').trim();
  const type = String(form.get('type') ?? '') as 'account' | 'user';
  const monthlyLimit = positiveInt(form.get('monthlyLimit'));
  const perRequestLimit = positiveInt(form.get('perRequestLimit'));
  const rawRate = form.get('rateLimitPerMinute');
  const rateLimitPerMinute = optionalPositiveInt(rawRate);

  if (!name || (type !== 'account' && type !== 'user') || monthlyLimit === null || perRequestLimit === null) {
    return { status: 'error', message: 'Fill in name, type, and positive limits.' };
  }

  try {
    const { apiKey } = await ensureDemo();
    const plan = await createPlan(apiKey, {
      name,
      type,
      monthlyLimit,
      perRequestLimit,
      rateLimitPerMinute: rateLimitPerMinute ?? null,
    });
    revalidatePath('/');
    return { status: 'ok', message: `Custom plan '${plan.name}' (${plan.type}) created.` };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function editPlanLimits(_prev: FormState, form: FormData): Promise<FormState> {
  const planId = String(form.get('planId') ?? '');
  const monthlyLimit = positiveInt(form.get('monthlyLimit'));
  const perRequestLimit = positiveInt(form.get('perRequestLimit'));
  const rawRate = form.get('rateLimitPerMinute');
  const rateLimitPerMinute = optionalPositiveInt(rawRate);

  if (!planId || monthlyLimit === null || perRequestLimit === null) {
    return { status: 'error', message: 'Plan and positive integer limits are required.' };
  }

  try {
    const { apiKey } = await ensureDemo();
    const plan = await updatePlan(apiKey, planId, {
      monthlyLimit,
      perRequestLimit,
      rateLimitPerMinute: rateLimitPerMinute ?? null,
    });
    revalidatePath('/');
    return {
      status: 'ok',
      message: `Plan '${plan.name}' updated: ${plan.monthlyLimit}/month, ${plan.perRequestLimit}/request${
        plan.rateLimitPerMinute ? `, ${plan.rateLimitPerMinute}/min` : ''
      }.`,
    };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function resetDemoAction(): Promise<void> {
  await resetDemo();
  revalidatePath('/');
}
