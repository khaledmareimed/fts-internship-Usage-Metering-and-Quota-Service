# Decisions Log — Usage Metering Service

## Tech stack
- TypeScript, Node.js, Fastify
- PostgreSQL 16 (only data store — no Redis, no separate queue)
- Docker Compose: postgres (with volume), service, example client
- No Bun: the bottleneck is the database, not the runtime

## Tooling
- Validation: Zod (with `fastify-type-provider-zod` for typed routes + Swagger)
- SQL injection: prevented by parameterized queries only (Drizzle builder and
  `sql` template); never build SQL by string concatenation
- Tests: Vitest + Testcontainers (real, fresh Postgres per run; no DB mocks)
- Load test: k6
- Logging: pino (Fastify built-in), `requestId` in every log line
- Migrations run on service start, then predefined plans are seeded
- API key format: `mk_` + 32 random bytes, base64url-encoded (`mk_` + 43 chars)
- Auth is checked before body validation: no/bad key → 401 even if the body is invalid
- Admin key errors: `401 MISSING_ADMIN_KEY` / `INVALID_ADMIN_KEY`
- Inactive company: its key returns `403 ACCOUNT_INACTIVE`
- Time: the database clock (`now()`) decides the UTC month, never the app server
- DB connection pool: `DB_POOL_MAX` env var, default 20, tuned in the load test
  (more connections don't help one busy company; it still waits on one row)

## Data access (Drizzle ORM)
- Drizzle query builder for simple CRUD (accounts, plans, users, reads)
- Raw SQL via `db.execute(sql\`...\`)` for consume and anything needing
  row locks (`FOR UPDATE`), `ON CONFLICT`, or exact control
- One source of truth for the schema: Drizzle table definitions +
  drizzle-kit migrations, checked against `schema.sql`

Builder example (simple insert):
```ts
const [user] = await db
  .insert(users)
  .values({ accountId, externalId: 'ali-123', planId })
  .returning();
```

Raw SQL example (consume: create month row, then lock it):
```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`
    INSERT INTO account_usage (account_id, month, monthly_limit)
    VALUES (${accountId}, ${month}, ${limit})
    ON CONFLICT (account_id, month) DO NOTHING
  `);
  const { rows } = await tx.execute(sql`
    SELECT used FROM account_usage
    WHERE account_id = ${accountId} AND month = ${month}
    FOR UPDATE
  `);
  // check limits, then update
});
```

## Accounts, users, keys
- One API key per company, sent in `x-api-key`; stored as SHA-256 hash, shown once
- `POST /v1/accounts` protected by an admin key from `.env`; no admin dashboard
- Users never call the service; the company backend does
- Users stored minimally: company's own `userId` (unique per company), plan, active flag
- `account_id` always taken from the API key, never from the request body
- One shared database; every table carries `account_id`

## Plans
- Limits live only on plans; accounts/users point to a plan
- Predefined plans stored in Postgres (seeded at startup), read-only, with fixed well-known ids
  (listed in API.md) so the admin can create a company without looking a plan up:
  - Starter (account): 10,000/month, 100/request
  - Pro (account): 100,000/month, 1,000/request
  - Basic (user): 1,000/month, 20/request
  - Premium (user): 10,000/month, 200/request
- Companies create custom plans of type `account` or `user`; type can't change
- A plan is required when creating an account or a user (no hidden defaults)
- No "unlimited" and no 0 limits; to block a user, deactivate them
- Rate-limit rule (extra): optional `rateLimitPerMinute` on plans (null = none). Counts only accepted
  requests per scope in a fixed UTC minute, stored on the locked monthly usage rows (no extra store).
  Failing it is a normal rejection (`rate_limit`). Rules 6–7, after the existing five.

## Consume
- Request: `requestId`, `userId`, `units` (positive integer) + API key header
- `userId` is required
- All four rules checked (user/account × per-request/monthly); all failures reported
- Rejections return 200 with `accepted: false`; nothing consumed; saved in history
- Request ID unique per company:
  - same ID + same data → original answer, `replayed: true`
  - same ID + different data → 409
- Concurrency: Postgres row locks, lock order = account row, then user row
- Fast path: inactive user or per-request limit failures are rejected without
  the long lock (still recorded, counted, and all rules reported)

## Plan changes and months
- Changes apply to new requests immediately
- Switching plans keeps usage: remaining = max(0, limit − used)
- Months are UTC; history keeps the limits used at decision time

## Deactivation (soft delete only)
- Users and custom plans can be deactivated/reactivated; no hard deletes
- Can't deactivate a plan that is still assigned
- Predefined plans can't be deactivated

## Scope
- Core first, then extras in order: Swagger docs, rate-limit rule,
  deactivation, API key rotation
- Example client: Next.js (App Router), API key kept server-side only
- Client styling: plain CSS Modules; no Tailwind, no UI libraries; responsive
  on laptop, tablet and mobile
- No shared types package: the client keeps its own API types from `API.md`
  (tradeoff: they can drift; acceptable for a small demo)

## Known tradeoffs (for README)
- Company usage row is a hot spot (exact totals); future: split counters
- History grows forever; future: monthly partitioning
- Single database = single point of failure
