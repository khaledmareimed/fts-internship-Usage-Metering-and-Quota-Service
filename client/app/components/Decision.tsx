import type { ConsumeResult } from '../../types/api';
import { decisionSummary, formatUnits, ruleLabel } from '../functions/format';
import styles from './Decision.module.css';

export function Decision({ result }: { result: ConsumeResult }) {
  return (
    <div className={result.accepted ? styles.accepted : styles.rejected}>
      <p className={styles.summary}>{decisionSummary(result)}</p>
      {result.failedRules.length > 0 && (
        <ul className={styles.rules}>
          {result.failedRules.map((rule) => (
            <li key={`${rule.scope}:${rule.rule}`}>{ruleLabel(rule)}</li>
          ))}
        </ul>
      )}
      <p className={styles.totals}>
        Company {formatUnits(result.account.used)}/{formatUnits(result.account.monthlyLimit)} · {result.user.userId}{' '}
        {formatUnits(result.user.used)}/{formatUnits(result.user.monthlyLimit)}
      </p>
    </div>
  );
}
