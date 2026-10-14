import { z } from 'zod';
import { DEFAULT_CONNECT_TIMEOUT_MS } from './db/client.js';

const configSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(DEFAULT_CONNECT_TIMEOUT_MS),
  ADMIN_KEY: z.string().min(32),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof configSchema>;
export type LogLevel = Config['LOG_LEVEL'];

/** Validates env vars once at startup; throws one message naming every bad variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
