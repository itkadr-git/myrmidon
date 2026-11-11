CREATE TABLE "nest_redact_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nest_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nest_redact_settings" ADD CONSTRAINT "nest_redact_settings_nest_id_companies_id_fk" FOREIGN KEY ("nest_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nest_redact_settings_nest_idx" ON "nest_redact_settings" USING btree ("nest_id");