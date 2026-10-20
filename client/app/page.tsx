import { ApiError } from '../lib/api/http';
import { AdminPanel } from './components/AdminPanel';
import { HistoryList } from './components/HistoryList';
import { ProcessForm } from './components/ProcessForm';
import { ResetButton } from './components/ResetButton';
import { UsageBars } from './components/UsageBars';
import { UserManagement } from './components/UserManagement';
import { type Dashboard, loadDashboard } from './functions/loadDashboard';
import styles from './page.module.css';

// Live usage on every request; never cache.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams?: Promise<{ month?: string; userId?: string }>;
}

export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  let data: Dashboard;

  try {
    data = await loadDashboard({ month: params?.month, userId: params?.userId });
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Unexpected error while loading the demo.';
    return (
      <main className={styles.main}>
        <h1 className={styles.title}>Usage Metering — Demo</h1>
        <p role="alert" className={styles.banner}>
          {message} Check that the service is running, then reload.
        </p>
      </main>
    );
  }

  const { account, users, userPlans, accountPlans, demoPlan, history, selectedMonth, selectedUserId } = data;
  const customPlans = [...accountPlans, ...userPlans].filter((p) => !p.predefined);

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{account.name}</h1>
          <p className={styles.subtitle}>
            Company Plan: <strong>{account.plan.name}</strong> · Calendar Month: <strong>{account.usage.month}</strong>
          </p>
        </div>
        <ResetButton />
      </header>

      <div className={styles.grid}>
        {/* 1. Process document / consume */}
        <section className={styles.card} aria-labelledby="app-title">
          <h2 id="app-title">Process a document</h2>
          <ProcessForm users={users.map((u) => ({ userId: u.userId, name: u.name }))} />
        </section>

        {/* 2. Live usage bars */}
        <section className={styles.card} aria-labelledby="usage-title">
          <h2 id="usage-title">Usage & Quotas ({account.usage.month})</h2>
          <UsageBars account={account} users={users} />
        </section>

        {/* 3. User Management */}
        <section className={styles.card} aria-labelledby="users-title">
          <h2 id="users-title">User Management</h2>
          <UserManagement users={users} userPlans={userPlans} />
        </section>

        {/* 4. Company & Custom Plans */}
        <section className={styles.card} aria-labelledby="admin-title">
          <h2 id="admin-title">Plans & Company Admin</h2>
          <AdminPanel
            currentAccountPlanId={account.plan.planId}
            accountPlans={accountPlans}
            customPlans={customPlans}
            demoPlan={demoPlan}
          />
        </section>

        {/* 5. Decision History with Filters & Inspection */}
        <section className={`${styles.card} ${styles.wide}`} aria-labelledby="history-title">
          <h2 id="history-title">Decision History & Query Inspector</h2>
          <HistoryList
            items={history}
            users={users.map((u) => ({ userId: u.userId, name: u.name }))}
            selectedUserId={selectedUserId}
            selectedMonth={selectedMonth}
          />
        </section>
      </div>
    </main>
  );
}
