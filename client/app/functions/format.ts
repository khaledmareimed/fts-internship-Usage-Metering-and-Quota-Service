import type { ConsumeResult, FailedRule } from '../../types/api';

export function formatUnits(n: number): string {
  return n.toLocaleString('en-US');
}

/** Whose rule it was, as the demo shows it. */
export function ruleOwner(rule: FailedRule): 'User' | 'Company' {
  return rule.scope === 'user' ? 'User' : 'Company';
}

export function ruleLabel(rule: FailedRule): string {
  const owner = ruleOwner(rule);
  switch (rule.rule) {
    case 'inactive':
      return 'User is inactive';
    case 'per_request_limit':
      return `${owner} per-request limit (${formatUnits(rule.limit)}): asked for ${formatUnits(rule.requested)}`;
    case 'monthly_limit':
      return `${owner} monthly limit (${formatUnits(rule.limit)}): ${formatUnits(rule.remaining)} left`;
    case 'rate_limit':
      return `${owner} rate limit (${formatUnits(rule.limit)}/min): ${formatUnits(rule.remaining)} left this minute`;
  }
}

export function decisionSummary(result: ConsumeResult): string {
  if (result.accepted) return `Accepted: ${formatUnits(result.units)} units for ${result.user.userId}`;
  const count = result.failedRules.length;
  return `Rejected: ${count} rule${count === 1 ? '' : 's'} failed, nothing was used`;
}

/** Share of the monthly limit used, 0–100 (usage can be above a lowered limit). */
export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}
