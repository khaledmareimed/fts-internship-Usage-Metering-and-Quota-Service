// Spread: 100 companies × 10 users, random company/user → normal throughput.
import { consume, exportSummary, pick, randomUnits, scenarioOptions, seedAccounts } from './lib/common.js';

export const options = scenarioOptions();
export const setup = () => seedAccounts(100, 10, 'spread');

export default function ({ accounts }) {
  const account = pick(accounts);
  consume(account.apiKey, { requestId: `${__VU}-${__ITER}`, userId: pick(account.userIds), units: randomUnits() });
}

export const handleSummary = exportSummary('spread');
