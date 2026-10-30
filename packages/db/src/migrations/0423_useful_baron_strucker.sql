CREATE TABLE "redaction_substitutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"redaction_id" uuid NOT NULL,
	"token" text NOT NULL,
	"original" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "redaction_substitutions_lookup_idx" ON "redaction_substitutions" USING btree ("redaction_id","token");--> statement-breakpoint
CREATE INDEX "redaction_substitutions_expiry_idx" ON "redaction_substitutions" USING btree ("expires_at");