-- Totals check (docs/TESTING.md): for every account and user, each month's counters must equal
-- what the requests history says. Prints the number of mismatching rows (must be 0).
WITH history AS (
  SELECT account_id, user_id, date_trunc('month', created_at AT TIME ZONE 'UTC')::date AS month, units, accepted
  FROM requests
),
acc AS (
  SELECT account_id, month,
         COALESCE(SUM(units) FILTER (WHERE accepted), 0) AS used,
         COUNT(*) FILTER (WHERE accepted) AS accepted_count,
         COUNT(*) FILTER (WHERE NOT accepted) AS rejected_count
  FROM history GROUP BY account_id, month
),
usr AS (
  SELECT user_id, month,
         COALESCE(SUM(units) FILTER (WHERE accepted), 0) AS used,
         COUNT(*) FILTER (WHERE accepted) AS accepted_count,
         COUNT(*) FILTER (WHERE NOT accepted) AS rejected_count
  FROM history GROUP BY user_id, month
)
SELECT
  (SELECT count(*) FROM account_usage au FULL JOIN acc ON acc.account_id = au.account_id AND acc.month = au.month
    WHERE COALESCE(au.used, 0) <> COALESCE(acc.used, 0)
       OR COALESCE(au.accepted_count, 0) <> COALESCE(acc.accepted_count, 0)
       OR COALESCE(au.rejected_count, 0) <> COALESCE(acc.rejected_count, 0)) AS account_mismatches,
  (SELECT count(*) FROM user_usage uu FULL JOIN usr ON usr.user_id = uu.user_id AND usr.month = uu.month
    WHERE COALESCE(uu.used, 0) <> COALESCE(usr.used, 0)
       OR COALESCE(uu.accepted_count, 0) <> COALESCE(usr.accepted_count, 0)
       OR COALESCE(uu.rejected_count, 0) <> COALESCE(usr.rejected_count, 0)) AS user_mismatches,
  (SELECT count(*) FROM requests) AS requests_checked;
