// Full-service load test. Run against the isolated stack via heavy.sh.
import http from 'k6/http';
import { check, fail } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://service:3000';
const VUS = Number(__ENV.VUS || 200);
const SECONDS = Number(__ENV.DURATION_SECONDS || 90);
const PHASE = __ENV.PHASE || 'spread';
const phases = ['spread', 'hot', 'retry', 'reads', 'mixed', 'lifecycle'];
if (!phases.includes(PHASE) || !Number.isInteger(VUS) || VUS < 1 ||
    !Number.isInteger(SECONDS) || SECONDS < 1) throw new Error('Invalid phase, VUS, or DURATION_SECONDS');
const errors = new Counter('unexpected_results');
const rateFailures = new Counter('rate_limit_failures');
const measuredElapsed = new Trend('measured_elapsed_seconds');
const STARTER = '00000000-0000-4000-8000-000000000001';
const limits = { monthlyLimit: 1e15, perRequestLimit: 1_000_000, rateLimitPerMinute: null };

export const options = {
  setupTimeout: '600s',
  scenarios: {
    warmup: {
      executor: 'constant-vus', exec: 'exercise', vus: VUS,
      duration: '10s', gracefulStop: '30s', tags: { phase: 'warmup' },
    },
    measure: {
      executor: 'constant-vus', exec: 'exercise', vus: VUS,
      duration: `${SECONDS}s`, startTime: '40s', gracefulStop: '30s',
      tags: { phase: 'measure' },
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    unexpected_results: ['count==0'],
    rate_limit_failures: ['count==0'],
    'http_req_failed{phase:measure}': ['rate==0'],
    'checks{phase:measure}': ['rate==1'],
    'http_req_duration{phase:measure}': ['max>=0'],
    'http_reqs{phase:measure}': ['count>0'],
  },
};

// Fixed route names prevent per-ID metric cardinality growth.
const routes = [
  'GET /health', 'GET /docs/json', 'POST /v1/accounts',
  'GET /v1/account', 'PATCH /v1/account', 'GET /v1/plans',
  'GET /v1/plans/:id', 'POST /v1/plans', 'PATCH /v1/plans/:id',
  'GET /v1/users', 'GET /v1/users/:id', 'POST /v1/users',
  'PATCH /v1/users/:id', 'POST /v1/consume', 'GET /v1/requests',
  'GET /v1/requests/:id',
];
for (const name of routes) {
  options.thresholds[`http_req_duration{phase:measure,name:${name}}`] = ['max>=0'];
  options.thresholds[`http_reqs{phase:measure,name:${name}}`] = ['count>=0'];
}

function verify(ok, label) {
  check(ok, { [label]: (value) => value });
  errors.add(ok ? 0 : 1);
  return ok;
}

function call(method, path, key, payload, status = 200, route = path, admin = false) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers[admin ? 'x-admin-key' : 'x-api-key'] = key;
  const res = http.request(method, `${BASE}${path}`, payload === undefined ? null : JSON.stringify(payload), {
    headers, timeout: '30s', tags: { name: `${method} ${route}` },
    responseCallback: http.expectedStatuses(status),
  });
  if (!verify(res.status === status, `${method} ${route}: ${status}`)) return null;
  try { return res.json(); } catch { verify(false, 'valid JSON'); return null; }
}

function need(value) {
  if (!value) fail('Fixture request failed (credentials and response body omitted)');
  return value;
}

function plan(key, type, name) {
  const p = need(call('POST', '/v1/plans', key, { name, type, ...limits }, 201));
  if (!verify(p.rateLimitPerMinute === null, 'plan has no rate limit')) fail('Rate limit enabled');
  return p.planId;
}

function company(name, users) {
  const a = need(call('POST', '/v1/accounts', __ENV.ADMIN_KEY,
    { name, planId: STARTER }, 201, '/v1/accounts', true));
  const key = a.apiKey;
  const accountPlan = plan(key, 'account', 'Heavy account');
  const userPlan = plan(key, 'user', 'Heavy user');
  const assigned = need(call('PATCH', '/v1/account', key, { planId: accountPlan }));
  if (!verify(assigned.plan.rateLimitPerMinute === null, 'account rate limit disabled')) fail('Rate limit enabled');
  for (let i = 0; i < users; i++) {
    const u = need(call('POST', '/v1/users', key, { userId: `u${i}`, planId: userPlan }, 201));
    if (!verify(u.plan.rateLimitPerMinute === null, 'user rate limit disabled')) fail('Rate limit enabled');
  }
  const aData = { key, accountPlan, userPlan, users };
  consume(aData, 'seed', 'u0');
  return aData;
}

export function setup() {
  if (!__ENV.ADMIN_KEY) throw new Error('ADMIN_KEY required');
  need(call('GET', '/health'));
  const run = `heavy-${PHASE}-${Date.now()}`;
  const accounts = [];
  const count = PHASE === 'hot' || PHASE === 'lifecycle' ? 1 : 100;
  for (let i = 0; i < count; i++) {
    const a = company(`${run}-${i}`, count === 1 ? 200 : 10);
    // Give read-only history queries enough records to exercise cursor pagination.
    if (PHASE === 'reads') {
      for (let request = 0; request < 100; request++) {
        consume(a, `history-${request}`, `u${request % a.users}`);
      }
    }
    accounts.push(a);
  }
  return { accounts, run };
}

