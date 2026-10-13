-- Usage Metering and Quota Service - database schema (PostgreSQL 16)

-- 1. PLANS (created first; accounts and users point to it)
CREATE TABLE plans (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid        NULL,                -- NULL = predefined plan
  name               text        NOT NULL,
  type               text        NOT NULL CHECK (type IN ('account', 'user')),
  monthly_limit      bigint      NOT NULL CHECK (monthly_limit > 0),
  per_request_limit  integer     NOT NULL CHECK (per_request_limit > 0),
  rate_limit_per_minute integer  NULL CHECK (rate_limit_per_minute > 0),   -- accepted requests per UTC minute; NULL = none
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (account_id, name)
);

-- 2. ACCOUNTS (the company)
CREATE TABLE accounts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  api_key_hash  text        NOT NULL UNIQUE,          -- SHA-256 of the key, never the plain key
  plan_id       uuid        NOT NULL REFERENCES plans(id),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Custom plans belong to a company (added after accounts exists)
ALTER TABLE plans
  ADD CONSTRAINT plans_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id);

-- 3. USERS (the company's users)
CREATE TABLE users (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid        NOT NULL REFERENCES accounts(id),
  external_id  text        NOT NULL CHECK (length(external_id) BETWEEN 1 AND 128),
  plan_id      uuid        NOT NULL REFERENCES plans(id),
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id),                    -- user ID is unique per company
  UNIQUE (account_id, id)                              -- target for the composite FK in requests
);

-- 4. ACCOUNT_USAGE (fast monthly counter per company)
CREATE TABLE account_usage (
  account_id      uuid        NOT NULL REFERENCES accounts(id),
  month           date        NOT NULL CHECK (month = date_trunc('month', month)::date),
  used            bigint      NOT NULL DEFAULT 0 CHECK (used >= 0),
  monthly_limit   bigint      NOT NULL,                  -- limit at last update (for past months)
  accepted_count  integer     NOT NULL DEFAULT 0,
  rejected_count  integer     NOT NULL DEFAULT 0,
  window_start    timestamptz NULL,                      -- rate limit: fixed 1-minute UTC window
  window_count    integer     NOT NULL DEFAULT 0 CHECK (window_count >= 0),  -- accepted requests in it
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, month)
) WITH (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01);  -- hot row: in-place (HOT) updates

-- 5. USER_USAGE (fast monthly counter per user)
CREATE TABLE user_usage (
  user_id         uuid        NOT NULL REFERENCES users(id),
  month           date        NOT NULL CHECK (month = date_trunc('month', month)::date),
  used            bigint      NOT NULL DEFAULT 0 CHECK (used >= 0),
  monthly_limit   bigint      NOT NULL,                  -- limit at last update (for past months)
  accepted_count  integer     NOT NULL DEFAULT 0,
  rejected_count  integer     NOT NULL DEFAULT 0,
  window_start    timestamptz NULL,                      -- rate limit: fixed 1-minute UTC window
  window_count    integer     NOT NULL DEFAULT 0 CHECK (window_count >= 0),  -- accepted requests in it
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
) WITH (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01);

-- 6. REQUESTS (full history: every accepted and rejected request)
CREATE TABLE requests (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id         uuid        NOT NULL REFERENCES accounts(id),
  request_id         text        NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  user_id            uuid        NOT NULL,
  units              integer     NOT NULL CHECK (units > 0),
  accepted           boolean     NOT NULL,
  failed_rules       jsonb       NOT NULL DEFAULT '[]',   -- e.g. [{"scope":"user","rule":"per_request_limit"}]
  limits_snapshot    jsonb       NOT NULL,                -- limits used at decision time
  account_remaining  bigint      NOT NULL,
  user_remaining     bigint      NOT NULL,
  account_used       bigint      NOT NULL,                -- totals after the decision (exact replay)
  user_used          bigint      NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id),                        -- safe retries, per company
  FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id)  -- user must belong to same company
);

-- INDEXES (start with account_id; lists page newest first by (created_at, id) as the cursor)
-- plans(account_id) is already covered by UNIQUE (account_id, name)
CREATE INDEX users_plan_idx         ON users (plan_id);                       -- "who is on this plan?"
CREATE INDEX users_list_idx         ON users (account_id, created_at DESC, id DESC);  -- GET /users, newest first
CREATE INDEX requests_history_idx   ON requests (account_id, created_at DESC, id DESC);           -- history, ?month=
CREATE INDEX requests_user_hist_idx ON requests (account_id, user_id, created_at DESC, id DESC);  -- ?userId= (+ month)

