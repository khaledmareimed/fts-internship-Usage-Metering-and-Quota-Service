// Reads: GET /account, /users/:id, /requests over companies that already have history.
import http from 'k6/http';
import { check } from 'k6';
import { BASE, consume, exportSummary, pick, randomUnits, scenarioOptions, seedAccounts } from './lib/common.js';

export const options = scenarioOptions();

export function setup() {
  const data = seedAccounts(20, 10, 'reads');
  // Some history to read: 50 decisions per company.
  for (const account of data.accounts) {
    for (let i = 0; i < 50; i++) {
      consume(account.apiKey, { requestId: `seed-${i}`, userId: pick(account.userIds), units: randomUnits() });
    }
  }
  return data;
}

export default function ({ accounts }) {
  const account = pick(accounts);
  const params = { headers: { 'x-api-key': account.apiKey }, tags: {} };
  const roll = Math.random();
  let res;
  if (roll < 1 / 3) {
    params.tags.endpoint = 'account';
    res = http.get(`${BASE}/v1/account`, params);
  } else if (roll < 2 / 3) {
    params.tags.endpoint = 'user';
    res = http.get(`${BASE}/v1/users/${pick(account.userIds)}`, params);
  } else {
    params.tags.endpoint = 'requests';
    res = http.get(`${BASE}/v1/requests?limit=20`, params);
  }
  check(res, { 'read: 200': (r) => r.status === 200 });
}

export const handleSummary = exportSummary('reads');
