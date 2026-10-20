// Retry storm: spread setup; 20% of requests resend the previous request (same id and body) → replays.
import { check } from 'k6';
import { consume, exportSummary, pick, randomUnits, scenarioOptions, seedAccounts } from './lib/common.js';

export const options = scenarioOptions();
export const setup = () => seedAccounts(100, 10, 'retry');

let last = null; // per VU

export default function ({ accounts }) {
  if (last && Math.random() < 0.2) {
    const res = consume(last.apiKey, last.body);
    check(res, { 'retry: replayed': (r) => r.status === 200 && r.json('replayed') === true });
    return;
  }
  const account = pick(accounts);
  const body = { requestId: `${__VU}-${__ITER}`, userId: pick(account.userIds), units: randomUnits() };
  consume(account.apiKey, body);
  last = { apiKey: account.apiKey, body };
}

export const handleSummary = exportSummary('retry');
