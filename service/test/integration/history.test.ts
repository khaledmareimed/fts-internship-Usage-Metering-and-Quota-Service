import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import type { Db, DbHandle } from '../../src/db/client.js';
import { historyQuery } from '../../src/modules/history/repo.js';
import { buildTestApp } from '../helpers/app.js';
import { consumeOk } from '../helpers/consume.js';
import { createAccount, createPlan, createUser, currentMonth, planIdByName } from '../helpers/fixtures.js';

// A valid snapshot for rows written directly (responses are schema-checked).
const SNAPSHOT = JSON.stringify({
  account: { planName: 'Starter', monthlyLimit: 10_000, perRequestLimit: 100 },
  user: { planName: 'Basic', monthlyLimit: 1_000, perRequestLimit: 20 },
});

interface Page {
  items: { requestId: string; userId: string }[];
  nextCursor: string | null;
}

describe('history', () => {
  let app: App;
  let db: Db;
  let dbHandle: DbHandle;

  beforeAll(async () => {
    ({ app, dbHandle } = await buildTestApp());
    db = dbHandle.db;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Account on Starter with ali-123 (Basic) and sara (Premium). */
  async function setup() {
    const account = await createAccount(app, db, 'Starter');
    await createUser(app, account.apiKey, 'ali-123', await planIdByName(db, 'Basic'));
    await createUser(app, account.apiKey, 'sara', await planIdByName(db, 'Premium'));
    return account;
  }

  const get = (apiKey: string, url: string) => app.inject({ method: 'GET', url: `/v1${url}`, headers: { 'x-api-key': apiKey } });

  const listAll = async (apiKey: string, query: string, limit: number) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(apiKey, `/requests?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      const body: Page = res.json();
      ids.push(...body.items.map((i) => i.requestId));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null);
    return { ids, pages };
  };

  it('returns the API.md item shape, in the list and by id', async () => {
    const { apiKey } = await setup();
    const decision = await consumeOk(app, apiKey, { requestId: 'doc-7782', userId: 'ali-123', units: 25 });
    const expected = {
      requestId: 'doc-7782',
      userId: 'ali-123',
      units: 25,
      accepted: false,
      failedRules: [{ scope: 'user', rule: 'per_request_limit', limit: 20, requested: 25 }],
      limits: {
        account: { planName: 'Starter', monthlyLimit: 10_000, perRequestLimit: 100, rateLimitPerMinute: null },
        user: { planName: 'Basic', monthlyLimit: 1_000, perRequestLimit: 20, rateLimitPerMinute: null },
      },
      accountRemaining: 10_000,
      userRemaining: 1_000,
      createdAt: decision.decidedAt,
    };
    expect((await get(apiKey, '/requests')).json()).toEqual({ items: [expected], nextCursor: null });
    expect((await get(apiKey, '/requests/doc-7782')).json()).toEqual(expected);
  });

  it('pages through every request exactly once, newest first', async () => {
    const { apiKey } = await setup();
    const sent: string[] = [];
    for (let i = 0; i < 25; i++) {
      const requestId = `r-${String(i).padStart(2, '0')}`;
      await consumeOk(app, apiKey, { requestId, userId: i % 2 ? 'sara' : 'ali-123', units: 1 });
      sent.push(requestId);
    }
    const { ids, pages } = await listAll(apiKey, '', 10);
    expect(pages).toBe(3);
    expect(ids).toEqual([...sent].reverse());
  });

  it('pages correctly when many requests share the same created_at', async () => {
    const { accountId, apiKey } = await setup();
    await db.execute(sql`
      INSERT INTO requests (account_id, request_id, user_id, units, accepted, limits_snapshot,
                            account_remaining, user_remaining, account_used, user_used)
      SELECT ${accountId}, 'same-' || n, u.id, 1, true, ${SNAPSHOT}::jsonb, 0, 0, 0, 0
      FROM generate_series(1, 13) AS n, users u WHERE u.account_id = ${accountId} AND u.external_id = 'sara'
    `);
    const { ids } = await listAll(apiKey, '', 4);
    expect(new Set(ids).size).toBe(13);
  });

  it('filters by user; an unknown or foreign user → 404', async () => {
    const { apiKey } = await setup();
    await consumeOk(app, apiKey, { requestId: 'a1', userId: 'ali-123', units: 1 });
    await consumeOk(app, apiKey, { requestId: 's1', userId: 'sara', units: 1 });
    await consumeOk(app, apiKey, { requestId: 'a2', userId: 'ali-123', units: 1 });
    expect((await listAll(apiKey, '&userId=ali-123', 1)).ids).toEqual(['a2', 'a1']);

    expect((await get(apiKey, '/requests?userId=nobody')).json().error.code).toBe('USER_NOT_FOUND');
    const other = await createAccount(app, db, 'Starter', 'Other Co');
    await createUser(app, other.apiKey, 'theirs', await planIdByName(db, 'Basic'));
    expect((await get(apiKey, '/requests?userId=theirs')).statusCode).toBe(404);
  });

  it('filters by month (and by user + month)', async () => {
    const { accountId, apiKey } = await setup();
    await consumeOk(app, apiKey, { requestId: 'now-1', userId: 'ali-123', units: 1 });
    await consumeOk(app, apiKey, { requestId: 'now-2', userId: 'sara', units: 1 });
    // shortcut: past-month rows are written directly; the DB clock can't produce them via consume.
    await db.execute(sql`
      INSERT INTO requests (account_id, request_id, user_id, units, accepted, limits_snapshot,
                            account_remaining, user_remaining, account_used, user_used, created_at)
      SELECT ${accountId}, x.rid, u.id, 1, true, ${SNAPSHOT}::jsonb, 0, 0, 0, 0, x.at::timestamptz
      FROM (VALUES ('jan-ali', 'ali-123', '2020-01-31T23:59:59.999999Z'),
                   ('jan-sara', 'sara', '2020-01-01T00:00:00Z'),
                   ('feb-ali', 'ali-123', '2020-02-01T00:00:00Z')) AS x(rid, ext, at)
      JOIN users u ON u.account_id = ${accountId} AND u.external_id = x.ext
    `);

    expect((await listAll(apiKey, `&month=${await currentMonth(db)}`, 10)).ids).toEqual(['now-2', 'now-1']);
    expect((await listAll(apiKey, '&month=2020-01', 10)).ids).toEqual(['jan-ali', 'jan-sara']);
    expect((await listAll(apiKey, '&month=2020-02', 10)).ids).toEqual(['feb-ali']);
    expect((await listAll(apiKey, '&month=2020-01&userId=sara', 10)).ids).toEqual(['jan-sara']);
    expect((await listAll(apiKey, '&month=2019-12', 10)).ids).toEqual([]);
  });

  it.each([
    ['future month', '?month=2999-01'],
    ['bad month', '?month=2026-13'],
    ['limit=0', '?limit=0'],
    ['limit=101', '?limit=101'],
    ['garbage cursor', '?cursor=nope'],
    ['cursor with a uuid id', `?cursor=${Buffer.from(JSON.stringify({ createdAt: '2026-10-14T08:00:00.000000Z', id: 'x' })).toString('base64url')}`],
  ])('%s → 400 VALIDATION_ERROR', async (_label, query) => {
    const { apiKey } = await setup();
    const res = await get(apiKey, `/requests${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /requests/:requestId: 404 for unknown or foreign ids; odd ids work when encoded', async () => {
    const { apiKey } = await setup();
    const other = await setup();
    await consumeOk(app, other.apiKey, { requestId: 'theirs', userId: 'ali-123', units: 1 });
    const missing = await get(apiKey, '/requests/theirs');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('REQUEST_NOT_FOUND');

    const odd = 'job/42 #ü😀';
    await consumeOk(app, apiKey, { requestId: odd, userId: 'ali-123', units: 1 });
    expect((await get(apiKey, `/requests/${encodeURIComponent(odd)}`)).json().requestId).toBe(odd);
  });

  it('keeps the limits used at decision time after a plan edit', async () => {
    const { apiKey } = await setup();
    const planId = await createPlan(app, apiKey, { name: 'Edit Me', type: 'user', monthlyLimit: 50, perRequestLimit: 5 });
    await app.inject({ method: 'PATCH', url: '/v1/users/sara', headers: { 'x-api-key': apiKey }, payload: { planId } });
    await consumeOk(app, apiKey, { requestId: 'old', userId: 'sara', units: 1 });
    await app.inject({ method: 'PATCH', url: `/v1/plans/${planId}`, headers: { 'x-api-key': apiKey }, payload: { monthlyLimit: 99 } });
    await consumeOk(app, apiKey, { requestId: 'new', userId: 'sara', units: 1 });

    expect((await get(apiKey, '/requests/old')).json().limits.user).toEqual({ planName: 'Edit Me', monthlyLimit: 50, perRequestLimit: 5, rateLimitPerMinute: null });
    expect((await get(apiKey, '/requests/new')).json().limits.user.monthlyLimit).toBe(99);
  });

  it.each([
    ['no filter', {}, 'requests_history_idx'],
    ['month', { month: '2020-01-01' }, 'requests_history_idx'],
    ['user', { user: true }, 'requests_user_hist_idx'],
    ['user + month', { user: true, month: '2020-01-01' }, 'requests_user_hist_idx'],
  ])('is backed by an index with no sort (%s)', async (_label, f, index) => {
    const { accountId } = await setup();
    const { rows: users } = await db.execute<{ id: string }>(sql`SELECT id FROM users WHERE account_id = ${accountId} LIMIT 1`);
    const after = { createdAt: '2026-10-14T08:00:00.000000Z', id: 1_000_000 };
    const query = historyQuery(db, accountId, {
      userId: 'user' in f ? users[0]?.id : undefined,
      month: 'month' in f ? f.month : undefined,
      after,
      limit: 20,
    }).toSQL();

    // Tiny test tables make seq scans cheapest; disable them so the planner shows what the indexes can serve.
    const client = await dbHandle.pool.connect();
    let plan: string;
    try {
      await client.query('SET enable_seqscan = off; SET enable_sort = off; SET enable_bitmapscan = off');
      const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query.sql}`, query.params);
      plan = result.rows.map((r) => r['QUERY PLAN']).join('\n');
      await client.query('RESET ALL');
    } finally {
      client.release();
    }
    expect(plan).toContain(index);
    expect(plan).not.toMatch(/\bSort\b/);
  });
});
