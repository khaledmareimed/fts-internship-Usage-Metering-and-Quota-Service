import { buildApp, type App, type AppOptions } from '../../src/app.js';
import type { DbHandle } from '../../src/db/client.js';
import { createTestDatabase } from './db.js';

export const TEST_ADMIN_KEY = 'test-admin-key-0123456789abcdef0123';

/** The real app on a fresh migrated database, with logs silenced. */
export async function buildTestApp(
  options: Partial<AppOptions> = {},
  poolMax = 4,
): Promise<{ app: App; dbHandle: DbHandle }> {
  const dbHandle = await createTestDatabase(poolMax);
  const app = buildApp({ dbHandle, logLevel: 'silent', adminKey: TEST_ADMIN_KEY, ...options });
  return { app, dbHandle };
}
