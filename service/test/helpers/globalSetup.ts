import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

// One Postgres for the whole run; each test file creates its own database in it.
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  project.provide('databaseUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
