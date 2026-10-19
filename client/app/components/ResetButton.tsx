'use client';

import { useFormStatus } from 'react-dom';
import { resetDemoAction } from '../functions/actions';
import styles from './forms.module.css';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={styles.secondary} disabled={pending}>
      {pending ? 'Resetting…' : 'Reset demo'}
    </button>
  );
}

/** Creates a fresh demo company (nothing is ever deleted). */
export function ResetButton() {
  return (
    <form action={resetDemoAction}>
      <Submit />
    </form>
  );
}
