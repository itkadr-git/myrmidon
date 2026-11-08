-- OPE-8985: users-admin-a — one-time password-set tokens and the block list.
CREATE TABLE "user_password_set_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issued_via" text NOT NULL,
	"issued_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"user_id" text PRIMARY KEY NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_by_user_id" text
);
--> statement-breakpoint
CREATE INDEX "user_password_set_tokens_user_idx" ON "user_password_set_tokens" USING btree ("user_id","revoked_at");
