'use client';

import { useState } from 'react';
import type { HistoryItem } from '../../types/api';
import { formatUnits, ruleLabel } from '../functions/format';
import styles from './HistoryList.module.css';

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
});

interface Props {
  items: HistoryItem[];
  users: { userId: string; name: string }[];
  selectedUserId?: string;
  selectedMonth?: string;
}

export function HistoryList({ items, users, selectedUserId, selectedMonth }: Props) {
  const [inspectedId, setInspectedId] = useState<string | null>(null);

  return (
    <div>
      {/* Filter Bar */}
      <form method="GET" style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select name="userId" defaultValue={selectedUserId ?? ''} style={{ padding: '0.4rem', borderRadius: '4px' }}>
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.userId} value={u.userId}>
              {u.name} ({u.userId})
            </option>
          ))}
        </select>

        <input
          name="month"
          type="text"
          placeholder="Month (YYYY-MM)"
          defaultValue={selectedMonth ?? ''}
          pattern="^\d{4}-\d{2}$"
          style={{ padding: '0.4rem', borderRadius: '4px', maxWidth: '140px' }}
        />

        <button type="submit" style={{ padding: '0.4rem 0.8rem', borderRadius: '4px', cursor: 'pointer' }}>
          Filter
        </button>
        {(selectedUserId || selectedMonth) && (
          <a href="/" style={{ padding: '0.4rem 0.8rem', textDecoration: 'none', color: '#666' }}>
            Clear filters
          </a>
        )}
      </form>

      {items.length === 0 ? (
        <p className={styles.empty}>No matching decisions found.</p>
      ) : (
        <ol className={styles.list}>
          {items.map((item) => {
            const isInspected = inspectedId === item.requestId;
            return (
              <li key={item.requestId} className={styles.item} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span className={item.accepted ? styles.accepted : styles.rejected}>
                      {item.accepted ? 'Accepted' : 'Rejected'}
                    </span>
                    <span className={styles.what}>
                      <strong>{item.userId}</strong> · {formatUnits(item.units)} units
                      {item.failedRules.length > 0 && (
                        <span className={styles.why}> — {item.failedRules.map(ruleLabel).join('; ')}</span>
                      )}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <button
                      type="button"
                      onClick={() => setInspectedId(isInspected ? null : item.requestId)}
                      style={{ fontSize: '0.75rem', padding: '2px 6px', cursor: 'pointer' }}
                    >
                      {isInspected ? 'Hide details' : 'Inspect'}
                    </button>
                    <time className={styles.time} dateTime={item.createdAt}>
                      {timeFormat.format(new Date(item.createdAt))} UTC
                    </time>
                  </div>
                </div>

                {/* Inspect Details Box */}
                {isInspected && (
                  <div
                    style={{
                      marginTop: '0.5rem',
                      padding: '0.6rem',
                      background: 'rgba(0,0,0,0.05)',
                      borderRadius: '4px',
                      fontSize: '0.8rem',
                      fontFamily: 'monospace',
                    }}
                  >
                    <div><strong>Request ID:</strong> {item.requestId}</div>
                    <div><strong>Company Plan:</strong> {item.limits.account.planName} (limit: {item.limits.account.monthlyLimit}, remaining: {item.accountRemaining})</div>
                    <div><strong>User Plan:</strong> {item.limits.user.planName} (limit: {item.limits.user.monthlyLimit}, remaining: {item.userRemaining})</div>
                    {item.failedRules.length > 0 && (
                      <div style={{ color: '#ef4444', marginTop: '0.2rem' }}>
                        <strong>Failures:</strong> {JSON.stringify(item.failedRules)}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
