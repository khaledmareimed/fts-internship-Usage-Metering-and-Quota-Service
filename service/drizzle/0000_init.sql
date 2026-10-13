CREATE TABLE "account_usage" (
	"account_id" uuid NOT NULL,
	"month" date NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"monthly_limit" bigint NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_usage_pkey" PRIMARY KEY("account_id","month"),
	CONSTRAINT "account_usage_month_check" CHECK ("account_usage"."month" = date_trunc('month', "account_usage"."month")::date),
	CONSTRAINT "account_usage_used_check" CHECK ("account_usage"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_api_key_hash_key" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"monthly_limit" bigint NOT NULL,
	"per_request_limit" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_account_id_name_key" UNIQUE NULLS NOT DISTINCT("account_id","name"),
	CONSTRAINT "plans_type_check" CHECK ("plans"."type" IN ('account', 'user')),
	CONSTRAINT "plans_monthly_limit_check" CHECK ("plans"."monthly_limit" > 0),
	CONSTRAINT "plans_per_request_limit_check" CHECK ("plans"."per_request_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"units" integer NOT NULL,
	"accepted" boolean NOT NULL,
	"failed_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits_snapshot" jsonb NOT NULL,
	"account_remaining" bigint NOT NULL,
	"user_remaining" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_account_id_request_id_key" UNIQUE("account_id","request_id"),
	CONSTRAINT "requests_request_id_check" CHECK (length("requests"."request_id") BETWEEN 1 AND 128),
	CONSTRAINT "requests_units_check" CHECK ("requests"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_usage" (
	"user_id" uuid NOT NULL,
	"month" date NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"monthly_limit" bigint NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_usage_pkey" PRIMARY KEY("user_id","month"),
	CONSTRAINT "user_usage_month_check" CHECK ("user_usage"."month" = date_trunc('month', "user_usage"."month")::date),
	CONSTRAINT "user_usage_used_check" CHECK ("user_usage"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_account_id_external_id_key" UNIQUE("account_id","external_id"),
	CONSTRAINT "users_account_id_id_key" UNIQUE("account_id","id"),
	CONSTRAINT "users_external_id_check" CHECK (length("users"."external_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_account_id_user_id_fkey" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_history_idx" ON "requests" USING btree ("account_id","id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "requests_user_hist_idx" ON "requests" USING btree ("account_id","user_id","id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "users_plan_idx" ON "users" USING btree ("plan_id");