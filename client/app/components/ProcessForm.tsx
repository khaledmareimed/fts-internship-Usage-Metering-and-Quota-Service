'use client';

import { useActionState } from 'react';
import { processDocument } from '../functions/actions';
import { IDLE, type ProcessState } from '../types/state';
import { Decision } from './Decision';
import styles from './forms.module.css';

interface Props {
  users: { userId: string; name: string }[];
}

export function ProcessForm({ users }: Props) {
  const [state, action, pending] = useActionState<ProcessState, FormData>(processDocument, IDLE);
  return (
    <form action={action} className={styles.form}>
      <div className={styles.row}>
        <label className={styles.field}>
          <span>User</span>
          <select name="userId" defaultValue={users[0]?.userId}>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Units</span>
          <input name="units" type="number" min={1} step={1} defaultValue={10} required inputMode="numeric" />
        </label>
      </div>
      <button type="submit" className={styles.primary} disabled={pending}>
        {pending ? 'Processing…' : 'Process document'}
      </button>
      <div aria-live="polite">
        {state.status === 'decided' && <Decision result={state.result} />}
        {state.status === 'error' && <p className={styles.error}>{state.message}</p>}
      </div>
    </form>
  );
}
