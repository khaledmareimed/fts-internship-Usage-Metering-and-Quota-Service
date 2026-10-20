'use client';

import { useActionState } from 'react';
import type { Plan, UserView } from '../../types/api';
import { registerUser, switchUserPlan, toggleUserStatus } from '../functions/actions';
import { type FormState, IDLE } from '../types/state';
import styles from './forms.module.css';

interface Props {
  users: (UserView & { name: string })[];
  userPlans: Plan[];
}

function Feedback({ state }: { state: FormState }) {
  if (state.status === 'idle') return null;
  return <p className={state.status === 'ok' ? styles.ok : styles.error}>{state.message}</p>;
}

export function UserManagement({ users, userPlans }: Props) {
  const [registerState, registerAction, registering] = useActionState<FormState, FormData>(registerUser, IDLE);
  const [switchState, switchAction, switching] = useActionState<FormState, FormData>(switchUserPlan, IDLE);
  const [toggleState, toggleAction, toggling] = useActionState<FormState, FormData>(toggleUserStatus, IDLE);

  return (
    <div className={styles.stack}>
      {/* 1. Register a new user */}
      <form action={registerAction} className={styles.form}>
        <h3 className={styles.heading}>Register new user</h3>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>User ID</span>
            <input name="userId" type="text" placeholder="e.g. omar-42" required maxLength={128} />
          </label>
          <label className={styles.field}>
            <span>Initial plan</span>
            <select name="planId" defaultValue={userPlans[0]?.planId}>
              {userPlans.map((p) => (
                <option key={p.planId} value={p.planId}>
                  {p.name} ({p.monthlyLimit.toLocaleString('en-US')}/mo)
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" className={styles.secondary} disabled={registering}>
          {registering ? 'Registering…' : 'Add user'}
        </button>
        <div aria-live="polite">
          <Feedback state={registerState} />
        </div>
      </form>

      {/* 2. Switch existing user's plan */}
      <form action={switchAction} className={styles.form}>
        <h3 className={styles.heading}>Switch a user's plan</h3>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>User</span>
            <select name="userId" defaultValue={users[0]?.userId}>
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.name} ({u.plan.name})
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

      {/* 3. Toggle user Active / Inactive */}
      <form action={toggleAction} className={styles.form}>
        <h3 className={styles.heading}>Toggle user status</h3>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>User</span>
            <select name="userId" defaultValue={users[0]?.userId}>
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.name} — currently {u.isActive ? 'Active' : 'Inactive'}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Status</span>
            <select name="isActive" defaultValue="false">
              <option value="true">Active</option>
              <option value="false">Inactive (blocks consumption)</option>
            </select>
          </label>
        </div>
        <button type="submit" className={styles.secondary} disabled={toggling}>
          {toggling ? 'Updating…' : 'Update status'}
        </button>
        <div aria-live="polite">
          <Feedback state={toggleState} />
        </div>
      </form>
    </div>
  );
}
