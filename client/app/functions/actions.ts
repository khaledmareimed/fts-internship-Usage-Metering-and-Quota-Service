'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { consume, updatePlan, updateUser } from '../../lib/api/endpoints';
import { ApiError } from '../../lib/api/http';
import { ensureDemo, resetDemo } from '../../lib/api/demo';
import type { FormState, ProcessState } from '../types/state';

function positiveInt(value: FormDataEntryValue | null): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  console.error(err);
  return 'Something went wrong. Please try again.';
}

/** "Process document": one consume call with a fresh requestId. */
export async function processDocument(_prev: ProcessState, form: FormData): Promise<ProcessState> {
  const userId = String(form.get('userId') ?? '');
  const units = positiveInt(form.get('units'));
  if (!userId || units === null) return { status: 'error', message: 'Pick a user and enter a whole number of units (1 or more).' };
  try {
    const { apiKey } = await ensureDemo();
    const result = await consume(apiKey, { requestId: randomUUID(), userId, units });
    revalidatePath('/');
    return { status: 'decided', result };
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
    return { status: 'ok', message: `${user.userId} is now on ${user.plan.name}.` };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function editDemoPlan(_prev: FormState, form: FormData): Promise<FormState> {
  const monthlyLimit = positiveInt(form.get('monthlyLimit'));
  const perRequestLimit = positiveInt(form.get('perRequestLimit'));
  if (monthlyLimit === null || perRequestLimit === null) {
    return { status: 'error', message: 'Limits must be whole numbers, 1 or more.' };
  }
  try {
    const { apiKey, demoPlanId } = await ensureDemo();
    const plan = await updatePlan(apiKey, demoPlanId, { monthlyLimit, perRequestLimit });
    revalidatePath('/');
    return { status: 'ok', message: `Saved: ${plan.name} is now ${plan.monthlyLimit}/month, ${plan.perRequestLimit}/request.` };
  } catch (err) {
    return { status: 'error', message: errorMessage(err) };
  }
}

export async function resetDemoAction(): Promise<void> {
  await resetDemo();
  revalidatePath('/');
}
