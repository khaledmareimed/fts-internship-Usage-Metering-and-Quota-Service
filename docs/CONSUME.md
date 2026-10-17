# Consume Logic — `POST /v1/consume`

The most important code path. Correctness first, then speed.

## Goals
1. Totals are always exact, even with many concurrent requests.
2. A retry never counts twice.
3. A rejection consumes nothing, but is recorded.
4. Plan changes apply to the next request after they commit.

## Before the transaction (no DB locks)
1. **Validate input** with Zod: `requestId` 1–128 chars, `userId` 1–128 chars,
   `units` integer ≥ 1. Invalid → `400 VALIDATION_ERROR`.
2. **Authenticate**: SHA-256 the `x-api-key`, look up the account by hash.
   Missing → `401 MISSING_API_KEY`. Unknown → `401 INVALID_API_KEY`.
   Inactive account → `403 ACCOUNT_INACTIVE`.
   `accountId` now comes from the key, never from the body.

## Fast path — reject without the long lock

Some rules don't depend on usage: user inactive, user per-request limit,
account per-request limit. If any of them fails, the request is rejected
without entering the locked transaction below.

```
1. Resolve user + both plans   one read (users JOIN plans, account JOIN plans)
                               not found → 404 USER_NOT_FOUND (not recorded)
2. Existing request?           requests WHERE account_id AND request_id
                               → replay or 409, exactly as step 5 below
3. Static checks               inactive, user per_request, account per_request
                               all pass → go to the locked transaction
                               any fail → continue here
4. Read usage (no lock)        current month's account + user `used`, only to
                               also report monthly failures and remaining
5. Short transaction           BEGIN
                                 UPDATE account_usage rejected_count += 1  (upsert)
                                 UPDATE user_usage    rejected_count += 1  (upsert)
                                 INSERT requests (rejected, all failed rules, snapshot)
                               COMMIT
                               23505 on requests insert → replay or 409
```

- Same lock order as the locked transaction: account usage row → user usage
  row → requests unique key, so no deadlocks. The unique key on
  `(account_id, request_id)` is a lock too: inserting the request before the
  upserts deadlocked (40P01 → 500) against a locked-path request with the same
  `requestId` (found in code review, fixed; see `docs/steps/fix-01-consume-lock-order.md`).
- The usage rows are locked only for one counter update at the end, not for
  the whole decision, so a burst of bad requests can't slow down good ones.
- The decision is safe without the lock: these rules fail regardless of usage.

## The transaction (READ COMMITTED)

Used when the static checks pass. Steps 6–7 re-read the plans under the lock,
so a plan edited in between is still respected.

```
BEGIN
 1. Resolve user        users WHERE account_id = $acc AND external_id = $userId
                        not found → ROLLBACK, 404 USER_NOT_FOUND (not recorded)
 2. Month               date_trunc('month', now() AT TIME ZONE 'UTC')::date
                        (database clock, fixed for the whole transaction)
 3. Lock account row    INSERT INTO account_usage ... ON CONFLICT DO NOTHING
                        SELECT used FROM account_usage ... FOR UPDATE
 4. Lock user row       same for user_usage
 5. Idempotency check   requests WHERE account_id = $acc AND request_id = $rid
                        found, same userId + units → return stored answer, replayed: true
                        found, different data      → 409 REQUEST_ID_CONFLICT
 6. Read plans          the account's plan and the user's plan (current rows)
 7. Evaluate rules      pure function, collects ALL failures (see below)
 8. Update counters     accepted: used += units, accepted_count += 1
                        rejected: rejected_count += 1
                        both: monthly_limit = current plan limit, updated_at = now()
 9. Insert history      requests row with decision, failed rules,
                        limits snapshot, remaining amounts
COMMIT
```

### Why this order
- **Lock order is always account usage row → user usage row → requests unique
  key.** Every transaction (locked and fast path) takes locks in the same
  order, so deadlocks cannot happen. The history insert locks the
  `(account_id, request_id)` key, so it must come last everywhere.
- **Idempotency check comes after the locks.** All consumes for one account wait
  on the account row, so when a retry gets the lock, the first attempt has
  already committed and is visible. No race between two identical requests.
- **Plans are read after the locks.** A plan change that committed before this
  request got its turn is always seen. A plan change that commits while the
  request is already deciding applies to the next request, which matches
  "changes apply to new requests after the update succeeds".
- **`now()` is the transaction start time from the database.** One clock for
  all service instances; no month mismatch at midnight UTC on the 1st.

### Safety net
If step 9 still hits a unique violation on `(account_id, request_id)`
(Postgres error `23505`), roll back, re-read the stored request, and answer
as a replay or `409`. With correct lock order this should never fire; it
exists so a bug can never double count.

## Rule evaluation (pure function, no DB)

File: `src/domain/rules.ts`. Input: units, user (active flag), both plans,
both current `used` values. Output: `{ accepted, failedRules[] }`.

| Check | Scope | Rule | Fails when |
|---|---|---|---|
| User inactive | user | `inactive` | `!user.isActive` |
| User per request | user | `per_request_limit` | `units > userPlan.perRequestLimit` |
| Account per request | account | `per_request_limit` | `units > accountPlan.perRequestLimit` |
| User monthly | user | `monthly_limit` | `userUsed + units > userPlan.monthlyLimit` |
| Account monthly | account | `monthly_limit` | `accountUsed + units > accountPlan.monthlyLimit` |
| User rate | user | `rate_limit` | plan `rateLimitPerMinute` set and `userCountThisMinute + 1 > limit` |
| Account rate | account | `rate_limit` | plan `rateLimitPerMinute` set and `accountCountThisMinute + 1 > limit` |

- All checks run; every failure is listed in this order.
- Rate counts are accepted requests in the current UTC minute (`window_start`/`window_count` on the
  usage rows); only accepted requests update them, inside the locked decision.
- `accepted = failedRules.length === 0`.
- `remaining = max(0, monthlyLimit - used)` (never negative, even after a plan
  was lowered below current usage).
- Each failure carries numbers: `limit`, plus `requested` or `remaining`.

Being pure, this function gets exhaustive unit tests with no database.

## Response
See `API.md` → `POST /v1/consume`. Accepted and rejected both return `200`.
Remaining amounts are computed after the update (accepted) or unchanged
(rejected).

## Performance plan
- **v1 (build this first):** the steps above as separate statements in one
  transaction using `db.execute(sql\`...\`)`. Readable and correct.
- **Measure with k6.** Expected bottleneck: many users of one account waiting
  on the same account row; time inside the lock = number of round trips.
- **v2 (only if the load test shows it matters):** move steps 1–9 into one
  PL/pgSQL function `consume(...)`, so the whole decision is one round trip
  and the lock is held for microseconds. Keep v1's tests unchanged; they must
  still pass. Report before/after numbers in the README.
- **Done (step 13):** v2 is implemented as `consume_decide()` (one autocommit
  statement; returns no row for an unknown user, `outcome = 'existing'` for a
  requestId already decided). Rule evaluation inside it is `evaluate_rules()`,
  the SQL twin of `domain/rules.ts`; `test/integration/rules-parity.test.ts`
  keeps them identical. The fast path's two pre-reads are merged into one query.
  Measured: spread +116%, hot +81–116% (see `loadtest/RESULTS.md`). The lock is
  held until commit, which includes the WAL flush (`synchronous_commit = on`).
- Further idea for the README only: split the hot account counter into N rows
  to spread lock contention.

## What is NOT allowed
- Reading usage, deciding in the app, then updating without a lock.
- Summing the requests table to get usage on the hot path.
- Using the app server's clock for the month.
- Building SQL with string concatenation.
