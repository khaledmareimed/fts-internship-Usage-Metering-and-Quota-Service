// Drizzle mirror of docs/schema.sql; test/integration/schema.test.ts proves they match.
// fillfactor/autovacuum for the usage tables live in drizzle/0001_usage_storage_params.sql.
import { sql } from 'drizzle-orm';
import type { FailedRule, LimitsSnapshot } from '../domain/rules.js';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const PLAN_TYPES = ['account', 'user'] as const;

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL = predefined plan
    accountId: uuid('account_id'),
    name: text('name').notNull(),
    type: text('type', { enum: PLAN_TYPES }).notNull(),
    monthlyLimit: bigint('monthly_limit', { mode: 'number' }).notNull(),
    perRequestLimit: integer('per_request_limit').notNull(),
    // accepted requests per UTC minute; NULL = no rate limit
    rateLimitPerMinute: integer('rate_limit_per_minute'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Explicit return type breaks the plans <-> accounts type cycle.
  (t): PgTableExtraConfigValue[] => [
    check('plans_type_check', sql`${t.type} IN ('account', 'user')`),
    check('plans_monthly_limit_check', sql`${t.monthlyLimit} > 0`),
    check('plans_per_request_limit_check', sql`${t.perRequestLimit} > 0`),
    check('plans_rate_limit_per_minute_check', sql`${t.rateLimitPerMinute} > 0`),
    unique('plans_account_id_name_key').on(t.accountId, t.name).nullsNotDistinct(),
    // custom plans belong to a company; accounts is declared below (circular FK)
    foreignKey({ name: 'plans_account_fk', columns: [t.accountId], foreignColumns: [accounts.id] }),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // SHA-256 of the key, never the plain key
    apiKeyHash: text('api_key_hash').notNull(),
    planId: uuid('plan_id').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('accounts_api_key_hash_key').on(t.apiKeyHash),
    foreignKey({ name: 'accounts_plan_id_fkey', columns: [t.planId], foreignColumns: [plans.id] }),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    externalId: text('external_id').notNull(),
    planId: uuid('plan_id').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('users_external_id_check', sql`length(${t.externalId}) BETWEEN 1 AND 128`),
    unique('users_account_id_external_id_key').on(t.accountId, t.externalId),
    // target for the composite FK in requests
    unique('users_account_id_id_key').on(t.accountId, t.id),
    foreignKey({ name: 'users_account_id_fkey', columns: [t.accountId], foreignColumns: [accounts.id] }),
    foreignKey({ name: 'users_plan_id_fkey', columns: [t.planId], foreignColumns: [plans.id] }),
    index('users_plan_idx').on(t.planId),
    // GET /users pages newest first; NULLS FIRST is Postgres' default for DESC (matches schema.sql)
    index('users_list_idx').on(t.accountId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
  ],
);

// account_usage and user_usage share the same counter columns.
const usageCounters = () => ({
  month: date('month').notNull(),
  used: bigint('used', { mode: 'number' }).notNull().default(0),
  // limit at last update (for past months)
  monthlyLimit: bigint('monthly_limit', { mode: 'number' }).notNull(),
  acceptedCount: integer('accepted_count').notNull().default(0),
  rejectedCount: integer('rejected_count').notNull().default(0),
  // fixed 1-minute window for the rate limit: accepted requests counted in the minute starting at window_start
  windowStart: timestamp('window_start', { withTimezone: true }),
  windowCount: integer('window_count').notNull().default(0),
  updatedAt: updatedAt(),
});

export const accountUsage = pgTable(
  'account_usage',
  {
    accountId: uuid('account_id').notNull(),
    ...usageCounters(),
  },
  (t) => [
    primaryKey({ name: 'account_usage_pkey', columns: [t.accountId, t.month] }),
    check('account_usage_month_check', sql`${t.month} = date_trunc('month', ${t.month})::date`),
    check('account_usage_used_check', sql`${t.used} >= 0`),
    check('account_usage_window_count_check', sql`${t.windowCount} >= 0`),
    foreignKey({ name: 'account_usage_account_id_fkey', columns: [t.accountId], foreignColumns: [accounts.id] }),
  ],
);

export const userUsage = pgTable(
  'user_usage',
  {
    userId: uuid('user_id').notNull(),
    ...usageCounters(),
  },
  (t) => [
    primaryKey({ name: 'user_usage_pkey', columns: [t.userId, t.month] }),
    check('user_usage_month_check', sql`${t.month} = date_trunc('month', ${t.month})::date`),
    check('user_usage_used_check', sql`${t.used} >= 0`),
    check('user_usage_window_count_check', sql`${t.windowCount} >= 0`),
    foreignKey({ name: 'user_usage_user_id_fkey', columns: [t.userId], foreignColumns: [users.id] }),
  ],
);

export const requests = pgTable(
  'requests',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: uuid('account_id').notNull(),
    requestId: text('request_id').notNull(),
    userId: uuid('user_id').notNull(),
    units: integer('units').notNull(),
    accepted: boolean('accepted').notNull(),
    // e.g. [{"scope":"user","rule":"per_request_limit"}]
    failedRules: jsonb('failed_rules').$type<FailedRule[]>().notNull().default([]),
    // limits used at decision time
    limitsSnapshot: jsonb('limits_snapshot').$type<LimitsSnapshot>().notNull(),
    accountRemaining: bigint('account_remaining', { mode: 'number' }).notNull(),
    userRemaining: bigint('user_remaining', { mode: 'number' }).notNull(),
    // totals after the decision, so a retry returns the original answer exactly
    accountUsed: bigint('account_used', { mode: 'number' }).notNull(),
    userUsed: bigint('user_used', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('requests_request_id_check', sql`length(${t.requestId}) BETWEEN 1 AND 128`),
    check('requests_units_check', sql`${t.units} > 0`),
    // safe retries, per company
    unique('requests_account_id_request_id_key').on(t.accountId, t.requestId),
    foreignKey({ name: 'requests_account_id_fkey', columns: [t.accountId], foreignColumns: [accounts.id] }),
    // user must belong to same company
    foreignKey({
      name: 'requests_account_id_user_id_fkey',
      columns: [t.accountId, t.userId],
      foreignColumns: [users.accountId, users.id],
    }),
    // History pages newest first by (created_at, id); each filter (month, user) is one range scan.
    index('requests_history_idx').on(t.accountId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index('requests_user_hist_idx').on(
      t.accountId,
      t.userId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);
