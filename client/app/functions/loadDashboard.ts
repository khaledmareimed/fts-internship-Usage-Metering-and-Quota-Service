import 'server-only';
import { getAccount, getPlan, getUser, listRecentRequests, listUserPlans } from '../../lib/api/endpoints';
import { DEMO_USERS, ensureDemo } from '../../lib/api/demo';
import type { AccountView, HistoryItem, Plan, UserView } from '../../types/api';

export interface Dashboard {
  account: AccountView;
  users: (UserView & { name: string })[];
  userPlans: Plan[];
  demoPlan: Plan;
  history: HistoryItem[];
}

/** Everything the page shows, fetched in parallel from the service. */
export async function loadDashboard(): Promise<Dashboard> {
  const { apiKey, demoPlanId } = await ensureDemo();
  const [account, users, userPlans, demoPlan, history] = await Promise.all([
    getAccount(apiKey),
    Promise.all(DEMO_USERS.map(async (u) => ({ ...(await getUser(apiKey, u.userId)), name: u.name }))),
    listUserPlans(apiKey),
    getPlan(apiKey, demoPlanId),
    listRecentRequests(apiKey, 10),
  ]);
  return { account, users, userPlans: userPlans.items, demoPlan, history: history.items };
}
