CREATE TABLE "myrmidon_channel_allowed_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"handle" text,
	"display_name" text,
	"scope" text DEFAULT 'company' NOT NULL,
	"endpoint_id" uuid,
	"board_user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "myrmidon_channel_allowed_users_scope_check" CHECK ("myrmidon_channel_allowed_users"."scope" in ('company', 'endpoint')),
	CONSTRAINT "myrmidon_channel_allowed_users_status_check" CHECK ("myrmidon_channel_allowed_users"."status" in ('active', 'revoked')),
	CONSTRAINT "myrmidon_channel_allowed_users_endpoint_scope_check" CHECK (("myrmidon_channel_allowed_users"."scope" = 'company' and "myrmidon_channel_allowed_users"."endpoint_id" is null) or ("myrmidon_channel_allowed_users"."scope" = 'endpoint' and "myrmidon_channel_allowed_users"."endpoint_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "myrmidon_channel_allowed_users" ADD CONSTRAINT "myrmidon_channel_allowed_users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_channel_allowed_users" ADD CONSTRAINT "myrmidon_channel_allowed_users_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "myrmidon_channel_allowed_users_company_idx" ON "myrmidon_channel_allowed_users" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "myrmidon_channel_allowed_users_company_provider_idx" ON "myrmidon_channel_allowed_users" USING btree ("company_id","provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_channel_allowed_users_admission_uq" ON "myrmidon_channel_allowed_users" USING btree ("company_id","provider","external_id","scope","endpoint_id");