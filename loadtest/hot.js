// Hot account: 1 company × 200 users → every consume waits on the same account usage row.
import { consume, exportSummary, pick, randomUnits, scenarioOptions, seedAccounts } from './lib/common.js';

export const options = scenarioOptions();
export const setup = () => seedAccounts(1, 200, 'hot');

export default function ({ accounts }) {
  const [account] = accounts;
  consume(account.apiKey, { requestId: `${__VU}-${__ITER}`, userId: pick(account.userIds), units: randomUnits() });
}

export const handleSummary = exportSummary('hot');
