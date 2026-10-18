DROP INDEX "requests_history_idx";--> statement-breakpoint
DROP INDEX "requests_user_hist_idx";--> statement-breakpoint
CREATE INDEX "requests_history_idx" ON "requests" USING btree ("account_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "requests_user_hist_idx" ON "requests" USING btree ("account_id","user_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);