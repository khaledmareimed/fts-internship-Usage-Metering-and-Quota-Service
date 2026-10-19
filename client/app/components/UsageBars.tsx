import type { AccountView, UserView } from '../../types/api';
import { formatUnits, usagePercent } from '../functions/format';
import styles from './UsageBars.module.css';

interface Bar {
  label: string;
  used: number;
  limit: number;
  remaining: number;
}

function UsageBar({ label, used, limit, remaining }: Bar) {
  const percent = usagePercent(used, limit);
  return (
    <li className={styles.item}>
      <div className={styles.labels}>
        <span className={styles.name}>{label}</span>
        <span>
          {formatUnits(used)} / {formatUnits(limit)} · {formatUnits(remaining)} left
        </span>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={percent >= 100 ? styles.full : styles.fill} style={{ width: `${percent}%` }} />
      </div>
    </li>
  );
}

export function UsageBars({ account, users }: { account: AccountView; users: (UserView & { name: string })[] }) {
  const bars: Bar[] = [
    { label: `Company (${account.plan.name})`, used: account.usage.used, limit: account.plan.monthlyLimit, remaining: account.usage.remaining },
    ...users.map((u) => ({
      label: `${u.name} (${u.plan.name})`,
      used: u.usage.used,
      limit: u.plan.monthlyLimit,
      remaining: u.usage.remaining,
    })),
  ];
  return (
    <ul className={styles.list}>
      {bars.map((bar) => (
        <UsageBar key={bar.label} {...bar} />
      ))}
    </ul>
  );
}