function consume(a, id, userId, replay = false) {
  const value = call('POST', '/v1/consume', a.key, { requestId: id, userId, units: 1 });
  const rateFailed = !!value?.failedRules?.some((r) => r.rule === 'rate_limit');
  rateFailures.add(rateFailed ? 1 : 0);
  verify(value?.accepted === true && value?.failedRules?.length === 0, 'consume accepted without failures');
  verify(value?.replayed === replay, 'correct replay flag');
  return value;
}

function reads(a, userId, index) {
  const choices = [
    ['/health', '/health'],
    ['/v1/account', '/v1/account'],
    ['/v1/plans', '/v1/plans'],
    [`/v1/plans/${a.userPlan}`, '/v1/plans/:id'],
    ['/v1/users?limit=5', '/v1/users'],
    [`/v1/users/${userId}`, '/v1/users/:id'],
    ['/v1/requests?limit=5', '/v1/requests'],
    ['/v1/requests/seed', '/v1/requests/:id'],
    ['/docs/json', '/docs/json'],
  ];
  const [path, route] = choices[index % choices.length];
  const result = call('GET', path, a.key, undefined, 200, route);
  if (result?.nextCursor) {
    const separator = path.includes('?') ? '&' : '?';
    call('GET', `${path}${separator}cursor=${encodeURIComponent(result.nextCursor)}`, a.key, undefined, 200, route);
  }
}

export function exercise(data) {
  try {
    exerciseOne(data);
  } finally {
    if (exec.scenario.name === 'measure') {
      measuredElapsed.add((Date.now() - exec.scenario.startTime) / 1000);
    }
  }
}

function exerciseOne(data) {
  const n = exec.scenario.iterationInTest;
  const id = `${data.run}-${exec.scenario.name}-${exec.vu.idInTest}-${n}`;
  const a = data.accounts[Math.floor(Math.random() * data.accounts.length)];
  const userId = `u${Math.floor(Math.random() * a.users)}`;
  if (PHASE === 'lifecycle') {
    // Exercise account/user/plan creation continuously under concurrency.
    const fresh = company(id, 1);
    call('PATCH', '/v1/users/u0', fresh.key, { isActive: false }, 200, '/v1/users/:id');
    call('PATCH', '/v1/users/u0', fresh.key, { isActive: true }, 200, '/v1/users/:id');
    const unused = plan(fresh.key, 'user', 'Unused');
    call('PATCH', `/v1/plans/${unused}`, fresh.key, { isActive: false }, 200, '/v1/plans/:id');
    call('GET', '/v1/account', fresh.key);
    return;
  }
  if (PHASE === 'reads') return reads(a, userId, n);
  if (PHASE === 'mixed') {
    if (n % 10 < 4) return reads(a, userId, Math.floor(n / 10));
    if (n % 10 === 4) {
      call('PATCH', `/v1/plans/${a.userPlan}`, a.key, limits, 200, '/v1/plans/:id');
      return;
    }
    if (n % 10 === 5) {
      call('PATCH', `/v1/users/${userId}`, a.key, { planId: a.userPlan }, 200, '/v1/users/:id');
      return;
    }
    if (n % 10 === 6) {
      call('PATCH', '/v1/account', a.key, { planId: a.accountPlan });
      return;
    }
  }
  const first = consume(a, id, userId);
  if (PHASE === 'retry') {
    const repeated = consume(a, id, userId, true);
    if (first && repeated) {
      const { replayed: ignoredFirst, ...original } = first;
      const { replayed: ignoredSecond, ...replay } = repeated;
      verify(JSON.stringify(original) === JSON.stringify(replay), 'replay preserves original decision');
    }
  }
}

export function handleSummary(data) {
  // Never export setup_data: it contains the test accounts' API keys.
  const report = { phase: PHASE, vus: VUS, seconds: SECONDS, metrics: data.metrics };
  const count = data.metrics['http_reqs{phase:measure}']?.values.count || 0;
  const latency = data.metrics['http_req_duration{phase:measure}']?.values || {};
  // Include request drain time; timed-out/in-flight iterations can finish after the nominal stage.
  const elapsed = Math.max(SECONDS, data.metrics.measured_elapsed_seconds?.values.max || 0);
  report.elapsedSeconds = elapsed;
  report.requestsPerSecond = count / elapsed;
  return {
    [`/loadtest/results/heavy/${PHASE}.json`]: JSON.stringify(report, null, 2),
    stdout: `${PHASE}: ${count} measured requests, ${(count / elapsed).toFixed(1)} req/s, ` +
      `p50=${latency.med?.toFixed(1)}ms p95=${latency['p(95)']?.toFixed(1)}ms p99=${latency['p(99)']?.toFixed(1)}ms\n`,
  };
}
