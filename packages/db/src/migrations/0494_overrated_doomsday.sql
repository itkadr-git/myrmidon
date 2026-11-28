CREATE TABLE "native_finalization_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"certificate_sha256" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by_operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_finalization_grants_run_uq" UNIQUE("run_id"),
	CONSTRAINT "native_finalization_grants_owner_uq" UNIQUE("company_id","issue_id","run_id","id"),
	CONSTRAINT "native_finalization_grants_generation_check" CHECK ("native_finalization_grants"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "native_finalization_outbox" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "native_finalization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"grant_generation" integer NOT NULL,
	"principal_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"verified_peer_sha256" text NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"document_id" uuid NOT NULL,
	"expected_revision_id" uuid NOT NULL,
	"expected_issue_epoch" text NOT NULL,
	"strong_etag" text NOT NULL,
	"canonical_payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'accepted' NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"result_decision_id" uuid,
	"error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_finalization_requests_replay_uq" UNIQUE("credential_id","run_id","idempotency_key"),
	CONSTRAINT "native_finalization_requests_state_check" CHECK ("native_finalization_requests"."state" in ('accepted', 'processing', 'committed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "native_finalization_grants" ADD CONSTRAINT "native_finalization_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_finalization_grants" ADD CONSTRAINT "native_finalization_grants_credential_id_acceptance_service_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."acceptance_service_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_finalization_grants" ADD CONSTRAINT "native_finalization_grants_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_finalization_grants" ADD CONSTRAINT "native_finalization_grants_issue_owner_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_finalization_outbox" ADD CONSTRAINT "native_finalization_outbox_request_id_native_finalization_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."native_finalization_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_finalization_requests" ADD CONSTRAINT "native_finalization_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_finalization_requests" ADD CONSTRAINT "native_finalization_requests_credential_id_acceptance_service_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."acceptance_service_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_finalization_requests" ADD CONSTRAINT "native_finalization_requests_grant_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","grant_id") REFERENCES "public"."native_finalization_grants"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_finalization_outbox_pending_idx" ON "native_finalization_outbox" USING btree ("created_at") WHERE "native_finalization_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "native_finalization_requests_active_run_uq" ON "native_finalization_requests" USING btree ("run_id") WHERE "native_finalization_requests"."state" in ('accepted', 'processing');