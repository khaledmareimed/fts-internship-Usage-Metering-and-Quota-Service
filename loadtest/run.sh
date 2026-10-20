#!/usr/bin/env bash
# Runs the k6 scenarios against the running Compose stack, checks exact totals after each one,
# and prints a results table. Usage: npm run loadtest   (stack must be up: docker compose up -d --build)
set -euo pipefail
cd "$(dirname "$0")/.."

K6_IMAGE="grafana/k6:2.2.0"
SCENARIOS=(${SCENARIOS:-spread hot retry reads})
ADMIN_KEY="${ADMIN_KEY:-dev-only-admin-key-change-me-0000000000}"
PSQL=(docker compose exec -T postgres psql -U "${POSTGRES_USER:-metering}" -d "${POSTGRES_DB:-metering}" -tA -F ' ')
mkdir -p loadtest/results

curl -fsS http://localhost:50000/health >/dev/null || { echo "service not healthy on :50000 — run: docker compose up -d --build" >&2; exit 1; }

sample_waits() { # one line per second: what active client backends are doing (lock waits vs running)
  while true; do
    "${PSQL[@]}" -c "SELECT now()::time(0), COALESCE(wait_event_type || ':' || wait_event, 'running'), count(*)
      FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid()
      GROUP BY 2" >>loadtest/results/hot-waits.txt 2>/dev/null || true
    sleep 1
  done
}

for name in "${SCENARIOS[@]}"; do
  echo "== $name"
  sampler=""
  if [[ "$name" == hot ]]; then : >loadtest/results/hot-waits.txt; sample_waits & sampler=$!; fi
  docker run --rm --network host --user "$(id -u):$(id -g)" -v "$PWD/loadtest:/loadtest" \
    -e BASE_URL=http://localhost:50000 -e ADMIN_KEY="$ADMIN_KEY" \
    "$K6_IMAGE" run --quiet "/loadtest/$name.js"
  [[ -n "$sampler" ]] && kill "$sampler" && wait "$sampler" 2>/dev/null || true

  read -r acc usr checked < <("${PSQL[@]}" -f - <loadtest/totals.sql)
  echo "   totals check: account mismatches=$acc user mismatches=$usr (requests checked: $checked)"
  if [[ "$acc" != 0 || "$usr" != 0 ]]; then echo "TOTALS MISMATCH — speed without exact totals does not count" >&2; exit 1; fi
done

python3 - "${SCENARIOS[@]}" <<'PY'
import json, sys
print(f"\n{'scenario':<8} {'req/s':>8} {'p50 ms':>8} {'p95 ms':>8} {'p99 ms':>8} {'errors':>8} {'checks':>8}")
for name in sys.argv[1:]:
    m = json.load(open(f"loadtest/results/{name}.json"))["metrics"]
    d = m["http_req_duration{phase:measure}"]["values"]
    n = m["http_reqs{phase:measure}"]["values"]["count"]
    err = m["http_req_failed{phase:measure}"]["values"]["rate"]
    ok = m["checks{phase:measure}"]["values"]["rate"]
    print(f"{name:<8} {n/60:>8.0f} {d['med']:>8.1f} {d['p(95)']:>8.1f} {d['p(99)']:>8.1f} {err:>8.2%} {ok:>8.2%}")
PY

if [[ -s loadtest/results/hot-waits.txt ]]; then
  echo -e "\nhot: active backends by wait event (summed over 1 s samples)"
  awk '{c[$2]+=$3} END {for (k in c) printf "  %-40s %d\n", k, c[k]}' loadtest/results/hot-waits.txt | sort -k2 -nr
fi