-- FUNCTIONS (consume v2 + rate-limit rule)
-- Consume v2 + rate-limit rule: evaluate_rules() gains the two rate_limit checks (6, 7) and
-- consume_decide() counts accepted requests in a fixed 1-minute UTC window on the locked usage rows.
-- evaluate_rules() is the SQL twin of src/domain/rules.ts evaluateRules(); a parity test keeps them identical.
CREATE FUNCTION evaluate_rules(
  p_units integer,
  p_user_active boolean,
  p_user_monthly bigint,
  p_user_per_request integer,
  p_account_monthly bigint,
  p_account_per_request integer,
  p_user_used bigint,
  p_account_used bigint,
  p_user_rate integer,
  p_account_rate integer,
  p_user_count integer,
  p_account_count integer
) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(f.rule ORDER BY f.ord), '[]'::jsonb)
  FROM (
    SELECT 1 AS ord, jsonb_build_object('scope', 'user', 'rule', 'inactive') AS rule
    WHERE NOT p_user_active
    UNION ALL
    SELECT 2, jsonb_build_object('scope', 'user', 'rule', 'per_request_limit',
                                 'limit', p_user_per_request, 'requested', p_units)
    WHERE p_units > p_user_per_request
    UNION ALL
    SELECT 3, jsonb_build_object('scope', 'account', 'rule', 'per_request_limit',
                                 'limit', p_account_per_request, 'requested', p_units)
    WHERE p_units > p_account_per_request
    UNION ALL
    SELECT 4, jsonb_build_object('scope', 'user', 'rule', 'monthly_limit',
                                 'limit', p_user_monthly, 'remaining', GREATEST(0, p_user_monthly - p_user_used))
    WHERE p_units > p_user_monthly - p_user_used
    UNION ALL
    SELECT 5, jsonb_build_object('scope', 'account', 'rule', 'monthly_limit',
                                 'limit', p_account_monthly, 'remaining', GREATEST(0, p_account_monthly - p_account_used))
    WHERE p_units > p_account_monthly - p_account_used
    UNION ALL
    SELECT 6, jsonb_build_object('scope', 'user', 'rule', 'rate_limit',
                                 'limit', p_user_rate, 'remaining', GREATEST(0, p_user_rate - p_user_count))
    WHERE p_user_rate IS NOT NULL AND p_user_count >= p_user_rate  -- = count + 1 > rate, without int overflow
    UNION ALL
    SELECT 7, jsonb_build_object('scope', 'account', 'rule', 'rate_limit',
                                 'limit', p_account_rate, 'remaining', GREATEST(0, p_account_rate - p_account_count))
    WHERE p_account_rate IS NOT NULL AND p_account_count >= p_account_rate  -- = count + 1 > rate, without int overflow
  ) f
