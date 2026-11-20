CREATE TABLE "acceptance_service_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"key_hash" text NOT NULL,
	"certificate_sha256" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acceptance_service_credentials" ADD CONSTRAINT "acceptance_service_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_service_credentials_key_hash_idx" ON "acceptance_service_credentials" USING btree ("key_hash");