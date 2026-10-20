import 'server-only';
import {
  getAccount,
  getPlan,
  getUser,
  listAccountPlans,
  listRequests,
  listUserPlans,
  listUsers,
} from '../../lib/api/endpoints';
import { ensureDemo } from '../../lib/api/demo';
import type { AccountView, HistoryItem, Plan, UserView } from '../../types/api';

export interface Dashboard {
  account: AccountView;
  users: (UserView & { name: string })[];
  userPlans: Plan[];
  accountPlans: Plan[];
  demoPlan: Plan;
  history: HistoryItem[];
  selectedMonth?: string;
  selectedUserId?: string;
}

/** Everything the page shows, fetched from the service. */
export async function loadDashboard(options?: {
  month?: string;
  userId?: string;
}): Promise<Dashboard> {
  const { apiKey, demoPlanId } = await ensureDemo();
  const [account, usersPage, userPlans, accountPlans, demoPlan, history] = await Promise.all([
    getAccount(apiKey, options?.month),
    listUsers(apiKey, { limit: 100 }),
    listUserPlans(apiKey),
    listAccountPlans(apiKey),
    getPlan(apiKey, demoPlanId),
    listRequests(apiKey, { limit: 20, month: options?.month, userId: options?.userId }),
  ]);

  const fullUsers = await Promise.all(
    usersPage.items.map(async (u) => {
      const userView = await getUser(apiKey, u.userId, options?.month);
      const displayName = u.userId.charAt(0).toUpperCase() + u.userId.slice(1);
      return { ...userView, name: displayName };
    })
  );

  return {
    account,
    users: fullUsers,
    userPlans: userPlans.items,
    accountPlans: accountPlans.items,
    demoPlan,
    history: history.items,
    selectedMonth: options?.month,
    selectedUserId: options?.userId,
  };
}
