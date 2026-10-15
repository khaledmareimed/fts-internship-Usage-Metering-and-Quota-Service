import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';

export const ADMIN_KEY_HEADER = 'x-admin-key';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** onRequest hook for admin-only routes. Hashing first gives equal lengths, so the compare leaks nothing. */
export function adminKeyAuth(adminKey: string) {
  const expected = sha256(adminKey);
  return async (request: FastifyRequest): Promise<void> => {
    const given = request.headers[ADMIN_KEY_HEADER];
    if (typeof given !== 'string' || given === '') {
      throw new AppError('MISSING_ADMIN_KEY', `Missing ${ADMIN_KEY_HEADER} header`);
    }
    if (!timingSafeEqual(sha256(given), expected)) {
      throw new AppError('INVALID_ADMIN_KEY', 'Invalid admin key');
    }
  };
}
