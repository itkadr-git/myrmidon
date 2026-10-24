CREATE TABLE IF NOT EXISTS "pool_chat_module_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"module_key" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_secret_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pool_chat_quota_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"account_ref" text NOT NULL,
	"units" bigint NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"settled_units" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pool_chat_request_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"state" text DEFAULT 'dispatching' NOT NULL,
	"provider" text NOT NULL,
	"account_ref" text,
	"reserved_units" bigint DEFAULT 0 NOT NULL,
	"settled_units" bigint,
	"failure_code" text,
	"failure_detail" text,
	"provider_request_ref" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pool_chat_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"subject_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"client_message_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"usage" jsonb,
	"charged" boolean,
	"reservation_units" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pool_chat_module_instances" ADD CONSTRAINT "pool_chat_module_instances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pool_chat_module_instances" ADD CONSTRAINT "pool_chat_module_instances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pool_chat_module_instances_company_module_uq" ON "pool_chat_module_instances" USING btree ("company_id","module_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_chat_module_instances_company_idx" ON "pool_chat_module_instances" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_chat_module_instances_project_idx" ON "pool_chat_module_instances" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pool_chat_quota_reservations_request_uq" ON "pool_chat_quota_reservations" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_chat_quota_reservations_company_state_idx" ON "pool_chat_quota_reservations" USING btree ("company_id","state");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pool_chat_request_attempts_request_no_uq" ON "pool_chat_request_attempts" USING btree ("request_id","attempt_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pool_chat_request_attempts_provider_ref_uq" ON "pool_chat_request_attempts" USING btree ("provider","provider_request_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_chat_request_attempts_request_idx" ON "pool_chat_request_attempts" USING btree ("company_id","request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pool_chat_requests_identity_key_uq" ON "pool_chat_requests" USING btree ("company_id","module_id","channel","subject_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pool_chat_requests_event_identity_uq" ON "pool_chat_requests" USING btree ("company_id","module_id","channel","subject_id","client_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_chat_requests_module_status_idx" ON "pool_chat_requests" USING btree ("company_id","module_id","status");
