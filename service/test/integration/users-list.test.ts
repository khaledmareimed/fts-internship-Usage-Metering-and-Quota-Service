import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { buildTestApp } from '../helpers/app.js';
import { createAccount, createUser, planIdByName } from '../helpers/fixtures.js';

interface Page {
  items: { userId: string; isActive: boolean; planId: string; planName: string }[];
  nextCursor: string | null;
}

describe('GET /v1/users (cursor pagination)', () => {
  let app: App;
  let db: Db;
  let basic: string;

  beforeAll(async () => {
    ({ app, dbHandle: { db } } = await buildTestApp());
    basic = await planIdByName(db, 'Basic');
  });

  afterAll(async () => {
    await app?.close();
  });

  const list = async (apiKey: string, query = ''): Promise<{ status: number; body: Page }> => {
    const res = await app.inject({ method: 'GET', url: `/v1/users${query}`, headers: { 'x-api-key': apiKey } });
    return { status: res.statusCode, body: res.json() };
  };

  /** Follows nextCursor to the end; returns every userId in order and the page count. */
  const listAll = async (apiKey: string, limit: number) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { body } = await list(apiKey, `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      ids.push(...body.items.map((u) => u.userId));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null);
    return { ids, pages };
  };

  it('returns every user exactly once, newest first', async () => {
    const { apiKey } = await createAccount(app, db);
    const created: string[] = [];
    for (let i = 0; i < 25; i++) {
      const userId = `user-${String(i).padStart(2, '0')}`;
      await createUser(app, apiKey, userId, basic);
      created.push(userId);
    }
    const { ids, pages } = await listAll(apiKey, 10);
    expect(pages).toBe(3);
    expect(ids).toEqual([...created].reverse());
  });

  it('pages correctly when many users share the same created_at', async () => {
    const { accountId, apiKey } = await createAccount(app, db);
    // One statement → one now() → identical created_at; only the id breaks the tie.
    await db.execute(sql`
      INSERT INTO users (account_id, external_id, plan_id)
      SELECT ${accountId}, 'same-' || n, ${basic} FROM generate_series(1, 13) AS n
    `);
    const { ids } = await listAll(apiKey, 4);
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
  });

  it('defaults to 20 per page and includes inactive users with their plan', async () => {
    const { apiKey } = await createAccount(app, db);
    for (let i = 0; i < 21; i++) await createUser(app, apiKey, `u${i}`, basic);
    await app.inject({
      method: 'PATCH', url: '/v1/users/u20', headers: { 'x-api-key': apiKey }, payload: { isActive: false },
    });
    const { body } = await list(apiKey);
    expect(body.items).toHaveLength(20);
    expect(body.nextCursor).not.toBeNull();
    expect(body.items[0]).toEqual({ userId: 'u20', isActive: false, planId: basic, planName: 'Basic' });
  });

  it('an empty company gets an empty page', async () => {
    const { apiKey } = await createAccount(app, db);
    expect((await list(apiKey)).body).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    ['limit=0', '?limit=0'],
    ['limit=101', '?limit=101'],
    ['limit=abc', '?limit=abc'],
    ['garbage cursor', '?cursor=not-a-cursor'],
    ['cursor with a bad shape', `?cursor=${Buffer.from('{"id":1}').toString('base64url')}`],
    ['cursor with an impossible date', `?cursor=${Buffer.from(
      JSON.stringify({ createdAt: '2026-13-45T00:00:00.000000Z', id: '6f1c3b6e-0e7a-4c2b-9d1e-1a2b3c4d5e6f' }),
    ).toString('base64url')}`],
  ])('%s → 400 VALIDATION_ERROR', async (_label, query) => {
    const { apiKey } = await createAccount(app, db);
    const { status } = await list(apiKey, query);
    expect(status).toBe(400);
  });
});
