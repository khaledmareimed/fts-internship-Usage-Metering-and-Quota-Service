#!/usr/bin/env bash
# Fresh, isolated Compose project each run. Keeps its DB volume for inspection.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v python3 >/dev/null
docker info >/dev/null
export HEAVY_ADMIN_KEY
HEAVY_ADMIN_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export HEAVY_UID="$(id -u)" HEAVY_GID="$(id -g)"
project="fts-heavy-$(date +%s)-$$"
compose=(docker compose --env-file /dev/null -p "$project" -f loadtest/heavy.compose.yml)
mkdir -p loadtest/results/heavy
printf '%s\n' "$project" >loadtest/results/heavy/project.txt
sampler=""
cleanup() {
  if [[ -n "$sampler" ]]; then kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true; fi
  "${compose[@]}" stop >/dev/null 2>&1 || true
}
trap cleanup EXIT
"${compose[@]}" up -d --build --wait postgres service
status=0
read -r -a phases <<<"${PHASES:-spread hot retry reads mixed lifecycle}"
for phase in "${phases[@]}"; do
  case "$phase" in spread|hot|retry|reads|mixed|lifecycle) ;; *) echo "Unknown phase: $phase" >&2; exit 1;; esac
  (
    while true; do
      date -u +%FT%TZ
      "${compose[@]}" exec -T postgres psql -U metering -d metering -tA -F ' ' -c \
        "SELECT COALESCE(wait_event_type || ':' || wait_event, 'running'), count(*)
         FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active'
         AND pid <> pg_backend_pid() GROUP BY 1"
      sleep 5
    done
  ) >"loadtest/results/heavy/$phase-waits.txt" 2>&1 &
  sampler=$!
  # Retain diagnostics and run exactness checks even if k6 reports failed thresholds.
  "${compose[@]}" run --rm -e "PHASE=$phase" k6 run --quiet /loadtest/heavy.js || status=1
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  sampler=""
  totals="$("${compose[@]}" exec -T postgres psql -U metering -d metering -tA -F ' ' <loadtest/totals.sql)"
  printf '%s\n' "$totals" >"loadtest/results/heavy/$phase-totals.txt"
  read -r accounts users requests <<<"$totals"
  printf '%s: account mismatches=%s user mismatches=%s recorded decisions=%s\n' "$phase" "$accounts" "$users" "$requests"
  [[ "$accounts" == 0 && "$users" == 0 ]] || status=1
  enabled="$("${compose[@]}" exec -T postgres psql -U metering -d metering -tAc \
    'SELECT count(*) FROM plans WHERE rate_limit_per_minute IS NOT NULL')"
  printf '%s\n' "$enabled" >"loadtest/results/heavy/$phase-enabled-rate-limits.txt"
  [[ "$enabled" == 0 ]] || { echo "Unexpected enabled rate limits" >&2; status=1; }
  "${compose[@]}" logs --no-color service >loadtest/results/heavy/service.log
done
echo "Reports: loadtest/results/heavy/ ; isolated project: $project"
exit "$status"
