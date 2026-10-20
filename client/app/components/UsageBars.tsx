import type { AccountView, UserView } from '../../types/api';
import { formatUnits, usagePercent } from '../functions/format';
import styles from './UsageBars.module.css';

interface Bar {
  label: string;
  used: number;
  limit: number;
  remaining: number;
  perRequestLimit: number;
  rateLimitPerMinute: number | null;
  acceptedCount: number;
  rejectedCount: number;
  isActive?: boolean;
}

function UsageBar({
  label,
  used,
  limit,
  remaining,
  perRequestLimit,
  rateLimitPerMinute,
  acceptedCount,
  rejectedCount,
  isActive = true,
}: Bar) {
  const percent = usagePercent(used, limit);
  return (
    <li className={styles.item}>
      <div className={styles.labels}>
        <span className={styles.name}>
          {label} {!isActive && <strong style={{ color: '#ef4444' }}>[INACTIVE]</strong>}
        </span>
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
      <div style={{ fontSize: '0.78rem', color: '#888', marginTop: '3px', display: 'flex', justifyContent: 'space-between' }}>
        <span>
          Max {formatUnits(perRequestLimit)}/req{rateLimitPerMinute ? ` · ${rateLimitPerMinute}/min rate limit` : ''}
        </span>
        <span>
          ✓ {acceptedCount} accepted · ✗ {rejectedCount} rejected
        </span>
      </div>
    </li>
  );
}

export function UsageBars({ account, users }: { account: AccountView; users: (UserView & { name: string })[] }) {
  const bars: Bar[] = [
    {
      label: `Company (${account.plan.name})`,
      used: account.usage.used,
      limit: account.plan.monthlyLimit,
      remaining: account.usage.remaining,
      perRequestLimit: account.plan.perRequestLimit,
      rateLimitPerMinute: account.plan.rateLimitPerMinute,
      acceptedCount: account.usage.acceptedCount,
      rejectedCount: account.usage.rejectedCount,
      isActive: account.isActive,
    },
    ...users.map((u) => ({
      label: `${u.name} (${u.plan.name})`,
      used: u.usage.used,
      limit: u.plan.monthlyLimit,
      remaining: u.usage.remaining,
      perRequestLimit: u.plan.perRequestLimit,
      rateLimitPerMinute: u.plan.rateLimitPerMinute,
      acceptedCount: u.usage.acceptedCount,
      rejectedCount: u.usage.rejectedCount,
      isActive: u.isActive,
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
