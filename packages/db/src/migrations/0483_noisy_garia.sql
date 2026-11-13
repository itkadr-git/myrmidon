CREATE TABLE "external_connector_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"agent_id" uuid,
	"connector_id" text NOT NULL,
	"action_id" text NOT NULL,
	"grant_mode" text,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"pending_approval_id" uuid,
	"payload_summary" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_connector_pending_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"action_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"payload_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_connector_policy_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"action_id" text NOT NULL,
	"mode" text NOT NULL,
	"created_by" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_connector_invocations" ADD CONSTRAINT "external_connector_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_connector_invocations" ADD CONSTRAINT "external_connector_invocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_connector_pending_approvals" ADD CONSTRAINT "external_connector_pending_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_connector_pending_approvals" ADD CONSTRAINT "external_connector_pending_approvals_invocation_id_external_connector_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."external_connector_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_connector_pending_approvals" ADD CONSTRAINT "external_connector_pending_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_connector_policy_grants" ADD CONSTRAINT "external_connector_policy_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_connector_policy_grants" ADD CONSTRAINT "external_connector_policy_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_connector_invocations_company_created_idx" ON "external_connector_invocations" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "external_connector_invocations_company_agent_created_idx" ON "external_connector_invocations" USING btree ("company_id","agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "external_connector_invocations_company_connector_created_idx" ON "external_connector_invocations" USING btree ("company_id","connector_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "external_connector_pending_approvals_company_status_idx" ON "external_connector_pending_approvals" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "external_connector_pending_approvals_invocation_idx" ON "external_connector_pending_approvals" USING btree ("invocation_id","status" = 'pending');--> statement-breakpoint
CREATE UNIQUE INDEX "external_connector_pending_approvals_invocation_uq" ON "external_connector_pending_approvals" USING btree ("invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_connector_policy_grants_uq" ON "external_connector_policy_grants" USING btree ("company_id","agent_id","connector_id","action_id");--> statement-breakpoint
CREATE INDEX "external_connector_policy_grants_lookup_idx" ON "external_connector_policy_grants" USING btree ("company_id","agent_id","enabled");