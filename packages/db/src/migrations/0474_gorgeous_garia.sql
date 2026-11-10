CREATE TABLE "webhook_intake_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_event_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"event_type" text,
	"raw_payload" jsonb NOT NULL,
	"signature_scheme" text,
	"signature_header" text,
	"signature_value" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivery_attempts" integer DEFAULT 1 NOT NULL,
	"last_delivery_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_intake_drafts" ADD CONSTRAINT "webhook_intake_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_intake_drafts_company_source_event_uq" ON "webhook_intake_drafts" USING btree ("company_id","source","external_event_id");--> statement-breakpoint
CREATE INDEX "webhook_intake_drafts_company_received_idx" ON "webhook_intake_drafts" USING btree ("company_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_intake_drafts_company_status_idx" ON "webhook_intake_drafts" USING btree ("company_id","status","received_at");