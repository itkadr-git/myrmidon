CREATE TABLE "myrmidon_owner_activity" (
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_owner_activity_user_channel_uq" ON "myrmidon_owner_activity" USING btree ("user_id","channel");