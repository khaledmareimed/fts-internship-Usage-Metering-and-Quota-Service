import { ApiError } from '../lib/api/http';
import { AdminPanel } from './components/AdminPanel';
import { HistoryList } from './components/HistoryList';
import { ProcessForm } from './components/ProcessForm';
import { ResetButton } from './components/ResetButton';
import { UsageBars } from './components/UsageBars';
import { type Dashboard, loadDashboard } from './functions/loadDashboard';
import styles from './page.module.css';

// Live usage on every request; never cache.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let data: Dashboard;
  try {
    data = await loadDashboard();
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

  const { account, users, userPlans, demoPlan, history } = data;
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{account.name}</h1>
          <p className={styles.subtitle}>
            Example app on plan <strong>{account.plan.name}</strong> · month {account.usage.month}
          </p>
        </div>
        <ResetButton />
      </header>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="app-title">
          <h2 id="app-title">Process a document</h2>
          <ProcessForm users={users.map((u) => ({ userId: u.userId, name: u.name }))} />
        </section>

        <section className={styles.card} aria-labelledby="usage-title">
          <h2 id="usage-title">Usage this month</h2>
          <UsageBars account={account} users={users} />
        </section>

        <section className={styles.card} aria-labelledby="admin-title">
          <h2 id="admin-title">Admin</h2>
          <AdminPanel
            users={users.map((u) => ({ userId: u.userId, name: u.name, planId: u.plan.planId }))}
            userPlans={userPlans}
            demoPlan={demoPlan}
          />
        </section>

        <section className={`${styles.card} ${styles.wide}`} aria-labelledby="history-title">
          <h2 id="history-title">Last 10 decisions</h2>
          <HistoryList items={history} />
        </section>
      </div>
    </main>
  );
}
