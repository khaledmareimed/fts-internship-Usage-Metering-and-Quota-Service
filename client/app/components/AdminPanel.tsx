'use client';

import { type ChangeEvent, useActionState, useState } from 'react';
import type { Plan } from '../../types/api';
import {
  createCustomPlanAction,
  editPlanLimits,
  switchAccountPlan,
} from '../functions/actions';
import { type FormState, IDLE } from '../types/state';
import styles from './forms.module.css';

interface Props {
  currentAccountPlanId: string;
  accountPlans: Plan[];
  customPlans: Plan[];
  demoPlan: Plan;
}

function Feedback({ state }: { state: FormState }) {
  if (state.status === 'idle') return null;
  return <p className={state.status === 'ok' ? styles.ok : styles.error}>{state.message}</p>;
}

export function AdminPanel({
  currentAccountPlanId,
  accountPlans,
  customPlans,
  demoPlan,
}: Props) {
  const [switchAccState, switchAccAction, switchingAcc] = useActionState<FormState, FormData>(
    switchAccountPlan,
    IDLE
  );
  const [createPlanState, createPlanAction, creatingPlan] = useActionState<FormState, FormData>(
    createCustomPlanAction,
    IDLE
  );
  const [editPlanState, editPlanAction, editingPlan] = useActionState<FormState, FormData>(
    editPlanLimits,
    IDLE
  );

  const editablePlans = customPlans.length > 0 ? customPlans : [demoPlan];
  const [selectedEditPlanId, setSelectedEditPlanId] = useState<string>(editablePlans[0]?.planId ?? '');
  const activeEditPlan = editablePlans.find((p) => p.planId === selectedEditPlanId) ?? editablePlans[0];

  return (
    <div className={styles.stack}>
      {/* 1. Switch Company Plan */}
      <form action={switchAccAction} className={styles.form}>
        <h3 className={styles.heading}>Switch company plan</h3>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Account plan</span>
            <select name="planId" defaultValue={currentAccountPlanId}>
              {accountPlans.map((p) => (
                <option key={p.planId} value={p.planId}>
                  {p.name} ({p.monthlyLimit.toLocaleString('en-US')}/mo, {p.perRequestLimit}/req)
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" className={styles.secondary} disabled={switchingAcc}>
          {switchingAcc ? 'Switching…' : 'Switch company plan'}
        </button>
        <div aria-live="polite">
          <Feedback state={switchAccState} />
        </div>
      </form>

      {/* 2. Create Custom Plan */}
      <form action={createPlanAction} className={styles.form}>
        <h3 className={styles.heading}>Create custom plan</h3>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Plan name</span>
            <input name="name" type="text" placeholder="e.g. Enterprise Tier" required maxLength={100} />
          </label>
          <label className={styles.field}>
            <span>Scope type</span>
            <select name="type" defaultValue="user">
              <option value="user">User plan</option>
              <option value="account">Account plan</option>
            </select>
          </label>
        </div>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Monthly limit</span>
            <input name="monthlyLimit" type="number" min={1} step={1} defaultValue={5000} required />
          </label>
          <label className={styles.field}>
            <span>Per request</span>
            <input name="perRequestLimit" type="number" min={1} step={1} defaultValue={50} required />
          </label>
          <label className={styles.field}>
            <span>Rate limit (req/min)</span>
            <input name="rateLimitPerMinute" type="number" min={1} step={1} placeholder="Optional" />
          </label>
        </div>
        <button type="submit" className={styles.secondary} disabled={creatingPlan}>
          {creatingPlan ? 'Creating…' : 'Create plan'}
        </button>
        <div aria-live="polite">
          <Feedback state={createPlanState} />
        </div>
      </form>

      {/* 3. Edit Custom Plan Limits */}
      {activeEditPlan && (
        <form action={editPlanAction} className={styles.form}>
          <h3 className={styles.heading}>Edit custom plan limits</h3>
          <div className={styles.row}>
            <label className={styles.field}>
              <span>Target plan</span>
              <select
                name="planId"
                value={selectedEditPlanId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setSelectedEditPlanId(e.target.value)}
              >
                {editablePlans.map((p) => (
                  <option key={p.planId} value={p.planId}>
                    {p.name} ({p.type})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={styles.row}>
            <label className={styles.field}>
              <span>Monthly limit</span>
              <input
                key={`${activeEditPlan.planId}-month`}
                name="monthlyLimit"
                type="number"
                min={1}
                step={1}
                defaultValue={activeEditPlan.monthlyLimit}
                required
              />
            </label>
            <label className={styles.field}>
              <span>Per request</span>
              <input
                key={`${activeEditPlan.planId}-req`}
                name="perRequestLimit"
                type="number"
                min={1}
                step={1}
                defaultValue={activeEditPlan.perRequestLimit}
                required
              />
            </label>
            <label className={styles.field}>
              <span>Rate limit (req/min)</span>
              <input
                key={`${activeEditPlan.planId}-rate`}
                name="rateLimitPerMinute"
                type="number"
                min={1}
                step={1}
                defaultValue={activeEditPlan.rateLimitPerMinute ?? ''}
                placeholder="None"
              />
            </label>
          </div>
          <button type="submit" className={styles.secondary} disabled={editingPlan}>
            {editingPlan ? 'Saving…' : 'Save limits'}
          </button>
          <div aria-live="polite">
            <Feedback state={editPlanState} />
          </div>
        </form>
      )}
    </div>
  );
}
