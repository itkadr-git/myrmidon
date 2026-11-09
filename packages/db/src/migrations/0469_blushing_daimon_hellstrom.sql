CREATE TABLE "company_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"agent_quota" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_tiers" ADD CONSTRAINT "company_tiers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_tiers_company_id_uq" ON "company_tiers" USING btree ("company_id");--> statement-breakpoint
-- OPE-12091 backfill: existing companies get the free tier with a quota of 5.
INSERT INTO "company_tiers" ("company_id", "tier", "agent_quota")
SELECT "id", 'free', 5 FROM "companies"
ON CONFLICT ("company_id") DO NOTHING;