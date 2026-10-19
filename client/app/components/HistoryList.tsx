import type { HistoryItem } from '../../types/api';
import { formatUnits, ruleLabel } from '../functions/format';
import styles from './HistoryList.module.css';

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });

export function HistoryList({ items }: { items: HistoryItem[] }) {
  if (items.length === 0) return <p className={styles.empty}>No decisions yet. Process a document to start.</p>;
  return (
    <ol className={styles.list}>
      {items.map((item) => (
        <li key={item.requestId} className={styles.item}>
          <span className={item.accepted ? styles.accepted : styles.rejected}>{item.accepted ? 'Accepted' : 'Rejected'}</span>
          <span className={styles.what}>
            <strong>{item.userId}</strong> · {formatUnits(item.units)} units
            {item.failedRules.length > 0 && (
              <span className={styles.why}> — {item.failedRules.map(ruleLabel).join('; ')}</span>
            )}
          </span>
          <time className={styles.time} dateTime={item.createdAt}>
            {time.format(new Date(item.createdAt))} UTC
          </time>
        </li>
      ))}
    </ol>
  );
}
