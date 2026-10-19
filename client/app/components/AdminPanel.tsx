'use client';

import { useActionState } from 'react';
import type { Plan } from '../../types/api';
import { editDemoPlan, switchUserPlan } from '../functions/actions';
import { type FormState, IDLE } from '../types/state';
import styles from './forms.module.css';

interface Props {
  users: { userId: string; name: string; planId: string }[];
  userPlans: Plan[];
  demoPlan: Plan;
}

function Feedback({ state }: { state: FormState }) {
  if (state.status === 'idle') return null;
  return <p className={state.status === 'ok' ? styles.ok : styles.error}>{state.message}</p>;
}

export function AdminPanel({ users, userPlans, demoPlan }: Props) {
  const [switchState, switchAction, switching] = useActionState<FormState, FormData>(switchUserPlan, IDLE);
  const [planState, planAction, saving] = useActionState<FormState, FormData>(editDemoPlan, IDLE);

  return (
    <div className={styles.stack}>
      <form action={switchAction} className={styles.form}>
        <h3 className={styles.heading}>Switch a user's plan</h3>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>User</span>
            <select name="userId" defaultValue={users[0]?.userId}>
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.name} ({userPlans.find((p) => p.planId === u.planId)?.name ?? 'custom'})
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>New plan</span>
            <select name="planId" defaultValue={userPlans[0]?.planId}>
              {userPlans.map((p) => (
                <option key={p.planId} value={p.planId}>
                  {p.name} ({p.monthlyLimit.toLocaleString('en-US')}/mo)
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" className={styles.secondary} disabled={switching}>
          {switching ? 'Saving…' : 'Switch plan'}
        </button>
        <div aria-live="polite">
          <Feedback state={switchState} />
        </div>
      </form>

      <form action={planAction} className={styles.form}>
        <h3 className={styles.heading}>Edit “{demoPlan.name}” (company plan)</h3>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Monthly limit</span>
            <input name="monthlyLimit" type="number" min={1} step={1} defaultValue={demoPlan.monthlyLimit} required />
          </label>
          <label className={styles.field}>
            <span>Per request</span>
            <input name="perRequestLimit" type="number" min={1} step={1} defaultValue={demoPlan.perRequestLimit} required />
          </label>
        </div>
        <button type="submit" className={styles.secondary} disabled={saving}>
          {saving ? 'Saving…' : 'Save limits'}
        </button>
        <div aria-live="polite">
          <Feedback state={planState} />
        </div>
      </form>
    </div>
  );
}
