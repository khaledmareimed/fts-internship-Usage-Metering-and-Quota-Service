import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { AppError } from '../errors.js';
import { findAuthByKeyHash } from '../modules/accounts/repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only by apiKeyAuth; the one source of the caller's account. */
    accountId: string;
  }
}

export const API_KEY_HEADER = 'x-api-key';

/** `mk_` + 32 random bytes, base64url (43 chars). Shown once, never stored. */
export function generateApiKey(): string {
  return `mk_${randomBytes(32).toString('base64url')}`;
}

/** Keys are 256-bit random, so a fast hash is safe (no bcrypt cost per request). */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/** onRequest hook: runs before body parsing, so a missing or bad key wins over a bad body. */
export function apiKeyAuth(db: Db) {
  return async (request: FastifyRequest): Promise<void> => {
    const apiKey = request.headers[API_KEY_HEADER];
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new AppError('MISSING_API_KEY', `Missing ${API_KEY_HEADER} header`);
    }
    const account = await findAuthByKeyHash(db, hashApiKey(apiKey));
    if (!account) throw new AppError('INVALID_API_KEY', 'Invalid API key');
    if (!account.isActive) throw new AppError('ACCOUNT_INACTIVE', 'This account is inactive');
    request.accountId = account.id;
  };
}
