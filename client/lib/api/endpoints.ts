import 'server-only';
import type { AccountView, ConsumeResult, HistoryItem, Page, Plan, UserListItem, UserView } from '../../types/api';
import { request } from './http';

const encode = encodeURIComponent;

export const getAccount = (apiKey: string) => request<AccountView>('/v1/account', { apiKey });

export const listUsers = (apiKey: string) => request<Page<UserListItem>>('/v1/users?limit=100', { apiKey });

export const getUser = (apiKey: string, userId: string) =>
  request<UserView>(`/v1/users/${encode(userId)}`, { apiKey });

export const listUserPlans = (apiKey: string) =>
  request<{ items: Plan[] }>('/v1/plans?type=user', { apiKey });

export const getPlan = (apiKey: string, planId: string) => request<Plan>(`/v1/plans/${encode(planId)}`, { apiKey });

export const listRecentRequests = (apiKey: string, limit: number) =>
  request<Page<HistoryItem>>(`/v1/requests?limit=${limit}`, { apiKey });

export const consume = (apiKey: string, body: { requestId: string; userId: string; units: number }) =>
  request<ConsumeResult>('/v1/consume', { method: 'POST', apiKey, body });

export const updateUser = (apiKey: string, userId: string, body: { planId?: string; isActive?: boolean }) =>
  request<UserView>(`/v1/users/${encode(userId)}`, { method: 'PATCH', apiKey, body });

export const updatePlan = (apiKey: string, planId: string, body: { monthlyLimit?: number; perRequestLimit?: number }) =>
  request<Plan>(`/v1/plans/${encode(planId)}`, { method: 'PATCH', apiKey, body });
