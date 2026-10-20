# Load test results

Step 12 measured consume v1 (baseline). Step 13 optimized only what those numbers showed (consume v2) and
re-ran the same scenarios on the same machine — see **Before / after** at the end.

## Setup
- **Machine:** 1 VM, 4 vCPU (Intel Xeon Platinum 8488C), 15 GB RAM. Service, Postgres 16 and k6 all run on
  it, so they compete for the same 4 cores. Absolute numbers are lower than on separate machines; comparisons
  between scenarios are valid.
- **Stack:** `docker compose up -d --build` (default config: `DB_POOL_MAX=20`, `DB_CONNECT_TIMEOUT_MS=10000`,
  `LOG_LEVEL=info` — every request is logged, as in production).
- **Load:** k6 `grafana/k6:2.2.0` in Docker (`npm run loadtest`). Each scenario: 50 VUs, 10 s warm-up (not
  measured) + 60 s measured, back-to-back requests (no think time). Data is seeded through the public API.
- **Exactness:** after every scenario `loadtest/totals.sql` compares every account's and user's counters with
  the request history.

## Baseline numbers — consume v1 (measured phase)

| Scenario | Shape | req/s | p50 ms | p95 ms | p99 ms | errors | checks |
|---|---|---:|---:|---:|---:|---:|---:|
| spread | 100 companies × 10 users, consume 1–20 units | 321 | 144.1 | 254.6 | 318.6 | 0.00% | 100% |
| hot | 1 company × 200 users | 133 | 347.4 | 605.2 | 756.0 | 0.00% | 100% |
| retry | spread + 20% resent with same id/body | 391 | 118.0 | 218.4 | 266.8 | 0.00% | 100% |
| reads | `GET /account`, `/users/:id`, `/requests` | 1,172 | 38.3 | 66.7 | 85.1 | 0.00% | 100% |

**Totals check:** 0 account mismatches and 0 user mismatches after every scenario
(76,285 requests checked by the end of the run). Every replay in the retry scenario returned `replayed: true`.

A second `spread` run gave 302 req/s, p50 152 ms (run-to-run noise ≈ 5–10%).

## What the numbers show

**1. The hot account is the bottleneck (as designed and expected).** With the same 50 VUs, one company
gets 133 req/s vs 321 req/s spread over 100 companies (−59%), and p50 latency is 2.4× higher. Sampling
`pg_stat_activity` once per second during `hot`:

| Active backends were… | samples |
|---|---:|
| `Lock:tuple` (waiting for the account usage row) | 1,015 |
| `Lock:transactionid` (same row, waiting for the holder to commit) | 60 |
| running | 40 |
| other (`IO:WALSync`, `ClientRead`, `LockManager`) | 15 |

≈ 95% of active backends were waiting on the one account row. All consumes of one company are serialized
on that row (by design: exact totals), so throughput ≈ 1 / (time the lock is held): 133 req/s → **≈ 7.5 ms
held per request**. Inside the lock, consume v1 makes ~9 round trips (lock user row, idempotency check, read
plans, 2 counter updates, history insert, commit…). More pool connections would not help: they would only
add waiters on the same row (as DECISIONS.md predicted).

**2. Spread is database-CPU-bound.** During `spread`, Postgres averaged ~165% CPU while the single Node
process averaged ~52% (k6 used much of the rest). A consume v1 sends about a dozen statements (2 reads before
the transaction, then BEGIN, 2 upserts + 2 locking reads, idempotency read, plans read, 2 updates, insert,
COMMIT). Statement count, not app CPU, sets the cost.

**3. Retries are cheap.** The retry scenario is *faster* than spread (391 vs 321 req/s): a replay is answered
by the fast path's lock-free lookup (2 reads, no transaction).

**4. Reads are fast** (1,172 req/s, p99 85 ms) — single indexed queries.

## Recommendation for step 13 (made after the baseline)
1. **Consume v2** (planned in CONSUME.md): move the locked steps into one PL/pgSQL function so the whole
   decision is one round trip and the account row is held for microseconds, not ~7.5 ms. Expected: large gain
   on `hot`, smaller on `spread` (fewer statements). v1 tests must pass unchanged.
2. Re-run the same four scenarios and record before/after here.
3. Only if numbers still point at it: compare `LOG_LEVEL=warn` (logging cost was not isolated in this baseline).

Not recommended now: a bigger pool (waits are row locks, not connections) or split counters (a README idea; it
changes the exact-totals design).

## How to reproduce
```bash
docker compose up -d --build
npm run loadtest                 # all scenarios; or: SCENARIOS="hot" npm run loadtest
```
Raw k6 summaries are written to `loadtest/results/` (not committed).

## Before / after — consume v2 (step 13)

**What changed (only what the numbers pointed at):**
1. The locked decision (CONSUME.md steps 1–9) is one PL/pgSQL function, `consume_decide()`, called as a single
   autocommit statement: ~9 round trips under the lock → 1. Rules run in `evaluate_rules()`, the SQL twin of
   `domain/rules.ts` (a parity test over 2,000+ cases keeps them identical).
2. The fast path's two lock-free reads (user + plans, existing request) are one query.
3. An accepted consume now costs **2 statements** instead of ~12. Behavior is unchanged: every v1 test
   (brief examples, retries, plan changes, isolation, all concurrency tests) passes as-is.

Same machine, same `npm run loadtest`, fresh database:

| Scenario | v1 req/s | v2 req/s | change | v1 p50 / p99 ms | v2 p50 / p99 ms |
|---|---:|---:|---:|---|---|
| spread | 321 | 694 | **+116%** | 144 / 319 | 67 / 134 |
| hot | 133 | 241–287 | **+81–116%** | 347 / 756 | 151–181 / 485–563 |
| retry | 391 | 678 | **+73%** | 118 / 267 | 69 / 148 |
| reads | 1,172 | 1,150 | none (unchanged code; noise) | 38 / 85 | 40 / 85 |

0 errors, 100% checks, and the totals check found **0 mismatches** after every scenario (103,293 requests
checked). `hot` was run twice after the change (241 and 287 req/s) to show run-to-run noise.

**Hot account after v2.** Lock waits fell from ~95% to ~77–86% of active backends; the account row is still
the bottleneck, by design. At ~250–290 req/s the row is held ≈ 3.5–4 ms per request, not microseconds:
the lock lasts until **commit**, and with `synchronous_commit = on` (fully durable) each commit waits for its
WAL flush (`IO:WALSync` now appears in the samples), on a box where k6 and the service share the CPU.

**Options beyond this step (not done — each is a tradeoff for the engineer to decide):**
- `synchronous_commit = off` for consume transactions: removes the flush wait from the lock; a crash can lose
  the last ~few hundred ms of acknowledged decisions (no corruption, but not durable).
- Split the hot account counter into N rows (sum on read): spreads lock contention; changes the exact-totals
  design (already listed as a future idea in DECISIONS.md).
- `commit_delay` / group commit tuning: only helps with many concurrent committers on separate rows.

## After the rate-limit rule (step 15a)

The rate-limit counters live on the same locked usage rows, so no extra statements were added. One `hot` run
afterwards: **281 req/s**, p50 155 ms, p99 468 ms, 0 errors, totals exact (142,570 requests checked) —
within v2's measured range (241–287 req/s). No regression.
