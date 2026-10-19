import 'server-only';
import type { CreatedAccount, Plan } from '../../types/api';
import { request } from './http';

// Fixed ids of the predefined plans (docs/API.md → Plans).
export const PREDEFINED = {
  starter: '00000000-0000-4000-8000-000000000001',
  basic: '00000000-0000-4000-8000-000000000003',
  premium: '00000000-0000-4000-8000-000000000004',
} as const;

export const DEMO_USERS = [
  { userId: 'ali', name: 'Ali', planId: PREDEFINED.basic },
  { userId: 'sara', name: 'Sara', planId: PREDEFINED.premium },
] as const;

export interface Demo {
  apiKey: string;
  demoPlanId: string;
}

function adminKey(): string {
  const key = process.env.ADMIN_KEY;
  if (!key) throw new Error('ADMIN_KEY is not set');
  return key;
}

/** Creates "Acme Docs" on the custom plan "Demo Team" (100/month, 60/request) with Ali and Sara (docs/DEMO.md). */
async function seedDemo(): Promise<Demo> {
  const account = await request<CreatedAccount>('/v1/accounts', {
    method: 'POST',
    adminKey: adminKey(),
    body: { name: 'Acme Docs', planId: PREDEFINED.starter },
  });
  const apiKey = account.apiKey;
  const plan = await request<Plan>('/v1/plans', {
    method: 'POST',
    apiKey,
    body: { name: 'Demo Team', type: 'account', monthlyLimit: 100, perRequestLimit: 60 },
  });
  await request('/v1/account', { method: 'PATCH', apiKey, body: { planId: plan.planId } });
  for (const user of DEMO_USERS) {
    await request('/v1/users', { method: 'POST', apiKey, body: { userId: user.userId, planId: user.planId } });
  }
  return { apiKey, demoPlanId: plan.planId };
}

// shortcut: the demo key lives in this server's memory; a restart (or a second client instance) creates
// a new demo company. Fine for a demo; a real app would store its key in a secret store.
let current: Promise<Demo> | null = null;

/** The demo company, created on first use. One in-flight promise, so parallel first requests seed once. */
export function ensureDemo(): Promise<Demo> {
  current ??= seedDemo().catch((err: unknown) => {
    current = null;
    throw err;
  });
  return current;
}

/** "Reset demo": nothing may be deleted, so a brand-new demo company replaces the old one. */
export async function resetDemo(): Promise<void> {
  current = null;
  await ensureDemo();
}