$$;
-- Steps 1–9 of the locked transaction. Called as one autocommit statement, so the usage row locks are
-- held only while this function runs. No row = user not found. outcome 'existing' = this requestId
-- was already decided (the caller replays or answers 409).
CREATE FUNCTION consume_decide(
  p_account_id uuid,
  p_request_id text,
  p_external_user_id text,
  p_units integer
) RETURNS TABLE (
  outcome text,
  request_id text,
  user_id uuid,
  external_user_id text,
  units integer,
  accepted boolean,
  failed_rules jsonb,
  limits_snapshot jsonb,
  account_used bigint,
  user_used bigint,
  account_remaining bigint,
  user_remaining bigint,
  month text,
  created_at timestamptz
)
LANGUAGE plpgsql VOLATILE AS $$
#variable_conflict use_column
DECLARE
  -- 2. The month comes from the database clock (transaction start), fixed for the whole decision.
  v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  -- The rate-limit window: the current UTC minute (same clock).
  v_minute timestamptz := date_trunc('minute', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_user_id uuid;
  v_user_active boolean;
  v_user_plan text;
  v_user_monthly bigint;
  v_user_per_request integer;
  v_user_rate integer;
  v_account_plan text;
  v_account_monthly bigint;
  v_account_per_request integer;
  v_account_rate integer;
  v_account_used bigint;
  v_user_used bigint;
  v_account_count integer;
  v_user_count integer;
  v_failed jsonb;
  v_accepted boolean;
BEGIN
  -- 1. Resolve the user (scoped to the account).
  SELECT u.id INTO v_user_id FROM users u
  WHERE u.account_id = p_account_id AND u.external_id = p_external_user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- 3. Lock the account usage row (create it first if this is the month's first request).
  INSERT INTO account_usage AS au (account_id, month, monthly_limit)
  SELECT a.id, v_month, p.monthly_limit FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.id = p_account_id
  ON CONFLICT (account_id, month) DO NOTHING;
  SELECT au.used, CASE WHEN au.window_start = v_minute THEN au.window_count ELSE 0 END
  INTO v_account_used, v_account_count FROM account_usage au
  WHERE au.account_id = p_account_id AND au.month = v_month FOR UPDATE;

  -- 4. Then lock the user usage row (same order everywhere: no deadlocks).
  INSERT INTO user_usage AS uu (user_id, month, monthly_limit)
  SELECT u.id, v_month, p.monthly_limit FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.id = v_user_id
  ON CONFLICT (user_id, month) DO NOTHING;
  SELECT uu.used, CASE WHEN uu.window_start = v_minute THEN uu.window_count ELSE 0 END
  INTO v_user_used, v_user_count FROM user_usage uu
  WHERE uu.user_id = v_user_id AND uu.month = v_month FOR UPDATE;

  -- 5. Idempotency after the locks: an earlier attempt with this id has committed by now.
  IF EXISTS (SELECT 1 FROM requests r WHERE r.account_id = p_account_id AND r.request_id = p_request_id) THEN
    RETURN QUERY
      SELECT 'existing'::text, r.request_id, r.user_id, ru.external_id, r.units, r.accepted, r.failed_rules,
             r.limits_snapshot, r.account_used, r.user_used, r.account_remaining, r.user_remaining,
             to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM'), r.created_at
      FROM requests r JOIN users ru ON ru.id = r.user_id
      WHERE r.account_id = p_account_id AND r.request_id = p_request_id;
    RETURN;
  END IF;

  -- 6. Current plans and the user's active flag, read after the locks.
  SELECT u.is_active, up.name, up.monthly_limit, up.per_request_limit, up.rate_limit_per_minute,
         ap.name, ap.monthly_limit, ap.per_request_limit, ap.rate_limit_per_minute
  INTO v_user_active, v_user_plan, v_user_monthly, v_user_per_request, v_user_rate,
       v_account_plan, v_account_monthly, v_account_per_request, v_account_rate
  FROM users u
  JOIN plans up ON up.id = u.plan_id
  JOIN accounts a ON a.id = u.account_id
  JOIN plans ap ON ap.id = a.plan_id
  WHERE u.id = v_user_id;

  -- 7. Evaluate all rules (SQL twin of domain/rules.ts).
  v_failed := evaluate_rules(p_units, v_user_active, v_user_monthly, v_user_per_request,
                             v_account_monthly, v_account_per_request, v_user_used, v_account_used,
                             v_user_rate, v_account_rate, v_user_count, v_account_count);
  v_accepted := jsonb_array_length(v_failed) = 0;

  -- 8. Update counters (account row, then user row) and keep the limit used for this month.
  --    Only accepted requests count toward the rate-limit window.
  UPDATE account_usage au
  SET used = au.used + CASE WHEN v_accepted THEN p_units ELSE 0 END,
      accepted_count = au.accepted_count + CASE WHEN v_accepted THEN 1 ELSE 0 END,
      rejected_count = au.rejected_count + CASE WHEN v_accepted THEN 0 ELSE 1 END,
      window_start = CASE WHEN v_accepted THEN v_minute ELSE au.window_start END,
      window_count = CASE WHEN v_accepted THEN v_account_count + 1 ELSE au.window_count END,
      monthly_limit = v_account_monthly,
      updated_at = now()
  WHERE au.account_id = p_account_id AND au.month = v_month
  RETURNING au.used INTO v_account_used;

  UPDATE user_usage uu
  SET used = uu.used + CASE WHEN v_accepted THEN p_units ELSE 0 END,
      accepted_count = uu.accepted_count + CASE WHEN v_accepted THEN 1 ELSE 0 END,
      rejected_count = uu.rejected_count + CASE WHEN v_accepted THEN 0 ELSE 1 END,
      window_start = CASE WHEN v_accepted THEN v_minute ELSE uu.window_start END,
      window_count = CASE WHEN v_accepted THEN v_user_count + 1 ELSE uu.window_count END,
      monthly_limit = v_user_monthly,
      updated_at = now()
  WHERE uu.user_id = v_user_id AND uu.month = v_month
  RETURNING uu.used INTO v_user_used;

  -- 9. Save the decision (a duplicate requestId raises 23505; the caller's safety net handles it).
  RETURN QUERY
    INSERT INTO requests AS r (account_id, request_id, user_id, units, accepted, failed_rules, limits_snapshot,
                               account_remaining, user_remaining, account_used, user_used)
    VALUES (
      p_account_id, p_request_id, v_user_id, p_units, v_accepted, v_failed,
      jsonb_build_object(
        'account', jsonb_build_object('planName', v_account_plan, 'monthlyLimit', v_account_monthly,
                                      'perRequestLimit', v_account_per_request,
                                      'rateLimitPerMinute', v_account_rate),
        'user', jsonb_build_object('planName', v_user_plan, 'monthlyLimit', v_user_monthly,
                                   'perRequestLimit', v_user_per_request,
                                   'rateLimitPerMinute', v_user_rate)
      ),
      GREATEST(0, v_account_monthly - v_account_used), GREATEST(0, v_user_monthly - v_user_used),
      v_account_used, v_user_used
    )
    RETURNING 'decided'::text, r.request_id, r.user_id, p_external_user_id, r.units, r.accepted, r.failed_rules,
              r.limits_snapshot, r.account_used, r.user_used, r.account_remaining, r.user_remaining,
              to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM'), r.created_at;
END;
$$;

-- Enforced in code, not here:
--  * accounts get only 'account' plans, users get only 'user' plans
--  * a plan must be predefined or owned by the same company