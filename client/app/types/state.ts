import type { ConsumeResult } from '../../types/api';

/** What a form shows after its server action ran. */
export type FormState = { status: 'idle' } | { status: 'ok'; message: string } | { status: 'error'; message: string };

export type ProcessState =
  | { status: 'idle' }
  | { status: 'decided'; result: ConsumeResult }
  | { status: 'error'; message: string };

export const IDLE = { status: 'idle' } as const;
