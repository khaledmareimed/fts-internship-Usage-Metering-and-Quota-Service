-- drizzle-kit can't express storage parameters; see docs/schema.sql.
-- Hot rows: leave room for in-place (HOT) updates and vacuum them often.
ALTER TABLE "account_usage" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01);--> statement-breakpoint
ALTER TABLE "user_usage" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01);
