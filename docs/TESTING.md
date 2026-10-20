# Test Plan

Tools: **Vitest** + **Testcontainers** (real Postgres per run, no DB mocks).
Load: **k6**. All runnable with `npm run test` and `npm run loadtest`.

## 1. Unit tests — `src/domain/rules.ts` (no DB)
- Accepts when all four rules pass
- Rejects on user per-request limit (25 units vs 20)
- Rejects on account per-request limit
- Rejects on user monthly limit
- Rejects on account monthly limit (5 left, ask 10)
- Several rules fail → all listed, in fixed order
- Inactive user → rule `inactive`
- Exactly at the limit is accepted (used + units == limit)
- Remaining never negative when limit < used

## 2. Integration tests (real Postgres, real HTTP via `app.inject`)

**Auth and isolation**
- Missing key → 401; wrong key → 401; inactive account → 403
- Company A reading B's user, plan, history → 404
- Company A assigning B's custom plan → 404
- Company A consuming for B's user → 404
- Same `userId` and same `requestId` in two companies → independent

**Accounts, users, plans**
- Create account → key returned once, only hash stored
- Admin key required for `POST /v1/accounts`
- Predefined plans exist after startup; editing one → 403
- Create/edit custom plan; type can't change
- Assign account plan to user (or reverse) → 400 `PLAN_TYPE_MISMATCH`
- Duplicate `userId` → 409
- Deactivate plan in use → 409; unused → OK

**Consume — the brief's examples**
- Account 10,000/100, user 1,000/20: 25 units → rejected (user per-request)
- 10 units → accepted; user +10 and account +10
- Account with 5 left, 10 units → rejected (account monthly)
- Rejection changes no `used` value; it is in history

**Plan changes**
- Edit custom plan → next request uses new limits
- Switch plan mid-month → usage kept, no fresh allowance
- Lower limit below usage → remaining 0, further requests rejected
- History keeps old limits after a plan edit

**Retries**
- Same `requestId` + same data → same answer, `replayed: true`, counted once
- Same `requestId` + different units → 409
- Fast-path rejection (per-request limit) is saved in history, increments
  `rejected_count`, lists monthly failures too, and replays on retry

**Months**
- Usage lands in the current UTC month (from DB clock)
- Past month query returns that month's numbers

**History**
- Cursor pagination returns all rows exactly once, newest first
- Filters by user and month

## 3. Concurrency tests (the proof)
- **Overspend:** account with 1,000 left; fire 200 parallel requests of 10
  units → exactly 100 accepted, 100 rejected, `used` = 1,000 exactly.
- **Duplicate storm:** 50 parallel requests with the same `requestId` →
  counted once, all answers identical.
- **Totals check:** after any concurrent run,
  `account_usage.used == SUM(units) of accepted requests` for that month,
  and the same for every user.
- **Bad requests don't block good ones:** while one account is flooded with
  over-limit requests, its normal requests keep similar latency.
- **Plan change under load:** lower a plan while requests run → no request
  accepted beyond the limit in force when it got the lock.

## 4. Load tests (k6) — `loadtest/`

Setup script seeds accounts, users and API keys, then runs:

| Scenario | Shape | Shows |
|---|---|---|
| Spread | 100 accounts × 10 users, random | Normal throughput |
| Hot account | 1 account × 200 users | Row-lock contention (the bottleneck) |
| Retry storm | 20% of requests resent with same ID | Idempotency cost |
| Reads | `GET /account`, `/users/:id`, `/requests` | Read path speed |

Record for each: requests/sec, p50/p95/p99 latency, error rate.
After each run, run the totals check above — **speed without exact totals
does not count**.

Report goes in `loadtest/RESULTS.md` and the README: machine specs, commands,
numbers, the bottleneck found, what was changed, and before/after.
