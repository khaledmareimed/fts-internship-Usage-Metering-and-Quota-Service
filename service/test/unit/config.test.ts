import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const DATABASE_URL = 'postgres://u:p@localhost:5432/db';
const ADMIN_KEY = 'a'.repeat(32);

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL, ADMIN_KEY })).toEqual({
      DATABASE_URL,
      ADMIN_KEY,
      PORT: 3000,
      DB_POOL_MAX: 20,
      DB_CONNECT_TIMEOUT_MS: 10_000,
      LOG_LEVEL: 'info',
    });
  });

  it('parses numbers from strings', () => {
    const config = loadConfig({ DATABASE_URL, ADMIN_KEY, PORT: '8080', DB_POOL_MAX: '5', LOG_LEVEL: 'debug' });
    expect(config).toMatchObject({ PORT: 8080, DB_POOL_MAX: 5, LOG_LEVEL: 'debug' });
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ ADMIN_KEY })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://u:p@h/db', ADMIN_KEY })).toThrow(/DATABASE_URL/);
  });

  it('requires an ADMIN_KEY of at least 32 chars', () => {
    expect(() => loadConfig({ DATABASE_URL })).toThrow(/ADMIN_KEY/);
    expect(() => loadConfig({ DATABASE_URL, ADMIN_KEY: 'short' })).toThrow(/ADMIN_KEY/);
  });

  it('validates DB_CONNECT_TIMEOUT_MS', () => {
    expect(loadConfig({ DATABASE_URL, ADMIN_KEY, DB_CONNECT_TIMEOUT_MS: '2500' }).DB_CONNECT_TIMEOUT_MS).toBe(2_500);
    for (const bad of ['50', '60001', 'soon', '1.5']) {
      expect(() => loadConfig({ DATABASE_URL, ADMIN_KEY, DB_CONNECT_TIMEOUT_MS: bad })).toThrow(/DB_CONNECT_TIMEOUT_MS/);
    }
  });

  it('names every bad variable', () => {
    expect(() => loadConfig({ DATABASE_URL, ADMIN_KEY, PORT: 'abc', DB_POOL_MAX: '0' })).toThrow(
      /PORT[\s\S]*DB_POOL_MAX/,
    );
  });
});
