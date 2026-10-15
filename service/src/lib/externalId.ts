import { z } from 'zod';

/**
 * A company's own id (userId, requestId), kept exactly as sent. Counted in characters like Postgres
 * `length()` (not UTF-16 units); NUL is rejected because Postgres text can't store it.
 */
export const externalIdSchema = z
  .string()
  .refine((id) => {
    const length = [...id].length;
    return length >= 1 && length <= 128;
  }, 'must be 1–128 characters')
  .refine((id) => !id.includes('\u0000'), 'must not contain NUL characters');
