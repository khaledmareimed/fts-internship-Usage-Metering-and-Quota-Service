# Heavy service load test

Run `bash loadtest/heavy.sh` on a machine with Docker Compose and Python 3.
The runner builds the current service and starts a fresh PostgreSQL database
in a uniquely named Compose project. No client or published ports are needed.
It stops its containers on exit, retaining the isolated volume for inspection.
No existing accounts, plans, containers, or databases are modified.

Default: 200 concurrent virtual users, 10 seconds warm-up, up to 30 seconds
drain, then 90 measured seconds per phase (six phases; roughly 13 minutes plus
build/fixture setup). No sleeps or request-rate throttles are applied.
All test account and user plans explicitly set `rateLimitPerMinute: null`.
Monthly limits are 10^15 and request limits are 1,000,000 to keep the workload
on the accepted-consume path. The service's enforcement code is unchanged.

Phases:

- `spread`: consumes across 100 accounts, 10 users each.
- `hot`: consumes on one account, 200 users.
- `retry`: fresh consume followed by an identical retry, checking the original
  decision is preserved and the replay flag is set.
- `reads`: health, OpenAPI JSON, account, plans, users, history, and cursor pages;
  each of its 100 accounts starts with 101 history records.
- `mixed`: reads, consumes, and plan/user/account updates at the same time.
- `lifecycle`: continuous account, plan, and user creation, user deactivation
  and reactivation, and unused-plan deactivation.

Example overrides:

```bash
VUS=400 DURATION_SECONDS=120 bash loadtest/heavy.sh
PHASES="hot mixed" VUS=200 DURATION_SECONDS=90 bash loadtest/heavy.sh
```

If outbound DNS is unavailable in the Docker build network but works on the
host, set `HEAVY_BUILD_NETWORK=host` for the image build. The running service,
database, and k6 containers still use their isolated Compose network.

To run the service type checks and existing unit/integration/concurrency
tests without installing Node.js on the host, from the repository root:

```bash
docker run --rm --network host \
  -v "$PWD:/workspace" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -w /workspace/service node:24-alpine \
  sh -c 'npm ci && npm run typecheck && npm test'
```

The Docker socket lets Testcontainers create disposable PostgreSQL instances.
Mount the whole repository: the schema parity test also reads `docs/schema.sql`.

Reports in `loadtest/results/heavy/` include phase and endpoint latency
metrics, HTTP failures, check failures, measured request counts, throughput,
and service logs. Throughput includes the measured stage's drain time.
Warm-up and fixture traffic are excluded from the measured HTTP metrics.
The runner checks account/user totals against history after every phase and
confirms the database has zero plans with rate limits. Nonzero HTTP failure
rates, failed correctness checks, rate-limit failures, or total mismatches
cause a failing exit status. No latency SLA is invented.

These are closed-loop saturation tests: concurrency is held constant, so
offered traffic slows when the service slows. They do not establish capacity
under a fixed external arrival rate. The load generator shares the Docker
host with the service/database; record host resources when reporting results.
This suite covers every business route, but does not replace the existing
integration tests for all validation, authorization, isolation, and quota cases.

Execution results are recorded separately in `HEAVY_RESULTS.md`.
