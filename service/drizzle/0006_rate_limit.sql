ALTER TABLE "account_usage" ADD COLUMN "window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_usage" ADD COLUMN "window_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "rate_limit_per_minute" integer;--> statement-breakpoint
ALTER TABLE "user_usage" ADD COLUMN "window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_usage" ADD COLUMN "window_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_window_count_check" CHECK ("account_usage"."window_count" >= 0);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_rate_limit_per_minute_check" CHECK ("plans"."rate_limit_per_minute" > 0);--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_window_count_check" CHECK ("user_usage"."window_count" >= 0);