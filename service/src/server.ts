import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb } from './db/client.js';
import { migrateAndSeed } from './db/migrate.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const dbHandle = createDb(config.DATABASE_URL, {
  poolMax: config.DB_POOL_MAX,
  connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
});
const app = buildApp({ dbHandle, logLevel: config.LOG_LEVEL, adminKey: config.ADMIN_KEY });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

try {
  await migrateAndSeed(dbHandle);
  app.log.info('migrations applied, predefined plans seeded');
  await app.listen({ host: '0.0.0.0', port: config.PORT });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
