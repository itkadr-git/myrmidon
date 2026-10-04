-- myrmidon(1.7 USERS-ADMIN-UI A): one-time password-set links for board users.
-- Additive only: one new table plus its two indexes; no vendor table is
-- touched, no data is rewritten (generated with drizzle-kit).
CREATE TABLE "user_password_set_tokens" (
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_via" text NOT NULL,
	"issued_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE INDEX "user_password_set_tokens_hash_idx" ON "user_password_set_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "user_password_set_tokens_user_idx" ON "user_password_set_tokens" USING btree ("user_id","revoked_at");
