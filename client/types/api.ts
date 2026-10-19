// API response types, written from docs/API.md (no shared package: see DECISIONS.md).

export type PlanType = 'account' | 'user';

export interface Plan {
  planId: string;
  name: string;
  type: PlanType;
  monthlyLimit: number;
  perRequestLimit: number;
  rateLimitPerMinute: number | null;
  predefined: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Usage {
  month: string;
  used: number;
  remaining: number;
  acceptedCount: number;
  rejectedCount: number;
}

export interface AccountView {
  accountId: string;
  name: string;
  isActive: boolean;
  plan: Plan;
  usage: Usage;
}

export interface CreatedAccount {
  accountId: string;
  name: string;
  apiKey: string;
  plan: Plan;
  createdAt: string;
}

export interface UserListItem {
  userId: string;
  isActive: boolean;
  planId: string;
  planName: string;
}

export interface UserView {
  userId: string;
  isActive: boolean;
  plan: Plan;
  usage: Usage;
}

export type RuleScope = 'user' | 'account';

export type FailedRule =
  | { scope: 'user'; rule: 'inactive' }
  | { scope: RuleScope; rule: 'per_request_limit'; limit: number; requested: number }
  | { scope: RuleScope; rule: 'monthly_limit'; limit: number; remaining: number }
  | { scope: RuleScope; rule: 'rate_limit'; limit: number; remaining: number };

interface Totals {
  used: number;
  remaining: number;
  monthlyLimit: number;
  perRequestLimit: number;
}

export interface ConsumeResult {
  requestId: string;
  accepted: boolean;
  units: number;
  failedRules: FailedRule[];
  month: string;
  account: Totals;
  user: Totals & { userId: string };
  replayed: boolean;
  decidedAt: string;
}

interface PlanLimits {
  planName: string;
  monthlyLimit: number;
  perRequestLimit: number;
  rateLimitPerMinute: number | null;
}

export interface HistoryItem {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  failedRules: FailedRule[];
  limits: { account: PlanLimits; user: PlanLimits };
  accountRemaining: number;
  userRemaining: number;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}
