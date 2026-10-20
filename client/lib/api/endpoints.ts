import 'server-only';
import type { AccountView, ConsumeResult, HistoryItem, Page, Plan, UserListItem, UserView } from '../../types/api';
import { request } from './http';

const encode = encodeURIComponent;

export const getAccount = (apiKey: string, month?: string) =>
  request<AccountView>(month ? `/v1/account?month=${encode(month)}` : '/v1/account', { apiKey });

export const updateAccount = (apiKey: string, body: { planId: string }) =>
  request<AccountView>('/v1/account', { method: 'PATCH', apiKey, body });

export const listPlans = (apiKey: string, query?: { type?: 'account' | 'user'; includeInactive?: boolean }) => {
  const params = new URLSearchParams();
  if (query?.type) params.set('type', query.type);
  if (query?.includeInactive) params.set('includeInactive', 'true');
  const qs = params.toString();
  return request<{ items: Plan[] }>(qs ? `/v1/plans?${qs}` : '/v1/plans', { apiKey });
};

export const listUserPlans = (apiKey: string) => listPlans(apiKey, { type: 'user' });
export const listAccountPlans = (apiKey: string) => listPlans(apiKey, { type: 'account' });

export const getPlan = (apiKey: string, planId: string) =>
  request<Plan>(`/v1/plans/${encode(planId)}`, { apiKey });

export const createPlan = (
  apiKey: string,
  body: {
    name: string;
    type: 'account' | 'user';
    monthlyLimit: number;
    perRequestLimit: number;
    rateLimitPerMinute?: number | null;
  }
) => request<Plan>('/v1/plans', { method: 'POST', apiKey, body });

export const updatePlan = (
  apiKey: string,
  planId: string,
  body: {
    name?: string;
    monthlyLimit?: number;
    perRequestLimit?: number;
    rateLimitPerMinute?: number | null;
    isActive?: boolean;
  }
) => request<Plan>(`/v1/plans/${encode(planId)}`, { method: 'PATCH', apiKey, body });

export const listUsers = (apiKey: string, query?: { limit?: number; cursor?: string }) => {
  const params = new URLSearchParams();
  if (query?.limit) params.set('limit', String(query.limit));
  if (query?.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return request<Page<UserListItem>>(qs ? `/v1/users?${qs}` : '/v1/users?limit=100', { apiKey });
};

export const getUser = (apiKey: string, userId: string, month?: string) =>
  request<UserView>(month ? `/v1/users/${encode(userId)}?month=${encode(month)}` : `/v1/users/${encode(userId)}`, { apiKey });

export const createUser = (apiKey: string, body: { userId: string; planId: string }) =>
  request<UserView>('/v1/users', { method: 'POST', apiKey, body });

export const updateUser = (apiKey: string, userId: string, body: { planId?: string; isActive?: boolean }) =>
  request<UserView>(`/v1/users/${encode(userId)}`, { method: 'PATCH', apiKey, body });

export const consume = (apiKey: string, body: { requestId: string; userId: string; units: number }) =>
  request<ConsumeResult>('/v1/consume', { method: 'POST', apiKey, body });

export const listRequests = (apiKey: string, query?: { userId?: string; month?: string; limit?: number; cursor?: string }) => {
  const params = new URLSearchParams();
  if (query?.userId) params.set('userId', query.userId);
  if (query?.month) params.set('month', query.month);
  if (query?.limit) params.set('limit', String(query.limit));
  if (query?.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return request<Page<HistoryItem>>(qs ? `/v1/requests?${qs}` : '/v1/requests', { apiKey });
};

export const listRecentRequests = (apiKey: string, limit: number) =>
  listRequests(apiKey, { limit });

export const getRequest = (apiKey: string, requestId: string) =>
  request<HistoryItem>(`/v1/requests/${encode(requestId)}`, { apiKey });
