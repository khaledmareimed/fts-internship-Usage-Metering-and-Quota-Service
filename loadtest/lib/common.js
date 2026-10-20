// Shared k6 helpers: seeding through the public API, consume calls, and summary export.
import http from 'k6/http';
import { check } from 'k6';

export const BASE = __ENV.BASE_URL || 'http://localhost:50000';
const ADMIN_KEY = __ENV.ADMIN_KEY;

// Fixed ids of predefined plans (docs/API.md → Plans).
const STARTER = '00000000-0000-4000-8000-000000000001';
const PREMIUM = '00000000-0000-4000-8000-000000000004';

/** Every scenario: 10 s warm-up (not measured), then 60 s measured, both at 50 VUs. */
export function scenarioOptions(vus = 50) {
  return {
    setupTimeout: '300s',
    scenarios: {
      warmup: { executor: 'constant-vus', vus, duration: '10s', tags: { phase: 'warmup' } },
      measure: { executor: 'constant-vus', vus, duration: '60s', startTime: '10s', tags: { phase: 'measure' } },
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
    // Trivial thresholds only make k6 report the measured-phase sub-metrics in the summary.
    thresholds: {
      'http_req_duration{phase:measure}': ['max>=0'],
      'http_reqs{phase:measure}': ['count>=0'],
      'http_req_failed{phase:measure}': ['rate>=0'],
      'checks{phase:measure}': ['rate>=0'],
    },
  };
}

const json = (body) => JSON.stringify(body);

function post(path, body, headers) {
  return http.post(`${BASE}${path}`, json(body), { headers: { 'content-type': 'application/json', ...headers } });
}

function must(res, status, what) {
  if (res.status !== status) throw new Error(`${what} failed: ${res.status} ${res.body}`);
  return res.json();
}

/**
 * Creates `count` companies, each on a custom account plan with a huge limit (we measure deciding,
 * not hitting limits) and `usersPerAccount` Premium users. Public API only, like any integrator.
 */
export function seedAccounts(count, usersPerAccount, tag) {
  if (!ADMIN_KEY) throw new Error('ADMIN_KEY is required');
  const accounts = [];
  for (let a = 0; a < count; a++) {
    const account = must(post('/v1/accounts', { name: `load-${tag}-${a}`, planId: STARTER }, { 'x-admin-key': ADMIN_KEY }), 201, 'create account');
    const auth = { 'x-api-key': account.apiKey, 'content-type': 'application/json' };
    const plan = must(post('/v1/plans', { name: 'Load', type: 'account', monthlyLimit: 1e15, perRequestLimit: 1_000_000 }, auth), 201, 'create plan');
    must(http.patch(`${BASE}/v1/account`, json({ planId: plan.planId }), { headers: auth }), 200, 'switch plan');
    const userIds = Array.from({ length: usersPerAccount }, (_, u) => `u${u}`);
    const created = http.batch(
      userIds.map((userId) => ['POST', `${BASE}/v1/users`, json({ userId, planId: PREMIUM }), { headers: auth }]),
    );
    created.forEach((res) => must(res, 201, 'create user'));
    accounts.push({ apiKey: account.apiKey, userIds });
  }
  return { accounts };
}

export const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const randomUnits = () => 1 + Math.floor(Math.random() * 20);

/** One consume call; checks the answer is a decision (accepted or rejected, both 200). */
export function consume(apiKey, body) {
  const res = post('/v1/consume', body, { 'x-api-key': apiKey });
  check(res, {
    'consume: 200': (r) => r.status === 200,
    'consume: decided': (r) => r.status === 200 && typeof r.json('accepted') === 'boolean',
  });
  return res;
}

/** Writes the raw summary for run.sh; prints nothing else (run.sh prints the table). */
export function exportSummary(name) {
  return (data) => ({ [`/loadtest/results/${name}.json`]: JSON.stringify(data, null, 2) });
}
